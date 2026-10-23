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
};
