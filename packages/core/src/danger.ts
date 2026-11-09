// Tiles a walk must not cross because a monster there hunts the account. The game rule
// (content/scripts/_unpack/225/all.hunt): `cowardly` and `ranged` hunt a player whose combat level is at most
// twice the monster's (check_nottoostrong); `aggressive_melee` hunts any player. A monster hunts inside its
// wanderrange (default 5) plus huntrange (default 0) of its spawn. White wolves (combat 25, cowardly) on White
// Wolf Mountain kill an 11 HP account on the Catherby-Taverley path.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Account, Tile } from './world';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const HUNTS_WEAKER = new Set(['cowardly', 'ranged']), HUNTS_ALL = new Set(['aggressive_melee']);
export type Hunter = { name: string; combat: number; mode: string; reach: number; spawns: Tile[] };

export function combatLevel(skills: Record<string, number>): number {
    const s = (k: string, d = 1) => skills[k] ?? d;
    const base = (s('defence') + s('hitpoints', 10) + Math.floor(s('prayer') / 2)) / 4;
    const melee = (s('attack') + s('strength')) * 0.325, range = Math.floor(s('ranged') * 1.5) * 0.325, mage = Math.floor(s('magic') * 1.5) * 0.325;
    return Math.floor(base + Math.max(melee, range, mage));
}

// Reads hunt mode and ranges from each npc's own config block (npcs.json `src` is file:line).
export function parseHunter(npc: { name: string; combat: number; spawns?: Tile[] }, block: string): Hunter | null {
    const field = (k: string) => block.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim();
    const mode = field('huntmode');
    if (!mode || !(HUNTS_WEAKER.has(mode) || HUNTS_ALL.has(mode)) || !npc.spawns?.length) return null;
    const reach = Number(field('wanderrange') ?? 5) + Number(field('huntrange') ?? 0);
    return { name: npc.name, combat: npc.combat, mode, reach, spawns: npc.spawns };
}

// Spawns the map walls in: the monster hunts, but no player tile is in its reach. The Wizards' Tower lesser demon
// (combat 82) stands in a cage on the top floor; counted, it closed the whole floor, with Mizgog's room and the
// Imp Catcher start, to a 37 HP account (TheFullMonty: `no route to 3104,3163,2`).
export const CAGED: readonly Tile[] = [{ x: 3110, z: 3157, level: 2 }];
const caged = (s: Tile) => CAGED.some(c => c.x === s.x && c.z === s.z && c.level === s.level);

let hunters: Hunter[] | undefined;
export function loadHunters(): Hunter[] {
    if (hunters) return hunters;
    const npcs = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'npcs.json'), 'utf8')) as { name: string; combat: number; src: string; spawns?: Tile[] }[];
    const files = new Map<string, string[]>();
    hunters = [];
    for (const n of npcs) {
        const m = n.src?.match(/^(.*):(\d+)$/);
        if (!m || !n.spawns?.length) continue;
        let lines = files.get(m[1]!);
        if (!lines) { try { lines = readFileSync(join(repoRoot, 'vendor', 'rs-sdk', 'server', 'content', m[1]!), 'utf8').split(/\r?\n/); } catch { lines = []; } files.set(m[1]!, lines); }
        const start = Number(m[2]) - 1, block: string[] = [];
        for (let i = start + 1; i < lines.length && !lines[i]!.startsWith('['); i++) block.push(lines[i]!);
        const h = parseHunter({ ...n, spawns: n.spawns.filter(s => !caged(s)) }, block.join('\n'));
        if (h) hunters.push(h);
    }
    return hunters;
}

export const hunts = (h: Hunter, combat: number) => HUNTS_ALL.has(h.mode) || combat <= 2 * h.combat;
// A hunter is a danger when it hunts the account and is strong enough to kill it: its combat level is above
// the account's combat level and at least 1.5 times the account's hitpoints. Rats and muggers stay walkable.
export const deadly = (h: Hunter, combat: number, hitpoints: number) => hunts(h, combat) && h.combat > combat && h.combat >= 1.5 * hitpoints;

// A tile packed into one number (level in bits 28-29, x in 14-27, z in 0-13). The whole-world danger set holds
// about 390,000 tiles for a weak account; as {x,z,level} objects with string keys it cost 320 MB per process.
export const pack = (level: number, x: number, z: number) => (level << 28) | (x << 14) | z;
export const unpack = (k: number): Tile => ({ x: (k >>> 14) & 0x3fff, z: k & 0x3fff, level: k >>> 28 });

// Danger tiles (deadly hunters) for this account inside a box, one margin tile past each monster's reach, packed.
export function dangerSet(acct: Account, level: number, box: { minX: number; maxX: number; minZ: number; maxZ: number }, list = loadHunters()): Int32Array {
    const combat = combatLevel(acct.skills), hp = acct.skills.hitpoints ?? 10, out = new Set<number>();
    for (const h of list) {
        if (!deadly(h, combat, hp)) continue;
        const r = h.reach + 1;
        for (const s of h.spawns) {
            if (s.level !== level || s.x + r < box.minX || s.x - r > box.maxX || s.z + r < box.minZ || s.z - r > box.maxZ) continue;
            for (let x = Math.max(0, s.x - r); x <= s.x + r; x++) for (let z = Math.max(0, s.z - r); z <= s.z + r; z++) out.add(pack(level, x, z));
        }
    }
    return Int32Array.from(out);
}
export const dangerTiles = (acct: Account, level: number, box: { minX: number; maxX: number; minZ: number; maxZ: number }, list = loadHunters()): Tile[] =>
    Array.from(dangerSet(acct, level, box, list), unpack);

