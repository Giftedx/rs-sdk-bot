// Connected walkable areas, labelled once per process from the loaded map collision (doors open, as the SDK
// pathfinder masks them). A route search asks "same area?" before it runs findLongPath: a leg between two areas
// cannot be walked, and searching it scans the whole 2048x2048 grid. Ardougne to Varrock took 180 s of search that
// way. Labelling the map takes about 5 s for 7.7M tiles in 20,763 areas.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { renameRetry } from './atomic-file';
import { openDiagonalDoors, pathfindingDataKey } from './pathcache';

// Labels hold one flat array of 64 labels for each zone (cells, in the order of zoneKeys; 0xffff in a Uint16Array, or -1 in an
// Int32Array, for a tile that is not walkable) and an open-addressing table from a zone key to the place of its labels.
// The array is a Uint16Array while the map has under 65,535 areas. zones offers size and keys() over zoneKeys.
export type Labels = { area(level: number, x: number, z: number): number; areas: number; tiles: number; zones: { size: number; keys(): IterableIterator<number> }; cells: Uint16Array | Int32Array; zoneKeys: Int32Array };
const zoneKey = (l: number, x: number, z: number) => (l << 28) | ((x >> 3) << 14) | (z >> 3);
const cell = (x: number, z: number) => ((x & 7) << 3) | (z & 7);
// area(): >= 0 an area id; -1 not walkable or not labelled; -2 outside the loaded map.
// zones: [level, origin x, origin z] of each 8x8 zone, in tiles.
export function labelAreas(zones: Iterable<[number, number, number]>, walkable: (l: number, x: number, z: number) => boolean,
    canStep: (l: number, x: number, z: number, dx: number, dz: number) => boolean): Labels {
    const uniqueKeys: number[] = [];
    const seenZone = new Set<number>();
    for (const [l, zx, zz] of zones) {
        const k = zoneKey(l, zx, zz);
        if (!seenZone.has(k)) { seenZone.add(k); uniqueKeys.push(k); }
    }
    seenZone.clear();
    const n = uniqueKeys.length;
    const keys = makeInt32(n);
    for (let i = 0; i < n; i++) keys[i] = uniqueKeys[i]!;
    const bits = Math.max(4, 32 - Math.clz32(Math.max(1, n) * 2 - 1)), shift = 32 - bits, mask = (1 << bits) - 1;
    const slotKey = makeInt32(1 << bits), slotAt = makeInt32(1 << bits).fill(-1);
    for (let i = 0; i < n; i++) {
        const k = keys[i]!;
        let s = Math.imul(k, 0x9e3779b1) >>> shift;
        while (slotAt[s]! >= 0) s = (s + 1) & mask;
        slotKey[s] = k;
        slotAt[s] = i;
    }
    const rawCells = new Int32Array(n * 64).fill(-1);
    const lookupZone = (l: number, x: number, z: number): number => {
        const k = zoneKey(l, x, z);
        let s = Math.imul(k, 0x9e3779b1) >>> shift;
        for (;;) {
            const at = slotAt[s]!;
            if (at < 0) return -1;
            if (slotKey[s] === k) return at;
            s = (s + 1) & mask;
        }
    };
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    let stackCap = Math.max(256, Math.min(65536, n * 4));
    let stackX = new Int32Array(stackCap);
    let stackZ = new Int32Array(stackCap);
    let areas = 0, tiles = 0;
    for (let zi = 0; zi < n; zi++) {
        const key = keys[zi]!;
        const l = key >>> 28, zx = ((key >>> 14) & 0x3fff) << 3, zz = (key & 0x3fff) << 3;
        const zoneBase = zi * 64;
        for (let dx = 0; dx < 8; dx++) for (let dz = 0; dz < 8; dz++) {
            const c0 = (dx << 3) | dz;
            const x0 = zx + dx, z0 = zz + dz;
            if (rawCells[zoneBase + c0] !== -1 || !walkable(l, x0, z0)) continue;
            const id = areas++;
            rawCells[zoneBase + c0] = id;
            let sp = 1;
            stackX[0] = x0;
            stackZ[0] = z0;
            while (sp > 0) {
                sp--;
                const cx = stackX[sp]!, cz = stackZ[sp]!;
                tiles++;
                for (let d = 0; d < 4; d++) {
                    const ox = dirs[d]![0], oz = dirs[d]![1];
                    const nx = cx + ox, nz = cz + oz;
                    const nzi = lookupZone(l, nx, nz);
                    if (nzi < 0) continue;
                    const nIdx = nzi * 64 + cell(nx, nz);
                    if (rawCells[nIdx] !== -1 || !canStep(l, cx, cz, ox, oz)) continue;
                    rawCells[nIdx] = id;
                    if (sp >= stackCap) {
                        stackCap *= 2;
                        const nextX = new Int32Array(stackCap), nextZ = new Int32Array(stackCap);
                        nextX.set(stackX); nextZ.set(stackZ);
                        stackX = nextX; stackZ = nextZ;
                    }
                    stackX[sp] = nx;
                    stackZ[sp] = nz;
                    sp++;
                }
            }
        }
    }
    const small = areas < 0xffff;
    const cells = small ? makeUint16(n * 64) : makeInt32(n * 64);
    if (small) {
        for (let i = 0; i < rawCells.length; i++) {
            const v = rawCells[i]!;
            cells[i] = v < 0 ? 0xffff : v;
        }
    } else {
        (cells as Int32Array).set(rawCells);
    }
    return buildLookup(keys, cells, slotKey, slotAt, bits, areas, tiles);
}

