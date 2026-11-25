import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateSupplies } from '../packages/core/src/launch-evidence';
import { RESERVED_ACCOUNTS } from '../packages/core/src/specialist-boards';
import { xpForLevel } from '../packages/planner/src/curve';
import { observedSupplies } from '../packages/practice/src/specialist-rehearsal';
import { selectItems } from '../packages/workers/src/market';
import {
    assertSupplierAccount,
    chooseDesiredAmmo,
    chooseDesiredArmor,
    chooseDesiredChaps,
    chooseDesiredWeapon,
    countAnyId,
    countById,
    EDGEVILLE_SUPPLIER_STAND,
    hasAtLeastKit,
    hasExactKit,
    isAdjacentToCannon,
    ITEM_IDS,
    kitRequirements,
    kitSlotTotal,
    LUMBRIDGE_HANDOFF,
    parseSpecialistArgs,
    RANGED_PVP_SPECIALIST_KIT,
    RANGED_SPECIALIST_KIT,
    RANGED_SPECIALIST_LIVE_KIT,
    RANGED_SPECIALIST_LIVE_TRADE1,
    RANGED_SPECIALIST_LIVE_TRADE2,
    RANGED_SPECIALIST_MSB_KIT,
    RANGED_SPECIALIST_MSB_TRADE1,
    RANGED_SPECIALIST_MSB_TRADE2,
    RANGED_SPECIALIST_TRADE1,
    RANGED_SPECIALIST_TRADE2,
    shouldDrinkAntipoison,
    shouldDrinkRanging,
    shouldDrinkSuperRestore,
    totalDoses,
    variantKit,
    variantTrades,
    weaponReach,
} from './ranged-specialist';
import {
    ATTACK_SPECIALIST_KIT,
    buildLegDeliveryReceipt,
    DEFAULT_STAGE_BANK,
    EDGEVILLE_BANK,
    parseSupplierCliArgs,
    resolveSupplierKitPlan,
} from '../packages/workers/src/logistics';
import {
    buildLeatherBodyShopInvocation,
    LIVE_PREP_IDS,
    parseRangedLivePrepArgs,
    planPrayerBrewBatch,
    planPrayerDecantSteps,
} from './ranged-live-prep';
import { SPECIALIST_RANGED_CASES } from './measure/specialist-ranged-cases';

const ROOT = resolve(import.meta.dir, '..');
const ITEMS: { id: number; name: string; tradeable?: boolean }[] = JSON.parse(
    readFileSync(join(ROOT, 'knowledge', 'items.json'), 'utf8'),
);

test('RANGED_SPECIALIST two-trade kits and combined supplies use cataloged tradeable items within <=28 slots per trade', () => {
    const byId = new Map(ITEMS.map(item => [item.id, item]));
    for (const [trade, expected] of [
        [RANGED_SPECIALIST_TRADE1, 28],
        [RANGED_SPECIALIST_TRADE2, 19],
        [RANGED_SPECIALIST_MSB_TRADE1, 28],
        [RANGED_SPECIALIST_MSB_TRADE2, 20],
        [RANGED_SPECIALIST_LIVE_TRADE1, 24],
        [RANGED_SPECIALIST_LIVE_TRADE2, 21],
    ] as const) {
        expect(kitSlotTotal(trade)).toBe(expected);
        expect(expected).toBeLessThanOrEqual(28);
        for (const spec of trade) {
            const entry = byId.get(spec.id);
            expect(entry).toBeDefined();
            expect(entry!.tradeable).toBe(true);
            expect(entry!.name).toBe(spec.name);
        }
        const inv = trade.flatMap(spec =>
            spec.stackable
                ? [{ id: spec.id, count: spec.count }]
                : Array.from({ length: spec.count }, () => ({ id: spec.id, count: 1 })),
        );
        expect(inv.length).toBe(expected);
        expect(hasExactKit(inv, trade)).toBe(true);
        expect(hasAtLeastKit([...inv, { id: 882, count: 10 }], trade)).toBe(true);
    }
    expect(countById(RANGED_SPECIALIST_KIT, ITEM_IDS.cannonball)).toBe(2000);
    expect(countById(RANGED_SPECIALIST_KIT, 3024)).toBe(8);
    expect(countById(RANGED_SPECIALIST_KIT, 3016)).toBe(7);
    expect(countById(RANGED_SPECIALIST_KIT, 1897)).toBe(3);
    expect(countById(RANGED_SPECIALIST_LIVE_KIT, ITEM_IDS.cannonball)).toBe(1500);
    expect(countById(RANGED_SPECIALIST_LIVE_KIT, 2434)).toBe(8);
    expect(countById(RANGED_SPECIALIST_LIVE_KIT, 175)).toBe(8);
    expect(countById(RANGED_SPECIALIST_LIVE_KIT, 379)).toBe(5);
    expect(variantKit('knives')).toBe(RANGED_SPECIALIST_KIT);
    expect(variantKit('msb')).toBe(RANGED_SPECIALIST_MSB_KIT);
    expect(variantKit('live')).toBe(RANGED_SPECIALIST_LIVE_KIT);
    expect(variantTrades('knives')).toEqual({ trade1: RANGED_SPECIALIST_TRADE1, trade2: RANGED_SPECIALIST_TRADE2 });
    expect(variantTrades('msb')).toEqual({ trade1: RANGED_SPECIALIST_MSB_TRADE1, trade2: RANGED_SPECIALIST_MSB_TRADE2 });
    expect(variantTrades('live')).toEqual({ trade1: RANGED_SPECIALIST_LIVE_TRADE1, trade2: RANGED_SPECIALIST_LIVE_TRADE2 });
});

