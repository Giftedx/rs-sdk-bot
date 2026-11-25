// Unit tests for all 6 fast-skill specialist supply bills, routes, and supplier kits.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateSupplies, type SupplyRequirement } from '../packages/core/src/launch-evidence';
import { xpForLevel } from '../packages/planner/src/curve';
import { observedSupplies } from '../packages/practice/src/specialist-rehearsal';
import { resolveSkillerStep } from './aio-skiller';
import { CRAFTING_SUPPLY_BILL } from './crafting-specialist';
import {
    assertCatalogItems,
    goalXp,
    ITEM_IDS,
    parseExternalSuppliers,
    parseSpecialistArgs,
    pickEligibleExternalSupplier,
    type SupplyEntry,
} from './fast-skills-lib';
import { HERBLORE_BANK_HELPER_SPOT, HERBLORE_DROP_SUPPLY_BILL, HERBLORE_SUPPLY_BILL } from './herblore-specialist';
import { MAGIC_SUPPLY_BILL } from './magic-specialist';
import { SPECIALIST_FAST_SKILLS_CASES, SPECIALIST_FAST_SKILLS_EXTERNAL_CASES } from './measure/specialist-fast-skills-cases';
import { PRAYER_BONES_NEEDED, PRAYER_SUPPLY_BILL } from './prayer-specialist';
import { RUNECRAFT_SUPPLY_BILL } from './runecraft-specialist';
import { SMITHING_RUNNER_QUEUE, SMITHING_SUPPLY_BILL } from './smithing-specialist';
import {
    countById,
    CRAFTING_SPECIALIST_KIT,
    hasAtLeastKit,
    hasExactKit,
    HERBLORE_SPECIALIST_KIT,
    kitSlotTotal,
    LUMBRIDGE_HANDOFF,
    MAGIC_SPECIALIST_KIT,
    parseKitArg,
    parseSupplierCliArgs,
    parseSupplierRole,
    PRAYER_SPECIALIST_KIT,
    resolveBaseId,
    resolveSupplierKit,
    resolveSupplierKitPlan,
    RUNECRAFT_SPECIALIST_KIT,
    SMITHING_SPECIALIST_KIT,
} from '../packages/workers/src/logistics';

const ROOT = resolve(import.meta.dir, '..');
const ITEMS: { id: number; name: string; tradeable?: boolean }[] = JSON.parse(
    readFileSync(join(ROOT, 'knowledge', 'items.json'), 'utf8'),
);

function toRequirements(bill: readonly SupplyEntry[]): SupplyRequirement[] {
    return [...bill]
        .sort((a, b) => a.itemId - b.itemId)
        .map(b => ({ item: b.item, count: b.count, itemId: b.itemId }));
}

function buildTradeLedgerJsonl(supplier: string, specialist: string, bill: readonly SupplyEntry[]): string {
    return bill
        .map((entry, i) =>
            JSON.stringify({
                from: supplier,
                to: specialist,
                tick: 10 + i,
                fromItems: [{ id: entry.itemId, count: entry.count }],
                toItems: [],
            }),
        )
        .join('\n');
}

test('all 6 fast-skill specialist supply bills use tradeable cataloged base IDs compatible with observedSupplies', () => {
    const bills: readonly (readonly SupplyEntry[])[] = [
        PRAYER_SUPPLY_BILL,
        SMITHING_SUPPLY_BILL,
        RUNECRAFT_SUPPLY_BILL,
        CRAFTING_SUPPLY_BILL,
        HERBLORE_SUPPLY_BILL,
        HERBLORE_DROP_SUPPLY_BILL,
        MAGIC_SUPPLY_BILL,
    ];
    const now = 1_000_000;
    const context = 'a'.repeat(64);
    for (const bill of bills) {
        expect(() => assertCatalogItems(bill)).not.toThrow();
        const ledger = buildTradeLedgerJsonl('Moneyshot', 'SpecBot', bill);
        const observed = observedSupplies(ledger + '\n', 'SpecBot', ITEMS);
        const expected = toRequirements(bill);
        expect(observed).toEqual(expected);
        const refs = new Map<string, any>([
            ['bank', { name: 'Moneyshot', server: 'rs-sdk-demo.fly.dev', bankAt: now - 1000, bank: bill.map(b => ({ id: b.itemId, count: b.count })) }],
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
                    after: bill.map(b => ({ id: b.itemId, count: b.count })),
                    items: bill.map(b => ({ id: b.itemId, count: b.count })),
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
                recipient: 'SpecBot',
                bank: { path: 'bank' },
                delivery: { path: 'delivery' },
            })),
        };
        expect(() => validateSupplies(manifest, context, observed, ITEMS, ['Helper', 'Moneyshot'], now, ref => refs.get(ref.path), 'SpecBot')).not.toThrow();
    }
});

