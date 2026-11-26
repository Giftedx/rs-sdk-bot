// The tiles a player stands on to operate a loc. The rules are the engine's reach rules for a player of size 1
// (server/engine/src/engine/routefinder/ReachStrategy.ts, RectangleBoundary.ts and Rotation.ts). The flags are the
// static collision that the SDK exports from the engine's map load (sdk/collision-data.json), so a bridged tile is
// on its engine level. Map floors (jm2.ts mapTiles) tell open air above level 0 from floor.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tileKey } from './jm2';
import { contentRoot } from './paths';

export type ReachTile = { x: number; z: number; level: number };
export interface Collision { at(x: number, z: number, level: number): number; floor(x: number, z: number, level: number): boolean }
export interface ReachLoc extends ReachTile { shape: number; angle: number; width: number; length: number; forceapproach: number }

const NULL = 0x7fffffff; // a tile in a zone the engine did not allocate
const WALL_N = 0x2, WALL_E = 0x8, WALL_S = 0x20, WALL_W = 0x80;
const WALK_BLOCKED = 0x240100; // LOC | FLOOR_DECORATION | FLOOR
const BLOCK_W = 0x240108, BLOCK_E = 0x240180, BLOCK_S = 0x240102, BLOCK_N = 0x240120;
const ACCESS_N = 0x1, ACCESS_E = 0x2, ACCESS_S = 0x4, ACCESS_W = 0x8;

// Tiles hold their flags. A tile with no row is open when its zone is allocated. Without floors every tile has floor.
export function collisionFrom(data: { tiles: [number, number, number, number][]; zones: [number, number, number][] }, floors?: ReadonlySet<number>): Collision {
    const tiles = new Map<number, number>(), zones = new Set<number>();
    for (const [level, x, z, flags] of data.tiles) tiles.set(tileKey(x, z, level), flags);
    for (const [level, x, z] of data.zones) zones.add(tileKey(x & ~7, z & ~7, level));
    return {
        at: (x, z, level) => tiles.get(tileKey(x, z, level)) ?? (zones.has(tileKey(x & ~7, z & ~7, level)) ? 0 : NULL),
        floor: (x, z, level) => level === 0 || !floors || floors.has(tileKey(x, z, level)),
    };
}

export function loadCollision(floors?: ReadonlySet<number>, file = join(contentRoot(), '..', '..', 'sdk', 'collision-data.json')): Collision | undefined {
    return existsSync(file) ? collisionFrom(JSON.parse(readFileSync(file, 'utf8')), floors) : undefined;
}

// forceapproach=<side> in a .loc config: the side the player must stand on (tools/pack/config/LocConfig.ts).
export function forceApproachFlags(side: string | undefined): number {
    const open = { north: ACCESS_N, east: ACCESS_E, south: ACCESS_S, west: ACCESS_W }[side ?? ''];
    return open === undefined ? 0 : 0b1111 & ~open;
}

const rotateAccess = (angle: number, flags: number) => angle === 0 ? flags : (((flags << angle) & 0xf) | (flags >>> (4 - angle))) >>> 0;

function reachWall(f: number, sx: number, sz: number, dx: number, dz: number, shape: number, angle: number): boolean {
    const w = sx === dx - 1 && sz === dz, e = sx === dx + 1 && sz === dz, n = sx === dx && sz === dz + 1, s = sx === dx && sz === dz - 1;
    const open = (mask: number) => (f & mask) === 0;
    if (shape === 0) {
        if (angle === 0) return w || (n && open(BLOCK_N)) || (s && open(BLOCK_S));
        if (angle === 1) return n || (w && open(BLOCK_W)) || (e && open(BLOCK_E));
        if (angle === 2) return e || (n && open(BLOCK_N)) || (s && open(BLOCK_S));
        return s || (w && open(BLOCK_W)) || (e && open(BLOCK_E));
    }
    if (shape === 2) {
        if (angle === 0) return w || n || (e && open(BLOCK_E)) || (s && open(BLOCK_S));
        if (angle === 1) return (w && open(BLOCK_W)) || n || e || (s && open(BLOCK_S));
        if (angle === 2) return (w && open(BLOCK_W)) || (n && open(BLOCK_N)) || e || s;
        return w || (n && open(BLOCK_N)) || (e && open(BLOCK_E)) || s;
    }
    if (shape === 9) return (n && open(WALL_S)) || (s && open(WALL_N)) || (w && open(WALL_E)) || (e && open(WALL_W));
    return false;
}

