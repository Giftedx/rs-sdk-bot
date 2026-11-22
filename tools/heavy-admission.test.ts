import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FREE_FLOOR_GB } from '../packages/core/src/memory';
import { MIN_HEAP_MB, SWARM_FRESH_MS, TEST_SHARD_GB, TOOL_FLOOR_GB, cpuCapacity, cpuQuota, floorGB, heapThatFits, sizedNote, swarmRuns, unitsThatFit } from './heavy-admission';

test('CPU time quotas round down to whole capacity while permitting one process under a fractional quota', () => {
    expect(cpuQuota('400000 100000\n')).toBe(4);
    expect(cpuQuota('250000 100000')).toBe(2);
    expect(cpuQuota('50000 100000')).toBe(1);
    for (const value of [null, 'max 100000', '-1 100000', '', 'broken', '0 100000', '100000 0', '-2 100000', '100000 -1', '1.5 100000'])
        expect(cpuQuota(value)).toBeNull();
});

test('CPU capacity respects both affinity and a stricter root container quota', () => {
    const files = new Map([['/proc/self/cgroup', '0::/\n'], ['/sys/fs/cgroup/cpu.max', '400000 100000']]);
    const read = (file: string) => files.get(file) ?? null;
    expect(cpuCapacity({ available: 5, platform: 'linux', read })).toBe(4);
    expect(cpuCapacity({ available: 2, platform: 'linux', read })).toBe(2);
});

test('an unlimited cgroup child retains its parent quota and a stricter child lowers it further', () => {
    const files = new Map([
        ['/proc/self/cgroup', '0::/tenant/job\n'], ['/sys/fs/cgroup/cpu.max', 'max 100000'],
        ['/sys/fs/cgroup/tenant/cpu.max', '200000 100000'], ['/sys/fs/cgroup/tenant/job/cpu.max', 'max 100000'],
    ]);
    const options = { available: 16, platform: 'linux' as const, read: (file: string) => files.get(file) ?? null };
    expect(cpuCapacity(options)).toBe(2);
    files.set('/sys/fs/cgroup/tenant/job/cpu.max', '100000 100000');
    expect(cpuCapacity(options)).toBe(1);
});

test('the mounted root quota remains a fallback when the membership path is not exposed', () => {
    const files = new Map([['/proc/self/cgroup', '0::/unexposed/container/path'], ['/sys/fs/cgroup/cpu.max', '400000 100000']]);
    expect(cpuCapacity({ available: 16, platform: 'linux', read: file => files.get(file) ?? null })).toBe(4);
});

test('cgroup v1 CPU controller quotas include limited parents', () => {
    const files = new Map([
        ['/proc/self/cgroup', '7:cpu,cpuacct:/tenant/job\n'],
        ['/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us', '-1'], ['/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us', '100000'],
        ['/sys/fs/cgroup/cpu,cpuacct/tenant/cpu.cfs_quota_us', '300000'], ['/sys/fs/cgroup/cpu,cpuacct/tenant/cpu.cfs_period_us', '100000'],
        ['/sys/fs/cgroup/cpu,cpuacct/tenant/job/cpu.cfs_quota_us', '250000'], ['/sys/fs/cgroup/cpu,cpuacct/tenant/job/cpu.cfs_period_us', '100000'],
    ]);
    expect(cpuCapacity({ available: 16, platform: 'linux', read: file => files.get(file) ?? null })).toBe(2);
});

test('missing or malformed quotas use effective CPU availability and non-Linux platforms read no cgroups', () => {
    expect(cpuCapacity({ available: 6, platform: 'linux', read: () => { throw Error('unavailable'); } })).toBe(6);
    expect(cpuCapacity({ available: 6, platform: 'linux', read: () => 'malformed' })).toBe(6);
    let reads = 0;
    expect(cpuCapacity({ available: 3, platform: 'win32', read: () => { reads++; return '100000 100000'; } })).toBe(3);
    expect(reads).toBe(0);
    expect(cpuCapacity({ available: NaN, platform: 'darwin' })).toBe(1);
});

