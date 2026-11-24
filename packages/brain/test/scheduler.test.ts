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

test('scheduler prevents donor double-booking, replans on failed transfer safety gate, and materializes hub_banker gear_upgrade transfers', () => {
    // 1. Donor already assigned work earlier in the cycle cannot be double-booked as a hub_banker donor.
    const richDonor = makeAcct({
        name: 'RichDonor',
        pos: { x: 3185, z: 3436, level: 0 },
        skills: { Fishing: { level: 76, xp: 1_500_000 }, Cooking: { level: 1, xp: 0 } },
        bank: { items: { 383: 400, 995: 5000 }, observedAt: NOW - 5000, trusted: true },
    });
    const cooker = makeAcct({
        name: 'Cooker',
        pos: { x: 3185, z: 3436, level: 0 },
        skills: { Cooking: { level: 80, xp: 2_000_000 }, Fishing: { level: 1, xp: 0 }, Thieving: { level: 60, xp: 280_000 } },
        bank: { items: { 995: 2000 }, observedAt: NOW - 5000, trusted: true },
    });
    const doubleBookPlan = scheduleFleet({
        world: {
            schemaVersion: 1,
            at: NOW,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: { RichDonor: richDonor, Cooker: cooker },
        },
        activities: [ACTIVITIES[0]!, ACTIVITIES[1]!, ACTIVITIES[2]!],
        demands: [
            { id: 'd:raw-sharks', goalKind: 'main_supply', valueScore: 500, valuePerHour: 500, target: { kind: 'item', itemId: 383, count: 500 }, fulfilled: 0, remaining: 500, priorityWeight: 1, assignedAccount: 'RichDonor', active: true },
            { id: 'd:cooked-sharks', goalKind: 'main_supply', valueScore: 100, valuePerHour: 100, target: { kind: 'item', itemId: 385, count: 100 }, fulfilled: 0, remaining: 100, priorityWeight: 1, assignedAccount: 'Cooker', active: true },
            { id: 'd:coins', goalKind: 'coin_fund', valueScore: 10, valuePerHour: 10, target: { kind: 'coins', amount: 50_000 }, fulfilled: 0, remaining: 50_000, priorityWeight: 1, active: true },
        ],
        logoutProofs: new Map([['richdonor', confirmedProof('RichDonor')], ['cooker', confirmedProof('Cooker')]]),
        requireMarketQuote: true,
        marketQuotes: {},
        maxBots: 5,
    });
    expect(doubleBookPlan.accountPlans.RichDonor?.steps.at(-1)?.stepKind).toBe('work');
    expect(doubleBookPlan.transferOrders.length).toBe(0);

    // 2. When transfer safety gate fails (missing logout proof), scheduler re-plans onto useful local work instead of parking idle.
    const replanResult = scheduleFleet({
        world: {
            schemaVersion: 1,
            at: NOW,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: { RichDonor: makeAcct({ ...richDonor, skills: { Cooking: { level: 1, xp: 0 }, Fishing: { level: 1, xp: 0 } } }), Cooker: cooker },
        },
        activities: [ACTIVITIES[1]!, ACTIVITIES[2]!],
        demands: [
            { id: 'd:cooked-sharks', goalKind: 'main_supply', valueScore: 200, valuePerHour: 200, target: { kind: 'item', itemId: 385, count: 100 }, fulfilled: 0, remaining: 100, priorityWeight: 1, assignedAccount: 'Cooker', active: true },
            { id: 'd:coins', goalKind: 'coin_fund', valueScore: 20, valuePerHour: 20, target: { kind: 'coins', amount: 50_000 }, fulfilled: 0, remaining: 50_000, priorityWeight: 1, active: true },
        ],
        requireMarketQuote: true,
        marketQuotes: {},
        maxBots: 5,
    });
    expect(replanResult.transferOrders.length).toBe(0);
    expect(replanResult.accountPlans.Cooker?.steps.length).toBeGreaterThan(0);
    expect(replanResult.accountPlans.Cooker?.demandId).toBe('d:coins');

    // 3. gear_upgrade via hub_banker creates a validated TransferOrder and stamps transferOrderId.
    const miningAct: ActivityDefinition = {
        id: 'gather:mining-ore',
        workerId: 'gather',
        family: 'gather',
        kind: 'gather',
        label: 'Mine iron ore',
        skill: 'Mining',
        config: { skill: 'mining', method: 'ore' },
        baselineRate: { xpPerTick: 65, unitsPerTick: 0.14, gpPerTick: 3, setupTicks: 15, minBatchUnits: 27, confidence: 'practice' },
        trust: 'practice_passed',
    };
    const pickDonor = makeAcct({
        name: 'PickDonor',
        pos: { x: 3185, z: 3436, level: 0 },
        bank: { items: { 1275: 1, 995: 5000 }, observedAt: NOW - 5000, trusted: true },
    });
    const miner = makeAcct({
        name: 'MinerBot',
        pos: { x: 3185, z: 3436, level: 0 },
        skills: { Mining: { level: 45, xp: 62_000 } },
        bank: { items: { 1265: 1, 995: 500 }, observedAt: NOW - 5000, trusted: true },
    });
    const upgradeXferPlan = scheduleFleet({
        world: {
            schemaVersion: 1,
            at: NOW,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: { PickDonor: pickDonor, MinerBot: miner },
        },
        activities: [miningAct],
        demands: [
            { id: 'd:mine65', goalKind: 'specialist_prep', valueScore: 100, valuePerHour: 100, target: { kind: 'skill', account: 'MinerBot', skill: 'Mining', targetLevel: 65 }, fulfilled: 45, remaining: 20, priorityWeight: 1, assignedAccount: 'MinerBot', active: true },
        ],
        logoutProofs: new Map([['pickdonor', confirmedProof('PickDonor')], ['minerbot', confirmedProof('MinerBot')]]),
        requireMarketQuote: true,
        marketQuotes: {},
        maxBots: 5,
    });
    expect(upgradeXferPlan.transferOrders.length).toBe(1);
    const upgStep = upgradeXferPlan.accountPlans.MinerBot?.steps[0];
    expect(upgStep?.stepKind).toBe('gear_upgrade');
    if (upgStep?.stepKind === 'gear_upgrade') {
        expect(upgStep.transferOrderId).toBe(upgradeXferPlan.transferOrders[0]!.id);
    }
});

