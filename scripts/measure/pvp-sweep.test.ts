import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { benchCases } from './aio-bench-cases';
import { packBatches, QUICK_CASES, quickPattern, shardKeys, sweepPattern } from './pvp-sweep';

test('a decimal budget value cannot replace the PvP case pattern', () => {
    const pattern = sweepPattern(['--parallel', '4', '--budget', '3.5', '--seed', '7', '--batch', '1', '--shard', '2/4']);
    expect(pattern.test('pvp:fight')).toBe(true);
    expect(pattern.test('extra:spar-escape-full-pack')).toBe(true);
    expect(pattern.test('quester:quest:cook')).toBe(false);
    expect(sweepPattern(['--budget', '3.5', '^pvp:hunt$', '--parallel', '4']).source).toBe('^pvp:hunt$');
    expect(sweepPattern(['--shard', '2/4', '^pvp:hunt$']).source).toBe('^pvp:hunt$');
});

test('four shards cover every declared default sweep case exactly once', () => {
    const pattern = sweepPattern([]);
    const keys = benchCases().filter(c => pattern.test(c.key) && !c.known).map(c => c.key);
    const shards = Array.from({length: 4}, (_, index) => shardKeys(keys, `${index + 1}/4`));
    expect(keys.length).toBeGreaterThan(0);
    expect(shards.every(shard => shard.length > 0)).toBe(true);
    expect(shards.flat().sort()).toEqual([...keys].sort());
    expect(new Set(shards.flat()).size).toBe(keys.length);
    for (let index = 0; index < 4; index++) {
        expect(shards[index]).toEqual(keys.filter((_, position) => position % 4 === index));
    }
});

test('omitting a shard retains the complete selection and its order', () => {
    const pattern = sweepPattern([]);
    const keys = benchCases().filter(c => pattern.test(c.key) && !c.known).map(c => c.key);
    expect(shardKeys(keys)).toEqual(keys);
    expect(shardKeys(keys, '1/1')).toEqual(keys);
});

test('a shard requires safe positive integers and an index within its count', () => {
    for (const shard of ['', '0/4', '1/0', '5/4', '-1/4', '1/-4', '1.5/4', '1/4.5', '1', '1/2/3',
        '9007199254740992/9007199254740992', '1/9007199254740992']) {
        expect(() => shardKeys(['pvp:fight'], shard)).toThrow('--shard needs i/n');
    }
});

test('a sweep with no matching cases fails instead of reporting success', () => {
    const result = Bun.spawnSync(['bun', 'scripts/measure/pvp-sweep.ts', '^no-such-pvp-case$'], {
        cwd: resolve(import.meta.dir, '../..'),
        stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: 15_000,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toContain('PVP_SWEEP no runnable cases');
});

test('an empty shard fails before starting a bench', () => {
    const result = Bun.spawnSync(['bun', 'scripts/measure/pvp-sweep.ts', '^pvp:monitor$', '--shard', '2/2'], {
        cwd: resolve(import.meta.dir, '../..'),
        stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: 15_000,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toContain('PVP_SWEEP no runnable cases');
    expect(result.stdout.toString()).toContain('in shard 2/2');
    expect(result.stdout.toString()).not.toContain('PVP_SWEEP_BATCH');
});

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
