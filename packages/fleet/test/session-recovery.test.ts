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
    dispatchRefusalWaits,
    executeControlledLiveRecovery,
    findAccountStatus,
    findCurrentNativeRecoveryQualification,
    readStandaloneHistory,
    recordStandaloneAttempt,
    passAhead,
    recoveryLeaseState,
    recoveryPassDir,
    refundStandaloneAttempts,
    runControlledDispatchOne,
    runLocalRecoveryDirect,
    runStandaloneRecoveryPass,
    spentAttemptsByEnd,
    spentStandaloneAttempts,
    swarmWroteStopText,
    triedEnds,
    type StandaloneRecoveryRecord,
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
    test('a refund gives back the attempts an end spent, later failures count again, and infrastructure faults never count', () => {
        const h: StandaloneRecoveryRecord[] = [
            { at: 1, account: 'Worker1', endedAt: 10, ok: false, reason: 'a' },
            { at: 2, account: 'worker1', endedAt: 10, ok: false, infraFault: true, reason: 'b' },
            { at: 3, account: 'worker1', endedAt: 10, ok: false, reason: 'c' },
            { at: 4, account: 'worker2', endedAt: 10, ok: false, reason: 'd' },
        ];
        expect(spentStandaloneAttempts(h, 'worker1', 10)).toBe(2);
        h.push({ at: 5, account: 'worker1', endedAt: 10, ok: true, refund: true, reason: 'refund of 2' });
        expect(spentStandaloneAttempts(h, 'worker1', 10)).toBe(0);
        expect(spentStandaloneAttempts(h, 'worker2', 10)).toBe(1);
        h.push({ at: 6, account: 'worker1', endedAt: 10, ok: false, reason: 'e' });
        expect(spentAttemptsByEnd(h).get('worker1|10')).toBe(1);
        // A refund of another end gives nothing back for this one.
        h.push({ at: 7, account: 'worker1', endedAt: 11, ok: true, refund: true, reason: 'other end' });
        expect(spentStandaloneAttempts(h, 'worker1', 10)).toBe(1);
        // A refund keeps the fact of a try: an end whose recovery left a newer producer attempt stays retryable.
        const refunded: StandaloneRecoveryRecord[] = [
            { at: 1, account: 'worker3', endedAt: 20, ok: false, reason: 'recovery child held' },
            { at: 2, account: 'worker3', endedAt: 20, ok: true, refund: true, reason: 'refund of 1' },
        ];
        expect(spentStandaloneAttempts(refunded, 'worker3', 20)).toBe(0);
        expect(triedEnds(refunded).has('worker3|20')).toBe(true);
        expect(triedEnds([{ at: 1, account: 'worker4', endedAt: 30, ok: true, reason: 'controlled recovery confirmed' }]).size).toBe(0);
    });

    test('the owner refund writes one record for a held account with spent attempts, and refuses any other', () => {
        const root = scratch(), server = 'rs-sdk-demo.fly.dev', lRoot = join(liveRoot(root), 'session-lifecycle');
        const endedAt = Date.now() - 60_000;
        mkdirSync(join(root, '.practice'), { recursive: true });
        writeFileSync(join(root, '.practice', 'swarm-deaths.json'), JSON.stringify({ worker1: { at: endedAt, reason: 'stopped after 1 runs' } }));
        expect(() => refundStandaloneAttempts(root, 'worker1', 'heartbeat stall')).toThrow('logout proof is none, not held');
        beginSessionAttempt({ account: 'worker1', server }, { root: lRoot, now: () => endedAt - 2_000 }).record('ready');
        expect(() => refundStandaloneAttempts(root, 'worker1', 'heartbeat stall')).toThrow('has spent no attempt for its end');
        recordStandaloneAttempt(root, { at: endedAt + 1, account: 'worker1', endedAt, ok: false, reason: 'repair lease busy' });
        recordStandaloneAttempt(root, { at: endedAt + 2, account: 'worker1', endedAt, ok: false, reason: 'recovery child held' });
        expect(() => refundStandaloneAttempts(root, 'worker1', ' ')).toThrow('a reason is required');
        expect(() => refundStandaloneAttempts(root, 'nobody', 'x')).toThrow('has no recorded end');
        expect(refundStandaloneAttempts(root, 'Worker1', 'stale swarm heartbeat during a lease renewal', endedAt + 3)).toEqual({
            at: endedAt + 3, account: 'worker1', endedAt, ok: true, refund: true, reason: 'refund of 2: stale swarm heartbeat during a lease renewal',
        });
        expect(spentStandaloneAttempts(readStandaloneHistory(root), 'worker1', endedAt)).toBe(0);
    });

    test('recovery pass admission: a running pass and a choosing one hold a new pass back, dead records go, and alone it runs', async () => {
        // Ahead means a lower ticket, then a lower pid: of two passes with one ticket, exactly one runs.
        expect(passAhead({ pid: 9, ticket: 5 }, { pid: 3, ticket: 6 })).toBe(true);
        expect(passAhead({ pid: 3, ticket: 6 }, { pid: 9, ticket: 6 })).toBe(true);
        expect(passAhead({ pid: 9, ticket: 6 }, { pid: 3, ticket: 6 })).toBe(false);
        const root = scratch(), dir = recoveryPassDir(root), now = Date.now();
        mkdirSync(dir, { recursive: true });
        const put = (pid: number, rec: object) => writeFileSync(join(dir, `${pid}-${now}.json`), JSON.stringify({ pid, at: now, ...rec }));
        const logs: string[] = [];
        const opts = { root, side: 'local', owners: new Map<string, { side: string; server: string }>(), log: (l: string) => logs.push(l), processStarts: () => new Map<number, number>(), passChoosingWaitMs: 50 };
        // A pass that runs holds ticket 7. A newcomer takes ticket 8, even one that read the clock first, and defers.
        put(4242, { choosing: false, ticket: 7 });
        expect((await runStandaloneRecoveryPass({ ...opts, pidAlive: pid => pid === 4242 })).blockedByPass).toBe(4242);
        expect(logs.at(-1)).toBe('deferred: recovery pass pid 4242 still running');
        // A pass that is still taking its ticket holds a newcomer back until the wait ends.
        rmSync(join(dir, `4242-${now}.json`));
        put(4343, { choosing: true, ticket: 0 });
        expect((await runStandaloneRecoveryPass({ ...opts, pidAlive: pid => pid === 4343 })).blockedByPass).toBe(4343);
        expect(logs.at(-1)).toBe('deferred: recovery pass pid 4343 still choosing');
        // The records of dead passes go, and a pass alone runs.
        const ran = await runStandaloneRecoveryPass({ ...opts, pidAlive: () => false });
        expect(ran.ok).toBe(true);
        expect(ran.blockedByPass).toBeUndefined();
        expect(readdirSync(dir)).toEqual([]);
    });

    test('a setup refusal for the controller state waits and spends no attempt; an account-side refusal spends one', () => {
        const refused = 'recovery setup refused; no lease issued; no retry';
        for (const cause of ['recovery admission waiting: memory', 'recovery admission waiting: maxBots', 'recovery waits for runtime source owner',
            'no worker progress: release pin missing; live starts paused', 'no worker progress: release source changed; live starts paused']) {
            expect(dispatchRefusalWaits(refused, cause)).toBe(true);
        }
        // A swarm heartbeat that a slow Git push held back, or a controller that just restarted.
        expect(dispatchRefusalWaits(refused, 'recovery fleet ownership unresolved: stale')).toBe(true);
        expect(dispatchRefusalWaits(refused, 'recovery fleet ownership unresolved: controller')).toBe(true);
        expect(dispatchRefusalWaits(refused, 'recovery fleet ownership unresolved: account-active')).toBe(false);
        expect(dispatchRefusalWaits('existing recovery lease held; request preserved', '')).toBe(true);
        for (const cause of ['recovery account still active', 'recovery owner stopped', 'recovery task owner changed']) expect(dispatchRefusalWaits(refused, cause)).toBe(false);
        expect(dispatchRefusalWaits('recovery setup failed after issuance; account lease held; no retry', 'recovery admission waiting: memory')).toBe(false);
    });

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

    test('a held trade claim is always refused, and the refusal is logged only when no live trade worker of this host holds it', () => {
        const proof = { state: 'held' as const, account: 'worker1', server: 'rs-sdk-demo.fly.dev', domain: 'live' as const, attemptId: '1700000001000-pid-nonce', reason: 'disconnect' };
        const trade = { phase: 'held' as const, orderId: 'o1', host: 'box-a', pid: 24460 };
        const refuse = (claim: typeof trade | Omit<typeof trade, 'pid'>, alive: boolean, host = 'box-a') => assessRecoveryEligibility({
            proof, claim, end: { at: 1_700_000_002_000, reason: 'exit unknown' }, stopText: undefined, pidAlive: pid => alive && pid === 24460, host,
        });
        // A live trade worker of this host holds the claim: the refusal is not logged.
        expect(refuse(trade, true)).toEqual({ eligible: false, reason: 'claim is held by a trade order', log: false });
        expect(refuse(trade, false)).toEqual({ eligible: false, reason: 'claim is held by a trade order', log: true });
        expect(refuse(trade, true, 'box-b')).toEqual({ eligible: false, reason: 'claim is held by a trade order', log: true });
        expect(refuse({ phase: 'held', orderId: 'o1', host: 'box-a' }, true)).toEqual({ eligible: false, reason: 'claim is held by a trade order', log: true });
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

        const ownerWritten = JSON.parse(readFileSync(join(liveRoot(root), 'fleet-runs', runId, 'owner.json'), 'utf8'));
        expect(ownerWritten.runId).toBe(runId);
        expect(Number.isSafeInteger(ownerWritten.pid) && ownerWritten.pid > 0 && ownerWritten.pid !== process.pid).toBe(true);
    });

    test('assessRecoveryEligibility accepts released fleet-trade claims with dead PID and stopped/disconnected proof', () => {
        const stoppedProof = {
            state: 'held' as const,
            account: 'oreelse',
            server: 'rs-sdk-demo.fly.dev',
            domain: 'live' as const,
            attemptId: '1795573046627-0000012580-0000000001',
            reason: 'ended stopped',
        };
        const priorEnd = { at: 1795562523246, reason: 'gave-up after 21 runs' };
        const releasedTrade = {
            phase: 'released' as const,
            orderId: '1795572728675-woodpecker-oreelse-1e1636f203f8de75',
            host: 'box-a',
            pid: 12580,
        };

        expect(assessRecoveryEligibility({
            proof: stoppedProof,
            claim: releasedTrade,
            end: priorEnd,
            stopText: undefined,
            pidAlive: () => false,
            host: 'box-a',
        })).toEqual({ eligible: true, endedAt: priorEnd.at });

        expect(assessRecoveryEligibility({
            proof: stoppedProof,
            claim: releasedTrade,
            end: priorEnd,
            stopText: undefined,
            pidAlive: () => true,
            host: 'box-a',
        })).toEqual({ eligible: false, reason: 'worker still alive', log: false });

        expect(assessRecoveryEligibility({
            proof: { ...stoppedProof, reason: 'session active or outcome unknown' },
            claim: releasedTrade,
            end: priorEnd,
            stopText: undefined,
            pidAlive: () => false,
            host: 'box-a',
        })).toEqual({ eligible: false, reason: 'no held fleet account claim', log: false });

        expect(assessRecoveryEligibility({
            proof: stoppedProof,
            claim: releasedTrade,
            end: { at: priorEnd.at, reason: 'died in pvp' },
            stopText: undefined,
            pidAlive: () => false,
            host: 'box-a',
        })).toEqual({ eligible: false, reason: 'death requires diagnosis before recovery', log: true });
    });
});

test('a held session after a release-paused, released or refused run is recovered; a death is not', async () => {
    const { RECOVERABLE_END } = await import('../src/session-recovery');
    for (const reason of ['release-paused after 1 runs', 'released: stopped after 1 runs', 'refused after 1 runs', 'stopped after 2 runs', 'blocked after 2 runs', 'exit 1']) {
        expect(RECOVERABLE_END.test(reason)).toBe(true);
    }
    for (const reason of ['died after 1 runs', 'done after 1 runs']) expect(RECOVERABLE_END.test(reason)).toBe(false);
});
