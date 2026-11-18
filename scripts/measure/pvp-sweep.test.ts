import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { benchCases } from './aio-bench-cases';
import { parseMatrixArgs } from './pk-spar-matrix';
import { DEFAULT_PATTERN, packBatches, parseSweepArgs, QUICK_CASES, quickPattern, runWithTimeout, shardBatches } from './pvp-sweep';

test('packBatches keeps each engine of a batch within the budget, longest cases first', () => {
    const cases = [100, 90, 80, 70, 60, 50, 40, 30].map((ms, i) => ({ key: `c${i}`, ms }));
    const batches = packBatches(cases, 2, 150);
    expect(batches.flat().sort()).toEqual(cases.map(c => c.key).sort());
    for (const b of batches) {
        const load = [0, 0];
        for (const k of b) { const i = load.indexOf(Math.min(...load)); load[i]! += cases.find(c => c.key === k)!.ms; }
        expect(Math.max(...load)).toBeLessThanOrEqual(150);
    }
});

test('packBatches gives a case longer than the budget a batch of its own', () => {
    expect(packBatches([{ key: 'long', ms: 500 }, { key: 'short', ms: 10 }], 1, 100)).toEqual([['long'], ['short']]);
});

test('the quick set names only cases that exist, and takes every pvp: route case', () => {
    const keys = new Set(benchCases().map(c => c.key));
    for (const k of QUICK_CASES) expect(keys.has(k)).toBe(true);
    const quick = [...keys].filter(k => quickPattern().test(k));
    expect(quick.filter(k => k.startsWith('pvp:')).length).toBe([...keys].filter(k => k.startsWith('pvp:')).length);
    expect(quick.length).toBe([...keys].filter(k => k.startsWith('pvp:')).length + QUICK_CASES.length);
});

test('parseSweepArgs consumes flag values so --budget 3.5 or --shard 2/4 are never treated as patterns', () => {
    const a = parseSweepArgs(['--parallel', '4', '--budget', '3.5', '--shard', '2/4', '--seed', 'alpha']);
    expect(a.pattern.source).toBe(new RegExp(DEFAULT_PATTERN).source);
    expect(a.engines).toBe(4);
    expect(a.budgetMs).toBe(210_000);
    expect(a.seed).toBe('alpha');
    expect(a.shard).toEqual({ index: 2, total: 4 });
    expect(a.shardError).toBeUndefined();

    const b = parseSweepArgs(['extra:roam', '--budget=2.5', '--parallel=2', '--batch=3', '--shard=4/4']);
    expect(b.pattern.source).toBe('extra:roam');
    expect(b.engines).toBe(2);
    expect(b.budgetMs).toBe(150_000);
    expect(b.only).toBe(3);
    expect(b.shard).toEqual({ index: 4, total: 4 });

    expect(parseSweepArgs(['--quick']).pattern.source).toBe(quickPattern().source);
    expect(parseSweepArgs(['--shard', '0/4']).shardError).toContain('--shard');
    expect(parseSweepArgs(['--shard', '5/4']).shardError).toContain('--shard');
    expect(parseSweepArgs(['--shard', 'bad']).shardError).toContain('--shard');
});

test('shardBatches partitions packed batches round-robin with full disjoint coverage', () => {
    const batches = [['b0'], ['b1'], ['b2'], ['b3'], ['b4'], ['b5']];
    const parts = [1, 2, 3, 4].map(index => shardBatches(batches, index, 4));
    expect(parts).toEqual([[['b0'], ['b4']], [['b1'], ['b5']], [['b2']], [['b3']]]);
    expect(parts.flat(2).sort()).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5']);
});

test('runWithTimeout completes normal commands and terminates overdue commands without POSIX timeout binary', async () => {
    const fast = await runWithTimeout([process.execPath, '-e', 'console.log("ok")'], {
        cwd: process.cwd(), env: process.env, timeoutMs: 3000,
    });
    expect(fast.timedOut).toBe(false);
    expect(fast.stdout.trim()).toBe('ok');

    const slow = await runWithTimeout([process.execPath, '-e', 'setTimeout(() => {}, 5000)'], {
        cwd: process.cwd(), env: process.env, timeoutMs: 250,
    });
    expect(slow.timedOut).toBe(true);
});

test('parseMatrixArgs parses --case, --seeds, --a-opts, --b-opts, --kits, and --wait', () => {
    const args = parseMatrixArgs([
        '--case', 'extra:spar-duel-hybrid-vs-melee-x8,extra:spar-duel-tribrid-food-vs-melee-x8',
        '--seeds', '1,2',
        '--a', 'champion',
        '--b', 'base',
        '--a-opts', '{"zeroDrainFlick":true}',
        '--wait', '3',
        '--parallel', '2',
    ]);
    expect(args.keys).toEqual(['extra:spar-duel-hybrid-vs-melee-x8', 'extra:spar-duel-tribrid-food-vs-melee-x8']);
    expect(args.seeds).toEqual([1, 2]);
    expect(args.aOpts).toBe('{"zeroDrainFlick":true}');
    expect(args.wait).toBe('3');
    expect(args.parallel).toBe(2);
});

test('the CI call of the sweep keeps the default pattern: a decimal budget is a flag value', () => {
    const args = parseSweepArgs(['--parallel', '4', '--budget', '3.5', '--shard', '2/4']);
    expect(args.pattern.source).toBe(DEFAULT_PATTERN);
    expect(args.pattern.test('extra:spar-escape-full-pack')).toBe(true);
    expect(args.shard).toEqual({ index: 2, total: 4 });
});

test('a sweep with no matching case exits 2 and starts no bench', () => {
    const run = (args: string[]) => Bun.spawnSync(['bun', 'scripts/measure/pvp-sweep.ts', ...args], {
        cwd: resolve(import.meta.dir, '../..'),
        stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: 20_000,
    });
    const none = run(['^no-such-pvp-case$']);
    expect(none.exitCode).toBe(2);
    expect(none.stdout.toString()).toContain('PVP_SWEEP no runnable cases');
    expect(none.stdout.toString()).not.toContain('PVP_SWEEP_BATCH');
    // One case packs into one batch, so shard 2 of 2 holds no case.
    const emptyShard = run(['^pvp:monitor$', '--shard', '2/2']);
    expect(emptyShard.exitCode).toBe(2);
    expect(emptyShard.stdout.toString()).toContain('in shard 2/2');
    expect(emptyShard.stdout.toString()).not.toContain('PVP_SWEEP_BATCH');
});