test('assertSupplierAccount rejects reserved specialists and invalid names', () => {
    for (const reserved of RESERVED_ACCOUNTS) {
        expect(() => assertSupplierAccount(reserved)).toThrow('reserved');
        expect(() => assertSupplierAccount(reserved.toUpperCase())).toThrow('reserved');
    }
    expect(() => assertSupplierAccount('')).toThrow('invalid');
    expect(() => assertSupplierAccount('name_over_12_chars')).toThrow('invalid');
    expect(assertSupplierAccount('Moneyshot')).toBe('Moneyshot');
});

test('weapon, gear, potion, and sustain scheduling rules behave across Ranged 1..99', () => {
    const invKnives = [
        { id: ITEM_IDS.ironKnife, slot: 0, count: 250 },
        { id: ITEM_IDS.runeKnife, slot: 1, count: 2000 },
        { id: ITEM_IDS.blackChaps, slot: 2, count: 1 },
    ];
    expect(chooseDesiredWeapon(1, invKnives, [], 'knives')?.id).toBe(ITEM_IDS.ironKnife);
    expect(chooseDesiredWeapon(39, invKnives, [{ id: ITEM_IDS.ironKnife, slot: 3 }], 'knives')).toBeUndefined();
    expect(chooseDesiredWeapon(40, invKnives, [{ id: ITEM_IDS.ironKnife, slot: 3 }], 'knives')?.id).toBe(ITEM_IDS.runeKnife);
    expect(chooseDesiredChaps(69, invKnives, [])).toBeUndefined();
    expect(chooseDesiredChaps(70, invKnives, [])?.id).toBe(ITEM_IDS.blackChaps);
    expect(chooseDesiredChaps(70, invKnives, [{ id: ITEM_IDS.blackChaps, slot: 7 }])).toBeUndefined();

    const invArmor = [
        { id: ITEM_IDS.blackChaps, slot: 0, count: 1 },
        { id: ITEM_IDS.blackVambs, slot: 1, count: 1 },
        { id: ITEM_IDS.robinHood, slot: 2, count: 1 },
        { id: ITEM_IDS.rangerBoots, slot: 3, count: 1 },
    ];
    expect(chooseDesiredArmor(39, invArmor, [])).toBeUndefined();
    expect(chooseDesiredArmor(40, invArmor, [])?.id).toBe(ITEM_IDS.robinHood);
    expect(chooseDesiredArmor(40, invArmor, [{ id: ITEM_IDS.robinHood, slot: 0 }])?.id).toBe(ITEM_IDS.rangerBoots);
    expect(chooseDesiredArmor(70, invArmor, [])?.id).toBe(ITEM_IDS.blackChaps);
    expect(chooseDesiredArmor(70, invArmor, [{ id: ITEM_IDS.blackChaps, slot: 7 }])?.id).toBe(ITEM_IDS.blackVambs);

    expect(isAdjacentToCannon({ x: 3291, z: 3814 }, { x: 3291, z: 3815 })).toBe(true);
    expect(isAdjacentToCannon({ x: 3290, z: 3816 }, { x: 3291, z: 3815 })).toBe(true);
    expect(isAdjacentToCannon({ x: 3290, z: 3814 }, { x: 3291, z: 3815 })).toBe(false);
    expect(isAdjacentToCannon({ x: 3292, z: 3816 }, { x: 3291, z: 3815 })).toBe(false);

    const invMsb = [
        { id: ITEM_IDS.ironKnife, slot: 0, count: 250 },
        { id: ITEM_IDS.msb, slot: 1, count: 1 },
    ];
    expect(chooseDesiredWeapon(49, invMsb, [{ id: ITEM_IDS.ironKnife, slot: 3 }], 'msb')).toBeUndefined();
    expect(chooseDesiredWeapon(50, invMsb, [{ id: ITEM_IDS.ironKnife, slot: 3 }], 'msb')?.id).toBe(ITEM_IDS.msb);
    expect(weaponReach([{ id: ITEM_IDS.runeKnife, slot: 3 }])).toBe(4);
    expect(weaponReach([{ id: ITEM_IDS.shortbow, slot: 3 }])).toBe(7);
    expect(weaponReach([{ id: ITEM_IDS.msb, slot: 3 }])).toBe(7);

    const invLive = [
        { id: ITEM_IDS.shortbow, slot: 0, count: 1 },
        { id: ITEM_IDS.ironArrow, slot: 1, count: 300 },
        { id: ITEM_IDS.msb, slot: 2, count: 1 },
        { id: ITEM_IDS.runeArrow, slot: 3, count: 1000 },
    ];
    expect(chooseDesiredWeapon(1, invLive, [], 'live')?.id).toBe(ITEM_IDS.shortbow);
    expect(chooseDesiredAmmo(1, invLive, [], 'live')?.id).toBe(ITEM_IDS.ironArrow);
    expect(chooseDesiredWeapon(49, invLive, [{ id: ITEM_IDS.shortbow, slot: 3 }], 'live')).toBeUndefined();
    expect(chooseDesiredWeapon(50, invLive, [{ id: ITEM_IDS.shortbow, slot: 3 }], 'live')?.id).toBe(ITEM_IDS.msb);
    expect(chooseDesiredAmmo(50, invLive, [{ id: ITEM_IDS.ironArrow, slot: 13 }], 'live')?.id).toBe(ITEM_IDS.runeArrow);
    expect(chooseDesiredAmmo(50, invLive, [{ id: ITEM_IDS.runeArrow, slot: 13 }], 'live')).toBeUndefined();

    // 8-dose Ranging pot: scheduled across 1, 22, 40, 54, 68, 77, 86, 93 without burning late doses early.
    expect(shouldDrinkRanging(1, 1, 8)).toBe(true);
    expect(shouldDrinkRanging(1, 5, 8)).toBe(false);
    expect(shouldDrinkRanging(21, 21, 7)).toBe(false);
    expect(shouldDrinkRanging(22, 23, 7)).toBe(true);
    expect(shouldDrinkRanging(40, 42, 6)).toBe(true);
    expect(shouldDrinkRanging(54, 57, 5)).toBe(true);
    expect(shouldDrinkRanging(67, 67, 4)).toBe(false);
    expect(shouldDrinkRanging(68, 72, 4)).toBe(true);
    expect(shouldDrinkRanging(77, 82, 3)).toBe(true);
    expect(shouldDrinkRanging(86, 92, 2)).toBe(true);
    expect(shouldDrinkRanging(93, 99, 1)).toBe(true);
    expect(shouldDrinkRanging(99, 99, 0)).toBe(false);

    // Super restore threshold keeps Prayer above 0 without wasting overfill.
    expect(shouldDrinkSuperRestore(16, 43)).toBe(true);
    expect(shouldDrinkSuperRestore(20, 43)).toBe(false);
    expect(shouldDrinkAntipoison(true, 10)).toBe(true);
    expect(shouldDrinkAntipoison(false, 539)).toBe(false);
    expect(shouldDrinkAntipoison(false, 540)).toBe(true);
    expect(shouldDrinkAntipoison(false, 139, false)).toBe(false);
    expect(shouldDrinkAntipoison(false, 140, false)).toBe(true);
    expect(shouldDrinkAntipoison(true, 0, false)).toBe(true);

    expect(totalDoses([{ id: 2444, count: 1 }, { id: 171, count: 1 }], ITEM_IDS.rangingPot)).toBe(6);
    expect(countAnyId([{ id: 3024, count: 1 }, { id: 3026, count: 1 }], ITEM_IDS.superRestore)).toBe(2);
});

