// Moves expired local/practice status rows to status-archive so controllers parse only active/live rows.
// Usage: bun packages/fleet/src/status-prune.ts [--apply]   Without --apply it moves nothing and prints counts.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadOwners } from '../../core/src/fleet';
import { isLocalServer } from '../../core/src/localserver';
import { liveStatusArchiveDir, liveStatusDir, simRoot, simStatusDir } from '../../core/src/practice-paths';

// A practice bot writes its row every few ticks, so a row an hour old belongs to an ended run.
export const STATUS_ROW_MAX_AGE_MS = 3600_000;

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
    if (existsSync(registry)) {
        for (const [name, entry] of Object.entries(JSON.parse(readFileSync(registry, 'utf8')) as Record<string, { server?: unknown } | null>)) {
            if (typeof entry?.server !== 'string' || !isLocalServer(entry.server)) keep.add(name.toLowerCase());
        }
    }
    return keep;
}

export function pruneStatus(root: string, opts: { now?: number; maxAgeMs?: number; keep?: ReadonlySet<string>; dry?: boolean } = {}) {
    const now = opts.now ?? Date.now(), maxAgeMs = opts.maxAgeMs ?? STATUS_ROW_MAX_AGE_MS;
    const targets: readonly { dir: string; archive: string }[] = [
        { dir: liveStatusDir(root), archive: liveStatusArchiveDir(root) },
        { dir: join(root, '.practice', 'status'), archive: join(root, '.practice', 'status-archive') },
        { dir: simStatusDir(root), archive: join(simRoot(root), 'status-archive') },
    ];
    const result = { moved: [] as string[], kept: 0, failed: 0 };
    const keep = opts.keep ?? keptAccounts(root);
    for (const { dir, archive } of targets) {
        if (!existsSync(dir)) continue;
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
    }
    return result;
}

if (import.meta.main) {
    const apply = process.argv.includes('--apply');
    const r = pruneStatus(resolve(import.meta.dir, '../../..'), { dry: !apply });
    console.log(`RESULT ok status-prune ${apply ? 'moved' : 'would move'} ${r.moved.length} rows, kept ${r.kept}${r.failed ? `, ${r.failed} not moved` : ''}`);
}
