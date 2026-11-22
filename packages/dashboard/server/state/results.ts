import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hostStopNativeProof, type NativeProof } from '../../collection';
import { failLoops, LOOP_WINDOW_MS } from '../../../core/src/fail-loops';
import { LEASE_MAX_AGE_MS, SIDE_NAME } from '../../../core/src/fleet';
import { append, FILES, MAIN, practice, root, statusDir, tailJsonl, type Status } from '../config';

// ---------- RESULT lines: every new result a status file shows, with pass/fail streaks per script ----------
type Res = { at: number; name: string; goal: string; ok: boolean; text: string; started?: number };
const allResults = tailJsonl<Res>(FILES.results, 100_000);
const results: Res[] = allResults.slice(-300).reverse();
const died = (text: string) => /\bdied=true\b/.test(text) || /\bdied (?!=)/.test(text);
// Per account, the newest result and the newest death. They do not drop out of the 300-row list when practice runs
// fill it (three live farmer deaths vanished from the page that way).
const lastResult = new Map<string, { text: string; started?: number }>(), newestRes = new Map<string, Res>(), newestDeath = new Map<string, Res>();
const noteRes = (r: Res) => { lastResult.set(r.name, { text: r.text, started: r.started }); newestRes.set(r.name, r); if (died(r.text)) newestDeath.set(r.name, r); };
for (const r of allResults) noteRes(r);
// The long read above fed the per-account maps; the list that fleetDiagnostics scans every 2 s keeps the newest RESULT_KEEP.
const RESULT_KEEP = 5000;
if (allResults.length > RESULT_KEEP) allResults.splice(0, allResults.length - RESULT_KEEP);
function trackResult(s: Status) {
    const text = String(s.result ?? '');
    // Two runs can end with the same text: the run start tells them apart.
    const last = lastResult.get(s.name), started = typeof s.started === 'number' ? s.started : undefined;
    if (!text || (last?.text === text.slice(0, 240) && (last.started === undefined || started === undefined || last.started === started))) return;
    const r: Res = { started, at: s.at, name: s.name, goal: String(s.goal ?? '').replace(/\.ts$/, ''), ok: /^ok\b/.test(text), text: text.slice(0, 240) };
    noteRes(r);
    allResults.push(r);
    if (allResults.length > RESULT_KEEP) allResults.splice(0, allResults.length - RESULT_KEEP);
    results.unshift(r);
    results.length = Math.min(results.length, 300);
    append(FILES.results, r);
}
type ProofEntry = {proof: NativeProof; resultPrefix: string};
let proofScanAt=0,proofStamp='';
let proofCache=new Map<string,ProofEntry>();
function nativeProofs(now: number): Map<string,ProofEntry> {
    if(now-proofScanAt<10_000)return proofCache;
    proofScanAt=now;
    // The inputs are the three hashed sources, the proof files and the status files of their actors: unchanged stats, same answer.
    const stamp=(()=>{try{const proofDir=join(practice,'fleet-proof'),parts:string[]=[];
        for(const f of ['packages/core/src/host.ts','packages/workers/src/bank-artisan/prayer.ts','scripts/measure/fleet-host-stop.ts']){const t=statSync(join(root,f));parts.push(f+t.size+':'+t.mtimeMs);}
        for(const f of readdirSync(proofDir)){const t=statSync(join(proofDir,f));parts.push(f+t.size+':'+t.mtimeMs);const m=/^host-stop-(fl[a-z0-9]+)-snapshot\.json$/i.exec(f);if(m)try{const t2=statSync(join(statusDir,m[1]+'.json'));parts.push('s'+t2.size+':'+t2.mtimeMs);}catch{/* no status */}}
        return parts.join('|');}catch{return '';}})();
    if(stamp&&stamp===proofStamp)return proofCache;
    proofStamp=stamp;
    const next=new Map<string,ProofEntry>(),dir=join(practice,'fleet-proof');
    const boundedText=(path:string,max:number)=>{if(statSync(path).size>max)throw new Error('proof input too large');return readFileSync(path,'utf8');};
    const digest=(path:string)=>createHash('sha256').update(boundedText(path,512_000)).digest('hex').toUpperCase();
    try {
        // Exact known harness family only. No path or evidence file comes from an HTTP argument.
        const hashes={host:digest(join(root,'packages/core/src/host.ts')),worker:digest(join(root,'packages/workers/src/bank-artisan/prayer.ts')),harness:digest(join(root,'scripts/measure/fleet-host-stop.ts'))};
        for(const filename of readdirSync(dir).filter(f=>/^host-stop-fl[a-z0-9]+-snapshot\.json$/i.test(f)).slice(-64))try{
            const path=join(dir,filename),s=JSON.parse(boundedText(path,256_000));
            if(typeof s.actor!=='string'||filename!==`host-stop-${s.actor}-snapshot.json`
                ||typeof s.sourcePath!=='string'||!/^\.practice\/fleet-proof\/prayer-fl[a-z0-9]+-source\.json$/i.test(s.sourcePath))continue;
            const status=JSON.parse(boundedText(join(statusDir,`${s.actor}.json`),256_000));
            const raw=boundedText(join(dir,`host-stop-${s.actor}.log`),2_000_000);
            const proof=hostStopNativeProof(status,{filename,snapshot:s,raw,at:statSync(path).mtimeMs,
                hashes:{...hashes,fixture:digest(join(dir,s.sourcePath.split('/').pop()!))}});
            if(proof)next.set(s.actor.toLowerCase(),{proof,resultPrefix:String(status.result).slice(0,220)});
        }catch{/* Missing, failed, changed-source or malformed evidence stays an ordinary raw result. */}
    }catch{/* No supported proof family is available. */}
    proofCache=next;return next;
}
function resultProof(r: Pick<Res,'name'|'text'>, proofs: Map<string,ProofEntry>) {
    const entry=proofs.get(r.name.toLowerCase());
    return entry&&r.text.startsWith(entry.resultPrefix)?entry.proof:null;
}
function scripts(proofs: Map<string,ProofEntry>) {
    const by = new Map<string, Res[]>();
    // A swarm run reports its job's goal text, a hand run its script name: count both under the script.
    const key = (g: string) => /^gold farm/i.test(g) ? 'goldfarm' : /^food chain: fish/i.test(g) ? 'fishcook' : /^food chain: courier/i.test(g) ? 'foodcourier' : g;
    for (const r of results) { const k = key(r.goal), l = by.get(k) ?? []; l.push(r); by.set(k, l); }
    return [...by].map(([goal, l]) => {
        let streak = 0;
        for (const r of l) { if (r.ok === l[0]!.ok) streak++; else break; }
        const proved=new Set(l.filter(r=>resultProof(r,proofs)).map(r=>r.name.toLowerCase())).size;
        return { goal, runs: l.length, ok: l.filter(r => r.ok).length, streak, streakOk: l[0]!.ok, last: l[0]!.at, recent: l.slice(0, 12).map(r => r.ok),
            proofs:{proved,stopCleanup:proved,failedWork:l.filter(r=>!r.ok).length} };
    }).sort((a, b) => b.last - a.last);
}

