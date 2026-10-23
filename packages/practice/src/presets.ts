import { rsSdkRoot } from './paths';
import { isLiteRunning } from './lite';

// Mirrors SaveConfig in vendor/rs-sdk/sdk/test/utils/save-generator.ts. createSaveData sets tutorial varp 281 = 1000 itself.
export interface SaveConfig {
    position?: { x: number; z: number; level?: number };
    skills?: Record<string, number>;
    inventory?: Array<{ id: number; count: number }>;
    equipment?: Array<{ id: number; count: number; slot: number }>;
    bank?: Array<{ id: number; count: number }>;
    coins?: number;
    varps?: Record<number, number>;
}

const LUMBRIDGE = { x: 3222, z: 3218, level: 0 };

export const PRESETS: Record<string, SaveConfig> = {
    fresh_lumbridge: { position: LUMBRIDGE },
    // Trees within reach, measured by the 2026-10-22 spike run.
    wc_lumbridge: { position: { x: 3224, z: 3245, level: 0 }, inventory: [{ id: 1351, count: 1 }] },
    // Lumbridge castle courtyard, ground floor (vendor/rs-sdk/learnings/walking.md: castle 3222,3218).
    floors_lumbridge: { position: LUMBRIDGE },
    // Draynor bank (3092,3243) per vendor/rs-sdk/learnings/walking.md; trees stand north of it.
    bank_draynor: { position: { x: 3092, z: 3247, level: 0 }, inventory: [{ id: 1351, count: 1 }] },
    // Inside the Lumbridge cow field (centre 3253,3290 per learnings/combat.md). Sword 1277, shrimps 315.
    fight_lumbridge: { position: { x: 3253, z: 3285, level: 0 }, inventory: [{ id: 1277, count: 1 }, { id: 315, count: 5 }] },
    // Measurement spots from vendor/rs-sdk/learnings (woodcutting.md, mining.md, fishing.md).
    measure_trees: { position: { x: 3195, z: 3220, level: 0 }, inventory: [{ id: 1351, count: 1 }] },
    measure_oaks: { position: { x: 3190, z: 3458, level: 0 }, skills: { Woodcutting: 15 }, inventory: [{ id: 1351, count: 1 }] },
    measure_mine: { position: { x: 3285, z: 3365, level: 0 }, inventory: [{ id: 1265, count: 1 }] },
    // Iron at the SE Varrock mine: (3286,3368) touches the iron rocks at (3285,3368), (3285,3369), (3286,3369): Mining 15 with a bronze pickaxe (1265), Mining 41 with rune (1275).
    measure_iron_bronze: { position: { x: 3286, z: 3368, level: 0 }, skills: { Mining: 15 }, inventory: [{ id: 1265, count: 1 }] },
    measure_iron_rune: { position: { x: 3286, z: 3368, level: 0 }, skills: { Mining: 41 }, inventory: [{ id: 1275, count: 1 }] },
    // 3-tick woodcutting test: the oak preset plus a knife (946) and one log (1511).
    oaks_3tick: { position: { x: 3190, z: 3458, level: 0 }, skills: { Woodcutting: 15 }, inventory: [{ id: 1351, count: 1 }, { id: 946, count: 1 }, { id: 1511, count: 1 }] },
    // 3-tick fishing test: the Draynor net spot, small net (303), knife (946), one log (1511).
    shrimp_3tick: { position: { x: 3087, z: 3230, level: 0 }, inventory: [{ id: 303, count: 1 }, { id: 946, count: 1 }, { id: 1511, count: 1 }] },
    // 3-tick fly fishing test: Lumbridge river spot (0_50_50_freshfish at 3238,3252), Fishing 20, fly fishing rod (309),
    // 300 feathers (314), knife (946), 10 logs (1511): a missed spot click lets the fletch finish and use a log.
    fly_3tick: { position: { x: 3239, z: 3251, level: 0 }, skills: { Fishing: 20 }, inventory: [{ id: 309, count: 1 }, { id: 314, count: 300 }, { id: 946, count: 1 }, ...Array.from({ length: 10 }, () => ({ id: 1511, count: 1 }))] },
    measure_shrimp: { position: { x: 3087, z: 3230, level: 0 }, inventory: [{ id: 303, count: 1 }] },
    // Wine batch test (skill_cooking/.../wine/wine.rs2): Cooking 35, one grapes + jug of water to start the
    // 20-tick fermenting timer, and 300 unfermented wines (1995) in the bank that ferment when it fires.
    wine_specialist: {
        position: LUMBRIDGE,
        skills: { Cooking: 35 },
        inventory: [{ id: 1987, count: 1 }, { id: 1937, count: 1 }],
        bank: [{ id: 1995, count: 300 }],
    },
    // Login wine test: no Cooking levels, 600 unfermented wines (1995) banked; the login timer does the rest.
    wine_login: { position: LUMBRIDGE, bank: [{ id: 1995, count: 600 }] },
    // Gem throughput test: Crafting 55, chisel (1755) and 27 uncut dragonstones (1631).
    gems_dragonstone: { position: LUMBRIDGE, skills: { Crafting: 55 }, inventory: [{ id: 1755, count: 1 }, ...Array.from({ length: 27 }, () => ({ id: 1631, count: 1 }))] },
    // Resupply test: helper next to the specialist with 27 uncut dragonstones.
    supply_spec: { position: LUMBRIDGE, skills: { Crafting: 55 } },
    supply_helper: { position: { x: 3223, z: 3218, level: 0 }, inventory: Array.from({ length: 27 }, () => ({ id: 1631, count: 1 })) },
    // Bank-loop test at Draynor bank (3092,3243, learnings/walking.md): chisel in pack, 270 uncut dragonstones banked.
    bank_gems: { position: { x: 3092, z: 3243, level: 0 }, skills: { Crafting: 55 }, inventory: [{ id: 1755, count: 1 }], bank: [{ id: 1631, count: 270 }] },
    // Thieving: south Varrock man/woman cluster (knowledge/npcs.json: man 3237,3406 / 3223,3398; woman2 3223,3401),
    // 5 shrimps (315) for stun damage.
    thieve_varrock: { position: { x: 3235, z: 3403, level: 0 }, inventory: [{ id: 315, count: 5 }] },
    // Thieving tier 2: Varrock palace guards (knowledge/npcs.json guard1 at 3206-3213,3462-3465; combat 21).
    // Pickpocket guard needs Thieving 40 (46.8 XP); HP 30 and 20 shrimps (315) for harder stun hits.
    thieve_guards: { position: { x: 3210, z: 3459, level: 0 }, skills: { Thieving: 40, Hitpoints: 30 }, inventory: Array.from({ length: 20 }, () => ({ id: 315, count: 1 })) },
    // Thieving tier 3: Ardougne market knights (knowledge/npcs.json knight_of_ardougne at 2652,3318 and 2653,3300).
    // Pickpocket knight needs Thieving 55 (84.3 XP); a fail hits for 3, so HP 50 and 20 lobsters (379).
    thieve_knights: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 55, Hitpoints: 50 }, inventory: Array.from({ length: 20 }, () => ({ id: 379, count: 1 })) },
    // Same as thieve_knights but with a fresh account's 10 HP: isolates the cost of a low HP cap at knights.
    thieve_knights_hp10: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 55 }, inventory: Array.from({ length: 20 }, () => ({ id: 379, count: 1 })) },
    // Cycle tests only: HP 99 and 27 lobsters, so food never runs out in a 1,500-tick knight run.
    thieve_knights_hp99: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 55, Hitpoints: 99 }, inventory: Array.from({ length: 27 }, () => ({ id: 379, count: 1 })) },
    // Ardougne baker's stall food test: Thieving 5 (stall level), HP 10, next to the west stall (loc touches 2654,3310).
    cake_stall: { position: { x: 2655, z: 3310, level: 0 }, skills: { Thieving: 5 } },
    // Resume test: a live-like account already in the Ardougne market, Thieving 66, 10 HP, 2000 coins.
    resume_ardougne: { position: { x: 2657, z: 3313, level: 0 }, skills: { Thieving: 66 }, coins: 2000 },
    // Lockpick door test: Thieving 16 beside loc_2551 (2674,3304), east of the Ardougne market.
    door_2551: { position: { x: 2675, z: 3304, level: 0 }, skills: { Thieving: 16 } },
    // Waterfall Quest test: next to Almera at Baxtorian Falls (2521,3495), 10 HP, 2 ropes (954), 6 each of air (556),
    // earth (557) and water (555) runes, 18 lobsters (379), 500 coins. 10 lobsters ran out in the falls (MEASURED
    // practice 2026-10-23: eats=10 lobsters=0 at death); a helper hands Haggis the food.
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
    // Fresh woodcutter: Lumbridge castle courtyard with a bronze axe (1351), like a live account after the tutorial.
    wc_fresh: { position: { x: 3222, z: 3218, level: 0 }, inventory: [{ id: 1351, count: 1 }] },
    // GE courier test: Ardougne market with 20,000 coins (the live couriers are the Thieving 99 accounts).
    courier_ardougne: { position: { x: 2655, z: 3304, level: 0 }, coins: 20000 },
    // Grape picker (scripts/grapes.ts): Cooks' Guild top floor beside the grape spawn (3144,3450,2), Cooking 32,
    // chef's hat (1949) worn (head slot 0), so the bank loop can pass the chefdoor again.
    grapes_cooksguild: { position: { x: 3143, z: 3450, level: 2 }, skills: { Cooking: 32 }, equipment: [{ id: 1949, count: 1, slot: 0 }] },
    // Gold farm (scripts/goldfarm.ts): Thieving 99, 10 HP, 20 lobsters (379) in the pack and 40 in the bank, at the market knights.
    goldfarm_knights: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 99 }, inventory: Array.from({ length: 20 }, () => ({ id: 379, count: 1 })), bank: [{ id: 379, count: 40 }] },
    // Gold farm food fallback: same spot, no lobsters anywhere, so the script steals from the baker's stall.
    goldfarm_nofood: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 99 }, coins: 300 },
    // Stun-trade test: a food-less thief at the knights and a helper one tile east with 26 lobsters.
    stun_thief: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 55 } },
    stun_feeder: { position: { x: 2655, z: 3304, level: 0 }, inventory: Array.from({ length: 26 }, () => ({ id: 379, count: 1 })) },
    // Runecraft: inside the air altar (runecraft_table enter_coord 2841,4830,0), air talisman (1438), 27 rune essence (1436).
    rc_air_inside: { position: { x: 2841, z: 4830, level: 0 }, inventory: [{ id: 1438, count: 1 }, ...Array.from({ length: 27 }, () => ({ id: 1436, count: 1 }))] },
    // Thieving specialist trip: a fresh account (10 HP, no gear) with 60 coins for two 30-coin boat fares.
    boat_ardougne: { position: LUMBRIDGE, coins: 60 },
    // Trade pair: giver holds 100 coins, receiver stands one tile east (3223,3218).
    trade_giver: { position: LUMBRIDGE, coins: 100 },
    trade_receiver: { position: { x: 3223, z: 3218, level: 0 } },
    // Fishing resume test, the live Mightyrod state of 2026-10-23: near Bob's Axes (3236,3206), Fishing 22, Thieving 50,
    // 0 coins, 28 items (starter kit, small net 303, fly fishing rod 309, 24 feathers 314, knife 946, 7 logs 1511,
    // shrimps 315, bread 2309). A save cannot set current HP, so this starts at 10 HP, not 2.
    fish_resume: {
        position: { x: 3236, z: 3206, level: 0 },
        skills: { Fishing: 22, Thieving: 50 },
        inventory: [1351, 590, 303, 315, 1925, 1931, 2309, 1265, 1205, 1277, 1171, 841].map(id => ({ id, count: 1 }))
            .concat([{ id: 882, count: 25 }, { id: 556, count: 25 }, { id: 558, count: 15 }, { id: 555, count: 6 }, { id: 557, count: 4 }, { id: 559, count: 2 }, { id: 946, count: 1 }])
            .concat(Array.from({ length: 5 }, () => ({ id: 1511, count: 1 })), [{ id: 309, count: 1 }, { id: 314, count: 24 }], Array.from({ length: 2 }, () => ({ id: 1511, count: 1 }))),
    },
    // ---- Supply-board floors (scripts/measure/floor-*.ts, research/supply-floors.md). Counts come from
    // scripts/measure/floor-bands.ts (exact actions to 99 at 25x), plus 1 spare per stack so no bank slot empties.
    // Herblore 3 -> 99 at Draynor bank (3092,3243): every unfinished potion and secondary of the HERBLORE bands in
    // the bank. Herblore 3 because nothing in a pack gives XP at 1-2 (identify guam needs 3).
    floor_herblore: {
        position: { x: 3092, z: 3243, level: 0 },
        skills: { Herblore: 3 },
        bank: [{ id: 91, count: 2 }, { id: 221, count: 4 }, { id: 93, count: 2 }, { id: 235, count: 4 }, { id: 95, count: 3 }, { id: 225, count: 9 }, { id: 97, count: 3 }, { id: 223, count: 7 }, { id: 1975, count: 2 }, { id: 99, count: 7 }, { id: 239, count: 9 }, { id: 3002, count: 3 }, { id: 2152, count: 3 }, { id: 231, count: 7 }, { id: 101, count: 5 }, { id: 103, count: 6 }, { id: 2970, count: 4 }, { id: 105, count: 12 }, { id: 241, count: 14 }, { id: 3004, count: 6 }, { id: 107, count: 7 }, { id: 2483, count: 16 }, { id: 109, count: 13 }, { id: 245, count: 13 }, { id: 3138, count: 8 }, { id: 111, count: 176 }, { id: 247, count: 176 }],
    },
    // Delayed-click 3-tick fishing (scripts/measure/fish-delayed.ts): Musa Point rarefish spots (2923,3180 2925,3181
    // 2926,3179, knowledge/npcs.json id 324), lobster pot (301) or harpoon (311), knife (946), 15 logs (1511): a missed click lets the fletch finish and use a log.
    lobster_delayed_40: { position: { x: 2924, z: 3178, level: 0 }, skills: { Fishing: 40 }, inventory: [{ id: 301, count: 1 }, { id: 946, count: 1 }, ...Array.from({ length: 15 }, () => ({ id: 1511, count: 1 }))] },
    lobster_delayed_70: { position: { x: 2924, z: 3178, level: 0 }, skills: { Fishing: 70 }, inventory: [{ id: 301, count: 1 }, { id: 946, count: 1 }, ...Array.from({ length: 15 }, () => ({ id: 1511, count: 1 }))] },
    harpoon_delayed_55: { position: { x: 2924, z: 3178, level: 0 }, skills: { Fishing: 55 }, inventory: [{ id: 311, count: 1 }, { id: 946, count: 1 }, ...Array.from({ length: 15 }, () => ({ id: 1511, count: 1 }))] },
    // Catherby memberfish spots (2846,3429 2855,3423 2859,3426, id 322): shark harpoon at Fishing 80.
    shark_delayed_80: { position: { x: 2850, z: 3431, level: 0 }, skills: { Fishing: 80 }, inventory: [{ id: 311, count: 1 }, { id: 946, count: 1 }, ...Array.from({ length: 15 }, () => ({ id: 1511, count: 1 }))] },
    // Fly fishing baseline at the same levels (Lumbridge river spot 3238,3252), for scripts/measure/fish-3tick.ts.
    fly_3tick_40: { position: { x: 3239, z: 3251, level: 0 }, skills: { Fishing: 40 }, inventory: [{ id: 309, count: 1 }, { id: 314, count: 1000 }, { id: 946, count: 1 }, ...Array.from({ length: 10 }, () => ({ id: 1511, count: 1 }))] },
    fly_3tick_70: { position: { x: 3239, z: 3251, level: 0 }, skills: { Fishing: 70 }, inventory: [{ id: 309, count: 1 }, { id: 314, count: 1000 }, { id: 946, count: 1 }, ...Array.from({ length: 10 }, () => ({ id: 1511, count: 1 }))] },
    // Flinch 2-tick woodcutting (scripts/measure/flinch.ts) and its knife/normal baseline (wc-3tick.ts): Barbarian Village
    // oak (3074,3422) in a multiway zone (maps/multiway.csv "barbarian village"), barbarians (combat 7, attackrate 4) at
    // 3076,3414 3078,3419 3080,3423. Steel axe (1353), shortbow (841, no arrows), pot (1931) + bucket (1925) for the
    // clear input, knife (946) + log (1511) for the knife baseline, 10 lobsters (379). HP 40, Defence 20.
    flinch_oak_15: { position: { x: 3075, z: 3421, level: 0 }, skills: { Woodcutting: 15, Hitpoints: 40, Defence: 20 }, inventory: [{ id: 1353, count: 1 }, { id: 841, count: 1 }, { id: 1931, count: 1 }, { id: 1925, count: 1 }, { id: 946, count: 1 }, { id: 1511, count: 1 }, ...Array.from({ length: 10 }, () => ({ id: 379, count: 1 }))] },
    flinch_oak_45: { position: { x: 3075, z: 3421, level: 0 }, skills: { Woodcutting: 45, Hitpoints: 40, Defence: 20 }, inventory: [{ id: 1353, count: 1 }, { id: 841, count: 1 }, { id: 1931, count: 1 }, { id: 1925, count: 1 }, { id: 946, count: 1 }, { id: 1511, count: 1 }, ...Array.from({ length: 10 }, () => ({ id: 379, count: 1 }))] },
    // Flinch 2-tick shark (flinch.ts RES=fish AGGRO=1 PRAY=1) and its delayed-click baseline (fish-delayed.ts OPT=harpoon):
    // Ape Atoll memberfish spot (2780,2741, id 1405) in a multiway zone, aggressive jungle scorpions (combat 38,
    // attackrate 4, mm_jungle_scorpion) nearby. Fishing 80, Prayer 99 (Protect from Melee), HP 99, Defence 70. Harpoon
    // (311), shortbow (841), pot + bucket, knife (946) + 15 logs (1511), 5 sharks (385). No Monkey Madness gate in a preset.
    flinch_shark_80: { position: { x: 2779, z: 2740, level: 0 }, skills: { Fishing: 80, Prayer: 99, Hitpoints: 99, Defence: 70 }, inventory: [{ id: 311, count: 1 }, { id: 841, count: 1 }, { id: 1931, count: 1 }, { id: 1925, count: 1 }, { id: 946, count: 1 }, ...Array.from({ length: 15 }, () => ({ id: 1511, count: 1 })), ...Array.from({ length: 5 }, () => ({ id: 385, count: 1 }))] },
    // Crafting 1 -> 99 at Draynor bank: chisel (1755) in the pack, the CRAFTING gem bands in the bank (opal, jade and
    // red topaz +2 each for smashes).
    floor_crafting: {
        position: { x: 3092, z: 3243, level: 0 },
        inventory: [{ id: 1755, count: 1 }],
        bank: [{ id: 1625, count: 11 }, { id: 1627, count: 6 }, { id: 1629, count: 6 }, { id: 1623, count: 4 }, { id: 1621, count: 3 }, { id: 1619, count: 6 }, { id: 1617, count: 11 }, { id: 1631, count: 278 }],
    },
    // Smithing 1 -> 99 at Varrock west bank (3185,3436, learnings/banking.md), anvils at (3188,3421-3426): hammer
    // (2347) in the pack, the SMITHING bar bands in the bank.
    floor_smithing: {
        position: { x: 3185, z: 3436, level: 0 },
        inventory: [{ id: 2347, count: 1 }],
        bank: [{ id: 2349, count: 20 }, { id: 2351, count: 37 }, { id: 2353, count: 96 }, { id: 2359, count: 281 }, { id: 2361, count: 341 }],
    },
    // ---- Combat measurement (scripts/measure/combat-melee.ts, research/combat-measure.md). Falador castle courtyard,
    // multiway (maps/multiway.csv "falador"), 11 ground-floor White Knights (falador.npc:1-30: HP 52, defence 21,
    // attackrate 7, not aggressive). Worn: rune full helm 1163, amulet of strength 1725, rune scimitar 1333, rune
    // chainbody 1113 (the platebody needs Dragon Slayer), rune kiteshield 1201, rune platelegs 1079, leather gloves
    // 1059, leather boots 1061; all tradeable, so a helper can supply them. 20 lobsters (379).
    // Spot gb: the Gnome battlefield west of the Tree Gnome Village (maps/multiway.csv "gnome battlefield"), 41 Khazard
    // troopers (gnome_battlefield.npc:1-40: HP 22, defence 12-13, attackrate 5-6, no huntmode), open ground.
    // Higher-HP multiway spots (research/combat-measure.md section 4): iw = Ice Queen lair, 6 ice warriors within 4 tiles
    // (all.npc icewarrior_queen: HP 59, att/str/def 47, huntmode cowardly, huntrange 5); ks = Kalphite lair, 5 soldiers
    // within 10 tiles on plane 2 (kalphite.npc:62-95: HP 90, att/str/def 70, cowardly, huntrange 5, poison 20);
    // sk = Temple of Ikov dungeon, 9 skeletons (all.npc skeleton id 93: HP 59, def 36, cowardly, huntrange 1).
    ...Object.fromEntries([['wk', { x: 2979, z: 3340, level: 0 }], ['gb', { x: 2525, z: 3242, level: 0 }], ['iw', { x: 2866, z: 9946, level: 0 }], ['ks', { x: 3467, z: 9484, level: 2 }], ['sk', { x: 2650, z: 9889, level: 0 }]].flatMap(([spot, position]) => [40, 70, 90].flatMap(lv => {
        const base: SaveConfig = {
            position: position as { x: number; z: number; level: number },
            skills: { Attack: lv, Strength: lv, Defence: lv, Hitpoints: lv },
            equipment: [[1163, 0], [1725, 2], [1333, 3], [1113, 4], [1201, 5], [1079, 7], [1059, 9], [1061, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! })),
            inventory: Array.from({ length: 20 }, () => ({ id: 379, count: 1 })),
        };
        // Cannon variant: %mcannon (varp 0) = 11 (^mcannon_complete, quest.constant:43), %ownedmcannon (varp 4) = -1 (null;
        // a 0 save value reads as a placed cannon: "You cannot construct more than one Cannon"), cannon base/stand/barrels/
        // furnace (6/8/10/12), 1,000 cannonballs (2), 16 lobsters.
        const cannon: SaveConfig = {
            ...base,
            varps: { 0: 11, 4: -1 },
            inventory: [6, 8, 10, 12].map(id => ({ id, count: 1 })).concat([{ id: 2, count: 1000 }], Array.from({ length: 16 }, () => ({ id: 379, count: 1 }))),
        };
        return [[`combat_${spot}_${lv}`, base], [`combat_${spot}_${lv}_cannon`, cannon]];
    }))),
    // Defence top-up as the Haggis plan reaches it (research/combat-measure.md section 7): Attack, Strength, Hitpoints 99,
    // Defence 93 (Monkey Madness 500,000 + longrange side 179,700 = 679,700 XP), same gear and food as combat_<spot>_<band>.
    // Run with STYLE=3 (scimitar "block", defensive: Defence XP).
    ...Object.fromEntries([['gb', { x: 2525, z: 3242, level: 0 }], ['iw', { x: 2866, z: 9946, level: 0 }], ['sk', { x: 2650, z: 9889, level: 0 }]].map(([spot, position]) => [`combat_${spot}_def93`, {
        position: position as { x: number; z: number; level: number },
        skills: { Attack: 99, Strength: 99, Defence: 93, Hitpoints: 99 },
        equipment: [[1163, 0], [1725, 2], [1333, 3], [1113, 4], [1201, 5], [1079, 7], [1059, 9], [1061, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! })),
        inventory: Array.from({ length: 20 }, () => ({ id: 379, count: 1 })),
    } satisfies SaveConfig])),
    // Ranged with a bow at the Gnome battlefield (spot gb), bands 40 / 70 / 90 in Ranged, Defence and Hitpoints. Band 40:
    // yew shortbow 857 (Ranged 40, tier40.rs2:64) and green d'hide body 1135, chaps 1099, vambraces 1065; bands 70 and 90:
    // magic shortbow 861 (Ranged 50) and black d'hide body 2503 (Ranged 70, Defence 40), chaps 2497, vambraces 2491.
    // All: coif 1169, amulet of power 1731, leather boots 1061, 3,000 rune arrows 892 in the ammo slot (13), 20 lobsters.
    // The _cannon variant swaps 4 lobsters for the cannon parts and 1,000 cannonballs, as above.
    ...Object.fromEntries([40, 70, 90].flatMap(lv => {
        const [bow, body, chaps, vamb] = lv < 70 ? [857, 1135, 1099, 1065] : [861, 2503, 2497, 2491];
        const base: SaveConfig = {
            position: { x: 2525, z: 3242, level: 0 },
            skills: { Ranged: lv, Defence: lv, Hitpoints: lv },
            equipment: [[1169, 0], [1731, 2], [bow, 3], [body, 4], [chaps, 7], [vamb, 9], [1061, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }))
                .concat([{ id: 892, count: 3000, slot: 13 }]),
            inventory: Array.from({ length: 20 }, () => ({ id: 379, count: 1 })),
        };
        const cannon: SaveConfig = {
            ...base,
            varps: { 0: 11, 4: -1 },
            inventory: [6, 8, 10, 12].map(id => ({ id, count: 1 })).concat([{ id: 2, count: 1000 }], Array.from({ length: 16 }, () => ({ id: 379, count: 1 }))),
        };
        return [[`combat_rb_${lv}`, base], [`combat_rb_${lv}_cannon`, cannon]];
    })),
    // ---- Stun guests (scripts/measure/stun-guest.ts): Thieving 99 at the Ardougne knights, 10 HP, 5 lobsters.
    // Bury arm: 22 dragon bones (536), Prayer 99 so no level-up page opens. Enchant arm: Magic 99, 300 water (555),
    // 300 cosmic (564), 20 sapphire rings (1637) for Lvl-1 Enchant. Baseline: no guest items.
    stun_base: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 99 }, inventory: Array.from({ length: 5 }, () => ({ id: 379, count: 1 })) },
    stun_bury: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 99, Prayer: 99 }, inventory: Array.from({ length: 5 }, () => ({ id: 379, count: 1 })).concat(Array.from({ length: 22 }, () => ({ id: 536, count: 1 }))) },
    stun_enchant: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 99, Magic: 99 }, inventory: Array.from({ length: 5 }, () => ({ id: 379, count: 1 })).concat([{ id: 555, count: 300 }, { id: 564, count: 300 }], Array.from({ length: 20 }, () => ({ id: 1637, count: 1 }))) },
    // Fletching 1 -> 99 with stacks only (Lumbridge castle): the FLETCHING band tips, headless arrows (53) and feathers
    // (314), 2 spare actions per band.
    floor_fletching: {
        position: { x: 3222, z: 3218, level: 0 },
        inventory: [{ id: 39, count: 90 }, { id: 53, count: 1440 }, { id: 40, count: 60 }, { id: 820, count: 60 }, { id: 314, count: 1590 }, { id: 41, count: 165 }, { id: 42, count: 255 }, { id: 43, count: 525 }, { id: 44, count: 345 }, { id: 824, count: 1530 }],
    },
    // Prayer 1 -> 99 at Draynor bank: 560 dragon bones (536) in the bank (555 needed).
    floor_prayer: { position: { x: 3092, z: 3243, level: 0 }, bank: [{ id: 536, count: 560 }] },
    // Magic 7 -> 99 at Draynor bank: rune stacks in the pack (cosmic 564, water 555, air 556, fire 554, earth 557, with
    // spares), the MAGIC enchant bands' jewellery in the bank (sapphire 1637, emerald 1639, ruby 1641, diamond 1643
    // rings, strung dragonstone amulets 1702). Magic 7 because no supply-only spell gives XP at 1-6.
    floor_magic: {
        position: { x: 3092, z: 3243, level: 0 },
        skills: { Magic: 7 },
        inventory: [{ id: 564, count: 600 }, { id: 555, count: 7000 }, { id: 556, count: 120 }, { id: 554, count: 120 }, { id: 557, count: 7400 }],
        bank: [{ id: 1637, count: 13 }, { id: 1639, count: 28 }, { id: 1641, count: 17 }, { id: 1643, count: 38 }, { id: 1702, count: 460 }],
    },
    // Firemaking 1 -> 99 at Draynor bank: tinderbox (590) in the pack, the FIREMAKING log bands in the bank (logs 1511,
    // oak 1521, willow 1519, maple 1517, yew 1515, magic 1513), 1 spare each. Lines start at (3099,3249).
    floor_firemaking: {
        position: { x: 3092, z: 3243, level: 0 },
        inventory: [{ id: 590, count: 1 }],
        bank: [{ id: 1511, count: 3 }, { id: 1521, count: 5 }, { id: 1519, count: 8 }, { id: 1517, count: 14 }, { id: 1515, count: 25 }, { id: 1513, count: 108 }],
    },
    // Cooking 1 -> 99 by the normal method at Draynor bank: tinderbox + 1 log for a fire, raw sardine (327), herring
    // (345), trout (335), salmon (331) with spares for burns; 400 grapes (1987) and 400 jugs of water (1937) banked.
    floor_cooking: {
        position: { x: 3092, z: 3243, level: 0 },
        inventory: [{ id: 590, count: 1 }, { id: 1511, count: 1 }, ...[327, 327, 327, 327, 327, 327, 327, 327, 327, 327, 345, 345, 345, 345, 345, 335, 335, 335, 335, 335, 331, 331, 331, 331, 331].map(id => ({ id, count: 1 }))],
        bank: [{ id: 1987, count: 400 }, { id: 1937, count: 400 }],
    },
    // Wine probe (research/supply-floors.md, Cooking): Cooking 35 at Draynor bank, 40 grapes + 40 jugs of water banked.
    floor_wine35: { position: { x: 3092, z: 3243, level: 0 }, skills: { Cooking: 35 }, bank: [{ id: 1987, count: 40 }, { id: 1937, count: 40 }] },
    // Firemaking burn-rate test at the top band: Firemaking 75, tinderbox, 30 magic logs (1513) banked; one 27-log line.
    floor_fm75: { position: { x: 3092, z: 3243, level: 0 }, skills: { Firemaking: 75 }, inventory: [{ id: 590, count: 1 }], bank: [{ id: 1513, count: 30 }] },
    // Same at Firemaking 45 with 30 maple logs (1517).
    floor_fm45: { position: { x: 3092, z: 3243, level: 0 }, skills: { Firemaking: 45 }, inventory: [{ id: 590, count: 1 }], bank: [{ id: 1517, count: 30 }] },
    // Smithing with a helper (scripts/measure/floor-smith-trade.ts): the smither beside the Varrock west smithy anvil
    // (3188,3426) with a hammer (2347); the helper <bot>b at Varrock west bank with the SMITHING bars banked.
    floor_smith_trade: { position: { x: 3188, z: 3427, level: 0 }, inventory: [{ id: 2347, count: 1 }] },
    floor_smith_helper: { position: { x: 3185, z: 3436, level: 0 }, bank: [{ id: 2349, count: 20 }, { id: 2351, count: 37 }, { id: 2353, count: 96 }, { id: 2359, count: 281 }, { id: 2361, count: 341 }] },
    // Ground-log firemaking (scripts/measure/floor-fm-ground.ts): the firemaker (Firemaking 75, tinderbox)
    // at Draynor bank, the helper <bot>b on the row start (3098,3248; 3099,3249 is not walkable) with 27 magic logs (1513).
    floor_fmg: { position: { x: 3092, z: 3243, level: 0 }, skills: { Firemaking: 75 }, inventory: [{ id: 590, count: 1 }] },
    floor_fmg_helper: { position: { x: 3098, z: 3248, level: 0 }, inventory: Array.from({ length: 27 }, () => ({ id: 1513, count: 1 })) },
    // Magic from 44 (the Imp Catcher reward, 21,875 XP, quests/quest_imp/scripts/quest_imp.rs2:4) at Draynor bank: the
    // floor_magic runes, and the jewellery of the bands from 44 (emerald 4, ruby 16, diamond 37, dragonstone 453, +spares).
    floor_magic44: {
        position: { x: 3092, z: 3243, level: 0 },
        skills: { Magic: 44 },
        inventory: [{ id: 564, count: 600 }, { id: 555, count: 7000 }, { id: 556, count: 120 }, { id: 554, count: 120 }, { id: 557, count: 7400 }],
        bank: [{ id: 1639, count: 28 }, { id: 1641, count: 17 }, { id: 1643, count: 38 }, { id: 1702, count: 460 }],
    },
    // Firemaking 1 -> 99 with no banking (scripts/measure/floor-fm-rows.ts): firemaker with a tinderbox at Draynor bank;
    // helper <bot>b at Draynor bank with the FIREMAKING logs banked (2/4/7/13/24/107, 1 spare each) to drop on the path.
    floor_fmr: { position: { x: 3092, z: 3243, level: 0 }, inventory: [{ id: 590, count: 1 }] },
    floor_fmr_helper: { position: { x: 3092, z: 3243, level: 0 }, bank: [{ id: 1511, count: 3 }, { id: 1521, count: 5 }, { id: 1519, count: 8 }, { id: 1517, count: 14 }, { id: 1515, count: 25 }, { id: 1513, count: 108 }] },
    ...agilityPresets(),
    // Snake firemaking (scripts/measure/floor-fm-snake.ts): the firemaker with a tinderbox at the snake start (3068,3295).
    floor_fms: { position: { x: 3068, z: 3295, level: 0 }, inventory: [{ id: 590, count: 1 }] },
};

