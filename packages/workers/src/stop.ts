// Shared worker stop-file and session-disconnect checks across WorkerModule families.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionCore } from './contracts';

export const STOP_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function checkCandidate(
    rel: string,
    exists: (path: string) => boolean,
    checkRepoRoot: boolean,
): boolean {
    if (exists(rel)) return true;
    if (checkRepoRoot && !rel.startsWith('/') && !(rel.length >= 3 && rel.charCodeAt(1) === 58 && (rel.charCodeAt(2) === 92 || rel.charCodeAt(2) === 47))) {
        if (exists(join(STOP_REPO_ROOT, rel))) return true;
    }
    return false;
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
    const checkRepoRoot = exists === existsSync && resolve('.') !== STOP_REPO_ROOT;
    if (checkCandidate('.practice/stop-all', exists, checkRepoRoot)) return true;
    const trimmed = account?.trim();
    if (trimmed) {
        if (checkCandidate(`.practice/stop-${trimmed}`, exists, checkRepoRoot)) return true;
        const lower = trimmed.toLowerCase();
        if (lower !== trimmed && checkCandidate(`.practice/stop-${lower}`, exists, checkRepoRoot)) return true;
    }
    for (let i = 0; i < extraFiles.length; i++) {
        const extra = extraFiles[i];
        if (extra && checkCandidate(extra, exists, checkRepoRoot)) return true;
    }
    if (role && checkCandidate(role, exists, checkRepoRoot)) return true;
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
