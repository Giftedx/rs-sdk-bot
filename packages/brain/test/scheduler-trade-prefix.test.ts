import { expect, test } from 'bun:test';
import type { LogoutProof } from '../../core/src/session-lifecycle';
import type { AccountState, ActivityDefinition } from '../src/contracts';
import { xpForLevel } from '../src/planner';
import { scheduleFleet } from '../src/scheduler';

// The next snapshot names the recipient of an open order in_trade (snapshot.ts readOrdersAndReceipts), and the swarm
// drops a running job of that account. A plan with a step before its hub trade therefore stages no order: it runs
// that step first, and a later cycle that plans the trade first stages the order.

const NOW = 1_800_000_000_000;
const SERVER = 'rs-sdk-demo.fly.dev';

const ACTIVITIES: ActivityDefinition[] = [
    {
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
    },
    {
        id: 'bank-artisan:cook-trainer',
        workerId: 'bank-artisan',
        family: 'bank-artisan',
        kind: 'train',
        label: 'Train Cooking without inputs',
        skill: 'Cooking',
        config: { skill: 'cooking', method: 'trainer', requiredLevel: 1 },
        baselineRate: { xpPerTick: 500, unitsPerTick: 0.25, gpPerTick: 0, setupTicks: 10, minBatchUnits: 1, confidence: 'practice' },
        location: { x: 2817, z: 3443, level: 0 },
        trust: 'practice_passed',
    },
];

function account(name: string, cooking: number, bank: Record<number, number>, pos = { x: 3185, z: 3436, level: 0 }): AccountState {
    return {
        name,
        side: 'local',
        role: 'helper',
        protectedClock: false,
        lifecycle: 'idle',
        skills: { Cooking: { level: cooking, xp: xpForLevel(cooking) } },
        quests: {},
        pos,
        inventory: { 995: 1000 },
        equipment: {},
        bank: { items: bank, observedAt: NOW - 5000, trusted: true },
    };
}

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

function schedule(cooking: number) {
    const donor = account('Donor', 1, { 383: 400, 995: 5000 });
    const cook = account('Cooker', cooking, { 995: 1000 }, { x: 2619, z: 3332, level: 0 });
    return scheduleFleet({
        world: { schemaVersion: 1, at: NOW, side: 'local', server: SERVER, accounts: { Donor: donor, Cooker: cook } },
        activities: ACTIVITIES,
        demands: [{ id: 'd:cooked', goalKind: 'main_supply', valueScore: 20, valuePerHour: 20, target: { kind: 'item', itemId: 385, count: 100 }, fulfilled: 0, remaining: 100, priorityWeight: 1, assignedAccount: 'Cooker', active: true }],
        logoutProofs: new Map<string, LogoutProof>([['donor', proof('Donor')], ['cooker', proof('Cooker')]]),
        stationedHubBankers: { ardougne: 'Moneyshot', varrock_west: 'Coinpurse' },
        requireMarketQuote: true,
        marketQuotes: {},
        maxBots: 5,
    });
}

test('a plan that starts with its hub trade stages the order', () => {
    const plan = schedule(80);
    expect(plan.accountPlans.Cooker?.steps[0]?.stepKind).toBe('acquire');
    expect(plan.transferOrders.length).toBe(1);
});

test('a plan with an unlock before its hub trade stages no order', () => {
    const plan = schedule(79);
    const steps = plan.accountPlans.Cooker?.steps ?? [];
    expect(steps[0]?.stepKind).toBe('unlock');
    expect(steps.some((s) => s.stepKind === 'acquire' && s.source === 'hub_banker')).toBe(true);
    expect(plan.transferOrders).toEqual([]);
    expect(steps.some((s) => s.stepKind === 'acquire' && s.transferOrderId !== undefined)).toBe(false);
});
