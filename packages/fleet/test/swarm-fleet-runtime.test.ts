import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeLiveUpdate } from '../../core/src/live-reload';
import { hasStopFile, liveLifecycleRoot, liveRoot, liveStatusDir, practiceRoot } from '../../core/src/practice-paths';
import { beginSessionAttempt, readLogoutProof } from '../../core/src/session-lifecycle';
import { confirmedTradeLogout, readSyncStatuses, readSyncStopText, sideCard } from '../src/fleet-sync';
import {
    clearAccountAutoStops,
    clearAccountSwarmStops,
    readAccountStatus,
    readAllStatuses,
    recoveryLeaseHeld,
    shouldSwarmReload,
    startable,
    SWARM_STOP,
    swarmReloadArgs,
} from '../src/swarm';

const dirs: string[] = [];
const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-runtime-test-'));
    dirs.push(d);
    return d;
};

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('fleet runtime live-path, Brain dispatch, reload, and lease fixes', () => {
    test('reads .practice/live/status first, honors .practice/live/stop-<account> owner pauses, and clears only auto-stops', () => {
        const root = scratch();
        mkdirSync(liveStatusDir(root), { recursive: true });
        mkdirSync(join(practiceRoot(root), 'status'), { recursive: true });
        mkdirSync(liveRoot(root), { recursive: true });

        writeFileSync(
            join(practiceRoot(root), 'status', 'Bob.json'),
            JSON.stringify({ name: 'Bob', server: 'rs-sdk-demo.fly.dev', at: 1000, started: 500 }),
        );
        writeFileSync(
            join(liveStatusDir(root), 'Bob.json'),
            JSON.stringify({ name: 'Bob', server: 'rs-sdk-demo.fly.dev', at: 2000, started: 1500 }),
        );
        writeFileSync(
            join(liveStatusDir(root), 'Alice.json'),
            JSON.stringify({ name: 'Alice', server: 'rs-sdk-demo.fly.dev', at: 2500, started: 2000 }),
        );

        const bob = readAccountStatus(root, 'Bob');
        expect(bob?.data?.at).toBe(2000);

        const all = readAllStatuses(root) as { name: string; at: number }[];
        expect(all.map(r => `${r.name}:${r.at}`).sort()).toEqual(['Alice:2500', 'Bob:2000']);

        const syncRows = readSyncStatuses(root) as { name: string; at: number }[];
        expect(syncRows.some(r => r.name === 'Alice' && r.at === 2500)).toBe(true);
        expect(syncRows.some(r => r.name === 'Bob' && r.at === 2000)).toBe(true);

        // Owner pause in .practice/live/stop-Alice blocks startable and sideCard, and survives auto-stop clearing.
        writeFileSync(join(liveRoot(root), 'stop-Alice'), 'owner manual pause');
        writeFileSync(join(liveRoot(root), 'stop-Bob'), SWARM_STOP.all);

        expect(hasStopFile('Alice', root)).toBe(true);
        expect(clearAccountAutoStops('Alice', root)).toBe(false);
        expect(clearAccountSwarmStops('Alice', root)).toBe(false);
        expect(existsSync(join(liveRoot(root), 'stop-Alice'))).toBe(true);

        expect(clearAccountSwarmStops('Bob', root)).toBe(true);
        expect(existsSync(join(liveRoot(root), 'stop-Bob'))).toBe(false);

        const card = sideCard('local', 4, ['Alice', 'Bob'], n => readSyncStopText(root, n));
        expect(card.paused).toEqual(['alice']);

        const sel = startable(['Alice', 'Bob'], true, new Map(), () => Infinity, undefined, 'rev1', a => hasStopFile(a, root));
        expect(sel.start).toEqual(['Bob']);
        expect(sel.blocked.Alice).toBe('paused: stop file');
    });

    test('confirmedTradeLogout resolves confirmed logout receipts under .practice/live/session-lifecycle', () => {
        const root = scratch();
        const server = 'rs-sdk-demo.fly.dev';
        const lRoot = liveLifecycleRoot(root);
        const nonce = '11111111-1111-4111-8111-111111111111';
        const claimAt = 1_700_000_000_000;
        const attempt = beginSessionAttempt(
            { account: 'trader1', server },
            {
                root: lRoot,
                now: () => claimAt + 500,
                owner: {
                    pid: 54321,
                    coordinatorRunId: null,
                    workerRelease: 'a'.repeat(64),
                    script: 'scripts/aio-logistics.ts',
                    role: 'trade',
                    participants: null,
                    sharedClaimNonce: nonce,
                },
            },
        );
        attempt.record('ready');
        attempt.record('ended', 'logged-out');
        const proof = readLogoutProof('trader1', server, { root: lRoot });
        expect(proof.state).toBe('confirmed');
        if (proof.state !== 'confirmed') throw Error('expected confirmed');

        const ok = confirmedTradeLogout(
            root,
            { account: 'trader1', server, side: 'local', orderId: 'ord-1', role: 'from', nonce, phase: 'held', at: claimAt, pid: 54321 },
            {
                version: 2,
                state: 'reconcile',
                id: 'ord-1',
                account: 'trader1',
                role: 'from',
                side: 'local',
                ok: false,
                count: 0,
                at: proof.loggedOutAt + 100,
                detail: 'done',
                server,
                partner: 'trader2',
                item: 'Shark',
                requested: 10,
                claim: nonce,
                logout: { attemptId: proof.attemptId, at: proof.loggedOutAt, sha256: proof.receiptSha256 },
            },
            () => false,
        );
        expect(ok).toBe(true);
    });

    test('Brain-dispatched jobs repeat after done, switch after non-death failures, and keep death holds enforced', () => {
        const doneSame = new Map([['BotA', { at: 10_000, reason: 'done after 1 runs', revision: 'sig-a' }]]);
        expect(
            startable(['BotA'], true, doneSame, () => Infinity, undefined, 'sig-a', () => false, () => true).start,
        ).toEqual(['BotA']);

        // Non-death failure + Brain switches to a different activity (sig-b !== sig-a) -> allowed.
        const blockedOther = new Map([['BotA', { at: 10_000, reason: 'blocked after 1 runs', revision: 'sig-a' }]]);
        expect(
            startable(['BotA'], true, blockedOther, () => Infinity, undefined, 'sig-b', () => false, () => true).start,
        ).toEqual(['BotA']);

        // Non-death failure on the same activity stays blocked.
        expect(
            startable(['BotA'], true, blockedOther, () => Infinity, undefined, 'sig-a', () => false, () => true).start,
        ).toEqual([]);

        // Orphaned end with no revision stays blocked.
        const orphan = new Map([['BotA', { at: 10_000, reason: 'exit orphaned: attempt 1 owner 9 gone' }]]);
        expect(
            startable(['BotA'], true, orphan, () => Infinity, undefined, 'sig-b', () => false, () => true).start,
        ).toEqual([]);

        // Death end ALWAYS stays blocked even when Brain switches activity.
        const died = new Map([['BotA', { at: 10_000, reason: 'died after 1 runs', revision: 'sig-a' }]]);
        const deathSel = startable(['BotA'], true, died, () => Infinity, undefined, 'sig-b', () => false, () => true);
        expect(deathSel.start).toEqual([]);
        expect(deathSel.blocked.BotA).toContain('died');
    });

    test('shouldSwarmReload triggers on live-update.json mark only when no recovery or stop is active', () => {
        const root = scratch();
        const startedAt = 1_000_000;
        expect(shouldSwarmReload({ root, startedAt, recoveryActive: false, stopAll: false })).toBe(false);

        writeLiveUpdate(root, { at: startedAt + 5_000, from: 'aaa', to: 'bbb', files: 1, reload: ['swarm'] });
        expect(shouldSwarmReload({ root, startedAt, recoveryActive: false, stopAll: false })).toBe(true);
        expect(shouldSwarmReload({ root, startedAt, recoveryActive: true, stopAll: false })).toBe(false);
        expect(shouldSwarmReload({ root, startedAt, recoveryActive: false, stopAll: true })).toBe(false);
        expect(shouldSwarmReload({ root, startedAt: startedAt + 6_000, recoveryActive: false, stopAll: false })).toBe(false);

        const nonce = '11111111-2222-3333-4444-555555555555';
        const args = swarmReloadArgs(root, join(root, 'swarm.json'), 'watch-1', nonce);
        expect(args).toEqual([
            join(root, 'scripts', 'swarm.ts'),
            join(root, 'swarm.json'),
            `--nonce=${nonce}`,
            '--watch-id=watch-1',
        ]);
    });

    test('recoveryLeaseHeld releases immediately when JSON lease owner PID is dead', () => {
        const root = scratch();
        const lease = join(root, 'swarm-repair.json.lease');
        const now = 1_700_000_000_000;
        writeFileSync(lease, JSON.stringify({ pid: 999991, runId: 'r1', nonce: 'n1', at: now - 1000 }));
        expect(recoveryLeaseHeld(lease, now, () => false, () => new Map())).toBe(false);
        expect(recoveryLeaseHeld(lease, now, () => true, () => new Map([[999991, now - 5000]]))).toBe(true);
        // Reused PID started after lease.at is not the lease owner.
        expect(recoveryLeaseHeld(lease, now, () => true, () => new Map([[999991, now + 10_000]]))).toBe(false);
    });
});
