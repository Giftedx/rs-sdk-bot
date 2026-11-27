import { expect, test } from 'bun:test';
import { WORKER_FAMILIES, type WorkerFamily } from '../../workers/src/contracts';
import { selectItems } from '../../workers/src/market/preflight';
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
    // The walk checks the route for the account and falls back to the other hub, then to the nearest banks.
    expect(locRec.args).toEqual(['walk-to', '2619', '3332', '0', '--or=3185,3436,0', '--or-bank']);
    expect(locRec.config).toMatchObject({ targetHub: 'ardougne', fallbacks: [{ x: 3185, z: 3436, level: 0 }], orBank: true });

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
    expect(blueDragonRoute.env.BANK_PACK).toBeUndefined();

    // A generic combat job banks the leftovers of an earlier job (melee-gather.ts BANK_PACK); other combat jobs do not.
    const blackKnights = resolveActivityWorkerRoute({ id: 'combat:taverley_black_knight', family: 'combat', kind: 'gather', config: {} });
    expect(blackKnights.routeKey).toBe('taverley_black_knight');
    expect(blackKnights.env.BANK_PACK).toBe('1');
    expect(resolveActivityWorkerRoute({ id: 'combat:cow', family: 'combat', kind: 'train', config: {} }).env.BANK_PACK).toBeUndefined();
    expect(resolveActivityWorkerRoute({ id: 'combat:druid', family: 'combat', kind: 'train', config: { defaultEnv: { BANK_PACK: '0' } } }).env.BANK_PACK).toBe('0');
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

    const potionShopAcquire = resolvePlannedStepWorkerRoute('Shopper', {
        stepKind: 'acquire',
        source: 'npc_shop',
        itemId: 2434,
        itemName: 'Prayer potion(4)',
        quantity: 2,
        estimatedTicks: 30,
        estimatedCoinCost: 500,
        coinFloatPreserved: 1000,
        shopId: 'al_kharid_potion',
    });
    expect(potionShopAcquire.env.ITEMS).toBe('Prayer potion\\\\?\\(4\\\\?\\)');
    expect(potionShopAcquire.config.items).toBe('Prayer potion\\\\?\\(4\\\\?\\)');
    expect(selectItems([{ re: /^Prayer potion\(4\)$/i }], potionShopAcquire.env.ITEMS)).toHaveLength(1);
    expect(new RegExp(potionShopAcquire.env.ITEMS!, 'i').test('Prayer potion(4)')).toBe(true);

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

