// The part of a route scope that one saved walk length depends on.
// A scope (the doors an account keeps shut, door-policy.ts withDoorPolicy, and the danger ground closed for it,
// danger/tiles.ts withDanger) changes the collision flags of single tiles; a door changes the flags of its own tile
// and of the tiles next to it. findLongPath (rsmod-pathfinder, src/rsmod/pathfinder.rs) floods one level breadth
// first over a 2048x2048 grid centred on the start, and tests the goal when it takes a tile from its queue:
// - a walk that ends on its goal has the length of a shortest path in the grid (each waypoint starts a straight run,
//   so the Chebyshev sum is the step count). Every tile t of a path of length at most L has
//   cheb(start, t) + cheb(t, goal) <= L. A path step reads the flags of tiles next to it, and the goal test reads the
//   flags of the goal's edge tiles (reach_strategy.rs, rectangle_boundary.rs). So a change at a tile d with
//   cheb(start, d) + cheb(d, goal) > L + span + 4 neither removes a shortest path nor makes a shorter one, and the
//   length stays (legKey);
// - any other result (no path, a closest approach, a path cut at the waypoint limit) read the flags of every tile it
//   could reach inside the grid (windowKey).
// So two scopes with the same changes in that region give the same result. A change table sums one hash of each
// change over 32x32-tile chunks; prefix sums give the sum of a run of chunks in four reads. A chunk counts when the
// lower bound of the region test over the chunk passes, so the chunks cover the region.

export const CHUNK_SHIFT = 5;
const CHUNK = 1 << CHUNK_SHIFT;
// Two tiles from a path tile to a door that changes a flag the step reads, on each of the two distances.
export const PATH_MARGIN = 4;
// The window margin: a door one tile outside the grid changes a flag inside it.
export const BOX_MARGIN = 3;
// Half the side of the findLongPath grid (rsmod-pathfinder lib.rs: PathFinder::with_size(2048, ...)).
export const FLOOD_HALF = 1024;
// The waypoint limit of every findLongPath call of this package: a path with this many turns may be cut.
export const WAYPOINT_LIMIT = 500;

type Level = { cx: number; cz: number; w: number; h: number; a: Uint32Array; b: Uint32Array };
export interface ChangeTable { readonly levels: ReadonlyArray<Level | undefined>; readonly size: number }

const mix = (h: number, v: number, m: number): number => { h = Math.imul(h ^ v, m); return h ^ (h >>> 15); };
const finish = (h: number): number => {
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
};

// The two 32-bit hashes of one change: the tile it is bucketed on and up to four numbers that name it exactly (its
// kind first).
const lanes = new Uint32Array(2);
function hashChange(level: number, x: number, z: number, k0: number, k1: number, k2: number, k3: number): void {
    let ha = 0x243f6a88, hb = 0x85a308d3;
    ha = mix(ha, level, 0x9e3779b1); hb = mix(hb, level, 0x27d4eb2f);
    ha = mix(ha, x, 0x9e3779b1); hb = mix(hb, x, 0x27d4eb2f);
    ha = mix(ha, z, 0x9e3779b1); hb = mix(hb, z, 0x27d4eb2f);
    ha = mix(ha, k0, 0x9e3779b1); hb = mix(hb, k0, 0x27d4eb2f);
    ha = mix(ha, k1, 0x9e3779b1); hb = mix(hb, k1, 0x27d4eb2f);
    ha = mix(ha, k2, 0x9e3779b1); hb = mix(hb, k2, 0x27d4eb2f);
    ha = mix(ha, k3, 0x9e3779b1); hb = mix(hb, k3, 0x27d4eb2f);
    lanes[0] = finish(ha); lanes[1] = finish(hb);
}

// Collects changes (hashChange) into a table.
export function changeBuilder(): { add(level: number, x: number, z: number, k0: number, k1?: number, k2?: number, k3?: number): void; build(): ChangeTable } {
    const per: { cx: number[]; cz: number[]; a: number[]; b: number[] }[] = [];
    let size = 0;
    return {
        add(level, x, z, k0, k1 = 0, k2 = 0, k3 = 0) {
            hashChange(level, x, z, k0, k1, k2, k3);
            const l = (per[level] ??= { cx: [], cz: [], a: [], b: [] });
            l.cx.push(x >> CHUNK_SHIFT); l.cz.push(z >> CHUNK_SHIFT); l.a.push(lanes[0]!); l.b.push(lanes[1]!);
            size++;
        },
        build: () => {
            const bounds: number[][] = [];
            for (let level = 0; level < per.length; level++) {
                const l = per[level];
                for (let i = 0; l && i < l.cx.length; i++) grow(bounds, level, l.cx[i]!, l.cz[i]!);
            }
            const cells = cellsOf(bounds);
            for (let level = 0; level < per.length; level++) {
                const l = per[level], c = cells[level];
                for (let i = 0; l && c && i < l.cx.length; i++) put(c, l.cx[i]!, l.cz[i]!, l.a[i]!, l.b[i]!);
            }
            return tableOf(cells, size);
        },
    };
}