test('parseSpecialistArgs and bench cases validate cleanly', () => {
    expect(parseSpecialistArgs(['Shaftshooter', '4800', 'VARIANT=msb', 'BENCH_SUPPLIER=Sup'])).toEqual({
        bot: 'Shaftshooter',
        cap: 4800,
        variant: 'msb',
        supplier: undefined,
        benchSupplier: 'Sup',
        benchSupplier2: undefined,
        spotCentre: { x: 3287, z: 3810, level: 0 },
    });
    expect(parseSpecialistArgs(['Shaftshooter', '5600', 'VARIANT=live', 'BENCH_SUPPLIER=Sup'])).toEqual({
        bot: 'Shaftshooter',
        cap: 5600,
        variant: 'live',
        supplier: undefined,
        benchSupplier: 'Sup',
        benchSupplier2: undefined,
        spotCentre: { x: 3287, z: 3810, level: 0 },
    });
    expect(SPECIALIST_RANGED_CASES.map(c => c.key)).toEqual([
        'fighter:ranged-specialist',
        'extra:ranged-specialist-msb',
        'extra:ranged-specialist-live',
    ]);
});

test('specialist-supplier resolves attack and 2-trade ranged kits and parses CLI options', () => {
    const attack = resolveSupplierKitPlan(undefined);
    expect(attack.name).toBe('attack');
    expect(attack.legs).toHaveLength(1);
    expect(attack.legs[0]).toEqual({ kit: ATTACK_SPECIALIST_KIT, handoff: LUMBRIDGE_HANDOFF, bank: DEFAULT_STAGE_BANK });

    const ranged = resolveSupplierKitPlan('ranged');
    expect(ranged.name).toBe('ranged');
    expect(ranged.combined).toBe(RANGED_SPECIALIST_KIT);
    expect(ranged.legs).toEqual([
        { kit: RANGED_SPECIALIST_TRADE1, handoff: LUMBRIDGE_HANDOFF, bank: DEFAULT_STAGE_BANK },
        { kit: RANGED_SPECIALIST_TRADE2, handoff: EDGEVILLE_SUPPLIER_STAND, bank: EDGEVILLE_BANK },
    ]);

    const live = resolveSupplierKitPlan('ranged-live');
    expect(live.name).toBe('ranged-live');
    expect(live.combined).toBe(RANGED_SPECIALIST_LIVE_KIT);
    expect(live.legs).toEqual([
        { kit: RANGED_SPECIALIST_LIVE_TRADE1, handoff: LUMBRIDGE_HANDOFF, bank: DEFAULT_STAGE_BANK },
        { kit: RANGED_SPECIALIST_LIVE_TRADE2, handoff: EDGEVILLE_SUPPLIER_STAND, bank: EDGEVILLE_BANK },
    ]);

    expect(() => resolveSupplierKitPlan('unknown')).toThrow('unknown kit');
    expect(parseSupplierCliArgs(['Holder', 'Shaftshooter', '--kit=ranged-live', '6000'])).toEqual({
        kitArg: 'ranged-live',
        cap: 6000,
        outArg: undefined,
        bankX: undefined,
        bankZ: undefined,
        positional: ['Holder', 'Shaftshooter', '6000'],
    });
    expect(parseSupplierCliArgs(['Donor', 'Holder', '--kit=ranged', '--out=.practice/stage', '--bank-x=3094', '--bank-z=3491'])).toEqual({
        kitArg: 'ranged',
        cap: undefined,
        outArg: '.practice/stage',
        bankX: 3094,
        bankZ: 3491,
        positional: ['Donor', 'Holder'],
    });
});

