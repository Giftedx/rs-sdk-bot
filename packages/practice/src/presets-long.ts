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

export const LONG_PRESETS: Record<string, SaveConfig> = {
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