type FloorGrid = { isFlagged(x: number, z: number, level: number, mask: number): boolean; changeFloor(x: number, z: number, level: number, add: boolean): void };
const FLOOR = 2097152; // CollisionFlag.FLOOR
// Runs a synchronous path query with the danger tiles blocked, then opens exactly the tiles it blocked.
// The start and end tiles stay open, so a walk that starts or ends inside an area can still leave or arrive.
let active: { key: string; kept: ReadonlySet<string> } | null = null;
// The danger scope a path query runs in: `key` names the closed set, `kept` the tiles left open (level,x,z).
export const activeDanger = () => active;
export function withDanger<T>(grid: FloorGrid, tiles: readonly Tile[] | Int32Array, keep: readonly Tile[], query: () => T, key = '?'): T {
    const kept = new Set(keep.map(t => `${t.level},${t.x},${t.z}`)), open = new Set(keep.map(t => pack(t.level, t.x, t.z))), outer = active;
    const packed = tiles instanceof Int32Array ? tiles : Int32Array.from(tiles, t => pack(t.level, t.x, t.z));
    const added = new Int32Array(packed.length);
    let n = 0;
    active = { key, kept };
    try {
        for (const k of packed) {
            const x = (k >>> 14) & 0x3fff, z = k & 0x3fff, level = k >>> 28;
            if (!open.has(k) && !grid.isFlagged(x, z, level, FLOOR)) { grid.changeFloor(x, z, level, true); added[n++] = k; }
        }
        const result = query();
        if (result && typeof (result as any).then === 'function') throw Error('Danger queries must be synchronous');
        return result;
    } finally {
        for (let i = 0; i < n; i++) { const k = added[i]!; grid.changeFloor((k >>> 14) & 0x3fff, k & 0x3fff, k >>> 28, false); }
        active = outer;
    }
}

// Names the account's deadly hunters; accounts with the same key get the same closed tiles.
export function dangerKey(acct: Account, list = loadHunters()): string {
    const combat = combatLevel(acct.skills), hp = acct.skills.hitpoints ?? 10;
    return list.flatMap((h, i) => deadly(h, combat, hp) ? [i] : []).join('.') || 'none';
}

// The deadly ground around `at`: every danger square that holds it. An account that already stands there may walk
// out through it (a hunter spawn inside Catherby otherwise closes every walk from the beach).
export function escapeTiles(acct: Account, at: Tile, list = loadHunters()): Tile[] {
    const combat = combatLevel(acct.skills), hp = acct.skills.hitpoints ?? 10, out = new Map<string, Tile>();
    for (const h of list) {
        if (!deadly(h, combat, hp)) continue;
        const r = h.reach + 1;
        for (const s of h.spawns) {
            if (s.level !== at.level || Math.abs(s.x - at.x) > r || Math.abs(s.z - at.z) > r) continue;
            for (let x = s.x - r; x <= s.x + r; x++) for (let z = s.z - r; z <= s.z + r; z++) out.set(`${x},${z}`, { x, z, level: at.level });
        }
    }
    return [...out.values()];
}

const WORLD = { minX: 0, maxX: 16383, minZ: 0, maxZ: 16383 };
const routeTiles = new Map<string, Int32Array>();
// Closes the account's deadly ground on every level for a whole route search. The tile set does not depend
// on the route, so measured legs stay valid for every route with the same key.
export function guardRoute<T>(grid: FloorGrid, acct: Account, keep: readonly Tile[], query: () => T): T {
    const key = dangerKey(acct);
    let tiles = routeTiles.get(key);
    if (!tiles) { const parts = [0, 1, 2, 3].map(l => dangerSet(acct, l, WORLD)), all = new Int32Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { all.set(p, at); at += p.length; } routeTiles.set(key, tiles = all); }
    // The start (keep[0]) may leave the zone it stands in. Those legs get their own cache key.
    const start = keep[0], out = start ? escapeTiles(acct, start) : [];
    return withDanger(grid, tiles, [...keep, ...out], query, out.length ? `${key}|from:${start!.level},${start!.x},${start!.z}` : key);
}

// The danger tiles for a walk from `from` to `to` on one level: the box around both ends plus `pad` tiles.
export function guardWalk<T>(grid: FloorGrid, acct: Account, from: Tile, to: Tile, pad: number, query: () => T): T {
    const box = { minX: Math.min(from.x, to.x) - pad, maxX: Math.max(from.x, to.x) + pad, minZ: Math.min(from.z, to.z) - pad, maxZ: Math.max(from.z, to.z) + pad };
    return withDanger(grid, from.level === to.level ? dangerSet(acct, from.level, box) : [], [from, to, ...escapeTiles(acct, from)], query);
}
