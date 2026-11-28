import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openPagedLocIndex, shareLocIndex } from '../src/loc-index-share';

const packKey = (level: number, x: number, z: number) => ((level & 0x3) << 28) | ((x & 0x3fff) << 14) | (z & 0x3fff);

function writeLocIndexBin(path: string, sections: { keys: number[]; values: number[] }[]): void {
    let size = 8;
    for (const s of sections) size += 4 + s.keys.length * 8;
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x4c4f4331, true);
    view.setUint32(4, 2, true);
    let offset = 8;
    for (const s of sections) {
        view.setUint32(offset, s.keys.length, true);
        offset += 4;
        for (let i = 0; i < s.keys.length; i++) view.setInt32(offset + i * 4, s.keys[i]!, true);
        offset += s.keys.length * 4;
        for (let i = 0; i < s.values.length; i++) view.setInt32(offset + i * 4, s.values[i]!, true);
        offset += s.values.length * 4;
    }
    writeFileSync(path, bytes);
}

test('LocIndex.load builds one index for each cache path and versionlist CRC, keeps only the newest key, and retries after a failure', async () => {
    const mod: any = await import(join(resolve(import.meta.dir, '..', '..', '..'), 'vendor', 'rs-sdk', 'server', 'webclient', 'src', 'lite', 'world', 'LocIndex.ts'));
    const L = mod.LocIndex, realLoad = L.load, realFlag = L.__hostShared;
    let builds = 0, failNext = false;
    L.load = async () => { builds++; if (failNext) { failNext = false; throw Error('fixture failure'); } return { built: builds }; };
    L.__hostShared = false;
    try {
        await shareLocIndex();
        const o = { cacheDir: '/cache', versionlistCrc: 7 };
        const a = await L.load(o), b = await L.load({ ...o });
        expect(b).toBe(a); // a reconnect gets the same index
        expect(builds).toBe(1);
        expect(await L.load({ cacheDir: '/cache', versionlistCrc: 8 })).not.toBe(a); // a game update builds a new one
        expect(builds).toBe(2);
        await L.load(o); // the old key was dropped, so it builds again
        expect(builds).toBe(3);
        failNext = true;
        await expect(L.load({ cacheDir: '/cache', versionlistCrc: 9 })).rejects.toThrow('fixture failure');
        await L.load({ cacheDir: '/cache', versionlistCrc: 9 }); // a failure is not kept
        expect(builds).toBe(5);
        await shareLocIndex(); // a second call does not wrap again
        await L.load({ cacheDir: '/cache', versionlistCrc: 9 });
        expect(builds).toBe(5);
    } finally { L.load = realLoad; L.__hostShared = realFlag; }
});

test('openPagedLocIndex matches multi-page binary files bit-for-bit under LRU eviction and rejects corrupt files', async () => {
    const mod: any = await import(join(resolve(import.meta.dir, '..', '..', '..'), 'vendor', 'rs-sdk', 'server', 'webclient', 'src', 'lite', 'world', 'LocIndex.ts'));
    const dir = mkdtempSync(join(tmpdir(), 'locindex-paged-'));
    try {
        // Section 2 (GROUND) spans 3 pages (2,500 entries); section 4 (mapFlags) spans 2 pages (1,200 entries); section 1 is empty.
        const s0 = { keys: [packKey(0, 3200, 3200)], values: [(100 << 7) | (0 << 2) | 1] };
        const s1 = { keys: [] as number[], values: [] as number[] };
        const s2 = { keys: [] as number[], values: [] as number[] };
        for (let i = 0; i < 2500; i++) {
            const x = 3000 + Math.floor(i / 50), z = 3100 + (i % 50) * 2;
            s2.keys.push(packKey(0, x, z));
            s2.values.push(((500 + i) << 7) | ((10 & 0x1f) << 2) | (i & 3));
        }
        const s3 = { keys: [packKey(2, 3222, 3218)], values: [(999 << 7) | 2] };
        const s4 = { keys: [] as number[], values: [] as number[] };
        for (let i = 0; i < 1200; i++) {
            const x = 2800 + Math.floor(i / 40), z = 3000 + (i % 40) * 2;
            s4.keys.push(packKey(1, x, z));
            s4.values.push((i % 3) + 1);
        }
        const file = join(dir, 'locindex-42.bin');
        writeLocIndexBin(file, [s0, s1, s2, s3, s4]);

        // Force heavy LRU churn with maxPages = 2.
        const paged = openPagedLocIndex(file, mod.LocIndex.prototype, 2)!;
        expect(paged).not.toBeNull();
        expect(paged instanceof mod.LocIndex).toBe(true);
        expect(paged.size).toBe(s0.keys.length + s1.keys.length + s2.keys.length + s3.keys.length + s4.keys.length);
        expect(paged.lookup(0, 0, 3200, 3200)).toBe(s0.values[0]!);
        expect(paged.lookup(1, 0, 3200, 3200)).toBe(0);
        expect(paged.lookup(3, 2, 3222, 3218)).toBe(s3.values[0]!);

        // Verify page boundaries (0, 1023, 1024, 2047, 2048, 2499) and misses in reverse order to trigger evictions.
        for (const i of [0, 1023, 1024, 2047, 2048, 2499, 512, 1500, 0]) {
            const x = 3000 + Math.floor(i / 50), z = 3100 + (i % 50) * 2;
            expect(paged.lookup(2, 0, x, z)).toBe(s2.values[i]!);
            expect(paged.lookup(2, 0, x, z + 1)).toBe(0); // odd z is absent
        }
        expect(paged.lookup(2, 0, 2999, 3100)).toBe(0); // before first key
        expect(paged.lookup(2, 0, 3999, 3999)).toBe(0); // after last key
        for (const i of [0, 1023, 1024, 1199]) {
            const x = 2800 + Math.floor(i / 40), z = 3000 + (i % 40) * 2;
            expect(paged.mapFlags(1, x, z)).toBe(s4.values[i]!);
            expect(paged.mapFlags(1, x, z + 1)).toBe(0);
        }

        // Corrupt / truncated files return null so load() falls back to rebuilding.
        const badMagic = join(dir, 'bad.bin');
        writeFileSync(badMagic, new Uint8Array(64));
        expect(openPagedLocIndex(badMagic)).toBeNull();
        expect(openPagedLocIndex(join(dir, 'missing.bin'))).toBeNull();

        // shareLocIndex serves the paged index directly when the cache file exists.
        const L = mod.LocIndex, realLoad = L.load, realFlag = L.__hostShared;
        let origCalls = 0;
        L.load = async () => { origCalls++; return { fallback: true }; };
        L.__hostShared = false;
        try {
            await shareLocIndex();
            const loaded = await L.load({ cacheDir: dir, versionlistCrc: 42 });
            expect(origCalls).toBe(0);
            expect(loaded.lookup(2, 0, 3000, 3100)).toBe(s2.values[0]!);
            expect(loaded.size).toBe(paged.size);
        } finally { L.load = realLoad; L.__hostShared = realFlag; }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
