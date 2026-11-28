import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

const MAGIC = 0x4c4f4331; // 'LOC1'
const INDEX_FORMAT_VERSION = 2;
const LAYER_COUNT = 4;
const SECTION_COUNT = LAYER_COUNT + 1;
const FLAGS_SECTION = LAYER_COUNT;
const PAGE_ENTRIES = 1024;
const CHUNK_PAGES = 16;
const MAX_CACHED_PAGES = 64;
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

interface PagedSection {
    count: number;
    keysOffset: number;
    valuesOffset: number;
    firstKeys: Int32Array;
}

interface PageData {
    keys: Int32Array;
    values: Int32Array;
}

export interface LocIndexLike {
    readonly size: number;
    lookup(layer: number, level: number, worldX: number, worldZ: number): number;
    mapFlags(level: number, worldX: number, worldZ: number): number;
}

function packKey(level: number, x: number, z: number): number {
    return ((level & 0x3) << 28) | ((x & 0x3fff) << 14) | (z & 0x3fff);
}

function readExact(fd: number, dst: Uint8Array, length: number, position: number): boolean {
    let done = 0;
    while (done < length) {
        const n = readSync(fd, dst, done, length - done, position + done);
        if (n <= 0) return false;
        done += n;
    }
    return true;
}

function readPage(path: string, sec: PagedSection, pageIdx: number): PageData {
    const startEntry = pageIdx * PAGE_ENTRIES;
    const entryCount = Math.min(PAGE_ENTRIES, sec.count - startEntry);
    const byteLen = entryCount * 4;
    const ab = new ArrayBuffer(byteLen * 2);
    const keysBytes = new Uint8Array(ab, 0, byteLen);
    const valuesBytes = new Uint8Array(ab, byteLen, byteLen);
    const fd = openSync(path, 'r');
    try {
        if (!readExact(fd, keysBytes, byteLen, sec.keysOffset + startEntry * 4)
            || !readExact(fd, valuesBytes, byteLen, sec.valuesOffset + startEntry * 4)) {
            throw new Error(`locindex short read at page ${pageIdx}`);
        }
    } finally {
        closeSync(fd);
    }
    if (IS_LITTLE_ENDIAN) {
        return {
            keys: new Int32Array(ab, 0, entryCount),
            values: new Int32Array(ab, byteLen, entryCount),
        };
    }
    const view = new DataView(ab);
    const keys = new Int32Array(entryCount);
    const values = new Int32Array(entryCount);
    for (let i = 0; i < entryCount; i++) {
        keys[i] = view.getInt32(i * 4, true);
        values[i] = view.getInt32(byteLen + i * 4, true);
    }
    return { keys, values };
}

/**
 * Opens an existing `locindex-<crc>.bin` cache file as a paged on-disk LocIndex.
 * Keeps only a ~7 KB first-key page directory plus a bounded LRU of 64 pages (<= 512 KiB)
 * instead of reading and copying the full 14 MB world index into JS heap.
 */
