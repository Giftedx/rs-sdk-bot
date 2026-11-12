import type { SaveConfig } from './presets';
import { QP_BEFORE_DRAGON } from './presets-dragon';

// Long and very long quests of the planner's `quests-rest` row (scripts/generated/quest-<name>.ts,
// research/quest-points-board.md). The row runs after the last 99, so every skill is 99. Done: the quests before the
// dragon row (QP_BEFORE_DRAGON), Dragon Slayer (176 = 10), Merlin's Crystal (14 = 7), Fight Arena (17 = 14), and the
// quests-medium prerequisites each preset names. Each preset starts beside the quest's first NPC with the
// helper-supplied items.
const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
const ALL_99: Record<string, number> = Object.fromEntries(SKILLS.map(k => [k, 99]));
const DONE: Record<number, number> = { ...QP_BEFORE_DRAGON, 176: 10, 14: 7, 17: 14 };
const items = (list: Array<number | [number, number]>) => list.map(e => Array.isArray(e) ? { id: e[0], count: e[1] } : { id: e, count: 1 });
const wear = (list: Array<[number, number]>) => list.map(([id, slot]) => ({ id, count: 1, slot }));

// Underground Pass (scripts/generated/quest-upass.ts): Plague City (165 = 30) and Biohazard (68 = 16) done
// (quest_upass.rs2:81). Worn: rune full helm, rune scimitar, rune chainbody, rune platelegs (4 slots: Iban's temple
// door opens only with the Zamorak robe top and bottom worn and nothing else, quest_upass.rs2:586, so the bot takes
// these 4 off there). Helper items (tradeable): shortbow (841) and 5 iron arrows (884) for the fire arrow
// (upass_bridge.rs2:1-22,33-79), a tinderbox (590) to light it, a rope (954) for the rock swing
// (upass_obstacles.rs2:94-131), a bucket (1925) for the dwarf brew (quest_upass.rs2:421-427), a spade (952) for the mud in
// the cell (:210-224), 14 sharks (385). A trial with 14 lobsters ended at hp 16 (traps, Kalrag, Iban's bolts).
const UP_WORN = wear([[1163, 0], [1333, 3], [1113, 4], [1079, 7]]);
const UP_ITEMS: Array<number | [number, number]> = [841, [884, 5], 590, 954, 1925, 952];
// Debug presets: %upass (161), %ibanmulti (162; bit 11 started, bits 22-31 the grid path set by King Lathas,
// upass_grid.rs2:47-60; 333 << 22 is the middle row in all 3 columns).
const GRID = 2048 + (333 << 22);
function upass(position: { x: number; z: number; level?: number }, varps: Record<number, number> = {}, extra: Array<number | [number, number]> = [], food = 14): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: UP_WORN, varps: { ...DONE, 165: 30, 68: 16, ...varps },
        inventory: items([...UP_ITEMS, ...extra, ...Array.from({ length: food }, () => 385)]),
    };
}

// Shilo Village (scripts/generated/quest-zombiequeen.ts): Jungle Potion (175 = 12) done (mosol_rei.rs2:2). Worn: the
// same rune set (the Beads of the Dead go on the neck slot). Helper items (tradeable): spade (952) for the mound
// (quest_zombiequeen.rs2:415-443), a lit candle (33) and a rope (954) for the fissure (:445-483), a chisel (1755) for
// the pommel and the bone shard (:1246-1299), bronze wire (1794) for the beads (:1263-1280), 3 bones (526) for the
// tomb door (:1399-1447), 14 sharks. %zombiequeen is varp 116, %zq_map_mechanisms 117.
const ZQ_ITEMS: Array<number | [number, number]> = [952, 33, 954, 1755, 1794, 526, 526, 526];
function zq(position: { x: number; z: number; level?: number }, varps: Record<number, number> = {}, extra: Array<number | [number, number]> = [], food = 14, base = ZQ_ITEMS): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: UP_WORN, varps: { ...DONE, 175: 12, ...varps },
        inventory: items([...base, ...extra, ...Array.from({ length: food }, () => 385)]),
    };
}

