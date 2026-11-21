import {expect, test} from 'bun:test';
import {DEFAULT_PARITY_CONCURRENCY, mapWithConcurrency, parsePlansLine, runParityChecks} from './route-key-parity';

test('parsePlansLine parses PLANS line cleanly and raises informative failure on missing or nonzero exit', () => {
    expect(parsePlansLine('warning line\nPLANS ["a","b"]\n', '--shared')).toEqual(['a', 'b']);
    expect(() => parsePlansLine('warning only\n', '--one 0', 'boom tail', 1)).toThrow(/--one 0.*boom tail/);
    expect(() => parsePlansLine('no plans here\n', '--one 2', '', 0)).toThrow(/--one 2.*no plans here/);
});

test('mapWithConcurrency bounds parallel workers and preserves input order', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 3, async (item, index) => {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(item * 5);
        active--;
        return `${index}:${item}`;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(out).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3', '5:0']);
});

test('runParityChecks executes --shared and --one children within concurrency cap and preserves order', async () => {
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    const res = await runParityChecks(5, async args => {
        const key = args.join(' ');
        seen.push(key);
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(key === '--shared' ? 25 : 10);
        active--;
        if (key === '--shared') return ['p0', 'p1', 'p2', 'p3', 'p4'];
        const idx = Number(args[1]);
        return [`p${idx}`];
    }, DEFAULT_PARITY_CONCURRENCY);
    expect(peak).toBeLessThanOrEqual(DEFAULT_PARITY_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(seen).toEqual(['--shared', '--one 0', '--one 1', '--one 2', '--one 3', '--one 4']);
    expect(res).toEqual({
        shared: ['p0', 'p1', 'p2', 'p3', 'p4'],
        alone: ['p0', 'p1', 'p2', 'p3', 'p4'],
    });
});