test('recovery accounts with recovery-trigger holds emit recover steps, and blocked recovery does not burn remainingSlots', () => {
    const stranded = makeAcct({
        name: 'StrandedBot',
        lifecycle: 'needs_location_recovery',
        pos: { x: 3200, z: 3200, level: 2 },
        systemHolds: [{
            kind: 'maintenance',
            key: 'location_stranded',
            reason: 'stranded upstairs',
            createdAt: NOW - 10_000,
            expiresAt: NOW + 300_000,
        }],
    });
    const unsettled = makeAcct({
        name: 'UnsettledBot',
        lifecycle: 'needs_logout_recovery',
        systemHolds: [{
            kind: 'retry_backoff',
            key: 'session_unsettled',
            reason: 'unsettled session',
            createdAt: NOW - 10_000,
            expiresAt: NOW + 300_000,
        }],
    });
    const coinDemands: GoalDemand[] = [{
        id: 'd:coins',
        goalKind: 'coin_fund',
        valueScore: 50,
        valuePerHour: 50,
        target: { kind: 'coins', amount: 10_000 },
        fulfilled: 0,
        remaining: 10_000,
        priorityWeight: 1,
        active: true,
    }];
    const recPlan = scheduleFleet({
        world: {
            schemaVersion: 1,
            at: NOW,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: { StrandedBot: stranded, UnsettledBot: unsettled },
        },
        activities: ACTIVITIES,
        demands: coinDemands,
        maxBots: 2,
    });
    expect(recPlan.accountPlans.UnsettledBot?.steps[0]?.stepKind).toBe('recover');
    expect(recPlan.accountPlans.StrandedBot?.steps[0]?.stepKind).toBe('recover');

    // A recovery account blocked by a non-recovery hold emits 0 steps and must NOT consume remainingSlots.
    const blockedRec = makeAcct({
        name: 'BlockedRec',
        lifecycle: 'needs_logout_recovery',
        systemHolds: [{
            kind: 'circuit_breaker',
            key: 'login_storm',
            reason: 'circuit open',
            createdAt: NOW - 10_000,
            expiresAt: NOW + 300_000,
        }],
    });
    const idleBot = makeAcct({
        name: 'IdleBot',
        lifecycle: 'idle',
    });
    const slotPlan = scheduleFleet({
        world: {
            schemaVersion: 1,
            at: NOW,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: { BlockedRec: blockedRec, IdleBot: idleBot },
        },
        activities: ACTIVITIES,
        demands: coinDemands,
        maxBots: 1,
    });
    expect(slotPlan.accountPlans.BlockedRec?.steps).toHaveLength(0);
    expect(slotPlan.accountPlans.IdleBot?.steps.length).toBeGreaterThan(0);
});

