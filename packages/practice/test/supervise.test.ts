import { test, expect } from 'bun:test';
import { supervise } from '../src/supervise';

const out = (lines: string[], code: number) => async () => ({ stdout: lines.join('\n'), exitCode: code });

test('supervise restarts a run that ends without RESULT ok, and stops on RESULT ok', async () => {
    const runs = [out(['START 1 1 0', 'RESULT fail thieving 70 < 99'], 1), out(['START 1 1 0', 'RESULT ok thieving=99'], 0)];
    let n = 0;
    const r = await supervise({ run: () => runs[n++]!(), stopped: () => false, pause: async () => {}, maxRestarts: 5 });
    expect(n).toBe(2);
    expect(r.reason).toBe('done');
});

test('supervise does not restart after a stop file', async () => {
    let n = 0;
    const r = await supervise({ run: async () => { n++; return { stdout: 'RESULT fail stop file', exitCode: 1 }; }, stopped: () => true, pause: async () => {}, maxRestarts: 5 });
    expect(n).toBe(1);
    expect(r.reason).toBe('stopped');
});

test('supervise gives up after maxRestarts failures in a row', async () => {
    let n = 0;
    const r = await supervise({ run: async () => { n++; return { stdout: 'login: Error: Unable to connect', exitCode: 1 }; }, stopped: () => false, pause: async () => {}, maxRestarts: 3 });
    expect(n).toBe(4);
    expect(r.reason).toBe('gave-up');
});

test('a death ends supervision: restarting would walk the account into the same danger', async () => {
    let n = 0;
    const r = await supervise({ run: async () => { n++; return { stdout: 'RESULT fail died thieving=40 died=true', exitCode: 1 }; }, stopped: () => false, pause: async () => {}, maxRestarts: 5 });
    expect(n).toBe(1);
    expect(r.reason).toBe('died');
});
