// Walk exposure: the damage that hunting NPCs along a walk path can do to one account, the walk verdict, and the
// harm ground that a walk plans round.
//
// The deadly rule (threat.ts deadly) closes ground only where one hunter outclasses the account (combat above the
// account and at least 1.5 x its Hitpoints), and the catalog (catalog.ts) holds only three hunt modes. A hunter under
// that line still hits, and several of them add up, most in a multi-combat area. White Wolf Mountain (multi-combat)
// holds wolves (vislevel 25), ice warriors (57) and a big wolf (73): none is deadly to a combat-50, 67 HP account, so
// the deadly rule closes no tile there (live: Spitroaster, no food, attacked by four of them on the pass).
// This file prices the path instead, from the damage facts of each NPC (knowledge npc-threat.ts), its hunt rule
// (knowledge npc-hunters.ts) and the multi-combat map (content maps/multiway.csv).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { npcHunters } from '../../../knowledge/src/npc-hunters';
import { npcThreats } from '../../../knowledge/src/npc-threat';
import { contentRoot } from '../../../knowledge/src/paths';
import { npcHitChance, retreatLine } from '../combat-admission';
import { withDoorPolicy } from '../door-policy';
import { allFoodIds, foodTotalHeal, objIdByDebugName } from '../sustain';
import type { Account, Tile } from '../world-types';
import { CAGED, combatLevel } from './catalog';
import { activeDanger, pack, withDanger, type FloorGrid } from './tiles';

const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..');

// One spawn of an NPC that attacks a player first and can damage it.
// `r`: the square round the spawn in which it can hunt the player: wanderrange (where it stands) + huntrange (how far
// it looks) + 1 margin tile, as dangerSet counts it. `vislevel`: the NPC's visible combat level. `tooStrong`: the NPC
// skips a player outside the Wilderness whose combat level is above 2 x vislevel (engine Npc.ts huntPlayers,
// HuntCheckNotTooStrong.OUTSIDE_WILDERNESS). `distant`: it attacks with ranged or magic, so a wall between does not
// keep its hits off (npcReach counts the whole square). `hitRange`: the tiles past its walk tiles that npcReach counts
// (default 1, a melee attack from an adjacent tile).
export type WalkThreat = {
    readonly id: number; readonly name: string; readonly x: number; readonly z: number; readonly level: number;
    readonly r: number; readonly vislevel: number; readonly tooStrong: boolean; readonly distant: boolean; readonly hitRange?: number;
    readonly maxHit: number; readonly attackRoll: number; readonly attackRate: number;
};

type NpcRow = { id?: number; name: string; combat: number; spawns?: Tile[] };
let threats: WalkThreat[] | undefined;
const BUCKET = 64;
let buckets: Map<number, WalkThreat[]> | undefined, widest = 0;
const bucketKey = (level: number, bx: number, bz: number) => (level << 24) | (bx << 12) | bz;

export function walkThreats(): readonly WalkThreat[] {
    if (threats) return threats;
    const npcs = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'npcs.json'), 'utf8')) as NpcRow[];
    const hunters = npcHunters(), facts = npcThreats();
    const out: WalkThreat[] = [];
    for (const n of npcs) {
        if (n.id === undefined || !n.spawns?.length) continue;
        const h = hunters.get(n.id), t = facts.get(n.id);
        if (!h || !t || t.maxHit <= 0) continue;
        const r = Math.max(0, h.wander) + h.range + 1, distant = t.rangedMaxHit > 0 || t.magicMaxHit > 0;
        for (const s of n.spawns) {
            if (CAGED.some(c => c.x === s.x && c.z === s.z && c.level === s.level)) continue;
            out.push({ id: n.id, name: n.name, x: s.x, z: s.z, level: s.level, r, vislevel: h.level, tooStrong: h.tooStrong, distant, maxHit: t.maxHit, attackRoll: t.attackRoll, attackRate: Math.max(1, t.attackRate) });
        }
    }
    return threats = out;
}