// Agility laps (scripts/measure/agility-laps.ts): each course at its entry level and at 70 / 90.
// Gnome: north of the log (2474,3435). Barbarian: north of the rope swing (2551,3550), already inside the outpost
// (the gate needs Alfred Grimhand's Barcrawl, outpost_gate.rs2:2). Wilderness: south of the pipe (3004,3938), inside
// the course. HP 70, Defence 70 and 15 lobsters (379) for the fail damage (15-21.6% of HP + 1 per fail).
function agilityPresets(): Record<string, SaveConfig> {
    const food = Array.from({ length: 15 }, () => ({ id: 379, count: 1 }));
    const at = {
        gnome: { pos: { x: 2474, z: 3437, level: 0 }, levels: [1, 70, 90] },
        barbarian: { pos: { x: 2551, z: 3555, level: 0 }, levels: [35, 70, 90] },
        wilderness: { pos: { x: 3004, z: 3937, level: 0 }, levels: [52, 70, 90] },
        // Brimhaven Agility Arena floor (plane 3, agilityarena.rs2:7), on the east rope swing's start tile.
        arenaswing: { pos: { x: 2764, z: 9569, level: 3 }, levels: [75, 90] },
    };
    const out: Record<string, SaveConfig> = {};
    for (const [course, c] of Object.entries(at))
        for (const l of c.levels)
            out[`agility_${course}_${l}`] = { position: c.pos, skills: { Agility: l, Hitpoints: 70, Defence: 70 }, inventory: food };
    return out;
}

// The engine writes the save on logout, so a preset written while logged in is lost.
export async function applyPreset(name: string, preset: SaveConfig): Promise<string> {
    if (isLiteRunning(name)) throw new Error(`bot ${name} is logged in`);
    const code = `import { generateSave } from './sdk/test/utils/save-generator.ts';
const p = await generateSave(process.env.BOT_NAME, JSON.parse(process.env.PRESET));
console.log('SAVE=' + p);`;
    const r = Bun.spawnSync(['bun', '-e', code], {
        cwd: rsSdkRoot(),
        env: { ...process.env, BOT_NAME: name, PRESET: JSON.stringify(preset) },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const out = r.stdout.toString();
    const m = out.match(/SAVE=(.+)/);
    if (r.exitCode !== 0 || !m) throw new Error(`generateSave failed for ${name}: ${r.stderr.toString()}${out}`);
    return m[1]!.trim();
}
