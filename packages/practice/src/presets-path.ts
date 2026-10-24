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
// Camelot Teleport (law 563, air 556, water 555); an antipoison (2446); 4 lobsters. Thormac gives the cage. Alfred
// Grimhand's Barcrawl done (77 = 2, the barcrawl row) for the Barbarian Outpost gate.
const ALL_99: Record<string, number> = Object.fromEntries(['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'].map(k => [k, 99]));
const RUNE_SET = [[1163, 0], [1333, 3], [1127, 4], [1079, 7]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
function scorpion(position: { x: number; z: number; level?: number }, varps: Record<number, number> = {}, quest: number[] = []): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: RUNE_SET, varps: { ...QP_BEFORE_DRAGON, 176: 10, 77: 2, ...varps },
        inventory: [[563, 5], [556, 20], [555, 4]].map(([id, count]) => ({ id: id!, count: count! }))
            .concat([2446, 379, 379, 379, 379, ...quest].map(id => ({ id, count: 1 }))),
    };
}

// The Dig Site (the dig row, tick 28,294, after the fly-fishing row): the Sea Slug state plus Fishing 99; Sea Slug
// (159 = 12), Cook's Assistant (29 = 2), Druidic Ritual (80 = 4), Family Crest (148 = 11) done. Helper items (all
// tradeable): cup of tea (1978), opal (1609), 2 ropes (954), vial (229), charcoal (973), pestle and mortar (233),
// tinderbox (590), runes for 1 Varrock Teleport, 2 lobsters. Debug presets start a stage with its quest items
// (DIG_FROM=<stage>): %itexamlevel (131) is the stage, the trowel (676), jar (669), brush (670), certificates.
const DIG_SKILLS = { ...LATE_SKILLS, Fishing: 99 };
const DIG_VARPS = { 17: 14, 111: 9, 150: 160, 159: 12, 29: 2, 80: 4, 148: 11 };
function dig(position: { x: number; z: number; level?: number }, items: number[], varps: Record<number, number> = {}): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: DIG_SKILLS, varps: { ...DIG_VARPS, ...varps },
        inventory: [[563, 1], [556, 3], [554, 1]].map(([id, count]) => ({ id: id!, count: count! }))
            .concat([...items, 379, 379].map(id => ({ id, count: 1 }))),
    };
}
const DIG_HELPER = [1978, 1609, 954, 954, 229, 973, 233, 590];

export const PATH_PRESETS: Record<string, SaveConfig> = {
    // The Dig Site: beside the examiner (spawn 3360,3343, maps/m52_52.jm2), in the Exam Centre.
    quest_dig: dig({ x: 3361, z: 3341 }, DIG_HELPER),
    // Debug: stage 5 (talisman dig) north of the level 3 site; the trowel, jar, brush, 3 certificates, nitroglycerin
    // (703) and ground charcoal (704); the tea and the opal used.
    quest_dig_talisman: dig({ x: 3354, z: 3403 }, [954, 954, 590, 676, 669, 670, 691, 692, 693, 703, 704], { 131: 5, 133: 2 }),
    // Debug: stage 6 (permit) beside winch 2, the same items.
    quest_dig_cave: dig({ x: 3370, z: 3427 }, [954, 954, 590, 676, 669, 670, 691, 692, 693, 703, 704], { 131: 6, 133: 2 }),
    // Fight Arena: beside Lady Servil (spawn 2566,3199, maps/m40_49.jm2).
    quest_arena: arena({ x: 2566, z: 3197 }),
    // Sea Slug: beside Caroline (spawn 2716,3302, maps/m42_51.jm2).
    // Scorpion Catcher: beside Thormac, top floor of the Sorcerer's Tower (spawn 2702,3405,3, maps/m42_53.jm2).
    quest_scorpion: scorpion({ x: 2702, z: 3404, level: 3 }),
    // Debug: stage 2 (76 = 2) with the empty cage (456), west of the Barbarian Outpost (SC_FROM=2).
    quest_scorpion_s2: scorpion({ x: 2538, z: 3570 }, { 76: 2 }, [456]),
    // Debug: stage 2 with the cage holding B (460), at the foot of the Taverley dungeon ladder (SC_FROM=3).
    quest_scorpion_s3: scorpion({ x: 2885, z: 9797 }, { 76: 2 }, [460]),
    // Alfred Grimhand's Barcrawl (scripts/generated/quest-barcrawl.ts): the scorpion row's state (every skill 99, rune
    // set, QP_BEFORE_DRAGON and Dragon Slayer), outside the Barbarian Outpost gate (guards 2544,3567 / 2544,3571).
    // 500 coins (208 for the bars, 60 for two ships); runes for Falador, Varrock and Camelot Teleport (3 law 563,
    // 11 air 556, 1 water 555, 1 fire 554); 4 lobsters.
    barcrawl: {
        position: { x: 2541, z: 3569, level: 0 }, skills: ALL_99, equipment: RUNE_SET, varps: { ...QP_BEFORE_DRAGON, 176: 10 }, coins: 500,
        inventory: [[563, 3], [556, 11], [555, 1], [554, 1]].map(([id, count]) => ({ id: id!, count: count! }))
            .concat([379, 379, 379, 379].map(id => ({ id, count: 1 }))),
    },
    quest_seaslug: late({ x: 2717, z: 3302 }, LATE_SKILLS, [1941, 596, 563, 563, 563, 556, 556, 556]),
};
