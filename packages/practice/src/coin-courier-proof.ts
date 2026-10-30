import { existsSync, readFileSync, writeFileSync, copyFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { freemem } from 'node:os';
import { createBot } from './bots';
import { applyPreset } from './presets';
import { runBotName } from './prove';
import { startStack } from './stack';
import { practiceDir, rsSdkRoot } from './paths';
import { killTree } from './proc';
import { FREE_FLOOR_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';
import { readPracticeSave, waitPracticeSave } from '../../../scripts/measure/fleet-player-save';
import { exactCoinDelta } from '../../../scripts/coin-courier';

const files = ['scripts/coin-courier.ts', 'scripts/coin-courier.test.ts', 'packages/practice/src/coin-courier-proof.ts'];
const root = resolve(import.meta.dir, '../../..');
const source = () => createHash('sha256').update(files.map(p => p + '\0' + readFileSync(join(root, p), 'utf8')).join('\0')).digest('hex');
type Save = ReturnType<typeof readPracticeSave>;
const count = (s: Save, container: number) => (s.inventories[container] ?? []).filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);

export function verify(directory: string) {
    const meta = JSON.parse(readFileSync(join(directory, 'native.json'), 'utf8'));
    const before = [0, 1].map(i => readPracticeSave(join(directory, `before-${i}.sav`)));
    const after = [0, 1].map(i => readPracticeSave(join(directory, `after-${i}.sav`)));
    const log = readFileSync(join(directory, 'transfer.log'), 'utf8');
    const checks = {
        source: meta.source === source(),
        transfer: meta.code === 0 && log.includes('COIN_RESULT {"ok":true'),
        coins: exactCoinDelta(before.map(s => ({ bank: count(s, 95), pack: count(s, 93) })), after.map(s => ({ bank: count(s, 95), pack: count(s, 93) })), meta.amount),
        assets: before.every((s, i) => [93, 94, 95].every(c => JSON.stringify((s.inventories[c] ?? []).filter(it => it.id !== 995)) === JSON.stringify((after[i]!.inventories[c] ?? []).filter(it => it.id !== 995)))),
        health: before.every((s, i) => s.skills[3]!.level === after[i]!.skills[3]!.level),
        logout: log.includes('LOGOUT logged-out logged-out'),
    };
    const report = { ok: Object.values(checks).every(Boolean), checks, source: meta.source, scope: 'One native preset transfer; no live or repeat qualification' };
    writeFileSync(join(directory, 'consumer.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    return report;
}

async function run(directory: string) {
    if (freemem() / 2 ** 30 < PRACTICE_STARTUP_GB) throw Error('practice startup headroom unavailable');
    const lock = join(practiceDir(), 'delivery-practice.lock'), fd = openSync(lock, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, task: 'coin-courier', directory }));
    let stack: Awaited<ReturnType<typeof startStack>> | undefined;
    const command = async (args: string[], label: string, env: Record<string, string> = {}) => {
        const child = Bun.spawn(['bun', ...args], { cwd: root, env: { ...process.env, RANDOM_EVENTS: '0', DEMO_OK: '', ...env }, stdout: Bun.file(join(directory, label + '.log')), stderr: Bun.file(join(directory, label + '.err')), windowsHide: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; void killTree(child.pid); }, 240000);
        try { const code = await child.exited; return timedOut ? -1 : code; } finally { clearTimeout(timer); }
    };
    try {
        const revision = source(), amount = 12345, names = [runBotName('cgive', 1), runBotName('ctake', 1)], saves: string[] = [];
        stack = await startStack({ tickMs: 150, readyTimeoutMs: 60000 });
        for (const [i, name] of names.entries()) {
            if (existsSync(join(rsSdkRoot(), 'bots', name))) throw Error('practice name already exists');
            await createBot(name);
            const path = await applyPreset(name, { position: { x: i ? 3184 : 3183, z: 3436, level: 0 }, skills: { Hitpoints: 15 }, inventory: [{ id: 995, count: i ? 7 : 9 }, { id: 1265, count: 1 }], bank: [{ id: 995, count: i ? 500 : 50000 }, { id: 2347, count: 1 }] });
            saves.push(path);
            if (await command(['packages/practice/src/register-proof-account.ts', name], 'auth-' + i) !== 0) throw Error('practice registration failed');
            const entry = await waitPracticeSave(path, s => count(s, 95) === (i ? 500 : 50000) && count(s, 93) === (i ? 7 : 9));
            if (!entry.matched) throw Error('practice entry not retained');
            copyFileSync(path, join(directory, `before-${i}.sav`));
        }
        if (freemem() / 2 ** 30 < FREE_FLOOR_GB) throw Error('practice memory floor reached before transfer');
        const code = await command(['scripts/coin-courier.ts', ...names, String(amount)], 'transfer', { COIN_ORDER: 'proof-' + crypto.randomUUID() });
        for (const [i, path] of saves.entries()) {
            await waitPracticeSave(path, s => count(s, 95) === (i ? 500 + amount : 50000 - amount));
            copyFileSync(path, join(directory, `after-${i}.sav`));
        }
        writeFileSync(join(directory, 'native.json'), JSON.stringify({ source: revision, amount, names, code }));
        return verify(directory);
    } finally {
        try { await stack?.stop(); } finally { closeSync(fd); unlinkSync(lock); }
    }
}
if (import.meta.main) {
    try {
        if (!process.env.DELIVERY_DIR) throw Error('run through coin-courier delivery harness');
        const directory = resolve(process.env.DELIVERY_DIR);
        process.exitCode = (process.argv[2] === '--verify' ? verify(directory) : await run(directory)).ok ? 0 : 1;
    } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