const useSab = typeof SharedArrayBuffer !== 'undefined';
const makeInt32 = (n: number): Int32Array => useSab ? new Int32Array(new SharedArrayBuffer(n * 4)) : new Int32Array(n);
const makeUint16 = (n: number): Uint16Array => useSab ? new Uint16Array(new SharedArrayBuffer(n * 2)) : new Uint16Array(n);

export type SharedLabels = {
    zoneKeys: SharedArrayBuffer;
    cells: SharedArrayBuffer;
    slotKey: SharedArrayBuffer;
    slotAt: SharedArrayBuffer;
    areas: number;
    tiles: number;
    bits: number;
    isUint16: boolean;
};
const sharedByLabels = new WeakMap<Labels, SharedLabels>();
export const shareLabels = (l: Labels): SharedLabels | null => sharedByLabels.get(l) ?? null;

function buildLookup(
    keys: Int32Array,
    cells: Uint16Array | Int32Array,
    slotKey: Int32Array,
    slotAt: Int32Array,
    bits: number,
    areas: number,
    tiles: number,
): Labels {
    const shift = 32 - bits, mask = (1 << bits) - 1;
    const none = cells instanceof Uint16Array ? 0xffff : -1;
    const area = (l: number, x: number, z: number): number => {
        const k = zoneKey(l, x, z);
        let s = Math.imul(k, 0x9e3779b1) >>> shift;
        for (;;) {
            const at = slotAt[s]!;
            if (at < 0) return -2;
            if (slotKey[s] === k) { const v = cells[at * 64 + cell(x, z)]!; return v === none ? -1 : v; }
            s = (s + 1) & mask;
        }
    };
    const out: Labels = { area, areas, tiles, zones: { size: keys.length, keys: () => keys.values() }, cells, zoneKeys: keys };
    if (useSab && keys.buffer instanceof SharedArrayBuffer && cells.buffer instanceof SharedArrayBuffer
        && slotKey.buffer instanceof SharedArrayBuffer && slotAt.buffer instanceof SharedArrayBuffer) {
        sharedByLabels.set(out, {
            zoneKeys: keys.buffer, cells: cells.buffer,
            slotKey: slotKey.buffer, slotAt: slotAt.buffer,
            areas, tiles, bits, isUint16: cells instanceof Uint16Array,
        });
    }
    return out;
}