type LeaseDiagnostic = { side: string; host: string | null; pid: number | null; at: number | null; ageMs: number | null; stale: boolean | null };
function readLeaseDiagnostics(dir: string, now: number): LeaseDiagnostic[] {
    if (!existsSync(dir)) return [];
    try {
        return readdirSync(dir)
            .filter(f => f.endsWith('.json') && SIDE_NAME.test(f.slice(0, -5)))
            .sort()
            .map(file => {
                const side = file.slice(0, -5);
                try {
                    const row = JSON.parse(readFileSync(join(dir, file), 'utf8'));
                    if (row?.side !== side) return { side, host: null, pid: null, at: null, ageMs: null, stale: null };
                    const pid = Number.isSafeInteger(row.pid) && row.pid > 0 ? row.pid : null;
                    const at = Number.isSafeInteger(row.at) && row.at > 0 && row.at <= now ? row.at : null;
                    const host = typeof row.host === 'string' && row.host.trim() ? row.host.trim() : null;
                    const ageMs = at !== null ? now - at : null;
                    return { side, host, pid, at, ageMs, stale: ageMs !== null ? ageMs >= LEASE_MAX_AGE_MS : null };
                } catch {
                    return { side, host: null, pid: null, at: null, ageMs: null, stale: null };
                }
            });
    } catch { return []; }
}
function fleetDiagnostics(now: number) {
    const syncedLeases = join(FILES.fleet, 'leases'), localLeases = join(root, 'fleet', 'leases');
    const leaseDir = existsSync(syncedLeases) ? syncedLeases : localLeases;
    const leases = readLeaseDiagnostics(leaseDir, now);
    const loops = failLoops(allResults.filter(r => r.name.toLowerCase() !== MAIN.toLowerCase()), now);
    return {
        at: now,
        windowMs: LOOP_WINDOW_MS,
        leaseMaxAgeMs: LEASE_MAX_AGE_MS,
        failLoops: loops,
        leases,
    };
}

export {
    died,
    fleetDiagnostics,
    nativeProofs,
    newestDeath,
    newestRes,
    resultProof,
    results,
    scripts,
    trackResult,
};
