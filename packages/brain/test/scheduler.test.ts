import { expect, test } from 'bun:test';
import type { LogoutProof } from '../../core/src/session-lifecycle';
import {
    isFleetPlan,
    isFleetState,
    type AccountState,
    type ActivityDefinition,
    type GoalDemand,
    type Mission,
    type TransferOrder,
    type WorldSnapshot,
} from '../src/contracts';
import { buildFleetState, scheduleFleet } from '../src/scheduler';

const NOW = 1_700_000_000_000;

function makeAcct(overrides: Partial<AccountState> = {}): AccountState {
    return {
        name: 'Packhorse',
        side: 'local',
        role: 'helper',
        protectedClock: false,
        lifecycle: 'idle',
        skills: {
            Fishing: { level: 76, xp: 1_350_000 },
            Cooking: { level: 80, xp: 2_000_000 },
            Thieving: { level: 60, xp: 280_000 },
        },
        quests: { cook: 'complete' },
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: { 995: 5000 },
        equipment: {},
        bank: {
            items: { 995: 50_000, 383: 200 },
            observedAt: NOW - 10_000,
            trusted: true,
        },
        ...overrides,
    };
}

const ACTIVITIES: ActivityDefinition[] = [
    {
        id: 'gather:fishing-shark',
        workerId: 'gather',
        family: 'gather',
        kind: 'gather',
        label: 'Catch sharks',
        skill: 'Fishing',
        spotId: 'catherby-sharks',
        maxConcurrentAccounts: 1,
        config: { skill: 'fishing', method: 'shark', requiredLevel: 76 },
        baselineRate: { xpPerTick: 100, unitsPerTick: 0.1, gpPerTick: 50, setupTicks: 20, minBatchUnits: 50, confidence: 'practice', outputsPerUnit: { 383: 1 } },
        outputs: [{ itemId: 383, countPerUnit: 1 }],
        location: { x: 2835, z: 3432, level: 0 },
        trust: 'practice_passed',
    },
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
        id: 'gather:thieving-knights',
        workerId: 'gather',
        family: 'gather',
        kind: 'gather',
        label: 'Pickpocket knights',
        skill: 'Thieving',
        config: { skill: 'thieving', method: 'knights', requiredLevel: 55 },
        baselineRate: { xpPerTick: 84, unitsPerTick: 0.35, gpPerTick: 35, setupTicks: 20, minBatchUnits: 100, confidence: 'practice' },
        location: { x: 2654, z: 3294, level: 0 },
        trust: 'practice_passed',
    },
];

function confirmedProof(name: string): LogoutProof {
    return {
        state: 'confirmed',
        account: name,
        server: 'rs-sdk-demo.fly.dev',
        domain: 'live',
        attemptId: '1700000000000-0000000001-0000000001',
        loggedOutAt: NOW - 15_000,
        ownerRun: null,
        receiptSha256: 'a'.repeat(64),
    };
}

test('unblock order prioritizes needs_logout_recovery by frozen GP+supply value, then needs_location_recovery, then idle under maxBots', () => {
    const lowLogout = makeAcct({ name: 'LogLow', lifecycle: 'needs_logout_recovery', inventory: { 995: 100 }, bank: { items: {}, observedAt: NOW - 5000, trusted: true } });
    const highLogout = makeAcct({ name: 'LogHigh', lifecycle: 'needs_logout_recovery', inventory: { 995: 500_000 }, bank: { items: { 383: 500 }, observedAt: NOW - 5000, trusted: true } });
    const locRec = makeAcct({ name: 'LocStranded', lifecycle: 'needs_location_recovery', inventory: { 995: 900_000 } });
    const idleAcct = makeAcct({ name: 'IdleOne', lifecycle: 'idle' });
    const pausedAcct = makeAcct({ name: 'PausedOne', lifecycle: 'paused_owner' });
    const haggis = makeAcct({ name: 'Haggis', role: 'main', protectedClock: true, lifecycle: 'needs_logout_recovery', inventory: { 995: 9_999_999 } });

    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: {
            LogLow: lowLogout,
            LogHigh: highLogout,
            LocStranded: locRec,
            IdleOne: idleAcct,
            PausedOne: pausedAcct,
            Haggis: haggis,
        },
    };
    const demands: GoalDemand[] = [
        { id: 'd:coins', goalKind: 'coin_fund', valueScore: 10, valuePerHour: 10, target: { kind: 'coins', amount: 10_000 }, fulfilled: 0, remaining: 10_000, priorityWeight: 1, active: true },
    ];

    // maxBots=2: only LogHigh and LogLow get slots; LocStranded & IdleOne wait for maxBots; Haggis stays excluded!
    const plan2 = scheduleFleet({ world, activities: ACTIVITIES, demands, maxBots: 2 });
    expect(isFleetPlan(plan2)).toBe(true);
    expect(plan2.recoveryQueue.map((r) => r.account)).toEqual(['LogHigh', 'LogLow', 'LocStranded']);
    expect(plan2.selectedSlots).toBe(2);
    expect(plan2.accountPlans.LogHigh?.steps[0]?.stepKind).toBe('recover');
    expect(plan2.accountPlans.LogLow?.steps[0]?.stepKind).toBe('recover');
    expect(plan2.accountPlans.LocStranded?.idleReason).toBe('max_bots_limit');
    expect(plan2.accountPlans.IdleOne?.idleReason).toBe('max_bots_limit');
    expect(plan2.accountPlans.Haggis?.steps).toEqual([]);
    expect(plan2.accountPlans.PausedOne?.idleReason).toBe('paused_owner');

    // maxBots=4: LogHigh, LogLow, LocStranded, and IdleOne all run.
    const plan4 = scheduleFleet({ world, activities: ACTIVITIES, demands, maxBots: 4 });
    expect(plan4.selectedSlots).toBe(4);
    expect(plan4.accountPlans.LocStranded?.steps[0]?.stepKind).toBe('recover');
    expect(plan4.accountPlans.IdleOne?.steps[0]?.stepKind).toBe('work');
});

