// Bench cases and multi-actor fresh-clock coordinator for Hitpoints, Strength, and Defence combat-quest specialists.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { finish, openBot } from '../../packages/core/src/bot';
import type { SaveConfig } from '../../packages/practice/src/presets';
import { killTree } from '../../packages/practice/src/proc';
import { playerSavePath } from '../../packages/practice/src/save-library';
import {
    DEFENCE_SPECIALIST_KIT,
    HP_SPECIALIST_KIT,
    KIT_BY_BOARD,
    SPECIALIST_TARGETS,
    STRENGTH_SPECIALIST_KIT,
    runCompanionRole,
    type KitSpecItem,
} from '../combat-quest-specialists';
import type { BenchCase } from './aio-bench-cases';

const ROOT = resolve(import.meta.dir, '..', '..');

const ok = (s: string) => /^RESULT ok\b/m.test(s);
const loggedOutOnce = (s: string) => (s.match(/^LOGOUT .*$/gm) ?? []).length === 1;
const observedTicks = (s: string): number => {
    const res = /^RESULT .*?\bticks=(\d+)/m.exec(s);
    if (res) return Number(res[1]);
    const ledger = /^LEDGER ticks=(\d+)/m.exec(s);
    return ledger ? Number(ledger[1]) : Number.POSITIVE_INFINITY;
};

export function kitToSaveInventory(kit: readonly KitSpecItem[]): { id: number; count: number }[] {
    const out: { id: number; count: number }[] = [];
    for (const item of kit) {
        if (item.stackable) out.push({ id: item.id, count: item.count });
        else for (let i = 0; i < item.count; i++) out.push({ id: item.id, count: 1 });
    }
    return out;
}

const TANK_SKILLS = {
    Attack: 99,
    Strength: 99,
    Defence: 1,
    Hitpoints: 99,
    Prayer: 99,
    Magic: 99,
    Ranged: 1,
} as const;

const TANK_BANK = [
    { id: 563, count: 100 },
    { id: 2552, count: 50 },
    { id: 391, count: 1000 },
];

export function supplierPresetConfig(kit: readonly KitSpecItem[]): SaveConfig {
    return {
        position: { x: 3222, z: 3222, level: 0 },
        skills: { Hitpoints: 99 },
        inventory: kitToSaveInventory(kit),
        equipment: [],
        bank: [],
    };
}

export function tankSupplierPresetConfig(kit: readonly KitSpecItem[]): SaveConfig {
    return {
        position: { x: 3222, z: 3222, level: 0 },
        skills: { ...TANK_SKILLS },
        inventory: kitToSaveInventory(kit),
        equipment: [{ id: 1381, count: 1, slot: 3 }, { id: 2552, count: 1, slot: 12 }],
        bank: [...TANK_BANK],
    };
}

export function tankPostPresetConfig(): SaveConfig {
    return {
        position: { x: 3154, z: 3924, level: 0 },
        skills: { ...TANK_SKILLS },
        inventory: Array.from({ length: 28 }, () => ({ id: 391, count: 1 })),
        equipment: [{ id: 1381, count: 1, slot: 3 }, { id: 2552, count: 1, slot: 12 }],
        bank: [...TANK_BANK],
    };
}

const SPECIALIST_SCRIPT: Readonly<Record<'hp' | 'strength' | 'defence', string>> = {
    hp: 'scripts/hp-specialist.ts',
    strength: 'scripts/strength-specialist.ts',
    defence: 'scripts/defence-specialist.ts',
};

const SPECIALIST_BOARD: Readonly<Record<'hp' | 'strength' | 'defence', 'hitpoints' | 'strength' | 'defence'>> = {
    hp: 'hitpoints',
    strength: 'strength',
    defence: 'defence',
};