function index(list: readonly WalkThreat[]): Map<number, WalkThreat[]> {
    if (list === threats && buckets) return buckets;
    const map = new Map<number, WalkThreat[]>();
    let wide = 0;
    for (const t of list) {
        const k = bucketKey(t.level, Math.floor(t.x / BUCKET), Math.floor(t.z / BUCKET));
        (map.get(k) ?? map.set(k, []).get(k)!).push(t);
        wide = Math.max(wide, t.r);
    }
    if (list === threats) { buckets = map; widest = wide; }
    else widest = Math.max(widest, wide);
    return map;
}

// The threats whose square can touch the box.
function threatsIn(level: number, box: { minX: number; maxX: number; minZ: number; maxZ: number }, list: readonly WalkThreat[]): WalkThreat[] {
    const map = index(list), pad = widest, out: WalkThreat[] = [];
    for (let bx = Math.floor((box.minX - pad) / BUCKET); bx <= Math.floor((box.maxX + pad) / BUCKET); bx++)
        for (let bz = Math.floor((box.minZ - pad) / BUCKET); bz <= Math.floor((box.maxZ + pad) / BUCKET); bz++)
            for (const t of map.get(bucketKey(level, bx, bz)) ?? [])
                if (t.x + t.r >= box.minX && t.x - t.r <= box.maxX && t.z + t.r >= box.minZ && t.z - t.r <= box.maxZ) out.push(t);
    return out;
}

// Which tiles of its square a threat can attack. Without a reach every tile of the square counts.
export type NpcReach = (t: WalkThreat, x: number, z: number) => boolean;
type ReachGrid = FloorGrid & {
    canTravel(level: number, x: number, z: number, dx: number, dz: number, size: number, extraFlag: number, collision: number): boolean;
    changeWall?(x: number, z: number, level: number, angle: number, shape: number, blockrange: boolean, breakroutefinding: boolean, add: boolean): void;
    __set?(x: number, z: number, level: number, mask: number): void;
    CollisionType: { NORMAL: number };
};
type DoorRow = { x: number; z: number; level: number; kind: string; angle?: number; shape?: number };
let shutDoors: Map<number, DoorRow[]> | undefined;
// Doors an NPC does not pass: every closed door of doors.json. An NPC opens no door, and the rs-sdk grid opens every
// door for the walker (sdk/pathfinding.ts initPathfinding). Bucketed like the threats.
function doorsNear(level: number, x: number, z: number, r: number): DoorRow[] {
    if (!shutDoors) {
        shutDoors = new Map();
        for (const d of JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'doors.json'), 'utf8')) as DoorRow[]) {
            const k = bucketKey(d.level, Math.floor(d.x / BUCKET), Math.floor(d.z / BUCKET));
            (shutDoors.get(k) ?? shutDoors.set(k, []).get(k)!).push(d);
        }
    }
    const out: DoorRow[] = [];
    for (let bx = Math.floor((x - r) / BUCKET); bx <= Math.floor((x + r) / BUCKET); bx++)
        for (let bz = Math.floor((z - r) / BUCKET); bz <= Math.floor((z + r) / BUCKET); bz++)
            for (const d of shutDoors.get(bucketKey(level, bx, bz)) ?? []) if (Math.abs(d.x - x) <= r && Math.abs(d.z - z) <= r) out.push(d);
    return out;
}