test('supply bill quantities cover 1-to-99 XP and Smithing runner queue totals match bill', () => {
    expect(PRAYER_BONES_NEEDED * 1800).toBeGreaterThanOrEqual(goalXp());
    expect(xpForLevel(99)).toBe(goalXp());

    const barTotals = new Map<number, number>([[ITEM_IDS.bronze_bar, 9], [ITEM_IDS.iron_bar, 17]]);
    for (const delivery of SMITHING_RUNNER_QUEUE) {
        barTotals.set(delivery.barId, (barTotals.get(delivery.barId) ?? 0) + delivery.count);
    }
    const smithingById = new Map(SMITHING_SUPPLY_BILL.map(b => [b.itemId, b.count]));
    expect(smithingById.get(ITEM_IDS.bronze_bar)).toBe(barTotals.get(ITEM_IDS.bronze_bar));
    expect(smithingById.get(ITEM_IDS.iron_bar)).toBe(barTotals.get(ITEM_IDS.iron_bar));
    expect(smithingById.get(ITEM_IDS.steel_bar)).toBe(barTotals.get(ITEM_IDS.steel_bar));
    expect(smithingById.get(ITEM_IDS.mithril_bar)).toBe(barTotals.get(ITEM_IDS.mithril_bar));
    expect(smithingById.get(ITEM_IDS.adamantite_bar)).toBe(barTotals.get(ITEM_IDS.adamantite_bar));

    const rcEss = RUNECRAFT_SUPPLY_BILL.find(b => b.itemId === ITEM_IDS.blankrune);
    expect(rcEss?.count).toBe(25 + 22 * 26 + 177 * 27);

    const dropCounts = new Map(HERBLORE_DROP_SUPPLY_BILL.map(b => [b.itemId, b.count]));
    const dropXp =
        6250 +
        (dropCounts.get(ITEM_IDS.harralandervial) ?? 0) * 1687.5 +
        (dropCounts.get(ITEM_IDS.iritvial) ?? 0) * 2500 +
        (dropCounts.get(ITEM_IDS.limpwurt_root) ?? 0) * 3125 +
        (dropCounts.get(ITEM_IDS.dragon_scale_dust) ?? 0) * 3437.5 +
        (dropCounts.get(ITEM_IDS.cadantinevial) ?? 0) * 3750 +
        (dropCounts.get(ITEM_IDS.dwarfweedvial) ?? 0) * 4062.5;
    expect(dropXp).toBeGreaterThanOrEqual(goalXp());
    expect(SPECIALIST_FAST_SKILLS_EXTERNAL_CASES.find(c => c.key === 'extra:herblore-drop')?.companions?.length).toBe(2);
});

test('parseSpecialistArgs and parseExternalSuppliers handle positional settings and external supplier env', () => {
    const parsed = parseSpecialistArgs(
        ['PrayBot', 'CAP=1350', 'TARGET=99', 'HELPERS=b,c'],
        {},
        { cap: 2000, defaultHelpers: 8 },
    );
    expect(parsed.account).toBe('PrayBot');
    expect(parsed.cap).toBe(1350);
    expect(parsed.target).toBe(99);
    expect(parsed.helpers).toEqual(['b', 'c']);

    expect(parseExternalSuppliers({ PRACTICE_SUPPLIER: 'SupplierA, SupplierB' })).toEqual(['SupplierA', 'SupplierB']);
    expect(parseExternalSuppliers({ SUPPLIER: 'Moneyshot' })).toEqual(['Moneyshot']);
    expect(parseExternalSuppliers({})).toEqual([]);
});

