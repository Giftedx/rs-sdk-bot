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
    // Doric's Quest: inside Doric's house north of Falador (doric spawn 2952,3451, maps/m46_53.jm2); 6 clay (434),
    // 4 copper ore (436), 2 iron ore (440): the hand-in needs all 12 in the pack (quest_doric.rs2:70).
    quest_doric: short({ x: 2951, z: 3450 }, [...Array(6).fill(434), ...Array(4).fill(436), 440, 440]),
    // Imp Catcher: top floor of the Wizards' Tower beside Wizard Mizgog (spawn 3103,3163,2, maps/m48_49.jm2); the
    // red, yellow, black and white beads (1470, 1472, 1474, 1476; imp drops, tradeable).
    quest_imp: short({ x: 3104, z: 3163, level: 2 }, [1470, 1472, 1474, 1476]),
    // Witch's Potion: in Hetty's house, Rimmington (hetty spawn 2968,3206, maps/m46_50.jm2); onion (1957), eye of newt
    // (221), burnt meat (2146). The rat's tail is untradeable (quest_hetty.obj) and drops only while %hetty is 1 or 2
    // (drop tables/scripts/rat.rs2:9-12): the bot kills one of the rats next door (2953-2960,3202-3205).
    quest_hetty: short({ x: 2966, z: 3206 }, [1957, 221, 2146]),
    // Rune Mysteries: beside Duke Horacio on level 1 of Lumbridge castle (duke_of_lumbridge spawn 3212,3220,1,
    // maps/m50_50.jm2); runes for a Varrock and a Lumbridge teleport (2 law 563, 6 air 556, 1 fire 554, 1 earth 557).
    quest_runemysteries: short({ x: 3210, z: 3221, level: 1 }, [[563, 2], [556, 6], [554, 1], [557, 1]]),
    // The Restless Ghost: in Lumbridge church beside Father Aereck (spawn 3244,3206, maps/m50_50.jm2); runes for a
    // Lumbridge teleport (1 law 563, 3 air 556, 1 earth 557) for the way back from the Wizards' Tower basement. The amulet
    // of ghostspeak and the skull are untradeable (quest_priest.obj), so Urhney and the skull are part of the run.
    quest_priest: short({ x: 3243, z: 3206 }, [[563, 1], [556, 3], [557, 1]]),
};
