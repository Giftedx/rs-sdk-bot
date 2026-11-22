import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfraCircuitBreaker, classifyInfraFault } from '../src/infra-circuit-breaker';
import { observeSwarmInfraFault } from '../../../scripts/swarm';
import { recordAgentInfraResult } from '../../../scripts/fleet-agent';

const dirs: string[] = [];
const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-infra-cb-'));
    dirs.push(d);
    return d;
};

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('classifyInfraFault', () => {
    test('classifies proxy, server-drain, and remote Git claim authority errors while ignoring gameplay errors', () => {
        expect(classifyInfraFault('ERR_PROXY_CONNECTION_FAILED to socks5 host')).toBe('proxy');
        expect(classifyInfraFault(new Error('HTTP 407 Proxy Authentication Required'))).toBe('proxy');
        expect(classifyInfraFault('server is draining before reboot')).toBe('server_drain');
        expect(classifyInfraFault('503 Service Unavailable during login')).toBe('server_drain');
        expect(classifyInfraFault('fleet controller lease unavailable: push failed')).toBe('remote_git_claim');
        expect(classifyInfraFault('cannot lock ref refs/heads/fleet-trade-claim')).toBe('remote_git_claim');
        expect(classifyInfraFault('unable to access https://github.com/org/repo.git/: Could not resolve host')).toBe('remote_git_claim');

        expect(classifyInfraFault('RESULT died account bob ran out of hitpoints')).toBeNull();
        expect(classifyInfraFault('bad password or locked account')).toBeNull();
        expect(classifyInfraFault('')).toBeNull();
    });
});

describe('InfraCircuitBreaker', () => {
    test('applies exponential backoff with cap and resets cleanly on success', () => {
        let now = 1_000_000;
        const breaker = new InfraCircuitBreaker({
            baseMs: 1_000,
            maxMs: 8_000,
            factor: 2,
            jitterRatio: 0,
            threshold: 1,
            now: () => now,
            random: () => 0.5,
        });

        expect(breaker.canProceed().allowed).toBe(true);

        const f1 = breaker.recordFailure('could not resolve host github.com');
        expect(f1.tripped).toBe(true);
        expect(f1.kind).toBe('remote_git_claim');
        expect(f1.backoffMs).toBe(1_000);
        expect(breaker.canProceed().allowed).toBe(false);
        expect(breaker.canProceed().waitMs).toBe(1_000);

        now += 1_000;
        expect(breaker.canProceed().allowed).toBe(true);

        const f2 = breaker.recordFailure('could not resolve host github.com');
        expect(f2.backoffMs).toBe(2_000);

        now += 2_000;
        const f3 = breaker.recordFailure('could not resolve host github.com');
        expect(f3.backoffMs).toBe(4_000);

        now += 4_000;
        const f4 = breaker.recordFailure('could not resolve host github.com');
        expect(f4.backoffMs).toBe(8_000);

        now += 8_000;
        const f5 = breaker.recordFailure('could not resolve host github.com');
        expect(f5.backoffMs).toBe(8_000);

        breaker.recordSuccess('remote_git_claim');
        expect(breaker.canProceed('remote_git_claim').allowed).toBe(true);
        expect(breaker.snapshot().faults.remote_git_claim.consecutiveFailures).toBe(0);
    });

    test('honors failure threshold, deterministic jitter, and persists state without touching per-account files', () => {
        const dir = scratch();
        const stateFile = join(dir, 'live', 'infra-circuit-breaker.json');
        const deathsFile = join(dir, 'swarm-deaths.json');
        const holdsFile = join(dir, 'swarm-script-holds.json');
        writeFileSync(deathsFile, '{}');
        writeFileSync(holdsFile, '[]');

        let now = 50_000;
        const breaker = new InfraCircuitBreaker({
            baseMs: 2_000,
            maxMs: 20_000,
            factor: 2,
            jitterRatio: 0.2,
            threshold: 2,
            stateFile,
            now: () => now,
            random: () => 1, // +20% jitter -> 2400 ms on trip
        });

        const first = breaker.recordFailure('proxy connection refused');
        expect(first.tripped).toBe(false);
        expect(first.backoffMs).toBe(0);
        expect(breaker.canProceed('proxy').allowed).toBe(true);

        const second = breaker.recordFailure('proxy connection refused');
        expect(second.tripped).toBe(true);
        expect(second.backoffMs).toBe(2_400);
        expect(breaker.canProceed('proxy').allowed).toBe(false);
        expect(existsSync(stateFile)).toBe(true);

        const reloaded = new InfraCircuitBreaker({ stateFile, now: () => now });
        expect(reloaded.canProceed('proxy').allowed).toBe(false);
        expect(reloaded.canProceed('proxy').consecutiveFailures).toBe(2);

        // Verify per-account hold/death files were never touched.
        expect(readFileSync(deathsFile, 'utf8')).toBe('{}');
        expect(readFileSync(holdsFile, 'utf8')).toBe('[]');
    });

    test('redacts embedded credentials in lastError and wraps guard calls cleanly', async () => {
        let now = 10_000;
        const breaker = new InfraCircuitBreaker({
            baseMs: 1_000,
            jitterRatio: 0,
            now: () => now,
            random: () => 0.5,
        });

        await expect(
            breaker.guard(async () => {
                throw new Error('fetch failed from https://user:secret@example.com PASSWORD=my-secret');
            }, 'remote_git_claim'),
        ).rejects.toThrow();

        const snap = breaker.snapshot();
        expect(snap.faults.remote_git_claim.lastError).not.toContain('secret');
        expect(snap.faults.remote_git_claim.lastError).not.toContain('my-secret');
        expect(snap.faults.remote_git_claim.lastError).toContain('[redacted]');

        await expect(breaker.guard(async () => 'ok', 'remote_git_claim')).rejects.toThrow(/infra circuit breaker open/);

        now += 1_000;
        await expect(breaker.guard(async () => 'recovered', 'remote_git_claim')).resolves.toBe('recovered');
        expect(breaker.snapshot().faults.remote_git_claim.consecutiveFailures).toBe(0);
    });

    test('swarm and fleet-agent adapters trip only on infra faults and never penalize account failures', () => {
        let now = 20_000;
        const breaker = new InfraCircuitBreaker({
            baseMs: 1_000,
            jitterRatio: 0,
            now: () => now,
            random: () => 0.5,
        });

        expect(observeSwarmInfraFault(breaker, 'BOT died during quest step')).toBe(false);
        expect(breaker.canProceed().allowed).toBe(true);

        expect(observeSwarmInfraFault(breaker, 'server is draining; disconnecting')).toBe(true);
        expect(breaker.canProceed('server_drain').allowed).toBe(false);

        now += 2_000;
        expect(recordAgentInfraResult(breaker, 'fatal: unable to access https://github.com/org/r: Could not resolve host', 128)).toBe(true);
        expect(breaker.canProceed('remote_git_claim').allowed).toBe(false);

        now += 2_000;
        expect(recordAgentInfraResult(breaker, 'RESULT ok fleet-sync clean', 0)).toBe(false);
        expect(breaker.canProceed('remote_git_claim').allowed).toBe(true);
    });
});