test('specialist-supplier kits, parseKitArg, and resolveBaseId cert mapping work for all 6 fast-skill specialists', () => {
    expect(parseKitArg([])).toBe('attack');
    expect(parseKitArg(['--kit=prayer'])).toBe('prayer');
    expect(parseKitArg(['--kit=smithing'])).toBe('smithing');
    expect(parseKitArg(['--kit=runecraft'])).toBe('runecraft');
    expect(parseKitArg(['--kit=crafting'])).toBe('crafting');
    expect(parseKitArg(['--kit=herblore'])).toBe('herblore');
    expect(parseKitArg(['--kit=magic'])).toBe('magic');
    expect(() => parseKitArg(['--kit=unknown'])).toThrow('unknown --kit');

    expect(resolveSupplierKit('prayer')).toBe(PRAYER_SPECIALIST_KIT);
    expect(resolveSupplierKit('smithing')).toBe(SMITHING_SPECIALIST_KIT);
    expect(resolveSupplierKit('runecraft')).toBe(RUNECRAFT_SPECIALIST_KIT);
    expect(resolveSupplierKit('crafting')).toBe(CRAFTING_SPECIALIST_KIT);
    expect(resolveSupplierKit('herblore')).toBe(HERBLORE_SPECIALIST_KIT);
    expect(resolveSupplierKit('magic')).toBe(MAGIC_SPECIALIST_KIT);
    expect(kitSlotTotal(PRAYER_SPECIALIST_KIT)).toBe(PRAYER_BONES_NEEDED);

    const herbPlan = resolveSupplierKitPlan('herblore');
    expect(herbPlan.legs).toHaveLength(2);
    expect(herbPlan.legs[0]!.handoff).toEqual(LUMBRIDGE_HANDOFF);
    expect(herbPlan.legs[1]!.handoff).toEqual(HERBLORE_BANK_HELPER_SPOT);
    expect(herbPlan.legs[1]!.noted).toBe(true);

    // Base IDs remain unchanged; cert_<name> IDs from obj.pack map back to base IDs.
    expect(resolveBaseId(ITEM_IDS.dragon_bones)).toBe(ITEM_IDS.dragon_bones);
    expect(resolveBaseId(ITEM_IDS.dragon_bones + 1)).toBe(ITEM_IDS.dragon_bones);
    expect(resolveBaseId(ITEM_IDS.iron_bar + 1)).toBe(ITEM_IDS.iron_bar);
    expect(resolveBaseId(ITEM_IDS.blankrune + 1)).toBe(ITEM_IDS.blankrune);
    expect(resolveBaseId(ITEM_IDS.torstolvial + 1)).toBe(ITEM_IDS.torstolvial);

    const notedPrayerInv = [{ id: ITEM_IDS.dragon_bones + 1, count: PRAYER_BONES_NEEDED }];
    expect(countById(notedPrayerInv, ITEM_IDS.dragon_bones)).toBe(PRAYER_BONES_NEEDED);
    expect(hasExactKit(notedPrayerInv, PRAYER_SPECIALIST_KIT)).toBe(true);
    expect(hasAtLeastKit(notedPrayerInv, PRAYER_SPECIALIST_KIT)).toBe(true);
});

test('bench cases and aio-skiller routes cover all 6 fast-skill specialists', () => {
    expect(SPECIALIST_FAST_SKILLS_CASES.map(c => c.key)).toEqual([
        'skiller:prayer:specialist',
        'skiller:smithing:specialist',
        'skiller:runecraft:specialist',
        'skiller:crafting:specialist',
        'skiller:herblore:specialist',
        'skiller:magic:specialist',
    ]);

    expect(resolveSkillerStep('prayer', 'specialist', ['CAP=1350']).script).toBe('scripts/prayer-specialist.ts');
    expect(resolveSkillerStep('smithing', 'specialist', ['CAP=1350']).script).toBe('scripts/smithing-specialist.ts');
    expect(resolveSkillerStep('runecraft', 'specialist', ['CAP=2300']).script).toBe('scripts/runecraft-specialist.ts');
    expect(resolveSkillerStep('crafting', 'specialist', ['CAP=250']).script).toBe('scripts/crafting-specialist.ts');
    expect(resolveSkillerStep('herblore', 'specialist', ['CAP=600']).script).toBe('scripts/herblore-specialist.ts');
    expect(resolveSkillerStep('magic', 'specialist', ['CAP=1300']).script).toBe('scripts/magic-specialist.ts');
});