test('running account switch excludes hub_banker and spot reroute respects all full spots', () => {
    // 1. Running account switching to a higher-value cooking demand must NOT pick hub_banker.
    const donor = makeAcct({
        name: 'IdleDonor',
        lifecycle: 'idle',
        skills: { Fishing: { level: 1, xp: 0 }, Cooking: { level: 1, xp: 0 }, Thieving: { level: 1, xp: 0 } },
        bank: { items: { 383: 500, 995: 5000 }, observedAt: NOW - 5000, trusted: true },
    });
    const runner = makeAcct({
        name: 'RunnerBot',
        lifecycle: 'running',
        activeJob: { activityId: 'gather:thieving-knight', demandId: 'd:coins', startedAt: NOW - 60_000 },
        inventory: {},
        bank: { items: { 995: 500 }, observedAt: NOW - 5000, trusted: true },
    });
    const noHubSwitch = scheduleFleet({
        world: {
            schemaVersion: 1,
            at: NOW,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: { IdleDonor: donor, RunnerBot: runner },
        },
        activities: [ACTIVITIES[1]!, ACTIVITIES[2]!],
        demands: [
            { id: 'd:cooked-sharks', goalKind: 'main_supply', valueScore: 500, valuePerHour: 5000, target: { kind: 'item', itemId: 385, count: 100 }, fulfilled: 0, remaining: 100, priorityWeight: 1, active: true },
            { id: 'd:coins', goalKind: 'coin_fund', valueScore: 20, valuePerHour: 20, target: { kind: 'coins', amount: 50_000 }, fulfilled: 0, remaining: 50_000, priorityWeight: 1, active: true },
        ],
        logoutProofs: new Map([['idledonor', confirmedProof('IdleDonor')]]),
        requireMarketQuote: true,
        marketQuotes: {},
        maxBots: 5,
    });
    const runnerSteps = noHubSwitch.accountPlans.RunnerBot?.steps ?? [];
    expect(runnerSteps.some((s) => (s.stepKind === 'acquire' || s.stepKind === 'gear_upgrade') && s.source === 'hub_banker')).toBe(false);
    expect(noHubSwitch.transferOrders.some((t) => t.to === 'RunnerBot')).toBe(false);

    // 2. Running-account reroute excludes both locally-allocated full spots and externally-occupied spots.
    const spotA: ActivityDefinition = {
        id: 'gather:spot-a',
        workerId: 'gather',
        family: 'gather',
        kind: 'gather',
        label: 'Spot A',
        skill: 'Fishing',
        spotId: 'spot_a',
        maxConcurrentAccounts: 1,
        outputs: [{ itemId: 383, countPerUnit: 1 }],
        config: {},
        baselineRate: { xpPerTick: 100, unitsPerTick: 0.3, gpPerTick: 0, setupTicks: 10, minBatchUnits: 10, confidence: 'practice' },
        trust: 'practice_passed',
    };
    const spotB: ActivityDefinition = {
        ...spotA,
        id: 'gather:spot-b',
        label: 'Spot B',
        spotId: 'spot_b',
        baselineRate: { xpPerTick: 100, unitsPerTick: 0.25, gpPerTick: 0, setupTicks: 10, minBatchUnits: 10, confidence: 'practice' },
    };
    const spotC: ActivityDefinition = {
        ...spotA,
        id: 'gather:spot-c',
        label: 'Spot C',
        spotId: 'spot_c',
        baselineRate: { xpPerTick: 100, unitsPerTick: 0.2, gpPerTick: 0, setupTicks: 10, minBatchUnits: 10, confidence: 'practice' },
    };
    const run1 = makeAcct({
        name: 'RunA',
        lifecycle: 'running',
        activeJob: { activityId: 'gather:spot-a', demandId: 'd:raw', startedAt: NOW - 60_000 },
    });
    const run2 = makeAcct({
        name: 'RunB',
        lifecycle: 'running',
        activeJob: { activityId: 'gather:spot-a', demandId: 'd:raw', startedAt: NOW - 60_000 },
    });
    const reroutePlan = scheduleFleet({
        world: {
            schemaVersion: 1,
            at: NOW,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: { RunA: run1, RunB: run2 },
            spotOccupancy: { spot_b: 1 },
        },
        activities: [spotA, spotB, spotC],
        demands: [{
            id: 'd:raw',
            goalKind: 'main_supply',
            valueScore: 500,
            valuePerHour: 5000,
            target: { kind: 'item', itemId: 383, count: 500 },
            fulfilled: 0,
            remaining: 500,
            priorityWeight: 1,
            active: true,
        }],
        maxBots: 5,
    });
    const runAAct = reroutePlan.accountPlans.RunA?.steps.at(-1);
    const runBAct = reroutePlan.accountPlans.RunB?.steps.at(-1);
    expect(runAAct?.stepKind === 'work' && runAAct.activityId).toBe('gather:spot-a');
    expect(runBAct?.stepKind === 'work' && runBAct.activityId).toBe('gather:spot-c');
    expect(reroutePlan.spotAllocations.spot_b).toBeUndefined();
});

