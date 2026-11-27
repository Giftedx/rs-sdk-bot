// Danger tile region generation and route/walk collision guarding.
import type { Account, Tile } from '../world-types';
import { npcAttackStyles } from '../../../knowledge/src/npc-attack-styles';
import { combatLevel, loadHunters, type Hunter } from './catalog';
import { npcReach, routeHarmKeep, routeHarmSet, type WalkThreat } from './exposure';
import { PROTECT_MELEE_LEVEL, isDeadlyWithCombat, meleeOnly } from './threat';
import { activeDanger, pack, unpack, withDanger, type FloorGrid } from './tiles';

// A square at least this wide (reach + 1) closes only the tiles its monster can walk to or hit (exposure.ts npcReach):
// the King black dragon (wanderrange 30, huntrange 20) at 2716,9817 has a square of 51 tiles each way, which covers the
// Temple of Ikov dungeon on the other side of the lair walls and closed the only way out of the pocket below the Ikov
// dark stairs (packages/core/test/world.data.test.ts). A narrower square closes all its tiles: its floods would cost
// more than they open.
export const WIDE_DANGER_SQUARE = 10, DISTANT_HIT_RANGE = 10;
type SpawnReach = (h: Hunter, s: Tile, x: number, z: number) => boolean;
let doorAt: ((level: number, x: number, z: number) => { angle: number; shape: number; blockrange?: boolean } | undefined) | undefined;
// The door shapes for the floods (rs-sdk pathfinding getDoorAt): world/pathfinding.ts registers them when it loads.
export const setDangerDoorAt = (f: NonNullable<typeof doorAt>) => { doorAt = f; };
const spawnThreats = new Map<string, WalkThreat>();
// The flood of a wide square on `grid`, or null (every tile counts) when the grid cannot flood or a danger scope is
// active (its closed floor would cut the flood short).
function spawnReach(grid: FloorGrid | undefined): SpawnReach | null {
    if (!grid || typeof (grid as { canTravel?: unknown }).canTravel !== 'function' || activeDanger()) return null;
    const reach = npcReach(grid as Parameters<typeof npcReach>[0], (l, x, z) => doorAt?.(l, x, z));
    return (h, s, x, z) => {
        if (h.reach + 1 < WIDE_DANGER_SQUARE) return true;
        const key = `${h.id ?? h.name}|${s.level},${s.x},${s.z}`;
        let t = spawnThreats.get(key);
        // A monster that attacks from a distance hits up to DISTANT_HIT_RANGE tiles past where it walks.
        if (!t) spawnThreats.set(key, t = { id: h.id ?? -1, name: h.name, x: s.x, z: s.z, level: s.level, r: h.reach + 1, vislevel: h.combat, tooStrong: h.tooStrong ?? true, distant: false, hitRange: meleeOnly(h) ? 1 : DISTANT_HIT_RANGE, maxHit: 0, attackRoll: 0, attackRate: 4 });
        return reach(t, x, z);
    };
}

// Danger tiles (deadly hunters) for this account inside a box, one margin tile past each monster's reach, packed.
// With `grid` a wide square keeps only the tiles its monster reaches (spawnReach).
export function dangerSet(acct: Account, level: number, box: { minX: number; maxX: number; minZ: number; maxZ: number }, list = loadHunters(), grid?: FloorGrid): Int32Array {
    const styles = npcAttackStyles(), out = new Set<number>(), reach = spawnReach(grid);
    const combat = combatLevel(acct.skills), hitpoints = acct.skills.hitpoints ?? 10;
    const prayerProtected = (acct.skills.prayer ?? 1) >= PROTECT_MELEE_LEVEL && process.env.PRAYER_GUARD !== '0';
    for (const h of list) {
        if (!isDeadlyWithCombat(h, combat, hitpoints, prayerProtected, styles)) continue;
        const r = h.reach + 1;
        for (const s of h.spawns) {
            if (s.level !== level || s.x + r < box.minX || s.x - r > box.maxX || s.z + r < box.minZ || s.z - r > box.maxZ) continue;
            for (let x = Math.max(0, s.x - r); x <= s.x + r; x++) for (let z = Math.max(0, s.z - r); z <= s.z + r; z++) if (!reach || reach(h, s, x, z)) out.add(pack(level, x, z));
        }
    }
    return Int32Array.from(out);
}
export const dangerTiles = (acct: Account, level: number, box: { minX: number; maxX: number; minZ: number; maxZ: number }, list = loadHunters()): Tile[] =>
    Array.from(dangerSet(acct, level, box, list), unpack);

