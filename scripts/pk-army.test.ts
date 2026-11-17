import { expect, test } from 'bun:test';
import { armyEscapeFood, armyEscapeMethod } from './pk-army';

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