// The multi-combat zones (8 x 8 tiles each), from the content multiway map that the engine reads (GameMap.ts
// loadCsvMap: lines `level_mx_mz_lx_lz`). In a multi-combat zone every hunter in reach attacks at once.
let multi: Set<number> | undefined;
const zoneKey = (level: number, x: number, z: number) => (level << 22) | ((x >> 3) << 11) | (z >> 3);
export function isMulti(level: number, x: number, z: number): boolean {
    if (!multi) {
        multi = new Set();
        let text = '';
        try { text = readFileSync(join(contentRoot(), 'maps', 'multiway.csv'), 'ascii'); } catch { /* no content: every zone is single-combat */ }
        for (const line of text.split(/\r?\n/)) {
            if (!line || line.startsWith('//')) continue;
            const [y, mx, mz, lx, lz] = line.split('_').map(Number);
            if ([y, mx, mz, lx, lz].every(Number.isInteger)) multi.add(zoneKey(y!, (mx! << 6) + lx!, (mz! << 6) + lz!));
        }
    }
    return multi.has(zoneKey(level, x, z));
}
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
const reachCache = new Map<WalkThreat, Uint8Array>();
// The tiles an NPC can walk to from its spawn inside its square (doors shut), and the tiles next to them: a melee
// attack lands from an adjacent tile. Walls, fences and the Draynor jail doors keep a hunter's hits off a road that its
// square covers. `doorAt` resolves a door's wall shape (rs-sdk pathfinding getDoorAt). The flood runs on the
// plain grid only: under a danger scope (tiles.ts activeDanger) the closed floor would cut it short, so it is not kept.
export function npcReach(grid: ReachGrid, doorAt: (level: number, x: number, z: number) => { angle: number; shape: number; blockrange?: boolean } | undefined, active: () => unknown = activeDanger): NpcReach {
    const flood = (t: WalkThreat): Uint8Array => {
        const side = 2 * t.r + 1, walk = new Uint8Array(side * side), out = new Uint8Array(side * side);
        const at = (x: number, z: number) => (x - t.x + t.r) * side + (z - t.z + t.r);
        const run = () => {
            const qx: number[] = [t.x], qz: number[] = [t.z];
            walk[at(t.x, t.z)] = 1;
            for (let i = 0; i < qx.length; i++) {
                const x = qx[i]!, z = qz[i]!;
                for (const [dx, dz] of DIRS) {
                    const nx = x + dx, nz = z + dz;
                    if (Math.abs(nx - t.x) > t.r || Math.abs(nz - t.z) > t.r || walk[at(nx, nz)]) continue;
                    if (!grid.canTravel(t.level, x, z, dx, dz, 1, 0, grid.CollisionType.NORMAL)) continue;
                    walk[at(nx, nz)] = 1; qx.push(nx); qz.push(nz);
                }
            }
        };
        const doors = doorsNear(t.level, t.x, t.z, t.r + 1).flatMap(d => {
            const w = Number.isInteger(d.angle) && Number.isInteger(d.shape) ? { angle: d.angle!, shape: d.shape! } : doorAt(d.level, d.x, d.z);
            return w ? [{ x: d.x, z: d.z, level: d.level, angle: w.angle, shape: w.shape, blockrange: !!(w as { blockrange?: boolean }).blockrange }] : [];
        });
        if (doors.length && grid.changeWall && grid.__set) withDoorPolicy(grid as Parameters<typeof withDoorPolicy>[0], doors, run); else run();
        const hit = Math.max(1, t.hitRange ?? 1);
        for (let x = -t.r; x <= t.r; x++) for (let z = -t.r; z <= t.r; z++) {
            if (!walk[(x + t.r) * side + (z + t.r)]) continue;
            for (let ax = Math.max(-t.r, x - hit); ax <= Math.min(t.r, x + hit); ax++) for (let az = Math.max(-t.r, z - hit); az <= Math.min(t.r, z + hit); az++) out[(ax + t.r) * side + (az + t.r)] = 1;
        }
        return out;
    };
    return (t, x, z) => {
        if (Math.abs(x - t.x) > t.r || Math.abs(z - t.z) > t.r) return false;
        if (t.distant) return true;
        let bits = reachCache.get(t);
        if (!bits) { bits = flood(t); if (!active()) reachCache.set(t, bits); }
        return bits[(x - t.x + t.r) * (2 * t.r + 1) + (z - t.z + t.r)] === 1;
    };
}

// Whether a hunter of this combat level has its square in the box: a cheap test before a path is planned and priced.
export function huntersNear(combat: number, level: number, box: { minX: number; maxX: number; minZ: number; maxZ: number }, list: readonly WalkThreat[] = walkThreats()): boolean {
    return threatsIn(level, box, list).some(t => huntsAt(t, combat, t.x, t.z));
}

