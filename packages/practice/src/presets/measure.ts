import type { SaveConfig } from '../preset-types';

// Agility laps (scripts/measure/agility-laps.ts): each course at its entry level and at 70 / 90.
// Gnome: north of the log (2474,3435). Barbarian: north of the rope swing (2551,3550), already inside the outpost
// (the gate needs Alfred Grimhand's Barcrawl, outpost_gate.rs2:2). Wilderness: south of the pipe (3004,3938), inside
// the course. HP 70, Defence 70 and 15 lobsters (379) for the fail damage (15-21.6% of HP + 1 per fail).
function agilityPresets(): Record<string, SaveConfig> {
    const food = Array.from({ length: 15 }, () => ({ id: 379, count: 1 }));
    const at = {
        gnome: { pos: { x: 2474, z: 3437, level: 0 }, levels: [1, 70, 90] },
        barbarian: { pos: { x: 2551, z: 3555, level: 0 }, levels: [35, 70, 90] },
        wilderness: { pos: { x: 3004, z: 3937, level: 0 }, levels: [49, 52, 60, 70, 76, 90] },
        // Brimhaven Agility Arena floor (plane 3, agilityarena.rs2:7), on the east rope swing's start tile.
        arenaswing: { pos: { x: 2764, z: 9569, level: 3 }, levels: [75, 90] },
    };
    const out: Record<string, SaveConfig> = {};
    for (const [course, c] of Object.entries(at))
        for (const l of c.levels)
            out[`agility_${course}_${l}`] = { position: c.pos, skills: { Agility: l, Hitpoints: 70, Defence: 70 }, inventory: food };
    // Agility 49 south of the ridge gate (loc_2309 at 2998,3917) with 2 agility potion(4) (obj 3032, +3 Agility): the gate
    // needs stat(agility) >= 52 (wilderness_course.rs2:2), the pipe >= 49 (:53). Run with AGI_POTION=1.
    out.agility_wilderness_49pot = {
        position: { x: 2998, z: 3916, level: 0 },
        skills: { Agility: 49, Hitpoints: 70, Defence: 70 },
        inventory: [{ id: 3032, count: 1 }, { id: 3032, count: 1 }, ...food.slice(0, 13)],
    };
    return out;
}

