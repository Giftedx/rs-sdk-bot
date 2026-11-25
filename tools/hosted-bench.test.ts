import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {expect, test} from 'bun:test';
import {autoPlanOptions, benchPlan, checkArgs, decodeSetB64, evaluatePollState, expandMultiSeedArtifacts, extractPlanOpts, INITIAL_POLL_WAIT_MS, MAX_JOBS, parseBoundedIntFlag, parseRunId, POLL_BACKOFF_MS, pollDelayMs, resultLines} from './hosted-bench';

test('the plan gives one runner to each pattern and seed', () => {
    expect(benchPlan('^pvp:squad$  ^quester:quest:crest$', '7,8')).toEqual([
        {id: 'p1-s7', pattern: '^pvp:squad$', seed: '7'}, {id: 'p1-s8', pattern: '^pvp:squad$', seed: '8'},
        {id: 'p2-s7', pattern: '^quester:quest:crest$', seed: '7'}, {id: 'p2-s8', pattern: '^quester:quest:crest$', seed: '8'}]);
    expect(benchPlan('cook', '')).toEqual([{id: 'p1-s7', pattern: 'cook', seed: '7'}]);
    expect(() => benchPlan('', '7')).toThrow(/no bench pattern/);
    expect(() => benchPlan('cook', '7;rm')).toThrow(/seeds/);
    expect(() => benchPlan('(', '7')).toThrow();
    expect(() => benchPlan('a', Array.from({length: MAX_JOBS + 1}, (_, i) => i).join(','))).toThrow(/at most/);
});

test('extra arguments: the listed flags and --set KEY=value only', () => {
    expect(checkArgs('--profile --set SPAR_CAP=1200 --no-keep')).toEqual(['--profile', '--set', 'SPAR_CAP=1200', '--no-keep']);
    expect(checkArgs('')).toEqual([]);
    for (const bad of ['--force', '--over-budget', '--set', '--set a=1', '--set KEY=$(id)', '--parallel 9', '; ls', '--set KEY=a;b'])
        expect(() => checkArgs(bad)).toThrow();
});

test('result lines: one for each case, the failure text, the profile, and a runner with no result', () => {
    const profile = 'AIO_BENCH_PROFILE ' + JSON.stringify({case: 'a', wallMs: 35282, engineStartMs: 2654, engine: {startupMs: 3908, gameMsPerTick: 9.4}, client: {heldMs: 867, capped: 0}});
    const r = resultLines([
        {name: 'bench-p1-s8', rows: [{case: 'b', ok: false, elapsedMs: 1000, ledgerTicks: [], result: 'RESULT fail died'}], log: ''},
        {name: 'bench-p1-s7', rows: [{case: 'a', ok: true, elapsedMs: 35282, ledgerTicks: [3, 1050], output: 12}], log: 'x\n' + profile + '\n'},
        {name: 'bench-p2-s7', rows: [], log: 'bench: not started: port 21000 has a listener\n'}]);
    expect(r.lines).toEqual([
        'pass  seed 7  a  ticks 1050  35.3 s  output 12',
        '      profile  seed 7  a  wall 35.3 s  engine start 2.7 s  login wait 3.9 s  tick wait 9.4 ms  held 0.9 s  capped 0',
        'FAIL  seed 8  b  ticks -  1.0 s  RESULT fail died',
        'FAIL  seed 7  bench-p2-s7: no result (bench: not started: port 21000 has a listener)']);
    expect({failed: r.failed, cases: r.cases}).toEqual({failed: 2, cases: 2});
});

test('a pattern that starts with a dash is refused: the runner would read it as an option', () => {
    expect(() => benchPlan('--force', '7')).toThrow(/cannot start with "-"/);
    expect(() => benchPlan('cook -x', '7')).toThrow(/cannot start with "-"/);
    expect(benchPlan('a-b', '7')).toHaveLength(1);
});

test('--set-b64 decodes standard and URL-safe base64 JSON payloads and rejects malformed input', () => {
    const json = '{"eatAt":65,"comboFood":true}';
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    const b64url = Buffer.from('a', 'utf8').toString('base64url');
    expect(checkArgs(`--profile --set-b64 SQUAD_OPTS=${b64}`)).toEqual(['--profile', '--set-b64', `SQUAD_OPTS=${b64}`]);
    expect(decodeSetB64(`SQUAD_OPTS=${b64}`)).toEqual({key: 'SQUAD_OPTS', value: json});
    expect(decodeSetB64(`FLAG=${b64url}`)).toEqual({key: 'FLAG', value: 'a'});
    for (const bad of ['SQUAD_OPTS=', 'lower=YQ==', 'K=A', 'K=YQ=', 'K=bad!chars', 'K=YWJj=']) {
        expect(() => decodeSetB64(bad)).toThrow();
        expect(() => checkArgs(`--set-b64 ${bad}`)).toThrow();
    }
    expect(() => checkArgs('--set-b64')).toThrow();
    expect(INITIAL_POLL_WAIT_MS).toBe(20_000);
    expect(POLL_BACKOFF_MS).toEqual([15_000, 30_000]);
    expect(pollDelayMs(-1)).toBe(15_000);
    expect(pollDelayMs(0)).toBe(15_000);
    expect(pollDelayMs(1)).toBe(30_000);
    expect(pollDelayMs(5)).toBe(30_000);
});

