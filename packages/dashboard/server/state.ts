import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, freemem, totalmem } from 'node:os';
import { createHash } from 'node:crypto';
import { accountJobRows, collectionState, operationState, effectiveJob, productionGoal, boundedOperation, capacityState, hostStopNativeProof, productionReview, type NativeProof } from '../collection';
import { requestEvidence, gateView } from '../evidence';
import { goalPlan, goalProgress, questPointObservation, GOAL_RECEIPTS, type GoalInputs } from '../goals';
import { GEAR_TARGETS } from '../goal-details';
import { flowView, trackFlow } from '../flow';
import { coordinationView } from '../coordination';
import { dashboardStatuses, fleetSidesView, healthObservation, localDisplayNames, remoteBots, scoreboardView } from '../fleet-view';
import { itemPrice, projectItemPrices, type PriceIdentity } from '../item-prices';
import { projectItemExamine } from '../item-examine';
import { packQuests } from '../quest-pack';
import { folderScan } from '../folder-scan';
import { cachedTail } from '../jsonl-tail';
import { contentionView, farmsView, overtakeView, rivalsView, rosterView, wildernessOverlayData, wildernessView } from '../world-view';
import { xpForLevel } from '../../planner/src/curve';
import { applyLevers, haggisActivities, haggisTravel, loadSnapshot, scheduleOverall, overallRequirementsFor, TRICKS } from '../../planner/src/haggis';
import { isLocalServer } from '../../core/src/localserver';
import { ownerOfIn } from '../../core/src/fleet-snapshots';
import { LEASE_MAX_AGE_MS, SIDE_NAME } from '../../core/src/fleet';
import { failLoops, LOOP_WINDOW_MS } from '../../core/src/fail-loops';
import {
    append, BANKER, cached, dashboardDir, every, FILES, fleetList, getMapBytes, liveAccounts, MAIN, MAP, NL,
    OBJS, PAGE_FILE, placeOf, practice, remoteNames, ROLE_SKILL, root, SCRIPT_ROLE, SECRET_MARK, SECRET_RE,
    shortPhase, snapshotFiles, statusDir, tailJsonl, type Status,
} from './config';
import { getItemPrices, getPricesAt, icons, itemExamines, keySupplyIds, marketById, npcLootPrices, vault } from './market';
import {
    ALL_BOARDS, boardTops, EXTRA, extraBoards, firstSeen, fmtTicks, inferRole, liveTop, NO_ROLE, parseTime, rankDelta,
    ranks, roster, serverTick, SKILL_BOARDS, snapshot, topOf, valueRanks, world,
} from './world';

// A status file is parsed again only when its mtime changes; track() runs once per new version. The scan names
// the files to stat, so a build does not stat the thousands of old practice files.
const statusScan = folderScan(statusDir), statusCache = new Map<string, { mtime: number; doc: Status }>();
const flows = new Map<string, any>(); // loot and supplies per account and session (flow.ts)
function readStatuses(): Map<string, Status> {
    const { check, gone } = statusScan();
    for (const f of gone) statusCache.delete(join(statusDir, f));
    for (const f of check) {
        if (!f.endsWith('.json')) continue;
        const p = join(statusDir, f);
        try {
            const mtime = statSync(p).mtimeMs;
            if (statusCache.get(p)?.mtime === mtime) continue;
            const doc = JSON.parse(readFileSync(p, 'utf8'));
            if (!doc || typeof doc.name !== 'string' || !doc.name || typeof doc.server !== 'string'
                || !Number.isFinite(doc.at) || doc.at < 0
                || ['phase','role','goal','result','timeline'].some(k => doc[k] != null && typeof doc[k] !== 'string')
                || ['skills','inventory','bank','equipment','quests'].some(k => doc[k] != null && !Array.isArray(doc[k]))
                || (doc.skills ?? []).some((k: any) => !k || typeof k.name !== 'string')) { statusCache.delete(p); continue; }
            track(doc);
            statusCache.set(p, { mtime, doc });
        } catch { if (existsSync(p)) statusScan.retry(f); /* being written */ else statusCache.delete(p); }
    }
    const out = new Map<string, Status>(), now = Date.now();
    for (const { doc: s } of statusCache.values()) {
        if (isLocalServer(s.server) && now - s.at > 30 * 60_000) continue; // stale practice bots
        const other = out.get(s.name);
        if (!other || s.at >= other.at) out.set(s.name, s);
    }
    return out;
}

