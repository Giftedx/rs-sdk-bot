import { rsSdkRoot } from './paths';
import { isLiteRunning } from './lite';

// Mirrors SaveConfig in vendor/rs-sdk/sdk/test/utils/save-generator.ts. createSaveData sets tutorial varp 281 = 1000 itself.
export interface SaveConfig {
    position?: { x: number; z: number; level?: number };
    skills?: Record<string, number>;
    inventory?: Array<{ id: number; count: number }>;
    equipment?: Array<{ id: number; count: number; slot: number }>;
    bank?: Array<{ id: number; count: number }>;
    coins?: number;
    varps?: Record<number, number>;
}

const LUMBRIDGE = { x: 3222, z: 3218, level: 0 };

export const PRESETS: Record<string, SaveConfig> = {
    fresh_lumbridge: { position: LUMBRIDGE },
    // Trees within reach, measured by the 2026-10-22 spike run.
    wc_lumbridge: { position: { x: 3224, z: 3245, level: 0 }, inventory: [{ id: 1351, count: 1 }] },
    // Lumbridge castle courtyard, ground floor (vendor/rs-sdk/learnings/walking.md: castle 3222,3218).
    floors_lumbridge: { position: LUMBRIDGE },
    // Draynor bank (3092,3243) per vendor/rs-sdk/learnings/walking.md; trees stand north of it.
    bank_draynor: { position: { x: 3092, z: 3247, level: 0 }, inventory: [{ id: 1351, count: 1 }] },
    // Inside the Lumbridge cow field (centre 3253,3290 per learnings/combat.md). Sword 1277, shrimps 315.
    fight_lumbridge: { position: { x: 3253, z: 3285, level: 0 }, inventory: [{ id: 1277, count: 1 }, { id: 315, count: 5 }] },
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
    // Wine batch test (skill_cooking/.../wine/wine.rs2): Cooking 35, one grapes + jug of water to start the
    // 20-tick fermenting timer, and 300 unfermented wines (1995) in the bank that ferment when it fires.
    wine_specialist: {
        position: LUMBRIDGE,
        skills: { Cooking: 35 },
        inventory: [{ id: 1987, count: 1 }, { id: 1937, count: 1 }],
        bank: [{ id: 1995, count: 300 }],
    },
    // Login wine test: no Cooking levels, 600 unfermented wines (1995) banked; the login timer does the rest.
    wine_login: { position: LUMBRIDGE, bank: [{ id: 1995, count: 600 }] },
    // Gem throughput test: Crafting 55, chisel (1755) and 27 uncut dragonstones (1631).
    gems_dragonstone: { position: LUMBRIDGE, skills: { Crafting: 55 }, inventory: [{ id: 1755, count: 1 }, ...Array.from({ length: 27 }, () => ({ id: 1631, count: 1 }))] },
    // Resupply test: helper next to the specialist with 27 uncut dragonstones.
    supply_spec: { position: LUMBRIDGE, skills: { Crafting: 55 } },
    supply_helper: { position: { x: 3223, z: 3218, level: 0 }, inventory: Array.from({ length: 27 }, () => ({ id: 1631, count: 1 })) },
    // Bank-loop test at Draynor bank (3092,3243, learnings/walking.md): chisel in pack, 270 uncut dragonstones banked.
    bank_gems: { position: { x: 3092, z: 3243, level: 0 }, skills: { Crafting: 55 }, inventory: [{ id: 1755, count: 1 }], bank: [{ id: 1631, count: 270 }] },
    // Thieving: south Varrock man/woman cluster (knowledge/npcs.json: man 3237,3406 / 3223,3398; woman2 3223,3401),
    // 5 shrimps (315) for stun damage.
    thieve_varrock: { position: { x: 3235, z: 3403, level: 0 }, inventory: [{ id: 315, count: 5 }] },
    // Thieving tier 2: Varrock palace guards (knowledge/npcs.json guard1 at 3206-3213,3462-3465; combat 21).
    // Pickpocket guard needs Thieving 40 (46.8 XP); HP 30 and 20 shrimps (315) for harder stun hits.
    thieve_guards: { position: { x: 3210, z: 3459, level: 0 }, skills: { Thieving: 40, Hitpoints: 30 }, inventory: Array.from({ length: 20 }, () => ({ id: 315, count: 1 })) },
    // Thieving tier 3: Ardougne market knights (knowledge/npcs.json knight_of_ardougne at 2652,3318 and 2653,3300).
    // Pickpocket knight needs Thieving 55 (84.3 XP); a fail hits for 3, so HP 50 and 20 lobsters (379).
    thieve_knights: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 55, Hitpoints: 50 }, inventory: Array.from({ length: 20 }, () => ({ id: 379, count: 1 })) },
    // Same as thieve_knights but with a fresh account's 10 HP: isolates the cost of a low HP cap at knights.
    thieve_knights_hp10: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 55 }, inventory: Array.from({ length: 20 }, () => ({ id: 379, count: 1 })) },
    // Cycle tests only: HP 99 and 27 lobsters, so food never runs out in a 1,500-tick knight run.
    thieve_knights_hp99: { position: { x: 2654, z: 3304, level: 0 }, skills: { Thieving: 55, Hitpoints: 99 }, inventory: Array.from({ length: 27 }, () => ({ id: 379, count: 1 })) },
    // Ardougne baker's stall food test: Thieving 5 (stall level), HP 10, next to the west stall (loc touches 2654,3310).
    cake_stall: { position: { x: 2655, z: 3310, level: 0 }, skills: { Thieving: 5 } },
    // Resume test: a live-like account already in the Ardougne market, Thieving 66, 10 HP, 2000 coins.
    resume_ardougne: { position: { x: 2657, z: 3313, level: 0 }, skills: { Thieving: 66 }, coins: 2000 },
    // Lockpick door test: Thieving 16 beside loc_2551 (2674,3304), east of the Ardougne market.
    door_2551: { position: { x: 2675, z: 3304, level: 0 }, skills: { Thieving: 16 } },
    // Runecraft: inside the air altar (runecraft_table enter_coord 2841,4830,0), air talisman (1438), 27 rune essence (1436).
    rc_air_inside: { position: { x: 2841, z: 4830, level: 0 }, inventory: [{ id: 1438, count: 1 }, ...Array.from({ length: 27 }, () => ({ id: 1436, count: 1 }))] },
    // Thieving specialist trip: a fresh account (10 HP, no gear) with 60 coins for two 30-coin boat fares.
    boat_ardougne: { position: LUMBRIDGE, coins: 60 },
    // Trade pair: giver holds 100 coins, receiver stands one tile east (3223,3218).
    trade_giver: { position: LUMBRIDGE, coins: 100 },
    trade_receiver: { position: { x: 3223, z: 3218, level: 0 } },
};

// The engine writes the save on logout, so a preset written while logged in is lost.
export async function applyPreset(name: string, preset: SaveConfig): Promise<string> {
    if (isLiteRunning(name)) throw new Error(`bot ${name} is logged in`);
    const code = `import { generateSave } from './sdk/test/utils/save-generator.ts';
const p = await generateSave(process.env.BOT_NAME, JSON.parse(process.env.PRESET));
console.log('SAVE=' + p);`;
    const r = Bun.spawnSync(['bun', '-e', code], {
        cwd: rsSdkRoot(),
        env: { ...process.env, BOT_NAME: name, PRESET: JSON.stringify(preset) },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const out = r.stdout.toString();
    const m = out.match(/SAVE=(.+)/);
    if (r.exitCode !== 0 || !m) throw new Error(`generateSave failed for ${name}: ${r.stderr.toString()}${out}`);
    return m[1]!.trim();
}
