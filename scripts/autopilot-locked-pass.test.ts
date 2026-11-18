import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAN_ATTEMPTS, lockedPass, pass, passInputFiles, passOutcome, queueBoundAccounts, type PassWrite } from './autopilot';

// A plan file in a temporary folder. Each test ends its pass at the pause check of the write step, so no test writes
// a plan, a planner state or an order. A plan takes about 2 s and a test makes up to four, so each test has a 60 s limit.
function fixture() {
    const base = mkdtempSync(join(tmpdir(), 'rsbot-autopilot-lock-')), planFile = join(base, 'swarm.json'), before = '{"jobs":[],"maxBots":4}';
    writeFileSync(planFile, before);
    const previous = process.env.FLEET_DIR;
    process.env.FLEET_DIR = base;
    let held = false;
    const lockCalls: boolean[] = [], pauseChecks: boolean[] = [];
    return {
        planFile, before, lockCalls, pauseChecks,
        // The plan lock of the test: it records each use and whether the lock is held.
        lock: (beforeAction?: () => void) => async <T>(action: () => T): Promise<T> => {
            lockCalls.push(true); held = true;
            try { beforeAction?.(); return await action(); } finally { held = false; }
        },
        // The pause check records whether the lock is held at each call. The call in the write step answers "paused".
        isPaused: () => { pauseChecks.push(held); return held; },
        end: () => { if (previous === undefined) delete process.env.FLEET_DIR; else process.env.FLEET_DIR = previous; rmSync(base, { recursive: true, force: true }); },
    };
}

test('the planner computes its plan with no lock and holds the lock only for the write step', async () => {
    const f = fixture();
    try {
        expect(await lockedPass(f.planFile, false, f.lock(), f.isPaused)).toEqual(['AUTOPILOT hold: swarm is paused']);
        // The first pause check is at the start of the plan, the second in the write step.
        expect(f.pauseChecks).toEqual([false, true]);
        expect(f.lockCalls).toHaveLength(1);
        expect(readFileSync(f.planFile, 'utf8')).toBe(f.before);
    } finally { f.end(); }
}, 60_000);

test('a plan file that another writer changed after the plan is not written over: the pass plans again', async () => {
    const f = fixture();
    try {
        const changed = '{"jobs":[],"maxBots":5}';
        let first = true;
        // Another writer gets the lock between the plan and the write step of the first attempt.
        const lock = f.lock(() => { if (first) { first = false; writeFileSync(f.planFile, changed); } });
        expect(await lockedPass(f.planFile, false, lock, f.isPaused)).toEqual(['AUTOPILOT hold: swarm is paused']);
        // Two plans with no lock, then one write step: the first lock use found a changed file and wrote nothing.
        expect(f.pauseChecks).toEqual([false, false, true]);
        expect(f.lockCalls).toHaveLength(2);
        expect(readFileSync(f.planFile, 'utf8')).toBe(changed);
    } finally { f.end(); }
}, 60_000);

test('a plan file that changes during each plan ends the pass with a hold and no write', async () => {
    const f = fixture();
    try {
        let n = 0;
        const lock = f.lock(() => writeFileSync(f.planFile, `{"jobs":[],"maxBots":${10 + ++n}}`));
        const lines = await lockedPass(f.planFile, false, lock, f.isPaused);
        expect(lines).toEqual([`AUTOPILOT hold: another writer changed the account plan during each of ${PLAN_ATTEMPTS} plans`]);
        expect(f.pauseChecks).toEqual(Array(PLAN_ATTEMPTS).fill(false));
        expect(readFileSync(f.planFile, 'utf8')).toBe(`{"jobs":[],"maxBots":${10 + PLAN_ATTEMPTS}}`);
    } finally { f.end(); }
}, 60_000);

test('a pass with no write step keeps its one call: the write step compares the files that the plan read', () => {
    const f = fixture();
    try {
        let step: PassWrite | undefined;
        pass(f.planFile, false, () => false, s => { step = s; });
        expect(step!.unchanged()).toBe(true);
        expect(readFileSync(f.planFile, 'utf8')).toBe(f.before);
        writeFileSync(f.planFile, '{"jobs":[],"maxBots":6}');
        expect(step!.unchanged()).toBe(false);
        // A paused or dry pass has no write step.
        let none: PassWrite | undefined;
        expect(pass(f.planFile, true, () => false, s => { none = s; }).at(-1)).toBe('AUTOPILOT dry run: nothing written');
        expect(none).toBeUndefined();
    } finally { f.end(); }
}, 60_000);

