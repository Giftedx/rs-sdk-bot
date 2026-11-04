// Walk lengths the route search has measured, kept on disk across processes. A length depends only on the
// collision map, the doors kept shut and the closed danger ground, so the key holds all three and the file is
// tied to the pathfinder wasm, collision data and npc data it was measured with. Most route-search time is
// spent measuring the same legs between fixed stairs, docks and transports again; with this file only new
// legs cost a search.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { dirname, join, resolve } from 'node:path';
import { pathfindingSourceKey } from './pathcache';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
export const LEG_CACHE_FILE = join(repoRoot, '.practice', 'cache', 'route-legs.json');
type File = { source: string; legs: Record<string, number | null> };

export interface LegCache {
    has(k: string): boolean;
    get(k: string): number | null | undefined;
    set(k: string, v: number | null): void;
    hash(value: unknown): string;
    // Writes new legs, merged with what other processes wrote since this one read the file.
    save(): void;
}

// The final route endpoint is opened by the danger mask, even when it is not
// an endpoint of a particular cached walk leg. Include every opened tile.
export function routeDangerHash(danger:{key:string;kept:ReadonlySet<string>},cache:Pick<LegCache,'hash'>):string{
    return cache.hash([danger.key,[...danger.kept].sort()]);
}

let shared: LegCache | undefined;
export function legCache(file = LEG_CACHE_FILE, source?: string): LegCache {
    if (shared && file === LEG_CACHE_FILE && source === undefined) return shared;
    const src = source ?? pathfindingSourceKey() + ':' + createHash('sha256').update(readFileSync(join(repoRoot, 'knowledge', 'npcs.json'))).digest('hex');
    const read = (): Record<string, number | null> => {
        try { const f = JSON.parse(readFileSync(file, 'utf8')) as File; return f.source === src && f.legs && typeof f.legs === 'object' && !Array.isArray(f.legs) ? Object.setPrototypeOf(f.legs, null) : Object.create(null); } catch { return Object.create(null); }
    };
    const legs = read(), fresh = new Map<string, number | null>();
    const c: LegCache = {
        has: k => Object.hasOwn(legs, k),
        get: k => legs[k],
        set: (k, v) => { legs[k] = v; fresh.set(k, v); },
        hash: value => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12),
        save: () => {
            if (!fresh.size) return;
            const merged = { ...read(), ...Object.fromEntries(fresh) };
            // The route worker shares the process id: the thread id and a random part keep temp names apart.
            const tmp = `${file}.${process.pid}.${threadId}.${Math.random().toString(36).slice(2, 8)}.tmp`;
            try {
                if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
                writeFileSync(tmp, JSON.stringify({ source: src, legs: merged } satisfies File));
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOSPC') throw e;
                // Optional cache storage must not replace a computed route with an error.
                // Keep fresh legs for a later save and remove only this save's partial file.
                try { rmSync(tmp, { force: true }); } catch {}
                return;
            }
            // Windows refuses the rename while another bot reads the file (EPERM). The cache is an optimization:
            // retry briefly, then keep the legs for the next save instead of failing the walk.
            for (let i = 0; ; i++) {
                try { renameSync(tmp, file); break; }
                catch (e) {
                    if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) { try { rmSync(tmp, { force: true }); } catch {} return; }
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
                }
            }
            fresh.clear();
        },
    };
    if (file === LEG_CACHE_FILE && source === undefined) shared = c;
    return c;
}
