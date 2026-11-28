import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireFleetLease, fleetGitRetryable, fleetPushRetryable, fleetGitWindow, fleetGitWindowAsync, fleetLeaseAllowsWorker, gitErrorDetail, writeFence, FLEET_LEASE_RENEW_MS, FLEET_LEASE_TTL_MS } from '../src/fleet-lease';

const git = (cwd: string, ...args: string[]) => fleetGitWindow(cwd, 'fleet lease fixture', 5000)(args);

test('a network fault is tried again inside the budget; a rejected push fails at once with Git\'s text', () => {
    const fail = (stderr: string) => Object.assign(Error('Command failed'), { stderr });
    let calls = 0;
    const flaky = fleetGitWindow('.', 'fleet swarm claim authority', 5000, () => { if (++calls === 1) throw fail('fatal: unable to access \'https://github.com/x/y.git/\': Could not resolve host: github.com'); return 'ok\n'; });
    expect(flaky(['ls-remote'])).toBe('ok');
    expect(calls).toBe(2);
    let pushes = 0;
    const rejected = fleetGitWindow('.', 'fleet swarm claim authority', 5000, () => { pushes++; throw fail(' ! [rejected]        HEAD -> fleet-trade-claim/a (fetch first)\nerror: failed to push some refs'); });
    expect(() => rejected(['push'])).toThrow('fleet swarm claim authority unavailable or changed: ! [rejected] HEAD -> fleet-trade-claim/a (fetch first) error: failed to push some refs');
    expect(pushes).toBe(1);
    // A network fault that lasts ends after the retries with its text.
    let down = 0;
    const offline = fleetGitWindow('.', 'fleet swarm claim authority', 5000, () => { down++; throw fail('fatal: unable to access: Failed to connect to github.com port 443'); });
    expect(() => offline(['ls-remote'])).toThrow(/unavailable or changed: fatal: unable to access: Failed to connect/);
    expect(down).toBe(3);
    expect(gitErrorDetail('fatal: unable to access \'https://user:token123@github.com/x.git\'')).toBe('fatal: unable to access \'https://github.com/x.git\'');
});

test('a long push failure retains its transport prefix for the existing bounded retry', () => {
    const tail=" ! [remote failure] HEAD -> fleet-trade-claim/a (failed)\nerror: failed to push some refs to 'https://github.com/x/y.git'";
    const stderr='error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503\n'+'remote progress '.repeat(40)+'\n'+tail;
    let calls=0;
    const flaky=fleetGitWindow('.', 'fleet swarm claim authority',5000,()=>{if(++calls===1)throw Object.assign(Error('push failed'),{stderr});return'landed';});
    expect(flaky(['push'])).toBe('landed');expect(calls).toBe(2);
    expect(gitErrorDetail(stderr)).toContain('error: RPC failed; HTTP 503');
    expect(gitErrorDetail(stderr)).toContain('failed to push some refs');expect(gitErrorDetail(stderr).length).toBeLessThanOrEqual(320);
});

test('a long ref rejection never retries even beside a transport diagnostic', () => {
    const stderr=' ! [rejected] HEAD -> fleet-trade-claim/a (fetch first)\n'+'remote progress '.repeat(40)+'\nerror: RPC failed; failed to push some refs';
    let calls=0;
    const rejected=fleetGitWindow('.', 'fleet swarm claim authority',5000,()=>{calls++;throw Object.assign(Error('push failed'),{stderr});});
    expect(()=>rejected(['push'])).toThrow('fetch first');expect(calls).toBe(1);
});

