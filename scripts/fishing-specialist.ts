import { existsSync } from 'node:fs';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import type { Session } from '../packages/core/src/inprocess';
import type { NearbyNpc } from '../vendor/rs-sdk/sdk/types';
import { pickFishSpot } from '../packages/workers/src/gather/fishing';
import { knifeCut } from '../packages/workers/src/gather/knife-reset';
import {
    openHelperAndMain,
    skipTutorialFast,
    startHelperTradeArm,
    receiveTradeFast,
    settleHelper,
    rubTeleport,
    walkWaypointsSafe,
    drinkEnergyIfLow,
    slotOfId,
    finish,
    SKILL_MULTI3_MAKE1_A,
    OBJ_COINS,
    OBJ_KNIFE,
    OBJ_LOGS,
    OBJ_GLORY_4,
    OBJ_SUPER_ENERGY_4,
} from './gathering-specialist-lib';

export const OBJ_SMALL_NET = 303;
export const OBJ_BIG_NET = 305;
export const OBJ_FLY_ROD = 309;
export const OBJ_FEATHER = 314;
export const OBJ_TORCH_UNLIT = 596;
export const OBJ_SWAMP_PASTE = 1941;
export const OBJ_OAK_LOGS = 1521;

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
    [OBJ_SUPER_ENERGY_4]: 1,
};

export const FISHING_GLORY_IDS = [1712, 1710, 1708, 1706] as const;

const FISHING_DROP_OUTPUT_IDS = new Set<number>([
    317, 321, // shrimps, anchovies
    353, 341, 363, // mackerel, cod, bass
    1061, 401, 1059, 407, 405, // boots, seaweed, gloves, oyster, casket
    229, // empty vial
]);

const CATHERBY_BEACH_SEARCH: readonly [number, number][] = [
    [2838, 3432],
    [2846, 3430],
    [2856, 3425],
];

