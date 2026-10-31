// Swarm dashboard server. Usage: bun packages/dashboard/server.ts  ->  http://localhost:3100
// Sources: the status files every bot writes (.practice/status/<name>.json, packages/core/src/status.ts), the live
// accounts in vendor/rs-sdk/bots (SERVER = the demo), the swarm controller (.practice/swarm-state.json), the world feed
// (who is in the world, server tick, player count), our live hiscore ranks (cached 5 min), the 2026-10-22 board
// snapshot (each skill board's #1), the live Equipment, Bank and Runite boards, Grand Exchange prices
// (/api/market/items), research/owner-requests.md (the owner's request queue), the Haggis plan (research/haggis-run.md
// when it has a board table, else haggis-plan.json here), and this machine (memory, CPU, bun processes).
// One state is built every 2 s while someone watches and sent to every client over server-sent events.
// Files it keeps: .practice/events.jsonl (phase changes), .practice/results.jsonl (RESULT lines),
// .practice/rank-history.jsonl (rank changes). It reads .practice/vault-log.jsonl (the banker's transfers).
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { cpus, freemem, totalmem } from 'node:os';
import { createHash } from 'node:crypto';
import { accountJobRows, collectionState, operationState, isLoopback, effectiveJob, productionGoal, boundedOperation, capacityState, hostStopNativeProof, productionReview, type NativeProof } from './collection';
import {requestEvidence,gateView} from './evidence';
import {goalPlan,goalProgress,GOAL_RECEIPTS,type GoalInputs} from './goals';
import { VIEWER_MANIFEST_SHA256, viewerAssetRoute, viewerBridgeSource } from './viewer';
import {coordinationView} from './coordination';
import {createOperatorControl} from './operator-control';
import { xpForLevel } from '../planner/src/curve';
import { applyLevers, haggisActivities, haggisTravel, loadSnapshot, schedule, suppliesFor, TRICKS } from '../planner/src/haggis';

const root = resolve(import.meta.dir, '..', '..');
const operatorControl=createOperatorControl({root});
const practice = join(root, '.practice');
const statusDir = join(practice, 'status');
const botsDir = join(root, 'vendor', 'rs-sdk', 'bots');
const FILES = {
    events: join(practice, 'events.jsonl'),
    results: join(practice, 'results.jsonl'),
    ranks: join(practice, 'rank-history.jsonl'),
    vault: join(practice, 'vault-log.jsonl'),
    swarm: join(practice, 'swarm-state.json'),
    requests: join(root, 'research', 'owner-requests.md'),
    haggisRun: join(root, 'research', 'haggis-run.md'),
    haggisPlan: join(import.meta.dir, 'haggis-plan.json'),
};
const PORT = Number(process.env.DASH_PORT ?? 3100);
const PAGE_FILE = resolve(process.env.DASH_PAGE ?? join(import.meta.dir, 'index.html'));
// The state holds bot positions, inventories, banks and account names, so only this PC listens by default.
// DASH_HOST=0.0.0.0 opens it to the network on purpose (the reveal routes still answer loopback only).
const HOST = process.env.DASH_HOST ?? '127.0.0.1';
const DEMO = 'https://rs-sdk-demo.fly.dev';
const BANKER = 'Moneyshot';
const MAIN = 'Haggis';
const SECRET_RE = new RegExp(MAIN, 'gi');
const SECRET_MARK = '⟦MAIN⟧';
// A script started by hand (outside the swarm) reports its file name as the goal, and the swarm still lists the
// account's old job. This map names what the script does, so the roster shows the run, not the stale job.
const SCRIPT_ROLE: Record<string, { role: string; skill?: string; goal: string }> = {
    'fishcook.ts': { role: 'cooking', skill: 'Cooking', goal: 'food chain: fish and cook' },
    'foodcourier.ts': { role: 'courier', goal: 'food chain: courier' },
    'goldfarm.ts': { role: 'thieving', goal: 'gold farm: knights, food by trade' },
    'banker.ts': { role: 'bank', goal: 'bank' },
    'give-to-banker.ts': { role: 'give', goal: 'give to the bank' },
};
const ROLE_SKILL: Record<string, string> = { thieving: 'Thieving', fishing: 'Fishing', woodcutting: 'Woodcutting', mining: 'Mining', runecraft: 'Runecraft', cooking: 'Cooking', crafting: 'Crafting', combat: 'Attack' };
const NL = String.fromCharCode(10);

function tailJsonl<T>(file: string, n: number): T[] {
    try {
        return readFileSync(file, 'utf8').split(NL).filter(Boolean).slice(-n).flatMap(l => { try { return [JSON.parse(l) as T]; } catch { return []; } });
    } catch { return []; }
}
function append(file: string, doc: unknown) {
    if (process.env.DASH_READ_ONLY === '1') return;
    try { appendFileSync(file, JSON.stringify(doc) + NL); } catch { /* locked or full: memory still has it */ }
}
// Re-reads a file only when its mtime changes.
const fileCache = new Map<string, { mtime: number; value: unknown }>();
function cached<T>(file: string, parse: (text: string) => T, empty: T): T {
    try {
        const mtime = statSync(file).mtimeMs, hit = fileCache.get(file);
        if (hit && hit.mtime === mtime) return hit.value as T;
        const value = parse(readFileSync(file, 'utf8'));
        fileCache.set(file, { mtime, value });
        return value;
    } catch { return (fileCache.get(file)?.value as T) ?? empty; }
}

// ---------- map: 2 tiles per pixel; 0 void, 1 land, 2 water/blocked floor, 3 objects/walls ----------
const MAP = { x0: 2368, z0: 2880, w: 560, h: 416, scale: 2 };
let mapBytes: Uint8Array | null = null;
function buildMap() {
    try {
        const t0 = Date.now();
        const data = JSON.parse(readFileSync(join(root, 'vendor', 'rs-sdk', 'sdk', 'collision-data.json'), 'utf8'));
        const counts = new Uint16Array(MAP.w * MAP.h * 4);
        const zoneLand = new Uint8Array(MAP.w * MAP.h);
        const cell = (x: number, z: number) => {
            const px = Math.floor((x - MAP.x0) / MAP.scale), pz = Math.floor((z - MAP.z0) / MAP.scale);
            return px < 0 || pz < 0 || px >= MAP.w || pz >= MAP.h ? -1 : pz * MAP.w + px;
        };
        for (const [level, zx, zz] of data.zones) {
            if (level !== 0) continue;
            for (let dx = 0; dx < 8; dx += MAP.scale) for (let dz = 0; dz < 8; dz += MAP.scale) { const c = cell(zx + dx, zz + dz); if (c >= 0) zoneLand[c] = 1; }
        }
        for (const [level, x, z, flags] of data.tiles) {
            if (level !== 0) continue;
            const c = cell(x, z); if (c < 0) continue;
            counts[c * 4 + ((flags & 2097152) ? 2 : 3)]++;
        }
        mapBytes = new Uint8Array(MAP.w * MAP.h);
        for (let i = 0; i < mapBytes.length; i++) {
            const water = counts[i * 4 + 2]!, obj = counts[i * 4 + 3]!;
            mapBytes[i] = water >= 2 ? 2 : obj >= 2 ? 3 : zoneLand[i] ? 1 : water ? 2 : 0;
        }
        console.log(`map built in ${Date.now() - t0} ms`);
    } catch (e) { console.log(`map build failed: ${String(e)}`); }
    // The 27 MB collision JSON parses into a large heap; give it back now, not at some later GC.
    setTimeout(() => Bun.gc(true), 0);
}
setTimeout(buildMap, 100);

