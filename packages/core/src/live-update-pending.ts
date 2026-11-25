// A live update that waits only because live runs load its incoming files asks for a drain: the swarm starts no new
// run that loads one of those files, so the running ones end, the update lands, and later runs start on the new code.
// Without the drain, the next run of a busy worker loads the same old files and the update waits on that run too.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { atomicJson } from './plan-lock';
import { liveRoot } from './practice-paths';
import { cachedReleaseFiles, releaseEntries } from './worker-release';

// `others`: the live runs that the update waits on and that are not trades (scripts/aio-logistics.ts). While one of
// them runs, the update cannot land, so the fleet agent does not hold a trade for the drain (fleet-agent.ts
// tradeDrainHold). A mark without the field holds every drained trade.
// `since`: when the drain began. A renewal keeps it while the previous mark is fresh, also when a later merge changes
// the target, so the swarm can end its own runs that hold a drain past DRAIN_STOP_MS (packages/fleet/src/swarm.ts).
export type PendingUpdate = { at: number; target: string; files: string[]; others?: string[]; since?: number };

// A drain that waits this long on a swarm run asks that run to log out (swarm.ts drainStopAccounts). Most capped runs
// end within it; a run near its cap, a chain step or a long quest otherwise holds every new start for an hour or more.
export const DRAIN_STOP_MS = 20 * 60_000;
// The stop-file text of that request. The supervisor ends such a job as release-paused (supervise.ts), so the swarm
// starts it again on the new code, and the swarm removes the file once the run has ended.
export const DRAIN_STOP_TEXT = 'swarm stopped for a live update drain';

// The mark that a renewal writes: `since` comes from a fresh previous mark, or the renewal starts the drain.
export function renewedPendingUpdate(previous: PendingUpdate | null, mark: PendingUpdate): PendingUpdate {
    return { ...mark, since: previous ? previous.since ?? previous.at : mark.at };
}

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
        const others = Array.isArray(v.others) && v.others.every((n: unknown) => typeof n === 'string') ? { others: v.others as string[] } : {};
        const since = Number.isFinite(v.since) && v.since <= v.at ? { since: v.since as number } : {};
        return { at: v.at, target: v.target, files: v.files, ...others, ...since };
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

// The pending files that the next run of a supervised live worker would load (packages/practice/src/supervise.ts). A
// restart of such a worker holds the update as long as a new start would, so its supervisor ends the job as
// release-paused, and the swarm starts it again on the new code. The swarm does not drain a standing job, and a run
// without DEMO_OK is not a live swarm run.
export function workerDrain(
    root: string,
    env: Record<string, string | undefined> = process.env,
    now = Date.now(),
    closure: (entries: readonly string[], root: string) => readonly string[] = cachedReleaseFiles,
): string[] {
    if (env.DEMO_OK !== '1' || env.STANDING === '1') return [];
    const entries = releaseEntries(env.WORKER_ENTRY).map(e => relative(resolve(root), resolve(root, e)).replaceAll('\\', '/'));
    try { return drainedFiles(readPendingUpdate(root, now), entries, root, closure); } catch { return []; }
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