// Engine Player.isInWilderness.
export const inWilderness = (x: number, z: number) => x >= 2944 && x < 3392 && ((z >= 3520 && z < 6400) || (z >= 9920 && z < 12800));
export const huntsAt = (t: WalkThreat, combat: number, x: number, z: number) => !t.tooStrong || inWilderness(x, z) || combat <= 2 * t.vislevel;

// What the walk check reads from an account: combat level, Hitpoints now, Defence, the heal of the food in the pack,
// and `runTiles`, the path tiles its run energy covers (0 when not known: the account walks).
// `maxHp`: the base Hitpoints (absent: `hp`).
export type WalkProfile = { readonly combat: number; readonly hp: number; readonly maxHp?: number; readonly defence: number; readonly defenceBonus?: number; readonly foodHeal: number; readonly runTiles: number };

// The heal of one piece of a food that the HP floor eats (hp-floor.ts eats sustain.ts allFoodIds), over all its bites;
// undefined for any other item. Food the floor does not eat does not count for a walk.
export function foodHealOf(name: string): number | undefined {
    const id = objIdByDebugName(name);
    return id !== undefined && allFoodIds().has(id) ? foodTotalHeal(id) : undefined;
}
export function packFoodHeal(counts: Readonly<Record<string, number>> | undefined): number {
    let heal = 0;
    for (const [name, n] of Object.entries(counts ?? {})) { const h = n > 0 ? foodHealOf(name) : undefined; if (h) heal += h * n; }
    return heal;
}

// Path tiles that run energy (SDK player.runEnergy, 0-100) covers: a running tick (2 tiles) costs
// 67 + 67 x kg / 64 of 10000 energy units (engine Player.ts updateEnergy, weight clamped to 0-64 kg).
export function runTiles(energy: number | undefined, weightKg = 0): number {
    if (!(typeof energy === 'number' && energy > 0)) return 0;
    const loss = Math.trunc(67 + (67 * Math.min(Math.max(weightKg, 0), 64)) / 64);
    return 2 * Math.floor((energy * 100) / loss);
}

export function walkProfile(acct: Pick<Account, 'skills' | 'counts'>, run?: { energy?: number; weightKg?: number; maxHp?: number }): WalkProfile {
    return { combat: combatLevel(acct.skills), hp: acct.skills.hitpoints ?? 10, ...(run?.maxHp ? { maxHp: run.maxHp } : {}), defence: acct.skills.defence ?? 1, foodHeal: packFoodHeal(acct.counts), runTiles: runTiles(run?.energy, run?.weightKg) };
}
// The profile of the player in an SDK state: run energy, weight (grams) and maximum Hitpoints from the player record.
export const stateWalkProfile = (acct: Pick<Account, 'skills' | 'counts'>, player: { runEnergy?: number; runWeight?: number; maxHp?: number } | null | undefined): WalkProfile =>
    walkProfile(acct, { energy: player?.runEnergy, weightKg: (player?.runWeight ?? 0) / 1000, ...(player?.maxHp ? { maxHp: player.maxHp } : {}) });

// Ticks a path tile costs: 0.5 while the run energy lasts (2 tiles a tick), then 1. A hunter walks 1 tile a tick, so
// it falls behind a running player; the time in its square still counts.
export const RUN_TICKS_PER_TILE = 0.5, WALK_TICKS_PER_TILE = 1;
// Expected damage is multiplied by this factor before it is compared with the Hitpoints (combat-admission.ts uses the same).
export const WALK_SAFETY = 1.25;
// The cost of a way round harm ground. An open walk whose verdict is not clear may take a way round up to the full
// bound: open length x 1.5 + 20 tiles (detourBound), or open cost x 2 + 60 for a route (routeDetourBound). A clear
// walk pays TILES_PER_HP extra tiles for each Hitpoint of expected damage it saves: a combat-126, 99 HP account keeps
// the pass over White Wolf Mountain (12 expected damage) instead of a 104-tile way round.
export const detourBound = (openTiles: number) => Math.ceil(openTiles * 1.5) + 20;
export const routeDetourBound = (openCost: number) => Math.ceil(openCost * 2) + 60;
export const TILES_PER_HP = 2;
export const allowedDetour = (open: number, saved: number, clear: boolean, bound: (n: number) => number) =>
    clear ? Math.min(bound(open), open + Math.ceil(Math.max(0, saved) * TILES_PER_HP)) : bound(open);

