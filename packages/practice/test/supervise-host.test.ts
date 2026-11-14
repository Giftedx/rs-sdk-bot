import { test, expect } from 'bun:test';
import { classify, lastResults, superviseHost } from '../src/supervise-host';
import { HELD_CLAIM_TRIES } from '../src/supervise';

test('host release refusal pauses each account without retrying',async()=>{
 const r=await superviseHost(['a','b'],{run:async()=>({stdout:['a','b'].map(a=>`[${a}] RESULT fail Error: no worker progress: release source changed; live starts paused`).join('\n'),exitCode:1}),
 stopped:()=>false,pause:async()=>{throw Error('must not retry');},maxRestarts:20});
 expect(r.ends).toEqual({a:'release-paused',b:'release-paused'});expect(r.runs).toBe(1);
 expect(classify('RESULT fail Error: no courier progress: collection credit unbound',false)).toBe('blocked');
 expect(classify('RESULT fail no Ranged progress: Error: route failed tick stream stalled: no new game tick for 15000ms',false)).toBeNull();
});

test('classify applies the supervise.ts rules to one account', () => {
    expect(classify('RESULT ok ticks=9000', false)).toBe('done');
    expect(classify('RESULT fail died ticks=10 died=true', false)).toBe('died');
    expect(classify('RESULT fail x died=true', false)).toBe('died');
    expect(classify('RESULT fail no food ticks=1', false)).toBe('stopped');
    expect(classify('RESULT ok stop file', false)).toBe('done');
    expect(classify('RESULT fail walk', true)).toBe('stopped');
    expect(classify('RESULT fail walk', false)).toBeNull();
    expect(classify('RESULT okay', false)).toBeNull();
    expect(classify(undefined, false)).toBeNull();
});

