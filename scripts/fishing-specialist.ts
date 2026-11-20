import { existsSync } from 'node:fs';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import type { NearbyNpc } from '../vendor/rs-sdk/sdk/types';
import { runStagedFishing } from './microbot-b-fishing';
import {
    openHelperAndMain,
    skipTutorialFast,
    dropTutorialJunk,
    receiveTradeFast,
    settleHelper,
    rubTeleport,
    walkWaypointsSafe,
    finish,
    SKILL_MULTI3_MAKE1_A,
    OBJ_KNIFE,
    OBJ_LOGS,
    OBJ_GLORY_4,
} from './gathering-specialist-lib';

export const OBJ_SMALL_NET = 303;
export const OBJ_FISHING_ROD = 307;
export const OBJ_FLY_ROD = 309;
export const OBJ_FISHING_BAIT = 313;
export const OBJ_FEATHER = 314;

export const FISHING_SPECIALIST_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_SMALL_NET]: 1,
    [OBJ_FISHING_ROD]: 1,
    [OBJ_FISHING_BAIT]: 60,
    [OBJ_FLY_ROD]: 1,
    [OBJ_FEATHER]: 1500,
    [OBJ_KNIFE]: 1,
    [OBJ_LOGS]: 5,
    [OBJ_GLORY_4]: 1,
};

export const FISHING_GLORY_IDS = [1712, 1710, 1708, 1706] as const;

if (import.meta.main) {
    const account = process.argv[2];
    const helperName = process.argv.slice(3).find(a => !a.includes('=') && !a.startsWith('-')) ?? process.env.HELPER ?? `${account}b`;
    const cap = Number(process.env.CAP ?? 3600);
    if (!account) throw Error('usage: bun scripts/fishing-specialist.ts <account> [helperAccount]');

    const { main, helper, stopped } = await openHelperAndMain(account, helperName);
    const t0 = main.tick();
    const isStopped = () => stopped() || existsSync(`.practice/stop-${account}`) || existsSync('.practice/stop-all') || main.tick() - t0 >= cap;
    let helperDone: Promise<void> | undefined;
    let ok = false;
    let detail = '';

    try {
        const tutTicks = await skipTutorialFast(main, isStopped, helper);
        await dropTutorialJunk(main, isStopped, 10, helper);
        const tradeTicks = await receiveTradeFast(main, helper, FISHING_SPECIALIST_SUPPLIES, isStopped);
        helperDone = settleHelper(helper).catch(err => {
            console.log(`WARN helper settle: ${String(err)}`);
        });

        // Karamja Glory option 2 lands beside Musa Point saltfish spots (danger-free).
        await rubTeleport(
            main,
            FISHING_GLORY_IDS,
            2,
            p => p.worldX >= 2900 && p.worldX <= 2960 && p.worldZ >= 3140 && p.worldZ <= 3200,
            isStopped,
        );
        await walkWaypointsSafe(main, [[2923, 3179, 2]], isStopped);

        const stand = async (spot: NearbyNpc) => {
            const p = main.sdk.getState()?.player;
            if (!p) return false;
            const tiles = [[1, 0], [-1, 0], [0, 1], [0, -1]]
                .map(([dx, dz]) => ({ x: spot.x + dx!, z: spot.z + dz! }))
                .sort((a, b) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ)) - Math.max(Math.abs(b.x - p.worldX), Math.abs(b.z - p.worldZ)));
            for (const t of tiles) {
                const path = main.sdk.findPath(t.x, t.z);
                if (path.success && path.reachedDestination === true) {
                    return (await walkPath(await sessionWalker(main), [{ ...t, tol: 0 }], { maxTicks: 20, stop: isStopped })).ok;
                }
            }
            return false;
        };

        const driver = {
            state: () => main.sdk.getState(),
            tick: () => main.tick(),
            stopped: isStopped,
            interact: (i: number, op: number) => main.sdk.sendInteractNpc(i, op),
            combine: (a: number, b: number) => main.sdk.sendUseItemOnItem(a, b),
            wait: (test: () => boolean, ticks: number) => waitUntil(main, test, { timeoutTicks: ticks }),
            step: () => waitTicks(main, 1),
            send: async (acts: readonly { type: string; [k: string]: unknown }[]) => {
                for (const a of acts) await main.direct({ ...a, reason: 'SDK' });
            },
            stand,
        };
        const knife = { make1: SKILL_MULTI3_MAKE1_A, drop: true };

        if ((main.sdk.getSkill('Fishing')?.baseLevel ?? 1) < 5) {
            await runStagedFishing(driver, {
                method: 'net',
                amount: 30,
                untilLevel: 5,
                cap: Math.max(100, cap - (main.tick() - t0)),
                maxAttempts: 200,
                progressTicks: 240,
                xpRate: 25,
                knife,
            });
        }
        const baitStart = main.tick() - t0;
        if ((main.sdk.getSkill('Fishing')?.baseLevel ?? 1) < 20) {
            await runStagedFishing(driver, {
                method: 'seaBait',
                amount: 100,
                untilLevel: 20,
                cap: Math.max(150, cap - (main.tick() - t0)),
                maxAttempts: 400,
                progressTicks: 240,
                xpRate: 25,
                knife,
            });
        }

        // Edgeville Glory option 1 lands at (3087,3496) -> hunter-free Barbarian Village river west bank (3109,3434).
        await rubTeleport(
            main,
            FISHING_GLORY_IDS,
            1,
            p => p.worldX >= 3070 && p.worldX <= 3110 && p.worldZ >= 3480 && p.worldZ <= 3515,
            isStopped,
        );
        await walkWaypointsSafe(
            main,
            [[3087, 3465, 3], [3109, 3434, 1]],
            isStopped,
        );

        const flyStart = main.tick() - t0;
        if ((main.sdk.getSkill('Fishing')?.baseLevel ?? 1) < 99) {
            await runStagedFishing(driver, {
                method: 'fly',
                amount: 3000,
                untilLevel: 99,
                cap: Math.max(200, cap - (main.tick() - t0)),
                maxAttempts: 2500,
                progressTicks: 420,
                xpRate: 25,
                knife,
            });
        }

        const totalTicks = main.tick() - t0;
        const lvl = main.sdk.getSkill('Fishing')?.baseLevel ?? 0;
        const xp = main.sdk.getSkillXp('Fishing') ?? 0;
        ok = lvl >= 99;
        detail = `level=${lvl} xp=${xp} ticks=${totalTicks} tut=${tutTicks} trade=${tradeTicks} baitStart=${baitStart} flyStart=${flyStart}`;
    } catch (error) {
        detail = String(error);
    }

    await helperDone;
    await finish([main], ok, detail);
}