export type ExposureZone = { id: number; name: string; x: number; z: number; tiles: number; damage: number; maxHit: number };
// `burst`: the largest damage one tick of the walk can take: the largest max hit of a tile in a single-combat zone, the
// sum of the max hits that can attack a tile in a multi-combat zone. 0 or absent: `maxHit`.
export type WalkExposure = { tiles: number; damage: number; maxHit: number; burst?: number; zones: ExposureZone[] };
export const NO_EXPOSURE: WalkExposure = { tiles: 0, damage: 0, maxHit: 0, burst: 0, zones: [] };

// `list`: the threats (default every spawn, walkThreats). `reach`: the tiles each threat can attack (npcReach);
// without it each tile of a threat's square counts.
export type ExposureOptions = { readonly list?: readonly WalkThreat[]; readonly reach?: NpcReach };
const hits = (o: ExposureOptions, t: WalkThreat, x: number, z: number) =>
    Math.abs(t.x - x) <= t.r && Math.abs(t.z - z) <= t.r && (!o.reach || o.reach(t, x, z));

// The expected damage of a walk along `tiles` (in walk order) on one level. Each tile costs a damage rate (hit chance x
// mean hit / attack rate) for its ticks (RUN_TICKS_PER_TILE for the first p.runTiles tiles, then WALK_TICKS_PER_TILE).
// In a single-combat zone one NPC attacks the player at a time (engine Npc.ts huntPlayers: check_notcombat skips a
// player in combat), so the rate is that of the worst hunter that can attack the tile; in a multi-combat zone it is
// the sum over all of them.
export function walkExposure(p: WalkProfile, level: number, tiles: readonly { x: number; z: number }[], o: ExposureOptions = {}): WalkExposure {
    if (!tiles.length) return NO_EXPOSURE;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const t of tiles) { if (t.x < minX) minX = t.x; if (t.x > maxX) maxX = t.x; if (t.z < minZ) minZ = t.z; if (t.z > maxZ) maxZ = t.z; }
    const near = threatsIn(level, { minX, maxX, minZ, maxZ }, o.list ?? walkThreats()).filter(t => huntsAt(t, p.combat, t.x, t.z));
    if (!near.length) return NO_EXPOSURE;
    const rate = near.map(t => npcHitChance(t.attackRoll, p.defence, p.defenceBonus ?? 0) * (t.maxHit / 2) / t.attackRate);
    const zones = new Map<WalkThreat, ExposureZone>();
    const add = (t: WalkThreat, d: number) => {
        const z = zones.get(t) ?? zones.set(t, { id: t.id, name: t.name, x: t.x, z: t.z, tiles: 0, damage: 0, maxHit: t.maxHit }).get(t)!;
        z.tiles++; z.damage += d;
    };
    let inside = 0, damage = 0, maxHit = 0, burst = 0;
    for (let k = 0; k < tiles.length; k++) {
        const tile = tiles[k]!, ticks = k < p.runTiles ? RUN_TICKS_PER_TILE : WALK_TICKS_PER_TILE, many = isMulti(level, tile.x, tile.z);
        let best = -1, any = false, sum = 0;
        for (let i = 0; i < near.length; i++) {
            const t = near[i]!;
            if (!hits(o, t, tile.x, tile.z)) continue;
            any = true;
            if (t.maxHit > maxHit) maxHit = t.maxHit;
            sum = many ? sum + t.maxHit : Math.max(sum, t.maxHit);
            if (many) { const d = rate[i]! * ticks; damage += d; add(t, d); }
            else if (best < 0 || rate[i]! > rate[best]!) best = i;
        }
        if (!any) continue;
        inside++; burst = Math.max(burst, sum);
        if (best >= 0) { const d = rate[best]! * ticks; damage += d; add(near[best]!, d); }
    }
    return { tiles: inside, damage, maxHit, burst, zones: [...zones.values()].sort((a, b) => b.damage - a.damage) };
}

