import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { lazyCollisionSource } from '../src/collision-lazy';

test('doors come from the file tail: a file larger than the first read, with doors at the end, with a key order that puts doors first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coll-')), runtime = globalThis as { __rsPathRestored?: boolean };
    const previousRestored = runtime.__rsPathRestored;
    const serve = async (name: string, data: object) => {
        const json = join(dir, `${name}.json`), mod = join(dir, `${name}.js`);
        writeFileSync(json, JSON.stringify(data));
        writeFileSync(mod, lazyCollisionSource(json));
        return (await import(mod)).default;
    };
    const doors = Array.from({ length: 3000 }, (_, i) => [0, i, i + 1, 0, i % 4, 1]);
    // 1.2 MB of tiles ahead of the doors: more than the first 64 KiB read, so the read grows.
    const tiles = Array.from({ length: 60000 }, (_, i) => [0, i, i, i]);
    runtime.__rsPathRestored = true;
    try {
        expect((await serve('big', { tiles, zones: [[0, 8, 8]], doors })).doors).toEqual(doors);
        expect((await serve('small', { tiles: [], zones: [], doors: [] })).doors).toEqual([]);
        // Doors first and tiles last: the tail has no doors, so the module falls back to the whole file.
        expect((await serve('first', { doors: [[1, 2, 3, 0, 0, 1]], tiles, zones: [] })).doors).toEqual([[1, 2, 3, 0, 0, 1]]);
    } finally {
        if (previousRestored === undefined) delete runtime.__rsPathRestored;
        else runtime.__rsPathRestored = previousRestored;
    }
});

test('the lazy collision module serves the same zones, tiles and doors, and none after a snapshot restore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coll-')), json = join(dir, 'collision-data.json'), mod = join(dir, 'lazy.js');
    writeFileSync(json, JSON.stringify({ tiles: [[0, 1, 2, 3]], zones: [[0, 8, 8]], doors: [[0, 5, 6, 0, 1, 1]] }));
    writeFileSync(mod, lazyCollisionSource(json));
    const data = (await import(mod)).default;
    const runtime = globalThis as { __rsPathRestored?: boolean; __rsPathEnsure?: () => void };
    const previous = runtime.__rsPathRestored;
    const previousEnsure = runtime.__rsPathEnsure;
    try {
        runtime.__rsPathRestored = false;
        delete runtime.__rsPathEnsure;
        expect(data.tiles).toEqual([[0, 1, 2, 3]]);
        expect(data.zones).toEqual([[0, 8, 8]]);
        expect(data.doors).toEqual([[0, 5, 6, 0, 1, 1]]);

        runtime.__rsPathRestored = true;
        expect(data.tiles).toEqual([]);
        expect(data.zones).toEqual([]);
        expect(data.doors).toEqual([[0, 5, 6, 0, 1, 1]]);
    } finally {
        if (previous === undefined) delete runtime.__rsPathRestored;
        else runtime.__rsPathRestored = previous;
        if (previousEnsure === undefined) delete runtime.__rsPathEnsure;
        else runtime.__rsPathEnsure = previousEnsure;
    }
});

test('importing rsmod and calling getDoorAt/findDoorsAlongPath do not instantiate WASM until a path query runs', async () => {
    const probe = `
        import assert from 'node:assert/strict';
        const rsmod = await import('./vendor/rs-sdk/server/vendor/rsmod-pathfinder');
        assert.equal(rsmod.CollisionType.NORMAL, 0);
        assert.ok(rsmod.CollisionFlag.WALK_BLOCKED > 0);
        assert.equal(rsmod.__wasm, undefined, 'importing rsmod must not eagerly instantiate WASM');
        const pf = await import('./vendor/rs-sdk/sdk/pathfinding');
        assert.equal(rsmod.__wasm, undefined, 'importing sdk/pathfinding must not eagerly instantiate WASM');
        // Lumbridge castle gate/door tiles exist in collision-data.json doors tail.
        const door = pf.getDoorAt(0, 3217, 3218) ?? pf.getDoorAt(0, 3234, 3203) ?? pf.getDoorAt(0, 3207, 3210);
        assert.ok(door, 'getDoorAt must resolve real doors without WASM');
        const along = pf.findDoorsAlongPath([{ x: door.x, z: door.z, level: door.level }]);
        assert.ok(along.some(d => d.x === door.x && d.z === door.z), 'findDoorsAlongPath must find door without WASM');
        assert.equal(rsmod.__wasm, undefined, 'door-only lookups must not instantiate WASM');
        // Calling a WASM-backed function lazily instantiates WASM on demand.
        assert.equal(typeof rsmod.isZoneAllocated(3222, 3218, 0), 'boolean');
        assert.ok(rsmod.__wasm?.memory instanceof WebAssembly.Memory, 'first WASM call must instantiate WASM');
    `;
    const child = Bun.spawn([process.execPath, '-e', probe], {
        cwd: resolve(import.meta.dir, '../../..'),
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(stderr).toBe('');
        expect(code).toBe(0);
    } finally { clearTimeout(timer); }
});
