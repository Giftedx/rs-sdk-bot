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

// Where a pickable plant stands (knowledge/pickables.json from the knowledge build: potato, wheat, onion, cabbage and
// flax plants by loc id). Reading every map square's LOC section at run time took 147 s on the bot's own thread and the
// server dropped the client, so the tiles come from the generated file.
let pickables: Map<number, Tile[]> | undefined;
export function pickableTiles(locId: number): Tile[] {
    pickables ??= new Map(Object.entries(JSON.parse(readFileSync(join(resolve(import.meta.dir, '..', '..', '..'), 'knowledge', 'pickables.json'), 'utf8')) as Record<string, { tiles: Tile[] }>).map(([id, p]) => [Number(id), p.tiles]));
    return pickables.get(locId) ?? [];
}
export const rank = (list: Tile[], at: Tile): Tile[] => {
    const d = (t: Tile) => Math.max(Math.abs(t.x - at.x), Math.abs(t.z - at.z)) + LEVEL_STEP * Math.abs(t.level - at.level) + (crossesSea(t, at) ? SEA : 0);
    return [...list].sort((a, b) => d(a) - d(b));
};
export const locsByDistance = (locId: number, at: Tile, list?: Map<number, Tile[]>): Tile[] => rank(list ? list.get(locId) ?? [] : pickableTiles(locId), at);

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
// A tile across water ranks SEA tiles farther: a bot standing by the Musa Point beer spawn saw the Falador hammer spawn
// nearer than Ardougne's, by straight line, and from Ardougne the Miscellania food shop (2516,3864) ranked within the
// seller limit, so the sweep walked up the Fremennik shore toward a boat it has no fare for.
export const SEA = 1000;
// Karamja: the island south of Brimhaven and west of Port Sarim.
export const onKaramja = (p: { x: number; z: number }): boolean => p.z <= 3260 && p.x >= 2690 && p.x <= 2960;
// Miscellania and Etceteria: the isles north of Rellekka, reached by Sailor Fjord's boat.
const onFremennikIsles = (p: { x: number; z: number }): boolean => p.z >= 3830 && p.x >= 2490 && p.x <= 2630;
export const landmass = (p: { x: number; z: number }): 'mainland' | 'karamja' | 'isles' => onKaramja(p) ? 'karamja' : onFremennikIsles(p) ? 'isles' : 'mainland';
export const crossesSea = (a: { x: number; z: number }, b: { x: number; z: number }): boolean => landmass(a) !== landmass(b);
export function spawnsByDistance(id: number, at: Tile, list = objSpawns()): Tile[] { return rank(list.get(id) ?? [], at); }
