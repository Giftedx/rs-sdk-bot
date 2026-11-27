// Travel, door exits, shop purchases, gathering helpers, and handOver session management for quest sweep.
import { accountOf, sessionDied } from '../../../core/src/bot';
import { TINDERBOX } from '../../../core/src/gather';
import type { Session } from '../../../core/src/inprocess';
import { componentId } from '../../../core/src/logout';
import { questFlags } from '../../../core/src/quest-status';
import { planTripOffThread } from '../../../core/src/route-plan';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import type { TripPlan } from '../../../core/src/trip';
import { loadTravel } from '../../../core/src/travel';
import { goTo, sessionWalker, walkPath, walkRoute, type PathDeps } from '../../../core/src/walk';
import type { Account, Tile, World } from '../../../core/src/world';
import { executionContext } from '../../../../vendor/rs-sdk/sdk/execution-context';
import { walkQuestCorridor } from './helpers';
import { resolveCrossStrongholdGate, STRONGHOLD_GATE_REF, type GateDepsLike } from './runtime';
import {
    approachOf,
    BOAT_FARES,
    catalogItem,
    CATHERBY_BEACH,
    cheb,
    COINS,
    countItems,
    eastOfArdougne,
    eastOfPass,
    ELENA_HOUSE,
    extractSpellRunes,
    FAR_SELLER,
    generalStores,
    HECKEL_DUST,
    hopsTo,
    inElenaHouse,
    inMagicGuild,
    inWestArdougne,
    JIMINUA,
    JIMINUA_FROM_BRIMHAVEN,
    KARAMJA,
    MAGIC_GUILD,
    magicGuildApproach,
    MANOR_FOOD,
    MANOR_POISON,
    MAX_HOP,
    NET,
    OBSERVATORY_FROM_ARDOUGNE,
    prayerShort,
    prayerWanted,
    questScriptId,
    RAW_ANCHOVIES,
    RAW_SHRIMPS,
    runeInventoryAccount,
    sameArea,
    SARIM_LANDING,
    SARIM_NORTH,
    scorpionCureJourney,
    SEERS_ALTAR,
    SHOP_TALK,
    surfaceOf,
    SWEEP_PLAN_BUDGET_MS,
    TAVERLEY_SIDE,
    TRAIN_TICKS,
    travelDistance,
    UNDERGROUND,
    wayDown,
    WEST_ARDOUGNE,
    type Buy,
    type LightStep,
    type Pt,
    type Walked,
} from './sweep-plan';
import { castable } from './teleport-runes';

type Item = { id: number; count: number };

const STOPPED: Walked = { ok: false, reason: 'stopped', detail: 'quest guard' };

export const atTile = (s: Session): Tile => {
    const q = s.sdk.getState()?.player;
    return { x: q?.worldX ?? 0, z: q?.worldZ ?? 0, level: q?.level ?? 0 };
};

export async function sweepPlan(
    world: World,
    from: Tile,
    to: Tile,
    acct: Account,
    budgetMs = SWEEP_PLAN_BUDGET_MS,
    offThreadPlan = planTripOffThread,
): Promise<Pick<TripPlan, 'cost' | 'legs'> | null> {
    if (!world.offThread) {
        const d = world.route(from, to, acct, { deadline: performance.now() + budgetMs });
        return d.ok ? { cost: d.cost, legs: d.legs } : null;
    }
    try {
        return await offThreadPlan(from, to, acct, undefined, budgetMs);
    } catch (error) {
        if (executionContext.getStore()?.signal?.aborted) throw error;
        console.log(`QUEST_SWEEP_PLAN_FAULT ${JSON.stringify({ from, to, error: String(error).slice(0, 160) })}`);
        return null;
    }
}

export async function planTeleportRunes(
    world: World,
    from: Tile,
    to: Tile,
    acct: Account,
    bank: readonly Item[],
    nameOf: (id: number) => string | undefined,
    idOf: (name: string) => number | undefined,
    budgetMs = SWEEP_PLAN_BUDGET_MS,
    offThreadPlan = planTripOffThread,
): Promise<Item[]> {
    const withRunes = runeInventoryAccount(acct, bank, nameOf);
    if (!withRunes) return [];
    const plan = await sweepPlan(world, from, to, withRunes, budgetMs, offThreadPlan);
    return plan ? extractSpellRunes(plan.legs, idOf) : [];
}

export async function reserveInputSlots(s: Session, inputs: readonly Item[], keep: ReadonlySet<number>): Promise<string | null> {
    const pack = () => s.sdk.getState()?.inventory ?? [];
    const bank = () => s.sdk.getState()?.bank?.items ?? [];
    const client = s.client as { objType?: (id: number) => { stackable: boolean } };
    const slots = () => {
        const stacks = new Set(pack().map((i) => i.id));
        let n = 0;
        for (const i of inputs) {
            if (client.objType?.(i.id)?.stackable) {
                if (!stacks.has(i.id)) {
                    n++;
                    stacks.add(i.id);
                }
            } else {
                n += i.count;
            }
        }
        return n;
    };
    for (const id of new Set(pack().map((i) => i.id))) {
        if (28 - pack().length >= slots()) break;
        if (keep.has(id)) continue;
        const row = pack().find((i) => i.id === id)!;
        const held = countItems(pack(), id);
        const stored = countItems(bank(), id);
        await s.bot.depositItem(row, -1);
        if (!(await waitUntil(s, () => countItems(pack(), id) === 0 && countItems(bank(), id) === stored + held, { timeoutTicks: 10 }))) {
            return `capacity deposit unobserved ${id}:${held}`;
        }
    }
    const required = slots();
    const free = 28 - pack().length;
    console.log(`QUEST_SWEEP_CAPACITY ${JSON.stringify({ required, free })}`);
    return free >= required ? null : `input capacity short: free ${free}, required ${required}`;
}

// Lights each planned light source at the open bank: withdraws the unlit ones and a tinderbox, closes the bank (the
// bank hides the inventory, and the server refuses an item use under it), uses each unlit one on the tinderbox, opens
// the bank again and banks a tinderbox that it withdrew and that the quest pack does not need. Each light is one free
// slot fewer than a staged unlit one and a staged tinderbox: Temple of Ikov at stage 10 fills all 28 slots with the
// pendant of Lucien and the lit candle.
export async function lightAtBank(s: Session, lights: readonly LightStep[], keepTinderbox: boolean): Promise<string | null> {
    const pack = () => (s.sdk.getState()?.inventory ?? []).map((i) => ({ id: i.id, count: i.count }));
    const bank = () => (s.sdk.getState()?.bank?.items ?? []).map((i) => ({ id: i.id, count: i.count }));
    const take = async (id: number, count: number) => {
        const row = (s.sdk.getState()?.bank?.items ?? []).find((i) => i.id === id);
        if (!row) return `light: bank row ${id} vanished`;
        const before = countItems(pack(), id);
        await s.bot.withdrawItem(row, count);
        return (await waitUntil(s, () => countItems(pack(), id) === before + count, { timeoutTicks: 10 })) ? null : `light: withdraw unobserved ${id}:${count}`;
    };
    const tinderFromBank = countItems(pack(), TINDERBOX) === 0;
    const required = lights.reduce((n, l) => n + Math.max(0, l.count - countItems(pack(), l.unlit)), tinderFromBank ? 1 : 0);
    const free = 28 - pack().length;
    if (free < required) {
        console.log(`QUEST_SWEEP_LIGHT ${JSON.stringify({ skipped: 'pack room', free, required })}`);
        return null;
    }
    if (tinderFromBank) {
        const why = await take(TINDERBOX, 1);
        if (why) return why;
    }
    for (const l of lights) {
        const short = l.count - countItems(pack(), l.unlit);
        if (short > 0) {
            const why = await take(l.unlit, short);
            if (why) return why;
        }
    }
    const closed = await s.bot.closeBank();
    if (!closed.success) return `light: ${closed.message}`;
    const made: Record<number, number> = {};
    for (const l of lights) {
        made[l.lit] = 0;
        for (let i = 0; i < l.count; i++) {
            const inv = s.sdk.getState()?.inventory ?? [];
            const unlit = inv.find((it) => it.id === l.unlit), tinder = inv.find((it) => it.id === TINDERBOX);
            if (!unlit || !tinder) return `light: ${l.unlit} or ${TINDERBOX} left the pack`;
            const before = countItems(pack(), l.lit);
            await s.direct({ type: 'useItemOnItem', sourceSlot: unlit.slot, targetSlot: tinder.slot, reason: 'SDK' });
            if (!(await waitUntil(s, () => countItems(pack(), l.lit) > before, { timeoutTicks: 5 }))) {
                return `light: ${l.unlit} on ${TINDERBOX} made no ${l.lit}`;
            }
            made[l.lit]!++;
        }
    }
    if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 10 }))) {
        return 'bank did not reopen after the light';
    }
    // The sweep plans from the bank rows next, so the light waits for them as the first bank open does.
    await waitUntil(s, () => bank().length > 0, { timeoutTicks: 10 });
    let banked = false;
    if (tinderFromBank && !keepTinderbox) {
        const row = (s.sdk.getState()?.inventory ?? []).find((i) => i.id === TINDERBOX);
        if (row) await s.bot.depositItem(row, -1);
        banked = await waitUntil(s, () => countItems(pack(), TINDERBOX) === 0, { timeoutTicks: 10 });
        if (!banked) return `light: tinderbox deposit unobserved`;
    }
    console.log(`QUEST_SWEEP_LIGHT ${JSON.stringify({ lights, made, tinderbox: tinderFromBank ? (banked ? 'banked again' : 'kept') : 'pack', free: 28 - pack().length })}`);
    return null;
}