test('batching and multi-seed fan-out pack patterns and seeds cleanly onto 4-vCPU runners', () => {
    expect(autoPlanOptions(3, 4)).toEqual({batch: 1, seedJobs: 2});
    expect(autoPlanOptions(6, 1)).toEqual({batch: 2, seedJobs: 1});
    expect(autoPlanOptions(6, 1, {arms: 8})).toEqual({batch: 3, seedJobs: 1});
    expect(autoPlanOptions(3, 4, {arms: 4})).toEqual({batch: 1, seedJobs: 4});
    expect(autoPlanOptions(6, 4, {arms: 4})).toEqual({batch: 2, seedJobs: 4});
    expect(autoPlanOptions(6, 4, {noBatch: true})).toEqual({batch: 1, seedJobs: 1});

    expect(benchPlan('^a$ ^b$ ^c$ ^d$', '7', {batch: 4, seedJobs: 1})).toEqual([
        {id: 'p1-s7', pattern: '(?:^a$)|(?:^b$)|(?:^c$)|(?:^d$)', seed: '7', parallel: '4'},
    ]);
    expect(benchPlan('^a$ ^b$', '1,2,3,4', {batch: 1, seedJobs: 4})).toEqual([
        {id: 'm1', pattern: '^a$', seed: '1', seeds: '1,2,3,4', seedJobs: '4'},
        {id: 'm2', pattern: '^b$', seed: '1', seeds: '1,2,3,4', seedJobs: '4'},
    ]);
    expect(extractPlanOpts('--profile --seed-jobs 4 --batch 2')).toEqual({seedJobs: 4, batch: 2});
    expect(() => checkArgs('--seed-jobs 9')).toThrow();
    expect(() => checkArgs('--batch 9')).toThrow();
});

