import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireFleetSwarmClaim, acquireFleetTradeClaim, readFleetAccountClaim, readFleetTradeClaim, readHeldFleetTradeClaims, releaseFleetTradeClaim } from '../src/fleet-trade-claim';
import { beginSessionAttempt, lifecycleOwner } from '../src/session-lifecycle';
import { acquireFleetLease } from '../src/fleet-lease';
import { ORPHAN_CLAIM_MS } from '../src/fleet-trade-claim';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', timeout: 5000, windowsHide: true });
const server = 'rs-sdk-demo.fly.dev';
const input = { account: 'Trader', server, side: 'local', orderId: 'order-one', role: 'from' as const };

async function withRepos(run: (a: string, b: string) => void | Promise<void>) {
    const base = mkdtempSync(join(tmpdir(), 'fleet-trade-claim-'));
    try {
        const remote = join(base, 'origin.git'), a = join(base, 'a'), b = join(base, 'b');
        git(base, 'init', '--bare', remote);
        for (const dir of [a, b]) {
            mkdirSync(dir);
            git(dir, 'init');
            git(dir, 'remote', 'add', 'origin', remote);
        }
        await run(a, b);
    } finally {
        if (dirname(base) === tmpdir()) rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    }
}

test('two trade-only checkouts cannot claim the same account concurrently', async () => {
    await withRepos(async (a, b) => {
        const modulePath = JSON.stringify(resolve(import.meta.dir, '../src/fleet-trade-claim.ts'));
        const start = (root: string, trade: typeof input) => Bun.spawn([process.execPath, '-e',
            `import { acquireFleetTradeClaim } from ${modulePath}; acquireFleetTradeClaim(process.cwd(), ${JSON.stringify(trade)}).armNetwork()`],
        { cwd: root, stdout: 'ignore', stderr: 'pipe', timeout: 15_000, windowsHide: true });
        const one = start(a, input);
        const two = start(b, { ...input, account: 'TRADER', orderId: 'order-two' });
        const results = await Promise.all([one.exited, two.exited]);
        expect(results.filter(code => code === 0)).toHaveLength(1);
        const claim = readFleetTradeClaim(a, input)!;
        expect(claim.phase).toBe('held');
        expect(['order-one', 'order-two']).toContain(claim.orderId);
        // The winning process exited without proving settlement. The shared hold remains.
        expect(() => acquireFleetTradeClaim(b, { ...input, orderId: 'next' }, () => Date.now() + 86_400_000)).toThrow('held');
        expect(() => releaseFleetTradeClaim(b, { ...input, nonce: '11111111-1111-4111-8111-111111111111' })).toThrow('changed');
        releaseFleetTradeClaim(b, { ...input, nonce: claim.nonce });
        expect(readFleetTradeClaim(a, input)?.phase).toBe('released');
    });
}, 30_000);

test('a released trade role cannot replay after another order claims and releases the account', async () => {
    await withRepos((a, b) => {
        const first = acquireFleetTradeClaim(a, input);
        first.release();
        first.release();
        const second = acquireFleetTradeClaim(b, { ...input, orderId: 'order-two' });
        const another = acquireFleetTradeClaim(b, { ...input, account: 'Receiver', orderId: 'order-two', role: 'to' });
        expect(readHeldFleetTradeClaims(a, ['Trader', 'Receiver', 'NotFound']).map(c => c.nonce).sort()).toEqual([second.nonce, another.nonce].sort());
        second.release();
        expect(readHeldFleetTradeClaims(a).map(c => c.account)).toEqual(['receiver']);
        expect(() => acquireFleetTradeClaim(a, input)).toThrow('already claimed');
        expect(readFleetTradeClaim(b, input)?.orderId).toBe('order-two');
    });
}, 30_000);

test('an unknown Git authority cannot grant trade admission', async () => {
    await withRepos((a) => {
        git(a, 'remote', 'remove', 'origin');
        expect(() => acquireFleetTradeClaim(a, input)).toThrow('authority');
    });
}, 30_000);

test('a trade and a swarm racing on the same account have exactly one winner', async () => {
    await withRepos(async (a, b) => {
        const modulePath = JSON.stringify(resolve(import.meta.dir, '../src/fleet-trade-claim.ts'));
        const start = (root: string, functionName: string) => Bun.spawn([process.execPath, '-e',
            `import { ${functionName} } from ${modulePath}; ${functionName}(process.cwd(), ${JSON.stringify(input)}).armNetwork()`],
        { cwd: root, stdout: 'ignore', stderr: 'pipe', timeout: 15_000, windowsHide: true });
        const results = await Promise.all([start(a, 'acquireFleetTradeClaim').exited, start(b, 'acquireFleetSwarmClaim').exited]);
        expect(results.filter(code => code === 0)).toHaveLength(1);
        const held = readFleetAccountClaim(a, input);
        expect(held?.phase).toBe('held');
        expect(() => acquireFleetTradeClaim(b, { ...input, orderId: 'next' })).toThrow('held');
        expect(() => acquireFleetSwarmClaim(b, input)).toThrow('held');
    });
}, 30_000);