// XP rate samples, xp/tick history (sparkline), phase start times.
// Each sample keeps every skill's XP, so a rate can be taken for one skill (the goal) and not the sum of all.
type Sample = { at: number; tick: number; xp: number; sk: Record<string, number>; coins: number; food: number; bank: boolean };
// Food a gold farmer eats: the pack items the thieving scripts eat (lobsters, cakes, bread, chocolate, fish).
const FOOD_RE = /lobster|cake|bread|chocolate|shrimp|anchov|trout|salmon|tuna|swordfish|pike|herring|sardine|meat|chicken/i;
const coinsOf = (s: Status) => [...(s.inventory ?? []), ...(s.bank ?? [])].filter((i: any) => i?.name === 'Coins').reduce((n: number, i: any) => n + i.count, 0);
const foodOf = (l: any[] | null | undefined) => (l ?? []).filter((i: any) => i?.name && FOOD_RE.test(i.name) && !/noted/i.test(i.name)).reduce((n: number, i: any) => n + i.count, 0);
// Coins at the first status of each run (name + started), so "made this run" survives a dashboard restart only
// within one process; it restarts from the next status after that.
const runStartCoins = new Map<string, number>();
const sampleSessions = new Map<string, string>();
const samples = new Map<string, Sample[]>();
const spark = new Map<string, number[]>();
type Ev = { at: number; name: string; text: string };
const events: Ev[] = tailJsonl<Ev>(FILES.events, 200).reverse();
const lastPhase = new Map<string, string>();
const phaseSince = new Map<string, { at: number; exact: boolean }>();
for (const e of [...events].reverse()) phaseSince.set(e.name + NL + e.text, { at: e.at, exact: true });
function track(s: Status) {
    trackFlow(flows, s);
    const session = JSON.stringify([s.server, s.started ?? null]);
    if (sampleSessions.get(s.name) !== session) {
        samples.delete(s.name);
        spark.delete(s.name);
        sampleSessions.set(s.name, session);
    }
    const xp = (s.skills ?? []).reduce((n: number, k: any) => n + (k.xp ?? 0), 0);
    const sk: Record<string, number> = {};
    for (const k of s.skills ?? []) sk[k.name] = k.xp ?? 0;
    const list = samples.get(s.name) ?? [];
    // A status written before the game state loaded has 0 XP in every skill; as a sample it would make the next
    // real one look like a jump of the account's whole XP (214M xp/h on a level-99 thief).
    if (xp > 0 && (!list.length || list[list.length - 1]!.tick !== s.tick)) {
        list.push({ at: s.at, tick: s.tick, xp, sk, coins: coinsOf(s), food: foodOf(s.inventory) + foodOf(s.bank), bank: s.bank != null });
        const rk = s.name + '|' + s.started;
        // Only a status that lists the bank: before the first bank view, the whole old bank would count as "made".
        if (!runStartCoins.has(rk) && s.bank != null) runStartCoins.set(rk, coinsOf(s));
        const r = rate(s.name, goalSkillOf(s), list);
        if (r != null && Date.now() - s.at < 20_000) { const sp = spark.get(s.name) ?? []; sp.push(Math.round(r * 10) / 10); if (sp.length > 60) sp.shift(); spark.set(s.name, sp); }
    }
    while (list.length > 2 && list[0]!.at < s.at - 120_000) list.shift();
    samples.set(s.name, list);
    const ph = s.phase ?? '';
    if (ph && lastPhase.get(s.name) !== ph) {
        if (lastPhase.has(s.name)) {
            phaseSince.delete(s.name + NL + lastPhase.get(s.name));
            const ev = { at: s.at, name: s.name, text: ph };
            events.unshift(ev);
            append(FILES.events, ev);
            phaseSince.set(s.name + NL + ph, { at: s.at, exact: true });
        } else if (!phaseSince.has(s.name + NL + ph)) phaseSince.set(s.name + NL + ph, { at: s.at, exact: false });
        lastPhase.set(s.name, ph);
        events.length = Math.min(events.length, 200);
    }
    trackResult(s);
}
// XP per tick over the last 2 minutes: of the goal skill when there is one, else of all skills.
function rate(name: string, skill: string | null, l = samples.get(name) ?? []) {
    if (l.length < 2) return null;
    const a = l[0]!, b = l[l.length - 1]!;
    const xa = skill ? a.sk[skill] ?? 0 : a.xp, xb = skill ? b.sk[skill] ?? 0 : b.xp;
    return b.tick > a.tick ? (xb - xa) / (b.tick - a.tick) : null;
}
// Coins and food per tick over the last 2 minutes (food is eaten: a positive number is food used per tick).
function flowRate(name: string, key: 'coins' | 'food') {
    const l = samples.get(name) ?? [];
    if (l.length < 2) return null;
    const a = l[0]!, b = l[l.length - 1]!;
    if (b.tick <= a.tick) return null;
    // Food is counted in the pack and the bank; a rise means a trade or a new bank view, not negative eating.
    if (key === 'food') return a.food >= b.food ? (a.food - b.food) / (b.tick - a.tick) : null;
    // Coins are counted in the pack and the bank; a bank that is known in only one sample is not income.
    if (a.bank !== b.bank) return null;
    return (b.coins - a.coins) / (b.tick - a.tick);
}
function goalSkillOf(s: Status): string | null {
    const known = SCRIPT_ROLE[String(s.goal ?? '')]?.skill ?? ROLE_SKILL[s.role];
    if (known) return known;
    if (NO_ROLE.has(s.role) && s.name !== MAIN) return inferRole(s, ranks.get(s.name)?.rows ?? []);
    return null;
}

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
        for(const f of ['packages/core/src/host.ts','scripts/train-prayer.ts','scripts/measure/fleet-host-stop.ts']){const t=statSync(join(root,f));parts.push(f+t.size+':'+t.mtimeMs);}
        for(const f of readdirSync(proofDir)){const t=statSync(join(proofDir,f));parts.push(f+t.size+':'+t.mtimeMs);const m=/^host-stop-(fl[a-z0-9]+)-snapshot\.json$/i.exec(f);if(m)try{const t2=statSync(join(statusDir,m[1]+'.json'));parts.push('s'+t2.size+':'+t2.mtimeMs);}catch{/* no status */}}
        return parts.join('|');}catch{return '';}})();
    if(stamp&&stamp===proofStamp)return proofCache;
    proofStamp=stamp;
    const next=new Map<string,ProofEntry>(),dir=join(practice,'fleet-proof');
    const boundedText=(path:string,max:number)=>{if(statSync(path).size>max)throw new Error('proof input too large');return readFileSync(path,'utf8');};
    const digest=(path:string)=>createHash('sha256').update(boundedText(path,512_000)).digest('hex').toUpperCase();
    try {
        // Exact known harness family only. No path or evidence file comes from an HTTP argument.
        const hashes={host:digest(join(root,'packages/core/src/host.ts')),worker:digest(join(root,'scripts/train-prayer.ts')),harness:digest(join(root,'scripts/measure/fleet-host-stop.ts'))};
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

// ---------- machine: memory, CPU load, bun processes ----------
let cpuPrev = cpus().map(c => c.times);
let cpuPct = 0;
const procs: { pid: number; script: string; started: number; mb: number; accounts: string[] }[] = [];
let procsAt = 0, procsScanning = false;
async function scanProcs(force = false) {
    if (!clients.size && !force) return; // nobody watching: no PowerShell
    if (procsScanning) return; // a slow scan must not stack a second PowerShell
    procsScanning = true;
    procsAt = Date.now();
    try {
        const ps = "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.CreationDate.ToString('o'), $_.WorkingSetSize, $_.CommandLine }";
        const p = Bun.spawn(['powershell', '-NoProfile', '-Command', ps], { stdout: 'pipe', stderr: 'ignore' ,windowsHide:true});
        const hung = setTimeout(() => p.kill(), 20_000);
        const text = await new Response(p.stdout).text().finally(() => clearTimeout(hung));
        procs.length = 0;
        for (const line of text.split(NL)) {
            const [pid, created, ws, ...cmd] = line.trim().split('|');
            if (!pid || !created) continue;
            // Only the script file name: command lines never reach the page.
            const script = (cmd.join('|').match(/([\w.-]+\.(?:ts|js))\b/g) ?? []).pop() ?? 'bun';
            const tokens = (cmd.join('|').match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map(t => t.replace(/^["']|["']$/g, '').toLowerCase());
            const accounts = liveAccounts().filter(name => tokens.includes(name.toLowerCase()));
            procs.push({ pid: Number(pid), script, started: Date.parse(created), mb: Math.round(Number(ws) / 2 ** 20), accounts });
        }
        procs.sort((a, b) => a.started - b.started);
    } catch { /* not Windows */ } finally { procsScanning = false; }
}
function maybeScanProcs() {
    if (Date.now() - procsAt > 60_000) void scanProcs(true);
}

// ---------- pull requests: the bot repository's open and lately merged PRs (gh), every 5 minutes ----------
// The hosted publisher fetches the same list; the local page reads it from here.
let prRows: any[] = [];
async function refreshPrs() {
    const fields = 'number,title,headRefName,state,isDraft,updatedAt,author,url';
    const list = async (state: string, limit: string) => {
        const p = Bun.spawn(['gh', 'pr', 'list', '--repo', 'Giftedx/rs-sdk-bot', '--state', state, '--limit', limit, '--json', fields], { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
        const text = await new Response(p.stdout).text();
        if (await p.exited !== 0) throw Error(`gh pr list ${state} failed`);
        return JSON.parse(text) as any[];
    };
    try {
        prRows = [...await list('open', '50'), ...await list('merged', '15')].map(r => ({ number: r.number, title: String(r.title ?? ''), branch: String(r.headRefName ?? ''), state: String(r.state ?? ''), draft: r.isDraft === true, updatedAt: String(r.updatedAt ?? ''), author: String(r.author?.login ?? ''), url: String(r.url ?? '') }));
    } catch { /* gh missing or offline: keep the last list */ }
}

// ---------- swarm controller (scripts/swarm.ts) ----------
type SwarmJob = { account: string; script: string; role: string; goal: string; enabled: boolean; repeat: boolean; note: string; state: string; since: number | null };
type Swarm = { at: number; freeGB: number; running: number; externalRunning?: number; pendingStartup?: number; pendingReserveGB?: number; minFreeGB?: number; maxBots: number; jobs: SwarmJob[] };
const swarm = () => cached<Swarm | null>(FILES.swarm, t => JSON.parse(t) as Swarm, null);

// ---------- owner request queue (research/owner-requests.md) ----------
type Req = { id: string; date: string; request: string; status: string; kind: string; evidence: string; next: string; section: string; line: number };
const KINDS: [RegExp, string][] = [[/^done/i, 'DONE'], [/^partial/i, 'PARTIAL'], [/^not started/i, 'NOT STARTED'], [/^blocked/i, 'BLOCKED'], [/^new/i, 'NEW'], [/^rule/i, 'RULE'], [/^dropped/i, 'DONE'], [/^(open|in progress)/i, 'PARTIAL']];
const kindOf = (status: string) => KINDS.find(([re]) => re.test(status))?.[1] ?? status.toUpperCase();
// Every numbered table row of owner-requests.md. A table's first row is its header only when a separator row
// follows it; a row appended under a paragraph (no header of its own) is read by position: # | request | status | ...
// One id can appear more than once (a later correction): the row furthest down the file wins.
function parseRequests(text: string): Req[] {
    const byId = new Map<string, Req>();
    let section = '', header: string[] | null = null;
    const lines = text.split(NL);
    const cellsOf = (line: string) => line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map(c => c.trim());
    const isSep = (line: string | undefined) => !!line && line.trim().startsWith('|') && cellsOf(line.trim()).every(c => /^:?-+:?$/.test(c));
    lines.forEach((raw, i) => {
        const line = raw.trim();
        if (line.startsWith('#')) { section = line.replace(/^#+\s*/, ''); header = null; return; }
        if (!line.startsWith('|')) { header = null; return; }
        if (isSep(line)) return;
        const cells = cellsOf(line);
        if (!header && isSep(lines[i + 1])) { header = cells.map(c => c.toLowerCase()); return; }
        if (!/^\d+$/.test(cells[0] ?? '')) return;
        let r: Req;
        if (header) {
            const h = header;
            const col = (re: RegExp) => { const j = h.findIndex(x => re.test(x)); return j >= 0 ? cells[j] ?? '' : ''; };
            r = { id: cells[0]!, date: col(/^date$/), request: col(/^request/), status: col(/^status$/), kind: '', evidence: col(/^evidence/), next: col(/^next/), section, line: i + 1 };
        } else {
            const si = cells.findIndex((c, j) => j > 0 && KINDS.some(([re]) => re.test(c)));
            if (si < 0) return;
            r = { id: cells[0]!, date: '', request: cells.slice(1, si).find(c => c) ?? '', status: cells[si]!, kind: '', evidence: cells[si + 1] ?? '', next: '', section, line: i + 1 };
        }
        if (!r.status) return;
        r.kind = kindOf(r.status);
        byId.delete(r.id); // re-insert so file order = position of the latest row
        byId.set(r.id, r);
    });
    return [...byId.values()];
}
// The newest changes to the request rows: added or changed numbered rows in the last commits of the file and in the
// working tree, newest first. Read with git, cached on the file's mtime.
type ReqChange = { id: string; kind: string; request: string; at: number; where: string };
let changesCache: { mtime: number; value: ReqChange[] } = { mtime: -1, value: [] };
function requestChanges(all: Req[], mtime: number): ReqChange[] {
    if (changesCache.mtime === mtime) return changesCache.value;
    const out: ReqChange[] = [], seen = new Set<string>();
    const take = (diff: string, at: number, where: string) => {
        for (const l of diff.split(NL).reverse()) {
            const m = l.match(/^\+\|\s*(\d+)\s*\|/);
            if (!m || seen.has(m[1]!)) continue;
            const r = all.find(x => x.id === m[1]);
            if (!r) continue;
            seen.add(m[1]!);
            out.push({ id: r.id, kind: r.kind, request: r.request, at, where });
        }
    };
    try {
        const rel = 'research/owner-requests.md';
        const wt = Bun.spawnSync(['git', 'diff', '-U0', '--', rel], { cwd: root, stdout: 'pipe', stderr: 'ignore' ,windowsHide:true}).stdout.toString();
        if (wt.trim()) take(wt, mtime, 'uncommitted');
        const log = Bun.spawnSync(['git', 'log', '-n', '8', '-p', '-U0', '--format=@@C %h %ct', '--', rel], { cwd: root, stdout: 'pipe', stderr: 'ignore' ,windowsHide:true}).stdout.toString();
        for (const part of log.split(/^@@C /m).filter(Boolean)) {
            const [head, ...rest] = part.split(NL);
            const [hash, ct] = head!.split(' ');
            take(rest.join(NL), Number(ct) * 1000, hash!);
            if (out.length >= 3) break;
        }
    } catch { /* no git */ }
    changesCache = { mtime, value: out.slice(0, 3) };
    return changesCache.value;
}
function requests() {
    const doc=cached(FILES.requests,text=>({all:parseRequests(text),text}),{all:[] as Req[],text:''});
    const all=doc.all;
    const counts: Record<string, number> = {};
    for (const r of all) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    // File order is priority order ("most important to the Haggis goal first", then later additions).
    const open = all.filter(r => !['DONE', 'RULE'].includes(r.kind));
    let mtime = 0; try { mtime = statSync(FILES.requests).mtimeMs; } catch { /* missing */ }
    const evidence=requestEvidence(doc.text);
    return { counts, open, total: all.length, mtime, changes: requestChanges(all, mtime), ...evidence };
}

// ---------- Haggis plan: research/haggis-run.md board table if it has one, else haggis-plan.json ----------
const PLAN_STATES = ['not started', 'method known', 'prep needed', 'rehearsed'];
function planFromRun(text: string): Record<string, { status: string; note: string }> {
    const out: Record<string, { status: string; note: string }> = {};
    let header: string[] | null = null;
    for (const raw of text.split(NL)) {
        const line = raw.trim();
        if (!line.startsWith('|')) { header = null; continue; }
        const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map(c => c.trim());
        if (cells.every(c => /^:?-+:?$/.test(c))) continue;
        if (!header) { header = cells.map(c => c.toLowerCase()); continue; }
        const board = ALL_BOARDS.find(b => cells.some(c => c.replace(/\*|`/g, '').toLowerCase() === b.toLowerCase() || (b === 'Runite' && /lava maze/i.test(c))));
        if (!board) continue;
        const si = header.findIndex(h => /status|state/.test(h));
        const statusText = (si >= 0 ? cells[si] : cells.join(' ')) ?? '';
        const status = PLAN_STATES.slice().reverse().find(s => statusText.toLowerCase().includes(s)) ?? (si >= 0 ? statusText.toLowerCase() : 'not started');
        const ni = header.findIndex(h => /method|plan|note/.test(h));
        out[board] = { status, note: (ni >= 0 ? cells[ni] : '') ?? '' };
    }
    return out;
}
function haggisPlan() {
    const run = existsSync(FILES.haggisRun) ? cached(FILES.haggisRun, planFromRun, {}) : {};
    const json = cached<{ boards: { board: string; status: string; note?: string }[] }>(FILES.haggisPlan, t => JSON.parse(t), { boards: [] });
    const fromRun = Object.keys(run).length > 0;
    return {
        source: fromRun ? 'research/haggis-run.md' : 'packages/dashboard/haggis-plan.json',
        boards: ALL_BOARDS.map(b => {
            const r = (run as Record<string, { status: string; note: string }>)[b], j = json.boards.find(x => x.board === b);
            return { board: b, status: r?.status ?? j?.status ?? 'not started', note: r?.note ?? j?.note ?? '' };
        }),
    };
}

// ---------- alerts ----------
type Alert = { at: number; name: string; kind: 'death' | 'failure' | 'blocked' | 'stuck' | 'idle' | 'logout' | 'efficiency'; text: string; practice?: boolean };
const productionReviews=new Map<string,{at:number;texts:string[]}>();
// Practice bots: every status file that ever named a localhost server, including ones too old for the roster.
const practiceNames = () => new Set([...statusCache.values()].filter(c => isLocalServer(c.doc.server)).map(c => c.doc.name));
function alerts(bots: any[], now: number): Alert[] {
    const out: Alert[] = [];
    const prac = practiceNames();
    for (const r of results) if (now - r.at < 12 * 3_600_000 && died(r.text)) out.push({ at: r.at, name: r.name, kind: 'death', text: (r.text.match(/died[^=]\S*(?: \S+){0,4}/)?.[0] ?? 'died').slice(0, 60) });
    for (const r of results) if (now - r.at < 86_400_000 && /logout\s*(fail|timeout|stuck)|logoutFail\w*=[1-9]/i.test(r.text)) out.push({ at: r.at, name: r.name, kind: 'logout', text: 'logout failed' });
    for (const b of bots) {
        if (!b.at) continue;
        const age = now - b.at;
        if(b.result&&!b.practice&&/^ok\b/.test(String(b.result))) productionReviews.set(b.name,{at:b.at,texts:productionReview(b)});
        const review=productionReviews.get(b.name);
        if(review&&now-review.at<3_600_000)for(const text of review.texts)out.push({at:review.at,name:b.name,kind:'efficiency',text});
        if (['failed','died','blocked'].includes(b.operation)) out.push({ at:b.at, name:b.name, kind:b.operation==='died'?'death':b.operation==='blocked'?'blocked':'failure', text:String(b.result||b.phase||'HP 0 observed').slice(0,110) });
        // Running = this process has printed no RESULT yet. No update for 60 s while running: stuck or crashed.
        // A job the swarm disabled or saw end is not stuck; without a swarm job, only the last 15 min count.
        // Fleet stock snapshots omit session results; their age cannot prove a worker is stuck.
        const js = String(b.job?.state ?? '');
        const meant = !b.remote && !b.snapshotOnly && (b.job ? /^(running|starting|external)/.test(js) : age < 15 * 60_000);
        if (!b.result && meant && age > 60_000) out.push({ at: b.at, name: b.name, kind: 'stuck', text: `no status for ${Math.round(age / 1000)} s while running` });
        if (b.fresh && !b.result) {
            const tl = String(b.timeline ?? ''), m = tl.match(/i+$/);
            if (m && m[0].length > 20) out.push({ at: b.at, name: b.name, kind: 'idle', text: `idle ${m[0].length} ticks now` });
            if (/logout fail/i.test(b.phase ?? '')) out.push({ at: b.at, name: b.name, kind: 'logout', text: b.phase });
        }
    }
    // Live accounts first; practice alerts only for the last hour.
    for (const a of out) a.practice = prac.has(a.name);
    const seen = new Set<string>();
    return out.filter(a => !a.practice || now - a.at < 3_600_000).sort((a, b) => Number(!!a.practice) - Number(!!b.practice) || b.at - a.at).filter(a => { const k = a.name + a.kind + a.text; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30);
}

// ---------- role-aware row data, picked from the swarm job's goal ----------
function roleView(s: Status, job: SwarmJob | null, fresh: boolean, xpRate: number | null) {
    const goal = String(s.goal ?? job?.goal ?? '');
    const pack = s.inventory ?? [];
    if (/^gold farm/i.test(goal)) {
        const coins = coinsOf(s), start = runStartCoins.get(s.name + '|' + s.started);
        const cpt = fresh ? flowRate(s.name, 'coins') : null, eat = fresh ? flowRate(s.name, 'food') : null;
        const food = foodOf(pack), bankFood = foodOf(s.bank);
        // Time until the pack and bank food is gone at the measured eat rate (game time, 0.4 s a tick); the farmer
        // refills its pack from the bank, so the pack alone is not the limit.
        const emptyTicks = eat && eat > 0 ? (food + bankFood) / eat : null;
        return { kind: 'gold', coins, made: start != null ? coins - start : null, coinsPerTick: cpt, food, bankFood, eatPerTick: eat, emptyMs: emptyTicks != null ? emptyTicks * world.tickMs : null };
    }
    // Food chain (research/food-chain.md): the cook banks cooked fish at Draynor; the courier carries them as notes.
    const fishCount = (l: any[] | null | undefined, re: RegExp) => (l ?? []).filter((i: any) => re.test(i?.name ?? '')).reduce((n: number, i: any) => n + i.count, 0);
    if (/^food chain: fish/i.test(goal)) return { kind: 'cook', cooked: fishCount(s.bank, /^(trout|salmon)$/i), raw: fishCount(pack, /^raw (trout|salmon)$/i), cookedPack: fishCount(pack, /^(trout|salmon)$/i), burnt: fishCount(s.bank, /^burnt fish$/i), feathers: fishCount(pack, /^feather$/i), xpPerTick: xpRate };
    if (/^food chain: courier/i.test(goal)) return { kind: 'courier', fish: fishCount(pack, /^(trout|salmon)$/i), coins: coinsOf(s), at: placeOf(s.pos) };
    if (/fish/i.test(goal) || s.role === 'fishing') return { kind: 'fish', xpPerTick: xpRate, feathers: pack.filter((i: any) => i?.name === 'Feather').reduce((n: number, i: any) => n + i.count, 0) };
    if (/woodcut|chop/i.test(goal) || s.role === 'woodcutting') return { kind: 'wood', xpPerTick: xpRate, hp: s.hp ?? null };
    if (/bank/i.test(goal) || s.name === BANKER) return { kind: 'bank' };
    return { kind: 'xp', xpPerTick: xpRate };
}

// ---------- main account race: the planner's schedule against the live #1 deadlines ----------
// One source of truth: exactly the options of `bun packages/planner/src/haggis-cli.ts research/hiscores-live.json`,
// scenario a (all techniques eligible, travel on). The headline is the realistic plan; the
// floor plan is shown next to it.
const LIVE_HISCORES = join(root, 'research', 'hiscores-live.json');
const BOARDS_FILE = join(root, 'packages', 'planner', 'src', 'haggis-boards.json');
const TRAVEL_FILE = join(root, 'packages', 'planner', 'src', 'haggis-travel.json');
const GATE_FILE = join(practice, 'haggis-go.json');
const GAP_FILE = join(practice, 'gap-history.jsonl');
// `m: 'cli'` marks points made with the CLI's options; older points used another model (no travel) and are not shown.
type GapRec = { at: number; gap: number | null; floorGap?: number | null; wins: number; floorWins: number; m?: string };
const gapHistory: GapRec[] = tailJsonl<GapRec>(GAP_FILE, 300).filter(g => g.m === 'cli');
let raceCache: { key: string; value: any } | null = null;
const mt = (f: string) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
function race() {
    const key = [LIVE_HISCORES, BOARDS_FILE, TRAVEL_FILE].map(mt).join('|');
    if (!mt(LIVE_HISCORES)) return null;
    if (raceCache?.key === key) return raceCache.value;
    try {
        const boards = loadSnapshot(LIVE_HISCORES);
        const acts = haggisActivities(), travel = haggisTravel();
        const run = (mode: 'floor' | 'realistic') => scheduleOverall(boards, acts, { travel, mode, tricks: new Set(TRICKS) });
        const fl = run('floor'), re = run('realistic');
        // Evidence of the inputs behind each board: the activities (levers applied) that serve it. Overall: all of them.
        const live = applyLevers(acts, {});
        const ev = (id: string) => {
            const l = live.filter(a => id === 'overall' || a.serves.includes(id as any)).map(a => (a.ticks ?? a.train?.xpPerTick)?.evidence ?? a.evidence);
            return { measured: l.filter(e => e === 'MEASURED').length, codeRead: l.filter(e => e === 'CODE-READ').length, estimate: l.filter(e => e === 'ESTIMATE').length };
        };
        const rows = re.boards.map(r => {
            const f = fl.boards.find(x => x.id === r.id)!, b = boards.find(x => x.id === r.id)!;
            const label = r.label.replace(/\s*\(.*\)$/, ''), holder = (r.label.match(/\(#1 ([^,)]+)/) ?? [])[1] ?? null;
            const rule = b.rule.kind === 'clock' ? { kind: 'clock' } : b.rule.kind === 'qp' ? { kind: 'qp', points: b.rule.leaderPoints, ticks: b.rule.leaderTicks } : { kind: 'value', note: b.rule.note };
            return { id: r.id, label, holder, deadline: r.deadline, rule, evidence: ev(r.id), real: { finish: r.finish, slack: r.slack, status: r.status }, floor: { finish: f.finish, slack: f.slack, status: f.status } };
        });
        const overall = rows.find(r => r.id === 'overall');
        // The board that finishes last in the realistic plan (Overall aside) and the activity that finishes it.
        const clock = rows.filter(r => r.rule.kind === 'clock' && r.id !== 'overall' && r.real.finish != null);
        const lastB = clock.reduce((a, r) => (!a || r.real.finish! > a.real.finish! ? r : a), null as (typeof rows)[number] | null);
        const lastAct = lastB ? [...re.order].reverse().find(p => live.find(a => a.id === p.id)?.serves.includes(lastB.id as any)) : null;
        const n = (l: typeof rows, k: 'real' | 'floor') => l.filter(r => r[k].status === 'WIN').length;
        const value = {
            supplies: re.overallFinish === null ? null : overallRequirementsFor(acts, {travel, mode:'realistic', tricks:new Set(TRICKS)}, re)
                .supplies.map(({consumers,...supply}) => supply),
            rows, unmeasured: (readFileSync(BOARDS_FILE, 'utf8').match(/"evidence":\s*"(ESTIMATE|CODE-READ)"/g) ?? []).length,
            wins: n(rows, 'real'), floorWins: n(rows, 'floor'), gap: overall?.real.slack ?? null, floorGap: overall?.floor.slack ?? null,
            qpEnd: { realistic: re.qp, floor: fl.qp },
            last: lastB ? { board: lastB.label, finish: lastB.real.finish, slack: lastB.real.slack, activity: lastAct?.label ?? null } : null,
            at: Date.now(), source: 'research/hiscores-live.json', sourceAt: Date.parse(JSON.parse(readFileSync(LIVE_HISCORES,'utf8')).takenAt)||0,
            options: 'Planner CLI scenario a. Travel on. Supplies require acquisition. Relaxed scheduling deadlines: ' + (re.boards.filter(b => b.sacrificed).map(b => b.id).join(', ') || 'none'),
        };
        raceCache = { key, value };
        const last = gapHistory[gapHistory.length - 1];
        if (!last || last.gap !== value.gap || last.floorGap !== value.floorGap || last.wins !== value.wins) {
            const rec = { at: Date.now(), gap: value.gap, floorGap: value.floorGap, wins: value.wins, floorWins: value.floorWins, m: 'cli' };
            gapHistory.push(rec); if (gapHistory.length > 300) gapHistory.shift();
            append(GAP_FILE, rec);
        }
        return value;
    } catch (e) { const value = { error: String(e) }; raceCache = { key, value }; return value; }
}
// Readiness report only: no --authorize here. A dashboard refresh must never authorize login.
async function runGate() {
    if (process.env.DASH_READ_ONLY === '1') return;
    try { await Bun.spawn(['bun', join(root, 'scripts', 'haggis-gate.ts')], { stdout: 'ignore', stderr: 'ignore', cwd: root ,windowsHide:true}).exited; } catch { /* next round */ }
}
// Gate details name files by absolute path; the page shows only the file name.
const gateReport = (file:string) => gateView(cached<{ go: boolean; at: number; gates: { name: string; pass: boolean; detail: string }[] } | null>(file, t => {
    const g = JSON.parse(t);
    for (const x of g?.gates ?? []) x.detail = String(x.detail ?? '').replace(/[A-Za-z]:[\\/](?:[^\s\\/]+[\\/])*/g, '');
    return g;
}, null));
const gates = () => { const authorization=gateReport(GATE_FILE); return authorization.go?authorization:gateReport(join(practice,'haggis-readiness.json')); };

// Vault value over time (in memory, one point a minute) for the economy sparkline.
const vaultTrend: { at: number; value: number; coins: number }[] = [];

// Food chain card (research/food-chain.md): the newest fish cook, courier and gold farmers in the live status files
// of the last 6 hours. A courier that last ran give-to-banker.ts with fish still counts as the courier.
function foodChain(st: Map<string, Status>, now: number) {
    const recent = [...st.values()].filter(s => now - s.at < 6 * 3_600_000 && !isLocalServer(s.server) && s.name !== MAIN);
    const newest = (f: (s: Status) => boolean) => recent.filter(f).sort((a, b) => b.at - a.at)[0] ?? null;
    const n = (l: any[] | null | undefined, re: RegExp) => (l ?? []).filter((i: any) => re.test(i?.name ?? '')).reduce((k: number, i: any) => k + i.count, 0);
    const FISH = /^(trout|salmon)$/i, fresh = (s: Status) => now - s.at < 20_000;
    const cook = newest(s => s.goal === 'fishcook.ts');
    const courier = newest(s => s.goal === 'foodcourier.ts' || (s.goal === 'give-to-banker.ts' && /trout|salmon/i.test(String(s.phase ?? ''))));
    if (!cook && !courier) return null;
    const farmers = recent.filter(s => s.goal === 'goldfarm.ts' && fresh(s)).map(s => ({ name: s.name, fresh: true, food: foodOf(s.inventory), bankFood: foodOf(s.bank) }));
    return {
        cook: cook && { name: cook.name, fresh: fresh(cook), at: cook.at, cooked: n(cook.bank, FISH), pack: n(cook.inventory, FISH), raw: n(cook.inventory, /^raw (trout|salmon)$/i), level: (cook.skills ?? []).find((k: any) => k.name === 'Cooking')?.level ?? null },
        courier: courier && { name: courier.name, fresh: fresh(courier), at: courier.at, fish: n(courier.inventory, FISH), place: placeOf(courier.pos), phase: shortPhase(String(courier.phase ?? '')) },
        farmers,
    };
}

function fleetSides(now: number) {
    return fleetSidesView(snapshotFiles(), fleetList(join(FILES.fleet, 'orders')), now, fleetList(join(FILES.fleet, 'receipts')));
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

// ---------- state ----------
function buildState() {
    const proofs=nativeProofs(Date.now());
    const localStatuses = readStatuses();
    const sw = swarm();
    const accountJobs=accountJobRows(sw?.jobs);
    // File/proof reads can span a newer controller publication. Compare those
    // observations with the time after the reads, not the build's old start time.
    const now = Date.now();
    const snapshots=snapshotFiles(),side=process.env.FLEET_SIDE??'local',ownerOf=ownerOfIn(FILES.fleet);
    const st=dashboardStatuses(localStatuses,snapshots,ownerOf,side,now);
    const statusByName=new Map([...st.values()].map(s=>[s.name.toLowerCase(),s]));
    const names = localDisplayNames([...liveAccounts(), ...st.keys(), ...accountJobs.map(j => j.account)],snapshots,ownerOf,side,now);
    const bots = [...names].map(name => {
        const s0 = statusByName.get(name.toLowerCase()) ?? ({ name, at: 0, server: 'rs-sdk-demo.fly.dev', role: 'unknown', skills: [] } as Status);
        const live = roster.get(name.toLowerCase());
        const inWorld = !!live && now - live.seen < 30_000;
        const fresh = !s0.snapshotOnly && now - s0.at < 20_000 && s0.at <= now + 5_000;
        const mine = accountJobs.filter(j => j.account.toLowerCase() === name.toLowerCase());
        // Running by hand: a fresh status from a known script while the swarm has no enabled job for the account.
        const byHand = fresh && !isLocalServer(s0.server) && !mine.some(j => j.enabled && j.script) ? SCRIPT_ROLE[String(s0.goal ?? '')] : undefined;
        const s = byHand ? { ...s0, role: byHand.role, goal: byHand.goal } : s0;
        const rankRows = [...(ranks.get(name)?.rows ?? []), ...valueRanks(name)];
        const guess = NO_ROLE.has(s.role) && name !== MAIN ? inferRole(s, rankRows) : null;
        const skill = byHand ? byHand.skill ?? null : ROLE_SKILL[s.role] ?? (guess && (s.skills ?? []).some((k: any) => k.name === guess) ? guess : null);
        const sk = skill ? (s.skills ?? []).find((k: any) => k.name === skill) : null;
        // TARGET is a level only when it is a whole number from 2 to 99; some scripts use it for a count or a name.
        const targetRaw = Number(s.env?.target), target = Number.isInteger(targetRaw) && targetRaw >= 2 && targetRaw <= 99 ? targetRaw : 99;
        const r = fresh ? rate(name, skill) : null;
        // XP left to this run's TARGET level on this server's curve (packages/planner/src/curve.ts), not always 99.
        const xpLeft = sk && Number.isFinite(sk.xp) ? Math.max(0, xpForLevel(target) - sk.xp) : null;
        const ticksLeft = r && r > 0 && xpLeft != null ? xpLeft / r : null;
        // Pace: the account's hiscore time on the goal board (or this run's ticks) plus ticks left, against #1's time.
        // Pace only means something when the run's target reaches #1's level.
        const topRaw = skill ? topOf(skill) : null;
        const top = topRaw && target >= topRaw.level ? topRaw : null;
        const row = skill ? rankRows.find(x => x.board === skill) : null;
        const played = Math.max(row ? parseTime(row.time) : 0, s.tick ?? 0);
        const finish = ticksLeft != null ? played + ticksLeft : null;
        const ph = s.phase ?? '';
        const since = ph ? phaseSince.get(name + NL + ph) : undefined;
        const last = String(s.timeline ?? '').slice(-1);
        // An account can have two entries (an old disabled single job and a host job): the enabled one wins.
        // An entry without a script is a reservation (the main account), not a job.
        const jobRaw = mine.find(j => j.enabled && j.script) ?? mine.filter(j => j.script).pop() ?? null;
        const jobBeforeStatus = byHand ? { ...(jobRaw ?? { account: name, repeat: false, since: null }), script: String(s0.goal), role: byHand.role, goal: byHand.goal, enabled: true, state: 'manual', note: `started by hand: ${s0.goal}` } as SwarmJob : jobRaw;
        const job = effectiveJob(s, jobBeforeStatus, fresh);
        const processActive = !s.snapshotOnly && procs.some(p => p.accounts.some(a => a.toLowerCase() === name.toLowerCase()) && p.started <= (s.at ?? 0));
        const currentGoal = String(s.goal || job?.goal || '');
        // The status may carry a custom goal. Keep the configured script as
        // classification evidence even when effectiveJob labels it manual.
        const production = productionGoal(currentGoal, jobBeforeStatus?.script);
        const reservedEntry = mine.some(j => !j.script || j.state === 'reserved');
        const res = String(s.result ?? '');
        return {
            ...s, ground: name === MAIN ? [] : s.ground ?? [], flow: name === MAIN || s.snapshotOnly ? null : flowView(flows, name), name, fresh, inWorld, processActive, currentGoal, production, operation: s.snapshotOnly ? (inWorld ? 'unobserved' : 'offline') : operationState({ ...s, inWorld, processActive, planJob:job, reserved: name === MAIN }, now), live: inWorld ? live : null, ranksAt:ranks.get(name)?.at??null, ranks: rankRows.map(x => ({ ...x, ...rankDelta(name, x.board) })),
            role: guess ? guess.toLowerCase() + '*' : s.role, roleInferred: !!guess, seenInFeed: firstSeen.has(name.toLowerCase()),
            practice: isLocalServer(s.server), lastSeen: Math.max(s.at || 0, live?.seen ?? 0) || null,
            goalSkill: skill, goalLevel: target, goalNow: sk?.level ?? null, goalXp: sk?.xp ?? null, xpPerTick: r,
            xpPerHour: r != null ? r * 3_600_000 / world.tickMs : null, spark: s.snapshotOnly ? [] : spark.get(name) ?? [], rateSkill: skill ?? "all skills", xpLeft,
            eta: ticksLeft != null ? fmtTicks(ticksLeft) : null, finish: finish != null ? fmtTicks(finish) : null,
            pace: finish != null && top ? { top: top.name, topTime: fmtTicks(top.ticks), ahead: finish < top.ticks, gap: fmtTicks(Math.abs(top.ticks - finish)) } : null,
            action: fresh ? ({ x: 'xp', v: 'inventory', m: 'move', a: 'anim', d: 'dialog', s: 'stun', i: 'idle' } as Record<string, string>)[last] ?? null : null,
            phaseShort: shortPhase(ph), phaseSince: since?.at ?? null, phaseExact: since?.exact ?? false,
            uptime: s.started && s.at ? s.at - s.started : null,
            outcome: !res ? null : died(res) ? 'died' : /^ok\b/.test(res) ? 'ok' : 'fail',
            nativeProof: resultProof({name,text:res},proofs),
            job, planJob: jobRaw, bounded: boundedOperation(s), reserved: name === MAIN || (reservedEntry && !job),
            // Training: a fresh bot whose goal skill is still below its target, not a gold farmer or a banker.
            training: fresh && !production && sk != null && sk.level < target && !/^gold farm|bank/i.test(String(job?.goal ?? s.goal ?? '')),
            role4: roleView(s, job, fresh, r),
            // Newest RESULT this server saw for the account, and its newest death in the last 24 h.
            lastRes: (() => { const x = newestRes.get(name); return x && (!s.started || x.at >= s.started) ? { at: x.at, ok: x.ok, died: died(x.text), text: x.text } : null; })(),
            death: (() => { const x0 = newestDeath.get(name), x = x0 && now - x0.at < 86_400_000 && (!s.started || x0.at >= s.started) ? x0 : null; return x ? { at: x.at, text: x.text } : null; })(),
        };
    });
    // The other sides' accounts (Codex cloud, Claude cloud): snapshot items and levels, world-feed position, hiscore ranks.
    const local = new Set(bots.map(b => b.name.toLowerCase()));
    for (const r of remoteBots(snapshots, local, roster, firstSeen, now, side, fleetList(join(FILES.fleet, 'plans')), ownerOf))
        (bots as any[]).push({ ...r, ranksAt: ranks.get(r.name)?.at ?? null, ranks: [...(ranks.get(r.name)?.rows ?? []).map(x => ({ ...x, ...rankDelta(r.name, x.board) })), ...valueRanks(r.name)], spark: [], rateSkill: 'all skills' });
    for (const bot of bots as any[]) { bot.questPoints=questPointObservation(bot,now); Object.assign(bot,healthObservation(bot,now)); }
    // In the world now, then fresh status, then the rest (seen in the feed, live accounts, practice bots); Haggis last.
    const tier = (b: typeof bots[number]) => b.reserved ? 5 : b.inWorld ? 0 : b.fresh ? 1 : b.seenInFeed ? 2 : b.practice ? 4 : 3;
    bots.sort((a, b) => tier(a) - tier(b) || (b.at ?? 0) - (a.at ?? 0) || a.name.localeCompare(b.name));
    // 24 boards: each board's #1 against our best live rank on it.
    const boards = [...SKILL_BOARDS.map(b => {
        const top = topOf(b);
        let best: any = null;
        for (const bot of bots) if (bot.name !== MAIN) for (const r of bot.ranks) if (r.board === b && (!best || r.rank < best.rank)) best = { ...r, name: bot.name };
        const ours = best ? parseTime(best.time) : null;
        // close: 1 = level with #1 or faster, toward 0 = far behind (levels, then time).
        const gap = best && top ? (best.level >= top.level
            ? { kind: 'time', ahead: ours! <= top.ticks, text: fmtTicks(Math.abs(top.ticks - ours!)), close: Math.min(1, top.ticks / Math.max(1, ours!)) }
            : { kind: 'level', ahead: false, text: `-${top.level - best.level} lvl`, close: Math.max(0, best.level / top.level) * 0.8 }) : null;
        return { board: b, top: top ? { name: top.name, level: top.level, time: fmtTicks(top.ticks), ticks: top.ticks, live: top.live, at: top.at } : null, best, gap, kind: 'skill' };
    }), ...EXTRA.map(e => {
        const t = extraBoards.get(e.board), first = t?.rows[0], last = t?.rows[t.rows.length - 1];
        return { board: e.board, top: first ? { name: first.name, level: null, time: first.text, ticks: null } : null, best: null, gap: null, kind: 'value', cutoff: last ? { rank: last.rank, text: last.text } : null };
    })];
    const v = vault(bots, now);
    const cargoDir = join(practice, 'cargo');
    const cargo = every(10_000, cargoDir, () => existsSync(cargoDir) ? readdirSync(cargoDir).filter(f => f.endsWith('.json') && !f.startsWith('request-')).flatMap(f => {
        try { return [JSON.parse(readFileSync(join(cargoDir, f), 'utf8'))]; } catch { return []; }
    }) : []);
    const collection = collectionState(bots, [...new Set([...liveAccounts(), ...remoteNames()])], cargo, cachedTail<any>(FILES.vault, 100_000), now);
    if (!vaultTrend.length || now - vaultTrend[vaultTrend.length - 1]!.at > 60_000) { vaultTrend.push({ at: now, value: Math.round(v.value), coins: v.coins }); if (vaultTrend.length > 240) vaultTrend.shift(); }
    const farmers = (bots as any[]).filter(b => b.role4?.kind === 'gold' && !b.practice);
    const itemPrices = getItemPrices(), pricesAt = getPricesAt();
    const visiblePrices: (PriceIdentity | string)[] = [...(bots as any[]).flatMap(b => [b.inventory,b.bank,b.equipment,b.flow?.loot,b.flow?.used].flatMap(l => l ?? []).filter(Boolean)),
        ...(bots as any[]).flatMap(b => (b.ground ?? []).filter((row:any) => Array.isArray(row) && row.length >= 5).map((row:any) => ({id:row[3]}))),
        ...v.items,...v.log.flatMap(t => t.items),...v.flow.flatMap(f => f.items),...keySupplyIds().map(id => ({id})),...npcLootPrices()];
    for (const f of flows.values()) for (const m of [f.loot,f.used]) for (const item of m?.values?.() ?? []) visiblePrices.push(item);
    const projectedPrices = projectItemPrices(itemPrices,visiblePrices);
    const economy = {
        goldPerTick: farmers.reduce((n, b) => n + (b.fresh && b.role4.coinsPerTick > 0 ? b.role4.coinsPerTick : 0), 0),
        farmers: farmers.map(b => ({ name: b.name, fresh: b.fresh, ...b.role4 })),
        trend: vaultTrend.map(t => t.value),
        supplies: keySupplyIds().map(id => ({ id, ...(marketById.get(id) ?? { name: '?', ask: null, bid: null, stock: 0, vwap: null, base: null }) })).filter(x => x.name !== '?'),
        pricesAt,
        itemPricesById: projectedPrices.byId,
        itemPricesByName: projectedPrices.byName,
        // One value per item a fleet account holds, the same value the vault total uses (7-day VWAP after 3 trades,
        // else the shop base price), for the page's item prices and bank value.
        // The game's examine text of each held item (obj configs), for the page's Examine option.
        ...projectItemExamine(itemExamines,(bots as any[]).flatMap(b=>[b.inventory,b.bank,b.equipment].flatMap(l=>l??[]).filter(Boolean))),
        // Also the items of the Loot and Supplies lists (flow.ts), which stay after the fleet holds none of them.
        itemValues: (() => { const out: Record<string, number> = {}; for (const i of visiblePrices) { const name=typeof i==='string'?i:i.name; if(!name)continue; const p=itemPrice({byId:{},byName:projectedPrices.byName},name); if(p)out[name]=p.value; } return out; })(),
        // The Equipment-board set for the Supply ledger's Best in slot tab (S.economy.gearTargets): each slot's accepted item ids and the first one's name.
        gearTargets: GEAR_TARGETS.map(t => ({ slot: t.slot, ids: [t.id, ...('equivalentIds' in t ? t.equivalentIds ?? [] : [])], name: OBJS.get(t.id)?.name ?? null, need: t.need, source: t.source })),
    };
    const prac = practiceNames();
    const sys = {
        freeGB: freemem() / 2 ** 30, totalGB: totalmem() / 2 ** 30, cpu: cpuPct, cores: cpus().length, buildMs,
        procs: procs.map(p => ({ ...p, up: now - p.started })),
    };
    const objectives=cached(join(root,'docs/plans/joined-plan.md'),goalPlan,goalPlan(''));
    const currentRace=race(),currentGates=gates();
    const currentScoreboard=cached(FILES.scoreboard,text=>scoreboardView(JSON.parse(text)),scoreboardView(null));
    const goalInputs:GoalInputs={requirements:currentRace?.supplies??null,
        items:cached<any[]>(join(root,'knowledge/items.json'),JSON.parse,[]),
        quests:cached<any[]>(join(root,'knowledge/quests.json'),JSON.parse,[]),
        questConstants:cached(join(root,'vendor/rs-sdk/server/content/scripts/general/configs/quest.constant'),text=>text,''),
        receipts:Object.fromEntries(Object.entries(GOAL_RECEIPTS).map(([key,path])=>[key,cached<any>(join(root,path),JSON.parse,null)]))};
    const progress=goalProgress({now,bots,boards,collection,objectives,race:currentRace,gates:currentGates,scoreboard:currentScoreboard},goalInputs);
    // The quest journals travel as one list and each bot's finished and started ids (quest-pack.ts); the page expands them.
    const packedQuests = packQuests(bots as any[]);
    return {
        now, objectives:{...objectives,progress}, world: { ...world, tick: serverTick() }, worldPlayers: world.players, bots: packedQuests.bots, questList: packedQuests.questList, boards,
        coordination:(()=>{const file=join(practice,'coordinator/state.json');try{return coordinationView(cached(file,JSON.parse,null),statSync(file).mtimeMs,now,existsSync(join(practice,'stop-coordinator'))||existsSync(join(practice,'stop-swarm')));}catch{return coordinationView(null,0,now);}})(),
        events: events.slice(0, 160).map(e => ({ ...e, text: shortPhase(e.text), full: e.text, practice: prac.has(e.name) })),
        results: results.slice(0, 120).map(r => ({ ...r, practice: prac.has(r.name),nativeProof:resultProof(r,proofs) })), scripts: scripts(proofs), alerts: alerts(bots, now), requests: requests(), mainPlan: haggisPlan(),
        capacity: capacityState(sw,sys.freeGB,now),
        swarm: sw ? { at: sw.at, freeGB: sw.freeGB, running: sw.running, externalRunning: sw.externalRunning ?? null, pendingStartup: sw.pendingStartup ?? null, pendingReserveGB: sw.pendingReserveGB ?? null, minFreeGB: sw.minFreeGB ?? null, maxBots: sw.maxBots, jobs: sw.jobs.length } : null,
        // An open page reloads itself when index.html changes, so a deploy reaches the owner's tab.
        viewerTimings: viewerTimings.slice(0, 20),
        race: currentRace, gates: currentGates, chain: foodChain(st, now), gapHistory: gapHistory.slice(-120).map(g => ({ at: g.at, gap: g.gap, floorGap: g.floorGap ?? null })), economy,
        pageVersion: (() => { try { return Math.max(...[PAGE_FILE,...['map-shell.css','map-shell.js','client-shell.css','client-shell.js','client-viewer.css','operations.css','operations.js','xp-tracker.js'].map(f=>join(dashboardDir,f))].map(f=>existsSync(f)?statSync(f).mtimeMs:0)); } catch { return 0; } })(),
        ...(() => {
            // Other players: the roster, each board's rivals, who stands at our claimed spots.
            const fleet = new Set(bots.map(b => b.name.toLowerCase()));
            const best = new Map(SKILL_BOARDS.map(b => { let top: { rank: number; name: string } | null = null; for (const bot of bots as any[]) for (const r of bot.ranks ?? []) if (r.board === b && (!top || r.rank < top.rank)) top = { rank: r.rank, name: bot.name }; return [b, top] as const; }));
            const rivals = rivalsView(boardTops, roster, fleet, best, now);
            const contention = contentionView(fleetList(join(FILES.fleet, 'claims')), roster, fleet, now);
            return { roster: rosterView(roster, now), rivals, contention, farms: farmsView(roster, fleet, contention, now), wilderness: wildernessView(roster, fleet, now), overtake: overtakeView(boardTops, bots as any, xpForLevel) };
        })(),
        prs: prRows,
        scoreboard:currentScoreboard, fleetSides:fleetSides(now),
        wildernessOverlay: wildernessOverlayData(),
        diagnostics:fleetDiagnostics(now),
        icons, vault: v, collection, map: { ...MAP, ready: !!getMapBytes() }, sys, snapshotAt: snapshot?.takenAt ?? null, liveTopsAt: Math.max(0, ...[...liveTop.values()].map(t => t.at)), liveTops: liveTop.size,
    };
}

const viewerTimings: { at: number; mode: string; ms: number; tiles: number; frames: number; blankFrames: number; holdFrames: number }[] = [];

// One state for everyone: built every 2 s only while a client watches, serialized once, sent to each SSE client.
const clients = new Set<ReadableStreamDefaultController>();
let latest = { at: 0, json: '' };
// A page that connects gets the last built state at once, and the next tick sends a new one. A build holds the
// server for 150 to 300 ms, and each other request of the loading page waits behind it. The publisher reads the
// state each 60 s, so the last state is younger than this limit while the publisher runs.
const FIRST_STATE_MAX_AGE_MS = 90_000;
// The time the newest state took to build and write; the next state reports it in sys.
let buildMs = 0;
function current() {
    // The main account's name never leaves the server unasked: every string value has it swapped for a marker, which
    // the page draws as a blurred block (owner rule: screenshots must not show it). /api/reveal returns it on a click.
    if (Date.now() - latest.at > 1500) {
        try {
            // One replace on the finished text masks every value and every key.
            const t0 = performance.now(), json = JSON.stringify(buildState()).replace(SECRET_RE, SECRET_MARK);
            buildMs = Math.round(performance.now() - t0);
            latest = { at: Date.now(), json };
        } catch (e) {
            // A malformed status file or a transient read failure must not stop the dashboard for every client.
            // Keep the last good state, and expose the failure so the page can show it.
            console.error(`state build failed: ${String(e)}`);
            if (latest.json) {
                try {
                    const stale = JSON.parse(latest.json);
                    stale.stateError = String(e).replace(SECRET_RE, SECRET_MARK);
                    latest = { at: Date.now(), json: JSON.stringify(stale) };
                } catch {
                    // If the previous state cannot be parsed, fall through to a minimal error state.
                }
            }
            if (!latest.json) {
                latest = { at: Date.now(), json: JSON.stringify({
                    now: Date.now(), stateError: String(e).replace(SECRET_RE, SECRET_MARK), bots: [], boards: [], events: [], results: [],
                    scripts: [], alerts: [], requests: [], mainPlan: null, capacity: null, swarm: null,
                    viewerTimings: [], race: null, gates: [], chain: null, gapHistory: [], economy: null,
                    pageVersion: 0, icons: {}, vault: null, collection: null, map: { ...MAP, ready: false },
                    sys: null, snapshotAt: null, liveTopsAt: 0, liveTops: 0, world: {}, worldPlayers: 0,
                }) };
            }
        }
    }
    return latest.json;
}
// ---------- SSE broadcast ----------
function getLatest() { return latest; }
function startStateBackground() {
    setInterval(() => {
        const now = cpus().map(c => c.times);
        let busy = 0, all = 0;
        now.forEach((t, i) => {
            const p = cpuPrev[i]!;
            const d = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq);
            busy += d; all += d + (t.idle - p.idle);
        });
        cpuPct = all ? 100 * busy / all : 0;
        cpuPrev = now;
    }, 4000);
    setInterval(() => void scanProcs(), 30_000);
    setInterval(() => void refreshPrs(), 300_000);
    void refreshPrs();
    setInterval(() => void runGate(), 600_000);
    setTimeout(() => void runGate(), 20_000);
    setInterval(() => {
        if (!clients.size) return;
        const msg = `data: ${current()}\n\n`;
        for (const c of clients) {
            // A client that holds the socket open and does not read would queue each state without limit.
            if ((c.desiredSize ?? 1) < -64) { clients.delete(c); try { c.close(); } catch { /* closed */ } continue; }
            try { c.enqueue(msg); } catch { clients.delete(c); }
        }
    }, 2000);
    // The first build reads every status file and every bot.env, which takes seconds. Do it at the start, so the
    // first page load does not wait for it.
    setTimeout(() => void current(), 1_000);
}

export {
    alerts,
    buildState,
    clients,
    current,
    FIRST_STATE_MAX_AGE_MS,
    fleetDiagnostics,
    flowRate,
    getLatest,
    maybeScanProcs,
    practiceNames,
    rate,
    readLeaseDiagnostics,
    readStatuses,
    scanProcs,
    startStateBackground,
    track,
    viewerTimings,
};
