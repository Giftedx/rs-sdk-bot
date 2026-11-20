// Shared fast-trade, tutorial-skip, run-guarded walking and teleport helpers for the fresh-clock gathering specialists.
import { openBot, settle, finish, logoutSession, closeWithin, countItems, randomEventsOf } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import { componentId } from '../packages/core/src/logout';
import { onStarterIsland } from './rune-starter';

export const LUMBRIDGE_SPAWN = { x: 3222, z: 3222, level: 0 } as const;
export const HELPER_SPAWN = { x: 3223, z: 3222, level: 0 } as const;
export const SKILL_MULTI3_MAKE1_A = componentId('skill_multi3:make1_a');

export const TRADE_SIDE_INV_ID = 3322;
export const TRADE_MAIN_ACCEPT_ID = 3420;
export const TRADE_CONFIRM_ACCEPT_ID = 3546;

export const OBJ_COINS = 995;
export const OBJ_KNIFE = 946;
export const OBJ_LOGS = 1511;
export const OBJ_SHARK = 385;
export const OBJ_GLORY_4 = 1712;
export const OBJ_DUELING_8 = 2552;
export const RING_OF_DUELING_IDS = [2552, 2554, 2556, 2558, 2560, 2562, 2564, 2566] as const;
export const OBJ_GAMES_8 = 3853;
export const OBJ_SUPER_ENERGY_4 = 3016;
export const ENERGY_POTION_IDS = [3016, 3018, 3020, 3022] as const;
export const OBJ_PINEAPPLE_PIZZA = 2301;
export const OBJ_HALF_PINEAPPLE_PIZZA = 2303;
export const OBJ_CAKE = 1891;
export const OBJ_CAKE_2_3 = 1893;
export const OBJ_CAKE_SLICE = 1895;
export const OBJ_CHOCOLATE_SLICE = 1901;
export const OBJ_BREAD = 2309;
const MULTI2_OPT1_ID = 2461;

export const CWARS_TO_ARDY_ZOO_WAYPOINTS: readonly [number, number, number][] = [
    [2451, 3151, 3],
    [2463, 3178, 3],
    [2478, 3190, 2],
    [2476, 3197, 3],
    [2486, 3214, 3],
    [2506, 3233, 4],
    [2555, 3234, 3],
    [2603, 3234, 1],
];

export const CWARS_TO_ARDY_MARKET_WAYPOINTS: readonly [number, number, number][] = [
    [2451, 3151, 3],
    [2463, 3178, 3],
    [2478, 3190, 2],
    [2476, 3197, 3],
    [2486, 3214, 3],
    [2506, 3233, 4],
    [2598, 3235, 3],
    [2621, 3293, 2],
];

export const isLiveSupplyVariant = (
    env: Record<string, string | undefined> = process.env,
    argv: readonly string[] = process.argv,
): boolean => env.LIVE === '1' || argv.includes('--live');

export const chebDist = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
    Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

export const itemQty = (s: Session, id: number): number =>
    s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

export const slotOfId = (s: Session, id: number): number | undefined =>
    s.sdk.getInventory().find(i => i.id === id)?.slot;

