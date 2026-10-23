import type { SaveConfig } from './presets';

// The planner's state at the dragon, merlin and grail rows: they run after the last 99 (haggis-cli --order rows
// 46-49), so every skill is 99. Rune helm, body, legs and scimitar worn (the dragon row's "rune armour set" supply).
const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
const ALL_99: Record<string, number> = Object.fromEntries(SKILLS.map(k => [k, 99]));
const RUNE_SET = [[1163, 0], [1333, 3], [1127, 4], [1079, 7]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));

// Quests the planner completes before the dragon row, at their complete values. The QP varp 101 is recounted at
// login from these (count_questpoints, general/scripts/quests.rs2), so the varps, not varp 101, give the 32 QP of the
// Champions' Guild door (champions_guild.rs2:1-3). Cook's Assistant 29, Romeo & Juliet 144, Druidic Ritual 80, Goblin
// Diplomacy 62, Sheep Herder 60, Witch's House 226, Ernest 32, Black Knights' Fortress 130, Prince Ali 273, Tree Gnome
// Village 111, The Grand Tree 150, Family Crest 148, Waterfall 65, Sea Slug 159, Dig Site 131, Dwarf Cannon 0: 46 QP.
// (Monkey Madness, varp 365, is past the save generator's varp range 0-308.)
export const QP_BEFORE_DRAGON: Record<number, number> = { 29: 2, 144: 100, 80: 4, 62: 6, 60: 3, 226: 7, 32: 3, 130: 4, 273: 110, 111: 9, 150: 160, 148: 11, 65: 10, 159: 12, 131: 9, 0: 11 };

// Dragon Slayer (scripts/generated/quest-dragon.ts). Helper items: 12,000 coins (Wormbrain 10,000, the ship 2,000),
// 3 planks (960), 12 steel nails (1539), a hammer (2347); the magic door's wizard's mind bomb (1907), unfired bowl
// (1791), lobster pot (301) and silk (950); runes for the Falador and Lumbridge teleports (4 law 563, 12 air 556,
// 2 earth 557, 2 water 555); 6 lobsters (379).
// Debug presets: quest_dragon_s<milestone> start at that milestone (DS_FROM=<milestone>) with its varps and items.
function dragon(varps: Record<number, number>, position: { x: number; z: number; level: number }, quest: number[] = [], coins = 12000): SaveConfig {
    return {
        position, skills: ALL_99, equipment: RUNE_SET, varps: { ...QP_BEFORE_DRAGON, ...varps }, coins,
        inventory: [[563, 4], [556, 12], [557, 2], [555, 2], [1539, 12]].map(([id, count]) => ({ id: id!, count: count! }))
            .concat([960, 960, 960, 2347, 1907, 1791, 301, 950, ...quest, 379, 379, 379, 379, 379, 379].map(id => ({ id, count: 1 }))),
    };
}
const MAPS = { 176: 2, 184: 3, 186: 1, 187: 1 };          // %dragonquest 2, oracle door passed, shield and goblin known

export const DRAGON_PRESETS: Record<string, SaveConfig> = {
    // Beside the Guild master (198 at 3191,3362, maps/m49_52.jm2 0 55 34), inside the Champions' Guild.
    quest_dragon: dragon({}, { x: 3190, z: 3358, level: 0 }),
    quest_dragon_s4: dragon(MAPS, { x: 3055, z: 9841, level: 0 }, [1542, 1537]),
    quest_dragon_s8: dragon(MAPS, { x: 2933, z: 9640, level: 0 }, [1537]),
    quest_dragon_s9: dragon(MAPS, { x: 2935, z: 9656, level: 0 }, [1537, 1535]),
    quest_dragon_s12: dragon({ ...MAPS, 176: 7, 177: 3 }, { x: 3047, z: 3204, level: 0 }, [1537, 1535], 10000),
    quest_dragon_s15: dragon({ ...MAPS, 176: 9 }, { x: 2851, z: 3235, level: 0 }, [1540]),
    ...merlinPresets(),
    ...grailPresets(),
};

