import type { SaveConfig } from './presets';
import { QP_BEFORE_DRAGON } from './presets-dragon';

// Medium quests inside the planner's `quests-rest` row (scripts/generated/quest-<name>.ts,
// research/quest-points-board.md). Same base as presets-short.ts: every skill at 99; rune helm, body, legs and
// scimitar worn; the quests before the dragon row plus Dragon Slayer (176 = 10) and Merlin's Crystal (14 = 7) done.
// Each preset starts beside the quest's first NPC with the helper-supplied items and food (379 lobster).
const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
const ALL_99: Record<string, number> = Object.fromEntries(SKILLS.map(k => [k, 99]));
const RUNE_SET = [[1163, 0], [1333, 3], [1127, 4], [1079, 7]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
const DONE = { ...QP_BEFORE_DRAGON, 176: 10, 14: 7 };

function medium(position: { x: number; z: number; level?: number }, items: Array<number | [number, number]>, food = 4, coins = 0, varps: Record<number, number> = {}): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: RUNE_SET, varps: { ...DONE, ...varps },
        inventory: [...items, ...Array.from({ length: food }, () => 379)].map(e => Array.isArray(e) ? { id: e[0], count: e[1] } : { id: e, count: 1 }),
        ...(coins ? { coins } : {}),
    };
}

// Haunted Mine: a staff of fire (1387) in the weapon slot and Fire Wave runes (1 blood 565 + 5 air 556 a cast) for the
// boss, 21 sharks (385, heal 20; a fight of 3-4 rounds ate 18-21 lobsters and died in 2 of 12 proof runs; 21 + runes +
// chisel + the 4 quest items fill the 28 slots).
function hauntedmine(position: { x: number; z: number }, items: Array<number | [number, number]>, varps: Record<number, number> = {}): SaveConfig {
    const c = medium(position, [...items, [565, 40], [556, 200], ...Array(21).fill(385)], 0, 0, { 107: 5, 302: 61, 307: 110, ...varps });
    return { ...c, equipment: [...RUNE_SET.filter(e => e.slot !== 3), { id: 1387, count: 1, slot: 3 }] };
}

// Shades of Mort'ton: in Herbi Flax's house, Mort'ton, beside the shelf with the diary (shades_experimentshelf
// 3481,3279, maps/m54_51.jm2); the state after Haunted Mine. Helper items (tradeable): hammer (2347), tinderbox (590),
// logs (1511) for the pyre logs, a clean tarromin (253), a vial of water (227) and ashes (592) for serum 207, two more
// serum 207 (3410; each talk with an afflicted NPC spends a dose, razmire_keelgan.rs2:33-48), 30,000 coins for
// Razmire's builders' store (planks, limestone bricks, swamp paste, _unpack/274/all.inv:28-36), 2 lobsters (swamp
// paste does not stack, so free slots set the material sets a store trip carries).
const MORTTON = medium({ x: 3482, z: 3279 }, [2347, 590, 1511, 253, 227, 592, 3410, 3410], 2, 30000, { 107: 5, 302: 61, 307: 110 });