test('long Git diagnostics redact URL credentials before display and retry classification', () => {
    const stderr="fatal: authentication failed for 'https://first:TLS@github.com/x.git'\n"+'remote progress '.repeat(40)+"\nerror: failed to push some refs to 'https://last:tail-secret@github.com/x.git'";
    const detail=gitErrorDetail(stderr);
    expect(detail).toContain('fatal: authentication failed');expect(detail).toContain('https://github.com/x.git');
    expect(detail).not.toContain('first:TLS');expect(detail).not.toContain('tail-secret');expect(detail.length).toBeLessThanOrEqual(320);
    let calls=0;
    const auth=fleetGitWindow('.', 'fleet swarm claim authority',5000,()=>{calls++;throw Object.assign(Error('push failed'),{stderr});});
    expect(()=>auth(['push'])).toThrow('authentication failed');expect(calls).toBe(1);
});

test('the remote lease excludes another checkout, fences old workers, and permits expired takeover', () => {
    const base = mkdtempSync(join(tmpdir(), 'fleet-lease-'));
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
        git(base, 'init');
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
        git(base, 'init', '--bare', remote);
        git(base, 'init');
        git(base, 'remote', 'add', 'origin', remote);
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

for (const landed of [false, true]) test(`an uncertain initial lease push requires exact remote confirmation: landed=${landed}`, () => {
    const base = mkdtempSync(join(tmpdir(), 'fleet-lease-'));
    try {
        const remote = join(base, 'origin.git'), root = join(base, 'checkout');
        git(base, 'init', '--bare', remote);
        mkdirSync(root); git(root, 'init'); git(root, 'remote', 'add', 'origin', remote);
        let clock = Date.now(), drop = true;
        const window: typeof fleetGitWindow = (directory, authority, budget) => {
            const run = fleetGitWindow(directory, authority, budget);
            return (args, input) => {
                if (drop && args.includes('push')) {
                    drop = false;
                    if (landed) run(args, input);
                    throw Error('initial lease push reply lost');
                }
                return run(args, input);
            };
        };
        if (!landed) {
            expect(() => acquireFleetLease(root, 'local', () => clock, window)).toThrow('initial lease push reply lost');
            expect(existsSync(join(root, '.practice/fleet-controller-fence.json'))).toBe(false);
            expect(acquireFleetLease(root, 'local', () => clock).allows()).toBe(true);
        } else {
            const lease = acquireFleetLease(root, 'local', () => clock, window);
            const ref = 'refs/heads/fleet-lease/local', first = git(remote, 'rev-parse', ref);
            expect(lease.allows()).toBe(true);
            expect(fleetLeaseAllowsWorker(root, lease.holder, clock)).toBe(true);
            clock += FLEET_LEASE_RENEW_MS;
            lease.renew();
            expect(git(remote, 'rev-parse', ref + '^')).toBe(first);
        }
    } finally {
        if (dirname(base) === tmpdir()) rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    }
}, 30_000);

test('a record that lands after the ref was checked is taken up at the next renewal, not read as a takeover', () => {
    const base = mkdtempSync(join(tmpdir(), 'fleet-lease-'));
    try {
        const remote = join(base, 'origin.git'), a = join(base, 'a');
        git(base, 'init', '--bare', remote);
        mkdirSync(a); git(a, 'init'); git(a, 'remote', 'add', 'origin', remote);
        let clock = Date.now(), hold: string | undefined, holding = false;
        // The push is held back: the caller hears a failure and the ref check still reads the old head.
        const window: typeof fleetGitWindow = (root, authority, budget) => {
            const run = fleetGitWindow(root, authority, budget);
            return (args, input) => {
                if (holding && args.includes('push')) { hold = args.at(-1)!; holding = false; throw Error('fleet controller lease authority unavailable or changed'); }
                return run(args, input);
            };
        };
        const lease = acquireFleetLease(a, 'local', () => clock, window);
        const ref = 'refs/heads/fleet-lease/local', first = git(remote, 'rev-parse', ref);
        clock += FLEET_LEASE_RENEW_MS; holding = true;
        expect(() => lease.renew()).toThrow('did not land');
        expect(git(remote, 'rev-parse', ref)).toBe(first);
        // The remote applies the held push now.
        git(a, 'push', '--quiet', 'origin', hold!);
        const late = git(remote, 'rev-parse', ref);
        expect(late).not.toBe(first);
        // The retry is a sibling of that record and is rejected; the controller sees its own record on the ref.
        clock += 20_000;
        expect(() => lease.renew()).toThrow('did not land');
        expect(lease.allows()).toBe(true);
        expect(fleetLeaseAllowsWorker(a, lease.holder, clock)).toBe(true);
        clock += 20_000;
        lease.renew();
        expect(git(remote, 'rev-parse', ref + '^')).toBe(late);
    } finally {
        if (dirname(base) === tmpdir()) rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    }
}, 30_000);

test('a caller may try again after a timeout or a network fault, never after a rejected push', () => {
    for (const text of ['fleet swarm claim authority unavailable or changed: spawnSync git ETIMEDOUT', 'fleet swarm claim authority timed out',
        'fleet swarm claim authority unavailable or changed: fatal: unable to access: Could not resolve host: github.com'])
        expect(fleetGitRetryable(Error(text)), text).toBe(true);
    for (const text of ['fleet swarm claim authority unavailable or changed: ! [rejected] abc -> refs/heads/fleet-trade-claim/x (fetch first)',
        'fleet swarm claim authority unavailable or changed: error: failed to push some refs (non-fast-forward) after Connection timed out',
        'fleet account claim held by swarm', 'fleet swarm claim authority unavailable or changed: fatal: Authentication failed'])
        expect(fleetGitRetryable(Error(text)), text).toBe(false);
});

test('the same commit is pushed again after a remote that was busy, never after a final rejection', () => {
    // Live, Sausagefest: the push after a timed-out push of the same account.
    const busy = 'fleet swarm claim authority unavailable or changed: To https://github.com/Giftedx/rs-sdk-bot.git ! [remote rejected] ea11789128b8337ca211d92c0c94a1c4b8682222 -> fleet-trade-claim/sausagefest (failed)';
    expect(fleetGitRetryable(Error(busy))).toBe(false);
    expect(fleetPushRetryable(Error(busy))).toBe(true);
    // Live, YewGotWood: GitHub answered one claim push with a server error and the run ended stopped.
    for (const reason of ['failed to lock', 'failed to update ref', 'missing necessary objects', 'Internal Server Error']) {
        const msg = `x unavailable or changed: ! [remote rejected] abc -> fleet-trade-claim/x (${reason})`;
        expect(fleetGitRetryable(Error(msg)), reason).toBe(false);
        expect(fleetPushRetryable(Error(msg)), reason).toBe(true);
    }
    expect(fleetPushRetryable(Error('fleet swarm claim authority unavailable or changed: spawnSync git ETIMEDOUT'))).toBe(true);
    for (const text of ['x unavailable or changed: ! [rejected] abc -> fleet-trade-claim/x (fetch first)', 'x unavailable or changed: ! [rejected] abc -> fleet-trade-claim/x (non-fast-forward)',
        'x unavailable or changed: ! [remote rejected] abc -> fleet-trade-claim/x (pre-receive hook declined)', 'x unavailable or changed: ! [remote rejected] abc -> x (protected branch hook declined)',
        'fleet account claim held by swarm'])
        expect(fleetPushRetryable(Error(text)), text).toBe(false);
});

test('writeFence retries transient EPERM/EBUSY renames and removes temp files on permanent error', () => {
    const base = mkdtempSync(join(tmpdir(), 'fleet-fence-'));
    try {
        let attempts = 0;
        writeFence(base, 'local:00000000-0000-4000-8000-000000000001', 123456, (from, to) => {
            attempts++;
            if (attempts <= 2) throw Object.assign(Error('locked'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
            renameSync(from, to);
        });
        expect(attempts).toBe(3);
        const fence = JSON.parse(readFileSync(join(base, '.practice', 'fleet-controller-fence.json'), 'utf8'));
        expect(fence).toEqual({ holder: 'local:00000000-0000-4000-8000-000000000001', until: 123456 });
        expect(readdirSync(join(base, '.practice')).filter(f => f.endsWith('.tmp'))).toEqual([]);

        expect(() => writeFence(base, 'local:00000000-0000-4000-8000-000000000001', 999, () => {
            throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
        })).toThrow('disk full');
        expect(readdirSync(join(base, '.practice')).filter(f => f.endsWith('.tmp'))).toEqual([]);
    } finally {
        if (dirname(base) === tmpdir()) rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    }
});

test('fleetGitWindowAsync preserves retry, ref-rejection, and credential redaction without blocking the event loop', async () => {
    const fail = (stderr: string) => Object.assign(Error('Command failed'), { stderr });
    let ticks = 0;
    const interval = setInterval(() => { ticks++; }, 25);
    try {
        let calls = 0;
        const flaky = fleetGitWindowAsync('.', 'fleet swarm claim authority', 5000, async () => {
            await Bun.sleep(60);
            if (++calls === 1) throw fail("fatal: unable to access 'https://user:secret@github.com/x/y.git/': Could not resolve host: github.com");
            return 'ok\n';
        });
        expect(await flaky(['ls-remote'])).toBe('ok');
        expect(calls).toBe(2);
        // The 25 ms timer fires repeatedly across the 60 ms async run + 300 ms async retry pause.
        expect(ticks).toBeGreaterThanOrEqual(8);
    } finally {
        clearInterval(interval);
    }

    let pushes = 0;
    const rejected = fleetGitWindowAsync('.', 'fleet swarm claim authority', 5000, async () => {
        pushes++;
        throw fail(" ! [rejected] HEAD -> fleet-trade-claim/a (fetch first)\nerror: failed to push to 'https://tok:pw@github.com/x/y.git'");
    });
    const err = await rejected(['push']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) throw Error('expected Error');
    expect(err.message).toContain('fetch first');
    expect(err.message).not.toContain('tok:pw');
    expect(pushes).toBe(1);
}, 15_000);

test('fleetGitWindowAsync executes real git commands concurrently while keeping a 25 ms timer responsive and kills timed-out git', async () => {
    let ticks = 0;
    let maxGapMs = 0;
    let last = performance.now();
    const interval = setInterval(() => {
        const now = performance.now();
        maxGapMs = Math.max(maxGapMs, now - last);
        last = now;
        ticks++;
    }, 25);
    try {
        const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
            fleetGitWindowAsync(process.cwd(), 'async-git-test', 10_000)(['hash-object', '--stdin'], `payload-${i}`)));
        expect(results).toHaveLength(6);
        for (const sha of results) expect(sha).toMatch(/^[0-9a-f]{40}$/);
        expect(maxGapMs).toBeLessThan(1000);
    } finally {
        clearInterval(interval);
    }

    // Timeout enforcement on a real git subprocess with nested shell+bun descendants:
    // must abort near budgetMs and leave zero surviving descendants while this process stays alive.
    const tag = `fleet-git-timeout-${randomUUID()}`;
    const t0 = performance.now();
    const slow = fleetGitWindowAsync(process.cwd(), 'timeout-test', 1200);
    await expect(slow(['-c', `alias.hang=!bun -e "await Bun.sleep(20000)" -- ${tag}`, 'hang'])).rejects.toThrow(/ETIMEDOUT|timed out|unavailable or changed/);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(6000);
    expect(ticks).toBeGreaterThanOrEqual(1);

    if (process.platform === 'win32') {
        const probe = Bun.spawn(
            ['powershell', '-NoProfile', '-Command', `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${tag}*' -and $_.ProcessId -ne $PID }).Count`],
            { stdout: 'pipe', stderr: 'pipe', windowsHide: true },
        );
        const [code, stdout] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
        expect(code).toBe(0);
        expect(Number(stdout.trim())).toBe(0);
    } else {
        const probe = Bun.spawn(['ps', '-ax', '-o', 'args='], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
        const [code, stdout] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
        expect(code).toBe(0);
        expect(stdout).not.toContain(tag);
    }
}, 25_000);