// Troll Stronghold (scripts/generated/quest-troll.ts): Death Plateau done (%death_equiproom 314 = 80, %death_map 315 =
// 8; death_ig_commander.rs2:5-9 offers the troll talk only then). Worn: the rune set, a rune kiteshield and climbing
// boots (3105, tradeable; Tenzing sells them for 12 coins after Death Plateau, death_sherpa.rs2:12-25), which the death
// and troll climbing rocks need (quest_death.rs2:159-176, quest_troll.rs2:1-13). 20 sharks. %troll_quest is varp 317,
// %troll_varbit 318.
const TROLL_WORN = wear([[1163, 0], [1333, 3], [1113, 4], [1201, 5], [1079, 7], [3105, 10]]);
function troll(position: { x: number; z: number; level?: number }, varps: Record<number, number> = {}, extra: Array<number | [number, number]> = [], food = 20): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: TROLL_WORN, varps: { ...DONE, 314: 80, 315: 8, ...varps },
        inventory: items([...extra, ...Array.from({ length: food }, () => 385)]),
    };
}

// Eadgar's Ruse (scripts/generated/quest-eadgar.ts): Druidic Ritual (in DONE), Death Plateau, Troll Stronghold done
// with Eadgar freed and the back door opened (317 = 50, 318 = 63, as the 3 Troll Stronghold proof saves). Worn: the
// troll set (climbing boots for the rocks). Helper items (tradeable): pineapple chunks (2116) and vodka (2015) for the
// parrot (eadgar_zoo_keeper_aviary.rs2:21-50), 2 logs (one for Eadgar, one for the fire), 10 grain, 5 raw chickens
// (quest_eadgar.rs2:224-357), a tinderbox, a pestle and mortar, a ranarr potion (unf) (99) for the troll potion,
// runes for 3 Falador teleports, 3 sharks (the Death Plateau trolls took the bot from 99 to 30 hp in a trial).
// %eadgar_quest 335, %eadgar_bits 336, %eadgar_grain 337, %eadgar_chickens 338.
const EA_ITEMS: Array<number | [number, number]> = [2116, 2015, 1511, 1511, ...Array(10).fill(1947), ...Array(5).fill(2138), 590, 233, 99, [563, 3], [556, 9], [555, 3], 385, 385, 385];
const EA_BITS = 1 | (1 << 11) | (1 << 1);   // Pete's 2 talks, the logs given
function eadgar(position: { x: number; z: number; level?: number }, varps: Record<number, number> = {}, inv: Array<number | [number, number]> = EA_ITEMS): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: TROLL_WORN, varps: { ...DONE, 314: 80, 315: 8, 317: 50, 318: 63, ...varps },
        inventory: items(inv),
    };
}
const EA_LATE: Array<number | [number, number]> = [590, 233, 99, [563, 3], [556, 9], [555, 3], 385, 385, 385];

// Troll Romance (scripts/generated/quest-trolllove.ts): Death Plateau, Troll Stronghold and Eadgar's Ruse done (335 =
// 110, for the Trollheim teleport, skill_magic/scripts/spells/teleport.rs2:30-33). Worn: the troll set. Helper items
// (tradeable): maple logs, an iron bar and a rope for Dunstan's sled (death_smithy.rs2:233-255), a bucket of wax, swamp
// tar and a cake tin for the sled wax (quest_troll_love.rs2:67-82), runes for 3 Trollheim teleports (2 law, 2 fire
// each, magic_spells.dbrow), 14 sharks. %troll_love is varp 385. The sled, wax and Trollweiss are untradeable
// (quest_troll_love.obj).
const TR_ITEMS: Array<number | [number, number]> = [1517, 2351, 954, 30, 1939, 1887, [563, 6], [554, 6]];
function trollLove(position: { x: number; z: number; level?: number }, varps: Record<number, number> = {}, inv: Array<number | [number, number]> = TR_ITEMS, food = 14): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: TROLL_WORN,
        varps: { ...DONE, 314: 80, 315: 8, 317: 50, 318: 63, 335: 110, ...varps },
        inventory: items([...inv, ...Array.from({ length: food }, () => 385)]),
    };
}

// The Tourist Trap (scripts/generated/quest-desertrescue.ts): no quest needed. Worn: a rune scimitar for the Mercenary
// Captain (the bot takes it off before the camp: the guards jail a player with a weapon or armour,
// quest_desertrescue.rs2:145-186) and the desert shirt, robe and boots (1833/1835/1837, tradeable), which the slave
// swaps for his clothes in the worn slots (mining_slave.rs2:145-200) and which slow the desert heat
// (area_desert/scripts/desert_heat.rs2:10-56). Helper items (tradeable): a hammer, 5 bronze bars and 40 feathers for
// the dart (quest_desertrescue.rs2:577-672; a failed roll wastes a bar or 10 feathers), 2 full waterskins (1823), 6
// sharks. %desertrescue is varp 197, %desertrescue_map_mechanisms 198.
const TT_WORN = wear([[1333, 3], [1833, 4], [1835, 7], [1837, 10]]);
const SLAVE_WORN = wear([[1844, 4], [1845, 7], [1846, 10]]);
const TT_ITEMS: Array<number | [number, number]> = [2347, 2349, 2349, 2349, 2349, 2349, [314, 40], 1823, 1823];
function tt(position: { x: number; z: number; level?: number }, varps: Record<number, number> = {}, extra: Array<number | [number, number]> = [], equipment = TT_WORN): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment, varps: { ...DONE, ...varps },
        inventory: items([...TT_ITEMS, ...extra, ...Array.from({ length: 6 }, () => 385)]),
    };
}

