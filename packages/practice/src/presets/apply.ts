import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSaveData } from '../../../../vendor/rs-sdk/sdk/test/utils/save-generator';
import { isLiteRunning } from '../lite';
import { rsSdkRoot } from '../paths';
import { extendVarps, extendVarpsBytes } from '../presets-mm';
import type { SaveConfig } from '../preset-types';

export function preparePresetDirectory(root = rsSdkRoot()): string {
    const dir = resolve(realpathSync(root), 'server/engine/data/players/main');
    // The generator chooses its engine directory by existence, so a fresh checkout needs the canonical parent first.
    mkdirSync(dir, { recursive: true });
    return dir;
}

// The engine writes the save on logout, so a preset written while logged in is lost.
export async function applyPreset(name: string, preset: SaveConfig, options: { root?: string } = {}): Promise<string> {
    if (isLiteRunning(name)) throw new Error(`bot ${name} is logged in`);
    const needsExtendedVarps = !!preset.varps && Object.keys(preset.varps).some(k => Number(k) >= 309);
    if (options.root === undefined) {
        const root = realpathSync(rsSdkRoot());
        const expected = resolve(preparePresetDirectory(root), `${name.toLowerCase()}.sav`);
        let data: Uint8Array = createSaveData(preset as never);
        if (needsExtendedVarps) data = extendVarpsBytes(Buffer.from(data), preset.varps!, expected);
        writeFileSync(expected, data);
        return expected;
    }
    const root = realpathSync(options.root);
    const expected = resolve(preparePresetDirectory(root), `${name.toLowerCase()}.sav`);
    const code = `import { generateSave } from './sdk/test/utils/save-generator.ts';
const p = await generateSave(process.env.BOT_NAME, JSON.parse(process.env.PRESET));
console.log('SAVE=' + p);`;
    const r = Bun.spawnSync(['bun', '-e', code], {
        cwd: root,
        env: { ...process.env, BOT_NAME: name, PRESET: JSON.stringify(preset) },
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
    });
    const out = r.stdout.toString();
    const m = out.match(/SAVE=(.+)/);
    if (r.exitCode !== 0 || !m) throw new Error(`generateSave failed for ${name}: ${r.stderr.toString()}${out}`);
    const path = resolve(root, m[1]!.trim());
    if (path !== expected || !existsSync(expected)) throw new Error(`generateSave wrote an unexpected path for ${name}: ${path}, expected ${expected}`);
    // The generator keeps varps 0-308 only; higher ids (Monkey Madness 365-374) are written here.
    if (needsExtendedVarps) extendVarps(path, preset.varps!);
    return path;
}