// The Hitpoints at which the HP floor eats on this walk: FLOOR_HITS (2) x the burst (hp-floor.ts floorLine; the floor
// sums the max-hit estimates of the attackers in view, so it sees the burst of a multi-combat zone).
export const walkFloorLine = (e: WalkExposure) => 2 * Math.max(e.burst || e.maxHit, e.maxHit);

// clear: the Hitpoints hold the expected damage x WALK_SAFETY plus the retreat line of the largest hit in reach (one
// max hit and a margin, combat-admission.ts retreatLine). eat: the pack food covers the rest. No walk script eats:
// the eat guard eats only in a fight that the script started (eat-guard.ts), and the HP floor eats any held food at its
// line with no script attack (hp-floor.ts; test/hp-floor.test.ts "eats held food at the floor with no script attack").
// So pack food counts only for the foods the floor eats (foodHealOf) and only when the Hitpoints start above the floor
// line of the walk's burst: under it one burst can land before the floor's eat. refuse: `needHeal` more heal of food
// is needed (and the Hitpoints must start above the floor line).
// `eatFirst`: the heal to eat before the first step, when the Hitpoints start at or under the floor line: the walk
// eats it from the pack (walk/harm.ts eatBeforeWalk), then starts above the line. A walk whose maximum Hitpoints are
// at or under the floor line cannot start above it, and food does not help: needHeal is 0 and the walk is refused.
// needHeal: the heal of food still short, the start line and the need together.
export type WalkVerdict = { verdict: 'clear' | 'eat' | 'refuse'; need: number; needHeal: number; eatFirst: number };
export function walkVerdict(p: WalkProfile, e: WalkExposure): WalkVerdict {
    if (e.damage <= 0) return { verdict: 'clear', need: 0, needHeal: 0, eatFirst: 0 };
    const need = Math.ceil(e.damage * WALK_SAFETY + retreatLine(e.maxHit)), line = walkFloorLine(e);
    // At or under the floor line the first hit sends the HP floor into its eat or escape, so the walk starts above it.
    if (p.hp >= need && p.hp > line) return { verdict: 'clear', need, needHeal: 0, eatFirst: 0 };
    const maxHp = Math.max(p.hp, p.maxHp ?? p.hp);
    if (maxHp <= line) return { verdict: 'refuse', need, needHeal: 0, eatFirst: 0 };
    const eatFirst = Math.max(0, line + 1 - p.hp), total = Math.max(need, line + 1) - p.hp;
    if (p.foodHeal >= total) return { verdict: 'eat', need, needHeal: 0, eatFirst };
    return { verdict: 'refuse', need, needHeal: total - p.foodHeal, eatFirst };
}

// The fields of a WALK_DANGER log line: the worst zone, the expected damage, the Hitpoints needed and the food short.
export function dangerSummary(e: WalkExposure, v: WalkVerdict): { zone: string; damage: number; need: number; needHeal: number; eatFirst: number; floorLine: number; tiles: number; zones: { name: string; x: number; z: number; tiles: number; damage: number }[] } {
    const top = e.zones[0];
    return {
        zone: top ? `${top.name} ${top.x},${top.z}` : '-', damage: Math.round(e.damage * 10) / 10, need: v.need, needHeal: v.needHeal, eatFirst: v.eatFirst, floorLine: walkFloorLine(e), tiles: e.tiles,
        zones: e.zones.slice(0, 5).map(z => ({ name: z.name, x: z.x, z: z.z, tiles: z.tiles, damage: Math.round(z.damage * 10) / 10 })),
    };
}

// The harm ground for an account on one level inside a box: each tile a hunter of the account can attack, packed.
// `open`: a threat that can attack one of these tiles keeps its ground open (the walk's start and goal may stand in
// it and must leave or arrive).
export function harmSet(p: WalkProfile, level: number, box: { minX: number; maxX: number; minZ: number; maxZ: number }, open: readonly { x: number; z: number }[] = [], o: ExposureOptions = {}): Int32Array {
    const out = new Set<number>();
    for (const t of threatsIn(level, box, o.list ?? walkThreats())) {
        if (!huntsAt(t, p.combat, t.x, t.z)) continue;
        if (open.some(q => hits(o, t, q.x, q.z))) continue;
        for (let x = Math.max(box.minX, t.x - t.r); x <= Math.min(box.maxX, t.x + t.r); x++)
            for (let z = Math.max(box.minZ, t.z - t.r); z <= Math.min(box.maxZ, t.z + t.r); z++) if (!o.reach || o.reach(t, x, z)) out.add(pack(level, x, z));
    }
    return Int32Array.from(out);
}

