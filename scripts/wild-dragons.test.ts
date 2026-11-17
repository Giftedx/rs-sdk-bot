import { expect, test } from 'bun:test';
import { DRAGONFIRE_SHIELD_ID, GREEN_DRAGON_ID, GREEN_DRAGON_SPOT, SAFE_SOUTH_TILE, selectGreenDragon, wildDragonEscapeAction, wildDragonEscapeKeep, wildDragonPreflight, wildDragonRetreatReason, wildDragonThreat } from './wild-dragons';
import { ITEMS, wildernessLevel } from './pk';

const baseState = (over: Partial<any> = {}): any => ({
    player: { worldX: GREEN_DRAGON_SPOT.x, worldZ: GREEN_DRAGON_SPOT.z, level: 0, combatLevel: 90, lifeId: 1 },
    skills: [{ name: 'Hitpoints', level: 80, experience: 1000 }],
    equipment: [{ slot: 3, id: 1333, count: 1 }, { slot: 5, id: DRAGONFIRE_SHIELD_ID, count: 1 }],
    inventory: [{ id: 385, count: 1, slot: 0 }],
    nearbyNpcs: [],
    nearbyPlayers: [],
    groundItems: [],
    ...over,
});

test('wildDragonPreflight requires Dragonfire shield (1540), melee weapon, and food', () => {
    expect(wildDragonPreflight(baseState())).toBeNull();
    expect(wildDragonPreflight(baseState({ inventory: [] }), false)).toBeNull();
    expect(wildDragonPreflight(baseState({ equipment: [{ slot: 3, id: 1333, count: 1 }] }))).toContain('Dragonfire shield');
    expect(wildDragonPreflight(baseState({ equipment: [{ slot: 5, id: DRAGONFIRE_SHIELD_ID, count: 1 }] }))).toContain('melee weapon');
    expect(wildDragonPreflight(baseState({ inventory: [] }))).toContain('food');
});

test('wildDragonThreat ignores fleet accounts and out-of-range players, flags attackable PKers', () => {
    const ours = new Set(['ally']);
    expect(wildernessLevel(GREEN_DRAGON_SPOT.z)).toBeGreaterThanOrEqual(35);
    expect(wildDragonThreat(baseState({ nearbyPlayers: [{ name: 'Ally', combatLevel: 90, z: GREEN_DRAGON_SPOT.z }] }), ours)).toBeNull();
    expect(wildDragonThreat(baseState({ nearbyPlayers: [{ name: 'Lowbie', combatLevel: 10, z: GREEN_DRAGON_SPOT.z }] }), ours)).toBeNull();
    const pker: any = { kind: 'player', index: 1, name: 'Pker', combatLevel: 100, x: 3092, z: GREEN_DRAGON_SPOT.z, distance: 3 };
    expect(wildDragonThreat(baseState({ nearbyPlayers: [pker] }), ours)).toEqual(pker);
});

test('wildDragonRetreatReason triggers on PKer threat, low HP, full pack, or missing shield', () => {
    const ours = new Set<string>();
    expect(wildDragonRetreatReason(baseState(), { eatAt: 45, escapeAt: 30 }, ours)).toBeNull();
    expect(wildDragonRetreatReason(baseState({ nearbyPlayers: [{ name: 'Pker', combatLevel: 90, z: GREEN_DRAGON_SPOT.z }] }), { eatAt: 45, escapeAt: 30 }, ours)).toBe('pker-threat');
    expect(wildDragonRetreatReason(baseState({ skills: [{ name: 'Hitpoints', level: 25 }] }), { eatAt: 45, escapeAt: 30 }, ours)).toBe('low-hp');
    expect(wildDragonRetreatReason(baseState({ inventory: Array.from({ length: 28 }, (_, slot) => ({ id: 536, count: 1, slot })) }), { eatAt: 45, escapeAt: 30 }, ours)).toBe('pack-full');
    expect(wildDragonRetreatReason(baseState({ equipment: [{ slot: 3, id: 1333, count: 1 }] }), { eatAt: 45, escapeAt: 30 }, ours)).toBe('shield-missing');
});

test('wildDragonEscapeAction runs south above level 30, uses glory below 30, and Varrock Teleport below 20', () => {
    expect(wildernessLevel(SAFE_SOUTH_TILE.z)).toBe(0);
    const withGlory = baseState({ inventory: [{ id: ITEMS.glory[0], count: 1, slot: 0 }] });
    expect(wildDragonEscapeAction(withGlory).kind).toBe('run');
    expect(wildDragonEscapeAction({ ...withGlory, player: { ...withGlory.player, worldZ: 3750 } }).kind).toBe('glory');
    const withTele = baseState({
        skills: [{ name: 'Hitpoints', level: 80 }, { name: 'Magic', level: 25 }],
        player: { worldX: 3092, worldZ: 3670, level: 0, combatLevel: 90 },
        inventory: [{ id: ITEMS.lawRune, name: 'Law rune', count: 1, slot: 0 }, { id: ITEMS.airRune, name: 'Air rune', count: 3, slot: 1 }, { id: ITEMS.fireRune, name: 'Fire rune', count: 1, slot: 2 }],
    });
    expect(wildDragonEscapeAction(withTele).kind).toBe('teleport');
    // Escape keep preserves food, glory(1..4), and staged tele runes while allowing unreserved law drops to bank.
    expect(wildDragonEscapeKeep({ id: ITEMS.glory[2] }, 0)).toBe(true);
    expect(wildDragonEscapeKeep({ id: ITEMS.airRune }, 0)).toBe(true);
    expect(wildDragonEscapeKeep({ id: ITEMS.fireRune }, 0)).toBe(true);
    expect(wildDragonEscapeKeep({ id: ITEMS.lawRune }, 1)).toBe(true);
    expect(wildDragonEscapeKeep({ id: ITEMS.lawRune }, 0)).toBe(false);
    expect(wildDragonEscapeKeep({ id: 536 }, 1)).toBe(false);
});

test('selectGreenDragon prefers a dragon targeting us, then nearest free reachable dragon', () => {
    const freeFar: any = { index: 1, id: GREEN_DRAGON_ID, distance: 8, hp: 75, reachable: true, inCombat: false, targetIndex: -1 };
    const freeNear: any = { index: 2, id: GREEN_DRAGON_ID, distance: 3, hp: 75, reachable: true, inCombat: false, targetIndex: -1 };
    const busyOther: any = { index: 3, id: GREEN_DRAGON_ID, distance: 1, hp: 75, reachable: true, inCombat: true, targetIndex: 32768 + 99 };
    const ours: any = { index: 4, id: GREEN_DRAGON_ID, distance: 5, hp: 75, reachable: true, inCombat: true, targetIndex: 32768 + 7 };
    expect(selectGreenDragon([freeFar, busyOther, freeNear], 7)?.index).toBe(2);
    expect(selectGreenDragon([freeFar, freeNear, ours], 7)?.index).toBe(4);
});