function reachWallDecor(f: number, sx: number, sz: number, dx: number, dz: number, shape: number, angle: number): boolean {
    const w = sx === dx - 1 && sz === dz, e = sx === dx + 1 && sz === dz, n = sx === dx && sz === dz + 1, s = sx === dx && sz === dz - 1;
    const open = (mask: number) => (f & mask) === 0;
    if (shape === 6 || shape === 7) {
        const rot = shape === 7 ? (angle + 2) & 0x3 : angle;
        if (rot === 0) return (e && open(WALL_W)) || (s && open(WALL_N));
        if (rot === 1) return (w && open(WALL_E)) || (s && open(WALL_N));
        if (rot === 2) return (w && open(WALL_E)) || (n && open(WALL_S));
        return (e && open(WALL_W)) || (n && open(WALL_S));
    }
    if (shape === 8) return (n && open(WALL_S)) || (s && open(WALL_N)) || (w && open(WALL_E)) || (e && open(WALL_W));
    return false;
}

// ReachStrategy.reached for srcSize 1.
export function reaches(c: Collision, sx: number, sz: number, loc: ReachLoc): boolean {
    const { x: dx, z: dz, level, shape, angle } = loc;
    const f = c.at(sx, sz, level);
    if ((shape >= 0 && shape <= 3) || shape === 9) return (sx === dx && sz === dz) || reachWall(f, sx, sz, dx, dz, shape, angle);
    if (shape < 9) return (sx === dx && sz === dz) || reachWallDecor(f, sx, sz, dx, dz, shape, angle);
    if (shape !== 10 && shape !== 11 && shape !== 22) return false;
    const w = angle & 1 ? loc.length : loc.width, l = angle & 1 ? loc.width : loc.length;
    const east = dx + w - 1, north = dz + l - 1, access = rotateAccess(angle, loc.forceapproach);
    if (sx >= dx && sx <= east && sz >= dz && sz <= north) return true;
    if (sx === dx - 1 && sz >= dz && sz <= north && (f & WALL_E) === 0 && (access & ACCESS_W) === 0) return true;
    if (sx === east + 1 && sz >= dz && sz <= north && (f & WALL_W) === 0 && (access & ACCESS_E) === 0) return true;
    if (sz + 1 === dz && sx >= dx && sx <= east && (f & WALL_N) === 0 && (access & ACCESS_S) === 0) return true;
    return sz === north + 1 && sx >= dx && sx <= east && (f & WALL_S) === 0 && (access & ACCESS_N) === 0;
}

const standable = (c: Collision, x: number, z: number, level: number) => (c.at(x, z, level) & WALK_BLOCKED) === 0 && c.floor(x, z, level);
const step = (c: Collision, x: number, z: number, level: number, block: number) => (c.at(x, z, level) & block) === 0 && c.floor(x, z, level);

// The standable tiles, within one tile of the loc, from which the engine lets the player operate it.
export function approachTiles(c: Collision, loc: ReachLoc): ReachTile[] {
    const w = loc.angle & 1 ? loc.length : loc.width, l = loc.angle & 1 ? loc.width : loc.length;
    const out: ReachTile[] = [];
    for (let z = loc.z - 1; z <= loc.z + l; z++) for (let x = loc.x - 1; x <= loc.x + w; x++) {
        if (standable(c, x, z, loc.level) && reaches(c, x, z, loc)) out.push({ x, z, level: loc.level });
    }
    return out;
}

// The tiles (tileKey) a walk from t can reach when they are at most `limit`, or null for a larger region. Such a
// closed pocket is the open middle of a log (the Karamja river log, the coal trucks log): no walk ends there.
export function smallRegion(c: Collision, t: ReachTile, limit = 4): number[] | null {
    const seen = new Set<number>([tileKey(t.x, t.z, t.level)]), todo: ReachTile[] = [t];
    while (todo.length) {
        const { x, z, level } = todo.pop()!;
        for (const [nx, nz, block] of [[x - 1, z, BLOCK_W], [x + 1, z, BLOCK_E], [x, z - 1, BLOCK_S], [x, z + 1, BLOCK_N]] as const) {
            const k = tileKey(nx, nz, level);
            if (seen.has(k) || !step(c, nx, nz, level, block)) continue;
            seen.add(k);
            if (seen.size > limit) return null;
            todo.push({ x: nx, z: nz, level });
        }
    }
    return [...seen];
}
