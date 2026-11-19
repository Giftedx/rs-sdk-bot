import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BUNZIP_KEEP_FILES, BUNZIP_MIN_BYTES, cachedBunzipSource } from '../src/bunzip-cache';

// A stand-in for the vendor function: it counts its calls and returns the input reversed.
const vendor = 'export function bunzip2(bytes, checkMagic = false, checkCRC = false) { globalThis.__bzCalls = (globalThis.__bzCalls ?? 0) + 1; return Uint8Array.from(bytes).reverse(); }\n';
const load = async (dir: string, name: string) => {
    const file = join(dir, `${name}.mjs`);
    writeFileSync(file, cachedBunzipSource(vendor, dir));
    return await import(file);
};
const calls = () => (globalThis as { __bzCalls?: number }).__bzCalls ?? 0;
const bytes = (seed: number, n = BUNZIP_MIN_BYTES + 5) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 255);

test('an archive unpacks once: the next call reads the kept bytes, a damaged file unpacks again, a small input is not kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunzip-')), prior = process.env.BUNZIP_CACHE_DIR;
    process.env.BUNZIP_CACHE_DIR = dir;
    try {
        const mod = await load(dir, 'a'), input = bytes(1), want = Uint8Array.from(input).reverse();
        const start = calls();
        expect(mod.bunzip2(input)).toEqual(want);
        expect(calls() - start).toBe(1);
        expect(readdirSync(dir).filter(f => f.endsWith('.bin'))).toHaveLength(1);
        expect(mod.bunzip2(input)).toEqual(want);
        expect(calls() - start).toBe(1);
        // The flags are part of the key.
        expect(mod.bunzip2(input, true)).toEqual(want);
        expect(calls() - start).toBe(2);
        // A damaged entry runs the vendor function and is written again.
        for (const f of readdirSync(dir).filter(f => f.endsWith('.bin'))) {
            const stored = readFileSync(join(dir, f));
            stored[stored.length - 1]! ^= 1;
            writeFileSync(join(dir, f), stored);
        }
        expect(mod.bunzip2(input)).toEqual(want);
        expect(calls() - start).toBe(3);
        expect(mod.bunzip2(input)).toEqual(want);
        expect(calls() - start).toBe(3);
        // Under the minimum: no file.
        const files = readdirSync(dir).length;
        mod.bunzip2(new Uint8Array([1, 2, 3]));
        expect(readdirSync(dir)).toHaveLength(files);
    } finally { if (prior === undefined) delete process.env.BUNZIP_CACHE_DIR; else process.env.BUNZIP_CACHE_DIR = prior; }
});

test('the cache keeps the newest entries only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunzip-')), prior = process.env.BUNZIP_CACHE_DIR;
    process.env.BUNZIP_CACHE_DIR = dir;
    try {
        const mod = await load(dir, 'b');
        for (let i = 0; i < BUNZIP_KEEP_FILES + 4; i++) {
            mod.bunzip2(bytes(i + 10));
            for (const f of readdirSync(dir).filter(f => f.endsWith('.bin'))) { const t = new Date(Date.now() + i * 1000); utimesSync(join(dir, f), t, t); }
        }
        expect(readdirSync(dir).filter(f => f.endsWith('.bin'))).toHaveLength(BUNZIP_KEEP_FILES);
    } finally { if (prior === undefined) delete process.env.BUNZIP_CACHE_DIR; else process.env.BUNZIP_CACHE_DIR = prior; }
});

test('the preload serves the vendor module: bunzip2 gives the same bytes as bunzip2Raw for a real bzip2 stream', async () => {
    const probe = Bun.spawnSync(['bzip2', '--help'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true }).exitCode;
    if (probe === undefined || probe === null || probe > 1) return; // no system bzip2 here
    const dir = mkdtempSync(join(tmpdir(), 'bunzip-')), raw = join(dir, 'in.txt');
    let seed = 7;
    writeFileSync(raw, Buffer.from('interface text '.repeat(500) + Array.from({ length: 60000 }, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 9973).join(',')));
    const packed = Bun.spawnSync(['bzip2', '-9', '-c', raw], { stdout: 'pipe', windowsHide: true }).stdout;
    const mod: any = await import('../../../vendor/rs-sdk/server/webclient/src/io/BZip2.js');
    expect(typeof mod.bunzip2Raw).toBe('function');
    const prior = process.env.BUNZIP_CACHE_DIR;
    process.env.BUNZIP_CACHE_DIR = join(dir, 'cache');
    try {
        const input = new Uint8Array(packed);
        const want = mod.bunzip2Raw(input, true);
        expect(Buffer.from(want).equals(readFileSync(raw))).toBe(true);
        expect(Buffer.from(mod.bunzip2(input, true)).equals(Buffer.from(want))).toBe(true);
        expect(Buffer.from(mod.bunzip2(input, true)).equals(Buffer.from(want))).toBe(true);
        expect(readdirSync(join(dir, 'cache')).filter(f => f.endsWith('.bin'))).toHaveLength(1);
    } finally { if (prior === undefined) delete process.env.BUNZIP_CACHE_DIR; else process.env.BUNZIP_CACHE_DIR = prior; }
});
