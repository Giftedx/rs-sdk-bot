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
        const h = parseHunter(n, block.join('\n'));
        if (h) hunters.push(h);
    }
    return hunters;
}

export const hunts = (h: Hunter, combat: number) => HUNTS_ALL.has(h.mode) || combat <= 2 * h.combat;
// A hunter is a danger when it hunts the account and is strong enough to kill it: its combat level is above
// the account's combat level and at least 1.5 times the account's hitpoints. Rats and muggers stay walkable.
export const deadly = (h: Hunter, combat: number, hitpoints: number) => hunts(h, combat) && h.combat > combat && h.combat >= 1.5 * hitpoints;

// Danger tiles (deadly hunters) for this account inside a box, one margin tile past each monster's reach.
export function dangerTiles(acct: Account, level: number, box: { minX: number; maxX: number; minZ: number; maxZ: number }, list = loadHunters()): Tile[] {
    const combat = combatLevel(acct.skills), hp = acct.skills.hitpoints ?? 10, out = new Map<string, Tile>();
    for (const h of list) {
        if (!deadly(h, combat, hp)) continue;
        const r = h.reach + 1;
        for (const s of h.spawns) {
            if (s.level !== level || s.x + r < box.minX || s.x - r > box.maxX || s.z + r < box.minZ || s.z - r > box.maxZ) continue;
            for (let x = s.x - r; x <= s.x + r; x++) for (let z = s.z - r; z <= s.z + r; z++) out.set(`${x},${z}`, { x, z, level });
        }
    }
    return [...out.values()];
}

type FloorGrid = { isFlagged(x: number, z: number, level: number, mask: number): boolean; changeFloor(x: number, z: number, level: number, add: boolean): void };
const FLOOR = 2097152; // CollisionFlag.FLOOR
// Runs a synchronous path query with the danger tiles blocked, then opens exactly the tiles it blocked.
// The start and end tiles stay open, so a walk that starts or ends inside an area can still leave or arrive.
export function withDanger<T>(grid: FloorGrid, tiles: readonly Tile[], keep: readonly Tile[], query: () => T): T {
    const kept = new Set(keep.map(t => `${t.level},${t.x},${t.z}`)), added: Tile[] = [];
    try {
        for (const t of tiles) if (!kept.has(`${t.level},${t.x},${t.z}`) && !grid.isFlagged(t.x, t.z, t.level, FLOOR)) { grid.changeFloor(t.x, t.z, t.level, true); added.push(t); }
        const result = query();
        if (result && typeof (result as any).then === 'function') throw Error('Danger queries must be synchronous');
        return result;
    } finally {
        for (const t of added) grid.changeFloor(t.x, t.z, t.level, false);
    }
}

// The danger tiles for a walk from `from` to `to` on one level: the box around both ends plus `pad` tiles.
export function guardWalk<T>(grid: FloorGrid, acct: Account, from: Tile, to: Tile, pad: number, query: () => T): T {
    const box = { minX: Math.min(from.x, to.x) - pad, maxX: Math.max(from.x, to.x) + pad, minZ: Math.min(from.z, to.z) - pad, maxZ: Math.max(from.z, to.z) + pad };
    return withDanger(grid, from.level === to.level ? dangerTiles(acct, from.level, box) : [], [from, to], query);
}
