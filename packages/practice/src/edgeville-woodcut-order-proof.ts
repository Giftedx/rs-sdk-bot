import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { PRACTICE_STARTUP_GB } from '../../core/src/memory';
import { capabilityRevision } from '../../core/src/worker-release';
import { readPracticeSave, waitPracticeSave } from '../../../scripts/measure/fleet-player-save';
import { createBot } from './bots';
import { ironProofAccountEnv, selectIronProofEndpoints, startIronProofStack } from './iron-progress-order-proof';
import { applyPreset } from './presets';
import { killTree } from './proc';
import { runBotName } from './prove';
import { startStack } from './stack';

const ROOT = resolve(import.meta.dir, '../../..');
const ENTRY = 'scripts/edgeville-woodcut-order.ts';
const AXE = 1351, LOGS = 1521, WOOD = 8, HP = 3, BANK = 95, PACK = 93;
const OAK_XP_TENTHS = 375 * 25;
type Save = ReturnType<typeof readPracticeSave>;

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const count = (items: readonly { id: number; count: number }[], id: number) =>
    items.reduce((total, item) => total + (item.id === id ? item.count : 0), 0);
const source = () => ({
    runtime: capabilityRevision([ENTRY], ROOT),
    files: Object.fromEntries([
        'packages/practice/src/edgeville-woodcut-order-proof.ts',
        'scripts/measure/fleet-player-save.ts',
        'vendor/rs-sdk/server/content/maps/m48_54.jm2',
        'vendor/rs-sdk/server/content/maps/m48_53.jm2',
        'vendor/rs-sdk/server/content/scripts/skill_woodcutting/configs/trees.dbrow',
    ].map(path => [path, sha(join(ROOT, path))])),
});

export function savedBatch(before: Save, after: Save) {
    const priorBank = before.inventories[BANK] ?? [], finalBank = after.inventories[BANK] ?? [];
    const banked = count(finalBank, LOGS) - count(priorBank, LOGS);
    const delta = (after.skills[WOOD]?.rawExperience ?? 0) - (before.skills[WOOD]?.rawExperience ?? 0);
    const otherAssets = (save: Save) => Object.entries(save.inventories).flatMap(([inventory, items]) =>
        items.filter(item => item.id !== LOGS).map(({ id, count, slot }) => [inventory, slot, id, count]));
    const nearEdgeville = after.position.level === 0 &&
        Math.max(Math.abs(after.position.x - 3094), Math.abs(after.position.z - 3492)) <= 3;
    // Bank deposit can reuse a vacant slot. Compare per-container quantities, keeping worn slots exact.
    const byContainer = (save: Save) => {
        const items = new Map<string, number>();
        for (const [container, slot, id, amount] of otherAssets(save)) {
            const key = [container, container === '94' ? slot : '', id].join('/');
            items.set(key, (items.get(key) ?? 0) + Number(amount));
        }
        return JSON.stringify([...items].sort(([a], [b]) => a.localeCompare(b)));
    };
    return {
        banked, delta, nearEdgeville,
        ok: before.skills[WOOD]?.level === 15 && (after.skills[WOOD]?.level ?? 0) >= 36 &&
            after.skills[HP]?.level === before.skills[HP]?.level && nearEdgeville &&
            count(finalBank, AXE) === count(priorBank, AXE) && count(after.inventories[PACK] ?? [], LOGS) === 0 &&
            banked > 0 && delta === banked * OAK_XP_TENTHS && byContainer(before) === byContainer(after),
    };
}

function verify(dir: string) {
    const receipt = JSON.parse(readFileSync(join(dir, 'edgeville-woodcut-order.json'), 'utf8'));
    const paths = ['edgeville-before.sav', 'edgeville-after.sav', 'edgeville-worker.log'];
    if (receipt.code !== 0 || receipt.timedOut || JSON.stringify(receipt.source) !== JSON.stringify(source()) ||
        paths.some(path => receipt.hashes[path] !== sha(join(dir, path)))) return false;
    const log = readFileSync(join(dir, 'edgeville-worker.log'), 'utf8');
    const resultLine = /^EDGEVILLE_WOODCUT (.+)$/m.exec(log)?.[1];
    if (!resultLine || !/^LOGOUT logged-out\r?$/m.test(log)) return false;
    const result = JSON.parse(resultLine);
    const saved = savedBatch(readPracticeSave(join(dir, paths[0]!)), readPracticeSave(join(dir, paths[1]!)));
    console.log(JSON.stringify({ saved, worker: result }));
    return saved.ok && result.ok === true && result.banked === saved.banked && result.hpMin === 52;
}

async function rehearse(dir: string) {
    if (!existsSync(join(ROOT, '.practice/delivery-native.lock')) || freemem() / 2 ** 30 < PRACTICE_STARTUP_GB) {
        throw Error('Edgeville Woodcutting requires an admitted delivery practice turn');
    }
    mkdirSync(dir, { recursive: true });
    const endpoints = selectIronProofEndpoints();
    const name = runBotName('flwood', 1), bot = await createBot(name);
    writeFileSync(bot.envPath, ironProofAccountEnv(readFileSync(bot.envPath, 'utf8'), endpoints));
    const save = await applyPreset(name, {
        position: { x: 3094, z: 3491, level: 0 },
        skills: { Attack: 67, Strength: 25, Defence: 24, Hitpoints: 52, Woodcutting: 15 },
        inventory: Array.from({ length: 8 }, () => ({ id: 385, count: 1 })),
        bank: [{ id: AXE, count: 1 }, { id: LOGS, count: 5 }, { id: 995, count: 216372 }],
    });
    const beforePath = join(dir, 'edgeville-before.sav');
    copyFileSync(save, beforePath);
    const before = readPracticeSave(beforePath), expected = source();
    const stack = await startIronProofStack(endpoints, opts => startStack({ ...opts, xpRate: 25 }));
    try {
        const log = join(dir, 'edgeville-worker.log');
        const child = Bun.spawn([process.execPath, ENTRY, name], {
            cwd: ROOT, windowsHide: true, stdout: Bun.file(log), stderr: Bun.file(join(dir, 'edgeville-worker.err')),
            env: { ...process.env, ...endpoints.env, DEMO_OK: '', RANDOM_EVENTS: '0', STALL_TICKS: '0' },
        });
        let timeout: Promise<void> | undefined;
        const timer = setTimeout(() => { timeout = killTree(child.pid); }, 420_000);
        const code = await child.exited;
        clearTimeout(timer);
        await timeout;
        if (code === 0) await waitPracticeSave(save, after => savedBatch(before, after).ok);
        copyFileSync(save, join(dir, 'edgeville-after.sav'));
        const paths = ['edgeville-before.sav', 'edgeville-after.sav', 'edgeville-worker.log'];
        writeFileSync(join(dir, 'edgeville-woodcut-order.json'), JSON.stringify({
            code, timedOut: Boolean(timeout), source: expected,
            hashes: Object.fromEntries(paths.map(path => [path, sha(join(dir, path))])),
        }, null, 2));
        return verify(dir);
    } finally {
        await stack.stop();
    }
}

if (import.meta.main) {
    const directory = process.env.DELIVERY_DIR;
    if (!directory) throw Error('Run through the Edgeville Woodcutting delivery harness');
    process.exitCode = (process.argv[2] === '--verify' ? verify(resolve(directory)) : await rehearse(resolve(directory))) ? 0 : 1;
}
