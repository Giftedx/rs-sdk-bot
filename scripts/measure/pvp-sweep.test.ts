import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { benchCases } from './aio-bench-cases';
import { packBatches, QUICK_CASES, quickPattern, sweepPattern } from './pvp-sweep';

test('a decimal budget value cannot replace the PvP case pattern', () => {
    const pattern = sweepPattern(['--parallel', '4', '--budget', '3.5', '--seed', '7', '--batch', '1']);
    expect(pattern.test('pvp:fight')).toBe(true);
    expect(pattern.test('extra:spar-escape-full-pack')).toBe(true);
    expect(pattern.test('quester:quest:cook')).toBe(false);
    expect(sweepPattern(['--budget', '3.5', '^pvp:hunt$', '--parallel', '4']).source).toBe('^pvp:hunt$');
});

test('a sweep with no matching cases fails instead of reporting success', () => {
    const result = Bun.spawnSync(['bun', 'scripts/measure/pvp-sweep.ts', '^no-such-pvp-case$'], {
        cwd: resolve(import.meta.dir, '../..'),
        stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: 15_000,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toContain('PVP_SWEEP no runnable cases');
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
