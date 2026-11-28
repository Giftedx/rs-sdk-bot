// Walk lengths the route search has measured, kept on disk across processes. A length depends only on the
// collision map and on the doors kept shut and the closed danger ground near the walk, so the key holds the walk and
// those changes (world/leg-key.ts), and the file is tied to the pathfinder wasm, collision data and npc data it was
// measured with. Most route-search time is spent measuring the same legs between fixed stairs, docks and transports
// again; with this file only new legs cost a search.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { pathfindingDataKey } from './pathcache';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
let npcsDigestCache: { stamp: string; digest: string } | null = null;
function npcsDigest(file: string): string {
    let stamp = 'missing';
    try { const st = statSync(file); stamp = `${st.size}:${st.mtimeMs}`; } catch { /* missing */ }
    if (npcsDigestCache && npcsDigestCache.stamp === stamp) return npcsDigestCache.digest;
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    npcsDigestCache = { stamp, digest };
    return digest;
}
// The file name holds the format of the keys: v3 keys name the walk and the changes near it (world/leg-key.ts). The
// v2 file (the prior store) keys a length by the whole scope (a hash of every shut door and of the danger ground), so
// a new quest step, key item or skill-door level measured every leg again. A row of it is right for a search of the
// same whole scope: the route search reads it by that key (`prior`) and copies it into v3 rows. The prior store is
// read, never written, and is removed when nothing wrote it for PRIOR_KEEP_MS (no process of a release before v3
// runs); so is the v1 file. Their JSON form and temporary files, which no code reads, are removed at an open.
export const LEG_CACHE_FILE = join(repoRoot, '.practice', 'cache', 'route-legs-v3.sqlite');
export const PRIOR_KEEP_MS = 7 * 24 * 3_600_000;
const PRIOR = 'route-legs-v2.sqlite', SUPERSEDED = ['route-legs.sqlite', PRIOR], UNREAD = /^route-legs(?:-v2)?\.json(?:\..*\.tmp)?$/;
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
        for (const old of SUPERSEDED) if (names.includes(old) && now - Math.max(written(old), written(old + '-wal')) >= PRIOR_KEEP_MS) for (const name of [old + '-wal', old + '-shm', old]) if (names.includes(name)) remove(name);
    } catch { /* no cache folder yet */ }
    return removed;
}
const LEGACY_READ_LIMIT = 16 * 2 ** 20;
type File = { source: string; legs: Record<string, number | null> };

