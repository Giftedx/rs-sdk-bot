import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOD_LOADOUTS } from '../pk-kits';
import { restockPlan } from '../../packages/workers/src/pvp/wild-rules';
import marketRows from '../measure/pk-restock-market.json';
import type { RestockMarket } from '../../packages/workers/src/pvp/wild-rules';
import {
    ANTIPOISON,
    assessPilotEscapePreflight,
    buildPilotRestockInput,
    detectGodGearForPilot,
    MELEE,
    selectLivePilotLoadout,
} from './live-pilot';

test('detectGodGearForPilot selects matching Mage Arena cape+staff with runes and rejects low Magic or short runes', () => {
    const saraItems = [
        { id: GOD_LOADOUTS.saradomin.capeId, name: 'Saradomin cape', count: 1 },
        { id: GOD_LOADOUTS.saradomin.staffId, name: 'Saradomin staff', count: 1 },
        { id: 565, name: 'Blood rune', count: 50 },
        { id: 554, name: 'Fire rune', count: 50 },
        { id: 556, name: 'Air rune', count: 100 },
    ];
    const god85 = detectGodGearForPilot(saraItems, 85);
    expect(god85?.spec.god).toBe('saradomin');
    expect(god85?.chargeEligible).toBe(true);
    expect(god85?.maxCasts).toBe(25);

    expect(detectGodGearForPilot(saraItems, 59)).toBeNull();
    expect(detectGodGearForPilot(saraItems, 79)?.chargeEligible).toBe(false);
    // Mismatched cape/staff must not form a god spell pair.
    const mismatched = [
        { id: GOD_LOADOUTS.saradomin.capeId, name: 'Saradomin cape', count: 1 },
        { id: GOD_LOADOUTS.zamorak.staffId, name: 'Zamorak staff', count: 1 },
        { id: 565, name: 'Blood rune', count: 50 },
        { id: 554, name: 'Fire rune', count: 50 },
        { id: 556, name: 'Air rune', count: 100 },
    ];
    expect(detectGodGearForPilot(mismatched, 85)).toBeNull();
});

test('assessPilotEscapePreflight enforces full Varrock Teleport rune checks (law + 3 air/staff + 1 fire/staff) or charged glory', () => {
    // Law rune alone without air/fire runes is NOT a valid teleport escape.
    expect(assessPilotEscapePreflight({
        magicLevel: 60,
        inventory: [{ name: 'Law rune', count: 2 }],
        equipment: [],
    })).toEqual({ ok: false, glory: false, teleport: false });

    // Valid with staff of air + fire rune + law rune.
    expect(assessPilotEscapePreflight({
        magicLevel: 25,
        inventory: [{ name: 'Law rune', count: 1 }, { name: 'Fire rune', count: 1 }],
        equipment: [{ name: 'Staff of air' }],
    })).toEqual({ ok: true, glory: false, teleport: true });

    // Uncharged glory does not count; charged glory(1) counts.
    expect(assessPilotEscapePreflight({
        magicLevel: 1,
        inventory: [{ name: 'Amulet of glory', count: 1 }],
        equipment: [],
    })).toEqual({ ok: false, glory: false, teleport: false });
    expect(assessPilotEscapePreflight({
        magicLevel: 1,
        inventory: [],
        equipment: [{ name: 'Amulet of glory(1)' }],
    })).toEqual({ ok: true, glory: true, teleport: false });
});

