import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireFleetTradeClaim, readFleetTradeClaim, readHeldFleetTradeClaims, releaseFleetTradeClaim } from '../src/fleet-trade-claim';

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
            `import { acquireFleetTradeClaim } from ${modulePath}; acquireFleetTradeClaim(process.cwd(), ${JSON.stringify(trade)})`],
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
