import { expect, test } from 'bun:test';
import { parseStep, runChain } from './chain';
import { lastResult } from '../packages/core/src/run-child';

test('a chain step splits into script, arguments and its own environment', () => {
    expect(parseStep('scripts/cook-food.ts 2000 lobster CAP=2000')).toEqual({ script: 'scripts/cook-food.ts', args: ['2000', 'lobster'], env: { CAP: '2000' } });
    expect(() => parseStep('rm -rf /')).toThrow();
});

test.each(['RESULT fail died', 'RESULT fail Courier prerequisite: combat29 required', 'RESULT fail session ended: disconnected', 'RESULT fail no result'])('failed prerequisite ends the chain and preserves %s', async failure => {
    const calls: string[] = [];
    const result = await runChain([parseStep('scripts/foodcourier.ts'), parseStep('scripts/shop-buyer.ts ardy')], 2, {
        stopped: () => false, log: () => {}, run: async step => { calls.push(step.script); return failure; },
    });
    expect(calls).toEqual(['scripts/foodcourier.ts']);
    expect(result).toBe(`${failure} chain rounds=1 ok=0 failed=1`);
});

test('a prior successful step never masks a later death or starts another round', async () => {
    let calls = 0;
    const result = await runChain([parseStep('scripts/walk-to.ts'), parseStep('scripts/foodcourier.ts'), parseStep('scripts/shop-buyer.ts')], 0, {
        stopped: () => false, log: () => {}, run: async () => ++calls === 1 ? 'RESULT ok staged' : 'RESULT fail died',
    });
    expect(calls).toBe(2);
    expect(result).toBe('RESULT fail died chain rounds=1 ok=1 failed=1');
});

test('an owner stop after a successful step prevents the next step', async () => {
    let stopped = false, calls = 0;
    const result = await runChain([parseStep('scripts/walk-to.ts'), parseStep('scripts/foodcourier.ts')], 1, {
        stopped: () => stopped, log: () => {}, run: async () => { calls++; stopped = true; return 'RESULT ok staged'; },
    });
    expect(calls).toBe(1);
    expect(result).toBe('RESULT fail stop file chain rounds=1 ok=1 failed=0');
});

test('successful finite rounds keep their ordering and totals', async () => {
    const calls: string[] = [];
    const result = await runChain([parseStep('scripts/walk-to.ts'), parseStep('scripts/shop-buyer.ts')], 2, {
        stopped: () => false, log: () => {}, run: async step => { calls.push(step.script); return 'RESULT ok product'; },
    });
    expect(calls).toEqual(['scripts/walk-to.ts', 'scripts/shop-buyer.ts', 'scripts/walk-to.ts', 'scripts/shop-buyer.ts']);
    expect(result).toBe('RESULT ok chain rounds=2 ok=4 failed=0');
});

test.each([-1, NaN, Infinity, 1.5])('invalid round limit %s is a per-chain refusal before dispatch', async rounds => {
    let calls = 0;
    const result = await runChain([parseStep('scripts/walk-to.ts')], rounds, {
        stopped: () => false, log: () => {}, run: async () => { calls++; return 'RESULT ok'; },
    });
    expect(calls).toBe(0);
    expect(result).toBe('RESULT fail chain needs steps and nonnegative integer ROUNDS');
});

test('the last RESULT line wins; none is a failure', () => {
    expect(lastResult('RESULT fail a\nlog\nRESULT ok b\n')).toBe('RESULT ok b');
    expect(lastResult('no result here')).toBe('RESULT fail no result');
});
