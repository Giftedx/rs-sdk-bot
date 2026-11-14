import { expect, test } from 'bun:test';
import { failRoll, npcSpawns, obstacles } from './gen-world-points';

test('an obstacle that can fail carries the literal agility roll of its handler block', () => {
    const blocks: Record<string, string> = {
        'scripts/skill_agility/scripts/wilderness_course.rs2:79': '[oploc1,obstical_ropeswing2]\nif(stat_random(agility, 200, 250) = false) {\n    @fail;\n}',
        'scripts/skill_agility/scripts/shortcuts.rs2:170': '[oploc1,shortcut]\nif(stat_random(agility, loc_param(obstacle_low_fail), loc_param(obstacle_high_fail)) = false) {',
    };
    expect(obstacles([
        { kind: 'course', optionText: 'Swing-on', from: { x: 3005, z: 3952, level: 0 }, handler: 'scripts/skill_agility/scripts/wilderness_course.rs2:79' },
        { kind: 'shortcut', optionText: 'Jump', from: { x: 3000, z: 3000, level: 0 }, handler: 'scripts/skill_agility/scripts/shortcuts.rs2:170' },
        { kind: 'course', optionText: 'Climb', from: { x: 2993, z: 3936, level: 0 } },
    ], h => blocks[h] ?? '')).toEqual([[2993, 3936, 0, 'Climb'], [3000, 3000, 0, 'Jump'], [3005, 3952, 0, 'Swing-on', [200, 250]]]);
    expect(failRoll('nothing here')).toBe(null);
});

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
