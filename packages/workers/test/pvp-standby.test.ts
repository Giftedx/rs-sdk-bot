import { expect, test } from 'bun:test';
import { combatTwelveStandbyProfile, shallowStandbyThreat, standbyEscapePlan } from '../src/pvp/standby';

test('shallow standby blocks adjacent combat brackets and unknown levels', () => {
    const tile = { x: 3135, z: 3523, level: 0 };
    const nearby = { x: 3135, z: 3521 };
    expect(shallowStandbyThreat({ ...nearby, combatLevel: 5 }, tile, 6)).toBe(true);
    expect(shallowStandbyThreat({ ...nearby, combatLevel: 7 }, tile, 6)).toBe(true);
    expect(shallowStandbyThreat({ ...nearby, combatLevel: 20 }, tile, 6)).toBe(false);
    expect(shallowStandbyThreat({ ...nearby, combatLevel: 9 }, tile, 6)).toBe(false);
    expect(shallowStandbyThreat({ ...nearby, combatLevel: 0 }, tile, 6)).toBe(true);
    expect(shallowStandbyThreat({ ...nearby, z: 3519, combatLevel: 6 }, tile, 6)).toBe(false);
});


test('combat 12 stages only the trained Ranged and full health builds', () => {
    const profile = combatTwelveStandbyProfile(14, 17);
    expect(profile?.tile).toEqual({ x: 3134, z: 3525, level: 0 });
    expect(profile?.magic).toBe(13);
    expect(combatTwelveStandbyProfile(15, 18)?.ranged).toBe(18);
    expect(combatTwelveStandbyProfile(13, 17)).toBeUndefined();
    expect(combatTwelveStandbyProfile(15, 16)).toBeUndefined();
});

test('standbyEscapePlan orders eatFirst, glory (<30 wild), Varrock tele (<20), and safe walk south', () => {
    const hurtEdge = standbyEscapePlan({
        x: 3135, z: 3525, hp: 9, maxHp: 15, magic: 13,
        inventory: [{ id: 1985, name: 'Cheese', count: 1 }],
        equipment: [],
    });
    expect(hurtEdge.wild).toBe(1);
    expect(hurtEdge.eatFirst).toBe(true);
    expect(hurtEdge.action).toBe('run');
    expect(hurtEdge.destination).toEqual({ x: 3135, z: 3519, level: 0 });

    const deepGlory = standbyEscapePlan({
        x: 3125, z: 3720, hp: 40, maxHp: 40, magic: 25,
        inventory: [{ id: 1712, name: 'Amulet of glory(4)', count: 1 }],
        equipment: [],
    });
    expect(deepGlory.eatFirst).toBe(false);
    expect(deepGlory.action).toBe('glory');

    const safeOut = standbyEscapePlan({
        x: 3135, z: 3519, hp: 15, maxHp: 15, magic: 25,
        inventory: [{ id: 563, name: 'Law rune', count: 1 }, { id: 556, name: 'Air rune', count: 3 }, { id: 554, name: 'Fire rune', count: 1 }],
        equipment: [],
    });
    expect(safeOut.wild).toBe(0);
    expect(safeOut.action).toBe('out');
});