// Names the account's deadly hunters; accounts with the same key get the same closed tiles.
function dangerKey(acct: Account, list = loadHunters()): string {
    const styles = npcAttackStyles();
    const combat = combatLevel(acct.skills), hitpoints = acct.skills.hitpoints ?? 10;
    const prayerProtected = (acct.skills.prayer ?? 1) >= PROTECT_MELEE_LEVEL && process.env.PRAYER_GUARD !== '0';
    const indices: number[] = [];
    for (let i = 0; i < list.length; i++) if (isDeadlyWithCombat(list[i]!, combat, hitpoints, prayerProtected, styles)) indices.push(i);
    return indices.length ? indices.join('.') : 'none';
}

// The deadly ground around `at`: every danger square that holds it. An account that already stands there may walk
// out through it (a hunter spawn inside Catherby otherwise closes every walk from the beach).
export function escapeTiles(acct: Account, at: Tile, list = loadHunters()): Tile[] {
    const styles = npcAttackStyles(), out = new Map<number, Tile>();
    const combat = combatLevel(acct.skills), hitpoints = acct.skills.hitpoints ?? 10;
    const prayerProtected = (acct.skills.prayer ?? 1) >= PROTECT_MELEE_LEVEL && process.env.PRAYER_GUARD !== '0';
    for (const h of list) {
        if (!isDeadlyWithCombat(h, combat, hitpoints, prayerProtected, styles)) continue;
        const r = h.reach + 1;
        for (const s of h.spawns) {
            if (s.level !== at.level || Math.abs(s.x - at.x) > r || Math.abs(s.z - at.z) > r) continue;
            for (let x = s.x - r; x <= s.x + r; x++) for (let z = s.z - r; z <= s.z + r; z++) {
                const k = pack(at.level, x, z);
                if (!out.has(k)) out.set(k, { x, z, level: at.level });
            }
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
    if (!tiles) { const parts = [0, 1, 2, 3].map(l => dangerSet(acct, l, WORLD, undefined, grid)), all = new Int32Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { all.set(p, at); at += p.length; } routeTiles.set(key, tiles = all); }
    // The start (keep[0]) may leave the zone it stands in. Those legs get their own cache key.
    const start = keep[0], out = start ? escapeTiles(acct, start) : [];
    const deadlyKey = out.length ? `${key}|from:${start!.level},${start!.x},${start!.z}` : key;
    if (!acct.avoidHarm) return withDanger(grid, tiles, [...keep, ...out], query, deadlyKey);
    // A route search for an account that avoids harm (walk/goto.ts, a walk whose verdict is not clear) also closes the
    // square of each hunter of its combat level (exposure.ts routeHarmSet); the squares of its start and goal stay open.
    // The harm scope is the inner one: the route labels and scope keys (world/pathfinding.ts) read the inner key.
    const combat = combatLevel(acct.skills), harm = routeHarmKeep(combat, keep);
    return withDanger(grid, tiles, [...keep, ...out], () => withDanger(grid, routeHarmSet(combat), [...keep, ...out, ...harm.tiles], query, `${deadlyKey}|harm:${combat}|${harm.key}`), deadlyKey);
}

// The danger tiles for a walk from `from` to `to` on one level: the box around both ends plus `pad` tiles.
export function guardWalk<T>(grid: FloorGrid, acct: Account, from: Tile, to: Tile, pad: number, query: () => T): T {
    const box = { minX: Math.min(from.x, to.x) - pad, maxX: Math.max(from.x, to.x) + pad, minZ: Math.min(from.z, to.z) - pad, maxZ: Math.max(from.z, to.z) + pad };
    return withDanger(grid, from.level === to.level ? dangerSet(acct, from.level, box, undefined, grid) : [], [from, to, ...escapeTiles(acct, from)], query);
}
