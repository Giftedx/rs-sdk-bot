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
let active: { key: string; kept: ReadonlySet<string> } | null = null;
// The danger scope a path query runs in: `key` names the closed set, `kept` the tiles of that set left open
// (level,x,z). A keep tile outside the closed set changes no tile of the grid, so it is not in `kept`: the two name
// the closed ground exactly, and a walk length measured under them holds for every trip with the same closed ground
// (leg-cache.ts). With every keep tile in `kept`, each new start or end tile of a trip measured every leg again.
export const activeDanger = () => active;
export function withDanger<T>(grid: FloorGrid, tiles: readonly Tile[] | Int32Array, keep: readonly Tile[], query: () => T, key = '?'): T {
    const kept = new Set<string>(), open = new Set(keep.map(t => pack(t.level, t.x, t.z))), outer = active;
    const packed = tiles instanceof Int32Array ? tiles : Int32Array.from(tiles, t => pack(t.level, t.x, t.z));
    const added = new Int32Array(packed.length);
    let n = 0;
    active = { key, kept };
    try {
        for (const k of packed) {
            const x = (k >>> 14) & 0x3fff, z = k & 0x3fff, level = k >>> 28;
            if (open.has(k)) kept.add(`${level},${x},${z}`);
            else if (!grid.isFlagged(x, z, level, FLOOR)) { grid.changeFloor(x, z, level, true); added[n++] = k; }
        }
        const result = query();
        if (result && typeof (result as any).then === 'function') throw Error('Danger queries must be synchronous');
        return result;
    } finally {
        for (let i = 0; i < n; i++) { const k = added[i]!; grid.changeFloor((k >>> 14) & 0x3fff, k & 0x3fff, k >>> 28, false); }
        active = outer;
    }
}