export async function dismissModalsAndDialogs(s: Session, stop: () => boolean, maxTicks = 6): Promise<void> {
    for (let i = 0; i < maxTicks && !stop(); i++) {
        const st = s.sdk.getState();
        const dlg = s.sdk.getDialog();
        if (!st?.modalOpen && !st?.interface?.isOpen && !dlg?.isOpen) return;
        if (st?.modalOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
        if (dlg?.isOpen && !dlg.isWaiting) {
            if (dlg.options.length === 0 || dlg.options[0]?.buttonType === 6) {
                await s.direct({ type: 'clickDialogOption', optionIndex: 0, reason: 'SDK' });
            } else {
                break;
            }
        }
        await waitTicks(s, 1);
    }
}

export async function eatSharkIfHurt(s: Session, minMissing = 3): Promise<boolean> {
    const p = s.sdk.getState()?.player;
    if (!p || p.hp > p.maxHp - minMissing) return false;
    const slot = slotOfId(s, OBJ_SHARK);
    if (slot === undefined) return false;
    await s.direct({ type: 'useInventoryItem', slot, optionIndex: 1, reason: 'SDK' });
    return true;
}

/** Drink one dose of Super energy potion (no action/eat delay) whenever energy drops at or below threshold. */
export async function drinkEnergyIfLow(s: Session, maxEnergy = 78): Promise<boolean> {
    const p = s.sdk.getState()?.player;
    if (!p || p.runEnergy > maxEnergy) return false;
    const item = s.sdk.getInventory().find(it => (ENERGY_POTION_IDS as readonly number[]).includes(it.id));
    if (!item) return false;
    await s.direct({ type: 'useInventoryItem', slot: item.slot, optionIndex: 1, reason: 'SDK' });
    return true;
}

/** Eat half or whole pineapple pizza (10 HP bite on 10 HP specialist, 20 HP/slot). */
export async function eatPineapplePizza(s: Session): Promise<boolean> {
    const half = slotOfId(s, OBJ_HALF_PINEAPPLE_PIZZA);
    const whole = slotOfId(s, OBJ_PINEAPPLE_PIZZA);
    const slot = half ?? whole;
    if (slot === undefined) return false;
    await s.direct({ type: 'useInventoryItem', slot, optionIndex: 1, reason: 'SDK' });
    return true;
}

const HEALING_FOOD_IDS = [
    OBJ_HALF_PINEAPPLE_PIZZA,
    OBJ_PINEAPPLE_PIZZA,
    OBJ_CAKE_SLICE,
    OBJ_CAKE_2_3,
    OBJ_CAKE,
    OBJ_CHOCOLATE_SLICE,
    OBJ_BREAD,
    OBJ_SHARK,
] as const;

const FOOD_BITES_BY_ID: Readonly<Record<number, number>> = {
    [OBJ_HALF_PINEAPPLE_PIZZA]: 1,
    [OBJ_PINEAPPLE_PIZZA]: 2,
    [OBJ_CAKE_SLICE]: 1,
    [OBJ_CAKE_2_3]: 2,
    [OBJ_CAKE]: 3,
    [OBJ_CHOCOLATE_SLICE]: 1,
    [OBJ_BREAD]: 1,
    [OBJ_SHARK]: 1,
};

export const foodBitesCount = (s: Session): number =>
    s.sdk.getInventory().reduce((sum, item) => sum + (FOOD_BITES_BY_ID[item.id] ?? 0) * item.count, 0);

export const hasAnyFood = (s: Session): boolean =>
    HEALING_FOOD_IDS.some(id => slotOfId(s, id) !== undefined);

/** Eat partial/whole healing food (pizza, cake slices, bread, or shark), returning true if an eat packet was sent. */
export async function eatAnyFood(s: Session): Promise<boolean> {
    for (const id of HEALING_FOOD_IDS) {
        const slot = slotOfId(s, id);
        if (slot !== undefined) {
            await s.direct({ type: 'useInventoryItem', slot, optionIndex: 1, reason: 'SDK' });
            return true;
        }
    }
    return false;
}

/** Skip Tutorial Island in 2 ticks by chaining dialog continue + multi2:com_1 ("Yes please.") on tick 2. */
export async function skipTutorialFast(s: Session, stop: () => boolean): Promise<number> {
    const t0 = s.tick();
    let designSent = false;
    let guideClicked = false;
    for (let i = 0; i < 60 && !stop(); i++) {
        const st = s.sdk.getState();
        const p = st?.player;
        if (p && !onStarterIsland(p) && !st?.dialog?.isOpen && !st?.modalOpen) {
            return s.tick() - t0;
        }
        if (st?.modalOpen && st.modalInterface === 3559 && !designSent) {
            designSent = true;
            await s.direct({ type: 'acceptCharacterDesign', reason: 'SDK' });
            const guide = st.nearbyNpcs.find(n => /^runescape guide$/i.test(n.name));
            const op = guide?.optionsWithIndex.find(o => /^talk-to$/i.test(o.text));
            if (guide && op) {
                guideClicked = true;
                await s.direct({ type: 'interactNpc', npcIndex: guide.index, optionIndex: op.opIndex, reason: 'SDK' });
            }
        } else if (p && onStarterIsland(p)) {
            const dlg = s.sdk.getDialog();
            if (dlg?.isOpen && !dlg.isWaiting) {
                const yes = dlg.options.find(o => /^yes please[.]?$/i.test(o.text));
                if (yes && dlg.options.every(o => /^(yes please|no, thank you)[.]?$/i.test(o.text))) {
                    await s.direct({ type: 'clickDialogOption', optionIndex: yes.index, reason: 'SDK' });
                } else if (dlg.options.length === 0 || (dlg.options.length === 1 && dlg.options[0]!.buttonType === 6)) {
                    await s.direct({ type: 'clickDialogOption', optionIndex: 0, reason: 'SDK' });
                    await s.direct({ type: 'clickComponent', componentId: MULTI2_OPT1_ID, reason: 'SDK' });
                } else {
                    throw Error(`unsupported tutorial dialog: ${JSON.stringify(dlg)}`);
                }
            } else if (!guideClicked && (designSent || i >= 8)) {
                const guide = st?.nearbyNpcs.find(n => /^runescape guide$/i.test(n.name));
                const op = guide?.optionsWithIndex.find(o => /^talk-to$/i.test(o.text));
                if (guide && op) {
                    guideClicked = true;
                    await s.direct({ type: 'interactNpc', npcIndex: guide.index, optionIndex: op.opIndex, reason: 'SDK' });
                }
            }
        }
        await waitTicks(s, 1);
    }
    throw Error('tutorial skip exceeded tick budget');
}

/** Drop up to `maxCount` matching slots in 5-per-tick bursts to clear tutorial items quickly. */
export async function dropTutorialJunk(s: Session, stop: () => boolean, dropSlotsNeeded: number): Promise<void> {
    let left = dropSlotsNeeded;
    for (let tick = 0; tick < 10 && left > 0 && !stop(); tick++) {
        const inv = s.sdk.getInventory();
        const batch = inv.slice(0, Math.min(5, left));
        if (!batch.length) return;
        for (const item of batch) {
            await s.direct({ type: 'dropItem', slot: item.slot, reason: 'SDK' });
            left--;
        }
        if (left > 0) await waitTicks(s, 1);
    }
}

export interface TradeHelperArm {
    readonly close: () => void;
}

/**
 * Drive `helper` synchronously inside `helper.onTick` before lockstep `acknowledgeTick` schedules flush,
 * and hold one lockstep waiter so packets never miss a tick behind `main`.
 */
export function startHelperTradeArm(
    helper: Session | undefined,
    mainName: string,
    stop: () => boolean,
    canRequest: () => boolean = () => true,
): TradeHelperArm {
    // An external supplier process (scripts/gathering-supplier.ts) runs this arm on its own session.
    if (!helper) return { close: () => {} };
    let done = false;
    let lastReqTick = -10;
    let lastOfferTick = -10;
    let lastAcceptTick = -10;
    let lastConfirmTick = -10;
    const offeredIds = new Set<number>();
    const mainLower = mainName.toLowerCase();
    const ac = new AbortController();

    const stepHelper = () => {
        if (done || stop()) return;
        const tHelp = helper.sdk.getTradeState();
        const t = helper.tick();

        if (!tHelp.isOpen) {
            if (offeredIds.size > 0) offeredIds.clear();
            if (canRequest() && t - lastReqTick >= 1) {
                const pMain = helper.sdk.getState()?.nearbyPlayers.find(p => p.name.toLowerCase() === mainLower);
                if (pMain) {
                    lastReqTick = t;
                    void helper.direct({ type: 'interactPlayer', playerIndex: pMain.index, optionIndex: 4, reason: 'SDK' });
                }
            }
            return;
        }

        if (tHelp.screen === 'offer') {
            if (t === lastOfferTick) return;
            const remainingById = new Map<number, number>();
            for (const item of helper.sdk.getInventory()) {
                if (!offeredIds.has(item.id) && !remainingById.has(item.id)) remainingById.set(item.id, item.slot);
            }
            const batch = [...remainingById.entries()].slice(0, 5);
            if (batch.length > 0) {
                lastOfferTick = t;
                for (const [id, slot] of batch) {
                    offeredIds.add(id);
                    void helper.direct({
                        type: 'clickComponentWithOption',
                        componentId: TRADE_SIDE_INV_ID,
                        optionIndex: 4,
                        slot,
                        reason: 'SDK',
                    });
                }
            }
            const leftAfter = remainingById.size - batch.length;
            if (leftAfter === 0 && batch.length < 5 && !tHelp.myAccepted && t - lastAcceptTick >= 1) {
                lastAcceptTick = t;
                void helper.direct({ type: 'clickComponent', componentId: TRADE_MAIN_ACCEPT_ID, reason: 'SDK' });
            }
            return;
        }

        if (tHelp.screen === 'confirm' && !tHelp.myAccepted && t - lastConfirmTick >= 1) {
            lastConfirmTick = t;
            void helper.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT_ID, reason: 'SDK' });
        }
    };

    const offTick = helper.onTick(stepHelper);
    void waitUntil(helper, () => done || stop(), { timeoutTicks: 80, signal: ac.signal }).catch(() => {});
    stepHelper();

    return {
        close: () => {
            if (done) return;
            done = true;
            offTick();
            ac.abort();
        },
    };
}