// Temple of Ikov (scripts/generated/quest-ikov.ts): no quest needed (Thieving 42, Ranged 40). Worn: a magic shortbow
// (861; ice arrows need a yew or magic bow, quest_ikov.obj ice_arrow levelrequire 40, player_ranged.rs2:97), no
// armour: the lava bridge drops a player whose weight is 0 or more (ikov_dungeon.rs2:52-82), and the boots of
// lightness give -10 lb. Helper items (tradeable): a lit candle (33) for the dark stairs (:3-10), a knife (946) for the
// web in front of the boots (general_use/scripts/web.rs2:10-30, 1 in 2 per slash), 20 limpwurt roots
// (225) for Winelda (winelda.rs2:1-12), Varrock Teleport runes (law, 3 air, fire), 2 sharks. %ikov is varp 26,
// %ikov_icearrowchest_coord 28 is set to -1: a coord varp starts at -1 (null) in the engine (engine/entity/Player.ts:490-497)
// but the generated save writes 0, which matches no chest (quest_ikov.rs2:115-131; trial 4 searched 60 times for none).
// %ikov_dungeon 27 (bit 0 the lever, bit 1 the bridge).
const IK_WORN = wear([[861, 3]]);
const IK_ITEMS: Array<number | [number, number]> = [33, 946, ...Array(20).fill(225), [563, 1], [556, 3], [554, 1], 385, 385];
function ikov(position: { x: number; z: number; level?: number }, varps: Record<number, number> = {}, extra: Array<number | [number, number]> = [], equipment = IK_WORN): SaveConfig {
    return { position: { level: 0, ...position }, skills: ALL_99, equipment, varps: { ...DONE, 28: -1, ...varps }, inventory: items([...IK_ITEMS, ...extra]) };
}

// Horror from the Deep (scripts/generated/quest-horror.ts): no quest needed (Agility 35, horror_journal.rs2:6);
// Alfred Grimhand's Barcrawl done (77 = 2, the barcrawl row before Scorpion Catcher) for the Barbarian Outpost gate on
// the way to Gunnjorn (area_barbarian_outpost/scripts/outpost_gate.rs2:1-5). Worn:
// the rune set. Helper items (tradeable): 2 planks, 8 nails and a hammer for the bridge (quest_horror.rs2:110-167);
// swamp tar, a tinderbox and molten glass for the light (:245-289); a bronze dagger and a bronze arrow for the strange
// wall (:332-427, with one rune of each element from the stacks); air, water, earth, fire and blood runes for the
// waves on the Dagannoth mother (npc_combat.rs2:402-437); 12 sharks. %deephorror is varp 351 (above 308, so
// extendVarps writes it): stage in bits 0-10, the bridge halves 12-13, the key 14, the door 15, the wall slots 16-21,
// tar, glass and light 22-24 (quest_horror.varbit).
const HD_ITEMS: Array<number | [number, number]> = [960, 960, [1539, 8], 2347, 1939, 1775, 590, 1205, [882, 1], [556, 200], [555, 100], [557, 100], [554, 100], [565, 40]];
const HD_IN = 2 + (15 << 12);                            // entered; bridges, key and door bits
const HD_LIT = 4 + (15 << 12) + (7 << 22);               // the light repaired
function horror(position: { x: number; z: number; level?: number }, varps: Record<number, number> = {}, inv = HD_ITEMS, food = 12): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: UP_WORN, varps: { ...DONE, 77: 2, ...varps },
        inventory: items([...inv, ...Array.from({ length: food }, () => 385)]),
    };
}

