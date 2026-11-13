import { expect, test } from 'bun:test';
import { npcSpawns, obstacles } from './gen-world-points';

test('obstacles: course and shortcut tiles, one row a tile, labelled with the menu option', () => {
    expect(obstacles([
        { kind: 'course', locName: 'gnome_obstical_net', optionText: 'Climb-over', from: { x: 2471, z: 3425, level: 0 } },
        { kind: 'course', locName: 'gnome_obstical_net', optionText: 'Climb-over', from: { x: 2471, z: 3425, level: 0 } },
        { kind: 'shortcut', locName: 'loc_123', optionText: 'squeeze-through', from: { x: 2400, z: 3100, level: 0 } },
        { kind: 'quest', locName: 'door', optionText: 'Open', from: { x: 1, z: 2, level: 0 } },
        { kind: 'course' },
    ])).toEqual([[2400, 3100, 0, 'Squeeze-through'], [2471, 3425, 0, 'Climb-over']]);
});

test('npc spawns: grouped by name, with the lowest and highest combat and every spawn tile once', () => {
    expect(npcSpawns([
        { name: 'Man', combat: 2, spawns: [{ x: 1, z: 2, level: 0 }] },
        { name: 'Man', combat: 3, spawns: [{ x: 1, z: 2, level: 0 }, { x: 5, z: 6, level: 1 }] },
        { name: 'Hans', combat: 0, spawns: [] },
        { name: 'null', combat: 0, spawns: [{ x: 9, z: 9, level: 0 }] },
    ])).toEqual([['Man', 2, 3, [1, 2, 0, 5, 6, 1]]]);
});
