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
export type DangerScope = { key: string; kept: ReadonlySet<string>; closed: Int32Array; outer: DangerScope | null };
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
