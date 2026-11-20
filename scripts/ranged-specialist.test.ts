import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateSupplies } from '../packages/core/src/launch-evidence';
import { evaluateProgressionWork, preflightProgressionWork } from '../packages/core/src/progression-session';
import { RESERVED_ACCOUNTS } from '../packages/core/src/specialist-boards';
import { intentForEntry, loadProgressionCatalog } from '../packages/planner/src/progression-catalog';
import { xpForLevel } from '../packages/planner/src/curve';
import { observedSupplies } from '../packages/practice/src/specialist-rehearsal';
import {
    assertSupplierAccount,
    chooseDesiredChaps,
    chooseDesiredWeapon,
    countAnyId,
    countById,
    hasAtLeastKit,
    hasExactKit,
    ITEM_IDS,
    kitRequirements,
    kitSlotTotal,
    parseSpecialistArgs,
    RANGED_SPECIALIST_KIT,
    RANGED_SPECIALIST_MSB_KIT,
    shouldDrinkAntipoison,
    shouldDrinkRanging,
    shouldDrinkSuperRestore,
    totalDoses,
    variantKit,
    weaponReach,
} from './ranged-specialist';
import { SPECIALIST_RANGED_CASES } from './measure/specialist-ranged-cases';

const ROOT = resolve(import.meta.dir, '..');
const ITEMS: { id: number; name: string; tradeable?: boolean }[] = JSON.parse(
    readFileSync(join(ROOT, 'knowledge', 'items.json'), 'utf8'),
);

test('RANGED_SPECIALIST_KIT and MSB variant each fill 28 tradeable cataloged inventory slots', () => {
    const byId = new Map(ITEMS.map(item => [item.id, item]));
    for (const kit of [RANGED_SPECIALIST_KIT, RANGED_SPECIALIST_MSB_KIT]) {
        expect(kitSlotTotal(kit)).toBe(28);
        for (const spec of kit) {
            const entry = byId.get(spec.id);
            expect(entry).toBeDefined();
            expect(entry!.tradeable).toBe(true);
            expect(entry!.name).toBe(spec.name);
        }
        const inv = kit.flatMap(spec =>
            spec.stackable
                ? [{ id: spec.id, count: spec.count }]
                : Array.from({ length: spec.count }, () => ({ id: spec.id, count: 1 })),
        );
        expect(inv.length).toBe(28);
        expect(hasExactKit(inv, kit)).toBe(true);
        expect(hasAtLeastKit([...inv, { id: 882, count: 10 }], kit)).toBe(true);
    }
    expect(countById(RANGED_SPECIALIST_KIT, ITEM_IDS.cannonball)).toBe(2000);
    expect(variantKit('knives')).toBe(RANGED_SPECIALIST_KIT);
    expect(variantKit('msb')).toBe(RANGED_SPECIALIST_MSB_KIT);
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

    const invMsb = [
        { id: ITEM_IDS.ironKnife, slot: 0, count: 250 },
        { id: ITEM_IDS.msb, slot: 1, count: 1 },
    ];
    expect(chooseDesiredWeapon(49, invMsb, [{ id: ITEM_IDS.ironKnife, slot: 3 }], 'msb')).toBeUndefined();
    expect(chooseDesiredWeapon(50, invMsb, [{ id: ITEM_IDS.ironKnife, slot: 3 }], 'msb')?.id).toBe(ITEM_IDS.msb);
    expect(weaponReach([{ id: ITEM_IDS.runeKnife, slot: 3 }])).toBe(4);
    expect(weaponReach([{ id: ITEM_IDS.msb, slot: 3 }])).toBe(7);

    // 4-dose Ranging pot: doses scheduled at 1, 40, 68, 86 without burning late doses early.
    expect(shouldDrinkRanging(1, 1, 4)).toBe(true);
    expect(shouldDrinkRanging(1, 5, 4)).toBe(false);
    expect(shouldDrinkRanging(25, 25, 3)).toBe(false);
    expect(shouldDrinkRanging(40, 41, 3)).toBe(true);
    expect(shouldDrinkRanging(67, 67, 2)).toBe(false);
    expect(shouldDrinkRanging(68, 70, 2)).toBe(true);
    expect(shouldDrinkRanging(85, 85, 1)).toBe(false);
    expect(shouldDrinkRanging(86, 90, 1)).toBe(true);
    expect(shouldDrinkRanging(99, 99, 0)).toBe(false);

    // Super restore threshold keeps Prayer above 0 without wasting overfill.
    expect(shouldDrinkSuperRestore(16, 43)).toBe(true);
    expect(shouldDrinkSuperRestore(20, 43)).toBe(false);
    expect(shouldDrinkAntipoison(true, 10)).toBe(true);
    expect(shouldDrinkAntipoison(false, 539)).toBe(false);
    expect(shouldDrinkAntipoison(false, 540)).toBe(true);

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
        spotCentre: { x: 3292, z: 3816, level: 0 },
    });
    expect(SPECIALIST_RANGED_CASES.map(c => c.key)).toEqual([
        'fighter:ranged-specialist',
        'extra:ranged-specialist-msb',
    ]);
});

test('progression catalog and live work gate admit ranged-specialist across Ranged 1..98', () => {
    const work = {
        script: 'scripts/ranged-specialist.ts',
        args: [] as string[],
        env: { SUPPLIER: 'Moneyshot', CAP: '5000', LOOT_WATCH: '0', PRAYER_GUARD: '0', EAT_GUARD: '0', RANDOM_EVENTS: '1' },
    };
    const accept = { skills: { Ranged: 99 } };
    expect(intentForEntry(work.script, work.args, work.env, accept)).toEqual({
        kind: 'service',
        objective: 'fresh-clock Ranged 99 specialist route',
        units: 1,
    });

    const catalog = loadProgressionCatalog();
    expect(() => preflightProgressionWork(work, 'rs-sdk-demo.fly.dev', catalog, 'Shaftshooter')).not.toThrow();

    const now = Date.now();
    for (const rangedLevel of [1, 40, 70, 98]) {
        const status = {
            name: 'Shaftshooter',
            server: 'rs-sdk-demo.fly.dev',
            at: now,
            bankAt: now,
            questsAt: now,
            equipmentObserved: true,
            skills: [{ name: 'Ranged', level: rangedLevel, xp: rangedLevel === 1 ? 0 : xpForLevel(rangedLevel) }],
            inventory: [],
            equipment: [],
            bank: [],
            quests: [],
        };
        const res = evaluateProgressionWork(work, status, { now, accept, catalog });
        expect(res.intent).toEqual({ kind: 'service', objective: 'fresh-clock Ranged 99 specialist route', units: 1 });
        expect(res.supported).toBe(true);
    }
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
});