export function attachSharedLabels(s: SharedLabels): Labels {
    const keys = new Int32Array(s.zoneKeys);
    const cells = s.isUint16 ? new Uint16Array(s.cells) : new Int32Array(s.cells);
    const slotKey = new Int32Array(s.slotKey);
    const slotAt = new Int32Array(s.slotAt);
    const l = buildLookup(keys, cells, slotKey, slotAt, s.bits, s.areas, s.tiles);
    built = l;
    (globalThis as { __rsGetSharedLabels?: () => SharedLabels | null }).__rsGetSharedLabels = () => built ? shareLabels(built) : null;
    return l;
}

export const getBuiltAreas = (): Labels | undefined => built;
// Puts back the labels a caller took with getBuiltAreas; undefined leaves none, so the next mapAreas reads the map.
// A test that attaches labels of its own restores the map labels, which later tests in the same process use.
export const restoreBuiltAreas = (l: Labels | undefined): void => { built = l; };

// The labels over one flat array. null when two zones have one key. The table holds at least twice as many slots as zones.
function flat(keys: Int32Array, cells: Uint16Array | Int32Array, areas: number, tiles: number): Labels | null {
    const bits = Math.max(4, 32 - Math.clz32(Math.max(1, keys.length) * 2 - 1)), shift = 32 - bits, mask = (1 << bits) - 1;
    const slotKey = makeInt32(1 << bits), slotAt = makeInt32(1 << bits).fill(-1);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        let s = Math.imul(k, 0x9e3779b1) >>> shift;
        while (slotAt[s]! >= 0) { if (slotKey[s] === k) return null; s = (s + 1) & mask; }
        slotKey[s] = k; slotAt[s] = i;
    }
    return buildLookup(keys, cells, slotKey, slotAt, bits, areas, tiles);
}