test('enforces +15% retention hysteresis on healthy running accounts and shared spot capacity', () => {
    const runner = makeAcct({
        name: 'Runner',
        role: 'auto',
        skills: { Fishing: { level: 76, xp: 1_350_000 }, Cooking: { level: 1, xp: 0 }, Thieving: { level: 60, xp: 280_000 } },
        lifecycle: 'running',
        activeJob: { activityId: 'gather:thieving-knights', demandId: 'd:current', startedAt: NOW - 60_000 },
    });
    const idle1 = makeAcct({ name: 'FisherOne', lifecycle: 'idle' });
    const idle2 = makeAcct({ name: 'FisherTwo', lifecycle: 'idle' });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { Runner: runner, FisherOne: idle1, FisherTwo: idle2 },
    };

    // Current job yields 10/hr; alternative yields 11/hr (+10% <= +15%) -> retained!
    const retainedPlan = scheduleFleet({
        world,
        activities: ACTIVITIES,
        demands: [
            { id: 'd:current', goalKind: 'coin_fund', valueScore: 10, valuePerHour: 10, target: { kind: 'coins', amount: 10_000 }, fulfilled: 0, remaining: 10_000, priorityWeight: 1, active: true },
            { id: 'd:alt', goalKind: 'main_supply', valueScore: 11, valuePerHour: 11, target: { kind: 'item', itemId: 383, count: 100 }, fulfilled: 0, remaining: 100, priorityWeight: 1, active: true },
        ],
        maxBots: 5,
    });
    expect(retainedPlan.accountPlans.Runner?.demandId).toBe('d:current');
    expect(retainedPlan.accountPlans.Runner?.retentionMarginApplied).toBe(true);

    // Alternative yields 20/hr (+100% > +15%) -> switches!
    const switchedPlan = scheduleFleet({
        world,
        activities: ACTIVITIES,
        demands: [
            { id: 'd:current', goalKind: 'coin_fund', valueScore: 10, valuePerHour: 10, target: { kind: 'coins', amount: 10_000 }, fulfilled: 0, remaining: 10_000, priorityWeight: 1, active: true },
            { id: 'd:alt', goalKind: 'main_supply', valueScore: 20, valuePerHour: 20, target: { kind: 'item', itemId: 383, count: 100 }, fulfilled: 0, remaining: 100, priorityWeight: 1, active: true },
        ],
        maxBots: 5,
    });
    expect(switchedPlan.accountPlans.Runner?.demandId).toBe('d:alt');

    // Shared spot capacity: catherby-sharks maxConcurrentAccounts=1 -> only 1 fisher gets the spot.
    const spotPlan = scheduleFleet({
        world: {
            ...world,
            accounts: { FisherOne: idle1, FisherTwo: idle2 },
        },
        activities: ACTIVITIES,
        demands: [
            { id: 'd:raw-sharks', goalKind: 'main_supply', valueScore: 20, valuePerHour: 20, target: { kind: 'item', itemId: 383, count: 100 }, fulfilled: 0, remaining: 100, priorityWeight: 1, active: true },
        ],
        maxBots: 5,
    });
    expect(spotPlan.spotAllocations['catherby-sharks']?.length).toBe(1);
    const activeCount = Object.values(spotPlan.accountPlans).filter((p) => p.steps.length > 0).length;
    expect(activeCount).toBe(1);
});