export async function leaveStronghold(
    s: Session,
    approach: (to: Tile) => Promise<{ ok: boolean }> = async (to) => walkPath(await sessionWalker(s), [{ ...to, tol: 0 }], { maxTicks: 150 }),
) {
    const pos = () => s.sdk.getState()?.player;
    const p = pos();
    if (!p || p.level !== 0 || p.worldX < 2369 || p.worldX > 2505 || p.worldZ < 3385 || p.worldZ > 3524) return { ok: true };
    if (p.worldX >= 2464 && p.worldX <= 2467 && p.worldZ >= 3493 && p.worldZ <= 3495) {
        await s.direct({ type: 'interactLoc', x: 2466, z: 3492, locId: 1968, optionIndex: 1, reason: 'SDK' });
        const outside = await waitUntil(s, () => {
            const q = pos();
            return q?.level === 0 && q.worldX === 2466 && q.worldZ === 3491;
        }, { timeoutTicks: 30 });
        console.log(`QUEST_SWEEP_TREE_EXIT ${JSON.stringify({ ok: outside, at: pos() && { x: pos()!.worldX, z: pos()!.worldZ, level: pos()!.level } })}`);
        if (!outside) return { ok: false, detail: 'Grand Tree southern landing unobserved' };
    }
    const walked = await approach({ x: 2461, z: 3385, level: 0 });
    if (!walked.ok) return { ok: false, detail: 'Stronghold north gate approach failed' };
    const n = pos();
    if (n?.worldX !== 2461 || n.worldZ !== 3385 || n.level !== 0) return { ok: false, detail: 'Stronghold north landing unobserved' };
    await s.direct({ type: 'interactLoc', x: 2459, z: 3383, locId: 190, optionIndex: 1, reason: 'SDK' });
    const crossed = await waitUntil(s, () => {
        const p = pos();
        return p?.worldX === 2461 && p.worldZ === 3382 && p.level === 0;
    }, { timeoutTicks: 30 });
    console.log(`QUEST_SWEEP_GATE ${JSON.stringify({ ok: crossed, at: pos() && { x: pos()!.worldX, z: pos()!.worldZ, level: pos()!.level } })}`);
    return { ok: crossed, detail: crossed ? undefined : 'Stronghold southern landing unobserved' };
}

const inBoxRoom = (p: { worldX: number; worldZ: number; level: number }) =>
    p.level === 1 && p.worldX >= 3026 && p.worldX <= 3031 && p.worldZ >= 3504 && p.worldZ <= 3509;

export async function leaveFortress(
    s: Session,
    approach: (to: readonly Tile[]) => Promise<{ ok: boolean }> = async (to) =>
        walkPath(await sessionWalker(s), to.map((t) => ({ x: t.x, z: t.z, tol: 0 })), { maxTicks: 150 }),
) {
    const pos = () => s.sdk.getState()?.player;
    const at = (x: number, z: number, level: number, tol = 0) => {
        const p = pos();
        return !!p && p.level === level && Math.abs(p.worldX - x) <= tol && Math.abs(p.worldZ - z) <= tol;
    };
    const where = () => {
        const p = pos();
        return p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown';
    };
    const p = pos();
    if (!p || !inBoxRoom(p)) return { ok: true };
    const log = (step: string, ok: boolean) => console.log(`QUEST_SWEEP_FORTRESS ${JSON.stringify({ step, ok, at: where() })}`);
    if (!(await approach([{ x: 3030, z: 3509, level: 1 }])).ok || !at(3030, 3509, 1)) {
        log('wall tile', false);
        return { ok: false, detail: `fortress secret wall tile 3030,3509,1 unobserved at ${where()}` };
    }
    await s.direct({ type: 'interactLoc', x: 3030, z: 3510, locId: 2341, optionIndex: 1, reason: 'SDK' });
    const pushed = await waitUntil(s, () => {
        const p = pos();
        return !!p && p.level === 1 && p.worldZ >= 3510;
    }, { timeoutTicks: 20 });
    log('secret wall', pushed);
    if (!pushed) return { ok: false, detail: `fortress secret wall push unobserved at ${where()}` };
    if (!(await approach([{ x: 3030, z: 3516, level: 1 }, { x: 3029, z: 3517, level: 1 }, { x: 3022, z: 3517, level: 1 }])).ok || !at(3022, 3517, 1)) {
        log('corridor', false);
        return { ok: false, detail: `fortress corridor 3022,3517,1 unobserved at ${where()}` };
    }
    await s.direct({ type: 'interactLoc', x: 3022, z: 3518, locId: 1749, optionIndex: 1, reason: 'SDK' });
    const down = await waitUntil(s, () => pos()?.level === 0, { timeoutTicks: 20 });
    log('hall ladder', down);
    if (!down) return { ok: false, detail: `fortress hall ladder descent unobserved at ${where()}` };
    const out = (await approach([{ x: 3016, z: 3512, level: 0 }])).ok && at(3016, 3512, 0, 1);
    log('front', out);
    return out ? { ok: true } : { ok: false, detail: `fortress front 3016,3512,0 unobserved at ${where()}` };
}

const inHazeelCave = (p: { worldX: number; worldZ: number; level: number }) =>
    p.level === 0 && p.worldX >= 2555 && p.worldX <= 2625 && p.worldZ >= 9655 && p.worldZ <= 9705;

export async function leaveHazeelCave(
    s: Session,
    approach: (to: readonly Tile[]) => Promise<{ ok: boolean }> = async (to) =>
        walkPath(await sessionWalker(s), to.map((t) => ({ x: t.x, z: t.z, tol: 0 })), { maxTicks: 150 }),
) {
    const pos = () => s.sdk.getState()?.player;
    const where = () => {
        const p = pos();
        return p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown';
    };
    const p = pos();
    if (!p || !inHazeelCave(p)) return { ok: true };
    const log = (step: string, ok: boolean) => console.log(`QUEST_SWEEP_HAZEEL_CAVE ${JSON.stringify({ step, ok, at: where() })}`);
    const foot =
        (await approach([{ x: 2570, z: 9682, level: 0 }])).ok &&
        (() => {
            const q = pos();
            return !!q && q.level === 0 && Math.abs(q.worldX - 2570) <= 1 && Math.abs(q.worldZ - 9682) <= 1;
        })();
    log('stairs foot', foot);
    if (!foot) return { ok: false, detail: `hazeel cave stairs foot 2570,9682,0 unobserved at ${where()}` };
    await s.direct({ type: 'interactLoc', x: 2570, z: 9683, locId: 2853, optionIndex: 1, reason: 'SDK' });
    const up = await waitUntil(s, () => {
        const q = pos();
        return !!q && q.worldZ < 9000;
    }, { timeoutTicks: 20 });
    log('stairs', up);
    return up ? { ok: true } : { ok: false, detail: `hazeel cave stairs climb unobserved at ${where()}` };
}

// Keep Le Faye with its jetty: the walls (loc 1911) of maps/m43_53.jm2 enclose x 2764-2776, z 3395-3409, and the
// jetty is 2777-2780,3399-3402. The walker has no way out (live Merlin's Crystal runs that ended there logged in at
// 2768,3409 and 2771,3409, and every walk failed with "no route"). The keep crate on the jetty (loc 64 at 2779,3401,
// op 2, "Yes.") ships the player to the Catherby pier with no varp check (quest_arthur.rs2:38-66), as quest-merlin.ts
// leaves the keep.
export const inKeepLeFaye = (p: { worldX: number; worldZ: number; level: number }) =>
    p.level === 0 && p.worldX >= 2764 && p.worldX <= 2780 && p.worldZ >= 3395 && p.worldZ <= 3409;

export async function leaveKeepLeFaye(s: Session): Promise<{ ok: boolean; detail?: string }> {
    const pos = () => s.sdk.getState()?.player;
    const where = () => {
        const p = pos();
        return p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown';
    };
    const p0 = pos();
    if (!p0 || !inKeepLeFaye(p0)) return { ok: true };
    const from = where();
    const near = (x: number, z: number, tol: number) => {
        const p = pos();
        return !!p && p.level === 0 && Math.abs(p.worldX - x) <= tol && Math.abs(p.worldZ - z) <= tol;
    };
    const landed = () => near(2802, 3441, 3);
    const onJetty = () => (pos()?.worldX ?? 0) >= 2777;
    // The double doors 1516/1519 at 2776,3400-3401 (maps/m43_53.jm2 0 24 8-9) between the keep and the jetty start
    // shut, and a walk click does not open them (hosted bench extra:sweep-merlin-resume-s3-keep: no move from 2768,3409).
    const openDoor = async () => {
        const door = (s.sdk.getState()?.nearbyLocs ?? []).find(
            (l: any) => l.x === 2776 && (l.z === 3400 || l.z === 3401) && (l.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text)),
        ) as any;
        if (!door) return;
        const op = (door.optionsWithIndex as { text: string; opIndex: number }[]).find((o) => /^open$/i.test(o.text))!.opIndex;
        await s.direct({ type: 'interactLoc', x: door.x, z: door.z, locId: door.id, optionIndex: op, reason: 'SDK' });
        await waitUntil(s, () => !(s.sdk.getState()?.nearbyLocs ?? []).some(
            (l: any) => l.x === 2776 && l.z === door.z && (l.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text)),
        ), { timeoutTicks: 12 });
    };
    // The session walker opens doors on its way (live Dipstick walked from the jetty to 2768,3409 with it).
    if (!onJetty()) await walkPath(await sessionWalker(s), [{ x: 2778, z: 3401, tol: 0 }], { maxTicks: 60 });
    for (let i = 0; i < 3 && !landed(); i++) {
        if (!onJetty()) {
            await s.direct({ type: 'walkTo', x: 2775, z: 3401, running: true, reason: 'SDK' });
            await waitUntil(s, () => near(2775, 3401, 0), { timeoutTicks: 30 });
            await openDoor();
        }
        await s.direct({ type: 'walkTo', x: 2778, z: 3401, running: true, reason: 'SDK' });
        await waitUntil(s, () => near(2778, 3401, 1), { timeoutTicks: 15 });
        await s.direct({ type: 'interactLoc', x: 2779, z: 3401, locId: 64, optionIndex: 2, reason: 'SDK' });
        for (let k = 0; k < 120 && !landed(); k++) {
            const dlg: any = s.sdk.getDialog();
            if (dlg?.isOpen && !dlg.isWaiting) {
                if ((dlg.options ?? []).some((o: any) => /^yes\.?$/i.test(o.text))) await s.sdk.clickDialogByText(/^yes\.?$/i);
                else await s.sdk.sendClickDialog(0);
            }
            await waitTicks(s, 1);
        }
    }
    for (let k = 0; k < 6 && s.sdk.getDialog()?.isOpen; k++) {
        await s.sdk.sendClickDialog(0);
        await waitTicks(s, 1);
    }
    console.log(`QUEST_SWEEP_KEEP_LE_FAYE_EXIT ${JSON.stringify({ from, ok: landed(), at: where() })}`);
    return landed() ? { ok: true } : { ok: false, detail: `keep le faye crate to catherby unobserved at ${where()}` };
}

