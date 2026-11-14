import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SWARM_STOP } from './swarm';
import { archiveDir, archiveStaleLease, budgetRefusal, clearSwarmStops, cloudSide, deadTasks, eligibility, END_SETTLE_MS, endSettled, LIVE_SERVER, lifecycleRoot, NEVER_RECOVERED, MAX_ATTEMPTS, MAX_TARGETS, MAX_WAITS, waitedAttempts, waitRefusedRuns, recoveriesInFlight, recoveryBatch, recoveryLeaseState, recoveryLineage, recoveryProposal, recoveryRequestWaiting, releasableAccounts, releaseBlockers, releasePlan, spentAttempts, submitRejected, type ClaimView } from './cloud-recover';
import { accountDir, DEFAULT_LIFECYCLE_ROOT } from '../packages/core/src/session-lifecycle';
import { RECOVERY_SCRIPT } from '../packages/core/src/session-recovery-permit';
import type { LogoutProof } from '../packages/core/src/session-lifecycle';

const held: LogoutProof = { state: 'held', account: 'kiltlifter', server: 'rs-sdk-demo.fly.dev', domain: 'live', attemptId: 'a', reason: 'disconnected' };
const claim: ClaimView = { phase: 'held', kind: 'swarm', pid: 41, host: 'box' };
const end = { at: 1794183517222, reason: 'gave-up after 21 runs' };
const base = { proof: held, claim, end, stopText: undefined, pidAlive: () => false, host: 'box' };

test('a held swarm claim with a dead worker and a recoverable end is eligible', () => {
    expect(eligibility(base)).toEqual({ eligible: true, endedAt: 1794183517222 });
    expect(eligibility({ ...base, end: { at: 5, reason: 'stopped after 1 runs' } })).toEqual({ eligible: true, endedAt: 5 });
    expect(eligibility({ ...base, stopText: 'swarm stopped' })).toEqual({ eligible: true, endedAt: 1794183517222 });
});

test('accounts with nothing to recover are skipped quietly', () => {
    const confirmed: LogoutProof = { state: 'confirmed', account: 'k', server: 's', domain: 'live', attemptId: 'a', loggedOutAt: 1, ownerRun: null, receiptSha256: 'x' };
    expect(eligibility({ ...base, proof: confirmed })).toMatchObject({ eligible: false, log: false });
    expect(eligibility({ ...base, claim: null })).toMatchObject({ eligible: false, log: false });
    expect(eligibility({ ...base, claim: { ...claim!, phase: 'released' } })).toMatchObject({ eligible: false, log: false });
    expect(eligibility({ ...base, pidAlive: () => true })).toMatchObject({ eligible: false, reason: 'worker still alive', log: false });
});

test('a held logout with no claim is eligible once the swarm has recorded that attempt as orphaned', () => {
    // A trade worker dropped and fleet sync released its claim: the swarm's orphan end names the held attempt.
    const proof: LogoutProof = { ...held, attemptId: '1794362885215-0000001822-0000000001' };
    const orphan = { at: 1794365516000, reason: `exit orphaned: attempt ${proof.attemptId} owner 1822 gone` };
    for (const c of [null, { phase: 'released', kind: 'trade' }] as ClaimView[])
        expect(eligibility({ ...base, proof, claim: c, end: orphan })).toEqual({ eligible: true, endedAt: orphan.at });
    // An orphan end of another attempt, any other end, or no end: nothing to recover, quietly.
    expect(eligibility({ ...base, proof, claim: null, end: { ...orphan, reason: 'exit orphaned: attempt 1794000000000-1-1 owner 9 gone' } })).toMatchObject({ eligible: false, reason: 'no held fleet account claim', log: false });
    expect(eligibility({ ...base, proof, claim: null })).toMatchObject({ eligible: false, log: false });
    expect(eligibility({ ...base, proof, claim: null, end: undefined })).toMatchObject({ eligible: false, log: false });
    // An owner's stop file still holds the account.
    expect(eligibility({ ...base, proof, claim: null, end: orphan, stopText: 'held: owner pause' })).toMatchObject({ eligible: false, log: true, reason: 'owner stop file holds the account' });
});

test('held sessions that cannot be recovered safely are refused with a logged reason', () => {
    expect(eligibility({ ...base, end: undefined })).toMatchObject({ eligible: false, log: true, reason: expect.stringContaining('end record gone') });
    expect(eligibility({ ...base, end: { at: 1, reason: 'died' } })).toMatchObject({ eligible: false, log: true, reason: 'death needs a person' });
    expect(eligibility({ ...base, end: { at: 1, reason: 'done after 1 runs' } })).toMatchObject({ eligible: false, log: true });
    expect(eligibility({ ...base, stopText: 'held: owner pause' })).toMatchObject({ eligible: false, log: true, reason: 'owner stop file holds the account' });
    expect(eligibility({ ...base, claim: { phase: 'held' } })).toMatchObject({ eligible: false, log: true });
});

