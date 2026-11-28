import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLEET_STATE_SCHEMA_VERSION, type FleetState } from '../../brain/src/index';
import { liveRoot } from '../../core/src/practice-paths';
import { readActiveOrdersAndReceipts } from '../src/fleet-agent';
import { brainBusyAccounts } from '../src/fleet-sync';

const dirs: string[] = [];
const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-active-orders-test-'));
    dirs.push(d);
    return d;
};

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeOrder(id: string, end: number) {
    return {
        id,
        server: 'rs-sdk-demo.fly.dev',
        from: 'Donor',
        to: 'Taker',
        item: 'Coins',
        count: 1000,
        start: end - 600_000,
        end,
        meet: [{ x: 3222, z: 3218, level: 0 }, { x: 3223, z: 3218, level: 0 }],
    };
}

describe('fleet active order cache and brainBusyAccounts', () => {
    test('readActiveOrdersAndReceipts drops expired orders and unrelated receipts while keeping running orders', () => {
        const dir = scratch();
        mkdirSync(join(dir, 'orders'), { recursive: true });
        mkdirSync(join(dir, 'receipts'), { recursive: true });
        const now = 2_000_000;

        writeFileSync(join(dir, 'orders', 'expired-old.json'), JSON.stringify(makeOrder('expired-old', now - 10_000)));
        writeFileSync(join(dir, 'orders', 'expired-running.json'), JSON.stringify(makeOrder('expired-running', now - 5_000)));
        writeFileSync(join(dir, 'orders', 'active-1.json'), JSON.stringify(makeOrder('active-1', now + 60_000)));
        writeFileSync(join(dir, 'receipts', 'expired-old.from.json'), JSON.stringify({ id: 'expired-old', role: 'from', ok: true }));
        writeFileSync(join(dir, 'receipts', 'active-1.from.json'), JSON.stringify({ id: 'active-1', role: 'from', ok: true }));

        const running = new Map<string, string>([['donor', 'expired-running']]);
        const pass1 = readActiveOrdersAndReceipts(dir, now, running);
        expect(pass1.orders.map(o => o.id).sort()).toEqual(['active-1', 'expired-running']);
        expect(pass1.receipts.map(r => r.id)).toEqual(['active-1']);

        // Second pass hits the expired stamp cache cleanly and drops expired-running once no longer running.
        const pass2 = readActiveOrdersAndReceipts(dir, now, new Map());
        expect(pass2.orders.map(o => o.id)).toEqual(['active-1']);
        expect(pass2.receipts.map(r => r.id)).toEqual(['active-1']);
    });

    test('brainBusyAccounts skips paused, protected, existing, and hub-banker trade chains without loading catalog', () => {
        const base = scratch();
        mkdirSync(liveRoot(base), { recursive: true });
        const now = 5_000_000;
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
        const workStep = {
            stepKind: 'work' as const,
            activityId: 'skiller:fishing:cage',
            demandId: 'd:fish',
            workerId: 'skiller',
            batchUnits: 1,
            estimatedTicks: 100,
            expectedValuePerHour: 100,
            config: { skill: 'fishing', method: 'cage' },
        };
        const tradeStep = {
            stepKind: 'acquire' as const,
            itemId: 995,
            quantity: 1000,
            source: 'hub_banker' as const,
            estimatedTicks: 50,
            estimatedCoinCost: 0,
            coinFloatPreserved: 0,
        };
        const state: FleetState = {
            schemaVersion: FLEET_STATE_SCHEMA_VERSION,
            emittedAt: now - 1000,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            maxBots: 5,
            accounts: {
                worker1: mkAcct('Worker1', 'idle'),
                paused1: mkAcct('Paused1', 'paused_owner'),
                protected1: mkAcct('Protected1', 'reserved', true),
                transfer1: mkAcct('Transfer1', 'idle'),
                hand1: mkAcct('Hand1', 'idle'),
            },
            activeChains: {
                Worker1: { account: 'Worker1', demandId: 'd:fish', scorePerHour: 100, steps: [workStep] },
                Paused1: { account: 'Paused1', demandId: 'd:fish', scorePerHour: 100, steps: [workStep] },
                Protected1: { account: 'Protected1', demandId: 'd:fish', scorePerHour: 100, steps: [workStep] },
                Transfer1: { account: 'Transfer1', demandId: 'd:fish', scorePerHour: 100, steps: [tradeStep, workStep] },
                Hand1: { account: 'Hand1', demandId: 'd:fish', scorePerHour: 100, steps: [workStep] },
            },
            idleReasons: {},
            goals: [],
            campaigns: [],
            missions: [],
            pendingTransfers: [],
            quarantinedDefects: [],
        };
        writeFileSync(join(liveRoot(base), 'fleet-state.json'), JSON.stringify(state));

        expect(brainBusyAccounts(base, [{ account: 'Hand1', enabled: true }], now)).toEqual(['Worker1']);
    });
});