const inMournerHq = (p: { worldX: number; worldZ: number; level: number }) =>
    p.level === 0 && p.worldX >= 2539 && p.worldX <= 2557 && p.worldZ >= 3321 && p.worldZ <= 3330;
type ExitPoint = Tile & { tol?: number };
export type WestArdougneDeps = { approach: (to: readonly ExitPoint[]) => Promise<{ ok: boolean }>; canTeleport: () => boolean; walled: () => boolean };

export async function leaveWestArdougne(s: Session, deps: Partial<WestArdougneDeps> = {}): Promise<{ ok: boolean; detail?: string }> {
    const W = WEST_ARDOUGNE;
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const where = () => {
        const p = pos();
        return p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown';
    };
    const tile = () => {
        const p = pos();
        return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null;
    };
    const out = () => (pos()?.worldX ?? 0) >= W.landing.x;
    const p0 = pos();
    if (!p0 || p0.level > 1 || !inWestArdougne({ x: p0.worldX, z: p0.worldZ })) return { ok: true };
    const approach = deps.approach ?? (async (to) => walkPath(await sessionWalker(s), to.map((t) => ({ x: t.x, z: t.z, tol: t.tol ?? 0 })), { maxTicks: 150 }));
    const magic = () => st()?.skills?.find((k: any) => k.name === 'Magic')?.level ?? 1;
    const held = (id: number) => (st()?.inventory ?? []).filter((i: any) => i.id === id).reduce((n: number, i: any) => n + (i.count ?? 1), 0);
    const canTeleport = deps.canTeleport ?? (() => castable(W.teleport.comp, held, s.sdk.getEquipment().map((i) => i.id), magic()));
    const walled = deps.walled ?? (() => questFlags(s.client)?.find((f) => f.name === 'Biohazard')?.state !== 'complete');
    if (!walled()) return { ok: true };
    const from = tile();
    const report = (method: string) => {
        console.log(`QUEST_SWEEP_WEST_ARDOUGNE_EXIT ${JSON.stringify({ from, method, ok: out(), at: tile() })}`);
    };
    if (canTeleport()) {
        for (let i = 0; i < 3 && !out(); i++) {
            await s.direct({ type: 'clickComponent', componentId: componentId(W.teleport.comp), reason: 'SDK' });
            await waitUntil(s, out, { timeoutTicks: 12 });
        }
        if (out()) {
            report('teleport');
            return { ok: true };
        }
    }
    const fail = (step: string) => {
        report('kilron');
        return { ok: false, detail: `west ardougne exit: ${step} unobserved at ${where()}` };
    };
    const openOp = (l: { x: number; z: number; id?: number }) => {
        const loc = (st()?.nearbyLocs ?? []).find(
            (k: any) => k.x === l.x && k.z === l.z && (l.id === undefined || k.id === l.id) && (k.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text)),
        );
        return loc
            ? { id: loc.id as number, op: (loc.optionsWithIndex as { text: string; opIndex: number }[]).find((o) => /^open$/i.test(o.text))!.opIndex }
            : null;
    };
    const cross = async (d: { id: number; x: number; z: number }, through: () => boolean) => {
        for (let i = 0; i < 4 && !through(); i++) {
            const o = openOp(d);
            await s.direct({ type: 'interactLoc', x: d.x, z: d.z, locId: o?.id ?? d.id, optionIndex: o?.op ?? 1, reason: 'SDK' });
            await waitUntil(s, through, { timeoutTicks: 12 });
        }
        return through();
    };
    const x = () => pos()?.worldX ?? 0;
    const z = () => pos()?.worldZ ?? 0;
    const lvl = () => pos()?.level ?? -1;
    const at = (t: { x: number; z: number }, level: number, tol = 0) => {
        const p = pos();
        return !!p && p.level === level && Math.abs(p.worldX - t.x) <= tol && Math.abs(p.worldZ - t.z) <= tol;
    };
    if (lvl() === 1) {
        if (x() > W.gate.x) {
            if (!(await approach([{ x: W.gate.x + 1, z: W.gate.z, level: 1 }])).ok || !at({ x: W.gate.x + 1, z: W.gate.z }, 1)) return fail('hq gate tile');
            if (!(await cross(W.gate, () => x() <= W.gate.x))) return fail('hq gate');
        }
        if (!(await approach([{ x: W.upDoor.x, z: W.upDoor.z, level: 1 }])).ok || !at(W.upDoor, 1)) return fail('hq up door tile');
        if (!(await cross(W.upDoor, () => x() < W.upDoor.x))) return fail('hq up door');
        for (let i = 0; i < 4 && lvl() !== 0; i++) {
            await s.direct({ type: 'interactLoc', x: W.stairsTop.x, z: W.stairsTop.z, locId: W.stairsTop.id, optionIndex: 1, reason: 'SDK' });
            await waitUntil(s, () => lvl() === 0, { timeoutTicks: 15 });
        }
        if (lvl() !== 0) return fail('hq stairs down');
    }
    const p1 = pos();
    if (p1 && inMournerHq(p1)) {
        if (x() <= W.stairsDoor.x) {
            if (!(await approach([{ x: W.stairsDoor.x, z: W.stairsDoor.z, level: 0 }])).ok || !at(W.stairsDoor, 0)) return fail('stairs door tile');
            const o = openOp(W.stairsDoor);
            if (o) {
                await s.direct({ type: 'interactLoc', x: W.stairsDoor.x, z: W.stairsDoor.z, locId: o.id, optionIndex: o.op, reason: 'SDK' });
                await waitUntil(s, () => !openOp(W.stairsDoor), { timeoutTicks: 8 });
            }
            if (!(await approach([{ x: W.stairsLeaf.x, z: W.stairsLeaf.z, level: 0 }])).ok || !at(W.stairsLeaf, 0)) return fail('stairs doorway');
        }
        // Live KnightRider and mmsmk1232: with the leaf open, three walks from 2546,3325 to the HQ door tile got
        // client_rejected. Shut from the doorway tile, the door wall is on the stairs room side again. The leaf walls in
        // only the doorway tile and the two tiles north and east of it (2547,3326 and 2548,3326).
        const leaf = () => (st()?.nearbyLocs ?? []).find(
            (k: any) => k.x === W.stairsLeaf.x && k.z === W.stairsLeaf.z && (k.optionsWithIndex ?? []).some((o: any) => /^close$/i.test(o.text)),
        );
        const pocket = () => lvl() === 0 && x() > W.stairsDoor.x && x() <= W.stairsLeaf.x + 1 && z() >= W.stairsLeaf.z && z() <= W.stairsLeaf.z + 1;
        for (let i = 0; i < 4 && pocket() && leaf(); i++) {
            const l: any = leaf();
            const op = (l.optionsWithIndex as { text: string; opIndex: number }[]).find((o) => /^close$/i.test(o.text))!.opIndex;
            await s.direct({ type: 'interactLoc', x: l.x, z: l.z, locId: l.id, optionIndex: op, reason: 'SDK' });
            await waitUntil(s, () => !leaf(), { timeoutTicks: 8 });
        }
        if (pocket() && leaf()) return fail('stairs door shut');
        if (!(await approach([{ x: W.hqDoor.x, z: W.hqDoor.z + 1, level: 0 }])).ok || !at({ x: W.hqDoor.x, z: W.hqDoor.z + 1 }, 0)) return fail('hq door tile');
        if (!(await cross(W.hqDoor, () => z() <= W.hqDoor.z))) return fail('hq door');
    }
    if (!(await approach([{ x: W.kilron.x, z: W.kilron.z + 2, level: 0, tol: 2 }])).ok || !at({ x: W.kilron.x, z: W.kilron.z + 2 }, 0, 2)) {
        return fail('kilron approach');
    }
    for (let i = 0; i < 3 && !out(); i++) {
        const npc = (st()?.nearbyNpcs ?? [])
            .filter((n: any) => n.id === W.kilron.id || /^kilron$/i.test(n.name ?? ''))
            .sort((a: any, b: any) => a.distance - b.distance)[0];
        if (!npc) {
            await waitTicks(s, 2);
            continue;
        }
        const t: any = await s.bot.talkTo(npc);
        if (!t?.success) continue;
        for (let k = 0; k < 40 && !out(); k++) {
            const dlg: any = s.sdk.getDialog();
            if (dlg?.isOpen && !dlg.isWaiting) {
                if ((dlg.options ?? []).some((o: any) => /yes i do/i.test(o.text))) await s.sdk.clickDialogByText(/yes i do/i);
                else await s.sdk.sendClickDialog(0);
            }
            await waitTicks(s, 1);
        }
        await waitUntil(s, out, { timeoutTicks: 10 });
    }
    for (let k = 0; k < 6 && s.sdk.getDialog()?.isOpen; k++) {
        await s.sdk.sendClickDialog(0);
        await waitTicks(s, 1);
    }
    if (!out()) return fail('kilron ladder');
    report('kilron');
    return { ok: true };
}