// A table of packed tiles (danger/tiles.ts pack), each a change of kind `k0` on its own tile.
export function tileTable(lists: readonly Int32Array[], k0: number): ChangeTable {
    const bounds: number[][] = [];
    let size = 0;
    for (const list of lists) for (let i = 0; i < list.length; i++) { const k = list[i]!; grow(bounds, k >>> 28, ((k >>> 14) & 0x3fff) >> CHUNK_SHIFT, (k & 0x3fff) >> CHUNK_SHIFT); size++; }
    const cells = cellsOf(bounds);
    for (const list of lists) for (let i = 0; i < list.length; i++) {
        const k = list[i]!, level = k >>> 28, x = (k >>> 14) & 0x3fff, z = k & 0x3fff;
        hashChange(level, x, z, k0, 0, 0, 0);
        put(cells[level]!, x >> CHUNK_SHIFT, z >> CHUNK_SHIFT, lanes[0]!, lanes[1]!);
    }
    return tableOf(cells, size);
}

function grow(bounds: number[][], level: number, cx: number, cz: number): void {
    const bd = (bounds[level] ??= [cx, cx, cz, cz]);
    if (cx < bd[0]!) bd[0] = cx; if (cx > bd[1]!) bd[1] = cx; if (cz < bd[2]!) bd[2] = cz; if (cz > bd[3]!) bd[3] = cz;
}
// Cell sums at (i + 1, j + 1) of a (w + 1) x (h + 1) grid, so that the prefix sums need no edge case.
function cellsOf(bounds: number[][]): (Level | undefined)[] {
    return bounds.map(bd => {
        if (!bd) return undefined;
        const w = bd[1]! - bd[0]! + 1, h = bd[3]! - bd[2]! + 1;
        return { cx: bd[0]!, cz: bd[2]!, w, h, a: new Uint32Array((w + 1) * (h + 1)), b: new Uint32Array((w + 1) * (h + 1)) };
    });
}
// A Uint32Array store wraps modulo 2^32.
function put(l: Level, cx: number, cz: number, ha: number, hb: number): void {
    const at = (cx - l.cx + 1) * (l.h + 1) + (cz - l.cz + 1);
    l.a[at] = l.a[at]! + ha; l.b[at] = l.b[at]! + hb;
}
function tableOf(levels: (Level | undefined)[], size: number): ChangeTable {
    for (const l of levels) {
        if (!l) continue;
        const { w, h, a, b } = l;
        for (let i = 1; i <= w; i++) for (let j = 1; j <= h; j++) {
            const at = i * (h + 1) + j, up = at - (h + 1);
            a[at] = a[at]! + a[up]! + a[at - 1]! - a[up - 1]!;
            b[at] = b[at]! + b[up]! + b[at - 1]! - b[up - 1]!;
        }
    }
    return { levels, size };
}

export const NO_CHANGES = changeBuilder().build();

// The changes of all tables inside the chunks that the tile box (inclusive) touches on one level, as text.
export function boxKey(tables: readonly ChangeTable[], level: number, x0: number, z0: number, x1: number, z1: number): string {
    let a = 0, b = 0;
    for (let t = 0; t < tables.length; t++) {
        const l = tables[t]!.levels[level];
        if (!l) continue;
        const i0 = Math.max(x0 >> CHUNK_SHIFT, l.cx) - l.cx, i1 = Math.min(x1 >> CHUNK_SHIFT, l.cx + l.w - 1) - l.cx + 1;
        const j0 = Math.max(z0 >> CHUNK_SHIFT, l.cz) - l.cz, j1 = Math.min(z1 >> CHUNK_SHIFT, l.cz + l.h - 1) - l.cz + 1;
        if (i0 >= i1 || j0 >= j1) continue;
        const s = l.h + 1;
        a += l.a[i1 * s + j1]! - l.a[i0 * s + j1]! - l.a[i1 * s + j0]! + l.a[i0 * s + j0]!;
        b += l.b[i1 * s + j1]! - l.b[i0 * s + j1]! - l.b[i1 * s + j0]! + l.b[i0 * s + j0]!;
    }
    return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}