test('an end record older than the held attempt is an earlier run: wait quietly until the supervisor ends this one', () => {
    const attempt: LogoutProof = { ...held, attemptId: '1794190630000-0000012460-0000000001' } as LogoutProof;
    expect(eligibility({ ...base, proof: attempt, end: { at: 1794190600000, reason: 'done after 1 runs' } })).toEqual({ eligible: false, reason: 'waiting: the supervisor has not ended the held attempt', log: false });
    expect(eligibility({ ...base, proof: attempt, end: { at: 1794190845000, reason: 'gave-up after 21 runs' } })).toEqual({ eligible: true, endedAt: 1794190845000 });
    expect(eligibility({ ...base, proof: attempt, end: { at: 1794190845000, reason: 'done after 1 runs' } })).toMatchObject({ eligible: false, log: true });
});

test('after a failed recovery of an end, a held attempt newer than that end is the recovery\'s own session: the retry is not held back', () => {
    // Fingerblastr: end 1794352171236 "gave-up after 21 runs", then the failed recovery's attempt 1794352434295.
    const attempt: LogoutProof = { ...held, attemptId: '1794352434295-0000011731-0000000001' } as LogoutProof, end = { at: 1794352171236, reason: 'gave-up after 21 runs' };
    expect(eligibility({ ...base, proof: attempt, end })).toEqual({ eligible: false, reason: 'waiting: the supervisor has not ended the held attempt', log: false });
    expect(eligibility({ ...base, proof: attempt, end, retried: true })).toEqual({ eligible: true, endedAt: 1794352171236 });
    // The other rules still hold for a retry: a live worker, a death, an end that is not recoverable.
    expect(eligibility({ ...base, proof: attempt, end, retried: true, pidAlive: () => true })).toMatchObject({ eligible: false, reason: 'worker still alive' });
    expect(eligibility({ ...base, proof: attempt, end: { at: 1794352171236, reason: 'died' }, retried: true })).toMatchObject({ eligible: false, log: true });
    expect(eligibility({ ...base, proof: attempt, end: { at: 1794352171236, reason: 'done after 1 runs' }, retried: true })).toMatchObject({ eligible: false, log: true });
});

test('a worker pid on another host does not count as alive here', () => {
    expect(eligibility({ ...base, host: 'other', pidAlive: () => true })).toEqual({ eligible: true, endedAt: 1794183517222 });
});

test('the proposal holds one qualify and one recovery run task with fresh ids', () => {
    const p = recoveryProposal('claude-cloud-3', [{ account: 'Kiltlifter', endedAt: 99 }], Date.UTC(2026, 10, 9, 0, 18, 57, 123));
    expect(p.capabilities).toEqual([]);
    const [q, r] = p.tasks as any[];
    expect(q.id).toBe('claude-cloud-3-recovery-qualified-20261109t001857z');
    expect(q).toMatchObject({ kind: 'qualify', capability: 'session-recovery-only', dependsOn: [] });
    expect(r).toMatchObject({ id: 'claude-cloud-3-recover-kiltlifter-20261109t001857z', kind: 'run', account: 'Kiltlifter', dependsOn: [q.id],
        repairs: [{ account: 'Kiltlifter', endedAt: 99 }], sessionRecovery: { account: 'Kiltlifter', endedAt: 99 }, accept: { counters: { sessionChecked: 1 } } });
    expect(recoveryProposal('claude-cloud-3', [{ account: 'Kiltlifter', endedAt: 99 }], Date.UTC(2026, 10, 9, 0, 19)).tasks[0]!.id).not.toBe(q.id);
});

test('archive folders are named by time and account under the coordinator directory', () => {
    expect(archiveDir('/r', 'PocketPool', Date.UTC(2026, 10, 9, 0, 24, 26))).toBe(join('/r', '.practice', 'coordinator', 'release-archive', '20261109t002426z-pocketpool'));
});