export type ElenaDoorDeps = { approach: (to: Tile) => Promise<{ ok: boolean }> };
export async function enterElenaHouse(s: Session, deps: Partial<ElenaDoorDeps> = {}): Promise<{ ok: boolean; detail?: string }> {
    const E = ELENA_HOUSE;
    const pos = () => s.sdk.getState()?.player;
    const tile = () => {
        const p = pos();
        return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null;
    };
    const where = () => {
        const t = tile();
        return t ? `${t.x},${t.z},${t.level}` : 'unknown';
    };
    const inside = () => {
        const t = tile();
        return !!t && inElenaHouse(t);
    };
    if (inside()) return { ok: true };
    const approach = deps.approach ?? (async (to) => walkPath(await sessionWalker(s), [{ x: to.x, z: to.z, tol: 0 }], { maxTicks: 150 }));
    const from = tile();
    const report = () => {
        console.log(`QUEST_SWEEP_ELENA_DOOR ${JSON.stringify({ from, ok: inside(), at: tile() })}`);
    };
    const door = () => {
        const t = tile();
        return !!t && t.level === 0 && t.z >= E.outside.z && Math.max(Math.abs(t.x - E.outside.x), Math.abs(t.z - E.outside.z)) <= 1;
    };
    await approach(E.outside);
    if (!door()) {
        report();
        return { ok: false, detail: `elena door tile ${E.outside.x},${E.outside.z},0 unobserved at ${where()}` };
    }
    const through = () => {
        const t = tile();
        return !!t && t.level === 0 && t.z < E.door.z;
    };
    for (let i = 0; i < 4 && !through(); i++) {
        const loc = (s.sdk.getState()?.nearbyLocs ?? []).find((k: any) => k.x === E.door.x && k.z === E.door.z && k.id === E.door.id);
        const op = (loc?.optionsWithIndex as { text: string; opIndex: number }[] | undefined)?.find((o) => /^open$/i.test(o.text))?.opIndex ?? 1;
        await s.direct({ type: 'interactLoc', x: E.door.x, z: E.door.z, locId: E.door.id, optionIndex: op, reason: 'SDK' });
        await waitUntil(s, through, { timeoutTicks: 12 });
    }
    report();
    return through() ? { ok: true } : { ok: false, detail: `elena door unobserved at ${where()}` };
}

type ManorLoc = { id: number; x: number; z: number };
type ManorItem = { id: number; x: number; z: number; level: number };
export type ManorIO = {
    pos: () => Tile | undefined;
    held: (item: ManorItem) => number;
    ground: (item: ManorItem) => { x: number; z: number } | undefined;
    travel: (to: Tile) => Promise<{ ok: boolean; detail?: string }>;
    walk: (to: readonly Tile[]) => Promise<{ ok: boolean; detail?: string }>;
    op: (loc: ManorLoc, re: RegExp) => Promise<unknown>;
    pickup: (at: { x: number; z: number }, item: ManorItem) => Promise<unknown>;
    wait: (ok: () => boolean, ticks: number) => Promise<boolean>;
};

export async function fetchManorFishFood(
    io: ManorIO,
    start: Tile,
    want: { food: boolean; poison: boolean } = { food: true, poison: false },
): Promise<{ ok: boolean; detail?: string }> {
    const where = () => {
        const p = io.pos();
        return p ? `${p.x},${p.z},${p.level}` : 'unknown';
    };
    const at = (x: number, z: number, level: number, tol = 0) => {
        const p = io.pos();
        return !!p && p.level === level && Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) <= tol;
    };
    const log = (step: string, ok: boolean, extra: object = {}) => console.log(`QUEST_SWEEP_MANOR ${JSON.stringify({ step, ok, at: where(), ...extra })}`);
    const fail = (step: string, what: string) => {
        log(step, false);
        return { ok: false, detail: `manor fish food ${what} unobserved at ${where()}` };
    };
    const take = async (item: ManorItem, name: string): Promise<{ ok: boolean; detail?: string }> => {
        const before = io.held(item);
        if (!io.ground(item) && !(await io.wait(() => !!io.ground(item), 60))) return fail(name, `ground ${name}`);
        for (let i = 0; i < 3 && io.held(item) < before + 1; i++) {
            const g = io.ground(item);
            if (g) await io.pickup(g, item);
            await io.wait(() => io.held(item) >= before + 1, 10);
        }
        const got = io.held(item) === before + 1;
        log('pickup', got, { item: item.id, before, after: io.held(item) });
        return got ? { ok: true } : { ok: false, detail: `manor ${name} inventory credit unobserved: ${before} -> ${io.held(item)} at ${where()}` };
    };
    const travelled = await io.travel(start);
    if (!travelled.ok) {
        log('travel', false);
        return { ok: false, detail: `manor fish food travel to ${start.x},${start.z} failed: ${travelled.detail}` };
    }
    if (!(await io.walk([{ x: 3108, z: 3352, level: 0 }])).ok || !at(3108, 3352, 0)) return fail('front', 'front door tile 3108,3352,0');
    await io.op({ id: 134, x: 3108, z: 3353 }, /^open$/i);
    if (!(await io.wait(() => {
        const p = io.pos();
        return !!p && p.level === 0 && p.z >= 3354;
    }, 20))) return fail('front door', 'front door entry');
    log('front door', true);
    if (want.poison) {
        const r = await io.travel(MANOR_POISON);
        if (!r.ok || !at(MANOR_POISON.x, MANOR_POISON.z, 0, 1)) return fail('poison tile', 'poison tile 3097,3366,0');
        const taken = await take(MANOR_POISON, 'poison');
        if (!taken.ok) return taken;
        const back = await io.travel({ x: 3108, z: 3362, level: 0 });
        if (!back.ok || !at(3108, 3362, 0, 1)) return fail('hall', 'stairs tile 3108,3362,0');
    }
    if (want.food) {
        if (!(await io.walk([{ x: 3108, z: 3362, level: 0 }])).ok || !at(3108, 3362, 0)) return fail('hall', 'stairs tile 3108,3362,0');
        await io.op({ id: 1730, x: 3108, z: 3363 }, /climb-up/i);
        if (!(await io.wait(() => io.pos()?.level === 1, 20))) return fail('stairs up', 'level 1');
        log('stairs up', true);
        if (!(await io.walk([MANOR_FOOD])).ok || !at(MANOR_FOOD.x, MANOR_FOOD.z, 1, 1)) return fail('food tile', 'food tile 3108,3356,1');
        const taken = await take(MANOR_FOOD, 'fish food');
        if (!taken.ok) return taken;
        if (!(await io.walk([{ x: 3108, z: 3366, level: 1 }])).ok || !at(3108, 3366, 1, 1)) return fail('landing', 'stairs landing 3108,3366,1');
        await io.op({ id: 1731, x: 3108, z: 3364 }, /climb-down/i);
        if (!(await io.wait(() => io.pos()?.level === 0, 20))) return fail('stairs down', 'level 0');
        log('stairs down', true);
    }
    if (!(await io.walk([{ x: 3123, z: 3361, level: 0 }])).ok || !at(3123, 3361, 0)) return fail('back door', 'back door exit 3123,3361,0');
    log('back door', true);
    return { ok: true };
}

export function manorIO(s: Session, world: World): ManorIO {
    const st = () => s.sdk.getState() as any;
    return {
        pos: () => {
            const p = st()?.player;
            return p ? { x: p.worldX, z: p.worldZ, level: p.level } : undefined;
        },
        held: (item) => countItems((st()?.inventory ?? []).map((i: any) => ({ id: i.id, count: i.count })), item.id),
        ground: (item) =>
            st()?.player?.level === item.level
                ? (st()?.groundItems ?? []).find((g: any) => g.id === item.id && g.x === item.x && g.z === item.z)
                : undefined,
        travel: async (to) => {
            const r = await goTo(s, world, to, accountOf(s), { legTimeoutTicks: 150 });
            return r.ok ? { ok: true } : { ok: false, detail: `${r.reason} ${r.detail}` };
        },
        walk: async (to) => walkPath(await sessionWalker(s), to.map((t) => ({ x: t.x, z: t.z, tol: 0 })), { maxTicks: 150 }),
        op: async (loc, re) => {
            const l = (st()?.nearbyLocs ?? []).find((n: any) => n.x === loc.x && n.z === loc.z && (n.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));
            await s.direct({
                type: 'interactLoc',
                x: loc.x,
                z: loc.z,
                locId: l?.id ?? loc.id,
                optionIndex: l?.optionsWithIndex.find((o: any) => re.test(o.text)).opIndex ?? 1,
                reason: 'SDK',
            });
        },
        pickup: async (g, item) => s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: item.id, reason: 'SDK' }),
        wait: (ok, ticks) => waitUntil(s, ok, { timeoutTicks: ticks }),
    };
}

export type HeckelIO = {
    pos: () => Tile | undefined;
    held: () => number;
    coins: () => number;
    gate: () => Promise<unknown>;
    travel: (to: Tile) => Promise<{ ok: boolean; detail?: string }>;
    walk: (to: Tile) => Promise<{ ok: boolean }>;
    climb: (up: boolean) => Promise<unknown>;
    open: () => Promise<boolean>;
    row: () => Item | undefined;
    buy: (row: Item) => Promise<unknown>;
    close: () => Promise<unknown>;
    wait: (ok: () => boolean, ticks: number) => Promise<boolean>;
};

