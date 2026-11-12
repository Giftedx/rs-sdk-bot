// One rule for the size of a heavy tool job (test shards, a type check): it takes the memory that is free above a
// floor, and it never takes the floor. A job gets smaller when memory is short. It is not refused, and no flag
// overrides the rule: one test process, or a small compiler heap, still starts.
//
// The floor is the fleet's floor (FREE_FLOOR_GB, packages/core/src/memory.ts) on a machine where a swarm runs: the
// swarm starts a bot only while that much memory is free, so a tool that takes it stops the fleet's starts.
// On a machine with no swarm (a cloud container, a hosted runner) the floor is TOOL_FLOOR_GB.
// This file is tooling. Runtime code does not import it, so a change here does not change a worker release.
import { readFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { FREE_FLOOR_GB } from '../packages/core/src/memory';

export const TOOL_FLOOR_GB = 1;
// The swarm writes its state each 2 s (scripts/swarm.ts). A state that is older than this is of a swarm that stopped.
export const SWARM_FRESH_MS = 30_000;
// One `bun test` process, measured on the PC with tasklist: 85 MB for 1 file, 142 MB for the 38 dashboard files,
// 277 MB for the 32 router files. A shard of the full set holds about 34 files.
export const TEST_SHARD_GB = 0.3;
// The smallest compiler heap that is of use. A check that needs more fails with a heap error and takes no more.
export const MIN_HEAP_MB = 768;

export const freeGB = (): number => freemem() / 2 ** 30;

// The main checkout of this repository: a worktree has its own .practice folder, and the swarm writes in the main one.
export function mainCheckout(root: string): string {
    const r = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--git-common-dir'], { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
    return r.exitCode === 0 ? dirname(resolve(root, r.stdout.toString().trim())) : root;
}
// True while a swarm on this machine writes its state.
export function swarmRuns(root: string, now = Date.now()): boolean {
    try {
        const at = JSON.parse(readFileSync(join(mainCheckout(root), '.practice', 'swarm-state.json'), 'utf8')).at;
        return Number.isFinite(at) && now >= at && now - at < SWARM_FRESH_MS;
    } catch { return false; }
}
export const floorGB = (root: string, now = Date.now()): number => swarmRuns(root, now) ? FREE_FLOOR_GB : TOOL_FLOOR_GB;

// How many units of `perUnitGB` fit in the memory above the floor: `wanted` at most, and 1 at least.
export function unitsThatFit(wanted: number, perUnitGB: number, free: number, floor: number): number {
    const fit = Math.floor((free - floor) / perUnitGB);
    return Math.max(1, Math.min(wanted, Number.isFinite(fit) ? fit : 1));
}
// The compiler heap in MB: `wanted` at most, the memory above the floor when that is less, and MIN_HEAP_MB at least.
export function heapThatFits(wantedMB: number, free: number, floor: number): number {
    const fit = Math.floor((free - floor) * 1024);
    return Math.min(wantedMB, Math.max(MIN_HEAP_MB, Number.isFinite(fit) ? fit : MIN_HEAP_MB));
}
// One line for the log of a tool that took less than it wanted.
export const sizedNote = (tool: string, got: string, wanted: string, free: number, floor: number): string =>
    `${tool}: ${got} in place of ${wanted}: ${free.toFixed(1)} GiB is free and the floor is ${floor} GiB (scripts/heavy-admission.ts)`;
