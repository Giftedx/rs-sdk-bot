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