test('hub_banker transfer slot accounting prevents recipient + idle donor from exceeding maxBots', () => {
    const recipient = makeAcct({
        name: 'NeedsBones',
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: {},
        bank: { items: { 995: 500 }, observedAt: NOW - 5_000, trusted: true },
    });
    const donor = makeAcct({
        name: 'BoneMule',
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: {},
        bank: { items: { 536: 100, 995: 2_000 }, observedAt: NOW - 5_000, trusted: true },
    });
    const buryAct: ActivityDefinition = {
        id: 'bank-artisan:prayer-bury',
        workerId: 'bank-artisan',
        family: 'bank-artisan',
        kind: 'produce',
        label: 'Bury banked bones',
        skill: 'Prayer',
        skills: ['Prayer'],
        inputs: [{ itemId: 536, countPerUnit: 1 }],
        location: { x: 3185, z: 3436, level: 0 },
        config: { requiredLevel: 1 },
        baselineRate: { xpPerTick: 400, unitsPerTick: 0.4, gpPerTick: 0, setupTicks: 10, minBatchUnits: 10, confidence: 'live' },
        trust: 'live_proven',
        protectedAllowed: false,
    };
    const demands: GoalDemand[] = [{
        id: 'd:pray-need',
        goalKind: 'specialist_prep',
        valueScore: 500,
        valuePerHour: 5000,
        target: { kind: 'skill', account: 'NeedsBones', skill: 'Prayer', targetLevel: 43 },
        fulfilled: 1,
        remaining: 42,
        priorityWeight: 1,
        assignedAccount: 'NeedsBones',
        active: true,
    }];
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { NeedsBones: recipient, BoneMule: donor },
    };
    const logoutProofs = new Map<string, LogoutProof>([
        ['needsbones', confirmedProof('NeedsBones')],
        ['bonemule', confirmedProof('BoneMule')],
    ]);

    // With maxBots=1, a transfer requiring both recipient + donor (2 slots) cannot commit under hub_banker.
    const oneSlotPlan = scheduleFleet({
        world,
        activities: [buryAct],
        demands,
        maxBots: 1,
        logoutProofs,
        requireMarketQuote: true,
        marketQuotes: {},
    });
    expect(oneSlotPlan.transferOrders).toHaveLength(0);
    expect(oneSlotPlan.selectedSlots).toBeLessThanOrEqual(1);

    // With maxBots=2, recipient work plan + 1 idle donor = 2 selectedSlots total.
    const twoSlotPlan = scheduleFleet({
        world,
        activities: [buryAct],
        demands,
        maxBots: 2,
        logoutProofs,
        requireMarketQuote: true,
        marketQuotes: {},
    });
    expect(twoSlotPlan.transferOrders).toHaveLength(1);
    expect(twoSlotPlan.selectedSlots).toBe(2);
});