test('a dead swarm producer remains held, and pre-network recovery refusal restores the prior hold', async () => {
    await withRepos(async (a, b) => {
        const claimModule = JSON.stringify(resolve(import.meta.dir, '../src/fleet-trade-claim.ts'));
        const producerModule = JSON.stringify(resolve(import.meta.dir, '../src/session-lifecycle.ts'));
        const child = Bun.spawn([process.execPath, '-e', `
            import { join } from 'node:path';
            import { acquireFleetSwarmClaim } from ${claimModule};
            import { beginSessionAttempt, lifecycleOwner } from ${producerModule};
            const root = process.cwd(), input = ${JSON.stringify(input)};
            const claim = acquireFleetSwarmClaim(root, input);
            beginSessionAttempt(input, { root: join(root, '.practice/session-lifecycle'), owner: { ...lifecycleOwner(), sharedClaimNonce: claim.nonce } });
        `], { cwd: a, stdout: 'ignore', stderr: 'pipe', timeout: 15_000, windowsHide: true });
        expect(await child.exited).toBe(0);
        const prior = readFleetAccountClaim(a, input);
        expect(prior).toMatchObject({ kind: 'swarm', phase: 'held' });
        expect(() => acquireFleetSwarmClaim(a, input)).toThrow('held');
        // An owner that still runs keeps the claim from a recovery. The question carries the claim's time, which tells
        // the owner from a later process with the same id.
        const asked: number[][] = [];
        expect(() => acquireFleetSwarmClaim(a, input, { recover: true, ownerAlive: (pid, at) => { asked.push([pid, at]); return true; } })).toThrow('held');
        expect(asked).toEqual([[prior!.pid!, prior!.at]]);
        expect(() => acquireFleetSwarmClaim(b, input, { recover: true })).toThrow('held');
        const interrupted = Bun.spawn([process.execPath, '-e',
            `import { acquireFleetSwarmClaim } from ${claimModule}; acquireFleetSwarmClaim(process.cwd(), ${JSON.stringify(input)}, {recover: true})`],
        { cwd: a, stdout: 'ignore', stderr: 'pipe', timeout: 15_000, windowsHide: true });
        expect(await interrupted.exited).toBe(0);
        expect(() => acquireFleetTradeClaim(a, input)).toThrow('held');
        const replacement = acquireFleetSwarmClaim(a, input, { recover: true });
        expect(replacement.nonce).not.toBe(prior?.nonce);
        replacement.abortBeforeNetwork();
        expect(readFleetAccountClaim(b, input)).toEqual(prior);
        expect(() => acquireFleetTradeClaim(b, input)).toThrow('held');
    });
}, 30_000);

test('the owning checkout can recover a dead claim that never reached session intent', async () => {
    await withRepos(async (a, b) => {
        const modulePath = JSON.stringify(resolve(import.meta.dir, '../src/fleet-trade-claim.ts'));
        const child = Bun.spawn([process.execPath, '-e',
            `import { acquireFleetSwarmClaim } from ${modulePath}; acquireFleetSwarmClaim(process.cwd(), ${JSON.stringify(input)})`],
        { cwd: a, stdout: 'ignore', stderr: 'pipe', timeout: 15_000, windowsHide: true });
        expect(await child.exited).toBe(0);
        expect(() => acquireFleetTradeClaim(b, input)).toThrow('held');
        const claim = acquireFleetTradeClaim(a, input);
        expect(readFleetAccountClaim(b, input)?.nonce).toBe(claim.nonce);
        claim.release();
    });
}, 30_000);

test('a dead claim with no pending marker stays held even if the session receipt is missing', async () => {
    await withRepos(async (a) => {
        const modulePath = JSON.stringify(resolve(import.meta.dir, '../src/fleet-trade-claim.ts'));
        const child = Bun.spawn([process.execPath, '-e',
            `import { acquireFleetSwarmClaim } from ${modulePath}; acquireFleetSwarmClaim(process.cwd(), ${JSON.stringify(input)}).armNetwork()`],
        { cwd: a, stdout: 'ignore', stderr: 'pipe', timeout: 15_000, windowsHide: true });
        expect(await child.exited).toBe(0);
        expect(() => acquireFleetTradeClaim(a, input)).toThrow('held');
        expect(() => acquireFleetSwarmClaim(a, input, {recover: true})).toThrow('held');
    });
}, 30_000);

