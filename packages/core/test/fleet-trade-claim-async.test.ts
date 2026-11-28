import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import { settle } from '../src/bot';
import { fleetGitWindowAsync } from '../src/fleet-lease';
import { acquireFleetSwarmClaimAsync, readFleetAccountClaim } from '../src/fleet-trade-claim';
import { startInProcessSession } from '../src/inprocess';
import { lifecycleRootForServer } from '../src/practice-paths';
import { beginSessionAttempt, lifecycleOwner } from '../src/session-lifecycle';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', timeout: 5000, windowsHide: true });
const server = 'rs-sdk-demo.fly.dev';

async function withRepos(run: (a: string, b: string) => Promise<void>) {
    const base = mkdtempSync(join(tmpdir(), 'fleet-claim-async-'));
    try {
        const remote = join(base, 'origin.git');
        const remoteUrl = remote.replaceAll('\\', '/');
        const a = join(base, 'a');
        const b = join(base, 'b');
        git(base, 'init', '--bare', remote);
        git(remote, 'config', 'receive.autogc', 'false');
        git(remote, 'config', 'gc.auto', '0');
        for (const d of [a, b]) {
            mkdirSync(d);
            git(d, 'init');
            git(d, 'remote', 'add', 'origin', remoteUrl);
            git(d, 'config', 'gc.auto', '0');
            git(d, 'config', 'maintenance.auto', 'false');
        }
        await run(a, b);
    } finally {
        if (dirname(base) === tmpdir()) rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    }
}

test('concurrent acquireFleetSwarmClaimAsync and release calls keep the 25 ms event loop responsive and serialize per root', async () => {
    await withRepos(async (a) => {
        let ticks = 0;
        let maxGapMs = 0;
        let last = performance.now();
        const timer = setInterval(() => {
            const now = performance.now();
            maxGapMs = Math.max(maxGapMs, now - last);
            last = now;
            ticks++;
        }, 25);

        let inFlight = 0;
        let maxInFlight = 0;
        const instrumentedWindow: typeof fleetGitWindowAsync = (root, authority, budgetMs) => {
            const run = fleetGitWindowAsync(root, authority, budgetMs);
            return async (args, input) => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                try {
                    await Bun.sleep(20);
                    return await run(args, input);
                } finally {
                    inFlight--;
                }
            };
        };

        try {
            const accounts = ['PoolOne', 'PoolTwo', 'PoolThree', 'PoolFour'];
            const claims = await Promise.all(accounts.map(account =>
                acquireFleetSwarmClaimAsync(a, { account, server, side: 'local' }, { gitWindow: instrumentedWindow })));
            expect(claims).toHaveLength(4);
            expect(maxInFlight).toBe(1);

            await Promise.all(claims.map(claim => claim.abortBeforeNetwork()));
            for (const account of accounts) {
                expect(readFleetAccountClaim(a, { account, server })?.phase).toBe('released');
            }
            expect(ticks).toBeGreaterThanOrEqual(8);
            expect(maxGapMs).toBeLessThan(500);
        } finally {
            clearInterval(timer);
        }
    });
}, 30_000);

