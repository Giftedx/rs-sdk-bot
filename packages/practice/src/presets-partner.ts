import type { SaveConfig } from './presets';
import { QP_BEFORE_DRAGON } from './presets-dragon';

// Cook's Assistant, Witch's House and Lost City (scripts/generated/quest-cook.ts, quest-ball.ts, quest-zanaris.ts).
// Both the main account and the Heroes' Quest partner need them (research/heroes-partner.md). Each quest has two
// presets:
// - quest_<name>: the main account late in the run, on the presets-short.ts base: every skill 99, the quests before
//   the dragon row plus Dragon Slayer (176 = 10) and Merlin's Crystal (14 = 7) done, with this quest's varp set to 0.
// - quest_<name>_partner: Bigchopper (Woodcutting 99, Fletching 32, Thieving 35, combat 3, 10 HP) with the quest XP
//   and skill gates of the partner route up to this quest (heroes-partner.md section 3). Levels from the quest
//   rewards (stat_advance x 2.5, packages/planner/src/curve.ts levelForXp). No quest varps: none of the 3 quests
//   checks another quest or the QP total.
const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
const ALL_99: Record<string, number> = Object.fromEntries(SKILLS.map(k => [k, 99]));
const RUNE_SET = [[1163, 0], [1333, 3], [1127, 4], [1079, 7]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
const DONE = { ...QP_BEFORE_DRAGON, 176: 10, 14: 7 };
const BIGCHOPPER = { Woodcutting: 99, Fletching: 32, Thieving: 35 };
// Route rows 1-4 (Imp Catcher, Rune Mysteries, The Restless Ghost, Sheep Shearer): Magic 44, Prayer 37, Crafting 9.
const PARTNER_COOK = { ...BIGCHOPPER, Magic: 44, Prayer: 37, Crafting: 9 };
// Rows 1-10 and the skill gates (Prayer 60, Magic 45, Crafting 31, Agility 25, Fishing 10): Waterfall gives Attack and
// Strength 83 (quest_waterfall.rs2:491-492); Hitpoints stays 10 and Defence 1 (worst case: no combat XP counted).
const PARTNER_BALL = { ...BIGCHOPPER, Attack: 83, Strength: 83, Prayer: 60, Magic: 50, Crafting: 31, Mining: 49, Cooking: 30, Agility: 25, Fishing: 10 };
// Rows 1-22: Witch's House Hitpoints 72 (quest_ball.rs2:202); Attack 99 from Waterfall, Tree Gnome Village, The Grand
// Tree and Vampire Slayer; Holy Grail Defence 85 and Prayer 81 (quest_grail.rs2:116-117); Magic 63, Agility 75.
const PARTNER_ZANARIS = { ...PARTNER_BALL, Attack: 99, Defence: 85, Hitpoints: 72, Prayer: 81, Magic: 63, Agility: 75, Cooking: 54 };

// Partner quest varps at their complete values (quest.constant), route rows 1-20 (heroes-partner.md section 3):
// Imp Catcher 160, Rune Mysteries 63, The Restless Ghost 107, Sheep Shearer 179, Cook's Assistant 29, Witch's Potion
// 67, Doric's Quest 31, Goblin Diplomacy 62, Druidic Ritual 80, Waterfall 65, Witch's House 226, Pirate's Treasure 71,
// Vampire Slayer 178, Romeo & Juliet 144, Gertrude's Cat 180, Monk's Friend 30, Fishing Contest 11, Tree Gnome
// Village 111, The Grand Tree 150: 41 QP (count_questpoints recounts varp 101 at login).
const PARTNER_ROWS_1_20: Record<number, number> = { 160: 2, 63: 6, 107: 5, 179: 22, 29: 2, 67: 3, 31: 100, 62: 6, 80: 4, 65: 10, 226: 7, 71: 4, 178: 3, 144: 100, 180: 6, 30: 80, 11: 5, 111: 9, 150: 160 };
// Rows 1-20 skills: PARTNER_ZANARIS before Holy Grail, so Defence 1 and Prayer 60 (Holy Grail gives only Prayer and
// Defence, quest_grail.rs2:116-117).
const PARTNER_MERLIN = { ...PARTNER_ZANARIS, Defence: 1, Prayer: 60 };
// Rows 1-23: + Merlin's Crystal (14 = 7, 6 QP), Holy Grail (5 = 10, 2 QP), Lost City (147 = 6, 3 QP): 52 QP.
const PARTNER_ROWS_1_23: Record<number, number> = { ...PARTNER_ROWS_1_20, 14: 7, 5: 10, 147: 6 };

// Rows 1-11 (Witch's House done): PARTNER_BALL with Hitpoints 72 (quest_ball.rs2:202).
const PARTNER_HUNT = { ...PARTNER_BALL, Hitpoints: 72 };
const rows = (...ids: number[]): Record<number, number> => Object.fromEntries(ids.map(id => [id, PARTNER_ROWS_1_20[id]!]));
const SCIMITAR = { id: 1333, count: 1, slot: 3 };

type Item = number | [number, number];
const inv = (items: Item[]) => items.map(e => Array.isArray(e) ? { id: e[0], count: e[1] } : { id: e, count: 1 });
const lobsters = (n: number): number[] => Array.from({ length: n }, () => 379);

// Witch's House: leather gloves (1059) worn for the electric gate in the basement (quest_ball.rs2:33-38); cheese (1985)
// for the mouse hole (:89-93). The door key, magnet, shed key and ball are untradeable (quest_ball.obj).
const GLOVES = { id: 1059, count: 1, slot: 9 };
// Lost City: a bronze axe (1351) for Shamus's tree, dropped before the Entrana monk (no weapons, armour or axes,
// area_port_sarim/scripts/monk_of_entrana.rs2:26-53); a knife (946) for the dramen staff; prayer potions (2434) for
// Protect from Melee (the cave ladder drains Prayer by 95%, area_entrana/scripts/cave_monk.rs2:14); runes for a
// Lumbridge teleport (1 law 563, 3 air 556, 1 earth 557) south of Wilderness level 20 after the exit portal.
const ZANARIS_ITEMS: Item[] = [1351, 946, 2434, 2434, [563, 1], [556, 3], [557, 1]];

export const PARTNER_PRESETS: Record<string, SaveConfig> = {
    // Cook's Assistant: in the Lumbridge castle kitchen beside the cook (spawn 3209,3215, maps/m50_50.jm2 0 9 15); egg
    // (1944), bucket of milk (1927), pot of flour (1933).
    quest_cook: { position: { x: 3208, z: 3214, level: 0 }, skills: ALL_99, equipment: RUNE_SET, varps: { ...DONE, 29: 0 }, inventory: inv([1944, 1927, 1933]) },
    quest_cook_partner: { position: { x: 3208, z: 3214, level: 0 }, skills: PARTNER_COOK, inventory: inv([1944, 1927, 1933]) },
    // Witch's House: beside the boy south of the garden hedge (ballboy spawn 2928,3456, maps/m45_54.jm2 0 48 0).
    quest_ball: { position: { x: 2928, z: 3455, level: 0 }, skills: ALL_99, equipment: [...RUNE_SET, GLOVES], varps: { ...DONE, 226: 0 }, inventory: inv([1985, ...lobsters(4)]) },
    // The partner wields a rune scimitar (Attack 40) and wears no armour (Defence 1); Protect from Melee for the 4
    // experiment forms (max hits 2, 3, 4, 5 at 10 HP; witches_house.npc).
    quest_ball_partner: { position: { x: 2928, z: 3455, level: 0 }, skills: PARTNER_BALL, equipment: [{ id: 1333, count: 1, slot: 3 }, GLOVES], inventory: inv([1985, ...lobsters(10)]) },
    // Lost City: beside the warrior of the adventurers' camp in Lumbridge swamp (warrioradventurerpg spawn 3145,3202,
    // maps/m49_50.jm2 0 9 2). Nothing worn: the run banks its armour before this leg.
    quest_zanaris: { position: { x: 3144, z: 3203, level: 0 }, skills: ALL_99, varps: { ...DONE, 147: 0 }, inventory: inv([...ZANARIS_ITEMS, ...lobsters(6)]) },
    quest_zanaris_partner: { position: { x: 3144, z: 3203, level: 0 }, skills: PARTNER_ZANARIS, inventory: inv([...ZANARIS_ITEMS, 2434, ...lobsters(10)]) },
    // The Restless Ghost (row 3, quest-priest.ts): beside Father Aereck as quest_priest. Rows 1-2 done (Imp Catcher
    // Magic 44); combat 3, 10 HP, nothing worn. The skull spawns a skeleton that the bot leaves.
    quest_priest_partner: { position: { x: 3243, z: 3206, level: 0 }, skills: { ...BIGCHOPPER, Magic: 44 }, varps: rows(160, 63), inventory: inv([[563, 1], [556, 3], [557, 1], ...lobsters(4)]) },
    // Pirate's Treasure (row 12, quest-hunt.ts): beside Redbeard Frank as quest_hunt (presets-medium.ts). Rows 1-11 done;
    // Attack 83 wields the rune scimitar, Defence 1 wears no armour.
    quest_hunt_partner: {
        position: { x: 3052, z: 3251, level: 0 }, skills: PARTNER_HUNT, equipment: [SCIMITAR], varps: rows(160, 63, 107, 179, 29, 67, 31, 62, 80, 65, 226), coins: 200,
        inventory: inv([...Array(10).fill(1963), 1005, 952, [563, 2], [556, 6], [554, 1], [555, 1], ...lobsters(4)]),
    },
    // Vampire Slayer (row 13, quest-vampire.ts): in Morgan's house as quest_vampire. Rows 1-12 done.
    quest_vampire_partner: {
        position: { x: 3097, z: 3268, level: 0 }, skills: PARTNER_HUNT, equipment: [SCIMITAR], varps: rows(160, 63, 107, 179, 29, 67, 31, 62, 80, 65, 226, 71),
        inventory: inv([1917, 2347, 1550, [563, 2], [556, 6], [554, 2], ...lobsters(6)]),
    },
    // Shield of Arrav, Phoenix part (row 16, quest-arrav.ts helper role): beside Reldo as quest_arrav_helper
    // (presets-gang.ts), 20 coins for Baraek. Rows 1-15 done. Not proved: the pair needs 2 practice bots at once.
    quest_arrav_helper_partner: {
        position: { x: 3210, z: 3494, level: 0 }, skills: PARTNER_HUNT, equipment: [SCIMITAR], coins: 20,
        varps: rows(160, 63, 107, 179, 29, 67, 31, 62, 80, 65, 226, 71, 178, 144, 180), inventory: inv(lobsters(4)),
    },
    // Dragon Slayer (row 24, quest-dragon.ts): beside the Guild master as quest_dragon, with the helper items of
    // presets-dragon.ts dragon(). Defence 85 from Holy Grail, so the rune set is worn; 52 QP from rows 1-23.
    quest_dragon_partner: {
        position: { x: 3190, z: 3358, level: 0 }, skills: PARTNER_ZANARIS, equipment: RUNE_SET, varps: PARTNER_ROWS_1_23, coins: 12000,
        inventory: inv([[563, 4], [556, 12], [557, 2], [555, 2], [1539, 12], 960, 960, 960, 2347, 1907, 1791, 301, 950, ...lobsters(6)]),
    },
    // Merlin's Crystal (row 21, quest-merlin.ts): beside King Arthur as quest_merlin. Defence 1, so only the rune
    // scimitar (Attack 40) is worn; Prayer 60. Helper items of presets-dragon.ts merlin().
    quest_merlin_partner: {
        position: { x: 2763, z: 3513, level: 0 }, skills: PARTNER_MERLIN, equipment: [{ id: 1333, count: 1, slot: 3 }], varps: PARTNER_ROWS_1_20, coins: 500,
        inventory: inv([[563, 4], [556, 14], [555, 2], [554, 1], 30, 530, 2309, 590, ...lobsters(6)]),
    },
    // Holy Grail (row 22, quest-grail.ts): beside King Arthur as quest_grail, Merlin's Crystal done, Excalibur (35) and
    // the rune scimitar in the pack, nothing worn. Defence 1, Prayer 60.
    quest_grail_partner: {
        position: { x: 2763, z: 3513, level: 0 }, skills: PARTNER_MERLIN, varps: { ...PARTNER_ROWS_1_20, 14: 7 }, coins: 100,
        inventory: inv([[563, 8], [556, 32], [555, 4], 35, 1333, ...lobsters(6)]),
    },
};