// The claude-cloud release of 06:33 was blocked by a parked copy of Quickhandjob's goldfarm job.
const settled = { ownerJob: () => true, confirmed: () => true, recovering: () => false };
const check = { account: 'TheFullMonty', coordinatorOwner: 'coordinator', enabled: false, script: 'scripts/session-check.ts' };
const copy = { account: 'Quickhandjob', script: 'scripts/goldfarm.ts', enabled: false, standing: true, autopilot: 'knights' };
test('a parked owner-job copy is archived when its owner job is in swarm.json, its logout is confirmed and no recovery of it is open', () => {
    expect(releasableAccounts([check, copy], settled)).toEqual(['TheFullMonty', 'Quickhandjob']);
    expect(releasableAccounts([check, { ...copy, enabled: true }], settled)).toEqual([]);
    expect(releasableAccounts([{ ...copy, account: undefined }], settled)).toEqual([]);
});
test('a parked owner-job copy stays when swarm.json no longer names the account', () => {
    const v = { ...settled, ownerJob: (a: string) => a !== 'Quickhandjob' };
    expect(releasableAccounts([check, copy], v)).toEqual([]);
    expect(releaseBlockers([check, copy], v)).toEqual([copy]);
});
test('a parked owner-job copy stays unless the logout proof is confirmed, and it no longer holds the other accounts', () => {
    for (const state of ['none', 'invalid', 'held']) {
        const v = { ...settled, confirmed: (a: string) => a !== 'Quickhandjob' || state === 'confirmed' };
        // The copy waits for its own account; the recovered account beside it is released.
        expect(releasePlan([check, copy], v)).toEqual({ free: [check], keep: [copy] });
        expect(releasableAccounts([check, copy], v)).toEqual(['TheFullMonty']);
        expect(releasableAccounts([copy], v)).toEqual([]);
    }
    const pair = { ...copy, account: undefined, accounts: ['A', 'B'] };
    expect(releasePlan([check, pair], { ...settled, confirmed: (a: string) => a === 'A' })).toEqual({ free: [check], keep: [pair] });
    // Live claude-cloud: seven parked session checks and one unsettled copy of Fingersmith's planner job.
    const seven = ['TrouserSnake', 'Kiltlifter', 'PocketPool', 'Quickhandjob', 'UnderMyKilt', 'Deeppockets', 'Knightstick'].map(account => ({ ...check, account }));
    const stray = { account: 'Fingersmith', script: 'scripts/gather-combat.ts', enabled: false, standing: true, autopilot: 'army-cow-defence-80' };
    const plan = releasePlan([...seven, stray], { ...settled, confirmed: (a: string) => a !== 'Fingersmith' });
    expect(plan.free).toEqual(seven); expect(plan.keep).toEqual([stray]);
});
test('nothing is released around a blocker that is not a waiting copy: enabled work, a coordinator job, a copy with no owner job', () => {
    const unsettled = { ...settled, confirmed: (a: string) => a !== 'Quickhandjob' };
    expect(releasePlan([check, copy, { ...copy, account: 'Haggis', enabled: true }], unsettled).free).toEqual([]);
    expect(releasePlan([check, copy, { account: 'Haggis', coordinatorOwner: 'coordinator', enabled: false, script: 'scripts/fight.ts' }], unsettled).free).toEqual([]);
    expect(releasePlan([check, copy], { ...unsettled, ownerJob: (a: string) => a !== 'Quickhandjob' }).free).toEqual([]);
    expect(releasePlan([check, copy], { ...unsettled, recovering: (a: string) => a === 'Quickhandjob' }).free).toEqual([]);
});
test('a parked owner-job copy stays while a recovery of its account is pending or running', () => {
    expect(releasableAccounts([check, copy], { ...settled, recovering: (a: string) => a === 'Quickhandjob' })).toEqual([]);
});

test('logout proofs are read from the session-lifecycle directory under the checkout', () => {
    // readLogoutProof's root is the lifecycle directory, not the checkout; a checkout root reads every proof as none.
    expect(lifecycleRoot(join(import.meta.dir, '..'))).toBe(DEFAULT_LIFECYCLE_ROOT);
    expect(lifecycleRoot('/r')).toBe(join('/r', '.practice', 'session-lifecycle'));
});

test('only a cloud side waits for its runs and restarts its coordinator; the local side submits and returns', () => {
    expect(cloudSide('local')).toBe(false);
    expect(cloudSide('claude-cloud-3')).toBe(true);
    expect(cloudSide('cloud')).toBe(true);
});

test('the local side takes an end only when the standing retry can no longer change its time', () => {
    const now = 1794487000000;
    // Bigpackage: a logout timed out, the supervisor gave up after 4 runs. The standing retry deletes that end.
    expect(endSettled({ at: now - 60_000, reason: 'gave-up after 4 runs' }, now)).toBe(false);
    expect(endSettled({ at: now - END_SETTLE_MS + 1, reason: 'gave-up after 4 runs' }, now)).toBe(false);
    // The orphan end that follows is not retried: its time holds from the first second.
    expect(endSettled({ at: now - 1000, reason: 'exit orphaned: attempt 1794487442414-0000029304-0000000001 owner 29304 gone' }, now)).toBe(true);
    // An end the retry has passed by (a job that is not standing) is taken too.
    expect(endSettled({ at: now - END_SETTLE_MS, reason: 'gave-up after 4 runs' }, now)).toBe(true);
    expect(END_SETTLE_MS).toBeGreaterThan(15 * 60_000);
});

test('the accounts that stay offline are never recovery targets', () => {
    for (const name of ['haggis', 'shaftshooter', 'polevaulter', 'afknight']) expect(NEVER_RECOVERED).toContain(name);
});

