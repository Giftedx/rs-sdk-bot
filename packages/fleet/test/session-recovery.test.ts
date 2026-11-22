import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfraCircuitBreaker } from '../src/infra-circuit-breaker';
import {
    END_SETTLE_MS,
    assessRecoveryEligibility,
    clearSwarmStops,
    readStandaloneHistory,
    recoveryLeaseState,
    runLocalRecoveryDirect,
    runStandaloneRecoveryPass,
    spentStandaloneAttempts,
    swarmWroteStopText,
} from '../src/session-recovery';
import { liveRoot } from '../../core/src/practice-paths';
import { beginSessionAttempt } from '../../core/src/session-lifecycle';

const dirs: string[] = [];
const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-recovery-test-'));
    dirs.push(d);
    return d;
};

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('fleet standalone session recovery', () => {
    test('distinguishes swarm-authored stops from owner/specialist pauses and assesses eligibility cleanly', () => {
        expect(swarmWroteStopText('swarm stopped')).toBe(true);
        expect(swarmWroteStopText('swarm plan removed or stopped')).toBe(true);
        expect(swarmWroteStopText('owner stopped swarm')).toBe(false);
        expect(swarmWroteStopText('specialist hold')).toBe(false);

        const heldProof = {
            state: 'held' as const,
            account: 'worker1',
            server: 'rs-sdk-demo.fly.dev',
            domain: 'live' as const,
            attemptId: '1700000001000-pid-nonce',
            reason: 'disconnect',
        };
        const end = { at: 1_700_000_002_000, reason: 'blocked at bank' };
        expect(assessRecoveryEligibility({
            proof: heldProof,
            claim: { phase: 'held', kind: 'swarm', host: 'box-a', pid: 999991 },
            end,
            stopText: 'owner stop',
            pidAlive: () => false,
            host: 'box-a',
        })).toEqual({ eligible: false, reason: 'owner stop file holds the account', log: true });

        expect(assessRecoveryEligibility({
            proof: heldProof,
            claim: { phase: 'held', kind: 'swarm', host: 'box-a', pid: 999991 },
            end,
            stopText: 'swarm stopped',
            pidAlive: () => false,
            host: 'box-a',
        })).toEqual({ eligible: true, endedAt: end.at });
    });

    test('runs standalone recovery without coordinator proposals, preserves attempt budget on infra faults, and archives stale leases', async () => {
        const root = scratch();
        const server = 'rs-sdk-demo.fly.dev';
        const lRoot = join(liveRoot(root), 'session-lifecycle');
        const acct = 'worker1';

        const attempt = beginSessionAttempt(
            { account: acct, server },
            {
                root: lRoot,
                owner: {
                    pid: 999991,
                    coordinatorRunId: null,
                    workerRelease: 'rel-1',
                    script: 'scripts/woodcut.ts',
                    role: null,
                    participants: null,
                },
            },
        );
        const createdAt = Number(attempt.attemptId.slice(0, 13));
        const endedAt = createdAt + 5_000;
        const now = endedAt + END_SETTLE_MS + 10_000;

        mkdirSync(join(root, '.practice', 'coordinator', 'session-recovery', 'accounts', acct), { recursive: true });
        writeFileSync(
            join(root, '.practice', 'coordinator', 'session-recovery', 'accounts', acct, 'lease.json'),
            JSON.stringify({
                schema: 'session-recovery-permit/1',
                request: {
                    schema: 'session-recovery/1',
                    account: acct,
                    server,
                    runId: 'dead-run',
                    nonce: 'dead-nonce',
                    endedAt,
                    source: 'a'.repeat(64),
                },
                controller: { pid: 999991, nonce: 'c-nonce', source: 'a'.repeat(64) },
                issuedAt: endedAt + 100,
                expiresAt: endedAt + 150_100,
                runnerSha256: 'b'.repeat(64),
                nativeFixture: false,
            }),
        );
        writeFileSync(join(root, '.practice', 'swarm-deaths.json'), JSON.stringify({
            [acct]: { at: endedAt, reason: 'blocked on login' },
        }));
        writeFileSync(join(root, '.practice', 'stop-' + acct), 'swarm stopped');

        const owners = new Map([[acct, { side: 'local', server }]]);
        const breaker = new InfraCircuitBreaker({
            baseMs: 5_000,
            jitterRatio: 0,
            stateFile: join(liveRoot(root), 'infra-circuit-breaker.json'),
            now: () => now,
            random: () => 0.5,
        });

        // 1. Dry run reports target without clearing stops or mutating leases.
        const dry = await runStandaloneRecoveryPass({
            root,
            side: 'local',
            server,
            dry: true,
            now: () => now,
            pidAlive: () => false,
            owners,
            breaker,
            readClaim: () => ({ phase: 'held', kind: 'swarm', host: 'box-a', pid: 999991 }),
            log: () => {},
        });
        expect(dry.targets).toEqual([{ account: acct, endedAt }]);
        expect(existsSync(join(root, '.practice', 'stop-' + acct))).toBe(true);
        expect(recoveryLeaseState(root, acct, () => false, now)).toBe('stale');

        // 2. Infra fault trips circuit breaker without consuming account recovery attempt budget.
        const infraRes = await runStandaloneRecoveryPass({
            root,
            side: 'local',
            server,
            dry: false,
            now: () => now,
            pidAlive: () => false,
            owners,
            breaker,
            readClaim: () => ({ phase: 'held', kind: 'swarm', host: 'box-a', pid: 999991 }),
            executeRecovery: async () => ({ ok: false, detail: 'ERR_PROXY_CONNECTION_FAILED on socks5 proxy' }),
            log: () => {},
        });
        expect(infraRes.failed).toEqual([]);
        expect(infraRes.skipped[0]?.reason).toContain('infra fault (proxy)');
        expect(breaker.canProceed('proxy').allowed).toBe(false);
        expect(spentStandaloneAttempts(readStandaloneHistory(root), acct, endedAt)).toBe(0);
        // Stale recovery lease was archived and swarm stop cleared, with zero coordinator proposals queued.
        const leaseFiles = readdirSync(join(root, '.practice', 'coordinator', 'session-recovery', 'accounts', acct));
        expect(leaseFiles.some(f => f.startsWith('lease-stale-'))).toBe(true);
        expect(existsSync(join(root, '.practice', 'stop-' + acct))).toBe(false);
        expect(existsSync(join(root, '.practice', 'coordinator', 'state.json'))).toBe(false);

        // 3. While circuit breaker is open, recovery pass backs off globally.
        const deferred = await runStandaloneRecoveryPass({
            root,
            side: 'local',
            server,
            dry: false,
            now: () => now,
            owners,
            breaker,
            log: () => {},
        });
        expect(deferred.blockedByCircuit).toContain('proxy backoff active');

        // 4. After backoff expires, successful execution clears breaker and records success.
        const later = now + 6_000;
        const okBreaker = new InfraCircuitBreaker({
            baseMs: 5_000,
            jitterRatio: 0,
            stateFile: join(liveRoot(root), 'infra-circuit-breaker.json'),
            now: () => later,
            random: () => 0.5,
        });
        const passOk = await runStandaloneRecoveryPass({
            root,
            side: 'local',
            server,
            dry: false,
            now: () => later,
            pidAlive: () => false,
            owners,
            breaker: okBreaker,
            readClaim: () => ({ phase: 'held', kind: 'swarm', host: 'box-a', pid: 999991 }),
            executeRecovery: async () => ({ ok: true, detail: 'closed modal and logged out cleanly' }),
            log: () => {},
        });
        expect(passOk.ok).toBe(true);
        expect(passOk.recovered).toEqual([acct]);
        expect(okBreaker.canProceed().allowed).toBe(true);
    });

    test('refuses runLocalRecoveryDirect on live servers and allows explicit local mock execution', async () => {
        const root = scratch();
        await expect(runLocalRecoveryDirect('worker1', 'rs-sdk-demo.fly.dev', {} as any, root)).rejects.toThrow(
            /live authenticated recovery/,
        );

        const settled = await runLocalRecoveryDirect('worker1', 'localhost:8880', {
            connect: async () => { throw new Error('local connect stub'); },
            ready: async () => false,
            closeModal: async () => false,
            logout: async () => 'logged-out',
            close: async () => {},
            root: join(liveRoot(root), 'session-lifecycle'),
            guard: () => {},
            log: () => {},
        }, root, 'c'.repeat(64));
        expect(settled).toBeDefined();

        // Owner pause prevents clearing stops.
        mkdirSync(join(root, '.practice'), { recursive: true });
        writeFileSync(join(root, '.practice', 'stop-swarm'), '');
        writeFileSync(join(root, '.practice', 'stop-worker1'), 'swarm stopped');
        expect(clearSwarmStops(root, ['worker1'])).toEqual([]);
        expect(existsSync(join(root, '.practice', 'stop-worker1'))).toBe(true);
    });
});
