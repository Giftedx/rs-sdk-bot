// Haggis Overall Stage-3 isolated/practice rehearsal: Draynor bank (post-Stage-2) -> Ring of dueling(8) Castle Wars
// -> Ardougne Market -> standalone stun-relog Thieving 1->99 (Men -> Warriors -> Guards -> Knights of Ardougne).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../packages/core/src/inprocess';
import { PRACTICE_STARTUP_GB } from '../../packages/core/src/memory';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import { xpForLevel } from '../../packages/planner/src/curve';
import { createBot } from '../../packages/practice/src/bots';
import { rsSdkRoot } from '../../packages/practice/src/paths';
import { applyPreset } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { ISOLATED, pointBotAt, startIsolatedStack } from '../../packages/practice/src/rehearse';
import { playerSavePath } from '../../packages/practice/src/save-library';
import {
    CWARS_TO_ARDY_MARKET_WAYPOINTS,
    OBJ_DUELING_8,
    OBJ_PINEAPPLE_PIZZA,
    RING_OF_DUELING_IDS,
    closeWithin,
    logoutSession,
    openBot,
    rubTeleport,
    settle,
    waitUntil,
    walkWaypointsSafe,
} from '../gathering-specialist-lib';
import { THIEVING_PIZZAS, runArdougneStunRelogThieving } from '../thieving-specialist';
import { DRAYNOR_BANK } from './haggis-stage2';
import { dialogOpen, inv, level, meter, send, tick, xp } from '../../packages/practice/src/floor-lib';

export const STAGE3_PIZZA_COUNT = THIEVING_PIZZAS;

export interface Stage3Phases {
    readonly bankTicks: number;
    readonly toMarketTicks: number;
    readonly thieveTicks: number;
    readonly totalElapsedTicks: number;
    readonly thievingLevel: number;
    readonly thievingXp: number;
    readonly relogs: number;
    readonly stuns: number;
    readonly attempts: number;
    readonly endPlaytime: number | null;
}

export interface Stage3Plan {
    readonly pizzaCount: number;
    readonly mainBank: ReadonlyArray<{ id: number; count: number }>;
    readonly startingPosition: typeof DRAYNOR_BANK;
    readonly startingSkills: Readonly<Record<string, number>>;
}

/** Validates that a Stage-3 rehearsal account name is non-empty and not in RESERVED_ACCOUNTS. */
export function assertSafeStage3Account(mainName: string): string {
    const cleanMain = mainName.trim();
    if (!cleanMain) throw Error('haggis-stage3: main account name required');
    if (RESERVED_ACCOUNTS.includes(cleanMain.toLowerCase())) {
        throw Error(`haggis-stage3: refuses reserved account ${cleanMain}`);
    }
    return cleanMain;
}

/** Builds Stage-2 end state at Draynor bank with Ring of dueling(8) and pineapple pizzas staged in bank. */
export function buildStage3Plan(pizzaCount = STAGE3_PIZZA_COUNT): Stage3Plan {
    if (!Number.isSafeInteger(pizzaCount) || pizzaCount < 10 || pizzaCount > 26) {
        throw Error(`haggis-stage3: pizzaCount must be between 10 and 26, got ${pizzaCount}`);
    }
    return {
        pizzaCount,
        mainBank: [
            { id: OBJ_DUELING_8, count: 1 },
            { id: OBJ_PINEAPPLE_PIZZA, count: pizzaCount },
        ],
        startingPosition: DRAYNOR_BANK,
        startingSkills: { Cooking: 99, Fletching: 99, Firemaking: 99, Prayer: 43, Hitpoints: 10 },
    };
}

function readPlaytimeTicks(account: string): number | null {
    try {
        return readFileSync(playerSavePath(account)).readInt32BE(24);
    } catch {
        return null;
    }
}