export const SPECIALIST_COMBAT_QUESTS_CASES: BenchCase[] = [
    {
        key: 'fighter:specialist-hp',
        script: 'scripts/measure/specialist-combat-quests-cases.ts',
        preset: 'fresh_lumbridge',
        presetConfig: {},
        scriptArgs: ['hp', '{bot:s}'],
        companions: [{ suffix: 's', preset: 'fresh_lumbridge', presetConfig: supplierPresetConfig(HP_SPECIALIST_KIT) }],
        timeoutMs: 900_000,
        pass: s => ok(s) && /hitpoints=99\b/.test(s) && observedTicks(s) <= SPECIALIST_TARGETS.hitpoints.targetTicks && loggedOutOnce(s),
    },
    {
        key: 'fighter:specialist-strength',
        script: 'scripts/measure/specialist-combat-quests-cases.ts',
        preset: 'fresh_lumbridge',
        presetConfig: {},
        scriptArgs: ['strength', '{bot:s}', '{bot:t}'],
        companions: [
            { suffix: 's', preset: 'fresh_lumbridge', presetConfig: tankSupplierPresetConfig(STRENGTH_SPECIALIST_KIT) },
            { suffix: 't', preset: 'fresh_lumbridge', presetConfig: tankPostPresetConfig() },
        ],
        timeoutMs: 900_000,
        pass: s => ok(s) && /strength=99\b/.test(s) && observedTicks(s) <= SPECIALIST_TARGETS.strength.targetTicks && loggedOutOnce(s),
    },
    {
        key: 'fighter:specialist-defence',
        script: 'scripts/measure/specialist-combat-quests-cases.ts',
        preset: 'fresh_lumbridge',
        presetConfig: {},
        scriptArgs: ['defence', '{bot:s}', '{bot:t}'],
        companions: [
            { suffix: 's', preset: 'fresh_lumbridge', presetConfig: tankSupplierPresetConfig(DEFENCE_SPECIALIST_KIT) },
            { suffix: 't', preset: 'fresh_lumbridge', presetConfig: tankPostPresetConfig() },
        ],
        timeoutMs: 900_000,
        pass: s => ok(s) && /defence=99\b/.test(s) && observedTicks(s) <= SPECIALIST_TARGETS.defence.targetTicks && loggedOutOnce(s),
    },
];

async function pumpPrefixed(
    stream: ReadableStream<Uint8Array>,
    prefix: string,
    target: NodeJS.WriteStream,
    onLine?: (line: string) => void,
): Promise<void> {
    const decoder = new TextDecoder();
    let rest = '';
    for await (const chunk of stream) {
        rest += decoder.decode(chunk, { stream: true });
        const lines = rest.split('\n');
        rest = lines.pop() ?? '';
        for (const raw of lines) {
            const line = raw.replace(/\r$/, '');
            target.write(`${prefix}${line}\n`);
            onLine?.(line);
        }
    }
    if (rest.length > 0) {
        const line = rest.replace(/\r$/, '');
        target.write(`${prefix}${line}\n`);
        onLine?.(line);
    }
}

