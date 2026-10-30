import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lazyCollisionSource } from '../src/collision-lazy';

test('the lazy collision module serves the same zones, tiles and doors, and none after a snapshot restore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coll-')), json = join(dir, 'collision-data.json'), mod = join(dir, 'lazy.js');
    writeFileSync(json, JSON.stringify({ tiles: [[0, 1, 2, 3]], zones: [[0, 8, 8]], doors: [[0, 5, 6, 0, 1, 1]] }));
    writeFileSync(mod, lazyCollisionSource(json));
    const data = (await import(mod)).default;
    expect(data.tiles).toEqual([[0, 1, 2, 3]]);
    expect(data.zones).toEqual([[0, 8, 8]]);
    expect(data.doors).toEqual([[0, 5, 6, 0, 1, 1]]);
    (globalThis as any).__rsPathRestored = true;
    try { expect(data.tiles).toEqual([]); expect(data.zones).toEqual([]); expect(data.doors).toEqual([[0, 5, 6, 0, 1, 1]]); }
    finally { delete (globalThis as any).__rsPathRestored; }
});
