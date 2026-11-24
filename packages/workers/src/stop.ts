// Shared worker stop-file and session-disconnect checks across WorkerModule families.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionCore } from './contracts';

export const STOP_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function stopFileCandidates(account: string | undefined, extraFiles: readonly string[] = [], role: string | undefined = process.env.STOP_FILE): string[] {
    const names = new Set<string>(['.practice/stop-all']);
    const trimmed = account?.trim();
    if (trimmed) {
        names.add(`.practice/stop-${trimmed}`);
        names.add(`.practice/stop-${trimmed.toLowerCase()}`);
    }
    for (const extra of extraFiles) {
        if (extra) names.add(extra);
    }
    if (role) names.add(role);
    return [...names];
}

/**
 * Checks whether any stop marker exists for the given account, relative to cwd or repo root.
 * Preserves custom `exists` stubs for unit tests while avoiding cwd misses across worktrees.
 */
export function isStopFilePresent(
    account: string | undefined,
    extraFiles: readonly string[] = [],
    exists: (path: string) => boolean = existsSync,
    role: string | undefined = process.env.STOP_FILE,
): boolean {
    const candidates = stopFileCandidates(account, extraFiles, role);
    const checkRepoRoot = exists === existsSync;
    for (const rel of candidates) {
        if (exists(rel)) return true;
        if (checkRepoRoot && !rel.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(rel)) {
            if (exists(join(STOP_REPO_ROOT, rel))) return true;
        }
    }
    return false;
}

export interface WorkerStopWatch {
    readonly isStopped: () => boolean;
    readonly hasEnded: () => boolean;
}

/**
 * Combines `session.ended`, caller-supplied `cfgStop()`, and `.practice/stop-*` files into one sticky check.
 */
export function watchWorkerStop(
    session: Pick<SessionCore, 'name' | 'ended'> | null | undefined,
    cfgStop?: () => boolean,
    extraFiles: readonly string[] = [],
): WorkerStopWatch {
    let ended = false;
    void session?.ended?.then(() => {
        ended = true;
    });
    const isStopped = (): boolean => ended || Boolean(cfgStop?.()) || isStopFilePresent(session?.name, extraFiles);
    return {
        isStopped,
        hasEnded: () => ended,
    };
}
