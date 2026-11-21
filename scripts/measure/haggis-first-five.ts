// Haggis Overall first-five-steps rehearsal: tutorial skip, early supply trade, Al Kharid wine banking, Cook's Assistant, and relog login-wine overlapped with Fletching 1->99.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../packages/core/src/inprocess';
import { PRACTICE_STARTUP_GB } from '../../packages/core/src/memory';
import { questFlags } from '../../packages/core/src/quest-status';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import { xpForLevel } from '../../packages/planner/src/curve';
import { createBot } from '../../packages/practice/src/bots';
import { rsSdkRoot } from '../../packages/practice/src/paths';
import { applyPreset } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { ISOLATED, pointBotAt, startIsolatedStack } from '../../packages/practice/src/rehearse';
import { onlineState, playerSavePath } from '../../packages/practice/src/save-library';
import { GLORY_IDS } from '../fast-skills-lib';
import { FLETCHING_SPECIALIST_SUPPLIES, OBJ_HEADLESS_ARROW, pickNextFletchTier } from '../fletching-specialist';
import { completeCook } from '../generated/quest-cook';
import { openQuest } from '../generated/quest-lib';
import {
    OBJ_COINS,
    OBJ_DUELING_8,
    OBJ_GLORY_4,
    closeWithin,
    dismissModalsAndDialogs,
    dropTutorialJunk,
    externalSupplierName,
    finish,
    HELPER_SPAWN,
    itemQty,
    logoutSession,
    openBot,
    receiveTradeFast,
    rubTeleport,
    settle,
    settleHelper,
    skipTutorialFast,
    slotOfId,
    startHelperTradeArm,
    waitTicks,
    waitUntil,
    walkWaypointsSafe,
} from '../gathering-specialist-lib';

export const OBJ_WINE_NOTED = 1996;
export const OBJ_EGG = 1944;
export const OBJ_MILK = 1927;
export const OBJ_FLOUR = 1933;
// 1,500 noted wines reach 99 after Cook's Assistant (~54% batch roll) on >99% of seeds at the same trade/bank tick cost as 600.
export const DEFAULT_WINE_COUNT = 1500;
const AL_KHARID_BANK = { x: 3269, z: 3167 };
const TOLL_GATE = { x: 3268, z: 3227 };

export interface FirstFivePhases {
    readonly tutorialTicks: number;
    readonly tradeTicks: number;
    readonly toAlKharidTicks: number;
    readonly bankWineTicks: number;
    readonly toLumbridgeTicks: number;
    readonly cookTicks: number;
    readonly relogWallMs: number;
    readonly fletchTicks: number;
    readonly wineAfterRelogTicks: number;
    readonly postFletchWineWaitTicks: number;
    readonly totalElapsedTicks: number;
    readonly endPlaytime: number | null;
    readonly cookingLevel: number;
    readonly cookingXp: number;
    readonly fletchingLevel: number;
    readonly fletchingXp: number;
    readonly cookQuestState: string;
}

export function assertSafeRehearsalAccounts(mainName: string, helperName?: string): { mainName: string; helperName?: string } {
    const cleanMain = mainName.trim();
    if (!cleanMain) throw Error('haggis-first-five: main account name required');
    if (RESERVED_ACCOUNTS.includes(cleanMain.toLowerCase())) {
        throw Error(`haggis-first-five: refuses reserved account ${cleanMain}`);
    }
    const cleanHelper = helperName?.trim();
    if (cleanHelper !== undefined) {
        if (!cleanHelper) throw Error('haggis-first-five: helper account name cannot be empty');
        if (RESERVED_ACCOUNTS.includes(cleanHelper.toLowerCase())) {
            throw Error(`haggis-first-five: refuses reserved helper account ${cleanHelper}`);
        }
        if (cleanHelper.toLowerCase() === cleanMain.toLowerCase()) {
            throw Error('haggis-first-five: main and helper accounts must differ');
        }
    }
    return { mainName: cleanMain, ...(cleanHelper ? { helperName: cleanHelper } : {}) };
}