// ---------- bots ----------
type Status = Record<string, any> & { name: string; at: number; server: string };
type Item = { name: string; count: number };
let accountsCache = { at: 0, names: [] as string[] };
function liveAccounts(): string[] {
    if (Date.now() - accountsCache.at < 30_000) return accountsCache.names;
    const names = !existsSync(botsDir) ? [] : readdirSync(botsDir).filter(n => {
        try { return n !== '_template' && /SERVER=rs-sdk-demo/.test(readFileSync(join(botsDir, n, 'bot.env'), 'utf8')); } catch { return false; }
    });
    accountsCache = { at: Date.now(), names };
    return names;
}
// Status files are parsed again only when their mtime changes; track() runs once per new version.
const statusCache = new Map<string, { mtime: number; doc: Status }>();
function readStatuses(): Map<string, Status> {
    const out = new Map<string, Status>();
    if (!existsSync(statusDir)) return out;
    for (const f of readdirSync(statusDir)) {
        if (!f.endsWith('.json')) continue;
        const p = join(statusDir, f);
        try {
            const mtime = statSync(p).mtimeMs;
            let hit = statusCache.get(p);
            if (!hit || hit.mtime !== mtime) {
                hit = { mtime, doc: JSON.parse(readFileSync(p, 'utf8')) };
                statusCache.set(p, hit);
                track(hit.doc);
            }
            const s = hit.doc;
            if (/^localhost/.test(s.server) && Date.now() - s.at > 30 * 60_000) continue; // stale practice bots
            out.set(s.name, s);
        } catch { /* being written */ }
    }
    return out;
}