test('acquireFleetSwarmClaimAsync enforces lock exclusivity, ref conflict refusal, credential redaction, abandoned recovery, and post-arm protection', async () => {
    await withRepos(async (a, b) => {
        const target = { account: 'AsyncGuard', server, side: 'local' };

        // 1. Cross-checkout race: only one winner succeeds; the loser gets a ref conflict / held refusal.
        const race = await Promise.allSettled([
            acquireFleetSwarmClaimAsync(a, target),
            acquireFleetSwarmClaimAsync(b, target),
        ]);
        const won = race.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireFleetSwarmClaimAsync>>> => r.status === 'fulfilled');
        const lost = race.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        const winnerRoot = race[0]?.status === 'fulfilled' ? a : b;
        const loserRoot = winnerRoot === a ? b : a;
        const winner = won[0]!.value;
        expect(readFleetAccountClaim(loserRoot, target)).toMatchObject({ phase: 'held', nonce: winner.nonce });

        // 2. Post-armNetwork protection: abortBeforeNetwork refuses and releaseAfterLogout requires exact confirmed logout proof.
        const attempt = beginSessionAttempt(
            { account: target.account, server, secret: 'fixture-pass' },
            { root: lifecycleRootForServer(server, winnerRoot), owner: { ...lifecycleOwner(), sharedClaimNonce: winner.nonce } },
        );
        winner.armNetwork();
        await expect(winner.abortBeforeNetwork()).rejects.toThrow('already armed for network');
        await expect(winner.releaseAfterLogout(attempt.attemptId)).rejects.toThrow('exact logout proof');
        attempt.record('ended', 'logged-out');
        await expect(winner.releaseAfterLogout('wrong-attempt-id')).rejects.toThrow('exact logout proof');
        await winner.releaseAfterLogout(attempt.attemptId);
        expect(readFleetAccountClaim(winnerRoot, target)).toMatchObject({ phase: 'released', nonce: winner.nonce });

        // 3. Abandoned pre-network recovery while the same pool PID stays alive: failed push writes abandoned marker,
        // so the same checkout can recover even when the push actually landed on the remote.
        const droppedWindow: typeof fleetGitWindowAsync = (root, authority, budgetMs) => {
            const run = fleetGitWindowAsync(root, authority, budgetMs);
            return async (args, input) => {
                const out = await run(args, input);
                if (args.includes('push')) {
                    throw Error("fleet swarm claim authority unavailable or changed: push reply lost for 'https://bot:secret-token@github.com/x/y.git'");
                }
                return out;
            };
        };
        const failed = await acquireFleetSwarmClaimAsync(a, target, { gitWindow: droppedWindow }).catch(e => e as Error);
        expect(failed).toBeInstanceOf(Error);
        expect(readFleetAccountClaim(b, target)?.phase).toBe('held');

        // Another checkout still cannot steal the held claim, while the owning checkout recovers via the abandoned marker.
        await expect(acquireFleetSwarmClaimAsync(b, target)).rejects.toThrow('held by swarm');
        const recovered = await acquireFleetSwarmClaimAsync(a, target);
        await recovered.abortBeforeNetwork();
        expect(readFleetAccountClaim(b, target)).toMatchObject({ phase: 'released', nonce: recovered.nonce });

        // 4. Credential redaction and queue resilience: a failing claim with URL credentials redacts them and never wedges later claims.
        const credWindow: typeof fleetGitWindowAsync = (root, authority, budgetMs) =>
            fleetGitWindowAsync(root, authority, budgetMs, async () => {
                throw Object.assign(Error('git failed'), { stderr: "fatal: Authentication failed for 'https://alice:top-secret-pw@github.com/org/repo.git'" });
            });
        const credErr = await acquireFleetSwarmClaimAsync(a, target, { gitWindow: credWindow }).catch((e: unknown) => e);
        expect(credErr).toBeInstanceOf(Error);
        if (!(credErr instanceof Error)) throw Error('expected Error');
        expect(credErr.message).toContain('Authentication failed');
        expect(credErr.message).not.toContain('top-secret-pw');

        const afterError = await acquireFleetSwarmClaimAsync(a, target);
        await afterError.abortBeforeNetwork();
        expect(readFleetAccountClaim(a, target)).toMatchObject({ phase: 'released', nonce: afterError.nonce });
    });
}, 30_000);

test('startInProcessSession and settle await async swarm claim acquire and release without blocking the event loop', async () => {
    await withRepos(async (a) => {
        class FakeActions { constructor(public sdk: unknown) {} }
        const fakeStart = async (o: any) => {
            let resolveStopped!: (v: unknown) => void;
            let done = false;
            const stopped = new Promise(r => { resolveStopped = r; });
            const end = (reason: string) => {
                if (done) return;
                done = true;
                o.onEnd({ reason });
                resolveStopped({ reason });
            };
            const client: any = {
                collectBotState: () => ({}),
                executeBotAction: () => ({ success: true }),
                setOnGameTickCallback: () => {},
                end,
            };
            o.onClient(client);
            return { client, stop: () => end('stopped'), stopped };
        };

        let ticks = 0;
        const timer = setInterval(() => { ticks++; }, 25);
        try {
            const session = await startInProcessSession(
                { name: 'SettleAsync', password: 'fixture-password', server },
                {
                    startSession: fakeStart,
                    sdk: new BotSDK({ botUsername: 'SettleAsync', password: 'fixture-password', autoLaunchBrowser: false, autoReconnect: false } as any),
                    Actions: FakeActions as any,
                    cacheDir: join(a, 'cache'),
                    lifecycle: { root: lifecycleRootForServer(server, a) },
                    recordOwned: () => {},
                    sharedAccount: { root: a, side: 'local' },
                    soloProcess: false,
                },
            );
            expect(readFleetAccountClaim(a, { account: 'SettleAsync', server })?.phase).toBe('held');

            const ok = await settle([session], true, 'done', {
                log: () => {},
                logout: async s => {
                    (s.client as any).end('logged-out');
                    return 'logged-out';
                },
            });
            expect(ok).toBe(true);
            expect(readFleetAccountClaim(a, { account: 'SettleAsync', server })?.phase).toBe('released');
            expect(ticks).toBeGreaterThanOrEqual(1);
        } finally {
            clearInterval(timer);
        }
    });
}, 30_000);
