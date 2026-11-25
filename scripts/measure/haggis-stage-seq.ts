// Sequential isolated rehearsal chaining Haggis Stage 1 (haggis-first-five: Tutorial -> Trade 1 -> Al Kharid bank wine ->
// Cook's Assistant -> Relog Login-Wine + Fletch 99) -> Stage 2..7 on a fresh level-1 account with zero Super energy(4).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../packages/core/src/inprocess';
import { PRACTICE_STARTUP_GB } from '../../packages/core/src/memory';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import { createBot } from '../../packages/practice/src/bots';
import {
    bankOpen,
    countId,
    dialogOpen,
    inv,
    meter,
    openBank,
    send,
    tick,
    withdrawN,
} from '../../packages/practice/src/floor-lib';
import { rsSdkRoot } from '../../packages/practice/src/paths';
import { applyPreset } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { ISOLATED, pointBotAt, startIsolatedStack } from '../../packages/practice/src/rehearse';
import { playerSavePath } from '../../packages/practice/src/save-library';
import { GLORY_IDS } from '../fast-skills-lib';
import {
    HELPER_SPAWN,
    OBJ_COINS,
    OBJ_GLORY_4,
    openBot,
    receiveTradeFast,
    rubTeleport,
    settle,
    settleHelper,
    startHelperTradeArm,
    waitUntil,
    walkWaypointsSafe,
} from '../gathering-specialist-lib';
import {
    DEFAULT_WINE_COUNT,
    assertSafeRehearsalAccounts,
    buildFirstFiveSupplies,
    runHaggisFirstFive,
    type FirstFivePhases,
} from './haggis-first-five';
import {
    DRAYNOR_BANK,
    OBJ_TINDERBOX,
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
const BANKER_SUFFIXES = ['k', 'l', 'm'] as const;
const DRAYNOR_BANKER_POS = { x: 3092, z: 3244, level: 0 } as const;

export interface StageSeqAccountSet {
    readonly mainName: string;
    readonly stage1HelperName: string;
    readonly bankerNames: readonly string[];
    readonly fmHelperNames: readonly string[];
}

export interface StageSeqPlan {
    readonly stage1Supplies: Readonly<Record<number, number>>;
    readonly packLogsCounts: ReadonlyArray<{ id: number; count: number }>;
    readonly bankerBatches: ReadonlyArray<ReadonlyArray<{ id: number; count: number }>>;
    readonly stage2to7Bank: ReadonlyArray<{ id: number; count: number }>;
    readonly fmHelperChunks: ReturnType<typeof buildStage2Plan>['helperChunks'];
}

export interface StageSeqPhases {
    readonly stage1: FirstFivePhases;
    readonly stage1To2Ticks: number;
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

/** Loads itemId -> noted certId mapping from rs-sdk obj.pack. */
export function loadCertIdMap(packPath = join(rsSdkRoot(), 'server', 'content', 'pack', 'obj.pack')): Map<number, number> {
    const raw = readFileSync(packPath, 'utf8');
    const idToName = new Map<number, string>();
    const nameToId = new Map<string, number>();
    for (const line of raw.split(/\r?\n/)) {
        const m = /^(\d+)=(.+)$/.exec(line.trim());
        if (!m) continue;
        const id = Number(m[1]);
        const name = m[2]!;
        idToName.set(id, name);
        nameToId.set(name, id);
    }
    const certMap = new Map<number, number>();
    for (const [id, name] of idToName) {
        const certId = nameToId.get(`cert_${name}`);
        if (certId !== undefined) certMap.set(id, certId);
    }
    return certMap;
}

/** Validates main, Stage-1 helper, Draynor banker mules, and Stage-2 FM helper account names. */
export function assertSafeStageSeqAccounts(mainName: string): StageSeqAccountSet {
    const cleanMain = mainName.trim();
    const stage2 = assertSafeStage2Accounts(cleanMain, buildStage2Plan().helperChunks.length);
    if (cleanMain.length > 11) throw Error(`haggis-stage-seq: mainName "${cleanMain}" exceeds 11 chars`);
    const stage1HelperName = `${cleanMain}h`;
    assertSafeRehearsalAccounts(cleanMain, stage1HelperName);
    const bankerNames = BANKER_SUFFIXES.map(s => `${cleanMain}${s}`);
    const reserved = new Set(RESERVED_ACCOUNTS.map(n => n.toLowerCase()));
    for (const name of bankerNames) {
        if (reserved.has(name.toLowerCase())) {
            throw Error(`haggis-stage-seq: refuses reserved banker account ${name}`);
        }
    }
    return {
        mainName: stage2.mainName,
        stage1HelperName,
        bankerNames,
        fmHelperNames: stage2.helperNames,
    };
}

/** Builds Stage 1 supplies, Draynor banker note batches, and unified Stage 2..7 bank counts. */
export function buildStageSeqPlan(wineCount = DEFAULT_WINE_COUNT): StageSeqPlan {
    const s2 = buildStage2Plan();
    const s3 = buildStage3Plan();
    const s4 = buildStage4Plan();
    const s5 = buildStage5Plan();
    const s6 = buildStage6Plan();
    const s7 = buildStage7Plan();
    const packLogsCounts = mergeBankStacks(s2.packLogs.map(p => ({ id: p.id, count: 1 })));
    const stage2to7Bank = mergeBankStacks(
        s2.mainBank,
        s3.mainBank,
        s4.mainBank,
        s5.mainBank,
        s6.mainBank,
        s7.mainBank,
        [{ id: OBJ_GLORY_4, count: 1 }, { id: OBJ_TINDERBOX, count: 1 }],
        packLogsCounts,
    );
    const certMap = loadCertIdMap();
    const tradeableStacks = stage2to7Bank.map(item => ({
        id: certMap.get(item.id) ?? item.id,
        count: item.count,
    }));
    const bankerBatches: { id: number; count: number }[][] = [];
    for (let i = 0; i < tradeableStacks.length; i += 28) {
        bankerBatches.push(tradeableStacks.slice(i, i + 28));
    }
    if (bankerBatches.length > BANKER_SUFFIXES.length) {
        throw Error(`haggis-stage-seq: need ${bankerBatches.length} banker batches > ${BANKER_SUFFIXES.length} suffixes`);
    }
    return {
        stage1Supplies: buildFirstFiveSupplies(wineCount),
        packLogsCounts,
        bankerBatches,
        stage2to7Bank,
        fmHelperChunks: s2.helperChunks,
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
    console.log('Packing rs-sdk engine game assets for sequential Stage 1..7 rehearsal...');
    const res = Bun.spawnSync(['bun', 'run', 'build'], { cwd: engineDir, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
    if (res.exitCode !== 0 || !existsSync(packed)) throw Error(`failed packing rs-sdk game assets (exit=${res.exitCode})`);
}

async function depositAllOpenBank(main: Session, m: ReturnType<typeof meter>, isStopped: () => boolean): Promise<void> {
    if (dialogOpen(main)) await send(main, m, { type: 'closeModal' });
    if (await openBank(main, m) < 0) throw Error('haggis-stage-seq: Draynor bank did not open');
    const seen = new Set<number>();
    for (const it of inv(main)) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        await send(main, m, { type: 'bankDeposit', slot: it.slot, amount: -1 });
    }
    const cleared = await waitUntil(main, () => inv(main).length === 0 || isStopped(), { timeoutTicks: 15 });
    if (!cleared || inv(main).length > 0) throw Error('haggis-stage-seq: failed clearing inventory at Draynor bank');
}

/** Teleports post-Stage-1 account from Lumbridge Kitchen to Draynor Bank, banks Stage 2..7 supplies via trade, and equips Stage 2 kit. */
export async function transitionStage1To2(
    mainName: string,
    bankerNames: readonly string[],
    plan: StageSeqPlan,
    cap = 250,
): Promise<number> {
    let stopFlag = false;
    let settling = false;
    const main = await openBot(mainName, {
        onStop: async () => { stopFlag = true; },
        onSessionEnd: async (_s, detail) => { if (!settling) throw Error(`unexpected stage1->2 end: ${detail}`); },
    });
    const t0 = main.tick();
    const isStopped = () => stopFlag || main.tick() - t0 >= cap;
    const m = meter(main, 'Firemaking');

    try {
        await tick(main, 2);
        await rubTeleport(
            main,
            GLORY_IDS,
            /draynor/i,
            p => p.level === 0 && p.worldX >= 3098 && p.worldX <= 3115 && p.worldZ >= 3240 && p.worldZ <= 3260,
            isStopped,
        );
        await walkWaypointsSafe(main, [[DRAYNOR_BANK.x, DRAYNOR_BANK.z, 2]], isStopped);

        await depositAllOpenBank(main, m, isStopped);
        await send(main, m, { type: 'closeModal' });
        await waitUntil(main, () => !bankOpen(main), { timeoutTicks: 8 });

        for (let b = 0; b < plan.bankerBatches.length; b++) {
            const batch = plan.bankerBatches[b]!;
            const banker = await openBot(bankerNames[b]!, { onStop: async () => { stopFlag = true; } });
            const arm = startHelperTradeArm(banker, mainName, isStopped);
            const expected: Record<number, number> = {};
            for (const item of batch) expected[item.id] = (expected[item.id] ?? 0) + item.count;
            try {
                await receiveTradeFast(main, banker, expected, isStopped, arm);
            } finally {
                arm.close();
                await settleHelper(banker);
            }
            await depositAllOpenBank(main, m, isStopped);
            if (b < plan.bankerBatches.length - 1) {
                await send(main, m, { type: 'closeModal' });
                await waitUntil(main, () => !bankOpen(main), { timeoutTicks: 8 });
            }
        }

        const stage2Need: { id: number; count: number }[] = [
            { id: OBJ_GLORY_4, count: 1 },
            { id: OBJ_TINDERBOX, count: 1 },
            ...plan.packLogsCounts,
        ];
        for (const req of stage2Need) {
            const bankSlot = main.sdk.getState()?.bank?.items.find(x => x.id === req.id && x.count >= req.count);
            if (!bankSlot) throw Error(`haggis-stage-seq: Draynor bank missing Stage 2 item ${req.id} (need ${req.count})`);
            await withdrawN(main, m, bankSlot.slot, req.count);
            const got = await waitUntil(main, () => countId(main, req.id) >= req.count, { timeoutTicks: 10 });
            if (!got) throw Error(`haggis-stage-seq: Stage 2 withdraw ${req.id} timed out`);
        }
        await send(main, m, { type: 'closeModal' });
        await waitUntil(main, () => !bankOpen(main), { timeoutTicks: 8 });

        const elapsed = main.tick() - t0;
        settling = true;
        const ok = await settle([main], inv(main).length === 28 && countId(main, OBJ_TINDERBOX) === 1, 'stage1->stage2 ready');
        if (!ok) throw Error(`haggis-stage-seq: transitionStage1To2 end check failed (inv=${inv(main).length})`);
        return elapsed;
    } catch (error) {
        stopFlag = true;
        settling = true;
        await settle([main], false, String(error)).catch(() => {});
        throw error;
    }
}

/** Runs Stages 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 sequentially on a fresh level-1 Tutorial Island account. */
export async function runHaggisStageSeq(
    accounts: StageSeqAccountSet,
    plan: StageSeqPlan,
    wineCount = DEFAULT_WINE_COUNT,
): Promise<StageSeqPhases> {
    const stage1 = (await runHaggisFirstFive(accounts.mainName, accounts.stage1HelperName, {
        wineCount,
        savePort: ISOLATED.save,
        cap: 600,
    })).phases;
    const stage1To2Ticks = await transitionStage1To2(accounts.mainName, accounts.bankerNames, plan);
    const stage2 = (await runHaggisStage2(accounts.mainName)).phases;
    const stage3 = (await runHaggisStage3(accounts.mainName)).phases;
    const stage4 = (await runHaggisStage4(accounts.mainName)).phases;
    const stage5 = (await runHaggisStage5(accounts.mainName)).phases;
    const stage6 = (await runHaggisStage6(accounts.mainName)).phases;
    const stage7 = (await runHaggisStage7(accounts.mainName)).phases;
    const sumStageTicks = stage1.totalElapsedTicks
        + stage1To2Ticks
        + stage2.totalElapsedTicks
        + stage3.totalElapsedTicks
        + stage4.totalElapsedTicks
        + stage5.totalElapsedTicks
        + stage6.totalElapsedTicks
        + stage7.totalElapsedTicks;
    const endPlaytime = readPlaytimeTicks(accounts.mainName);
    return { stage1, stage1To2Ticks, stage2, stage3, stage4, stage5, stage6, stage7, sumStageTicks, endPlaytime };
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

    const wineCount = Number(process.env.WINE_COUNT ?? DEFAULT_WINE_COUNT);
    const plan = buildStageSeqPlan(wineCount);
    const accounts = assertSafeStageSeqAccounts(runBotName('hseq', 1));
    const botsDir = join(rsSdkRoot(), 'bots');
    const allNames = [
        accounts.mainName,
        accounts.stage1HelperName,
        ...accounts.bankerNames.slice(0, plan.bankerBatches.length),
        ...accounts.fmHelperNames,
    ];
    const cleanup = () => {
        for (const n of allNames) {
            rmSync(join(botsDir, n), { recursive: true, force: true });
            rmSync(playerSavePath(n), { force: true });
        }
    };
    cleanup();

    try {
        const createdMain = await createBot(accounts.mainName);
        pointBotAt(createdMain.envPath, ISOLATED.engine, ISOLATED.gateway, 'localhost');

        const createdS1H = await createBot(accounts.stage1HelperName);
        pointBotAt(createdS1H.envPath, ISOLATED.engine, ISOLATED.gateway, 'localhost');
        await applyPreset(accounts.stage1HelperName, {
            position: HELPER_SPAWN,
            coins: plan.stage1Supplies[OBJ_COINS],
            inventory: Object.entries(plan.stage1Supplies)
                .filter(([id]) => Number(id) !== OBJ_COINS)
                .map(([id, count]) => ({ id: Number(id), count })),
        });

        for (let b = 0; b < plan.bankerBatches.length; b++) {
            const bName = accounts.bankerNames[b]!;
            const createdBanker = await createBot(bName);
            pointBotAt(createdBanker.envPath, ISOLATED.engine, ISOLATED.gateway, 'localhost');
            await applyPreset(bName, {
                position: { ...DRAYNOR_BANKER_POS },
                varps: { 281: 1000, 173: 1 },
                inventory: [...plan.bankerBatches[b]!],
            });
        }

        for (let k = 0; k < plan.fmHelperChunks.length; k++) {
            const hName = accounts.fmHelperNames[k]!;
            const chunk = plan.fmHelperChunks[k]!;
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
            const res = await runHaggisStageSeq(accounts, plan, wineCount);
            console.log(
                `STAGE_SEQ pass playtime=${res.endPlaytime} sumStages=${res.sumStageTicks}`
                + ` s1=${res.stage1.totalElapsedTicks} s1To2=${res.stage1To2Ticks}`
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
