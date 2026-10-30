// Connected walkable areas, labelled once per process from the loaded map collision (doors open, as the SDK
// pathfinder masks them). A route search asks "same area?" before it runs findLongPath: a leg between two areas
// cannot be walked, and searching it scans the whole 2048x2048 grid. Ardougne to Varrock took 180 s of search that
// way. Labelling the map takes about 5 s for 7.7M tiles in 20,763 areas.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Labels = { area(level: number, x: number, z: number): number; areas: number; tiles: number };
const zoneKey = (l: number, x: number, z: number) => (l << 28) | ((x >> 3) << 14) | (z >> 3);
const cell = (x: number, z: number) => ((x & 7) << 3) | (z & 7);
// area(): >= 0 an area id; -1 not walkable or not labelled; -2 outside the loaded map.
// zones: [level, origin x, origin z] of each 8x8 zone, in tiles.
export function labelAreas(zones: Iterable<[number, number, number]>, walkable: (l: number, x: number, z: number) => boolean,
    canStep: (l: number, x: number, z: number, dx: number, dz: number) => boolean): Labels {
    const label = new Map<number, Int32Array>();
    for (const [l, zx, zz] of zones) if (!label.has(zoneKey(l, zx, zz))) label.set(zoneKey(l, zx, zz), new Int32Array(64).fill(-1));
    const get = (l: number, x: number, z: number) => label.get(zoneKey(l, x, z))?.[cell(x, z)] ?? -2;
    const set = (l: number, x: number, z: number, v: number) => { label.get(zoneKey(l, x, z))![cell(x, z)] = v; };
    let areas = 0, tiles = 0;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    for (const key of label.keys()) {
        const l = key >>> 28, zx = ((key >>> 14) & 0x3fff) << 3, zz = (key & 0x3fff) << 3;
        for (let dx = 0; dx < 8; dx++) for (let dz = 0; dz < 8; dz++) {
            const x = zx + dx, z = zz + dz;
            if (get(l, x, z) !== -1 || !walkable(l, x, z)) continue;
            const id = areas++, stack = [x, z];
            set(l, x, z, id);
            while (stack.length) {
                const cz = stack.pop()!, cx = stack.pop()!; tiles++;
                for (const [ox, oz] of dirs) {
                    const nx = cx + ox, nz = cz + oz;
                    if (get(l, nx, nz) !== -1 || !canStep(l, cx, cz, ox, oz)) continue;
                    set(l, nx, nz, id); stack.push(nx, nz);
                }
            }
        }
    }
    return { area: (l, x, z) => { const v = get(l, x, z); return v < 0 ? (v === -2 ? -2 : -1) : v; }, areas, tiles };
}

// Areas a walk can start from or end at around a box of tiles; null when part of it lies outside the labelled map.
function areasIn(labels: Labels, level: number, x0: number, z0: number, x1: number, z1: number, ok?: (x: number, z: number) => boolean): Set<number> | null {
    const out = new Set<number>();
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        if (ok && !ok(x, z)) continue;
        const v = labels.area(level, x, z);
        if (v === -2) return null;
        if (v >= 0) out.add(v);
    }
    return out;
}

// True when no walk can join `from` to `to`: the areas at the start share none with the areas at the end.
// An unwalkable start (a stair or ladder tile) counts its neighbours. An end with `size` (a loc to operate)
// counts the ring around its box, kept to tiles `reaches` accepts; a plain end counts the tiles within tol.
// Unknown labels never refuse.
export function separated(labels: Labels, from: { level: number; x: number; z: number }, to: { level: number; x: number; z: number }, tol: number,
    size?: { width: number; height: number }, reaches?: (x: number, z: number) => boolean): boolean {
    if (from.level !== to.level) return false;
    const own = labels.area(from.level, from.x, from.z);
    const starts = own >= 0 ? new Set([own]) : areasIn(labels, from.level, from.x - 1, from.z - 1, from.x + 1, from.z + 1);
    const r = size ? Math.max(tol, 1) : tol;
    const ends = areasIn(labels, to.level, to.x - r, to.z - r, to.x + (size ? size.width - 1 : 0) + r, to.z + (size ? size.height - 1 : 0) + r, size ? reaches : undefined);
    if (!starts || !ends || starts.size === 0 || ends.size === 0) return false;
    for (const e of ends) if (starts.has(e)) return false;
    return true;
}

let built: Labels | undefined;
// Labels for the SDK map, built on first use; pf and grid must be the modules the route search uses.
export function mapAreas(pf: any, grid: any, repoRoot: string): Labels {
    if (built) return built;
    pf.initPathfinding();
    const data = JSON.parse(readFileSync(join(repoRoot, 'vendor/rs-sdk/sdk/collision-data.json'), 'utf8')) as { zones: [number, number, number][] };
    // Zones are given by their origin tile, as pathfinding.ts allocates them; the same mainland fill follows.
    const zones: [number, number, number][] = [...data.zones];
    for (let x = 2304; x <= 3392; x += 8) for (let z = 2944; z <= 3584; z += 8) zones.push([0, x, z]);
    built = labelAreas(zones, (l, x, z) => pf.isTileWalkable(l, x, z),
        (l, x, z, dx, dz) => grid.canTravel(l, x, z, dx, dz, 1, 0, grid.CollisionType.NORMAL));
    return built;
}
