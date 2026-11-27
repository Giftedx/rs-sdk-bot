import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Order, Receipt } from '../../core/src/fleet-trade-settlement';
import type { LogoutProof } from '../../core/src/session-lifecycle';
import {
    marketCooldownKey,
    validateWorldSnapshot,
    type AccountState,
    type ActivityDefinition,
    type GoalDemand,
    type WorldSnapshot,
} from '../src/contracts';
import { scheduleFleet } from '../src/scheduler';
import { DEFAULT_LIVE_SERVER, loadWorldSnapshot } from '../src/snapshot';
import {
    RECEIVED_ITEM_HOLD_MS,
    TRANSFER_FAILURE_BASE_BACKOFF_MS,
    TRANSFER_FAILURE_MAX_BACKOFF_MS,
    backoffUntil,
    hubRouteCooldownKey,
    transferEvent,
    transferMemory,
    uniqueTradeableItemId,
} from '../src/transfer-memory';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const SERVER = DEFAULT_LIVE_SERVER;

function order(over: Partial<Order> = {}): Order {
    return {
        id: 'xfer-1-1',
        server: SERVER,
        from: 'Giver',
        to: 'Taker',
        item: 'Raw shark',
        itemId: 383,
        count: 10,
        start: NOW - 30 * MIN,
        end: NOW - 15 * MIN,
        ...over,
    };
}

function receipt(role: 'from' | 'to', state: 'settled' | 'failed' | 'reconcile' | 'prepared', at: number, detail = '', o: Order = order()): Receipt {
    return {
        version: 2,
        state,
        id: o.id,
        account: role === 'from' ? o.from : o.to,
        partner: role === 'from' ? o.to : o.from,
        role,
        side: 'local',
        server: SERVER,
        item: o.item,
        requested: o.count,
        claim: '00000000-0000-4000-8000-000000000001',
        count: state === 'settled' ? o.count : 0,
        ok: state === 'settled',
        at,
        detail,
    };
}

describe('transferEvent', () => {
    test('a settled receipt of the recipient is a receive at its time', () => {
        const ev = transferEvent(order(), [receipt('from', 'settled', NOW - 20 * MIN), receipt('to', 'settled', NOW - 19 * MIN)], NOW);
        expect(ev).toEqual({ kind: 'received', at: NOW - 19 * MIN, order: order() });
    });

    test('an open order with no terminal receipts is not an event yet', () => {
        const open = order({ end: NOW + 5 * MIN });
        expect(transferEvent(open, [receipt('from', 'prepared', NOW - MIN, 'trade claimed', open)], NOW)).toBeNull();
        expect(transferEvent(open, [], NOW)).toBeNull();
    });

    test('blames the donor for its own failure and the recipient that never came', () => {
        const stockShort = transferEvent(order(), [receipt('from', 'failed', NOW - 20 * MIN, 'Error: stock short: Raw shark 0 banked + 0 held < 10')], NOW);
        expect(stockShort).toMatchObject({ kind: 'failed', donorFault: true, recipientFault: false });

        const withdraw = transferEvent(order(), [
            receipt('from', 'reconcile', NOW - 20 * MIN, 'Error: sender withdrawal debit or pack credit not confirmed: Raw shark'),
            receipt('to', 'failed', NOW - 15 * MIN, 'Error: order window ended during work'),
        ], NOW);
        expect(withdraw).toMatchObject({ kind: 'failed', donorFault: true, recipientFault: false });

        const takerAbsent = transferEvent(order(), [receipt('from', 'reconcile', NOW - 15 * MIN, 'Error: order window ended during work')], NOW);
        expect(takerAbsent).toMatchObject({ kind: 'failed', donorFault: false, recipientFault: true });

        const giverAbsent = transferEvent(order(), [receipt('to', 'failed', NOW - 15 * MIN, 'Error: order window ended during work')], NOW);
        expect(giverAbsent).toMatchObject({ kind: 'failed', donorFault: true, recipientFault: false });

        const takerRoute = transferEvent(order(), [
            receipt('from', 'failed', NOW - 16 * MIN, 'Error: partner failed: no trade'),
            receipt('to', 'failed', NOW - 17 * MIN, 'Error: route to 3185, 3436: precondition no route'),
        ], NOW);
        expect(takerRoute).toMatchObject({ kind: 'failed', donorFault: false, recipientFault: true });
    });

    test('an order that nobody ran, or both waited out, blames both; a stop file blames neither', () => {
        expect(transferEvent(order(), [], NOW)).toMatchObject({ kind: 'failed', at: NOW - 15 * MIN, donorFault: true, recipientFault: true });
        expect(transferEvent(order(), [
            receipt('from', 'failed', NOW - 15 * MIN, 'Error: order window ended during work'),
            receipt('to', 'failed', NOW - 15 * MIN, 'Error: order window ended during work'),
        ], NOW)).toMatchObject({ kind: 'failed', donorFault: true, recipientFault: true });
        expect(transferEvent(order(), [receipt('from', 'reconcile', NOW - 16 * MIN, 'stop file')], NOW)).toBeNull();
    });

    test('a failure older than the lookback is not an event', () => {
        const old = order({ start: NOW - 30 * 3_600_000, end: NOW - 29 * 3_600_000 });
        expect(transferEvent(old, [], NOW)).toBeNull();
    });
});