export function openPagedLocIndex(path: string, proto?: object, maxPages = MAX_CACHED_PAGES): LocIndexLike | null {
    if (!existsSync(path)) return null;
    let fd: number;
    try { fd = openSync(path, 'r'); } catch { return null; }
    try {
        const fileSize = fstatSync(fd).size;
        if (fileSize < 8 + SECTION_COUNT * 4) return null;
        const header = new Uint8Array(8);
        if (!readExact(fd, header, 8, 0)) return null;
        const hView = new DataView(header.buffer);
        if (hView.getUint32(0, true) !== MAGIC || hView.getUint32(4, true) !== INDEX_FORMAT_VERSION) return null;

        const countBuf = new Uint8Array(4);
        const countView = new DataView(countBuf.buffer);
        const chunkBuf = new Uint8Array(CHUNK_PAGES * PAGE_ENTRIES * 4);
        const chunkView = new DataView(chunkBuf.buffer);
        const sections: PagedSection[] = [];
        let totalSize = 0;
        let offset = 8;

        for (let s = 0; s < SECTION_COUNT; s++) {
            if (offset + 4 > fileSize || !readExact(fd, countBuf, 4, offset)) return null;
            const count = countView.getUint32(0, true);
            offset += 4;
            const keysOffset = offset;
            const valuesOffset = keysOffset + count * 4;
            const endOffset = valuesOffset + count * 4;
            if (endOffset > fileSize) return null;

            const pageCount = Math.ceil(count / PAGE_ENTRIES);
            const firstKeys = new Int32Array(pageCount);
            for (let p = 0; p < pageCount; p += CHUNK_PAGES) {
                const pagesHere = Math.min(CHUNK_PAGES, pageCount - p);
                const entriesHere = Math.min(pagesHere * PAGE_ENTRIES, count - p * PAGE_ENTRIES);
                if (!readExact(fd, chunkBuf, entriesHere * 4, keysOffset + p * PAGE_ENTRIES * 4)) return null;
                for (let j = 0; j < pagesHere; j++) {
                    firstKeys[p + j] = chunkView.getInt32(j * PAGE_ENTRIES * 4, true);
                }
            }
            sections.push({ count, keysOffset, valuesOffset, firstKeys });
            totalSize += count;
            offset = endOffset;
        }
        if (offset !== fileSize) return null;

        const cache = new Map<number, PageData>();
        const pageCap = Math.max(1, maxPages);
        const getPage = (section: number, sec: PagedSection, pageIdx: number): PageData => {
            const cacheKey = (section << 20) | pageIdx;
            const hit = cache.get(cacheKey);
            if (hit) {
                cache.delete(cacheKey);
                cache.set(cacheKey, hit);
                return hit;
            }
            const loaded = readPage(path, sec, pageIdx);
            cache.set(cacheKey, loaded);
            if (cache.size > pageCap) {
                const oldest = cache.keys().next().value;
                if (oldest !== undefined) cache.delete(oldest);
            }
            return loaded;
        };

        const lookupSection = (section: number, level: number, worldX: number, worldZ: number): number => {
            const sec = sections[section];
            if (!sec || sec.count === 0) return 0;
            const key = packKey(level, worldX, worldZ);
            const firstKeys = sec.firstKeys;
            if (key < firstKeys[0]!) return 0;
            let lo = 0;
            let hi = firstKeys.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >>> 1;
                if (firstKeys[mid]! <= key) lo = mid;
                else hi = mid - 1;
            }
            const page = getPage(section, sec, lo);
            let pLo = 0;
            let pHi = page.keys.length - 1;
            while (pLo <= pHi) {
                const mid = (pLo + pHi) >>> 1;
                const probe = page.keys[mid]!;
                if (probe === key) return page.values[mid]!;
                if (probe < key) pLo = mid + 1;
                else pHi = mid - 1;
            }
            return 0;
        };

        const instance = (proto ? Object.create(proto) : {}) as Record<string, unknown>;
        Object.defineProperty(instance, 'size', { get: () => totalSize, enumerable: true, configurable: true });
        instance.lookup = (layer: number, level: number, worldX: number, worldZ: number) => lookupSection(layer, level, worldX, worldZ);
        instance.mapFlags = (level: number, worldX: number, worldZ: number) => lookupSection(FLAGS_SECTION, level, worldX, worldZ);
        return instance as unknown as LocIndexLike;
    } catch {
        return null;
    } finally {
        closeSync(fd);
    }
}

// The web client builds a world loc index (14 to 31 MB, read only; LocIndex.ts says it is meant to be shared) for
// each session start and each reconnect (lite/session.ts calls LocIndex.load at both). This keeps one paged index
// per cache path and versionlist CRC in the process: sessions share it, a reconnect does not build a second copy,
// and reading on-demand pages avoids retaining the full 14 MB world array in RAM. Only the newest key stays, so a
// game update does not keep the old index. The SDK file is unchanged; this wraps its static `load` once per process.
export async function shareLocIndex(): Promise<void> {
    const mod: any = await import(join(repoRoot, 'vendor', 'rs-sdk', 'server', 'webclient', 'src', 'lite', 'world', 'LocIndex.ts'));
    const L = mod.LocIndex;
    if (L.__hostShared) return;
    const orig = L.load.bind(L);
    const memo = new Map<string, Promise<unknown>>();
    L.load = (opts: { cacheDir: string; versionlistCrc: number }) => {
        const crc = opts.versionlistCrc >>> 0;
        const k = `${opts.cacheDir}|${crc}`;
        const hit = memo.get(k);
        if (hit) return hit;
        const cachePath = `${opts.cacheDir}/locindex-${crc}.bin`;
        const paged = openPagedLocIndex(cachePath, L.prototype);
        const p: Promise<unknown> = paged
            ? Promise.resolve(paged)
            : Promise.resolve(orig(opts)).then((built: unknown) => openPagedLocIndex(cachePath, L.prototype) ?? built);
        for (const other of [...memo.keys()]) memo.delete(other);
        memo.set(k, p);
        p.catch(() => { if (memo.get(k) === p) memo.delete(k); });
        return p;
    };
    L.__hostShared = true;
}
