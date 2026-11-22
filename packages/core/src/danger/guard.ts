// Danger tile region generation and route/walk collision guarding.
import type { Account, Tile } from '../world-types';
import { npcAttackStyles } from '../../../knowledge/src/npc-attack-styles';
import { loadHunters } from './catalog';
import { deadlyTo } from './threat';
import { pack, unpack, withDanger, type FloorGrid } from './tiles';

// Danger tiles (deadly hunters) for this account inside a box, one margin tile past each monster's reach, packed.
export function dangerSet(acct: Account, level: number, box: { minX: number; maxX: number; minZ: number; maxZ: number }, list = loadHunters()): Int32Array {
    const styles = npcAttackStyles(), out = new Set<number>();
    for (const h of list) {
        if (!deadlyTo(h, acct.skills, styles)) continue;
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

// Names the account's deadly hunters; accounts with the same key get the same closed tiles.
function dangerKey(acct: Account, list = loadHunters()): string {
    const styles = npcAttackStyles();
    return list.flatMap((h, i) => deadlyTo(h, acct.skills, styles) ? [i] : []).join('.') || 'none';
}

// The deadly ground around `at`: every danger square that holds it. An account that already stands there may walk
// out through it (a hunter spawn inside Catherby otherwise closes every walk from the beach).
export function escapeTiles(acct: Account, at: Tile, list = loadHunters()): Tile[] {
    const styles = npcAttackStyles(), out = new Map<string, Tile>();
    for (const h of list) {
        if (!deadlyTo(h, acct.skills, styles)) continue;
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
