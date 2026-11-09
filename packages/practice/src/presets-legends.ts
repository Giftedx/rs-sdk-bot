import type { SaveConfig } from './presets';

// Legends' Quest (scripts/generated/quest-legends.ts). Every skill 99, combat rune set worn with the rune scimitar. DONE holds
// each quest varp below 309 at its complete value, so the login recount (general/scripts/quests.rs2) gives over 107 QP and
// the guard's five quests pass (legends_guard.rs2:50-53). Varp 139 %legendsquest, 140 legends_bits.
const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
const ALL_99: Record<string, number> = Object.fromEntries(SKILLS.map(k => [k, 99]));
const COMBAT_SET = [[1163, 0], [1725, 2], [1333, 3], [1113, 4], [1201, 5], [1079, 7], [1059, 9], [1061, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
const DONE: Record<number, number> = { 0: 11, 5: 10, 11: 5, 14: 7, 17: 14, 26: 80, 29: 2, 30: 80, 31: 100, 32: 3, 60: 3, 62: 6, 63: 6, 65: 10, 67: 3, 68: 16, 71: 4, 76: 6, 80: 4, 107: 5, 111: 9, 112: 7, 116: 15, 122: 7, 130: 4, 131: 9, 144: 100, 147: 6, 148: 11, 150: 160, 159: 12, 160: 2, 161: 10, 165: 29, 175: 12, 176: 10, 178: 3, 179: 22, 180: 6, 188: 15, 192: 2, 197: 30, 200: 5, 212: 13, 222: 30, 223: 9, 226: 7, 273: 110, 293: 65, 302: 60, 307: 110 };
const BITS_MAPPED = 0b111;                                   // the three jungle sections
const BITS_B = BITS_MAPPED | 0b110000 | (0b11111 << 7);      // + asked Ungadulu where and who, + the five rune bits
const BITS_C = BITS_B | (0b11111 << 24);                     // + rope, bravery, the three smelted pieces

type Kit = Array<number | [number, number]>;
function legends(position: { x: number; z: number; level?: number }, items: Kit, stage = 0, bits = 0): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: COMBAT_SET, varps: { ...DONE, 139: stage, 140: bits },
        inventory: items.map(e => Array.isArray(e) ? { id: e[0], count: e[1] } : { id: e, count: 1 }),
    };
}
const SHARKS = (n: number): number[] => Array(n).fill(385);
// Carried in from the bank: 60 coins (ship 30, cart 10), 5 papyrus (970), 4 charcoal (973), a rune axe (1359), 4 sharks, a
// prayer potion (2434), runes for the Camelot Teleport home (law 563, air 556).
const CARRY: Kit = [[995, 60], 970, 970, 970, 970, 970, 973, 973, 973, 973, 1359, 2434, [563, 1], [556, 5], ...SHARKS(4)];
// Quest tools the jungle needs: the machete (975), the completed map (715), the rune axe.
const TOOLS: Kit = [975, 715, 1359];
// Kit B (helper at 2816,2947): 2 gold bars (2357; a forge mistake needs Smithing below 99, so a weaker account takes 4), hammer (2347), lockpick (1523), rune pickaxe (1275), soul (566), mind (558),
// earth (557), 4 law (563), the 7 gems, a prayer potion.
const KIT_B: Kit = [2357, 2357, 2347, 1523, 1275, [566, 1], [558, 1], [557, 1], [563, 4], 1609, 1611, 1613, 1607, 1601, 1603, 1605, 2434];
// Kit C (helper at 2816,2947): rope (954), unpowered orb (567), 30 water (555), 3 cosmic (564), a vial of water (227), 3 prayer
// potions, super attack (2436), super strength (2440), 2 sharks. The main keeps 2 free slots for the herbs.
const KIT_C: Kit = [954, 567, [555, 30], [564, 3], 227, 2434, 2434, 2434, 2436, 2440, ...SHARKS(2)];
const MEET = { x: 2816, z: 2947 };

export const LEGENDS_PRESETS: Record<string, SaveConfig> = {
    // Outside the Legends' Guild gate (2728,3349).
    quest_legends: legends({ x: 2728, z: 3346 }, CARRY),
    quest_legends_kit_b: legends(MEET, KIT_B),
    quest_legends_kit_c: legends(MEET, KIT_C),
    // Debug: the state before a segment (LEG_FROM=<segment>).
    // B: stage 5, in the jungle after Gujuo.
    quest_legends_b: legends({ x: 2815, z: 2933 }, [...TOOLS, 716, 2434, [563, 1], [556, 5], ...SHARKS(5)], 5, BITS_MAPPED),
    // C: stage 12, in the octagram beside Ungadulu.
    quest_legends_c: legends({ x: 2791, z: 9328 }, [...TOOLS, 716, 726, 730, 1523, 1275, 2434, [563, 3], [556, 5], ...SHARKS(4)], 12, BITS_B),
    // C2: stage 14, the pool dried, at the Gujuo spot (LEG_C2=1).
    quest_legends_c2: legends({ x: 2815, z: 2933 }, [...TOOLS, 716, 722, [736, 3], 727, 1523, 1275, 2434, [563, 3], [556, 5], ...SHARKS(4)], 14, BITS_B),
    // D: stage 20, beside the boulder in the south cave.
    quest_legends_d: legends({ x: 2388, z: 4690 }, [...TOOLS, 746, 722, [736, 3], 1523, 1275, 2434, 2434, 2436, 2440, [563, 3], [556, 5], ...SHARKS(8)], 20, BITS_C),
    // E: stage 45, beside the replaced totem.
    quest_legends_e: legends({ x: 2792, z: 2909 }, [750, 715, 975, 1359, [563, 1], [556, 5], ...SHARKS(2)], 45, BITS_C),
};