test('a skill unlock by inventory production makes its planned units and must reach its level', () => {
    const ctx = { catalog: createActivityCatalog() };
    const unlock = resolvePlannedStepWorkerRoute(
        'HerbBot',
        {
            stepKind: 'unlock',
            unlockKind: 'skill',
            activityId: 'bank-artisan:identify-ranarr_weed',
            skill: 'Herblore',
            targetLevel: 54,
            batchUnits: 198,
            estimatedTicks: 507,
        },
        ctx,
    );
    expect(unlock.routeKey).toBe('crafting:inventory');
    expect(unlock.args).toEqual(['crafting', 'inventory', 'identify:ranarr_weed']);
    expect(unlock.env).toMatchObject({ TRAIN_SKILL: 'Herblore', TARGET_LEVEL: '54', MAX_MAKE: '198', ORDER_MODE: 'level', MEMBERS: '1' });
    // One identification with its bank trip is 5.6 ticks on the bench, so the default 600-tick cap ends a long unlock early.
    expect(Number(unlock.env.CAP)).toBeGreaterThanOrEqual(198 * 12);

    // A plan made before unlocks carried a unit count still runs to its level, with the activity's limit.
    const unsized = resolvePlannedStepWorkerRoute(
        'HerbBot',
        { stepKind: 'unlock', unlockKind: 'skill', activityId: 'bank-artisan:identify-ranarr_weed', skill: 'Herblore', targetLevel: 54, estimatedTicks: 507 },
        ctx,
    );
    expect(unsized.env).toMatchObject({ TARGET_LEVEL: '54', ORDER_MODE: 'level', MAX_MAKE: '1' });

    // Other routes keep their own completion rule: smelting reads ORDER_MODE as exact or best-effort.
    const smelt = resolvePlannedStepWorkerRoute(
        'BarBot',
        { stepKind: 'unlock', unlockKind: 'skill', activityId: 'bank-artisan:skill:smelting.struct:smelting_iron_bar', skill: 'Smithing', targetLevel: 20, batchUnits: 40, estimatedTicks: 300 },
        ctx,
    );
    expect(smelt.env.ORDER_MODE).toBeUndefined();
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

test('craft_gather routing compiles runnable enchant, charge-glory, decant, smithing anvil, and brew inventory orders', () => {
    const catalog = createActivityCatalog();
    const ctx = { catalog };

    const dueling = resolvePlannedStepWorkerRoute(
        'RingMaker',
        {
            stepKind: 'acquire',
            source: 'craft_gather',
            itemId: 2552,
            quantity: 4,
            estimatedTicks: 30,
            estimatedCoinCost: 0,
            coinFloatPreserved: 1000,
            activityId: 'bank-artisan:magic-enchant-emerald_ring',
        },
        ctx,
    );
    expect(dueling.routeKey).toBe('magic:items');
    expect(dueling.args).toEqual(['magic', 'items', 'enchant:emerald_ring', '-', '4', '1000']);

    const gloryUncharged = resolvePlannedStepWorkerRoute(
        'GloryEnchanter',
        {
            stepKind: 'acquire',
            source: 'craft_gather',
            itemId: 1704,
            quantity: 2,
            estimatedTicks: 30,
            estimatedCoinCost: 0,
            coinFloatPreserved: 1000,
            activityId: 'bank-artisan:magic-enchant-strung_dragonstone_amulet',
        },
        ctx,
    );
    expect(gloryUncharged.routeKey).toBe('magic:items');
    expect(gloryUncharged.args).toEqual(['magic', 'items', 'enchant:strung_dragonstone_amulet', '-', '2', '1000']);
    expect(gloryUncharged.env.MEMBERS).toBe('1');

    const chargeGlory = resolvePlannedStepWorkerRoute(
        'GloryCharger',
        {
            stepKind: 'acquire',
            source: 'craft_gather',
            itemId: 1712,
            quantity: 3,
            estimatedTicks: 160,
            estimatedCoinCost: 0,
            coinFloatPreserved: 1000,
            activityId: 'logistics:charge-glory',
        },
        ctx,
    );
    expect(chargeGlory.family).toBe('logistics');
    expect(chargeGlory.routeKey).toBe('charge-glory');
    expect(chargeGlory.args).toEqual(['charge-glory']);
    expect(chargeGlory.env.MAX_GLORIES).toBe('3');

    const decantAgi = resolvePlannedStepWorkerRoute(
        'Decanter',
        {
            stepKind: 'acquire',
            source: 'craft_gather',
            itemId: 3032,
            quantity: 3,
            estimatedTicks: 20,
            estimatedCoinCost: 0,
            coinFloatPreserved: 1000,
            activityId: 'bank-artisan:decant-agility_potion',
        },
        ctx,
    );
    expect(decantAgi.routeKey).toBe('crafting:inventory');
    expect(decantAgi.args).toEqual(['crafting', 'inventory', 'decant:agility_potion']);
    expect(decantAgi.env.MAX_MAKE).toBe('3');
    expect(decantAgi.env.MEMBERS).toBe('1');

    const smithR2h = resolvePlannedStepWorkerRoute(
        'MasterSmith',
        {
            stepKind: 'acquire',
            source: 'craft_gather',
            itemId: 1319,
            quantity: 2,
            estimatedTicks: 30,
            estimatedCoinCost: 0,
            coinFloatPreserved: 1000,
            activityId: 'bank-artisan:skill:smithing:rune_2h_sword',
        },
        ctx,
    );
    expect(smithR2h.routeKey).toBe('smithing:anvil');
    expect(smithR2h.args).toEqual(['smithing', 'anvil', '1000']);
    expect(smithR2h.env.ORDER_ACTION).toBe('smith');
    expect(smithR2h.env.PRODUCT_ID).toBe('1319');
    expect(smithR2h.env.MAX_MAKE).toBe('2');

    const brewAgi3 = resolvePlannedStepWorkerRoute(
        'HerbBrewer',
        {
            stepKind: 'acquire',
            source: 'craft_gather',
            itemId: 3034,
            quantity: 5,
            estimatedTicks: 30,
            estimatedCoinCost: 0,
            coinFloatPreserved: 1000,
            activityId: 'bank-artisan:skill:brew_potion.struct:3dose1agility',
        },
        ctx,
    );
    expect(brewAgi3.routeKey).toBe('crafting:inventory');
    expect(brewAgi3.args).toEqual(['crafting', 'inventory', 'brew:3dose1agility']);
    expect(brewAgi3.env.MAX_MAKE).toBe('5');
    expect(brewAgi3.env.MEMBERS).toBe('1');

    // Legacy skill-action configs still compile cleanly to runnable methods.
    const legacySmith = resolveActivityWorkerRoute({
        id: 'bank-artisan:skill:smithing:rune_2h_sword',
        family: 'bank-artisan',
        kind: 'produce',
        skill: 'Smithing',
        config: { aioRoute: 'smithing:skill-action', productId: 1319, row: 'rune_2h_sword' },
    });
    expect(legacySmith.routeKey).toBe('smithing:anvil');
    expect(legacySmith.env.PRODUCT_ID).toBe('1319');

    const legacyHerb = resolveActivityWorkerRoute({
        id: 'bank-artisan:skill:brew_potion.struct:3dose1agility',
        family: 'bank-artisan',
        kind: 'produce',
        skill: 'Herblore',
        config: { aioRoute: 'herblore:skill-action', row: '3dose1agility' },
    });
    expect(legacyHerb.routeKey).toBe('crafting:inventory');
    expect(legacyHerb.args).toEqual(['crafting', 'inventory', 'brew:3dose1agility']);

    const smeltRunite = resolvePlannedStepWorkerRoute(
        'BarSmelter',
        {
            stepKind: 'acquire',
            source: 'craft_gather',
            itemId: 2363,
            quantity: 3,
            estimatedTicks: 50,
            estimatedCoinCost: 0,
            coinFloatPreserved: 1000,
            activityId: 'bank-artisan:skill:smelting.struct:smelting_runite_bar',
        },
        ctx,
    );
    expect(smeltRunite.routeKey).toBe('smithing:smelt');
    expect(smeltRunite.args).toEqual(['smithing', 'smelt', '1000', 'runite']);
    expect(smeltRunite.env.BAR_TYPE).toBe('runite');
    expect(smeltRunite.env.MAX_MAKE).toBe('3');

    const jewelEmerald = resolvePlannedStepWorkerRoute(
        'RingCaster',
        {
            stepKind: 'acquire',
            source: 'craft_gather',
            itemId: 1639,
            quantity: 4,
            estimatedTicks: 40,
            estimatedCoinCost: 0,
            coinFloatPreserved: 1000,
            activityId: 'bank-artisan:jewellery-emerald_ring',
        },
        ctx,
    );
    expect(jewelEmerald.routeKey).toBe('crafting:jewellery-trip');
    expect(jewelEmerald.args).toEqual(['crafting', 'jewellery-trip']);
    expect(jewelEmerald.env.RECIPE).toBe('emerald_ring');
    expect(jewelEmerald.env.TARGET).toBe('4');
    expect(jewelEmerald.env.CAP).toBe('1000');

    const legacySmelt = resolveActivityWorkerRoute({
        id: 'bank-artisan:skill:smelting.struct:smelting_gold_bar',
        family: 'bank-artisan',
        kind: 'produce',
        skill: 'Smithing',
        config: { aioRoute: 'smithing:skill-action', table: 'smelting.struct', row: 'smelting_gold_bar' },
    });
    expect(legacySmelt.routeKey).toBe('smithing:smelt');
    expect(legacySmelt.env.BAR_TYPE).toBe('gold');

    const legacyGem = resolveActivityWorkerRoute({
        id: 'bank-artisan:skill:gem_cutting_table:dragonstone_cutting',
        family: 'bank-artisan',
        kind: 'produce',
        skill: 'Crafting',
        config: { aioRoute: 'crafting:skill-action', table: 'gem_cutting_table', row: 'dragonstone_cutting' },
    });
    expect(legacyGem.routeKey).toBe('crafting:inventory');
    expect(legacyGem.args).toEqual(['crafting', 'inventory', 'cut-dragonstone']);
});

test('a planned shop step fills its order, waits for a restock and stops at the owned total', () => {
    const vials = resolvePlannedStepWorkerRoute('KnightRider', {
        stepKind: 'acquire',
        source: 'npc_shop',
        itemId: 227,
        itemName: 'Vial of water',
        quantity: 2,
        stockTarget: 2,
        estimatedTicks: 30,
        estimatedCoinCost: 4,
        coinFloatPreserved: 1000,
        shopId: 'adventurershop',
    });
    expect(vials.env.FILL_ORDER).toBe('1');
    expect(vials.env.STOCK_TARGET).toBe('2');
    expect(vials.env.MAX_ITEMS).toBe('2');
    expect(Number(vials.env.NO_BUY_TICKS)).toBeGreaterThan(30);
    expect(vials.config).toMatchObject({ fillOrder: true, stockTarget: 2, maxItems: 2 });

    const noTarget = resolvePlannedStepWorkerRoute('KnightRider', {
        stepKind: 'acquire', source: 'npc_shop', itemId: 227, quantity: 2, estimatedTicks: 30, estimatedCoinCost: 4, coinFloatPreserved: 1000, shopId: 'adventurershop',
    });
    expect(noTarget.env.STOCK_TARGET).toBeUndefined();
    expect(noTarget.env.FILL_ORDER).toBe('1');

    const staff = resolvePlannedStepWorkerRoute('Earlyshooter', {
        stepKind: 'gear_upgrade',
        itemId: 1381,
        itemName: 'Staff of air',
        slot: 'weapon',
        netXpPerTickGain: 15,
        remainingBandTicks: 2000,
        acquisitionTicks: 60,
        paybackNetTicks: 500,
        source: 'npc_shop',
        shopId: 'zaff',
        estimatedCoinCost: 1500,
        coinFloatPreserved: 1000,
    });
    // One owned staff of air meets the upgrade, so a rerun of the chain buys no second staff.
    expect(staff.env.STOCK_TARGET).toBe('1');
    expect(staff.env.MAX_ITEMS).toBe('1');
    expect(staff.env.FILL_ORDER).toBe('1');
});

test('a market work step keeps a partial purchase: no fill order, no stock target, the short stock wait', () => {
    const work = resolvePlannedStepWorkerRoute('Packhorse', {
        stepKind: 'work',
        activityId: 'market:shop-buy',
        demandId: 'campaign:haggis:item:44',
        workerId: 'market',
        batchUnits: 197,
        estimatedTicks: 600,
        expectedValuePerHour: 100,
        config: { mode: 'shop-buy', itemId: 44, itemName: 'Rune arrowtips', quantity: 197, shopId: 'archeryshop2', estimatedCoinCost: 1000, coinFloatPreserved: 1000 },
    });
    expect(work.routeKey).toBe('shop-buy');
    expect(work.env.MAX_ITEMS).toBe('197');
    expect(work.env.FILL_ORDER).toBeUndefined();
    expect(work.env.STOCK_TARGET).toBeUndefined();
    expect(work.env.NO_BUY_TICKS).toBe('25');
    expect(work.env.FLOAT).toBeDefined();
    expect(work.env.STOP_AT_TARGET).toBe('1');
});

test('a production acquire names its owned total, so its inventory run makes only what the bank lacks', () => {
    const catalog = createActivityCatalog();
    const cut = catalog.list().find((a) => a.config?.aioRoute === 'crafting:inventory' && JSON.stringify(a.config?.defaultArgs) === '["cut-diamond"]');
    if (!cut) throw Error('cut-diamond activity missing');
    const step = resolvePlannedStepWorkerRoute('Abracadickra', {
        stepKind: 'acquire',
        source: 'craft_gather',
        itemId: 1601,
        quantity: 7,
        stockTarget: 7,
        estimatedTicks: 120,
        estimatedCoinCost: 0,
        coinFloatPreserved: 1000,
        activityId: cut.id,
    }, { catalog });
    expect(step.env.MAX_MAKE).toBe('7');
    expect(step.env.PRODUCT_TARGET).toBe('7');
    const noTarget = resolvePlannedStepWorkerRoute('Abracadickra', {
        stepKind: 'acquire', source: 'craft_gather', itemId: 1601, quantity: 7, estimatedTicks: 120, estimatedCoinCost: 0, coinFloatPreserved: 1000, activityId: cut.id,
    }, { catalog });
    expect(noTarget.env.PRODUCT_TARGET).toBeUndefined();
});

test('an inventory work step makes its planned batch, not the catalog default of one', () => {
    const ctx = { catalog: createActivityCatalog() };
    const work = resolvePlannedStepWorkerRoute('Unsheathed', {
        stepKind: 'work',
        activityId: 'bank-artisan:identify-avantoe',
        demandId: 'campaign:haggis:item:261',
        workerId: 'bank-artisan',
        batchUnits: 5,
        estimatedTicks: 60,
        expectedValuePerHour: 100,
        config: { batchUnits: 5 },
    }, ctx);
    expect(work.routeKey).toBe('crafting:inventory');
    expect(work.env.MAX_MAKE).toBe('5');
    // A bank short of the staged herbs ends the run after the herbs it holds.
    expect(work.env.ORDER_MODE).toBe('best-effort');
    expect(Number(work.env.CAP)).toBeGreaterThanOrEqual(600);
});

test('a planned shop buy and its worker share one tick cap', async () => {
    const { SHOP_BUY_CAP_TICKS } = await import('../src/acquire');
    const work = resolvePlannedStepWorkerRoute('Packhorse', {
        stepKind: 'work',
        activityId: 'market:shop-buy',
        demandId: 'campaign:haggis:item:44',
        workerId: 'market',
        batchUnits: 10,
        estimatedTicks: 600,
        expectedValuePerHour: 100,
        config: { mode: 'shop-buy', itemId: 44, itemName: 'Rune arrowtips', quantity: 10, shopId: 'archeryshop2', estimatedCoinCost: 1000, coinFloatPreserved: 1000 },
    });
    expect(work.args).toEqual(['shop-buy', 'archeryshop2', String(SHOP_BUY_CAP_TICKS)]);
    expect(work.config.cap).toBe(SHOP_BUY_CAP_TICKS);
});

test('a location recovery inside a walled place runs the quest exit, not the walk to a hub', async () => {
    const { walledRecoveryReason } = await import('../src/worker-routing');
    const step = resolvePlannedStepWorkerRoute('KnightRider', {
        stepKind: 'recover',
        recoveryKind: 'location',
        targetHub: 'ardougne',
        estimatedTicks: 60,
        reason: walledRecoveryReason({ id: 'west-ardougne', openedByQuest: 'biohazard' }),
    });
    expect(step.stepKind).toBe('recover');
    expect(step.family).toBe('quest');
    expect(step.routeKey).toBe('quest:biohazard');
    expect(step.args).toEqual(['sweep', 'biohazard']);

    const walk = resolvePlannedStepWorkerRoute('KnightRider', {
        stepKind: 'recover', recoveryKind: 'location', targetHub: 'varrock_west', estimatedTicks: 60, reason: 'stranded off-hub or non-ground plane',
    });
    expect(walk.routeKey).toBe('walk-to');
});