// Merlin's Crystal (scripts/generated/quest-merlin.ts): Dragon Slayer done (varp 176 = 10, +2 QP). Helper items:
// bucket of wax (30), bat bones (530), bread (2309), tinderbox (590); runes for the Falador (x2), Varrock and Camelot
// teleports (4 law 563, 14 air 556, 2 water 555, 1 fire 554); 6 lobsters (379); 500 coins.
// Debug presets quest_merlin_s<milestone> (MC_FROM=<milestone>): varp 14 = %arthur, 15 = component bits.
function merlin(varps: Record<number, number>, position: { x: number; z: number; level: number }, quest: number[] = []): SaveConfig {
    return {
        position, skills: ALL_99, equipment: RUNE_SET, varps: { ...QP_BEFORE_DRAGON, 176: 10, ...varps }, coins: 500,
        inventory: [[563, 4], [556, 14], [555, 2], [554, 1]].map(([id, count]) => ({ id: id!, count: count! }))
            .concat([30, 530, 2309, 590, ...quest, 379, 379, 379, 379, 379, 379].map(id => ({ id, count: 1 }))),
    };
}
function merlinPresets(): Record<string, SaveConfig> {
    return {
        quest_merlin: merlin({}, { x: 2763, z: 3513, level: 0 }),
        quest_merlin_s3: merlin({ 14: 3 }, { x: 2800, z: 3441, level: 0 }),
        quest_merlin_s4: merlin({ 14: 4 }, { x: 2769, z: 3401, level: 2 }),
        quest_merlin_s5: merlin({ 14: 4 }, { x: 2802, z: 3441, level: 0 }, [32]),
        quest_merlin_s7: merlin({ 14: 4, 15: 0b10101 }, { x: 3239, z: 3605, level: 0 }, [32, 35]),
        quest_merlin_s8: merlin({ 14: 5 }, { x: 2780, z: 3512, level: 0 }, [35]),
    };
}

// Holy Grail (scripts/generated/quest-grail.ts): Merlin's Crystal done (varp 14 = 7, +6 QP), Excalibur (35) in the
// pack with the rune scimitar (1333) of the merlin row's rune set. Nothing worn: Entrana takes no weapons or armour
// (monk_of_entrana.rs2 has_entrana_restricted_items), so the rune helm, body and legs go to the bank before this row. Helper items: 100 coins (two Ardougne-Brimhaven trips,
// 30 each), runes for three Falador and four Camelot teleports (8 law, 32 air, 4 water), 6 lobsters.
// Debug presets quest_grail_s<milestone> (HG_FROM=<milestone>): varp 5 = %grail; napkin 15, whistle 16, grail 19;
// from s3 on, the scimitar is worn.
function grail(varps: Record<number, number>, position: { x: number; z: number; level: number }, quest: number[] = [], worn = false): SaveConfig {
    return {
        position, skills: ALL_99, equipment: worn ? [{ id: 1333, count: 1, slot: 3 }] : [],
        varps: { ...QP_BEFORE_DRAGON, 176: 10, 14: 7, ...varps }, coins: 100,
        inventory: [[563, 8], [556, 32], [555, 4]].map(([id, count]) => ({ id: id!, count: count! }))
            .concat([...(worn ? [35] : [35, 1333]), ...quest, 379, 379, 379, 379, 379, 379].map(id => ({ id, count: 1 }))),
    };
}
function grailPresets(): Record<string, SaveConfig> {
    const CAMELOT = { x: 2757, z: 3477, level: 0 };
    const KARAMJA = { x: 2741, z: 3235, level: 0 };
    return {
        quest_grail: grail({}, { x: 2763, z: 3513, level: 0 }),
        quest_grail_s2: grail({ 5: 3 }, { x: 3046, z: 3237, level: 0 }),
        quest_grail_s3: grail({ 5: 4 }, CAMELOT, [], true),
        quest_grail_s4: grail({ 5: 4 }, { x: 3108, z: 3350, level: 0 }, [15], true),
        quest_grail_s5: grail({ 5: 4 }, CAMELOT, [15, 16, 16], true),
        quest_grail_s6: grail({ 5: 4 }, { x: 2806, z: 4715, level: 0 }, [15, 16, 16], true),
        quest_grail_s7: grail({ 5: 8 }, KARAMJA, [15, 16, 16], true),
        quest_grail_s8: grail({ 5: 9 }, KARAMJA, [15, 16], true),
        quest_grail_s9: grail({ 5: 9 }, KARAMJA, [15, 16, 19], true),
    };
}
