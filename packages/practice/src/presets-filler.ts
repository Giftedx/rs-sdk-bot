import type { SaveConfig } from './presets';
import { QP_BEFORE_DRAGON } from './presets-dragon';

// The 4 quests of the planner's `qp-filler` row (scripts/generated/quest-<name>.ts, research/quest-points-board.md).
// `haggis-cli --order` (scenario a) puts the row at tick 47,484, after Romeo & Juliet and after the last 99 (Agility at
// 44,393), so Haggis has every skill at 99. Worn: the combat_* rune set of the gobdip / rj / druid presets
// (presets.ts). Done: every quest before the row (QP_BEFORE_DRAGON without the 4 filler quests Sheep Herder 60,
// Ernest 32, Black Knights' Fortress 130, Prince Ali 273) plus Fight Arena (17 = 14): 34 QP. Monkey Madness (3 QP,
// varp 365) is also done in the plan; it is left out here, and no quest in this row reads it.
// Each preset starts beside the quest's first NPC with the helper-supplied items and food (379 lobster).
const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
const ALL_99: Record<string, number> = Object.fromEntries(SKILLS.map(k => [k, 99]));
const COMBAT_SET = [[1163, 0], [1725, 2], [1333, 3], [1113, 4], [1201, 5], [1079, 7], [1059, 9], [1061, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
const FILLER = [60, 32, 130, 273];
const DONE: Record<number, number> = { ...Object.fromEntries(Object.entries(QP_BEFORE_DRAGON).filter(([k]) => !FILLER.includes(Number(k)))), 17: 14 };

function filler(position: { x: number; z: number; level?: number }, items: Array<number | [number, number]>, food = 4, coins = 0, varps: Record<number, number> = {}): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: COMBAT_SET, varps: { ...DONE, ...varps },
        inventory: [...items, ...Array.from({ length: food }, () => 379)].map(e => Array.isArray(e) ? { id: e[0], count: e[1] } : { id: e, count: 1 }),
        ...(coins ? { coins } : {}),
    };
}

export const FILLER_PRESETS: Record<string, SaveConfig> = {
    // Black Knights' Fortress: level 2 of Falador castle beside Sir Amik Varze (spawn 2960,3336,2, maps/m46_52.jm2);
    // iron chainbody (1101) and bronze med helm (1139), the guards' uniform (quest_blackknight.rs2:16); a cabbage (1965,
    // not the Draynor Manor magic cabbage, :91-97); runes for two Falador teleports (2 law 563, 6 air 556, 2 water 555).
    quest_blackknight: filler({ x: 2961, z: 3337, level: 2 }, [1101, 1139, 1965, [563, 2], [556, 6], [555, 2]]),
    // Debug: outside the fortress door with %spy 1 and the uniform worn.
    quest_blackknight_fort: { ...filler({ x: 3016, z: 3512 }, [1333, 1965, [563, 1], [556, 3], [555, 1]], 4, 0, { 130: 1 }), equipment: [[1139, 0], [1725, 2], [1101, 4], [1201, 5], [1079, 7], [1059, 9], [1061, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! })) },
};
