import type { SaveConfig } from '../preset-types';
import { LUMBRIDGE } from './skilling';

const COMBAT70 = { Attack: 70, Strength: 70, Defence: 70, Hitpoints: 70 };

export const FLOOR_PRESETS: Record<string, SaveConfig> = {
    // ---- Supply-board floors (scripts/measure/floor-*.ts, research/supply-floors.md). Counts come from
    // scripts/measure/floor-bands.ts (exact actions to 99 at 25x), plus 1 spare per stack so no bank slot empties.
    // Herblore 3 -> 99 at Draynor bank (3092,3243): every unfinished potion and secondary of the HERBLORE bands in
    // the bank. Herblore 3 because nothing in a pack gives XP at 1-2 (identify guam needs 3).
    floor_herblore: {
        position: { x: 3092, z: 3243, level: 0 },
        skills: { Herblore: 3 },
        bank: [{ id: 91, count: 2 }, { id: 221, count: 4 }, { id: 93, count: 2 }, { id: 235, count: 4 }, { id: 95, count: 3 }, { id: 225, count: 9 }, { id: 97, count: 3 }, { id: 223, count: 7 }, { id: 1975, count: 2 }, { id: 99, count: 7 }, { id: 239, count: 9 }, { id: 3002, count: 3 }, { id: 2152, count: 3 }, { id: 231, count: 7 }, { id: 101, count: 5 }, { id: 103, count: 6 }, { id: 2970, count: 4 }, { id: 105, count: 12 }, { id: 241, count: 14 }, { id: 3004, count: 6 }, { id: 107, count: 7 }, { id: 2483, count: 16 }, { id: 109, count: 13 }, { id: 245, count: 13 }, { id: 3138, count: 8 }, { id: 111, count: 176 }, { id: 247, count: 176 }],
    },
    // Crafting 1 -> 99 at Draynor bank: chisel (1755) in the pack, the CRAFTING gem bands in the bank (opal, jade and
    // red topaz +2 each for smashes).
    floor_crafting: {
        position: { x: 3092, z: 3243, level: 0 },
        inventory: [{ id: 1755, count: 1 }],
        bank: [{ id: 1625, count: 11 }, { id: 1627, count: 6 }, { id: 1629, count: 6 }, { id: 1623, count: 4 }, { id: 1621, count: 3 }, { id: 1619, count: 6 }, { id: 1617, count: 11 }, { id: 1631, count: 278 }],
    },
    // Smithing 1 -> 99 at Varrock west bank (3185,3436, learnings/banking.md), anvils at (3188,3421-3426): hammer
    // (2347) in the pack, the SMITHING bar bands in the bank.
    floor_smithing: {
        position: { x: 3185, z: 3436, level: 0 },
        inventory: [{ id: 2347, count: 1 }],
        bank: [{ id: 2349, count: 20 }, { id: 2351, count: 37 }, { id: 2353, count: 96 }, { id: 2359, count: 281 }, { id: 2361, count: 341 }],
    },
    // Fletching 1 -> 99 with stacks only (Lumbridge castle): the FLETCHING band tips, headless arrows (53) and feathers
    // (314), 2 spare actions per band.
    floor_fletching: {
        position: { x: 3222, z: 3218, level: 0 },
        inventory: [{ id: 39, count: 90 }, { id: 53, count: 1440 }, { id: 40, count: 60 }, { id: 820, count: 60 }, { id: 314, count: 1590 }, { id: 41, count: 165 }, { id: 42, count: 255 }, { id: 43, count: 525 }, { id: 44, count: 345 }, { id: 824, count: 1530 }],
    },
    // Prayer 1 -> 99 at Draynor bank: 560 dragon bones (536) in the bank (555 needed).
    floor_prayer: { position: { x: 3092, z: 3243, level: 0 }, bank: [{ id: 536, count: 560 }] },
    // Substitution ladders (scripts/measure/floor-bands.ts, LADDER=...): planner rows craft-diamond, fletch-arrows, herb-drops.
    // Crafting 1 -> 99 with diamonds from 43 (no dragonstones): ladder counts + 1 spare, opal/jade/red topaz + 2 more.
    floor_crafting_diamond: {
        position: { x: 3092, z: 3243, level: 0 },
        inventory: [{ id: 1755, count: 1 }],
        bank: [{ id: 1625, count: 11 }, { id: 1627, count: 6 }, { id: 1629, count: 6 }, { id: 1623, count: 4 }, { id: 1621, count: 3 }, { id: 1619, count: 6 }, { id: 1617, count: 366 }],
    },
    // Fletching 1 -> 99 with arrows only (no dart tips): ladder tips + 2 spare actions per band, headless arrows.
    floor_fletching_arrows: {
        position: { x: 3222, z: 3218, level: 0 },
        inventory: [{ id: 39, count: 90 }, { id: 53, count: 3780 }, { id: 40, count: 120 }, { id: 41, count: 165 }, { id: 42, count: 255 }, { id: 43, count: 525 }, { id: 44, count: 2625 }],
    },
    // Herblore 3 -> 99 with the herb-drops mix (HERB_DROPS): unfinished guam, harralander, ranarr, irit, avantoe, kwuarm
    // and their secondaries (eye of newt, red spiders' eggs, snape grass, limpwurt root), + 2 spares each.
    floor_herb_drops: {
        position: { x: 3092, z: 3243, level: 0 },
        skills: { Herblore: 3 },
        bank: [[91, 272], [97, 121], [99, 95], [101, 70], [103, 53], [105, 45], [221, 340], [223, 121], [231, 146], [225, 45]].map(([id, count]) => ({ id: id!, count: count! })),
    },
    // Superheat gold (scripts/measure/floor-superheat.ts): Magic 43, Smithing 40 (gold bar levelrequired,
    // smelting.struct:63), goldsmith gauntlets (776) worn, nature (561) and fire (554) runes in the pack, 720 gold ore
    // (444) in the bank (699 casts from 40 to 99).
    floor_superheat: {
        position: { x: 3092, z: 3243, level: 0 },
        skills: { Magic: 43, Smithing: 40 },
        equipment: [{ id: 776, count: 1, slot: 9 }],
        inventory: [{ id: 561, count: 760 }, { id: 554, count: 3040 }],
        bank: [{ id: 444, count: 720 }],
    },
    // Magic 7 -> 99 at Draynor bank: rune stacks in the pack (cosmic 564, water 555, air 556, fire 554, earth 557, with
    // spares), the MAGIC enchant bands' jewellery in the bank (sapphire 1637, emerald 1639, ruby 1641, diamond 1643
    // rings, strung dragonstone amulets 1702). Magic 7 because no supply-only spell gives XP at 1-6.
    floor_magic: {
        position: { x: 3092, z: 3243, level: 0 },
        skills: { Magic: 7 },
        inventory: [{ id: 564, count: 600 }, { id: 555, count: 7000 }, { id: 556, count: 120 }, { id: 554, count: 120 }, { id: 557, count: 7400 }],
        bank: [{ id: 1637, count: 13 }, { id: 1639, count: 28 }, { id: 1641, count: 17 }, { id: 1643, count: 38 }, { id: 1702, count: 460 }],
    },
    // Firemaking 1 -> 99 at Draynor bank: tinderbox (590) in the pack, the FIREMAKING log bands in the bank (logs 1511,
    // oak 1521, willow 1519, maple 1517, yew 1515, magic 1513), 1 spare each. Lines start at (3099,3249).
    floor_firemaking: {
        position: { x: 3092, z: 3243, level: 0 },
        inventory: [{ id: 590, count: 1 }],
        bank: [{ id: 1511, count: 3 }, { id: 1521, count: 5 }, { id: 1519, count: 8 }, { id: 1517, count: 14 }, { id: 1515, count: 25 }, { id: 1513, count: 108 }],
    },
    // Cooking 1 -> 99 by the normal method at Draynor bank: tinderbox + 1 log for a fire, raw sardine (327), herring
    // (345), trout (335), salmon (331) with spares for burns; 400 grapes (1987) and 400 jugs of water (1937) banked.
    floor_cooking: {
        position: { x: 3092, z: 3243, level: 0 },
        inventory: [{ id: 590, count: 1 }, { id: 1511, count: 1 }, ...[327, 327, 327, 327, 327, 327, 327, 327, 327, 327, 345, 345, 345, 345, 345, 335, 335, 335, 335, 335, 331, 331, 331, 331, 331].map(id => ({ id, count: 1 }))],
        bank: [{ id: 1987, count: 400 }, { id: 1937, count: 400 }],
    },
    // Wine probe (research/supply-floors.md, Cooking): Cooking 35 at Draynor bank, 40 grapes + 40 jugs of water banked.
    floor_wine35: { position: { x: 3092, z: 3243, level: 0 }, skills: { Cooking: 35 }, bank: [{ id: 1987, count: 40 }, { id: 1937, count: 40 }] },
    // Firemaking burn-rate test at the top band: Firemaking 75, tinderbox, 30 magic logs (1513) banked; one 27-log line.
    floor_fm75: { position: { x: 3092, z: 3243, level: 0 }, skills: { Firemaking: 75 }, inventory: [{ id: 590, count: 1 }], bank: [{ id: 1513, count: 30 }] },
    // Same at Firemaking 45 with 30 maple logs (1517).
    floor_fm45: { position: { x: 3092, z: 3243, level: 0 }, skills: { Firemaking: 45 }, inventory: [{ id: 590, count: 1 }], bank: [{ id: 1517, count: 30 }] },
    // Smithing with a helper (scripts/measure/floor-smith-trade.ts): the smither beside the Varrock west smithy anvil
    // (3188,3426) with a hammer (2347); the helper <bot>b at Varrock west bank with the SMITHING bars banked.
    floor_smith_trade: { position: { x: 3188, z: 3427, level: 0 }, inventory: [{ id: 2347, count: 1 }] },
    floor_smith_helper: { position: { x: 3185, z: 3436, level: 0 }, bank: [{ id: 2349, count: 20 }, { id: 2351, count: 37 }, { id: 2353, count: 96 }, { id: 2359, count: 281 }, { id: 2361, count: 341 }] },
    // Ground-log firemaking (scripts/measure/floor-fm-ground.ts): the firemaker (Firemaking 75, tinderbox)
    // at Draynor bank, the helper <bot>b on the row start (3098,3248; 3099,3249 is not walkable) with 27 magic logs (1513).
    floor_fmg: { position: { x: 3092, z: 3243, level: 0 }, skills: { Firemaking: 75 }, inventory: [{ id: 590, count: 1 }] },
    floor_fmg_helper: { position: { x: 3098, z: 3248, level: 0 }, inventory: Array.from({ length: 27 }, () => ({ id: 1513, count: 1 })) },
    // Magic from 44 (the Imp Catcher reward, 21,875 XP, quests/quest_imp/scripts/quest_imp.rs2:4) at Draynor bank: the
    // floor_magic runes, and the jewellery of the bands from 44 (emerald 4, ruby 16, diamond 37, dragonstone 453, +spares).
    floor_magic44: {
        position: { x: 3092, z: 3243, level: 0 },
        skills: { Magic: 44 },
        inventory: [{ id: 564, count: 600 }, { id: 555, count: 7000 }, { id: 556, count: 120 }, { id: 554, count: 120 }, { id: 557, count: 7400 }],
        bank: [{ id: 1639, count: 28 }, { id: 1641, count: 17 }, { id: 1643, count: 38 }, { id: 1702, count: 460 }],
    },
    // Teleport ladder (scripts/measure/floor-teleport.ts): staff of air (1381) worn; law (563), fire (554), earth (557),
    // water (555) and mind (558) runes in the pack. floor_tele1 starts in the Lumbridge chicken pen for wind strike.
    ...Object.fromEntries([1, 25, 45, 80].map(l => [`floor_tele${l}`, {
        position: l === 1 ? { x: 3229, z: 3298, level: 0 } : LUMBRIDGE,
        skills: { Magic: l },
        equipment: [{ id: 1381, count: 1, slot: 3 }],
        inventory: [{ id: 563, count: 1000 }, { id: 554, count: 300 }, { id: 557, count: 300 }, { id: 555, count: 300 }, { id: 558, count: 300 }],
    }])),
    // Woodcutting ladder (scripts/measure/floor-woodcut.ts): rune axe (1359), knife (946), 15 logs (1511). Normal trees
    // and oaks east of Draynor (oaktree 1281 at 3114,3231 and 3114,3239, m48_50.jm2), willows at Draynor (3082-3088,3227-3237).
    ...Object.fromEntries([1, 45, 72, 85].map(l => [`floor_wc${l}`, {
        position: l < 72 ? { x: 3110, z: 3228, level: 0 } : { x: 3086, z: 3233, level: 0 },
        // Combat 70s so the jail guards and the black knight near the oaks do not attack (a level-3 preset died there).
        skills: { Woodcutting: l, Attack: 70, Strength: 70, Defence: 70, Hitpoints: 70 },
        inventory: [{ id: 1359, count: 1 }, { id: 946, count: 1 }, ...Array.from({ length: 15 }, () => ({ id: 1511, count: 1 }))],
    }])),
    // Combat 70s: a Fishing-only preset died at the Lumbridge river spot (practice, respawned at 3222,3216).
    // Fishing ladder from the Sea Slug level (scripts/measure/floor-fish.ts): fly at the Lumbridge river (fly rod 309,
    // feathers 314, knife 946, logs 1511); cage (pot 301) and harpoon (311) at Musa Point.
    ...Object.fromEntries([74, 85].flatMap(l => [
        [`floor_fish_fly${l}`, { position: { x: 3239, z: 3251, level: 0 }, skills: { Fishing: l, ...COMBAT70 }, inventory: [{ id: 309, count: 1 }, { id: 314, count: 2000 }, { id: 946, count: 1 }, ...Array.from({ length: 10 }, () => ({ id: 1511, count: 1 }))] }],
        [`floor_fish_cage${l}`, { position: { x: 2924, z: 3178, level: 0 }, skills: { Fishing: l, ...COMBAT70 }, inventory: [{ id: 301, count: 1 }, { id: 946, count: 1 }, ...Array.from({ length: 10 }, () => ({ id: 1511, count: 1 }))] }],
        [`floor_fish_harpoon${l}`, { position: { x: 2924, z: 3178, level: 0 }, skills: { Fishing: l, ...COMBAT70 }, inventory: [{ id: 311, count: 1 }, { id: 946, count: 1 }, ...Array.from({ length: 10 }, () => ({ id: 1511, count: 1 }))] }],
    ])),
    // Firemaking 1 -> 99 with no banking (scripts/measure/floor-fm-rows.ts): firemaker with a tinderbox at Draynor bank;
    // helper <bot>b at Draynor bank with the FIREMAKING logs banked (2/4/7/13/24/107, 1 spare each) to drop on the path.
    floor_fmr: { position: { x: 3092, z: 3243, level: 0 }, inventory: [{ id: 590, count: 1 }] },
    floor_fmr_helper: { position: { x: 3092, z: 3243, level: 0 }, bank: [{ id: 1511, count: 3 }, { id: 1521, count: 5 }, { id: 1519, count: 8 }, { id: 1517, count: 14 }, { id: 1515, count: 25 }, { id: 1513, count: 108 }] },
    // Snake firemaking (scripts/measure/floor-fm-snake.ts): the firemaker with a tinderbox at the snake start (3068,3295).
    floor_fms: { position: { x: 3068, z: 3295, level: 0 }, inventory: [{ id: 590, count: 1 }] },
};
