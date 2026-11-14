import { describe, expect, test } from 'bun:test';
import { BENCH_ENGINE_GB, admitStart, heavyScript, otherHeavyJobs, ownJob, parseProcs, refusalLine, startProblems, type Proc, type StartFacts } from './bench-start-check';

const BUN = 'C:\\Users\\dev\\.bun\\bin\\bun.exe';
const proc = (pid: number, ppid: number, startedAt: number, commandLine: string, name = 'bun.exe'): Proc => ({ pid, ppid, name, startedAt, commandLine });
// This bench is pid 100. Its parent is the `bun run bench` process, pid 90, under a shell, pid 80.
const SELF = [proc(80, 1, 1000, 'bash', 'bash.exe'), proc(90, 80, 2000, `${BUN} run bench cook`), proc(100, 90, 3000, `${BUN} scripts/measure/aio-practice-bench.ts cook`)];
const facts = (over: Partial<StartFacts> = {}): StartFacts => ({ procs: SELF, selfPid: 100, busyPorts: [], freeGB: 12, floorGB: 4, engines: 3, ...over });

describe('heavyScript', () => {
    test('names the script that a bun process runs', () => {
        expect(heavyScript(proc(1, 0, 0, `${BUN} scripts/measure/aio-practice-bench.ts ^quester: --parallel 3`))).toBe('aio-practice-bench.ts');
        expect(heavyScript(proc(1, 0, 0, `"C:\\Program Files\\bun\\bun.exe" F:\\repo\\scripts\\ci-gate.ts --post`))).toBe('ci-gate.ts');
        expect(heavyScript(proc(1, 0, 0, `C:\\Program Files\\bun\\bun.exe scripts/ci-gate.ts`))).toBe('ci-gate.ts');
        expect(heavyScript(proc(1, 0, 0, `bun --smol run scripts/test-shards.ts --changed origin/master ./scripts`))).toBe('test-shards.ts');
    });
    test('a script name that is an argument, a test file or a process of another program is not a heavy job', () => {
        expect(heavyScript(proc(1, 0, 0, `${BUN} scripts/typecheck-narrow.ts scripts/ci-gate.ts`))).toBeNull();
        expect(heavyScript(proc(1, 0, 0, `${BUN} test ./scripts/measure/aio-practice-bench.test.ts`))).toBeNull();
        expect(heavyScript(proc(1, 0, 0, `${BUN} run bench cook`))).toBeNull();
        expect(heavyScript(proc(1, 0, 0, 'rg aio-practice-bench.ts scripts', 'rg.exe'))).toBeNull();
    });
});

describe('startProblems', () => {
    test('passes with no other heavy job, free ports and memory above the floor and the engines', () => {
        expect(startProblems(facts())).toEqual([]);
        expect(startProblems(facts({ freeGB: 4 + 3 * BENCH_ENGINE_GB }))).toEqual([]);
    });
    test('refuses beside the bench, the gate or the test shards of another owner, with the pid and the script', () => {
        const others = [proc(200, 1, 500, `${BUN} scripts/measure/aio-practice-bench.ts --smoke`), proc(300, 1, 5000, `${BUN} scripts/ci-gate.ts --post`), proc(310, 300, 5100, `${BUN} scripts/test-shards.ts ./scripts`)];
        expect(startProblems(facts({ procs: [...SELF, ...others] }))).toEqual(['another heavy job runs (pid 200 aio-practice-bench.ts, pid 300 ci-gate.ts, pid 310 test-shards.ts)']);
    });
    test('refuses when an engine port has a listener', () => {
        expect(startProblems(facts({ busyPorts: [21000] }))).toEqual(['port 21000 has a listener']);
    });
    test('refuses when the free memory is under the floor and the engines', () => {
        expect(startProblems(facts({ freeGB: 6.64 }))).toEqual(['6.6 GiB is free and the run needs 6.7 GiB (the floor of 4 GiB and 3 engines of 0.9 GiB)']);
        expect(startProblems(facts({ freeGB: 1.5, floorGB: 1, engines: 1 }))).toEqual(['1.5 GiB is free and the run needs 1.9 GiB (the floor of 1 GiB and 1 engine of 0.9 GiB)']);
    });
    test('names every cause in one line', () => {
        const line = refusalLine(startProblems(facts({ procs: [...SELF, proc(300, 1, 500, `${BUN} scripts/ci-gate.ts`)], busyPorts: [21000, 21010], freeGB: 3 })));
        expect(line).toBe('bench: not started: another heavy job runs (pid 300 ci-gate.ts); port 21000, 21010 has a listener; 3.0 GiB is free and the run needs 6.7 GiB (the floor of 4 GiB and 3 engines of 0.9 GiB). Use --wait <minutes> to wait for a safe start, or --force to skip this check.');
        expect(line).not.toContain('\n');
    });
    test('a process list that was not read gives no refusal of its own', () => {
        expect(startProblems(facts({ procs: null }))).toEqual([]);
        expect(startProblems(facts({ procs: null, busyPorts: [21000] }))).toHaveLength(1);
    });
});

