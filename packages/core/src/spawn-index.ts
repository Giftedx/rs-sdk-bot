// Where an item lies on the ground and respawns: the OBJ section of each map square file. A line is
// `<level> <localX> <localZ>: <obj id> <count>`; the file m<X>_<Z>.jm2 holds world x = X*64 + localX, z = Z*64 + localZ.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeAtomicFile } from './atomic-file';
import type { Tile } from './world';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const maps = join(repoRoot, 'vendor', 'rs-sdk', 'server', 'content', 'maps');
export const DEFAULT_SPAWN_CACHE = join(repoRoot, '.practice', 'cache', 'obj-spawns.json');

export function parseObjSpawns(file: string, text: string, out = new Map<number, Tile[]>()): Map<number, Tile[]> {
    const square = /^m(\d+)_(\d+)\.jm2$/.exec(file);
    if (!square) return out;
    const at = text.indexOf('==== OBJ');
    if (at < 0) return out;
    const nl0 = text.indexOf('\n', at);
    if (nl0 < 0) return out;
    const baseX = Number(square[1]) * 64, baseZ = Number(square[2]) * 64;
    let pos = nl0 + 1;
    const len = text.length;
    while (pos < len) {
        let nl = text.indexOf('\n', pos);
        if (nl < 0) nl = len;
        const lineEnd = nl > pos && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
        if (text.startsWith('====', pos)) break;
        // Line format: "<level> <localX> <localZ>: <obj id> <count>"
        let p = pos, lvl = 0, lx = 0, lz = 0, id = 0, c = 0;
        if (p < lineEnd && (c = text.charCodeAt(p) - 48) >= 0 && c <= 9) {
            lvl = c; p++;
            while (p < lineEnd && (c = text.charCodeAt(p) - 48) >= 0 && c <= 9) { lvl = lvl * 10 + c; p++; }
            if (p < lineEnd && text.charCodeAt(p) === 32) {
                p++;
                if (p < lineEnd && (c = text.charCodeAt(p) - 48) >= 0 && c <= 9) {
                    lx = c; p++;
                    while (p < lineEnd && (c = text.charCodeAt(p) - 48) >= 0 && c <= 9) { lx = lx * 10 + c; p++; }
                    if (p < lineEnd && text.charCodeAt(p) === 32) {
                        p++;
                        if (p < lineEnd && (c = text.charCodeAt(p) - 48) >= 0 && c <= 9) {
                            lz = c; p++;
                            while (p < lineEnd && (c = text.charCodeAt(p) - 48) >= 0 && c <= 9) { lz = lz * 10 + c; p++; }
                            if (p + 1 < lineEnd && text.charCodeAt(p) === 58 && text.charCodeAt(p + 1) === 32) {
                                p += 2;
                                if (p < lineEnd && (c = text.charCodeAt(p) - 48) >= 0 && c <= 9) {
                                    id = c; p++;
                                    while (p < lineEnd && (c = text.charCodeAt(p) - 48) >= 0 && c <= 9) { id = id * 10 + c; p++; }
                                    const tile: Tile = { x: baseX + lx, z: baseZ + lz, level: lvl };
                                    let list = out.get(id);
                                    if (!list) { list = []; out.set(id, list); }
                                    list.push(tile);
                                }
                            }
                        }
                    }
                }
            }
        }
        pos = nl + 1;
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

type SpawnCache = { v: 1; key: string; entries: [number, number[]][] };

function spawnCacheKey(mapsDir: string, files: string[]): string {
    const h = createHash('sha256').update('v1:');
    for (const f of files) {
        const st = statSync(join(mapsDir, f));
        h.update(`${f}:${st.size}:${Math.trunc(st.mtimeMs)}\n`);
    }
    return h.digest('hex');
}

function loadCachedSpawns(cacheFile: string, key: string): Map<number, Tile[]> | null {
    try {
        const parsed = JSON.parse(readFileSync(cacheFile, 'utf8')) as SpawnCache;
        if (parsed?.v !== 1 || parsed.key !== key || !Array.isArray(parsed.entries)) return null;
        const out = new Map<number, Tile[]>();
        for (const [id, coords] of parsed.entries) {
            const list: Tile[] = [];
            for (let i = 0; i < coords.length; i += 3) {
                list.push({ x: coords[i]!, z: coords[i + 1]!, level: coords[i + 2]! });
            }
            out.set(id, list);
        }
        return out;
    } catch {
        return null;
    }
}

function saveCachedSpawns(cacheFile: string, key: string, map: Map<number, Tile[]>): void {
    try {
        const entries: [number, number[]][] = [];
        for (const [id, tiles] of map) {
            const coords = new Array<number>(tiles.length * 3);
            for (let i = 0; i < tiles.length; i++) {
                const t = tiles[i]!;
                coords[i * 3] = t.x;
                coords[i * 3 + 1] = t.z;
                coords[i * 3 + 2] = t.level;
            }
            entries.push([id, coords]);
        }
        writeAtomicFile(cacheFile, JSON.stringify({ v: 1, key, entries }), { ensureDir: true });
    } catch {
        // Ignore cache write contention or read-only filesystems.
    }
}

let index: Map<number, Tile[]> | undefined;
export function objSpawns(mapsDir = maps, cacheFile = DEFAULT_SPAWN_CACHE): Map<number, Tile[]> {
    const isDefault = mapsDir === maps && cacheFile === DEFAULT_SPAWN_CACHE;
    if (isDefault && index) return index;
    const files = readdirSync(mapsDir).filter(f => f.endsWith('.jm2')).sort();
    const key = cacheFile ? spawnCacheKey(mapsDir, files) : '';
    const cached = cacheFile ? loadCachedSpawns(cacheFile, key) : null;
    if (cached) {
        if (isDefault) index = cached;
        return cached;
    }
    const built = new Map<number, Tile[]>();
    for (const f of files) parseObjSpawns(f, readFileSync(join(mapsDir, f), 'utf8'), built);
    if (cacheFile) saveCachedSpawns(cacheFile, key, built);
    if (isDefault) index = built;
    return built;
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
