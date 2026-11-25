// A live update that waits only because live runs load its incoming files asks for a drain: the swarm starts no new
// run that loads one of those files, so the running ones end, the update lands, and later runs start on the new code.
// Without the drain, the next run of a busy worker loads the same old files and the update waits on that run too.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson } from '../../../core/src/plan-lock';
import { liveRoot } from '../../../core/src/practice-paths';
import { cachedReleaseFiles } from '../../../core/src/worker-release';

export type PendingUpdate = { at: number; target: string; files: string[] };

// live-update renews the mark on each fleet-agent pass while it waits. A quiet agent sleeps its whole CYCLE (10 min
// by default, packages/fleet/src/fleet-agent.ts) between passes, so the mark lives three cycles; one this old has no
// live writer and holds nothing. The watchdog restarts a stopped agent within 5 minutes.
export const PENDING_MAX_AGE_MS = 30 * 60_000;
export const pendingUpdateFile = (root: string) => join(liveRoot(root), 'live-update-pending.json');

export function writePendingUpdate(root: string, mark: PendingUpdate): void {
    atomicJson(pendingUpdateFile(root), mark);
}

export function clearPendingUpdate(root: string): void {
    try { rmSync(pendingUpdateFile(root), { force: true }); } catch { /* an old mark holds nothing after PENDING_MAX_AGE_MS */ }
}

export function readPendingUpdate(root: string, now = Date.now()): PendingUpdate | null {
    const file = pendingUpdateFile(root);
    if (!existsSync(file)) return null;
    try {
        const v = JSON.parse(readFileSync(file, 'utf8'));
        if (!Number.isFinite(v?.at) || typeof v.target !== 'string' || !Array.isArray(v.files) || !v.files.every((f: unknown) => typeof f === 'string')) return null;
        if (now - v.at >= PENDING_MAX_AGE_MS || v.at > now + 60_000) return null;
        return { at: v.at, target: v.target, files: v.files };
    } catch { return null; }
}

// The pending files a job's worker would load: its entries and the supervisor, with their release closure. The
// closure comes from the release record that each start already keeps (cachedReleaseFiles), so a swarm tick parses
// nothing while the release files keep their stamps.
export function drainedFiles(
    pending: PendingUpdate | null,
    entries: readonly string[],
    root: string,
    closure: (entries: readonly string[], root: string) => readonly string[] = cachedReleaseFiles,
): string[] {
    if (!pending || !pending.files.length || !entries.length) return [];
    const loaded = new Set(closure(entries, root));
    return pending.files.filter(f => loaded.has(f));
}

// A cheap reader for a loop: it parses the mark again only when the file changes.
export function pendingUpdateReader(root: string): (now?: number) => PendingUpdate | null {
    let seen: { mtimeMs: number; size: number; value: PendingUpdate | null } | null = null;
    return (now = Date.now()) => {
        const file = pendingUpdateFile(root);
        let st: { mtimeMs: number; size: number };
        try { st = statSync(file); } catch { seen = null; return null; }
        if (!seen || seen.mtimeMs !== st.mtimeMs || seen.size !== st.size) seen = { mtimeMs: st.mtimeMs, size: st.size, value: readPendingUpdate(root, now) };
        const v = seen.value;
        return v && now - v.at < PENDING_MAX_AGE_MS ? v : null;
    };
}