test('observedSupplies and validateSupplies round-trip for RANGED_SPECIALIST_KIT', () => {
    const ledger = JSON.stringify({
        tick: 100,
        from: 'Moneyshot',
        to: 'shaftshooter',
        fromItems: RANGED_SPECIALIST_KIT.map(k => ({ id: k.id, count: k.count })),
        toItems: [],
    });
    const observed = observedSupplies(ledger + '\n', 'shaftshooter', ITEMS);
    expect(observed).toEqual(kitRequirements(RANGED_SPECIALIST_KIT));

    const now = 1_000_000;
    const context = 'a'.repeat(64);
    const refs = new Map<string, any>([
        ['bank', { name: 'Moneyshot', server: 'rs-sdk-demo.fly.dev', bankAt: now - 1000, bank: RANGED_SPECIALIST_KIT.map(k => ({ id: k.id, count: k.count })) }],
        [
            'delivery',
            {
                ok: true,
                observed: true,
                server: 'rs-sdk-demo.fly.dev',
                from: 'Helper',
                to: 'Moneyshot',
                at: now - 2000,
                before: [],
                after: RANGED_SPECIALIST_KIT.map(k => ({ id: k.id, count: k.count })),
                items: RANGED_SPECIALIST_KIT.map(k => ({ id: k.id, count: k.count })),
            },
        ],
    ]);
    const manifest = {
        version: 2,
        context,
        at: now - 1000,
        allocations: observed.map(req => ({
            item: req.item,
            itemId: req.itemId,
            count: req.count,
            holder: 'Moneyshot',
            recipient: 'shaftshooter',
            bank: { path: 'bank' },
            delivery: { path: 'delivery' },
        })),
    };
    expect(() => validateSupplies(manifest, context, observed, ITEMS, ['Helper', 'Moneyshot'], now, ref => refs.get(ref.path), 'shaftshooter')).not.toThrow();

    const liveLedger = JSON.stringify({
        tick: 120,
        from: 'Moneyshot',
        to: 'shaftshooter',
        fromItems: RANGED_SPECIALIST_LIVE_KIT.map(k => ({ id: k.id, count: k.count })),
        toItems: [],
    });
    const liveObserved = observedSupplies(liveLedger + '\n', 'shaftshooter', ITEMS);
    expect(liveObserved).toEqual(kitRequirements(RANGED_SPECIALIST_LIVE_KIT));

    const livePlan = resolveSupplierKitPlan('ranged-live');
    const liveRefs = new Map<string, any>([
        ['bank', { name: 'Moneyshot', server: 'rs-sdk-demo.fly.dev', bankAt: now - 1000, bank: RANGED_SPECIALIST_LIVE_KIT.map(k => ({ id: k.id, count: k.count })) }],
        ...livePlan.legs.map((leg, idx) => [
            `delivery-leg${idx + 1}`,
            buildLegDeliveryReceipt({
                kitName: livePlan.name,
                leg: idx + 1,
                totalLegs: livePlan.legs.length,
                server: 'rs-sdk-demo.fly.dev',
                from: 'Helper',
                to: 'Moneyshot',
                at: now - 2000 + idx * 100,
                before: [],
                after: leg.kit.map(k => ({ id: k.id, count: k.count })),
                kit: leg.kit,
            }),
        ] as const),
    ]);
    const liveManifest = {
        version: 2,
        context,
        at: now - 1000,
        allocations: livePlan.legs.flatMap((leg, idx) =>
            leg.kit.map(item => ({
                item: item.name,
                itemId: item.id,
                count: item.count,
                holder: 'Moneyshot',
                recipient: 'shaftshooter',
                bank: { path: 'bank' },
                delivery: { path: `delivery-leg${idx + 1}` },
            })),
        ),
    };
    expect(() => validateSupplies(liveManifest, context, liveObserved, ITEMS, ['Helper', 'Moneyshot'], now, ref => liveRefs.get(ref.path), 'shaftshooter')).not.toThrow();
});

