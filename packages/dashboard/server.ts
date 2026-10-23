// Swarm dashboard server. Usage: bun packages/dashboard/server.ts  ->  http://localhost:3100
// Reads the status files every bot writes (.practice/status/<name>.json, packages/core/src/status.ts), checks who is
// online on the live server (world feed roster), reads our live hiscore ranks (cached 5 min), and pushes everything
// to the page every 2 s over server-sent events. New bots appear on their own.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..', '..');
const statusDir = join(root, '.practice', 'status');
const PORT = Number(process.env.DASH_PORT ?? 3100);
const DEMO = 'https://rs-sdk-demo.fly.dev';

type Status = Record<string, any> & { name: string; at: number; server: string };
function readStatuses(): Status[] {
    if (!existsSync(statusDir)) return [];
    const out: Status[] = [];
    for (const f of readdirSync(statusDir).filter(f => f.endsWith('.json'))) {
        try {
            const s = JSON.parse(readFileSync(join(statusDir, f), 'utf8'));
            // Practice-server test bots drop off after 30 minutes without an update; live accounts stay.
            if (/^localhost/.test(s.server) && Date.now() - s.at > 30 * 60_000) continue;
            out.push(s);
        } catch { /* being written */ }
    }
    return out;
}

// Live roster: which of our accounts the server has in the world, and where. One feed socket, reconnects itself.
const roster = new Map<string, { x: number; z: number; level: number; combat: number; seen: number }>();
let worldPlayers = 0;
function connectFeed() {
    try {
        const ws = new WebSocket('wss://rs-sdk-demo.fly.dev/worldfeed');
        ws.onopen = () => ws.send(JSON.stringify({ t: 'roster', on: true }));
        ws.onmessage = e => {
            const m = JSON.parse(String(e.data));
            if (m.t === 'hello') worldPlayers = m.players ?? worldPlayers;
            if (m.t !== 'roster') return;
            worldPlayers = m.p.length;
            const now = Date.now();
            for (const p of m.p) roster.set(String(p[1]).toLowerCase(), { x: p[2], z: p[3], level: p[4], combat: p[5], seen: now });
        };
        ws.onclose = () => setTimeout(connectFeed, 5000);
        ws.onerror = () => ws.close();
    } catch { setTimeout(connectFeed, 5000); }
}
connectFeed();

// Hiscore ranks for our live accounts: one player page per 1.5 s, refreshed every 5 minutes.
const ranks = new Map<string, { at: number; rows: { board: string; rank: string; level: string; time: string }[] }>();
const SKILLS = ['Overall', 'Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft', 'Quest Points'];
async function refreshRanks() {
    const names = readStatuses().filter(s => !/^localhost/.test(s.server)).map(s => s.name);
    for (const name of names) {
        const r = ranks.get(name);
        if (r && Date.now() - r.at < 300_000) continue;
        try {
            const html = await (await fetch(`${DEMO}/hiscores/player/${encodeURIComponent(name.toLowerCase())}?profile=main`)).text();
            const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
            const rows = [];
            for (const b of SKILLS) {
                const m = text.match(new RegExp(`${b} ([0-9,-]+) ([0-9-]+) ((?:\\d+h )?(?:\\d+m )?\\d+s|-)`));
                if (m && m[2] !== '-' && m[2] !== '1') rows.push({ board: b, rank: m[1]!, level: m[2]!, time: m[3]! });
            }
            ranks.set(name, { at: Date.now(), rows });
        } catch { /* try again next round */ }
        await Bun.sleep(1500);
    }
}
setInterval(() => void refreshRanks(), 20_000);
void refreshRanks();

function state() {
    const now = Date.now();
    const bots = readStatuses().map(s => {
        const live = roster.get(s.name.toLowerCase());
        const fresh = now - s.at < 20_000;
        const inWorld = !!live && now - live.seen < 30_000;
        return { ...s, fresh, inWorld, live: inWorld ? live : null, ranks: ranks.get(s.name)?.rows ?? [] };
    });
    bots.sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.at - a.at);
    return { now, worldPlayers, bots };
}

Bun.serve({
    port: PORT,
    fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/state') return Response.json(state());
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
        if (url.pathname === '/' || url.pathname === '/index.html') return new Response(Bun.file(join(import.meta.dir, 'index.html')));
        return new Response('not found', { status: 404 });
    },
});
console.log(`dashboard: http://localhost:${PORT}`);
