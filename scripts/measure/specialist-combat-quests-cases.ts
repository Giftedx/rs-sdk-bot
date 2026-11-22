// Bench cases and multi-actor fresh-clock coordinator for Hitpoints, Strength, and Defence combat-quest specialists.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { finish, openBot } from '../../packages/core/src/bot';
import type { SaveConfig } from '../../packages/practice/src/presets';
import { killTree } from '../../packages/core/src/proc';
import type { RehearsalReport } from '../../packages/practice/src/rehearse';
import { playerSavePath } from '../../packages/practice/src/save-library';
import { scoredClock } from '../../packages/practice/src/specialist-rehearsal';
import {
    DEFENCE_SPECIALIST_KIT,
    HP_SPECIALIST_KIT,
    KIT_BY_BOARD,
    SPECIALIST_TARGETS,
    STRENGTH_SPECIALIST_KIT,
    runCompanionRole,
    type KitSpecItem,
} from '../combat-quest-specialists';
import type { BenchCase } from './bench-case-types';

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
    Magic: 45,
    Ranged: 99,
} as const;

const TANK_BANK = [
    { id: 563, count: 100 },
    { id: 2552, count: 50 },
    { id: 391, count: 1500 },
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

export function tankPostPresetConfig(offsetX = 0): SaveConfig {
    return {
        position: offsetX === 2 ? { x: 3154, z: 3923, level: 0 } : { x: 3154, z: 3924, level: 0 },
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
        scriptArgs: ['strength', '{bot:s}', '{bot:t}', '{bot:u}'],
        companions: [
            { suffix: 's', preset: 'fresh_lumbridge', presetConfig: tankSupplierPresetConfig(STRENGTH_SPECIALIST_KIT) },
            { suffix: 't', preset: 'fresh_lumbridge', presetConfig: tankPostPresetConfig(0) },
            { suffix: 'u', preset: 'fresh_lumbridge', presetConfig: tankPostPresetConfig(2) },
        ],
        timeoutMs: 900_000,
        pass: s => ok(s) && /strength=99\b/.test(s) && observedTicks(s) <= SPECIALIST_TARGETS.strength.targetTicks && loggedOutOnce(s),
    },
    {
        key: 'fighter:specialist-defence',
        script: 'scripts/measure/specialist-combat-quests-cases.ts',
        preset: 'fresh_lumbridge',
        presetConfig: {},
        scriptArgs: ['defence', '{bot:s}', '{bot:t}', '{bot:u}'],
        companions: [
            { suffix: 's', preset: 'fresh_lumbridge', presetConfig: tankSupplierPresetConfig(DEFENCE_SPECIALIST_KIT) },
            { suffix: 't', preset: 'fresh_lumbridge', presetConfig: tankPostPresetConfig(0) },
            { suffix: 'u', preset: 'fresh_lumbridge', presetConfig: tankPostPresetConfig(2) },
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
            board,
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
    const [bot, modeRaw, supplier, ...tanks] = args;
    if (!bot || !modeRaw || !supplier || !(modeRaw in SPECIALIST_SCRIPT)) {
        throw Error('usage: specialist-combat-quests-cases.ts <bot> <hp|strength|defence> <supplier> [tank...]');
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
                ...tanks.map((t, i) => ({ account: t, role: 'tank' as const, offsetX: i === 0 ? 0 : i + 1 })),
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

        const tankEnv = [supplier, ...tanks].join(',');
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

const REHEARSE_GUARD_ENV: Record<string, string> = {
    FLEE_GUARD: '0',
    DEATH_RECOVERY: '0',
    VALUE_GUARD: '0',
    LOOT_WATCH: '0',
    PRAYER_GUARD: '0',
    EAT_GUARD: '0',
    RANDOM_EVENTS: '0',
    STALL_TICKS: '0',
};

export function buildCombatSpecialistRehearsalSegment(
    accountRaw: string,
    opts?: { planTicks?: number },
) {
    const key = accountRaw.trim().toLowerCase();
    const override = opts?.planTicks;
    if (key === 'fullblooded') {
        return {
            specialist: 'FullBlooded',
            id: 'fullblooded-hitpoints',
            start: { fresh: true as const },
            script: 'scripts/hp-specialist.ts',
            env: { CAP: '12000' },
            supplier: {
                script: 'scripts/aio-logistics.ts',
                args: ['specialist-supplier', '{ACTOR}', '--kit=hp', '12000'],
                env: { ...REHEARSE_GUARD_ENV },
                save: { position: { x: 3223, z: 3222, level: 0 }, inventory: kitToSaveInventory(HP_SPECIALIST_KIT) },
            },
            plan: { ticks: override ?? 8475, source: '400ms rehearsals & hosted-bench fighter:specialist-hp median ~8475t (<=11116t vs #1 11343t)' },
            expect: { skills: { Hitpoints: 99 } },
            timeoutMs: 900_000,
        };
    }
    if (key === 'bigswinger' || key === 'rocksolid') {
        const isStr = key === 'bigswinger';
        const board = isStr ? 'strength' : 'defence';
        const skill = isStr ? 'Strength' : 'Defence';
        const cap = isStr ? '6000' : '7500';
        const kit = isStr ? STRENGTH_SPECIALIST_KIT : DEFENCE_SPECIALIST_KIT;
        const planTicks = override ?? (isStr ? 2230 : 2838);
        return {
            specialist: isStr ? 'BigSwinger' : 'RockSolid',
            id: isStr ? 'bigswinger-strength' : 'rocksolid-defence',
            start: { fresh: true as const },
            script: isStr ? 'scripts/strength-specialist.ts' : 'scripts/defence-specialist.ts',
            env: { CAP: cap },
            suppliers: [
                {
                    script: 'scripts/measure/specialist-combat-quests-cases.ts',
                    args: ['--companion', '{ACTOR}', 'supplier-tank', board, '1'],
                    env: { ...REHEARSE_GUARD_ENV },
                    save: tankSupplierPresetConfig(kit),
                },
                {
                    script: 'scripts/measure/specialist-combat-quests-cases.ts',
                    args: ['--companion', '{ACTOR}', 'tank', board, '0'],
                    env: { ...REHEARSE_GUARD_ENV },
                    save: tankPostPresetConfig(0),
                },
                {
                    script: 'scripts/measure/specialist-combat-quests-cases.ts',
                    args: ['--companion', '{ACTOR}', 'tank', board, '2'],
                    env: { ...REHEARSE_GUARD_ENV },
                    save: tankPostPresetConfig(2),
                },
            ],
            plan: {
                ticks: planTicks,
                source: isStr
                    ? 'Waterfall + 1-tick Rune 2h relog Keep PvP (<=3222t vs #1 3288t)'
                    : 'Waterfall + 1-tick Rune 2h relog Keep PvP (<=4236t vs #1 4323t)',
            },
            expect: { skills: { [skill]: 99 } },
            timeoutMs: 900_000,
        };
    }
    throw Error(`unknown combat specialist account "${accountRaw}" (expected FullBlooded, BigSwinger, RockSolid)`);
}

async function runRehearseMain(args: string[]): Promise<void> {
    const accounts: string[] = [];
    let planTicks: number | undefined;
    let runs = 1;
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === '--all') {
            accounts.push('FullBlooded', 'BigSwinger', 'RockSolid');
        } else if (a.startsWith('--plan-ticks=')) {
            planTicks = Number(a.slice('--plan-ticks='.length));
        } else if (a === '--plan-ticks') {
            planTicks = Number(args[++i]);
        } else if (a.startsWith('--runs=')) {
            runs = Math.max(1, Number(a.slice('--runs='.length)));
        } else if (a === '--runs') {
            runs = Math.max(1, Number(args[++i]));
        } else if (!a.startsWith('-')) {
            accounts.push(a);
        }
    }
    if (accounts.length === 0) throw Error('usage: specialist-combat-quests-cases.ts --rehearse <FullBlooded|BigSwinger|RockSolid|--all> [--plan-ticks=<n>] [--runs=<n>]');

    const engineDir = join(ROOT, 'vendor', 'rs-sdk', 'server', 'engine');
    if (!existsSync(join(engineDir, 'data', 'pack', 'server', 'script.dat'))) {
        const built = Bun.spawnSync(['bun', 'run', 'build'], { cwd: engineDir, stdout: 'inherit', stderr: 'inherit', windowsHide: true });
        if (built.exitCode !== 0) throw Error(`engine asset build failed (${built.exitCode})`);
    }

    const baseOut = join(ROOT, '.practice', 'hosted-rehearse');
    mkdirSync(baseOut, { recursive: true });
    let allOk = true;
    for (const acc of accounts) {
        const seg = buildCombatSpecialistRehearsalSegment(acc, { planTicks });
        const segFile = join(baseOut, `${seg.specialist.toLowerCase()}.segment.json`);
        writeFileSync(segFile, JSON.stringify(seg, null, 2) + '\n');
        for (let runIdx = 1; runIdx <= runs; runIdx++) {
            const suffix = runs > 1 ? `-r${runIdx}` : '';
            const outRel = `.practice/hosted-rehearse/${seg.specialist.toLowerCase()}${suffix}`;
            const outAbs = resolve(ROOT, outRel);
            rmSync(outAbs, { recursive: true, force: true });
            const proc = Bun.spawn(['bun', 'packages/practice/src/rehearse.ts', '--specialist', segFile, '--start', '--out', outRel], {
                cwd: ROOT,
                stdout: 'inherit',
                stderr: 'inherit',
                windowsHide: true,
            });
            const code = await proc.exited;
            const reportPath = join(outAbs, `${seg.id}.json`);
            const receiptPath = join(outAbs, `${seg.id}.receipt.json`);
            const report = existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, 'utf8')) as RehearsalReport) : null;
            const receipt = existsSync(receiptPath) ? (JSON.parse(readFileSync(receiptPath, 'utf8')) as { endPlaytime?: number; boardTicks?: Record<string, number> }) : null;
            let boardTicks = receipt?.boardTicks ?? null;
            let endPlaytime = receipt?.endPlaytime ?? null;
            const board = Object.keys(seg.expect.skills)[0]!;
            if (!receipt && report?.account) {
                try {
                    const c = scoredClock(readFileSync(playerSavePath(report.account)), board);
                    boardTicks = { [board]: c.boardTick };
                    endPlaytime = c.endPlaytime;
                } catch { /* no save */ }
            }
            console.log('COMBAT_REHEARSAL_SUMMARY ' + JSON.stringify({
                account: seg.specialist,
                run: runIdx,
                runs,
                board,
                code,
                ok: report?.ok === true,
                wholeClock: report?.checks?.wholeClock === true,
                planTicks: seg.plan.ticks,
                ticks: report?.ticks ?? null,
                checks: report?.checks ?? null,
                boardTicks,
                endPlaytime,
                scope: report?.scope ?? null,
                outDir: relative(ROOT, outAbs).replaceAll('\\', '/'),
            }));
            if (code !== 0 || report?.ok !== true || report?.checks?.wholeClock !== true) {
                allOk = false;
                const logPath = join(outAbs, `${seg.id}.log`);
                if (existsSync(logPath)) {
                    console.log(`--- ${seg.id}${suffix}.log tail ---\n` + readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-50).join('\n'));
                }
            }
        }
    }
    if (!allOk) process.exitCode = 1;
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const entry = args[0] === '--companion'
        ? runCompanionMain(args.slice(1))
        : args[1] === '--companion'
            ? runCompanionMain([args[0]!, ...args.slice(2)])
            : args[0] === '--rehearse'
                ? runRehearseMain(args.slice(1))
                : runCoordinatorMain(args);
    entry.catch(err => {
        console.log(`RESULT fail ${String(err instanceof Error ? err.message : err)}`);
        process.exit(1);
    });
}
