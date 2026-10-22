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
    wc_lumbridge: { position: LUMBRIDGE, inventory: [{ id: 1351, count: 1 }] },
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
