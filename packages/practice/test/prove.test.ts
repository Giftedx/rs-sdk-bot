import { test, expect } from 'bun:test';
import { prove, type ProveDeps } from '../src/prove';

test('prove counts passing runs and calls prepare before each run', async () => {
    let n = 0;
    let prepared = 0;
    const deps: ProveDeps = {
        prepare: async () => { prepared++; },
        run: async () => {
            n++;
            return { stdout: n % 2 === 1 ? 'RESULT ok' : 'RESULT bad', exitCode: 0 };
        },
    };
    const r = await prove({ bot: 'b', script: 's.ts', runs: 5, pass: s => s.includes('RESULT ok') }, deps);
    expect(r.runs).toBe(5);
    expect(r.passes).toBe(3);
    expect(prepared).toBe(5);
    expect(r.results.map(x => x.ok)).toEqual([true, false, true, false, true]);
});

test('a non-zero exit is a failed run even if the pass check matches', async () => {
    const deps: ProveDeps = {
        prepare: async () => {},
        run: async () => ({ stdout: 'RESULT ok', exitCode: 1 }),
    };
    const r = await prove({ bot: 'b', script: 's.ts', runs: 2, pass: s => s.includes('RESULT ok') }, deps);
    expect(r.passes).toBe(0);
});

test('wcPass needs positive Woodcutting XP', async () => {
    const { wcPass } = await import('../src/prove');
    expect(wcPass('RESULT chops=7 wcXpGained=4375 seconds=63.9')).toBe(true);
    expect(wcPass('RESULT chops=0 wcXpGained=0 seconds=10')).toBe(false);
    expect(wcPass('crashed')).toBe(false);
});
