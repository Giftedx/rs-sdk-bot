import {expect, test} from 'bun:test';
import {benchPlan, checkArgs, resultLines, MAX_JOBS} from './hosted-bench';

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