// Corners to single tiles (rs-sdk path segments are straight or diagonal).
export function cornerTiles(from: { x: number; z: number }, corners: readonly { x: number; z: number }[]): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    let x = from.x, z = from.z;
    for (const c of corners) while (x !== c.x || z !== c.z) { x += Math.sign(c.x - x); z += Math.sign(c.z - z); out.push({ x, z }); }
    return out;
}

type Corners = readonly { x: number; z: number }[];
// The corners of a path query result: an rs-sdk findLongPath array, or an SDK findPath result ({success, waypoints}).
export function cornersOf(r: unknown): Corners | null {
    if (Array.isArray(r)) return r.length ? r : null;
    const w = r && typeof r === 'object' ? (r as { success?: boolean; waypoints?: unknown }) : null;
    return w && w.success !== false && Array.isArray(w.waypoints) && w.waypoints.length ? w.waypoints : null;
}

// Plans a one-level walk round harm ground. `find` is the path query with the caller's door and deadly scopes inside
// it; planAroundHarm runs outside them, so npcReach floods the plain grid. The open path is kept when its expected
// damage is under 1 Hitpoint, when no way round reaches the goal, when the way round is longer than allowedDetour, or
// when the way round costs no less damage.
export function planAroundHarm<T>(grid: FloorGrid, p: WalkProfile, level: number, from: { x: number; z: number }, to: { x: number; z: number }, pad: number, find: () => T, o: ExposureOptions = {}): T {
    const open = find(), openCorners = cornersOf(open);
    if (!openCorners) return open;
    const openTiles = cornerTiles(from, openCorners), exposure = walkExposure(p, level, openTiles, o);
    if (exposure.damage * WALK_SAFETY < 1) return open;
    const box = { minX: Math.min(from.x, to.x) - pad, maxX: Math.max(from.x, to.x) + pad, minZ: Math.min(from.z, to.z) - pad, maxZ: Math.max(from.z, to.z) + pad };
    const closed = harmSet(p, level, box, [from, to], o);
    if (!closed.length) return open;
    const round = withDanger(grid, closed, [{ ...from, level }, { ...to, level }], find, 'harm'), roundCorners = cornersOf(round);
    if (!roundCorners) return open;
    const end = roundCorners[roundCorners.length - 1]!, openEnd = openCorners[openCorners.length - 1]!;
    if (Math.max(Math.abs(end.x - openEnd.x), Math.abs(end.z - openEnd.z)) > 1) return open;
    const roundTiles = cornerTiles(from, roundCorners), roundDamage = walkExposure(p, level, roundTiles, o).damage;
    if (roundDamage >= exposure.damage) return open;
    const clear = walkVerdict(p, exposure).verdict === 'clear';
    return roundTiles.length <= allowedDetour(openTiles.length, exposure.damage - roundDamage, clear, detourBound) ? round : open;
}

// The exposure of a planned route: each walk leg's path on its level from where the route stands before it. The run
// energy is spent along the legs in order. `path` returns the corners of a walk on one level (null when none).
export type RouteLegLike = { kind: string; to: Tile };
export function routeExposure(p: WalkProfile, from: Tile, legs: readonly RouteLegLike[], path: (level: number, a: { x: number; z: number }, b: { x: number; z: number }) => Corners | null, o: ExposureOptions = {}): WalkExposure {
    let at = from, tiles = 0, damage = 0, maxHit = 0, burst = 0, walked = 0;
    const zones: ExposureZone[] = [];
    for (const leg of legs) {
        if (leg.kind === 'walk' && leg.to.level === at.level) {
            const corners = path(at.level, at, leg.to), steps = corners?.length ? cornerTiles(at, corners) : [];
            const e = walkExposure({ ...p, runTiles: Math.max(0, p.runTiles - walked) }, at.level, steps, o);
            walked += steps.length;
            tiles += e.tiles; damage += e.damage; maxHit = Math.max(maxHit, e.maxHit); burst = Math.max(burst, e.burst ?? 0); zones.push(...e.zones);
        }
        at = leg.to;
    }
    return { tiles, damage, maxHit, burst, zones: zones.sort((a, b) => b.damage - a.damage) };
}

