import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// rs-sdk's initPathfinding() costs about 14 s per process: 12.8 s of it is allocateIfAbsent for 136,704 zones in
// rsmod's wasm memory (measured 2026-10-22). Every proof run and every bot process paid it. This saves that wasm
// memory once after a cold build and copies it back into a fresh instance before initPathfinding() runs. The
// zones are then already present, so allocateIfAbsent returns at once; __set and the door unmasking are
// idempotent and rebuild pathfinding.ts's own JS-side door index. The snapshot is keyed on the wasm and
// collision-data files, so an rs-sdk update rebuilds it.

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const vendor = (p: string) => join(repoRoot, 'vendor', 'rs-sdk', p);
const WASM = vendor('server/vendor/rsmod-pathfinder/rsmod_bg.wasm');
const DATA = vendor('sdk/collision-data.json');
export const DEFAULT_CACHE = join(repoRoot, '.practice', 'cache', 'rsmod-pathfinding.snap');

function key(): string {
    const w = statSync(WASM);
    const d = statSync(DATA);
    return JSON.stringify({ v: 1, wasm: [w.size, Math.floor(w.mtimeMs)], data: [d.size, Math.floor(d.mtimeMs)] });
}

let loaded: Promise<{ restored: boolean; ms: number }> | null = null;

export function loadPathfinding(opts: { cacheFile?: string } = {}): Promise<{ restored: boolean; ms: number }> {
    loaded ??= load(opts.cacheFile ?? DEFAULT_CACHE);
    return loaded;
}

async function load(file: string): Promise<{ restored: boolean; ms: number }> {
    const t0 = Date.now();
    // Same specifier as sdk/pathfinding.ts imports, so this is the same module instance and the same wasm memory.
    const rsmod: any = await import(vendor('server/vendor/rsmod-pathfinder/rsmod-pathfinder.js'));
    const memory: WebAssembly.Memory = rsmod.__wasm.memory;
    const k = key();
    let restored = false;
    if (existsSync(file)) {
        const buf = readFileSync(file);
        const headLen = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
        const snap = buf.subarray(4 + headLen);
        // The key holds the memory length, so a cut-off file (seen: three runs wrote it at once) never matches.
        if (headLen > 0 && buf.subarray(4, 4 + headLen).toString('utf8') === `${k}:${snap.length}`) {
            const page = 65536;
            const need = Math.ceil(snap.length / page) - memory.buffer.byteLength / page;
            if (need > 0) memory.grow(need);
            new Uint8Array(memory.buffer).set(snap);
            restored = true;
        }
    }
    const { initPathfinding } = await import(vendor('sdk/pathfinding.ts'));
    initPathfinding();
    if (!restored) {
        const mem = Buffer.from(new Uint8Array(memory.buffer));
        const head = Buffer.from(`${k}:${mem.length}`, 'utf8');
        const len = Buffer.alloc(4);
        len.writeUInt32LE(head.length, 0);
        mkdirSync(dirname(file), { recursive: true });
        // Write then rename, so a reader never sees a half-written file.
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, Buffer.concat([len, head, mem]));
        renameSync(tmp, file);
    }
    return { restored, ms: Date.now() - t0 };
}
