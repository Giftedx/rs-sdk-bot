import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_RECOVERY_CHECKS, RECOVERY_SCHEMA, RECOVERY_SCRIPT } from '../../core/src/session-recovery-permit';
import { cachedLaunchRevision, capabilityRevision } from '../../core/src/worker-release';
import { InfraCircuitBreaker } from '../src/infra-circuit-breaker';
import {
    END_SETTLE_MS,
    acquireRepairLease,
    archiveStaleLease,
    assessRecoveryEligibility,
    clearSwarmStops,
    executeControlledLiveRecovery,
    findAccountStatus,
    findCurrentNativeRecoveryQualification,
    readStandaloneHistory,
    recoveryLeaseState,
    runControlledDispatchOne,
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

    test('filters by single account, defers without burning budget when swarm controller is down, and locates current native qualification', async () => {
        const root = scratch();
        const server = 'rs-sdk-demo.fly.dev';
        const lRoot = join(liveRoot(root), 'session-lifecycle');
        const owners = new Map([
            ['worker1', { side: 'local', server }],
            ['worker2', { side: 'local', server }],
        ]);
        const endedAt = Date.now() - END_SETTLE_MS - 10_000;
        for (const acct of ['worker1', 'worker2']) {
            const a = beginSessionAttempt({ account: acct, server }, { root: lRoot, now: () => endedAt - 2_000 });
            a.record('ready');
        }
        writeFileSync(join(root, '.practice', 'swarm-deaths.json'), JSON.stringify({
            worker1: { at: endedAt, reason: 'blocked' },
            worker2: { at: endedAt, reason: 'blocked' },
        }));

        // Account filter picks only worker2
        const filteredDry = await runStandaloneRecoveryPass({
            root,
            side: 'local',
            server,
            account: 'worker2',
            dry: true,
            pidAlive: () => false,
            owners,
            readClaim: () => ({ phase: 'held', kind: 'swarm', host: 'box-a', pid: 999991 }),
            log: () => {},
        });
        expect(filteredDry.targets).toEqual([{ account: 'worker2', endedAt }]);

        // Missing swarm controller defers without burning attempt budget or tripping circuit breaker
        const deferred = await runStandaloneRecoveryPass({
            root,
            side: 'local',
            server,
            account: 'worker1',
            dry: false,
            pidAlive: () => false,
            owners,
            readClaim: () => ({ phase: 'held', kind: 'swarm', host: 'box-a', pid: 999991 }),
            log: () => {},
        });
        expect(deferred.failed).toEqual([]);
        expect(deferred.skipped[0]?.reason).toContain('swarm controller unavailable');
        expect(spentStandaloneAttempts(readStandaloneHistory(root), 'worker1', endedAt)).toBe(0);

        // executeControlledLiveRecovery defers when controller missing
        const directDefer = await executeControlledLiveRecovery(
            { account: 'worker1', endedAt, server },
            { root, pidAlive: () => false },
        );
        expect(directDefer.ok).toBe(false);
        expect(directDefer.deferred).toBe(true);

        // Qualification scanner returns null when absent, and validates a complete delivery + proof bundle
        expect(findCurrentNativeRecoveryQualification(root)).toBeNull();

        const repo = join(import.meta.dir, '..', '..', '..');
        const source = cachedLaunchRevision(repo);
        const capRev = capabilityRevision(['scripts/session-check.ts'], repo);
        const delivDir = join(root, '.practice', 'deliveries', 'rec-proof');
        mkdirSync(delivDir, { recursive: true });
        // Copy real runner file so findCurrentNativeRecoveryQualification hashes RECOVERY_SCRIPT under root
        const runnerDst = join(root, RECOVERY_SCRIPT);
        mkdirSync(join(runnerDst, '..'), { recursive: true });
        const runnerBytes = await Bun.file(join(repo, RECOVERY_SCRIPT)).bytes();
        writeFileSync(runnerDst, runnerBytes);
        // Copy scripts/session-check.ts and its transitive capability deps? Pass explicit root=repo?
        // Easier: place a minimal delivery in a scratch root only when capabilityRevision matches; or test findCurrentNativeRecoveryQualification on a temp root with runner + matching capabilityRevision.
        const runnerSha = createHash('sha256').update(runnerBytes).digest('hex');
        const evPath = join(delivDir, 'ev.txt');
        writeFileSync(evPath, 'ok');
        const evSha = createHash('sha256').update('ok').digest('hex');
        const checks = Object.fromEntries(NATIVE_RECOVERY_CHECKS.map(k => [k, { ok: true, level: 'native-test', cases: ['c1'], evidence: [{ path: 'ev.txt', sha256: evSha }] }]));
        const proofPath = join(delivDir, 'proof.json');
        writeFileSync(proofPath, JSON.stringify({
            ok: true,
            level: 'native-controller-recovery',
            runtimeRevision: source,
            runnerSha256: runnerSha,
            cases: [{ id: 'c1', ok: true, level: 'native-test', evidence: [{ path: 'ev.txt', sha256: evSha }] }],
            checks,
        }));
        const proofSha = createHash('sha256').update(await Bun.file(proofPath).bytes()).digest('hex');
        const gateLog = join(delivDir, 'gate.out.log');
        writeFileSync(gateLog, `RECOVERY_NATIVE_PROOF ${JSON.stringify({ path: '.practice/deliveries/rec-proof/proof.json', sha256: proofSha })}\n`);
        writeFileSync(join(delivDir, 'report.json'), JSON.stringify({
            ok: true,
            stage: 'delivered',
            id: 'session-recovery-only',
            at: endedAt + 1000,
            runtimeRevision: capRev,
            checks: [{ id: 'native-session-recovery', phase: 'practice', exitCode: 0, timedOut: false, detail: JSON.stringify({ stdout: '.practice/deliveries/rec-proof/gate.out.log' }) }],
        }));

        // Validate findCurrentNativeRecoveryQualification positive path (matching report + proof + marker)
        const foundQual = findCurrentNativeRecoveryQualification(root, source, endedAt, endedAt + 5_000, capRev);
        expect(foundQual).not.toBeNull();
        expect(foundQual!.proof.path).toBe('.practice/deliveries/rec-proof/proof.json');
        expect(foundQual!.proof.sha256).toBe(proofSha);
        expect(findCurrentNativeRecoveryQualification(root, source, endedAt + 2_000, endedAt + 5_000, capRev)).toBeNull();

        const qual = foundQual!;
        const runId = 'fleet-recovery-test-1';
        const nonce = 'nonce-test-1';
        const okAttempt = beginSessionAttempt({ account: 'worker1', server }, { root: lRoot });
        okAttempt.record('ready');
        okAttempt.record('ended', 'logged-out');

        const resultsFile = join(root, '.practice', 'swarm-repair.json.results.jsonl');
        setTimeout(() => {
            const raw = JSON.stringify({
                schema: RECOVERY_SCHEMA,
                kind: 'session-recovery',
                account: 'worker1',
                server,
                runId,
                nonce,
                endedAt,
                source,
                qualification: qual,
            });
            writeFileSync(resultsFile, JSON.stringify({ at: Date.now(), raw, result: { changed: false, sessionRecovered: true, reason: 'confirmed' } }) + '\n');
        }, 50);

        const dispatchRes = await runControlledDispatchOne({
            root,
            account: 'worker1',
            endedAt,
            server,
            runId,
            nonce,
            source,
            qualification: qual,
            timeoutMs: 2_000,
            pollMs: 20,
        });
        expect(dispatchRes.ok).toBe(true);
        expect(existsSync(join(root, '.practice', 'swarm-repair.json.lease'))).toBe(false);
    }, 30_000);

    test('acquireRepairLease reclaims dead-PID orphaned leases and refuses live active leases', () => {
        const root = scratch();
        mkdirSync(join(root, '.practice'), { recursive: true });
        const leaseFile = join(root, '.practice', 'swarm-repair.json.lease');
        const now = 1_700_000_900_000;

        // Dead PID lease is reclaimed atomically.
        writeFileSync(leaseFile, JSON.stringify({ pid: 999991, runId: 'dead-run', nonce: 'dead-nonce', at: now - 10_000 }));
        acquireRepairLease(
            leaseFile,
            { pid: process.pid, runId: 'new-run', nonce: 'new-nonce', at: now },
            { now, pidAlive: () => false, processStarts: () => new Map() },
        );
        const claimed = JSON.parse(readFileSync(leaseFile, 'utf8'));
        expect(claimed.pid).toBe(process.pid);
        expect(claimed.runId).toBe('new-run');

        // Live PID lease within maxAgeMs is refused.
        expect(() => acquireRepairLease(
            leaseFile,
            { pid: process.pid + 1, runId: 'contender', nonce: 'contender-nonce', at: now + 1_000 },
            { now: now + 1_000, pidAlive: () => true, processStarts: () => new Map([[process.pid, now - 5_000]]) },
        )).toThrow(/repair lease held by active pid/);
    });

    test('runControlledDispatchOne marks transient wait refusals as deferred, archiveStaleLease avoids same-second collisions, and findAccountStatus filters by server', async () => {
        const root = scratch();
        const server = 'rs-sdk-demo.fly.dev';
        const lRoot = join(liveRoot(root), 'session-lifecycle');
        const statusDir = join(liveRoot(root), 'status');
        mkdirSync(statusDir, { recursive: true });
        writeFileSync(join(statusDir, 'worker1.json'), JSON.stringify({ name: 'worker1', server: 'localhost:8880', at: Date.now() }));
        expect(findAccountStatus(root, 'worker1', server)).toBeNull();
        expect(findAccountStatus(root, 'worker1', 'localhost:8880')).not.toBeNull();

        const leaseDir = join(root, '.practice', 'coordinator', 'session-recovery', 'accounts', 'worker1');
        mkdirSync(leaseDir, { recursive: true });
        const now = 1_700_000_500_000;
        writeFileSync(join(leaseDir, 'lease.json'), '{"pid":1}');
        const firstArchive = archiveStaleLease(root, 'worker1', now);
        writeFileSync(join(leaseDir, 'lease.json'), '{"pid":2}');
        const secondArchive = archiveStaleLease(root, 'worker1', now);
        expect(firstArchive).not.toBe(secondArchive);
        expect(existsSync(firstArchive)).toBe(true);
        expect(existsSync(secondArchive)).toBe(true);

        const repo = join(import.meta.dir, '..', '..', '..');
        const source = cachedLaunchRevision(repo);
        const capRev = capabilityRevision(['scripts/session-check.ts'], repo);
        const delivDir = join(root, '.practice', 'deliveries', 'rec-wait');
        mkdirSync(delivDir, { recursive: true });
        const runnerDst = join(root, RECOVERY_SCRIPT);
        mkdirSync(join(runnerDst, '..'), { recursive: true });
        const runnerBytes = await Bun.file(join(repo, RECOVERY_SCRIPT)).bytes();
        writeFileSync(runnerDst, runnerBytes);
        const runnerSha = createHash('sha256').update(runnerBytes).digest('hex');
        const evPath = join(delivDir, 'ev.txt');
        writeFileSync(evPath, 'ok');
        const evSha = createHash('sha256').update('ok').digest('hex');
        const checks = Object.fromEntries(NATIVE_RECOVERY_CHECKS.map(k => [k, { ok: true, level: 'native-test', cases: ['c1'], evidence: [{ path: 'ev.txt', sha256: evSha }] }]));
        const proofPath = join(delivDir, 'proof.json');
        writeFileSync(proofPath, JSON.stringify({
            ok: true,
            level: 'native-controller-recovery',
            runtimeRevision: source,
            runnerSha256: runnerSha,
            cases: [{ id: 'c1', ok: true, level: 'native-test', evidence: [{ path: 'ev.txt', sha256: evSha }] }],
            checks,
        }));
        const proofSha = createHash('sha256').update(await Bun.file(proofPath).bytes()).digest('hex');
        const gateLog = join(delivDir, 'gate.out.log');
        writeFileSync(gateLog, `RECOVERY_NATIVE_PROOF ${JSON.stringify({ path: '.practice/deliveries/rec-wait/proof.json', sha256: proofSha })}\n`);
        writeFileSync(join(delivDir, 'report.json'), JSON.stringify({
            ok: true,
            stage: 'delivered',
            id: 'session-recovery-only',
            at: now - 10_000,
            runtimeRevision: capRev,
            checks: [{ id: 'native-session-recovery', phase: 'practice', exitCode: 0, timedOut: false, detail: JSON.stringify({ stdout: '.practice/deliveries/rec-wait/gate.out.log' }) }],
        }));
        const qual = findCurrentNativeRecoveryQualification(root, source, now - 20_000, now, capRev)!;
        expect(qual).not.toBeNull();

        mkdirSync(lRoot, { recursive: true });
        const runId = 'fleet-recovery-wait-1';
        const nonce = 'nonce-wait-1';
        const resultsFile = join(root, '.practice', 'swarm-repair.json.results.jsonl');
        setTimeout(() => {
            const raw = JSON.stringify({
                schema: RECOVERY_SCHEMA,
                kind: 'session-recovery',
                account: 'worker1',
                server,
                runId,
                nonce,
                endedAt: now - 20_000,
                source,
                qualification: qual,
            });
            writeFileSync(resultsFile, JSON.stringify({
                at: Date.now(),
                raw,
                result: {
                    changed: false,
                    sessionRecovered: false,
                    reason: 'recovery setup refused; no lease issued; no retry',
                    setup: { phase: 'admission', cause: 'recovery admission waiting: maxBots' },
                },
            }) + '\n');
        }, 40);

        const waitRes = await runControlledDispatchOne({
            root,
            account: 'worker1',
            endedAt: now - 20_000,
            server,
            runId,
            nonce,
            source,
            qualification: qual,
            timeoutMs: 2_000,
            pollMs: 20,
        });
        expect(waitRes.ok).toBe(false);
        expect(waitRes.deferred).toBe(true);
        expect(waitRes.detail).toContain('recovery admission waiting: maxBots');
    });
});
