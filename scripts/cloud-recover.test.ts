import { expect, test } from 'bun:test';
import { archiveDir, eligibility, parkedAccounts, recoveryProposal, type ClaimView } from './cloud-recover';
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

test('a worker pid on another host does not count as alive here', () => {
    expect(eligibility({ ...base, host: 'other', pidAlive: () => true })).toEqual({ eligible: true, endedAt: 1794183517222 });
});

test('the proposal holds one qualify and one recovery run task with fresh ids', () => {
    const p = recoveryProposal('claude-cloud-3', 'Kiltlifter', 99, Date.UTC(2026, 10, 9, 0, 18, 57, 123));
    expect(p.capabilities).toEqual([]);
    const [q, r] = p.tasks as any[];
    expect(q.id).toBe('claude-cloud-3-recovery-qualified-20261109t001857z');
    expect(q).toMatchObject({ kind: 'qualify', capability: 'session-recovery-only', dependsOn: [] });
    expect(r).toMatchObject({ id: 'claude-cloud-3-recover-kiltlifter-20261109t001857z', kind: 'run', account: 'Kiltlifter', dependsOn: [q.id],
        repairs: [{ account: 'Kiltlifter', endedAt: 99 }], sessionRecovery: { account: 'Kiltlifter', endedAt: 99 }, accept: { counters: { sessionChecked: 1 } } });
    expect(recoveryProposal('claude-cloud-3', 'Kiltlifter', 99, Date.UTC(2026, 10, 9, 0, 19)).tasks[0]!.id).not.toBe(q.id);
});

test('archive folders are named by time and account under the coordinator directory', () => {
    expect(archiveDir('/r', 'PocketPool', Date.UTC(2026, 10, 9, 0, 24, 26))).toBe('/r/.practice/coordinator/release-archive/20261109t002426z-pocketpool');
});

test('only disabled coordinator-owned account jobs count as parked', () => {
    expect(parkedAccounts([
        { account: 'Kiltlifter', coordinatorOwner: 'coordinator', enabled: false, script: 'scripts/session-check.ts' },
        { account: 'PocketPool', coordinatorOwner: 'coordinator', enabled: true },
        { account: 'SporranDip', enabled: false },
        { accounts: ['A'], coordinatorOwner: 'coordinator', enabled: false },
    ])).toEqual(['Kiltlifter']);
});
