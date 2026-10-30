// Walk lengths the route search has measured, kept on disk across processes. A length depends only on the
// collision map, the doors kept shut and the closed danger ground, so the key holds all three and the file is
// tied to the pathfinder wasm, collision data and npc data it was measured with. Most route-search time is
// spent measuring the same legs between fixed stairs, docks and transports again; with this file only new
// legs cost a search.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

let shared: LegCache | undefined;
export function legCache(file = LEG_CACHE_FILE, source?: string): LegCache {
    if (shared && file === LEG_CACHE_FILE && source === undefined) return shared;
    const src = source ?? pathfindingSourceKey() + ':' + createHash('sha256').update(readFileSync(join(repoRoot, 'knowledge', 'npcs.json'))).digest('hex');
    const read = (): Record<string, number | null> => {
        try { const f = JSON.parse(readFileSync(file, 'utf8')) as File; return f.source === src ? f.legs : {}; } catch { return {}; }
    };
    const legs = new Map(Object.entries(read())), fresh = new Map<string, number | null>();
    const c: LegCache = {
        has: k => legs.has(k),
        get: k => legs.get(k),
        set: (k, v) => { legs.set(k, v); fresh.set(k, v); },
        hash: value => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12),
        save: () => {
            if (!fresh.size) return;
            const merged = { ...read(), ...Object.fromEntries(fresh) };
            if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify({ source: src, legs: merged } satisfies File));
            renameSync(tmp, file);
            fresh.clear();
        },
    };
    if (file === LEG_CACHE_FILE && source === undefined) shared = c;
    return c;
}