export function buildFirstFiveSupplies(wineCount = DEFAULT_WINE_COUNT): Readonly<Record<number, number>> {
    if (!Number.isSafeInteger(wineCount) || wineCount < 1) throw Error(`invalid wineCount: ${wineCount}`);
    return {
        [OBJ_WINE_NOTED]: wineCount,
        [OBJ_EGG]: 1,
        [OBJ_MILK]: 1,
        [OBJ_FLOUR]: 1,
        [OBJ_COINS]: 10,
        [OBJ_GLORY_4]: 1,
        [OBJ_DUELING_8]: 1,
        ...FLETCHING_SPECIALIST_SUPPLIES,
    };
}

function readPlaytimeTicks(account: string): number | null {
    try {
        return readFileSync(playerSavePath(account)).readInt32BE(24);
    } catch {
        return null;
    }
}

async function crossTollGateWest(s: Session, isStopped: () => boolean): Promise<void> {
    const posX = () => s.sdk.getState()?.player?.worldX ?? 9999;
    if (posX() < TOLL_GATE.x) return;
    await walkWaypointsSafe(s, [[3271, 3198, 3], [TOLL_GATE.x + 1, TOLL_GATE.z, 1]], isStopped);
    for (let attempt = 0; attempt < 6 && posX() >= TOLL_GATE.x && !isStopped(); attempt++) {
        const dlg = s.sdk.getDialog();
        if (dlg?.isOpen && !dlg.isWaiting) {
            const yes = dlg.options.find(o => /^yes, ok/i.test(o.text));
            await s.direct({ type: 'clickDialogOption', optionIndex: yes ? yes.index : 0, reason: 'SDK' });
            await waitTicks(s, 1);
            continue;
        }
        const gate = (s.sdk.getState()?.nearbyLocs ?? []).find(
            l => /gate/i.test(l.name) && Math.abs(l.x - TOLL_GATE.x) <= 1 && Math.abs(l.z - TOLL_GATE.z) <= 2,
        );
        if (!gate) {
            await waitTicks(s, 1);
            continue;
        }
        const payOp = gate.optionsWithIndex.find(o => /pay/i.test(o.text));
        const openOp = gate.optionsWithIndex.find(o => /open/i.test(o.text));
        const opIndex = payOp?.opIndex ?? openOp?.opIndex ?? 1;
        await s.bot.interactLoc(gate, opIndex);
        await waitUntil(s, () => posX() < TOLL_GATE.x || !!s.sdk.getDialog()?.isOpen, { timeoutTicks: 8 });
    }
    if (posX() >= TOLL_GATE.x) throw Error(`failed to cross Al Kharid toll gate west from x=${posX()}`);
}

