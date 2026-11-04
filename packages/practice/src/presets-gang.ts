import type { SaveConfig } from './presets';
import { QP_BEFORE_DRAGON } from './presets-dragon';

// Shield of Arrav as a pair (scripts/generated/quest-arrav.ts, research/quest-points-board.md). The main joins the
// Black Arm Gang; the helper joins the Phoenix Gang and brings the 2 Phoenix crossbows and the Phoenix half of the
// shield. Both at the quests-rest state (every skill 99, rune helm, body, legs and scimitar worn, the quests before
// the dragon row plus Dragon Slayer 176 = 10 and Merlin's Crystal 14 = 7 done), 4 lobsters (379).
// Varps: 145 %blackarmgang (0-4), 146 %phoenixgang (0-10) (pack/varp.pack; quest_blackarmgang.constant).
const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
const ALL_99: Record<string, number> = Object.fromEntries(SKILLS.map(k => [k, 99]));
const RUNE_SET = [[1163, 0], [1333, 3], [1127, 4], [1079, 7]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
const DONE = { ...QP_BEFORE_DRAGON, 176: 10, 14: 7 };

function gang(position: { x: number; z: number; level?: number }, items: Array<number | [number, number]>, coins = 0, varps: Record<number, number> = {}): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: RUNE_SET, varps: { ...DONE, ...varps },
        inventory: [...items, 379, 379, 379, 379].map(e => Array.isArray(e) ? { id: e[0], count: e[1] } : { id: e, count: 1 }),
        ...(coins ? { coins } : {}),
    };
}

// Hero's Quest as a pair (scripts/generated/quest-hero.ts): both outside the Heroes' Guild door (Achietties 2903,3510,
// maps/m45_54.jm2). Done on top of DONE: Fight Arena 17 = 14, Lost City 147 = 6, Plague City 165 = 30 with the scroll read
// (Ardougne teleport, teleport.rs2:22-35), Shield of Arrav in one gang. Nothing worn: Entrana bans weapons and armour
// (monk_of_entrana.rs2:26-53). Kit (tradeable, the rs-stun-toolkit kit): runes for the teleports and the Fire Blasts
// (law 563, water 555, death 560, fire 554, air 556), a glory (1712), fishing rod (307), bait (313), a harralander potion
// (97), tinderbox (590), 2 logs (1511), 2 prayer potions (2434), a bronze pickaxe (1265), 100 coins, 6 lobsters.
const HERO_KIT: Array<number | [number, number]> = [[563, 10], [555, 6], [560, 150], [554, 700], [556, 650], 1712, 307, [313, 10], 97, 590, 1511, 1511, 2434, 2434, 1265, 379, 379, 379, 379, 379, 379];
function hero(gangVarp: Record<number, number>, extra: number[] = []): SaveConfig {
    return {
        position: { x: 2904, z: 3510, level: 0 }, skills: ALL_99, equipment: [], varps: { ...DONE, 17: 14, 147: 6, 165: 30, ...gangVarp }, coins: 100,
        inventory: [...HERO_KIT, ...extra].map(e => Array.isArray(e) ? { id: e[0], count: e[1] } : { id: e, count: 1 }),
    };
}

export const GANG_PRESETS: Record<string, SaveConfig> = {
    // Main (Black Arm): beside the tramp (tramppg spawn 3208,3391, maps/m50_52.jm2) south of the Blue Moon Inn; runes
    // for one Varrock teleport (1 law 563, 3 air 556, 1 fire 554) from the Black Arm HQ to the museum.
    quest_arrav: gang({ x: 3209, z: 3390 }, [[563, 1], [556, 3], [554, 1]]),
    // Helper (Phoenix): beside Reldo in the palace library (reldo spawn 3209,3495, maps/m50_54.jm2); 20 coins for
    // Baraek (baraek.rs2:106-114).
    quest_arrav_helper: gang({ x: 3210, z: 3494 }, [], 20),
    // Debug: the helper after its Phoenix part (%phoenixgang 9, weapon store key 759, 2 crossbows 767, the Phoenix
    // half 763), beside the tramp. ARRAV_HELPER_READY=1 skips the helper's part.
    quest_arrav_helper_ready: gang({ x: 3208, z: 3390 }, [759, 767, 767, 763], 0, { 146: 9 }),
    // Black Arm side, with a black full helm, platebody and platelegs for Garv (quest_hero.rs2:21-25).
    quest_hero: hero({ 145: 4 }, [1165, 1125, 1077]),
    // Phoenix side.
    quest_hero_helper: hero({ 146: 10 }),
};
