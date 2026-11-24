import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { labelAreas, readLabels, separated, writeLabels } from '../src/components';

const directory = mkdtempSync(join(tmpdir(), 'areas-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

// Two rooms on one zone, split by a wall at x=4; a gap at z=7 joins them when open.
const grid = (gap: boolean) => labelAreas([[0, 0, 0]], () => true,
    (_l, x, z, dx) => !(dx !== 0 && Math.min(x, x + dx) === 3 && !(gap && z === 7)));

test('a wall makes two areas and the leg across it is refused', () => {
    const g = grid(false);
    expect(g.areas).toBe(2);
    expect(g.tiles).toBe(64);
    expect(separated(g, { level: 0, x: 1, z: 1 }, { level: 0, x: 6, z: 1 }, 0)).toBe(true);
    expect(separated(g, { level: 0, x: 1, z: 1 }, { level: 0, x: 2, z: 5 }, 0)).toBe(false);
});

test('a gap joins the areas', () => {
    expect(grid(true).areas).toBe(1);
    expect(separated(grid(true), { level: 0, x: 1, z: 1 }, { level: 0, x: 6, z: 1 }, 0)).toBe(false);
});

test('a target near the map edge or on another level is never refused', () => {
    const g = grid(false);
    expect(separated(g, { level: 0, x: 1, z: 1 }, { level: 0, x: 7, z: 1 }, 1)).toBe(false);
    expect(separated(g, { level: 0, x: 1, z: 1 }, { level: 1, x: 6, z: 1 }, 0)).toBe(false);
});

test('labels read back from disk give the same areas', () => {
    const file = join(directory, 'round-trip.bin'), g = grid(false);
    writeLabels(file, 'src1', g);
    expect(readLabels(file, 'other')).toBeNull();
    const back = readLabels(file, 'src1')!;
    expect([back.areas, back.tiles]).toEqual([g.areas, g.tiles]);
    for (let x = -1; x < 9; x++) for (let z = 0; z < 8; z++) expect(back.area(0, x, z)).toBe(g.area(0, x, z));
});

test('a truncated final label cannot invent a disconnected tile in a connected room', () => {
    const file = join(directory, 'truncated.bin'), g = grid(false);
    const from = { level: 0, x: 6, z: 7 }, to = { level: 0, x: 7, z: 7 };
    expect(separated(g, from, to, 0)).toBe(false);
    writeLabels(file, 'src1', g);
    const bytes = readFileSync(file);
    writeFileSync(file, bytes.subarray(0, bytes.length - 2));
    expect(readLabels(file, 'src1')).toBeNull();
});

test('same-range payload corruption cannot invent a disconnected tile', () => {
    const file = join(directory, 'checksum.bin'), g = grid(false);
    writeLabels(file, 'src1', g);
    const bytes = readFileSync(file), ids = 4 + bytes.readUInt32LE(0) + g.zones.size * 4;
    // Both area IDs remain in use and all counts stay valid after this bit flip.
    bytes.writeUInt16LE(0, ids + 63 * 2);
    writeFileSync(file, bytes);
    expect(readLabels(file, 'src1')).toBeNull();
});

test('malformed cache headers and incomplete or extra payloads are cache misses', () => {
    const file = join(directory, 'header.bin');
    writeLabels(file, 'src1', grid(false));
    const bytes = readFileSync(file), length = bytes.readUInt32LE(0);
    const header = JSON.parse(bytes.subarray(4, 4 + length).toString()), payload = bytes.subarray(4 + length);
    for (const change of [
        { n: -1 }, { n: 1.5 }, { n: null }, { n: Number.MAX_SAFE_INTEGER },
        { areas: -1 }, { areas: 1.5 }, { areas: 0xffff }, { areas: null },
        { tiles: -1 }, { tiles: 1.5 }, { tiles: 65 }, { tiles: null }, { sha256: undefined },
    ]) {
        const json = Buffer.from(JSON.stringify({ ...header, ...change })), prefix = Buffer.alloc(4);
        prefix.writeUInt32LE(json.length);
        writeFileSync(file, Buffer.concat([prefix, json, payload]));
        expect(readLabels(file, 'src1')).toBeNull();
    }
    for (const bad of [bytes.subarray(0, 3), bytes.subarray(0, 4 + length - 1),
        bytes.subarray(0, bytes.length - 128), Buffer.concat([bytes, Buffer.alloc(2)])]) {
        writeFileSync(file, bad);
        expect(readLabels(file, 'src1')).toBeNull();
    }
});

test('invalid label ids, duplicate zones and inconsistent area counts cannot affect routing', () => {
    const file = join(directory, 'labels.bin');
    const g = labelAreas([[0, 0, 0], [0, 8, 0]], () => true,
        (_l, x, _z, dx) => !(dx !== 0 && Math.min(x, x + dx) === 7));
    writeLabels(file, 'src1', g);
    const bytes = readFileSync(file), at = 4 + bytes.readUInt32LE(0), ids = at + g.zones.size * 4;
    const invalid = Buffer.from(bytes); invalid.writeUInt16LE(g.areas, ids);
    const missing = Buffer.from(bytes); missing.writeUInt16LE(0xffff, ids);
    const duplicate = Buffer.from(bytes); duplicate.writeInt32LE(duplicate.readInt32LE(at), at + 4);
    const unused = Buffer.from(bytes); unused.fill(0, ids);
    for (const bad of [invalid, missing, duplicate, unused]) {
        // Keep a matching checksum so the semantic validation is exercised independently.
        const payload = bad.subarray(at), header = JSON.parse(bad.subarray(4, at).toString());
        header.sha256 = createHash('sha256').update(payload).digest('hex');
        const json = Buffer.from(JSON.stringify(header)), prefix = Buffer.alloc(4); prefix.writeUInt32LE(json.length);
        writeFileSync(file, Buffer.concat([prefix, json, payload]));
        expect(readLabels(file, 'src1')).toBeNull();
    }
});

test('the flat labels answer like a map of zones, for zones, gaps and tiles that no zone holds', () => {
    // Zones at three levels and far apart, so the hash table has to place keys that share slots; one zone is all wall.
    const origins: [number, number, number][] = [[0, 0, 0], [0, 8, 0], [1, 8, 8], [2, 3000, 3200], [3, 16384 - 8, 16384 - 8]];
    const open = (l: number, x: number) => !(l === 1 && x < 12);
    const g = labelAreas(origins, (l, x) => open(l, x), (l, x, _z, dx) => open(l, x + dx));
    expect(g.zones.size).toBe(5);
    expect([...g.zones.keys()].length).toBe(5);
    expect(g.area(0, 3, 3)).toBeGreaterThanOrEqual(0);
    expect(g.area(1, 9, 9)).toBe(-1);                 // in a zone, not walkable
    expect(g.area(1, 13, 13)).toBeGreaterThanOrEqual(0);
    expect(g.area(2, 3001, 3201)).toBeGreaterThanOrEqual(0);
    for (const [l, x, z] of [[0, -1, -1], [0, 16, 0], [1, 0, 0], [3, 100, 100], [0, 5000, 5000], [2, -9, 3200]] as const) expect(g.area(l, x, z)).toBe(-2);
    const file = join(directory, 'flat.bin');
    writeLabels(file, 'flat', g);
    const back = readLabels(file, 'flat')!;
    expect(back.zones.size).toBe(5);
    for (const [l, x, z] of [[0, 3, 3], [1, 9, 9], [1, 13, 13], [2, 3001, 3201], [0, -1, -1], [0, 16, 0], [3, 16380, 16380]] as const) expect(back.area(l, x, z)).toBe(g.area(l, x, z));
});

test('the flat labels give the answers of a Map of zone arrays for 20,000 sampled tiles, on a table with many shared slots', () => {
    // 3,000 zones of three levels: the table holds 8,192 slots, so keys share slots and the probe loop runs often.
    const origins: [number, number, number][] = [];
    for (let l = 0; l < 3; l++) for (let i = 0; i < 1000; i++) origins.push([l, 8 * (i % 40), 8 * ((i / 40) | 0) + 1600 * l]);
    const open = (x: number, z: number) => ((x * 31 + z * 17) & 7) !== 0;
    const g = labelAreas(origins, (_l, x, z) => open(x, z), (_l, x, z, dx, dz) => open(x + dx, z + dz));
    const file = join(directory, 'sampled.bin');
    writeLabels(file, 'sampled', g);
    const back = readLabels(file, 'sampled')!;
    // The reference is the structure that the labels replace: a Map from the zone key to its own array of 64 labels.
    const key = (l: number, x: number, z: number) => (l << 28) | ((x >> 3) << 14) | (z >> 3);
    const reference = new Map<number, number[]>();
    [...g.zones.keys()].forEach((k, i) => reference.set(k, Array.from(g.cells.subarray(i * 64, i * 64 + 64), v => (v === 0xffff || v < 0 ? -1 : v))));
    const expected = (l: number, x: number, z: number) => { const zone = reference.get(key(l, x, z)); return zone ? zone[((x & 7) << 3) | (z & 7)]! : -2; };
    let seed = 12345, inMap = 0, outside = 0;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (let n = 0; n < 20000; n++) {
        // Half of the samples fall inside a zone of the map (a tile of it, or one tile beside it), half anywhere.
        const [zl, zx, zz] = origins[next() % origins.length]!;
        const near = n % 2 === 0, l = near ? zl : next() % 4, x = near ? zx + (next() % 10) - 1 : (next() % 400) - 20, z = near ? zz + (next() % 10) - 1 : (next() % 3600) - 20;
        const want = expected(l, x, z);
        expect(back.area(l, x, z)).toBe(want);
        expect(g.area(l, x, z)).toBe(want);
        if (want === -2) outside++; else inMap++;
    }
    expect(inMap).toBeGreaterThan(1000);
    expect(outside).toBeGreaterThan(1000);
    expect(g.zones.size).toBe(3000);
    expect(back.zones.size).toBe(3000);
});

test('SharedArrayBuffer-backed labels preserve area and separated checks across attachSharedLabels', async () => {
    const { attachSharedLabels, shareLabels } = await import('../src/components');
    const g = grid(false);
    const shared = shareLabels(g);
    expect(shared).not.toBeNull();
    const attached = attachSharedLabels(shared!);
    expect(attached.areas).toBe(g.areas);
    expect(attached.tiles).toBe(g.tiles);
    expect(attached.zones.size).toBe(g.zones.size);
    for (let x = -1; x < 9; x++) for (let z = 0; z < 8; z++) expect(attached.area(0, x, z)).toBe(g.area(0, x, z));
    expect(separated(attached, { level: 0, x: 1, z: 1 }, { level: 0, x: 6, z: 1 }, 0)).toBe(true);
    expect(separated(attached, { level: 0, x: 1, z: 1 }, { level: 0, x: 2, z: 5 }, 0)).toBe(false);
    // Unwalkable start tile (returns -1) counts walkable neighbours cleanly without Set allocations.
    const walled = labelAreas([[0, 0, 0]], (_l, x, z) => !(x === 0 && z === 0),
        (_l, x, z, dx) => !(x === 0 && z === 0) && !(x + dx === 0 && z === 0) && !(dx !== 0 && Math.min(x, x + dx) === 3));
    expect(separated(walled, { level: 0, x: 0, z: 0 }, { level: 0, x: 2, z: 2 }, 0)).toBe(false);
    expect(separated(walled, { level: 0, x: 0, z: 0 }, { level: 0, x: 6, z: 2 }, 0)).toBe(true);
});
