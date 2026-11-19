import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathfindingSnapshotUsable, writePathfindingSnapshot } from '../src/pathcache';

test('a snapshot is usable only for its own source key, and a missing or cut file is not usable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pathcache-usable-')), file = join(dir, 'world.snap');
    expect(pathfindingSnapshotUsable(file, 'key-a')).toBe(false); // no file
    writePathfindingSnapshot(file, 'key-a', new Uint8Array(65536).fill(3));
    expect(pathfindingSnapshotUsable(file, 'key-a')).toBe(true);
    // A snapshot made before a change of the wasm, the collision data, the initializer or the doors has another key.
    expect(pathfindingSnapshotUsable(file, 'key-b')).toBe(false);
    const bytes = readFileSync(file);
    writeFileSync(file, bytes.subarray(0, bytes.length - 100));
    expect(pathfindingSnapshotUsable(file, 'key-a')).toBe(false); // the payload is shorter than the header says
    writeFileSync(file, bytes.subarray(0, 3));
    expect(pathfindingSnapshotUsable(file, 'key-a')).toBe(false);
});

test('the default key is the current source: a snapshot of the current source is usable, a stale one is not', () => {
    const { pathfindingSourceKey } = require('../src/pathcache') as typeof import('../src/pathcache');
    const dir = mkdtempSync(join(tmpdir(), 'pathcache-usable-')), file = join(dir, 'world.snap');
    writePathfindingSnapshot(file, pathfindingSourceKey(), new Uint8Array(65536));
    expect(pathfindingSnapshotUsable(file)).toBe(true);
    writePathfindingSnapshot(file, JSON.stringify({ v: 0, stale: true }), new Uint8Array(65536));
    expect(pathfindingSnapshotUsable(file)).toBe(false);
});