async function withdrawStage3Pack(main: Session, pizzaCount: number): Promise<void> {
    const m = meter(main, 'Thieving');
    if (dialogOpen(main)) await send(main, m, { type: 'closeModal' });
    if (!(await main.bot.openBank()).success || !await waitUntil(main, () => !!main.sdk.getState()?.bank?.isOpen, { timeoutTicks: 15 })) {
        throw Error('haggis-stage3: Draynor bank did not open');
    }
    if (inv(main).length > 0) {
        const seen = new Set<number>();
        for (const it of inv(main)) {
            if (seen.has(it.id)) continue;
            seen.add(it.id);
            await send(main, m, { type: 'bankDeposit', slot: it.slot, amount: -1 });
        }
        await waitUntil(main, () => inv(main).length === 0, { timeoutTicks: 10 });
    }
    const ring = main.sdk.getState()?.bank?.items.find(i => (RING_OF_DUELING_IDS as readonly number[]).includes(i.id));
    if (!ring) throw Error('haggis-stage3: missing Ring of dueling in bank');
    await send(main, m, { type: 'bankWithdraw', slot: ring.slot, amount: 1 });
    await waitUntil(main, () => inv(main).some(i => (RING_OF_DUELING_IDS as readonly number[]).includes(i.id)), { timeoutTicks: 10 });

    const pizzas = main.sdk.getState()?.bank?.items.find(i => i.id === OBJ_PINEAPPLE_PIZZA);
    if (!pizzas || pizzas.count < pizzaCount) {
        throw Error(`haggis-stage3: bank short of pineapple pizzas (${pizzas?.count ?? 0} < ${pizzaCount})`);
    }
    await send(main, m, { type: 'bankWithdraw', slot: pizzas.slot, amount: -1 });
    await waitUntil(main, () => inv(main).filter(i => i.id === OBJ_PINEAPPLE_PIZZA).length >= Math.min(pizzaCount, 26), { timeoutTicks: 10 });
    await main.bot.closeBank();
    await waitUntil(main, () => !main.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
}

/** Runs Stage 3 on an already-staged practice account: Draynor bank -> Castle Wars -> Ardougne Thieving 1->99. */
export async function runHaggisStage3(
    mainName: string,
    opts: { cap?: number; pizzaCount?: number } = {},
): Promise<{ phases: Stage3Phases }> {
    const cleanMain = assertSafeStage3Account(mainName);
    const plan = buildStage3Plan(opts.pizzaCount);
    const cap = opts.cap ?? 2800;

    let stopFlag = false;
    let activeToken = 1;
    let intentionalRelog = false;
    let main = await openBot(cleanMain, {
        onStop: async () => { if (activeToken === 1) stopFlag = true; },
        onSessionEnd: async (_s, detail) => { if (!intentionalRelog) throw Error(`unexpected stage3 end: ${detail}`); },
    });
    const t0 = main.tick();
    const isStopped = () => stopFlag;

    try {
        await tick(main, 3);
        const bankStart = main.tick();
        await withdrawStage3Pack(main, plan.pizzaCount);
        const bankTicks = main.tick() - bankStart;

        const travelStart = main.tick();
        await rubTeleport(
            main,
            RING_OF_DUELING_IDS,
            /castle wars/i,
            p => p.level === 0 && p.worldX >= 2430 && p.worldX <= 2455 && p.worldZ >= 3075 && p.worldZ <= 3105,
            isStopped,
        );
        await walkWaypointsSafe(main, CWARS_TO_ARDY_MARKET_WAYPOINTS, isStopped);
        const toMarketTicks = main.tick() - travelStart;
        const preThieveTicks = bankTicks + toMarketTicks + 3;

        const thieveRes = await runArdougneStunRelogThieving({
            main,
            cap,
            initialTicks: preThieveTicks,
            goalLevel: 99,
            isStopped,
            relogSession: async current => {
                intentionalRelog = true;
                try {
                    const out = await logoutSession(current);
                    if (out !== 'logged-out' && out !== 'disconnected') throw Error(`relog logout failed: ${out}`);
                    await closeWithin([current], 5000);
                    const token = ++activeToken;
                    return await openBot(cleanMain, {
                        onStop: async () => { if (token === activeToken) stopFlag = true; },
                        onSessionEnd: async (_s, detail) => { if (!intentionalRelog) throw Error(`unexpected stage3 end: ${detail}`); },
                    });
                } finally {
                    intentionalRelog = false;
                }
            },
        });
        main = thieveRes.session;

        const thieveTicks = thieveRes.totalTicks - preThieveTicks;
        const totalElapsedTicks = thieveRes.totalTicks;
        const thievingLevel = thieveRes.ok ? thieveRes.finalLevel : level(main, 'Thieving');
        const thievingXp = thieveRes.ok ? thieveRes.finalXp : xp(main, 'Thieving');
        const ok = await settle(
            [main],
            thieveRes.ok && thievingLevel >= 99 && thievingXp >= xpForLevel(99),
            `thieving=${thievingLevel} xp=${thievingXp} relogs=${thieveRes.relogs} stuns=${thieveRes.stuns} total=${totalElapsedTicks}`,
        );
        await Bun.sleep(150);
        const endPlaytime = readPlaytimeTicks(cleanMain);
        if (!ok) {
            throw Error(`haggis-stage3 failed end checks: thieving=${thievingLevel} xp=${thievingXp} total=${totalElapsedTicks}`);
        }

        return {
            phases: {
                bankTicks,
                toMarketTicks,
                thieveTicks,
                totalElapsedTicks,
                thievingLevel,
                thievingXp,
                relogs: thieveRes.relogs,
                stuns: thieveRes.stuns,
                attempts: thieveRes.attempts,
                endPlaytime,
            },
        };
    } catch (error) {
        stopFlag = true;
        console.error(`STAGE3_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        await settle([main], false, String(error)).catch(() => {});
        throw error;
    }
}

function ensurePackedGameAssets(): void {
    const engineDir = join(rsSdkRoot(), 'server', 'engine');
    const packed = join(engineDir, 'data', 'pack', 'server', 'script.dat');
    if (existsSync(packed)) return;
    console.log('Packing rs-sdk engine game assets for isolated Stage-3 rehearsal...');
    const res = Bun.spawnSync(['bun', 'run', 'build'], { cwd: engineDir, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
    if (res.exitCode !== 0 || !existsSync(packed)) throw Error(`failed packing rs-sdk game assets (exit=${res.exitCode})`);
}

async function runIsolated(): Promise<void> {
    const freeGiB = freemem() / 2 ** 30;
    if (freeGiB < PRACTICE_STARTUP_GB) {
        throw Error(`haggis-stage3 --isolated needs ${PRACTICE_STARTUP_GB} GiB free (currently ${freeGiB.toFixed(1)} GiB); run via hosted CI measure_script`);
    }
    ensurePackedGameAssets();
    process.env.SIM_LOCKSTEP = '1';
    process.env.RANDOM_EVENTS ??= '0';
    process.env.DEMO_OK = '';

    const plan = buildStage3Plan();
    const mainName = assertSafeStage3Account(runBotName('hs3m', 1));
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
            const { phases } = await runHaggisStage3(mainName);
            console.log(
                `STAGE3 pass thieving=${phases.thievingLevel}(${phases.thievingXp}xp) playtime=${phases.endPlaytime}`
                + ` bank=${phases.bankTicks} toMarket=${phases.toMarketTicks} thieve=${phases.thieveTicks}`
                + ` relogs=${phases.relogs} stuns=${phases.stuns} attempts=${phases.attempts} totalSession=${phases.totalElapsedTicks}`,
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
    const positional = process.argv.slice(2).filter(a => !a.startsWith('-'));
    const isolated = process.argv.includes('--isolated') || positional.length === 0;
    if (isolated) {
        await runIsolated();
    } else {
        const { phases } = await runHaggisStage3(positional[0]!);
        console.log(`STAGE3 pass ${JSON.stringify(phases)}`);
    }
    process.exit(0);
}