test('a pass that wrote nothing is held, so the trainer poll keeps the finished trainers for the next pass', async () => {
    // The hold after PLAN_ATTEMPTS changed plans, from a real pass.
    const f = fixture();
    try {
        let n = 0;
        const lines = await lockedPass(f.planFile, false, f.lock(() => writeFileSync(f.planFile, `{"jobs":[],"maxBots":${20 + ++n}}`)), f.isPaused);
        expect(passOutcome(lines)).toEqual({ outcome: 'held', result: `RESULT fail autopilot held, nothing written: another writer changed the account plan during each of ${PLAN_ATTEMPTS} plans` });
    } finally { f.end(); }
    expect(passOutcome(['AUTOPILOT hold: owning coordinator queue is unavailable'])).toEqual({ outcome: 'held', result: 'RESULT fail autopilot held, nothing written: owning coordinator queue is unavailable' });
    expect(passOutcome(['AUTOPILOT hold: swarm is paused'])).toEqual({ outcome: 'held', result: 'RESULT ok autopilot held: swarm is paused' });
    // A pass that wrote its plan is applied. A hold of one account is a line of such a pass, not a hold of the pass.
    expect(passOutcome(['AUTOPILOT hold Rod: coordinator owns the assignment', 'AUTOPILOT assign Cod fishing 1.0 x', 'AUTOPILOT keep Bob mining 1.0 y', 'AUTOPILOT retire Tim cooking: z']))
        .toEqual({ outcome: 'applied', result: 'RESULT ok autopilot jobs=2 retired=1' });
    expect(passOutcome(['AUTOPILOT dry run: nothing written']).outcome).toBe('applied');
}, 60_000);

test('the write step compares each file that another writer changes, not only the plan file', () => {
    const f = fixture();
    try {
        // The plan file, the coordinator jobs file, the owner list of the fleet and the planner state of this side.
        const files = passInputFiles(f.planFile).map(p => p.replace(/\\/g, '/'));
        expect(files[0]).toBe(f.planFile.replace(/\\/g, '/'));
        expect(files.filter(p => p.endsWith('/.practice/coordinator/jobs.json'))).toHaveLength(1);
        expect(files.filter(p => p.endsWith('/owners.json'))).toHaveLength(1);
        expect(files.filter(p => /\/\.practice\/autopilot\/[a-z0-9-]+\.json$/.test(p))).toHaveLength(1);
        // A change of a listed file other than the plan file: the owner list is in the temporary fleet folder.
        let step: PassWrite | undefined;
        pass(f.planFile, false, () => false, s => { step = s; });
        expect(step!.unchanged()).toBe(true);
        writeFileSync(passInputFiles(f.planFile).find(p => p.endsWith('owners.json'))!, '{"accounts":{"Rod":{"side":"cloud"}}}');
        expect(step!.unchanged()).toBe(false);
    } finally { f.end(); }
}, 60_000);

test('the write step sees an account that the coordinator queue bound after the plan read the queue', () => {
    const task = (id: string, status: string, account?: string) => ({ status, spec: { id, kind: 'run', ...(account ? { account } : {}) } });
    const queue = (...tasks: unknown[]) => ({ version: 1, tasks });
    const before = queueBoundAccounts(queue(task('a', 'running', 'Rod'), task('b', 'pending', 'Cod'), task('c', 'succeeded', 'Old')));
    expect(before).toBe('["cod","rod"]');
    // State that the coordinator saves for other reasons does not change the answer.
    expect(queueBoundAccounts({ ...queue(task('b', 'pending', 'Cod'), task('a', 'running', 'Rod'), task('c', 'failed', 'Old')), sequence: 99 })).toBe(before);
    // A new task with an account does, and so does a task that ends.
    expect(queueBoundAccounts(queue(task('a', 'running', 'Rod'), task('b', 'pending', 'Cod'), task('d', 'pending', 'Bob')))).not.toBe(before);
    expect(queueBoundAccounts(queue(task('a', 'succeeded', 'Rod'), task('b', 'pending', 'Cod')))).not.toBe(before);
    // No readable queue is its own answer.
    expect(queueBoundAccounts(null)).toBe('unavailable');
    expect(queueBoundAccounts({ version: 2, tasks: [] })).toBe('unavailable');
});
