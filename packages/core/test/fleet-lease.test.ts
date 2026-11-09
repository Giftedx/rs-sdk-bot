import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireFleetLease, fleetGitWindow, fleetLeaseAllowsWorker, FLEET_LEASE_RENEW_MS, FLEET_LEASE_TTL_MS } from '../src/fleet-lease';

test('the remote lease excludes another checkout, fences old workers, and permits expired takeover', () => {
    const base = mkdtempSync(join(tmpdir(), 'fleet-lease-'));
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', timeout: 5000, windowsHide: true });
    try {
        const remote = join(base, 'origin.git'), a = join(base, 'a'), b = join(base, 'b');
        git(base, 'init', '--bare', remote);
        for (const root of [a, b]) {
            mkdirSync(root);
            git(root, 'init');
            git(root, 'remote', 'add', 'origin', remote);
        }
        let clock = Date.now();
        const now = () => clock;
        const first = acquireFleetLease(a, 'local', now);
        expect(fleetLeaseAllowsWorker(a, first.holder, clock)).toBe(true);
        expect(() => acquireFleetLease(a, 'local', now)).toThrow('held');
        expect(() => acquireFleetLease(b, 'local', now)).toThrow('held');

        clock += FLEET_LEASE_RENEW_MS;
        first.renew();
        expect(fleetLeaseAllowsWorker(a, first.holder, clock)).toBe(true);
        const takeover = clock + FLEET_LEASE_TTL_MS;
        const second = acquireFleetLease(b, 'local', () => takeover);
        expect(fleetLeaseAllowsWorker(b, second.holder, takeover)).toBe(true);
        expect(fleetLeaseAllowsWorker(a, first.holder, takeover)).toBe(false);
        // Simulate a stale local clock to reach the Git compare-and-swap. The old controller
        // still thinks it can renew, but its commit is a sibling of the new remote head.
        expect(() => first.renew()).toThrow('authority unavailable or changed');
        expect(fleetLeaseAllowsWorker(a, first.holder, clock)).toBe(false);

        const returnedAt = takeover + FLEET_LEASE_TTL_MS;
        const returned = acquireFleetLease(a, 'local', () => returnedAt);
        expect(returned.holder).not.toBe(first.holder);
        expect(fleetLeaseAllowsWorker(a, first.holder, returnedAt)).toBe(false);
    } finally {
        if (dirname(base) === tmpdir()) rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    }
}, 30_000);

test('an unreadable authority fails closed', () => {
    const base = mkdtempSync(join(tmpdir(), 'fleet-lease-'));
    try {
        execFileSync('git', ['init'], { cwd: base, stdio: 'pipe', timeout: 5000, windowsHide: true });
        expect(() => acquireFleetLease(base, 'local')).toThrow('authority');
        expect(fleetLeaseAllowsWorker(base, 'unconfirmed')).toBe(false);
    } finally {
        if (dirname(base) === tmpdir()) rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    }
}, 30_000);

test('a replacement in the same checkout can adopt workers after the previous controller exits', async () => {
    const base = mkdtempSync(join(tmpdir(), 'fleet-lease-'));
    try {
        const remote = join(base, 'origin.git');
        const git = (...args: string[]) => execFileSync('git', args, { cwd: base, stdio: 'pipe', timeout: 5000, windowsHide: true });
        git('init', '--bare', remote);
        git('init');
        git('remote', 'add', 'origin', remote);
        const modulePath = JSON.stringify(resolve(import.meta.dir, '../src/fleet-lease.ts'));
        const child = Bun.spawn([process.execPath, '-e',
            `import { acquireFleetLease } from ${modulePath}; console.log(acquireFleetLease(process.cwd(), 'local').holder)`],
        { cwd: base, stdout: 'pipe', stderr: 'pipe', timeout: 15_000, windowsHide: true });
        const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        expect(exit).toBe(0);
        const oldHolder = output.trim();
        const replacement = acquireFleetLease(base, 'local');
        expect(replacement.holder).toBe(oldHolder);
        expect(fleetLeaseAllowsWorker(base, oldHolder)).toBe(true);
    } finally {
        if (dirname(base) === tmpdir()) rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    }
}, 30_000);

test.skipIf(process.platform !== 'win32')('a fresh Git deadline works in a long-running process', async () => {
    const args = ['hash-object', '--stdin'];
    const input = 'lease payload';
    const expected = fleetGitWindow(process.cwd())(args, input);
    await Bun.sleep(12_500);
    expect(fleetGitWindow(process.cwd())(args, input)).toBe(expected);
}, 25_000);
