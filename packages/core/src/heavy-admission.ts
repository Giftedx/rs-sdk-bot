// One rule for the size of a heavy tool job (test shards, a type check): it takes the memory that is free above a
// floor, and it never takes the floor. A job gets smaller when memory is short. It is not refused, and no flag
// overrides the rule: one test process, or a small compiler heap, still starts.
//
// The floor is the fleet's floor (FREE_FLOOR_GB, packages/core/src/memory.ts) on a machine where a swarm runs: the
// swarm starts a bot only while that much memory is free, so a tool that takes it stops the fleet's starts.
// On a machine with no swarm (a cloud container, a hosted runner) the floor is TOOL_FLOOR_GB.
// This file is tooling. Runtime code does not import it, so a change here does not change a worker release.
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { FREE_FLOOR_GB } from './memory';

export const TOOL_FLOOR_GB = 1;
// The swarm writes its state each 2 s (scripts/swarm.ts). A state that is older than this is of a swarm that stopped.
export const SWARM_FRESH_MS = 30_000;
// The memory of one shard of the full test set, with the processes that its tests start. Measured on the PC: 12
// shards over ./scripts and ./packages (459 files) had a peak working set of 8.82 GiB for the whole process tree,
// with 46 processes at one time. That is 0.74 GiB for each shard. One `bun test` process alone is far less (85 MB
// for 1 file, 277 MB for the 32 router files): the child processes of the tests are the larger part.
export const TEST_SHARD_GB = 0.75;
// The smallest compiler heap that is of use. A check that needs more fails with a heap error and takes no more.
export const MIN_HEAP_MB = 768;

export const freeGB = (): number => os.freemem() / 2 ** 30;

// CPU quotas count time in a period, not the host's logical processors. Fractional capacity permits one process
// at least; larger quotas round down so CPU-bound test children do not compete beyond the available whole CPUs.
export function cpuQuota(text: string | null): number | null {
    const match = text?.trim().match(/^(max|-1|\d+)\s+(\d+)$/);
    if (!match || match[1] === 'max' || match[1] === '-1') return null;
    const quota = Number(match[1]), period = Number(match[2]);
    return Number.isSafeInteger(quota) && quota > 0 && Number.isSafeInteger(period) && period > 0
        ? Math.max(1, Math.floor(quota / period)) : null;
}

function nativeCpuCapacity(): number {
    try { const n = os.availableParallelism(); if (Number.isSafeInteger(n) && n > 0) return n; } catch { /* older runtime */ }
    try { return Math.max(1, os.cpus().length); } catch { return 1; }
}

function cgroupDirectories(mount: string, membership: string): string[] {
    if (!membership.startsWith('/') || membership.split('/').includes('..')) return [mount];
    const directories: string[] = [];
    for (let current = posix.resolve(mount, '.' + membership); ; current = posix.dirname(current)) {
        directories.push(current);
        if (current === mount) return directories;
    }
}

// availableParallelism observes affinity/cpusets. Linux cgroup quotas can be stricter, including a limited parent
// of an unlimited child. The mount root remains a fallback for a container whose membership path is not exposed.
export function cpuCapacity(options: { available?: number; platform?: NodeJS.Platform; read?: (file: string) => string | null } = {}): number {
    const available = options.available ?? nativeCpuCapacity();
    let limit = Number.isSafeInteger(available) && available > 0 ? available : 1;
    if ((options.platform ?? process.platform) !== 'linux') return limit;
    const read = (file: string) => { try { return options.read ? options.read(file) : readFileSync(file, 'utf8'); } catch { return null; } };
    const membership = (read('/proc/self/cgroup') ?? '').split(/\r?\n/);
    const v2 = new Set(['/sys/fs/cgroup']);
    const v1 = new Set(['/sys/fs/cgroup/cpu', '/sys/fs/cgroup/cpu,cpuacct', '/sys/fs/cgroup']);
    for (const row of membership) {
        const entry = row.match(/^\d+:([^:]*):(\/.*)$/);
        if (!entry) continue;
        if (entry[1] === '') for (const directory of cgroupDirectories('/sys/fs/cgroup', entry[2]!)) v2.add(directory);
        if (entry[1]!.split(',').includes('cpu')) {
            for (const mount of ['/sys/fs/cgroup/cpu', '/sys/fs/cgroup/cpu,cpuacct', '/sys/fs/cgroup'])
                for (const directory of cgroupDirectories(mount, entry[2]!)) v1.add(directory);
        }
    }
    for (const directory of v2) {
        const quota = cpuQuota(read(posix.join(directory, 'cpu.max')));
        if (quota !== null) limit = Math.min(limit, quota);
    }
    for (const directory of v1) {
        const quota = read(posix.join(directory, 'cpu.cfs_quota_us')), period = read(posix.join(directory, 'cpu.cfs_period_us'));
        const count = quota === null || period === null ? null : cpuQuota(`${quota.trim()} ${period.trim()}`);
        if (count !== null) limit = Math.min(limit, count);
    }
    return limit;
}

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
// The live fleet of this machine, or null with no swarm: the bots that run and the memory the swarm holds back for
// the bots that it starts now (pendingReserveGB of scripts/swarm.ts). A tool beside the fleet leaves the floor and
// this reserve free.
export type Fleet = { bots: number; reserveGB: number };
export function fleet(root: string, now = Date.now()): Fleet | null {
    try {
        const state = JSON.parse(readFileSync(join(mainCheckout(root), '.practice', 'swarm-state.json'), 'utf8'));
        if (!Number.isFinite(state.at) || now < state.at || now - state.at >= SWARM_FRESH_MS) return null;
        const count = (v: unknown) => Array.isArray(v) ? v.length : Number.isFinite(v) ? Number(v) : 0;
        return { bots: count(state.running) + count(state.externalRunning), reserveGB: Math.max(0, Number(state.pendingReserveGB) || 0) };
    } catch { return null; }
}

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
