import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeJobs, mergedPlan, shadowAssignments, readCoordinatorJobs, writeCoordinatorJobs, readMergedPlan, emptyCoordinatorJobs, coordinatorJobsPath } from '../src/coordinator-jobs';

const owner = [
    { account: 'Rod', script: 'owner.ts', enabled: true, repeat: true },
    { accounts: ['A', 'B', 'C'], host: true, script: 'host.ts', enabled: true },
    { accounts: ['P', 'Q'], orchestrate: true, script: 'pair.ts', enabled: true },
    { account: 'Keep', script: 'keep.ts', enabled: true },
];
test('a coordinator job takes its accounts away from the owner job that names them; the rest stay in order', () => {
    const run = { account: 'Rod', script: 'run.ts', enabled: true, coordinatorOwner: 'coordinator' };
    const merged = mergeJobs(owner, [run]);
    expect(merged.map(j => j.account ?? j.accounts.join('+'))).toEqual(['A+B+C', 'P+Q', 'Keep', 'Rod']);
    expect(merged.at(-1)).toBe(run);
    expect(mergeJobs(owner, [])).toEqual(owner);
});
test('a host job loses only the named accounts; a composed job that loses one participant is kept off', () => {
    const merged = mergeJobs(owner, [{ accounts: ['b', 'Q'], orchestrate: true, script: 'x.ts', enabled: true, coordinatorOwner: 'coordinator' }]);
    expect(merged[1]).toMatchObject({ accounts: ['A', 'C'], host: true });
    expect(merged[2]).toMatchObject({ accounts: ['P', 'Q'], enabled: false });
    expect(shadowAssignments(owner, ['rod', 'keep']).map(j => j.accounts?.join('+'))).toEqual(['A+B+C', 'P+Q']);
});
test('later coordinator jobs shadow earlier ones, so a reinstalled account appears once', () => {
    const first = { account: 'Rod', script: 'one.ts', enabled: false, coordinatorOwner: 'coordinator' };
    const second = { account: 'Rod', script: 'two.ts', enabled: true, coordinatorOwner: 'coordinator' };
    const merged = mergeJobs(owner, [first, second]);
    expect(merged.filter(j => j.account === 'Rod')).toEqual([second]);
});
test('a legacy retired cohort keeps each participant parked as a valid single assignment', () => {
    const hold = { accounts: ['A', 'B'], script: 'handoff.ts', enabled: false, coordinatorOwner: 'coordinator',
        coordinatorTask: 'handoff', env: { COORDINATOR_RUN_ID: 'task-1' } };
    const replacement = { account: 'B', script: 'next.ts', enabled: true, coordinatorOwner: 'coordinator' };
    const jobs = mergeJobs(owner, [hold, replacement]);
    expect(jobs.find(j => j.host)).toMatchObject({ accounts: ['C'] });
    expect(jobs.filter(j => j.script === 'handoff.ts')).toEqual([{
        account: 'A', script: 'handoff.ts', enabled: false, coordinatorOwner: 'coordinator',
        coordinatorTask: 'handoff', env: { COORDINATOR_RUN_ID: 'task-1' },
    }]);
    expect(jobs.filter(j => j.account === 'B')).toEqual([replacement]);
    const enabled = { ...hold, enabled: true };
    expect(mergeJobs(owner, [enabled]).at(-1)).toBe(enabled);
});
test('the plan keeps owner limits; a granted expansion applies only while the owner maxBots it was granted over stands', () => {
    const plan = { maxBots: 17, minFreeGB: 4, jobs: owner, coordination: { enabled: true, maxLive: 17, directive: 'go' } };
    const overlay = { ...emptyCoordinatorJobs(), coordination: { focusCapability: 'wine-order', focusSince: 5, lastExpansionAt: 9 }, expansion: { maxBots: 21, over: 17 } };
    const merged = mergedPlan(plan, overlay);
    expect(merged).toMatchObject({ maxBots: 21, minFreeGB: 4, coordination: { enabled: true, maxLive: 21, directive: 'go', focusCapability: 'wine-order', focusSince: 5, lastExpansionAt: 9 } });
    expect(merged.jobs).toEqual(owner);
    const edited = mergedPlan({ ...plan, maxBots: 12 }, overlay);
    expect(edited.maxBots).toBe(12); expect(edited.coordination.maxLive).toBe(17);
    expect(mergedPlan({ maxBots: 3, jobs: [] }, emptyCoordinatorJobs())).toEqual({ maxBots: 3, jobs: [] });
    // A rollout pause shows the named standing jobs off; other jobs and the owner's flags are untouched.
    const standing = [{ accounts: ['S1', 'S2'], host: true, standing: true, script: 's.ts', enabled: true }, { account: 'S3', standing: true, script: 's.ts', enabled: true }, { account: 'Rod', script: 'r.ts', enabled: true }];
    const pausedPlan = mergedPlan({ maxBots: 3, jobs: standing }, { ...emptyCoordinatorJobs(), paused: ['s2', 'rod'] });
    expect(pausedPlan.jobs.map((j: any) => j.enabled)).toEqual([false, true, true]);
    expect(standing[0].enabled).toBe(true);
    expect(plan.coordination).toEqual({ enabled: true, maxLive: 17, directive: 'go' });
});
test('a missing file is an empty overlay; a written file reads back and merges from disk', () => {
    const base = mkdtempSync(join(tmpdir(), 'coordinator-jobs-'));
    writeFileSync(join(base, 'swarm.json'), JSON.stringify({ maxBots: 2, minFreeGB: 0, jobs: owner }));
    expect(readCoordinatorJobs(base)).toEqual({ jobs: [], coordination: {} });
    expect(readMergedPlan(base).jobs).toEqual(owner);
    writeCoordinatorJobs(base, { jobs: [{ account: 'Keep', script: 'run.ts', enabled: true, coordinatorOwner: 'coordinator' }], coordination: { focusCapability: 'x' } });
    expect(existsSync(coordinatorJobsPath(base))).toBe(true);
    expect(readMergedPlan(base)).toMatchObject({ maxBots: 2, coordination: { focusCapability: 'x' } });
    expect(readMergedPlan(base).jobs.map((j: any) => j.script)).toEqual(['owner.ts', 'host.ts', 'pair.ts', 'run.ts']);
    writeFileSync(coordinatorJobsPath(base), '{"coordination":{}}');
    expect(() => readCoordinatorJobs(base)).toThrow('jobs array');
    expect(readFileSync(join(base, 'swarm.json'), 'utf8')).toBe(JSON.stringify({ maxBots: 2, minFreeGB: 0, jobs: owner }));
});