test('shared planner index and greedy reuse handle spot saturation and shrinking item demands cleanly', () => {
    const fishA = makeAcct({ name: 'Alpha', bank: { items: { 995: 5_000 }, observedAt: NOW - 5_000, trusted: true } });
    const fishB = makeAcct({ name: 'Bravo', bank: { items: { 995: 5_000 }, observedAt: NOW - 5_000, trusted: true } });
    const fishC = makeAcct({ name: 'Charlie', bank: { items: { 995: 5_000 }, observedAt: NOW - 5_000, trusted: true } });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { Alpha: fishA, Bravo: fishB, Charlie: fishC },
    };
    const demands: GoalDemand[] = [
        {
            id: 'd:raw-sharks',
            goalKind: 'main_supply',
            valueScore: 500,
            valuePerHour: 2000,
            target: { kind: 'item', itemId: 383, itemName: 'Raw shark', count: 120 },
            fulfilled: 0,
            remaining: 120,
            priorityWeight: 1,
            active: true,
        },
        {
            id: 'd:coins',
            goalKind: 'coin_fund',
            valueScore: 50,
            valuePerHour: 200,
            target: { kind: 'coins', amount: 5_000_000 },
            fulfilled: 0,
            remaining: 5_000_000,
            priorityWeight: 1,
            active: true,
        },
    ];
    const plan = scheduleFleet({ world, activities: ACTIVITIES, demands, maxBots: 3 });
    expect(plan.spotAllocations['catherby-sharks']).toHaveLength(1);
    const sharkOwners = Object.values(plan.accountPlans).filter(
        (p) => p.steps.at(-1)?.stepKind === 'work' && (p.steps.at(-1) as any).activityId === 'gather:fishing-shark',
    );
    const thievingOwners = Object.values(plan.accountPlans).filter(
        (p) => p.steps.at(-1)?.stepKind === 'work' && (p.steps.at(-1) as any).activityId === 'gather:thieving-knights',
    );
    expect(sharkOwners).toHaveLength(1);
    expect(thievingOwners).toHaveLength(2);
    expect(plan.selectedSlots).toBe(3);
});

test('scheduleFleet caps market:shop-buy and market:ge-buy to 1 concurrent buyer per venue even across finite cross-demands', () => {
    const names = ['Fingerblastr', 'Kiltlifter', 'KnightRider', 'Knightstick', 'Masterbaiter', 'Popsicle'];
    const accounts: Record<string, AccountState> = {};
    for (const name of names) {
        accounts[name] = makeAcct({
            name,
            skills: {
                Ranged: { level: 50, xp: 105_000 },
                Thieving: { level: 60, xp: 280_000 },
            },
            bank: { items: { 995: 500_000 }, observedAt: NOW - 5_000, trusted: true },
        });
    }
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts,
    };
    const marketActivities: ActivityDefinition[] = [
        ...ACTIVITIES,
        {
            id: 'market:shop-buy',
            workerId: 'market',
            family: 'market',
            kind: 'shop',
            label: 'Buy item from NPC shop',
            config: { mode: 'shop-buy' },
            baselineRate: { xpPerTick: 0, unitsPerTick: 2, gpPerTick: 0, setupTicks: 25, minBatchUnits: 1, confidence: 'practice' },
            trust: 'practice_passed',
        },
        {
            id: 'market:ge-buy',
            workerId: 'market',
            family: 'market',
            kind: 'ge_buy',
            label: 'Buy item on GE',
            config: { mode: 'ge-buy' },
            baselineRate: { xpPerTick: 0, unitsPerTick: 4, gpPerTick: 0, setupTicks: 30, minBatchUnits: 1, confidence: 'practice' },
            trust: 'practice_passed',
        },
    ];
    const demands: GoalDemand[] = [
        {
            id: 'campaign:haggis:item:892',
            goalKind: 'main_supply',
            valueScore: 500,
            valuePerHour: 21_962.66,
            target: { kind: 'item', itemId: 892, itemName: 'Rune arrow', count: 2500 },
            fulfilled: 0,
            remaining: 2500,
            priorityWeight: 1,
            active: true,
        },
        {
            id: 'campaign:shaftshooter:item:892',
            goalKind: 'specialist_prep',
            valueScore: 400,
            valuePerHour: 18_000,
            target: { kind: 'item', itemId: 892, itemName: 'Rune arrow', count: 1000 },
            fulfilled: 0,
            remaining: 1000,
            priorityWeight: 1,
            active: true,
        },
        {
            id: 'd:coins',
            goalKind: 'coin_fund',
            valueScore: 50,
            valuePerHour: 200,
            target: { kind: 'coins', amount: 5_000_000 },
            fulfilled: 0,
            remaining: 5_000_000,
            priorityWeight: 1,
            active: true,
        },
    ];

    const shopOnlyPlan = scheduleFleet({ world, activities: marketActivities, demands, maxBots: 6 });
    expect(isFleetPlan(shopOnlyPlan)).toBe(true);
    const shopBuyers = Object.values(shopOnlyPlan.accountPlans).filter((p) => {
        const w = p.steps.at(-1);
        return w?.stepKind === 'work' && w.config.mode === 'shop-buy';
    });
    const thievers = Object.values(shopOnlyPlan.accountPlans).filter((p) => {
        const w = p.steps.at(-1);
        return w?.stepKind === 'work' && w.activityId === 'gather:thieving-knights';
    });
    expect(shopBuyers).toHaveLength(1);
    expect(thievers).toHaveLength(5);

    const shopAndGePlan = scheduleFleet({
        world,
        activities: marketActivities,
        demands,
        maxBots: 6,
        marketQuotes: { 892: { ask: 400, sell: 380, trades: 50 } },
    });
    expect(isFleetPlan(shopAndGePlan)).toBe(true);
    const shopBuyersWithGe = Object.values(shopAndGePlan.accountPlans).filter((p) => {
        const w = p.steps.at(-1);
        return w?.stepKind === 'work' && w.config.mode === 'shop-buy';
    });
    const geBuyersWithGe = Object.values(shopAndGePlan.accountPlans).filter((p) => {
        const w = p.steps.at(-1);
        return w?.stepKind === 'work' && w.config.mode === 'ge-buy';
    });
    const thieversWithGe = Object.values(shopAndGePlan.accountPlans).filter((p) => {
        const w = p.steps.at(-1);
        return w?.stepKind === 'work' && w.activityId === 'gather:thieving-knights';
    });
    expect(shopBuyersWithGe).toHaveLength(1);
    expect(geBuyersWithGe).toHaveLength(1);
    expect(thieversWithGe).toHaveLength(4);
});

