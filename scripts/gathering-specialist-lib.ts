import { openBot, settle, finish, logoutSession, closeWithin, countItems, randomEventsOf } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
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
export const OBJ_GAMES_8 = 3853;

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

/** Skip Tutorial Island from login using same-tick character-design acceptance + guide interaction. */
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

/**
 * Execute a high-speed mutual trade between `main` and `helper` (opened before `main` so World processes
 * `helper`'s offers and screen acceptations first on shared ticks).
 */
export async function receiveTradeFast(
    main: Session,
    helper: Session,
    expectedCounts: Readonly<Record<number, number>>,
    stop: () => boolean,
): Promise<number> {
    const t0 = main.tick();
    const pendingSlots = helper.sdk.getInventory().map(i => ({ slot: i.slot, id: i.id, count: i.count }));
    const hasAllExpected = () =>
        Object.entries(expectedCounts).every(([id, minQty]) => itemQty(main, Number(id)) >= minQty);

    let lastReqTick = -99;
    let confirmClickedTick = -99;

    for (let i = 0; i < 60 && !stop(); i++) {
        if (hasAllExpected() && !main.sdk.getTradeState().isOpen) {
            return main.tick() - t0;
        }
        const tMain = main.sdk.getTradeState();
        const tHelp = helper.sdk.getTradeState();

        if (!tMain.isOpen && !tHelp.isOpen) {
            if (main.tick() - lastReqTick >= 2) {
                const pHelpOnMain = main.sdk.getState()?.nearbyPlayers.find(p => p.name.toLowerCase() === helper.name.toLowerCase());
                const pMainOnHelp = helper.sdk.getState()?.nearbyPlayers.find(p => p.name.toLowerCase() === main.name.toLowerCase());
                if (pHelpOnMain && pMainOnHelp) {
                    lastReqTick = main.tick();
                    await helper.direct({ type: 'interactPlayer', playerIndex: pMainOnHelp.index, optionIndex: 4, reason: 'SDK' });
                    await main.direct({ type: 'interactPlayer', playerIndex: pHelpOnMain.index, optionIndex: 4, reason: 'SDK' });
                } else {
                    const pPos = main.sdk.getState()?.player;
                    const hPos = helper.sdk.getState()?.player;
                    if (pPos && hPos && Math.max(Math.abs(pPos.worldX - hPos.worldX), Math.abs(pPos.worldZ - hPos.worldZ)) > 3) {
                        await helper.bot.walkTo(pPos.worldX + 1, pPos.worldZ, 1);
                    }
                }
            }
        } else if (tHelp.isOpen && tHelp.screen === 'offer' && tMain.isOpen && tMain.screen === 'offer') {
            let sent = 0;
            while (pendingSlots.length > 0 && sent < 5) {
                const next = pendingSlots.shift()!;
                await helper.direct({
                    type: 'clickComponentWithOption',
                    componentId: TRADE_SIDE_INV_ID,
                    optionIndex: 4,
                    slot: next.slot,
                    reason: 'SDK',
                });
                sent++;
            }
            if (pendingSlots.length === 0) {
                if (!tHelp.myAccepted && sent < 5) {
                    await helper.direct({ type: 'clickComponent', componentId: TRADE_MAIN_ACCEPT_ID, reason: 'SDK' });
                }
                if (!tMain.myAccepted) {
                    await main.direct({ type: 'clickComponent', componentId: TRADE_MAIN_ACCEPT_ID, reason: 'SDK' });
                }
            }
        } else if (tHelp.screen === 'confirm' || tMain.screen === 'confirm') {
            if (main.tick() !== confirmClickedTick) {
                confirmClickedTick = main.tick();
                if (tHelp.isOpen && tHelp.screen === 'confirm' && !tHelp.myAccepted) {
                    await helper.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT_ID, reason: 'SDK' });
                }
                if (tMain.isOpen && tMain.screen === 'confirm' && !tMain.myAccepted) {
                    await main.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT_ID, reason: 'SDK' });
                }
            }
        }

        await waitTicks(main, 1);
        if (hasAllExpected() && !main.sdk.getTradeState().isOpen) {
            return main.tick() - t0;
        }
    }
    throw Error(`receiveTradeFast timed out; inv=${JSON.stringify(main.sdk.getInventory().map(x => [x.id, x.count]))}`);
}

export async function rubTeleport(
    s: Session,
    itemIds: readonly number[],
    choiceIndex: number,
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
            if (dlg.options.length >= choiceIndex && dlg.options[choiceIndex - 1]) {
                await s.direct({ type: 'clickDialogOption', optionIndex: choiceIndex, reason: 'SDK' });
            } else {
                await s.direct({ type: 'clickDialogOption', optionIndex: 0, reason: 'SDK' });
            }
        } else if (!rubbed || i % 6 === 0) {
            const slot = s.sdk.getInventory().find(it => itemIds.includes(it.id))?.slot;
            if (slot === undefined) throw Error(`teleport item missing (${itemIds.join(',')})`);
            rubbed = true;
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
    for (const [x, z, tol] of points) {
        for (let tries = 0; tries < 4 && !stop(); tries++) {
            const p = s.sdk.getState()?.player;
            if (p && p.level === 0 && chebDist({ x, z }, { x: p.worldX, z: p.worldZ }) <= tol + 1) break;
            await eatSharkIfHurt(s, 4);
            await s.bot.walkTo(x, z, tol);
        }
        const p = s.sdk.getState()?.player;
        if (stop() || !p || chebDist({ x, z }, { x: p.worldX, z: p.worldZ }) > tol + 2) {
            throw Error(`walkWaypointsSafe failed reaching (${x},${z}) from (${p?.worldX},${p?.worldZ},${p?.level})`);
        }
    }
}

export async function sailBrimhavenToArdougne(s: Session, stop: () => boolean): Promise<void> {
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
    if (!landed()) throw Error('customs officer sailing failed');

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
    if (s.sdk.getState()?.player?.level !== 0) throw Error('Ardougne gangplank failed');
}

export async function openHelperAndMain(
    mainName: string,
    helperName: string,
): Promise<{ main: Session; helper: Session; stopped: () => boolean }> {
    let stopFlag = false;
    const stopCheck = () => stopFlag;
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

export async function settleHelper(helper: Session): Promise<void> {
    await settle([helper], true, 'helper supplied specialist');
}

export { openBot, settle, finish, logoutSession, closeWithin, countItems, waitTicks, waitUntil };