type Tile = { x: number; z: number; level: number };
// The changes in the region a walk that ended on its goal after `len` steps depends on: the tiles d with
// cheb(from, d) + cheb(d, goal) <= len + span + PATH_MARGIN, where the goal is the `span`-tile square at `to` and the
// tiles next to it (a walk ends on the goal tile, or next to a loc).
// The lower bound of the region test over a chunk is convex along a row of chunks, so the chunks of a row that pass
// are one run; `runs` holds the first and last chunk column of each row (rows cz0.., an empty row as 1, 0).
let runs = new Int32Array(256);
export function legKey(tables: readonly ChangeTable[], from: Tile, to: Tile, len: number, span: number): string {
    const c = len + span + PATH_MARGIN;
    const gx0 = to.x - 1, gx1 = to.x + span, gz0 = to.z - 1, gz1 = to.z + span;
    const cx0 = (from.x - c) >> CHUNK_SHIFT, cx1 = (from.x + c) >> CHUNK_SHIFT, cz0 = (from.z - c) >> CHUNK_SHIFT, cz1 = (from.z + c) >> CHUNK_SHIFT;
    if (runs.length < 2 * (cz1 - cz0 + 1)) runs = new Int32Array(4 * (cz1 - cz0 + 1));
    const passes = (i: number, dzFrom: number, dzGoal: number): boolean => {
        const qx0 = i * CHUNK, qx1 = qx0 + CHUNK - 1;
        return Math.max(qx0 - from.x, 0, from.x - qx1, dzFrom) + Math.max(gx0 - qx1, 0, qx0 - gx1, dzGoal) <= c;
    };
    for (let j = cz0; j <= cz1; j++) {
        const qz0 = j * CHUNK, qz1 = qz0 + CHUNK - 1, r = 2 * (j - cz0);
        const dzFrom = Math.max(qz0 - from.z, 0, from.z - qz1), dzGoal = Math.max(gz0 - qz1, 0, qz0 - gz1);
        runs[r] = 1; runs[r + 1] = 0;
        if (dzFrom + dzGoal > c) continue;
        let lo = cx0, hi = cx1;
        while (lo <= hi && !passes(lo, dzFrom, dzGoal)) lo++;
        while (hi >= lo && !passes(hi, dzFrom, dzGoal)) hi--;
        if (lo <= hi) { runs[r] = lo; runs[r + 1] = hi; }
    }
    let a = 0, b = 0;
    for (let t = 0; t < tables.length; t++) {
        const l = tables[t]!.levels[from.level];
        if (!l) continue;
        const s = l.h + 1, j0 = Math.max(cz0, l.cz), j1 = Math.min(cz1, l.cz + l.h - 1);
        for (let j = j0; j <= j1; j++) {
            const r = 2 * (j - cz0), i0 = Math.max(runs[r]!, l.cx), i1 = Math.min(runs[r + 1]!, l.cx + l.w - 1);
            if (i0 > i1) continue;
            // The chunks i0..i1 of row j.
            const ii0 = i0 - l.cx, ii1 = i1 - l.cx + 1, jj = j - l.cz;
            a += l.a[ii1 * s + jj + 1]! - l.a[ii0 * s + jj + 1]! - l.a[ii1 * s + jj]! + l.a[ii0 * s + jj]!;
            b += l.b[ii1 * s + jj + 1]! - l.b[ii0 * s + jj + 1]! - l.b[ii1 * s + jj]! + l.b[ii0 * s + jj]!;
        }
    }
    return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}
// The changes any other result depends on: the whole findLongPath grid with the margin.
export function windowKey(tables: readonly ChangeTable[], from: Tile): string {
    const r = FLOOD_HALF + BOX_MARGIN;
    return boxKey(tables, from.level, from.x - r, from.z - r, from.x + r, from.z + r);
}

// The saved exact lengths of one leg: the newest two, packed in one number.
const HINT = 2 ** 26;
export const hintLengths = (hint: number): number[] => {
    const newest = hint % HINT, older = Math.floor(hint / HINT) - 1;
    return older >= 0 && older !== newest ? [newest, older] : [newest];
};
export const withHint = (hint: number | null | undefined, len: number): number => {
    if (typeof hint !== 'number') return len;
    const newest = hint % HINT;
    return newest === len ? hint : len + (newest + 1) * HINT;
};
