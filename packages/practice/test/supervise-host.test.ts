import { test, expect } from 'bun:test';
import { classify, keptHostLine, lastResults, superviseHost } from '../src/supervise-host';
import { CLAIM_AUTHORITY_PAUSE_MS, HELD_CLAIM_TRIES, lineKeeper } from '../src/supervise';

test('the host keeper holds the last RESULT and LEDGER line of each account and reads the same as the full output', () => {
    const full = ['[A] noise', '[A] LEDGER ticks=10', '[B] RESULT fail x', '[A] RESULT ok one', '[B] LEDGER ticks=400 idle=2', '[A] LEDGER ticks=900', '[A] RESULT ok two', 'bare line'].join('\n');
    const keep = lineKeeper(keptHostLine);
    keep.push(full.slice(0, 40));
    keep.push(full.slice(40));
    const kept = keep.text();
    expect(Object.fromEntries(lastResults(kept))).toEqual({ A: 'RESULT ok two', B: 'RESULT fail x' });
    expect(kept.split('\n').filter(l => l.includes('LEDGER')).sort()).toEqual(['[A] LEDGER ticks=900', '[B] LEDGER ticks=400 idle=2']);
});

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

test('the host waits longer before its next run when the claim authority of an account did not answer', async () => {
    const fault = 'RESULT fail login: Error: fleet swarm claim authority unavailable or changed: spawnSync git ETIMEDOUT';
    const run = (lines: string[]) => { let n = 0; const pauses: number[] = []; return { pauses, deps: {
        run: async () => ({ stdout: n++ === 0 ? lines.join('\n') : ['a', 'b'].map(a => `[${a}] RESULT ok done`).join('\n'), exitCode: 0 }),
        stopped: () => false, pause: async (ms: number) => { pauses.push(ms); }, maxRestarts: 5 } }; };
    const slow = run([`[a] ${fault}`, '[b] RESULT fail bank did not open']);
    expect((await superviseHost(['a', 'b'], slow.deps)).ends).toEqual({ a: 'done', b: 'done' });
    expect(slow.pauses).toEqual([CLAIM_AUTHORITY_PAUSE_MS]);
    const other = run(['[a] RESULT fail bank did not open', '[b] RESULT fail shop closed']);
    expect((await superviseHost(['a', 'b'], other.deps)).ends).toEqual({ a: 'done', b: 'done' });
    expect(other.pauses).toEqual([10_000]);
});

