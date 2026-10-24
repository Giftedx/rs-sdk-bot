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

// The Tourist Trap (scripts/generated/quest-desertrescue.ts): no quest needed. Worn: a rune scimitar for the Mercenary
// Captain (the bot takes it off before the camp: the guards jail a player with a weapon or armour,
// quest_desertrescue.rs2:145-186) and the desert shirt, robe and boots (1833/1835/1837, tradeable), which the slave
// swaps for his clothes in the worn slots (mining_slave.rs2:145-200) and which slow the desert heat
// (area_desert/scripts/desert_heat.rs2:10-56). Helper items (tradeable): a hammer, 3 bronze bars and 40 feathers for
// the dart (quest_desertrescue.rs2:577-672; a failed roll wastes a bar or 10 feathers), 2 full waterskins (1823), 6
// sharks. %desertrescue is varp 197, %desertrescue_map_mechanisms 198.
const TT_WORN = wear([[1333, 3], [1833, 4], [1835, 7], [1837, 10]]);
const SLAVE_WORN = wear([[1844, 4], [1845, 7], [1846, 10]]);
const TT_ITEMS: Array<number | [number, number]> = [2347, 2349, 2349, 2349, [314, 40], 1823, 1823];
function tt(position: { x: number; z: number; level?: number }, varps: Record<number, number> = {}, extra: Array<number | [number, number]> = [], equipment = TT_WORN): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment, varps: { ...DONE, ...varps },
        inventory: items([...TT_ITEMS, ...extra, ...Array.from({ length: 6 }, () => 385)]),
    };
}

export const LONG_PRESETS: Record<string, SaveConfig> = {
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

    // Beside Denulth in the Imperial Guard camp, Burthorpe (spawn 2896,3528, maps/m45_55.jm2).
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
};
