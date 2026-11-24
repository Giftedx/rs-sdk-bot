import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { priceSteps, type CairnStep } from '../src/cairn-cli';
import {
    bestSet, haggisActivities, haggisTravel, haggisUnsourceable, loadSnapshot, schedule, scheduleOverall, scheduleQpSpecialist, TRICKS,
} from '../src/haggis';
import { bestHaggisLeg, createHaggisLegCache, legCacheFor } from '../src/haggis/travel';
import {
    bestElementalStaffForRunes, bestMiningPickaxe, bestWoodcuttingAxe, meleeWeaponSlot, planToolShopUpgrade, selectProgressiveLoadout,
} from '../src/gear-progression';
import { gearSources, resetGearSourceTables } from '../src/gear-sources';
import { squadHeld, squadKeeps, squadRows } from '../src/squad';
import { loadGear } from '../../knowledge/src/gear-query';
import { idsFor, supplyBill } from '../src/supply-bill';
import type { TravelModel } from '../src/travel';

const root = join(import.meta.dir, '..', '..', '..');

test('legCacheFor binds a dedicated cache per haggisTravel model and skips non-Haggis models', () => {
    const m1 = haggisTravel();
    const m2 = haggisTravel();
    const c1 = legCacheFor(m1);
    const c2 = legCacheFor(m2);
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(c1).toBe(legCacheFor(m1));
    expect(c1).not.toBe(c2);

    const custom: TravelModel = {
        places: { a: { x: 3200, z: 3200 }, b: { x: 3220, z: 3220 } },
        cache: { legs: {}, nearestBank: {}, banks: {} },
    };
    expect(legCacheFor(undefined)).toBeUndefined();
    expect(legCacheFor(custom)).toBeUndefined();
    expect(bestHaggisLeg(custom, 'a', 'b', 99, new Map(), false, c1)).toEqual({ ticks: 14, method: 'estimate' });
});

test('Haggis schedule, scheduleOverall, bestSet, and scheduleQpSpecialist match fresh uncached travel models identically', () => {
    const boards = loadSnapshot(join(root, 'research', 'hiscores-live.json'));
    const acts = haggisActivities();
    const shared = haggisTravel();
    const fresh1 = haggisTravel();
    const fresh2 = haggisTravel();

    const sCached = schedule(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), travel: shared });
    const sFresh = schedule(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), travel: fresh1 }, createHaggisLegCache());
    expect(sCached).toEqual(sFresh);

    const oCached = scheduleOverall(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), travel: shared });
    const oFresh = scheduleOverall(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), travel: fresh2 });
    expect(oCached).toEqual(oFresh);

    const bCached = bestSet(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), travel: shared });
    const bFresh = bestSet(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), travel: haggisTravel() });
    expect(bCached).toEqual(bFresh);

    const qCached = scheduleQpSpecialist(boards, acts, { mode: 'floor', tricks: new Set(TRICKS), travel: shared });
    const qFresh = scheduleQpSpecialist(boards, acts, { mode: 'floor', tricks: new Set(TRICKS), travel: haggisTravel() });
    expect(qCached).toEqual(qFresh);
});

test('supplyBill indexed item lookup matches idsFor across exact, plural, unfinished-potion, and itemId inputs', () => {
    const items = JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')) as {
        id: number; name: string; debugname?: string;
    }[];
    const queries = ['dragon bones', 'ranarr potion (unf)', 'mort myre fungus', 'shark', 'nonexistent_supply_xyz'];
    const supplies = [
        ...queries.map(item => ({ item, count: 10 })),
        { item: 'sapphire ring', itemId: 1637, count: 5 },
    ];
    const bill = supplyBill(supplies, items, [
        { name: 'Banker', bank: [{ id: 536, count: 4 }, { id: 1637, count: 5 }] },
    ]);
    for (const q of queries) {
        const expectedIds = [...new Set(idsFor(q, items))].sort((a, b) => a - b);
        const row = bill.find(r => r.item === q)!;
        expect(row.ids).toEqual(expectedIds);
    }
    expect(bill.find(r => r.item === 'sapphire ring')!.short).toBe(0);
    expect(bill.find(r => r.item === 'dragon bones')!.short).toBe(6);
});

test('gear progression slot index and gearSources table reset keep exact parity', () => {
    resetGearSourceTables();
    const gear = loadGear();
    const runeScimitar = gear.find(g => g.id === 1333)!;
    const before = gearSources(runeScimitar, { skills: { attack: 40, smithing: 90 }, done: new Set(['Dragon Slayer']), openShops: [] });
    resetGearSourceTables();
    const after = gearSources(runeScimitar, { skills: { attack: 40, smithing: 90 }, done: new Set(['Dragon Slayer']), openShops: [] });
    expect(after).toEqual(before);

    const loadout = selectProgressiveLoadout(
        'melee',
        [{ id: 1333, count: 1 }, { id: 1201, count: 1 }],
        { attack: 40, strength: 40, defence: 40 },
        ['Dragon Slayer'],
        { trainSkill: 'Strength' },
    );
    expect(loadout.worn.weapon?.id).toBe(1333);
    expect(loadout.worn.shield?.id).toBe(1201);
    const weaponSlot = meleeWeaponSlot(40, { oneHanded: true });
    expect(weaponSlot.options.find(o => o.equippable === true)?.id).toBe(1333);
    expect(weaponSlot.options.some(o => o.id === 1319)).toBe(false); // rune 2h excluded when oneHanded: true
});