describe('otherHeavyJobs', () => {
    test('the job that started this bench and the processes that this bench started do not count', () => {
        // A gate (pid 50) runs the test shards (60), a test of them starts this bench (100), and this bench started a child bench (110).
        const procs = [proc(50, 1, 1000, `${BUN} scripts/ci-gate.ts`), proc(60, 50, 1100, `${BUN} scripts/test-shards.ts ./scripts`), proc(70, 60, 1200, `${BUN} test ./scripts/a.test.ts`),
            proc(100, 70, 1300, `${BUN} scripts/measure/aio-practice-bench.ts --seeds 7,8`), proc(110, 100, 1400, `${BUN} scripts/measure/aio-practice-bench.ts --seed 7`)];
        expect(ownJob(procs, 100)).toEqual(new Set([100, 70, 60, 50, 110]));
        expect(otherHeavyJobs(procs, 100)).toEqual([]);
        expect(otherHeavyJobs(procs, 110)).toEqual([]);
    });
    test('the seed children of one --seed-jobs run are one job; benches of two test shards are two', () => {
        const parent = proc(100, 1, 1000, `${BUN} scripts/measure/aio-practice-bench.ts --seeds 1,2 --seed-jobs 2`);
        const a = proc(110, 100, 1100, `${BUN} scripts/measure/aio-practice-bench.ts --seed 1`), b = proc(120, 100, 1100, `${BUN} scripts/measure/aio-practice-bench.ts --seed 2`);
        expect(otherHeavyJobs([parent, a, b], 110)).toEqual([]);
        expect(otherHeavyJobs([parent, a, b], 120)).toEqual([]);
        const gate = proc(50, 1, 900, `${BUN} scripts/ci-gate.ts`), s1 = proc(60, 50, 950, `${BUN} test ./scripts/x.test.ts`), s2 = proc(61, 50, 950, `${BUN} test ./scripts/y.test.ts`);
        const b1 = proc(200, 60, 1000, `${BUN} scripts/measure/aio-practice-bench.ts cook`), b2 = proc(210, 61, 1000, `${BUN} scripts/measure/aio-practice-bench.ts fish`);
        expect(otherHeavyJobs([gate, s1, s2, b1, b2], 210)).toEqual([{ pid: 200, script: 'aio-practice-bench.ts' }]);
    });
    test('a process that holds the id of an ended parent is not a parent', () => {
        // Pid 90 started after this bench, so it is a later process with the id of the parent that ended.
        const procs = [proc(90, 1, 9000, `${BUN} scripts/ci-gate.ts`), proc(100, 90, 3000, `${BUN} scripts/measure/aio-practice-bench.ts`)];
        expect(otherHeavyJobs(procs, 100)).toEqual([{ pid: 90, script: 'ci-gate.ts' }]);
    });
    test('of two benches the first one runs: the later bench does not count for the first', () => {
        const first = proc(100, 1, 3000, `${BUN} scripts/measure/aio-practice-bench.ts cook`), later = proc(200, 1, 3400, `${BUN} scripts/measure/aio-practice-bench.ts fish`);
        expect(otherHeavyJobs([first, later], 100)).toEqual([]);
        expect(otherHeavyJobs([first, later], 200)).toEqual([{ pid: 100, script: 'aio-practice-bench.ts' }]);
        // The same start time: the lower pid runs.
        const twin = { ...later, startedAt: 3000 };
        expect(otherHeavyJobs([first, twin], 100)).toEqual([]);
        expect(otherHeavyJobs([first, twin], 200)).toHaveLength(1);
    });
    test('a process that is not a heavy job has its own start time, not the start of the shell above it', () => {
        // A tool (pid 100) under an old shell asks: the bench that started before the tool counts.
        const procs = [proc(80, 1, 1000, 'bash', 'bash.exe'), proc(100, 80, 5000, `${BUN} tool.ts`), proc(200, 1, 3000, `${BUN} scripts/measure/aio-practice-bench.ts`)];
        expect(otherHeavyJobs(procs, 100)).toEqual([{ pid: 200, script: 'aio-practice-bench.ts' }]);
    });
    test('a gate that started later counts: it does not run this check', () => {
        expect(otherHeavyJobs([...SELF, proc(300, 1, 9000, `${BUN} scripts/ci-gate.ts`)], 100)).toEqual([{ pid: 300, script: 'ci-gate.ts' }]);
    });
    test('a bench that waits does not stop a later child of the job that it waits for', () => {
        // A --seeds run (pid 40) started first. Bench 100 waits for it. The --seeds run then starts its next child (pid 45).
        const procs = [proc(40, 1, 1000, `${BUN} scripts/measure/aio-practice-bench.ts --seeds 7,8`), proc(100, 1, 3000, `${BUN} scripts/measure/aio-practice-bench.ts cook --wait 30`),
            proc(45, 40, 6000, `${BUN} scripts/measure/aio-practice-bench.ts --seed 8`)];
        expect(otherHeavyJobs(procs, 45)).toEqual([]);
        expect(otherHeavyJobs(procs, 100).map(o => o.pid)).toEqual([40, 45]);
    });
});