async function dropNonNetTutorialItems(main: Session, stop: () => boolean): Promise<void> {
    for (let tick = 0; tick < 6 && !stop(); tick++) {
        let keptNet = false;
        const dropList = main.sdk.getInventory().filter(it => {
            if (!keptNet && it.id === OBJ_SMALL_NET) {
                keptNet = true;
                return false;
            }
            return true;
        });
        if (dropList.length === 0) return;
        await Promise.all(dropList.slice(0, 5).map(it => main.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' })));
        if (dropList.length > 5) await waitTicks(main, 1);
    }
}

async function buyBigNetAtCatherby(main: Session, stop: () => boolean): Promise<void> {
    if (slotOfId(main, OBJ_BIG_NET) !== undefined) return;
    await walkWaypointsSafe(main, [[2837, 3443, 2]], stop);
    for (let t = 0; t < 20 && !stop() && slotOfId(main, OBJ_BIG_NET) === undefined; t++) {
        const st = main.sdk.getState();
        if (st?.shop?.isOpen) {
            const bigNetItem = st.shop.shopItems?.find(i => i.id === OBJ_BIG_NET && i.count > 0);
            if (bigNetItem) {
                await main.direct({ type: 'shopBuy', slot: bigNetItem.slot, amount: 1, reason: 'SDK' });
                await waitTicks(main, 1);
                if (slotOfId(main, OBJ_BIG_NET) !== undefined) {
                    await main.direct({ type: 'closeShop', reason: 'SDK' });
                    return;
                }
            }
        } else {
            const harry = st?.nearbyNpcs.find(n => /^harry$/i.test(n.name));
            if (harry) {
                const tradeOp = harry.optionsWithIndex?.find(o => /trade/i.test(o.text))?.opIndex ?? 3;
                await main.direct({ type: 'interactNpc', npcIndex: harry.index, optionIndex: tradeOp, reason: 'SDK' });
            }
        }
        await waitTicks(main, 1);
    }
    if (slotOfId(main, OBJ_BIG_NET) === undefined) throw Error('failed to buy Big fishing net from Harry');
    if (main.sdk.getState()?.shop?.isOpen) {
        await main.direct({ type: 'closeShop', reason: 'SDK' });
    }
}

async function standBesideFishSpot(
    main: Session,
    spot: NearbyNpc,
    cachedWalker: { current?: Awaited<ReturnType<typeof sessionWalker>> },
    stop: () => boolean,
): Promise<boolean> {
    await drinkEnergyIfLow(main, 65);
    const p = main.sdk.getState()?.player;
    if (!p) return false;
    const tiles = [[0, 1], [1, 0], [-1, 0], [0, -1]]
        .map(([dx, dz]) => ({ x: spot.x + dx!, z: spot.z + dz! }))
        .sort((a, b) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ)) - Math.max(Math.abs(b.x - p.worldX), Math.abs(b.z - p.worldZ)));
    for (const t of tiles) {
        const dist = Math.max(Math.abs(t.x - p.worldX), Math.abs(t.z - p.worldZ));
        if (dist === 0) return true;
        const path = main.sdk.findPath(t.x, t.z);
        if (!path.success || path.reachedDestination !== true) continue;
        if (dist <= 4 && path.waypoints.length <= 4) {
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
        cachedWalker.current ??= await sessionWalker(main);
        return (await walkPath(cachedWalker.current, [{ ...t, tol: 0 }], { maxTicks: 20, stop })).ok;
    }
    return false;
}

/** Runs 3-tick delayed-click knife fishing (`net` -> `bigNet`) at Catherby, dropping multi-item big-net outputs cleanly. */
async function runDelayedKnifeBigNetTo99(
    main: Session,
    stop: () => boolean,
): Promise<{ cycles: number; netCycles: number; bigNetCycles: number; stands: number }> {
    const cachedWalker: { current?: Awaited<ReturnType<typeof sessionWalker>> } = {};
    let cycles = 0;
    let netCycles = 0;
    let bigNetCycles = 0;
    let stands = 0;
    let searchIdx = 0;

    while (!stop()) {
        const lvl = main.sdk.getSkill('Fishing')?.baseLevel ?? 1;
        if (lvl >= 99) break;

        const st = main.sdk.getState();
        if (!st?.player) {
            await waitTicks(main, 1);
            continue;
        }
        if (st.shop?.isOpen) {
            await main.direct({ type: 'closeShop', reason: 'SDK' });
            await waitTicks(main, 1);
            continue;
        }

        const method = lvl >= 16 ? 'bigNet' : 'net';
        const op = 1; // Net on both saltfish (small net) and memberfish (big net).
        const spot = pickFishSpot(st, method, 24);
        if (!spot) {
            const pt = CATHERBY_BEACH_SEARCH[searchIdx % CATHERBY_BEACH_SEARCH.length]!;
            searchIdx++;
            cachedWalker.current ??= await sessionWalker(main);
            await walkPath(cachedWalker.current, [{ x: pt[0], z: pt[1], tol: 1 }], { maxTicks: 20, stop });
            await waitTicks(main, 1);
            continue;
        }

        if (Math.abs(st.player.worldX - spot.x) + Math.abs(st.player.worldZ - spot.z) !== 1) {
            stands++;
            if (!(await standBesideFishSpot(main, spot, cachedWalker, stop))) {
                await waitTicks(main, 1);
            }
            continue;
        }

        const cut = knifeCut(st.inventory, SKILL_MULTI3_MAKE1_A);
        if (!cut) throw Error('delayed knife fishing requires knife and normal logs');

        // Tick T: queue knife-on-logs + Make 1 (sets %action_delay = map_clock + 2).
        await Promise.all(cut.map(a => main.direct({ ...a, reason: 'SDK' })));
        await waitTicks(main, 1);
        if (stop() || (main.sdk.getSkill('Fishing')?.baseLevel ?? 1) >= 99) break;

        // Tick T+1: clear weakqueue + level-up dialog via closeModal, and drop up to 4 outputs/unused items.
        const st1 = main.sdk.getState();
        const drops1 = (st1?.inventory ?? [])
            .filter(it => FISHING_DROP_OUTPUT_IDS.has(it.id) || (method === 'bigNet' && (it.id === OBJ_SMALL_NET || it.id === OBJ_COINS)))
            .slice(0, 4);
        await Promise.all([
            main.direct({ type: 'closeModal', reason: 'SDK' }),
            ...drops1.map(it => main.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' })),
        ]);
        await waitTicks(main, 1);
        if (stop() || (main.sdk.getSkill('Fishing')?.baseLevel ?? 1) >= 99) break;

        // Tick T+2: ensure >= 9 free slots for bigNet multi-drop, then click spot when %action_delay == map_clock.
        const st2 = main.sdk.getState();
        const inv2 = st2?.inventory ?? [];
        const acts2: Promise<unknown>[] = [];
        if (28 - inv2.length < 9) {
            const extraDrops = inv2
                .filter(it => FISHING_DROP_OUTPUT_IDS.has(it.id))
                .slice(0, 4);
            for (const it of extraDrops) {
                acts2.push(main.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' }));
            }
        }
        const liveSpot = st2?.nearbyNpcs.find(n => n.index === spot.index && n.x === spot.x && n.z === spot.z)
            ?? (st2 ? pickFishSpot(st2, method, 2) : undefined);
        if (liveSpot && st2?.player && Math.abs(st2.player.worldX - liveSpot.x) + Math.abs(st2.player.worldZ - liveSpot.z) === 1) {
            acts2.push(main.direct({ type: 'interactNpc', npcIndex: liveSpot.index, optionIndex: op, reason: 'SDK' }));
            cycles++;
            if (method === 'bigNet') bigNetCycles++;
            else netCycles++;
        }
        if (acts2.length > 0) await Promise.all(acts2);
        await waitTicks(main, 1);
    }

    return { cycles, netCycles, bigNetCycles, stands };
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
        await dropNonNetTutorialItems(main, isStopped);
        readyForTrade = true;
        const tradeTicks = await receiveTradeFast(main, helper, FISHING_SPECIALIST_SUPPLIES, isStopped, arm, { [OBJ_GLORY_4]: [1710, 1708] });
        helperDone = settleHelper(helper).catch(err => {
            console.log(`WARN helper settle: ${String(err)}`);
        });

        // Drop Sea Slug / fly-only items in 1 tick so 22+ pack slots stay free for Catherby big net.
        const unused = main.sdk.getInventory().filter(it =>
            it.id === OBJ_FLY_ROD || it.id === OBJ_FEATHER || it.id === OBJ_TORCH_UNLIT || it.id === OBJ_OAK_LOGS || it.id === OBJ_SWAMP_PASTE);
        if (unused.length > 0) {
            await Promise.all(unused.slice(0, 5).map(it => main.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' })));
        }

        // Edgeville Glory option 1 -> walk west across White Wolf Mountain to Harry's Fishing Shop at Catherby.
        await rubTeleport(
            main,
            FISHING_GLORY_IDS,
            1,
            p => p.worldX >= 3070 && p.worldX <= 3110 && p.worldZ >= 3480 && p.worldZ <= 3515,
            isStopped,
        );
        await walkWaypointsSafe(
            main,
            [[3059, 3405, 4], [2953, 3435, 4], [2866, 3459, 4], [2848, 3473, 4], [2837, 3443, 2]],
            isStopped,
        );
        await buyBigNetAtCatherby(main, isStopped);
        await walkWaypointsSafe(main, [[2838, 3432, 1]], isStopped);

        const fishStart = main.tick() - t0;
        const stats = await runDelayedKnifeBigNetTo99(main, isStopped);

        const totalTicks = main.tick() - t0;
        const lvl = main.sdk.getSkill('Fishing')?.baseLevel ?? 0;
        const xp = main.sdk.getSkillXp('Fishing') ?? 0;
        ok = lvl >= 99;
        detail = `level=${lvl} xp=${xp} ticks=${totalTicks} tut=${tutTicks} trade=${tradeTicks} fishStart=${fishStart} cycles=${stats.cycles} net=${stats.netCycles} bigNet=${stats.bigNetCycles} stands=${stats.stands}`;
    } catch (error) {
        detail = String(error);
    } finally {
        arm.close();
    }

    await helperDone;
    await finish([main], ok, detail);
}