test('buildPilotRestockInput forwards glory, prayer pots, super pots, and antipoison into restockPlan awareness', () => {
    const missingSupplies = buildPilotRestockInput(
        [{ id: 995, name: 'Coins', count: 200_000 }],
        [],
        { attack: 70, ranged: 70, defence: 70, magic: 82 },
        false,
    );
    expect(missingSupplies.glory).toBe(false);
    expect(missingSupplies.prayerPots).toBe(0);
    expect(missingSupplies.superPots).toBe(true);
    expect(missingSupplies.antipoison).toBe(true);

    const stocked = buildPilotRestockInput(
        [
            { id: 995, name: 'Coins', count: 50_000 },
            { id: 1712, name: 'Amulet of glory(4)', count: 1 },
            { id: 2434, name: 'Prayer potion(4)', count: 1 },
            { id: 2434, name: 'Prayer potion(4)', count: 1 },
            { id: 2436, name: 'Super attack(4)', count: 1 },
            { id: 2440, name: 'Super strength(4)', count: 1 },
            { id: 2448, name: 'Superantipoison(4)', count: 1 },
        ],
        [],
        { attack: 70, ranged: 70, defence: 70, magic: 82 },
        false,
    );
    expect(stocked.glory).toBe(true);
    expect(stocked.prayerPots).toBe(2);
    expect(stocked.superPots).toBe(false);
    expect(stocked.antipoison).toBe(false);
});

test('selectLivePilotLoadout prefers worn higher-rank weapon, detects cape/staff conflict, and checks the dragon sq shield risk gate', () => {
    const loadout = selectLivePilotLoadout({
        skills: { attack: 60, ranged: 70, magic: 85, defence: 75 },
        bank: [
            { id: 1333, name: 'Rune scimitar', count: 1 },
            { id: 861, name: 'Magic shortbow', count: 1 },
            { id: 892, name: 'Rune arrow', count: 200 },
            { id: GOD_LOADOUTS.guthix.capeId, name: 'Guthix cape', count: 1 },
            { id: GOD_LOADOUTS.guthix.staffId, name: 'Guthix staff', count: 1 },
            { id: GOD_LOADOUTS.saradomin.capeId, name: 'Saradomin cape', count: 1 },
            { id: 565, name: 'Blood rune', count: 100 },
            { id: 554, name: 'Fire rune', count: 100 },
            { id: 556, name: 'Air rune', count: 200 },
        ],
        worn: [{ id: 1215, name: 'Dragon dagger', count: 1, slot: 3 }],
        riskDsq: true,
    });
    expect(loadout.keepWorn).toBe(true);
    expect(loadout.godGear?.spec.god).toBe('guthix');
    expect(loadout.conflict).toEqual({ capeGod: 'saradomin', staffGod: 'guthix' });
    expect(loadout.armourTiers[3]![0]![0].source).toContain('dragon sq shield');
    expect(loadout.armourTiers[3]![0]![1]).toBe(60);
    expect(selectLivePilotLoadout({ skills: { attack: 60, ranged: 70, magic: 85, defence: 75 }, bank: [], worn: [] })
        .armourTiers[3]!.some(([re]) => /dragon/.test(re.source))).toBe(false);
});

const RESTOCK_MARKET: RestockMarket = marketRows;
const SKILLS = { attack: 70, ranged: 70, defence: 70, magic: 82 };

test('ANTIPOISON matches the antipoison and the superantipoison of each dose and nothing else', () => {
    for (const name of ['Antipoison(4)', 'Antipoison(1)', 'Superantipoison(4)', 'Superantipoison(3)', 'Superantipoison(1)']) expect(ANTIPOISON.test(name)).toBe(true);
    for (const name of ['Antipoison', 'Superantipoison', 'Antipoison(0)', 'Superantipoison(5)', 'Antipoison++(4)', 'Prayer potion(4)', 'Super antipoison(4)']) expect(ANTIPOISON.test(name)).toBe(false);
});

