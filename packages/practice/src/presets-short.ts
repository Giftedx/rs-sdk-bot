import type { SaveConfig } from './presets';
import { QP_BEFORE_DRAGON } from './presets-dragon';

// Short quests inside the planner's `quests-rest` row (scripts/generated/quest-<name>.ts, research/quest-points-board.md).
// The row runs after Overall, so Haggis has every skill at 99; rune helm, body, legs and scimitar worn; the quests
// before the dragon row plus Dragon Slayer (176 = 10) and Merlin's Crystal (14 = 7) done. Each preset starts beside
// the quest's first NPC with the helper-supplied items and food (379 lobster).
const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
const ALL_99: Record<string, number> = Object.fromEntries(SKILLS.map(k => [k, 99]));
const RUNE_SET = [[1163, 0], [1333, 3], [1127, 4], [1079, 7]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
const DONE = { ...QP_BEFORE_DRAGON, 176: 10, 14: 7 };

function short(position: { x: number; z: number; level?: number }, items: Array<number | [number, number]>, food = 4, coins = 0, varps: Record<number, number> = {}): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: RUNE_SET, varps: { ...DONE, ...varps },
        inventory: [...items, ...Array.from({ length: food }, () => 379)].map(e => Array.isArray(e) ? { id: e[0], count: e[1] } : { id: e, count: 1 }),
        ...(coins ? { coins } : {}),
    };
}

export const SHORT_PRESETS: Record<string, SaveConfig> = {
    // Sheep Shearer: inside Fred's farmhouse (fred_the_farmer spawn 3189,3273, maps/m49_51.jm2); 20 balls of wool (1759).
    quest_sheep: short({ x: 3190, z: 3272 }, Array.from({ length: 20 }, () => 1759)),
};
