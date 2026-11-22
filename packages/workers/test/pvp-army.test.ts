import { expect, test } from 'bun:test';
import { armyEscapeFood, armyEscapeMethod, armyFocusTarget, pickArmyScoutHandoff } from '../src/pvp/pk-army';

test('armyEscapeMethod prefers glory up to level 30, Varrock Teleport up to 20, else runs south', () => {
    const runes = [{ name: 'Law rune', count: 1 }, { name: 'Air rune', count: 3 }, { name: 'Fire rune', count: 1 }];
    expect(armyEscapeMethod(99, 3510, [], [], 0).how).toBe('out');
    // Level 25 Wilderness: glory in pack wins, worn glory still works below 3 tries, no teleport above level 20.
    expect(armyEscapeMethod(99, 3715, [{ name: 'Amulet of glory(4)' }, ...runes], [], 0).how).toBe('glory');
    expect(armyEscapeMethod(99, 3715, runes, [{ name: 'Amulet of glory(2)' }], 2).how).toBe('glory');
    expect(armyEscapeMethod(99, 3715, runes, [{ name: 'Amulet of glory(2)' }], 3).how).toBe('run');
    // Level 15 Wilderness without glory: Magic 25+ with teleport runes uses Varrock Teleport; without runes runs south.
    expect(armyEscapeMethod(70, 3632, runes, [], 0).how).toBe('teleport');
    expect(armyEscapeMethod(70, 3632, [{ name: 'Law rune', count: 1 }], [{ name: 'Mystic fire staff' }], 0).how).toBe('run');
    expect(armyEscapeMethod(70, 3632, [{ name: 'Law rune', count: 1 }, { name: 'Air rune', count: 3 }], [{ name: 'Mystic fire staff' }], 0).how).toBe('teleport');
});

test('armyEscapeFood eats best food when missing more than 20 HP and skips when near full', () => {
    const eat = [{ text: 'Eat' }];
    const inv = [{ name: 'Lobster', slot: 0, optionsWithIndex: eat }, { name: 'Shark', slot: 1, optionsWithIndex: eat }];
    expect(armyEscapeFood(85, 99, inv)).toBeUndefined();
    expect(armyEscapeFood(78, 99, inv)?.name).toBe('Shark');
});

test('pickArmyScoutHandoff and armyFocusTarget coordinate scout handoffs and multi-way stun focus', () => {
    const now = 1_000_000;
    const intel = [
        { target: 'Alpha', x: 3067, z: 3640, combatLevel: 118, hpFrac: 0.4, skulled: true, multi: true, wild: 16, scout: 'Scout1', at: now },
        { target: 'Ally', x: 3067, z: 3640, combatLevel: 120, hpFrac: 0.1, skulled: true, multi: true, wild: 16, scout: 'Scout1', at: now },
        { target: 'DeepOutOfCap', x: 3060, z: 3880, combatLevel: 120, hpFrac: 0.1, skulled: true, multi: true, wild: 46, scout: 'Scout2', at: now },
    ];
    expect(pickArmyScoutHandoff({ leader: { x: 3090, z: 3560, combat: 126 }, maxWild: 20, friends: new Set(['ally']), intel, now })?.target).toBe('Alpha');

    // Single-way (3090, 3550 is single): skip busy non-shared inCombat target; multi-way (3067, 3640): focus stunned enemy.
    const view = [
        { name: 'SharedFoe', x: 3067, z: 3640, combatLevel: 120, distance: 3, inCombat: true },
        { name: 'StunnedFoe', x: 3067, z: 3641, combatLevel: 120, distance: 2, inCombat: true },
    ];
    expect(armyFocusTarget({ me: { x: 3067, z: 3640, combatLevel: 126 }, sharedTarget: 'SharedFoe', view, friends: new Set(), stunned: new Set(['stunnedfoe']) })?.name).toBe('SharedFoe');
    expect(armyFocusTarget({ me: { x: 3067, z: 3640, combatLevel: 126 }, sharedTarget: null, view, friends: new Set(), stunned: new Set(['stunnedfoe']) })?.name).toBe('StunnedFoe');
    expect(armyFocusTarget({ me: { x: 3090, z: 3550, combatLevel: 126 }, sharedTarget: null, view: [{ ...view[1]!, x: 3090, z: 3551 }], friends: new Set() })).toBeUndefined();
});
