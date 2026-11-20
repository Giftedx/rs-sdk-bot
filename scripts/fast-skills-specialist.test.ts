// Unit tests for Prayer, Smithing, and Runecraft specialist supply bills, routes, and supplier kits.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateSupplies, type SupplyRequirement } from '../packages/core/src/launch-evidence';
import { preflightProgressionWork } from '../packages/core/src/progression-session';
import { xpForLevel } from '../packages/planner/src/curve';
import { intentForEntry, loadProgressionCatalog } from '../packages/planner/src/progression-catalog';
import { observedSupplies } from '../packages/practice/src/specialist-rehearsal';
import { resolveSkillerStep } from './aio-skiller';
import {
    assertCatalogItems,
    goalXp,
    ITEM_IDS,
    parseExternalSuppliers,
    parseSpecialistArgs,
    type SupplyEntry,
} from './fast-skills-lib';
import { SPECIALIST_FAST_SKILLS_CASES } from './measure/specialist-fast-skills-cases';
import { PRAYER_BONES_NEEDED, PRAYER_SUPPLY_BILL } from './prayer-specialist';
import { RUNECRAFT_SUPPLY_BILL } from './runecraft-specialist';
import { SMITHING_RUNNER_QUEUE, SMITHING_SUPPLY_BILL } from './smithing-specialist';
import {
    countById,
    hasAtLeastKit,
    hasExactKit,
    kitSlotTotal,
    parseKitArg,
    PRAYER_SPECIALIST_KIT,
    resolveBaseId,
    resolveSupplierKit,
    RUNECRAFT_SPECIALIST_KIT,
    SMITHING_SPECIALIST_KIT,
} from './specialist-supplier';

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

test('all PR #1 specialist supply bills use tradeable cataloged base IDs compatible with observedSupplies', () => {
    const bills: readonly (readonly SupplyEntry[])[] = [
        PRAYER_SUPPLY_BILL,
        SMITHING_SUPPLY_BILL,
        RUNECRAFT_SUPPLY_BILL,
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
    expect(rcEss?.count).toBe(25 + 205 * 26);
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

test('specialist-supplier kits, parseKitArg, and resolveBaseId cert mapping work for PR #1 skills', () => {
    expect(parseKitArg([])).toBe('attack');
    expect(parseKitArg(['--kit=prayer'])).toBe('prayer');
    expect(parseKitArg(['--kit=smithing'])).toBe('smithing');
    expect(parseKitArg(['--kit=runecraft'])).toBe('runecraft');
    expect(() => parseKitArg(['--kit=unknown'])).toThrow('unknown --kit');

    expect(resolveSupplierKit('prayer')).toBe(PRAYER_SPECIALIST_KIT);
    expect(resolveSupplierKit('smithing')).toBe(SMITHING_SPECIALIST_KIT);
    expect(resolveSupplierKit('runecraft')).toBe(RUNECRAFT_SPECIALIST_KIT);
    expect(kitSlotTotal(PRAYER_SPECIALIST_KIT)).toBe(PRAYER_BONES_NEEDED);

    // Base IDs remain unchanged; cert_<name> IDs from obj.pack map back to base IDs.
    expect(resolveBaseId(ITEM_IDS.dragon_bones)).toBe(ITEM_IDS.dragon_bones);
    expect(resolveBaseId(ITEM_IDS.dragon_bones + 1)).toBe(ITEM_IDS.dragon_bones);
    expect(resolveBaseId(ITEM_IDS.iron_bar + 1)).toBe(ITEM_IDS.iron_bar);
    expect(resolveBaseId(ITEM_IDS.blankrune + 1)).toBe(ITEM_IDS.blankrune);

    const notedPrayerInv = [{ id: ITEM_IDS.dragon_bones + 1, count: PRAYER_BONES_NEEDED }];
    expect(countById(notedPrayerInv, ITEM_IDS.dragon_bones)).toBe(PRAYER_BONES_NEEDED);
    expect(hasExactKit(notedPrayerInv, PRAYER_SPECIALIST_KIT)).toBe(true);
    expect(hasAtLeastKit(notedPrayerInv, PRAYER_SPECIALIST_KIT)).toBe(true);
});

test('bench cases, aio-skiller routes, and progression catalog admit Prayer, Smithing, and Runecraft specialists', () => {
    expect(SPECIALIST_FAST_SKILLS_CASES.map(c => c.key)).toEqual([
        'extra:specialist-prayer',
        'extra:specialist-smithing',
        'extra:specialist-runecraft',
    ]);

    expect(resolveSkillerStep('prayer', 'specialist', ['CAP=1350']).script).toBe('scripts/prayer-specialist.ts');
    expect(resolveSkillerStep('smithing', 'specialist', ['CAP=1350']).script).toBe('scripts/smithing-specialist.ts');
    expect(resolveSkillerStep('runecraft', 'specialist', ['CAP=2300']).script).toBe('scripts/runecraft-specialist.ts');

    const catalog = loadProgressionCatalog();
    for (const [script, skill, cap] of [
        ['scripts/prayer-specialist.ts', 'prayer', '1350'],
        ['scripts/smithing-specialist.ts', 'smithing', '1350'],
        ['scripts/runecraft-specialist.ts', 'runecraft', '2300'],
    ] as const) {
        expect(intentForEntry(script, [], { CAP: cap })).toEqual({
            kind: 'service',
            objective: `specialist:${skill}:99`,
            units: 1,
        });
        expect(() => preflightProgressionWork({ script, args: [], env: { CAP: cap, SUPPLIER: 'Moneyshot' } }, 'rs-sdk-demo.fly.dev', catalog, 'SpecBot')).not.toThrow();
    }
});
