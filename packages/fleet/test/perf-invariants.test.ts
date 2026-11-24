import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveRoot, liveStatusDir, practiceRoot } from '../../core/src/practice-paths';
import { beginSessionAttempt } from '../../core/src/session-lifecycle';
import { RECOVERY_SCHEMA } from '../../core/src/session-recovery-permit';
import { WORKER_FAMILIES } from '../../workers/src/contracts';
import { materializeBrainTransferOrders } from '../src/brain-runtime';
import { managedCommands, mayRestart, observeNormalOwners, worktreeSetupResult } from '../src/cloud-side';
import { courierCargo, courierDeliveryWaiting } from '../src/courier-admission';
import { dueTrades } from '../src/fleet-agent';
import { droppedTradeClaims, planView, releasePublishedTradeClaims, snapshot } from '../src/fleet-sync';
import { InfraCircuitBreaker } from '../src/infra-circuit-breaker';
import { importClosure } from '../src/live-update/inspect';
import { findCurrentNativeRecoveryQualification, runControlledDispatchOne, spentStandaloneAttempts } from '../src/session-recovery';
import { overlappingRun, readAllStatuses } from '../src/swarm';
import { buildOrderPicker, pickOrder } from '../src/trade-plan';
import { resolveWorkerModule, UNIFIED_WORKER_MODULES } from '../src/worker-dispatch';

