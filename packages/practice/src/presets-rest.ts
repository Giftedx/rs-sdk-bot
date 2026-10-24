import type { SaveConfig } from './presets';
import { QP_BEFORE_DRAGON } from './presets-dragon';

// Quests of the planner's `quests-rest` row that no other preset file covers (scripts/generated/quest-<name>.ts,
// research/quest-points-board.md). The row runs after the last 99, so every skill is 99. Worn: the combat_* rune set
// of presets-filler.ts. Done: the quests before the dragon row (QP_BEFORE_DRAGON, which holds the 4 qp-filler quests),
// Dragon Slayer (176 = 10), Merlin's Crystal (14 = 7) and Fight Arena (17 = 14).
// Each preset starts beside the quest's first NPC with the helper-supplied items.
const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
const ALL_99: Record<string, number> = Object.fromEntries(SKILLS.map(k => [k, 99]));
const COMBAT_SET = [[1163, 0], [1725, 2], [1333, 3], [1113, 4], [1201, 5], [1079, 7], [1059, 9], [1061, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
const DONE: Record<number, number> = { ...QP_BEFORE_DRAGON, 176: 10, 14: 7, 17: 14 };

function rest(position: { x: number; z: number; level?: number }, items: Array<number | [number, number]>, food = 4, coins = 0, varps: Record<number, number> = {}, weapon?: number): SaveConfig {
    const equipment = weapon ? [...COMBAT_SET.filter(e => e.slot !== 3), { id: weapon, count: 1, slot: 3 }] : COMBAT_SET;
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment, varps: { ...DONE, ...varps },
        inventory: [...items, ...Array.from({ length: food }, () => 379)].map(e => Array.isArray(e) ? { id: e[0], count: e[1] } : { id: e, count: 1 }),
        ...(coins ? { coins } : {}),
    };
}

export const REST_PRESETS: Record<string, SaveConfig> = {
    // Demon Slayer: in Gypsy Aris's tent, Varrock square (spawn 3203,3424, maps/m50_53.jm2). Helper items (tradeable):
    // 25 bones (526) for Traiborn, 1 coin for Aris, a law (563) and a fire rune (554) for one Varrock Teleport with a
    // staff of air (1381) wielded. That fills the 28 slots, so there is no food and no bucket: the bucket is the floor
    // spawn on level 1 of the palace (3221,3497,1, maps/m50_54.jm2), filled at the kitchen sink. The keys and
    // Silverlight are untradeable (demon.obj), so the run collects them.
    quest_demon: rest({ x: 3204, z: 3424 }, [...Array(25).fill(526), [563, 1], [554, 1]], 0, 1, {}, 1381),
    // Jungle Potion: in Trufitus's hut, Tai Bwo Wannai (spawn 2809,3086, maps/m43_48.jm2); Druidic Ritual is done (80 = 4
    // in QP_BEFORE_DRAGON; trufitus.rs2:280 reads it). No helper items: the 5 herbs count only when picked at their own
    // stage (quest_junglepotion.rs2:51-75). 6 lobsters for the jungle.
    quest_junglepotion: rest({ x: 2810, z: 3086 }, [], 6),
    // Tribal Totem: beside Kangai Mau in Brimhaven (spawn 2791,3182, maps/m43_49.jm2). Plague City done (165 = 30; the
    // quest moves to the end of the quests-medium row, after Plague City) for Ardougne Teleport (teleport.rs2:22-35). Helper items: runes for one
    // Ardougne Teleport (2 law 563, 2 water 555), 30 coins for Captain Barnaby back to Brimhaven, 4 lobsters. The label
    // and the totem are quest items from the run.
    quest_totem: rest({ x: 2791, z: 3183 }, [[563, 2], [555, 2]], 4, 30, { 165: 30 }),
    // Tribal Totem: beside Kangai Mau in Brimhaven (spawn 2791,3182, maps/m43_49.jm2). Plague City done (165 = 30; the
    // quest moves to the end of the quests-medium row, after Plague City) for Ardougne Teleport (teleport.rs2:22-35). Helper items: runes for one
    // Ardougne Teleport (2 law 563, 2 water 555), 30 coins for Captain Barnaby back to Brimhaven, 4 lobsters. The label
    // and the totem are quest items from the run.
    quest_totem: rest({ x: 2791, z: 3183 }, [[563, 2], [555, 2]], 4, 30, { 165: 30 }),
};