export async function fetchHeckelDust(io: HeckelIO): Promise<{ ok: boolean; detail?: string }> {
    const at = (to: Tile, tol = 2) => {
        const p = io.pos();
        return !!p && p.level === to.level && Math.max(Math.abs(p.x - to.x), Math.abs(p.z - to.z)) <= tol;
    };
    const fail = (detail: string) => ({ ok: false, detail: `Heckel dust ${detail}` });
    const before = io.held();
    const p = io.pos();
    if (!p) return fail('Stronghold entry location unobserved');
    if (!(p.level === 0 && p.x >= 2369 && p.x <= 2505 && p.z >= 3385 && p.z <= 3524)) {
        const south = { ...STRONGHOLD_GATE_REF.south, level: 0 };
        const approach = await io.travel(south);
        console.log(`QUEST_SWEEP_HECKEL_APPROACH ${JSON.stringify({ from: p, to: south, at: io.pos(), observed: approach.ok && at(south, 1) })}`);
        if (!approach.ok || !at(south, 1)) return fail(`Stronghold south leg to 2461,3382,0 failed: ${approach.detail ?? 'arrival unobserved'}`);
        try {
            await io.gate();
        } catch (error) {
            return fail(`Stronghold gate leg 2461,3382,0 -> 2461,3385,0 failed: ${String(error)}`);
        }
        if (!at({ ...STRONGHOLD_GATE_REF.north, level: 0 }, 0)) return fail('Stronghold gate leg to 2461,3385,0 failed: north arrival unobserved');
    }
    const travelled = await io.travel(HECKEL_DUST.ground);
    if (!travelled.ok) return fail(`Stronghold ground leg to 2493,3488,0 failed: ${travelled.detail}`);
    if (!at(HECKEL_DUST.ground)) return fail('Stronghold ground arrival 2493,3488,0 unobserved');
    const landing = { x: 2466, z: 3494, level: 0 };
    if (!(await io.walk(landing)).ok || !at(landing, 0)) return fail('ladder approach 2466,3494,0 unobserved');
    await io.climb(true);
    if (!(await io.wait(() => at({ ...landing, level: 1 }), 20))) return fail('ladder up 2466,3495,1 unobserved');
    const seller = { x: 2493, z: 3488, level: 1 };
    if (!(await io.walk(seller)).ok || !at(seller)) return fail('seller leg to 2493,3488,1 unobserved');
    if (!(await io.open())) return fail('shop open unobserved');
    let got = false;
    let paid = false;
    try {
        if (!(await io.wait(() => {
            const row = io.row();
            return !!row && row.id === 1975 && row.count > 0;
        }, 110))) return fail('stock 1975 unobserved');
        const row = io.row();
        if (!row || row.id !== 1975 || row.count < 1) return fail('stock 1975 vanished');
        const coinsBefore = io.coins();
        await io.buy(row);
        await io.wait(() => io.held() === before + 1 && io.coins() < coinsBefore, 10);
        got = io.held() === before + 1;
        paid = io.coins() < coinsBefore;
        console.log(`QUEST_SWEEP_HECKEL ${JSON.stringify({ item: 1975, before, after: io.held(), coinsBefore, coins: io.coins(), observed: got && paid })}`);
    } finally {
        await io.close();
    }
    if (!got) return fail(`inventory credit unobserved: ${before} -> ${io.held()}`);
    if (!paid) return fail('coin debit unobserved');
    if (!(await io.walk({ ...landing, level: 1 })).ok || !at({ ...landing, level: 1 }, 0)) return fail('ladder return 2466,3494,1 unobserved');
    await io.climb(false);
    if (!(await io.wait(() => at(landing), 20))) return fail('ladder down 2466,3495,0 unobserved');
    return { ok: true };
}

export function heckelIO(s: Session, world: World): HeckelIO {
    const st = () => s.sdk.getState();
    const held = (id: number) => countItems(st()?.inventory ?? [], id);
    const walk = async (to: Tile) => walkPath(await sessionWalker(s), [{ x: to.x, z: to.z, tol: 0 }], { maxTicks: 150 });
    const gate = async () => {
        const initial = st()?.player;
        const live = () => {
            if (!st()?.inGame) throw Error('session interrupted');
            if (sessionDied(initial, st()?.player) || (s.sdk.getSkill('Hitpoints')?.level ?? 0) <= 0) throw Error('died');
        };
        const end = s.tick() + 200;
        const deps: GateDepsLike = {
            live,
            left: (label) => {
                live();
                if (s.tick() >= end) throw Error(`${label}: tick budget exhausted`);
            },
            health: async () => {
                live();
            },
        };
        return resolveCrossStrongholdGate(s, deps);
    };
    return {
        gate,
        pos: () => {
            const p = st()?.player;
            return p ? { x: p.worldX, z: p.worldZ, level: p.level } : undefined;
        },
        held: () => held(1975),
        coins: () => held(COINS),
        travel: async (to) => {
            const r = await walkFar(s, world, to, 150);
            if (!r.ok) return { ok: false, detail: `${r.reason} ${r.detail}` };
            const ground = HECKEL_DUST.ground;
            const p = st()?.player;
            if (to.x === ground.x && to.z === ground.z && to.level === ground.level && p?.level === ground.level && Math.max(Math.abs(p.worldX - ground.x), Math.abs(p.worldZ - ground.z)) <= 2) {
                return { ok: true };
            }
            const last = await walk(to);
            return last.ok ? { ok: true } : { ok: false, detail: `final approach ${last.detail ?? 'arrival unobserved'}` };
        },
        walk,
        climb: async (up) => s.direct({ type: 'interactLoc', ...HECKEL_DUST.ladder, locId: up ? 1747 : 1748, optionIndex: up ? 1 : 3, reason: 'SDK' }),
        open: async () => {
            const npc = st()?.nearbyNpcs.find((n) => n.id === 603);
            if (!npc) return false;
            await s.bot.openShop(npc);
            return waitUntil(s, () => !!st()?.shop?.isOpen, { timeoutTicks: 10 });
        },
        row: () => st()?.shop?.shopItems.find((i) => i.id === 1975 && i.count > 0),
        buy: async (row) => {
            const observed = st()?.shop?.shopItems.find((i) => i.id === row.id && i.count > 0);
            if (observed) await s.bot.buyFromShop(observed, 1);
        },
        close: () => s.bot.closeShop(),
        wait: (ok, ticks) => waitUntil(s, ok, { timeoutTicks: ticks }),
    };
}

export async function walkCorridor(deps: PathDeps, points: readonly Pt[], walk: typeof walkPath = walkPath) {
    const [gx, gz, gtol = 0] = points[points.length - 1]!;
    const at = () => {
        const p = deps.pos();
        return p && { x: p.x, z: p.z, level: p.level };
    };
    const near = () => {
        const p = at();
        return !!p && p.level === 0 && Math.max(Math.abs(p.x - gx), Math.abs(p.z - gz)) <= gtol + 1;
    };
    let left = points.map(([x, z, tol]) => ({ x, z, tol }));
    for (let i = 0; i < 3 && !near(); i++) {
        const r = await walk(deps, left);
        console.log(`QUEST_SWEEP_CORRIDOR ${JSON.stringify({ to: { x: gx, z: gz }, try: i + 1, ok: r.ok, next: r.next, at: at(), detail: r.detail })}`);
        left = left.slice(Math.min(r.next, left.length - 1));
    }
    return { ok: near(), at: at() };
}

export async function prayBefore(s: Session, world: World, quest: string): Promise<string | null> {
    const level = s.sdk.getSkill('Prayer')?.baseLevel ?? 1;
    const wanted = prayerWanted(quest, level);
    if (wanted === undefined) return null;
    const points = (): number => (s.sdk.getState() as any)?.prayers?.prayerPoints ?? 0;
    const before = points();
    if (!prayerShort(before, level, wanted)) return null;
    const walked = await walkFar(s, world, SEERS_ALTAR.stand, 150);
    if (!walked.ok) return `walk to the Seers' Village altar failed: ${walked.reason} ${walked.detail}`;
    for (let i = 0; i < 3 && points() < level; i++) {
        await s.direct({ type: 'interactLoc', x: SEERS_ALTAR.x, z: SEERS_ALTAR.z, locId: SEERS_ALTAR.id, optionIndex: 1, reason: 'SDK' });
        await waitUntil(s, () => points() >= level, { timeoutTicks: 12 });
    }
    console.log(`QUEST_SWEEP_PRAY ${JSON.stringify({ quest, before, after: points(), level, wanted })}`);
    return prayerShort(points(), level, wanted) ? `prayer points ${points()} of ${level} after the Seers' Village altar` : null;
}

// Whether the straight line between two surface tiles enters the Wilderness (x 2944-3391, z 3520-3967 on the
// surface). The corridor walk follows that line, and a dungeon goal walked as a surface tile from Lumbridge went into
// Wilderness level 56; such a goal goes to the world router, which keeps to its danger rule.
export const WILDERNESS = { minX: 2944, maxX: 3391, minZ: 3520, maxZ: 3967 };
export function crossesWilderness(a: { x: number; z: number }, b: { x: number; z: number }): boolean {
    const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z), 1);
    for (let i = 0; i <= n; i++) {
        const x = Math.round(a.x + ((b.x - a.x) * i) / n), z = Math.round(a.z + ((b.z - a.z) * i) / n);
        if (x >= WILDERNESS.minX && x <= WILDERNESS.maxX && z >= WILDERNESS.minZ && z <= WILDERNESS.maxZ) return true;
    }
    return false;
}

export async function walkFar(
    s: Session,
    world: World,
    to: Tile,
    legTimeoutTicks = 150,
    opts: { signal?: AbortSignal } = {},
): Promise<Walked> {
    const from = atTile(s);
    const r = await walkFarLegs(s, world, to, legTimeoutTicks, opts.signal);
    if (!r.ok) console.log(`QUEST_SWEEP_WALK_FAIL ${JSON.stringify({ from, to, at: atTile(s), reason: r.reason, detail: r.detail })}`);
    return r;
}