const dirs: string[] = [];
const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-perf-inv-'));
    dirs.push(d);
    return d;
};

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('fleet perf cache and index invariants', () => {
    test('readAllStatuses refreshes immediately on same-second overwrites and mtime/size changes', () => {
        const root = scratch();
        const dir = liveStatusDir(root);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, 'CacheBot.json');

        writeFileSync(file, JSON.stringify({ name: 'CacheBot', server: 'rs-sdk-demo.fly.dev', at: 1000, tick: 1 }));
        expect((readAllStatuses(root) as any[])[0]?.tick).toBe(1);

        // Overwrite within the same second (must not serve stale cached entry).
        writeFileSync(file, JSON.stringify({ name: 'CacheBot', server: 'rs-sdk-demo.fly.dev', at: 1001, tick: 2 }));
        expect((readAllStatuses(root) as any[])[0]?.tick).toBe(2);

        // Backdate > 1s to enter steady-state cache, then change content + mtime.
        const past = new Date(Date.now() - 10_000);
        utimesSync(file, past, past);
        expect((readAllStatuses(root) as any[])[0]?.tick).toBe(2);

        writeFileSync(file, JSON.stringify({ name: 'CacheBot', server: 'rs-sdk-demo.fly.dev', at: 2000, tick: 33 }));
        const newerPast = new Date(Date.now() - 5_000);
        utimesSync(file, newerPast, newerPast);
        expect((readAllStatuses(root) as any[])[0]?.tick).toBe(33);
    });

    test('buildOrderPicker and dueTrades match pickOrder semantics across roles and receipts', () => {
        const now = 1_700_000_000_000;
        const orders: any[] = [
            { id: 'o1', server: 'rs-sdk-demo.fly.dev', from: 'Alpha', to: 'Beta', item: 'Shark', count: 10, start: now - 500, end: now + 60_000 },
            { id: 'o2', server: 'rs-sdk-demo.fly.dev', from: 'Alpha', to: 'Gamma', item: 'Lobster', count: 20, start: now - 1000, end: now + 60_000 },
            { id: 'o3', server: 'rs-sdk-demo.fly.dev', from: 'Delta', to: 'Alpha', item: 'Coins', count: 500, start: now + 100, end: now + 60_000 },
        ];
        const receipts: any[] = [
            { id: 'o2', role: 'to', version: 2, state: 'failed' },
            { id: 'o1', role: 'from', ok: true },
        ];
        const pick = buildOrderPicker(orders, receipts);
        for (const acct of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
            expect(pick(acct, now, 10_000)).toEqual(pickOrder(orders, receipts, acct, now, 10_000));
        }

        const owners = new Map([
            ['alpha', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
            ['beta', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
            ['gamma', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
            ['delta', { side: 'cloud', server: 'rs-sdk-demo.fly.dev' }],
        ]);
        const due = dueTrades(orders, receipts, 'local', owners, new Set(['beta']), new Set(), now, 10_000);
        expect(due.map(d => `${d.account}:${d.order.id}:${d.busy}`).sort()).toEqual([
            'Alpha:o3:false',
            'Beta:o1:true',
        ]);
    });

    test('materializeBrainTransferOrders deduplicates cached orders and writes new ones', () => {
        const root = scratch();
        const fleetDir = join(root, 'fleet');
        mkdirSync(join(fleetDir, 'orders'), { recursive: true });
        mkdirSync(join(fleetDir, 'receipts'), { recursive: true });
        const now = 1_700_000_000_000;
        const world: any = {
            accounts: {
                alpha: { name: 'Alpha', side: 'local' },
                beta: { name: 'Beta', side: 'local' },
                gamma: { name: 'Gamma', side: 'cloud' },
            },
        };
        const firstOrder: any = {
            id: 'ord-existing',
            server: 'rs-sdk-demo.fly.dev',
            from: 'Alpha',
            to: 'Beta',
            hub: 'varrock_west',
            items: [{ itemId: 385, itemName: 'Shark', count: 5 }],
            expiresAt: now + 600_000,
        };
        const firstRun = materializeBrainTransferOrders([firstOrder], { fleetDir, side: 'local', world, now });
        expect(firstRun).toEqual({ written: ['ord-existing'], skipped: [] });

        // Backdate existing order so cache path is hit, then verify dedup + new order write.
        const existingFile = join(fleetDir, 'orders', 'ord-existing.json');
        const oldDate = new Date(Date.now() - 10_000);
        utimesSync(existingFile, oldDate, oldDate);

        const secondOrder: any = {
            id: 'ord-new',
            server: 'rs-sdk-demo.fly.dev',
            from: 'Alpha',
            to: 'Gamma',
            hub: 'varrock_west',
            items: [{ itemId: 379, count: 10 }],
            expiresAt: now + 600_000,
        };
        const secondRun = materializeBrainTransferOrders([firstOrder, secondOrder], { fleetDir, side: 'local', world, now });
        expect(secondRun).toEqual({ written: ['ord-new'], skipped: ['ord-existing'] });
    });

    test('droppedTradeClaims resolves memoized owners and published side timestamps accurately', () => {
        const now = 1_700_000_500_000;
        const claims: any[] = [
            { account: 'alpha', server: 'rs-sdk-demo.fly.dev', side: 'local', orderId: 'o1', role: 'from', nonce: 'n1', phase: 'held', at: now - 4_000_000 },
            { account: 'beta', server: 'rs-sdk-demo.fly.dev', side: 'local', orderId: 'o2', role: 'from', nonce: 'n2', phase: 'held', at: now - 4_000_000 },
        ];
        const files: Record<string, any> = {
            'owners.json': { accounts: { Alpha: { side: 'local' }, Beta: { side: 'local' }, CloudPartner: { side: 'cloud' } } },
            'orders/o1.json': { id: 'o1', server: 'rs-sdk-demo.fly.dev', from: 'Alpha', to: 'CloudPartner', item: 'Shark', count: 10, start: now - 4_000_000, end: now - 3_700_000 },
            'orders/o2.json': { id: 'o2', server: 'rs-sdk-demo.fly.dev', from: 'Beta', to: 'CloudPartner', item: 'Shark', count: 10, start: now - 4_000_000, end: now - 50_000 },
            'receipts/o1.from.json': { version: 2, state: 'reconcile', claim: 'n1', side: 'local', account: 'Alpha', count: 0 },
            'receipts/o2.from.json': { version: 2, state: 'reconcile', claim: 'n2', side: 'local', account: 'Beta', count: 0 },
            'snapshots/cloud.json': { at: now - 10_000 },
        };
        let ownerReads = 0;
        const dropped = droppedTradeClaims(claims, 'local', p => {
            if (p === 'owners.json') ownerReads++;
            return files[p] ?? null;
        }, now);
        expect(dropped.map(c => c.orderId)).toEqual(['o1']);
        expect(ownerReads).toBe(1);
    });

    test('runControlledDispatchOne incremental tail finds result appended after prior non-matching lines', async () => {
        const root = scratch();
        const server = 'rs-sdk-demo.fly.dev';
        const lRoot = join(liveRoot(root), 'session-lifecycle');
        mkdirSync(lRoot, { recursive: true });
        mkdirSync(practiceRoot(root), { recursive: true });
        const attempt = beginSessionAttempt({ account: 'worker1', server }, { root: lRoot });
        attempt.record('ready');
        attempt.record('ended', 'logged-out');

        const source = 'a'.repeat(64);
        const capRev = 'b'.repeat(64);
        const resultsFile = join(practiceRoot(root), 'swarm-repair.json.results.jsonl');

        const otherRaw = JSON.stringify({ runId: 'other-run', nonce: 'other-nonce' });
        writeFileSync(resultsFile, JSON.stringify({ at: Date.now(), raw: otherRaw, result: { sessionRecovered: false } }) + '\n');

        const runId = 'inc-run-1';
        const nonce = 'inc-nonce-1';
        const timer = setTimeout(() => {
            const matchRaw = JSON.stringify({
                schema: RECOVERY_SCHEMA,
                kind: 'session-recovery',
                account: 'worker1',
                server,
                runId,
                nonce,
                endedAt: Date.now() - 1000,
                source,
                qualification: { delivery: { path: 'a', sha256: '0'.repeat(64) }, proof: { path: 'b', sha256: '1'.repeat(64) } },
            });
            appendFileSync(
                resultsFile,
                JSON.stringify({ at: Date.now(), raw: matchRaw, result: { changed: false, sessionRecovered: true, reason: 'ok' } }) + '\n',
            );
        }, 40);

        try {
            const res = await runControlledDispatchOne({
                root,
                account: 'worker1',
                endedAt: Date.now() - 1000,
                server,
                runId,
                nonce,
                source,
                qualification: { delivery: { path: 'a', sha256: '0'.repeat(64) }, proof: { path: 'b', sha256: '1'.repeat(64) } },
                timeoutMs: 2_000,
                pollMs: 15,
            });
            expect(res.ok).toBe(true);
            expect(findCurrentNativeRecoveryQualification(root, source, 0, Date.now(), capRev)).toBeNull();
        } finally {
            clearTimeout(timer);
        }
    });

    test('UNIFIED_WORKER_MODULES lazy getters preserve family enumeration, identity, and resolveWorkerModule parity', () => {
        expect(Object.keys(UNIFIED_WORKER_MODULES).sort()).toEqual([...WORKER_FAMILIES].sort());
        for (const family of WORKER_FAMILIES) {
            const mod = UNIFIED_WORKER_MODULES[family];
            expect(mod.family).toBe(family);
            expect(resolveWorkerModule(family)).toBe(mod);
        }
    });

    test('importClosure invalidates immediately on same-second edits and backdated mtime changes', () => {
        const root = scratch();
        const entry = join(root, 'entry.ts');
        const depA = join(root, 'dep-a.ts');
        const depB = join(root, 'dep-b.ts');
        writeFileSync(depA, 'export const a = 1;\n', 'utf8');
        writeFileSync(depB, 'export const b = 2;\n', 'utf8');
        writeFileSync(entry, "import { a } from './dep-a';\nexport const x = a;\n", 'utf8');

        expect(importClosure(['entry.ts'], root)).toEqual(['dep-a.ts', 'entry.ts']);

        // Same-second overwrite adding a second relative import must invalidate immediately.
        writeFileSync(entry, "import { a } from './dep-a';\nimport { b } from './dep-b';\nexport const x = a + b;\n", 'utf8');
        expect(importClosure(['entry.ts'], root)).toEqual(['dep-a.ts', 'dep-b.ts', 'entry.ts']);

        // Backdate > 1s to exercise stat-cached steady state, then update content and mtime.
        const past = new Date(Date.now() - 10_000);
        utimesSync(entry, past, past);
        expect(importClosure(['entry.ts'], root)).toEqual(['dep-a.ts', 'dep-b.ts', 'entry.ts']);

        writeFileSync(entry, "import type { Foo } from './dep-a';\nexport const x: Foo | number = 3;\n", 'utf8');
        const newerPast = new Date(Date.now() - 5_000);
        utimesSync(entry, newerPast, newerPast);
        // Type-only import is erased at runtime and excluded from closure.
        expect(importClosure(['entry.ts'], root)).toEqual(['entry.ts']);
    });

    test('courierDeliveryWaiting and courierCargo preserve multi-account job matching and trout separation guards', () => {
        const now = 1_700_000_000_000;
        expect(courierCargo([{ id: 333, name: 'Trout', count: 2 }, { id: 334, name: 'Trout', count: 5 }], 2).blocked).toEqual([
            'Trout: need-bank-separation',
        ]);
        expect(courierCargo([{ id: 333, name: 'Trout', count: 4 }, { id: 995, name: 'Coins', count: 500 }], 2)).toEqual({
            items: [{ name: 'Trout', count: 2 }],
            blocked: [],
        });

        const jobs = [
            { accounts: ['HaulerA', 'HaulerB'], script: 'scripts/aio-logistics.ts', args: ['food-courier'], env: { OUTBOUND_ONLY: '1' } },
        ];
        const waiting = courierDeliveryWaiting(
            ['HaulerB'],
            undefined,
            jobs,
            () => ({ name: 'HaulerB', at: now - 1000, server: 'rs-sdk-demo.fly.dev', inventory: [{ id: 379, name: 'Lobster', count: 10 }] }),
            now,
        );
        expect(waiting).toBe(false);
    });

    test('InfraCircuitBreaker.snapshot returns an isolated deep copy of all fault buckets', () => {
        const breaker = new InfraCircuitBreaker({ now: () => 1_700_000_000_000, random: () => 0.5 });
        breaker.recordFailure('ERR_PROXY_CONNECTION_FAILED', 'proxy');
        const snap = breaker.snapshot();
        snap.faults.proxy.consecutiveFailures = 999;
        snap.faults.proxy.lastError = 'mutated';
        expect(breaker.snapshot().faults.proxy.consecutiveFailures).toBe(1);
        expect(breaker.snapshot().faults.proxy.lastError).toBe('ERR_PROXY_CONNECTION_FAILED');
    });

    test('cloud-side managedCommands, mayRestart, observeNormalOwners, and worktreeSetupResult preserve safety and bounds', () => {
        const now = 1_700_000_000_000;
        expect(managedCommands(false, 'swarm.json')).toEqual({
            swarm: ['scripts/swarm.ts', 'swarm.json'],
            'fleet-agent': ['scripts/fleet-agent.ts'],
        });
        expect(managedCommands(true, 'swarm.json')).toEqual({ swarm: ['scripts/swarm.ts', 'swarm.json'] });

        expect(mayRestart([now - 3_600_000, now - 3_600_001, now - 20_000, now - 15_000, now - 10_000, now - 5_000, now - 1_000], now)).toBe(true);
        expect(mayRestart([now - 3_599_999, now - 200_000, now - 100_000, now - 50_000, now - 10_000, now - 1_000], now)).toBe(false);

        let retained = '';
        const res = worktreeSetupResult(
            {
                status: 1,
                stdout: '\u001b[31mworktree-setup: SDK patch: FAILED\u001b[0m\nsecret=topsecretvalue',
                stderr: 'Authorization: Bearer mytoken123',
            },
            (out) => { retained = out; },
            { MY_SECRET_TOKEN: 'topsecretvalue' },
        );
        expect(res.ok).toBe(false);
        expect(res.detail).toContain('SDK patch: FAILED');
        expect(retained).not.toContain('topsecretvalue');
        expect(retained).not.toContain('mytoken123');
        expect(retained).toContain('[redacted]');

        const root = scratch();
        mkdirSync(join(root, '.practice'), { recursive: true });
        const ownerView = observeNormalOwners(root, join(root, 'swarm.json'), 'local', {}, {
            alive: (pid) => pid === 4242,
            processes: () => [4242],
            command: () => 'bun scripts/swarm.ts swarm.json',
            groups: () => [],
        });
        expect(ownerView.known).toBe(false);
        expect(ownerView.reason).toContain('normal migration waits for unowned swarm to settle');
    });

    test('session-recovery spentStandaloneAttempts, fleet-sync snapshot/planView/claims, swarm overlappingRun, and fleet-agent dueTrades parity', () => {
        const now = 1_700_000_000_000;
        expect(spentStandaloneAttempts([
            { at: now - 100, account: 'Alpha', endedAt: 500, ok: false, reason: 'err' },
            { at: now - 90, account: 'alpha', endedAt: 500, ok: false, infraFault: true, reason: 'proxy' },
            { at: now - 80, account: 'alpha', endedAt: 500, ok: true, reason: 'ok' },
            { at: now - 70, account: 'ALPHA', endedAt: 500, ok: false, reason: 'err2' },
        ], 'Alpha', 500)).toBe(2);

        const owners = new Map<string, any>([
            ['alpha', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
            ['beta', { side: 'cloud', server: 'rs-sdk-demo.fly.dev' }],
        ]);
        const snap = snapshot([
            {
                name: 'Alpha',
                server: 'rs-sdk-demo.fly.dev',
                at: now - 1000,
                skills: [{ name: 'Attack', level: 50, xp: 101333 }, { name: 'Bad', level: 0 }],
                quests: [{ name: 'Cooks Assistant', state: 'complete' }, { name: 'Sheep Shearer', state: 'started' }],
            },
            { name: 'Beta', server: 'rs-sdk-demo.fly.dev', at: now },
        ], 'local', owners, now);
        expect(snap.accounts).toHaveLength(1);
        expect(snap.accounts[0]?.skills).toEqual([{ name: 'Attack', level: 50, xp: 101333 }]);
        expect(snap.accounts[0]?.quests).toEqual(['Cooks Assistant']);

        const pv = planView([
            { account: 'Alpha', script: 'scripts/aio.ts', enabled: true, extraDrop: 1 },
            { account: 'Alpha', role: 'main', script: 'scripts/aio.ts', enabled: true },
            { account: 'Beta', script: 'scripts/aio.ts', enabled: true },
        ], 'local', owners, now);
        expect(pv.jobs).toEqual([{ account: 'Alpha', script: 'scripts/aio.ts', enabled: true }]);

        const runSet = new Set([{ accounts: ['Beta', 'Gamma'], pid: 1 }, { accounts: ['Alpha'], pid: 2 }]);
        expect(overlappingRun(runSet, ['ALPHA'])?.pid).toBe(2);
        expect(overlappingRun(runSet, ['Missing'])).toBeUndefined();

        const orders = [{ id: 'o1', from: 'Alpha', to: 'Beta', server: 'rs-sdk-demo.fly.dev', at: now - 1000, end: now + 60_000 }] as any[];
        expect(dueTrades(orders, [], 'local', owners, new Set(), new Set(), now)).toHaveLength(1);
        expect(dueTrades(orders, [], 'local', owners, new Set(), new Set(['alpha']), now)).toEqual([]);

        const releasedCount = releasePublishedTradeClaims([
            { orderId: 'ord-1', role: 'from', side: 'local', account: 'Alpha', server: 'rs-sdk-demo.fly.dev', phase: 'held', at: now - 20_000, nonce: 'n1' },
            { orderId: 'ord-1', role: 'to', side: 'local', account: 'Beta', server: 'rs-sdk-demo.fly.dev', phase: 'held', at: now - 20_000, nonce: 'n2' },
        ] as any[], 'local', () => null, () => {}, now);
        expect(releasedCount).toBe(0);
    });
});