// What a planned route does about its harm: `clear` walks it, `detour` takes the safe route (a search with the harm
// ground closed), `eat` walks it and eats the pack food on the way, `refuse` does not start it (stage food first).
// The safe route is taken when it costs less damage, its own verdict is not refuse, and its cost is inside
// allowedDetour (routeDetourBound).
export type RouteDanger = { action: 'clear' | 'detour' | 'eat' | 'refuse'; verdict: WalkVerdict; exposure: WalkExposure };
export function routeDanger(p: WalkProfile, open: { cost: number; exposure: WalkExposure }, safe?: { cost: number; exposure: WalkExposure } | null): RouteDanger {
    const verdict = walkVerdict(p, open.exposure), base = { verdict, exposure: open.exposure };
    if (open.exposure.damage * WALK_SAFETY < 1) return { action: 'clear', ...base };
    if (safe && safe.exposure.damage < open.exposure.damage && walkVerdict(p, safe.exposure).verdict !== 'refuse'
        && safe.cost <= allowedDetour(open.cost, open.exposure.damage - safe.exposure.damage, verdict.verdict === 'clear', routeDetourBound)) return { action: 'detour', ...base };
    return { action: verdict.verdict === 'clear' ? 'clear' : verdict.verdict, ...base };
}

// Harm ground for a whole route search (danger/guard.ts guardRoute with Account.avoidHarm): the square of each hunter
// of this combat level on every level. A square that holds `open` (the route's start and goal) stays open. Squares, not
// npcReach floods: a world search closes more ground than one walk, and the flood of every spawn costs seconds.
const worldHarm = new Map<number, Int32Array>();
export function routeHarmSet(combat: number, list: readonly WalkThreat[] = walkThreats()): Int32Array {
    let tiles = list === threats ? worldHarm.get(combat) : undefined;
    if (tiles) return tiles;
    const out = new Set<number>();
    for (const t of list) {
        if (!huntsAt(t, combat, t.x, t.z)) continue;
        for (let x = Math.max(0, t.x - t.r); x <= t.x + t.r; x++) for (let z = Math.max(0, t.z - t.r); z <= t.z + t.r; z++) out.add(pack(t.level, x, z));
    }
    tiles = Int32Array.from(out);
    if (list === threats) { if (worldHarm.size >= 4) worldHarm.delete(worldHarm.keys().next().value!); worldHarm.set(combat, tiles); }
    return tiles;
}
// The tiles of each hunter square that holds one of `open`: they stay open in a route search, so the walk leaves its
// start and reaches its goal. `key` names them for the leg cache.
export function routeHarmKeep(combat: number, open: readonly Tile[], list: readonly WalkThreat[] = walkThreats()): { tiles: Tile[]; key: string } {
    const out = new Map<number, Tile>(), ids: string[] = [];
    for (const o of open) for (const t of threatsIn(o.level, { minX: o.x, maxX: o.x, minZ: o.z, maxZ: o.z }, list)) {
        if (!huntsAt(t, combat, t.x, t.z) || Math.abs(t.x - o.x) > t.r || Math.abs(t.z - o.z) > t.r) continue;
        ids.push(`${t.level},${t.x},${t.z},${t.id}`);
        for (let x = t.x - t.r; x <= t.x + t.r; x++) for (let z = t.z - t.r; z <= t.z + t.r; z++) { const k = pack(t.level, x, z); if (!out.has(k)) out.set(k, { x, z, level: t.level }); }
    }
    return { tiles: [...out.values()], key: ids.sort().join(';') };
}