/**
 * Execute a high-speed mutual trade between `main` and `helper` (opened before `main` so World processes
 * `helper`'s offers and screen acceptations first on shared ticks).
 */
export async function receiveTradeFast(
    main: Session,
    helper: Session | undefined,
    expectedCounts: Readonly<Record<number, number>>,
    stop: () => boolean,
    existingArm?: TradeHelperArm,
): Promise<number> {
    const t0 = main.tick();
    const expectedEntries = Object.entries(expectedCounts).map(([id, minQty]) => [Number(id), minQty] as const);
    const hasAllExpected = () =>
        expectedEntries.every(([id, minQty]) => itemQty(main, id) >= minQty);
    const uniqueSupplyCount = expectedEntries.length;
    const minUniqueOfferedBeforeAccept = Math.floor(uniqueSupplyCount / 5) * 5;
    const supplierName = helper?.name ?? externalSupplierName();
    if (!supplierName) throw Error('receiveTradeFast needs a helper session or SUPPLIER/PRACTICE_SUPPLIER');
    const supplierLower = supplierName.toLowerCase();

    const arm = existingArm ?? startHelperTradeArm(helper, main.name, stop, () => true);
    let lastReqTick = -10;
    let lastOfferAcceptTick = -10;
    let lastConfirmTick = -10;

    try {
        for (let i = 0; i < 60 && !stop(); i++) {
            const tMain = main.sdk.getTradeState();
            if (hasAllExpected() && !tMain.isOpen) {
                return main.tick() - t0;
            }
            const t = main.tick();

            if (!tMain.isOpen) {
                if (t - lastReqTick >= 1) {
                    const pHelpOnMain = main.sdk.getState()?.nearbyPlayers.find(p => p.name.toLowerCase() === supplierLower);
                    if (pHelpOnMain) {
                        lastReqTick = t;
                        await main.direct({ type: 'interactPlayer', playerIndex: pHelpOnMain.index, optionIndex: 4, reason: 'SDK' });
                    } else if (helper) {
                        const pPos = main.sdk.getState()?.player;
                        const hPos = helper.sdk.getState()?.player;
                        if (pPos && hPos && Math.max(Math.abs(pPos.worldX - hPos.worldX), Math.abs(pPos.worldZ - hPos.worldZ)) > 3) {
                            await helper.bot.walkTo(pPos.worldX + 1, pPos.worldZ, 1);
                        }
                    }
                }
            } else if (tMain.screen === 'offer') {
                const seenUnique = new Set(tMain.theirOffer.map(x => x.id)).size;
                if (!tMain.myAccepted && seenUnique >= minUniqueOfferedBeforeAccept && t - lastOfferAcceptTick >= 1) {
                    lastOfferAcceptTick = t;
                    await main.direct({ type: 'clickComponent', componentId: TRADE_MAIN_ACCEPT_ID, reason: 'SDK' });
                    await main.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT_ID, reason: 'SDK' });
                }
            } else if (tMain.screen === 'confirm' && !tMain.myAccepted && t - lastConfirmTick >= 1) {
                lastConfirmTick = t;
                await main.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT_ID, reason: 'SDK' });
            }

            await waitTicks(main, 1);
            if (hasAllExpected() && !main.sdk.getTradeState().isOpen) {
                return main.tick() - t0;
            }
        }
        throw Error(`receiveTradeFast timed out; inv=${JSON.stringify(main.sdk.getInventory().map(x => [x.id, x.count]))}`);
    } finally {
        arm.close();
    }
}