export interface LegCache {
    has(k: string): boolean;
    get(k: string): number | null | undefined;
    // A length of the prior store under its own key (see LEG_CACHE_FILE); the caller copies it into this store.
    prior?(k: string): number | null | undefined;
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
    // A v3 key holds the danger tiles near its walk (world/leg-key.ts), so npc data that moves a hunter changes the keys
    // of the walks near it and no other: the store is tied to the pathfinder and collision data only. With the npc
    // data in the namespace, each change of knowledge/npcs.json deleted every row of the shared store (372,119 rows),
    // and each long walk of every account was measured cold again. The prior store keys a length by the whole scope
    // (hunter indices of that npc data), so its namespace keeps the npc data.
    const src = source ?? pathfindingDataKey() + ':' + npcsDigest(join(repoRoot, 'knowledge', 'npcs.json'));
    const namespace = createHash('sha256').update(source ?? pathfindingDataKey()).digest('base64url');
    const priorNamespace = createHash('sha256').update(src).digest('base64url');
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
    const READ_MEMO_LIMIT = 4_096;
    const readMemo = new Map<string, number | null>();
    type GetStmt = { get(namespace: string, key: string): { value: number | null } | null };
    let dbGetStmt: GetStmt | undefined;
    let priorGetStmt: GetStmt | undefined;
    const open = () => {
        let connection: Database | undefined;
        try {
            mkdirSync(dirname(file), { recursive: true });
            connection = new Database(file);
            connection.exec('PRAGMA journal_mode=WAL; PRAGMA cache_size=-1024; PRAGMA mmap_size=0; CREATE TABLE IF NOT EXISTS legs (source TEXT, key TEXT, value INTEGER, PRIMARY KEY (source, key)) WITHOUT ROWID');
            return connection;
        } catch { connection?.close(); return undefined; }
    };
    // ROUTE_LEG_CACHE=0: this process reads and writes no saved lengths, so each search measures its legs (a run with
    // empty caches, for the check that a bench case gives the same ticks with empty and with full caches).
    const stored = process.env.ROUTE_LEG_CACHE !== '0';
    let db = stored && existsSync(file) ? open() : undefined;
    // The prior store, read only, beside a v3 store (see LEG_CACHE_FILE), opened lazily on first prior() lookup.
    let prior: Database | undefined;
    let priorFile: string | undefined;
    let priorOpened = false;
    if (stored && /-v3\.sqlite$/.test(file)) {
        removeSupersededLegFiles(file);
        priorFile = join(dirname(file), PRIOR);
    }
    const openPrior = (): Database | undefined => {
        if (priorOpened) return prior;
        priorOpened = true;
        if (!priorFile || !existsSync(priorFile)) return undefined;
        try {
            prior = new Database(priorFile, { readonly: true });
            prior.exec('PRAGMA cache_size=-512; PRAGMA mmap_size=0');
        } catch {
            prior?.close();
            prior = undefined;
        }
        return prior;
    };
    // The shared store only: one checkout has one collision map, so rows of another source are of an older map.
    if (stored && file === LEG_CACHE_FILE && source === undefined) {
        // Rows written under the namespace that also named the npc data (priorNamespace) of the same data stay valid.
        try { if (priorNamespace !== namespace && db?.query('SELECT 1 FROM legs WHERE source = ?1 LIMIT 1').get(priorNamespace)) db.query('UPDATE OR IGNORE legs SET source = ?1 WHERE source = ?2').run(namespace, priorNamespace); } catch { /* another process moves them, or the store is busy */ }
        try { if (db?.query('SELECT 1 FROM legs WHERE source < ?1 OR source > ?1 LIMIT 1').get(namespace)) db.query('DELETE FROM legs WHERE source < ?1 OR source > ?1').run(namespace); } catch { /* another process prunes, or the store is busy */ }
    }
    const rememberRead = (key: string, value: number | null) => {
        if (readMemo.has(key)) {
            readMemo.delete(key);
        } else if (readMemo.size >= READ_MEMO_LIMIT) {
            const oldest = readMemo.keys().next().value;
            if (oldest !== undefined) readMemo.delete(oldest);
        }
        readMemo.set(key, value);
    };
    const get = (key: string) => {
        if (fresh.has(key)) return fresh.get(key);
        if (readMemo.has(key)) return readMemo.get(key);
        try {
            if (db) {
                if (!dbGetStmt) dbGetStmt = db.query<{ value: number | null }, [string, string]>('SELECT value FROM legs WHERE source = ? AND key = ?');
                const row = dbGetStmt.get(namespace, key);
                if (row) { rememberRead(key, row.value); return row.value; }
            }
        } catch { /* Compute the leg when the cache is unavailable. */ }
        return stored ? old[key] : undefined;
    };
    const c: LegCache = {
        has: k => get(k) !== undefined,
        get,
        prior: key => {
            try {
                const p = openPrior();
                if (p && !priorGetStmt) priorGetStmt = p.query<{ value: number | null }, [string, string]>('SELECT value FROM legs WHERE source = ? AND key = ?');
                const row = priorGetStmt?.get(priorNamespace, key);
                if (row) return row.value;
            } catch { /* The prior store is optional. */ }
            return undefined;
        },
        set: (k, v) => { fresh.set(k, v); if (stored) rememberRead(k, v); },
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
        close: () => { dbGetStmt = undefined; priorGetStmt = undefined; priorOpened = false; readMemo.clear(); db?.close(); db = undefined; prior?.close(); prior = undefined; if (shared === c) shared = undefined; },
    };
    if (file === LEG_CACHE_FILE && source === undefined) shared = c;
    return c;
}
