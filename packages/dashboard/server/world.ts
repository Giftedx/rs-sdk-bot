import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWorn } from '../appearance';
import { type DeathRecap } from '../death-recap';
import { hiscoreRows, valueBoardRows, ONLINE_MS, RIVALS_PER_BOARD, type BoardRow, type HiscoreRow, type ValueRow } from '../world-view';
import { RosterFeed } from '../../core/src/roster-feed';
import { gameDialAddress } from '../../core/src/websocket-proxy';
import { append, DEMO, FILES, liveAccounts, OBJS, remoteNames, root, tailJsonl, type Row, type Status } from './config';

// ---------- world feed: who is in the world, server tick, player count ----------
const roster = new Map<string, { name: string; x: number; z: number; level: number; combat: number; seen: number }>();
const firstSeen = new Map<string, number>();
const world = { players: 0, tick: 0, tickAt: 0, tickMs: 400, connected: false, rev: 0 };
// The feed sends a roster every few seconds. A half-open socket reports no close, so silence is the only sign of it.
const FEED_SILENCE_MS = 60_000;
let feedSocket: WebSocket | null = null, feedHeardAt = 0;
function dropFeed(ws: WebSocket) {
    if (feedSocket !== ws) return;
    feedSocket = null;
    world.connected = false;
    // The roster stays: the feed closes often, and each entry already expires 30 s after it was last seen.
    try { ws.close(); } catch { /* already closed */ }
    setTimeout(connectFeed, 1000);
}
function connectFeed() {
    try {
        const ws = new WebSocket(gameDialAddress('wss://rs-sdk-demo.fly.dev/worldfeed'));
        feedSocket = ws;
        feedHeardAt = Date.now();
        const feed = new RosterFeed();
        ws.onopen = () => { world.connected = true; ws.send(JSON.stringify({ t: 'roster', on: true })); };
        ws.onmessage = e => {
            try {
                if (feedSocket !== ws) return;
                const m = feed.expand(JSON.parse(String(e.data)));
                const now = Date.now();
                feedHeardAt = now;
                if (m.t === 'hello') { world.players = m.players ?? world.players; world.tick = m.tick ?? world.tick; world.tickAt = now; world.tickMs = m.tickMs ?? 400; world.rev = m.rev ?? 0; }
                if (m.t !== 'roster') return;
                if (!Array.isArray(m.p) || !m.p.every((p:any)=>Array.isArray(p)&&p.length>=6&&typeof p[1]==='string'&&[p[2],p[3],p[4],p[5]].every(Number.isFinite))) return;
                world.players = m.p.length;
                if (m.k) { world.tick = m.k; world.tickAt = now; }
                const present=new Set<string>();
                for (const p of m.p) {
                    const n = String(p[1]).toLowerCase();
                    present.add(n);
                    if (!firstSeen.has(n)) {
                        if (firstSeen.size >= 4096) firstSeen.delete(firstSeen.keys().next().value!);
                        firstSeen.set(n, now);
                    }
                    roster.set(n, { name: String(p[1]), x: p[2], z: p[3], level: p[4], combat: p[5], seen: now });
                }
                // RosterFeed makes each roster message the full player set, so an absent name has left.
                for(const name of roster.keys())if(!present.has(name))roster.delete(name);
            } catch (err) {
                console.error(`world feed message failed: ${String(err)}`);
            }
        };
        ws.onclose = () => dropFeed(ws);
        ws.onerror = () => dropFeed(ws);
    } catch { setTimeout(connectFeed, 5000); }
}
const serverTick = () => world.tickAt ? world.tick + Math.floor((Date.now() - world.tickAt) / world.tickMs) : null;
const fmtTicks = (ticks: number) => { const s = Math.round(ticks * world.tickMs / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };
const parseTime = (t: string) => { let s = 0; for (const [, n, u] of t.matchAll(/(\d+)([hms])/g)) s += Number(n) * (u === 'h' ? 3600 : u === 'm' ? 60 : 1); return Math.round(s * 1000 / world.tickMs); };

// ---------- hiscores: our ranks (and their history), the 24 boards ----------
const SKILL_BOARDS = ['Overall', 'Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft', 'Quest Points'];
const EXTRA = [{ board: 'Equipment', path: 'outfit' }, { board: 'Bank', path: 'bank' }, { board: 'Runite', path: 'runite' }];
const ALL_BOARDS = [...SKILL_BOARDS, ...EXTRA.map(e => e.board)];
const ranks = new Map<string, { at: number; rows: Row[] }>();
type RankRec = { at: number; name: string; board: string; rank: number; level: number };
const rankHist = new Map<string, RankRec[]>(); // name|board -> history, oldest first
for (const r of tailJsonl<RankRec>(FILES.ranks, 5000)) { const k = r.name + '|' + r.board; const l = rankHist.get(k) ?? []; l.push(r); rankHist.set(k, l); }
let ranksRefreshing = false;
// When an account's ranks last moved: a quiet account is read every 30 minutes, an active one every 5.
const rankChangedAt = new Map<string, number>();
async function refreshRanks() {
    if (ranksRefreshing) return;
    ranksRefreshing = true;
    try {
    for (const name of [...new Set([...liveAccounts(), ...remoteNames()])]) {
        const r = ranks.get(name);
        if (r && Date.now() - r.at < (Date.now() - (rankChangedAt.get(name) ?? 0) > 2 * 3600_000 ? 1_800_000 : 300_000)) continue;
        try {
            const response = await fetch(gameDialAddress(`${DEMO}/hiscores/player/${encodeURIComponent(name.toLowerCase())}?profile=main`), { signal: AbortSignal.timeout(15_000) });
            if (!response.ok) throw Error(`Player ranks HTTP ${response.status}`);
            const rows: Row[] = hiscoreRows(await response.text(), SKILL_BOARDS);
            if (!r || JSON.stringify(r.rows) !== JSON.stringify(rows)) rankChangedAt.set(name, Date.now());
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
    } finally { ranksRefreshing = false; }
}
const EMPTY_RANK_DELTA = { delta: 0, since: null as number | null, hist: [] as number[] };
function rankDelta(name: string, board: string) {
    const l = rankHist.get(name + '|' + board);
    if (!l || l.length === 0) return EMPTY_RANK_DELTA;
    if (l.length === 1) return { delta: 0, since: null as number | null, hist: [l[0]!.rank] };
    // A row is written only when a rank changes, so the rank held 24 hours ago is the newest row older than that.
    const day = Date.now() - 86_400_000;
    let baseIdx = 0;
    for (let i = l.length - 1; i >= 0; i--) {
        if (l[i]!.at < day) { baseIdx = i; break; }
    }
    const base = l[baseIdx]!, now = l[l.length - 1]!;
    const start = Math.max(0, l.length - 30);
    const hist = new Array<number>(l.length - start);
    for (let i = start; i < l.length; i++) hist[i - start] = l[i]!.rank;
    return { delta: base.rank - now.rank, since: base.at, hist };
}
// Live #1 per skill board (category = skill index + 1, Quest Points 100: packages/planner/src/scout-cli.ts),
// refreshed hourly, one request a second. The snapshot is only the fallback, with its age shown.
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
const boardTops = new Map<string, { at: number; rows: BoardRow[] }>();
async function refreshLiveTops() {
    for (const b of SKILL_BOARDS) {
        try {
            const response = await fetch(gameDialAddress(`${DEMO}/hiscores?category=${CATEGORY[b]}&profile=main`), { signal: AbortSignal.timeout(15_000) });
            if (!response.ok) throw Error(`Board HTTP ${response.status}`);
            const rows = parseBoard(await response.text());
            if (rows[0]) { liveTop.set(b, { name: rows[0].name, level: rows[0].level, ticks: rows[0].ticks, at: Date.now() }); boardTops.set(b, { at: Date.now(), rows: rows.slice(0, RIVALS_PER_BOARD) }); }
        } catch { /* keep the last value */ }
        await Bun.sleep(1000);
    }
}
const snapshotTopByBoard = new Map<string, { name: string; level: number; ticks: number }>();
const snapshot: { takenAt: string } | null = (() => {
    try {
        const parsed = JSON.parse(readFileSync(join(root, 'research', 'hiscores-2026-10-22.json'), 'utf8'));
        for (const entry of parsed?.boards ?? []) {
            const row = entry?.rows?.[0];
            if (entry?.board && row) {
                snapshotTopByBoard.set(entry.board, { name: row.name, level: row.level, ticks: row.ticks });
            }
        }
        return typeof parsed?.takenAt === 'string' ? { takenAt: parsed.takenAt } : null;
    } catch { return null; }
})();
const snapshotTakenAt = snapshot?.takenAt ? (Date.parse(snapshot.takenAt) || 0) : 0;
function topOf(board: string): { name: string; level: number; ticks: number; at: number; live: boolean } | null {
    const l = liveTop.get(board);
    if (l) return { ...l, live: true };
    const s = snapshotTopByBoard.get(board);
    return s ? { name: s.name, level: s.level, ticks: s.ticks, at: snapshotTakenAt, live: false } : null;
}
// Player lookups (World plugin): any player's hiscore page, one request every 1.2 s, each kept 30 minutes. They are served
// only on demand, through /api/player; the state does not carry them. The hosted page cannot reach the hiscores
// itself (no CORS), so it shows no lookup detail.
type Lookup = { name: string; at: number; rows: HiscoreRow[]; worn: { slot: string; id:number; name: string }[] | null; wornAt: number | null };
const lookups = new Map<string, Lookup>();
// Worn items of an online player (appearance.ts readWorn); lookups run one at a time, so this holds one feed slot.
const recapCache = new Map<string, { at: number; recap: DeathRecap | null }>();
const wornOf = (name: string, seen: { x: number; z: number } | undefined) => seen && OBJS.size ? readWorn(gameDialAddress(DEMO.replace(/^http/, 'ws') + '/worldfeed'), name, seen, OBJS) : Promise.resolve(null);
let lookupChain: Promise<unknown> = Promise.resolve();
const lookupPending = new Map<string, Promise<Lookup | null>>();
function lookupPlayer(name: string): Promise<Lookup | null> {
    const key = name.toLowerCase(), hit = lookups.get(key);
    if (hit && Date.now() - hit.at < 1_800_000) return Promise.resolve(hit);
    const pending = lookupPending.get(key);
    if (pending) return pending;
    const job = lookupChain.then(async () => {
        const again = lookups.get(key);
        if (again && Date.now() - again.at < 1_800_000) return again;
        try {
            const r = await fetch(gameDialAddress(`${DEMO}/hiscores/player/${encodeURIComponent(key)}?profile=main`), { signal: AbortSignal.timeout(15_000) });
            if (!r.ok && r.status !== 404) return null;
            const rows = r.ok ? hiscoreRows(await r.text(), SKILL_BOARDS) : [], seen = roster.get(key), online = !!seen && Date.now() - seen.seen < ONLINE_MS;
            const worn = online ? await wornOf(name, seen) : null;
            const entry: Lookup = { name, at: Date.now(), rows, worn, wornAt: worn ? Date.now() : null };
            lookups.delete(key); lookups.set(key, entry);
            if (lookups.size > 400) lookups.delete(lookups.keys().next().value!);
            return entry;
        } catch { return null; } finally { await Bun.sleep(1200); }
    }).finally(() => { lookupPending.delete(key); });
    lookupPending.set(key, job);
    lookupChain = job.catch(() => null);
    return job;
}

// Equipment, Bank and Runite boards: each page's top 50, read every 10 min, for the #1 holder, our accounts' ranks
// (a value board has no per-player page) and the value at the page's last rank.
const extraBoards = new Map<string, { at: number; rows: ValueRow[] }>();
async function refreshExtra() {
    for (const e of EXTRA) {
        try {
            const response = await fetch(gameDialAddress(`${DEMO}/hiscores/${e.path}?profile=main`), { signal: AbortSignal.timeout(15_000) });
            if (!response.ok) throw Error(`Value board HTTP ${response.status}`);
            const rows = valueBoardRows(await response.text());
            if (rows.length) extraBoards.set(e.board, { at: Date.now(), rows });
        } catch { /* next round */ }
    }
}
const extraBoardRowIndex = new WeakMap<ValueRow[], Map<string, ValueRow>>();
function extraBoardByName(rows: ValueRow[]): Map<string, ValueRow> {
    let map = extraBoardRowIndex.get(rows);
    if (!map) {
        map = new Map<string, ValueRow>();
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!;
            const low = row.name.toLowerCase();
            if (!map.has(low)) map.set(low, row);
        }
        extraBoardRowIndex.set(rows, map);
    }
    return map;
}
// An account's rows on the value boards, in the shape of its skill rows (the value as the time text), with the
// board read's own time (`at`): the account's ranksAt is the time of its skill page. A read older than 30 minutes
// (the page has failed since) is not shown.
const valueRanks = (name: string): (Row & { at: number })[] => {
    const low = name.toLowerCase(), now = Date.now(), out: (Row & { at: number })[] = [];
    for (let i = 0; i < EXTRA.length; i++) {
        const e = EXTRA[i]!;
        const t = extraBoards.get(e.board);
        if (!t || now - t.at >= 1_800_000) continue;
        const r = extraBoardByName(t.rows).get(low);
        if (r) out.push({ board: e.board, rank: r.rank, level: 0, time: r.text, at: t.at });
    }
    return out;
};

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

function startWorldFeed() {
    setInterval(() => {
        if (feedSocket && Date.now() - feedHeardAt > FEED_SILENCE_MS) {
            console.error(`world feed silent for ${FEED_SILENCE_MS / 1000} s: reconnecting`);
            dropFeed(feedSocket);
        }
    }, 15_000);
    connectFeed();
}

function startHiscoresRefresh() {
    setInterval(() => void refreshRanks(), 60_000);
    void refreshRanks();
    setInterval(() => void refreshLiveTops(), 900_000);
    void refreshLiveTops();
    setInterval(() => void refreshExtra(), 600_000);
    void refreshExtra();
}

export {
    ALL_BOARDS,
    boardTops,
    connectFeed,
    EXTRA,
    extraBoards,
    firstSeen,
    fmtTicks,
    inferRole,
    liveTop,
    lookupPlayer,
    NO_ROLE,
    parseTime,
    rankDelta,
    ranks,
    recapCache,
    refreshRanks,
    roster,
    serverTick,
    SKILL_BOARDS,
    snapshot,
    startHiscoresRefresh,
    startWorldFeed,
    topOf,
    valueRanks,
    world,
};
