// Haggis Overall Stage-4 isolated/practice rehearsal: Ardougne Market -> Ardougne South Bank -> Sea Slug
// (Fishing 1->74+) -> Glory Edgeville -> Barbarian Village 3-tick knife-reset fly fishing (74->99).
import { existsSync, rmSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../packages/core/src/inprocess';
import { PRACTICE_STARTUP_GB } from '../../packages/core/src/memory';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import { sessionWalker, walkPath } from '../../packages/core/src/walk';
import { xpForLevel } from '../../packages/planner/src/curve';
import { createBot } from '../../packages/practice/src/bots';
import { rsSdkRoot } from '../../packages/practice/src/paths';
import { applyPreset } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { ISOLATED, pointBotAt, startIsolatedStack } from '../../packages/practice/src/rehearse';
import { playerSavePath } from '../../packages/practice/src/save-library';
import { FISHING_GLORY_IDS, OBJ_FEATHER, OBJ_FLY_ROD } from '../fishing-specialist';
import {
    OBJ_GLORY_4,
    OBJ_KNIFE,
    OBJ_LOGS,
    SKILL_MULTI3_MAKE1_A,
    openBot,
    rubTeleport,
    settle,
    waitUntil,
    walkWaypointsSafe,
} from '../gathering-specialist-lib';
import { runSeaSlugQuest } from '../generated/quest-seaslug';
import { createFishingDriver, runStagedFishing } from '../../packages/workers/src/gather';
import { dialogOpen, inv, level, meter, send, tick, xp } from '../../packages/practice/src/floor-lib';

export const OBJ_SWAMP_PASTE = 1941;
export const STAGE4_FEATHERS = 1000;
export const ARDOUGNE_MARKET_START = { x: 2662, z: 3305, level: 0 } as const;
export const ARDOUGNE_SOUTH_BANK = { x: 2655, z: 3283, level: 0 } as const;
const BARBARIAN_WAYPOINTS: readonly [number, number, number][] = [[3087, 3465, 3], [3109, 3434, 1]];

export interface Stage4Phases {
    readonly toBankTicks: number;
    readonly bankTicks: number;
    readonly seaSlugTicks: number;
    readonly fishingAfterSeaSlug: number;
    readonly toBarbarianTicks: number;
    readonly flyFishingTicks: number;
    readonly fishingLevel: number;
    readonly fishingXp: number;
    readonly totalElapsedTicks: number;
}

const RESERVED_SET = new Set(RESERVED_ACCOUNTS.map(name => name.toLowerCase()));

/** Rejects empty or reserved account names before any Stage-4 session opens. */
export function assertSafeStage4Account(accountName: string): string {
    const clean = accountName.trim();
    if (!clean) throw Error('haggis-stage4: main account name required');
    if (RESERVED_SET.has(clean.toLowerCase())) {
        throw Error(`haggis-stage4: refuses reserved account ${clean}`);
    }
    return clean;
}

/** Builds the deterministic Stage-4 preset starting at Ardougne Market after Stage 3 (Thieving 99). */
export function buildStage4Plan(featherCount = STAGE4_FEATHERS) {
    if (!Number.isSafeInteger(featherCount) || featherCount < 500 || featherCount > 10_000) {
        throw Error(`haggis-stage4: featherCount must be between 500 and 10000, got ${featherCount}`);
    }
    return {
        startingPosition: ARDOUGNE_MARKET_START,
        startingSkills: { Cooking: 99, Fletching: 99, Firemaking: 99, Prayer: 43, Hitpoints: 10, Thieving: 99 },
        mainInventory: [] as { id: number; count: number }[],
        mainBank: [
            { id: OBJ_SWAMP_PASTE, count: 1 },
            { id: OBJ_FLY_ROD, count: 1 },
            { id: OBJ_FEATHER, count: featherCount },
            { id: OBJ_KNIFE, count: 1 },
            { id: OBJ_LOGS, count: 1 },
            { id: OBJ_GLORY_4, count: 1 },
        ],
    };
}

async function withdrawStage4Pack(main: Session, featherCount: number): Promise<void> {
    const m = meter(main, 'Fishing');
    if (dialogOpen(main)) await send(main, m, { type: 'closeModal' });
    if (!(await main.bot.openBank()).success || !await waitUntil(main, () => !!main.sdk.getState()?.bank?.isOpen, { timeoutTicks: 15 })) {
        throw Error('haggis-stage4: Ardougne south bank did not open');
    }
    const items: ReadonlyArray<readonly [number, number, number]> = [
        [OBJ_SWAMP_PASTE, 1, 1],
        [OBJ_FLY_ROD, 1, 1],
        [OBJ_FEATHER, -1, featherCount],
        [OBJ_KNIFE, 1, 1],
        [OBJ_LOGS, 1, 1],
        [OBJ_GLORY_4, 1, 1],
    ];
    for (const [id, withdrawAmt, minCount] of items) {
        const bankItem = main.sdk.getState()?.bank?.items.find(i => i.id === id);
        if (!bankItem || bankItem.count < minCount) {
            throw Error(`haggis-stage4: Ardougne bank short on item ${id} (${bankItem?.count ?? 0} < ${minCount})`);
        }
        await send(main, m, { type: 'bankWithdraw', slot: bankItem.slot, amount: withdrawAmt });
        const received = await waitUntil(
            main,
            () => inv(main).filter(i => i.id === id).reduce((n, i) => n + i.count, 0) >= minCount,
            { timeoutTicks: 10 },
        );
        if (!received) throw Error(`haggis-stage4: withdraw ${id} unobserved`);
    }
    await main.bot.closeBank();
    await waitUntil(main, () => !main.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
}

/** Runs Stage 4 on an already-staged practice account: Ardougne bank -> Sea Slug -> Edgeville -> Barbarian fly 99. */
export async function runHaggisStage4(
    mainName: string,
    opts: { cap?: number; featherCount?: number } = {},
): Promise<{ phases: Stage4Phases }> {
    const cleanMain = assertSafeStage4Account(mainName);
    const featherCount = opts.featherCount ?? STAGE4_FEATHERS;
    buildStage4Plan(featherCount);
    const cap = opts.cap ?? 3600;

    let stopFlag = false;
    let settling = false;
    const main = await openBot(cleanMain, {
        onStop: async () => { stopFlag = true; },
        onSessionEnd: async (_s, detail) => { if (!settling) throw Error(`unexpected stage4 end: ${detail}`); },
    });
    const t0 = main.tick();
    const isStopped = () => stopFlag || main.tick() - t0 >= cap;
    const m = meter(main, 'Fishing');

    try {
        await tick(main, 3);
        const walkBankStart = main.tick();
        const bankWalk = await walkPath(
            await sessionWalker(main),
            [{ ...ARDOUGNE_SOUTH_BANK, tol: 2 }],
            { maxTicks: 40, stop: isStopped },
        );
        if (!bankWalk.ok) throw Error(`haggis-stage4: walk to Ardougne south bank failed: ${bankWalk.detail ?? 'unknown'}`);
        const toBankTicks = main.tick() - walkBankStart;

        const bankStart = main.tick();
        await withdrawStage4Pack(main, featherCount);
        const bankTicks = main.tick() - bankStart;

        const seaSlugStart = main.tick();
        const questDone = await runSeaSlugQuest(main, {
            keepAlive: true,
            cap: Math.max(400, cap - (main.tick() - t0)),
            stop: isStopped,
        });
        if (!questDone) throw Error('haggis-stage4: Sea Slug did not finish');
        const seaSlugTicks = main.tick() - seaSlugStart;
        const fishingAfterSeaSlug = level(main, 'Fishing');
        if (fishingAfterSeaSlug < 70) {
            throw Error(`haggis-stage4: Fishing after Sea Slug too low (${fishingAfterSeaSlug} < 70)`);
        }

        const travelStart = main.tick();
        if (dialogOpen(main)) await send(main, m, { type: 'closeModal' });
        await rubTeleport(
            main,
            FISHING_GLORY_IDS,
            1,
            p => p.level === 0 && p.worldX >= 3070 && p.worldX <= 3110 && p.worldZ >= 3480 && p.worldZ <= 3515,
            isStopped,
        );
        await walkWaypointsSafe(main, BARBARIAN_WAYPOINTS, isStopped);
        const toBarbarianTicks = main.tick() - travelStart;

        const flyStart = main.tick();
        const driver = createFishingDriver(main, isStopped);
        await runStagedFishing(driver, {
            method: 'fly',
            amount: 3000,
            untilLevel: 99,
            cap: Math.max(200, cap - (main.tick() - t0)),
            maxAttempts: 2500,
            progressTicks: 420,
            xpRate: 25,
            knife: { make1: SKILL_MULTI3_MAKE1_A, drop: true },
        });
        const flyFishingTicks = main.tick() - flyStart;

        const fishingLevel = level(main, 'Fishing');
        const fishingXp = xp(main, 'Fishing');
        const totalElapsedTicks = main.tick() - t0;
        const passed = fishingLevel >= 99 && fishingXp >= xpForLevel(99) && totalElapsedTicks <= cap;
        settling = true;
        const ok = await settle(
            [main],
            passed,
            `fishing=${fishingLevel} xp=${fishingXp} seaslug=${seaSlugTicks} fly=${flyFishingTicks} total=${totalElapsedTicks}`,
        );
        if (!ok) {
            throw Error(`haggis-stage4 failed end checks: fishing=${fishingLevel} xp=${fishingXp} total=${totalElapsedTicks}`);
        }
        return {
            phases: {
                toBankTicks,
                bankTicks,
                seaSlugTicks,
                fishingAfterSeaSlug,
                toBarbarianTicks,
                flyFishingTicks,
                fishingLevel,
                fishingXp,
                totalElapsedTicks,
            },
        };
    } catch (error) {
        stopFlag = true;
        settling = true;
        console.error(`STAGE4_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        await settle([main], false, String(error)).catch(() => {});
        throw error;
    }
}

function ensurePackedGameAssets(): void {
    const engineDir = join(rsSdkRoot(), 'server', 'engine');
    const packed = join(engineDir, 'data', 'pack', 'server', 'script.dat');
    if (existsSync(packed)) return;
    console.log('Packing rs-sdk engine game assets for isolated Stage-4 rehearsal...');
    const res = Bun.spawnSync(['bun', 'run', 'build'], { cwd: engineDir, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
    if (res.exitCode !== 0 || !existsSync(packed)) throw Error(`failed packing rs-sdk game assets (exit=${res.exitCode})`);
}

async function runIsolated(cap?: number): Promise<void> {
    const freeGiB = freemem() / 2 ** 30;
    if (freeGiB < PRACTICE_STARTUP_GB) {
        throw Error(`haggis-stage4 --isolated needs ${PRACTICE_STARTUP_GB} GiB free (currently ${freeGiB.toFixed(1)} GiB); run via hosted CI measure_script`);
    }
    ensurePackedGameAssets();
    process.env.SIM_LOCKSTEP = '1';
    process.env.RANDOM_EVENTS ??= '0';
    process.env.DEMO_OK = '';

    const plan = buildStage4Plan();
    const mainName = assertSafeStage4Account(runBotName('hs4m', 1));
    const botsDir = join(rsSdkRoot(), 'bots');
    const save = playerSavePath(mainName);
    try {
        const created = await createBot(mainName);
        pointBotAt(created.envPath, ISOLATED.engine, ISOLATED.gateway, 'localhost');
        rmSync(save, { force: true });
        await applyPreset(mainName, {
            position: plan.startingPosition,
            skills: { ...plan.startingSkills },
            varps: { 29: 2, 173: 1 },
            inventory: [],
            bank: [...plan.mainBank],
        });
        const stack = await startIsolatedStack();
        try {
            const { phases } = await runHaggisStage4(mainName, { cap });
            console.log(
                `STAGE4 pass fishing=${phases.fishingLevel}(${phases.fishingXp}xp) afterSlug=${phases.fishingAfterSeaSlug}`
                + ` toBank=${phases.toBankTicks} bank=${phases.bankTicks} seaslug=${phases.seaSlugTicks}`
                + ` toBarb=${phases.toBarbarianTicks} fly=${phases.flyFishingTicks} totalSession=${phases.totalElapsedTicks}`,
            );
        } finally {
            await stack.stop();
        }
    } finally {
        rmSync(join(botsDir, mainName), { recursive: true, force: true });
        rmSync(save, { force: true });
    }
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const capArg = args.find(a => /^\d+$/.test(a));
    const cap = capArg ? Number(capArg) : undefined;
    const positional = args.filter(a => !/^\d+$/.test(a) && !a.startsWith('-'));
    const isolatedMode = args.includes('--isolated') || positional.length === 0;
    try {
        if (isolatedMode) {
            await runIsolated(cap);
        } else {
            const { phases } = await runHaggisStage4(positional[0]!, { cap });
            console.log(`STAGE4 pass ${JSON.stringify(phases)}`);
        }
        process.exit(0);
    } catch (err) {
        console.error(`STAGE4 fail ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
