import { expect, test } from 'bun:test';
import { GOD_LOADOUTS } from '../pk-kits';
import {
    assessPilotEscapePreflight,
    buildPilotRestockInput,
    detectGodGearForPilot,
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
            { id: 2448, name: 'Antipoison(4)', count: 1 },
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
