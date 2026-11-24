import { expect, test } from 'bun:test';
import { WORKER_FAMILIES, type WorkerFamily } from '../../workers/src/contracts';
import { createActivityCatalog } from '../src/catalog';
import type { AccountPlan, ActivityDefinition } from '../src/contracts';
import {
    isSupportedWorkerFamily,
    resolveAccountWorkerPlan,
    resolveActivityWorkerRoute,
    resolvePlannedStepWorkerRoute,
} from '../src/worker-routing';

const CATALOG_SAMPLE: ActivityDefinition[] = [
    {
        id: 'gather:fishing-shark',
        workerId: 'gather',
        family: 'gather',
        kind: 'gather',
        label: 'Catch sharks',
        skill: 'Fishing',
        config: { aioCategory: 'skiller', aioRoute: 'fishing:shark', skill: 'fishing', method: 'shark' },
        baselineRate: { xpPerTick: 100, unitsPerTick: 0.1, gpPerTick: 50, setupTicks: 20, minBatchUnits: 50, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'bank-artisan:cook-shark',
        workerId: 'bank-artisan',
        family: 'bank-artisan',
        kind: 'produce',
        label: 'Cook sharks',
        skill: 'Cooking',
        config: { aioCategory: 'skiller', aioRoute: 'cooking:food', defaultArgs: ['2000', 'shark'] },
        baselineRate: { xpPerTick: 210, unitsPerTick: 0.25, gpPerTick: 15, setupTicks: 20, minBatchUnits: 50, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'combat:kbd',
        workerId: 'combat',
        family: 'combat',
        kind: 'train',
        label: 'Kill KBD',
        config: { aioCategory: 'boss', aioRoute: 'kbd', boss: 'kbd', defaultEnv: { TRIP_CAP: '2000' } },
        baselineRate: { xpPerTick: 80, unitsPerTick: 0.01, gpPerTick: 400, setupTicks: 40, minBatchUnits: 5, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'agility:gnome',
        workerId: 'agility',
        family: 'agility',
        kind: 'train',
        label: 'Gnome agility',
        skill: 'Agility',
        config: { method: 'gnome' },
        baselineRate: { xpPerTick: 86, unitsPerTick: 0.05, gpPerTick: 0, setupTicks: 15, minBatchUnits: 10, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'runecraft:air',
        workerId: 'runecraft',
        family: 'runecraft',
        kind: 'produce',
        label: 'Air runes',
        skill: 'Runecraft',
        config: { method: 'bank-craft', defaultEnv: { RUNE_ALTAR: 'air' } },
        baselineRate: { xpPerTick: 30, unitsPerTick: 0.5, gpPerTick: 10, setupTicks: 20, minBatchUnits: 28, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'quest:cook',
        workerId: 'quest',
        family: 'quest',
        kind: 'quest',
        label: "Cook's Assistant",
        questSlug: 'cook',
        config: { aioCategory: 'quester', aioRoute: 'cook', questSlug: 'cook', mode: 'sweep' },
        baselineRate: { xpPerTick: 120, unitsPerTick: 0.01, gpPerTick: 0, setupTicks: 15, minBatchUnits: 1, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'market:ge-buy',
        workerId: 'market',
        family: 'market',
        kind: 'ge_buy',
        label: 'GE buy',
        config: { aioCategory: 'market', aioRoute: 'ge-buy', mode: 'ge-buy' },
        baselineRate: { xpPerTick: 0, unitsPerTick: 10, gpPerTick: 0, setupTicks: 30, minBatchUnits: 1, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'logistics:banker',
        workerId: 'logistics',
        family: 'logistics',
        kind: 'recover',
        label: 'Stationed banker',
        config: { aioCategory: 'logistics', aioRoute: 'banker', role: 'banker' },
        baselineRate: { xpPerTick: 0, unitsPerTick: 1, gpPerTick: 0, setupTicks: 10, minBatchUnits: 1, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'pvp:hunt',
        workerId: 'pvp',
        family: 'pvp',
        kind: 'pk',
        label: 'Wildy PK hunt',
        config: { aioCategory: 'pvp', aioRoute: 'hunt', mode: 'hunt' },
        baselineRate: { xpPerTick: 0, unitsPerTick: 0.02, gpPerTick: 250, setupTicks: 25, minBatchUnits: 1, confidence: 'practice' },
        trust: 'practice_passed',
    },
];

test('resolveActivityWorkerRoute maps all 9 unified worker families purely without ScriptAdapter shims', () => {
    const routed = new Map<WorkerFamily, string>();
    for (const act of CATALOG_SAMPLE) {
        const res = resolveActivityWorkerRoute(act);
        expect(isSupportedWorkerFamily(res.family)).toBe(true);
        expect(res.routeKey.length).toBeGreaterThan(0);
        routed.set(res.family, res.routeKey);
    }

    expect([...routed.keys()].sort()).toEqual([...WORKER_FAMILIES].sort());
    expect(routed.get('gather')).toBe('fishing:shark');
    expect(routed.get('bank-artisan')).toBe('cooking:food');
    expect(routed.get('combat')).toBe('boss:kbd');
    expect(routed.get('agility')).toBe('agility:gnome');
    expect(routed.get('runecraft')).toBe('runecraft:bank-craft');
    expect(routed.get('quest')).toBe('quest:cook');
    expect(routed.get('market')).toBe('ge-buy');
    expect(routed.get('logistics')).toBe('banker');
    expect(routed.get('pvp')).toBe('hunt');
});

test('resolvePlannedStepWorkerRoute and resolveAccountWorkerPlan handle recover, acquire, gear_upgrade, unlock, and work', () => {
    const ctx = { activities: CATALOG_SAMPLE };

    const logoutRec = resolvePlannedStepWorkerRoute(
        'UnloadMe',
        { stepKind: 'recover', recoveryKind: 'logout', estimatedTicks: 20, reason: 'held proof' },
        ctx,
    );
    expect(logoutRec.executionMode).toBe('session_recovery');
    expect(logoutRec.family).toBe('logistics');
    expect(logoutRec.routeKey).toBe('logout');

    const locRec = resolvePlannedStepWorkerRoute(
        'UnloadMe',
        { stepKind: 'recover', recoveryKind: 'location', targetHub: 'ardougne', estimatedTicks: 60, reason: 'stranded' },
        ctx,
    );
    expect(locRec.executionMode).toBe('worker');
    expect(locRec.family).toBe('logistics');
    expect(locRec.routeKey).toBe('walk-to');
    expect(locRec.args[0]).toBe('walk-to');

    const plan: AccountPlan = {
        account: 'Packhorse',
        demandId: 'd:sharks',
        scorePerHour: 18,
        steps: [
            {
                stepKind: 'acquire',
                source: 'ge',
                itemId: 383,
                quantity: 100,
                estimatedTicks: 40,
                estimatedCoinCost: 40_000,
                coinFloatPreserved: 1000,
            },
            {
                stepKind: 'gear_upgrade',
                itemId: 775,
                slot: 'hands',
                netXpPerTickGain: 2,
                remainingBandTicks: 3000,
                acquisitionTicks: 20,
                paybackNetTicks: 200,
                source: 'own_bank',
            },
            {
                stepKind: 'work',
                activityId: 'bank-artisan:cook-shark',
                demandId: 'd:sharks',
                workerId: 'bank-artisan',
                batchUnits: 100,
                estimatedTicks: 425,
                expectedValuePerHour: 18,
                config: {},
            },
        ],
    };

    const resolved = resolveAccountWorkerPlan(plan, ctx);
    expect(resolved.steps.length).toBe(3);
    expect(resolved.steps[0]?.family).toBe('market');
    expect(resolved.steps[0]?.routeKey).toBe('ge-buy');
    expect(resolved.steps[1]?.family).toBe('logistics');
    expect(resolved.steps[1]?.routeKey).toBe('loadout');
    expect(resolved.steps[2]?.family).toBe('bank-artisan');
    expect(resolved.steps[2]?.routeKey).toBe('cooking:food');
    expect(resolved.steps[2]?.env.DEMAND_ID).toBe('d:sharks');
    expect(resolved.steps[0]?.env.ORDER_KEY).toBe('brain-383-100-p460');
    expect(resolved.steps[0]?.env.CASH_RESERVE).toBe('1000');
    expect(resolved.steps[0]?.env.LIMIT_PRICE).toBe('460');

    const repricedGe = resolvePlannedStepWorkerRoute('Cooker', {
        stepKind: 'acquire',
        source: 'ge',
        itemId: 383,
        quantity: 100,
        estimatedTicks: 40,
        estimatedCoinCost: 50_000,
        coinFloatPreserved: 1000,
    });
    expect(repricedGe.env.LIMIT_PRICE).toBe('575');
    expect(repricedGe.env.ORDER_KEY).toBe('brain-383-100-p575');
    expect(repricedGe.env.ORDER_KEY).not.toBe(resolved.steps[0]?.env.ORDER_KEY);

    const blueDragonRoute = resolveActivityWorkerRoute({
        id: 'combat:boss-blue-dragon',
        family: 'combat',
        kind: 'train',
        config: {},
    });
    expect(blueDragonRoute.family).toBe('combat');
    expect(blueDragonRoute.routeKey).toBe('boss:blue-dragon');
    expect(blueDragonRoute.args).toEqual(['blue-dragon']);
    expect(resolved.steps[1]?.env.EQUIP).toBe('1');

    const shopAcquire = resolvePlannedStepWorkerRoute('Shopper', {
        stepKind: 'acquire',
        source: 'npc_shop',
        itemId: 1351,
        itemName: 'Bronze axe',
        quantity: 1,
        estimatedTicks: 30,
        estimatedCoinCost: 16,
        coinFloatPreserved: 1000,
        shopId: 'axeshop',
    });
    expect(shopAcquire.env.ITEMS).toBe('Bronze axe');
    expect(Number(shopAcquire.env.FLOAT)).toBeGreaterThan(Number(shopAcquire.env.COIN_RESERVE));
    expect(shopAcquire.env.STOP_AT_TARGET).toBe('1');

    const upgradeHub = resolvePlannedStepWorkerRoute('Miner', {
        stepKind: 'gear_upgrade',
        itemId: 1275,
        slot: 'weapon',
        netXpPerTickGain: 15,
        remainingBandTicks: 2000,
        acquisitionTicks: 60,
        paybackNetTicks: 500,
        source: 'hub_banker',
        donorAccount: 'Donor',
        hub: 'varrock_west',
        transferOrderId: 'xfer-123',
    });
    expect(upgradeHub.executionMode).toBe('fleet_trade');
    expect(upgradeHub.args).toEqual(['fleet-trade', 'xfer-123']);

    const fullCatalog = createActivityCatalog();
    const splashUnlock = resolvePlannedStepWorkerRoute(
        'MageBot',
        {
            stepKind: 'unlock',
            unlockKind: 'skill',
            activityId: 'combat:magic-splash',
            skill: 'Magic',
            targetLevel: 37,
            estimatedTicks: 200,
        },
        { activities: fullCatalog.list() },
    );
    expect(splashUnlock.args).toEqual(['magic', 'splash', '37', '3000']);
    expect(splashUnlock.env.TARGET_LEVEL).toBe('37');
    expect(splashUnlock.env.TRAIN_SKILL).toBe('Magic');

    const trooperWork = resolvePlannedStepWorkerRoute(
        'ArmyBot',
        {
            stepKind: 'work',
            activityId: 'combat:trooper',
            demandId: 'goal:pk_army:ArmyBot',
            workerId: 'combat',
            batchUnits: 250,
            estimatedTicks: 500,
            expectedValuePerHour: 1000,
            config: { trainSkill: 'Attack', targetLevel: 90 },
        },
        { activities: fullCatalog.list() },
    );
    expect(trooperWork.env.TRAIN_SKILL).toBe('Attack');
    expect(trooperWork.env.TARGET_LEVEL).toBe('90');
    expect(trooperWork.env.DEMAND_ID).toBe('goal:pk_army:ArmyBot');

    const shopWork = resolvePlannedStepWorkerRoute(
        'ShopBuyer',
        {
            stepKind: 'work',
            activityId: 'market:shop-buy',
            demandId: 'campaign:campaign:haggis:item:564',
            workerId: 'market',
            batchUnits: 50,
            estimatedTicks: 60,
            expectedValuePerHour: 5000,
            config: {
                mode: 'shop-buy',
                itemId: 564,
                itemName: 'Cosmic rune',
                quantity: 50,
                shopId: 'magearena_runeshop',
                estimatedCoinCost: 2500,
                coinFloatPreserved: 1000,
            },
        },
        { activities: fullCatalog.list() },
    );
    expect(shopWork.family).toBe('market');
    expect(shopWork.routeKey).toBe('shop-buy');
    expect(shopWork.args).toEqual(['shop-buy', 'magearena_runeshop', '3000']);
    expect(shopWork.env.ITEM_ID).toBe('564');
    expect(shopWork.env.MAX_ITEMS).toBe('50');
    expect(shopWork.env.STOP_AT_TARGET).toBe('1');
    expect(shopWork.env.BANK_PACK).toBe('1');
    expect(shopWork.env.DEMAND_ID).toBe('campaign:campaign:haggis:item:564');
    expect(shopWork.config.profile).toBe('magearena_runeshop');
    expect(shopWork.config.items).toBe('Cosmic rune');
    expect(shopWork.config.maxItems).toBe(50);

    const agilityUnlock = resolvePlannedStepWorkerRoute(
        'AgiBot',
        {
            stepKind: 'unlock',
            unlockKind: 'skill',
            activityId: 'agility:gnome',
            skill: 'Agility',
            targetLevel: 45,
            estimatedTicks: 300,
        },
        { activities: CATALOG_SAMPLE },
    );
    expect(agilityUnlock.args).toEqual(['agility', 'order', 'gnome', '45']);
    expect(agilityUnlock.env.TARGET_LEVEL).toBe('45');
});

test('catalog covers all 9 worker families with existing standalone scripts only', () => {
    const catalog = createActivityCatalog();
    const families = new Set(catalog.list().map((a) => a.family));
    expect([...families].sort()).toEqual([...WORKER_FAMILIES].sort());
    for (const act of catalog.list()) {
        const route = resolveActivityWorkerRoute(act);
        expect(isSupportedWorkerFamily(route.family)).toBe(true);
        expect(route.routeKey.length).toBeGreaterThan(0);
    }
});
