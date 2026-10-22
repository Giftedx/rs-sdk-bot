import { test, expect, afterAll } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBot } from '../src/bots';
import { applyPreset, PRESETS } from '../src/presets';
import { practiceDir, rsSdkRoot } from '../src/paths';

const NAME = 'tenvfix';

afterAll(() => {
    rmSync(join(rsSdkRoot(), 'bots', NAME), { recursive: true, force: true });
    rmSync(join(practiceDir(), 'lite.json'), { force: true });
});

test('createBot writes a local env with telemetry and chat off', async () => {
    const { envPath } = await createBot(NAME);
    const env = readFileSync(envPath, 'utf8');
    expect(env).toContain('SERVER=localhost:8888');
    expect(env).toContain('TELEMETRY=false');
    expect(env).not.toContain('TELEMETRY=true');
    expect(env).toContain('SHOW_CHAT=false');
});

test('applyPreset refuses while the bot has a live lite runner', async () => {
    writeFileSync(join(practiceDir(), 'lite.json'), JSON.stringify({ [NAME]: process.pid }));
    await expect(applyPreset(NAME, PRESETS.fresh_lumbridge!)).rejects.toThrow(`bot ${NAME} is logged in`);
});

test('wc_lumbridge preset carries a bronze axe', () => {
    expect(PRESETS.wc_lumbridge!.inventory).toContainEqual({ id: 1351, count: 1 });
});
