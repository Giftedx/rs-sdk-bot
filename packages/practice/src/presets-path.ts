import type { SaveConfig } from './presets';
import { QP_BEFORE_DRAGON } from './presets-dragon';

// Quests on the main account's path that the planner places before the quests-rest block
// (scripts/generated/quest-<name>.ts, research/quest-plan.md). Each preset is the planner state at the row's start
// tick (`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json --order`, scenario a, realistic), beside
// the quest's first NPC, with the helper-supplied items. Hitpoints is the planner's 10 where the planner has not
// trained it (the planner does not model Hitpoints).

// Fight Arena (the rival-fight-arena row, tick 12,267, after The Grand Tree): Attack 94, Magic 99, Prayer 43,
// Agility 76, the 99s of the early route, Strength, Defence, Thieving 1, 10 HP. Tree Gnome Village (111 = 9) and The
// Grand Tree (150 = 160) done. Staff of fire worn; Fire Wave runes (1 blood 565 + 5 air 556 a cast, the staff gives
// the fire) for 60 casts; 3 prayer potions (2434); 4 lobsters (379); 20 coins (a Khali brew is 5).
const ARENA_SKILLS = { Attack: 94, Magic: 99, Prayer: 43, Agility: 76, Cooking: 99, Fletching: 99, Firemaking: 99, Crafting: 99, Smithing: 99, Herblore: 99, Runecraft: 99 };
function arena(position: { x: number; z: number; level?: number }, stage = 0, quest: number[] = []): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ARENA_SKILLS, equipment: [{ id: 1387, count: 1, slot: 3 }],
        varps: { 111: 9, 150: 160, ...(stage ? { 17: stage } : {}) }, coins: 20,
        inventory: [[565, 60], [556, 300]].map(([id, count]) => ({ id: id!, count: count! }))
            .concat([2434, 2434, 2434, 379, 379, 379, 379, ...quest].map(id => ({ id, count: 1 }))),
    };
}

// Sea Slug (the rival-seaslug row, tick 24,985, after the woodcut and prayer rows): Attack 99, Strength 97, Defence 89,
// Hitpoints 97, Prayer 99, Magic 99, Woodcutting 99, Thieving 99, Agility 76, the 99s of the early route; Fishing,
// Mining, Ranged 1. Fight Arena (17 = 14), Tree Gnome Village, The Grand Tree done. Helper items: swamp paste (1941,
// tradeable; swamp tar and flour cooked), an unlit torch (596, tradeable, so Bailey's talk is not needed), 3 law and
// 3 air runes (Telekinetic Grab for the broken glass, scripts/generated/quest-seaslug.ts).
const LATE_SKILLS = { Attack: 99, Strength: 97, Defence: 89, Hitpoints: 97, Prayer: 99, Magic: 99, Woodcutting: 99, Thieving: 99, Agility: 76, Cooking: 99, Fletching: 99, Firemaking: 99, Crafting: 99, Smithing: 99, Herblore: 99, Runecraft: 99 };
function late(position: { x: number; z: number; level?: number }, skills: Record<string, number>, items: number[], varps: Record<number, number> = {}): SaveConfig {
    return {
        position: { level: 0, ...position }, skills, varps: { 17: 14, 111: 9, 150: 160, ...varps },
        inventory: [...items, 379, 379, 379, 379].map(id => ({ id, count: 1 })),
    };
}

// Scorpion Catcher (the scorpion row, tick 53,715, after Dragon Slayer): every skill 99; rune helm, body, legs and
// scimitar worn; the quests before the dragon row plus Dragon Slayer (176 = 10) done. Runes for 2 Falador and 1
// Camelot Teleport (law 563, air 556, water 555); an antipoison (2446); 4 lobsters. Thormac gives the cage.
const ALL_99: Record<string, number> = Object.fromEntries(['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'].map(k => [k, 99]));
const RUNE_SET = [[1163, 0], [1333, 3], [1127, 4], [1079, 7]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
function scorpion(position: { x: number; z: number; level?: number }, varps: Record<number, number> = {}, quest: number[] = []): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: RUNE_SET, varps: { ...QP_BEFORE_DRAGON, 176: 10, ...varps },
        inventory: [[563, 5], [556, 20], [555, 4]].map(([id, count]) => ({ id: id!, count: count! }))
            .concat([2446, 379, 379, 379, 379, ...quest].map(id => ({ id, count: 1 }))),
    };
}

export const PATH_PRESETS: Record<string, SaveConfig> = {
    // Fight Arena: beside Lady Servil (spawn 2566,3199, maps/m40_49.jm2).
    quest_arena: arena({ x: 2566, z: 3197 }),
    // Sea Slug: beside Caroline (spawn 2716,3302, maps/m42_51.jm2).
    // Scorpion Catcher: beside Thormac, top floor of the Sorcerer's Tower (spawn 2702,3405,3, maps/m42_53.jm2).
    quest_scorpion: scorpion({ x: 2702, z: 3404, level: 3 }),
    // Debug: stage 2 (76 = 2) with the empty cage (456), west of the Barbarian Outpost (SC_FROM=2).
    quest_scorpion_s2: scorpion({ x: 2538, z: 3570 }, { 76: 2 }, [456]),
    quest_seaslug: late({ x: 2717, z: 3302 }, LATE_SKILLS, [1941, 596, 563, 563, 563, 556, 556, 556]),
};
