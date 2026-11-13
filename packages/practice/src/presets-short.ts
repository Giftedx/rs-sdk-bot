import type { SaveConfig } from './presets';
import { QP_BEFORE_DRAGON } from './presets-dragon';

// Short quests inside the planner's `quests-rest` row (scripts/generated/quest-<name>.ts, research/quest-points-board.md).
// The row runs after Overall, so Haggis has every skill at 99; rune helm, body, legs and scimitar worn; the quests
// before the dragon row plus Dragon Slayer (176 = 10) and Merlin's Crystal (14 = 7) done. Each preset starts beside
// the quest's first NPC with the helper-supplied items and food (379 lobster).
const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
const ALL_99: Record<string, number> = Object.fromEntries(SKILLS.map(k => [k, 99]));
const RUNE_SET = [[1163, 0], [1333, 3], [1127, 4], [1079, 7]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
const DONE = { ...QP_BEFORE_DRAGON, 176: 10, 14: 7 };

function short(position: { x: number; z: number; level?: number }, items: Array<number | [number, number]>, food = 4, coins = 0, varps: Record<number, number> = {}): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: RUNE_SET, varps: { ...DONE, ...varps },
        inventory: [...items, ...Array.from({ length: food }, () => 379)].map(e => Array.isArray(e) ? { id: e[0], count: e[1] } : { id: e, count: 1 }),
        ...(coins ? { coins } : {}),
    };
}