export const MEASURE_PRESETS: Record<string, SaveConfig> = {
    // Measurement spots from vendor/rs-sdk/learnings (woodcutting.md, mining.md, fishing.md).
    measure_trees: { position: { x: 3195, z: 3220, level: 0 }, inventory: [{ id: 1351, count: 1 }] },
    measure_oaks: { position: { x: 3190, z: 3458, level: 0 }, skills: { Woodcutting: 15 }, inventory: [{ id: 1351, count: 1 }] },
    measure_mine: { position: { x: 3285, z: 3365, level: 0 }, inventory: [{ id: 1265, count: 1 }] },
    // Iron at the SE Varrock mine: (3286,3368) touches the iron rocks at (3285,3368), (3285,3369), (3286,3369): Mining 15 with a bronze pickaxe (1265), Mining 41 with rune (1275).
    measure_iron_bronze: { position: { x: 3286, z: 3368, level: 0 }, skills: { Mining: 15 }, inventory: [{ id: 1265, count: 1 }] },
    measure_iron_rune: { position: { x: 3286, z: 3368, level: 0 }, skills: { Mining: 41 }, inventory: [{ id: 1275, count: 1 }] },
    // 3-tick woodcutting test: the oak preset plus a knife (946) and one log (1511).
    oaks_3tick: { position: { x: 3190, z: 3458, level: 0 }, skills: { Woodcutting: 15 }, inventory: [{ id: 1351, count: 1 }, { id: 946, count: 1 }, { id: 1511, count: 1 }] },
    // 3-tick fishing test: the Draynor net spot, small net (303), knife (946), one log (1511).
    shrimp_3tick: { position: { x: 3087, z: 3230, level: 0 }, inventory: [{ id: 303, count: 1 }, { id: 946, count: 1 }, { id: 1511, count: 1 }] },
    // 3-tick fly fishing test: Lumbridge river spot (0_50_50_freshfish at 3238,3252), Fishing 20, fly fishing rod (309),
    // 300 feathers (314), knife (946), 10 logs (1511): a missed spot click lets the fletch finish and use a log.
    fly_3tick: { position: { x: 3239, z: 3251, level: 0 }, skills: { Fishing: 20 }, inventory: [{ id: 309, count: 1 }, { id: 314, count: 300 }, { id: 946, count: 1 }, ...Array.from({ length: 10 }, () => ({ id: 1511, count: 1 }))] },
    measure_shrimp: { position: { x: 3087, z: 3230, level: 0 }, inventory: [{ id: 303, count: 1 }] },
    // Delayed-click 3-tick fishing (scripts/measure/fish-delayed.ts): Musa Point rarefish spots (2923,3180 2925,3181
    // 2926,3179, knowledge/npcs.json id 324), lobster pot (301) or harpoon (311), knife (946), 15 logs (1511): a missed click lets the fletch finish and use a log.
    lobster_delayed_40: { position: { x: 2924, z: 3178, level: 0 }, skills: { Fishing: 40 }, inventory: [{ id: 301, count: 1 }, { id: 946, count: 1 }, ...Array.from({ length: 15 }, () => ({ id: 1511, count: 1 }))] },
    lobster_delayed_70: { position: { x: 2924, z: 3178, level: 0 }, skills: { Fishing: 70 }, inventory: [{ id: 301, count: 1 }, { id: 946, count: 1 }, ...Array.from({ length: 15 }, () => ({ id: 1511, count: 1 }))] },
    harpoon_delayed_55: { position: { x: 2924, z: 3178, level: 0 }, skills: { Fishing: 55 }, inventory: [{ id: 311, count: 1 }, { id: 946, count: 1 }, ...Array.from({ length: 15 }, () => ({ id: 1511, count: 1 }))] },
    // Catherby memberfish spots (2846,3429 2855,3423 2859,3426, id 322): shark harpoon at Fishing 80.
    shark_delayed_80: { position: { x: 2850, z: 3431, level: 0 }, skills: { Fishing: 80 }, inventory: [{ id: 311, count: 1 }, { id: 946, count: 1 }, ...Array.from({ length: 15 }, () => ({ id: 1511, count: 1 }))] },
    // Fly fishing baseline at the same levels (Lumbridge river spot 3238,3252), for scripts/measure/fish-3tick.ts.
    fly_3tick_40: { position: { x: 3239, z: 3251, level: 0 }, skills: { Fishing: 40 }, inventory: [{ id: 309, count: 1 }, { id: 314, count: 1000 }, { id: 946, count: 1 }, ...Array.from({ length: 10 }, () => ({ id: 1511, count: 1 }))] },
    fly_3tick_70: { position: { x: 3239, z: 3251, level: 0 }, skills: { Fishing: 70 }, inventory: [{ id: 309, count: 1 }, { id: 314, count: 1000 }, { id: 946, count: 1 }, ...Array.from({ length: 10 }, () => ({ id: 1511, count: 1 }))] },
    // Flinch 2-tick woodcutting (scripts/measure/flinch.ts) and its knife/normal baseline (wc-3tick.ts): Barbarian Village
    // oak (3074,3422) in a multiway zone (maps/multiway.csv "barbarian village"), barbarians (combat 7, attackrate 4) at
    // 3076,3414 3078,3419 3080,3423. Steel axe (1353), shortbow (841, no arrows), pot (1931) + bucket (1925) for the
    // clear input, knife (946) + log (1511) for the knife baseline, 10 lobsters (379). HP 40, Defence 20.
    flinch_oak_15: { position: { x: 3075, z: 3421, level: 0 }, skills: { Woodcutting: 15, Hitpoints: 40, Defence: 20 }, inventory: [{ id: 1353, count: 1 }, { id: 841, count: 1 }, { id: 1931, count: 1 }, { id: 1925, count: 1 }, { id: 946, count: 1 }, { id: 1511, count: 1 }, ...Array.from({ length: 10 }, () => ({ id: 379, count: 1 }))] },
    flinch_oak_45: { position: { x: 3075, z: 3421, level: 0 }, skills: { Woodcutting: 45, Hitpoints: 40, Defence: 20 }, inventory: [{ id: 1353, count: 1 }, { id: 841, count: 1 }, { id: 1931, count: 1 }, { id: 1925, count: 1 }, { id: 946, count: 1 }, { id: 1511, count: 1 }, ...Array.from({ length: 10 }, () => ({ id: 379, count: 1 }))] },
    // Flinch 2-tick shark (flinch.ts RES=fish AGGRO=1 PRAY=1) and its delayed-click baseline (fish-delayed.ts OPT=harpoon):
    // Ape Atoll memberfish spot (2780,2741, id 1405) in a multiway zone, aggressive jungle scorpions (combat 38,
    // attackrate 4, mm_jungle_scorpion) nearby. Fishing 80, Prayer 99 (Protect from Melee), HP 99, Defence 70. Harpoon
    // (311), shortbow (841), pot + bucket, knife (946) + 15 logs (1511), 5 sharks (385). No Monkey Madness gate in a preset.
    flinch_shark_80: { position: { x: 2779, z: 2740, level: 0 }, skills: { Fishing: 80, Prayer: 99, Hitpoints: 99, Defence: 70 }, inventory: [{ id: 311, count: 1 }, { id: 841, count: 1 }, { id: 1931, count: 1 }, { id: 1925, count: 1 }, { id: 946, count: 1 }, ...Array.from({ length: 15 }, () => ({ id: 1511, count: 1 })), ...Array.from({ length: 5 }, () => ({ id: 385, count: 1 }))] },
    ...agilityPresets(),
};
