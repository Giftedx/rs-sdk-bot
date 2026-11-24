import { expect, test } from 'bun:test';
import {
    isAccountPlan,
    type AccountState,
    type ActivityDefinition,
    type Campaign,
    type DefectRecord,
    type GoalDemand,
    type WorldSnapshot,
} from '../src/contracts';
import {
    canProtectedAccountLaunch,
    evaluateBestGearUpgrade,
    planAccount,
    xpForLevel,
} from '../src/planner';
import { loadShopCatalogByItem } from '../src/acquire';
import { campaignShortfalls } from '../src/campaigns';
import { createActivityCatalog } from '../src/catalog';
import { loadItemsMap } from '../src/preflight';
import { createRateStore } from '../src/rate-store';
import { derivedProfile } from '../../workers/src/market/shop-profiles';

const NOW = 1_700_000_000_000;

function makeAcct(overrides: Partial<AccountState> = {}): AccountState {
    return {
        name: 'Packhorse',
        side: 'local',
        role: 'auto',
        protectedClock: false,
        lifecycle: 'idle',
        skills: {
            Attack: { level: 40, xp: xpForLevel(40) },
            Strength: { level: 40, xp: xpForLevel(40) },
            Defence: { level: 40, xp: xpForLevel(40) },
            Hitpoints: { level: 40, xp: xpForLevel(40) },
            Mining: { level: 45, xp: xpForLevel(45) },
            Cooking: { level: 80, xp: xpForLevel(80) },
        },
        quests: { cook: 'complete' },
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: { 995: 25_000 },
        equipment: {},
        bank: {
            items: { 995: 50_000, 1265: 1 }, // bronze pickaxe
            observedAt: NOW - 10_000,
            trusted: true,
        },
        ...overrides,
    };
}

const ACTIVITIES: ActivityDefinition[] = [
    {
        id: 'gather:mining-iron',
        workerId: 'gather',
        family: 'gather',
        kind: 'train',
        label: 'Mine iron ore',
        skill: 'Mining',
        config: { skill: 'mining', method: 'ore', requiredTools: [1265] },
        baselineRate: { xpPerTick: 20, unitsPerTick: 0.2, gpPerTick: 10, setupTicks: 20, minBatchUnits: 28, confidence: 'practice', outputsPerUnit: { 440: 1 } },
        outputs: [{ itemId: 440, countPerUnit: 1 }],
        location: { x: 3286, z: 3368, level: 0 },
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
        baselineRate: { xpPerTick: 210, unitsPerTick: 0.25, gpPerTick: 15, setupTicks: 20, minBatchUnits: 25, confidence: 'practice', outputsPerUnit: { 385: 1 } },
        inputs: [{ itemId: 383, countPerUnit: 1 }],
        outputs: [{ itemId: 385, countPerUnit: 1 }],
        location: { x: 2817, z: 3443, level: 0 },
        trust: 'practice_passed',
    },
    {
        id: 'quest:sweep-druid',
        workerId: 'quest',
        family: 'quest',
        kind: 'quest',
        label: 'Druidic Ritual',
        questSlug: 'druid',
        config: { questSlug: 'druid' },
        baselineRate: { xpPerTick: 250, unitsPerTick: 0.01, gpPerTick: 0, setupTicks: 15, minBatchUnits: 1, confidence: 'practice' },
        location: { x: 2925, z: 3485, level: 0 },
        trust: 'practice_passed',
    },
    {
        id: 'bank-artisan:herblore-attack',
        workerId: 'bank-artisan',
        family: 'bank-artisan',
        kind: 'train',
        label: 'Brew attack potions',
        skill: 'Herblore',
        config: { skill: 'herblore', requiredLevel: 3, requiredQuests: ['druid'] },
        baselineRate: { xpPerTick: 100, unitsPerTick: 0.2, gpPerTick: 0, setupTicks: 20, minBatchUnits: 10, confidence: 'practice', outputsPerUnit: { 121: 1 } },
        inputs: [{ itemId: 91, countPerUnit: 1 }, { itemId: 221, countPerUnit: 1 }],
        outputs: [{ itemId: 121, countPerUnit: 1 }],
        location: { x: 3185, z: 3436, level: 0 },
        trust: 'practice_passed',
    },
    {
        id: 'quest:sweep-legends',
        workerId: 'quest',
        family: 'quest',
        kind: 'quest',
        label: 'Legends Quest',
        questSlug: 'legends',
        config: { questSlug: 'legends', requiredQuests: ['hero'] },
        baselineRate: { xpPerTick: 450, unitsPerTick: 0.003, gpPerTick: 0, setupTicks: 40, minBatchUnits: 1, confidence: 'practice' },
        location: { x: 2728, z: 3348, level: 0 },
        trust: 'practice_passed',
    },
    {
        id: 'combat:chicken-starter',
        workerId: 'combat',
        family: 'combat',
        kind: 'train',
        label: 'Starter chickens',
        skill: 'Strength',
        config: { target: 'chicken' },
        baselineRate: { xpPerTick: 25, unitsPerTick: 0.1, gpPerTick: 5, setupTicks: 15, minBatchUnits: 20, confidence: 'practice' },
        location: { x: 3180, z: 3295, level: 0 },
        trust: 'practice_passed',
    },
    {
        id: 'pvp:wildy-hunt',
        workerId: 'pvp',
        family: 'pvp',
        kind: 'pk',
        label: 'Wilderness PK hunt',
        skills: ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic'],
        config: { mode: 'hunt', requiredSkills: { Attack: 85, Strength: 85, Defence: 85 } },
        baselineRate: { xpPerTick: 0, unitsPerTick: 0.02, gpPerTick: 200, setupTicks: 25, minBatchUnits: 1, confidence: 'practice' },
        location: { x: 3094, z: 3494, level: 0 },
        trust: 'practice_passed',
    },
];