describe('transferMemory: a failed walk to the meet', () => {
    // A Varrock meet, with a different item in each order.
    const varrock = (id: string, itemId: number, item: string) => order({ id, itemId, item, meet: [{ x: 3183, z: 3440, level: 0 }, { x: 3182, z: 3440, level: 0 }] });
    const route = 'Error: route to 3182, 3440: precondition no route to 3182,3440,0';

    test('backs the party off the hub for every item; the partner that waited is not blamed', () => {
        const o = varrock('xfer-1795742816386-1', 1387, 'Staff of fire');
        const ev = transferEvent(o, [receipt('from', 'failed', NOW - 20 * MIN, 'Error: partner failed: no trade', o), receipt('to', 'failed', NOW - 20 * MIN, route, o)], NOW);
        expect(ev).toMatchObject({ kind: 'failed', recipientFault: true, donorFault: false, routeFault: ['taker'] });
        const mem = transferMemory([ev!], NOW);
        expect(mem.accountCooldowns.taker?.[hubRouteCooldownKey('varrock_west')]).toBe(NOW - 20 * MIN + TRANSFER_FAILURE_BASE_BACKOFF_MS);
        expect(mem.accountCooldowns.giver?.[hubRouteCooldownKey('varrock_west')]).toBeUndefined();
    });

    test('a donor fare fault backs the donor off the Ardougne hub, and two faults double the backoff', () => {
        const ardougne = (id: string, at: number) => {
            const o = order({ id, meet: [{ x: 2618, z: 3333, level: 0 }, { x: 2617, z: 3333, level: 0 }] });
            return transferEvent(o, [receipt('from', 'failed', at, 'Error: route to 2618, 3333: precondition ferry needs 60 coins and the bank holds 0', o), receipt('to', 'failed', at, 'Error: partner failed: no trade', o)], NOW)!;
        };
        const mem = transferMemory([ardougne('xfer-1-1', NOW - 40 * MIN), ardougne('xfer-2-1', NOW - 20 * MIN)], NOW);
        expect(mem.accountCooldowns.giver?.[hubRouteCooldownKey('ardougne')]).toBe(NOW - 20 * MIN + 2 * TRANSFER_FAILURE_BASE_BACKOFF_MS);
        expect(mem.accountCooldowns.taker?.[hubRouteCooldownKey('ardougne')]).toBeUndefined();
    });

    test('other own faults give no hub backoff', () => {
        const ev = transferEvent(order(), [receipt('from', 'failed', NOW - 20 * MIN, 'Error: stock short: Raw shark 0 banked + 0 held < 10')], NOW)!;
        expect(ev).not.toHaveProperty('routeFault');
        expect(Object.keys(transferMemory([ev], NOW).accountCooldowns.giver ?? {})).toEqual([]);
    });
});