test('ranged-live-prep plans local Prayer potion brewing, decanting, and Thessalia Leather body purchases cleanly', () => {
    const localStock = new Map<number, number>([
        [LIVE_PREP_IDS.grimyRanarr, 2],
        [LIVE_PREP_IDS.snapeGrass, 7],
        [LIVE_PREP_IDS.vialOfWater, 939],
    ]);
    expect(planPrayerBrewBatch(localStock, 1).brewable).toBe(0);
    expect(planPrayerBrewBatch(localStock, 25).brewable).toBe(0);
    expect(planPrayerBrewBatch(localStock, 38)).toEqual({
        herbloreLevel: 38,
        canClean: true,
        canBrew: true,
        brewable: 2,
        cleanNeeded: 2,
        unfNeeded: 0,
        vialsNeeded: 2,
        snapeNeeded: 2,
    });

    // 4x Prayer(4) + 2x owned Prayer(3) + 2x brewed Prayer(3) = 7x Prayer(4) (28 doses) + 1 empty vial.
    const decant = planPrayerDecantSteps({ 1: 0, 2: 0, 3: 4, 4: 4 });
    expect(decant.totalDoses).toBe(28);
    expect(decant.finalCounts).toEqual({ 1: 0, 2: 0, 3: 0, 4: 7 });
    expect(decant.emptyVialsProduced).toBe(1);
    expect(decant.steps).toEqual([
        { fromDose: 3, toDose: 3, outHighDose: 4, outLowDose: 2 },
        { fromDose: 3, toDose: 3, outHighDose: 4, outLowDose: 2 },
        { fromDose: 2, toDose: 2, outHighDose: 4, outLowDose: 0 },
    ]);

    const mixed = planPrayerDecantSteps({ 1: 3, 2: 2, 3: 1, 4: 2 });
    expect(mixed.totalDoses).toBe(18);
    expect(mixed.finalCounts).toEqual({ 1: 0, 2: 1, 3: 0, 4: 4 });

    const leatherInvocation = buildLeatherBodyShopInvocation('Moneyshot');
    expect(leatherInvocation).toEqual({
        args: ['scripts/aio-market.ts', 'Moneyshot', 'shop-buy', 'data:clotheshop', '600'],
        env: {
            ITEMS: 'leather body',
            STOCK_TARGET: '1',
            STOP_AT_TARGET: '1',
            MAX_ITEMS: '1',
            BANK_PACK: '1',
            FLOAT: '500',
            COIN_RESERVE: '0',
            MAX_SPEND: '100',
            NO_BUY_TICKS: '25',
            BANK_AT: '1',
        },
    });
    expect(selectItems([{ re: /^Leather body$/i }], leatherInvocation.env.ITEMS).map(i => i.re.source)).toEqual(['^Leather body$']);

    expect(parseRangedLivePrepArgs(['Moneyshot', '--mode=leather', '--bank=varrock_east', '--cap=800'])).toEqual({
        account: 'Moneyshot',
        mode: 'leather',
        cap: 800,
        bankSpot: { x: 3253, z: 3420, level: 0 },
    });
    expect(() => parseRangedLivePrepArgs(['Shaftshooter'])).toThrow('refuses reserved account');
    expect(() => parseRangedLivePrepArgs(['Moneyshot', '--mode=bogus'])).toThrow('unknown --mode');
});

