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
