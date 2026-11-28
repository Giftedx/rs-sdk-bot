import { expect, test as bunTest, spyOn, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { acquireFleetSwarmClaim, acquireFleetTradeClaim, readAllFleetAccountClaims, readFleetAccountClaim, readFleetTradeClaim, readHeldFleetTradeClaims, releaseFleetTradeClaim } from '../src/fleet-trade-claim';
import { beginSessionAttempt, lifecycleOwner } from '../src/session-lifecycle';
import { savedProcessAlive } from '../src/session-takeover';
import { acquireFleetLease, fleetGitWindow } from '../src/fleet-lease';
import { ORPHAN_CLAIM_MS } from '../src/fleet-trade-claim';
import * as claimApi from '../src/fleet-trade-claim';

const isWorker = process.env.FLEET_CLAIM_WORKER === '1';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', timeout: 5000, windowsHide: true });
const server = 'rs-sdk-demo.fly.dev';
const input = { account: 'Trader', server, side: 'local', orderId: 'order-one', role: 'from' as const };

type RepoTemplate = { dir: string; remoteUrl: string; cfgA: string; cfgB: string };
let repoTemplate: RepoTemplate | undefined = isWorker && process.env.FLEET_CLAIM_TEMPLATE ? JSON.parse(process.env.FLEET_CLAIM_TEMPLATE) : undefined;

function createRepoTemplate(): RepoTemplate {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-trade-claim-tpl-'));
    const remote = join(dir, 'origin.git'), remoteUrl = remote.replaceAll('\\', '/');
    const a = join(dir, 'a'), b = join(dir, 'b');
    git(dir, 'init', '--bare', remote);
    // Each push to the bare remote would start `git gc --auto` after it, and each commit in a checkout would check
    // for automatic maintenance: one more Git process each, and a process start costs most on Windows.
    git(remote, 'config', 'receive.autogc', 'false');
    git(remote, 'config', 'gc.auto', '0');
    for (const d of [a, b]) {
        mkdirSync(d);
        git(d, 'init');
        git(d, 'remote', 'add', 'origin', remoteUrl);
        git(d, 'config', 'gc.auto', '0');
        git(d, 'config', 'maintenance.auto', 'false');
    }
    return {
        dir,
        remoteUrl,
        cfgA: readFileSync(join(a, '.git', 'config'), 'utf8'),
        cfgB: readFileSync(join(b, '.git', 'config'), 'utf8'),
    };
}

async function withRepos(run: (a: string, b: string) => void | Promise<void>) {
    const tpl = (repoTemplate ??= createRepoTemplate());
    const base = mkdtempSync(join(tmpdir(), 'fleet-trade-claim-'));
    try {
        cpSync(tpl.dir, base, { recursive: true });
        const remoteUrl = join(base, 'origin.git').replaceAll('\\', '/');
        const a = join(base, 'a'), b = join(base, 'b');
        writeFileSync(join(a, '.git', 'config'), tpl.cfgA.replaceAll(tpl.remoteUrl, remoteUrl));
        writeFileSync(join(b, '.git', 'config'), tpl.cfgB.replaceAll(tpl.remoteUrl, remoteUrl));
        await run(a, b);
    } finally {
        if (dirname(base) === tmpdir()) rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    }
}

// A case name that makes a worker exit with code 3 (the pool test below).
const CRASH_CASE = '__crash_worker__';
const CONCURRENT_CASES: Array<{ name: string; fn: () => void | Promise<void>; timeout: number }> = [];
const test = (name: string, fn: () => void | Promise<void>, timeout = 30_000) => {
    CONCURRENT_CASES.push({ name, fn, timeout });
};

test('atomic trade claim release frees both exact nonces and rejects replacement claims', async () => {
    await withRepos((a) => {
        const giver = acquireFleetTradeClaim(a, input), taker = acquireFleetTradeClaim(a, { ...input, account: 'Receiver', role: 'to' });
        expect(claimApi.releaseFleetTradeClaims(a, [giver, taker])).toBe(2);
        expect([giver, taker].map(target => readFleetTradeClaim(a, target)?.phase)).toEqual(['released', 'released']);
        expect(claimApi.releaseFleetTradeClaims(a, [giver, taker])).toBe(0);
        const next = acquireFleetTradeClaim(a, { ...input, account: 'Receiver', role: 'to', orderId: 'next-order' });
        expect(() => claimApi.releaseFleetTradeClaims(a, [giver, taker])).toThrow('changed');
        expect(readFleetTradeClaim(a, next)?.nonce).toBe(next.nonce);
        expect(readFleetTradeClaim(a, next)?.phase).toBe('held');
    });
}, 30_000);

test('atomic trade claim release rejects the whole push if one account receives a concurrent new claim', async () => {
    await withRepos((a, b) => {
        const giver = acquireFleetTradeClaim(a, input), taker = acquireFleetTradeClaim(a, { ...input, account: 'Receiver', role: 'to' });
        const original = childProcess.execFileSync; let raced = false, replacement: ReturnType<typeof acquireFleetTradeClaim> | undefined;
        const run = spyOn(childProcess, 'execFileSync').mockImplementation(((file: string, args: string[], options: any) => {
            if (!raced && args.includes('--atomic')) {
                raced = true;
                releaseFleetTradeClaim(b, taker);
                replacement = acquireFleetTradeClaim(b, { ...input, account: 'Receiver', role: 'to', orderId: 'next-order' });
            }
            return original(file, args, options);
        }) as any);
        try { expect(() => claimApi.releaseFleetTradeClaims(a, [giver, taker])).toThrow(); }
        finally { run.mockRestore(); }
        expect(raced).toBe(true);
        expect(readFleetTradeClaim(a, giver)?.phase).toBe('held');
        expect(readFleetTradeClaim(a, giver)?.nonce).toBe(giver.nonce);
        expect(readFleetTradeClaim(a, taker)?.nonce).toBe(replacement!.nonce);
        expect(readFleetTradeClaim(a, taker)?.phase).toBe('held');
    });
}, 30_000);

test('atomic trade claim release reads back both released claims after a lost response without replaying a release', async () => {
    await withRepos((a) => {
        const giver = acquireFleetTradeClaim(a, input), taker = acquireFleetTradeClaim(a, { ...input, account: 'Receiver', role: 'to' });
        const original = childProcess.execFileSync; let pushed = false;
        const run = spyOn(childProcess, 'execFileSync').mockImplementation(((file: string, args: string[], options: any) => {
            const result = original(file, args, options);
            if (args.includes('--atomic')) { pushed = true; throw Error('response lost after atomic push'); }
            return result;
        }) as any);
        try { expect(() => claimApi.releaseFleetTradeClaims(a, [giver, taker])).toThrow('response lost'); }
        finally { run.mockRestore(); }
        expect(pushed).toBe(true);
        expect([giver, taker].map(target => readFleetTradeClaim(a, target)?.phase)).toEqual(['released', 'released']);
        expect(claimApi.releaseFleetTradeClaims(a, [giver, taker])).toBe(0);
    });
}, 30_000);

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

test('the controller check before a trade start gives the refusal that the trade login gives', async () => {
    await withRepos(async (a, b) => {
        const swarm = acquireFleetSwarmClaim(a, { account: 'Receiver', server, side: 'local' });
        const trade = acquireFleetTradeClaim(a, input);
        const held = claimApi.readHeldFleetAccountClaims(b, ['Trader', 'Receiver']);
        expect(held.map(c => c.account).sort()).toEqual(['receiver', 'trader']);
        expect(readHeldFleetTradeClaims(b, ['Trader', 'Receiver']).map(c => c.account)).toEqual(['trader']);
        const refusal = (account: string) => claimApi.fleetTradeClaimRefusal(b, held.find(c => c.account === account)!, { account, server, side: 'local' });
        expect(refusal('receiver')).toBe('fleet account claim held by swarm');
        expect(() => acquireFleetTradeClaim(b, { ...input, account: 'Receiver', orderId: 'order-two', role: 'to' })).toThrow('fleet account claim held by swarm');
        expect(refusal('trader')).toBe('fleet trade claim held for order order-one');
        expect(claimApi.fleetTradeClaimRefusal(b, null, { account: 'Trader', server, side: 'local' })).toBeUndefined();
        trade.release();
        expect(swarm.nonce).toBeString();
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
        // Exclude prior.pid (awaited dead above) so fast Windows PID reuse inside PID_START_SLACK_MS cannot flake.
        const replacement = acquireFleetSwarmClaim(a, input, { recover: true, ownerAlive: (pid, at) => pid !== prior!.pid && savedProcessAlive(pid, at) });
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

test('an orphaned pre-network swarm claim on this checkout with a prior confirmed logout clears safely, while live, unsettled, or foreign claims stay held', async () => {
    await withRepos(async (a, b) => {
        const liveLifecycle = join(a, '.practice', 'live', 'session-lifecycle');
        const first = acquireFleetSwarmClaim(a, swarmInput);
        const priorAttempt = beginSessionAttempt(swarmInput, {
            root: liveLifecycle,
            owner: { ...lifecycleOwner(), sharedClaimNonce: first.nonce },
        });
        first.armNetwork();
        expect(priorAttempt.record('ended', 'logged-out')).toBe(true);
        first.releaseAfterLogout(priorAttempt.attemptId);

        // A later worker acquires a swarm claim, loses its pending marker before beginSessionAttempt, and dies.
        const modulePath = JSON.stringify(resolve(import.meta.dir, '../src/fleet-trade-claim.ts'));
        const child = Bun.spawn([process.execPath, '-e',
            `import { acquireFleetSwarmClaim } from ${modulePath}; acquireFleetSwarmClaim(process.cwd(), ${JSON.stringify(swarmInput)}).armNetwork()`],
        { cwd: a, stdout: 'ignore', stderr: 'pipe', timeout: 15_000, windowsHide: true });
        expect(await child.exited).toBe(0);

        const orphaned = readFleetAccountClaim(a, swarmInput)!;
        expect(orphaned).toMatchObject({ kind: 'swarm', phase: 'held' });
        const deadOwner = (pid: number, at: number) => pid !== orphaned.pid && savedProcessAlive(pid, at);

        // Live owner, another checkout, or an unsettled logout proof still refuses.
        expect(claimApi.fleetTradeClaimRefusal(a, orphaned, swarmInput, () => true)).toBe('fleet account claim held by swarm');
        expect(() => acquireFleetSwarmClaim(a, swarmInput, { ownerAlive: () => true })).toThrow('held');
        expect(claimApi.fleetTradeClaimRefusal(b, orphaned, swarmInput, deadOwner)).toBe('fleet account claim held by swarm');
        expect(() => acquireFleetSwarmClaim(b, swarmInput, { ownerAlive: deadOwner })).toThrow('held');

        // On the owning checkout with dead owner, confirmed prior logout, zero matching attempt, and missing marker:
        // trade preflight clears, swarm self-checkout replaces the orphan, and trade login succeeds.
        expect(claimApi.fleetTradeClaimRefusal(a, orphaned, swarmInput, deadOwner)).toBeUndefined();
        const taken = acquireFleetSwarmClaim(a, swarmInput, { ownerAlive: deadOwner });
        expect(taken.nonce).not.toBe(orphaned.nonce);
        expect(claimLog(a)[0]).toContain(`replacing the orphaned local claim ${orphaned.nonce}`);
        taken.abortBeforeNetwork();

        // A second dead pre-network orphan can also be taken directly by a trade login on the owning checkout.
        const child2 = Bun.spawn([process.execPath, '-e',
            `import { acquireFleetSwarmClaim } from ${modulePath}; acquireFleetSwarmClaim(process.cwd(), ${JSON.stringify(swarmInput)}).armNetwork()`],
        { cwd: a, stdout: 'ignore', stderr: 'pipe', timeout: 15_000, windowsHide: true });
        expect(await child2.exited).toBe(0);
        const trade = acquireFleetTradeClaim(a, input);
        expect(readFleetTradeClaim(b, input)?.nonce).toBe(trade.nonce);
        trade.release();

        // Unsettled latest attempt (`proof.state === 'held'`) never clears even when the orphan has zero matching attempt.
        const child3 = Bun.spawn([process.execPath, '-e',
            `import { acquireFleetSwarmClaim } from ${modulePath}; acquireFleetSwarmClaim(process.cwd(), ${JSON.stringify(swarmInput)}).armNetwork()`],
        { cwd: a, stdout: 'ignore', stderr: 'pipe', timeout: 15_000, windowsHide: true });
        expect(await child3.exited).toBe(0);
        beginSessionAttempt(swarmInput, {
            root: liveLifecycle,
            owner: { ...lifecycleOwner(), sharedClaimNonce: '00000000-0000-4000-8000-000000000001' },
        });
        const heldOrphan = readFleetAccountClaim(a, swarmInput)!;
        expect(claimApi.fleetTradeClaimRefusal(a, heldOrphan, swarmInput, () => false)).toBe('fleet account claim held by swarm');
        expect(() => acquireFleetSwarmClaim(a, swarmInput, { ownerAlive: () => false })).toThrow('held');
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

test('swarm claim release and trade handoff read confirmed logout from .practice/live/session-lifecycle', async () => {
    await withRepos((a, b) => {
        const liveLifecycle = join(a, '.practice', 'live', 'session-lifecycle');
        const worker = acquireFleetSwarmClaim(a, input);
        const attempt = beginSessionAttempt(input, {
            root: liveLifecycle,
            owner: { ...lifecycleOwner(), sharedClaimNonce: worker.nonce },
        });
        worker.armNetwork();
        expect(attempt.record('ended', 'logged-out')).toBe(true);
        worker.releaseAfterLogout(attempt.attemptId);
        expect(readFleetAccountClaim(b, input)).toMatchObject({ phase: 'released', nonce: worker.nonce });

        const worker2 = acquireFleetSwarmClaim(a, input);
        const attempt2 = beginSessionAttempt(input, {
            root: liveLifecycle,
            owner: { ...lifecycleOwner(), sharedClaimNonce: worker2.nonce },
        });
        worker2.armNetwork();
        expect(attempt2.record('ended', 'logged-out')).toBe(true);
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
        dead.armNetwork();
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

// A fleet Git window whose `git push` (or another named command) fails as a spawn timeout for its first calls. With
// `landed` the first push reaches the remote before the timeout is reported: the caller cannot know its outcome.
function slowGit(command: string, failures: number, landed = false) {
    const calls = { n: 0 };
    const window = ((root: string, authority?: string, budgetMs?: number) => fleetGitWindow(root, authority, budgetMs, (args, { input, timeout }) => {
        const real = () => execFileSync('git', args, { cwd: root, input, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout, windowsHide: true });
        if (!args.includes(command)) return real();
        if (++calls.n > failures) return real();
        if (landed && calls.n === 1) real();
        throw Object.assign(Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', stdout: '', stderr: '' });
    })) as typeof fleetGitWindow;
    return { window, calls };
}
const swarmInput = { account: 'Trader', server, side: 'local' };
const claimLog = (cwd: string) => git(cwd, 'log', '--format=%s', git(cwd, 'ls-remote', 'origin', 'refs/heads/fleet-trade-claim/trader').toString().split(/\s/)[0]!).toString().trim().split('\n');

test('a swarm login claim holds when its push times out: the same record is pushed again', async () => {
    await withRepos((a, b) => {
        // Two timed-out push calls cover the retry that one Git window makes on Windows.
        const slow = slowGit('push', 2), waits: number[] = [];
        const claim = acquireFleetSwarmClaim(a, swarmInput, { patient: true, gitWindow: slow.window, wait: ms => waits.push(ms) });
        expect(slow.calls.n).toBe(3);
        expect(waits.length).toBeGreaterThan(0);
        expect(readFleetAccountClaim(b, swarmInput)?.nonce).toBe(claim.nonce);
        git(a, 'fetch', '--quiet', 'origin', 'refs/heads/fleet-trade-claim/trader');
        expect(claimLog(a)).toEqual(['Fleet swarm attempt']);
        // The other side still finds the account held.
        expect(() => acquireFleetSwarmClaim(b, { ...swarmInput, side: 'cloud' })).toThrow('held');
    });
}, 60_000);

test('a push that reached the remote before its timeout is not a second record', async () => {
    await withRepos((a, b) => {
        const slow = slowGit('push', 2, true);
        const claim = acquireFleetSwarmClaim(a, swarmInput, { patient: true, gitWindow: slow.window, wait: () => {} });
        expect(readFleetAccountClaim(b, swarmInput)?.nonce).toBe(claim.nonce);
        git(a, 'fetch', '--quiet', 'origin', 'refs/heads/fleet-trade-claim/trader');
        expect(claimLog(a)).toEqual(['Fleet swarm attempt']);
    });
}, 60_000);

test('a slow read of the claim is read again, and a rejected push is never pushed again', async () => {
    await withRepos((a, b) => {
        const slowRead = slowGit('ls-remote', 2);
        const first = acquireFleetSwarmClaim(a, swarmInput, { patient: true, gitWindow: slowRead.window, wait: () => {} });
        expect(slowRead.calls.n).toBeGreaterThanOrEqual(3);
        first.abortBeforeNetwork();
        // Another side takes the released account between the read and the push of this side: the push is rejected.
        let pushes = 0, raced = false;
        const racing = ((root: string, authority?: string, budgetMs?: number) => fleetGitWindow(root, authority, budgetMs, (args, { input, timeout }) => {
            if (args.includes('push')) { pushes++; if (!raced) { raced = true; acquireFleetSwarmClaim(b, { ...swarmInput, side: 'cloud' }); } }
            return execFileSync('git', args, { cwd: root, input, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout, windowsHide: true });
        })) as typeof fleetGitWindow;
        expect(() => acquireFleetSwarmClaim(a, swarmInput, { patient: true, gitWindow: racing, wait: () => {} })).toThrow('unavailable or changed');
        expect(pushes).toBe(1);
        expect(readFleetAccountClaim(a, swarmInput)?.side).toBe('cloud');
    });
}, 60_000);

test('a login under the plan lock keeps one Git window: a timed-out push fails at once', async () => {
    await withRepos((a) => {
        const slow = slowGit('push', 2);
        expect(() => acquireFleetSwarmClaim(a, swarmInput, { gitWindow: slow.window, wait: () => {} })).toThrow('fleet swarm claim authority unavailable or changed: spawnSync git ETIMEDOUT');
        expect(slow.calls.n).toBeLessThanOrEqual(2);
    });
}, 60_000);

test('a claim push that the remote did not take while it was busy is pushed again as the same record', async () => {
    await withRepos((a, b) => {
        let pushes = 0;
        const busy = ((root: string, authority?: string, budgetMs?: number) => fleetGitWindow(root, authority, budgetMs, (args, { input, timeout }) => {
            if (args.includes('push') && ++pushes === 1) throw Object.assign(Error('Command failed: git push'), { status: 1, stdout: '',
                stderr: 'To https://github.com/Giftedx/rs-sdk-bot.git\n ! [remote rejected] ea11789128b8337ca211d92c0c94a1c4b8682222 -> fleet-trade-claim/trader (failed)\nerror: failed to push some refs to \'https://github.com/Giftedx/rs-sdk-bot.git\'' });
            return execFileSync('git', args, { cwd: root, input, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout, windowsHide: true });
        })) as typeof fleetGitWindow;
        const claim = acquireFleetSwarmClaim(a, swarmInput, { patient: true, gitWindow: busy, wait: () => {} });
        expect(pushes).toBe(2);
        expect(readFleetAccountClaim(b, swarmInput)?.nonce).toBe(claim.nonce);
        git(a, 'fetch', '--quiet', 'origin', 'refs/heads/fleet-trade-claim/trader');
        expect(claimLog(a)).toEqual(['Fleet swarm attempt']);
    });
}, 60_000);

test('the owning checkout takes back its own trade claim of the same order role when that claim never reached the network', async () => {
    await withRepos(async (a, b) => {
        const modulePath = JSON.stringify(resolve(import.meta.dir, '../src/fleet-trade-claim.ts'));
        const dead = (code: string) => Bun.spawn([process.execPath, '-e', `import { acquireFleetTradeClaim } from ${modulePath}; ${code}`],
            { cwd: a, stdout: 'ignore', stderr: 'pipe', timeout: 15_000, windowsHide: true }).exited;
        // A trade worker pushed its claim and ended before its session started: live, its push timed out for the client.
        expect(await dead(`acquireFleetTradeClaim(process.cwd(), ${JSON.stringify(input)})`)).toBe(0);
        const stale = readFleetAccountClaim(a, input)!;
        expect(stale.phase).toBe('held');
        // Another checkout cannot take it.
        expect(() => acquireFleetTradeClaim(b, input)).toThrow('held');
        // The next try of the same order role on the owning checkout takes it back.
        const again = acquireFleetTradeClaim(a, input);
        expect(again.nonce).not.toBe(stale.nonce);
        expect(readFleetAccountClaim(b, input)).toMatchObject({ nonce: again.nonce, phase: 'held', orderId: input.orderId, role: 'from' });
        // While that owner lives, the role is claimed: no second claim.
        expect(() => acquireFleetTradeClaim(a, input)).toThrow('held');
        again.release();
        // A released attempt is a used attempt: the order role is never claimed again.
        expect(() => acquireFleetTradeClaim(a, input)).toThrow('already claimed');
    });
}, 60_000);

test('a trade claim that reached the network is never taken back, and the claim of another order role is no excuse', async () => {
    await withRepos(async (a) => {
        const modulePath = JSON.stringify(resolve(import.meta.dir, '../src/fleet-trade-claim.ts'));
        const dead = (code: string) => Bun.spawn([process.execPath, '-e', `import { acquireFleetTradeClaim } from ${modulePath}; ${code}`],
            { cwd: a, stdout: 'ignore', stderr: 'pipe', timeout: 15_000, windowsHide: true }).exited;
        // Armed: the session intent was written and the marker is gone. The session can have traded.
        expect(await dead(`acquireFleetTradeClaim(process.cwd(), ${JSON.stringify(input)}).armNetwork()`)).toBe(0);
        expect(() => acquireFleetTradeClaim(a, input)).toThrow('held');
    });
    await withRepos(async (a) => {
        const modulePath = JSON.stringify(resolve(import.meta.dir, '../src/fleet-trade-claim.ts'));
        const dead = (code: string) => Bun.spawn([process.execPath, '-e', `import { acquireFleetTradeClaim } from ${modulePath}; ${code}`],
            { cwd: a, stdout: 'ignore', stderr: 'pipe', timeout: 15_000, windowsHide: true }).exited;
        // A used attempt of this order role, then an abandoned claim of another order at the head.
        acquireFleetTradeClaim(a, input).release();
        expect(await dead(`acquireFleetTradeClaim(process.cwd(), ${JSON.stringify({ ...input, orderId: 'order-two' })})`)).toBe(0);
        expect(() => acquireFleetTradeClaim(a, input)).toThrow('already claimed');
    });
}, 60_000);

// A git window that counts its commands by name.
function counting(root: string) {
    const base = fleetGitWindow(root), calls: Record<string, number> = {};
    const window = ((args: string[], input?: string) => { const name = args.find(a => !a.startsWith('-')) ?? args[0]!; calls[name] = (calls[name] ?? 0) + 1; return base(args, input); }) as typeof base;
    return { window, calls };
}
test('every claim is read with one batched read, and a head that this checkout holds is not fetched again', async () => {
    await withRepos(async (a, b) => {
        const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
        for (const [i, account] of names.entries()) acquireFleetTradeClaim(a, { ...input, account, orderId: 'order-' + i }, () => T0);
        // A checkout that holds none of the records fetches them once, and reads each account with one command in all.
        const first = counting(b), claims = readAllFleetAccountClaims(first.window);
        expect([...claims.keys()].sort()).toEqual(names.map(n => n.toLowerCase()).sort());
        for (const claim of claims.values()) expect(claim).toMatchObject({ phase: 'held' });
        expect(first.calls['show']).toBe(1);
        expect(first.calls['fetch']).toBe(1);
        expect(first.calls['cat-file']).toBe(1);
        // The same read again: the records are here, so nothing is fetched.
        const second = counting(b);
        expect(readAllFleetAccountClaims(second.window)).toEqual(claims);
        expect(second.calls['show']).toBe(1);
        expect(second.calls['fetch']).toBeUndefined();
        // The batched reader for the held trade claims fetches nothing either.
        expect(readHeldFleetTradeClaims(b).map(c => c.account).sort()).toEqual(names.map(n => n.toLowerCase()).sort());
        // A record that this checkout lacks is fetched, and only that one: Bravo moves on, the others stay here.
        const bravo = readFleetAccountClaim(a, { ...input, account: 'Bravo' })!;
        releaseFleetTradeClaim(a, { ...input, account: 'Bravo', nonce: bravo.nonce });
        const third = counting(b), after = readAllFleetAccountClaims(third.window);
        expect(after.get('bravo')).toMatchObject({ phase: 'released' });
        expect(third.calls['fetch']).toBe(1);
        expect(third.calls['show']).toBe(1);
    });
}, 60_000);
test('an unreadable claim record maps to null while the other accounts are still read in the one batch', async () => {
    await withRepos(async (a, b) => {
        acquireFleetTradeClaim(a, { ...input, account: 'Good', orderId: 'order-g' }, () => T0);
        // A claim ref whose record is not a claim: a commit with a body that is not JSON.
        const tree = execFileSync('git', ['hash-object', '-w', '-t', 'tree', '--stdin'], { cwd: a, input: '', encoding: 'utf8', windowsHide: true }).trim();
        // The committer is given here: a runner has no global git identity.
        const bad = git(a, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit-tree', tree, '-m', 'not a claim record\n\nplain text').toString().trim();
        git(a, 'push', 'origin', bad + ':refs/heads/fleet-trade-claim/broken');
        const read = counting(b), claims = readAllFleetAccountClaims(read.window);
        expect(claims.get('broken')).toBeNull();
        expect(claims.get('good')).toMatchObject({ phase: 'held' });
        expect(read.calls['show']).toBe(1);
    });
}, 60_000);

test('a failed batch read falls back to one read for each record, and a failed local check fetches every head', async () => {
    await withRepos(async (a, b) => {
        const names = ['Alpha', 'Bravo', 'Charlie'];
        for (const [i, account] of names.entries()) acquireFleetTradeClaim(a, { ...input, account, orderId: 'order-' + i }, () => T0);
        const expected = readAllFleetAccountClaims(fleetGitWindow(a));
        expect([...expected.values()].every(c => c?.phase === 'held')).toBe(true);
        // The batch `show` is refused: each record is read on its own, and the answer is the same.
        const calls: Record<string, number> = {}, fetched: string[][] = [];
        const refusing = ((args: string[], text?: string) => {
            const name = args.find(arg => !arg.startsWith('-')) ?? args[0]!;
            calls[name] = (calls[name] ?? 0) + 1;
            if (name === 'show' && args.some(arg => arg.includes('%H'))) throw Error('batch refused');
            return fleetGitWindow(b)(args, text);
        }) as ReturnType<typeof fleetGitWindow>;
        expect(readAllFleetAccountClaims(refusing)).toEqual(expected);
        expect(calls['show']).toBe(1 + names.length);
        // The local check fails: every head is fetched (as before this check existed), and the answer is the same.
        const noCheck = ((args: string[], text?: string) => {
            const name = args.find(arg => !arg.startsWith('-')) ?? args[0]!;
            if (name === 'cat-file') throw Error('cat-file refused');
            if (name === 'fetch') fetched.push(args.slice(args.indexOf('origin') + 1));
            return fleetGitWindow(b)(args, text);
        }) as ReturnType<typeof fleetGitWindow>;
        expect(readAllFleetAccountClaims(noCheck)).toEqual(expected);
        expect(fetched).toHaveLength(1);
        expect(fetched[0]).toHaveLength(names.length);
    });
}, 60_000);

test('a patient releaseAfterLogout retries a timed-out push via injected gitWindow without duplicate commits', async () => {
    await withRepos(async (a, b) => {
        const seenBudgets: Array<number | undefined> = [];
        let pushes = 0;
        const slowRelease = ((root: string, authority?: string, budgetMs?: number) => {
            seenBudgets.push(budgetMs);
            return fleetGitWindow(root, authority, budgetMs, (args, { input: stdin, timeout }) => {
                const real = () => execFileSync('git', args, { cwd: root, input: stdin, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout, windowsHide: true });
                if (!args.includes('push')) return real();
                if (++pushes === 1) return real();
                if (pushes <= 3) {
                    if (pushes === 2) real();
                    throw Object.assign(Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', stdout: '', stderr: '' });
                }
                return real();
            });
        }) as typeof fleetGitWindow;
        const waits: number[] = [];
        const claim = acquireFleetSwarmClaim(a, swarmInput, { patient: true, gitWindow: slowRelease, wait: ms => waits.push(ms) });
        const attempt = beginSessionAttempt(swarmInput, { root: join(a, '.practice/session-lifecycle'),
            owner: { ...lifecycleOwner(), sharedClaimNonce: claim.nonce } });
        claim.armNetwork();
        expect(attempt.record('ended', 'logged-out')).toBe(true);
        claim.releaseAfterLogout(attempt.attemptId);
        expect(pushes).toBe(4);
        expect(waits.length).toBeGreaterThan(0);
        expect(seenBudgets).toContain(claimApi.SWARM_CLAIM_PUSH_MS);
        expect(readFleetAccountClaim(b, swarmInput)).toMatchObject({ phase: 'released', nonce: claim.nonce });
        git(a, 'fetch', '--quiet', 'origin', 'refs/heads/fleet-trade-claim/trader');
        expect(claimLog(a)).toEqual(['Fleet swarm released', 'Fleet swarm attempt']);

        const nonPatientBudgets: Array<number | undefined> = [];
        const np = acquireFleetSwarmClaim(a, { ...swarmInput, account: 'Trader2' }, {
            gitWindow: ((root: string, authority?: string, budgetMs?: number) => {
                nonPatientBudgets.push(budgetMs);
                return fleetGitWindow(root, authority, budgetMs);
            }) as typeof fleetGitWindow,
        });
        np.abortBeforeNetwork();
        expect(nonPatientBudgets).toEqual([undefined, 4000]);
    });
}, 60_000);

test('a patient acquireFleetSwarmClaim recovers when own held H0 raced with own released H1 of the same nonce', async () => {
    await withRepos(async (a, b) => {
        const prev = acquireFleetSwarmClaim(a, swarmInput, { patient: true });
        const attempt = beginSessionAttempt(swarmInput, { root: join(a, '.practice/session-lifecycle'),
            owner: { ...lifecycleOwner(), sharedClaimNonce: prev.nonce } });
        prev.armNetwork();
        expect(attempt.record('ended', 'logged-out')).toBe(true);

        let pushes = 0, raced = false;
        const waits: number[] = [];
        const racingRelease = ((root: string, authority?: string, budgetMs?: number) => fleetGitWindow(root, authority, budgetMs, (args, { input: stdin, timeout }) => {
            if (args.includes('push')) {
                pushes++;
                if (!raced) { raced = true; prev.releaseAfterLogout(attempt.attemptId); }
            }
            return execFileSync('git', args, { cwd: root, input: stdin, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout, windowsHide: true });
        })) as typeof fleetGitWindow;

        const next = acquireFleetSwarmClaim(a, swarmInput, { patient: true, gitWindow: racingRelease, wait: ms => waits.push(ms) });
        expect(raced).toBe(true);
        expect(pushes).toBe(2);
        expect(waits).toEqual([claimApi.SWARM_CLAIM_PAUSE_MS]);
        expect(next.nonce).not.toBe(prev.nonce);
        expect(readFleetAccountClaim(b, swarmInput)).toMatchObject({ phase: 'held', nonce: next.nonce });
        // Failed casAttempt 1 pending marker was cleaned before retrying casAttempt 2.
        const pendingFiles = readdirSync(join(a, '.practice', 'fleet-account-pending'));
        expect(pendingFiles).toEqual([next.nonce + '.json']);
        git(a, 'fetch', '--quiet', 'origin', 'refs/heads/fleet-trade-claim/trader');
        expect(claimLog(a)).toEqual(['Fleet swarm attempt', 'Fleet swarm released', 'Fleet swarm attempt']);
    });
}, 60_000);

test('a patient acquireFleetSwarmClaim still refuses immediately when H1 has a different nonce or phase held', async () => {
    await withRepos(async (a) => {
        // Case 1: H1 is released, but under a different claim nonce on the same checkout.
        const prev = acquireFleetSwarmClaim(a, swarmInput, { patient: true });
        const attempt1 = beginSessionAttempt(swarmInput, { root: join(a, '.practice/session-lifecycle'),
            owner: { ...lifecycleOwner(), sharedClaimNonce: prev.nonce } });
        prev.armNetwork();
        expect(attempt1.record('ended', 'logged-out')).toBe(true);

        let pushes1 = 0, raced1 = false;
        const otherNonceRelease = ((root: string, authority?: string, budgetMs?: number) => fleetGitWindow(root, authority, budgetMs, (args, { input: stdin, timeout }) => {
            if (args.includes('push')) {
                pushes1++;
                if (!raced1) {
                    raced1 = true;
                    prev.releaseAfterLogout(attempt1.attemptId);
                    const intermediate = acquireFleetSwarmClaim(a, swarmInput, { patient: true });
                    const attempt2 = beginSessionAttempt(swarmInput, { root: join(a, '.practice/session-lifecycle'),
                        owner: { ...lifecycleOwner(), sharedClaimNonce: intermediate.nonce } });
                    intermediate.armNetwork();
                    expect(attempt2.record('ended', 'logged-out')).toBe(true);
                    intermediate.releaseAfterLogout(attempt2.attemptId);
                }
            }
            return execFileSync('git', args, { cwd: root, input: stdin, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout, windowsHide: true });
        })) as typeof fleetGitWindow;

        expect(() => acquireFleetSwarmClaim(a, swarmInput, { patient: true, gitWindow: otherNonceRelease, wait: () => {} })).toThrow('unavailable or changed');
        expect(raced1).toBe(true);
        expect(pushes1).toBe(1);
    });

    await withRepos(async (a) => {
        // Case 2: H1 is held (another login acquired after release before our push landed).
        const prev = acquireFleetSwarmClaim(a, swarmInput, { patient: true });
        const attempt1 = beginSessionAttempt(swarmInput, { root: join(a, '.practice/session-lifecycle'),
            owner: { ...lifecycleOwner(), sharedClaimNonce: prev.nonce } });
        prev.armNetwork();
        expect(attempt1.record('ended', 'logged-out')).toBe(true);

        let pushes2 = 0, raced2 = false, winnerNonce = '';
        const racedHeld = ((root: string, authority?: string, budgetMs?: number) => fleetGitWindow(root, authority, budgetMs, (args, { input: stdin, timeout }) => {
            if (args.includes('push')) {
                pushes2++;
                if (!raced2) {
                    raced2 = true;
                    prev.releaseAfterLogout(attempt1.attemptId);
                    winnerNonce = acquireFleetSwarmClaim(a, swarmInput, { patient: true }).nonce;
                }
            }
            return execFileSync('git', args, { cwd: root, input: stdin, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout, windowsHide: true });
        })) as typeof fleetGitWindow;

        expect(() => acquireFleetSwarmClaim(a, swarmInput, { patient: true, gitWindow: racedHeld, wait: () => {} })).toThrow('unavailable or changed');
        expect(raced2).toBe(true);
        expect(pushes2).toBe(1);
        expect(readFleetAccountClaim(a, swarmInput)).toMatchObject({ phase: 'held', nonce: winnerNonce });
    });
}, 60_000);

function rejectPushOnAttempts(failAttempts: ReadonlySet<number>, reason = 'missing necessary objects') {
    let pushes = 0, commits = 0;
    const budgets: Array<number | undefined> = [];
    const window = ((root: string, authority?: string, budgetMs?: number) => {
        budgets.push(budgetMs);
        return fleetGitWindow(root, authority, budgetMs, (args, { input: stdin, timeout }) => {
            if (args.includes('commit-tree')) commits++;
            if (args.includes('push') && failAttempts.has(++pushes)) {
                throw Object.assign(Error('Command failed: git push'), {
                    status: 1,
                    stdout: '',
                    stderr: `To https://github.com/Giftedx/rs-sdk-bot.git\n ! [remote rejected] deadbeef -> fleet-trade-claim/earlyshooter (${reason})\nerror: failed to push some refs to 'https://github.com/Giftedx/rs-sdk-bot.git'`,
                });
            }
            return execFileSync('git', args, { cwd: root, input: stdin, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout, windowsHide: true });
        });
    }) as typeof fleetGitWindow;
    return { window, counts: () => ({ pushes, commits, budgets: [...budgets] }) };
}

test('trade acquire, single release, and atomic batch release retry remote-busy pushes without duplicate commits', async () => {
    await withRepos((a, b) => {
        const earlyshooter = { ...input, account: 'Earlyshooter' };
        const waits: number[] = [];
        const acqSpy = rejectPushOnAttempts(new Set([1]), 'missing necessary objects');
        const claim = acquireFleetTradeClaim(a, earlyshooter, () => T0, { gitWindow: acqSpy.window, wait: ms => waits.push(ms) });
        expect(acqSpy.counts()).toMatchObject({ pushes: 2, commits: 1 });
        expect(waits).toEqual([claimApi.SWARM_CLAIM_PAUSE_MS]);
        expect(readFleetTradeClaim(b, earlyshooter)?.nonce).toBe(claim.nonce);

        const relWaits: number[] = [];
        const relSpy = rejectPushOnAttempts(new Set([1]), 'missing necessary objects');
        releaseFleetTradeClaim(a, { ...earlyshooter, nonce: claim.nonce }, () => T0 + 1, { gitWindow: relSpy.window, wait: ms => relWaits.push(ms) });
        expect(relSpy.counts()).toMatchObject({ pushes: 2, commits: 1 });
        expect(relWaits).toEqual([claimApi.SWARM_CLAIM_PAUSE_MS]);
        expect(readFleetTradeClaim(b, earlyshooter)).toMatchObject({ phase: 'released', nonce: claim.nonce });

        const giver = acquireFleetTradeClaim(a, { ...earlyshooter, orderId: 'order-two' }, () => T0 + 2);
        const taker = acquireFleetTradeClaim(a, { ...input, account: 'Receiver', orderId: 'order-two', role: 'to' }, () => T0 + 2);
        const batchSpy = rejectPushOnAttempts(new Set([1]), 'missing necessary objects');
        expect(claimApi.releaseFleetTradeClaims(a, [giver, taker], () => T0 + 3, { gitWindow: batchSpy.window, wait: () => {} })).toBe(2);
        expect(batchSpy.counts()).toMatchObject({ pushes: 2, commits: 2 });
        expect([giver, taker].map(t => readFleetTradeClaim(b, t)?.phase)).toEqual(['released', 'released']);

        // Non-retryable ref rejections still fail immediately on the first push.
        const rejectedSpy = rejectPushOnAttempts(new Set([1]), 'non-fast-forward');
        expect(() => acquireFleetTradeClaim(a, { ...earlyshooter, orderId: 'order-three' }, () => T0 + 4, { gitWindow: rejectedSpy.window, wait: () => {} })).toThrow('unavailable or changed');
        expect(rejectedSpy.counts().pushes).toBe(1);
    });
}, 60_000);

test('a non-patient swarm claim retries remote-busy acquire and release pushes inside its single Git windows', async () => {
    await withRepos((a, b) => {
        const earlyshooter = { ...swarmInput, account: 'Earlyshooter' };
        // Attempt 1 fails on acquire push (missing necessary objects), attempt 2 lands;
        // attempt 3 fails on abortBeforeNetwork release push, attempt 4 lands.
        const spy = rejectPushOnAttempts(new Set([1, 3]), 'missing necessary objects');
        const waits: number[] = [];
        const claim = acquireFleetSwarmClaim(a, earlyshooter, { gitWindow: spy.window, wait: ms => waits.push(ms) });
        expect(readFleetAccountClaim(b, earlyshooter)).toMatchObject({ phase: 'held', nonce: claim.nonce });
        claim.abortBeforeNetwork();
        expect(readFleetAccountClaim(b, earlyshooter)).toMatchObject({ phase: 'released', nonce: claim.nonce });
        expect(spy.counts()).toEqual({ pushes: 4, commits: 2, budgets: [undefined, 4000] });
        expect(waits).toEqual([200, 200]);
    });
}, 60_000);

if (!isWorker) {
    const tpl = (repoTemplate ??= createRepoTemplate());
    const scriptPath = fileURLToPath(import.meta.url);
    const spawnSlot = () => Bun.spawn([process.execPath, 'run', scriptPath], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
        env: { ...process.env, FLEET_CLAIM_WORKER: '1', FLEET_CLAIM_TEMPLATE: JSON.stringify(tpl) },
    });
    // A case's timeout counts from its dispatch to a worker. Every case starts at once under bun test.concurrent and
    // waits here for a free worker, so a bun timeout alone also counts the queue: on the 2 workers of a 4-vCPU runner
    // the last of 34 cases waited past 60 s and failed.
    type Job = { name: string; timeout: number; resolve: () => void; reject: (err: Error) => void };
    type WorkerSlot = { proc: ReturnType<typeof spawnSlot>; stopped?: boolean };
    const idle: WorkerSlot[] = [], queue: Job[] = [], workers: WorkerSlot[] = [];
    const pending = new Map<number, Job & { slot: WorkerSlot; timer: ReturnType<typeof setTimeout>; started: number }>();
    const times: { name: string; ms: number }[] = [];
    let seq = 0, closed = false;
    const release = (slot: WorkerSlot) => {
        const next = queue.shift();
        if (next && !closed) dispatch(slot, next);
        else if (!closed) idle.push(slot);
    };
    const dispatch = (slot: WorkerSlot, job: Job) => {
        const id = ++seq;
        // A case past its own timeout fails, and its worker (it can be blocked in a synchronous Git call) is replaced.
        const timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            job.reject(new Error(`case ran over its ${job.timeout} ms timeout`));
            slot.stopped = true;
            slot.proc.kill();
            if (!closed) release(addSlot());
        }, job.timeout);
        pending.set(id, { slot, ...job, timer, started: performance.now() });
        slot.proc.stdin.write(JSON.stringify({ id, name: job.name }) + '\n');
    };
    const addSlot = (): WorkerSlot => {
        const proc = spawnSlot(), slot: WorkerSlot = { proc };
        workers.push(slot);
        const failAll = (err: Error) => {
            for (const [id, entry] of pending) {
                if (entry.slot === slot) { pending.delete(id); clearTimeout(entry.timer); entry.reject(err); }
            }
        };
        void (async () => {
            const reader = proc.stdout.getReader(), decoder = new TextDecoder();
            let buf = '';
            while (true) {
                const { value, done } = await reader.read();
                if (value) buf += decoder.decode(value, { stream: true });
                let nl: number;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line.startsWith('__FTC__:')) continue;
                    const { id, error } = JSON.parse(line.slice(8)) as { id: number; error?: string };
                    const entry = pending.get(id);
                    if (!entry) continue;
                    pending.delete(id);
                    clearTimeout(entry.timer);
                    times.push({ name: entry.name, ms: Math.round(performance.now() - entry.started) });
                    release(slot);
                    if (error) entry.reject(new Error(error));
                    else entry.resolve();
                }
                if (done) break;
            }
        })();
        // A worker that exits by itself fails its case at once with its exit code and error text, and is replaced.
        // `slot.stopped` marks the workers this file stops (Bun's `killed` is also true after an exit of its own).
        void proc.exited.then(async code => {
            if (closed || slot.stopped) return;
            const at = idle.indexOf(slot);
            if (at >= 0) idle.splice(at, 1);
            failAll(new Error(`claim test worker exited with ${code}: ${await new Response(proc.stderr).text()}`));
            if (!closed) release(addSlot());
        });
        return slot;
    };
    for (let i = 0; i < Math.max(2, Math.min(6, Math.floor(cpus().length / 2))); i++) idle.push(addSlot());
    const runInPool = (name: string, timeout: number) => new Promise<void>((resolve, reject) => {
        const slot = idle.pop(), job = { name, timeout, resolve, reject };
        if (slot) dispatch(slot, job);
        else queue.push(job);
    });
    afterAll(async () => {
        closed = true;
        if (process.env.FLEET_CLAIM_TIMES === '1') console.log('FLEET_CLAIM_TIMES ' + JSON.stringify(times.sort((a, b) => b.ms - a.ms)));
        await Promise.all(workers.map(async ({ proc }) => {
            try { proc.stdin.end(); } catch { /* exited */ }
            await proc.exited;
        }));
        if (dirname(tpl.dir) === tmpdir()) rmSync(tpl.dir, { recursive: true, force: true, maxRetries: 5 });
    });
    // Longest-timeout cases launch first. The bun timeout bounds queue wait plus run: a case ahead in the queue ends by
    // its own timeout at the latest, so the sum of all timeouts is never reached while the dispatch timers work.
    const cases = [...CONCURRENT_CASES].sort((a, b) => b.timeout - a.timeout), queueBound = cases.reduce((n, c) => n + c.timeout, 0);
    for (const { name, timeout } of cases) bunTest.concurrent(name, () => runInPool(name, timeout), queueBound);
    // The crash, not the case timer, fails the case: the error names the exit code.
    bunTest.concurrent('a worker that crashes fails its case at once with its exit code, and the pool goes on', async () => {
        await expect(runInPool(CRASH_CASE, 60_000)).rejects.toThrow('claim test worker exited with 3');
    }, queueBound);
} else {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', async line => {
        if (!line.trim()) return;
        const { id, name } = JSON.parse(line) as { id: number; name: string };
        if (name === CRASH_CASE) process.exit(3);
        try {
            const entry = CONCURRENT_CASES.find(c => c.name === name);
            if (!entry) throw new Error(`missing test case ${name}`);
            await entry.fn();
            process.stdout.write(`__FTC__:${JSON.stringify({ id })}\n`);
        } catch (error) {
            process.stdout.write(`__FTC__:${JSON.stringify({ id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) })}\n`);
        }
    });
}
