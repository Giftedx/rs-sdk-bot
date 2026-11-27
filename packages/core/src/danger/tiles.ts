// Packed tile encoding and synchronous floor-grid danger scope management.
import type { Tile } from '../world-types';

// A tile packed into one number (level in bits 28-29, x in 14-27, z in 0-13). The whole-world danger set holds
// about 390,000 tiles for a weak account; as {x,z,level} objects with string keys it cost 320 MB per process.
export const pack = (level: number, x: number, z: number) => (level << 28) | (x << 14) | z;
export const unpack = (k: number): Tile => ({ x: (k >>> 14) & 0x3fff, z: k & 0x3fff, level: k >>> 28 });

export type FloorGrid = { isFlagged(x: number, z: number, level: number, mask: number): boolean; changeFloor(x: number, z: number, level: number, add: boolean): void };
const FLOOR = 2097152; // CollisionFlag.FLOOR
// Runs a synchronous path query with the danger tiles blocked, then opens exactly the tiles it blocked.
// The start and end tiles stay open, so a walk that starts or ends inside an area can still leave or arrive.
// The danger scope a path query runs in: `key` names the closed set, `kept` the tiles of that set left open
// (level,x,z). A keep tile outside the closed set changes no tile of the grid, so it is not in `kept`: the two name
// the closed ground exactly. `closed` holds the packed tiles this scope closed (not kept, and not closed before), and
// `outer` the scope it runs inside: together they are every tile the danger rule changed in the grid
// (world/leg-key.ts keys a saved walk length by the changed tiles near the walk).
export type DangerScope = { key: string; kept: ReadonlySet<string>; closed: Int32Array; outer: DangerScope | null; opened?: Int32Array };
let active: DangerScope | null = null;
export const activeDanger = () => active;
export function withDanger<T>(grid: FloorGrid, tiles: readonly Tile[] | Int32Array, keep: readonly Tile[], query: () => T, key = '?'): T {
    const kept = new Set<string>(), open = new Set<number>(), outer = active;
    for (let i = 0; i < keep.length; i++) { const t = keep[i]!; open.add(pack(t.level, t.x, t.z)); }
    const packed = tiles instanceof Int32Array ? tiles : Int32Array.from(tiles, t => pack(t.level, t.x, t.z));
    const added = new Int32Array(packed.length);
    let n = 0;
    const scope: DangerScope = { key, kept, closed: added.subarray(0, 0), outer };
    active = scope;
    try {
        for (let i = 0; i < packed.length; i++) {
            const k = packed[i]!;
            const x = (k >>> 14) & 0x3fff, z = k & 0x3fff, level = k >>> 28;
            if (open.has(k)) kept.add(`${level},${x},${z}`);
            else if (!grid.isFlagged(x, z, level, FLOOR)) { grid.changeFloor(x, z, level, true); added[n++] = k; }
        }
        scope.closed = added.subarray(0, n);
        const result = query();
        if (result && typeof (result as any).then === 'function') throw Error('Danger queries must be synchronous');
        return result;
    } finally {
        for (let i = 0; i < n; i++) { const k = added[i]!; grid.changeFloor((k >>> 14) & 0x3fff, k & 0x3fff, k >>> 28, false); }
        active = outer;
    }
}

// Runs a path query with `open` (packed tiles that the active scopes closed, closedOf) open again: a walk that starts
// on a route landing inside closed ground leaves it as a walk from the route start does (guard.ts escapeTiles). The
// query sees one more scope over the active one, with no closed tiles of its own and `opened` naming the tiles it
// opened: the closed lists of the chain are shared, not copied, and the leg keys (world/pathfinding.ts dangerChanges)
// count the opened tiles, so a length measured with them open is never read back with them shut. The scope is built
// once for each active scope and tag.
const openedScopes = new WeakMap<DangerScope, Map<string, DangerScope>>();
export function withOpened<T>(grid: FloorGrid, open: Int32Array, tag: string, query: () => T): T {
    const outer = active;
    if (!outer || !open.length) return query();
    let byTag = openedScopes.get(outer);
    if (!byTag) openedScopes.set(outer, byTag = new Map());
    let top = byTag.get(tag);
    if (!top) {
        const kept = new Set(outer.kept);
        for (let i = 0; i < open.length; i++) { const k = open[i]!; kept.add(`${k >>> 28},${(k >>> 14) & 0x3fff},${k & 0x3fff}`); }
        byTag.set(tag, top = { key: `${outer.key}|open:${tag}`, kept, closed: new Int32Array(0), outer, opened: open });
    }
    for (let i = 0; i < open.length; i++) { const k = open[i]!; grid.changeFloor((k >>> 14) & 0x3fff, k & 0x3fff, k >>> 28, false); }
    active = top;
    try {
        const result = query();
        if (result && typeof (result as any).then === 'function') throw Error('Danger queries must be synchronous');
        return result;
    } finally {
        for (let i = 0; i < open.length; i++) { const k = open[i]!; grid.changeFloor((k >>> 14) & 0x3fff, k & 0x3fff, k >>> 28, true); }
        active = outer;
    }
}

// The packed tiles of `squares` that the active scopes closed (empty when none, or no scope is active).
const closedSets = new WeakMap<DangerScope, Set<number>>();
export function closedOf(squares: readonly Tile[]): Int32Array {
    if (!active || !squares.length) return new Int32Array(0);
    const out = new Set<number>();
    for (let s: DangerScope | null = active; s; s = s.outer) {
        if (!s.closed.length) continue;
        let set = closedSets.get(s);
        if (!set) closedSets.set(s, set = new Set(s.closed));
        for (const t of squares) { const k = pack(t.level, t.x, t.z); if (set.has(k)) out.add(k); }
    }
    return Int32Array.from(out);
}
