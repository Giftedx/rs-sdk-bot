// Swarm dashboard server. Usage: bun packages/dashboard/server.ts  ->  http://localhost:3100
// Sources: the status files every bot writes (.practice/status/<name>.json, packages/core/src/status.ts), the live
// accounts in vendor/rs-sdk/bots (SERVER = the demo), the world-feed roster (who is in the world, where), our live
// hiscore ranks (cached 5 min), and the 2026-10-22 board snapshot (each board's #1 time). Pushes state every 2 s
// over server-sent events; new bots appear on their own. /api/map serves a land/water map built from collision data.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { freemem } from 'node:os';

const root = resolve(import.meta.dir, '..', '..');
const statusDir = join(root, '.practice', 'status');
const botsDir = join(root, 'vendor', 'rs-sdk', 'bots');
const PORT = Number(process.env.DASH_PORT ?? 3100);
const DEMO = 'https://rs-sdk-demo.fly.dev';
const ROLE_SKILL: Record<string, string> = { thieving: 'Thieving', fishing: 'Fishing', woodcutting: 'Woodcutting', mining: 'Mining', runecraft: 'Runecraft', cooking: 'Cooking', crafting: 'Crafting', combat: 'Attack' };

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
function liveAccounts(): string[] {
    if (!existsSync(botsDir)) return [];
    return readdirSync(botsDir).filter(n => {
        try { return /SERVER=rs-sdk-demo/.test(readFileSync(join(botsDir, n, 'bot.env'), 'utf8')) && n !== '_template'; } catch { return false; }
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

// XP rate and phase history per bot, from the status files as they change.
const samples = new Map<string, { at: number; tick: number; xp: number }[]>();
const events: { at: number; name: string; text: string }[] = [];
const lastPhase = new Map<string, string>();
function track(s: Status) {
    const xp = (s.skills ?? []).reduce((n: number, k: any) => n + (k.xp ?? 0), 0);
    const list = samples.get(s.name) ?? [];
    if (!list.length || list[list.length - 1]!.tick !== s.tick) list.push({ at: s.at, tick: s.tick, xp });
    while (list.length > 2 && list[0]!.at < s.at - 120_000) list.shift();
    samples.set(s.name, list);
    const ph = s.phase ?? '';
    if (ph && lastPhase.get(s.name) !== ph) {
        if (lastPhase.has(s.name)) events.unshift({ at: s.at, name: s.name, text: ph });
        lastPhase.set(s.name, ph);
        events.length = Math.min(events.length, 60);
    }
}
function rate(name: string) {
    const l = samples.get(name) ?? [];
    if (l.length < 2) return null;
    const a = l[0]!, b = l[l.length - 1]!;
    return b.tick > a.tick ? (b.xp - a.xp) / (b.tick - a.tick) : null;
}

// System numbers for the footer (bun processes counted every 10 s).
let bunCount = 0;
setInterval(async () => {
    try {
        const p = Bun.spawn(["tasklist", "/FI", "IMAGENAME eq bun.exe", "/NH"], { stdout: "pipe" });
        const text = await new Response(p.stdout).text();
        bunCount = text.split(String.fromCharCode(10)).filter(l => l.toLowerCase().includes('bun.exe')).length;
    } catch { /* tasklist is Windows only */ }
}, 10_000);

// ---------- live roster ----------
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

// ---------- hiscores ----------
const BOARDS = ['Overall', 'Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft', 'Quest Points'];
const ranks = new Map<string, { at: number; rows: { board: string; rank: number; level: number; time: string }[] }>();
async function refreshRanks() {
    for (const name of liveAccounts()) {
        const r = ranks.get(name);
        if (r && Date.now() - r.at < 300_000) continue;
        try {
            const text = (await (await fetch(`${DEMO}/hiscores/player/${encodeURIComponent(name.toLowerCase())}?profile=main`)).text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
            const rows = [];
            for (const b of BOARDS) {
                const m = text.match(new RegExp(`${b} ([0-9,]+) ([0-9]+) ((?:\\d+h )?(?:\\d+m )?\\d+s)`));
                if (m && Number(m[2]) > 1) rows.push({ board: b, rank: Number(m[1]!.replace(/,/g, '')), level: Number(m[2]), time: m[3]! });
            }
            ranks.set(name, { at: Date.now(), rows });
        } catch { /* next round */ }
        await Bun.sleep(1200);
    }
}
setInterval(() => void refreshRanks(), 30_000);
void refreshRanks();
const snapshot = (() => { try { return JSON.parse(readFileSync(join(root, 'research', 'hiscores-2026-10-22.json'), 'utf8')); } catch { return null; } })();
const fmt = (ticks: number) => { const s = Math.round(ticks * 0.4); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`; };

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
        const skill = ROLE_SKILL[s.role] ?? null;
        const sk = skill ? (s.skills ?? []).find((k: any) => k.name === skill) : null;
        const target = Number(s.env?.target ?? 99) || 99;
        const r = fresh ? rate(name) : null;
        const xpLeft = sk ? Math.max(0, 998_458 * (target >= 99 ? 1 : 0) - sk.xp) : null;
        return {
            ...s, name, fresh, inWorld, live: inWorld ? live : null, ranks: ranks.get(name)?.rows ?? [],
            goalSkill: skill, goalLevel: target, goalNow: sk?.level ?? null, xpPerTick: r,
            eta: r && r > 0 && xpLeft ? fmt(xpLeft / r) : null,
            reserved: name === 'Haggis',
        };
    });
    bots.sort((a, b) => Number(b.inWorld) - Number(a.inWorld) || Number(b.fresh) - Number(a.fresh) || Number(a.reserved) - Number(b.reserved) || a.name.localeCompare(b.name));
    // Board table: each board's #1 (snapshot) against our best live rank on it.
    const boards = BOARDS.map(b => {
        const top = snapshot?.boards?.find((x: any) => x.board === b)?.rows?.[0];
        let best: any = null;
        for (const bot of bots) for (const r of bot.ranks) if (r.board === b && (!best || r.rank < best.rank)) best = { ...r, name: bot.name };
        return { board: b, top: top ? { name: top.name, time: fmt(top.ticks), ticks: top.ticks } : null, best };
    });
    return { now, worldPlayers, bots, boards, events: events.slice(0, 40), map: { ...MAP, ready: !!mapBytes }, sys: { freeGB: freemem() / 2 ** 30, bun: bunCount } };
}

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
        if (url.pathname === '/' || url.pathname === '/index.html') return new Response(Bun.file(join(import.meta.dir, 'index.html')));
        return new Response('not found', { status: 404 });
    },
});
console.log(`dashboard: http://localhost:${PORT}`);