export const SHORT_PRESETS: Record<string, SaveConfig> = {
    // Sheep Shearer: inside Fred's farmhouse (fred_the_farmer spawn 3189,3273, maps/m49_51.jm2); 20 balls of wool (1759).
    quest_sheep: short({ x: 3190, z: 3272 }, Array.from({ length: 20 }, () => 1759)),
    // Doric's Quest: inside Doric's house north of Falador (doric spawn 2952,3451, maps/m46_53.jm2); 6 clay (434),
    // 4 copper ore (436), 2 iron ore (440): the hand-in needs all 12 in the pack (quest_doric.rs2:70).
    // The runes of a Falador Teleport (1 law, 3 air, 1 water) are optional: the quest sweep takes them when the bank
    // holds them, and its far walk casts the teleport (block 3 of the mock Haggis run starts at the Draynor bank).
    quest_doric: short({ x: 2951, z: 3450 }, [...Array(6).fill(434), ...Array(4).fill(436), 440, 440, [563, 1], [556, 3], [555, 1]]),
    // Imp Catcher: top floor of the Wizards' Tower beside Wizard Mizgog (spawn 3103,3163,2, maps/m48_49.jm2); the
    // red, yellow, black and white beads (1470, 1472, 1474, 1476; imp drops, tradeable).
    quest_imp: short({ x: 3104, z: 3163, level: 2 }, [1470, 1472, 1474, 1476]),
    // Witch's Potion: in Hetty's house, Rimmington (hetty spawn 2968,3206, maps/m46_50.jm2); onion (1957), eye of newt
    // (221), burnt meat (2146). The rat's tail is untradeable (quest_hetty.obj) and drops only while %hetty is 1 or 2
    // (drop tables/scripts/rat.rs2:9-12): the bot kills one of the rats next door (2953-2960,3202-3205).
    quest_hetty: short({ x: 2966, z: 3206 }, [1957, 221, 2146]),
    // Rune Mysteries: beside Duke Horacio on level 1 of Lumbridge castle (duke_of_lumbridge spawn 3212,3220,1,
    // maps/m50_50.jm2); runes for a Varrock and a Lumbridge teleport (2 law 563, 6 air 556, 1 fire 554, 1 earth 557).
    quest_runemysteries: short({ x: 3210, z: 3221, level: 1 }, [[563, 2], [556, 6], [554, 1], [557, 1]]),
    // Rune Mysteries resumed mid-quest with every quest item lost, as a parked live account resumes it: at the Varrock
    // East bank, low combat (Hitpoints 17, Magic 29), no runes, so the runner walks. Varp 63 is the quest stage
    // (quest_runemysteries.constant): 1 started, 2 given talisman, 3 received package, 4 given package, 5 received notes.
    // The quest item sits in the bank, as a sweep's unneeded-item deposit left it: stage 5 with the notes banked at the
    // Varrock East bank (TheFullMonty, live), and stage 3 with the package banked.
    quest_runemysteries_banked5: {
        position: { x: 3253, z: 3421, level: 0 }, skills: { Hitpoints: 17, Magic: 29 }, varps: { ...DONE, 63: 5 }, bank: [{ id: 291, count: 1 }],
        inventory: Array.from({ length: 4 }, () => ({ id: 379, count: 1 })),
    } satisfies SaveConfig,
    quest_runemysteries_banked3: {
        position: { x: 3253, z: 3421, level: 0 }, skills: { Hitpoints: 17, Magic: 29 }, varps: { ...DONE, 63: 3 }, bank: [{ id: 290, count: 1 }],
        inventory: Array.from({ length: 4 }, () => ({ id: 379, count: 1 })),
    } satisfies SaveConfig,
    // The same account where quest-sweep stages the quest: the Duke's room on castle level 1, package lost (stage 3).
    quest_runemysteries_lost_duke: {
        position: { x: 3209, z: 3222, level: 1 }, skills: { Hitpoints: 17, Magic: 29 }, varps: { ...DONE, 63: 3 },
        inventory: Array.from({ length: 4 }, () => ({ id: 379, count: 1 })),
    } satisfies SaveConfig,
    ...Object.fromEntries([1, 2, 3, 4, 5].map(stage => [`quest_runemysteries_lost${stage}`, {
        position: { x: 3252, z: 3420, level: 0 }, skills: { Hitpoints: 17, Magic: 29 }, varps: { ...DONE, 63: stage },
        inventory: Array.from({ length: 4 }, () => ({ id: 379, count: 1 })),
    } satisfies SaveConfig])),
    // The Restless Ghost: in Lumbridge church beside Father Aereck (spawn 3244,3206, maps/m50_50.jm2); runes for a
    // Lumbridge teleport (1 law 563, 3 air 556, 1 earth 557) for the way back from the Wizards' Tower basement. The amulet
    // of ghostspeak and the skull are untradeable (quest_priest.obj), so Urhney and the skull are part of the run.
    quest_priest: short({ x: 3243, z: 3206 }, [[563, 1], [556, 3], [557, 1]]),
    // Vampire Slayer: in Morgan's house, Draynor (morgan spawn 3098,3268, maps/m48_51.jm2); beer (1917) for Dr Harlow,
    // hammer (2347), garlic (1550), runes for two Varrock teleports (2 law 563, 6 air 556, 2 fire 554). The stake is
    // untradeable (stake.obj), so the Varrock leg to Harlow stays.
    quest_vampire: short({ x: 3097, z: 3268 }, [1917, 2347, 1550, [563, 2], [556, 6], [554, 2]], 6),
    // Gertrude's Cat: in Gertrude's house west of Varrock (gertrude spawn 3151,3410, maps/m49_53.jm2); bucket of milk
    // (1927), seasoned sardine (1552; tradeable, quest_fluffs.obj), 100 coins for Shilop, Varrock teleport runes (1 law
    // 563, 3 air 556, 1 fire 554). The kitten (1554) is untradeable and its crate is random(6) (quest_fluffs.rs2:221-228).
    quest_fluffs: short({ x: 3150, z: 3410 }, [1927, 1552, [563, 1], [556, 3], [554, 1]], 4, 100),
    // Monk's Friend: in the Ardougne monastery beside Brother Omad (spawn 2604,3209, maps/m40_50.jm2); jug of water (1937)
    // and logs (1511) for Brother Cedric. The child's blanket is untradeable (quest_drunkmonk.obj:12).
    quest_drunkmonk: short({ x: 2605, z: 3209 }, [1937, 1511], 6),
    // Fishing Contest: beside the west tunnel dwarf on White Wolf Mountain (tunnel_dwarf spawn 2820,3487, maps/m44_54.jm2);
    // spade (952) for a red vine worm (untradeable, quest_fishingcompo.obj:16), fishing rod (307), 2 fishing bait (313),
    // garlic (1550) for the pipe, 5 coins for Bonzo, Camelot teleport runes (1 law 563, 5 air 556) for the way back.
    quest_fishingcompo: short({ x: 2822, z: 3489 }, [952, 307, [313, 2], 1550, [563, 1], [556, 5]], 4, 5),
};
