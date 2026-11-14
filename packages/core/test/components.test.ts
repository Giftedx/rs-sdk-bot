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