// Regicide (scripts/generated/quest-regicide.ts): Underground Pass done (161 = 10; %ibanmulti 162 as a finished run
// leaves it: the doll bits 1-4, the 4 orbs 5-8, the cat 9, started 11, the 3 badges and the horn thrown 14-16 and 18,
// Koftik 17, the grid path 22-31), %regicide_quest (328) 1 with the King's summons (3206). Worn: the rune set. Helper
// items (tradeable): a shortbow and 2 iron fire arrows (2532) with a tinderbox for the bridge rope (one per crossing of
// the pass), a rope (the second one in the bank), a spade for the cell mud, a pestle and mortar, an empty pot, a
// limestone, 4 balls of wool, runes for a Falador and two Ardougne teleports, 10 sharks; in the Falador bank: 8 coal for
// the still, the second rope, a cooked rabbit for the catapult guard, 20 sharks.
const IBAN_DONE = 1022 + 2048 + 114688 + 131072 + 262144 + (333 << 22);
const RG_WORN = UP_WORN;
const RG_RUNES: Array<number | [number, number]> = [[563, 5], [556, 3], [555, 5]];
const RG_BANK = items([[453, 8], 954, 3228, [385, 20]]);
function rg(position: { x: number; z: number; level?: number }, stage: number, inv: Array<number | [number, number]>, food = 10): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: RG_WORN, varps: { ...DONE, 165: 30, 68: 16, 161: 10, 162: IBAN_DONE, 328: stage },
        inventory: items([...inv, ...Array.from({ length: food }, () => 385)]), bank: RG_BANK,
    };
}
const RG_TRAV: Array<number | [number, number]> = [841, 590, 952, 233, 1931, 3211];

// The Fremennik Trials (scripts/generated/quest-viking.ts): no quest needed. Nothing worn (Peer banks it all,
// viking_peer.rs2:160-215, and Thorvald's fight allows no weapons or armour, viking_thorvald.rs2:435-481). Helper items
// (tradeable): 5,300 coins, a beer, a tinderbox, a rune axe, a knife, a cabbage, a potato, an onion, a raw shark, 4
// sharks. %viking is varp 347 (1 + votes), %viking_bits 348 (quest_viking.constant).
const VK_ITEMS: Array<number | [number, number]> = [[995, 5300], 1917, 590, 1359, 946, 1965, 1942, 1957, 383];
function viking(position: { x: number; z: number; level?: number }, varps: Record<number, number> = {}, inv: Array<number | [number, number]> = VK_ITEMS, food = 4): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: [], varps: { ...DONE, ...varps },
        inventory: items([...inv, ...Array.from({ length: food }, () => 385)]),
    };
}
// Debug stages (VK_FROM): the %viking_bits ranges after each stage.
const VB_START = (2 << 10) | (1 << 12) | (1 << 14);                 // Swensen done; Manni, Sigli started
const VB_OLAF1 = VB_START | (1 << 16) | (3 << 20);                  // Thorvald started; Olaf: Askeladden's rock
const VB_CHAIN = VB_OLAF1 | (15 << 23);                             // Sigmund done
const VB_EAST2 = (VB_CHAIN & ~(7 << 20)) | (1 << 1) | (5 << 20) | (15 << 27);    // the salesman; Olaf 5 (the stew)
const VB_DRAUGEN = VB_EAST2 | (2 << 14);                            // Sigli done (3)
const VB_MANNI = (VB_DRAUGEN & ~0b111 & ~(3 << 12)) | (2 << 12);   // Manni done (2)
const VB_OLAF = (VB_MANNI & ~(7 << 20) & ~(15 << 27)) | (7 << 20);  // Olaf done
const VB_PEER = VB_OLAF | (3 << 18);                                // Peer done

// Throne of Miscellania (scripts/generated/quest-misc.ts): Heroes' Quest (188 = 15) and The Fremennik Trials (347 =
// 10) done (misc_door_guard.rs2:10, misc_journal.rs2:8-17). Heroes' Quest needs a partner account that is not scripted
// yet, so this preset sets it. Worn: an iron sickle (3899, tradeable; Gardener Gunnhild sells it), which the herb
// weeding needs (area_miscellania/scripts/weed_herbs.rs2:19-21). Helper items (tradeable): flowers (2472), a shortbow,
// a gold ring for Princess Astrid (princess_astrid.rs2:622-694); an iron bar for Derrik's nib and logs for the pen
// (derrik.rs2:32-45, quest_misc.rs2:9-19). %misc_quest is varp 359; %misc_varbit_1 (361) holds the approval (bits
// 18-24) and the affection (25-31); %misc_varbit_2 (362) bit 30 audience, bit 31 visited (quest_misc.varbit).
const MISC_ITEMS: Array<number | [number, number]> = [2472, 841, 1635, 2351, 1511];
const MISC_WORN = wear([[3899, 3]]);
const MISC_V2 = (1 << 30) | (1 << 31);                   // audience granted, island visited (negative as int32)
function misc(position: { x: number; z: number; level?: number }, varps: Record<number, number> = {}, inv: Array<number | [number, number]> = MISC_ITEMS): SaveConfig {
    return { position: { level: 0, ...position }, skills: ALL_99, equipment: MISC_WORN, varps: { ...DONE, 188: 15, 347: 10, ...varps }, inventory: items(inv) };
}
const MISC_WED = (40 << 25);                              // %misc_affection 40: Astrid agreed to marry
const MISC_FULL = MISC_WED | (96 << 18);                  // and the approval at 75 % (96 of 127)