async function fletchAndFerment(
    s: Session,
    relogTick: number,
    isStopped: () => boolean,
): Promise<{ fletchTicks: number; wineAfterRelogTicks: number; postFletchWineWaitTicks: number }> {
    const goalFletchXp = xpForLevel(99);
    const goalCookXp = xpForLevel(99);
    const fletchStartTick = s.tick();
    let wineAtTick = -1;
    let fletchEndTick = -1;

    const recordCook99 = () => {
        if (wineAtTick < 0 && ((s.sdk.getSkill('Cooking')?.baseLevel ?? 1) >= 99 || (s.sdk.getSkillXp('Cooking') ?? 0) >= goalCookXp)) {
            wineAtTick = s.tick();
        }
    };

    while (!isStopped()) {
        recordCook99();
        const fletchDone = (s.sdk.getSkill('Fletching')?.baseLevel ?? 1) >= 99 || (s.sdk.getSkillXp('Fletching') ?? 0) >= goalFletchXp;
        if (fletchDone) {
            fletchEndTick = s.tick();
            break;
        }
        const headlessSlot = slotOfId(s, OBJ_HEADLESS_ARROW);
        if (headlessSlot === undefined) throw Error('missing headless arrows during fletch phase');
        const counts: Record<number, number> = {};
        const slots: Record<number, number> = {};
        for (const item of s.sdk.getInventory()) {
            counts[item.id] = (counts[item.id] ?? 0) + item.count;
            if (slots[item.id] === undefined) slots[item.id] = item.slot;
        }
        let simXp = s.sdk.getSkillXp('Fletching') ?? 0;
        let burst = 0;
        while (burst < 5 && simXp < goalFletchXp) {
            const tier = pickNextFletchTier(simXp, counts);
            if (!tier) break;
            const tipSlot = slots[tier.tipId];
            if (tipSlot === undefined) break;
            await s.direct({ type: 'useItemOnItem', sourceSlot: tipSlot, targetSlot: headlessSlot, reason: 'SDK' });
            counts[OBJ_HEADLESS_ARROW] = (counts[OBJ_HEADLESS_ARROW] ?? 0) - 15;
            counts[tier.tipId] = (counts[tier.tipId] ?? 0) - 15;
            simXp += tier.xpPerAction;
            burst++;
        }
        if (burst === 0) throw Error(`fletch stalled at xp=${s.sdk.getSkillXp('Fletching')}`);
        // Clear a level-up modal immediately with any unused packet slot so the NORMAL login-wine timer is not held.
        if (burst < 5 && s.sdk.getDialog()?.isOpen) {
            await s.direct({ type: 'clickDialogOption', optionIndex: 0, reason: 'SDK' });
        }
        await waitTicks(s, 1);
    }

    if (fletchEndTick < 0) throw Error('fletching stopped before reaching 99');
    const postWaitStart = s.tick();
    while (!isStopped() && wineAtTick < 0 && s.tick() - postWaitStart < 40) {
        recordCook99();
        if (wineAtTick >= 0) break;
        await dismissModalsAndDialogs(s, isStopped, 3);
        await waitTicks(s, 1);
    }
    recordCook99();
    if (wineAtTick < 0) {
        throw Error(`login-wine did not reach Cooking 99 (lvl=${s.sdk.getSkill('Cooking')?.baseLevel}, xp=${s.sdk.getSkillXp('Cooking')})`);
    }
    return {
        fletchTicks: fletchEndTick - fletchStartTick,
        wineAfterRelogTicks: wineAtTick - relogTick,
        postFletchWineWaitTicks: Math.max(0, wineAtTick - fletchEndTick),
    };
}

