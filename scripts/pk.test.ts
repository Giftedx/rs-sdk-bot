import { expect, test } from 'bun:test';
import { attackable, bestFood, dangerReason, estMaxHit, freezeSpell, killMessage, lowHealth, nextStyle, observePlayer, protectedStyles, skulled, SPELLS, weaponStyle, wildernessLevel } from './pk';

test('Wilderness level follows wilderness_levels.rs2: surface from z 3520, the dungeon from z 9920', () => {
    expect(wildernessLevel(3519)).toBe(0);
    expect(wildernessLevel(3520)).toBe(1);
    expect(wildernessLevel(3555)).toBe(5);
    expect(wildernessLevel(3967)).toBe(56);
    expect(wildernessLevel(9920)).toBe(1);
    expect(wildernessLevel(9927)).toBe(1);
    expect(wildernessLevel(9928)).toBe(2);
});

test('a player is attackable when the combat gap fits the shallower Wilderness level', () => {
    expect(attackable({ z: 3555, combatLevel: 126 }, { z: 3555, combatLevel: 121 })).toBe(true);
    expect(attackable({ z: 3555, combatLevel: 126 }, { z: 3555, combatLevel: 120 })).toBe(false);
    expect(attackable({ z: 3700, combatLevel: 126 }, { z: 3555, combatLevel: 120 })).toBe(false);
    expect(attackable({ z: 3500, combatLevel: 126 }, { z: 3555, combatLevel: 126 })).toBe(false);
});

test('the freeze is the best one the Magic level allows', () => {
    expect(freezeSpell(99)).toBe(SPELLS.entangle);
    expect(freezeSpell(79)).toBe(SPELLS.entangle);
    expect(freezeSpell(78)).toBe(SPELLS.snare);
    expect(freezeSpell(50)).toBe(SPELLS.snare);
    expect(freezeSpell(20)).toBe(SPELLS.bind);
    expect(freezeSpell(19)).toBeNull();
});

test('style turns follow the rotation and skip a style that is not usable', () => {
    const rotation = ['magic', 'ranged', 'melee'] as const;
    expect(nextStyle(rotation, -1, () => true)).toEqual({ style: 'magic', index: 0 });
    expect(nextStyle(rotation, 0, () => true)).toEqual({ style: 'ranged', index: 1 });
    expect(nextStyle(rotation, 2, () => true)).toEqual({ style: 'magic', index: 0 });
    expect(nextStyle(rotation, 0, s => s !== 'ranged')).toEqual({ style: 'melee', index: 2 });
    expect(nextStyle(rotation, 0, () => false)).toBeNull();
});

test('a kill is read from any of the eleven killer messages, whatever the name case', () => {
    expect(killMessage("Pkdt2z6hk didn't stand a chance against you.", 'pkdt2z6hk')).toBe(true);
    expect(killMessage('With a crushing blow you finish Pkdt2z6hk.', 'pkdt2z6hk')).toBe(true);
    expect(killMessage('Iron Pker has won a free ticket to Lumbridge.', 'iron_pker')).toBe(true);
    expect(killMessage('You have defeated Someone Else.', 'pkdt2z6hk')).toBe(false);
    expect(killMessage('Oh dear you are dead!', 'pkdt2z6hk')).toBe(false);
});

test('overhead protect prayers and the skull are read from the head icon bits', () => {
    expect([...protectedStyles(0)]).toEqual([]);
    expect([...protectedStyles(1 << 3)]).toEqual(['melee']);
    expect([...protectedStyles(1 << 4)]).toEqual(['ranged']);
    expect([...protectedStyles((1 << 5) | 1)]).toEqual(['magic']);
    expect(skulled(1 | (1 << 5))).toBe(true);
    expect(skulled(1 << 5)).toBe(false);
});

test('a worn weapon attacks with the style its object name implies', () => {
    expect(weaponStyle(861)).toBe('ranged');   // magic_shortbow
    expect(weaponStyle(1401)).toBe('magic');   // mystic_fire_staff
    expect(weaponStyle(2417)).toBe('magic');   // zamorak_staff
    expect(weaponStyle(1231)).toBe('melee');   // dragon_dagger_p
    expect(weaponStyle(1305)).toBe('melee');   // dragon_longsword
    expect(weaponStyle(-1)).toBe('melee');
    expect(weaponStyle(undefined)).toBe('melee');
});

test("another player's head icons and worn items are read from the client's player entity", () => {
    const appearance = new Uint16Array(12); appearance[3] = 861 + 512; appearance[4] = 1127 + 512; appearance[8] = 7;
    const client = { players: [null, { headicons: (1 << 5) | 1, appearance, health: 30, totalHealth: 99 }] };
    const seen = observePlayer(client, 1)!;
    expect(seen.headicons).toBe(33);
    expect(seen.worn[3]).toBe(861);
    expect(seen.worn[4]).toBe(1127);
    expect(seen.worn[8]).toBe(-1);
    expect(seen.health / seen.totalHealth).toBeCloseTo(0.303, 2);
    expect(lowHealth(seen, 0.5)).toBe(true);
    expect(lowHealth(seen, 0.25)).toBe(false);
    expect(lowHealth({ ...seen, totalHealth: 0 }, 0.5)).toBe(false);
    expect(observePlayer(client, 0)).toBeNull();
    expect(observePlayer(undefined, 1)).toBeNull();
});

test('bestFood eats the best food held, then any other edible item', () => {
    const item = (name: string, eat = true) => ({ name, optionsWithIndex: eat ? [{ text: 'Eat' }] : [{ text: 'Drop' }] });
    expect(bestFood([item('Trout'), item('Shark'), item('Salmon')])?.name).toBe('Shark');
    expect(bestFood([item('Trout'), item('Salmon')])?.name).toBe('Salmon');
    expect(bestFood([item('Cake'), item('Law rune', false)])?.name).toBe('Cake');
    expect(bestFood([item('Law rune', false)])).toBeUndefined();
});

test('estMaxHit is about a quarter of combat, at least 10', () => {
    expect(estMaxHit(126)).toBe(32);
    expect(estMaxHit(20)).toBe(10);
});

test('dangerReason: no food near the max hit, a pile, a lost damage race, no prayer', () => {
    const base = { hp: 80, maxHp: 99, food: true, prayer: 50, oppMax: 30, hits: [] as { tick: number; damage: number; src: number }[], dealt: [] as { tick: number; damage: number }[], now: 100 };
    expect(dangerReason(base)).toBeNull();
    expect(dangerReason({ ...base, food: false, hp: 45 })).toMatch(/no food/);
    expect(dangerReason({ ...base, food: false, hp: 46 })).toBeNull();
    expect(dangerReason({ ...base, hits: [{ tick: 95, damage: 5, src: 1 }, { tick: 98, damage: 5, src: 2 }] })).toMatch(/2 players/);
    expect(dangerReason({ ...base, hits: [{ tick: 80, damage: 5, src: 1 }, { tick: 98, damage: 5, src: 2 }] })).toBeNull(); // first hit too old
    const race = { ...base, hp: 55, hits: [{ tick: 80, damage: 20, src: 1 }, { tick: 90, damage: 15, src: 1 }], dealt: [{ tick: 85, damage: 10 }] };
    expect(dangerReason(race)).toMatch(/losing the race/);
    expect(dangerReason({ ...race, hp: 60 })).toBeNull(); // still over 60%
    expect(dangerReason({ ...base, prayer: 0, hp: 49 })).toMatch(/no prayer/);
});