export const MEDIUM_PRESETS: Record<string, SaveConfig> = {
    // Pirate's Treasure: on the Port Sarim jetty beside Redbeard Frank (spawn 3053,3250, maps/m47_50.jm2); 10 bananas
    // (1963) for Luthas's crate, white apron (1005) for Wydin, spade (952), 200 coins (two boat fares, the rum), runes
    // for a Varrock and a Falador teleport (2 law 563, 6 air 556, 1 fire 554, 1 water 555). The rum, the key and the
    // message are untradeable (quest_hunt.obj), so the bot buys and smuggles the rum itself.
    quest_hunt: medium({ x: 3052, z: 3251 }, [...Array(10).fill(1963), 1005, 952, [563, 2], [556, 6], [554, 1], [555, 1]], 4, 200),
    // The Knight's Sword: in Falador castle courtyard beside the squire (spawn 2977,3342, maps/m46_52.jm2); redberry pie
    // (2325) for Thurgo, 2 iron bars (2351), rune pickaxe (1275) for the blurite, runes for a Varrock and two Falador
    // teleports (3 law 563, 9 air 556, 1 fire 554, 2 water 555). Portrait, blurite ore and sword are untradeable
    // (quest_squire.obj).
    // Plague City: in Edmond's house, East Ardougne (edmond spawn 2568,3334, maps/m40_52.jm2); dwellberries (2126) for
    // Alrena, 4 buckets of water (1929), spade (952), rope (954), chocolate dust (1975), bucket of milk (1927) and snape
    // grass (231) for the hangover cure. Gas mask, picture, book, key, warrant, chocolaty milk and the cure are
    // untradeable (quest_elena configs, knowledge/items.json).
    quest_elena: medium({ x: 2569, z: 3333 }, [2126, 1929, 1929, 1929, 1929, 952, 954, 1975, 1927, 231], 2),
    quest_squire: medium({ x: 2978, z: 3342 }, [2325, 2351, 2351, 1275, [563, 3], [556, 9], [554, 1], [555, 2]], 6),
    // Priest in Peril: in Varrock palace beside King Roald (spawn 3222,3476, maps/m50_54.jm2; he stands in the room
    // west of the throne room wall, door loc_1536 at 3219,3472); a bucket (1925) for the well, runes for two Varrock
    // teleports (2 law 563, 6 air 556, 2 fire 554), 23 rune essence (1436) in the pack and 27 in the bank, no food
    // (Drezel takes 50, drezel.rs2:96-113; 28 slots hold one batch, and the golden key needs a slot). The golden key,
    // iron key and the murky and blessed water are quest items (quest_priestperil/configs/priestperil.obj).
    quest_priestperil: { ...medium({ x: 3218, z: 3474 }, [1925, [563, 2], [556, 6], [554, 2], ...Array(23).fill(1436)], 0), bank: [{ id: 1436, count: 27 }] },
    // Biohazard: in Elena's house, East Ardougne (elena2 spawn 2592,3336, maps/m40_52.jm2); Plague City done (165 = 30,
    // quest_elena.constant:21; the Ardougne teleport needs it, teleport.rs2:35); priest gown (426) and robe (428) for
    // Guidor's door; runes for two Ardougne teleports (4 law 563, 4 water 555). A teleport destroys the plague sample
    // (teleport.rs2:94-97), so the bot sails to Port Sarim (60 coins, two fares) and walks to Rimmington and Varrock. The quest items are untradeable (quest_biohazard.obj).
    quest_biohazard: medium({ x: 2591, z: 3336 }, [426, 428, [563, 4], [555, 4]], 2, 60, { 165: 30 }),
    // Nature Spirit: in the mausoleum under Paterdomus beside Drezel (priestperiltrappedmonk2 spawn 3440,9895,
    // maps/m53_154.jm2); The Restless Ghost done (107 = 5, ^priest_complete) with its amulet of ghostspeak (552) worn
    // (filliman.rs2:4,22); Priest in Peril done (302 = 60; Drezel's barrier talk sets 61, drezel.rs2:8-19,138-147) with
    // the wolfbane dagger (2952) it gives; a silver sickle (2961, tradeable, skill_crafting/configs/jewellery/silver.obj)
    // for the Nature Spirit to bless (filliman.rs2:165-195). The quest items are untradeable (quest_druidspirit.obj).
    quest_druidspirit: {
        ...medium({ x: 3440, z: 9893 }, [2952, 2961], 4, 0, { 107: 5, 302: 60 }),
        equipment: [...RUNE_SET, { id: 552, count: 1, slot: 2 }],
    },
    // In Search of the Myreque: in the Hair of the Dog inn, Canifis, beside Vanstrom Klause (spawn 3503,3477,
    // maps/m54_54.jm2); Nature Spirit done (307 = 110) with its blessed sickle (2963) and a druid pouch of 6 charges
    // (2958, the proof's end state); 302 = 61 (Drezel's barrier talk). Helper items (all tradeable): steel longsword
    // (1295), 2 steel swords (1281), steel dagger (1207), steel mace (1424), steel warhammer (1339)
    // (quest_routequest.rs2:17-22), 6 wooden planks (960; 3 for Cyreg, 1 per bridge rung), 30 steel nails (1539) and a
    // hammer (2347) for the rungs (routequest_hollow.rs2:166-185), 10 coins for the boat (routequest_morton.rs2:8-17).
    quest_routequest: medium({ x: 3502, z: 3476 },
        [2963, [2958, 6], 1295, 1281, 1281, 1207, 1424, 1339, 960, 960, 960, 960, 960, 960, [1539, 30], 2347], 6, 20, { 107: 5, 302: 61, 307: 110 }),
    // Haunted Mine: south of the Zealot outside the Mort Ridge mines (saradominist_zealot spawn 3444,3258,
    // maps/m53_50.jm2); the state after In Search of the Myreque (107 = 5, 302 = 61, 307 = 110). A chisel (1755) for
    // the crystal (hauntedmine_crystals.rs2:39-43). No tinderbox (the lift soaks it, hauntedmine_lift.rs2:37-42). The
    // keys, the fungus and the shard are quest items (quest_hauntedmine/configs/hauntedmine.obj).
    quest_hauntedmine: hauntedmine({ x: 3444, z: 3256 }, [1755]),
    // Debug start for HM_FROM=lift: 42_70 north beside the cart-end ladder, the lift key (4078) and a fungus (4075),
    // %hauntedmine = 3 (an entrance crawled).
    quest_mortton: MORTTON,
    // Debug start for MT_FROM=ulsquire: beside Razmire's store with the state after Ulsquire sees a remains (339 = 47,
    // ulsquire_shauncy.rs2:84), 2 shade remains (3396) and three serum 207 (3410).
    quest_mortton_ulsquire: medium({ x: 3489, z: 3294 }, [2347, 590, 1511, 3410, 3410, 3410, 3396, 3396], 2, 30000, { 107: 5, 302: 61, 307: 110, 339: 47 }),
    quest_hauntedmine_lift: hauntedmine({ x: 2710, z: 4539 }, [1755, 4078, 4075], { 382: 3 }),
};
