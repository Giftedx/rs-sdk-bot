import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadContentTable } from '../appearance';
import { folderScan } from '../folder-scan';
import { tailJsonlFile } from '../jsonl-tail';
import { type PriceIdentity } from '../item-prices';
import { canonicalSnapshots, ownerOfIn } from '../../core/src/fleet-snapshots';
import { resolveFleetDataDir, simStatusDir, statusReadDirs } from '../../core/src/practice-paths';

// DASH_ROOT lets a server in a worktree read the data of another checkout.
export const dashboardDir = resolve(import.meta.dir, '..');
export const sourceRoot = resolve(import.meta.dir, '..', '..', '..'), startedAt = Date.now();
export const root = resolve(process.env.DASH_ROOT ?? sourceRoot);
export const practice = join(root, '.practice');
export const statusDirs = [...new Set([...statusReadDirs(root), simStatusDir(root)])];
const botsDir = join(root, 'vendor', 'rs-sdk', 'bots');
export const FILES = {
    events: join(practice, 'events.jsonl'),
    results: join(practice, 'results.jsonl'),
    ranks: join(practice, 'rank-history.jsonl'),
    vault: join(practice, 'vault-log.jsonl'),
    swarm: join(practice, 'swarm-state.json'),
    requests: join(root, 'research', 'owner-requests.md'),
    haggisRun: join(root, 'research', 'haggis-run.md'),
    haggisPlan: join(dashboardDir, 'haggis-plan.json'),
    scoreboard: join(practice, 'live', 'scoreboard.json'),
    fleet: join(resolveFleetDataDir(root), 'fleet'),
};
export const PORT = Number(process.env.DASH_PORT ?? 3100);
export const PAGE_FILE = resolve(process.env.DASH_PAGE ?? join(dashboardDir, 'index.html'));
// The state holds bot positions, inventories, banks and account names, so only this PC listens by default.
// DASH_HOST=0.0.0.0 opens it to the network on purpose (the reveal routes still answer loopback only).
export const HOST = process.env.DASH_HOST ?? '127.0.0.1';
export const DEMO = 'https://rs-sdk-demo.fly.dev';
export const BANKER = 'Moneyshot';
export const MAIN = 'Haggis';
export const SECRET_RE = new RegExp(MAIN, 'gi');
export const SECRET_MARK = '⟦MAIN⟧';
// A script started by hand (outside the swarm) reports its file name as the goal, and the swarm still lists the
// account's old job. This map names what the script does, so the roster shows the run, not the stale job.
export const SCRIPT_ROLE: Record<string, { role: string; skill?: string; goal: string }> = {
    'fishcook.ts': { role: 'cooking', skill: 'Cooking', goal: 'food chain: fish and cook' },
    'foodcourier.ts': { role: 'courier', goal: 'food chain: courier' },
    'goldfarm.ts': { role: 'thieving', goal: 'gold farm: knights, food by trade' },
    'banker.ts': { role: 'bank', goal: 'bank' },
    'give-to-banker.ts': { role: 'give', goal: 'give to the bank' },
};
export const ROLE_SKILL: Record<string, string> = { thieving: 'Thieving', fishing: 'Fishing', woodcutting: 'Woodcutting', mining: 'Mining', runecraft: 'Runecraft', cooking: 'Cooking', crafting: 'Crafting', combat: 'Attack' };
export const NL = String.fromCharCode(10);

export type Status = Record<string, any> & { name: string; at: number; server: string };
export type Item = PriceIdentity & { name: string; count: number; unconfirmed?: true };
export type Row = { board: string; rank: number; level: number; time: string };

export const OBJS = loadContentTable(join(root, 'vendor', 'rs-sdk', 'server', 'content'), 'obj');

