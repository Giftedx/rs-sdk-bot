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
    // quest sits in the quests-medium row after Plague City) for Ardougne Teleport (teleport.rs2:22-35). Helper items:
    // runes for one Ardougne Teleport (2 law 563, 2 water 555), 60 coins for the customs officer's boat when the teleport
    // cannot be cast and Captain Barnaby back to Brimhaven, 4
    // lobsters. The label and the totem are quest items from the run.
    quest_totem: rest({ x: 2791, z: 3183 }, [[563, 2], [555, 2]], 4, 60, { 165: 30 }),
    // Tribal Totem resumed as a parked live account resumes it: beside Kangai Mau, Hitpoints 17, Magic 29, Thieving 99
    // for the stairs trap, no Plague City and no runes, so the runner takes the customs officer's boat and Captain
    // Barnaby's back (60 coins). Varp 200 (quest_totem.constant): 1 started at Kangai, 2 the crate label replaced.
    // Tribal Totem run directly from the mainland (the Draynor bank), as the live account TheFullMonty stands: Hitpoints
    // 37, Magic 99, no Plague City, no runes, 90 coins for up to three fares. Varp 200: 0 not started, 1 started.
    ...Object.fromEntries([0, 1].map(stage => [`quest_totem_mainland${stage}`, {
        position: { x: 3092, z: 3243, level: 0 }, skills: { Hitpoints: 37, Magic: 99, Thieving: 99 }, varps: { ...DONE, 200: stage }, coins: 90,
        inventory: Array.from({ length: 4 }, () => ({ id: 379, count: 1 })),
    } satisfies SaveConfig])),
    // Tribal Totem with a full pack at the Ardougne south bank, as Quickhandjob stood live: 27 sharks and coins fill
    // all 28 slots, so the depot label would drop under the bot. Started, Hitpoints 17, no Plague City, no runes.
    quest_totem_fullpack: {
        position: { x: 2655, z: 3283, level: 0 }, skills: { Hitpoints: 17, Magic: 29, Thieving: 99 }, varps: { ...DONE, 200: 1 }, coins: 60,
        inventory: Array.from({ length: 27 }, () => ({ id: 385, count: 1 })),
    } satisfies SaveConfig,
    ...Object.fromEntries([1, 2].map(stage => [`quest_totem_boat${stage}`, {
        position: { x: 2791, z: 3183, level: 0 }, skills: { Hitpoints: 17, Magic: 29, Thieving: 99 }, varps: { ...DONE, 200: stage }, coins: 60,
        inventory: Array.from({ length: 4 }, () => ({ id: 379, count: 1 })),
    } satisfies SaveConfig])),
    // Tai Bwo Wannai Trio: at Timfraku's ladder in Tai Bwo Wannai (2782,3086, maps/m43_48.jm2). Jungle Potion done (175 =
    // 12, quest.constant:41; tbwt_timfraku.rs2:51 reads it). Helper items (tradeable, the rs-stun-toolkit kit): 4 raw
    // karambwan (3142), pestle and mortar (233), iron spear (1239), agility potion (3032), small net (303), jogre bones
    // (3125), seaweed (401), sliced banana (3162), the loaded karambwan vessel (3159); runes for one Superheat Item and 9
    // Fire Strikes (31 fire, 1 nature, 18 air, 9 mind); an amulet of glory (4) (1712); 100 coins. No food: falls and the
    // jungle spider hit take a share of current hitpoints.
    quest_tbwt: rest({ x: 2782, z: 3086 }, [3142, 3142, 3142, 3142, 233, 1239, 3032, 303, 3125, 401, 3162, 3159, [554, 31], [561, 1], [556, 18], [558, 9], 1712], 0, 100, { 175: 12 }),
    // Watch Tower: north of the Yanille watchtower's climbing rocks (2549,3120, maps/m39_48.jm2). Helper items (tradeable,
    // the rs-stun-toolkit kit): 2 ropes (954) for the two swings onto Grew's island, dragon bones (536), a gold bar (2357),
    // a death rune (560), a lit candle (33), a guam leaf (249), a vial of water (227), ground bat bones (2391),
    // jangerberries (247), a rune pickaxe (1275); 100 coins (20 for the chasm jump); 8 lobsters. The anti-dragon shield
    // (1540, from Dragon Slayer) is worn for the enclave's blue dragons. Fingernails, relic, cake, map, nightshade and
    // crystals are quest items from the run.
    quest_itwatchtower: {
        ...rest({ x: 2549, z: 3120 }, [954, 954, 536, 2357, 560, 33, 249, 227, 2391, 247, 1275], 8, 100),
        equipment: [...COMBAT_SET.filter(e => e.slot !== 5), { id: 1540, count: 1, slot: 5 }],
    },
    // Elemental Workshop: in the Seers' Village house beside the bookcase (2716,3481, maps/m42_54.jm2). Helper items
    // (tradeable): knife (946) for the book's spine, needle (1733), leather (1741) and thread (1734) for the bellows,
    // hammer (2347), rune pickaxe (1275), 4 coal (453); 6 lobsters. The book, key, bowl, ore and bar are quest items.
    quest_elemental: rest({ x: 2715, z: 3481 }, [946, 1733, 1741, 1734, 2347, 1275, 453, 453, 453, 453], 6),
    // Clock Tower: beside Brother Kojo, north of the tower (spawn 2569,3249, maps/m40_50.jm2). Helper item: a bucket of
    // water (1929) for the red-hot black cog (cogs.rs2:30-40); ice gloves also work but are untradeable. The cogs and
    // the rat poison are quest items from the run.
    quest_cog: rest({ x: 2568, z: 3249 }, [1929], 4),
    // Hazeel Cult (good side): beside Sir Ceril Carnillean in his house (spawn 2565,3271, maps/m40_51.jm2). No helper
    // items; the armour is a quest item from Alomone (alomone.rs2:115-123). 4 lobsters.
    quest_hazeelcult: rest({ x: 2566, z: 3271 }, [], 4),
    // Murder Mystery: beside the guard inside the Sinclair Mansion (spawn 2739,3577, maps/m42_55.jm2). Helper items
    // (tradeable): 3 pots of flour (1933) for the dagger and two suspects' items, a law (563) and 5 air runes (556) for
    // one Camelot Teleport to the poison salesman. The flypaper (untradeable) comes from the mansion's sacks.
    quest_murder: rest({ x: 2740, z: 3577 }, [1933, 1933, 1933, [563, 1], [556, 5]], 2),
    // Debug presets quest_murder_<suspect>: the quest started (varp 192 %murderquest = 1) with the murderer forced (varp 195
    // %murdersus, 1 Anna .. 6 Frank, quest_murder.constant); the guard's start rolls it at random (murder_guard.rs2:12).
    ...Object.fromEntries(['anna', 'bob', 'carol', 'david', 'elizabeth', 'frank'].map((k, i) =>
        [`quest_murder_${k}`, rest({ x: 2740, z: 3577 }, [1933, 1933, 1933, [563, 1], [556, 5]], 2, 0, { 192: 1, 195: i + 1 })])),
    // Observatory Quest: beside the professor in the reception (spawn 2438,3186, maps/m38_49.jm2). Helper items
    // (tradeable): 3 planks (960), a bronze bar (2349), a molten glass (1775); 4 lobsters. The keep key, the lens mould and
    // the lens are untradeable (knowledge/items.json 601-603), so the run collects them.
    quest_itgronigen: rest({ x: 2439, z: 3187 }, [960, 960, 960, 2349, 1775], 4),
    // Death Plateau: beside Denulth in the Imperial Guard camp, Burthorpe (spawn 2896,3528, maps/m45_55.jm2). Helper
    // items (tradeable): 10 bread (2309) and 10 trout (333) for Tenzing, an Asgarnian Ale (1905) and a Blurberry Special
    // (2064) for Harold, an iron bar (2351) for the spikes, coins for the 101-coin bet. No food: the 5 stone balls
    // need the last free slots. 500 coins cover a lost roll or two.
    quest_death: rest({ x: 2896, z: 3529 }, [...Array(10).fill(2309), ...Array(10).fill(333), 1905, 2064, 2351], 0, 500),
    // Big Chompy Bird Hunting: beside Rantz in the Feldip Hills (spawn 2630,2981, maps/m41_46.jm2). Helper items
    // (tradeable): a knife (946), a chisel (1755), an achey log (2862), wolf bones (2859) and 8 feathers (314) for the
    // bot's own ogre arrows (the made_arrows bit, ogre_arrows.rs2:139-142); 6 ogre arrows (2866) for Rantz with them; the
    // 6 possible seasonings (potato 1942, onion 1957, equa leaves 2128, cabbage 1965, tomato 1982, doogle leaves 1573),
    // as the content rolls each ogre's pick (random(1) is always 0 on this engine: onion, equa leaves, tomato);
    // 2 lobsters; 50 ogre arrows worn for the lent ogre bow. The bellows, the toads, the bow and the chompy are
    // untradeable or quest items (knowledge/items.json 2871-2883).
    quest_chompybird: {
        ...rest({ x: 2632, z: 2982 }, [946, 1755, 2862, 2859, [314, 8], [2866, 6], 1942, 1957, 2128, 1965, 1982, 1573], 2),
        equipment: [...COMBAT_SET, { id: 2866, count: 50, slot: 13 }],
    },
};
