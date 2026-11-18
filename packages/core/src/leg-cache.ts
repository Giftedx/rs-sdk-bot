// Walk lengths the route search has measured, kept on disk across processes. A length depends only on the
// collision map, the doors kept shut and the closed danger ground, so the key holds all three and the file is
// tied to the pathfinder wasm, collision data and npc data it was measured with. Most route-search time is
// spent measuring the same legs between fixed stairs, docks and transports again; with this file only new
// legs cost a search.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { pathfindingSourceKey } from './pathcache';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
// The file name holds the format of the keys: v2 keys name the closed danger ground alone (danger.ts withDanger).
// Rows of the first format were kept under the start and end tile of each trip, are never read again, and had grown
// to 1.5 GB in one checkout. A process that opens the v2 file removes the files of the first format when no other
// process holds them, and the rows that another collision map or npc file measured.
export const LEG_CACHE_FILE = join(repoRoot, '.practice', 'cache', 'route-legs-v2.sqlite');
const SUPERSEDED = /^route-legs\.(?:sqlite(?:-wal|-shm)?|json(?:\..*\.tmp)?)$/;
// Removes the cache files of the first key format beside `file`. Returns the names it removed. A file that another
// process holds stays (Windows refuses the delete) and goes at a later open.
export function removeSupersededLegFiles(file = LEG_CACHE_FILE): string[] {
    const removed: string[] = [];
    try {
        for (const name of readdirSync(dirname(file))) {
            if (!SUPERSEDED.test(name)) continue;
            try { rmSync(join(dirname(file), name)); removed.push(name); } catch { /* held by a process of an older release */ }
        }
    } catch { /* no cache folder yet */ }
    return removed;
}
const LEGACY_READ_LIMIT = 16 * 2 ** 20;
type File = { source: string; legs: Record<string, number | null> };

export interface LegCache {
    has(k: string): boolean;
    get(k: string): number | null | undefined;
    set(k: string, v: number | null): void;
    hash(value: unknown): string;
    // Persist only this writer's new measurements.
    save(): void;
    close(): void;
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
    const namespace = createHash('sha256').update(src).digest('base64url');
    const legacyFile = file.replace(/\.sqlite$/, '.json');
    const legacy = (): Record<string, number | null> => {
        try {
            if (legacyFile !== file && statSync(legacyFile).size <= LEGACY_READ_LIMIT) {
                const old = JSON.parse(readFileSync(legacyFile, 'utf8')) as File;
                if (old.source === src && old.legs && typeof old.legs === 'object' && !Array.isArray(old.legs)) return Object.setPrototypeOf(old.legs, null);
            }
        } catch { /* A missing or corrupt cache is optional. */ }
        return Object.create(null);
    };
    const old = legacy(), fresh = new Map<string, number | null>();
    const open = () => {
        let connection: Database | undefined;
        try {
            mkdirSync(dirname(file), { recursive: true });
            connection = new Database(file);
            connection.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS legs (source TEXT, key TEXT, value INTEGER, PRIMARY KEY (source, key)) WITHOUT ROWID');
            return connection;
        } catch { connection?.close(); return undefined; }
    };
    // ROUTE_LEG_CACHE=0: this process reads and writes no saved lengths, so each search measures its legs (a run with
    // empty caches, for the check that a bench case gives the same ticks with empty and with full caches).
    const stored = process.env.ROUTE_LEG_CACHE !== '0';
    let db = stored && existsSync(file) ? open() : undefined;
    // The shared store only: one checkout has one collision map, so rows of another source are of an older map.
    if (stored && file === LEG_CACHE_FILE && source === undefined) {
        removeSupersededLegFiles(file);
        try { if (db?.query('SELECT 1 FROM legs WHERE source < ?1 OR source > ?1 LIMIT 1').get(namespace)) db.query('DELETE FROM legs WHERE source < ?1 OR source > ?1').run(namespace); } catch { /* another process prunes, or the store is busy */ }
    }
    const get = (key: string) => {
        if (fresh.has(key)) return fresh.get(key);
        try {
            const row = db?.query<{ value: number | null }, [string, string]>('SELECT value FROM legs WHERE source = ? AND key = ?').get(namespace, key);
            if (row) return row.value;
        } catch { /* Compute the leg when the cache is unavailable. */ }
        return stored ? old[key] : undefined;
    };
    const c: LegCache = {
        has: k => get(k) !== undefined,
        get,
        set: (k, v) => { fresh.set(k, v); },
        hash: value => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12),
        save: () => {
            if (!fresh.size || !stored) return;
            const connection = db ??= open();
            if (!connection) return;
            try {
                const put = connection.query('INSERT OR REPLACE INTO legs VALUES (?, ?, ?)');
                connection.transaction(() => { for (const [key, value] of fresh) put.run(namespace, key, value); })();
                fresh.clear();
            } catch { /* A busy or full store leaves these measurements available for retry. */ }
        },
        close: () => { db?.close(); db = undefined; if (shared === c) shared = undefined; },
    };
    if (file === LEG_CACHE_FILE && source === undefined) shared = c;
    return c;
}
