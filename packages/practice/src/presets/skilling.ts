import type { SaveConfig } from '../preset-types';

export const LUMBRIDGE = { x: 3222, z: 3218, level: 0 };

export const SKILLING_PRESETS: Record<string, SaveConfig> = {
    fresh_lumbridge: { position: LUMBRIDGE },
    gather_flax: { position: { x: 2744, z: 3445, level: 0 } },
    gather_yews: { position: { x: 2712, z: 3462, level: 0 }, skills: { Woodcutting: 99, Attack: 60 }, inventory: [{ id: 1359, count: 1 }] },
    shop_catherby: { position: { x: 2822, z: 3442, level: 0 }, coins: 50000 },
    gather_fish_catherby: { position: { x: 2840, z: 3432, level: 0 }, skills: { Fishing: 70 }, inventory: [{ id: 301, count: 1 }] },
    spin_bowstrings_seers: { position: { x: 2727, z: 3492, level: 0 }, skills: { Crafting: 40 }, inventory: [{ id: 1779, count: 28 }], bank: [{ id: 1779, count: 100 }] },
    gather_ore_varrock: { position: { x: 3286, z: 3368, level: 0 }, skills: { Mining: 50 }, inventory: [{ id: 1275, count: 1 }] },
    smelt_bars_alkharid: { position: { x: 3274, z: 3186, level: 0 }, skills: { Smithing: 50 }, inventory: [{ id: 440, count: 28 }], bank: [{ id: 440, count: 200 }] },
    fletch_arrows_bank: { position: { x: 2809, z: 3441, level: 0 }, skills: { Fletching: 80 }, inventory: [{ id: 53, count: 1000 }, { id: 44, count: 1000 }], bank: [{ id: 53, count: 5000 }, { id: 44, count: 5000 }] },
    cook_food_catherby: { position: { x: 2816, z: 3443, level: 0 }, skills: { Cooking: 70 }, inventory: [{ id: 377, count: 28 }], bank: [{ id: 377, count: 200 }] },
    brew_potions_bank: { position: { x: 3253, z: 3420, level: 0 }, skills: { Herblore: 50 }, inventory: [{ id: 99, count: 14 }, { id: 231, count: 14 }], bank: [{ id: 99, count: 100 }, { id: 231, count: 100 }] },
    craft_jewelry_bank: { position: { x: 3269, z: 3167, level: 0 }, skills: { Crafting: 50 }, inventory: [{ id: 1755, count: 1 }, { id: 1623, count: 27 }], bank: [{ id: 1623, count: 100 }] },
    gather_combat_druid: { position: { x: 3115, z: 9928, level: 0 }, skills: { Attack: 60, Strength: 60, Defence: 60, Hitpoints: 60 }, equipment: [{ id: 1333, count: 1, slot: 3 }, { id: 1113, count: 1, slot: 4 }, { id: 1079, count: 1, slot: 7 }], inventory: Array.from({ length: 5 }, () => ({ id: 379, count: 1 })) },
    // Trees within reach, measured by the spike run.
    wc_lumbridge: { position: { x: 3224, z: 3245, level: 0 }, inventory: [{ id: 1351, count: 1 }] },
    // Lumbridge castle courtyard, ground floor (vendor/rs-sdk/learnings/walking.md: castle 3222,3218).
    floors_lumbridge: { position: LUMBRIDGE },
    // Draynor bank (3092,3243) per vendor/rs-sdk/learnings/walking.md; trees stand north of it.
    bank_draynor: { position: { x: 3092, z: 3247, level: 0 }, inventory: [{ id: 1351, count: 1 }] },
    // Inside the Lumbridge cow field (centre 3253,3290 per learnings/combat.md). Sword 1277, shrimps 315.
    fight_lumbridge: { position: { x: 3253, z: 3285, level: 0 }, inventory: [{ id: 1277, count: 1 }, ...Array.from({ length: 5 }, () => ({ id: 315, count: 1 }))] },
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
    thieve_varrock: { position: { x: 3235, z: 3403, level: 0 }, inventory: [...Array.from({ length: 5 }, () => ({ id: 315, count: 1 }))] },
    // Thieving tier 2: Varrock palace guards (knowledge/npcs.json guard1 at 3206-3213,3462-3465; combat 21).
    // Pickpocket guard needs Thieving 40 (46.8 XP); HP 30 and 20 shrimps (315) for harder stun hits.
    thieve_guards: { position: { x: 3210, z: 3459, level: 0 }, skills: { Thieving: 40, Hitpoints: 30 }, inventory: Array.from({ length: 20 }, () => ({ id: 315, count: 1 })) },
    // Thieving tier 3: Ardougne market knights (knowledge/npcs.json knight_of_ardougne at 2652,3318 and 2653,3300).
    // Pickpocket knight needs Thieving 55 (84.3 XP); a fail hits for 3, so HP 50 and 20 lobsters (379).
    thieve_knights: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 55, Hitpoints: 50 }, inventory: Array.from({ length: 20 }, () => ({ id: 379, count: 1 })) },
    // Same as thieve_knights but with a fresh account's 10 HP: isolates the cost of a low HP cap at knights.
    thieve_knights_hp10: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 55 }, inventory: Array.from({ length: 20 }, () => ({ id: 379, count: 1 })) },
    // Eat-timing tests for thieving60.ts, whose food list has bread and no lobsters: a fresh account's 10 HP, 20 bread (2309).
    thieve_knights_bread: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 55 }, inventory: Array.from({ length: 20 }, () => ({ id: 2309, count: 1 })) },
    // Cycle tests only: HP 99 and 27 lobsters, so food never runs out in a 1,500-tick knight run.
    thieve_knights_hp99: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 55, Hitpoints: 99 }, inventory: Array.from({ length: 27 }, () => ({ id: 379, count: 1 })) },
    // Ardougne baker's stall food test: Thieving 5 (stall level), HP 10, next to the west stall (loc touches 2654,3310).
    cake_stall: { position: { x: 2655, z: 3310, level: 0 }, skills: { Thieving: 5 } },
    // Resume test: a live-like account already in the Ardougne market, Thieving 66, 10 HP, 2000 coins.
    resume_ardougne: { position: { x: 2657, z: 3313, level: 0 }, skills: { Thieving: 66 }, coins: 2000 },
    // Lockpick door test: Thieving 16 beside loc_2551 (2674,3304), east of the Ardougne market.
    door_2551: { position: { x: 2675, z: 3304, level: 0 }, skills: { Thieving: 16 } },
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
    // Fishing resume test, a recorded live Mightyrod state: near Bob's Axes (3236,3206), Fishing 22, Thieving 50,
    // 0 coins, 28 items (starter kit, small net 303, fly fishing rod 309, 24 feathers 314, knife 946, 7 logs 1511,
    // shrimps 315, bread 2309). A save cannot set current HP, so this starts at 10 HP, not 2.
    fish_resume: {
        position: { x: 3236, z: 3206, level: 0 },
        skills: { Fishing: 22, Thieving: 50 },
        inventory: [1351, 590, 303, 315, 1925, 1931, 2309, 1265, 1205, 1277, 1171, 841].map(id => ({ id, count: 1 }))
            .concat([{ id: 882, count: 25 }, { id: 556, count: 25 }, { id: 558, count: 15 }, { id: 555, count: 6 }, { id: 557, count: 4 }, { id: 559, count: 2 }, { id: 946, count: 1 }])
            .concat(Array.from({ length: 5 }, () => ({ id: 1511, count: 1 })), [{ id: 309, count: 1 }, { id: 314, count: 24 }], Array.from({ length: 2 }, () => ({ id: 1511, count: 1 }))),
    },
    // ---- Stun guests (scripts/measure/stun-guest.ts): Thieving 99 at the Ardougne knights, 10 HP, 5 lobsters.
    // Bury arm: 22 dragon bones (536), Prayer 99 so no level-up page opens. Enchant arm: Magic 99, 300 water (555),
    // 300 cosmic (564), 20 sapphire rings (1637) for Lvl-1 Enchant. Baseline: no guest items.
    stun_base: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 99 }, inventory: Array.from({ length: 5 }, () => ({ id: 379, count: 1 })) },
    stun_bury: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 99, Prayer: 99 }, inventory: Array.from({ length: 5 }, () => ({ id: 379, count: 1 })).concat(Array.from({ length: 22 }, () => ({ id: 536, count: 1 }))) },
    stun_enchant: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 99, Magic: 99 }, inventory: Array.from({ length: 5 }, () => ({ id: 379, count: 1 })).concat([{ id: 555, count: 300 }, { id: 564, count: 300 }], Array.from({ length: 20 }, () => ({ id: 1637, count: 1 }))) },
};
