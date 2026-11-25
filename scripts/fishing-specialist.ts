import { existsSync } from 'node:fs';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import { finish } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import type { NearbyNpc } from '../vendor/rs-sdk/sdk/types';
import { runStagedFishing } from '../packages/workers/src/gather/fishing';
import { runSeaSlugQuest } from './generated/quest-seaslug';
import { LUMBRIDGE_FM_PATH, FM_LIGHT_OPOBJ, OBJ_TINDERBOX, OBJ_OAK_LOGS } from './firemaking-specialist';
import {
    openHelperAndMain,
    skipTutorialFast,
    startHelperTradeArm,
    receiveTradeFast,
    settleHelper,
    rubTeleport,
    walkWaypointsSafe,
    sailBrimhavenToArdougne,
    slotOfId,
    SKILL_MULTI3_MAKE1_A,
    OBJ_COINS,
    OBJ_KNIFE,
    OBJ_LOGS,
    OBJ_GLORY_4,
} from './gathering-specialist-lib';

export const OBJ_FLY_ROD = 309;
export const OBJ_FEATHER = 314;
export const OBJ_TORCH_UNLIT = 596;
export const OBJ_SWAMP_PASTE = 1941;

export const FISHING_SPECIALIST_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_FLY_ROD]: 1,
    [OBJ_FEATHER]: 1200,
    [OBJ_TORCH_UNLIT]: 1,
    [OBJ_KNIFE]: 1,
    [OBJ_COINS]: 100,
    [OBJ_LOGS]: 4,
    [OBJ_OAK_LOGS]: 4,
    [OBJ_GLORY_4]: 1,
    [OBJ_SWAMP_PASTE]: 1,
};

export const FISHING_GLORY_IDS = [1712, 1710, 1708, 1706] as const;