test('solves 1-to-3-step dependency chains (acquire + unlock + work) and respects MAX_ACCOUNT_PLAN_STEPS=3', () => {
    const acct = makeAcct({
        skills: { Herblore: { level: 1, xp: 0 }, Mining: { level: 1, xp: 0 } },
        quests: {},
        bank: { items: { 995: 50_000, 91: 50, 221: 50 }, observedAt: NOW - 10_000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { Packhorse: acct },
    };

    // Herblore training requires Druidic Ritual quest unlock -> 2-step chain: [unlock(druid), work(herblore)]
    const herblorePlan = planAccount(acct, {
        world,
        activities: ACTIVITIES,
        demands: [{
            id: 'd:herb-train',
            goalKind: 'specialist_prep',
            valueScore: 10,
            valuePerHour: 10,
            target: { kind: 'skill', account: 'Packhorse', skill: 'Herblore', targetLevel: 20 },
            fulfilled: 0,
            remaining: 1,
            priorityWeight: 1,
            assignedAccount: 'Packhorse',
            active: true,
        }],
    });
    expect(isAccountPlan(herblorePlan)).toBe(true);
    expect(herblorePlan.steps.map((s) => s.stepKind)).toEqual(['unlock', 'work']);

    // Cooking sharks missing raw sharks -> 2-step chain: [acquire(ge raw shark), work(cook-shark)]
    // (raw sharks have no runnable surface NPC shop, so GE acquires them cleanly).
    const cookAcct = makeAcct({
        skills: { Cooking: { level: 80, xp: xpForLevel(80) } },
        bank: { items: { 995: 100_000 }, observedAt: NOW - 10_000, trusted: true },
    });
    const sharkDemand: GoalDemand = {
        id: 'd:sharks',
        goalKind: 'main_supply',
        valueScore: 15,
        valuePerHour: 15,
        target: { kind: 'item', itemId: 385, count: 50 },
        fulfilled: 0,
        remaining: 50,
        priorityWeight: 1,
        active: true,
    };
    const cookPlan = planAccount(cookAcct, {
        world: { ...world, accounts: { Packhorse: cookAcct } },
        activities: ACTIVITIES,
        marketQuotes: { 383: { ask: 400, sell: 380, trades: 20 } },
        demands: [sharkDemand],
    });
    expect(isAccountPlan(cookPlan)).toBe(true);
    expect(cookPlan.steps.length).toBeLessThanOrEqual(3);
    expect(cookPlan.steps.map((s) => s.stepKind)).toEqual(['acquire', 'work']);
    expect(cookPlan.steps[0]?.stepKind === 'acquire' && cookPlan.steps[0].source).toBe('ge');

    const cooledCookAcct = { ...cookAcct, cooldowns: { '383:npc_shop': NOW + 60_000 } };
    const geCookPlan = planAccount(cooledCookAcct, {
        world: { ...world, accounts: { Packhorse: cooledCookAcct } },
        activities: ACTIVITIES,
        marketQuotes: { 383: { ask: 400, sell: 380, trades: 20 } },
        demands: [sharkDemand],
    });
    expect(geCookPlan.steps.map((s) => s.stepKind)).toEqual(['acquire', 'work']);
    expect(geCookPlan.steps[0]?.stepKind === 'acquire' && geCookPlan.steps[0].source).toBe('ge');
});

test('gear upgrade evaluator picks positive payback upgrades and rejects negative payback on short bands', () => {
    const miner = makeAcct({
        skills: { Mining: { level: 45, xp: xpForLevel(45) } },
        bank: { items: { 995: 100_000, 1265: 1 }, observedAt: NOW - 10_000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { Packhorse: miner },
    };
    const miningAct = ACTIVITIES[0]!;

    // Long band (45 -> 60 Mining): Rune pickaxe (1275) pays back strongly in net ticks!
    const longUpgrade = evaluateBestGearUpgrade({
        acct: miner,
        activity: miningAct,
        rate: miningAct.baselineRate,
        remainingXp: xpForLevel(60) - xpForLevel(45),
        acquireCtx: {
            world,
            marketQuotes: { 1275: { ask: 32_000, sell: 30_000, trades: 10 } },
        },
    });
    expect(longUpgrade).not.toBeNull();
    expect(longUpgrade!.step.itemId).toBe(1275);
    expect(longUpgrade!.step.paybackNetTicks).toBeGreaterThan(0);

    // Tiny band (500 XP = 25 ticks): acquisition ticks exceed ticks saved -> NO gear upgrade!
    const shortUpgrade = evaluateBestGearUpgrade({
        acct: miner,
        activity: miningAct,
        rate: miningAct.baselineRate,
        remainingXp: 500,
        acquireCtx: {
            world,
            marketQuotes: { 1275: { ask: 32_000, sell: 30_000, trades: 10 } },
        },
    });
    expect(shortUpgrade).toBeNull();
});

test('comparative advantage routes high-quest to Quest Board, high-artisan to supply, and maxed tribrid to PK/endgame', () => {
    const questVet = makeAcct({
        name: 'QuestVet',
        quests: {
            ...Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`q${i}`, 'complete' as const])),
            hero: 'complete',
        },
    });
    const artisanVet = makeAcct({
        name: 'ArtisanVet',
        skills: { Cooking: { level: 92, xp: xpForLevel(92) }, Hitpoints: { level: 40, xp: xpForLevel(40) } },
        bank: { items: { 383: 500, 995: 50_000 }, observedAt: NOW - 5000, trusted: true },
    });
    const maxedTribrid = makeAcct({
        name: 'MaxTribrid',
        role: 'army',
        skills: {
            Attack: { level: 99, xp: xpForLevel(99) },
            Strength: { level: 99, xp: xpForLevel(99) },
            Defence: { level: 99, xp: xpForLevel(99) },
            Hitpoints: { level: 99, xp: xpForLevel(99) },
            Ranged: { level: 99, xp: xpForLevel(99) },
            Magic: { level: 99, xp: xpForLevel(99) },
            Prayer: { level: 70, xp: xpForLevel(70) },
        },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { QuestVet: questVet, ArtisanVet: artisanVet, MaxTribrid: maxedTribrid },
    };
    const demands: GoalDemand[] = [
        { id: 'd:quest', goalKind: 'quest_board', valueScore: 10, valuePerHour: 10, target: { kind: 'quest', questSlug: 'legends' }, fulfilled: 0, remaining: 1, priorityWeight: 1, active: true },
        { id: 'd:supply', goalKind: 'main_supply', valueScore: 10, valuePerHour: 10, target: { kind: 'item', itemId: 385, count: 100 }, fulfilled: 0, remaining: 100, priorityWeight: 1, active: true },
        { id: 'd:pk', goalKind: 'pk_army', valueScore: 10, valuePerHour: 10, target: { kind: 'combat_readiness', account: 'MaxTribrid', targets: { Attack: 99, Strength: 99, Defence: 99 } }, fulfilled: 0, remaining: 1, priorityWeight: 1, active: true },
    ];

    expect(planAccount(questVet, { world, activities: ACTIVITIES, demands }).demandId).toBe('d:quest');
    expect(planAccount(artisanVet, { world, activities: ACTIVITIES, demands }).demandId).toBe('d:supply');
    expect(planAccount(maxedTribrid, { world, activities: ACTIVITIES, demands }).demandId).toBe('d:pk');
});

test('strictly isolates protectedClock accounts unless Campaign launch gate passes and honors quarantined defects', () => {
    const haggis = makeAcct({
        name: 'Haggis',
        role: 'main',
        protectedClock: true,
        lifecycle: 'reserved',
    });
    const specialist = makeAcct({
        name: 'polevaulter',
        role: 'specialist',
        protectedClock: true,
        lifecycle: 'idle', // even if lifecycle drifts, protectedClock blocks unauthorized work
    });
    const stagingCampaign: Campaign = {
        id: 'camp:haggis',
        account: 'Haggis',
        protectedClock: true,
        board: 'Overall',
        requiredSupplies: [{ itemId: 385, count: 100 }],
        stagingHolder: 'Packhorse',
        rehearsalProof: null,
        hiscoreMargin: null,
        state: 'staging',
    };
    const readyCampaign: Campaign = {
        ...stagingCampaign,
        requiredSupplies: [],
        state: 'ready',
        rehearsalProof: { verified: true, ticks: 400_000, verifiedAt: NOW },
        hiscoreMargin: {
            board: 'Overall',
            rivalTicks: 500_000,
            ourTicks: 400_000,
            marginTicks: 100_000,
            marginRatio: 0.2,
            checkedAt: NOW,
            meetsMargin: true,
        },
    };
    const protectedCook: ActivityDefinition = {
        ...ACTIVITIES[1]!,
        id: 'bank-artisan:cook-shark-protected',
        protectedAllowed: true,
    };
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { Haggis: haggis, polevaulter: specialist },
    };
    const demand: GoalDemand = {
        id: 'd:haggis-work',
        goalKind: 'main_supply',
        valueScore: 100,
        valuePerHour: 100,
        target: { kind: 'item', itemId: 385, count: 50 },
        fulfilled: 0,
        remaining: 50,
        priorityWeight: 1,
        active: true,
    };

    expect(canProtectedAccountLaunch(haggis, [stagingCampaign]).allowed).toBe(false);
    expect(planAccount(haggis, { world, activities: [protectedCook], demands: [demand], campaigns: [stagingCampaign] }).steps).toEqual([]);
    expect(planAccount(specialist, { world, activities: [protectedCook], demands: [demand], campaigns: [stagingCampaign] }).steps).toEqual([]);

    // When launch gate passes and activity is protectedAllowed=true, Haggis plans work; specialist without ready campaign stays offline.
    const haggisCook = {
        ...haggis,
        bank: { items: { 383: 100, 995: 5000 }, observedAt: NOW - 5000, trusted: true },
    };
    const launchedPlan = planAccount(haggisCook, {
        world: { ...world, accounts: { Haggis: haggisCook, polevaulter: specialist } },
        activities: [protectedCook],
        demands: [demand],
        campaigns: [readyCampaign],
    });
    expect(launchedPlan.steps.length).toBeGreaterThan(0);

    // Quarantined defect excludes activity.
    const defect: DefectRecord = {
        id: 'def-1',
        activityId: protectedCook.id,
        faultSignature: 'stuck',
        outcomeKind: 'worker_defect',
        account: 'Haggis',
        observedAt: NOW - 1000,
        quarantinedAt: NOW - 500,
        expiresAt: NOW + 60_000,
        quarantined: true,
        logPath: '.practice/live/logs/test.log',
        detail: 'stuck at range',
        count: 1,
    };
    const quarantinedPlan = planAccount(haggisCook, {
        world: { ...world, accounts: { Haggis: haggisCook } },
        activities: [protectedCook],
        demands: [demand],
        campaigns: [readyCampaign],
        defects: [defect],
    });
    expect(quarantinedPlan.steps).toEqual([]);

    // Missing supplies or stale hiscore snapshot must block launch when WorldSnapshot is supplied.
    const shortReadyCampaign: Campaign = { ...readyCampaign, requiredSupplies: [{ itemId: 385, count: 100 }] };
    expect(canProtectedAccountLaunch(haggisCook, [shortReadyCampaign], { ...world, accounts: { Haggis: haggisCook } })).toMatchObject({
        allowed: false,
        reason: 'campaign_supplies_short',
    });
    const staleReadyCampaign: Campaign = {
        ...readyCampaign,
        hiscoreMargin: { ...readyCampaign.hiscoreMargin!, checkedAt: NOW - 2 * 3_600_000 },
    };
    expect(canProtectedAccountLaunch(haggisCook, [staleReadyCampaign], { ...world, accounts: { Haggis: haggisCook } })).toMatchObject({
        allowed: false,
        reason: 'campaign_hiscore_stale',
    });
});

test('scoring rewards positive-payback gear upgrades, prefers faster candidate activities, and avoids double-multiplying priorityWeight', () => {
    const miner = makeAcct({
        name: 'UpgradeMiner',
        skills: { Mining: { level: 45, xp: xpForLevel(45) } },
        bank: { items: { 995: 100_000, 1265: 1 }, observedAt: NOW - 10_000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { UpgradeMiner: miner },
    };
    const skillDemand: GoalDemand = {
        id: 'd:mine-65',
        goalKind: 'specialist_prep',
        valueScore: 100,
        valuePerHour: 100,
        target: { kind: 'skill', account: 'UpgradeMiner', skill: 'Mining', targetLevel: 65 },
        fulfilled: 45,
        remaining: 20,
        priorityWeight: 3,
        assignedAccount: 'UpgradeMiner',
        active: true,
    };
    const slowMining: ActivityDefinition = {
        ...ACTIVITIES[0]!,
        id: 'gather:mining-slow',
        baselineRate: { xpPerTick: 15, unitsPerTick: 0.15, gpPerTick: 5, setupTicks: 20, minBatchUnits: 28, confidence: 'practice' },
    };
    const fastMining: ActivityDefinition = {
        ...ACTIVITIES[0]!,
        id: 'gather:mining-fast',
        baselineRate: { xpPerTick: 40, unitsPerTick: 0.4, gpPerTick: 5, setupTicks: 20, minBatchUnits: 28, confidence: 'practice' },
    };

    const minerNoCoins = makeAcct({
        name: 'UpgradeMiner',
        skills: { Mining: { level: 45, xp: xpForLevel(45) } },
        inventory: { 995: 0 },
        bank: { items: { 995: 1000, 1265: 1 }, observedAt: NOW - 10_000, trusted: true },
    });
    const planWithUpgrade = planAccount(miner, {
        world,
        activities: [ACTIVITIES[0]!],
        demands: [skillDemand],
        marketQuotes: { 1275: { ask: 32_000, sell: 30_000, trades: 10 } },
    });
    const planWithoutUpgrade = planAccount(minerNoCoins, {
        world: { ...world, accounts: { UpgradeMiner: minerNoCoins } },
        activities: [ACTIVITIES[0]!],
        demands: [skillDemand],
        requireMarketQuote: true,
        marketQuotes: {},
    });
    expect(planWithUpgrade.steps.map((s) => s.stepKind)).toEqual(['gear_upgrade', 'work']);
    expect(planWithoutUpgrade.steps.map((s) => s.stepKind)).toEqual(['work']);
    expect(planWithUpgrade.scorePerHour).toBeGreaterThan(planWithoutUpgrade.scorePerHour);

    // priorityWeight must NOT be double-multiplied when valuePerHour is already set.
    expect(planWithoutUpgrade.scorePerHour).toBeCloseTo(100 * 2.0, 2);

    // Faster activity strictly outscores slower activity for the same demand.
    const multiPlan = planAccount(minerNoCoins, {
        world: { ...world, accounts: { UpgradeMiner: minerNoCoins } },
        activities: [slowMining, fastMining],
        demands: [skillDemand],
        requireMarketQuote: true,
        marketQuotes: {},
    });
    expect(multiPlan.steps.at(-1)?.stepKind === 'work' && multiPlan.steps.at(-1)).toMatchObject({
        activityId: 'gather:mining-fast',
    });

    // GearUpgradePlannedStep preserves source metadata (donorAccount/hub for hub_banker, estimatedCoinCost for GE).
    const upgradeStep = planWithUpgrade.steps[0];
    expect(upgradeStep?.stepKind).toBe('gear_upgrade');
    if (upgradeStep?.stepKind === 'gear_upgrade') {
        expect(upgradeStep.source).toBe('ge');
        expect(upgradeStep.estimatedCoinCost).toBe(32_000);
        expect(upgradeStep.coinFloatPreserved).toBe(1000);
    }

    const donorMiner = makeAcct({
        name: 'DonorMiner',
        pos: { x: 3185, z: 3436, level: 0 },
        bank: { items: { 1275: 1, 995: 5000 }, observedAt: NOW - 10_000, trusted: true },
    });
    const hubUpgradePlan = planAccount(minerNoCoins, {
        world: { ...world, accounts: { UpgradeMiner: minerNoCoins, DonorMiner: donorMiner } },
        activities: [ACTIVITIES[0]!],
        demands: [skillDemand],
        requireMarketQuote: true,
        marketQuotes: {},
    });
    expect(hubUpgradePlan.steps[0]?.stepKind).toBe('gear_upgrade');
    if (hubUpgradePlan.steps[0]?.stepKind === 'gear_upgrade') {
        expect(hubUpgradePlan.steps[0].source).toBe('hub_banker');
        expect(hubUpgradePlan.steps[0].donorAccount).toBe('DonorMiner');
        expect(hubUpgradePlan.steps[0].hub).toBe('varrock_west');
    }
});

test('planAccount never picks 0-XP activities for skill unlocks/demands and selects fastest trainer + Druidic Ritual for Herblore', () => {
    const catalog = createActivityCatalog();
    const activities = catalog.list({ minTrust: 'practice_passed' });
    const zeroXpTrainer: ActivityDefinition = {
        id: 'bank-artisan:crafting-tanning-fake',
        workerId: 'bank-artisan',
        family: 'bank-artisan',
        kind: 'train',
        label: 'Zero XP crafting',
        skill: 'Crafting',
        config: { skill: 'crafting', method: 'tanning' },
        baselineRate: { xpPerTick: 0, unitsPerTick: 0.3, gpPerTick: 2, setupTicks: 10, minBatchUnits: 14, confidence: 'model' },
        trust: 'practice_passed',
    };
    const slowCrafter: ActivityDefinition = {
        id: 'bank-artisan:crafting-slow',
        workerId: 'bank-artisan',
        family: 'bank-artisan',
        kind: 'train',
        label: 'Slow crafting',
        skill: 'Crafting',
        config: { skill: 'crafting', method: 'bowstrings' },
        baselineRate: { xpPerTick: 65, unitsPerTick: 0.2, gpPerTick: 0, setupTicks: 20, minBatchUnits: 14, confidence: 'model' },
        trust: 'practice_passed',
    };
    const fastCrafter: ActivityDefinition = {
        id: 'bank-artisan:crafting-fast',
        workerId: 'bank-artisan',
        family: 'bank-artisan',
        kind: 'train',
        label: 'Fast crafting',
        skill: 'Crafting',
        config: { skill: 'crafting', method: 'inventory' },
        baselineRate: { xpPerTick: 320, unitsPerTick: 0.3, gpPerTick: 0, setupTicks: 15, minBatchUnits: 14, confidence: 'model' },
        trust: 'practice_passed',
    };
    const targetWithCraftReq: ActivityDefinition = {
        id: 'quest:craft-gated',
        workerId: 'quest',
        family: 'quest',
        kind: 'quest',
        label: 'Craft gated quest',
        questSlug: 'craftgated',
        config: { requiredSkills: { Crafting: 20 } },
        baselineRate: { xpPerTick: 50, unitsPerTick: 0.01, gpPerTick: 0, setupTicks: 15, minBatchUnits: 1, confidence: 'model' },
        trust: 'practice_passed',
    };
    const freshBot = makeAcct({
        name: 'FreshHerb',
        skills: { Hitpoints: { level: 10, xp: xpForLevel(10) } },
        quests: {},
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { FreshHerb: freshBot },
    };

    const craftUnlockPlan = planAccount(freshBot, {
        world,
        activities: [zeroXpTrainer, slowCrafter, fastCrafter, targetWithCraftReq],
        demands: [{
            id: 'd:craftgated',
            goalKind: 'quest_board',
            valueScore: 200,
            target: { kind: 'quest', questSlug: 'craftgated' },
            fulfilled: 0,
            remaining: 1,
            priorityWeight: 1,
            active: true,
        }],
    });
    expect(craftUnlockPlan.steps[0]?.stepKind).toBe('unlock');
    if (craftUnlockPlan.steps[0]?.stepKind === 'unlock') {
        expect(craftUnlockPlan.steps[0].activityId).toBe('bank-artisan:crafting-fast');
    }

    // Planning dig (requires Herblore 10, Agility 10, Thieving 25) must never emit bank-artisan:herblore-meats.
    const digPlan = planAccount(freshBot, {
        world,
        activities,
        demands: [{
            id: 'goal:quest_board:dig',
            goalKind: 'quest_board',
            valueScore: 200,
            target: { kind: 'quest', questSlug: 'dig' },
            fulfilled: 0,
            remaining: 1,
            priorityWeight: 1,
            active: true,
        }],
    });
    expect(digPlan.steps.some((s) => 'activityId' in s && s.activityId === 'bank-artisan:herblore-meats')).toBe(false);

    // A Herblore 3 skill demand without Druidic Ritual must unlock via quest:druid, never herblore:meats.
    const herbSkillPlan = planAccount(freshBot, {
        world,
        activities,
        demands: [{
            id: 'd:herb3',
            goalKind: 'specialist_prep',
            valueScore: 200,
            target: { kind: 'skill', account: 'FreshHerb', skill: 'Herblore', targetLevel: 3 },
            fulfilled: 1,
            remaining: 2,
            priorityWeight: 1,
            assignedAccount: 'FreshHerb',
            active: true,
        }],
    });
    expect(herbSkillPlan.steps.some((s) => 'activityId' in s && s.activityId === 'bank-artisan:herblore-meats')).toBe(false);
    if (herbSkillPlan.steps.length > 0) {
        expect(herbSkillPlan.steps.some((s) => 'activityId' in s && s.activityId === 'quest:druid')).toBe(true);
    }
});

test('planner excludes quest activities from combat_readiness/skill, selects lowest unmet trainSkill, uses shop-buy for items, and skips mining:loot for unlocks', () => {
    const activities = createActivityCatalog().list();
    const armyBot = makeAcct({
        name: 'ArmyBot',
        role: 'army',
        skills: {
            Attack: { level: 40, xp: xpForLevel(40) },
            Strength: { level: 90, xp: xpForLevel(90) },
            Defence: { level: 50, xp: xpForLevel(50) },
            Hitpoints: { level: 60, xp: xpForLevel(60) },
            Ranged: { level: 90, xp: xpForLevel(90) },
            Magic: { level: 90, xp: xpForLevel(90) },
            Prayer: { level: 70, xp: xpForLevel(70) },
            Agility: { level: 35, xp: xpForLevel(35) },
        },
        quests: { barcrawl: 'complete' },
        bank: {
            items: { 995: 50_000, 385: 100 },
            observedAt: NOW - 10_000,
            trusted: true,
        },
    });
    const shopBot = makeAcct({
        name: 'ShopBot',
        role: 'helper',
        skills: { Magic: { level: 60, xp: xpForLevel(60) } },
        bank: {
            items: { 995: 50_000 },
            observedAt: NOW - 10_000,
            trusted: true,
        },
    });
    const minerBot = makeAcct({
        name: 'MinerBot',
        role: 'auto',
        skills: {
            Mining: { level: 1, xp: 0 },
            Agility: { level: 25, xp: xpForLevel(25) },
            Thieving: { level: 15, xp: xpForLevel(15) },
            Magic: { level: 14, xp: xpForLevel(14) },
            Herblore: { level: 14, xp: xpForLevel(14) },
        },
        bank: {
            items: { 995: 20_000, 1265: 1 },
            observedAt: NOW - 10_000,
            trusted: true,
        },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { ArmyBot: armyBot, ShopBot: shopBot, MinerBot: minerBot },
    };

    const armyPlan = planAccount(armyBot, {
        world,
        activities,
        demands: [{
            id: 'goal:pk_army:ArmyBot',
            goalKind: 'pk_army',
            valueScore: 500,
            valuePerHour: 5000,
            target: {
                kind: 'combat_readiness',
                account: 'ArmyBot',
                targets: { Attack: 90, Strength: 90, Defence: 90, Hitpoints: 90, Ranged: 90, Magic: 90, Prayer: 70 },
            },
            fulfilled: 398,
            remaining: 200,
            priorityWeight: 1,
            assignedAccount: 'ArmyBot',
            active: true,
        }],
    });
    expect(armyPlan.steps.length).toBeGreaterThan(0);
    const armyWork = armyPlan.steps.find((s) => s.stepKind === 'work');
    expect(armyWork?.stepKind).toBe('work');
    if (armyWork?.stepKind === 'work') {
        expect(armyWork.activityId.startsWith('quest:')).toBe(false);
        expect(armyWork.config.trainSkill).toBe('Attack');
        expect(armyWork.config.targetLevel).toBe(90);
    }

    const magicSkillPlan = planAccount(armyBot, {
        world,
        activities,
        demands: [{
            id: 'd:magic-only',
            goalKind: 'pk_army',
            valueScore: 500,
            valuePerHour: 5000,
            target: { kind: 'skill', account: 'ArmyBot', skill: 'Magic', targetLevel: 95 },
            fulfilled: 90,
            remaining: 5,
            priorityWeight: 1,
            assignedAccount: 'ArmyBot',
            active: true,
        }],
    });
    expect(magicSkillPlan.steps.some((s) => 'activityId' in s && Boolean(s.activityId?.startsWith('quest:')))).toBe(false);

    // Adamant 2h sword (1317) is stocked by runnable 2handedshop; ShopBot should choose market:shop-buy with a runnable derivedProfile.
    const addy2hPlan = planAccount(shopBot, {
        world,
        activities,
        demands: [{
            id: 'campaign:haggis:item:1317',
            goalKind: 'main_supply',
            valueScore: 500,
            valuePerHour: 5000,
            target: { kind: 'item', itemId: 1317, itemName: 'Adamant 2h sword', count: 1 },
            fulfilled: 0,
            remaining: 1,
            priorityWeight: 1,
            active: true,
        }],
    });
    expect(addy2hPlan.steps).toHaveLength(1);
    const shopWork = addy2hPlan.steps[0];
    expect(shopWork?.stepKind).toBe('work');
    if (shopWork?.stepKind === 'work') {
        expect(shopWork.activityId).toBe('market:shop-buy');
        expect(shopWork.config.itemId).toBe(1317);
        expect(shopWork.config.shopId).toBe('2handedshop');
        expect(Boolean(derivedProfile(String(shopWork.config.shopId)))).toBe(true);
    }

    for (const entries of loadShopCatalogByItem().values()) {
        for (const entry of entries) {
            expect(Boolean(derivedProfile(entry.shop))).toBe(true);
        }
    }

    // Quest Watchtower requires Mining 40; unlocking Mining from level 1 must pick gather:mining-ore, never gather:mining-loot.
    const watchtowerPlan = planAccount(minerBot, {
        world,
        activities,
        demands: [{
            id: 'goal:quest_board:itwatchtower',
            goalKind: 'quest_board',
            valueScore: 300,
            valuePerHour: 1000,
            target: { kind: 'quest', questSlug: 'itwatchtower' },
            fulfilled: 0,
            remaining: 1,
            priorityWeight: 1,
            active: true,
        }],
    });
    expect(watchtowerPlan.steps.some((s) => 'activityId' in s && s.activityId === 'gather:mining-loot')).toBe(false);
    const miningUnlock = watchtowerPlan.steps.find((s) => s.stepKind === 'unlock' && s.unlockKind === 'skill' && s.skill === 'Mining');
    expect(miningUnlock).toBeDefined();
    if (miningUnlock?.stepKind === 'unlock') {
        expect(miningUnlock.activityId).toBe('gather:mining-ore');
    }
});

test('planner scales quest XP rewards by 25x, filters quarantined craft_gather producers, plans market:ge-buy with live quotes, and lets helpers plan stagingHolder campaigns', () => {
    const catalog = createActivityCatalog();
    const activities = catalog.list();

    // 1. Waterfall Quest (13,750 * 25 = 343,750 Attack XP) satisfies Attack 50 in a 2-step chain.
    const freshBot = makeAcct({
        name: 'FreshWaterfall',
        skills: {
            Attack: { level: 1, xp: 0 },
            Strength: { level: 1, xp: 0 },
            Hitpoints: { level: 10, xp: xpForLevel(10) },
        },
        quests: {},
        inventory: {},
        bank: { items: { 995: 500 }, observedAt: NOW - 10_000, trusted: true },
    });
    const waterfallAct = activities.find((a) => a.questSlug?.toLowerCase() === 'waterfall')!;
    expect(waterfallAct).toBeDefined();
    const gatedMeleeAct: ActivityDefinition = {
        id: 'combat:waterfall-gated',
        workerId: 'combat',
        family: 'combat',
        kind: 'train',
        label: 'Waterfall-gated melee',
        skill: 'Attack',
        config: {
            requiredQuests: ['waterfall'],
            requiredSkills: { Attack: 50 },
        },
        baselineRate: { xpPerTick: 200, unitsPerTick: 0.5, gpPerTick: 5, setupTicks: 10, minBatchUnits: 20, confidence: 'practice' },
        trust: 'practice_passed',
    };
    const wfPlan = planAccount(freshBot, {
        world: {
            schemaVersion: 1,
            at: NOW,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: { FreshWaterfall: freshBot },
        },
        activities: [waterfallAct, gatedMeleeAct],
        requireMarketQuote: true,
        marketQuotes: {},
        demands: [{
            id: 'd:atk60',
            goalKind: 'specialist_prep',
            valueScore: 500,
            valuePerHour: 5000,
            target: { kind: 'skill', account: 'FreshWaterfall', skill: 'Attack', targetLevel: 60 },
            fulfilled: 1,
            remaining: 59,
            priorityWeight: 1,
            assignedAccount: 'FreshWaterfall',
            active: true,
        }],
    });
    expect(wfPlan.steps).toHaveLength(2);
    expect(wfPlan.steps.some((s) => s.stepKind === 'unlock' && s.unlockKind === 'skill')).toBe(false);
    expect(wfPlan.steps[0]?.stepKind).toBe('unlock');
    if (wfPlan.steps[0]?.stepKind === 'unlock') {
        expect(wfPlan.steps[0].unlockKind).toBe('quest');
        expect(wfPlan.steps[0].questSlug?.toLowerCase()).toBe('waterfall');
    }
    expect(wfPlan.steps[1]?.stepKind).toBe('work');

    // 2. Quarantined producer activity is excluded from craft_gather supply resolution.
    const producerAct: ActivityDefinition = {
        id: 'gather:custom-raw',
        workerId: 'gather',
        family: 'gather',
        kind: 'gather',
        label: 'Gather raw shark',
        skill: 'Fishing',
        outputs: [{ itemId: 383, countPerUnit: 1 }],
        config: {},
        baselineRate: { xpPerTick: 100, unitsPerTick: 0.2, gpPerTick: 0, setupTicks: 10, minBatchUnits: 10, confidence: 'practice' },
        trust: 'practice_passed',
    };
    const consumerAct: ActivityDefinition = {
        id: 'bank-artisan:cook-custom',
        workerId: 'bank-artisan',
        family: 'bank-artisan',
        kind: 'produce',
        label: 'Cook raw shark',
        skill: 'Cooking',
        inputs: [{ itemId: 383, countPerUnit: 1 }],
        outputs: [{ itemId: 385, countPerUnit: 1 }],
        config: { requiredItems: [{ itemId: 383, count: 10 }] },
        baselineRate: { xpPerTick: 200, unitsPerTick: 0.25, gpPerTick: 0, setupTicks: 10, minBatchUnits: 10, confidence: 'practice' },
        trust: 'practice_passed',
    };
    const brokeCook = makeAcct({
        name: 'BrokeCook',
        skills: { Fishing: { level: 80, xp: xpForLevel(80) }, Cooking: { level: 85, xp: xpForLevel(85) } },
        inventory: {},
        bank: { items: { 995: 500 }, observedAt: NOW - 10_000, trusted: true },
    });
    const defect: DefectRecord = {
        id: 'def-quarantine-gather',
        activityId: 'gather:custom-raw',
        faultSignature: 'stuck',
        outcomeKind: 'worker_defect',
        account: 'BrokeCook',
        observedAt: NOW - 500,
        quarantinedAt: NOW - 500,
        quarantined: true,
        expiresAt: NOW + 60_000,
        logPath: '.practice/sim/logs/stuck.log',
        detail: 'stuck loop',
        count: 3,
    };
    const quarantinedPlan = planAccount(brokeCook, {
        world: {
            schemaVersion: 1,
            at: NOW,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: { BrokeCook: brokeCook },
        },
        activities: [producerAct, consumerAct],
        defects: [defect],
        requireMarketQuote: true,
        marketQuotes: {},
        demands: [{
            id: 'd:shark',
            goalKind: 'main_supply',
            valueScore: 500,
            valuePerHour: 5000,
            target: { kind: 'item', itemId: 385, count: 10 },
            fulfilled: 0,
            remaining: 10,
            priorityWeight: 1,
            active: true,
        }],
    });
    expect(quarantinedPlan.steps).toHaveLength(0);

    // 3. Default catalog + live marketQuotes enables market:ge-buy, and non-holder helpers can plan stagingHolder campaign demands.
    const sharkCost = Math.max(10, loadItemsMap().get(383)?.cost ?? 100);
    const stageCampaign: Campaign = {
        id: 'campaign:hiltsdeep',
        account: 'hiltsdeep',
        protectedClock: true,
        board: 'Attack',
        requiredSupplies: [{ itemId: 383, itemName: 'Raw shark', count: 20 }],
        stagingHolder: 'StageAlt',
        rehearsalProof: null,
        hiscoreMargin: null,
        state: 'staging',
        weight: 1,
    };
    const helperA = makeAcct({
        name: 'HelperA',
        role: 'helper',
        skills: { Fishing: { level: 1, xp: 0 } },
        bank: { items: { 995: 100_000 }, observedAt: NOW - 10_000, trusted: true },
    });
    const stageAlt = makeAcct({
        name: 'StageAlt',
        role: 'helper',
        bank: { items: { 995: 1_000 }, observedAt: NOW - 10_000, trusted: true },
    });
    const geWorld: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { HelperA: helperA, StageAlt: stageAlt },
    };
    const campEval = campaignShortfalls(stageCampaign, geWorld);
    expect(campEval.shortfalls).toHaveLength(1);
    expect(campEval.shortfalls[0]?.id).toBe('campaign:hiltsdeep:item:383');
    expect(campEval.shortfalls[0]?.assignedAccount).toBeUndefined();
    const gePlan = planAccount(helperA, {
        world: geWorld,
        activities,
        demands: campEval.shortfalls,
        marketQuotes: { 383: { ask: sharkCost, sell: 500, trades: 20 } },
    });
    expect(gePlan.steps).toHaveLength(1);
    expect(gePlan.steps[0]?.stepKind).toBe('work');
    if (gePlan.steps[0]?.stepKind === 'work') {
        expect(gePlan.steps[0].activityId).toBe('market:ge-buy');
    }
});

test('planner prevents multi-step coin double-spend across prepSteps and does not double-count travelTicks with RateStore', () => {
    // 1. Two required supplies each costing 4,000 gp nominal (4,600 gp buffered on GE) = 9,200 gp needed.
    const itemA = 383; // Raw shark (base cost ~100; ask 100 * 40 = 4,000)
    const itemB = 385; // Shark (base cost ~100; ask 100 * 40 = 4,000)
    const costA = Math.max(10, loadItemsMap().get(itemA)?.cost ?? 100);
    const costB = Math.max(10, loadItemsMap().get(itemB)?.cost ?? 100);
    const qtyA = Math.max(1, Math.ceil(4_000 / costA));
    const qtyB = Math.max(1, Math.ceil(4_000 / costB));
    const bufA = Math.ceil(costA * 1.15) * qtyA;
    const bufB = Math.ceil(costB * 1.15) * qtyB;

    const twoInputAct: ActivityDefinition = {
        id: 'bank-artisan:two-input',
        workerId: 'bank-artisan',
        family: 'bank-artisan',
        kind: 'produce',
        label: 'Two-input craft',
        skill: 'Cooking',
        inputs: [
            { itemId: itemA, countPerUnit: qtyA },
            { itemId: itemB, countPerUnit: qtyB },
        ],
        outputs: [{ itemId: 2434, countPerUnit: 1 }],
        config: {},
        baselineRate: { xpPerTick: 100, unitsPerTick: 0.2, gpPerTick: 0, setupTicks: 10, minBatchUnits: 1, confidence: 'practice' },
        trust: 'practice_passed',
    };
    const quotes = {
        [itemA]: { ask: costA, sell: 500, trades: 20 },
        [itemB]: { ask: costB, sell: 500, trades: 20 },
    };
    const demand: GoalDemand = {
        id: 'd:two-input',
        goalKind: 'main_supply',
        valueScore: 500,
        valuePerHour: 5000,
        target: { kind: 'item', itemId: 2434, count: 1 },
        fulfilled: 0,
        remaining: 1,
        priorityWeight: 1,
        active: true,
    };

    // Account with enough for ONE step (after 1,000 float) but NOT both must fail cleanly.
    const singleBudgetAcct = makeAcct({
        name: 'TightCoins',
        inventory: {},
        bank: { items: { 995: 1_000 + Math.max(bufA, bufB) + 500 }, observedAt: NOW - 10_000, trusted: true },
    });
    const tightPlan = planAccount(singleBudgetAcct, {
        world: { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { TightCoins: singleBudgetAcct } },
        activities: [twoInputAct],
        demands: [demand],
        marketQuotes: quotes,
    });
    expect(tightPlan.steps).toHaveLength(0);

    // Account with enough for BOTH buffered steps plus 1,000 float succeeds and keeps coinFloatPreserved = 1,000.
    const fullBudgetAcct = makeAcct({
        name: 'FullCoins',
        inventory: {},
        bank: { items: { 995: 1_000 + bufA + bufB + 500 }, observedAt: NOW - 10_000, trusted: true },
    });
    const fullPlan = planAccount(fullBudgetAcct, {
        world: { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { FullCoins: fullBudgetAcct } },
        activities: [twoInputAct],
        demands: [demand],
        marketQuotes: quotes,
    });
    expect(fullPlan.steps).toHaveLength(3);
    expect(fullPlan.steps[0]?.stepKind).toBe('acquire');
    expect(fullPlan.steps[1]?.stepKind).toBe('acquire');
    if (fullPlan.steps[1]?.stepKind === 'acquire') {
        expect(fullPlan.steps[1].coinFloatPreserved).toBe(1_000);
    }

    // 2. Plan with RateStore must not double-count travelTicks relative to baseline estimate.
    const catalog = createActivityCatalog();
    const rateStore = createRateStore({ catalog });
    const located = catalog.list().find((a) => a.id === 'gather:mining-ore' && a.location !== undefined)!;
    expect(located).toBeDefined();
    const distantMiner = makeAcct({
        name: 'FarMiner',
        pos: { x: 2655, z: 3283, level: 0 }, // Ardougne (far from Varrock/Al Kharid)
        skills: { Mining: { level: 45, xp: xpForLevel(45) } },
        bank: { items: { 1265: 1, 995: 500 }, observedAt: NOW - 10_000, trusted: true },
    });
    const mineDemand: GoalDemand = {
        id: 'd:mine-ore',
        goalKind: 'specialist_prep',
        valueScore: 200,
        valuePerHour: 2000,
        target: { kind: 'skill', account: 'FarMiner', skill: 'Mining', targetLevel: 50 },
        fulfilled: 45,
        remaining: 5,
        priorityWeight: 1,
        assignedAccount: 'FarMiner',
        active: true,
    };
    const mineWorld: WorldSnapshot = { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { FarMiner: distantMiner } };
    const withoutStore = planAccount(distantMiner, { world: mineWorld, activities: [located], demands: [mineDemand], requireMarketQuote: true, marketQuotes: {} });
    const withStore = planAccount(distantMiner, { world: mineWorld, activities: [located], demands: [mineDemand], rateStore, requireMarketQuote: true, marketQuotes: {} });
    const withoutWork = withoutStore.steps.at(-1);
    const withWork = withStore.steps.at(-1);
    expect(withoutWork?.stepKind).toBe('work');
    expect(withWork?.stepKind).toBe('work');
    if (withoutWork?.stepKind === 'work' && withWork?.stepKind === 'work') {
        expect(withWork.estimatedTicks).toBe(withoutWork.estimatedTicks);
    }
});

test('planAccount evaluates gear upgrade and band XP for the selected combat_readiness trainSkill with case-insensitive skills, and applies GE ask sanity bounds', () => {
    // 1. combat_readiness target needs Attack 40 (already at Strength 99) on a melee Strength activity.
    // Attack still needs XP so gear upgrade payback must be evaluated against Attack remaining XP rather than Strength=0.
    const meleeAct: ActivityDefinition = {
        id: 'combat:melee-camp',
        workerId: 'combat',
        family: 'combat',
        kind: 'train',
        label: 'Melee camp',
        skill: 'Strength',
        skills: ['Attack', 'Strength', 'Defence'],
        location: { x: 3185, z: 3436, level: 0 },
        config: { aioCategory: 'fighter', aioRoute: 'melee', target: 'melee', requiredLevel: 1 },
        baselineRate: {
            xpPerTick: 120,
            unitsPerTick: 0.05,
            gpPerTick: 5,
            setupTicks: 10,
            minBatchUnits: 25,
            confidence: 'live',
        },
        trust: 'live_proven',
        protectedAllowed: false,
    };
    const fighter = makeAcct({
        name: 'CombatUpg',
        skills: {
            attack: { level: 40, xp: xpForLevel(40) },
            strength: { level: 99, xp: xpForLevel(99) },
            defence: { level: 99, xp: xpForLevel(99) },
        },
        // Bronze scimitar (1321) equipped, Rune scimitar (1333) missing, enough coins in bank for GE upgrade.
        equipment: { 1321: 1 },
        bank: { items: { 995: 100_000 }, observedAt: NOW - 1000, trusted: true },
    });
    const readinessDemand: GoalDemand = {
        id: 'd:combat-ready',
        goalKind: 'pk_army',
        valueScore: 500,
        valuePerHour: 3000,
        target: { kind: 'combat_readiness', account: 'CombatUpg', targets: { Attack: 60, Strength: 60, Defence: 60 } },
        fulfilled: 2,
        remaining: 1,
        priorityWeight: 1,
        assignedAccount: 'CombatUpg',
        active: true,
    };
    const plan = planAccount(fighter, {
        world: { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { CombatUpg: fighter } },
        activities: [meleeAct],
        demands: [readinessDemand],
        marketQuotes: { 1333: { ask: 20_000, sell: 18_000, trades: 20 } },
    });
    expect(plan.steps.some((s) => s.stepKind === 'gear_upgrade' && s.itemId === 1333)).toBe(true);
    const work = plan.steps.at(-1);
    expect(work?.stepKind).toBe('work');
    if (work?.stepKind === 'work') {
        expect(work.config.trainSkill).toBe('Attack');
        expect(work.config.targetLevel).toBe(60);
    }

    // 2. Garbage GE quote outlier on item demand must be rejected consistently by direct market planner precheck.
    const directGeAct: ActivityDefinition = {
        id: 'market:ge-buy',
        workerId: 'market',
        family: 'market',
        kind: 'ge_buy',
        label: 'Buy on GE',
        location: { x: 3164, z: 3487, level: 0 },
        config: { mode: 'ge-buy' },
        baselineRate: { xpPerTick: 0, unitsPerTick: 0.4, gpPerTick: -10, setupTicks: 20, minBatchUnits: 1, confidence: 'live' },
        trust: 'live_proven',
        protectedAllowed: false,
    };
    const buyer = makeAcct({
        name: 'GeBuyer',
        bank: { items: { 995: 500_000 }, observedAt: NOW - 1000, trusted: true },
    });
    const itemDemand: GoalDemand = {
        id: 'd:dbones',
        goalKind: 'specialist_prep',
        valueScore: 200,
        valuePerHour: 1500,
        target: { kind: 'item', itemId: 536, itemName: 'Dragon bones', count: 10 },
        fulfilled: 0,
        remaining: 10,
        priorityWeight: 1,
        assignedAccount: 'GeBuyer',
        active: true,
    };
    const rejectedOutlier = planAccount(buyer, {
        world: { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { GeBuyer: buyer } },
        activities: [directGeAct],
        demands: [itemDemand],
        marketQuotes: { 536: { ask: 60_000, sell: 50_000, trades: 2 } },
    });
    expect(rejectedOutlier.steps).toHaveLength(0);
});

test('planner prevents stagingHolder over-buying, lets holder consolidate partial/full surplus, and scores nearby market buyers higher', () => {
    const geAct: ActivityDefinition = {
        id: 'market:ge-buy',
        workerId: 'market',
        family: 'market',
        kind: 'ge_buy',
        label: 'Buy on GE',
        location: { x: 3164, z: 3487, level: 0 },
        config: { mode: 'ge-buy' },
        baselineRate: { xpPerTick: 0, unitsPerTick: 4, gpPerTick: 0, setupTicks: 30, minBatchUnits: 1, confidence: 'practice' },
        trust: 'practice_passed',
    };
    const holder = makeAcct({
        name: 'StageHolder',
        role: 'helper',
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: {},
        bank: { items: {}, observedAt: NOW - 1_000, trusted: true },
    });
    const nonHolder = makeAcct({
        name: 'RichHelper',
        role: 'helper',
        pos: { x: 3164, z: 3487, level: 0 },
        inventory: { 995: 500_000 },
        bank: { items: { 995: 500_000 }, observedAt: NOW - 1_000, trusted: true },
    });
    const donor = makeAcct({
        name: 'StockDonor',
        role: 'helper',
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: {},
        bank: { items: { 536: 200, 995: 2_000 }, observedAt: NOW - 1_000, trusted: true },
    });
    const fullSupplyDemand: GoalDemand = {
        id: 'campaign:hiltsdeep:item:536',
        goalKind: 'specialist_prep',
        valueScore: 500,
        valuePerHour: 2_000,
        target: { kind: 'item', itemId: 536, itemName: 'Dragon bones', count: 200, holder: 'StageHolder' },
        fulfilled: 0,
        remaining: 200,
        priorityWeight: 1,
        active: true,
    };
    const worldFull: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { StageHolder: holder, RichHelper: nonHolder, StockDonor: donor },
    };
    const quotes = { 536: { ask: 2000, sell: 1800, trades: 20 } };

    // Fleet non-holder surplus already covers 200 -> RichHelper must not over-buy; StageHolder consolidates via hub_banker even with 0 gp.
    const nonHolderFullPlan = planAccount(nonHolder, {
        world: worldFull,
        activities: [geAct],
        demands: [fullSupplyDemand],
        marketQuotes: quotes,
    });
    expect(nonHolderFullPlan.steps).toHaveLength(0);

    const holderPlan = planAccount(holder, {
        world: worldFull,
        activities: [geAct],
        demands: [fullSupplyDemand],
        marketQuotes: quotes,
    });
    expect(holderPlan.steps).toHaveLength(1);
    expect(holderPlan.steps[0]?.stepKind).toBe('acquire');
    if (holderPlan.steps[0]?.stepKind === 'acquire') {
        expect(holderPlan.steps[0].source).toBe('hub_banker');
        expect(holderPlan.steps[0].donorAccount).toBe('StockDonor');
        expect(holderPlan.steps[0].quantity).toBe(200);
    }

    // Partial non-holder surplus (60 of 200) -> RichHelper caps purchase to remaining 140; StageHolder consolidates 60.
    const worldPartial: WorldSnapshot = {
        ...worldFull,
        accounts: {
            ...worldFull.accounts,
            StockDonor: { ...donor, bank: { items: { 536: 60, 995: 2_000 }, observedAt: NOW - 1_000, trusted: true } },
        },
    };
    const nonHolderPartialPlan = planAccount(nonHolder, {
        world: worldPartial,
        activities: [geAct],
        demands: [fullSupplyDemand],
        marketQuotes: quotes,
    });
    expect(nonHolderPartialPlan.steps).toHaveLength(1);
    if (nonHolderPartialPlan.steps[0]?.stepKind === 'work') {
        expect(nonHolderPartialPlan.steps[0].batchUnits).toBe(140);
    }

    // Travel-aware market scoring: buyer near GE beats distant buyer at Ardougne.
    const nearBuyer = makeAcct({
        name: 'NearGe',
        pos: { x: 3164, z: 3487, level: 0 },
        bank: { items: { 995: 500_000 }, observedAt: NOW - 1_000, trusted: true },
    });
    const farBuyer = makeAcct({
        name: 'FarArdy',
        pos: { x: 2655, z: 3283, level: 0 },
        bank: { items: { 995: 500_000 }, observedAt: NOW - 1_000, trusted: true },
    });
    const unheldDemand: GoalDemand = {
        id: 'd:unheld',
        goalKind: 'main_supply',
        valueScore: 500,
        valuePerHour: 2_000,
        target: { kind: 'item', itemId: 536, itemName: 'Dragon bones', count: 100 },
        fulfilled: 0,
        remaining: 100,
        priorityWeight: 1,
        active: true,
    };
    const nearPlan = planAccount(nearBuyer, {
        world: { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { NearGe: nearBuyer } },
        activities: [geAct],
        demands: [unheldDemand],
        marketQuotes: quotes,
    });
    const farPlan = planAccount(farBuyer, {
        world: { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { FarArdy: farBuyer } },
        activities: [geAct],
        demands: [unheldDemand],
        marketQuotes: quotes,
    });
    expect(nearPlan.scorePerHour).toBeGreaterThan(farPlan.scorePerHour);
});