export async function rubTeleport(
    s: Session,
    itemIds: readonly number[],
    choice: number | RegExp,
    inDest: (p: { worldX: number; worldZ: number; level: number }) => boolean,
    stop: () => boolean,
): Promise<void> {
    const startP = s.sdk.getState()?.player;
    if (startP && inDest(startP)) return;
    let rubbed = false;
    for (let i = 0; i < 20 && !stop(); i++) {
        const st = s.sdk.getState();
        if (st?.player && inDest(st.player)) return;
        const dlg = s.sdk.getDialog();
        if (dlg?.isOpen && !dlg.isWaiting) {
            const matched = choice instanceof RegExp
                ? dlg.options.find(o => choice.test(o.text))?.index
                : (dlg.options.length >= choice && dlg.options[choice - 1] ? choice : undefined);
            await s.direct({ type: 'clickDialogOption', optionIndex: matched ?? 0, reason: 'SDK' });
        } else if (!rubbed || i % 6 === 0) {
            const slot = s.sdk.getInventory().find(it => itemIds.includes(it.id))?.slot;
            if (slot === undefined) throw Error(`teleport item missing (${itemIds.join(',')})`);
            rubbed = true;
            if (st?.dialog?.isOpen || st?.modalOpen) {
                await s.direct({ type: 'closeModal', reason: 'SDK' });
            }
            await s.direct({ type: 'useInventoryItem', slot, optionIndex: 4, reason: 'SDK' });
        }
        await waitTicks(s, 1);
    }
    throw Error(`rubTeleport failed for items ${itemIds.join(',')}`);
}

