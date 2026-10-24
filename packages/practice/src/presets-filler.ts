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
    // Ernest the Chicken: outside the Draynor Manor gate beside Veronica (spawn 3110,3330, maps/m48_52.jm2); fish food
    // (272) and poison (273) for the fountain, a spade (952) for the compost heap. The gauge, key, tube and oil can
    // are untradeable (quest_haunted.obj), so the run fetches them.
    quest_haunted: filler({ x: 3111, z: 3331 }, [272, 273, 952]),
    // Prince Ali Rescue: in the Al Kharid palace beside Hassan (spawn 3302,3163, maps/m51_49.jm2). Helper items
    // (tradeable): 3 balls of wool (1759) for Ned's wig, yellow dye (1765), pink skirt (1013), rope (954), soft clay
    // (1761), bronze bar (2349), 3 beers (1917), and Aggie's paste set: redberries (1951), pot of flour (1933), bucket
    // of water (1929), ashes (592); runes for 4 Lumbridge teleports (4 law 563, 12 air 556, 4 earth 557); 50 coins
    // (the toll gate, 10). The wig, paste, key print and key are untradeable (quest_prince.obj), so the run makes them.
    quest_prince: filler({ x: 3301, z: 3163 }, [1759, 1759, 1759, 1765, 1013, 954, 1761, 2349, 1917, 1917, 1917, 1951, 1933, 1929, 592, [563, 4], [556, 12], [557, 4]], 4, 50),
};
