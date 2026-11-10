import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SWARM_STOP } from './swarm';
import { archiveDir, clearSwarmStops, cloudSide, deadTasks, eligibility, lifecycleRoot, MAX_ATTEMPTS, MAX_TARGETS, recoveriesInFlight, recoveryBatch, recoveryProposal, releasableAccounts, releaseBlockers, spentAttempts, submitRejected, type ClaimView } from './cloud-recover';
import { DEFAULT_LIFECYCLE_ROOT } from '../packages/core/src/session-lifecycle';
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
test('a parked owner-job copy stays unless the logout proof is confirmed: none, invalid and held all block', () => {
    for (const state of ['none', 'invalid', 'held']) {
        const v = { ...settled, confirmed: (a: string) => a !== 'Quickhandjob' || state === 'confirmed' };
        expect(releasableAccounts([check, copy], v)).toEqual([]);
    }
    expect(releasableAccounts([check, { ...copy, account: undefined, accounts: ['A', 'B'] }], { ...settled, confirmed: (a: string) => a === 'A' })).toEqual([]);
});
test('a parked owner-job copy stays while a recovery of its account is pending or running', () => {
    expect(releasableAccounts([check, copy], { ...settled, recovering: (a: string) => a === 'Quickhandjob' })).toEqual([]);
});

test('logout proofs are read from the session-lifecycle directory under the checkout', () => {
    // readLogoutProof's root is the lifecycle directory, not the checkout; a checkout root reads every proof as none.
    expect(lifecycleRoot(join(import.meta.dir, '..'))).toBe(DEFAULT_LIFECYCLE_ROOT);
    expect(lifecycleRoot('/r')).toBe(join('/r', '.practice', 'session-lifecycle'));
});

test('only a cloud side runs recovery; the local side and an unset FLEET_SIDE are refused', () => {
    expect(cloudSide('local')).toBe(false);
    expect(cloudSide('claude-cloud-3')).toBe(true);
    expect(cloudSide('cloud')).toBe(true);
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