test('a dead pre-login trade claim can be replaced only on its owning checkout', async () => {
    await withRepos(async (a, b) => {
        const modulePath = JSON.stringify(resolve(import.meta.dir, '../src/fleet-trade-claim.ts'));
        const child = Bun.spawn([process.execPath, '-e',
            `import { acquireFleetTradeClaim } from ${modulePath}; acquireFleetTradeClaim(process.cwd(), ${JSON.stringify(input)})`],
        { cwd: a, stdout: 'ignore', stderr: 'pipe', timeout: 15_000, windowsHide: true });
        expect(await child.exited).toBe(0);
        expect(() => acquireFleetSwarmClaim(b, input)).toThrow('held');
        const replacement = acquireFleetSwarmClaim(a, input);
        expect(readFleetAccountClaim(b, input)?.nonce).toBe(replacement.nonce);
        replacement.abortBeforeNetwork();
        expect(() => acquireFleetTradeClaim(a, input)).toThrow('already claimed');
    });
}, 30_000);

test('trade admission accepts the owning checkout’s exact confirmed worker logout', async () => {
    await withRepos((a, b) => {
        const worker = acquireFleetSwarmClaim(a, input);
        const attempt = beginSessionAttempt(input, {root: join(a, '.practice/session-lifecycle'),
            owner: {...lifecycleOwner(), sharedClaimNonce: worker.nonce}});
        worker.armNetwork();
        expect(attempt.record('ended', 'logged-out')).toBe(true);
        expect(() => acquireFleetTradeClaim(b, input)).toThrow('held');
        const trade = acquireFleetTradeClaim(a, input);
        expect(readFleetTradeClaim(b, input)?.nonce).toBe(trade.nonce);
        trade.release();
    });
}, 30_000);

const T0 = 1_794_230_000_000;
const oldSide = { account: 'Dipstick', server, side: 'claude-cloud-4' }, newSide = { account: 'Dipstick', server, side: 'claude-cloud' };

test('another side replaces a dead side\'s swarm claim only once the claim and that side\'s lease are an hour stale', async () => {
    await withRepos(async (a, b) => {
        acquireFleetLease(a, 'claude-cloud-4', () => T0);
        const dead = acquireFleetSwarmClaim(a, oldSide, { now: () => T0 });
        // The container died holding the claim. Its own checkout recovers only through session recovery.
        expect(() => acquireFleetSwarmClaim(a, oldSide, { now: () => T0 + 19 * ORPHAN_CLAIM_MS })).toThrow('held');
        // The side that now owns the account: refused a millisecond early, admitted at the hour.
        expect(() => acquireFleetSwarmClaim(b, newSide, { now: () => T0 + ORPHAN_CLAIM_MS - 1 })).toThrow('held');
        const taken = acquireFleetSwarmClaim(b, newSide, { now: () => T0 + ORPHAN_CLAIM_MS });
        expect(taken.nonce).not.toBe(dead.nonce);
        expect(readFleetAccountClaim(a, newSide)).toMatchObject({ kind: 'swarm', phase: 'held', side: 'claude-cloud', nonce: taken.nonce });
        expect(git(b, 'ls-remote', 'origin', 'refs/heads/fleet-trade-claim/dipstick').toString()).toMatch(/^[0-9a-f]{40}/);
        expect(git(a, 'log', '-1', '--format=%s', git(a, 'ls-remote', 'origin', 'refs/heads/fleet-trade-claim/dipstick').toString().split(/\s/)[0]!).toString())
            .toContain(`replacing the orphaned claude-cloud-4 claim ${dead.nonce}`);
    });
}, 30_000);