async function runCompanionMain(args: string[]): Promise<void> {
    const [account, specialist, roleRaw, boardRaw, offsetRaw, stopFile] = args;
    if (!account || !specialist || !roleRaw || !boardRaw) {
        throw Error('usage: --companion <account> <specialist> <supplier|supplier-tank|tank> <hitpoints|strength|defence> <offsetX> <stopFile>');
    }
    const role = roleRaw as 'supplier' | 'supplier-tank' | 'tank';
    const board = boardRaw as 'hitpoints' | 'strength' | 'defence';
    const s = await openBot(account);
    try {
        const res = await runCompanionRole(s, {
            role,
            specialistName: specialist,
            kit: role === 'tank' ? undefined : KIT_BY_BOARD[board],
            postTileOffsetX: Number(offsetRaw ?? 0),
            stopFile,
            cap: 20000,
        });
        await finish([s], res.ok, res.detail);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

async function runCoordinatorMain(args: string[]): Promise<void> {
    const [bot, modeRaw, supplier, tank] = args;
    if (!bot || !modeRaw || !supplier || !(modeRaw in SPECIALIST_SCRIPT)) {
        throw Error('usage: specialist-combat-quests-cases.ts <bot> <hp|strength|defence> <supplier> [tank]');
    }
    const mode = modeRaw as 'hp' | 'strength' | 'defence';
    const board = SPECIALIST_BOARD[mode];
    const specialistScript = SPECIALIST_SCRIPT[mode];

    // Remove the bench starter save so the specialist logs into Tutorial Island at playtime=0.
    rmSync(playerSavePath(bot), { force: true });

    const stopRel = `.practice/aio-bench/stop-${bot}.flag`;
    const stopAbs = resolve(ROOT, stopRel);
    mkdirSync(dirname(stopAbs), { recursive: true });
    rmSync(stopAbs, { force: true });

    const guardDisabledEnv = {
        FLEE_GUARD: '0',
        DEATH_RECOVERY: '0',
        VALUE_GUARD: '0',
        LOOT_WATCH: '0',
        PRAYER_GUARD: '0',
        EAT_GUARD: '0',
        RANDOM_EVENTS: '0',
    };

    const companionEnv = {
        ...process.env,
        ...guardDisabledEnv,
        STALL_TICKS: '0',
        DEMO_OK: '',
        COORDINATOR_RUN_ID: '',
    };

    const specs: { account: string; role: 'supplier' | 'supplier-tank' | 'tank'; offsetX: number }[] =
        mode === 'hp'
            ? [{ account: supplier, role: 'supplier', offsetX: 0 }]
            : [
                { account: supplier, role: 'supplier-tank', offsetX: 1 },
                ...(tank ? [{ account: tank, role: 'tank' as const, offsetX: 0 }] : []),
            ];

    const procs: ReturnType<typeof Bun.spawn>[] = [];
    const pumps: Promise<void>[] = [];

    const spawnCompanion = (c: { account: string; role: 'supplier' | 'supplier-tank' | 'tank'; offsetX: number }): Promise<void> => {
        const proc = Bun.spawn(
            [
                'bun',
                resolve(ROOT, 'scripts/measure/specialist-combat-quests-cases.ts'),
                '--companion',
                c.account,
                bot,
                c.role,
                board,
                String(c.offsetX),
                stopRel,
            ],
            { cwd: ROOT, env: companionEnv, stdout: 'pipe', stderr: 'pipe', windowsHide: true },
        );
        procs.push(proc);

        let resolveReady!: () => void;
        let rejectReady!: (err: Error) => void;
        const readyPromise = new Promise<void>((res, rej) => {
            resolveReady = res;
            rejectReady = rej;
        });
        let ready = false;
        pumps.push(
            pumpPrefixed(proc.stdout as ReadableStream<Uint8Array>, 'COMPANION ', process.stdout, line => {
                if (!ready && line.includes('COMPANION_READY ')) {
                    ready = true;
                    resolveReady();
                }
            }),
            pumpPrefixed(proc.stderr as ReadableStream<Uint8Array>, 'COMPANION_ERR ', process.stderr),
        );
        void proc.exited.then(code => {
            if (!ready) rejectReady(Error(`companion ${c.account} exited (${code}) before COMPANION_READY`));
        });
        return readyPromise;
    };

    let specProc: ReturnType<typeof Bun.spawn> | undefined;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            Promise.all(specs.map(spawnCompanion)),
            new Promise<never>((_, rej) => {
                readyTimer = setTimeout(() => rej(Error('companions did not log COMPANION_READY within 60 s')), 60_000);
            }),
        ]);
        clearTimeout(readyTimer);

        const tankEnv = tank ? `${supplier},${tank}` : supplier;
        specProc = Bun.spawn(['bun', resolve(ROOT, specialistScript), bot], {
            cwd: ROOT,
            env: {
                ...process.env,
                ...guardDisabledEnv,
                PRACTICE_SUPPLIER: supplier,
                PRACTICE_TANKS: tankEnv,
                DEMO_OK: '',
                COORDINATOR_RUN_ID: '',
            },
            stdout: 'pipe',
            stderr: 'pipe',
            windowsHide: true,
        });

        const outDone = pumpPrefixed(specProc.stdout as ReadableStream<Uint8Array>, '', process.stdout);
        const errDone = pumpPrefixed(specProc.stderr as ReadableStream<Uint8Array>, '', process.stderr);
        const [specCode] = await Promise.all([specProc.exited, outDone, errDone]);
        process.exitCode = specCode;
    } finally {
        clearTimeout(readyTimer);
        if (specProc && specProc.exitCode === null) await killTree(specProc.pid).catch(() => {});
        writeFileSync(stopAbs, 'stop\n');
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            Promise.allSettled(procs.map(p => p.exited)),
            new Promise<void>(r => { stopTimer = setTimeout(r, 10_000); }),
        ]).finally(() => clearTimeout(stopTimer));
        for (const p of procs) {
            if (p.exitCode === null) await killTree(p.pid).catch(() => {});
        }
        await Promise.allSettled(pumps);
        if (existsSync(stopAbs)) rmSync(stopAbs, { force: true });
    }
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const entry = args[0] === '--companion' ? runCompanionMain(args.slice(1)) : runCoordinatorMain(args);
    entry.catch(err => {
        console.log(`RESULT fail ${String(err instanceof Error ? err.message : err)}`);
        process.exit(1);
    });
}
