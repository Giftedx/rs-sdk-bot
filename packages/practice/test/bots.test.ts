import { test, expect, afterAll } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBot } from '../src/bots';
import { applyPreset, PRESETS } from '../src/presets';
import { practiceDir, rsSdkRoot } from '../src/paths';

const NAME = 'tenvfix';
const settings = (env: string) => env.split(/\r?\n/).filter(line => /^(SERVER|GATEWAY_URL|TELEMETRY|SHOW_CHAT)=/.test(line));

afterAll(() => {
    rmSync(join(rsSdkRoot(), 'bots', NAME), { recursive: true, force: true });
    rmSync(join(practiceDir(), 'lite.json'), { force: true });
});

test('createBot writes a local env with telemetry and chat off', async () => {
    const { envPath } = await createBot(NAME);
    const env = settings(readFileSync(envPath, 'utf8'));
    expect(env).toContain('SERVER=localhost:8888');
    expect(env).toContain('GATEWAY_URL=ws://localhost:7780');
    expect(env).toContain('TELEMETRY=false');
    expect(env).not.toContain('TELEMETRY=true');
    expect(env).toContain('SHOW_CHAT=false');
});

test('createBot preserves an existing practice profile on its assigned endpoints', async () => {
    const { envPath } = await createBot(NAME);
    const original = readFileSync(envPath, 'utf8');
    const rest = original.split(/\r?\n/).filter(line => !/^(SERVER|GATEWAY_URL)=/.test(line));
    writeFileSync(envPath, [...rest, 'SERVER=127.0.0.1:27100', 'GATEWAY_URL=ws://127.0.0.1:27101', ''].join('\n'));
    try {
        await createBot(NAME);
        const env = settings(readFileSync(envPath, 'utf8'));
        expect(env).toContain('SERVER=127.0.0.1:27100');
        expect(env).toContain('GATEWAY_URL=ws://127.0.0.1:27101');
    } finally {
        writeFileSync(envPath, original);
    }
});

test('applyPreset refuses while the bot has a live lite runner', async () => {
    writeFileSync(join(practiceDir(), 'lite.json'), JSON.stringify({ [NAME]: { pid: process.pid, marker: 'bun' } }));
    await expect(applyPreset(NAME, PRESETS.fresh_lumbridge!)).rejects.toThrow(`bot ${NAME} is logged in`);
});

test('wc_lumbridge preset carries a bronze axe', () => {
    expect(PRESETS.wc_lumbridge!.inventory).toContainEqual({ id: 1351, count: 1 });
});