test('a superantipoison in the pack or the bank counts as an antipoison, so the restock buys it once', () => {
    // Item 2448 is Superantipoison(4) and 2446 is Antipoison(4) (knowledge/items.json).
    const coins = { id: 995, name: 'Coins', count: 1_000_000 };
    for (const potion of [{ id: 2448, name: 'Superantipoison(4)', count: 1 }, { id: 2446, name: 'Antipoison(4)', count: 1 }, { id: 181, name: 'Superantipoison(3)', count: 1 }])
        expect(buildPilotRestockInput([coins, potion], [], SKILLS, false).antipoison).toBe(false);
    expect(buildPilotRestockInput([coins], [], SKILLS, false).antipoison).toBe(true);
    // Poisoned: restock another one whatever is held.
    expect(buildPilotRestockInput([coins, { id: 2448, name: 'Superantipoison(4)', count: 1 }], [], SKILLS, true).antipoison).toBe(true);
    // Two runs of the pilot: the first buys the super antipoison, the second finds it and buys no more.
    const market = { ...RESTOCK_MARKET, 2448: { ask: 2500, sell: 40 } };
    const bank = [coins, { id: 1712, name: 'Amulet of glory(4)', count: 1 }, { id: 2434, name: 'Prayer potion(4)', count: 2 }, { id: 2436, name: 'Super attack(4)', count: 1 }, { id: 2440, name: 'Super strength(4)', count: 1 }];
    const anti = (stock: typeof bank) => restockPlan(buildPilotRestockInput(stock, [], SKILLS, false), market).filter(s => s.kind === 'ge' && [2448, 2446].includes(s.item));
    expect(anti(bank)).toEqual([{ kind: 'ge', item: 2448, quantity: 1, limit: 2750, owned: 0 }]);
    expect(anti([...bank, { id: 2448, name: 'Superantipoison(4)', count: 1 }])).toEqual([]);
});

test('prayer potions are counted as potions, not as bank rows', () => {
    const rows = (counts: [string, number][]) => counts.map(([name, count], id) => ({ id, name, count }));
    const glory = { id: 1712, name: 'Amulet of glory(4)', count: 1 };
    expect(buildPilotRestockInput([glory, ...rows([['Prayer potion(4)', 3]])], [], SKILLS).prayerPots).toBe(3);
    expect(buildPilotRestockInput([glory, ...rows([['Prayer potion(4)', 3], ['Prayer potion(3)', 1], ['Super restore(4)', 2], ['Prayer potion(2)', 1]])], [], SKILLS).prayerPots).toBe(7);
    expect(buildPilotRestockInput([glory], [], SKILLS).prayerPots).toBe(0);
    // One bank row with 3 potions needs no prayer potion buy. A single potion does.
    const market = RESTOCK_MARKET;
    const plan = (n: number) => restockPlan(buildPilotRestockInput([{ id: 995, name: 'Coins', count: 50_000_000 }, glory, { id: 2434, name: 'Prayer potion(4)', count: n }], [], { ...SKILLS, attack: 1 }), market);
    expect(plan(3).some(s => s.kind === 'ge' && s.item === 2434)).toBe(false);
    expect(plan(1).find(s => s.kind === 'ge' && s.item === 2434)).toMatchObject({ quantity: 3, owned: 1 });
});

test('the melee list has no dragon scimitar and keeps the dragon longsword and mace', () => {
    const matches = (name: string) => MELEE.some(([re]) => re.test(name));
    expect(matches('Dragon scimitar')).toBe(false);
    for (const name of ['Dragon dagger', 'Dragon dagger(p++)', 'Dragon longsword', 'Dragon mace', 'Rune scimitar']) expect(matches(name)).toBe(true);
    const loadout = selectLivePilotLoadout({
        skills: { attack: 75, ranged: 1, magic: 1, defence: 1 },
        bank: [{ id: 1, name: 'Dragon scimitar', count: 1 }, { id: 1333, name: 'Rune scimitar', count: 1 }], worn: [],
    });
    expect(loadout.melee?.test('Rune scimitar')).toBe(true);
    // The item does not exist in this revision's content.
    expect(readFileSync(join(import.meta.dir, '../../vendor/rs-sdk/server/content/pack/obj.pack'), 'utf8')).not.toMatch(/^\d+=dragon_scimitar$/m);
});
