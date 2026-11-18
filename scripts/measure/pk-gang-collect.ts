// A long, low-rate record of named rivals from the public world feed: the source for the behaviour record of the
// dagger gang (research/gang-clones.md). Read-only: one socket, the roster and one tile rectangle that follows the
// names. It sends no game input, no account name and no credential.
//   bun scripts/measure/pk-gang-collect.ts <hours> [outDir] [name,name,...]
// Files in outDir (default .practice/gang-record):
//   samples.jsonl          one line a roster frame (each 10 ticks): {k, at, on:{name:[x,z,level,combat]}, players}
//   feed-<startMs>.jsonl   hello, roster and tick lines in the format of pk-rival-feed.ts `record`, one file an hour;
//                          `pk-rival-feed.ts digest` and `pk-gang-record.ts` read them.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RosterFeed, type RosterRow } from '../../packages/core/src/roster-feed';
import { gameDialAddress } from '../../packages/core/src/websocket-proxy';

export type Rect = { x: number; z: number; w: number; h: number };
// The gang's post (research/pvp-fight-loop.md): the rectangle with no name online.
export const POST = { x: 3078, z: 3640 } as const;
const MARGIN = 32, EDGE = 8, MAX = 384;
export const inside = (r: Rect, x: number, z: number, edge = 0) => x >= r.x + edge && x < r.x + r.w - edge && z >= r.z + edge && z < r.z + r.h - edge;
// The rectangle for the tiles of the names: `current` while each tile is `EDGE` tiles inside it, else the bounding box
// with `MARGIN` tiles on each side. A box wider than a subscription allows keeps its centre.
export function followRect(tiles: { x: number; z: number }[], current?: Rect): Rect {
    const pts = tiles.length ? tiles : [POST];
    if (current && pts.every(p => inside(current, p.x, p.z, EDGE))) return current;
    const x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x)), z0 = Math.min(...pts.map(p => p.z)), z1 = Math.max(...pts.map(p => p.z));
    const w = Math.min(MAX, x1 - x0 + 1 + 2 * MARGIN), h = Math.min(MAX, z1 - z0 + 1 + 2 * MARGIN);
    return { x: Math.max(0, Math.floor((x0 + x1 + 1) / 2 - w / 2)), z: Math.max(0, Math.floor((z0 + z1 + 1) / 2 - h / 2)), w, h };
}
const wild = (z: number) => z >= 3520 && z < 3968;
// The world feed of one server into `file`: the hello, roster and tick lines of the tiles of `rect`, as the recorder
// of pk-rival-feed.ts writes them. `first` is a line written before them (the names of a bench meeting). The engine of
// a bench case serves the feed with WORLD_FEED=true, so a bench fight and a live fight have one instrument. Returns
// the function that closes the socket.
export function tapFeed(url: string, file: string, rect: Rect, first?: unknown): () => void {
    // A fault of the tap must not end the run that it measures.
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, first === undefined ? '' : JSON.stringify(first) + '\n'); } catch { return () => {}; }
    const feed = new RosterFeed(), ws = new WebSocket(url), line = (o: unknown) => { try { appendFileSync(file, JSON.stringify(o) + '\n'); } catch { /* the folder went away */ } };
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'roster', on: true })); ws.send(JSON.stringify({ t: 'sub', ...rect })); };
    ws.onmessage = e => { try { const m = feed.expand(JSON.parse(String(e.data)));
        if (m.t === 'hello') line({ t: 'hello', r: 0, at: Date.now(), tick: m.tick });
        else if (m.t === 'roster') line({ t: 'roster', k: m.k, p: m.p });
        else if (m.t === 'tick' && (m.p?.length || m.rp?.length)) line({ t: 'tick', r: 0, k: m.k, p: m.p, rp: m.rp }); } catch { /* a frame that is no JSON is left out */ } };
    ws.onerror = () => { /* a bench with no feed writes the first line only */ };
    return () => { try { ws.close(); } catch { /* closed */ } };
}

if (import.meta.main) {
    const hours = Number(process.argv[2] ?? 1);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 14) { console.log('usage: bun scripts/measure/pk-gang-collect.ts <hours, over 0 and at most 336> [outDir] [name,name,...]'); process.exit(2); }
    const dir = resolve(process.argv[3] ?? join(import.meta.dir, '..', '..', '.practice', 'gang-record'));
    const names = new Set((process.argv[4] ?? 'goondelf,ligma,sugma').toLowerCase().split(','));
    mkdirSync(dir, { recursive: true });
    const samples = join(dir, 'samples.jsonl');
    let file = '', fileAt = 0, rect: Rect | undefined, lastSub = 0, ws: WebSocket | undefined, done = false, frames = 0, wait = 5_000;
    const line = (o: unknown) => appendFileSync(file, JSON.stringify(o) + '\n');
    const sub = (r: Rect) => { rect = r; lastSub = Date.now(); ws?.send(JSON.stringify({ t: 'sub', ...r })); };
    // A new file starts with a new subscription: the server then sends each player of the rectangle in full.
    const rotate = () => { fileAt = Date.now(); file = join(dir, `feed-${fileAt}.jsonl`); };
    const connect = () => {
        const feed = new RosterFeed(), sock = new WebSocket(process.env.FEED_URL ?? gameDialAddress('wss://rs-sdk-demo.fly.dev/worldfeed'));
        ws = sock;
        sock.onopen = () => { wait = 5_000; rotate(); sock.send(JSON.stringify({ t: 'roster', on: true })); sub(rect ?? followRect([])); };
        sock.onmessage = e => {
            const m = feed.expand(JSON.parse(String(e.data)));
            if (m.t === 'hello') line({ t: 'hello', r: 0, at: Date.now(), tick: m.tick, tickMs: m.tickMs, players: m.players });
            else if (m.t === 'roster') {
                const rows = (m.p ?? []) as RosterRow[], on: Record<string, number[]> = {};
                for (const p of rows) if (names.has(String(p[1]).toLowerCase())) on[String(p[1]).toLowerCase()] = [p[2], p[3], p[4], p[5]];
                appendFileSync(samples, JSON.stringify({ k: m.k, at: Date.now(), on, players: rows.length }) + '\n'); frames++;
                line({ t: 'roster', k: m.k, p: rows.filter(p => names.has(String(p[1]).toLowerCase()) || wild(p[3])) });
                const next = followRect(Object.values(on).map(([x, z]) => ({ x: x!, z: z! })), rect);
                if (Date.now() - fileAt >= 3_600_000) { rotate(); line({ t: 'hello', r: 0, at: Date.now(), tick: m.k }); sub(next); }
                else if (next !== rect && Date.now() - lastSub >= 8_000) sub(next);
            } else if (m.t === 'tick') {
                if (m.reset) line({ t: 'hello', r: 0, at: Date.now(), tick: m.k, rect });
                if (m.p?.length || m.rp?.length) line({ t: 'tick', r: 0, k: m.k, p: m.p, rp: m.rp });
            }
        };
        // The server closes a socket that sends nothing for its idle time; a closed socket connects again, later each time.
        sock.onclose = () => { if (!done && ws === sock) { setTimeout(connect, wait); wait = Math.min(wait * 2, 120_000); } };
        sock.onerror = () => { /* the close handler connects again */ };
    };
    connect();
    setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send('{"t":"ping"}'); }, 30_000);
    setTimeout(() => { done = true; try { ws?.close(); } catch { /* closed */ } console.log(`RESULT ok gang collect hours=${hours} frames=${frames} out=${dir}`); process.exit(0); }, hours * 3_600_000);
}
