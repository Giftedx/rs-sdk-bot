// Where an item lies on the ground and respawns: the OBJ section of each map square file. A line is
// `<level> <localX> <localZ>: <obj id> <count>`; the file m<X>_<Z>.jm2 holds world x = X*64 + localX, z = Z*64 + localZ.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Tile } from './world';

const maps = join(resolve(import.meta.dir, '..', '..', '..'), 'vendor', 'rs-sdk', 'server', 'content', 'maps');

export function parseObjSpawns(file: string, text: string, out = new Map<number, Tile[]>()): Map<number, Tile[]> {
    const square = file.match(/^m(\d+)_(\d+)\.jm2$/);
    const at = text.indexOf('==== OBJ');
    if (!square || at < 0) return out;
    const baseX = Number(square[1]) * 64, baseZ = Number(square[2]) * 64;
    for (const line of text.slice(at).split(/\r?\n/).slice(1)) {
        if (line.startsWith('====')) break;
        const m = line.match(/^(\d+) (\d+) (\d+): (\d+)/);
        if (!m) continue;
        const id = Number(m[4]), tile = { x: baseX + Number(m[2]), z: baseZ + Number(m[3]), level: Number(m[1]) };
        out.set(id, [...(out.get(id) ?? []), tile]);
    }
    return out;
}

let index: Map<number, Tile[]> | undefined;
export function objSpawns(): Map<number, Tile[]> {
    if (index) return index;
    index = new Map();
    for (const f of readdirSync(maps)) if (f.endsWith('.jm2')) parseObjSpawns(f, readFileSync(join(maps, f), 'utf8'), index);
    return index;
}

// Spawn tiles of `id`, nearest first by straight-line distance with LEVEL_STEP tiles for each floor between (the route
// search judges the walk, and the far walk takes the hubs toward the ground beneath an upstairs spawn). Ernest the
// Chicken's fish food lies upstairs in Draynor Manor (3108,3356,1) and nowhere on the ground.
export const LEVEL_STEP = 40;
export function spawnsByDistance(id: number, at: Tile, list = objSpawns()): Tile[] {
    const d = (t: Tile) => Math.max(Math.abs(t.x - at.x), Math.abs(t.z - at.z)) + LEVEL_STEP * Math.abs(t.level - at.level);
    return [...(list.get(id) ?? [])].sort((a, b) => d(a) - d(b));
}