test('haggisActivities and haggisUnsourceable isolate caller mutations and invalidate on file change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haggis-boards-cache-'));
    const file = join(dir, 'boards.json');
    try {
        const writeBoards = (label: string, item: string, mtimeSec: number) => {
            writeFileSync(file, JSON.stringify({
                activities: [{ id: 'a1', label, ticks: 100, serves: ['overall'], supplies: [{ item, count: 5 }] }],
                supplyResearch: [{ item, reason: 'test', source: 'fixture' }],
            }));
            utimesSync(file, mtimeSec, mtimeSec);
        };
        writeBoards('first', 'logs', 1_700_000_000);
        const a1 = haggisActivities(file);
        const u1 = haggisUnsourceable(file);
        expect(a1[0]!.label).toBe('first');
        expect(u1[0]!.item).toBe('logs');

        // Mutating returned rows must not corrupt the cached template.
        a1[0]!.label = 'mutated';
        a1[0]!.supplies![0]!.count = 999;
        u1[0]!.item = 'mutated';
        expect(haggisActivities(file)[0]!.label).toBe('first');
        expect(haggisActivities(file)[0]!.supplies![0]!.count).toBe(5);
        expect(haggisUnsourceable(file)[0]!.item).toBe('logs');

        // Updating the file invalidates the stat cache immediately.
        writeBoards('second', 'oak logs', 1_700_000_010);
        expect(haggisActivities(file)[0]!.label).toBe('second');
        expect(haggisUnsourceable(file)[0]!.item).toBe('oak logs');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('cairn priceSteps indexed lookup aggregates joined steps and missing scripts identically', () => {
    const steps: CairnStep[] = [
        { id: 's1', label: 'Step 1', skills: 'Magic', plan: 100, took: 110, ours: ['r1', 'r2'], scripts: ['package.json', 'missing-script.ts'] },
        { id: 's2', label: 'Step 2', skills: 'Magic', plan: 50, took: 60, ours: [], scripts: [], pricedWith: 's1' },
    ];
    const order = [
        { id: 'r1', label: 'Row 1', start: 0, end: 80, ticks: 70, travel: 10, serves: ['overall'] },
        { id: 'r2', label: 'Row 2', start: 80, end: 150, ticks: 65, travel: 5, serves: ['overall'] },
    ];
    const priced = priceSteps(order as any, 100, steps, root);
    expect(priced[0]!.ours).toBe(150);
    expect(priced[0]!.plan).toBe(150);
    expect(priced[0]!.took).toBe(170);
    expect(priced[0]!.joined).toEqual(['s2']);
    expect(priced[0]!.late).toEqual(['r2']);
    expect(priced[0]!.missingScripts).toEqual(['missing-script.ts']);
});

test('tool planners and squad demand helpers isolate mutations and preserve exact recommendations', () => {
    const axe = bestWoodcuttingAxe([{ id: 1349, count: 1 }], { woodcutting: 25, attack: 1 }, { enforceAxeLevel: true });
    expect(axe.current?.item.id).toBe(1349);
    expect(axe.bestUsable?.item.id).toBe(1355);
    expect(axe.nextAcquirable?.item.id).toBe(1355);
    expect(axe.nextUnlock?.item.id).toBe(1357);

    const pick = bestMiningPickaxe([{ id: 1265, count: 1 }], { mining: 35, attack: 1 });
    expect(pick.current?.item.id).toBe(1265);
    expect(pick.bestUsable?.item.id).toBe(1271);
    expect(pick.nextUnlock?.item.id).toBe(1275);

    const staff = bestElementalStaffForRunes(
        [{ id: 1381, count: 1 }],
        { magic: 10, attack: 10 },
        ['Lost City'],
        { runeIds: [556, 557, 555] },
    );
    expect(staff.current?.item.id).toBe(1381);
    expect(staff.bestUsable).not.toBeNull();

    const shopUpgrade = planToolShopUpgrade('mining-pickaxe', [{ id: 1265, count: 1 }], 50_000, { mining: 45, attack: 1 });
    expect(shopUpgrade?.target.id).toBe(1275);

    expect(squadHeld('food', { shark: 2, swordfish: 1, lobster: 1 })).toBeCloseTo(2 + 14 / 20 + 12 / 20, 6);
    expect(squadHeld('arrow', { 'rune arrow(p)': 100, 'rune arrow': 50 })).toBe(150);
    expect(squadHeld('prayer potion(3)', { 'prayer potion(4)': 3 })).toBe(4);

    const keeps1 = squadKeeps(4);
    const origSharkKeep = keeps1.shark;
    keeps1.shark = 999_999;
    expect(squadKeeps(4).shark).toBe(origSharkKeep);

    const rows = squadRows(
        { active: true, hours: 4, members: [{ name: 'Alpha', items: { shark: 10, 'law rune': 1 } }], maxCoins: 500_000 },
        () => 100,
    );
    expect(rows.some(r => r.consumer === 'gang squad Alpha: food' && r.short === (origSharkKeep! - 10))).toBe(true);
    expect(rows.some(r => r.account === 'alpha')).toBe(true);
});