export async function runHaggisFirstFive(
    mainName: string,
    helperName: string,
    opts: { wineCount?: number; cap?: number; savePort?: number } = {},
): Promise<{ phases: FirstFivePhases; mainSession: Session | null }> {
    assertSafeRehearsalAccounts(mainName, helperName);
    const wineCount = opts.wineCount ?? DEFAULT_WINE_COUNT;
    const cap = opts.cap ?? 350;
    const supplies = buildFirstFiveSupplies(wineCount);
    const uniqueSlots = Object.keys(supplies).length;

    let stopFlag = false;
    let relogging = false;
    let helperSettled: Promise<void> | undefined;
    let currentMain: Session | null = null;
    const helper = externalSupplierName()
        ? undefined
        : await openBot(helperName, { onStop: async () => { stopFlag = true; } });
    const main = await openBot(mainName, {
        onStop: async () => { stopFlag = true; },
        onSessionEnd: async (s, detail) => {
            if (!relogging) await finish([s], false, detail);
        },
    });
    currentMain = main;
    const t0 = main.tick();
    const isStopped = () => stopFlag || main.tick() - t0 >= cap;
    const arm = startHelperTradeArm(helper, main.name, isStopped);

    try {
        const tutorialTicks = await skipTutorialFast(main, isStopped);
        const dropNeeded = Math.max(0, main.sdk.getInventory().length - (28 - uniqueSlots));
        if (dropNeeded > 0) await dropTutorialJunk(main, isStopped, dropNeeded);

        const tradeTicks = await receiveTradeFast(main, helper, supplies, isStopped, arm);
        helperSettled = settleHelper(helper).catch(err => { console.log(`WARN helper settle: ${String(err)}`); });

        const toAlKharidStart = main.tick();
        await rubTeleport(
            main,
            GLORY_IDS,
            /al kharid/i,
            p => p.worldX >= 3260 && p.worldX <= 3310 && p.worldZ >= 3155 && p.worldZ <= 3190,
            isStopped,
        );
        await walkWaypointsSafe(main, [[3285, 3166, 3], [AL_KHARID_BANK.x, AL_KHARID_BANK.z, 2]], isStopped);
        const toAlKharidTicks = main.tick() - toAlKharidStart;

        const bankStart = main.tick();
        if (!(await main.bot.openBank()).success || !await waitUntil(main, () => !!main.sdk.getState()?.bank?.isOpen, { timeoutTicks: 15 })) {
            throw Error('Al Kharid bank did not open');
        }
        const wineItem = main.sdk.getInventory().find(i => i.id === OBJ_WINE_NOTED);
        if (!wineItem) throw Error('noted unfermented wine missing before deposit');
        if (!(await main.bot.depositItem(wineItem, -1)).success || !await waitUntil(main, () => itemQty(main, OBJ_WINE_NOTED) === 0, { timeoutTicks: 10 })) {
            throw Error('failed depositing noted wine stack');
        }
        await main.bot.closeBank();
        if (!await waitUntil(main, () => !main.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 })) {
            throw Error('Al Kharid bank did not close');
        }
        const bankWineTicks = main.tick() - bankStart;

        const toLumbridgeStart = main.tick();
        await crossTollGateWest(main, isStopped);
        await walkWaypointsSafe(main, [[3250, 3226, 2], [3224, 3226, 2], [3207, 3218, 1]], isStopped);
        const toLumbridgeTicks = main.tick() - toLumbridgeStart;

        const cookStart = main.tick();
        const q = await openQuest({ session: main, cap: 150, lumbridgeOk: true, burst: true });
        try {
            await completeCook({
                ...q,
                questState: () => questFlags(main.client)?.find(f => f.name === "Cook's Assistant")?.state ?? 'unknown',
                packReady: () => Array.isArray(q.st()?.inventory),
            });
        } finally {
            await q.dispose();
        }
        const cookTicks = main.tick() - cookStart;
        const preRelogTick = main.tick();
        if (helperSettled) await helperSettled;

        const relogStartMs = Date.now();
        relogging = true;
        await logoutSession(main);
        await closeWithin([main], 5000);
        currentMain = null;
        if (opts.savePort) {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
                const st = await onlineState(mainName, opts.savePort).catch(() => ({ online: false, pendingLogout: false }));
                if (!st.online && !st.pendingLogout) break;
                await Bun.sleep(25);
            }
        } else {
            await Bun.sleep(250);
        }

        const main2 = await openBot(mainName, { onStop: async () => { stopFlag = true; } });
        currentMain = main2;
        const relogWallMs = Date.now() - relogStartMs;
        const relogTick = main2.tick();
        const stopped2 = () => stopFlag || main2.tick() - t0 >= cap;
        const { fletchTicks, wineAfterRelogTicks, postFletchWineWaitTicks } = await fletchAndFerment(main2, relogTick, stopped2);

        const cookQuestState = questFlags(main2.client)?.find(f => f.name === "Cook's Assistant")?.state ?? 'unknown';
        const cookingLevel = main2.sdk.getSkill('Cooking')?.baseLevel ?? 0;
        const cookingXp = main2.sdk.getSkillXp('Cooking') ?? 0;
        const fletchingLevel = main2.sdk.getSkill('Fletching')?.baseLevel ?? 0;
        const fletchingXp = main2.sdk.getSkillXp('Fletching') ?? 0;
        const totalElapsedTicks = Math.max(main2.tick(), preRelogTick) - t0;

        const ok = await settle(
            [main2],
            cookingLevel >= 99 && fletchingLevel >= 99 && cookQuestState === 'complete',
            `cook=${cookingLevel} fletch=${fletchingLevel} qpState=${cookQuestState} total=${totalElapsedTicks}`,
        );
        currentMain = null;
        await Bun.sleep(150);
        const endPlaytime = readPlaytimeTicks(mainName);
        if (!ok) throw Error(`haggis-first-five failed end checks: cook=${cookingLevel} fletch=${fletchingLevel} qpState=${cookQuestState}`);

        return {
            phases: {
                tutorialTicks,
                tradeTicks,
                toAlKharidTicks,
                bankWineTicks,
                toLumbridgeTicks,
                cookTicks,
                relogWallMs,
                fletchTicks,
                wineAfterRelogTicks,
                postFletchWineWaitTicks,
                totalElapsedTicks,
                endPlaytime,
                cookingLevel,
                cookingXp,
                fletchingLevel,
                fletchingXp,
                cookQuestState,
            },
            mainSession: null,
        };
    } catch (error) {
        arm.close();
        if (helperSettled) await helperSettled.catch(() => {});
        const leftovers = [currentMain, helper].filter((s): s is Session => !!s);
        if (leftovers.length) await closeWithin(leftovers, 3000).catch(() => {});
        throw error;
    } finally {
        arm.close();
    }
}