test('expandMultiSeedArtifacts fans out multi-seed runner downloads into bench-p*-s* folders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hosted-multiseed-'));
    try {
        const mDir = join(dir, 'bench-m1-0123456789abcdef0123456789abcdef01234567');
        mkdirSync(join(mDir, 'bench-cases'), {recursive: true});
        mkdirSync(join(mDir, 'aio-bench', 'output-seed-1'), {recursive: true});
        mkdirSync(join(mDir, 'aio-bench', 'output-seed-2'), {recursive: true});
        writeFileSync(join(mDir, 'bench-cases', 'cases.json'), JSON.stringify({rows: [{case: 'extra:a', ok: true, seed: 1}]}));
        writeFileSync(join(mDir, 'bench-cases', 'seed-1.json'), JSON.stringify({rows: [{case: 'extra:a', ok: true, elapsedMs: 9000, ledgerTicks: [200]}]}));
        writeFileSync(join(mDir, 'bench-cases', 'seed-2.json'), JSON.stringify({rows: [{case: 'extra:a', ok: true, elapsedMs: 9500, ledgerTicks: [210]}]}));
        writeFileSync(join(mDir, 'bench-cases', 'seed-1.log'), 'AIO_BENCH start cases=1 runs=1 lockstep seed=1\n');
        writeFileSync(join(mDir, 'bench-cases', 'seed-2.log'), 'AIO_BENCH start cases=1 runs=1 lockstep seed=2\n');
        writeFileSync(join(mDir, 'aio-bench', 'output-seed-1', 'extra_a.log'), 'RESULT ok s1\n');
        writeFileSync(join(mDir, 'aio-bench', 'output-seed-2', 'extra_a.log'), 'RESULT ok s2\n');
        const expanded = expandMultiSeedArtifacts(dir);
        expect(expanded.has('bench-m1-0123456789abcdef0123456789abcdef01234567')).toBe(true);
        const s1Out = readFileSync(join(dir, 'bench-p1-s1-0123456789abcdef0123456789abcdef01234567', 'aio-bench', 'output', 'extra_a.log'), 'utf8');
        const s2Cases = JSON.parse(readFileSync(join(dir, 'bench-p1-s2-0123456789abcdef0123456789abcdef01234567', 'bench-cases', 'cases.json'), 'utf8'));
        expect(s1Out).toBe('RESULT ok s1\n');
        expect(s2Cases.rows[0].ledgerTicks).toEqual([210]);

        const simDir = join(dir, 'bench-m2-abcdef0123456789abcdef0123456789abcdef01');
        mkdirSync(join(simDir, 'bench-cases'), {recursive: true});
        mkdirSync(join(simDir, 'sim', 'aio-bench', 'output-seed-3'), {recursive: true});
        writeFileSync(join(simDir, 'bench-cases', 'cases.json'), JSON.stringify({rows: [{case: 'extra:b', ok: true, seed: 3}]}));
        writeFileSync(join(simDir, 'bench-cases', 'seed-3.json'), JSON.stringify({rows: [{case: 'extra:b', ok: true, elapsedMs: 1200, ledgerTicks: [99]}]}));
        writeFileSync(join(simDir, 'sim', 'aio-bench', 'output-seed-3', 'extra_b.log'), 'RESULT ok s3\n');
        const expandedSim = expandMultiSeedArtifacts(dir);
        expect(expandedSim.has('bench-m2-abcdef0123456789abcdef0123456789abcdef01')).toBe(true);
        expect(readFileSync(join(dir, 'bench-p2-s3-abcdef0123456789abcdef0123456789abcdef01', 'aio-bench', 'output', 'extra_b.log'), 'utf8')).toBe('RESULT ok s3\n');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('ci.yml bench-plan node planner matches benchPlan and enforces arg checks', () => {
    const yml = readFileSync(resolve(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8');
    const m = /bench-plan:[\s\S]*?node -e '\r?\n([\s\S]*?)\r?\n\s*' >>/.exec(yml);
    expect(m).not.toBeNull();
    const runPlan = (env: Record<string, string>) => Bun.spawnSync(['bun', '-e', m![1]!], {
        env: {...process.env, ...env},
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const ok = runPlan({BENCH_PATTERN: '^a$ ^b$', BENCH_SEEDS: '1,2,3,4', BENCH_ARGS: '--profile --seed-jobs 2 --set-b64 SQ=eyJ4IjoxfQ=='});
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString().trim()).toBe(`matrix=${JSON.stringify({include: benchPlan('^a$ ^b$', '1,2,3,4', {batch: 1, seedJobs: 2})})}`);
    const bad = runPlan({BENCH_PATTERN: '^a$', BENCH_SEEDS: '1', BENCH_ARGS: '--seed-jobs 9'});
    expect(bad.exitCode).not.toBe(0);
});

test('ci.yml caches Bun/route/pack across route-key-parity, measure, and rebalanced windows parts', () => {
    const yml = readFileSync(resolve(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8');
    const winMatch = /\n  windows:[\s\S]*?part:\s*\[([^\]]+)\][\s\S]*?--part \$\{\{ matrix\.part \}\}\/(\d+)/.exec(yml);
    expect(winMatch).not.toBeNull();
    const parts = winMatch![1]!.split(',').map(s => Number(s.trim()));
    expect(parts).toEqual(Array.from({length: Number(winMatch![2]!)}, (_, i) => i + 1));
    expect(parts.length).toBe(6);

    const measureSection = /\n  measure:[\s\S]*?(?=\n  \w[\w-]*:)/.exec(yml)?.[0] ?? '';
    expect(measureSection).toContain('~/.bun/install/cache');
    expect(measureSection).toContain('actions/cache/restore@v4');
    expect(measureSection).toContain('engine-pack-v3');
    expect(measureSection).toContain('.practice/hosted-rehearse/**');
    expect(measureSection).toContain('.practice/specialist-launch/**');

    const paritySection = /\n  route-key-parity:[\s\S]*?(?=\n  \w[\w-]*:)/.exec(yml)?.[0] ?? '';
    expect(paritySection).toContain('~/.bun/install/cache');
    expect(paritySection).toContain('actions/cache/restore@v4');
    expect(paritySection).toContain('route-caches-v2');
});

test('run id and bounded flag validation reject malformed inputs and evaluatePollState detects bench-plan failure', () => {
    expect(parseRunId('12345678')).toBe('12345678');
    for (const bad of ['', '../etc', '123abc', '12 34']) {
        expect(() => parseRunId(bad)).toThrow(/invalid --run id/);
    }
    expect(parseBoundedIntFlag('--batch', '4', 1, 8)).toBe(4);
    for (const bad of ['0', '9', 'abc', '-1']) {
        expect(() => parseBoundedIntFlag('--batch', bad, 1, 8)).toThrow(/--batch/);
    }
    expect(evaluatePollState({status: 'in_progress', jobs: [{name: 'bench-plan', status: 'completed', conclusion: 'failure'}]})).toEqual({
        done: true,
        planFailed: true,
        conclusion: 'failure',
    });
    expect(evaluatePollState({status: 'in_progress', jobs: [
        {name: 'bench-plan', status: 'completed', conclusion: 'success'},
        {name: 'bench-cases p1-s7', status: 'in_progress'},
    ]})).toEqual({done: false});
    expect(evaluatePollState({status: 'in_progress', jobs: [
        {name: 'bench-plan', status: 'completed', conclusion: 'success'},
        {name: 'bench-cases p1-s7', status: 'completed'},
    ]})).toEqual({done: true, planFailed: false});

    const missingVal = Bun.spawnSync([process.execPath, 'tools/hosted-bench.ts', '--run'], {
        cwd: resolve(import.meta.dir, '..'),
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
    });
    expect(missingVal.exitCode).toBe(2);
    expect(missingVal.stderr.toString()).toContain('--run requires a value');
});