// The Mage Arena (scripts/generated/quest-magearena.ts): Magic 80 for Fire Wave, Prayer 43 for Protect from Magic,
// Hitpoints 50, the other skills 1. A staff of fire worn: Kolodion refuses armour and weapons, and a staff is neither
// (mage_arena.rs2:100-138). Runes for 80 casts of Fire Wave (5 air and 1 blood a cast, the staff gives the fire) and
// 110 of Flames of Zamorak (4 fire, 2 blood, 1 air): 540 air (556), 440 fire (554), 300 blood (565). A knife (946) for
// the webs of the hut (web.rs2:10-16), 4 prayer potions (2434) and 6 sharks (385).
export const MAGEARENA_RUNES: Array<[number, number]> = [[556, 540], [554, 440], [565, 300]];
const MA_SKILLS = { Magic: 80, Prayer: 43, Hitpoints: 50 };
function magearena(varps: Record<number, number> = {}, worn = wear([[1387, 3]]), more: number[] = []): SaveConfig {
    return {
        position: { x: 2540, z: 4714, level: 0 }, skills: MA_SKILLS, equipment: worn, varps,
        inventory: items([...MAGEARENA_RUNES, 946, ...more, 2434, 2434, 2434, 2434, 385, 385, 385, 385, 385, 385]),
    };
}

