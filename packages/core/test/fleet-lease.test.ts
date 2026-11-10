import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
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

test('a renewal that does not land leaves the lease standing until its deadline, and the next one lands', () => {
    const base = mkdtempSync(join(tmpdir(), 'fleet-lease-'));
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', timeout: 5000, windowsHide: true }).toString().trim();
    try {
        const remote = join(base, 'origin.git'), off = join(base, 'origin.off'), a = join(base, 'a');
        git(base, 'init', '--bare', remote);
        mkdirSync(a); git(a, 'init'); git(a, 'remote', 'add', 'origin', remote);
        let clock = Date.now();
        const lease = acquireFleetLease(a, 'local', () => clock);
        const head = () => git(remote, 'rev-parse', 'refs/heads/fleet-lease/local');
        const first = head();

        // The remote cannot be reached: nothing landed and nobody else can hold the lease yet.
        clock += FLEET_LEASE_RENEW_MS;
        renameSync(remote, off);
        expect(() => lease.renew()).toThrow('did not land');
        expect(lease.allows()).toBe(true);
        expect(fleetLeaseAllowsWorker(a, lease.holder, clock)).toBe(true);
        renameSync(off, remote);
        expect(head()).toBe(first);

        // The remote is back: the retry lands as a child of the same head.
        clock += 20_000;
        lease.renew();
        expect(head()).not.toBe(first);
        expect(git(remote, 'rev-parse', 'refs/heads/fleet-lease/local^')).toBe(first);
        expect(lease.allows()).toBe(true);

        // Past the deadline with no confirmed record the lease is gone, and the workers are fenced.
        renameSync(remote, off);
        clock += FLEET_LEASE_TTL_MS;
        expect(() => lease.renew()).toThrow('expired');
        expect(lease.allows()).toBe(false);
        expect(fleetLeaseAllowsWorker(a, lease.holder, clock)).toBe(false);
    } finally {
        if (dirname(base) === tmpdir()) rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    }
}, 30_000);

test('a renewal whose push landed but whose answer was lost is taken as landed', () => {
    const base = mkdtempSync(join(tmpdir(), 'fleet-lease-'));
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', timeout: 5000, windowsHide: true }).toString().trim();
    try {
        const remote = join(base, 'origin.git'), a = join(base, 'a');
        git(base, 'init', '--bare', remote);
        mkdirSync(a); git(a, 'init'); git(a, 'remote', 'add', 'origin', remote);
        let clock = Date.now(), drop = false;
        // The push runs, then its caller hears a failure, as when the answer times out.
        const window: typeof fleetGitWindow = (root, authority, budget) => {
            const run = fleetGitWindow(root, authority, budget);
            return (args, input) => { const out = run(args, input); if (drop && args.includes('push')) { drop = false; throw Error('fleet controller lease authority unavailable or changed'); } return out; };
        };
        const lease = acquireFleetLease(a, 'local', () => clock, window);
        const head = () => git(remote, 'rev-parse', 'refs/heads/fleet-lease/local');
        const first = head();
        clock += FLEET_LEASE_RENEW_MS; drop = true;
        lease.renew();
        const second = head();
        expect(second).not.toBe(first);
        expect(lease.allows()).toBe(true);
        expect(fleetLeaseAllowsWorker(a, lease.holder, clock)).toBe(true);
        // The controller holds the new head: its next record is a child of it, not a rejected sibling.
        clock += FLEET_LEASE_RENEW_MS;
        lease.renew();
        expect(git(remote, 'rev-parse', 'refs/heads/fleet-lease/local^')).toBe(second);
    } finally {
        if (dirname(base) === tmpdir()) rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    }
}, 30_000);