// File: u32 header length, JSON header {source, areas, tiles, n, sha256}, n Int32 zone keys, n*64 Uint16 labels
// (0xffff = not walkable). Labels fit in 16 bits while the map has under 65,535 areas.
export function writeLabels(file: string, source: string, l: Labels): void {
    const keys = l.zoneKeys, ids = l.cells instanceof Uint16Array ? l.cells : Uint16Array.from(l.cells, v => v < 0 ? 0xffff : v);
    const keyBytes = Buffer.from(keys.buffer, keys.byteOffset, keys.byteLength), idBytes = Buffer.from(ids.buffer, ids.byteOffset, ids.byteLength);
    const sha256 = createHash('sha256').update(keyBytes).update(idBytes).digest('hex');
    const header = Buffer.from(JSON.stringify({ source, areas: l.areas, tiles: l.tiles, n: keys.length, sha256 }));
    const len = Buffer.alloc(4); len.writeUInt32LE(header.length);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, Buffer.concat([len, header, keyBytes, idBytes]));
    try {
        renameRetry(tmp, file);
    } catch (error) {
        try { unlinkSync(tmp); } catch { /* retain original error */ }
        throw error;
    }
}
export function readLabels(file: string, source: string): Labels | null {
    let fd: number | undefined;
    try {
        // The zone keys and the labels are read into their own arrays: no buffer of the whole file is held.
        fd = openSync(file, 'r');
        const size = fstatSync(fd).size, head = Buffer.alloc(4);
        if (size < 4 || !readExact(fd, head, 0)) return null;
        const hl = head.readUInt32LE(0);
        if (hl > size - 4) return null;
        const headerBytes = Buffer.alloc(hl);
        if (!readExact(fd, headerBytes, 4)) return null;
        const h = JSON.parse(headerBytes.toString()) as { source: string; areas: number; tiles: number; n: number; sha256: string };
        const at = 4 + hl;
        if (!h || h.source !== source || !Number.isSafeInteger(h.n) || h.n < 0
            || !Number.isSafeInteger(h.areas) || h.areas < 0 || h.areas >= 0xffff
            || !Number.isSafeInteger(h.tiles) || h.tiles < 0 || h.tiles > h.n * 64
            || size - at !== h.n * 132) return null;
        const keys = makeInt32(h.n), ids = makeUint16(h.n * 64);
        if (!readExact(fd, new Uint8Array(keys.buffer), at) || !readExact(fd, new Uint8Array(ids.buffer), at + h.n * 4)) return null;
        if (typeof h.sha256 !== 'string' || createHash('sha256').update(new Uint8Array(keys.buffer)).update(new Uint8Array(ids.buffer)).digest('hex') !== h.sha256) return null;
        const seen = new Uint8Array(h.areas);
        let tiles = 0, areas = 0;
        for (let i = 0; i < ids.length; i++) {
            const v = ids[i]!;
            if (v === 0xffff) continue;
            if (v >= h.areas) return null;
            tiles++;
            if (!seen[v]) { seen[v] = 1; areas++; }
        }
        if (tiles !== h.tiles || areas !== h.areas) return null;
        return flat(keys, ids, h.areas, h.tiles);
    } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
// Fills `into` from `position`. false when the file ends before it is full.
function readExact(fd: number, into: Uint8Array, position: number): boolean {
    let done = 0;
    while (done < into.length) {
        const got = readSync(fd, into, done, into.length - done, position + done);
        if (got <= 0) return false;
        done += got;
    }
    return true;
}

// A step test that joins two tiles when a step between them is allowed in either direction. The flood of labelAreas
// takes each tile once, so with a one-way step (a door policy `whenAxis` block, door-policy.ts directionalMasks) it
// would label the two sides apart when it reaches the refused side first, and a walk out through the door would be
// refused. The step back is tried only where `oneWay` holds for either tile (default: every tile), so the rest of the
// map keeps the plain step of mapAreas. It needs a walkable tile to start from: the grid allows a step off a closed
// tile (danger ground, danger/tiles.ts) onto open ground, and without the check the flood would cross closed ground.
export const eitherWay = (
    walkable: (l: number, x: number, z: number) => boolean,
    canStep: (l: number, x: number, z: number, dx: number, dz: number) => boolean,
    oneWay: (l: number, x: number, z: number) => boolean = () => true,
) => (l: number, x: number, z: number, dx: number, dz: number): boolean =>
    canStep(l, x, z, dx, dz)
    || ((oneWay(l, x, z) || oneWay(l, x + dx, z + dz)) && walkable(l, x + dx, z + dz) && canStep(l, x + dx, z + dz, -dx, -dz));

// True when no walk can join `from` to `to`: the areas at the start share none with the areas at the end.
// An unwalkable start (a stair or ladder tile) counts its neighbours. An end with `size` (a loc to operate)
// counts the ring around its box, kept to tiles `reaches` accepts; a plain end counts the tiles within tol.
// Unknown labels never refuse.
export function separated(labels: Labels, from: { level: number; x: number; z: number }, to: { level: number; x: number; z: number }, tol: number,
    size?: { width: number; height: number }, reaches?: (x: number, z: number) => boolean): boolean {
    if (from.level !== to.level) return false;
    const lvl = from.level;
    const own = labels.area(lvl, from.x, from.z);
    const r = size ? Math.max(tol, 1) : tol;
    const x0 = to.x - r, z0 = to.z - r;
    const x1 = to.x + (size ? size.width - 1 : 0) + r;
    const z1 = to.z + (size ? size.height - 1 : 0) + r;
    const check = size ? reaches : undefined;
    if (own >= 0) {
        let any = false, match = false;
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
            if (check && !check(x, z)) continue;
            const v = labels.area(lvl, x, z);
            if (v === -2) return false;
            if (v >= 0) { any = true; if (v === own) match = true; }
        }
        return any && !match;
    }
    const starts: number[] = [];
    for (let x = from.x - 1; x <= from.x + 1; x++) for (let z = from.z - 1; z <= from.z + 1; z++) {
        const v = labels.area(lvl, x, z);
        if (v === -2) return false;
        if (v >= 0 && !starts.includes(v)) starts.push(v);
    }
    if (starts.length === 0) return false;
    let any = false, match = false;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        if (check && !check(x, z)) continue;
        const v = labels.area(lvl, x, z);
        if (v === -2) return false;
        if (v >= 0) { any = true; if (starts.includes(v)) match = true; }
    }
    return any && !match;
}