export const LONG_PRESETS: Record<string, SaveConfig> = {
    // North of the throne room door, level 1 of the Miscellania castle (King Vargas spawn 2501,3859,1,
    // maps/m39_60.jm2), where the stairs from the ground floor arrive.
    quest_misc: misc({ x: 2506, z: 3865, level: 1 }),
    // Debug (MI_FROM=weed): by the herb garden, %misc_quest 10, Astrid agreed (approval 32).
    quest_misc_weed: misc({ x: 2524, z: 3851 }, { 359: 10, 361: MISC_WED | (32 << 18), 362: MISC_V2 }, [2351, 1511]),
    // Debug (MI_FROM=peace): by the herb garden, %misc_quest 10, Astrid agreed, approval 96.
    quest_misc_peace: misc({ x: 2523, z: 3851 }, { 359: 10, 361: MISC_FULL, 362: MISC_V2 }, [2351, 1511]),
    // Debug (MI_FROM=pen): north of the throne room door, %misc_quest 70 with the treaty (3896).
    quest_misc_pen: misc({ x: 2506, z: 3865, level: 1 }, { 359: 70, 361: MISC_FULL, 362: MISC_V2 }, [2351, 1511, 3896]),

    // In King Lathas's room, level 1 of Ardougne castle.
    quest_regicide: rg({ x: 2577, z: 3292, level: 1 }, 1, [3206, [2532, 2], 954, ...RG_TRAV, 1759, 1759, 1759, 1759, ...RG_RUNES]),
    // Debug (RG_FROM=tir1): at the temple exit in Tirannwn, %regicide_quest 2.
    quest_regicide_tir1: rg({ x: 2312, z: 3216 }, 2, [2532, ...RG_TRAV, 1759, 1759, 1759, 1759, ...RG_RUNES]),
    // Debug (RG_FROM=t8): beside the tracker, %regicide_quest 8, the 2 barrels and the cloth.
    quest_regicide_t8: rg({ x: 2256, z: 3150 }, 8, [2532, ...RG_TRAV, 3216, 3216, 3224, ...RG_RUNES]),
    // Debug (RG_FROM=falador): at the Falador teleport spot, %regicide_quest 11, 2 tar barrels, sulphur dust, the cloth.
    quest_regicide_falador: rg({ x: 2965, z: 3378 }, 11, [2532, ...RG_TRAV, 3220, 3220, 3215, 3224, [563, 4], [555, 4]], 8),
    // Debug (RG_FROM=up2): at the Ardougne teleport spot, %regicide_quest 11, the fused barrel, rabbit and rope.
    quest_regicide_up2: rg({ x: 2661, z: 3301 }, 11, [841, 2532, 590, 952, 954, 3219, 3228, [563, 2], [555, 2]], 12),
    // Debug (RG_FROM=tir2): at the temple exit, %regicide_quest 11, the fused barrel and the rabbit.
    quest_regicide_tir2: rg({ x: 2312, z: 3216 }, 11, [841, 590, 952, 3219, 3228, [563, 2], [555, 2]], 12),
    // Debug (RG_FROM=home): beside the catapult after the shot, %regicide_quest 12.
    quest_regicide_home: rg({ x: 2183, z: 3185 }, 12, [[563, 2], [555, 2]], 8),

    // Beside Lucien in the Flying Horse Inn, Ardougne (spawn 2573,3321, maps/m40_51.jm2).
    quest_ikov: ikov({ x: 2574, z: 3321 }),
    // Debug (IK_FROM=low): in the temple by the dark stairs, %ikov 10, the pendant of Lucien (86) worn.
    quest_ikov_low: ikov({ x: 2654, z: 9809 }, { 26: 10 }, [], wear([[861, 3], [86, 2]])),
    // Debug (IK_FROM=arrows): south of the mended-lever gate, %ikov 10, the lever bit set, boots of lightness worn.
    quest_ikov_arrows: ikov({ x: 2661, z: 9801 }, { 26: 10, 27: 1 }, [], wear([[861, 3], [86, 2], [89, 10]])),
    // Debug (IK_FROM=warrior): south of the trap-lever door, %ikov 30, 10 ice arrows worn.
    quest_ikov_warrior: ikov({ x: 2648, z: 9855 }, { 26: 30, 27: 1 }, [], [...wear([[861, 3], [86, 2], [89, 10]]), { id: 78, count: 10, slot: 13 }]),

    // Beside Larrissa outside the lighthouse (spawn 2508,3635, maps/m39_56.jm2).
    quest_horror: horror({ x: 2508, z: 3634 }),
    // Debug (HD_FROM=in): inside the lighthouse (the 38_71 copy), %horrorquest 2.
    quest_horror_in: horror({ x: 2445, z: 4598 }, { 351: HD_IN }),
    // Debug (HD_FROM=cave): at the foot of the basement ladder (level 1), the light repaired (%horrorquest 4).
    quest_horror_cave: horror({ x: 2518, z: 4618, level: 1 }, { 351: HD_LIT }),
    // Debug (HD_FROM=fight): beside Jossik in the cavern, %horrorquest 4, the wall slots filled.
    quest_horror_fight: horror({ x: 2516, z: 4634 }, { 351: HD_LIT + (63 << 16) }),
    // Beside Irena, south of the Shantay Pass (spawn 3303,3113, maps/m51_48.jm2).
    quest_desertrescue: tt({ x: 3303, z: 3112 }),
    // Debug (TT_FROM=shabim): beside Al Shabim's tent, %desertrescue 10 (the mine guard asked for a pineapple), the
    // metal key (1839), the scimitar and the slave clothes in the pack.
    quest_desertrescue_shabim: tt({ x: 3170, z: 3034 }, { 197: 10 }, [1839, 1333, 1844, 1845, 1846], []),
    // Debug (TT_FROM=ana): east of the mine cave, %desertrescue 17 (pineapple given), slave clothes worn, metal key.
    quest_desertrescue_ana: tt({ x: 3286, z: 9415 }, { 197: 17 }, [1839, 1333], SLAVE_WORN),
    // Beside Parroty Pete at the Ardougne zoo aviary (spawn 2611,3285, maps/m40_51.jm2).
    quest_eadgar: eadgar({ x: 2612, z: 3285 }),
    // Debug (EA_FROM=leg1): inside the stronghold back door with the parrot, %eadgar_quest 10.
    quest_eadgar_leg1: eadgar({ x: 2823, z: 10050 }, { 335: 10, 336: 1 | (1 << 11) }, [...EA_ITEMS.filter(e => e !== 2116 && e !== 2015), 3266]),
    // Debug (EA_FROM=rack1): beside Eadgar with the parrot and the ground thistle, %eadgar_quest 50.
    quest_eadgar_rack1: eadgar({ x: 2891, z: 10084, level: 2 }, { 335: 50, 336: 1 | (1 << 11) }, [1511, ...Array(10).fill(1947), ...Array(5).fill(2138), 3266, 3264, ...EA_LATE]),
    // Debug (EA_FROM=robe): beside Tegid, the items given (%eadgar_quest 70).
    quest_eadgar_robe: eadgar({ x: 2913, z: 3419 }, { 335: 70, 336: EA_BITS, 337: 10, 338: 5 }, [3264, ...EA_LATE]),
    // Debug (EA_FROM=potion): beside Eadgar with the robe and the ground thistle, %eadgar_quest 70.
    quest_eadgar_potion: eadgar({ x: 2891, z: 10084, level: 2 }, { 335: 70, 336: EA_BITS, 337: 10, 338: 5 }, [3267, 3264, ...EA_LATE]),
    // Debug (EA_FROM=rack2): beside Eadgar, the potion given (%eadgar_quest 85).
    quest_eadgar_rack2: eadgar({ x: 2891, z: 10084, level: 2 }, { 335: 85, 336: EA_BITS | 4, 337: 10, 338: 5 }, EA_LATE),
    // Debug (EA_FROM=fakeman): beside Eadgar with the fake man (%eadgar_quest 87).
    quest_eadgar_fakeman: eadgar({ x: 2891, z: 10084, level: 2 }, { 335: 87, 336: EA_BITS | 4, 337: 10, 338: 5 }, [3268, ...EA_LATE]),
    // Debug (EA_FROM=store): by the kitchen drawers (level 1) with the storeroom key (%eadgar_quest 90).
    quest_eadgar_store: eadgar({ x: 2852, z: 10050, level: 1 }, { 335: 90, 336: EA_BITS | 4, 337: 10, 338: 5 }, [3269, 2146, ...EA_LATE]),

    // Beside Ug, level 1 of the Troll Stronghold (spawn 2827,10064,1, maps/m44_157.jm2).
    quest_trolllove: trollLove({ x: 2827, z: 10066, level: 1 }),
    // Debug (TR_FROM=cave): in Burthorpe with the waxed sled (%troll_love 25).
    quest_trolllove_cave: trollLove({ x: 2919, z: 3574 }, { 385: 25 }, [4084, 1887, [563, 6], [554, 6]]),
    // Debug (TR_FROM=arrg): beside Ug with the Trollweiss given (%troll_love 35).
    quest_trolllove_arrg: trollLove({ x: 2827, z: 10066, level: 1 }, { 385: 35 }, [1887, [563, 2], [554, 2]]),

    // Beside Denulth in the Imperial Guard camp, Burthorpe (spawn 2896,3528, maps/m45_55.jm2).
    quest_viking: viking({ x: 2659, z: 3666 }),
    quest_viking_olaf1: viking({ x: 2649, z: 3661 }, { 347: 2, 348: VB_START }, [...VK_ITEMS, 3697]),
    quest_viking_chain: viking({ x: 2658, z: 3661 }, { 347: 2, 348: VB_OLAF1 }, [...VK_ITEMS, 3697, 3688, 3695]),
    quest_viking_east2: viking({ x: 2641, z: 3682 }, { 347: 3, 348: VB_CHAIN }, [[995, 300], 1917, 590, 1359, 946, 1965, 1942, 1957, 383, 3697, 3688, 3695]),
    quest_viking_draugen: viking({ x: 2626, z: 3600 }, { 347: 3, 348: VB_EAST2 }, [[995, 50], 590, 1359, 946, 3697, 3690, 3712, 3713]),
    quest_viking_manni: viking({ x: 2660, z: 3655 }, { 347: 4, 348: VB_DRAUGEN }, [[995, 50], 590, 1359, 946, 3690, 3712, 3713]),
    quest_viking_olaf: viking({ x: 2664, z: 3674 }, { 347: 5, 348: VB_MANNI }, [[995, 50], 590, 1359, 946, 3690]),
    quest_viking_peer: viking({ x: 2660, z: 3683 }, { 347: 6, 348: VB_OLAF }, [[995, 50], 590, 1359, 946, 3689]),
    quest_viking_thorvald: viking({ x: 2636, z: 3668 }, { 347: 7, 348: VB_PEER }, [], 0),
    quest_viking_end: viking({ x: 2667, z: 3695 }, { 347: 8, 348: (VB_PEER & ~(3 << 16)) | (2 << 16) }, [], 0),

    quest_troll: troll({ x: 2896, z: 3529 }),
    // Debug (TS_FROM=arena): west of the arena door, %troll_quest 10.
    quest_troll_arena: troll({ x: 2894, z: 3618 }, { 317: 10 }),
    // Debug (TS_FROM=inside): inside the stronghold door (level 2), Dad beaten (%troll_quest 20).
    quest_troll_inside: troll({ x: 2837, z: 10090, level: 2 }, { 317: 20 }),
    // Debug (TS_FROM=back): outside the back exit, Godric and Eadgar freed (%troll_quest 40, %troll_varbit bits 0-3).
    quest_troll_back: troll({ x: 2827, z: 3646 }, { 317: 40, 318: 15 }),

    // Beside Mosol Rei, east of the Shilo Village gates (spawn 2883,2951, maps/m45_46.jm2).
    quest_zombiequeen: zq({ x: 2884, z: 2951 }),
    // Debug (ZQ_FROM=mound): beside the mound with the quest started (%zombiequeen 1).
    quest_zombiequeen_mound: zq({ x: 2921, z: 2997 }, { 116: 1 }),
    // Debug (ZQ_FROM=azr): in Ah Za Rhoon below the fissure (%zombiequeen 7), the candle and rope used.
    quest_zombiequeen_azr: zq({ x: 2898, z: 9401 }, { 116: 7 }, [], 14, [1755, 1794, 526, 526, 526]),
    // Debug (ZQ_FROM=cairn): east of the Cairn Isle rocks, Ah Za Rhoon done (%zombiequeen 8, both scrolls read: bits
    // 5 and 6), Zadimus' remains and the 2 scrolls in the pack.
    quest_zombiequeen_cairn: zq({ x: 2796, z: 2979 }, { 116: 8, 117: 96 }, [610, 607, 608], 14, [1755, 1794, 526, 526, 526]),

    // In King Lathas's room, level 1 of Ardougne castle (spawn 2578,3293,1, maps/m40_51.jm2).
    quest_upass: upass({ x: 2577, z: 3292, level: 1 }),
    // Debug (UP_FROM=bridge): beside Koftik at the bridge, %upass 1.
    quest_upass_bridge: upass({ x: 2450, z: 9716 }, { 161: 1, 162: GRID }),
    // Debug (UP_FROM=grid): east of the spike grid, %upass 2, the rope already used.
    quest_upass_grid: upass({ x: 2477, z: 9677 }, { 161: 2, 162: GRID }),
    // Debug (UP_FROM=orbs): west of the portcullis, %upass 2.
    quest_upass_orbs: upass({ x: 2464, z: 9677 }, { 161: 2, 162: GRID }),
    // Debug (UP_FROM=area2): below the well, %upass 3.
    quest_upass_area2: upass({ x: 2423, z: 9660 }, { 161: 3, 162: GRID }),
    // Debug (UP_FROM=paladins): north of the skull door with the horn, %upass 4 (the rope and spade used).
    quest_upass_paladins: upass({ x: 2371, z: 9666 }, { 161: 4, 162: GRID }, [1487]),
    // Debug (UP_FROM=main): in the main cavern behind the skull door, %upass 5.
    quest_upass_main: upass({ x: 2173, z: 4725, level: 1 }, { 161: 5, 162: GRID }),
    // Debug (UP_FROM=witch): by the tunnel up from the dwarves, %upass 6.
    quest_upass_witch: upass({ x: 2336, z: 9795 }, { 161: 6, 162: GRID }),
    // Debug (UP_FROM=lower): beside the demons with the doll and shadow done, %upass 7 (bits 4 shadow, 9 cat).
    // Debug: at the shadow chest, same state.
    quest_upass_chest: upass({ x: 2136, z: 4577, level: 1 }, { 161: 7, 162: GRID + 16 + 512 }, [1492]),
    quest_upass_lower: upass({ x: 2135, z: 4556, level: 1 }, { 161: 7, 162: GRID + 16 + 512 }, [1492]),

    // Beside Kolodion in the cellar of the Mage Arena (spawn 2541,4715, maps/m39_73.jm2).
    quest_magearena: magearena(),
    // Debug: Kolodion beaten (%magearena 6), before the pool and the statue.
    quest_magearena_chamber: magearena({ 267: 6 }),
    // Debug: the cape and the staff of Zamorak worn (%magearena 8), before the casts in the arena.
    quest_magearena_casts: magearena({ 267: 8 }, wear([[2417, 3], [2414, 1]]), [1387]),
};
