// Sequential isolated rehearsal chaining Haggis Stages 2 -> 3 -> 4 -> 5 -> 6 -> 7 on one account
// with zero Super energy(4) usage (NODE_INFINITE_RUN=true).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { PRACTICE_STARTUP_GB } from '../../packages/core/src/memory';
import { createBot } from '../../packages/practice/src/bots';
import { rsSdkRoot } from '../../packages/practice/src/paths';
import { applyPreset } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { ISOLATED, pointBotAt, startIsolatedStack } from '../../packages/practice/src/rehearse';
import { playerSavePath } from '../../packages/practice/src/save-library';
import {
    LUMBRIDGE_KITCHEN,
    assertSafeStage2Accounts,
    buildStage2Plan,
    runHaggisStage2,
    type Stage2Phases,
} from './haggis-stage2';
import { buildStage3Plan, runHaggisStage3, type Stage3Phases } from './haggis-stage3';
import { buildStage4Plan, runHaggisStage4, type Stage4Phases } from './haggis-stage4';
import { buildStage5Plan, runHaggisStage5, type Stage5Phases } from './haggis-stage5';
import { buildStage6Plan, runHaggisStage6, type Stage6Phases } from './haggis-stage6';
import { buildStage7Plan, runHaggisStage7, type Stage7Phases } from './haggis-stage7';

export const SUPER_ENERGY_IDS = [3016, 3018, 3020, 3022] as const;

export interface StageSeqPlan {
    readonly startingPosition: typeof LUMBRIDGE_KITCHEN;
    readonly startingSkills: Readonly<Record<string, number>>;
    readonly startingVarps: Readonly<Record<number, number>>;
    readonly mainInventory: ReadonlyArray<{ id: number; count: number }>;
    readonly helperChunks: ReturnType<typeof buildStage2Plan>['helperChunks'];
    readonly mainBank: ReadonlyArray<{ id: number; count: number }>;
}

export interface StageSeqPhases {
    readonly stage2: Stage2Phases;
    readonly stage3: Stage3Phases;
    readonly stage4: Stage4Phases;
    readonly stage5: Stage5Phases;
    readonly stage6: Stage6Phases;
    readonly stage7: Stage7Phases;
    readonly sumStageTicks: number;
    readonly endPlaytime: number | null;
}

/** Merges bank item stacks across sequential stages, summing counts for shared item IDs. */
export function mergeBankStacks(
    ...lists: ReadonlyArray<ReadonlyArray<{ id: number; count: number }>>
): { id: number; count: number }[] {
    const merged = new Map<number, number>();
    for (const list of lists) {
        for (const item of list) {
            merged.set(item.id, (merged.get(item.id) ?? 0) + item.count);
        }
    }
    return [...merged.entries()].map(([id, count]) => ({ id, count }));
}

/** Validates main + Stage-2 helper account names are non-empty and free of reserved names. */
export function assertSafeStageSeqAccounts(mainName: string): { readonly mainName: string; readonly helperNames: readonly string[] } {
    return assertSafeStage2Accounts(mainName, buildStage2Plan().helperChunks.length);
}

/** Builds the unified sequential starting preset and combined bank across Stages 2..7. */
export function buildStageSeqPlan(): StageSeqPlan {
    const s2 = buildStage2Plan();
    const s3 = buildStage3Plan();
    const s4 = buildStage4Plan();
    const s5 = buildStage5Plan();
    const s6 = buildStage6Plan();
    const s7 = buildStage7Plan();
    return {
        startingPosition: LUMBRIDGE_KITCHEN,
        startingSkills: { Cooking: 99, Fletching: 99, Hitpoints: 10 },
        startingVarps: { 29: 2, 173: 1 },
        mainInventory: s2.mainInventory,
        helperChunks: s2.helperChunks,
        mainBank: mergeBankStacks(s2.mainBank, s3.mainBank, s4.mainBank, s5.mainBank, s6.mainBank, s7.mainBank),
    };
}

function readPlaytimeTicks(account: string): number | null {
    try {
        return readFileSync(playerSavePath(account)).readInt32BE(24);
    } catch {
        return null;
    }
}

