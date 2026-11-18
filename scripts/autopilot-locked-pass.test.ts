import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAN_ATTEMPTS, lockedPass, pass, type PassWrite } from './autopilot';

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
