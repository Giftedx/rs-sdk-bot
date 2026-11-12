import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FREE_FLOOR_GB } from '../packages/core/src/memory';
import { MIN_HEAP_MB, SWARM_FRESH_MS, TEST_SHARD_GB, TOOL_FLOOR_GB, floorGB, heapThatFits, sizedNote, swarmRuns, unitsThatFit } from './heavy-admission';

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
    expect(sizedNote('test-shards', '8 shards', '12', 6.42, 4)).toBe('test-shards: 8 shards in place of 12: 6.4 GiB is free and the floor is 4 GiB (scripts/heavy-admission.ts)');
});
