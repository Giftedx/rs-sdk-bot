import { test, expect, afterAll } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBot } from '../src/bots';
import { applyPreset, PRESETS } from '../src/presets';
import { practiceBotsRoot, practiceDir } from '../src/paths';

const NAME = 'tenvfix';
const settings = (env: string) => env.split(/\r?\n/).filter(line => /^(SERVER|GATEWAY_URL|TELEMETRY|SHOW_CHAT)=/.test(line));

afterAll(() => {
    rmSync(join(practiceBotsRoot(), NAME), { recursive: true, force: true });
    rmSync(join(practiceDir(), 'lite.json'), { force: true });
});

test('createBot writes a local env with telemetry and chat off under .practice/sim/bots', async () => {
    const { envPath } = await createBot(NAME);
    expect(envPath.replaceAll('\\', '/')).toContain('/.practice/sim/bots/');
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

import { isLiteRunning } from '../src/lite';
import { parsePracticeSave } from '../../../scripts/measure/fleet-player-save';
import { rsSdkRoot } from '../src/paths';

test('wc_lumbridge preset carries a bronze axe', () => {
    expect(PRESETS.wc_lumbridge!.inventory).toContainEqual({ id: 1351, count: 1 });
});

test('applyPreset writes extended varps in-process for default SDK root and isLiteRunning returns false for a dead PID', async () => {
    const tmpName = `tp${(process.pid % 10000).toString(36)}z`;
    writeFileSync(join(practiceDir(), 'lite.json'), JSON.stringify({ [tmpName]: { pid: 999_999_999, marker: 'src/lite/runner.ts' } }));
    expect(isLiteRunning(tmpName)).toBe(false);
    rmSync(join(practiceDir(), 'lite.json'), { force: true });

    const savPath = await applyPreset(tmpName, {
        position: { x: 2654, z: 3283, level: 0 },
        skills: { Thieving: 55 },
        inventory: [{ id: 333, count: 1 }],
        varps: { 365: 5 },
    });
    try {
        expect(savPath).toContain(join(rsSdkRoot(), 'server', 'engine', 'data', 'players', 'main'));
        const save = parsePracticeSave(readFileSync(savPath));
        expect(save.position).toEqual({ x: 2654, z: 3283, level: 0 });
        expect(save.vars[281]).toBe(1000);
        expect(save.vars[365]).toBe(5);
    } finally {
        rmSync(savPath, { force: true });
    }
});