test('a submitted recovery that the coordinator has not taken yet holds the next call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recover-requests-'));
    try {
        expect(recoveryRequestWaiting(join(dir, 'missing'))).toBe(false);
        expect(recoveryRequestWaiting(dir)).toBe(false);
        // Another session's proposal with no recovery in it does not hold the call.
        writeFileSync(join(dir, 'a.request.json'), JSON.stringify({ tasks: [{ id: 'x', kind: 'run', capability: 'shop-buyer' }] }));
        expect(recoveryRequestWaiting(dir)).toBe(false);
        // A taken or rejected recovery proposal is in the coordinator's state or settled: state.json decides.
        const proposal = JSON.stringify(recoveryProposal('local', [{ account: 'Bigpackage', endedAt: 5 }], 1794487000000));
        writeFileSync(join(dir, 'b.request.json.accepted'), proposal);
        writeFileSync(join(dir, 'c.request.json.rejected'), proposal);
        expect(recoveryRequestWaiting(dir)).toBe(false);
        writeFileSync(join(dir, 'd.request.json'), proposal);
        expect(recoveryRequestWaiting(dir)).toBe(true);
        rmSync(join(dir, 'd.request.json'));
        // A request file that cannot be read may be a recovery: wait.
        writeFileSync(join(dir, 'e.request.json'), '{');
        expect(recoveryRequestWaiting(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a local proposal has the shape of a hand recovery: one qualify, then serial runs that name the exact end', () => {
    const p = recoveryProposal('local', [{ account: 'Bigpackage', endedAt: 11 }, { account: 'Billionaire', endedAt: 12 }], 1794487000000);
    expect(p.tasks.map(t => t.kind)).toEqual(['qualify', 'run', 'run']);
    expect(p.tasks.every(t => t.capability === 'session-recovery-only')).toBe(true);
    const [qualify, first, second] = p.tasks as any[];
    expect(first.sessionRecovery).toEqual({ account: 'Bigpackage', endedAt: 11 });
    expect(first.repairs).toEqual([{ account: 'Bigpackage', endedAt: 11 }]);
    expect(first.dependsOn).toEqual([qualify.id]);
    expect(second.dependsOn).toEqual([qualify.id, first.id]);
});

test('a release frees accounts only when every coordinator-owned job is a parked session check', () => {
    const check = (account: string) => ({ account, coordinatorOwner: 'coordinator', enabled: false, script: 'scripts/session-check.ts' });
    const yes = settled, no = { ownerJob: () => false, confirmed: () => false, recovering: () => true };
    expect(releasableAccounts([check('Kiltlifter'), check('PocketPool')], no)).toEqual(['Kiltlifter', 'PocketPool']);
    expect(releasableAccounts([], yes)).toEqual([]);
    expect(releasableAccounts([check('Kiltlifter'), { account: 'Haggis', coordinatorOwner: 'coordinator', enabled: false, script: 'scripts/fight.ts' }], yes)).toEqual([]);
    expect(releasableAccounts([check('Kiltlifter'), { account: 'Haggis', coordinatorOwner: 'coordinator', enabled: true, script: 'scripts/session-check.ts' }], yes)).toEqual([]);
    expect(releasableAccounts([check('Kiltlifter'), { accounts: ['A'], coordinatorOwner: 'coordinator', enabled: false, script: 'scripts/session-check.ts' }], yes)).toEqual([]);
});

test('accounts dropped together recover in one proposal behind one qualify', () => {
    const p = recoveryProposal('claude-cloud-4', [{ account: 'Fingersmith', endedAt: 1 }, { account: 'KnightRider', endedAt: 2 }], Date.UTC(2026, 10, 9, 3, 51, 10));
    const [q, a, b] = p.tasks as any[];
    expect(p.tasks).toHaveLength(3);
    expect(q).toMatchObject({ kind: 'qualify', dependsOn: [] });
    expect(a).toMatchObject({ account: 'Fingersmith', dependsOn: [q.id], sessionRecovery: { account: 'Fingersmith', endedAt: 1 } });
    expect(b).toMatchObject({ account: 'KnightRider', sessionRecovery: { account: 'KnightRider', endedAt: 2 } });
    expect(new Set(p.tasks.map((t: any) => t.id)).size).toBe(3);
});

test('runs in one proposal take the single repair slot one after another', () => {
    const p = recoveryProposal('claude-cloud', ['Quickhandjob', 'TrouserSnake', 'TheFullMonty', 'UnderMyKilt'].map((account, endedAt) => ({ account, endedAt })), Date.UTC(2026, 10, 9, 6, 33, 28));
    const [q, ...runs] = p.tasks as any[];
    expect(runs.map(r => r.dependsOn)).toEqual([[q.id], [q.id, runs[0].id], [q.id, runs[1].id], [q.id, runs[2].id]]);
});

test('a release waits while any session-recovery task is pending or running', () => {
    const t = (status: string, sessionRecovery?: object) => ({ status, spec: { id: status, dependsOn: [], ...(sessionRecovery ? { sessionRecovery } : {}) } });
    expect(recoveriesInFlight([t('succeeded', { account: 'A' }), t('failed', { account: 'B' }), t('running')])).toHaveLength(0);
    expect(recoveriesInFlight([t('succeeded', { account: 'A' }), t('running', { account: 'B' })]).map((x: any) => x.spec.sessionRecovery.account)).toEqual(['B']);
    expect(recoveriesInFlight([t('pending', { account: 'C' })])).toHaveLength(1);
});

// The claude-cloud qualify of 06:07 failed in its native gate and left its run pending; every later call waited on it.
const task = (id: string, status: string, dependsOn: string[], recovery?: { account: string; endedAt: number }) => ({ status, spec: { id, kind: recovery ? 'run' : 'qualify', dependsOn, ...(recovery ? { sessionRecovery: recovery } : {}) } });
test('a recovery behind a failed qualify or a failed earlier run is settled, not in flight', () => {
    const tasks = [task('q', 'failed', []), task('a', 'pending', ['q'], { account: 'Quickhandjob', endedAt: 7 })];
    expect(recoveriesInFlight(tasks)).toEqual([]);
    const chain = [task('q', 'succeeded', []), task('a', 'failed', ['q'], { account: 'A', endedAt: 1 }), task('b', 'pending', ['q', 'a'], { account: 'B', endedAt: 2 }), task('c', 'pending', ['q', 'b'], { account: 'C', endedAt: 3 })];
    expect(recoveriesInFlight(chain)).toEqual([]);
    const waiting = [task('q', 'running', []), task('a', 'pending', ['q'], { account: 'A', endedAt: 1 }), task('b', 'pending', ['q', 'a'], { account: 'B', endedAt: 2 })];
    expect(recoveriesInFlight(waiting).map((t: any) => t.spec.id)).toEqual(['a', 'b']);
});

test('the dead-task rule matches the coordinator: missing or superseded dependencies count, a failed refresh does not', () => {
    expect([...deadTasks([task('a', 'pending', ['gone'], { account: 'A', endedAt: 1 })])]).toEqual(['a']);
    expect([...deadTasks([task('q', 'superseded', []), task('a', 'pending', ['q'], { account: 'A', endedAt: 1 })])]).toEqual(['a']);
    const refresh = { status: 'failed', spec: { id: 'refresh-session-recovery-only-x', kind: 'qualify', dependsOn: [] } };
    const run = { status: 'pending', spec: { id: 'a', kind: 'run', capability: 'session-recovery-only', dependsOn: [refresh.spec.id] } };
    expect(deadTasks([refresh, run]).size).toBe(0);
});

test('an end is retried once after its run or its qualify failed, then left for a person', () => {
    const target = { account: 'Quickhandjob', endedAt: 7 };
    const first = [task('q1', 'failed', []), task('a1', 'pending', ['q1'], target)];
    expect(spentAttempts(first, target)).toBe(1);
    const second = [...first, task('q2', 'succeeded', []), task('a2', 'failed', ['q2'], { account: 'quickhandjob', endedAt: 7 })];
    expect(spentAttempts(second, target)).toBe(MAX_ATTEMPTS);
    expect(spentAttempts(second, { ...target, endedAt: 8 })).toBe(0);
    expect(spentAttempts([task('q', 'succeeded', []), task('a', 'running', ['q'], target)], target)).toBe(0);
});

test('a run that never started behind a failed earlier run of its chain spends no attempt and is submitted again', () => {
    const target = { account: 'TrouserSnake', endedAt: 9 };
    const tasks = [task('q', 'succeeded', []), task('a', 'failed', ['q'], { account: 'Quickhandjob', endedAt: 7 }), task('b', 'pending', ['q', 'a'], target)];
    expect(recoveriesInFlight(tasks)).toEqual([]);
    expect(spentAttempts([...tasks, ...tasks.map(t => ({ ...t, spec: { ...t.spec, id: t.spec.id + '2', dependsOn: t.spec.dependsOn.map(d => d + '2') } }))], target)).toBe(0);
});

// The shape of a dispatcher result line (packages/core/src/session-recovery-dispatch.ts emit).
const resultLine = (runId: string, result: object) => JSON.stringify({ at: 1, raw: JSON.stringify({ kind: 'session-recovery', account: 'Sausagefest', runId }), result });
const refused = (cause: string, reason = 'recovery setup refused; no lease issued; no retry') => ({ changed: false, sessionRecovered: false, reason, setup: { phase: 'admission', cause } });

test('a run that the controller refused while it waited for memory or a bot slot spends no attempt', () => {
    const target = { account: 'Sausagefest', endedAt: 1794509172759 };
    const run = (id: string, runId: string, error: string) => ({ ...task(id, 'failed', [], target), runId, receipt: { ok: false, error } });
    const held = 'Error: controller held authenticated recovery: recovery setup refused; no lease issued; no retry';
    // The four live Sausagefest runs: three dispatcher refusals and one preflight refusal, all on memory.
    const tasks = [run('a', 'task-1', held), run('b', 'task-2', held), run('c', 'task-3', 'Error: live admission waiting: memory'), run('d', 'task-4', held)];
    const waits = waitRefusedRuns([resultLine('task-1', refused('recovery admission waiting: memory')), resultLine('task-2', refused('recovery admission waiting: maxBots')),
        resultLine('task-4', { ...refused('recovery waits for runtime source owner'), setup: { phase: 'source-owner', cause: 'recovery waits for runtime source owner' } }), 'not json', ''].join('\n'));
    expect([...waits].sort()).toEqual(['task-1', 'task-2', 'task-4']);
    expect(spentAttempts(tasks, target, waits)).toBe(0);
    expect(waitedAttempts(tasks, target, waits)).toBe(4);
    // Without the result lines only the preflight refusal is known as a wait: the other three count.
    expect(spentAttempts(tasks, target)).toBe(3);
    expect(MAX_WAITS).toBeGreaterThan(MAX_ATTEMPTS);
});

test('a refusal for any other cause, or a setup failure after the lease, still spends an attempt', () => {
    const waits = waitRefusedRuns([
        resultLine('owner', refused('recovery previous session owner still alive')),
        resultLine('unknown', refused('unclassified setup error')),
        resultLine('leased', refused('recovery admission waiting: memory', 'recovery setup failed after issuance; account lease held; no retry')),
        resultLine('child', { changed: false, sessionRecovered: false, reason: 'recovery child held; inspect fixed child output and retained account lease; no retry' }),
        resultLine('ok', { changed: false, sessionRecovered: true, reason: 'confirmed session cleanup; old failure retained' }),
    ].join('\n'));
    expect(waits.size).toBe(0);
    const target = { account: 'Sausagefest', endedAt: 5 };
    const tasks = ['owner', 'unknown'].map(r => ({ ...task(r, 'failed', [], target), runId: r, receipt: { ok: false, error: 'Error: live admission waiting: invalid' } }));
    expect(spentAttempts(tasks, target, waits)).toBe(MAX_ATTEMPTS);
    expect(waitedAttempts(tasks, target, waits)).toBe(0);
});

test('the swarm\'s own stop file is removed before a recovery is submitted; an owner\'s stays, and so do all under stop-swarm', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-recover-stops-')), prac = join(root, '.practice'), stop = (a: string) => join(prac, `stop-${a}`);
    try {
        mkdirSync(prac, { recursive: true });
        writeFileSync(stop('Quickhandjob'), SWARM_STOP.removed);
        writeFileSync(stop('TheFullMonty'), 'hold offline until the GE pilot');
        // The planner took Quickhandjob off its job for a fleet order and the swarm left its stop file; PocketPool has none.
        expect(clearSwarmStops(root, ['Quickhandjob', 'TheFullMonty', 'PocketPool'])).toEqual(['Quickhandjob']);
        expect(existsSync(stop('Quickhandjob'))).toBe(false);
        expect(readFileSync(stop('TheFullMonty'), 'utf8')).toBe('hold offline until the GE pilot');
        // Under stop-swarm nothing is removed: the swarm wrote those files for that stop.
        writeFileSync(stop('Quickhandjob'), SWARM_STOP.all); writeFileSync(join(prac, 'stop-swarm'), '');
        expect(clearSwarmStops(root, ['Quickhandjob'])).toEqual([]);
        expect(readFileSync(stop('Quickhandjob'), 'utf8')).toBe(SWARM_STOP.all);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a call recovers at most 11 accounts, the most one proposal of 12 tasks holds; the rest wait for the next call', () => {
    const dropped = ['Quickhandjob', 'TrouserSnake', 'TheFullMonty', 'Deeppockets', 'Fatstack', 'Fingerblastr', 'Kiltlifter', 'Knightstick', 'PocketPool', 'SporranDip', 'Fingersmith', 'KnightRider']
        .map((account, endedAt) => ({ account, endedAt }));
    const { now, later } = recoveryBatch(dropped);
    expect(MAX_TARGETS).toBe(11);
    expect(now.map(t => t.account)).toEqual(dropped.slice(0, 11).map(t => t.account));
    expect(later.map(t => t.account)).toEqual(['KnightRider']);
    // The coordinator refuses a proposal of more than 12 tasks (coordinator-planner.ts prepareProposal).
    expect(recoveryProposal('claude-cloud', now, Date.UTC(2026, 10, 10, 17, 12)).tasks).toHaveLength(12);
    expect(recoveryBatch(dropped.slice(0, 3))).toEqual({ now: dropped.slice(0, 3), later: [] });
});

test('a rejected submit is seen at once: the coordinator renames the request file and it carries the qualify id', () => {
    const base = mkdtempSync(join(tmpdir(), 'rsbot-recover-rejected-')), requests = join(base, 'requests');
    try {
        expect(submitRejected(requests, 'q-1')).toBe(false);
        mkdirSync(requests);
        const proposal = recoveryProposal('claude-cloud', [{ account: 'Kiltlifter', endedAt: 99 }], Date.UTC(2026, 10, 10, 17, 12)), id = proposal.tasks[0]!.id;
        // Queued and not yet read: not a rejection.
        writeFileSync(join(requests, 'a.request.json'), JSON.stringify(proposal));
        expect(submitRejected(requests, id)).toBe(false);
        writeFileSync(join(requests, 'b.request.json.rejected'), JSON.stringify(proposal));
        writeFileSync(join(requests, 'c.request.json.rejected'), '{ not json');
        expect(submitRejected(requests, id)).toBe(true);
        // Another proposal's rejection is not this one's.
        expect(submitRejected(requests, 'claude-cloud-recovery-qualified-other')).toBe(false);
    } finally { rmSync(base, { recursive: true }); }
});

test('a recovery lease is stale once its child is gone or, with no child, its permit has expired; a stale lease is moved aside', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-recover-lease-')), now = 1794183600000;
    const request = { schema: 'session-recovery/1', account: 'Fingersmith', server: 'rs-sdk-demo.fly.dev', runId: 'run-1', nonce: 'nonce-1', endedAt: 1794183517222, source: 'a'.repeat(64) };
    const dir = join(root, '.practice', 'coordinator', 'session-recovery', 'accounts', 'fingersmith'), lease = join(dir, 'lease.json');
    const permit = (expiresAt: number) => writeFileSync(lease, JSON.stringify({ schema: 'session-recovery-permit/1', request, issuedAt: expiresAt - 150000, expiresAt }));
    try {
        expect(recoveryLeaseState(root, 'Fingersmith', () => false, now)).toBe('none');
        mkdirSync(join(dir, 'nonce-1'), { recursive: true });
        // No child recorded: held until the permit expires.
        permit(now + 1000);
        expect(recoveryLeaseState(root, 'Fingersmith', () => false, now)).toBe('held');
        permit(now - 1000);
        expect(recoveryLeaseState(root, 'Fingersmith', () => false, now)).toBe('stale');
        // A recorded child holds the lease while its process lives, whatever the permit says.
        writeFileSync(join(dir, 'nonce-1', 'child.json'), JSON.stringify({ pid: 4242, nonce: 'nonce-1', runId: 'run-1' }));
        expect(recoveryLeaseState(root, 'Fingersmith', () => true, now)).toBe('held');
        expect(recoveryLeaseState(root, 'fingersmith', () => false, now)).toBe('stale');
        // A child record that is not this lease's, and a lease that cannot be read, are held.
        writeFileSync(join(dir, 'nonce-1', 'child.json'), JSON.stringify({ pid: 4242, nonce: 'other', runId: 'run-1' }));
        expect(recoveryLeaseState(root, 'Fingersmith', () => false, now)).toBe('held');
        writeFileSync(join(dir, 'nonce-1', 'child.json'), JSON.stringify({ pid: 4242, nonce: 'nonce-1', runId: 'run-1' }));
        writeFileSync(lease, '{');
        expect(recoveryLeaseState(root, 'Fingersmith', () => false, now)).toBe('held');
        permit(now - 1000);
        const moved = archiveStaleLease(root, 'Fingersmith', now);
        expect(moved.startsWith(join(dir, 'lease-stale-'))).toBe(true);
        expect(existsSync(moved)).toBe(true);
        expect(existsSync(join(dir, 'nonce-1', 'child.json'))).toBe(true);
        expect(recoveryLeaseState(root, 'Fingersmith', () => false, now)).toBe('none');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

// Live local Bigchopper: each failed recovery child stayed held, the swarm gave it a new orphan end with a new time,
// and the exact-end count of that new end started at zero.
test('two failures across successive child-generated ends stop a third automatic proposal, also after a stale lease is moved aside', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-recover-lineage-')), account = 'Bigchopper', t0 = 1794554000000;
    const attempts = join(accountDir(account, LIVE_SERVER, lifecycleRoot(root)), 'attempts'), rec = join(root, '.practice', 'coordinator', 'session-recovery', 'accounts', 'bigchopper');
    const id = (at: number, pid: number) => `${at}-${String(pid).padStart(10, '0')}-0000000001`;
    const attempt = (at: number, pid: number, owner: { runId: string | null; script: string; role: string | null }) => {
        const attemptId = id(at, pid);
        writeFileSync(join(attempts, `${attemptId}.json`), JSON.stringify({ schema: 'session-lifecycle/1', attemptId, account, server: LIVE_SERVER, domain: 'live',
            owner: { pid, coordinatorRunId: owner.runId, workerRelease: 'a'.repeat(64), script: owner.script, role: owner.role, participants: null }, config: { members: null },
            createdAt: at, updatedAt: at + 1, events: [{ at, kind: 'connecting' }, { at: at + 1, kind: 'connect-failed' }] }));
        return attemptId;
    };
    const orphan = (at: number, attemptId: string) => ({ at, reason: `exit orphaned: attempt ${attemptId} owner ${Number(attemptId.split('-')[1])} gone` });
    const ordinary = { runId: null, script: 'scripts/goldfarm.ts', role: 'thieving' }, child = (runId: string) => ({ runId, script: RECOVERY_SCRIPT, role: 'recovery' });
    const request = (runId: string, nonce: string, endedAt: number) => ({ schema: 'session-recovery/1', kind: 'session-recovery', account, server: LIVE_SERVER, endedAt, runId, nonce, source: 'a'.repeat(64) });
    const run = (id: string, runId: string, endedAt: number, error: string) => [{ status: 'succeeded', spec: { id: `q-${id}`, kind: 'qualify', dependsOn: [] } },
        { status: 'failed', runId, receipt: { ok: false, error }, spec: { id, kind: 'run', dependsOn: [`q-${id}`], sessionRecovery: { account, endedAt } } }];
    const childHeld = 'Error: controller held authenticated recovery: recovery child held; inspect fixed child output and retained account lease; no retry';
    try {
        mkdirSync(attempts, { recursive: true });
        // An ordinary session dropped: the first end of the lineage.
        const e0 = orphan(t0 + 60_000, attempt(t0, 100, ordinary));
        expect(budgetRefusal(root, account, e0, [])).toBeUndefined();
        // Recovery 1 of e0 fails and its child stays held. The child is gone, its lease is stale and moved aside, and its permit stays.
        mkdirSync(join(rec, 'n1'), { recursive: true });
        const permit1 = { schema: 'session-recovery-permit/1', request: request('run-1', 'n1', e0.at), issuedAt: t0 + 100_000, expiresAt: t0 + 250_000 };
        writeFileSync(join(rec, 'n1', 'permit.json'), JSON.stringify(permit1)); writeFileSync(join(rec, 'lease.json'), JSON.stringify(permit1));
        const e1 = orphan(t0 + 200_000, attempt(t0 + 120_000, 201, child('run-1')));
        // A run that only waited on memory issued no lease and spends no attempt; it counts against MAX_WAITS.
        const tasks: any[] = [...run('r1', 'run-1', e0.at, childHeld), ...run('w1', 'run-w1', e1.at, 'Error: live admission waiting: memory')];
        expect(recoveryLeaseState(root, account, () => false, t0 + 300_000)).toBe('stale');
        archiveStaleLease(root, account, t0 + 300_000);
        // The exact count of the new end is zero: that is the defect. The lineage carries the first failure.
        expect(spentAttempts(tasks, { account, endedAt: e1.at })).toBe(0);
        expect(budgetRefusal(root, account, e1, tasks)).toBeUndefined();
        // Recovery 2 of e1 fails the same way. Its request is retained only in its output folder.
        mkdirSync(join(rec, 'n2', 'output'), { recursive: true });
        writeFileSync(join(rec, 'n2', 'output', 'request.json'), JSON.stringify(request('run-2', 'n2', e1.at)));
        const e2 = orphan(t0 + 400_000, attempt(t0 + 320_000, 202, child('run-2')));
        tasks.push(...run('r2', 'run-2', e1.at, childHeld));
        expect(spentAttempts(tasks, { account, endedAt: e2.at })).toBe(0);
        expect(budgetRefusal(root, account, e2, tasks)).toBe(`${MAX_ATTEMPTS} recoveries of end ${e2.at} and the 2 earlier ends of its lineage (first ${e0.at}) failed; recover by hand`);
        // Compaction retains full outcomes. A replayed archive row and a row still in state count only once.
        const archive = join(root, '.practice/coordinator/archive/tasks.jsonl');
        mkdirSync(join(archive, '..'), { recursive: true });
        const archived = [...tasks, ...tasks];
        writeFileSync(archive, archived.map(t => JSON.stringify(t)).join('\n') + '\n');
        const exhausted = budgetRefusal(root, account, e2, tasks);
        expect(budgetRefusal(root, account, e2, [])).toBe(exhausted);
        expect(budgetRefusal(root, account, e1, tasks.slice(0, 4))).toMatch(/^2 recoveries /);
        // Task ids may be reused after compaction. Unrelated executions cannot hold this account's budget.
        const reused = ['task-1f733251-4e75-4fc2-8d92-06c81cee5303', 'task-2d04d57a-4b62-4ebf-b2f6-046ee44d7ff3']
            .map(runId => ({ status: 'failed', runId, spec: { id: 'build-fishing-contest-trophy-gate-exit', kind: 'build' } }));
        writeFileSync(archive, [...reused, ...archived].map(t => JSON.stringify(t)).join('\n') + '\n');
        expect(budgetRefusal(root, account, e2, tasks)).toBe(exhausted);
        // Six waits also survive compaction, without any child attempt to bound their number.
        const waits = Array.from({ length: MAX_WAITS }, (_, i) => run(`w${i + 2}`, `run-w${i + 2}`, e2.at, 'Error: live admission waiting: memory')).flat();
        writeFileSync(archive, [...tasks.slice(0, 2), ...waits, ...waits].map(t => JSON.stringify(t)).join('\n') + '\n');
        expect(budgetRefusal(root, account, e2, waits.slice(0, 2))).toMatch(/^6 recoveries .* waited /);
        writeFileSync(archive, JSON.stringify(tasks[1]) + '\n{');
        expect(budgetRefusal(root, account, e2, tasks)).toMatch(/unknown .*archive/);
        writeFileSync(archive, '');
        // A separate ordinary session after the lineage is a new lineage: its end has its full budget.
        const e3 = orphan(t0 + 560_000, attempt(t0 + 500_000, 300, ordinary));
        expect(budgetRefusal(root, account, e3, tasks)).toBeUndefined();
        // Unknown links get no budget: an end that names an attempt with no receipt, a recovery child of a run with no retained request.
        expect(budgetRefusal(root, account, orphan(t0 + 600_000, id(t0 + 590_000, 9)), tasks)).toMatch(/^recovery lineage of end \d+ unknown \(attempt .* has no lifecycle receipt\); recover by hand$/);
        expect(budgetRefusal(root, account, orphan(t0 + 760_000, attempt(t0 + 700_000, 400, child('run-unknown'))), tasks)).toMatch(/no retained recovery request names/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a confirmed logout or an ordinary session between an end and its recovery child starts a new lineage', () => {
    const c = (attemptId: string, runId: string, confirmed = false) => ({ attemptId, runId, script: RECOVERY_SCRIPT, role: 'recovery', confirmed });
    const parent = 1794554060000, records = [{ runId: 'run-1', endedAt: parent }];
    const childId = '1794554120000-0000000201-0000000001', end = { at: 1794554200000, reason: `exit orphaned: attempt ${childId} owner 201 gone` }, between = '1794554090000-0000000150-0000000001';
    expect(recoveryLineage(end, [c(childId, 'run-1')], records)).toEqual({ ends: [end.at, parent] });
    expect(recoveryLineage(end, [c(between, 'run-0', true), c(childId, 'run-1')], records)).toEqual({ ends: [end.at] });
    expect(recoveryLineage(end, [{ attemptId: between, runId: null, script: 'scripts/goldfarm.ts', role: 'thieving', confirmed: false }, c(childId, 'run-1')], records)).toEqual({ ends: [end.at] });
    // A coordinator job that runs the session check is an ordinary session, not a recovery child.
    expect(recoveryLineage(end, [{ ...c(childId, 'run-1'), script: 'scripts/session-check.ts', role: null }], records)).toEqual({ ends: [end.at] });
    expect(recoveryLineage(end, [{ attemptId: between, unreadable: true }, c(childId, 'run-1')], records)).toMatchObject({ unknown: expect.stringContaining('unreadable') });
    expect(recoveryLineage(end, [c(childId, 'run-1')], [...records, { runId: 'run-1', endedAt: parent - 1 }])).toMatchObject({ unknown: expect.stringContaining('different ends') });
});