export function tailJsonl<T>(file: string, n: number): T[] { return tailJsonlFile<T>(file, n); }
export function append(file: string, doc: unknown) {
    if (process.env.DASH_READ_ONLY === '1') return;
    try { appendFileSync(file, JSON.stringify(doc) + NL); } catch { /* locked or full: memory still has it */ }
}
// Runs a slow read at most once per `ms` for a key; between runs the last value is returned.
const everyCache = new Map<string, { at: number; value: unknown }>();
export function every<T>(ms: number, key: string, read: () => T): T {
    const hit = everyCache.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.value as T;
    const value = read();
    everyCache.set(key, { at: Date.now(), value });
    return value;
}
// Re-reads a file when modified within the last second or when its mtime or size changes.
const fileCache = new Map<string, { mtime: number; size: number; value: unknown }>();
export function cached<T>(file: string, parse: (text: string) => T, empty: T): T {
    try {
        const st = statSync(file), hit = fileCache.get(file);
        if (hit && Date.now() - st.mtimeMs > 1000 && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.value as T;
        const value = parse(readFileSync(file, 'utf8'));
        fileCache.set(file, { mtime: st.mtimeMs, size: st.size, value });
        return value;
    } catch {
        if (!existsSync(file)) {
            fileCache.delete(file);
            return empty;
        }
        return (fileCache.get(file)?.value as T) ?? empty;
    }
}

// ---------- map: 2 tiles per pixel; 0 void, 1 land, 2 water/blocked floor, 3 objects/walls ----------
export const MAP = { x0: 2368, z0: 2880, w: 560, h: 416, scale: 2 };
let mapBytes: Uint8Array | null = null;
export function getMapBytes(): Uint8Array | null { return mapBytes; }
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
export function startMapBuild() {
    setTimeout(buildMap, 100);
}

// The bots folder holds every practice bot ever made, so a bot.env is read once and then again only in the scan's slice.
const accountScan = folderScan(botsDir, { cycle: 20, listMs: 0 }), accountLive = new Map<string, boolean>();
let accountsCache = { at: 0, names: [] as string[] };
export function liveAccounts(): string[] {
    if (Date.now() - accountsCache.at < 30_000) return accountsCache.names;
    const { check, gone } = accountScan();
    for (const n of gone) accountLive.delete(n);
    for (const n of check) {
        if (n === '_template') continue;
        try { accountLive.set(n, /SERVER=rs-sdk-demo/.test(readFileSync(join(botsDir, n, 'bot.env'), 'utf8'))); }
        catch { if (existsSync(join(botsDir, n))) accountScan.retry(n); else accountLive.delete(n); }
    }
    accountsCache = { at: Date.now(), names: [...accountLive].filter(([, live]) => live).map(([n]) => n).sort() };
    return accountsCache.names;
}

// Each side's last fleet-data sync (snapshots) and the cross-side orders not yet done (orders and receipts); a side with no snapshot is not listed.
export function fleetList(dir: string): any[] { return every(10_000, dir, () => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => cached<any>(join(dir, f), JSON.parse, null)) : []); }
// One row per account: an account that changed side shows once, under the side that owns it (packages/core/src/fleet-snapshots.ts).
export function snapshotFiles() { return canonicalSnapshots(fleetList(join(FILES.fleet, 'snapshots')).filter(s => typeof s?.side === 'string'), ownerOfIn(FILES.fleet)); }
// A side's own published names also need ranks and nameplates when this container has no local credentials yet.
export function remoteNames(): string[] { return snapshotFiles().flatMap(s => (s?.accounts ?? []).map((a: any) => String(a?.name ?? ''))).filter(n => /^[A-Za-z0-9]{1,12}$/.test(n)); }

// Named places on the food-chain route (scripts/foodcourier.ts), by box; null elsewhere.
const PLACES: [string, number, number, number, number][] = [
    ['Ardougne', 2560, 3200, 2720, 3340], ['Brimhaven', 2740, 3140, 2960, 3240], ['Port Sarim', 2990, 3140, 3070, 3270],
    ['Draynor', 3071, 3200, 3130, 3300], ['Lumbridge', 3130, 3140, 3280, 3300], ['at sea', 2700, 3100, 3000, 3290],
];
export function placeOf(p: { x: number; z: number } | undefined | null): string | null {
    if (!p) return null;
    const hit = PLACES.find(([, x0, z0, x1, z1]) => p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1);
    return hit ? hit[0] : null;
}

const shortPhaseCache = new Map<string, string>();
export function shortPhase(ph: string) {
    const hit = shortPhaseCache.get(ph);
    if (hit !== undefined) return hit;
    let res = ph;
    // "gave 1 Shortbow, 1 Bronze sword, ..." -> "gave 19 items": never ship item lists to the roster.
    const m = ph.match(/^(\w+(?: \w+)?)\s+\d+ [A-Za-z][^,]*(?:,\s*\d+ [^,]+)+/);
    if (m) {
        const parts = m[0].slice(m[1]!.length).split(',').map(p => p.trim().match(/^(\d+) (.+?)(?: t=\d+)?$/));
        const n = parts.reduce((k, p) => k + Number(p?.[1] ?? 0), 0);
        const fish = parts.every(p => p && /^(trout|salmon|lobster|tuna|swordfish|shark)$/i.test(p[2]!));
        res = `${m[1]} ${n} ${fish ? 'fish' : 'items'}`;
    } else if (/^t=\d+ \w+=/.test(ph)) {
        // A key=value progress line ("t=2000 banked=28850 packCoins=5100 ... food=10"): the two numbers a viewer wants.
        const kv = Object.fromEntries([...ph.matchAll(/(\w+)=(-?\d+)/g)].map(x => [x[1], Number(x[2])]));
        const k = (v: number) => v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e4 ? (v / 1e3).toFixed(1) + 'K' : String(v);
        const out = [kv.banked != null ? `banked ${k(kv.banked)}` : '', kv.food != null ? `food ${kv.food}` : '', kv.picks != null ? `${k(kv.picks)} picks` : ''].filter(Boolean);
        if (out.length) res = out.join(' · ');
    } else {
        // A courier leg milestone ("received129 708", "sarim 204"): drop the run tick.
        const leg = ph.match(/^([a-z]+?)(\d*) \d+$/);
        if (leg) res = leg[2] ? `${leg[1]} ${leg[2]}` : leg[1]!;
    }
    if (shortPhaseCache.size >= 2048) shortPhaseCache.clear();
    shortPhaseCache.set(ph, res);
    return res;
}
