import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { objSpawns, parseObjSpawns, spawnsByDistance } from '../src/spawn-index';

test('an OBJ line gives the world tile of its map square', () => {
    const m = parseObjSpawns('m51_52.jm2', '==== MAP ====\n0 1 1: 9\n==== OBJ ====\n0 2 33: 753 1\n1 9 47: 753 1\n');
    expect(m.get(753)).toEqual([{ x: 3266, z: 3361, level: 0 }, { x: 3273, z: 3375, level: 1 }]);
    expect(m.has(9)).toBe(false);
});

test('the pinned maps hold the cadava berry spawns south-east of Varrock, nearest first', () => {
    expect(spawnsByDistance(753, { x: 3270, z: 3360, level: 0 }, objSpawns())[0]).toEqual({ x: 3266, z: 3361, level: 0 });
});

test('objSpawns caches parsed spawns and invalidates when a map file changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-cache-'));
    try {
        const mapsDir = join(dir, 'maps');
        const cacheFile = join(dir, 'cache', 'obj-spawns.json');
        mkdirSync(mapsDir, { recursive: true });
        const mapFile = join(mapsDir, 'm50_50.jm2');
        writeFileSync(mapFile, '==== OBJ ====\n0 2 3: 753 1\n');
        const first = objSpawns(mapsDir, cacheFile);
        expect(first.get(753)).toEqual([{ x: 3202, z: 3203, level: 0 }]);
        expect(JSON.parse(readFileSync(cacheFile, 'utf8')).v).toBe(1);
        // Same byte length + restored mtime verifies cache hit even if map contents differ under identical stats.
        const st = statSync(mapFile);
        writeFileSync(mapFile, '==== OBJ ====\n0 9 9: 999 1\n');
        utimesSync(mapFile, st.atime, st.mtime);
        const fromCache = objSpawns(mapsDir, cacheFile);
        expect(fromCache.get(753)).toEqual([{ x: 3202, z: 3203, level: 0 }]);
        expect(fromCache.get(999)).toBeUndefined();
        writeFileSync(mapFile, '==== OBJ ====\n0 4 5: 754 10\n');
        const rebuilt = objSpawns(mapsDir, cacheFile);
        expect(rebuilt.get(753)).toBeUndefined();
        expect(rebuilt.get(754)).toEqual([{ x: 3204, z: 3205, level: 0 }]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
