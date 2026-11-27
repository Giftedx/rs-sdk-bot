import type { FlagGrid } from '../door-policy';
import { loadKnowledgeJson, type Tile } from './model';

// An npc type with blockwalk=all puts block collision on its tiles (engine World.ts addNpc), so a player step onto
// one is refused and the player stands still. The static collision export has no npcs, so the SDK path goes
// straight through such a tile: the lumber yard crates (kittens_mew) held a walk at 3307,3508 for 63 ticks with
// "Stuck at", as its path south crossed the crate at 3307,3507.
const LOC = 256; // CollisionFlag.LOC

let ids: ReadonlySet<number> | null = null;
export function blockwalkNpcIds(): ReadonlySet<number> {
    return ids ??= new Set(loadKnowledgeJson<{ id: number; blockwalk?: string }[]>('npcs.json').filter(n => n.blockwalk === 'all').map(n => n.id));
}

export interface SeenNpc { id: number; x: number; z: number; tileX?: number; tileZ?: number; size?: number }

/** The tiles the seen blockwalk=all npcs cover, except the walker's own tile and the walk's destination. */
export function npcBlockTiles(npcs: readonly SeenNpc[], from: Tile, to: Tile, blockIds: ReadonlySet<number> = blockwalkNpcIds()): Tile[] {
    const out = new Map<string, Tile>();
    for (const n of npcs) {
        if (!blockIds.has(n.id)) continue;
        const x0 = n.tileX ?? n.x, z0 = n.tileZ ?? n.z, size = Math.max(1, n.size ?? 1);
        for (let dx = 0; dx < size; dx++) for (let dz = 0; dz < size; dz++) {
            const t = { x: x0 + dx, z: z0 + dz, level: from.level };
            if ((t.x === from.x && t.z === from.z) || (to.level === t.level && t.x === to.x && t.z === to.z)) continue;
            out.set(`${t.x},${t.z}`, t);
        }
    }
    return [...out.values()];
}

/** Runs a synchronous path query with the given tiles blocked, then restores their flags. */
export function withNpcBlocks<T>(grid: FlagGrid, tiles: readonly Tile[], query: () => T): T {
    if (tiles.length === 0) return query();
    const saved: { t: Tile; mask: number }[] = [];
    try {
        for (const t of tiles) {
            if (grid.isFlagged(t.x, t.z, t.level, LOC)) continue;
            let mask = 0;
            for (let bit = 0; bit < 32; bit++) if (grid.isFlagged(t.x, t.z, t.level, 1 << bit)) mask |= 1 << bit;
            saved.push({ t, mask });
            grid.__set(t.x, t.z, t.level, mask | LOC);
        }
        return query();
    } finally {
        for (const { t, mask } of saved) grid.__set(t.x, t.z, t.level, mask);
    }
}