function ensurePackedGameAssets(): void {
    const engineDir = join(rsSdkRoot(), 'server', 'engine');
    const packed = join(engineDir, 'data', 'pack', 'server', 'script.dat');
    if (existsSync(packed)) return;
    console.log('Packing rs-sdk engine game assets for sequential Stage 2..7 rehearsal...');
    const res = Bun.spawnSync(['bun', 'run', 'build'], { cwd: engineDir, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
    if (res.exitCode !== 0 || !existsSync(packed)) throw Error(`failed packing rs-sdk game assets (exit=${res.exitCode})`);
}

/** Runs Stages 2 -> 3 -> 4 -> 5 -> 6 -> 7 sequentially against a single account and server stack. */
export async function runHaggisStageSeq(mainName: string, helperNames: readonly string[]): Promise<StageSeqPhases> {
    const stage2 = (await runHaggisStage2(mainName)).phases;
    const stage3 = (await runHaggisStage3(mainName)).phases;
    const stage4 = (await runHaggisStage4(mainName)).phases;
    const stage5 = (await runHaggisStage5(mainName)).phases;
    const stage6 = (await runHaggisStage6(mainName)).phases;
    const stage7 = (await runHaggisStage7(mainName)).phases;
    const sumStageTicks = stage2.totalElapsedTicks
        + stage3.totalElapsedTicks
        + stage4.totalElapsedTicks
        + stage5.totalElapsedTicks
        + stage6.totalElapsedTicks
        + stage7.totalElapsedTicks;
    const endPlaytime = readPlaytimeTicks(mainName);
    if (helperNames.length === 0) throw Error('haggis-stage-seq: missing helperNames');
    return { stage2, stage3, stage4, stage5, stage6, stage7, sumStageTicks, endPlaytime };
}

async function runIsolated(): Promise<void> {
    const freeGiB = freemem() / 2 ** 30;
    if (freeGiB < PRACTICE_STARTUP_GB) {
        throw Error(`haggis-stage-seq --isolated needs ${PRACTICE_STARTUP_GB} GiB free (currently ${freeGiB.toFixed(1)} GiB); run via hosted CI measure_script`);
    }
    ensurePackedGameAssets();
    process.env.SIM_LOCKSTEP = '1';
    process.env.RANDOM_EVENTS ??= '0';
    process.env.DEMO_OK = '';

    const plan = buildStageSeqPlan();
    const { mainName, helperNames } = assertSafeStageSeqAccounts(runBotName('hseq', 1));
    const botsDir = join(rsSdkRoot(), 'bots');
    const allNames = [mainName, ...helperNames];
    const cleanup = () => {
        for (const n of allNames) {
            rmSync(join(botsDir, n), { recursive: true, force: true });
            rmSync(playerSavePath(n), { force: true });
        }
    };
    cleanup();

    try {
        const createdMain = await createBot(mainName);
        pointBotAt(createdMain.envPath, ISOLATED.engine, ISOLATED.gateway, 'localhost');
        await applyPreset(mainName, {
            position: { ...plan.startingPosition },
            skills: { ...plan.startingSkills },
            varps: { ...plan.startingVarps },
            inventory: [...plan.mainInventory],
            bank: [...plan.mainBank],
        });
        for (let k = 0; k < plan.helperChunks.length; k++) {
            const hName = helperNames[k]!;
            const chunk = plan.helperChunks[k]!;
            const createdHelper = await createBot(hName);
            pointBotAt(createdHelper.envPath, ISOLATED.engine, ISOLATED.gateway, 'localhost');
            await applyPreset(hName, {
                position: { x: chunk[0]!.x, z: chunk[0]!.z, level: 0 },
                varps: { 173: 1 },
                inventory: chunk.map(p => ({ id: p.id, count: 1 })),
            });
        }
        const stack = await startIsolatedStack();
        try {
            const res = await runHaggisStageSeq(mainName, helperNames);
            console.log(
                `STAGE_SEQ pass playtime=${res.endPlaytime} sumStages=${res.sumStageTicks}`
                + ` s2=${res.stage2.totalElapsedTicks}`
                + ` s3=${res.stage3.totalElapsedTicks}`
                + ` s4=${res.stage4.totalElapsedTicks}`
                + ` s5=${res.stage5.totalElapsedTicks}`
                + ` s6=${res.stage6.totalElapsedTicks}`
                + ` s7=${res.stage7.totalElapsedTicks}`,
            );
        } finally {
            await stack.stop();
        }
    } finally {
        cleanup();
    }
}

if (import.meta.main) {
    try {
        await runIsolated();
        process.exit(0);
    } catch (err) {
        console.error(`STAGE_SEQ fail ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
