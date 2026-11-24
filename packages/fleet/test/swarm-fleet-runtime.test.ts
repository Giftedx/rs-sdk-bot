import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLEET_STATE_SCHEMA_VERSION, type FleetState } from '../../brain/src/contracts';
import { writeLiveUpdate } from '../../core/src/live-reload';
import { hasStopFile, liveLifecycleRoot, liveRoot, liveStatusDir, practiceRoot } from '../../core/src/practice-paths';
import { beginSessionAttempt, readLogoutProof } from '../../core/src/session-lifecycle';
import { courierDeliveryWaiting, readCourierStatus } from '../src/courier-admission';
import { brainPlannedJobs, confirmedTradeLogout, droppedTradeClaims, readSyncStatuses, readSyncStopText, releasePublishedTradeClaims, sideCard } from '../src/fleet-sync';
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
    syncDeathHolds,
    type ScriptHold,
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

    test('readSyncStatuses excludes practice:true rows across status directories', () => {
        const root = scratch();
        mkdirSync(liveStatusDir(root), { recursive: true });
        writeFileSync(join(liveStatusDir(root), 'LiveBot.json'), JSON.stringify({ name: 'LiveBot', server: 'rs-sdk-demo.fly.dev', at: 1000 }));
        writeFileSync(join(liveStatusDir(root), 'SimBot.json'), JSON.stringify({ name: 'SimBot', server: 'rs-sdk-demo.fly.dev', at: 1000, practice: true }));
        const rows = readSyncStatuses(root) as { name: string }[];
        expect(rows.map(r => r.name)).toEqual(['LiveBot']);
    });

    test('readCourierStatus and courierDeliveryWaiting read .practice/live/status first with case-insensitive fallback', () => {
        const root = scratch();
        const now = 1_700_000_000_000;
        mkdirSync(liveStatusDir(root), { recursive: true });
        mkdirSync(join(practiceRoot(root), 'status'), { recursive: true });

        writeFileSync(
            join(practiceRoot(root), 'status', 'CourierBot.json'),
            JSON.stringify({ name: 'CourierBot', server: 'rs-sdk-demo.fly.dev', at: now - 10_000, inventory: [] }),
        );
        writeFileSync(
            join(liveStatusDir(root), 'courierbot.json'),
            JSON.stringify({
                name: 'CourierBot',
                server: 'rs-sdk-demo.fly.dev',
                at: now - 1_000,
                pos: { x: 2653, z: 3302, level: 0 },
                inventory: [{ id: 334, name: 'Trout', count: 50 }],
            }),
        );

        const row = readCourierStatus('CourierBot', root);
        expect(row.at).toBe(now - 1_000);
        expect(courierDeliveryWaiting(
            ['CourierBot'],
            undefined,
            [{ account: 'CourierBot', script: 'scripts/aio-logistics.ts', args: ['food-courier'] }],
            name => readCourierStatus(name, root),
            now,
        )).toBe(true);
    });

    test('syncDeathHolds refreshes same-second edits and clears holds when the hold file is removed', () => {
        const root = scratch();
        const holdsFile = join(root, 'swarm-script-holds.json');
        const holds: ScriptHold[] = [];
        let stamp = syncDeathHolds(holdsFile, holds, { mtimeMs: -1, size: -1 });
        expect(holds).toEqual([]);

        const makeHold = (at: number): ScriptHold => ({
            account: 'BotA',
            script: 'scripts/aio-fighter.ts',
            at,
            reason: 'died after 1 runs',
            heldAt: at,
        });
        writeFileSync(holdsFile, JSON.stringify([makeHold(1000)]));
        stamp = syncDeathHolds(holdsFile, holds, stamp);
        expect(holds.map(h => h.at)).toEqual([1000]);

        // Same-second overwrite refreshes immediately without stale mtime hit.
        writeFileSync(holdsFile, JSON.stringify([makeHold(2000)]));
        stamp = syncDeathHolds(holdsFile, holds, stamp);
        expect(holds.map(h => h.at)).toEqual([2000]);

        // Backdated steady-state hit skips reload when stamp matches, then removal clears in-memory holds.
        const past = new Date(Date.now() - 10_000);
        utimesSync(holdsFile, past, past);
        stamp = syncDeathHolds(holdsFile, holds, stamp);
        expect(holds.map(h => h.at)).toEqual([2000]);

        rmSync(holdsFile);
        stamp = syncDeathHolds(holdsFile, holds, stamp);
        expect(holds).toEqual([]);
        expect(stamp).toEqual({ mtimeMs: 0, size: 0 });
    });

    test('hasStopFile remains true when auto-stop clearing leaves an owner stop in the sibling directory', () => {
        const root = scratch();
        mkdirSync(liveRoot(root), { recursive: true });
        mkdirSync(practiceRoot(root), { recursive: true });
        writeFileSync(join(liveRoot(root), 'stop-DualBot'), SWARM_STOP.all);
        writeFileSync(join(practiceRoot(root), 'stop-DualBot'), 'owner manual hold');

        expect(clearAccountAutoStops('DualBot', root)).toBe(true);
        expect(existsSync(join(liveRoot(root), 'stop-DualBot'))).toBe(false);
        expect(hasStopFile('DualBot', root)).toBe(true);

        writeFileSync(join(liveRoot(root), 'stop-DualBot'), SWARM_STOP.removed);
        expect(clearAccountSwarmStops('DualBot', root)).toBe(true);
        expect(hasStopFile('DualBot', root)).toBe(true);
    });

    test('brainPlannedJobs skips paused_owner, reserved, dead, and protectedClock accounts; trade claims match mixed-case claims', () => {
        const root = scratch();
        const now = Date.now();
        mkdirSync(liveRoot(root), { recursive: true });
        const mkAcct = (name: string, lifecycle: 'idle' | 'paused_owner' | 'reserved' | 'dead', protectedClock = false) => ({
            name,
            side: 'local',
            role: 'auto' as const,
            protectedClock,
            lifecycle,
            pos: { x: 3222, z: 3218, level: 0 },
            skills: {},
            quests: {},
            inventory: {},
            equipment: {},
            bank: { items: {}, observedAt: now, trusted: true },
        });
        const step = {
            stepKind: 'work' as const,
            activityId: 'skiller:fishing:cage',
            demandId: 'd:fish',
            workerId: 'skiller',
            batchUnits: 1,
            estimatedTicks: 100,
            expectedValuePerHour: 100,
            config: { skill: 'fishing', method: 'cage' },
        };
        const state: FleetState = {
            schemaVersion: FLEET_STATE_SCHEMA_VERSION,
            emittedAt: now,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            maxBots: 5,
            accounts: {
                pausedbot: mkAcct('PausedBot', 'paused_owner'),
                reservedbot: mkAcct('ReservedBot', 'reserved', true),
                deadbot: mkAcct('DeadBot', 'dead'),
                activebot: mkAcct('ActiveBot', 'idle'),
            },
            activeChains: {
                PausedBot: { account: 'PausedBot', demandId: 'd:fish', scorePerHour: 100, steps: [step] },
                ReservedBot: { account: 'ReservedBot', demandId: 'd:fish', scorePerHour: 100, steps: [step] },
                DeadBot: { account: 'DeadBot', demandId: 'd:fish', scorePerHour: 100, steps: [step] },
                ActiveBot: { account: 'ActiveBot', demandId: 'd:fish', scorePerHour: 100, steps: [step] },
            },
            idleReasons: {},
            goals: [],
            campaigns: [],
            missions: [],
            pendingTransfers: [],
            quarantinedDefects: [],
        };
        writeFileSync(join(liveRoot(root), 'fleet-state.json'), JSON.stringify(state));
        const planned = brainPlannedJobs(root, [], now + 1000);
        expect(planned.map(j => j.account)).toEqual(['ActiveBot']);

        // Mixed-case claim identity still resolves dropped and released trade claims.
        const nonce = '11111111-2222-3333-4444-555555555555';
        const sha = 'a'.repeat(64);
        const attemptId = '1700000000000-1-1';
        const orderStart = now - 60_000;
        const orderEnd = now - 10_000;
        const files: Record<string, any> = {
            'owners.json': { accounts: { Alpha: { side: 'local' }, Beta: { side: 'cloud' } } },
            'orders/ord-case.json': { id: 'ord-case', server: 'rs-sdk-demo.fly.dev', from: 'Alpha', to: 'Beta', item: 'Shark', count: 5, start: orderStart, end: orderEnd },
            'receipts/ord-case.from.json': {
                version: 2,
                state: 'settled',
                ok: true,
                id: 'ord-case',
                account: 'alpha',
                role: 'from',
                side: 'local',
                partner: 'Beta',
                server: 'rs-sdk-demo.fly.dev',
                item: 'Shark',
                requested: 5,
                count: 5,
                at: orderStart + 5000,
                claim: nonce,
                inventory: { before: 10, after: 5 },
                logout: { attemptId, at: orderStart + 4000, sha256: sha },
            },
        };
        const released: string[] = [];
        const count = releasePublishedTradeClaims(
            [{ orderId: 'ord-case', role: 'from', side: 'local', account: 'Alpha', server: 'RS-SDK-DEMO.FLY.DEV', phase: 'held', at: orderStart, nonce }],
            'local',
            p => files[p] ?? null,
            c => released.push(c.account),
            now,
        );
        expect(count).toBe(1);
        expect(released).toEqual(['Alpha']);

        const dropped = droppedTradeClaims(
            [{ orderId: 'ord-drop', role: 'from', side: 'local', account: 'Alpha', server: 'rs-sdk-demo.fly.dev', phase: 'held', at: orderStart, nonce }],
            'local',
            p => ({
                'owners.json': { accounts: { Alpha: { side: 'local' }, Beta: { side: 'cloud' } } },
                'orders/ord-drop.json': { id: 'ord-drop', server: 'rs-sdk-demo.fly.dev', from: 'Alpha', to: 'Beta', item: 'Shark', count: 5, start: orderStart, end: orderEnd },
                'receipts/ord-drop.from.json': { version: 2, state: 'reconcile', screen: false, claim: nonce, side: 'local', account: 'alpha', count: 0 },
            }[p] ?? null),
            now,
        );
        expect(dropped.map(c => c.orderId)).toEqual(['ord-drop']);
    });
});