export async function walkWaypointsSafe(
    s: Session,
    points: readonly [number, number, number][],
    stop: () => boolean,
): Promise<void> {
    if (points.length === 0) return;
    const goal = points[points.length - 1]!;
    const arrived = () => {
        const p = s.sdk.getState()?.player;
        return !!p && p.level === 0 && chebDist({ x: goal[0], z: goal[1] }, { x: p.worldX, z: p.worldZ }) <= goal[2] + 1;
    };
    if (arrived()) return;

    const runEnabled = () => ((s.client as { var?: number[] } | undefined)?.var?.[173] ?? 0) === 1;
    let lastDrinkTick = -10;
    let lastRunClickTick = -10;
    const ensureRunOn = async () => {
        const t = s.tick();
        if (!runEnabled() && t - lastRunClickTick >= 2) {
            lastRunClickTick = t;
            await s.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' });
        }
    };
    const baseDeps = await sessionWalker(s);
    const deps = {
        ...baseDeps,
        // Guard component 153 toggle so consecutive walks keep varp 173 (option_run) active instead of toggling off.
        runOn: ensureRunOn,
    };

    const offWatch = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        if (!p) return;
        const t = s.tick();
        if (p.runEnergy <= 75 && t - lastDrinkTick >= 3) {
            lastDrinkTick = t;
            void drinkEnergyIfLow(s, 75);
        }
        if (p.runEnergy >= 10) void ensureRunOn();
    });

    try {
        await drinkEnergyIfLow(s, 75);
        const pathPts = points.map(([x, z, tol]) => ({ x, z, tol }));
        const budget = Math.max(320, points.length * 140);
        const res = await walkPath(deps, pathPts, { maxTicks: budget, immediateHunterDetours: true, stop });
        if (!res.ok || !arrived()) {
            const rem = points.slice(Math.min(res.next, points.length - 1));
            for (const [x, z, tol] of rem) {
                for (let tries = 0; tries < 4 && !stop(); tries++) {
                    const p = s.sdk.getState()?.player;
                    if (p && p.level === 0 && chebDist({ x, z }, { x: p.worldX, z: p.worldZ }) <= tol + 1) break;
                    await drinkEnergyIfLow(s, 75);
                    await eatSharkIfHurt(s, 4);
                    await s.bot.walkTo(x, z, tol);
                }
            }
        }
    } finally {
        offWatch();
    }

    const p = s.sdk.getState()?.player;
    if (stop() || !p || !arrived()) {
        throw Error(`walkWaypointsSafe failed reaching (${goal[0]},${goal[1]}) from (${p?.worldX},${p?.worldZ},${p?.level})`);
    }
}