test('a job takes the memory above the floor, the wanted size at most and one unit at least', () => {
    // 12 shards of 0.75 GiB want 9 GiB above the floor: 13 GiB free with the fleet floor of 4.
    expect(TEST_SHARD_GB).toBe(0.75);
    expect(unitsThatFit(12, 0.75, 16, 4)).toBe(12);
    expect(unitsThatFit(12, 0.75, 13, 4)).toBe(12);
    expect(unitsThatFit(12, 0.75, 12.9, 4)).toBe(11);
    expect(unitsThatFit(12, 0.75, 7.6, 4)).toBe(4);
    expect(unitsThatFit(12, 0.75, 6.4, 4)).toBe(3);
    expect(unitsThatFit(12, 0.75, 4.7, 4)).toBe(1);
    // Under the floor, and with a number that is not a number: one unit still starts.
    expect(unitsThatFit(12, 0.75, 2.8, 4)).toBe(1);
    expect(unitsThatFit(12, 0.75, NaN, 4)).toBe(1);
    expect(unitsThatFit(3, 0.75, 64, 4)).toBe(3);
    // The same memory on a machine with no swarm.
    expect(unitsThatFit(12, 0.75, 2.8, TOOL_FLOOR_GB)).toBe(2);
    expect(unitsThatFit(12, 0.75, 10, TOOL_FLOOR_GB)).toBe(12);
});

test('the compiler heap is the wanted size, less when memory is short, and never under the least heap of use', () => {
    expect(heapThatFits(2560, 16, 4)).toBe(2560);
    expect(heapThatFits(2560, 6.5, 4)).toBe(2560);
    expect(heapThatFits(2560, 6, 4)).toBe(2048);
    expect(heapThatFits(2560, 5, 4)).toBe(1024);
    expect(heapThatFits(2560, 4.5, 4)).toBe(MIN_HEAP_MB);
    expect(heapThatFits(2560, 2.8, 4)).toBe(MIN_HEAP_MB);
    expect(heapThatFits(2560, NaN, 4)).toBe(MIN_HEAP_MB);
    // A wanted heap under the least heap stays as the caller gave it.
    expect(heapThatFits(512, 16, 4)).toBe(512);
    expect(heapThatFits(512, 2.8, 4)).toBe(512);
});

test('the floor is the fleet floor only while a swarm on this machine writes its state', () => {
    const root = mkdtempSync(join(tmpdir(), 'heavy-admission-')), now = 1_800_000_000_000;
    try {
        // Not a git folder, and no state file: no swarm.
        expect(swarmRuns(root, now)).toBe(false); expect(floorGB(root, now)).toBe(TOOL_FLOOR_GB);
        mkdirSync(join(root, '.practice'));
        const state = (value: string) => writeFileSync(join(root, '.practice', 'swarm-state.json'), value);
        state(JSON.stringify({ at: now - 2000 }));
        expect(swarmRuns(root, now)).toBe(true); expect(floorGB(root, now)).toBe(FREE_FLOOR_GB);
        state(JSON.stringify({ at: now - SWARM_FRESH_MS + 1 })); expect(swarmRuns(root, now)).toBe(true);
        // A swarm that stopped, a time in the future, and a file that is not a state.
        for (const old of [JSON.stringify({ at: now - SWARM_FRESH_MS }), JSON.stringify({ at: now + 1000 }), JSON.stringify({ at: 'x' }), '{', 'null']) {
            state(old); expect(swarmRuns(root, now), old).toBe(false); expect(floorGB(root, now), old).toBe(TOOL_FLOOR_GB);
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the note for a smaller job names the free memory and the floor', () => {
    expect(sizedNote('test-shards', '8 shards', '12', 6.42, 4)).toBe('test-shards: 8 shards in place of 12: 6.4 GiB is free and the floor is 4 GiB (tools/heavy-admission.ts)');
});
