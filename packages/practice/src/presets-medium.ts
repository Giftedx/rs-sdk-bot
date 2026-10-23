import type { SaveConfig } from './presets';
import { QP_BEFORE_DRAGON } from './presets-dragon';

// Medium quests inside the planner's `quests-rest` row (scripts/generated/quest-<name>.ts,
// research/quest-points-board.md). Same base as presets-short.ts: every skill at 99; rune helm, body, legs and
// scimitar worn; the quests before the dragon row plus Dragon Slayer (176 = 10) and Merlin's Crystal (14 = 7) done.
// Each preset starts beside the quest's first NPC with the helper-supplied items and food (379 lobster).
const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
const ALL_99: Record<string, number> = Object.fromEntries(SKILLS.map(k => [k, 99]));
const RUNE_SET = [[1163, 0], [1333, 3], [1127, 4], [1079, 7]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
const DONE = { ...QP_BEFORE_DRAGON, 176: 10, 14: 7 };

function medium(position: { x: number; z: number; level?: number }, items: Array<number | [number, number]>, food = 4, coins = 0, varps: Record<number, number> = {}): SaveConfig {
    return {
        position: { level: 0, ...position }, skills: ALL_99, equipment: RUNE_SET, varps: { ...DONE, ...varps },
        inventory: [...items, ...Array.from({ length: food }, () => 379)].map(e => Array.isArray(e) ? { id: e[0], count: e[1] } : { id: e, count: 1 }),
        ...(coins ? { coins } : {}),
    };
}

export const MEDIUM_PRESETS: Record<string, SaveConfig> = {
    // Pirate's Treasure: on the Port Sarim jetty beside Redbeard Frank (spawn 3053,3250, maps/m47_50.jm2); 10 bananas
    // (1963) for Luthas's crate, white apron (1005) for Wydin, spade (952), 200 coins (two boat fares, the rum), runes
    // for a Varrock and a Falador teleport (2 law 563, 6 air 556, 1 fire 554, 1 water 555). The rum, the key and the
    // message are untradeable (quest_hunt.obj), so the bot buys and smuggles the rum itself.
    quest_hunt: medium({ x: 3052, z: 3251 }, [...Array(10).fill(1963), 1005, 952, [563, 2], [556, 6], [554, 1], [555, 1]], 4, 200),
    // The Knight's Sword: in Falador castle courtyard beside the squire (spawn 2977,3342, maps/m46_52.jm2); redberry pie
    // (2325) for Thurgo, 2 iron bars (2351), rune pickaxe (1275) for the blurite, runes for a Varrock and two Falador
    // teleports (3 law 563, 9 air 556, 1 fire 554, 2 water 555). Portrait, blurite ore and sword are untradeable
    // (quest_squire.obj).
    // Plague City: in Edmond's house, East Ardougne (edmond spawn 2568,3334, maps/m40_52.jm2); dwellberries (2126) for
    // Alrena, 4 buckets of water (1929), spade (952), rope (954), chocolate dust (1975), bucket of milk (1927) and snape
    // grass (231) for the hangover cure. Gas mask, picture, book, key, warrant, chocolaty milk and the cure are
    // untradeable (quest_elena configs, knowledge/items.json).
    quest_elena: medium({ x: 2569, z: 3333 }, [2126, 1929, 1929, 1929, 1929, 952, 954, 1975, 1927, 231], 2),
    quest_squire: medium({ x: 2978, z: 3342 }, [2325, 2351, 2351, 1275, [563, 3], [556, 9], [554, 1], [555, 2]], 6),
};