test('multi-supplier runecraft role parsing, cooldown partner selection, and external bench case', () => {
    expect(parseSupplierRole([])).toBe('auto');
    expect(parseSupplierRole(['--role=starter'])).toBe('starter');
    expect(parseSupplierRole(['--role=runner'])).toBe('runner');
    expect(parseSupplierRole([], { SUPPLIER_ROLE: 'runner' })).toBe('runner');
    expect(() => parseSupplierRole(['--role=invalid'])).toThrow('unknown --role=invalid');

    const nearby = [
        { name: 'Starter', distance: 1, x: 2523, z: 4833, worldX: 2523, worldZ: 4833, index: 1 },
        { name: 'Runner1', distance: 1, x: 2523, z: 4833, worldX: 2523, worldZ: 4833, index: 2 },
        { name: 'Runner2', distance: 2, x: 2523, z: 4834, worldX: 2523, worldZ: 4834, index: 3 },
        { name: 'FarRunner', distance: 6, x: 2528, z: 4833, worldX: 2528, worldZ: 4833, index: 4 },
    ];
    const cooldowns = new Map<string, number>([['starter', 50]]);
    const picked = pickEligibleExternalSupplier(
        nearby,
        ['Starter', 'Runner1', 'Runner2', 'FarRunner'],
        cooldowns,
        10,
        {
            maxDistance: 4,
            canStand: p => Math.max(Math.abs((p.worldX ?? p.x) - 2523), Math.abs((p.worldZ ?? p.z) - 4833)) <= 3,
        },
    );
    expect(picked?.name).toBe('Runner1');

    cooldowns.set('runner1', 55);
    const nextPicked = pickEligibleExternalSupplier(
        nearby,
        ['Starter', 'Runner1', 'Runner2', 'FarRunner'],
        cooldowns,
        10,
        { maxDistance: 4 },
    );
    expect(nextPicked?.name).toBe('Runner2');

    // LRU tie-break picks least-recently-traded runner even when distance and index favor an earlier runner.
    const lruPicked = pickEligibleExternalSupplier(
        nearby,
        ['Starter', 'Runner1', 'Runner2', 'FarRunner'],
        new Map(),
        100,
        {
            maxDistance: 4,
            lastTradedTick: new Map([['starter', 80], ['runner1', 90]]),
        },
    );
    expect(lruPicked?.name).toBe('Runner2');

    expect(SPECIALIST_FAST_SKILLS_EXTERNAL_CASES.map(c => c.key)).toEqual([
        'extra:specialist-runecraft',
        'extra:herblore-drop',
    ]);
    const rcExt = SPECIALIST_FAST_SKILLS_EXTERNAL_CASES[0]!;
    expect(rcExt.companions).toHaveLength(23);
    expect(rcExt.scriptArgs[0]!.split(',')).toHaveLength(23);
    expect(rcExt.scriptArgs).toContain('SUPPLIER_KIT=runecraft');

    expect(parseSupplierCliArgs(['Holder', 'CastMyLoad', '--kit=magic', '--batch=3', '3000'])).toMatchObject({
        kitArg: 'magic',
        batchIndex: 3,
        cap: 3000,
    });
    expect(parseSupplierCliArgs(['Holder', 'SteelRod', '--kit=smithing', '--role=runner', '--runner=1/3', '2000'])).toMatchObject({
        kitArg: 'smithing',
        runnerIndex: 1,
        runnerCount: 3,
        cap: 2000,
    });
    expect(() => parseSupplierCliArgs(['Holder', 'SteelRod', '--runner=3/3'])).toThrow(/out of bounds/);
    expect(() => parseSupplierCliArgs(['Holder', 'CastMyLoad', '--batch=abc'])).toThrow(/invalid --batch/);
});