export const sailBrimhavenToArdougne = async (s: Session, stop: () => boolean): Promise<void> => {
    const ardyDeck = { x: 2683, z: 3268 };
    const landed = () => {
        const p = s.sdk.getState()?.player;
        return !!p && p.level === 1 && chebDist(ardyDeck, { x: p.worldX, z: p.worldZ }) <= 8;
    };
    const pats = [/journey on this ship/i, /search away/i, /^ok\.?$/i];
    for (let tries = 0; tries < 3 && !stop() && !landed(); tries++) {
        await eatSharkIfHurt(s, 4);
        const talk = await s.bot.talkTo(/^customs officer$/i);
        if (!talk.success) {
            await waitTicks(s, 2);
            continue;
        }
        for (let i = 0; i < 60 && !stop() && !landed(); i++) {
            const d = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opt = d.options.find(o => pats.some(re => re.test(o.text)));
                await s.direct({ type: 'clickDialogOption', optionIndex: opt ? opt.index : 0, reason: 'SDK' });
            }
            await waitTicks(s, 1);
        }
    }
    if (!landed()) throw Error('Brimhaven->Ardougne sailing failed');

    for (let i = 0; i < 6 && !stop(); i++) {
        if (s.sdk.getState()?.player?.level === 0) return;
        const d = s.sdk.getDialog();
        if (d?.isOpen && !d.isWaiting) {
            await s.direct({ type: 'clickDialogOption', optionIndex: 0, reason: 'SDK' });
            await waitTicks(s, 1);
            continue;
        }
        const plank = s.sdk.findNearbyLoc(/^gangplank$/i);
        if (!plank) {
            await waitTicks(s, 2);
            continue;
        }
        await s.bot.interactLoc(plank, 'Cross');
        await waitUntil(s, st => st?.player?.level === 0, { timeoutTicks: 10 });
    }
    if (s.sdk.getState()?.player?.level !== 0) throw Error('Brimhaven->Ardougne gangplank failed');
};

/** Name of the external supplier account (live or rehearsal), or undefined when the helper runs in this process. */
export function externalSupplierName(env: Record<string, string | undefined> = process.env): string | undefined {
    const name = (env.PRACTICE_SUPPLIER ?? env.SUPPLIER ?? '').trim();
    return name || undefined;
}

export async function openHelperAndMain(
    mainName: string,
    helperName: string,
): Promise<{ main: Session; helper: Session | undefined; stopped: () => boolean }> {
    let stopFlag = false;
    const stopCheck = () => stopFlag;
    // An external SUPPLIER serves the trade from its own process, so this process runs the specialist alone.
    if (externalSupplierName()) {
        const main = await openBot(mainName, { onStop: async () => { stopFlag = true; } });
        return { main, helper: undefined, stopped: stopCheck };
    }
    // Open helper first so World slot order processes helper trade offers/accepts before main.
    const helper = await openBot(helperName, { onStop: async () => { stopFlag = true; } });
    const main = await openBot(mainName, { onStop: async () => { stopFlag = true; } });
    return { main, helper, stopped: stopCheck };
}

export async function fleeRandomEventIfPresent(s: Session, returnTo: { x: number; z: number }, stop: () => boolean): Promise<boolean> {
    const p = s.sdk.getState()?.player;
    const ev = randomEventsOf(s);
    const hostile = (s.sdk.getState()?.nearbyNpcs ?? []).some(n =>
        /^(river troll|rock golem|shade|swarm|strange plant|evil chicken|zombie|tree spirit)$/i.test(n.name) && n.distance <= 3);
    if (!hostile && !ev?.busy()) return false;
    if (!p) return false;
    await eatSharkIfHurt(s, 2);
    // Running >3 tiles off drops ~macro_event_lost_hostile and despawns the random event.
    await s.bot.walkTo(returnTo.x + 14, returnTo.z, 1);
    await waitTicks(s, 3);
    await s.bot.walkTo(returnTo.x, returnTo.z, 1);
    await eatSharkIfHurt(s, 2);
    return !stop();
}

export async function settleHelper(helper: Session | undefined): Promise<void> {
    if (!helper) return;
    await settle([helper], true, 'helper supplied specialist');
}

export { openBot, settle, finish, logoutSession, closeWithin, countItems, waitTicks, waitUntil };
