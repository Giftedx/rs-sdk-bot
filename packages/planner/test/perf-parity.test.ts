import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    bestSet, haggisActivities, haggisTravel, loadSnapshot, schedule, scheduleOverall, scheduleQpSpecialist, TRICKS,
} from '../src/haggis';
import { bestHaggisLeg, createHaggisLegCache, legCacheFor } from '../src/haggis/travel';
import { selectProgressiveLoadout, meleeWeaponSlot } from '../src/gear-progression';
import { gearSources, resetGearSourceTables } from '../src/gear-sources';
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
