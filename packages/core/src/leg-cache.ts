// Walk lengths the route search has measured, kept on disk across processes. A length depends only on the
// collision map, the doors kept shut and the closed danger ground, so the key holds all three and the file is
// tied to the pathfinder wasm, collision data and npc data it was measured with. Most route-search time is
// spent measuring the same legs between fixed stairs, docks and transports again; with this file only new
// legs cost a search.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { pathfindingDataKey } from './pathcache';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
// The file name holds the format of the keys: v2 keys name the closed danger ground alone (danger.ts withDanger).
// The first file (route-legs.sqlite) holds one set of rows for each start and end tile of a trip, so it has no size
// bound. A row of it whose key a search asks for is right, because a key names the closed ground exactly in both
// formats. The first file is read, never written: a length found in it is copied into the v2 file. The first file
// is removed when nothing wrote it for PRIOR_KEEP_MS (no process of a release before v2 runs). Its JSON form and
// temporary files, which no code reads, are removed at an open.
export const LEG_CACHE_FILE = join(repoRoot, '.practice', 'cache', 'route-legs-v2.sqlite');
export const PRIOR_KEEP_MS = 7 * 24 * 3_600_000;
const PRIOR = 'route-legs.sqlite', UNREAD = /^route-legs\.json(?:\..*\.tmp)?$/;
// Removes the superseded cache files beside `file`. Returns the names it removed. A file that another process holds
// stays (Windows refuses the delete) and goes at a later open.
export function removeSupersededLegFiles(file = LEG_CACHE_FILE, now = Date.now()): string[] {
    const removed: string[] = [], dir = dirname(file);
    const remove = (name: string) => { try { rmSync(join(dir, name)); removed.push(name); } catch { /* held by another process */ } };
    try {
        const names = readdirSync(dir);
        for (const name of names) if (UNREAD.test(name)) remove(name);
        const written = (name: string) => { try { return statSync(join(dir, name)).mtimeMs; } catch { return 0; } };
        // The write-ahead file holds the newest writes of a store in WAL mode.
        if (names.includes(PRIOR) && now - Math.max(written(PRIOR), written(PRIOR + '-wal')) >= PRIOR_KEEP_MS) for (const name of [PRIOR + '-wal', PRIOR + '-shm', PRIOR]) if (names.includes(name)) remove(name);
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
    const src = source ?? pathfindingDataKey() + ':' + createHash('sha256').update(readFileSync(join(repoRoot, 'knowledge', 'npcs.json'))).digest('hex');
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
    const READ_MEMO_LIMIT = 100_000;
    const readMemo = new Map<string, number | null>();
    type GetStmt = { get(namespace: string, key: string): { value: number | null } | null };
    let dbGetStmt: GetStmt | undefined;
    let priorGetStmt: GetStmt | undefined;
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
    // The first file, read only, beside a v2 store (see LEG_CACHE_FILE).
    let prior: Database | undefined;
    if (stored && /-v2\.sqlite$/.test(file)) {
        removeSupersededLegFiles(file);
        const first = join(dirname(file), PRIOR);
        try { if (existsSync(first)) prior = new Database(first, { readonly: true }); } catch { prior = undefined; }
    }
    // The shared store only: one checkout has one collision map, so rows of another source are of an older map.
    if (stored && file === LEG_CACHE_FILE && source === undefined) {
        try { if (db?.query('SELECT 1 FROM legs WHERE source < ?1 OR source > ?1 LIMIT 1').get(namespace)) db.query('DELETE FROM legs WHERE source < ?1 OR source > ?1').run(namespace); } catch { /* another process prunes, or the store is busy */ }
    }
    const rememberRead = (key: string, value: number | null) => {
        if (readMemo.size >= READ_MEMO_LIMIT) readMemo.clear();
        readMemo.set(key, value);
    };
    const get = (key: string) => {
        if (fresh.has(key)) return fresh.get(key);
        if (readMemo.has(key)) return readMemo.get(key);
        try {
            if (db && !dbGetStmt) dbGetStmt = db.query<{ value: number | null }, [string, string]>('SELECT value FROM legs WHERE source = ? AND key = ?');
            const row = dbGetStmt?.get(namespace, key);
            if (row) { rememberRead(key, row.value); return row.value; }
        } catch { /* Compute the leg when the cache is unavailable. */ }
        try {
            if (prior && !priorGetStmt) priorGetStmt = prior.query<{ value: number | null }, [string, string]>('SELECT value FROM legs WHERE source = ? AND key = ?');
            const row = priorGetStmt?.get(namespace, key);
            if (row) { fresh.set(key, row.value); rememberRead(key, row.value); return row.value; } // the next save writes it into the v2 file
        } catch { /* The first file is optional. */ }
        return stored ? old[key] : undefined;
    };
    const c: LegCache = {
        has: k => get(k) !== undefined,
        get,
        set: (k, v) => { fresh.set(k, v); rememberRead(k, v); },
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
        close: () => { dbGetStmt = undefined; priorGetStmt = undefined; readMemo.clear(); db?.close(); db = undefined; prior?.close(); prior = undefined; if (shared === c) shared = undefined; },
    };
    if (file === LEG_CACHE_FILE && source === undefined) shared = c;
    return c;
}