test('hostStopped honors stop files in .practice/live/ as well as root .practice/', async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { hostStopped } = await import('../src/supervise-host');
    const dir = mkdtempSync(join(tmpdir(), 'supervise-host-stop-'));
    try {
        expect(hostStopped('HostedBot', dir)).toBe(false);
        mkdirSync(join(dir, '.practice', 'live'), { recursive: true });
        writeFileSync(join(dir, '.practice', 'live', 'stop-hostedbot'), 'owner live stop');
        expect(hostStopped('HostedBot', dir)).toBe(true);
        rmSync(join(dir, '.practice', 'live', 'stop-hostedbot'));
        expect(hostStopped('HostedBot', dir)).toBe(false);
        writeFileSync(join(dir, '.practice', 'stop-HostedBot'), 'legacy stop');
        expect(hostStopped('HostedBot', dir)).toBe(true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a waiting live update that drains the host ends its accounts as release-paused instead of a restart', async () => {
    let calls = 0;
    const r = await superviseHost(['a', 'b', 'c'], {
        run: async () => { calls++; return { stdout: '[a] RESULT ok\n[b] RESULT fail walk\n[c] RESULT fail walk\n', exitCode: 1 }; },
        stopped: () => false, pause: async () => { throw Error('must not retry'); }, maxRestarts: 5, drained: () => ['packages/workers/src/market/ge-buy.ts'],
    });
    expect(calls).toBe(1);
    expect(r).toEqual({ ends: { a: 'done', b: 'release-paused', c: 'release-paused' }, runs: 1 });
});

test('a hosted account that walks to the same failure twice with no gain ends as blocked', async () => {
    const out = '[a] LEDGER ticks=504 xp=0 inventory=0 move=442 idle=57\n[a] RESULT fail talk bartender\n[b] LEDGER ticks=504 xp=5 inventory=0 move=400 idle=50\n[b] RESULT fail talk bartender\n';
    let calls = 0;
    const r = await superviseHost(['a', 'b'], { run: async () => { calls++; return { stdout: calls < 3 ? out : '[b] RESULT ok\n', exitCode: 1 }; }, stopped: () => false, pause: async () => {}, maxRestarts: 5 });
    expect(r.ends).toEqual({ a: 'blocked', b: 'done' });
    expect(calls).toBe(3);
});

test('runHostPool dynamically runs heterogeneous bots, cancels one without affecting peers, runs chains in-host, and drains cleanly', async () => {
    const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { join, relative, resolve } = await import('node:path');
    const { parsePoolArgs, runHostPool, writePoolCommand } = await import('../src/supervise-host');
    const { DRAIN_STOP_TEXT } = await import('../../core/src/live-update-pending');

    expect(parsePoolArgs(['--pool', 'pool-1', '--max-bots', '6', '--max-launches', '32', '--idle-exit-ms', '5000', '--source', 'abc'])).toEqual({
        poolId: 'pool-1', maxBots: 6, maxLaunches: 32, idleExitMs: 5000, source: 'abc',
    });
    expect(parsePoolArgs(['scripts/x.ts', '20', 'a'])).toBeNull();

    const prac = resolve(import.meta.dir, '..', '..', '..', '.practice');
    mkdirSync(prac, { recursive: true });
    const root = mkdtempSync(join(prac, 'host-pool-test-'));
    const logDir = join(root, 'logs');
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    const botRel = relative(scriptsDir, resolve(import.meta.dir, '../../core/src/bot')).replaceAll('\\', '/');
    const botImport = botRel.startsWith('.') ? botRel : `./${botRel}`;
    const echoScript = join(scriptsDir, 'pool-echo.ts');
    writeFileSync(echoScript, `import { finish } from '${botImport}';
console.log('HELLO ' + process.argv[2] + ' env=' + (process.env.HOST_TEST_TAG ?? ''));
await finish([], true, 'bot=' + process.argv[2]);\n`);
    const sleeper = join(scriptsDir, 'sleep-worker.ts');
    writeFileSync(sleeper, `import { finish } from '${botImport}';
await new Promise(() => {});
await finish([], true, 'never');\n`);

    const stopFiles = new Set<string>();
    const drainStopBots = new Set<string>();
    let releaseFail = false;

    try {
        const poolPromise = runHostPool(
            { poolId: 'p1', maxBots: 4, maxLaunches: 10, idleExitMs: 5000, source: 'rev-1' },
            {
                root,
                pollMs: 25,
                stallMs: 0,
                pause: async () => {},
                leaseAllows: () => true,
                stopped: bot => stopFiles.has(bot.toLowerCase()),
                drainStopped: bot => drainStopBots.has(bot.toLowerCase()),
                drained: () => [],
                swarmStopped: () => false,
                assertRelease: env => { if (releaseFail && env.BOT_GOAL === 'rel-fail') throw Error('no worker progress: release source changed; live starts paused'); },
                log: () => {},
            },
        );

        const alphaLog = join(logDir, 'alpha.log');
        const chainLog = join(logDir, 'beta.log');
        const cancelLog = join(logDir, 'gamma.log');
        const drainLog = join(logDir, 'delta.log');

        // 1. Regular single script
        writePoolCommand(root, 'p1', { op: 'start', id: '1', bot: 'alpha', script: 'scripts/pool-echo.ts', args: [], maxRestarts: 1, env: { HOST_TEST_TAG: 'pool-a' }, logPath: alphaLog });
        // 2. Multi-step chain running in-host (zero child processes)
        writePoolCommand(root, 'p1', {
            op: 'start', id: '2', bot: 'beta', script: 'scripts/chain.ts',
            args: ['scripts/pool-echo.ts HOST_TEST_TAG=step1', 'scripts/pool-echo.ts HOST_TEST_TAG=step2'],
            maxRestarts: 1, env: { ROUNDS: '1' }, logPath: chainLog,
        });
        // 3. Long-running bot canceled individually (must NOT kill alpha/beta!)
        writePoolCommand(root, 'p1', { op: 'start', id: '3', bot: 'gamma', script: 'scripts/sleep-worker.ts', args: [], maxRestarts: 2, env: {}, logPath: cancelLog });
        // 4. Bot stopped with DRAIN_STOP_TEXT -> ends as release-paused
        writePoolCommand(root, 'p1', { op: 'start', id: '4', bot: 'delta', script: 'scripts/sleep-worker.ts', args: [], maxRestarts: 2, env: {}, logPath: drainLog });

        await Bun.sleep(100);
        stopFiles.add('gamma');
        writePoolCommand(root, 'p1', { op: 'cancel', id: 'c1', bot: 'gamma', reason: 'stop file' });
        stopFiles.add('delta');
        drainStopBots.add('delta');
        writePoolCommand(root, 'p1', { op: 'cancel', id: 'c2', bot: 'delta', reason: DRAIN_STOP_TEXT });
        // 5. Release refusal check
        releaseFail = true;
        const relLog = join(logDir, 'eps.log');
        writePoolCommand(root, 'p1', { op: 'start', id: '5', bot: 'epsilon', script: 'scripts/pool-echo.ts', args: [], maxRestarts: 2, env: { DEMO_OK: '1', BOT_GOAL: 'rel-fail' }, logPath: relLog });

        writePoolCommand(root, 'p1', { op: 'drain', id: 'd1' });
        const summary = await poolPromise;

        expect(summary.launches).toBe(5);
        expect(summary.ends.alpha).toBe('done after 1 runs');
        expect(summary.ends.beta).toBe('done after 1 runs');
        expect(summary.ends.gamma).toBe('stopped after 1 runs');
        expect(summary.ends.delta).toBe('release-paused after 1 runs');
        expect(summary.ends.epsilon).toBe('release-paused after 1 runs');

        expect(readFileSync(alphaLog, 'utf8')).toContain('HELLO alpha env=pool-a');
        expect(readFileSync(alphaLog, 'utf8')).toContain('SUPERVISE end done after 1 runs');
        expect(readFileSync(chainLog, 'utf8')).toContain('RESULT ok chain rounds=1 ok=2 failed=0');
        expect(readFileSync(chainLog, 'utf8')).toContain('SUPERVISE end done after 1 runs');
        expect(readFileSync(cancelLog, 'utf8')).toContain('SUPERVISE end stopped after 1 runs');
        expect(readFileSync(drainLog, 'utf8')).toContain('SUPERVISE end release-paused after 1 runs');
        expect(readFileSync(relLog, 'utf8')).toContain('SUPERVISE end release-paused after 1 runs');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
