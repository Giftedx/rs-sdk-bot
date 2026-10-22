import { test, expect } from 'bun:test';
import { prove, runBotName, wcPass, type ProveDeps } from '../src/prove';

function fakeDeps(over: Partial<ProveDeps> = {}): ProveDeps & { names: string[] } {
    const names: string[] = [];
    let n = 0;
    return {
        names,
        prepare: async (bot) => { names.push(bot); },
        checkStart: async () => ({ ok: true, detail: 'POS 3224 3245 0' }),
        run: async () => {
            n++;
            return { stdout: n % 2 === 1 ? 'RESULT ok' : 'RESULT bad', exitCode: 0 };
        },
        cleanup: async () => {},
        ...over,
    };
}

test('prove counts passing runs', async () => {
    const r = await prove({ bot: 'b', script: 's.ts', runs: 5, pass: s => s.includes('RESULT ok') }, fakeDeps());
    expect(r.runs).toBe(5);
    expect(r.passes).toBe(3);
    expect(r.results.map(x => x.ok)).toEqual([true, false, true, false, true]);
});

test('each run uses a fresh account so no old session can take over', async () => {
    const deps = fakeDeps();
    await prove({ bot: 'practice', script: 's.ts', runs: 3, preset: 'wc_lumbridge', pass: () => true }, deps);
    expect(deps.names).toEqual(['practicer1', 'practicer2', 'practicer3']);
    expect(new Set(deps.names).size).toBe(3);
});

test('a run whose start does not match the preset fails even if the script passes', async () => {
    const deps = fakeDeps({ checkStart: async () => ({ ok: false, detail: 'POS 3222 3218 0, preset 3224 3245 0' }) });
    const r = await prove({ bot: 'b', script: 's.ts', runs: 1, preset: 'wc_lumbridge', pass: () => true }, deps);
    expect(r.passes).toBe(0);
    expect(r.results[0]!.tail).toContain('preset not loaded');
});

test('runBotName stays within the 12-char alphanumeric limit', () => {
    expect(runBotName('practice1', 10)).toBe('practice1r10');
    expect(runBotName('averylongname', 3)).toMatch(/^[a-z0-9]{1,12}$/);
});

test('a non-zero exit is a failed run even if the pass check matches', async () => {
    const deps = fakeDeps({ run: async () => ({ stdout: 'RESULT ok', exitCode: 1 }) });
    const r = await prove({ bot: 'b', script: 's.ts', runs: 2, pass: s => s.includes('RESULT ok') }, deps);
    expect(r.passes).toBe(0);
});

test('wcPass needs positive Woodcutting XP', () => {
    expect(wcPass('RESULT chops=7 wcXpGained=4375 seconds=63.9')).toBe(true);
    expect(wcPass('RESULT chops=0 wcXpGained=0 seconds=10')).toBe(false);
    expect(wcPass('crashed')).toBe(false);
});
