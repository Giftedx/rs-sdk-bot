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
    expect(deps.names.map(n => n.slice(-1))).toEqual(['1', '2', '3']);
    expect(deps.names.every(n => /^[a-zA-Z0-9]{1,12}$/.test(n))).toBe(true);
    expect(new Set(deps.names).size).toBe(3);
});

test('a run whose start does not match the preset fails even if the script passes', async () => {
    const deps = fakeDeps({ checkStart: async () => ({ ok: false, detail: 'POS 3222 3218 0, preset 3224 3245 0' }) });
    const r = await prove({ bot: 'b', script: 's.ts', runs: 1, preset: 'wc_lumbridge', pass: () => true }, deps);
    expect(r.passes).toBe(0);
    expect(r.results[0]!.tail).toContain('preset not loaded');
});

test('runBotName stays within the 12-char alphanumeric limit', () => {
    expect(runBotName('practice1', 10)).toMatch(/^[a-zA-Z0-9]{1,12}$/);
    expect(runBotName('practice1', 10).endsWith('10')).toBe(true);
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

test('in-process mode: passes on START matching the preset and RESULT ok', async () => {
    const { proveInProcess, okPass } = await import('../src/prove');
    const made: string[] = [];
    const cleaned: string[] = [];
    const deps = {
        prepare: async (bot: string) => { made.push(bot); },
        run: async () => ({ stdout: 'START 3224 3245 0\nRESULT ok chopped 5', exitCode: 0 }),
        cleanup: async (bot: string) => { cleaned.push(bot); },
    };
    const r = await proveInProcess({ bot: 'gath', script: 's.ts', runs: 2, preset: 'wc_lumbridge', companions: [{ suffix: 'b', preset: 'fresh_lumbridge' }], pass: okPass }, deps);
    expect(r.passes).toBe(2);
    expect(made.length).toBe(4);
    expect(made[1]).toBe(made[0] + 'b');
    expect(made[3]).toBe(made[2] + 'b');
    expect(new Set(made).size).toBe(4);
    expect(cleaned).toEqual(made);
});

test('in-process mode keeps MILESTONE and RATE lines in the tail, so step timings reach the report', async () => {
    const { proveInProcess, okPass } = await import('../src/prove');
    const out = ['START 3222 3218 0', 'noise', 'MILESTONE coins60 210', 'MILESTONE ardougne 540', 'RATE thieving 900 600', 'RESULT ok done'].join('\n');
    const deps = { prepare: async () => {}, run: async () => ({ stdout: out, exitCode: 0 }), cleanup: async () => {} };
    const r = await proveInProcess({ bot: 'mile', script: 's.ts', runs: 1, preset: 'floors_lumbridge', pass: okPass }, deps);
    expect(r.results[0]!.tail).toContain('MILESTONE coins60 210');
    expect(r.results[0]!.tail).toContain('MILESTONE ardougne 540');
    expect(r.results[0]!.tail).toContain('RATE thieving 900 600');
    expect(r.results[0]!.tail).not.toContain('noise');
});

test('in-process mode: a missing or wrong START line fails the run', async () => {
    const { proveInProcess, okPass } = await import('../src/prove');
    const deps = (out: string) => ({ prepare: async () => {}, run: async () => ({ stdout: out, exitCode: 0 }), cleanup: async () => {} });
    expect((await proveInProcess({ bot: 'g', script: 's', runs: 1, preset: 'wc_lumbridge', pass: okPass }, deps('RESULT ok'))).passes).toBe(0);
    expect((await proveInProcess({ bot: 'g', script: 's', runs: 1, preset: 'wc_lumbridge', pass: okPass }, deps('START 1 2 0\nRESULT ok'))).passes).toBe(0);
    expect((await proveInProcess({ bot: 'g', script: 's', runs: 1, preset: 'wc_lumbridge', pass: okPass }, deps('START 3224 3245 0\nRESULT fail no tree'))).passes).toBe(0);
});

test('run bot names are new on every invocation, so no earlier save can win over the preset', async () => {
    const { runBotName } = await import('../src/prove');
    const a = runBotName('flor', 1);
    await Bun.sleep(5);
    const b = runBotName('flor', 1);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-zA-Z0-9]{1,12}$/);
});

test('in-process mode passes extra script arguments after the bot name', async () => {
    const { proveInProcess } = await import('../src/prove');
    let seen: string[] = [];
    const deps = { prepare: async () => {}, run: async (_s: string, _b: string, _t: number, args?: string[]) => { seen = args ?? []; return { stdout: 'START 3224 3245 0\nRESULT ok', exitCode: 0 }; }, cleanup: async () => {} };
    await proveInProcess({ bot: 'm', script: 's', scriptArgs: ['oaks', '600'], runs: 1, preset: 'wc_lumbridge', pass: () => true }, deps);
    expect(seen).toEqual(['oaks', '600']);
});