async function walkFarLegs(s: Session, world: World, to: Tile, legTimeoutTicks: number, signal?: AbortSignal): Promise<Walked> {
    const stopped = () => signal?.aborted === true;
    const router = async (t: Tile): Promise<Walked> =>
        stopped() ? STOPPED : goTo(s, world, t, accountOf(s), { legTimeoutTicks, planBudgetMs: SWEEP_PLAN_BUDGET_MS, signal });
    const acct = accountOf(s);
    if (atTile(s).level === 0 && to.level === 0 && cheb(atTile(s), to) > 30 && (acct.counts?.lawrune ?? 0) > 0) {
        const plan = await sweepPlan(world, atTile(s), to, acct);
        const spell = plan?.legs.find((l) => l.kind === 'travel' && l.travel.kind === 'spell');
        console.log(`QUEST_SWEEP_SPELL ${JSON.stringify({ from: atTile(s), to, planned: !!plan, spell: spell?.kind === 'travel' ? (spell.travel as { name?: string }).name ?? true : false })}`);
        if (spell) return router(to);
    }
    const ground = async (t: Tile): Promise<Walked> => {
        if (stopped()) return STOPPED;
        if (t.z >= UNDERGROUND || crossesWilderness(atTile(s), t)) return router(t);
        const r = atTile(s).level === 0 && t.level === 0 ? await walkCorridor(await sessionWalker(s), [[t.x, t.z, 3]], (d, pts) => walkPath(d, pts, { signal })) : { ok: false };
        return r.ok && (cheb(atTile(s), t) <= 1 || (await sameArea(atTile(s), t))) ? { ok: true } : router(t);
    };
    if (stopped()) return STOPPED;
    for (let i = 0; i < 3 && atTile(s).level !== 0 && cheb(atTile(s), to) > MAX_HOP; i++) {
        const down = wayDown(world.navigationGraph?.().transports ?? [], atTile(s));
        console.log(`QUEST_SWEEP_DOWN ${JSON.stringify({ from: atTile(s), to: down })}`);
        const r = await router(down);
        if (!r.ok) return r;
    }
    const under = to.z >= UNDERGROUND;
    const beneath = approachOf(world.navigationGraph?.().transports ?? [], to);
    if (eastOfArdougne(atTile(s), under ? beneath : to, acct)) {
        const r = await crossEast(s, world, under ? beneath : to, signal);
        if (!r.ok) return r;
    }
    for (const hop of atTile(s).level === 0 && atTile(s).z < UNDERGROUND ? hopsTo(atTile(s), beneath) : []) {
        console.log(`QUEST_SWEEP_HOP ${JSON.stringify({ from: atTile(s), to: hop })}`);
        const r = await ground(hop);
        if (!r.ok) return r;
    }
    if ((to.level !== 0 || under) && atTile(s).level === 0 && atTile(s).z < UNDERGROUND && cheb(atTile(s), beneath) > (under ? 30 : MAX_HOP)) {
        const r = await ground(beneath);
        if (!r.ok) return r;
    }
    return !under && to.level === 0 && atTile(s).level === 0 && cheb(atTile(s), to) > 30 ? ground(to) : router(to);
}

async function crossEast(s: Session, world: World, to: Tile, signal?: AbortSignal): Promise<Walked> {
    if (countItems(s.sdk.getState()?.inventory ?? [], COINS) < BOAT_FARES) {
        return { ok: false, reason: 'precondition', detail: `missing 995:${BOAT_FARES} for safe boat route` };
    }
    const walk = async (to: Tile): Promise<Walked> =>
        signal?.aborted ? STOPPED : goTo(s, world, to, accountOf(s), { legTimeoutTicks: 150, planBudgetMs: SWEEP_PLAN_BUDGET_MS, signal });
    const corridor = async (points: readonly Pt[]): Promise<Walked> => {
        if (signal?.aborted) return STOPPED;
        const r = await walkCorridor(await sessionWalker(s), points, (d, pts) => walkPath(d, pts, { signal }));
        return r.ok ? { ok: true } : { ok: false, reason: 'corridor', detail: `corridor walk failed to ${points[points.length - 1]!.join(',')} at ${JSON.stringify(r.at)}` };
    };
    const sail = async (id: string): Promise<Walked> => {
        const t = loadTravel().find((t) => t.id === id);
        if (!t?.from) return { ok: false, reason: 'precondition', detail: `safe boat route unavailable: ${id}` };
        const q = s.sdk.getState()?.player;
        if (!q || q.level !== t.from.level || Math.max(Math.abs(q.worldX - t.from.x), Math.abs(q.worldZ - t.from.z)) > 8) {
            const w = await walk(t.from);
            if (!w.ok) return w;
        }
        const r = await walkRoute(s, [{ kind: 'travel', travel: t, at: t.from, to: t.to }], { maxRetriesPerLeg: 1, legTimeoutTicks: 150 });
        if (!r.ok) return { ok: false, reason: r.reason, detail: `safe boat route failed: ${r.detail}` };
        console.log(`QUEST_SWEEP_BOAT ${JSON.stringify({ id, coins: t.coins })}`);
        return { ok: true };
    };
    for (const leg of [
        () => sail('npc:captain_barnaby:brimhaven@2679,3275'),
        () => corridor(KARAMJA),
        () => sail('npc:customs_officer:port-sarim@2953,3147'),
    ]) {
        const r = await leg();
        if (!r.ok) return r;
    }
    return cheb(to, SARIM_LANDING) <= 60 || TAVERLEY_SIDE(to) ? { ok: true } : corridor(SARIM_NORTH);
}

export async function reachStart(
    s: Session,
    world: World,
    start: Tile,
    quest?: string,
    walker = () => sessionWalker(s),
    route = walkRoute,
    acct = (): Pick<Account, 'skills'> => accountOf(s),
) {
    const p = s.sdk.getState()?.player;
    const cure = quest === 'scorpion' ? scorpionCureJourney(atTile(s), { id: 175, count: 1, npcId: 560, tile: start }) : null;
    const cureReturn = quest === 'scorpion' && p?.level === 0 && cheb(atTile(s), JIMINUA) <= 8 && cheb(start, JIMINUA) > 8;
    const totemMainland = quest === 'totem' && p?.level === 0 && p.worldX < 2745 && p.worldZ >= 3200;
    const observatoryEast = quest === 'itgronigen' && !!p && start.level === 0 && eastOfPass({ x: p.worldX, z: p.worldZ, level: p.level }, acct());
    if (cure || cureReturn || totemMainland || observatoryEast || (quest === 'cog' && p?.level === 0 && p.worldX >= 2950 && p.worldZ < 3500 && start.level === 0)) {
        const fares = totemMainland ? 90 : cureReturn ? 30 : 60;
        const label = cure || cureReturn ? 'Scorpion antipoison' : totemMainland ? 'Tribal Totem' : observatoryEast ? 'Observatory' : 'Clock Tower';
        if (countItems(s.sdk.getState()?.inventory ?? [], COINS) < fares) throw Error(`missing 995:${fares} for ${label} boat route`);
        const deps = await walker();
        const deadline = s.tick() + (observatoryEast ? 2700 : 1800);
        const near = (point: { x: number; z: number }, tol: number) => {
            const at = deps.pos();
            return !!at && at.level === 0 && Math.max(Math.abs(at.x - point.x), Math.abs(at.z - point.z)) <= tol;
        };
        const corridor = async (points: readonly Pt[], legTicks = 600) => {
            const r = await walkQuestCorridor(
                { tick: () => s.tick(), stop: () => s.sdk.getState()?.player?.isDead === true, near, walk: (points, opts) => walkPath(deps, points, opts) },
                points.map(([x, z, tol]) => ({ x, z, tol })),
                Math.min(deadline, s.tick() + legTicks),
            );
            if (!r.ok) throw Error(`${label} corridor failed: ${r.detail}`);
        };
        const sail = async (id: string) => {
            const t = loadTravel().find((t) => t.id === id);
            if (!t?.from || !near(t.from, 8)) throw Error(`${label} boat approach unobserved: ${id}`);
            if (s.tick() >= deadline) throw Error(`${label} entry deadline`);
            const coins = countItems(s.sdk.getState()?.inventory ?? [], COINS);
            const r = await route(s, [{ kind: 'travel', travel: t, at: t.from, to: t.to }], { maxRetriesPerLeg: 1, legTimeoutTicks: 150 });
            const observed = () => near(t.to, 8) && (!(cure || cureReturn) || countItems(s.sdk.getState()?.inventory ?? [], COINS) === coins - t.coins);
            if (!r.ok || !(await waitUntil(s, observed, { timeoutTicks: 10 }))) {
                throw Error(`${label} boat failed: ${id} ${r.ok ? 'arrival/fare unobserved' : r.detail}`);
            }
            console.log(`QUEST_SWEEP_BOAT ${JSON.stringify({ id, coins: t.coins })}`);
        };
        if (cure) {
            if (cure === 'sarim') {
                await corridor([[SARIM_LANDING.x, SARIM_LANDING.z, 2]]);
                await sail('npc:captain_tobias:karamja-musa-point@3028,3216');
                await corridor([...KARAMJA].reverse());
            } else {
                await corridor([[2644, 3293, 2], [2669, 3284, 2], [2679, 3275, 2]]);
                await sail('npc:captain_barnaby:brimhaven@2679,3275');
            }
            await corridor(JIMINUA_FROM_BRIMHAVEN);
            return;
        }
        if (cureReturn) {
            await corridor([...JIMINUA_FROM_BRIMHAVEN].reverse().concat([[2772, 3231, 2]]));
            await sail('npc:customs_officer:ardougne@2772,3231');
            if (start.level !== 0 || !near(start, 8)) await reachStart(s, world, start, undefined, walker, route, acct);
            return;
        }
        if (totemMainland) {
            await corridor([[2644, 3293, 2], [2669, 3284, 2], [2679, 3275, 2]]);
            await sail('npc:captain_barnaby:brimhaven@2679,3275');
            await corridor([[2774, 3228, 2], [start.x, start.z, 2]]);
            return;
        }
        if (observatoryEast) {
            await corridor([[SARIM_LANDING.x, SARIM_LANDING.z, 2]], 900);
            await sail('npc:captain_tobias:karamja-musa-point@3028,3216');
            await corridor([...KARAMJA].reverse().concat([[2772, 3231, 2]]));
            await sail('npc:customs_officer:ardougne@2772,3231');
            await corridor([...OBSERVATORY_FROM_ARDOUGNE, [start.x, start.z, 2]]);
            return;
        }
        await corridor([...SARIM_NORTH].reverse().concat([[3029, 3217, 2]]));
        await sail('npc:captain_tobias:karamja-musa-point@3028,3216');
        await corridor([...KARAMJA].reverse().concat([[2772, 3231, 2]]));
        await sail('npc:customs_officer:ardougne@2772,3231');
        await corridor([[2669, 3284, 2], [2644, 3293, 2], [2610, 3290, 3], [2580, 3260, 2], [2575, 3250, 0], [start.x, start.z, 2]]);
        return;
    }
    if (quest === 'fishingcompo' && start.level === 0) {
        if (p?.level !== 0) throw Error('Fishing Contest west dwarf approach requires ground entry');
        const deps = await walker();
        const goal = { x: 2820, z: 3487, tol: 2 };
        const near = (t: { x: number; z: number }, tol: number) => {
            const at = deps.pos();
            return !!at && at.level === 0 && Math.max(Math.abs(at.x - t.x), Math.abs(at.z - t.z)) <= tol;
        };
        const r = await walkQuestCorridor(
            { tick: () => s.tick(), stop: () => s.sdk.getState()?.player?.isDead === true, near, walk: (points, options) => walkPath(deps, points, options) },
            [goal],
            s.tick() + 600,
        );
        if (!r.ok) throw Error(`Fishing Contest west dwarf approach failed: ${r.detail}`);
        const observed = () =>
            near(goal, 3) &&
            (s.sdk.getState()?.nearbyNpcs ?? []).some(
                (n) => n.id === 232 && /^mountain dwarf$/i.test(n.name) && Math.max(Math.abs(n.x - goal.x), Math.abs(n.z - goal.z)) <= 4,
            );
        if (!(await waitUntil(s, observed, { timeoutTicks: 10 }))) throw Error('Fishing Contest west dwarf unobserved');
        console.log(`QUEST_SWEEP_DWARF ${JSON.stringify({ at: deps.pos(), observed: true })}`);
        return;
    }
    if (quest === 'biohazard' && inElenaHouse(start) && !(p && inElenaHouse({ x: p.worldX, z: p.worldZ, level: p.level }))) {
        const e = await enterElenaHouse(s, {
            approach: async (to) => {
                const w = await walkFar(s, world, to);
                if (!w.ok) return w;
                return walkPath(await walker(), [{ x: to.x, z: to.z, tol: 0 }], { maxTicks: 40 });
            },
        });
        if (!e.ok) throw Error(e.detail);
        return;
    }
    const r = await walkFar(s, world, start);
    if (!r.ok) throw Error(`start walk failed to ${JSON.stringify(start)}: ${r.reason} ${r.detail}`);
}