describe('parseProcs', () => {
    test('reads the lines and keeps a command line that holds the separator', () => {
        const text = ['0|0|System Idle Process|0|', `34532|9116|bun.exe|1794500000000|${BUN} scripts/measure/aio-practice-bench.ts ^quester:quest:(cook|crest)$ --parallel 3`, 'read'].join('\r\n');
        expect(parseProcs(text)).toEqual([{ pid: 0, ppid: 0, name: 'System Idle Process', startedAt: 0, commandLine: '' },
            { pid: 34532, ppid: 9116, name: 'bun.exe', startedAt: 1794500000000, commandLine: `${BUN} scripts/measure/aio-practice-bench.ts ^quester:quest:(cook|crest)$ --parallel 3` }]);
    });
    test('a list with no last `read` line is not a list', () => {
        expect(parseProcs('1|0|bun.exe|5|bun a.ts')).toBeNull();
        expect(parseProcs('')).toBeNull();
    });
});

describe('admitStart', () => {
    const plan = { root: '.', ports: [21000], engines: 1 };
    const busy = facts({ busyPorts: [21000] });
    test('a safe start gives null and does not wait', async () => {
        let slept = 0;
        expect(await admitStart(plan, 60_000, { read: async () => facts(), sleep: async () => { slept++; }, log: () => {} })).toBeNull();
        expect(slept).toBe(0);
    });
    test('with no wait a start that is not safe gives the refusal line at once', async () => {
        let reads = 0;
        expect(await admitStart(plan, 0, { read: async () => { reads++; return busy; }, sleep: async () => { throw new Error('must not wait'); }, log: () => {} })).toBe(refusalLine(['port 21000 has a listener']));
        expect(reads).toBe(1);
    });
    test('with a wait it starts when the cause ends', async () => {
        let clock = 0, reads = 0;
        const said: string[] = [];
        const result = await admitStart(plan, 120_000, { read: async () => (++reads < 4 ? busy : facts()), sleep: async ms => { clock += ms; }, now: () => clock, log: line => said.push(line) });
        expect(result).toBeNull();
        expect(clock).toBe(30_000);
        expect(said).toEqual(['bench: waiting, 2 min at most: port 21000 has a listener']);
    });
    test('a wait prints one line for each set of causes, not for each change of the free memory', async () => {
        let clock = 0, reads = 0;
        const said: string[] = [];
        const steps = [facts({ freeGB: 4.6, engines: 1 }), facts({ freeGB: 4.2, engines: 1 }), facts({ freeGB: 4.2, engines: 1, busyPorts: [21000] }), facts()];
        expect(await admitStart(plan, 60_000, { read: async () => steps[reads++]!, sleep: async ms => { clock += ms; }, now: () => clock, log: line => said.push(line) })).toBeNull();
        expect(said).toEqual(['bench: waiting, 1 min at most: 4.6 GiB is free and the run needs 4.9 GiB (the floor of 4 GiB and 1 engine of 0.9 GiB)',
            'bench: waiting, 1 min at most: port 21000 has a listener; 4.2 GiB is free and the run needs 4.9 GiB (the floor of 4 GiB and 1 engine of 0.9 GiB)']);
    });
    test('with a wait it gives the refusal line when the time is over', async () => {
        let clock = 0;
        const result = await admitStart(plan, 25_000, { read: async () => busy, sleep: async ms => { clock += ms; }, now: () => clock, log: () => {} });
        expect(result).toBe(refusalLine(['port 21000 has a listener']));
        expect(clock).toBe(25_000);
    });
});