test('scheduleFleet materializes TransferOrder for stagingHolder consolidation and prevents non-holder over-buying', () => {
    const holder = makeAcct({
        name: 'StageHolder',
        role: 'helper',
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: {},
        bank: { items: { 995: 2_000 }, observedAt: NOW - 5_000, trusted: true },
    });
    const donor = makeAcct({
        name: 'DonorAlt',
        role: 'helper',
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: {},
        bank: { items: { 385: 120, 995: 2_000 }, observedAt: NOW - 5_000, trusted: true },
    });
    const buyer = makeAcct({
        name: 'RichBuyer',
        role: 'helper',
        pos: { x: 3164, z: 3487, level: 0 },
        inventory: { 995: 200_000 },
        bank: { items: { 995: 200_000 }, observedAt: NOW - 5_000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { StageHolder: holder, DonorAlt: donor, RichBuyer: buyer },
    };
    const geAct: ActivityDefinition = {
        id: 'market:ge-buy',
        workerId: 'market',
        family: 'market',
        kind: 'ge_buy',
        label: 'Buy on GE',
        config: { mode: 'ge-buy' },
        baselineRate: { xpPerTick: 0, unitsPerTick: 4, gpPerTick: 0, setupTicks: 30, minBatchUnits: 1, confidence: 'practice' },
        trust: 'practice_passed',
    };
    const demands: GoalDemand[] = [
        {
            id: 'campaign:haggis:item:385',
            goalKind: 'main_supply',
            valueScore: 600,
            valuePerHour: 6000,
            target: { kind: 'item', itemId: 385, itemName: 'Shark', count: 120, holder: 'StageHolder' },
            fulfilled: 0,
            remaining: 120,
            priorityWeight: 1,
            active: true,
        },
    ];
    const proofs = new Map<string, LogoutProof>([
        ['stageholder', confirmedProof('StageHolder')],
        ['donoralt', confirmedProof('DonorAlt')],
        ['richbuyer', confirmedProof('RichBuyer')],
    ]);

    const plan = scheduleFleet({
        world,
        activities: [...ACTIVITIES, geAct],
        demands,
        logoutProofs: proofs,
        marketQuotes: { 385: { ask: 400, sell: 350, trades: 20 } },
        maxBots: 5,
    });
    expect(isFleetPlan(plan)).toBe(true);
    expect(plan.transferOrders).toHaveLength(1);
    expect(plan.transferOrders[0]?.from).toBe('DonorAlt');
    expect(plan.transferOrders[0]?.to).toBe('StageHolder');
    expect(plan.transferOrders[0]?.items).toEqual([{ itemId: 385, itemName: 'Shark', count: 120 }]);
    expect(plan.accountPlans.DonorAlt?.idleReason).toBe('reserved_for_transfer');
    expect(plan.accountPlans.RichBuyer?.steps).toHaveLength(0);
});