test('the host blocks a real missing quest after one attempt, while success keeps priority', () => {
    const detail='essence {"failure":"Error: Rune Mysteries quest required: Aubury refused teleport"}';
    expect(classify(`RESULT fail ${detail}`,false)).toBe('blocked');
    expect(classify(`RESULT ok ${detail}`,false)).toBe('done');
    expect(classify(`RESULT fail ${detail}`,true)).toBe('stopped');
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

test('the host supervisor keeps script arguments and passes each run only the env of its accounts', async () => {
    const { parseSuperviseHostArgs, hostOptions } = await import('../src/supervise-host');
    const p = parseSuperviseHostArgs(['scripts/goldfarm.ts', '20', 'a', 'b', '--arg', 'x,y', '--env', 'a', 'KNIGHT_SPOT=2670,3306', '--env', 'b', 'KNIGHT_SPOT=2653,3302', '--args', 'p,q']);
    expect(p).toEqual({ script: 'scripts/goldfarm.ts', maxRestarts: 20, accounts: ['a', 'b'], args: ['x,y', 'p', 'q'], env: { a: { KNIGHT_SPOT: '2670,3306' }, b: { KNIGHT_SPOT: '2653,3302' } } });
    expect(hostOptions(p, ['a', 'b'])).toEqual(['--arg', 'x,y', '--arg', 'p', '--arg', 'q', '--env', 'a', 'KNIGHT_SPOT=2670,3306', '--env', 'b', 'KNIGHT_SPOT=2653,3302']);
    expect(hostOptions(p, ['b'])).toEqual(['--arg', 'x,y', '--arg', 'p', '--arg', 'q', '--env', 'b', 'KNIGHT_SPOT=2653,3302']);
    expect(() => parseSuperviseHostArgs(['s.ts', '20'])).toThrow(/usage/);
    expect(() => parseSuperviseHostArgs(['s.ts', 'many', 'a'])).toThrow(/maxRestarts/);
    expect(() => parseSuperviseHostArgs(['s.ts', '20', 'a', '--env', 'c', 'K=1'])).toThrow(/c/);
    expect(() => parseSuperviseHostArgs(['s.ts', '20', 'a', '--bogus'])).toThrow(/unknown option/);
});

test('hosted entry refusals end without a retry and retain death and stop priority', async () => {
    let calls = 0;
    const r = await superviseHost(['refused', 'dead', 'paused'], {
        run: async () => {
            calls++;
            return { stdout: '[refused] RESULT fail shark entry missing ticks=0\n[dead] RESULT fail died=true ticks=0\n[paused] RESULT fail missing kit ticks=0 stop file', exitCode: 1 };
        },
        stopped: () => false, pause: async () => { throw Error('must not retry entry'); }, maxRestarts: 20,
    });
    expect(calls).toBe(1);
    expect(r).toEqual({ ends: { refused: 'refused', dead: 'died', paused: 'stopped' }, runs: 1 });
});

test('two identical fast hosted failures block only their account while a productive peer continues', async () => {
    const calls: string[][] = [];
    const r = await superviseHost(['stuck', 'working'], {
        run: async accounts => {
            calls.push(accounts);
            if (calls.length > 3) throw Error('unexpected retry');
            return { stdout: calls.length === 3 ? '[working] RESULT ok completed=10'
                : `[stuck] RESULT fail recipe unavailable amount=${calls.length * 10}\n[working] LEDGER ticks=1200 xp=9000\n[working] RESULT fail session ended: disconnected`, exitCode: 1 };
        },
        stopped: () => false, pause: async () => {}, maxRestarts: 20,
    });
    expect(calls).toEqual([['stuck', 'working'], ['stuck', 'working'], ['working']]);
    expect(r).toEqual({ ends: { stuck: 'blocked', working: 'done' }, runs: 3 });
});

test('held hosted claims stop after the shared refusal limit so recovery can start', async () => {
    let calls = 0;
    const r = await superviseHost(['held'], {
        run: async () => { calls++; return { stdout: '[held] RESULT fail login: Error: fleet account claim held by swarm', exitCode: 1 }; },
        stopped: () => false, pause: async () => {}, maxRestarts: 20,
    });
    expect(calls).toBe(HELD_CLAIM_TRIES);
    expect(r).toEqual({ ends: { held: 'gave-up' }, runs: HELD_CLAIM_TRIES });
});

test('held-claim streaks reset after another failure instead of adding separated refusals', async () => {
    const results = [
        'RESULT fail fleet account claim held by swarm', 'RESULT fail fleet account claim held by swarm',
        'RESULT fail login: connection timeout',
        'RESULT fail fleet account claim held by swarm', 'RESULT fail fleet account claim held by swarm', 'RESULT ok recovered',
    ];
    let calls = 0;
    const r = await superviseHost(['held'], {
        run: async () => ({ stdout: `[held] ${results[calls++]}`, exitCode: 1 }),
        stopped: () => false, pause: async () => {}, maxRestarts: 20,
    });
    expect(calls).toBe(6);
    expect(r.ends).toEqual({ held: 'done' });
});

test('productive hosted runs reset only their own retry budget after transport disconnects', async () => {
    const calls: string[][] = [];
    const r = await superviseHost(['cold', 'working'], {
        run: async accounts => {
            calls.push(accounts);
            if (calls.length > 5) throw Error('unexpected retry');
            return { stdout: '[cold] RESULT fail login: connection timeout\n[working] LEDGER ticks=1200 xp=9000\n[working] RESULT fail session ended: disconnected', exitCode: 1 };
        },
        stopped: account => account === 'working' && calls.length >= 5, pause: async () => {}, maxRestarts: 1,
    });
    expect(calls).toEqual([['cold', 'working'], ['cold', 'working'], ['working'], ['working'], ['working']]);
    expect(r).toEqual({ ends: { cold: 'gave-up', working: 'stopped' }, runs: 5 });
});

test('only the last ledger of the hosted account resets its failure budget', async () => {
    let calls = 0;
    const r = await superviseHost(['a'], {
        run: async () => {
            calls++;
            return { stdout: '[a] LEDGER ticks=1200 xp=9000\n[a] LEDGER ticks=3 xp=0\n[other] LEDGER ticks=9000 xp=90000\n[a] RESULT fail session ended: disconnected', exitCode: 1 };
        },
        stopped: () => false, pause: async () => {}, maxRestarts: 1,
    });
    expect(calls).toBe(2);
    expect(r.ends).toEqual({ a: 'gave-up' });
});

test('hosted account names that match object properties run and retain their own terminal ends', async () => {
    const names = ['constructor', 'toString', '__proto__'];
    const calls: string[][] = [];
    const r = await superviseHost(names, {
        run: async accounts => {
            calls.push(accounts);
            return { stdout: accounts.map(name => `[${name}] RESULT ok ticks=1`).join('\n'), exitCode: 0 };
        },
        stopped: () => false, pause: async () => { throw Error('must not retry success'); }, maxRestarts: 0,
    });
    expect(calls).toEqual([names]);
    expect(r.runs).toBe(1);
    expect(Object.keys(r.ends)).toEqual(names);
    for (const name of names) {
        expect(Object.hasOwn(r.ends, name)).toBe(true);
        expect(r.ends[name]).toBe('done');
    }
});