export async function enterMagicGuild(
    s: Session,
    world: World,
    door: Tile,
    walk: (s: Session, world: World, to: Tile, legTimeoutTicks?: number) => Promise<Walked> = walkFar,
): Promise<Walked> {
    const w = await walk(s, world, door, 100);
    if (!w.ok) return w;
    const loc = (s.sdk.getState()?.nearbyLocs ?? []).filter(
        (l) => (MAGIC_GUILD.locs as readonly number[]).includes(l.id) && Math.abs(l.x - door.x) <= 1 && Math.abs(l.z - door.z) <= 1,
    )[0];
    if (!loc) return { ok: false, reason: 'transition', detail: `Magic Guild door unobserved at ${door.x},${door.z}` };
    await s.bot.openDoor(loc);
    if (!(await waitUntil(s, () => inMagicGuild(atTile(s)) && atTile(s).level === 0, { timeoutTicks: 10 }))) {
        return { ok: false, reason: 'transition', detail: `Magic Guild door at ${door.x},${door.z} left the bot at ${atTile(s).x},${atTile(s).z},${atTile(s).level}` };
    }
    return { ok: true };
}

export async function buyFromShops(
    s: Session,
    world: World,
    buys: readonly Buy[],
    observeScorpionTravel = false,
    approach = reachStart,
): Promise<string | null> {
    const st = () => s.sdk.getState() as any;
    const held = (id: number) => countItems((st()?.inventory ?? []).map((i: any) => ({ id: i.id, count: i.count })), id);
    const here = (): Tile => {
        const q = st()?.player;
        return { x: q?.worldX ?? 0, z: q?.worldZ ?? 0, level: q?.level ?? 0 };
    };
    const left = [...buys];
    while (left.length) {
        const b = left.sort((x, y) => travelDistance(here(), x.tile) - travelDistance(here(), y.tile)).shift()!;
        const before = held(b.id);
        const target = before + b.count;
        const sellers = [b, ...(b.alts ?? [])];
        let walked: { ok: boolean; reason?: string; detail?: string } = { ok: false };
        let tried = 0;
        for (const [k, c] of sellers.entries()) {
            if (held(b.id) >= target) break;
            const cure = observeScorpionTravel && scorpionCureJourney(here(), { ...b, ...c });
            if (!cure && travelDistance(here(), c.tile) > FAR_SELLER) {
                console.log(`QUEST_SWEEP_SELLER_FAR ${JSON.stringify({ npc: c.npc, tile: c.tile, from: here() })}`);
                continue;
            }
            const guild = magicGuildApproach(c.tile, here(), s.sdk.getSkill('Magic')?.level ?? 1);
            if (guild.refused || guild.door) {
                walked = guild.door ? await enterMagicGuild(s, world, guild.door) : { ok: false, reason: 'precondition', detail: guild.refused };
                console.log(`QUEST_SWEEP_GUILD ${JSON.stringify({ npc: c.npc, door: guild.door, at: here(), ...walked })}`);
                if (!walked.ok) continue;
            }
            const coinsBeforeTravel = held(COINS);
            const from = here();
            if (cure) {
                await approach(s, world, c.tile, 'scorpion');
                walked = { ok: true };
            } else {
                walked = await walkFar(s, world, c.tile, 100);
            }
            if (!walked.ok) continue;
            if (observeScorpionTravel && b.id === 175) {
                console.log(`QUEST_SWEEP_TRAVEL_COST ${JSON.stringify({ phase: 'shop', item: b.id, coinsBefore: coinsBeforeTravel, coins: held(COINS), from, at: here(), observed: true })}`);
            }
            tried++;
            const npc = (st()?.nearbyNpcs ?? []).filter((n: any) => n.id === c.npcId).sort((x: any, y: any) => x.distance - y.distance)[0];
            if (!npc) return `${c.npc} not in sight at ${c.tile.x},${c.tile.z}`;
            const shopOpen = () => waitUntil(s, () => !!st()?.shop?.isOpen, { timeoutTicks: 10 });
            const talked = async () => {
                const choices = SHOP_TALK[c.npcId]!;
                const t: any = await s.bot.talkTo(npc);
                if (!t?.success) return false;
                for (let i = 0, next = 0; i < 30 && !st()?.shop?.isOpen; i++) {
                    const dlg: any = s.sdk.getDialog();
                    if (dlg?.isOpen && !dlg.isWaiting) {
                        const opts: any[] = dlg.options ?? [];
                        const idx = next < choices.length && opts.some((o) => choices[next]!.test(o.text)) ? next : undefined;
                        if (idx !== undefined) {
                            await s.sdk.clickDialogByText(choices[idx]!);
                            next = idx + 1;
                        } else {
                            await s.sdk.sendClickDialog(0);
                        }
                    }
                    await waitTicks(s, 1);
                }
                return !!st()?.shop?.isOpen;
            };
            const opened = async () => (SHOP_TALK[c.npcId] ? talked() : (await s.bot.openShop(npc)).success && (await shopOpen()));
            if (!(await opened())) {
                const door = (await s.bot.openDoor(/door/i)).success;
                console.log(`QUEST_SWEEP_SHOP_DOOR ${JSON.stringify({ npc: c.npc, at: here(), door })}`);
                if (!door || !(await opened())) return `${c.npc} shop did not open`;
            }
            const rounds = k === sellers.length - 1 ? 12 : 3;
            const had0 = held(b.id);
            const coinsBefore = held(COINS);
            for (let i = 0; i < rounds && held(b.id) < target; i++) {
                const row = (st()?.shop?.shopItems ?? []).find((x: any) => x.id === b.id);
                if (!row || row.count < 1) {
                    await waitTicks(s, 50);
                    continue;
                }
                const want = Math.min(target - held(b.id), row.count);
                const had = held(b.id);
                await s.bot.buyFromShop(row, want);
                await waitUntil(s, () => held(b.id) >= had + want, { timeoutTicks: 10 });
            }
            console.log(`QUEST_SWEEP_BUY ${JSON.stringify({ item: b.id, name: b.name, count: b.count, npc: c.npc, before: had0, after: held(b.id), coinsBefore, coins: held(COINS) })}`);
            await s.bot.closeShop();
        }
        if (!tried) {
            return `shop walk to ${b.npc} at ${b.tile.x},${b.tile.z} and ${b.alts?.length ?? 0} more failed: ${walked.reason ? `${walked.reason} ${walked.detail}` : `no seller within ${FAR_SELLER} tiles`}`;
        }
        if (held(b.id) - before < (b.atLeast ?? b.count)) {
            return `bought ${held(b.id) - before} of ${b.count} ${b.name} from ${tried} sellers`;
        }
    }
    return null;
}

