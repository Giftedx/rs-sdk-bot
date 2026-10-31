import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { hostedBots, isChainScript, parseHostArgs } from '../src/host';

test('host keeps account order and zero values when flags appear between accounts', () => {
    expect(parseHostArgs(['worker.ts', 'first', '--stagger-ms', '0', 'second', '--mem-every-s', '5'])).toEqual({ script: 'worker.ts', names: ['first', 'second'], args: [], env: {}, stagger: 0, memEvery: 5 });
});

test('--env gives one bot its own variables; --arg keeps commas inside a value', () => {
    const parsed = parseHostArgs(['scripts/goldfarm.ts', 'a', 'b', '--env', 'a', 'KNIGHT_SPOT=2670,3306', '--env', 'b', 'KNIGHT_SPOT=2653,3302', '--env', 'a', 'TICKS=600', '--arg', 'x,y', '--args', 'p,q']);
    expect(parsed.env).toEqual({ a: { KNIGHT_SPOT: '2670,3306', TICKS: '600' }, b: { KNIGHT_SPOT: '2653,3302' } });
    expect(parsed.args).toEqual(['x,y', 'p', 'q']);
    const bots = hostedBots(parsed);
    expect(bots.map(b => [b.name, b.env?.KNIGHT_SPOT, b.args, b.steps])).toEqual([['a', '2670,3306', ['x,y', 'p', 'q'], undefined], ['b', '2653,3302', ['x,y', 'p', 'q'], undefined]]);
    expect(() => parseHostArgs(['w.ts', 'a', '--env', 'zed', 'K=1'])).toThrow(/zed/);
    expect(() => parseHostArgs(['w.ts', 'a', '--env', 'a', 'lower=1'])).toThrow(/KEY=value/);
    expect(() => parseHostArgs(['w.ts', 'a', '--env', 'a'])).toThrow(/KEY=value/);
});

test('the chain script turns the arguments into every bot\'s steps', () => {
    expect(isChainScript('scripts/chain.ts')).toBe(true);
    expect(isChainScript('F:\\r\\scripts\\chain.ts')).toBe(true);
    expect(isChainScript('scripts/goldfarm.ts')).toBe(false);
    const parsed = parseHostArgs(['scripts/chain.ts', 'a', 'b', '--arg', 'scripts/generated/thieving60.ts TARGET=55 CAP=3000', '--arg', 'scripts/goldfarm.ts', '--env', 'b', 'KNIGHT_SPOT=2582,3297']);
    const [a, b] = hostedBots(parsed);
    expect(a!.steps).toEqual([{ script: 'scripts/generated/thieving60.ts', args: [], env: { TARGET: '55', CAP: '3000' } }, { script: 'scripts/goldfarm.ts', args: [], env: {} }]);
    expect(b!.steps).toEqual(a!.steps);
    expect(b!.env).toEqual({ KNIGHT_SPOT: '2582,3297' });
    expect(() => hostedBots(parseHostArgs(['scripts/chain.ts', 'a']))).toThrow(/at least one/);
    expect(() => hostedBots(parseHostArgs(['scripts/chain.ts', 'a', '--arg', 'rm -rf /']))).toThrow(/scripts/);
});

for (const args of [
    ['--stagger-ms'],
    ['--stagger-ms', '--mem-every-s', '1'],
    ['--stagger-ms', 'NaN'],
    ['--mem-every-s', '-1'],
    ['--mem-every-s', 'Infinity'],
    ['--mem-every-s', '0.3'],
    ['--stagger-ms', ' '],
    ['--stagger-ms', '0', '--stagger-ms', '2'],
    ['--stager-ms', '2'],
    ['--env', 'nobody', 'K=1'],
    ['--env', 'testonly', 'k=1'],
]) test(`host rejects invalid launch options before running workers: ${args.join(' ')}`, async () => {
    const child = Bun.spawn(['bun', join(import.meta.dir, '../src/host.ts'), join(import.meta.dir, 'fixtures/host-main.ts'), 'testonly', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const timeout = setTimeout(() => child.kill(), 10_000);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code).toBe(2);
        expect(stdout).not.toContain('HOST start');
        expect(stderr).toContain('invalid host arguments:');
    } finally { clearTimeout(timeout); }
});
