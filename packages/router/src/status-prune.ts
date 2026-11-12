// Moves old rows of practice accounts out of .practice/status. A practice or bench bot writes one row there and nothing
// removes it. The swarm, the coordinator and each live worker start parse the whole folder, so its size is their cost.
// A row moves to .practice/status-archive only when all of these are true:
//   - its file was not written for STATUS_ROW_MAX_AGE_MS;
//   - it parses, and its server is this machine (isLocalServer);
//   - its account is not a fleet account of any side (fleet owners.json) and has no verified live login
//     (.practice/owned-accounts.json).
// Each other file stays. A live-server row is the last observation of an account. A file that does not parse is unknown.
// The watchdog runs this (packages/router/src/watchdog.ts).
// Usage: bun packages/router/src/status-prune.ts [--apply]   Without --apply it moves nothing and prints the counts.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isLocalServer } from '../../core/src/localserver';
import { loadOwners } from '../../core/src/fleet';

export const STATUS_ROW_MAX_AGE_MS = 24 * 3600_000;

// True for a row of this machine's own server whose account is not in `keep`. The file name and the row name both count.
export function prunable(row: unknown, file: string, keep: ReadonlySet<string>): boolean {
    const r = row as { name?: unknown; server?: unknown } | null;
    if (!r || typeof r !== 'object' || typeof r.server !== 'string' || !isLocalServer(r.server)) return false;
    const names = [file.replace(/\.json$/i, ''), typeof r.name === 'string' ? r.name : ''];
    return !names.some(n => keep.has(n.toLowerCase()));
}

// The accounts whose rows never move: the fleet accounts of each side and the accounts with a verified live login.
// The registry also holds the logins on this machine's own practice servers. Those entries do not keep a row.
export function keptAccounts(root: string, owners: ReadonlyMap<string, unknown> = loadOwners()): Set<string> {
    const keep = new Set([...owners.keys()].map(n => n.toLowerCase()));
    const registry = join(root, '.practice', 'owned-accounts.json');
    if (existsSync(registry)) for (const [name, entry] of Object.entries(JSON.parse(readFileSync(registry, 'utf8')) as Record<string, { server?: unknown } | null>))
        if (typeof entry?.server !== 'string' || !isLocalServer(entry.server)) keep.add(name.toLowerCase());
    return keep;
}

export function pruneStatus(root: string, opts: { now?: number; maxAgeMs?: number; keep?: ReadonlySet<string>; dry?: boolean } = {}) {
    const now = opts.now ?? Date.now(), maxAgeMs = opts.maxAgeMs ?? STATUS_ROW_MAX_AGE_MS;
    const dir = join(root, '.practice', 'status'), archive = join(root, '.practice', 'status-archive');
    const result = { moved: [] as string[], kept: 0, failed: 0 };
    if (!existsSync(dir)) return result;
    const keep = opts.keep ?? keptAccounts(root);
    let made = false;
    for (const file of readdirSync(dir)) {
        const path = join(dir, file);
        let move = false;
        if (file.endsWith('.json')) {
            try { move = now - statSync(path).mtimeMs >= maxAgeMs && prunable(JSON.parse(readFileSync(path, 'utf8')), file, keep); } catch { move = false; }
        }
        if (!move) { result.kept++; continue; }
        if (opts.dry) { result.moved.push(file); continue; }
        try {
            if (!made) { mkdirSync(archive, { recursive: true }); made = true; }
            renameSync(path, join(archive, file));
            result.moved.push(file);
        } catch { result.failed++; result.kept++; }
    }
    return result;
}

if (import.meta.main) {
    const apply = process.argv.includes('--apply');
    const r = pruneStatus(resolve(import.meta.dir, '../../..'), { dry: !apply });
    console.log(`RESULT ok status-prune ${apply ? 'moved' : 'would move'} ${r.moved.length} rows, kept ${r.kept}${r.failed ? `, ${r.failed} not moved` : ''}`);
}