export async function raiseFare(s: Session, world: World): Promise<boolean> {
    const st = () => s.sdk.getState() as any;
    const coins = () => countItems((st()?.inventory ?? []).map((i: any) => ({ id: i.id, count: i.count })), COINS);
    const here = (): Tile => {
        const p = st()?.player;
        return { x: p?.worldX ?? 0, z: p?.worldZ ?? 0, level: p?.level ?? 0 };
    };
    const start = coins();
    for (const store of generalStores(here()).slice(0, 3)) {
        const walked = await goTo(s, world, store.tile, accountOf(s), { legTimeoutTicks: 100 });
        console.log(`QUEST_SWEEP_FARE_WALK ${JSON.stringify({ npc: store.npc, to: store.tile, ok: walked.ok, detail: 'detail' in walked ? walked.detail : undefined })}`);
        if (!walked.ok) continue;
        const npc = (st()?.nearbyNpcs ?? []).filter((n: any) => n.id === store.npcId).sort((a: any, b: any) => a.distance - b.distance)[0];
        if (!npc || !(await s.bot.openShop(npc)).success) continue;
        await waitUntil(s, () => !!st()?.shop?.isOpen, { timeoutTicks: 10 });
        const items = [...(st()?.inventory ?? [])].filter((i: any) => i.id !== COINS).sort((a: any, b: any) => (catalogItem(a.id)?.cost ?? 0) - (catalogItem(b.id)?.cost ?? 0));
        for (const i of items) {
            const before = coins();
            await s.bot.sellToShop(i, 'all');
            await waitUntil(s, () => coins() > before, { timeoutTicks: 10 });
        }
        await s.bot.closeShop();
        console.log(`QUEST_SWEEP_FARE ${JSON.stringify({ npc: store.npc, before: start, after: coins() })}`);
        return coins() > start;
    }
    return false;
}

export async function trainFishing(s: Session, world: World, level: number): Promise<string | null> {
    const st = () => s.sdk.getState() as any;
    const lvl = () => st()?.skills?.find((k: any) => k.name === 'Fishing')?.baseLevel ?? 1;
    const caught = () =>
        countItems((st()?.inventory ?? []).map((i: any) => ({ id: i.id, count: i.count })), RAW_SHRIMPS) +
        countItems((st()?.inventory ?? []).map((i: any) => ({ id: i.id, count: i.count })), RAW_ANCHOVIES);
    const spot = () =>
        (st()?.nearbyNpcs ?? [])
            .filter(
                (n: any) =>
                    /^fishing spot$/i.test(n.name) &&
                    n.optionsWithIndex?.some((o: any) => /^net$/i.test(o.text)) &&
                    n.optionsWithIndex?.some((o: any) => /^bait$/i.test(o.text)),
            )
            .sort((a: any, b: any) => a.distance - b.distance)[0];
    if (!(st()?.inventory ?? []).some((i: any) => i.id === NET)) return `fishing training needs a small net (${NET}) in the pack`;
    if (!spot()) {
        const w = await walkFar(s, world, CATHERBY_BEACH, 100);
        if (!w.ok) return `fishing spot walk failed: ${w.reason} ${w.detail}`;
    }
    const dialog = () => {
        const d: any = s.sdk.getDialog();
        return !!d?.isOpen && !d.isWaiting;
    };
    const t0 = s.tick();
    const from = lvl();
    let casts = 0;
    while (lvl() < level && s.tick() - t0 < TRAIN_TICKS) {
        if (dialog()) {
            await s.sdk.sendClickDialog(0);
            await waitTicks(s, 1);
            continue;
        }
        const n = spot();
        if (!n) {
            await waitTicks(s, 5);
            continue;
        }
        if ((st()?.inventory?.length ?? 0) >= 28) return `fishing training: pack full at Fishing ${lvl()}`;
        const before = caught();
        await s.direct({
            type: 'interactNpc',
            npcIndex: n.index,
            optionIndex: n.optionsWithIndex.find((o: any) => /^net$/i.test(o.text))!.opIndex,
            reason: 'SDK',
        });
        casts++;
        await waitUntil(s, () => caught() > before || lvl() >= level || dialog(), { timeoutTicks: 30 });
    }
    console.log(`QUEST_SWEEP_TRAIN ${JSON.stringify({ skill: 'Fishing', from, to: lvl(), target: level, casts, caught: caught(), ticks: s.tick() - t0 })}`);
    return lvl() >= level ? null : `Fishing ${lvl()} of ${level} after ${s.tick() - t0} ticks`;
}

let handoff: Promise<void> = Promise.resolve();
export function handOver(s: Session, script: string, fresh?: string): Promise<unknown> {
    const g = globalThis as { QUEST_SESSION?: Session; QUEST_SESSION_TAKEN?: () => void; QUEST_SCRIPT_ID?: string };
    let started!: (p: Promise<unknown>) => void;
    const run = new Promise<Promise<unknown>>((r) => {
        started = r;
    });
    handoff = handoff.then(
        () =>
            new Promise<void>((release) => {
                const done = () => {
                    clearTimeout(timer);
                    if (g.QUEST_SESSION === s) delete g.QUEST_SESSION;
                    if (g.QUEST_SESSION_TAKEN === done) delete g.QUEST_SESSION_TAKEN;
                    release();
                };
                const timer = setTimeout(done, 60_000);
                g.QUEST_SESSION = s;
                g.QUEST_SESSION_TAKEN = done;
                g.QUEST_SCRIPT_ID = questScriptId(script);
                started(
                    import(fresh ? `${script}?${fresh}` : script).finally(() => {
                        if (g.QUEST_SESSION_TAKEN === done) done();
                    }),
                );
            }),
    );
    return run.then((p) => p);
}

export type AmikIO = {
    pos: () => Tile | undefined;
    travel: (to: Tile) => Promise<{ ok: boolean; detail?: string }>;
    climb: (loc: { id: number; x: number; z: number }, level: number) => Promise<boolean>;
    talk: () => Promise<string>;
    complete: () => boolean;
};

export async function finishBlackKnight(io: AmikIO): Promise<{ ok: boolean; detail?: string }> {
    const to = { x: 2955, z: 3337, level: 0 };
    const r = await io.travel(to);
    const p = io.pos();
    if (!r.ok || !p || p.level !== 0 || Math.max(Math.abs(p.x - to.x), Math.abs(p.z - to.z)) > 2) {
        return { ok: false, detail: `Amik castle leg to 2955,3337,0 failed: ${r.detail ?? 'arrival unobserved'}` };
    }
    for (const [x, level] of [
        [2954, 1],
        [2960, 2],
    ] as const) {
        if (!(await io.climb({ id: 1738, x, z: 3338 }, level)) || io.pos()?.level !== level) {
            return { ok: false, detail: `Amik stairs leg at ${x},3338 to level ${level} unobserved` };
        }
    }
    const dialogue = await io.talk();
    return io.complete() ? { ok: true } : { ok: false, detail: `Sir Amik did not complete quest; observed dialogue: ${JSON.stringify(dialogue)}` };
}

export function amikIO(s: Session, world: World): AmikIO {
    const st = () => s.sdk.getState();
    const initial = st()?.player;
    const state = () => questFlags(s.client)?.find((f) => f.name === "Black Knight's Fortress")?.state;
    const text: string[] = [];
    const messages = new Set((st()?.gameMessages ?? []).map((m) => m));
    let questComplete = false;
    const observe = () => {
        const d = st()?.dialog;
        const page = [d?.text ?? '', ...(d?.allComponents ?? []).map((c) => c.text)].filter(Boolean).join('\n');
        if (d?.isOpen && page && text.at(-1) !== page) text.push(page);
        if ((st()?.gameMessages ?? []).some((m) => !messages.has(m) && /quest complete/i.test(m.text))) questComplete = true;
    };
    const live = () => {
        if (!st()?.inGame || sessionDied(initial, st()?.player) || (s.sdk.getSkill('Hitpoints')?.level ?? 0) <= 0) {
            throw Error('Amik return session interrupted or died');
        }
    };
    return {
        pos: () => {
            const p = st()?.player;
            return p ? { x: p.worldX, z: p.worldZ, level: p.level } : undefined;
        },
        travel: async (to) => {
            const r = await goTo(s, world, to, accountOf(s), { legTimeoutTicks: 150, maxRetriesPerLeg: 1 });
            return r.ok ? { ok: true } : { ok: false, detail: `${r.reason} ${r.detail}` };
        },
        climb: async (loc, level) => {
            live();
            const r = await walkPath(await sessionWalker(s), [{ x: loc.x, z: loc.z, tol: 1 }], { maxTicks: 60 });
            if (!r.ok) return false;
            const l = st()?.nearbyLocs.find((l) => l.x === loc.x && l.z === loc.z);
            if (!l) return false;
            await s.bot.interactLoc(l, /climb/i);
            return waitUntil(s, () => st()?.player?.level === level, { timeoutTicks: 20 });
        },
        talk: async () => {
            const off = s.onTick(observe);
            try {
                live();
                const r = await walkPath(await sessionWalker(s), [{ x: 2960, z: 3336, tol: 1 }], { maxTicks: 60 });
                if (!r.ok) return 'Sir Amik approach 2960,3336,2 failed';
                await s.bot.talkTo(/^sir amik varze$/i);
                for (let i = 0; i < 60; i++) {
                    live();
                    observe();
                    if (state() === 'complete' && questComplete) return text.join('\n');
                    const d = st()?.dialog;
                    if (d?.isOpen && !d.isWaiting) {
                        if (d.options.some((o) => !/click here to continue/i.test(o.text))) {
                            return text.concat(d.options.map((o) => o.text)).join('\n');
                        }
                        const reply = await s.sdk.sendClickDialog(0);
                        if (!reply.success) return text.concat(reply.message ?? 'dialogue click refused').join('\n');
                    }
                    await waitTicks(s, 1);
                }
                return text.join('\n');
            } finally {
                off();
            }
        },
        complete: () => state() === 'complete' && questComplete,
    };
}