function ensurePackedGameAssets(): void {
    const engineDir = join(rsSdkRoot(), 'server', 'engine');
    const packed = join(engineDir, 'data', 'pack', 'server', 'script.dat');
    if (existsSync(packed)) return;
    console.log('Packing rs-sdk engine game assets for isolated rehearsal...');
    const res = Bun.spawnSync(['bun', 'run', 'build'], { cwd: engineDir, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
    if (res.exitCode !== 0 || !existsSync(packed)) throw Error(`failed packing rs-sdk game assets (exit=${res.exitCode})`);
}

async function runIsolated(): Promise<void> {
    const freeGiB = freemem() / 2 ** 30;
    if (freeGiB < PRACTICE_STARTUP_GB) {
        throw Error(`haggis-first-five --isolated needs ${PRACTICE_STARTUP_GB} GiB free (currently ${freeGiB.toFixed(1)} GiB); run via hosted CI measure_script`);
    }
    ensurePackedGameAssets();
    process.env.SIM_LOCKSTEP = '1';
    process.env.RANDOM_EVENTS ??= '0';
    process.env.DEMO_OK = '';

    const wineCount = Number(process.env.WINE_COUNT ?? DEFAULT_WINE_COUNT);
    const mainName = runBotName('hagm', 1);
    const helperName = runBotName('hagh', 1);
    const botsDir = join(rsSdkRoot(), 'bots');
    const saves = [playerSavePath(mainName), playerSavePath(helperName)];
    try {
        const [{ envPath: mEnv }, { envPath: hEnv }] = await Promise.all([createBot(mainName), createBot(helperName)]);
        pointBotAt(mEnv, ISOLATED.engine, ISOLATED.gateway, 'localhost');
        pointBotAt(hEnv, ISOLATED.engine, ISOLATED.gateway, 'localhost');
        for (const p of saves) rmSync(p, { force: true });
        const supplies = buildFirstFiveSupplies(wineCount);
        await applyPreset(helperName, {
            position: HELPER_SPAWN,
            coins: supplies[OBJ_COINS],
            inventory: Object.entries(supplies)
                .filter(([id]) => Number(id) !== OBJ_COINS)
                .map(([id, count]) => ({ id: Number(id), count })),
        });
        const stack = await startIsolatedStack();
        try {
            const { phases } = await runHaggisFirstFive(mainName, helperName, { wineCount, savePort: ISOLATED.save });
            console.log(
                `FIRST_FIVE pass cook=${phases.cookingLevel}(${phases.cookingXp}xp) fletch=${phases.fletchingLevel}(${phases.fletchingXp}xp)`
                + ` quest=${phases.cookQuestState} playtime=${phases.endPlaytime} tutorial=${phases.tutorialTicks}`
                + ` trade=${phases.tradeTicks} toAlKharid=${phases.toAlKharidTicks} bankWine=${phases.bankWineTicks}`
                + ` toLumbridge=${phases.toLumbridgeTicks} cook=${phases.cookTicks} fletch=${phases.fletchTicks}`
                + ` wineAfterRelog=${phases.wineAfterRelogTicks} postFletchWine=${phases.postFletchWineWaitTicks}`
                + ` totalSession=${phases.totalElapsedTicks}`,
            );
        } finally {
            await stack.stop();
        }
    } finally {
        for (const b of [mainName, helperName]) rmSync(join(botsDir, b), { recursive: true, force: true });
        for (const p of saves) rmSync(p, { force: true });
    }
}

if (import.meta.main) {
    const positional = process.argv.slice(2).filter(a => !a.startsWith('-'));
    const isolated = process.argv.includes('--isolated') || positional.length === 0;
    if (isolated) {
        await runIsolated();
    } else {
        const mainName = positional[0]!;
        const helperName = positional[1] ?? `${mainName}b`;
        const wineCount = Number(process.env.WINE_COUNT ?? DEFAULT_WINE_COUNT);
        const { phases } = await runHaggisFirstFive(mainName, helperName, { wineCount });
        console.log(`FIRST_FIVE pass ${JSON.stringify(phases)}`);
    }
    process.exit(0);
}
