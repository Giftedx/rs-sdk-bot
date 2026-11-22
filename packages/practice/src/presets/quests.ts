import type { SaveConfig } from '../preset-types';

function gtPreset(stage: number, position: { x: number; z: number; level: number }, quest: number[] = []): SaveConfig {
    return {
        position,
        skills: { Attack: 60, Magic: 43, Prayer: 43, Agility: 25, Cooking: 35, Fletching: 99, Crafting: 99, Herblore: 99, Firemaking: 99, Runecraft: 99 },
        equipment: [{ id: 1387, count: 1, slot: 3 }],
        varps: stage > 0 ? { 111: 9, 150: stage } : { 111: 9 },
        inventory: [[562, 80], [556, 250], [563, 2]].map(([id, count]) => ({ id: id!, count: count! }))
            .concat([2434, 2434, 2434, 2446, 379, 379, 379, 379, ...quest].map(id => ({ id, count: 1 }))),
    };
}

export const QUEST_PRESETS: Record<string, SaveConfig> = {
    // Waterfall Quest test: next to Almera at Baxtorian Falls (2521,3495), 10 HP, 2 ropes (954), 6 each of air (556),
    // earth (557) and water (555) runes, 18 lobsters (379), 500 coins. 10 lobsters ran out in the falls (MEASURED
    // practice: eats=10 lobsters=0 at death); a helper hands Haggis the food.
    quest_waterfall: { position: { x: 2522, z: 3494, level: 0 }, coins: 500, inventory: [{ id: 954, count: 1 }, { id: 954, count: 1 }, { id: 556, count: 6 }, { id: 557, count: 6 }, { id: 555, count: 6 }, ...Array.from({ length: 18 }, () => ({ id: 379, count: 1 }))] },
    // Waterfall Quest from step 6: inside the falls at the key crate (2589,9888), %waterfall_quest (varp 65) = 5,
    // Glarial's amulet (295), urn (296), 6 each of air, earth and water runes, 10 lobsters. Tests the fire giant crossing.
    quest_waterfall_falls: { position: { x: 2589, z: 9887, level: 0 }, varps: { 65: 5 }, inventory: [{ id: 295, count: 1 }, { id: 296, count: 1 }, { id: 556, count: 6 }, { id: 557, count: 6 }, { id: 555, count: 6 }, ...Array.from({ length: 10 }, () => ({ id: 379, count: 1 }))] },
    // Dwarf Cannon (scripts/generated/dwarfcannon.ts): beside the Dwarf Commander (lawgof2 spawn 2571,3463, maps/m40_54.jm2)
    // with Haggis's levels right after Waterfall in the planner order (bun packages/planner/src/haggis-cli.ts --order:
    // Waterfall is activity 28, after the supply boards, Thieving, Magic, Woodcutting, Fishing, Mining, the Grand Tree and
    // Monkey Madness; Attack 1.89M and Strength 1.22M XP, Defence 500,000 = 89, Hitpoints 876,154 = 97, Agility 76, Ranged 1).
    // Crafting and Smithing 99 make every cannon repair roll succeed (mcannon_broken_cannon.rs2:89-96). Worn: the
    // combat_* rune set. Pack: the 8 lobsters left after Waterfall, 500 coins, and runes for Falador (1 water, 3 air,
    // 1 law) and Camelot (5 air, 1 law) teleports, which cut the Nulodion trip from 741 + 741 tiles to 154 + 265.
    ...((): Record<string, SaveConfig> => {
        const skills: Record<string, number> = { Attack: 99, Strength: 99, Defence: 89, Hitpoints: 97, Agility: 76 };
        for (const k of ['Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Thieving', 'Runecraft']) skills[k] = 99;
        const equipment = [[1163, 0], [1725, 2], [1333, 3], [1113, 4], [1201, 5], [1079, 7], [1059, 9], [1061, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
        return {
            quest_dwarfcannon: {
                position: { x: 2572, z: 3464, level: 0 }, skills, equipment, coins: 500,
                inventory: [{ id: 563, count: 2 }, { id: 556, count: 8 }, { id: 555, count: 1 }, ...Array.from({ length: 8 }, () => ({ id: 379, count: 1 }))],
            },
            // Cannon session after the quest: the same account at the Gnome battlefield (multiway, maps/multiway.csv "gnome
            // battlefield"; 23 khazard_troop + 16 khazard_troop_spearmen, maps/m39_50.jm2), %mcannon (varp 0) = 11,
            // %ownedmcannon (varp 4) = -1, cannon base/stand/barrels/furnace (6/8/10/12), 1,000 cannonballs (2), 16 lobsters.
            quest_dwarfcannon_gb: {
                position: { x: 2525, z: 3242, level: 0 }, skills, equipment, varps: { 0: 11, 4: -1 },
                inventory: [6, 8, 10, 12].map(id => ({ id, count: 1 })).concat([{ id: 2, count: 1000 }], Array.from({ length: 16 }, () => ({ id: 379, count: 1 }))),
            },
        };
    })(),
    // ---- Short quests (scripts/generated/quest-*.ts, research/quest-plan.md section 6). Haggis's state at the
    // planner's `qp-filler` row (bun packages/planner/src/haggis-cli.ts research/hiscores-live.json --order, activity
    // 39): every skill 99 (Defence 99 at 45,540, the row starts at 46,584), the combat_* rune set worn, and 22 QP in
    // varp 101 (qp) from Cook's Assistant 1, Tree Gnome Village 2, Grand Tree 5, Fight Arena 2, Monkey Madness 3,
    // Sea Slug 1, Dig Site 2, Waterfall 1, Dwarf Cannon 1, Witch's House 4 (quest.constant). Each preset starts beside
    // the quest's first NPC with the helper-supplied items and 10 lobsters (379).
    ...((): Record<string, SaveConfig> => {
        const skills: Record<string, number> = {};
        for (const k of ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft']) skills[k] = 99;
        const equipment = [[1163, 0], [1725, 2], [1333, 3], [1113, 4], [1201, 5], [1079, 7], [1059, 9], [1061, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
        const food = Array.from({ length: 10 }, () => ({ id: 379, count: 1 }));
        const q = (position: { x: number; z: number; level?: number }, items: Array<{ id: number; count: number }>, coins = 0): SaveConfig =>
            ({ position: { level: 0, ...position }, skills, equipment, varps: { 101: 22 }, inventory: [...items, ...food], ...(coins ? { coins } : {}) });
        return {
            // Druidic Ritual: beside Kaqemeex (npc 455 spawn 2924,3486, maps/m45_54.jm2); raw beef 2132, rat meat 2134,
            // bear meat 2136, chicken 2138 (helper hand-off; the enchanted meats are untradeable).
            quest_druid: q({ x: 2925, z: 3487 }, [2132, 2134, 2136, 2138].map(id => ({ id, count: 1 }))),
            // Goblin Diplomacy: beside the Rusty Anchor bartender (npc 734 spawn 3045,3257, Port Sarim); 3 goblin mail
            // (288), orange dye (1769), blue dye (1767), and Falador teleport runes (1 law 563, 3 air 556, 1 water 555)
            // for the trip to the generals (npc 297 Wartface at 2957,3511). The dyed mails are untradeable.
            quest_gobdip: q({ x: 3047, z: 3256 }, [{ id: 288, count: 1 }, { id: 288, count: 1 }, { id: 288, count: 1 }, { id: 1769, count: 1 }, { id: 1767, count: 1 }, { id: 563, count: 1 }, { id: 556, count: 3 }, { id: 555, count: 1 }]),
            // Romeo & Juliet: beside Romeo (npc 639 spawn 3211,3425, Varrock Square); cadava berries (753) and Varrock
            // teleport runes (1 law 563, 3 air 556, 1 fire 554) for the last leg from Juliet's room back to the square.
            quest_rj: q({ x: 3211, z: 3424 }, [{ id: 753, count: 1 }, { id: 563, count: 1 }, { id: 556, count: 3 }, { id: 554, count: 1 }]),
        };
    })(),
    // Family Crest (scripts/generated/quest-crest.ts): beside Dimintheis (npc 664 spawn 3279,3404, maps/m51_53.jm2).
    // The planner's floor order puts the crest row at tick 1,872 (after prayer-31), where Haggis has Magic 1 and
    // 10 Hitpoints. The quest cannot pass there: Chronozon needs one hit of each blast (Fire Blast is Magic 59) and
    // the route crosses the Wilderness part of the Edgeville dungeon (poison spiders 64, black demons 172). So this
    // preset is Haggis after Monkey Madness in the floor order (Attack 99, Strength 98, Defence 89, Hitpoints 97,
    // Agility 76, Thieving 57, the early 99s, Prayer 31, Cooking 35) with Magic 59 from the teleport ladder, rune
    // set worn, QP 13 (Cook's Assistant 1, Tree Gnome Village 2, Grand Tree 5, Fight Arena 2, Monkey Madness 3).
    // Helper items: swordfish 373, bass 365, tuna 361, salmon 329, shrimp 315 (cooked, for Caleb); 2 perfect gold
    // bars 2365 (tradeable); 2 rubies 1603; ring mould 1592; necklace mould 1597; 2 antipoisons 2446 (Johnathon, the
    // poison spiders); runes for the 4 blasts with 2 splashes each, 10 fire blasts for the kill and 6 teleports (100
    // air, 12 water, 15 earth, 70 fire, 24 death, 6 law); 100 coins (the Al Kharid toll twice); 8 sharks 385 (8
    // lobsters ran out in 1 of 3 runs with the armour off).
    quest_crest: {
        position: { x: 3280, z: 3403, level: 0 },
        skills: { Attack: 99, Strength: 98, Defence: 89, Hitpoints: 97, Magic: 59, Prayer: 31, Agility: 76, Thieving: 57, Cooking: 35, Fletching: 99, Crafting: 99, Herblore: 99, Firemaking: 99, Runecraft: 99 },
        equipment: [[1163, 0], [1725, 2], [1333, 3], [1113, 4], [1201, 5], [1079, 7], [1059, 9], [1061, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! })),
        varps: { 101: 13 },
        coins: 100,
        inventory: [373, 365, 361, 329, 315, 2365, 2365, 1603, 1603, 1592, 1597, 2446, 2446].map(id => ({ id, count: 1 }))
            .concat([[556, 100], [555, 12], [557, 15], [554, 70], [560, 24], [563, 6]].map(([id, count]) => ({ id: id!, count: count! })), Array.from({ length: 8 }, () => ({ id: 385, count: 1 }))),
    },
    // Tree Gnome Village (scripts/generated/quest-tree.ts): beside King Bolren, at the planner's combat state for the
    // tree row (minLevel prayer 43, magic 35): Attack, Strength, Defence 1, 10 HP, Magic 43, Prayer 43, the skills
    // trained before it at 99. Staff of fire (1387) worn; 6 logs (1511) for Montai; Fire Bolt runes (1 chaos 562 +
    // 3 air 556 each, fire from the staff) for 80 casts; 2 prayer potions (2434); 4 lobsters.
    quest_tree: {
        position: { x: 2542, z: 3171, level: 0 },
        skills: { Magic: 43, Prayer: 43, Cooking: 35, Fletching: 99, Crafting: 99, Herblore: 99, Firemaking: 99, Runecraft: 99 },
        equipment: [{ id: 1387, count: 1, slot: 3 }],
        inventory: [[562, 80], [556, 240]].map(([id, count]) => ({ id: id!, count: count! }))
            .concat(Array.from({ length: 6 }, () => ({ id: 1511, count: 1 })), [2434, 2434].map(id => ({ id, count: 1 })), Array.from({ length: 4 }, () => ({ id: 379, count: 1 }))),
    },
    // Debug: Tree Gnome Village at stage 7 (varp 111), outside Elkoy (TREE_FROM=7: the warlord, then Bolren).
    quest_tree_s7: { position: { x: 2504, z: 3190, level: 0 }, varps: { 111: 7 }, skills: { Magic: 43, Prayer: 43 }, equipment: [{ id: 1387, count: 1, slot: 3 }],
        inventory: [{ id: 562, count: 80 }, { id: 556, count: 240 }, { id: 2434, count: 1 }, { id: 2434, count: 1 }] },
    // The Grand Tree (scripts/generated/quest-grandtree.ts): beside King Narnode, at the planner's state for the
    // grandtree row (after tree and agility-25; minLevel agility 25, prayer 43, magic 35): Attack 60 (the 286,250 XP
    // of Tree Gnome Village), Strength, Defence 1, 10 HP, Magic 43, Prayer 43, Agility 25. Varp 111 = 9 (Tree Gnome
    // Village complete: the village spirit tree works). Staff of fire worn; Fire Bolt runes (562 + 3 x 556) for 80
    // casts, 2 law runes (563) for Varrock Teleport; 3 prayer potions (2434), 1 antipoison (2446, the Karamja jungle
    // spiders poison through the prayer), 4 lobsters.
    quest_grandtree: gtPreset(0, { x: 2466, z: 3494, level: 0 }),
    // Debug: The Grand Tree at a later varp 150 stage (GT_FROM=<stage>), with that stage's quest items.
    quest_grandtree_s50: gtPreset(50, { x: 2467, z: 3495, level: 0 }, [784]),
    quest_grandtree_s80: gtPreset(80, { x: 2465, z: 3496, level: 3 }, [784]),
    quest_grandtree_s90: gtPreset(90, { x: 2461, z: 3443, level: 0 }, [784, 787]),
    quest_grandtree_s120: gtPreset(120, { x: 2476, z: 3461, level: 0 }, [784, 787, 789, 790, 791, 792]),
    quest_grandtree_s140: gtPreset(140, { x: 2464, z: 9893, level: 0 }, [784, 787]),
};
