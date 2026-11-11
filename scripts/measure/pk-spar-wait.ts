// The spar tools take only the memory that the live fleet does not need. One run holds about 1.7 GB for a minute.
// A run starts when it leaves 4.5 GB free and no live job waits for memory (the dashboard's `queued`), or when 9 GB
// are free whatever waits, and never while the file .practice/pk-climb-pause exists in the main checkout.
import { existsSync } from 'node:fs';
import { freemem } from 'node:os';
import { resolve } from 'node:path';

export const RUN_GB = 1.7;
// May a run start now? `queued` is the number of live jobs that wait for memory, or null when the dashboard gives none.
// `runs` is the number of runs that start at the same time (the cases of a matrix in parallel).
export function mayRun(freeGB: number, queued: number | null, paused: boolean, runs = 1): boolean {
    if (paused) return false;
    return freeGB >= 9 + RUN_GB * (runs - 1) || (freeGB - RUN_GB * runs >= 4.5 && (queued ?? 0) === 0);
}
export async function waitForMemory(root: string, log: (line: string) => void = l => console.log(l), runs = 1): Promise<void> {
    // The main checkout holds the pause file: a worktree under .claude/worktrees is three levels down.
    const main = /[\\/]\.claude[\\/]worktrees[\\/]/.test(root) ? resolve(root, '..', '..', '..') : root;
    for (;;) {
        let queued: number | null = null;
        try { queued = (await (await fetch('http://127.0.0.1:3100/api/state', { signal: AbortSignal.timeout(4000) })).json() as { capacity?: { queued?: number } }).capacity?.queued ?? null; } catch { /* no dashboard */ }
        const free = freemem() / 2 ** 30, paused = existsSync(resolve(main, '.practice/pk-climb-pause'));
        if (mayRun(free, queued, paused, runs)) return;
        log(`SPAR_WAIT free ${free.toFixed(1)} GB, live jobs waiting ${queued ?? 'unknown'}${paused ? ', pause file' : ''}`);
        await Bun.sleep(30_000);
    }
}
