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
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus, freemem, totalmem } from 'node:os';

const root = resolve(import.meta.dir, '..', '..');
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
const DEMO = 'https://rs-sdk-demo.fly.dev';
const BANKER = 'Moneyshot';
const MAIN = 'Haggis';
const SECRET_RE = new RegExp(MAIN, 'gi');
const SECRET_MARK = '⟦MAIN⟧';
const ROLE_SKILL: Record<string, string> = { thieving: 'Thieving', fishing: 'Fishing', woodcutting: 'Woodcutting', mining: 'Mining', runecraft: 'Runecraft', cooking: 'Cooking', crafting: 'Crafting', combat: 'Attack' };
const XP99 = 998_458; // level 99 on the demo server (Pocketpython hit 99 at 998,500 xp)
const NL = String.fromCharCode(10);

function tailJsonl<T>(file: string, n: number): T[] {
    try {
        return readFileSync(file, 'utf8').split(NL).filter(Boolean).slice(-n).flatMap(l => { try { return [JSON.parse(l) as T]; } catch { return []; } });
    } catch { return []; }
}
function append(file: string, doc: unknown) {
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
const samples = new Map<string, { at: number; tick: number; xp: number }[]>();
const spark = new Map<string, number[]>();
type Ev = { at: number; name: string; text: string };
const events: Ev[] = tailJsonl<Ev>(FILES.events, 200).reverse();
const lastPhase = new Map<string, string>();
const phaseSince = new Map<string, { at: number; exact: boolean }>();
for (const e of [...events].reverse()) phaseSince.set(e.name + NL + e.text, { at: e.at, exact: true });
function track(s: Status) {
    const xp = (s.skills ?? []).reduce((n: number, k: any) => n + (k.xp ?? 0), 0);
    const list = samples.get(s.name) ?? [];
    if (!list.length || list[list.length - 1]!.tick !== s.tick) {
        list.push({ at: s.at, tick: s.tick, xp });
        const r = rate(s.name, list);
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
function rate(name: string, l = samples.get(name) ?? []) {
    if (l.length < 2) return null;
    const a = l[0]!, b = l[l.length - 1]!;
    return b.tick > a.tick ? (b.xp - a.xp) / (b.tick - a.tick) : null;
}

// ---------- RESULT lines: every new result a status file shows, with pass/fail streaks per script ----------
type Res = { at: number; name: string; goal: string; ok: boolean; text: string };
const results: Res[] = tailJsonl<Res>(FILES.results, 300).reverse();
const lastResult = new Map<string, string>();
for (const r of [...results].reverse()) lastResult.set(r.name, r.text);
const died = (text: string) => /\bdied=true\b/.test(text) || /\bdied (?!=)/.test(text);
function trackResult(s: Status) {
    const text = String(s.result ?? '');
    if (!text || lastResult.get(s.name) === text.slice(0, 240)) return;
    lastResult.set(s.name, text.slice(0, 240));
    const r = { at: s.at, name: s.name, goal: String(s.goal ?? '').replace(/\.ts$/, ''), ok: /^ok\b/.test(text), text: text.slice(0, 240) };
    results.unshift(r);
    results.length = Math.min(results.length, 300);
    append(FILES.results, r);
}
function scripts() {
    const by = new Map<string, Res[]>();
    for (const r of results) { const l = by.get(r.goal) ?? []; l.push(r); by.set(r.goal, l); }
    return [...by].map(([goal, l]) => {
        let streak = 0;
        for (const r of l) { if (r.ok === l[0]!.ok) streak++; else break; }
        return { goal, runs: l.length, ok: l.filter(r => r.ok).length, streak, streakOk: l[0]!.ok, last: l[0]!.at, recent: l.slice(0, 12).map(r => r.ok) };
    }).sort((a, b) => b.last - a.last);
}

// ---------- machine: memory, CPU load, bun processes ----------
let cpuPrev = cpus().map(c => c.times);
let cpuPct = 0;
const procs: { pid: number; script: string; started: number; mb: number }[] = [];
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
async function scanProcs() {
    if (!clients.size) return; // nobody watching: no PowerShell
    try {
        const ps = "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.CreationDate.ToString('o'), $_.WorkingSetSize, $_.CommandLine }";
        const p = Bun.spawn(['powershell', '-NoProfile', '-Command', ps], { stdout: 'pipe', stderr: 'ignore' });
        const text = await new Response(p.stdout).text();
        procs.length = 0;
        for (const line of text.split(NL)) {
            const [pid, created, ws, ...cmd] = line.trim().split('|');
            if (!pid || !created) continue;
            // Only the script file name: command lines never reach the page.
            const script = (cmd.join('|').match(/([\w.-]+\.(?:ts|js))\b/g) ?? []).pop() ?? 'bun';
            procs.push({ pid: Number(pid), script, started: Date.parse(created), mb: Math.round(Number(ws) / 2 ** 20) });
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
            const m = JSON.parse(String(e.data));
            const now = Date.now();
            if (m.t === 'hello') { world.players = m.players ?? world.players; world.tick = m.tick ?? world.tick; world.tickAt = now; world.tickMs = m.tickMs ?? 400; world.rev = m.rev ?? 0; }
            if (m.t !== 'roster') return;
            world.players = m.p.length;
            if (m.k) { world.tick = m.k; world.tickAt = now; }
            for (const p of m.p) {
                const n = String(p[1]).toLowerCase();
                if (!firstSeen.has(n)) firstSeen.set(n, now);
                roster.set(n, { x: p[2], z: p[3], level: p[4], combat: p[5], seen: now });
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
                if (i.id != null) marketIds.set(String(i.name).toLowerCase(), Number(i.id));
                const p = i.vwap != null && (i.trades ?? 0) >= 3 ? i.vwap : i.basePrice;
                if (p != null) prices.set(String(i.name).toLowerCase(), Number(p));
            }
            await Bun.sleep(200);
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
            for (const t of mineLog) add(t.items, keyName(t.to) === k ? 1 : -1);
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
    for (const t of log) {
        const k = t.from + '>' + t.to, l = links.get(k) ?? { from: t.from, to: t.to, coins: 0, value: 0, items: new Map(), n: 0, last: 0 };
        for (const i of t.items) { l.items.set(i.name, (l.items.get(i.name) ?? 0) + i.count); l.value += (priceOf(i.name) ?? 0) * i.count; if (i.name === 'Coins') l.coins += i.count; }
        l.n++; l.last = Math.max(l.last, t.at); links.set(k, l);
    }
    return {
        coins, value: coins + items.reduce((n, i) => n + (i.value ?? 0), 0), unpriced: items.filter(i => i.price == null).length,
        items, holders, log: log.slice(-20).reverse(), logExists: existsSync(FILES.vault), banker: BANKER, pricesAt,
        flow: [...links.values()].map(l => ({ ...l, items: [...l.items].map(([name, count]) => ({ name, count })).sort((a, z) => z.count - a.count) })),
    };
}

// ---------- swarm controller (scripts/swarm.ts) ----------
type SwarmJob = { account: string; script: string; role: string; goal: string; enabled: boolean; repeat: boolean; note: string; state: string; since: number | null };
type Swarm = { at: number; freeGB: number; running: number; maxBots: number; jobs: SwarmJob[] };
const swarm = () => cached<Swarm | null>(FILES.swarm, t => JSON.parse(t) as Swarm, null);

// ---------- owner request queue (research/owner-requests.md) ----------
type Req = { id: string; date: string; request: string; status: string; kind: string; evidence: string; next: string; section: string };
function parseRequests(text: string): Req[] {
    const out: Req[] = [];
    let section = '', header: string[] | null = null;
    for (const raw of text.split(NL)) {
        const line = raw.trim();
        if (line.startsWith('#')) { section = line.replace(/^#+\s*/, ''); header = null; continue; }
        if (!line.startsWith('|')) { header = null; continue; }
        const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map(c => c.trim());
        if (cells.every(c => /^:?-+:?$/.test(c))) continue;
        if (!header) { header = cells.map(c => c.toLowerCase()); continue; }
        const col = (re: RegExp) => { const i = header!.findIndex(h => re.test(h)); return i >= 0 ? cells[i] ?? '' : ''; };
        const status = col(/^status$/);
        if (!status || !/^\d+$/.test(cells[0] ?? '')) continue;
        const kind = /^done/i.test(status) ? 'DONE' : /^partial/i.test(status) ? 'PARTIAL' : /^not started/i.test(status) ? 'NOT STARTED' : /^blocked/i.test(status) ? 'BLOCKED' : /^new/i.test(status) ? 'NEW' : /^rule/i.test(status) ? 'RULE' : status.toUpperCase();
        out.push({ id: cells[0]!, date: col(/^date$/), request: col(/^request/), status, kind, evidence: col(/^evidence/), next: col(/^next/), section });
    }
    return out;
}
function requests() {
    const all = cached<Req[]>(FILES.requests, parseRequests, []);
    const counts: Record<string, number> = {};
    for (const r of all) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    // File order is priority order ("most important to the Haggis goal first", then later additions).
    const open = all.filter(r => !['DONE', 'RULE'].includes(r.kind));
    let mtime = 0; try { mtime = statSync(FILES.requests).mtimeMs; } catch { /* missing */ }
    return { counts, open, total: all.length, mtime };
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
type Alert = { at: number; name: string; kind: 'death' | 'stuck' | 'idle' | 'logout'; text: string };
function alerts(bots: any[], now: number): Alert[] {
    const out: Alert[] = [];
    for (const r of results) if (now - r.at < 12 * 3_600_000 && died(r.text)) out.push({ at: r.at, name: r.name, kind: 'death', text: (r.text.match(/died[^=]\S*(?: \S+){0,4}/)?.[0] ?? 'died').slice(0, 60) });
    for (const r of results) if (now - r.at < 86_400_000 && /logout\s*(fail|timeout|stuck)|logoutFail\w*=[1-9]/i.test(r.text)) out.push({ at: r.at, name: r.name, kind: 'logout', text: 'logout failed' });
    for (const b of bots) {
        if (!b.at) continue;
        const age = now - b.at;
        // Running = this process has printed no RESULT yet. No update for 60 s while running: stuck or crashed.
        // A job the swarm disabled or saw end is not stuck; without a swarm job, only the last 15 min count.
        const js = String(b.job?.state ?? '');
        const meant = b.job ? /^(running|starting|external)/.test(js) : age < 15 * 60_000;
        if (!b.result && meant && age > 60_000) out.push({ at: b.at, name: b.name, kind: 'stuck', text: `no status for ${Math.round(age / 1000)} s while running` });
        if (b.fresh) {
            const tl = String(b.timeline ?? ''), m = tl.match(/i+$/);
            if (m && m[0].length > 20) out.push({ at: b.at, name: b.name, kind: 'idle', text: `idle ${m[0].length} ticks now` });
            if (/logout fail/i.test(b.phase ?? '')) out.push({ at: b.at, name: b.name, kind: 'logout', text: b.phase });
        }
    }
    const seen = new Set<string>();
    return out.sort((a, b) => b.at - a.at).filter(a => { const k = a.name + a.kind + a.text; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30);
}

// ---------- state ----------
function shortPhase(ph: string) {
    // "gave 1 Shortbow, 1 Bronze sword, ..." -> "gave 19 items": never ship item lists to the roster.
    const m = ph.match(/^(\w+(?: \w+)?)\s+\d+ [A-Za-z][^,]*(?:,\s*\d+ [^,]+)+/);
    if (m) return `${m[1]} ${ph.split(',').length} items`;
    return ph;
}
function buildState() {
    const now = Date.now();
    const st = readStatuses();
    const sw = swarm();
    const names = new Set([...liveAccounts(), ...st.keys()]);
    const bots = [...names].map(name => {
        const s = st.get(name) ?? ({ name, at: 0, server: 'rs-sdk-demo.fly.dev', role: 'unknown', skills: [] } as Status);
        const live = roster.get(name.toLowerCase());
        const inWorld = !!live && now - live.seen < 30_000;
        const fresh = now - s.at < 20_000;
        const rankRows = ranks.get(name)?.rows ?? [];
        const guess = NO_ROLE.has(s.role) && name !== MAIN ? inferRole(s, rankRows) : null;
        const skill = ROLE_SKILL[s.role] ?? (guess && (s.skills ?? []).some((k: any) => k.name === guess) ? guess : null);
        const sk = skill ? (s.skills ?? []).find((k: any) => k.name === skill) : null;
        const target = Number(s.env?.target ?? 99) || 99;
        const r = fresh ? rate(name) : null;
        const xpLeft = sk ? Math.max(0, XP99 - sk.xp) : null;
        const ticksLeft = r && r > 0 && xpLeft != null ? xpLeft / r : null;
        // Pace: the account's hiscore time on the goal board (or this run's ticks) plus ticks left, against #1's time.
        const top = skill ? snapshot?.boards?.find((x: any) => x.board === skill)?.rows?.[0] : null;
        const row = skill ? rankRows.find(x => x.board === skill) : null;
        const played = Math.max(row ? parseTime(row.time) : 0, s.tick ?? 0);
        const finish = ticksLeft != null ? played + ticksLeft : null;
        const ph = s.phase ?? '';
        const since = ph ? phaseSince.get(name + NL + ph) : undefined;
        const last = String(s.timeline ?? '').slice(-1);
        const job = sw?.jobs.find(j => j.account.toLowerCase() === name.toLowerCase()) ?? null;
        const res = String(s.result ?? '');
        return {
            ...s, name, fresh, inWorld, live: inWorld ? live : null, ranks: rankRows.map(x => ({ ...x, ...rankDelta(name, x.board) })),
            role: guess ? guess.toLowerCase() + '*' : s.role, roleInferred: !!guess, seenInFeed: firstSeen.has(name.toLowerCase()),
            practice: /^localhost/.test(s.server), lastSeen: Math.max(s.at || 0, live?.seen ?? 0) || null,
            goalSkill: skill, goalLevel: target, goalNow: sk?.level ?? null, goalXp: sk?.xp ?? null, xpPerTick: r,
            xpPerHour: r != null ? r * 3_600_000 / world.tickMs : null, spark: spark.get(name) ?? [],
            eta: ticksLeft != null ? fmtTicks(ticksLeft) : null, finish: finish != null ? fmtTicks(finish) : null,
            pace: finish != null && top ? { top: top.name, topTime: fmtTicks(top.ticks), ahead: finish < top.ticks, gap: fmtTicks(Math.abs(top.ticks - finish)) } : null,
            action: fresh ? ({ x: 'xp', m: 'move', a: 'anim', d: 'dialog', s: 'stun', i: 'idle' } as Record<string, string>)[last] ?? null : null,
            phaseShort: shortPhase(ph), phaseSince: since?.at ?? null, phaseExact: since?.exact ?? false,
            uptime: s.started && s.at ? s.at - s.started : null,
            outcome: !res ? null : died(res) ? 'died' : /^ok\b/.test(res) ? 'ok' : 'fail',
            job, reserved: name === MAIN,
        };
    });
    // In the world now, then fresh status, then the rest (seen in the feed, live accounts, practice bots); Haggis last.
    const tier = (b: typeof bots[number]) => b.reserved ? 5 : b.inWorld ? 0 : b.fresh ? 1 : b.seenInFeed ? 2 : b.practice ? 4 : 3;
    bots.sort((a, b) => tier(a) - tier(b) || (b.at ?? 0) - (a.at ?? 0) || a.name.localeCompare(b.name));
    // 24 boards: each board's #1 against our best live rank on it.
    const boards = [...SKILL_BOARDS.map(b => {
        const top = snapshot?.boards?.find((x: any) => x.board === b)?.rows?.[0];
        let best: any = null;
        for (const bot of bots) for (const r of bot.ranks) if (r.board === b && (!best || r.rank < best.rank)) best = { ...r, name: bot.name };
        const ours = best ? parseTime(best.time) : null;
        // close: 1 = level with #1 or faster, toward 0 = far behind (levels, then time).
        const gap = best && top ? (best.level >= top.level
            ? { kind: 'time', ahead: ours! <= top.ticks, text: fmtTicks(Math.abs(top.ticks - ours!)), close: Math.min(1, top.ticks / Math.max(1, ours!)) }
            : { kind: 'level', ahead: false, text: `${top.level - best.level} lvl`, close: Math.max(0, best.level / top.level) * 0.8 }) : null;
        return { board: b, top: top ? { name: top.name, level: top.level, time: fmtTicks(top.ticks), ticks: top.ticks } : null, best, gap, kind: 'skill' };
    }), ...EXTRA.map(e => {
        const t = extraTop.get(e.board);
        return { board: e.board, top: t ? { name: t.name, level: null, time: t.value, ticks: null } : null, best: null, gap: null, kind: 'value' };
    })];
    const v = vault(bots, now);
    const icons: Record<string, number | null> = {};
    const see = (l: any) => { for (const i of l ?? []) if (i?.name && !(i.name in icons)) icons[i.name] = iconId(i.name); };
    for (const b of bots as any[]) { see(b.inventory); see(b.bank); }
    see(v.items); see([{ name: 'Coins' }]); for (const t of v.log) see(t.items); for (const f of v.flow) see(f.items);
    const sys = {
        freeGB: freemem() / 2 ** 30, totalGB: totalmem() / 2 ** 30, cpu: cpuPct, cores: cpus().length,
        procs: procs.map(p => ({ ...p, up: now - p.started })),
    };
    return {
        now, world: { ...world, tick: serverTick() }, worldPlayers: world.players, bots, boards, events: events.slice(0, 120),
        results: results.slice(0, 60), scripts: scripts(), alerts: alerts(bots, now), requests: requests(), haggis: haggisPlan(),
        swarm: sw ? { at: sw.at, freeGB: sw.freeGB, running: sw.running, maxBots: sw.maxBots, jobs: sw.jobs.length } : null,
        icons, vault: v, map: { ...MAP, ready: !!mapBytes }, sys, snapshotAt: snapshot?.takenAt ?? null,
    };
}

// One state for everyone: built every 2 s only while a client watches, serialized once, sent to each SSE client.
const clients = new Set<ReadableStreamDefaultController>();
let latest = { at: 0, json: '' };
function current() {
    // The main account's name never leaves the server unasked: every string value has it swapped for a marker, which
    // the page draws as a blurred block (owner rule: screenshots must not show it). /api/reveal returns it on a click.
    if (Date.now() - latest.at > 1500) latest = { at: Date.now(), json: JSON.stringify(buildState(), (_k, v) => (typeof v === 'string' ? v.replace(SECRET_RE, SECRET_MARK) : v)) };
    return latest.json;
}
setInterval(() => {
    if (!clients.size) return;
    const msg = `data: ${current()}\n\n`;
    for (const c of clients) { try { c.enqueue(msg); } catch { clients.delete(c); } }
}, 2000);

// The page embeds the rs-world viewer (COEP require-corp); credentialless keeps Google Fonts loadable.
const ISO = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };
Bun.serve({
    port: PORT,
    idleTimeout: 0,
    fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/state') return new Response(current(), { headers: { 'content-type': 'application/json' } });
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
        if (url.pathname === '/' || url.pathname === '/index.html') return new Response(Bun.file(join(import.meta.dir, 'index.html')), { headers: { ...ISO, 'content-type': 'text/html;charset=utf-8' } });
        return new Response('not found', { status: 404 });
    },
});
console.log(`dashboard: http://localhost:${PORT}`);
