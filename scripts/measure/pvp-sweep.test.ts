import { expect, test } from 'bun:test';
import { packBatches } from './pvp-sweep';

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