describe('transferMemory', () => {
    test('keeps a received item for the hold window only', () => {
        const fresh = transferMemory([{ kind: 'received', at: NOW - 70 * MIN, order: order() }], NOW);
        expect(fresh.recentTransfers).toHaveLength(1);
        expect(fresh.recentTransfers[0]).toMatchObject({ to: 'Taker', state: 'settled', recipientLogoutConfirmedAt: NOW - 70 * MIN, items: [{ itemId: 383, count: 10 }] });
        const stale = transferMemory([{ kind: 'received', at: NOW - RECEIVED_ITEM_HOLD_MS - MIN, order: order() }], NOW);
        expect(stale.recentTransfers).toHaveLength(0);
    });

    test('resolves a name-only order line when one tradeable item has the name', () => {
        expect(uniqueTradeableItemId('Raw shark')).toBe(383);
        expect(uniqueTradeableItemId('Coins')).toBe(995);
        expect(uniqueTradeableItemId('Herb')).toBeUndefined();
        const named = order({ itemId: undefined, extra: [{ item: 'Herb', count: 5 }] });
        const mem = transferMemory([{ kind: 'received', at: NOW - 5 * MIN, order: named }], NOW);
        expect(mem.recentTransfers[0]?.items.map((l) => l.itemId)).toEqual([383]);
    });

    test('does not hold received coins', () => {
        const coins = order({ item: 'Coins', itemId: 995, count: 60 });
        expect(transferMemory([{ kind: 'received', at: NOW - 5 * MIN, order: coins }], NOW).recentTransfers).toHaveLength(0);
        const mixed = order({ extra: [{ item: 'Coins', itemId: 995, count: 60 }] });
        expect(transferMemory([{ kind: 'received', at: NOW - 5 * MIN, order: mixed }], NOW).recentTransfers[0]?.items.map((l) => l.itemId)).toEqual([383]);
    });

    test('backs off the donor venue at every hub and the recipient hub_banker venue, doubling per failure', () => {
        const fail = (at: number, donorFault: boolean, recipientFault: boolean) => ({ kind: 'failed' as const, at, order: order(), donorFault, recipientFault });
        const one = transferMemory([fail(NOW - 10 * MIN, true, false)], NOW);
        const until = NOW - 10 * MIN + TRANSFER_FAILURE_BASE_BACKOFF_MS;
        expect(one.marketCooldowns).toEqual({
            [marketCooldownKey(383, 'hub:varrock_west:giver')]: until,
            [marketCooldownKey(383, 'hub:ardougne:giver')]: until,
        });
        expect(one.accountCooldowns).toEqual({});

        const three = transferMemory([fail(NOW - 300 * MIN, false, true), fail(NOW - 200 * MIN, false, true), fail(NOW - 100 * MIN, false, true)], NOW);
        expect(three.marketCooldowns).toEqual({});
        expect(three.accountCooldowns).toEqual({ taker: { [marketCooldownKey(383, 'hub_banker')]: NOW - 100 * MIN + 4 * TRANSFER_FAILURE_BASE_BACKOFF_MS } });

        const expired = transferMemory([fail(NOW - TRANSFER_FAILURE_BASE_BACKOFF_MS - MIN, true, true)], NOW);
        expect(expired.marketCooldowns).toEqual({});
        expect(expired.accountCooldowns).toEqual({});
    });

    test('caps the backoff', () => {
        const times = Array.from({ length: 12 }, (_, i) => NOW - i * MIN);
        expect(backoffUntil(times)).toBe(NOW + TRANSFER_FAILURE_MAX_BACKOFF_MS);
        expect(backoffUntil([])).toBe(0);
    });
});

// Scheduler fixtures: Donor holds raw sharks, Cooker needs them to cook.
function acct(over: Partial<AccountState>): AccountState {
    return {
        name: 'Packhorse',
        side: 'local',
        role: 'helper',
        protectedClock: false,
        lifecycle: 'idle',
        skills: { Cooking: { level: 80, xp: 2_000_000 } },
        quests: {},
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: { 995: 1000 },
        equipment: {},
        bank: { items: { 995: 1000 }, observedAt: NOW - 10_000, trusted: true },
        ...over,
    };
}

