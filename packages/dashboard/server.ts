// Swarm dashboard server. Usage: bun packages/dashboard/server.ts  ->  http://localhost:3100
// Sources: the status files every bot writes (.practice/status/<name>.json, packages/core/src/status.ts), the live
// accounts in vendor/rs-sdk/bots (SERVER = the demo), the world feed (who is in the world, server tick, player count),
// our live hiscore ranks (cached 5 min), the 2026-10-22 board snapshot (each skill board's #1), the live Equipment,
// Bank and Runite boards, Grand Exchange prices (/api/market/items), and this machine (memory, CPU, bun processes).
// Pushes state every 2 s over server-sent events. /api/map serves a land/water map built from collision data.
// Files it keeps: .practice/events.jsonl (phase changes), .practice/results.jsonl (RESULT lines),
// .practice/rank-history.jsonl (rank changes). It reads .practice/vault-log.jsonl (the banker's transfers).
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
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
};
const PORT = Number(process.env.DASH_PORT ?? 3100);
const DEMO = 'https://rs-sdk-demo.fly.dev';
const BANKER = 'Moneyshot';
const MAIN = 'Haggis';
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
}
setTimeout(buildMap, 100);

// ---------- bots ----------
type Status = Record<string, any> & { name: string; at: number; server: string };
type Item = { name: string; count: number };
function liveAccounts(): string[] {
    if (!existsSync(botsDir)) return [];
    return readdirSync(botsDir).filter(n => {
        try { return n !== '_template' && /SERVER=rs-sdk-demo/.test(readFileSync(join(botsDir, n, 'bot.env'), 'utf8')); } catch { return false; }
    });
}
function readStatuses(): Map<string, Status> {
    const out = new Map<string, Status>();
    if (!existsSync(statusDir)) return out;
    for (const f of readdirSync(statusDir).filter(f => f.endsWith('.json'))) {
        try {
            const s = JSON.parse(readFileSync(join(statusDir, f), 'utf8'));
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
function trackResult(s: Status) {
    const text = String(s.result ?? '');
    if (!text || lastResult.get(s.name) === text) return;
    lastResult.set(s.name, text);
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
}, 2000);
async function scanProcs() {
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
setInterval(() => void scanProcs(), 15_000);
void scanProcs();

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
setInterval(() => void refreshRanks(), 30_000);
void refreshRanks();
function rankDelta(name: string, board: string) {
    const l = rankHist.get(name + '|' + board) ?? [];
    if (l.length < 2) return { delta: 0, since: null as number | null, hist: l.map(r => r.rank) };
    const day = Date.now() - 86_400_000, base = l.find(r => r.at >= day) ?? l[l.length - 2]!, now = l[l.length - 1]!;
    return { delta: base.rank - now.rank, since: base.at, hist: l.slice(-30).map(r => r.rank) };
}
const snapshot = (() => { try { return JSON.parse(readFileSync(join(root, 'research', 'hiscores-2026-10-22.json'), 'utf8')); } catch { return null; } })();
// Equipment, Bank and Runite boards: #1 holder and value, scraped every 10 min.
const EXTRA = [{ board: 'Equipment', path: 'outfit' }, { board: 'Bank', path: 'bank' }, { board: 'Runite', path: 'runite' }];
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

// ---------- Grand Exchange prices for the vault value ----------
const prices = new Map<string, number>();
let pricesAt = 0;
async function refreshPrices() {
    try {
        // 100 items per page (the API refuses more); about 15 pages.
        for (let offset = 0, total = 1; offset < total; offset += 100) {
            const j = await (await fetch(`${DEMO}/api/market/items?limit=100&offset=${offset}`, { signal: AbortSignal.timeout(15_000) })).json() as { items: any[]; total: number };
            total = Math.min(j.total ?? 0, 5000);
            // The market is thin: one trade can set lastPrice to 1,000,000 for Bread. Use the 7-day VWAP when the
            // item traded at least 3 times, else the shop base price.
            for (const i of j.items ?? []) { if (i.id != null) marketIds.set(String(i.name).toLowerCase(), Number(i.id)); const p = i.vwap != null && (i.trades ?? 0) >= 3 ? i.vwap : i.basePrice; if (p != null) prices.set(String(i.name).toLowerCase(), Number(p)); }
            await Bun.sleep(200);
        }
        pricesAt = Date.now();
    } catch { /* next round */ }
}
setInterval(() => void refreshPrices(), 600_000);
void refreshPrices();
// Item icons: packages/dashboard/items.png is the 32x32 sprite sheet (64 per row, index = item id) copied from
// vendor/lostcity-markets/storage/app/private/items-274.png; items.json maps lower-case names to ids (from its obj.json).
// The live market API ids win over items.json when both know a name.
const itemIds = new Map<string, number>(Object.entries((() => { try { return JSON.parse(readFileSync(join(import.meta.dir, 'items.json'), 'utf8')) as Record<string, number>; } catch { return {}; } })()));
const marketIds = new Map<string, number>();
const iconId = (name: string) => marketIds.get(name.toLowerCase()) ?? itemIds.get(name.toLowerCase()) ?? null;
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

// ---------- vault: everything the live accounts hold (pack + last-seen bank), and the banker's transfers ----------
function vault(bots: any[], now: number) {
    const totals = new Map<string, { count: number; holders: Map<string, number> }>();
    const holders = [];
    for (const b of bots) {
        if (!b.at || /^localhost/.test(b.server)) continue;
        const inv: Item[] = (b.inventory ?? []).filter(Boolean), bank: Item[] | null = b.bank ?? null;
        const mine = new Map<string, number>();
        for (const i of [...inv, ...(bank ?? [])]) if (i?.name && i.count > 0) mine.set(i.name, (mine.get(i.name) ?? 0) + i.count);
        let value = 0;
        for (const [n, c] of mine) {
            const t = totals.get(n) ?? { count: 0, holders: new Map() };
            t.count += c; t.holders.set(b.name, c); totals.set(n, t);
            value += (priceOf(n) ?? 0) * c;
        }
        holders.push({
            name: b.name, banker: b.name === BANKER, age: now - b.at, bankSeen: !!bank, coins: mine.get('Coins') ?? 0, value,
            items: [...mine].filter(([n]) => n !== 'Coins').sort((a, z) => z[1] - a[1]).map(([name, count]) => ({ name, count })),
        });
    }
    holders.sort((a, z) => Number(z.banker) - Number(a.banker) || z.value - a.value || a.name.localeCompare(z.name));
    const items = [...totals].filter(([n]) => n !== 'Coins').map(([name, t]) => {
        const p = priceOf(name);
        return { name, count: t.count, price: p, value: p != null ? p * t.count : null, holders: [...t.holders].sort((a, z) => z[1] - a[1]).map(([n, c]) => ({ name: n, count: c })) };
    }).sort((a, z) => (z.value ?? 0) - (a.value ?? 0) || z.count - a.count || a.name.localeCompare(z.name));
    const coins = totals.get('Coins')?.count ?? 0;
    const log = tailJsonl<{ at: number; from: string; to: string; items: Item[] }>(FILES.vault, 20).reverse();
    return {
        coins, value: coins + items.reduce((n, i) => n + (i.value ?? 0), 0), unpriced: items.filter(i => i.price == null).length,
        items, holders, log, logExists: existsSync(FILES.vault), banker: BANKER, pricesAt,
    };
}

function state() {
    const now = Date.now();
    const st = readStatuses();
    for (const s of st.values()) track(s);
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
        return {
            ...s, name, fresh, inWorld, live: inWorld ? live : null, ranks: rankRows.map(x => ({ ...x, ...rankDelta(name, x.board) })),
            role: guess ? guess.toLowerCase() + '*' : s.role, roleInferred: !!guess, seenInFeed: firstSeen.has(name.toLowerCase()),
            goalSkill: skill, goalLevel: target, goalNow: sk?.level ?? null, goalXp: sk?.xp ?? null, xpPerTick: r,
            xpPerHour: r != null ? r * 3_600_000 / world.tickMs : null, spark: spark.get(name) ?? [],
            eta: ticksLeft != null ? fmtTicks(ticksLeft) : null, finish: finish != null ? fmtTicks(finish) : null,
            pace: finish != null && top ? { top: top.name, topTime: fmtTicks(top.ticks), ahead: finish < top.ticks, gap: fmtTicks(Math.abs(top.ticks - finish)) } : null,
            action: fresh ? ({ x: 'xp', m: 'move', a: 'anim', d: 'dialog', s: 'stun', i: 'idle' } as Record<string, string>)[last] ?? null : null,
            phaseSince: since?.at ?? null, phaseExact: since?.exact ?? false,
            uptime: s.started && s.at ? s.at - s.started : null,
            reserved: name === MAIN,
        };
    });
    // In the world now, then fresh status, then the rest (seen in the feed, live accounts, practice bots); Haggis last.
    const tier = (b: typeof bots[number]) => b.reserved ? 5 : b.inWorld ? 0 : b.fresh ? 1 : b.seenInFeed ? 2 : /^localhost/.test(b.server) ? 4 : 3;
    bots.sort((a, b) => tier(a) - tier(b) || (b.at ?? 0) - (a.at ?? 0) || a.name.localeCompare(b.name));
    // 24 boards: each board's #1 against our best live rank on it.
    const boards = [...SKILL_BOARDS.map(b => {
        const top = snapshot?.boards?.find((x: any) => x.board === b)?.rows?.[0];
        let best: any = null;
        for (const bot of bots) for (const r of bot.ranks) if (r.board === b && (!best || r.rank < best.rank)) best = { ...r, name: bot.name };
        const ours = best ? parseTime(best.time) : null;
        const gap = best && top ? (best.level >= top.level ? { kind: 'time', ahead: ours! <= top.ticks, text: fmtTicks(Math.abs(top.ticks - ours!)) } : { kind: 'level', ahead: false, text: `${top.level - best.level} lvl` }) : null;
        return { board: b, top: top ? { name: top.name, level: top.level, time: fmtTicks(top.ticks), ticks: top.ticks } : null, best, gap, kind: 'skill' };
    }), ...EXTRA.map(e => {
        const t = extraTop.get(e.board);
        return { board: e.board, top: t ? { name: t.name, level: null, time: t.value, ticks: null } : null, best: null, gap: null, kind: 'value' };
    })];
    const v = vault(bots, now);
    const icons: Record<string, number | null> = {};
    const see = (l: any) => { for (const i of l ?? []) if (i?.name && !(i.name in icons)) icons[i.name] = iconId(i.name); };
    for (const b of bots as any[]) { see(b.inventory); see(b.bank); }
    see(v.items); for (const t of v.log) see(t.items);
    const sys = {
        freeGB: freemem() / 2 ** 30, totalGB: totalmem() / 2 ** 30, cpu: cpuPct, cores: cpus().length,
        procs: procs.map(p => ({ ...p, up: now - p.started })),
    };
    return {
        now, world: { ...world, tick: serverTick() }, worldPlayers: world.players, bots, boards, events: events.slice(0, 200),
        results: results.slice(0, 60), icons, scripts: scripts(), vault: v, map: { ...MAP, ready: !!mapBytes }, sys, snapshotAt: snapshot?.takenAt ?? null,
    };
}

// The page embeds the rs-world viewer (COEP require-corp); credentialless keeps Google Fonts loadable.
const ISO = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };
Bun.serve({
    port: PORT,
    fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/state') return Response.json(state());
        if (url.pathname === '/api/map') return mapBytes ? new Response(mapBytes, { headers: { 'content-type': 'application/octet-stream' } }) : new Response('building', { status: 503 });
        if (url.pathname === '/events') {
            let timer: ReturnType<typeof setInterval>;
            const stream = new ReadableStream({
                start(c) {
                    const push = () => { try { c.enqueue(`data: ${JSON.stringify(state())}\n\n`); } catch { clearInterval(timer); } };
                    push();
                    timer = setInterval(push, 2000);
                },
                cancel() { clearInterval(timer); },
            });
            return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
        }
        if (url.pathname === '/items.png') return new Response(Bun.file(join(import.meta.dir, 'items.png')), { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' } });
        if (url.pathname === '/' || url.pathname === '/index.html') return new Response(Bun.file(join(import.meta.dir, 'index.html')), { headers: { ...ISO, 'content-type': 'text/html;charset=utf-8' } });
        return new Response('not found', { status: 404 });
    },
});
console.log(`dashboard: http://localhost:${PORT}`);