test('schedules safe hub_banker transfers only with confirmed logout & anti-ping-pong, and builds valid FleetState', () => {
    const donor = makeAcct({
        name: 'Donor',
        pos: { x: 3185, z: 3436, level: 0 },
        skills: { Cooking: { level: 1, xp: 0 }, Fishing: { level: 1, xp: 0 } },
        bank: { items: { 383: 400, 995: 5000 }, observedAt: NOW - 5000, trusted: true },
    });
    const cook = makeAcct({
        name: 'Cooker',
        pos: { x: 2619, z: 3332, level: 0 },
        inventory: { 995: 1000 },
        bank: { items: { 995: 1000 }, observedAt: NOW - 5000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { Donor: donor, Cooker: cook },
    };
    const demands: GoalDemand[] = [
        { id: 'd:cooked', goalKind: 'main_supply', valueScore: 20, valuePerHour: 20, target: { kind: 'item', itemId: 385, count: 100 }, fulfilled: 0, remaining: 100, priorityWeight: 1, assignedAccount: 'Cooker', active: true },
    ];
    const pausedMission: Mission = {
        id: 'mission:paused',
        participants: ['Donor'],
        state: 'paused',
        kitTargets: [],
        consumables: [],
        weight: 5,
    };

    // Missing logout proof -> refuses to create TransferOrder!
    const unconfirmedPlan = scheduleFleet({
        world,
        activities: ACTIVITIES,
        demands,
        missions: [pausedMission],
        requireMarketQuote: true,
        marketQuotes: {},
        maxBots: 5,
    });
    expect(unconfirmedPlan.transferOrders.length).toBe(0);

    // Confirmed logout proofs for both parties -> creates hub_banker TransferOrder through varrock_west/ardougne!
    const proofs = new Map<string, LogoutProof>([
        ['donor', confirmedProof('Donor')],
        ['cooker', confirmedProof('Cooker')],
    ]);
    const confirmedPlan = scheduleFleet({
        world,
        activities: ACTIVITIES,
        demands,
        missions: [pausedMission],
        logoutProofs: proofs,
        stationedHubBankers: { ardougne: 'Moneyshot', varrock_west: 'Coinpurse' },
        requireMarketQuote: true,
        marketQuotes: {},
        maxBots: 5,
    });
    expect(confirmedPlan.transferOrders.length).toBe(1);
    const xfer = confirmedPlan.transferOrders[0]!;
    expect(xfer.from).toBe('Donor');
    expect(xfer.to).toBe('Cooker');
    expect(['varrock_west', 'ardougne']).toContain(xfer.hub);
    expect(xfer.bothIdleVerified).toBe(true);

    // Anti-ping-pong blocks sending item 383 back if Donor recently received 383.
    const recentOrder: TransferOrder = {
        ...xfer,
        id: 'prior-settled',
        from: 'Other',
        to: 'Donor',
        state: 'settled',
        createdAt: NOW - 60_000,
    };
    const pingPongBlocked = scheduleFleet({
        world,
        activities: ACTIVITIES,
        demands,
        logoutProofs: proofs,
        recentTransfers: [recentOrder],
        requireMarketQuote: true,
        marketQuotes: {},
        maxBots: 5,
    });
    expect(pingPongBlocked.transferOrders.length).toBe(0);

    const fleetState = buildFleetState(confirmedPlan, {
        world,
        goals: demands,
        missions: [pausedMission],
        rateStats: { 'bank-artisan:cook-shark': { samples: 5, xpPerTick: 205, unitsPerTick: 0.25, gpPerTick: 15 } },
    });
    expect(isFleetState(fleetState)).toBe(true);
    expect(fleetState.schemaVersion).toBe(1);
    expect(fleetState.pendingTransfers.length).toBe(1);
});

test('scheduleFleet halts launches with side_paused_owner when fleetSides[side].stopped is true unless ignoreSideStop is set', () => {
    const idle = makeAcct({ name: 'IdleBot', lifecycle: 'idle' });
    const rec = makeAcct({ name: 'RecBot', lifecycle: 'needs_logout_recovery' });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: {
            IdleBot: idle,
            RecBot: rec,
        },
        fleetSides: {
            local: {
                side: 'local',
                seenAt: NOW,
                capacity: 5,
                stopped: true,
            },
        },
    };
    const demands: GoalDemand[] = [{
        id: 'd:coins',
        goalKind: 'coin_fund',
        valueScore: 10,
        valuePerHour: 10,
        target: { kind: 'coins', amount: 10_000 },
        fulfilled: 0,
        remaining: 10_000,
        priorityWeight: 1,
        active: true,
    }];

    const halted = scheduleFleet({
        world,
        activities: ACTIVITIES,
        demands,
        maxBots: 5,
    });
    expect(halted.selectedSlots).toBe(0);
    expect(halted.recoveryQueue.map((r) => r.account)).toEqual(['RecBot']);
    expect(halted.accountPlans.IdleBot?.steps).toEqual([]);
    expect(halted.accountPlans.IdleBot?.idleReason).toBe('side_paused_owner');
    expect(halted.accountPlans.RecBot?.steps).toEqual([]);
    expect(halted.accountPlans.RecBot?.idleReason).toBe('side_paused_owner');

    const ignored = scheduleFleet({
        world,
        activities: ACTIVITIES,
        demands,
        maxBots: 5,
        ignoreSideStop: true,
    });
    expect(ignored.selectedSlots).toBeGreaterThan(0);
    expect(ignored.accountPlans.IdleBot?.steps.length).toBeGreaterThan(0);
    expect(ignored.accountPlans.RecBot?.steps.length).toBeGreaterThan(0);
});

test('global demand allocation prevents herd-piling on covered item and quest demands while allowing multiple accounts on large deficits', () => {
    const botA = makeAcct({ name: 'Alpha', lifecycle: 'idle', quests: {} });
    const botB = makeAcct({ name: 'Bravo', lifecycle: 'idle', quests: {} });
    const botC = makeAcct({ name: 'Charlie', lifecycle: 'idle', quests: {} });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { Alpha: botA, Bravo: botB, Charlie: botC },
    };
    const questAct: ActivityDefinition = {
        id: 'quest:cook',
        workerId: 'quest',
        family: 'quest',
        kind: 'quest',
        label: "Cook's Assistant",
        questSlug: 'cook',
        config: { questSlug: 'cook' },
        baselineRate: { xpPerTick: 100, unitsPerTick: 0.02, gpPerTick: 0, setupTicks: 10, minBatchUnits: 1, confidence: 'practice' },
        trust: 'practice_passed',
    };
    const activities: ActivityDefinition[] = [
        { ...ACTIVITIES[0]!, spotId: undefined, maxConcurrentAccounts: undefined },
        questAct,
        ACTIVITIES[2]!,
    ];

    // Alpha takes the small 50-shark item demand (covered by 1 batchUnits=50), Bravo takes the quest (1 account max), Charlie takes coins.
    const diversified = scheduleFleet({
        world,
        activities,
        demands: [
            { id: 'd:sharks-50', goalKind: 'main_supply', valueScore: 300, valuePerHour: 300, target: { kind: 'item', itemId: 383, count: 50 }, fulfilled: 0, remaining: 50, priorityWeight: 1, active: true },
            { id: 'd:quest-cook', goalKind: 'quest_board', valueScore: 200, valuePerHour: 200, target: { kind: 'quest', questSlug: 'cook' }, fulfilled: 0, remaining: 1, priorityWeight: 1, active: true },
            { id: 'd:coins', goalKind: 'coin_fund', valueScore: 50, valuePerHour: 50, target: { kind: 'coins', amount: 100_000 }, fulfilled: 0, remaining: 100_000, priorityWeight: 1, active: true },
        ],
        maxBots: 5,
    });
    const assignedDemands = Object.values(diversified.accountPlans).map((p) => p.demandId);
    expect(assignedDemands.filter((d) => d === 'd:sharks-50').length).toBe(1);
    expect(assignedDemands.filter((d) => d === 'd:quest-cook').length).toBe(1);
    expect(assignedDemands.filter((d) => d === 'd:coins').length).toBe(1);

    // Large 10,000-shark item demand can still absorb multiple accounts, while spot capacity still gates when spotId is present.
    const largeSplit = scheduleFleet({
        world,
        activities,
        demands: [
            { id: 'd:sharks-big', goalKind: 'main_supply', valueScore: 300, valuePerHour: 300, target: { kind: 'item', itemId: 383, count: 10_000 }, fulfilled: 0, remaining: 10_000, priorityWeight: 1, active: true },
        ],
        maxBots: 3,
    });
    const bigAssigned = Object.values(largeSplit.accountPlans).filter((p) => p.demandId === 'd:sharks-big');
    expect(bigAssigned.length).toBe(3);

    const spotCapped = scheduleFleet({
        world,
        activities: [ACTIVITIES[0]!, ACTIVITIES[2]!],
        demands: [
            { id: 'd:sharks-big', goalKind: 'main_supply', valueScore: 300, valuePerHour: 300, target: { kind: 'item', itemId: 383, count: 10_000 }, fulfilled: 0, remaining: 10_000, priorityWeight: 1, active: true },
        ],
        maxBots: 3,
    });
    expect(spotCapped.spotAllocations['catherby-sharks']?.length).toBe(1);
});
