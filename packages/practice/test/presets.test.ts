import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { applyPreset, type SaveConfig } from '../src/presets';
import { parsePracticeSave } from '../../../scripts/measure/fleet-player-save';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function freshSdkRoot() {
    const root = mkdtempSync(join(tmpdir(), 'preset-root-'));
    roots.push(root);
    const generator = join(root, 'sdk/test/utils/save-generator.ts');
    mkdirSync(dirname(generator), { recursive: true });
    copyFileSync(resolve(import.meta.dir, '../../../vendor/rs-sdk/sdk/test/utils/save-generator.ts'), generator);
    copyFileSync(resolve(import.meta.dir, '../../../vendor/rs-sdk/sdk/spells.ts'), join(root, 'sdk/spells.ts'));
    return { root, generator };
}

const preset = {
    position: { x: 2654, z: 3283, level: 0 }, skills: { Thieving: 55 },
    inventory: [{ id: 333, count: 1 }], bank: [{ id: 995, count: 1000 }], varps: { 365: 5 },
} satisfies SaveConfig;

test('a fresh SDK root receives its preset in the engine player directory before its first login', async () => {
    const { root } = freshSdkRoot();
    expect(existsSync(join(root, 'server/engine/data/players'))).toBe(false);
    const path = await applyPreset('PresetFresh', preset, { root });
    expect(path).toBe(join(root, 'server/engine/data/players/main/presetfresh.sav'));
    expect(existsSync(join(root, 'engine/data/players'))).toBe(false);
    const save = parsePracticeSave(readFileSync(path));
    expect(save.position).toEqual(preset.position);
    expect(save.inventories[93]).toEqual([{ slot: 0, id: 333, count: 1 }]);
    expect(save.inventories[95]).toEqual([{ slot: 0, id: 995, count: 1000 }]);
    expect(save.vars[281]).toBe(1000);
    expect(save.vars[365]).toBe(5);
});

test('an existing misplaced save is preserved while the preset goes into the canonical engine directory', async () => {
    const { root } = freshSdkRoot();
    const misplaced = join(root, 'engine/data/players/main/presetfresh.sav');
    mkdirSync(dirname(misplaced), { recursive: true });
    writeFileSync(misplaced, 'preserve this file');
    const path = await applyPreset('PresetFresh', preset, { root });
    expect(path).toBe(join(root, 'server/engine/data/players/main/presetfresh.sav'));
    expect(parsePracticeSave(readFileSync(path)).position).toEqual(preset.position);
    expect(readFileSync(misplaced, 'utf8')).toBe('preserve this file');
});

test('a linked SDK root matches the canonical path reported by the generator', async () => {
    const { root } = freshSdkRoot();
    const linked = join(root, 'sdk-link');
    symlinkSync(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const path = await applyPreset('PresetFresh', preset, { root: linked });
    expect(path).toBe(join(root, 'server/engine/data/players/main/presetfresh.sav'));
    expect(parsePracticeSave(readFileSync(path)).position).toEqual(preset.position);
});

test('a generator that reports another save path is rejected before preset post-processing', async () => {
    const { root, generator } = freshSdkRoot();
    writeFileSync(generator, "export async function generateSave() { return 'engine/data/players/main/presetfresh.sav'; }\n");
    await expect(applyPreset('PresetFresh', preset, { root })).rejects.toThrow('generateSave wrote an unexpected path');
});