// XP rate samples, xp/tick history (sparkline), phase start times.
// Each sample keeps every skill's XP, so a rate can be taken for one skill (the goal) and not the sum of all.
type Sample = { at: number; tick: number; xp: number; sk: Record<string, number>; coins: number; food: number };
// Food a gold farmer eats: the pack items the thieving scripts eat (lobsters, cakes, bread, chocolate, fish).
const FOOD_RE = /lobster|cake|bread|chocolate|shrimp|anchov|trout|salmon|tuna|swordfish|pike|herring|sardine|meat|chicken/i;
const coinsOf = (s: Status) => [...(s.inventory ?? []), ...(s.bank ?? [])].filter((i: any) => i?.name === 'Coins').reduce((n: number, i: any) => n + i.count, 0);
const foodOf = (l: any[] | null | undefined) => (l ?? []).filter((i: any) => i?.name && FOOD_RE.test(i.name) && !/noted/i.test(i.name)).reduce((n: number, i: any) => n + i.count, 0);
// Coins at the first status of each run (name + started), so "made this run" survives a dashboard restart only
// within one process; it restarts from the next status after that.
const runStartCoins = new Map<string, number>();
const samples = new Map<string, Sample[]>();
const spark = new Map<string, number[]>();
type Ev = { at: number; name: string; text: string };
const events: Ev[] = tailJsonl<Ev>(FILES.events, 200).reverse();
const lastPhase = new Map<string, string>();
const phaseSince = new Map<string, { at: number; exact: boolean }>();
for (const e of [...events].reverse()) phaseSince.set(e.name + NL + e.text, { at: e.at, exact: true });
function track(s: Status) {
    const xp = (s.skills ?? []).reduce((n: number, k: any) => n + (k.xp ?? 0), 0);
    const sk: Record<string, number> = {};
    for (const k of s.skills ?? []) sk[k.name] = k.xp ?? 0;
    const list = samples.get(s.name) ?? [];
    // A status written before the game state loaded has 0 XP in every skill; as a sample it would make the next
    // real one look like a jump of the account's whole XP (214M xp/h on a level-99 thief).
    if (xp > 0 && (!list.length || list[list.length - 1]!.tick !== s.tick)) {
        list.push({ at: s.at, tick: s.tick, xp, sk, coins: coinsOf(s), food: foodOf(s.inventory) + foodOf(s.bank) });
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
    return (b.coins - a.coins) / (b.tick - a.tick);
}
function goalSkillOf(s: Status): string | null {
    const known = SCRIPT_ROLE[String(s.goal ?? '')]?.skill ?? ROLE_SKILL[s.role];
    if (known) return known;
    if (NO_ROLE.has(s.role) && s.name !== MAIN) return inferRole(s, ranks.get(s.name)?.rows ?? []);
    return null;
}

// ---------- RESULT lines: every new result a status file shows, with pass/fail streaks per script ----------
type Res = { at: number; name: string; goal: string; ok: boolean; text: string };
const allResults = tailJsonl<Res>(FILES.results, 100_000);
const results: Res[] = allResults.slice(-300).reverse();
const died = (text: string) => /\bdied=true\b/.test(text) || /\bdied (?!=)/.test(text);
// Per account, the newest result and the newest death. They do not drop out of the 300-row list when practice runs
// fill it (2026-10-23: three live farmer deaths vanished from the page that way).
const lastResult = new Map<string, string>(), newestRes = new Map<string, Res>(), newestDeath = new Map<string, Res>();
const noteRes = (r: Res) => { lastResult.set(r.name, r.text); newestRes.set(r.name, r); if (died(r.text)) newestDeath.set(r.name, r); };
for (const r of allResults) noteRes(r);
function trackResult(s: Status) {
    const text = String(s.result ?? '');
    if (!text || lastResult.get(s.name) === text.slice(0, 240)) return;
    const r = { at: s.at, name: s.name, goal: String(s.goal ?? '').replace(/\.ts$/, ''), ok: /^ok\b/.test(text), text: text.slice(0, 240) };
    noteRes(r);
    results.unshift(r);
    results.length = Math.min(results.length, 300);
    append(FILES.results, r);
}
type ProofEntry = {proof: NativeProof; resultPrefix: string};
let proofScanAt=0;
let proofCache=new Map<string,ProofEntry>();
function nativeProofs(now: number): Map<string,ProofEntry> {
    if(now-proofScanAt<10_000)return proofCache;
    proofScanAt=now;
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
let procsAt = 0;
async function scanProcs(force = false) {
    if (!clients.size && !force) return; // nobody watching: no PowerShell
    procsAt = Date.now();
    try {
        const ps = "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.CreationDate.ToString('o'), $_.WorkingSetSize, $_.CommandLine }";
        const p = Bun.spawn(['powershell', '-NoProfile', '-Command', ps], { stdout: 'pipe', stderr: 'ignore' ,windowsHide:true});
        const text = await new Response(p.stdout).text();
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
    } catch { /* not Windows */ }
}
setInterval(() => void scanProcs(), 30_000);

// ---------- world feed: who is in the world, server tick, player count ----------
const roster = new Map<string, { x: number; z: number; level: number; combat: number; seen: number }>();
const firstSeen = new Map<string, number>();
const world = { players: 0, tick: 0, tickAt: 0, tickMs: 400, connected: false, rev: 0 };
function connectFeed() {
    try {
        const ws = new WebSocket('wss://rs-sdk-demo.fly.dev/worldfeed');
        ws.onopen = () => { world.connected = true; ws.send(JSON.stringify({ t: 'roster', on: true })); };
        ws.onmessage = e => {
            try {
                const m = JSON.parse(String(e.data));
                const now = Date.now();
                if (m.t === 'hello') { world.players = m.players ?? world.players; world.tick = m.tick ?? world.tick; world.tickAt = now; world.tickMs = m.tickMs ?? 400; world.rev = m.rev ?? 0; }
                if (m.t !== 'roster') return;
                if (!Array.isArray(m.p)) return;
                world.players = m.p.length;
                if (m.k) { world.tick = m.k; world.tickAt = now; }
                for (const p of m.p) {
                    if (!Array.isArray(p) || p.length < 6) continue;
                    const n = String(p[1]).toLowerCase();
                    if (!firstSeen.has(n)) firstSeen.set(n, now);
                    roster.set(n, { x: p[2], z: p[3], level: p[4], combat: p[5], seen: now });
                }
            } catch (err) {
                console.error(`world feed message failed: ${String(err)}`);
            }
        };
        ws.onclose = () => { world.connected = false; setTimeout(connectFeed, 5000); };
        ws.onerror = () => ws.close();
    } catch { setTimeout(connectFeed, 5000); }
}
connectFeed();
const serverTick = () => world.tickAt ? world.tick + Math.floor((Date.now() - world.tickAt) / world.tickMs) : null;
const fmtTicks = (ticks: number) => { const s = Math.round(ticks * world.tickMs / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const parseTime = (t: string) => { let s = 0; for (const [, n, u] of t.matchAll(/(\d+)([hms])/g)) s += Number(n) * (u === 'h' ? 3600 : u === 'm' ? 60 : 1); return Math.round(s * 1000 / world.tickMs); };

// ---------- hiscores: our ranks (and their history), the 24 boards ----------
const SKILL_BOARDS = ['Overall', 'Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft', 'Quest Points'];
const EXTRA = [{ board: 'Equipment', path: 'outfit' }, { board: 'Bank', path: 'bank' }, { board: 'Runite', path: 'runite' }];
const ALL_BOARDS = [...SKILL_BOARDS, ...EXTRA.map(e => e.board)];
type Row = { board: string; rank: number; level: number; time: string };
const ranks = new Map<string, { at: number; rows: Row[] }>();
type RankRec = { at: number; name: string; board: string; rank: number; level: number };
const rankHist = new Map<string, RankRec[]>(); // name|board -> history, oldest first
for (const r of tailJsonl<RankRec>(FILES.ranks, 5000)) { const k = r.name + '|' + r.board; const l = rankHist.get(k) ?? []; l.push(r); rankHist.set(k, l); }
async function refreshRanks() {
    for (const name of liveAccounts()) {
        const r = ranks.get(name);
        if (r && Date.now() - r.at < 300_000) continue;
        try {
            const text = (await (await fetch(`${DEMO}/hiscores/player/${encodeURIComponent(name.toLowerCase())}?profile=main`)).text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
            const rows: Row[] = [];
            for (const b of SKILL_BOARDS) {
                const m = text.match(new RegExp(`${b} ([0-9,]+) ([0-9]+) ((?:\\d+h )?(?:\\d+m )?\\d+s)`));
                if (m && Number(m[2]) > 1) rows.push({ board: b, rank: Number(m[1]!.replace(/,/g, '')), level: Number(m[2]), time: m[3]! });
            }
            ranks.set(name, { at: Date.now(), rows });
            for (const row of rows) {
                const k = name + '|' + row.board, l = rankHist.get(k) ?? [], last = l[l.length - 1];
                if (last && last.rank === row.rank && last.level === row.level) continue;
                const rec = { at: Date.now(), name, board: row.board, rank: row.rank, level: row.level };
                l.push(rec); if (l.length > 200) l.shift(); rankHist.set(k, l);
                append(FILES.ranks, rec);
            }
        } catch { /* next round */ }
        await Bun.sleep(1200);
    }
}
setInterval(() => void refreshRanks(), 60_000);
void refreshRanks();
function rankDelta(name: string, board: string) {
    const l = rankHist.get(name + '|' + board) ?? [];
    if (l.length < 2) return { delta: 0, since: null as number | null, hist: l.map(r => r.rank) };
    const day = Date.now() - 86_400_000, base = l.find(r => r.at >= day) ?? l[l.length - 2]!, now = l[l.length - 1]!;
    return { delta: base.rank - now.rank, since: base.at, hist: l.slice(-30).map(r => r.rank) };
}
// Live #1 per skill board (category = skill index + 1, Quest Points 100: packages/planner/src/scout-cli.ts),
// refreshed hourly, one request a second. The 2026-10-22 snapshot is only the fallback, with its age shown.
const CATEGORY: Record<string, number> = { Overall: 0, 'Quest Points': 100 };
['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', null, null, 'Runecraft']
    .forEach((b, i) => { if (b) CATEGORY[b] = i + 1; });
// Same page shape as packages/planner/src/scout.ts parseBoard, but the time title now reads
// "2,935 ticks normalized to 400 ms per tick", which that parser's `ticks"` pattern misses.
function parseBoard(html: string): { rank: number; name: string; level: number; ticks: number }[] {
    const names = [...html.matchAll(/href="\/hiscores\/player\/([^"?]+)\?[^"]*"[^>]*>([^<]*)<\/a><br>/g)].map(m => decodeURIComponent(m[1]!));
    const ticks = [...html.matchAll(/title="([\d,]+) ticks\b/g)].map(m => Number(m[1]!.replace(/,/g, '')));
    const nums = [...html.matchAll(/(?:^|>)\s*([\d,]+)<br>/gm)].map(m => Number(m[1]!.replace(/,/g, '')));
    const n = names.length;
    if (ticks.length < n || nums.length < 2 * n) return [];
    return names.map((name, i) => ({ rank: nums[i]!, name, level: nums[n + i]!, ticks: ticks[i]! }));
}
const liveTop = new Map<string, { name: string; level: number; ticks: number; at: number }>();
async function refreshLiveTops() {
    for (const b of SKILL_BOARDS) {
        try {
            const rows = parseBoard(await (await fetch(`${DEMO}/hiscores?category=${CATEGORY[b]}&profile=main`, { signal: AbortSignal.timeout(15_000) })).text());
            if (rows[0]) liveTop.set(b, { name: rows[0].name, level: rows[0].level, ticks: rows[0].ticks, at: Date.now() });
        } catch { /* keep the last value */ }
        await Bun.sleep(1000);
    }
}
setInterval(() => void refreshLiveTops(), 3_600_000);
void refreshLiveTops();
function topOf(board: string): { name: string; level: number; ticks: number; at: number; live: boolean } | null {
    const l = liveTop.get(board);
    if (l) return { ...l, live: true };
    const s = snapshot?.boards?.find((x: any) => x.board === board)?.rows?.[0];
    return s ? { name: s.name, level: s.level, ticks: s.ticks, at: Date.parse(snapshot.takenAt) || 0, live: false } : null;
}
const snapshot = (() => { try { return JSON.parse(readFileSync(join(root, 'research', 'hiscores-2026-10-22.json'), 'utf8')); } catch { return null; } })();
// Equipment, Bank and Runite boards: #1 holder and value, scraped every 10 min.
const extraTop = new Map<string, { name: string; value: string; at: number } | null>();
async function refreshExtra() {
    for (const e of EXTRA) {
        try {
            const text = (await (await fetch(`${DEMO}/hiscores/${e.path}?profile=main`)).text()).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
            const m = text.match(/(?:# Name [A-Za-z ]*?|All time) 1 (\S+) ([0-9.,]+[KMB]?)/);
            extraTop.set(e.board, m ? { name: m[1]!, value: m[2]!, at: Date.now() } : null);
        } catch { /* next round */ }
    }
}
setInterval(() => void refreshExtra(), 600_000);
void refreshExtra();

// ---------- Grand Exchange prices and item icons ----------
// Icons: items.png is the 32x32 sprite sheet (64 per row, index = item id) copied from
// vendor/lostcity-markets/storage/app/private/items-274.png; items.json maps lower-case names to ids (its obj.json).
// The live market API ids win over items.json when both know a name.
const itemIds = new Map<string, number>(Object.entries((() => { try { return JSON.parse(readFileSync(join(import.meta.dir, 'items.json'), 'utf8')) as Record<string, number>; } catch { return {}; } })()));
const marketIds = new Map<string, number>();
const iconId = (name: string) => marketIds.get(name.toLowerCase()) ?? itemIds.get(name.toLowerCase()) ?? null;
const prices = new Map<string, number>();
const marketById = new Map<number, { name: string; ask: number | null; bid: number | null; stock: number; vwap: number | null; base: number | null }>();
// Key supplies for the main run: the ids in research/market-2026-10-23.json.
const KEY_SUPPLY_FILE = join(root, 'research', 'market-2026-10-23.json');
const keySupplyIds = () => cached<number[]>(KEY_SUPPLY_FILE, t => Object.values(JSON.parse(t).items ?? {}).map((x: any) => Number(x.id)).filter(n => !isNaN(n)), []);
let pricesAt = 0;
async function refreshPrices() {
    try {
        // 100 items per page (the API refuses more); about 15 pages.
        for (let offset = 0, total = 1; offset < total; offset += 100) {
            const j = await (await fetch(`${DEMO}/api/market/items?limit=100&offset=${offset}`, { signal: AbortSignal.timeout(15_000) })).json() as { items: any[]; total: number };
            total = Math.min(j.total ?? 0, 5000);
            // The market is thin: one trade set Bread's lastPrice to 1,000,000. Use the 7-day VWAP when the item
            // traded at least 3 times, else the shop base price.
            for (const i of j.items ?? []) {
                if (i.id != null) { marketIds.set(String(i.name).toLowerCase(), Number(i.id)); marketById.set(Number(i.id), { name: i.name, ask: i.ask ?? null, bid: i.bid ?? null, stock: i.sellQuantity ?? 0, vwap: i.vwap ?? null, base: i.basePrice ?? null }); }
                const p = i.vwap != null && (i.trades ?? 0) >= 3 ? i.vwap : i.basePrice;
                if (p != null) prices.set(String(i.name).toLowerCase(), Number(p));
            }
            await Bun.sleep(500); // 2 requests a second at most
        }
        pricesAt = Date.now();
    } catch { /* next round */ }
}
setInterval(() => void refreshPrices(), 600_000);
void refreshPrices();
const priceOf = (name: string) => name === 'Coins' ? 1 : prices.get(name.toLowerCase()) ?? null;

// ---------- role inference for accounts the names list does not know ----------
const NO_ROLE = new Set(['unknown', 'test', '', undefined, null]);
function inferRole(s: Status, rows: Row[]): string | null {
    let best: { name: string; level: number; xp: number } | null = null;
    for (const k of s.skills ?? []) {
        if (k.name === 'Hitpoints' || /^Stat\d+$/.test(k.name) || k.level <= 1) continue;
        if (!best || k.level > best.level || (k.level === best.level && (k.xp ?? 0) > best.xp)) best = { name: k.name, level: k.level, xp: k.xp ?? 0 };
    }
    if (!best) for (const r of rows) {
        if (['Overall', 'Hitpoints', 'Quest Points'].includes(r.board) || r.level <= 1) continue;
        if (!best || r.level > best.level) best = { name: r.board, level: r.level, xp: 0 };
    }
    return best ? best.name : null;
}

// ---------- vault ----------
// Holdings per account = last snapshot (pack at the status time, bank at bankAt) plus every vault-log transfer
// after that snapshot. The banker's bank snapshot is often older than the deposits, so when no bank snapshot is
// newer than its last logged transfer, the log is its truth: everything received minus everything paid.
type Transfer = { at: number; from: string; to: string; items: Item[] };
const keyName = (n: string) => n.toLowerCase();
function vault(bots: any[], now: number) {
    const log = cached<Transfer[]>(FILES.vault, t => t.split(NL).filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as Transfer]; } catch { return []; } }), []);
    const live = bots.filter(b => !/^localhost/.test(b.server));
    const byKey = new Map(live.map(b => [keyName(b.name), b]));
    const names = new Set<string>([...live.filter(b => b.at).map(b => keyName(b.name))]);
    for (const t of log) { names.add(keyName(t.from)); names.add(keyName(t.to)); }
    const totals = new Map<string, { count: number; holders: Map<string, number> }>();
    const holders = [];
    for (const k of names) {
        const b = byKey.get(k);
        const name = b?.name ?? log.find(t => keyName(t.from) === k)?.from ?? log.find(t => keyName(t.to) === k)?.to ?? k;
        const isBanker = keyName(BANKER) === k;
        const mine = new Map<string, number>();
        const add = (l: Item[] | null | undefined, sign = 1) => { for (const i of l ?? []) if (i?.name && i.count > 0) mine.set(i.name, (mine.get(i.name) ?? 0) + sign * i.count); };
        const mineLog = log.filter(t => keyName(t.from) === k || keyName(t.to) === k);
        const lastLog = mineLog.reduce((n, t) => Math.max(n, t.at), 0);
        let source: 'snapshot' | 'log' | 'snapshot+log';
        if (isBanker && !(b?.bankAt && b.bankAt > lastLog) && mineLog.length) {
            // Base: the banker's last bank snapshot (what it held before the log, or at bankAt), then every logged
            // flow after that snapshot. Without bankAt the snapshot's time is unknown, so every flow is added.
            add(b?.bank);
            for (const t of mineLog) if (!b?.bankAt || t.at > b.bankAt) add(t.items, keyName(t.to) === k ? 1 : -1);
            source = 'log';
        } else {
            const since = b?.at ?? 0;
            add((b?.inventory ?? []).filter(Boolean));
            add(b?.bank);
            const after = mineLog.filter(t => t.at > since);
            for (const t of after) add(t.items, keyName(t.to) === k ? 1 : -1);
            source = after.length ? 'snapshot+log' : 'snapshot';
        }
        for (const [n, c] of [...mine]) if (c <= 0) mine.delete(n);
        let value = 0;
        for (const [n, c] of mine) {
            const t = totals.get(n) ?? { count: 0, holders: new Map() };
            t.count += c; t.holders.set(name, c); totals.set(n, t);
            value += (priceOf(n) ?? 0) * c;
        }
        holders.push({
            name, banker: isBanker, age: b?.at ? now - b.at : null, bankSeen: !!b?.bank || source === 'log', bankAt: b?.bankAt ?? null, source,
            coins: mine.get('Coins') ?? 0, value,
            items: [...mine].filter(([n]) => n !== 'Coins').sort((a, z) => z[1] - a[1]).map(([name, count]) => ({ name, count })),
        });
    }
    holders.sort((a, z) => Number(z.banker) - Number(a.banker) || z.value - a.value || a.name.localeCompare(z.name));
    const items = [...totals].filter(([n]) => n !== 'Coins').map(([name, t]) => {
        const p = priceOf(name);
        return { name, count: t.count, price: p, value: p != null ? p * t.count : null, holders: [...t.holders].sort((a, z) => z[1] - a[1]).map(([n, c]) => ({ name: n, count: c })) };
    }).sort((a, z) => (z.value ?? 0) - (a.value ?? 0) || z.count - a.count || a.name.localeCompare(z.name));
    const coins = totals.get('Coins')?.count ?? 0;
    // Flow: one link per giver -> receiver pair, with coins, value and item counts.
    const links = new Map<string, { from: string; to: string; coins: number; value: number; items: Map<string, number>; n: number; last: number }>();
    // The vault log spells some accounts with a capital first letter; use the account's own spelling.
    const accts = liveAccounts(), canon = (n: string) => accts.find(a => a.toLowerCase() === n.toLowerCase()) ?? n;
    for (const t0 of log) {
        const t = { ...t0, from: canon(t0.from), to: canon(t0.to) };
        const k = t.from + '>' + t.to, l = links.get(k) ?? { from: t.from, to: t.to, coins: 0, value: 0, items: new Map(), n: 0, last: 0 };
        for (const i of t.items) { l.items.set(i.name, (l.items.get(i.name) ?? 0) + i.count); l.value += (priceOf(i.name) ?? 0) * i.count; if (i.name === 'Coins') l.coins += i.count; }
        l.n++; l.last = Math.max(l.last, t.at); links.set(k, l);
    }
    return {
        coins, value: coins + items.reduce((n, i) => n + (i.value ?? 0), 0), unpriced: items.filter(i => i.price == null).length,
        items, holders, log: log.slice(-20).reverse(), logExists: existsSync(FILES.vault), banker: BANKER, pricesAt,
        lastTransferAt: log.reduce((n, t) => Math.max(n, t.at), 0) || null,
        flow: [...links.values()].map(l => ({ ...l, items: [...l.items].map(([name, count]) => ({ name, count })).sort((a, z) => z.count - a.count) })),
    };
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
const practiceNames = () => new Set([...statusCache.values()].filter(c => /^localhost/.test(c.doc.server)).map(c => c.doc.name));
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
        const js = String(b.job?.state ?? '');
        const meant = b.job ? /^(running|starting|external)/.test(js) : age < 15 * 60_000;
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

// Named places on the food-chain route (scripts/foodcourier.ts), by box; null elsewhere.
const PLACES: [string, number, number, number, number][] = [
    ['Ardougne', 2560, 3200, 2720, 3340], ['Brimhaven', 2740, 3140, 2960, 3240], ['Port Sarim', 2990, 3140, 3070, 3270],
    ['Draynor', 3071, 3200, 3130, 3300], ['Lumbridge', 3130, 3140, 3280, 3300], ['at sea', 2700, 3100, 3000, 3290],
];
function placeOf(p: { x: number; z: number } | undefined | null): string | null {
    if (!p) return null;
    const hit = PLACES.find(([, x0, z0, x1, z1]) => p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1);
    return hit ? hit[0] : null;
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
        const run = (mode: 'floor' | 'realistic') => schedule(boards, acts, { travel, mode, tricks: new Set(TRICKS) });
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
            supplies: suppliesFor(acts, {travel, mode:'realistic', tricks:new Set(TRICKS)}, boards),
            rows, unmeasured: (readFileSync(BOARDS_FILE, 'utf8').match(/"evidence":\s*"(ESTIMATE|CODE-READ)"/g) ?? []).length,
            wins: n(rows, 'real'), floorWins: n(rows, 'floor'), gap: overall?.real.slack ?? null, floorGap: overall?.floor.slack ?? null,
            qpEnd: { realistic: re.qp, floor: fl.qp },
            last: lastB ? { board: lastB.label, finish: lastB.real.finish, slack: lastB.real.slack, activity: lastAct?.label ?? null } : null,
            at: Date.now(), source: 'research/hiscores-live.json', sourceAt: Date.parse(JSON.parse(readFileSync(LIVE_HISCORES,'utf8')).takenAt)||0,
            options: 'planner CLI scenario a: all techniques eligible, travel on; supplies require acquisition',
        };
        raceCache = { key, value };
        const last = gapHistory[gapHistory.length - 1];
        if (!last || last.gap !== value.gap || last.floorGap !== value.floorGap || last.wins !== value.wins) {
            const rec = { at: Date.now(), gap: value.gap, floorGap: value.floorGap, wins: value.wins, floorWins: value.floorWins, m: 'cli' };
            gapHistory.push(rec); if (gapHistory.length > 300) gapHistory.shift();
            append(GAP_FILE, rec);
        }
        return value;
    } catch (e) { return { error: String(e) }; }
}
// Readiness report only: no --authorize here. A dashboard refresh must never authorize login.
async function runGate() {
    if (process.env.DASH_READ_ONLY === '1') return;
    try { await Bun.spawn(['bun', join(root, 'scripts', 'haggis-gate.ts')], { stdout: 'ignore', stderr: 'ignore', cwd: root ,windowsHide:true}).exited; } catch { /* next round */ }
}
setInterval(() => void runGate(), 600_000);
setTimeout(() => void runGate(), 20_000);
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
    const recent = [...st.values()].filter(s => now - s.at < 6 * 3_600_000 && !/^localhost/.test(s.server) && s.name !== MAIN);
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

// ---------- state ----------
function shortPhase(ph: string) {
    // "gave 1 Shortbow, 1 Bronze sword, ..." -> "gave 19 items": never ship item lists to the roster.
    const m = ph.match(/^(\w+(?: \w+)?)\s+\d+ [A-Za-z][^,]*(?:,\s*\d+ [^,]+)+/);
    if (m) {
        const parts = m[0].slice(m[1]!.length).split(',').map(p => p.trim().match(/^(\d+) (.+?)(?: t=\d+)?$/));
        const n = parts.reduce((k, p) => k + Number(p?.[1] ?? 0), 0);
        const fish = parts.every(p => p && /^(trout|salmon|lobster|tuna|swordfish|shark)$/i.test(p[2]!));
        return `${m[1]} ${n} ${fish ? 'fish' : 'items'}`;
    }
    // A key=value progress line ("t=2000 banked=28850 packCoins=5100 ... food=10"): the two numbers a viewer wants.
    if (/^t=\d+ \w+=/.test(ph)) {
        const kv = Object.fromEntries([...ph.matchAll(/(\w+)=(-?\d+)/g)].map(x => [x[1], Number(x[2])]));
        const k = (v: number) => v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e4 ? (v / 1e3).toFixed(1) + 'K' : String(v);
        const out = [kv.banked != null ? `banked ${k(kv.banked)}` : '', kv.food != null ? `food ${kv.food}` : '', kv.picks != null ? `${k(kv.picks)} picks` : ''].filter(Boolean);
        if (out.length) return out.join(' · ');
    }
    // A courier leg milestone ("received129 708", "sarim 204"): drop the run tick.
    const leg = ph.match(/^([a-z]+?)(\d*) \d+$/);
    if (leg) return leg[2] ? `${leg[1]} ${leg[2]}` : leg[1]!;
    return ph;
}
function buildState() {
    const proofs=nativeProofs(Date.now());
    const st = readStatuses();
    const sw = swarm();
    const accountJobs=accountJobRows(sw?.jobs);
    // File/proof reads can span a newer controller publication. Compare those
    // observations with the time after the reads, not the build's old start time.
    const now = Date.now();
    const names = new Set([...liveAccounts(), ...st.keys(), ...accountJobs.map(j => j.account)]);
    const bots = [...names].map(name => {
        const s0 = st.get(name) ?? ({ name, at: 0, server: 'rs-sdk-demo.fly.dev', role: 'unknown', skills: [] } as Status);
        const live = roster.get(name.toLowerCase());
        const inWorld = !!live && now - live.seen < 30_000;
        const fresh = now - s0.at < 20_000;
        const mine = accountJobs.filter(j => j.account.toLowerCase() === name.toLowerCase());
        // Running by hand: a fresh status from a known script while the swarm has no enabled job for the account.
        const byHand = fresh && !/^localhost/.test(s0.server) && !mine.some(j => j.enabled && j.script) ? SCRIPT_ROLE[String(s0.goal ?? '')] : undefined;
        const s = byHand ? { ...s0, role: byHand.role, goal: byHand.goal } : s0;
        const rankRows = ranks.get(name)?.rows ?? [];
        const guess = NO_ROLE.has(s.role) && name !== MAIN ? inferRole(s, rankRows) : null;
        const skill = byHand ? byHand.skill ?? null : ROLE_SKILL[s.role] ?? (guess && (s.skills ?? []).some((k: any) => k.name === guess) ? guess : null);
        const sk = skill ? (s.skills ?? []).find((k: any) => k.name === skill) : null;
        const target = Number(s.env?.target ?? 99) || 99;
        const r = fresh ? rate(name, skill) : null;
        // XP left to this run's TARGET level on this server's curve (packages/planner/src/curve.ts), not always 99.
        const xpLeft = sk ? Math.max(0, xpForLevel(target) - sk.xp) : null;
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
        const processActive = procs.some(p => p.accounts.some(a => a.toLowerCase() === name.toLowerCase()) && p.started <= (s.at ?? 0));
        const currentGoal = String(s.goal || job?.goal || '');
        // The status may carry a custom goal. Keep the configured script as
        // classification evidence even when effectiveJob labels it manual.
        const production = productionGoal(currentGoal, jobBeforeStatus?.script);
        const reservedEntry = mine.some(j => !j.script || j.state === 'reserved');
        const res = String(s.result ?? '');
        return {
            ...s, name, fresh, inWorld, processActive, currentGoal, production, operation: operationState({ ...s, inWorld, processActive, planJob:job, reserved: name === MAIN }, now), live: inWorld ? live : null, ranksAt:ranks.get(name)?.at??null, ranks: rankRows.map(x => ({ ...x, ...rankDelta(name, x.board) })),
            role: guess ? guess.toLowerCase() + '*' : s.role, roleInferred: !!guess, seenInFeed: firstSeen.has(name.toLowerCase()),
            practice: /^localhost/.test(s.server), lastSeen: Math.max(s.at || 0, live?.seen ?? 0) || null,
            goalSkill: skill, goalLevel: target, goalNow: sk?.level ?? null, goalXp: sk?.xp ?? null, xpPerTick: r,
            xpPerHour: r != null ? r * 3_600_000 / world.tickMs : null, spark: spark.get(name) ?? [], rateSkill: skill ?? "all skills", xpLeft,
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
    // In the world now, then fresh status, then the rest (seen in the feed, live accounts, practice bots); Haggis last.
    const tier = (b: typeof bots[number]) => b.reserved ? 5 : b.inWorld ? 0 : b.fresh ? 1 : b.seenInFeed ? 2 : b.practice ? 4 : 3;
    bots.sort((a, b) => tier(a) - tier(b) || (b.at ?? 0) - (a.at ?? 0) || a.name.localeCompare(b.name));
    // 24 boards: each board's #1 against our best live rank on it.
    const boards = [...SKILL_BOARDS.map(b => {
        const top = topOf(b);
        let best: any = null;
        for (const bot of bots) for (const r of bot.ranks) if (r.board === b && (!best || r.rank < best.rank)) best = { ...r, name: bot.name };
        const ours = best ? parseTime(best.time) : null;
        // close: 1 = level with #1 or faster, toward 0 = far behind (levels, then time).
        const gap = best && top ? (best.level >= top.level
            ? { kind: 'time', ahead: ours! <= top.ticks, text: fmtTicks(Math.abs(top.ticks - ours!)), close: Math.min(1, top.ticks / Math.max(1, ours!)) }
            : { kind: 'level', ahead: false, text: `-${top.level - best.level} lvl`, close: Math.max(0, best.level / top.level) * 0.8 }) : null;
        return { board: b, top: top ? { name: top.name, level: top.level, time: fmtTicks(top.ticks), ticks: top.ticks, live: top.live, at: top.at } : null, best, gap, kind: 'skill' };
    }), ...EXTRA.map(e => {
        const t = extraTop.get(e.board);
        return { board: e.board, top: t ? { name: t.name, level: null, time: t.value, ticks: null } : null, best: null, gap: null, kind: 'value' };
    })];
    const v = vault(bots, now);
    const cargoDir = join(practice, 'cargo');
    const cargo = existsSync(cargoDir) ? readdirSync(cargoDir).filter(f => f.endsWith('.json') && !f.startsWith('request-')).flatMap(f => {
        try { return [JSON.parse(readFileSync(join(cargoDir, f), 'utf8'))]; } catch { return []; }
    }) : [];
    const collection = collectionState(bots, liveAccounts(), cargo, tailJsonl<any>(FILES.vault, 100_000), now);
    if (!vaultTrend.length || now - vaultTrend[vaultTrend.length - 1]!.at > 60_000) { vaultTrend.push({ at: now, value: Math.round(v.value), coins: v.coins }); if (vaultTrend.length > 240) vaultTrend.shift(); }
    const farmers = (bots as any[]).filter(b => b.role4?.kind === 'gold' && !b.practice);
    const economy = {
        goldPerTick: farmers.reduce((n, b) => n + (b.fresh && b.role4.coinsPerTick > 0 ? b.role4.coinsPerTick : 0), 0),
        farmers: farmers.map(b => ({ name: b.name, fresh: b.fresh, ...b.role4 })),
        trend: vaultTrend.map(t => t.value),
        supplies: keySupplyIds().map(id => ({ id, ...(marketById.get(id) ?? { name: '?', ask: null, bid: null, stock: 0, vwap: null, base: null }) })).filter(x => x.name !== '?'),
        pricesAt,
    };
    const icons: Record<string, number | null> = {};
    const see = (l: any) => { for (const i of l ?? []) if (i?.name && !(i.name in icons)) icons[i.name] = iconId(i.name); };
    for (const b of bots as any[]) { see(b.inventory); see(b.bank); }
    see(v.items); see([{ name: 'Coins' }]); for (const t of v.log) see(t.items); for (const f of v.flow) see(f.items);
    const prac = practiceNames();
    const sys = {
        freeGB: freemem() / 2 ** 30, totalGB: totalmem() / 2 ** 30, cpu: cpuPct, cores: cpus().length,
        procs: procs.map(p => ({ ...p, up: now - p.started })),
    };
    const objectives=cached(join(root,'docs/plans/joined-plan.md'),goalPlan,goalPlan(''));
    const currentRace=race(),currentGates=gates();
    const goalInputs:GoalInputs={requirements:currentRace?.supplies??null,
        items:cached<any[]>(join(root,'knowledge/items.json'),JSON.parse,[]),
        quests:cached<any[]>(join(root,'knowledge/quests.json'),JSON.parse,[]),
        questConstants:cached(join(root,'vendor/rs-sdk/server/content/scripts/general/configs/quest.constant'),text=>text,''),
        receipts:Object.fromEntries(Object.entries(GOAL_RECEIPTS).map(([key,path])=>[key,cached<any>(join(root,path),JSON.parse,null)]))};
    const progress=goalProgress({now,bots,boards,collection,objectives,race:currentRace,gates:currentGates},goalInputs);
    return {
        now, objectives:{...objectives,progress}, world: { ...world, tick: serverTick() }, worldPlayers: world.players, bots, boards,
        coordination:(()=>{const file=join(practice,'coordinator/state.json');try{return coordinationView(cached(file,JSON.parse,null),statSync(file).mtimeMs,now,existsSync(join(practice,'stop-coordinator'))||existsSync(join(practice,'stop-swarm')));}catch{return coordinationView(null,0,now);}})(),
        events: events.slice(0, 160).map(e => ({ ...e, text: shortPhase(e.text), full: e.text, practice: prac.has(e.name) })),
        results: results.slice(0, 120).map(r => ({ ...r, practice: prac.has(r.name),nativeProof:resultProof(r,proofs) })), scripts: scripts(proofs), alerts: alerts(bots, now), requests: requests(), mainPlan: haggisPlan(),
        capacity: capacityState(sw,sys.freeGB,now),
        swarm: sw ? { at: sw.at, freeGB: sw.freeGB, running: sw.running, externalRunning: sw.externalRunning ?? null, pendingStartup: sw.pendingStartup ?? null, pendingReserveGB: sw.pendingReserveGB ?? null, minFreeGB: sw.minFreeGB ?? null, maxBots: sw.maxBots, jobs: sw.jobs.length } : null,
        // An open page reloads itself when index.html changes, so a deploy reaches the owner's tab.
        viewerTimings: viewerTimings.slice(0, 20),
        race: currentRace, gates: currentGates, chain: foodChain(st, now), gapHistory: gapHistory.slice(-120).map(g => ({ at: g.at, gap: g.gap, floorGap: g.floorGap ?? null })), economy,
        pageVersion: (() => { try { return Math.max(...[PAGE_FILE,...['map-shell.css','map-shell.js','client-shell.css','client-shell.js','client-viewer.css','operations.css','operations.js','xp-tracker.js'].map(f=>join(import.meta.dir,f))].map(f=>existsSync(f)?statSync(f).mtimeMs:0)); } catch { return 0; } })(),
        icons, vault: v, collection, map: { ...MAP, ready: !!mapBytes }, sys, snapshotAt: snapshot?.takenAt ?? null, liveTopsAt: Math.max(0, ...[...liveTop.values()].map(t => t.at)), liveTops: liveTop.size,
    };
}

const viewerTimings: { at: number; mode: string; ms: number; tiles: number; frames: number; blankFrames: number; holdFrames: number }[] = [];

// One state for everyone: built every 2 s only while a client watches, serialized once, sent to each SSE client.
const clients = new Set<ReadableStreamDefaultController>();
let latest = { at: 0, json: '' };
function current() {
    // The main account's name never leaves the server unasked: every string value has it swapped for a marker, which
    // the page draws as a blurred block (owner rule: screenshots must not show it). /api/reveal returns it on a click.
    if (Date.now() - latest.at > 1500) {
        try {
            latest = { at: Date.now(), json: JSON.stringify(buildState(), (_k, v) => (typeof v === 'string' ? v.replace(SECRET_RE, SECRET_MARK) : v)) };
        } catch (e) {
            // A malformed status file or a transient read failure must not stop the dashboard for every client.
            // Keep the last good state, and expose the failure so the page can show it.
            console.error(`state build failed: ${String(e)}`);
            if (latest.json) {
                try {
                    const stale = JSON.parse(latest.json);
                    stale.stateError = String(e);
                    latest = { at: Date.now(), json: JSON.stringify(stale) };
                } catch {
                    // If the previous state cannot be parsed, fall through to a minimal error state.
                }
            }
            if (!latest.json) {
                latest = { at: Date.now(), json: JSON.stringify({
                    now: Date.now(), stateError: String(e), bots: [], boards: [], events: [], results: [],
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
setInterval(() => {
    if (!clients.size) return;
    const msg = `data: ${current()}\n\n`;
    for (const c of clients) { try { c.enqueue(msg); } catch { clients.delete(c); } }
}, 2000);

// The page embeds the rs-world viewer (COEP require-corp); credentialless keeps Google Fonts loadable.
const ISO = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };
const viewerRoot=join(root,'vendor','rs-world'),viewerBuild=join(viewerRoot,'build'),viewerCaches=join(viewerRoot,'caches');
const VIEWER_ISO={...ISO,'Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin'};
function viewerAvailable() {
    try {
        const text=readFileSync(join(viewerBuild,'asset-manifest.json'),'utf8');
        if(createHash('sha256').update(text).digest('hex').toUpperCase()!==VIEWER_MANIFEST_SHA256)return false;
        const manifest=JSON.parse(text);
        const files=[manifest.files?.['main.js'],manifest.files?.['main.css']];
        return existsSync(join(viewerBuild,'index.html'))&&existsSync(join(viewerCaches,'caches.json'))
            &&files.every(p=>typeof p==='string'&&/^\/static\/(?:js|css)\/[\w.-]+$/.test(p)&&existsSync(join(viewerBuild,p.slice(1))));
    }catch{return false;}
}
function viewerAsset(pathname:string):Response|null {
    const route=viewerAssetRoute(pathname);
    if(route===null)return null;
    if(route==='bad')return new Response('bad viewer path',{status:400});
    const base=route.root==='static'?join(viewerBuild,'static'):viewerCaches;
    try {
        const realBase=realpathSync(base),file=realpathSync(resolve(base,route.relative));
        if(!file.startsWith(realBase+sep)||!statSync(file).isFile())return new Response('not found',{status:404});
        return new Response(Bun.file(file),{headers:{...VIEWER_ISO,'cache-control':route.root==='static'?'public,max-age=3600':'no-cache'}});
    }catch{return new Response('not found',{status:404});}
}
Bun.serve({
    hostname: HOST,
    port: PORT,
    idleTimeout: 0,
    fetch(req, server) {
        const url = new URL(req.url);
        if(url.pathname==='/api/control')return operatorControl(req,server.requestIP(req)?.address??'').then(async response=>new Response((await response.text()).replace(SECRET_RE,SECRET_MARK),{status:response.status,headers:response.headers}));
        if(url.pathname==='/RUNELITE-LICENSE.txt')return new Response(Bun.file(join(import.meta.dir,'RUNELITE-LICENSE.txt')),{headers:{'content-type':'text/plain;charset=utf-8'}});
        if(['/map-shell.css','/map-shell.js','/client-shell.css','/client-shell.js','/client-viewer.css','/operations.css','/operations.js','/xp-tracker.js'].includes(url.pathname))return new Response(Bun.file(join(import.meta.dir,url.pathname.slice(1))),{headers:{'content-type':url.pathname.endsWith('.css')?'text/css':'text/javascript','cache-control':'no-store'}});
        if(url.pathname.startsWith('/client-assets/')) {
            const name=url.pathname.slice('/client-assets/'.length);
            if(!/^[a-zA-Z0-9_-]+\.(png|ttf|txt)$/.test(name))return new Response('Invalid asset',{status:400});
            const file=Bun.file(join(import.meta.dir,'client-assets',name));
            return new Response(file,{headers:{'cache-control':'public,max-age=3600'}});
        }
        if (url.pathname === '/api/viewer-health') {const available=viewerAvailable();return Response.json({available,url:'/viewer/',reason:available?null:'Reviewed 3D viewer assets/cache are unavailable or the build version is unsupported; 2D remains available.'},{headers:{'cache-control':'no-store'}});}
        if(url.pathname==='/api/viewer-bridge.js')return viewerAvailable()?new Response(viewerBridgeSource(),{headers:{...VIEWER_ISO,'content-type':'text/javascript;charset=utf-8','cache-control':'no-store'}}):new Response('Unsupported viewer build',{status:503});
        if(url.pathname==='/viewer'||url.pathname==='/viewer/') {
            if(!viewerAvailable())return new Response('3D viewer assets unavailable',{status:503});
            // Native isolation headers replace this root-scoped service worker;
            // the viewer must not install a worker over the dashboard itself.
            const html=readFileSync(join(viewerBuild,'index.html'),'utf8').replace(/<script\s+src="\/coi-serviceworker\.js"><\/script>/,'')
                .replace('<head>','<head><script src="/api/viewer-bridge.js"></script>'+(url.searchParams.get('client')==='1'?'<link rel="stylesheet" href="/client-viewer.css">':''));
            return new Response(html,{headers:{...VIEWER_ISO,'content-type':'text/html;charset=utf-8','cache-control':'no-store'}});
        }
        const asset=viewerAsset(url.pathname);if(asset)return asset;
        // The page relays the 3D viewer's follow-change timings (time until the destination is loaded).
        if (url.pathname === '/api/viewer-timing' && req.method === 'POST') {
            return req.json().then((t: any) => {
                if (t && typeof t.ms === 'number') { viewerTimings.unshift({ at: Date.now(), mode: String(t.mode), ms: t.ms, tiles: Number(t.tiles) || 0, frames: Number(t.frames) || 0, blankFrames: Number(t.blankFrames) || 0, holdFrames: Number(t.holdFrames) || 0 }); viewerTimings.length = Math.min(viewerTimings.length, 40); }
                return new Response('ok');
            }).catch(() => new Response('bad', { status: 400 }));
        }
        if (url.pathname === '/api/state' && Date.now() - procsAt > 60_000) void scanProcs(true);
        if (url.pathname === '/api/state') return new Response(current(), { headers: { 'content-type': 'application/json' } });
        // The 3D viewer (localhost:3000) fetches the names whose nameplates it must hide, so the dashboard page
        // never holds the name: the iframe URL carries only this endpoint.
        // Our live accounts, for the viewer's gold nameplates (the main account stays hidden, not highlighted).
        if (url.pathname === '/api/our-names') return Response.json(liveAccounts().filter(n => n !== MAIN), { headers: { 'access-control-allow-origin': 'http://localhost:3000', 'cross-origin-resource-policy': 'cross-origin', 'cache-control': 'no-store' } });
        if (['/api/reveal', '/api/hidden-names'].includes(url.pathname) && !isLoopback(server.requestIP(req)?.address ?? '')) return new Response('forbidden', { status: 403 });
        if (url.pathname === '/api/hidden-names') return Response.json([MAIN], { headers: { 'access-control-allow-origin': 'http://localhost:3000', 'cross-origin-resource-policy': 'cross-origin', 'cache-control': 'no-store' } });
        // The server may listen on every address (DASH_HOST); only this PC may read the main account's name.

        if (url.pathname === '/api/reveal') return new Response(MAIN, { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
        if (url.pathname === '/api/map') return mapBytes ? new Response(mapBytes, { headers: { 'content-type': 'application/octet-stream' } }) : new Response('building', { status: 503 });
        if (url.pathname === '/events') {
            let me: ReadableStreamDefaultController;
            const stream = new ReadableStream({
                start(c) { me = c; clients.add(c); if (clients.size === 1) void scanProcs(); c.enqueue(`data: ${current()}\n\n`); },
                cancel() { clients.delete(me); },
            });
            return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
        }
        if (url.pathname === '/items.png') return new Response(Bun.file(join(import.meta.dir, 'items.png')), { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' } });
        if (url.pathname === '/' || url.pathname === '/index.html') return new Response(Bun.file(PAGE_FILE), { headers: { ...ISO, 'content-type': 'text/html;charset=utf-8' } });
        return new Response('not found', { status: 404 });
    },
});
console.log(`dashboard: http://localhost:${PORT} (listening on ${HOST})`);
