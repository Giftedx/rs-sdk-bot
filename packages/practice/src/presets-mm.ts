import type { SaveConfig } from './presets';

// Monkey Madness (scripts/generated/quest-mm.ts) at the planner's state for the rival-mm row (scenario a, order
// row 24, after Fight Arena; research/quest-plan.md section 1h): Attack 99 (Tree Gnome Village 286,250 + The Grand
// Tree 460,000 + Fight Arena 304,375), Magic 99 and Smithing 99 (superheat), Prayer 43, Agility 57 (Grand Tree
// 197,500 + the course to 25), Thieving 43 (Fight Arena 54,375), Hitpoints 35 (an estimate: the planner does not
// model Hitpoints), Strength, Defence, Ranged 1, the skills trained before it at 99.
// Quest varps: %treequest (111) = 9 and %grandtree (150) = 160 (^grandtree_complete, quest.constant:28), set directly:
// the Grand Tree is scripted by another helper.
// Worn (Defence 1): wizard hat 579, amulet of magic 1727, staff of fire 1387, wizard robe 577, blue skirt 1011.
// Inventory (helper items): Fire Wave runes (1 blood 565 + 5 air 556, fire from the staff) for 200 casts (one test
// run used 60 without the kill; Ape Atoll pests take some); 2 law runes 563 (Varrock Teleport); gold bar 2357, ball
// of wool 1759, monkey bones 3183 (a Karamja monkey's, quest_tbwt/scripts/monkey.rs2:73); 7 prayer potions 2434;
// 1 antipoison 2446 (Karamja jungle spiders, Ape Atoll wildlife); 12 sharks 385 (26 slots: the seal and the orders fill the pack in chapter 1). No bananas: the child's garden has
// banana trees (2741-2746,2792-2797) and the script picks 5 there (banana_tree.rs2). The full run at HP 35 with
// 4 potions and 10 sharks died in the dungeon (practice, 2026-10-23).
const MM_SKILLS = {
    Attack: 99, Hitpoints: 35, Magic: 99, Prayer: 43, Agility: 57, Thieving: 43, Smithing: 99, Cooking: 35,
    Fletching: 99, Crafting: 99, Herblore: 99, Firemaking: 99, Runecraft: 99,
};
const MM_WORN = [[579, 0], [1727, 2], [1387, 3], [577, 4], [1011, 7]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
const MM_PACK = [[565, 200], [556, 1000], [563, 2]].map(([id, count]) => ({ id: id!, count: count! }))
    .concat([2357, 1759, 3183, 2434, 2434, 2434, 2434, 2434, 2434, 2434, 2446].map(id => ({ id, count: 1 })),
        Array.from({ length: 12 }, () => ({ id: 385, count: 1 })));

// mm_gnomes (varp 372) bit fields, quest_mm.varbit: narnode 0-3, caranock 4-6, daero 7-10, waydar 11-12,
// lumdo 13-15, garkor 16-19, zooknock 20-23.
export function mmGnomes(f: { narnode?: number; caranock?: number; daero?: number; waydar?: number; lumdo?: number; garkor?: number; zooknock?: number }): number {
    return (f.narnode ?? 0) | ((f.caranock ?? 0) << 4) | ((f.daero ?? 0) << 7) | ((f.waydar ?? 0) << 11)
        | ((f.lumdo ?? 0) << 13) | ((f.garkor ?? 0) << 16) | ((f.zooknock ?? 0) << 20);
}

function mmPreset(position: { x: number; z: number; level: number }, varps: Record<number, number> = {}, extra: number[] = [], pack = MM_PACK): SaveConfig {
    return {
        position,
        skills: MM_SKILLS,
        equipment: MM_WORN,
        varps: { 111: 9, 150: 160, ...varps },
        inventory: pack.concat(extra.map(id => ({ id, count: 1 }))),
    };
}
// After chapter 3 the helper items are spent: runes, law runes, prayer potions, sharks stay.
const MM_PACK_LATE = [[565, 150], [556, 760], [563, 2]].map(([id, count]) => ({ id: id!, count: count! }))
    .concat([2434, 2434, 2434, 2434].map(id => ({ id, count: 1 })), Array.from({ length: 8 }, () => ({ id: 385, count: 1 })));

export const MM_PRESETS: Record<string, SaveConfig> = {
    quest_mm: mmPreset({ x: 2466, z: 3494, level: 0 }),
    // Debug: beside Daero in the Grand Tree bar (l1) with Narnode's orders (%mm_narnode 7): MM_FROM=30.
    quest_mm_s30: mmPreset({ x: 2482, z: 3486, level: 1 }, { 365: 1, 372: mmGnomes({ narnode: 7, caranock: 3 }) }, [4004, 4005]),
    // Debug: in the hangar after Daero's introduction (%mm_main 1, %mm_narnode 7, %mm_caranock 3, %mm_daero 5):
    // MM_FROM=40 (the puzzle).
    // Debug: with the sigil, before the battle (the sigil works anywhere outside the Wilderness, mm_demon.rs2:7-14;
    // the preset stands in the Grand Tree because a human on the atoll is poisoned by the wildlife): %mm_main 5
    // (completed_ch3), %mm_garkor 6 (joined_10th_squad), %mm_zooknock 6, %mm_awowogei 2 (mm_monkeys bits 2-4).
    // MM_FROM=130 (the demon, the way back, the reward).
    quest_mm_s130: mmPreset({ x: 2466, z: 3494, level: 0 }, { 365: 5, 372: mmGnomes({ narnode: 7, caranock: 3, daero: 7, waydar: 1, lumdo: 3, garkor: 6, zooknock: 6 }), 373: 2 << 2 }, [4035], MM_PACK_LATE),
    // Debug: the Ape Atoll landing after the chapter 2 cutscene (%mm_main 3 arrived_atoll, %mm_lumdo 3 travelled): MM_FROM=70.
    quest_mm_s70: mmPreset({ x: 2801, z: 2707, level: 0 }, { 365: 3, 372: mmGnomes({ narnode: 7, caranock: 3, daero: 7, waydar: 1, lumdo: 3 }) }, [4004]),
    // Debug: out of the jail, beside Garkor (2805,2762): MM_FROM=80.
    quest_mm_s80: mmPreset({ x: 2806, z: 2764, level: 0 }, { 365: 3, 372: mmGnomes({ narnode: 7, caranock: 3, daero: 7, waydar: 1, lumdo: 3 }), 374: 1 << 2 }, [4004]),
    // Debug: out of the eastern warehouse door (2764,2763) with the dentures and the mould (%mm_garkor 2 speak_zooknock):
    // MM_FROM=90.
    quest_mm_s90: mmPreset({ x: 2764, z: 2763, level: 0 }, { 365: 3, 372: mmGnomes({ narnode: 7, caranock: 3, daero: 7, waydar: 1, lumdo: 3, garkor: 2 }), 374: 1 << 2 }, [4004, 4006, 4020]),
    // Debug: beside Zooknock after the amulet half (%mm_zooknock 5; mm_flags: gold bar 7, mould 8, dentures 9, relic 11,
    // collecting for the talisman 13; mm_misc relic type 5 = normal monkey, jail count 1) with the enchanted bar and the
    // mould: MM_FROM=100.
    quest_mm_s100: mmPreset({ x: 2803, z: 9145, level: 0 },
        { 365: 3, 371: (1 << 7) | (1 << 8) | (1 << 9) | (1 << 11) | (1 << 13), 372: mmGnomes({ narnode: 7, caranock: 3, daero: 7, waydar: 1, lumdo: 3, garkor: 2, zooknock: 5 }), 374: (1 << 2) | (5 << 12) },
        [4004, 4007, 4020], MM_PACK.filter(i => i.id !== 2357 && i.id !== 3183)),
    // Debug: in the temple fire room (2807,9201) with the strung amulet of monkey speak: MM_FROM=105.
    quest_mm_s105: mmPreset({ x: 2808, z: 9197, level: 0 },
        { 365: 3, 371: (1 << 7) | (1 << 8) | (1 << 9) | (1 << 11) | (1 << 13), 372: mmGnomes({ narnode: 7, caranock: 3, daero: 7, waydar: 1, lumdo: 3, garkor: 2, zooknock: 5 }), 374: (2 << 2) | (5 << 12) },
        [4020, 4021], MM_PACK.filter(i => i.id !== 2357 && i.id !== 3183 && i.id !== 1759)),
    // Debug: beside Zooknock after the chapter 3 cutscene (%mm_main 4 completed_ch2, %mm_zooknock 6, %mm_garkor 2,
    // %mm_monkey_child 7) with the Karamjan greegree; the amulet of monkey speak worn, the amulet of magic in the pack:
    // MM_FROM=110.
    quest_mm_s110: {
        ...mmPreset({ x: 2803, z: 9145, level: 0 },
            { 365: 4, 372: mmGnomes({ narnode: 7, caranock: 3, daero: 7, waydar: 1, lumdo: 3, garkor: 2, zooknock: 6 }), 373: 7 << 5, 374: 2 << 2 },
            [4031, 1727], MM_PACK_LATE.concat([{ id: 2446, count: 1 }])),
        equipment: MM_WORN.map(e => e.slot === 2 ? { ...e, id: 4021 } : e),
    },
    // Debug: outside the monkey child's garden (2746,2800) with the amulet of monkey speak worn and 5 bananas:
    // MM_FROM=107.
    quest_mm_s107: {
        ...mmPreset({ x: 2746, z: 2800, level: 0 },
            { 365: 3, 371: (1 << 7) | (1 << 8) | (1 << 9) | (1 << 11) | (1 << 13), 372: mmGnomes({ narnode: 7, caranock: 3, daero: 7, waydar: 1, lumdo: 3, garkor: 2, zooknock: 5 }), 374: (2 << 2) | (5 << 12) },
            [4020, 1727, 2446], MM_PACK_LATE),
        equipment: MM_WORN.map(e => e.slot === 2 ? { ...e, id: 4021 } : e),
    },
    // Debug: in Awowogei's hall after his mission, as a monkey (%mm_garkor 4 seek_alliance; mm_monkeys: kruk 1,
    // awowogei 1, child 7, elder guard 1); the greegree in the weapon slot, the staff in the pack: MM_FROM=115.
    quest_mm_s115: {
        ...mmPreset({ x: 2802, z: 2762, level: 0 },
            { 365: 4, 372: mmGnomes({ narnode: 7, caranock: 3, daero: 7, waydar: 1, lumdo: 3, garkor: 4, zooknock: 6 }), 373: 1 | (1 << 2) | (7 << 5) | (1 << 9), 374: 2 << 2 },
            [1387, 1727], MM_PACK_LATE.concat([{ id: 2446, count: 1 }])),
        equipment: MM_WORN.map(e => e.slot === 2 ? { ...e, id: 4021 } : e.slot === 3 ? { ...e, id: 4031 } : e),
    },
    quest_mm_s40: mmPreset({ x: 2393, z: 9890, level: 0 }, { 365: 1, 372: mmGnomes({ narnode: 7, caranock: 3, daero: 5 }) }, [4004]),
};

// The save generator writes 309 varps (vendor/rs-sdk/sdk/test/utils/save-generator.ts:314) and drops higher ids, but
// the Monkey Madness varps are 365-374 (content/pack/varp.pack:366-375). PlayerLoading.ts:101-111 reads any count
// (save version below 7: one 4-byte value per id from 0). This rewrites the varp block of a generated save with
// count = highest id + 1 and the CRC32 trailer again.
export function extendVarps(savePath: string, varps: Record<number, number>): void {
    const { readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const buf = readFileSync(savePath);
    const body = buf.subarray(0, buf.length - 4);
    const crcOld = buf.readUInt32BE(buf.length - 4);
    if ((Bun.hash.crc32(body) >>> 0) !== crcOld) throw new Error(`extendVarps: CRC of ${savePath} is not CRC32`);
    let at = -1;
    for (let i = 0; i + 2 + 309 * 4 <= body.length; i++) {
        if (body.readUInt16BE(i) === 309 && body.readInt32BE(i + 2 + 281 * 4) === 1000) { at = i; break; }
    }
    if (at < 0) throw new Error(`extendVarps: no varp block in ${savePath}`);
    const old: number[] = [];
    for (let k = 0; k < 309; k++) old.push(body.readInt32BE(at + 2 + k * 4));
    const count = Math.max(309, ...Object.keys(varps).map(k => Number(k) + 1));
    const block = Buffer.alloc(2 + count * 4);
    block.writeUInt16BE(count, 0);
    for (let k = 0; k < count; k++) block.writeInt32BE(varps[k] ?? old[k] ?? 0, 2 + k * 4);
    const out = Buffer.concat([body.subarray(0, at), block, body.subarray(at + 2 + 309 * 4)]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Bun.hash.crc32(out) >>> 0, 0);
    writeFileSync(savePath, Buffer.concat([out, crc]));
}
