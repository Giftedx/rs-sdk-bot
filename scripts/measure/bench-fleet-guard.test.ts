import { describe, expect, test } from 'bun:test';
import { BENCH_CASE_GB, FLEET_STOP_EXIT, LIVE_MAX_ENGINES, admitStart, fleetStop, memoryProblems, startProblems, type Proc, type StartFacts } from './bench-start-check';

const BUN = 'C:/Users/dev/.bun/bin/bun.exe';
const proc = (pid: number, ppid: number, startedAt: number, commandLine: string, name = 'bun.exe'): Proc => ({ pid, ppid, name, startedAt, commandLine });
const SELF = [proc(90, 1, 2000, `${BUN} run bench cook`), proc(100, 90, 3000, `${BUN} scripts/measure/aio-practice-bench.ts cook`)];
const facts = (over: Partial<StartFacts> = {}): StartFacts => ({ procs: SELF, selfPid: 100, busyPorts: [], freeGB: 12, floorGB: 4, engines: 3, ...over });
const live = { bots: 17, reserveGB: 1.5 };

describe('a bench beside a live fleet', () => {
    test('each engine counts as a whole case and the swarm reserve stays free', () => {
        const need = 4 + 1.5 + 2 * BENCH_CASE_GB;
        expect(need).toBe(8.5);
        expect(startProblems(facts({ engines: 2, freeGB: need, fleet: live }))).toEqual([]);
        expect(startProblems(facts({ engines: 2, freeGB: 8.4, fleet: live }))).toEqual(['8.4 GiB is free and the run needs 8.5 GiB (the floor of 4 GiB and 2 engines of 1.5 GiB, beside 17 live bots with 1.5 GiB held for bot starts)']);
        // The same memory with no fleet starts: the rule changes only beside live bots.
        expect(startProblems(facts({ engines: 2, freeGB: 8.4 }))).toEqual([]);
    });

    test('four engines at most', () => {
        expect(memoryProblems(facts({ engines: LIVE_MAX_ENGINES + 1, freeGB: 30, fleet: { bots: 1, reserveGB: 0 } }))).toEqual(['5 engines beside the live fleet, 4 at most (--parallel 4)']);
        expect(memoryProblems(facts({ engines: 6, freeGB: 30 }))).toEqual([]);
    });

    test('--force keeps the memory rule beside a fleet and drops the other checks', async () => {
        const busy = facts({ engines: 1, freeGB: 5, fleet: live, busyPorts: [21000], procs: [...SELF, proc(300, 1, 500, `${BUN} scripts/ci-gate.ts`)] });
        const plan = { root: '.', ports: [], engines: 1 }, log = () => {};
        expect(await admitStart(plan, 0, { read: async () => busy, log, memoryOnly: true })).toMatch(/^bench: not started: 5\.0 GiB is free and the run needs 7\.0 GiB/);
        expect(await admitStart(plan, 0, { read: async () => ({ ...busy, freeGB: 7 }), log, memoryOnly: true })).toBeNull();
        // With no fleet --force skips the whole check, as before.
        expect(await admitStart(plan, 0, { read: async () => ({ ...busy, fleet: null, freeGB: 0.5 }), log, memoryOnly: true })).toBeNull();
        // Without --force the other job and the port still refuse the start.
        expect(await admitStart(plan, 0, { read: async () => ({ ...busy, freeGB: 7 }), log })).toMatch(/another heavy job runs.*port 21000/);
    });

    test('a run stops when the free memory is under the floor and the reserve', () => {
        expect(fleetStop({ freeGB: 5.5, floorGB: 4, fleet: live })).toBeNull();
        expect(fleetStop({ freeGB: 5.4, floorGB: 4, fleet: live })).toMatch(/^bench: stopped: 5\.4 GiB is free beside 17 live bots and the fleet needs 5\.5 GiB \(the floor of 4 GiB and 1\.5 GiB for bot starts\)\. Run the cases on a hosted runner/);
        expect(fleetStop({ freeGB: 3.9, floorGB: 4, fleet: { bots: 6, reserveGB: 0 } })).toMatch(/3\.9 GiB is free beside 6 live bots and the fleet needs 4\.0 GiB \(the floor of 4 GiB\)/);
        expect(fleetStop({ freeGB: 0.2, floorGB: 1, fleet: null })).toBeNull();
        expect(FLEET_STOP_EXIT).toBe(4);
    });
});

import { fleetFacts, liveBotProcs } from './bench-start-check';
describe('a fleet whose swarm wrote no fresh state', () => {
    const WIN = 'C:/Users/dev/.bun/bin/bun.exe F:/repo/packages/practice/src/';
    test('the supervisors of live bots in the process list are the second signal', () => {
        const BS = String.fromCharCode(92), procs = [...SELF, proc(400, 1, 100, WIN + 'supervise.ts Moneyshot'), proc(401, 1, 100, ['bun.exe F:', 'repo', 'packages', 'practice', 'src', 'supervise-host.ts a b'].join(BS)), proc(402, 1, 100, WIN + 'supervised.ts'), proc(403, 1, 100, 'node F:/repo/packages/practice/src/supervise.ts', 'node.exe')];
        expect(liveBotProcs(procs)).toBe(2);
        expect(liveBotProcs(SELF)).toBe(0);
        expect(liveBotProcs(null)).toBe(0);
    });
    test('live bots with a stale swarm state keep the fleet floor and stop a run under it', () => {
        // '.' in this test has no fresh swarm state: the facts come from the bot count alone.
        const none = fleetFacts('.practice/no-such-checkout', 0, 3.9), bots = fleetFacts('.practice/no-such-checkout', 2, 3.9);
        expect(none.fleet).toBeNull();
        expect(fleetStop(none)).toBeNull();
        expect(bots).toEqual({ freeGB: 3.9, floorGB: 4, fleet: { bots: 2, reserveGB: 0 } });
        expect(fleetStop(bots)).toMatch(/3\.9 GiB is free beside 2 live bots and the fleet needs 4\.0 GiB/);
        expect(memoryProblems(facts({ engines: 1, ...fleetFacts('.practice/no-such-checkout', 2, 5.4) }))).toHaveLength(1);
    });
});
test('the refusal line names the hosted command', () => {
    expect(startProblems(facts({ engines: 2, freeGB: 1 })).length).toBe(1);
    const busy = facts({ engines: 1, freeGB: 5, fleet: live });
    return admitStart({ root: '.', ports: [], engines: 1 }, 0, { read: async () => busy, log: () => {} }).then(line => expect(line).toMatch(/Beside live bots run the cases on hosted runners: bun tools\/hosted-bench\.ts '<pattern>'\.$/));
});