const COOK: ActivityDefinition = {
    id: 'bank-artisan:cook-shark',
    workerId: 'bank-artisan',
    family: 'bank-artisan',
    kind: 'produce',
    label: 'Cook sharks',
    skill: 'Cooking',
    config: { skill: 'cooking', method: 'food', requiredLevel: 80 },
    baselineRate: { xpPerTick: 210, unitsPerTick: 0.25, gpPerTick: 15, setupTicks: 20, minBatchUnits: 50, confidence: 'practice', outputsPerUnit: { 385: 1 } },
    inputs: [{ itemId: 383, countPerUnit: 1 }],
    outputs: [{ itemId: 385, countPerUnit: 1 }],
    location: { x: 2817, z: 3443, level: 0 },
    trust: 'practice_passed',
};

const DEMANDS: GoalDemand[] = [
    { id: 'd:cooked', goalKind: 'main_supply', valueScore: 20, valuePerHour: 20, target: { kind: 'item', itemId: 385, count: 100 }, fulfilled: 0, remaining: 100, priorityWeight: 1, assignedAccount: 'Cooker', active: true },
];

function proof(name: string): LogoutProof {
    return {
        state: 'confirmed',
        account: name,
        server: SERVER,
        domain: 'live',
        attemptId: '1700000000000-0000000001-0000000001',
        loggedOutAt: NOW - 15_000,
        ownerRun: null,
        receiptSha256: 'a'.repeat(64),
    };
}

function world(accounts: Record<string, AccountState>, extra: Partial<WorldSnapshot> = {}): WorldSnapshot {
    return { schemaVersion: 1, at: NOW, side: 'local', server: SERVER, accounts, ...extra };
}

const PROOFS = new Map<string, LogoutProof>([['donor', proof('Donor')], ['cooker', proof('Cooker')], ['spare', proof('Spare')]]);
const schedule = (w: WorldSnapshot, activities: ActivityDefinition[] = [COOK], demands: GoalDemand[] = DEMANDS) =>
    scheduleFleet({ world: w, activities, demands, logoutProofs: PROOFS, requireMarketQuote: true, marketQuotes: {}, maxBots: 5 });

