// Connected walkable areas, labelled once per process from the loaded map collision (doors open, as the SDK
// pathfinder masks them). A route search asks "same area?" before it runs findLongPath: a leg between two areas
// cannot be walked, and searching it scans the whole 2048x2048 grid. Ardougne to Varrock took 180 s of search that
// way. Labelling the map takes about 5 s for 7.7M tiles in 20,763 areas.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathfindingDataKey } from './pathcache';

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
    return fromZones(label, areas, tiles);
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

function fromZones(label: Map<number, Int32Array>, areas: number, tiles: number): Labels {
    const keys = makeInt32(label.size);
    let idx = 0;
    for (const k of label.keys()) keys[idx++] = k;
    const small = areas < 0xffff;
    const cells = small ? makeUint16(keys.length * 64) : makeInt32(keys.length * 64);
    for (let i = 0; i < keys.length; i++) {
        const z = label.get(keys[i]!)!;
        const base = i * 64;
        for (let c = 0; c < 64; c++) cells[base + c] = z[c]! < 0 ? (small ? 0xffff : -1) : z[c]!;
    }
    return flat(keys, cells, areas, tiles)!;
}

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
    renameSync(tmp, file);
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
    const text = readFileSync(file, 'utf8');
    const marker = text.indexOf('"zones":');
    if (marker >= 0) {
        const start = text.indexOf('[', marker + 8);
        if (start >= 0) {
            let depth = 0, end = -1;
            for (let i = start; i < text.length; i++) {
                const c = text.charCodeAt(i);
                if (c === 91) depth++;
                else if (c === 93 && --depth === 0) { end = i + 1; break; }
            }
            if (end > start) {
                try { return JSON.parse(text.slice(start, end)) as [number, number, number][]; }
                catch { /* fall back to full JSON parse */ }
            }
        }
    }
    return (JSON.parse(text) as { zones: [number, number, number][] }).zones;
}

let built: Labels | undefined;
const publishBuiltAreas = (l: Labels): Labels => {
    built = l;
    (globalThis as { __rsGetSharedLabels?: () => SharedLabels | null }).__rsGetSharedLabels = () => built ? shareLabels(built) : null;
    return l;
};
// Labels for the SDK map, built on first use; pf and grid must be the modules the route search uses.
export function mapAreas(pf: any, grid: any, repoRoot: string): Labels {
    if (built) return built;
    pf.initPathfinding();
    const file = join(repoRoot, '.practice', 'cache', 'route-areas.bin'), source = pathfindingDataKey();
    const cached = readLabels(file, source);
    if (cached) return publishBuiltAreas(cached);
    const rawZones = readCollisionZones(join(repoRoot, 'vendor/rs-sdk/sdk/collision-data.json'));
    // Zones are given by their origin tile, as pathfinding.ts allocates them; the same mainland fill follows.
    const zones: [number, number, number][] = [...rawZones];
    for (let x = 2304; x <= 3392; x += 8) for (let z = 2944; z <= 3584; z += 8) zones.push([0, x, z]);
    const labels = labelAreas(zones, (l, x, z) => pf.isTileWalkable(l, x, z),
        (l, x, z, dx, dz) => grid.canTravel(l, x, z, dx, dz, 1, 0, grid.CollisionType.NORMAL));
    if (labels.areas < 0xffff) writeLabels(file, source, labels);
    return publishBuiltAreas(labels);
}
