import { test, expect } from 'bun:test';
import { classify, lastResults, superviseHost } from '../src/supervise-host';

test('classify applies the supervise.ts rules to one account', () => {
    expect(classify('RESULT ok ticks=9000', false)).toBe('done');
    expect(classify('RESULT fail died ticks=10 died=true', false)).toBe('died');
    expect(classify('RESULT fail x died=true', false)).toBe('died');
    expect(classify('RESULT fail no food ticks=1', false)).toBe('stopped');
    expect(classify('RESULT ok stop file', false)).toBe('done');
    expect(classify('RESULT fail walk', true)).toBe('stopped');
    expect(classify('RESULT fail walk', false)).toBeNull();
    expect(classify(undefined, false)).toBeNull();
});

test('lastResults keeps the last RESULT per account from host output', () => {
    const m = lastResults('[a] START 1 2 0\n[a] RESULT fail x\n[b] RESULT ok y\n[a] RESULT ok z\nRESULT stray');
    expect([...m]).toEqual([['a', 'RESULT ok z'], ['b', 'RESULT ok y']]);
});

test('the host restarts only failed accounts and never an account that died', async () => {
    const calls: string[][] = [];
    const outs = [
        '[a] RESULT ok\n[b] RESULT fail died died=true\n[c] RESULT fail walk\n',
        '[c] RESULT fail walk again\n',
        '[c] RESULT ok\n',
    ];
    const r = await superviseHost(['a', 'b', 'c'], {
        run: async acc => { calls.push(acc); return { stdout: outs[calls.length - 1]!, exitCode: 1 }; },
        stopped: () => false, pause: async () => {}, maxRestarts: 5,
    });
    expect(calls).toEqual([['a', 'b', 'c'], ['c'], ['c']]);
    expect(r.ends).toEqual({ a: 'done', b: 'died', c: 'done' });
});

test('a host that exits with no RESULT is restarted; restarts run out to gave-up; stop files end accounts', async () => {
    const calls: string[][] = [];
    let stop = false;
    const r = await superviseHost(['a', 'b'], {
        run: async acc => { calls.push(acc); if (calls.length === 2) stop = true; return { stdout: '', exitCode: 1 }; },
        stopped: a => stop && a === 'a', pause: async () => {}, maxRestarts: 2,
    });
    expect(calls).toEqual([['a', 'b'], ['a', 'b'], ['b']]);
    expect(r.ends).toEqual({ a: 'stopped', b: 'gave-up' });
});


test('host blocks a no-progress account on its first run while retrying a transient login for its peer', async () => {
    const calls: string[][] = [];
    const result = await superviseHost(['stuck', 'transient', 'dead'], {
        run: async accounts => {
            calls.push(accounts);
            return calls.length === 1
                ? { stdout: '[stuck] RESULT fail Error: spinning made no progress\n[transient] RESULT fail login timeout\n[dead] RESULT fail died=true', exitCode: 1 }
                : { stdout: '[transient] RESULT ok collected=20', exitCode: 0 };
        },
        stopped: () => false, pause: async () => {}, maxRestarts: 20,
    });
    expect(calls).toEqual([['stuck', 'transient', 'dead'], ['transient']]);
    expect(result.ends).toEqual({ stuck: 'blocked', transient: 'done', dead: 'died' });
});