test('RANGED_PVP_SPECIALIST_KIT fits 25 tradeable cataloged slots without Super energy and parseSpecialistArgs supports VARIANT=pvp', () => {
    expect(kitSlotTotal(RANGED_PVP_SPECIALIST_KIT)).toBe(25);
    expect(RANGED_PVP_SPECIALIST_KIT.some(k => k.id === 3016)).toBe(false);
    const byId = new Map(ITEMS.map(item => [item.id, item]));
    for (const spec of RANGED_PVP_SPECIALIST_KIT) {
        const entry = byId.get(spec.id);
        expect(entry).toBeDefined();
        expect(entry!.tradeable).toBe(true);
        expect(entry!.name).toBe(spec.name);
    }
    expect(parseSpecialistArgs(['Moneyshot', '3000', 'VARIANT=pvp', 'TANKS=tank1,tank2'])).toMatchObject({
        bot: 'Moneyshot',
        cap: 3000,
        variant: 'pvp',
        tanks: ['tank1', 'tank2'],
    });
});

test('selectRangedPvpUpgradeIds upgrades Crossbow->MSB, Rune arrows, and dhide tiers in priority order', async () => {
    const { selectRangedPvpUpgradeIds } = await import('./ranged-specialist');
    const inv = [837, 881, 861, 892, 2581, 2577, 1099, 1065, 2497, 2491].map((id, slot) => ({ id, slot, name: `item-${id}`, count: 1 }));
    expect(selectRangedPvpUpgradeIds(1, inv, [])).toEqual([837, 881]);
    expect(selectRangedPvpUpgradeIds(40, inv, [{ id: 837, slot: 3, name: 'x', count: 1 }, { id: 881, slot: 13, name: 'b', count: 1 }])).toEqual([2581, 2577, 1099, 1065]);
    expect(selectRangedPvpUpgradeIds(50, inv, [])).toEqual([861, 892, 2581, 2577, 1099, 1065]);
    expect(selectRangedPvpUpgradeIds(70, inv, [{ id: 861, slot: 3, name: 'm', count: 1 }, { id: 892, slot: 13, name: 'r', count: 1 }])).toEqual([2581, 2577, 2497, 2491]);
});
