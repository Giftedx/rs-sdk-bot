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
};