test('a new checkout of the same side replaces a dead checkout\'s claim once the claim and that checkout\'s renewals are an hour stale', async () => {
    await withRepos(async (a, b) => {
        const side = { account: 'Fatstack', server, side: 'claude-cloud' };
        const dead = acquireFleetSwarmClaim(a, side, { now: () => T0 });
        // The dead container renewed the side's lease 50 minutes after it took the claim.
        acquireFleetLease(a, 'claude-cloud', () => T0 + 50 * 60_000);
        expect(() => acquireFleetSwarmClaim(b, side, { now: () => T0 + ORPHAN_CLAIM_MS - 1 })).toThrow('held');
        // The claim is an hour old, but its checkout renewed ten minutes ago: still alive.
        expect(() => acquireFleetSwarmClaim(b, side, { now: () => T0 + ORPHAN_CLAIM_MS })).toThrow('held');
        const taken = acquireFleetSwarmClaim(b, side, { now: () => T0 + 50 * 60_000 + ORPHAN_CLAIM_MS });
        expect(taken.nonce).not.toBe(dead.nonce);
        expect(readFleetAccountClaim(a, side)).toMatchObject({ kind: 'swarm', phase: 'held', side: 'claude-cloud', nonce: taken.nonce });
        expect(git(a, 'log', '-1', '--format=%s', git(a, 'ls-remote', 'origin', 'refs/heads/fleet-trade-claim/fatstack').toString().split(/\s/)[0]!).toString())
            .toContain(`replacing the orphaned claude-cloud claim ${dead.nonce}`);
    });
}, 30_000);

test('a same-side claim whose checkout never held the lease is orphaned once another checkout holds it; no lease ref gives no takeover', async () => {
    await withRepos(async (a, b) => {
        const one = { account: 'Dipstick', server, side: 'claude-cloud' };
        acquireFleetSwarmClaim(a, one, { now: () => T0 });
        acquireFleetLease(b, 'claude-cloud', () => T0 + 60_000);
        expect(() => acquireFleetSwarmClaim(b, one, { now: () => T0 + ORPHAN_CLAIM_MS - 1 })).toThrow('held');
        expect(acquireFleetSwarmClaim(b, one, { now: () => T0 + ORPHAN_CLAIM_MS }).nonce).toBeTruthy();
        const two = { account: 'Kiltlifter', server, side: 'claude-cloud-2' };
        acquireFleetSwarmClaim(a, two, { now: () => T0 });
        expect(() => acquireFleetSwarmClaim(b, two, { now: () => T0 + 19 * ORPHAN_CLAIM_MS })).toThrow('held');
    });
}, 30_000);

test('a side that still renews its lease keeps its held claims, and a side with no lease record gives no takeover', async () => {
    await withRepos(async (a, b) => {
        acquireFleetSwarmClaim(a, oldSide, { now: () => T0 });
        // Its controller recorded the lease five minutes before the other side asks: the side is alive.
        acquireFleetLease(a, 'claude-cloud-4', () => T0 + 19 * ORPHAN_CLAIM_MS - 5 * 60_000);
        expect(() => acquireFleetSwarmClaim(b, newSide, { now: () => T0 + 19 * ORPHAN_CLAIM_MS })).toThrow('held');
        const unknown = { account: 'Kiltlifter', server, side: 'claude-cloud-3' };
        acquireFleetSwarmClaim(a, unknown, { now: () => T0 });
        expect(() => acquireFleetSwarmClaim(b, { ...unknown, side: 'claude-cloud' }, { now: () => T0 + 19 * ORPHAN_CLAIM_MS })).toThrow('held');
    });
}, 30_000);

test('the older fleet-data heartbeat counts as the dead side\'s lease, and a held trade claim is never taken over', async () => {
    await withRepos(async (a, b) => {
        mkdirSync(join(a, 'fleet', 'leases'), { recursive: true });
        await Bun.write(join(a, 'fleet', 'leases', 'claude-cloud-3.json'), JSON.stringify({ side: 'claude-cloud-3', host: 'vm', pid: 17115, at: T0 }));
        git(a, 'add', 'fleet/leases/claude-cloud-3.json');
        git(a, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'lease');
        git(a, 'push', '-q', 'origin', 'HEAD:refs/heads/fleet-data');
        const old = { account: 'Kiltlifter', server, side: 'claude-cloud-3' };
        acquireFleetSwarmClaim(a, old, { now: () => T0 });
        expect(() => acquireFleetSwarmClaim(b, { ...old, side: 'claude-cloud' }, { now: () => T0 + ORPHAN_CLAIM_MS - 1 })).toThrow('held');
        expect(acquireFleetSwarmClaim(b, { ...old, side: 'claude-cloud' }, { now: () => T0 + ORPHAN_CLAIM_MS }).nonce).toBeTruthy();
        acquireFleetTradeClaim(a, { ...input, account: 'Trader2' }, () => T0);
        expect(() => acquireFleetSwarmClaim(b, { account: 'Trader2', server, side: 'claude-cloud' }, { now: () => T0 + 19 * ORPHAN_CLAIM_MS })).toThrow('fleet trade claim held');
    });
}, 30_000);