async function dropNonTinderboxTutorialItems(main: Session, stop: () => boolean): Promise<void> {
    for (let tick = 0; tick < 6 && !stop(); tick++) {
        let keptTinderbox = false;
        const dropList = main.sdk.getInventory().filter(it => {
            if (!keptTinderbox && it.id === OBJ_TINDERBOX) {
                keptTinderbox = true;
                return false;
            }
            return true;
        });
        if (dropList.length === 0) return;
        await Promise.all(dropList.slice(0, 5).map(it => main.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' })));
        if (dropList.length > 5) await waitTicks(main, 1);
    }
}

async function trainFiremakingTo30(main: Session, stop: () => boolean): Promise<void> {
    const plan = [
        OBJ_LOGS, OBJ_LOGS,
        OBJ_OAK_LOGS, OBJ_OAK_LOGS, OBJ_OAK_LOGS, OBJ_OAK_LOGS,
    ];
    for (let i = 0; i < plan.length && !stop(); i++) {
        if ((main.sdk.getSkill('Firemaking')?.baseLevel ?? 1) >= 30) return;
        const itemId = plan[i]!;
        const [tx, tz] = LUMBRIDGE_FM_PATH[i]!;
        while (!stop()) {
            const p = main.sdk.getState()?.player;
            if (p && p.worldX === tx && p.worldZ === tz) break;
            if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
                await main.direct({ type: 'closeModal', reason: 'SDK' });
            }
            await main.bot.walkTo(tx, tz, 0);
        }
        if (stop()) return;
        const tboxSlot = slotOfId(main, OBJ_TINDERBOX);
        const logSlot = slotOfId(main, itemId);
        if (tboxSlot === undefined || logSlot === undefined) {
            throw Error(`missing tinderbox/log for FM 30 step ${i} tbox=${tboxSlot} log=${logSlot}`);
        }
        const beforeXp = main.sdk.getSkillXp('Firemaking') ?? 0;
        const sentTick = main.tick();
        const lightInvOp = { type: 'useItemOnItem', sourceSlot: tboxSlot, targetSlot: logSlot, reason: 'SDK' } as const;
        const lightGroundOp = { type: 'interactGroundItem', x: tx, z: tz, itemId, optionIndex: FM_LIGHT_OPOBJ, reason: 'SDK' } as const;
        const groundHas = () =>
            ((main.sdk.getState() as { groundItems?: { id: number; x: number; z: number }[] } | undefined)?.groundItems ?? []).some(
                g => g.id === itemId && g.x === tx && g.z === tz,
            );
        if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
            await Promise.all([main.direct({ type: 'closeModal', reason: 'SDK' }), main.direct(lightInvOp)]);
        } else {
            await main.direct(lightInvOp);
        }
        while (!stop() && (main.sdk.getSkillXp('Firemaking') ?? 0) === beforeXp) {
            await waitTicks(main, 1);
            if ((main.sdk.getSkillXp('Firemaking') ?? 0) !== beforeXp) break;
            const dlgOpen = !!(main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen);
            const elapsed = main.tick() - sentTick;
            const retryInvSlot = !groundHas() && elapsed >= 4 ? slotOfId(main, itemId) : undefined;
            const retryTboxSlot = retryInvSlot !== undefined ? slotOfId(main, OBJ_TINDERBOX) : undefined;
            const retryOp = groundHas()
                ? lightGroundOp
                : retryInvSlot !== undefined && retryTboxSlot !== undefined
                    ? ({ type: 'useItemOnItem', sourceSlot: retryTboxSlot, targetSlot: retryInvSlot, reason: 'SDK' } as const)
                    : null;
            if (dlgOpen && retryOp) {
                await Promise.all([main.direct({ type: 'closeModal', reason: 'SDK' }), main.direct(retryOp)]);
            } else if (dlgOpen) {
                await main.direct({ type: 'closeModal', reason: 'SDK' });
            } else if (elapsed >= 4 && elapsed % 4 === 0 && retryOp) {
                await main.direct(retryOp);
            }
        }
    }
}

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

    let readyForTrade = false;
    const arm = startHelperTradeArm(helper, main.name, isStopped, () => readyForTrade);
    try {
        const tutTicks = await skipTutorialFast(main, isStopped);
        await dropNonTinderboxTutorialItems(main, isStopped);
        readyForTrade = true;
        const tradeTicks = await receiveTradeFast(main, helper, FISHING_SPECIALIST_SUPPLIES, isStopped, arm, { [OBJ_GLORY_4]: [1710, 1708] });
        helperDone = settleHelper(helper).catch(err => {
            console.log(`WARN helper settle: ${String(err)}`);
        });

        await trainFiremakingTo30(main, isStopped);
        const fmDone = main.tick() - t0;

        // Karamja Glory option 2 -> Brimhaven dock -> Ardougne dock -> Witchaven Caroline for Sea Slug (179,375 Fishing XP).
        await rubTeleport(
            main,
            FISHING_GLORY_IDS,
            2,
            p => p.worldX >= 2900 && p.worldX <= 2960 && p.worldZ >= 3140 && p.worldZ <= 3200,
            isStopped,
        );
        await walkWaypointsSafe(main, [[2890, 3175, 4], [2850, 3175, 4], [2818, 3188, 4], [2788, 3212, 4], [2774, 3228, 3]], isStopped);
        await sailBrimhavenToArdougne(main, isStopped);
        await walkWaypointsSafe(main, [[2716, 3302, 2]], isStopped);

        let lastQuestRunClick = -10;
        const offQuestRunWatch = main.onTick(() => {
            if (isStopped()) return;
            const p = main.sdk.getState()?.player;
            if (!p) return;
            const now = main.tick();
            const runOn = ((main.client as { var?: number[] } | undefined)?.var?.[173] ?? 0) === 1;
            if (!runOn && p.runEnergy >= 10 && now - lastQuestRunClick >= 2) {
                lastQuestRunClick = now;
                void main.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' });
            }
        });
        try {
            const done = await runSeaSlugQuest(main, {
                keepAlive: true,
                eatAt: 0,
                stop: isStopped,
                cap: Math.max(400, cap - (main.tick() - t0)),
            });
            if (!done) throw Error('Sea Slug did not finish');
        } finally {
            offQuestRunWatch();
        }
        const questDone = main.tick() - t0;

        // Edgeville Glory option 1 -> Barbarian Village river west bank (3109,3434).
        await rubTeleport(
            main,
            FISHING_GLORY_IDS,
            1,
            p => p.worldX >= 3070 && p.worldX <= 3110 && p.worldZ >= 3480 && p.worldZ <= 3515,
            isStopped,
        );
        await walkWaypointsSafe(
            main,
            [[3098, 3465, 3], [3109, 3434, 1]],
            isStopped,
        );

        let cachedWalker: Awaited<ReturnType<typeof sessionWalker>> | undefined;
        const stand = async (spot: NearbyNpc) => {
            const p = main.sdk.getState()?.player;
            if (!p) return false;
            const tiles = [[1, 0], [-1, 0], [0, 1], [0, -1]]
                .map(([dx, dz]) => ({ x: spot.x + dx!, z: spot.z + dz! }))
                .sort((a, b) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ)) - Math.max(Math.abs(b.x - p.worldX), Math.abs(b.z - p.worldZ)));
            for (const t of tiles) {
                const dist = Math.max(Math.abs(t.x - p.worldX), Math.abs(t.z - p.worldZ));
                if (dist === 0) return true;
                if (dist <= 4) {
                    const path = main.sdk.findPath(t.x, t.z);
                    if (path.success && path.reachedDestination === true && path.waypoints.length <= 4) {
                        await main.direct({ type: 'walkTo', x: t.x, z: t.z, running: true, reason: 'SDK' });
                        const arrived = await waitUntil(
                            main,
                            () => {
                                const me = main.sdk.getState()?.player;
                                return !!me && me.worldX === t.x && me.worldZ === t.z;
                            },
                            { timeoutTicks: 6 },
                        );
                        if (arrived) return true;
                    }
                }
                const path = main.sdk.findPath(t.x, t.z);
                if (path.success && path.reachedDestination === true) {
                    cachedWalker ??= await sessionWalker(main);
                    return (await walkPath(cachedWalker, [{ ...t, tol: 0 }], { maxTicks: 20, stop: isStopped })).ok;
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
                await Promise.all(acts.map(a => main.direct({ ...a, reason: 'SDK' })));
            },
            stand,
        };
        const knife = { make1: SKILL_MULTI3_MAKE1_A, drop: true };

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
        detail = `level=${lvl} xp=${xp} ticks=${totalTicks} tut=${tutTicks} trade=${tradeTicks} fmDone=${fmDone} seaSlug=${questDone} flyStart=${flyStart}`;
    } catch (error) {
        detail = String(error);
    } finally {
        arm.close();
    }

    await helperDone;
    await finish([main], ok, detail);
}