function readCollisionZones(file: string): [number, number, number][] {
    const bytes = readFileSync(file);
    const marker = bytes.indexOf('"zones":');
    if (marker >= 0) {
        const start = bytes.indexOf(91, marker + 8);
        if (start >= 0) {
            let depth = 0, end = -1;
            for (let i = start; i < bytes.length; i++) {
                const c = bytes[i]!;
                if (c === 91) depth++;
                else if (c === 93 && --depth === 0) { end = i + 1; break; }
            }
            if (end > start) {
                try { return JSON.parse(bytes.subarray(start, end).toString('utf8')) as [number, number, number][]; }
                catch { /* fall back to full JSON parse */ }
            }
        }
    }
    return (JSON.parse(bytes.toString('utf8')) as { zones: [number, number, number][] }).zones;
}

let built: Labels | undefined;
const publishBuiltAreas = (l: Labels): Labels => {
    built = l;
    (globalThis as { __rsGetSharedLabels?: () => SharedLabels | null }).__rsGetSharedLabels = () => built ? shareLabels(built) : null;
    return l;
};
// The labels' cache key: the pathfinding data key and the label build version. Version 2 labels the map with the
// diagonal doors open; files of the earlier build carry no version and are built again.
export const MAP_LABELS_VERSION = 2;
export function mapLabelSource(): string {
    return JSON.stringify({ ...JSON.parse(pathfindingDataKey()) as object, labels: MAP_LABELS_VERSION });
}
// Cached labels for the SDK map without initializing pathfinding; null when the cache file is absent or stale.
export function cachedMapAreas(repoRoot: string): Labels | null {
    if (built) return built;
    const cached = readLabels(join(repoRoot, '.practice', 'cache', 'route-areas.bin'), mapLabelSource());
    return cached ? publishBuiltAreas(cached) : null;
}
// Labels for the SDK map, built on first use; pf and grid must be the modules the route search uses.
export function mapAreas(pf: any, grid: any, repoRoot: string): Labels {
    if (built) return built;
    const file = join(repoRoot, '.practice', 'cache', 'route-areas.bin'), source = mapLabelSource();
    const cached = readLabels(file, source);
    if (cached) return publishBuiltAreas(cached);
    pf.initPathfinding();
    // A cold process builds the labels before pathcache.ts loadPathfinding opens the diagonal doors (that load runs
    // in a microtask after the first initPathfinding), so the labels sealed every building behind a shape-9 door: the
    // Wizards' Tower ladder room (3105,3162) and the essence mine exit to Sedridor had "no route" out.
    openDiagonalDoors(grid);
    const rawZones = readCollisionZones(join(repoRoot, 'vendor/rs-sdk/sdk/collision-data.json'));
    // Zones are given by their origin tile, as pathfinding.ts allocates them; the same mainland fill follows.
    const zones: [number, number, number][] = [...rawZones];
    for (let x = 2304; x <= 3392; x += 8) for (let z = 2944; z <= 3584; z += 8) zones.push([0, x, z]);
    const labels = labelAreas(zones, (l, x, z) => pf.isTileWalkable(l, x, z),
        (l, x, z, dx, dz) => grid.canTravel(l, x, z, dx, dz, 1, 0, grid.CollisionType.NORMAL));
    if (labels.areas < 0xffff) {
        try { writeLabels(file, source, labels); } catch { /* optional cache */ }
    }
    return publishBuiltAreas(labels);
}