describe('scheduler with trade memory', () => {
    const donor = acct({ name: 'Donor', skills: { Cooking: { level: 1, xp: 0 } }, bank: { items: { 383: 400, 995: 5000 }, observedAt: NOW - 5000, trusted: true } });
    const cooker = acct({ name: 'Cooker' });

    test('a donor that received the item inside the hold does not give it away', () => {
        const base = schedule(world({ Donor: donor, Cooker: cooker }));
        expect(base.transferOrders.map((o) => `${o.from}->${o.to}`)).toEqual(['Donor->Cooker']);

        const received = transferMemory([{ kind: 'received', at: NOW - 70 * MIN, order: order({ id: 'xfer-0-1', from: 'Other', to: 'Donor' }) }], NOW);
        const held = schedule(world({ Donor: donor, Cooker: cooker }, { recentTransfers: received.recentTransfers }));
        expect(validateWorldSnapshot(world({ Donor: donor, Cooker: cooker }, { recentTransfers: received.recentTransfers }))).toEqual([]);
        expect(held.transferOrders).toHaveLength(0);

        const old = transferMemory([{ kind: 'received', at: NOW - RECEIVED_ITEM_HOLD_MS - MIN, order: order({ id: 'xfer-0-1', from: 'Other', to: 'Donor' }) }], NOW);
        expect(old.recentTransfers).toHaveLength(0);
    });

    test('a donor in failure backoff is not planned again; another donor is', () => {
        const spare = acct({ name: 'Spare', skills: { Cooking: { level: 1, xp: 0 } }, pos: { x: 3190, z: 3440, level: 0 }, bank: { items: { 383: 400, 995: 5000 }, observedAt: NOW - 5000, trusted: true } });
        const failed = transferMemory([{ kind: 'failed', at: NOW - 5 * MIN, order: order({ from: 'Donor', to: 'Cooker' }), donorFault: true, recipientFault: false }], NOW);
        const plan = schedule(world({ Donor: donor, Spare: spare, Cooker: cooker }, { marketCooldowns: failed.marketCooldowns }));
        expect(plan.transferOrders.map((o) => `${o.from}->${o.to}`)).toEqual(['Spare->Cooker']);
    });

    test('a recipient in failure backoff gets no hub transfer for that item', () => {
        const failed = transferMemory([{ kind: 'failed', at: NOW - 5 * MIN, order: order({ from: 'Donor', to: 'Cooker' }), donorFault: false, recipientFault: true }], NOW);
        const cooling = acct({ name: 'Cooker', cooldowns: failed.accountCooldowns.cooker });
        const plan = schedule(world({ Donor: donor, Cooker: cooling }));
        expect(plan.transferOrders).toHaveLength(0);
    });

    test('two items from one donor in one plan move in one order', () => {
        const stew: ActivityDefinition = {
            ...COOK,
            id: 'bank-artisan:cook-combo',
            inputs: [{ itemId: 383, countPerUnit: 1 }, { itemId: 371, countPerUnit: 1 }],
        };
        const both = acct({ name: 'Donor', skills: { Cooking: { level: 1, xp: 0 } }, bank: { items: { 383: 400, 371: 400, 995: 5000 }, observedAt: NOW - 5000, trusted: true } });
        const plan = schedule(world({ Donor: both, Cooker: cooker }), [stew]);
        expect(plan.transferOrders).toHaveLength(1);
        const only = plan.transferOrders[0]!;
        expect(only.items.map((l) => l.itemId).sort()).toEqual([371, 383]);
        const stamped = (plan.accountPlans.Cooker?.steps ?? [])
            .filter((s) => s.stepKind === 'acquire' && s.source === 'hub_banker')
            .map((s) => (s.stepKind === 'acquire' ? s.transferOrderId : undefined));
        expect(stamped).toEqual([only.id, only.id]);
    });
});

describe('snapshot reads trade memory from order and receipt files', () => {
    let root = '';
    const writeJson = (file: string, data: unknown) => {
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, JSON.stringify(data, null, 1), 'utf8');
    };
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'brain-trade-memory-')); });
    afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

    test('a settled order becomes a recent transfer and a failed one a donor cooldown', () => {
        const fleetDir = join(root, '.practice', 'live', 'fleet-data', 'fleet');
        writeJson(join(fleetDir, 'owners.json'), {
            accounts: { Giver: { side: 'local', server: SERVER }, Taker: { side: 'local', server: SERVER } },
        });
        const settled = order({ id: 'xfer-10-1' });
        writeJson(join(fleetDir, 'orders', `${settled.id}.json`), settled);
        writeJson(join(fleetDir, 'receipts', `${settled.id}.from.json`), receipt('from', 'settled', NOW - 20 * MIN, 'transfer observed', settled));
        writeJson(join(fleetDir, 'receipts', `${settled.id}.to.json`), receipt('to', 'settled', NOW - 20 * MIN, 'transfer observed', settled));
        const failed = order({ id: 'xfer-11-1', item: 'Raw swordfish', itemId: 371 });
        writeJson(join(fleetDir, 'orders', `${failed.id}.json`), failed);
        writeJson(join(fleetDir, 'receipts', `${failed.id}.from.json`), receipt('from', 'failed', NOW - 20 * MIN, 'Error: stock short: Raw swordfish 0 banked + 0 held < 10', failed));

        const snap = loadWorldSnapshot({ root, now: NOW });
        expect(validateWorldSnapshot(snap)).toEqual([]);
        expect(snap.recentTransfers?.map((t) => `${t.id}:${t.to}`)).toEqual(['xfer-10-1:Taker']);
        expect(snap.marketCooldowns?.[marketCooldownKey(371, 'hub:varrock_west:giver')]).toBe(NOW - 20 * MIN + TRANSFER_FAILURE_BASE_BACKOFF_MS);
        expect(snap.marketCooldowns?.[marketCooldownKey(383, 'hub:varrock_west:giver')]).toBeUndefined();
    });
});
