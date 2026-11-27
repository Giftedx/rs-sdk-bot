import { existsSync } from 'node:fs';
import { getWorld, accountOf } from '../../../core/src/bot';
import { goTo, walkPath, sessionWalker, walkRoute } from '../../../core/src/walk';
import { waitUntil } from '../../../core/src/ticks';
import type { Session } from '../../../core/src/inprocess';
import type { Tile, Account } from '../../../core/src/world';
import type { Outcome } from '../../../core/src/act';
import { loadTravel, travelAllowed, type Travel } from '../../../core/src/travel';
import { isStopFilePresent } from '../stop';

export const DRAYNOR_BANK = { x: 3092, z: 3243 };
export const LUMBRIDGE_TO_DRAYNOR: [number, number, number][] = [
    [3226, 3250, 2],
    [3180, 3258, 3],
    [3100, 3285, 3],
    [3089, 3266, 2],
    [3092, 3250, 1],
    [DRAYNOR_BANK.x, DRAYNOR_BANK.z, 2],
];

const FARE_BANKS: readonly Tile[] = [
    { x: 3185, z: 3436, level: 0 },
    { x: 3253, z: 3420, level: 0 },
    { x: 3092, z: 3243, level: 0 },
    { x: 3013, z: 3355, level: 0 },
    { x: 2946, z: 3368, level: 0 },
    { x: 2619, z: 3332, level: 0 },
    { x: 2655, z: 3283, level: 0 },
];
const COINS = 995;
const PACK_SLOTS = 28;
// Strictly below DEFAULT_TICK_IDLE_MS (15_000) so lockstep route holds never trip partner TickStallError deadlines.
const FERRY_LEG_PLAN_MS = 10_000;

export function fareSpare(pack: readonly { id: number }[]): { id: number; all: boolean } | null {
    if (pack.length < PACK_SLOTS) return null;
    const rows = new Map<number, number>();
    for (let i = 0; i < pack.length; i++) {
        const id = pack[i]!.id;
        if (id === COINS) return null;
        rows.set(id, (rows.get(id) ?? 0) + 1);
    }
    let bestId = -1;
    let bestCount = -1;
    for (const [id, count] of rows) {
        if (count > bestCount) {
            bestCount = count;
            bestId = id;
        }
    }
    return bestId === -1 ? null : { id: bestId, all: bestCount === 1 };
}

export const fareFault = (need: number, missing: number, banked: number): string =>
    banked >= missing
        ? `ferry fare: the withdrawal of ${missing} coins failed, the bank holds ${banked}`
        : `ferry needs ${need} coins and the bank holds ${banked}`;

export async function bankFare(s: Session, need: number, walk: (to: Tile, budgetMs?: number) => Promise<Outcome>): Promise<Outcome> {
    const start = s.tick();
    const held = () => {
        const inv = s.sdk.getInventory();
        let total = 0;
        for (let i = 0; i < inv.length; i++) {
            const row = inv[i]!;
            if (row.id === COINS) total += row.count;
        }
        return total;
    };
    const done = (ok: boolean, detail: string): Outcome =>
        ok ? { ok: true, ticks: s.tick() - start } : { ok: false, reason: 'precondition', detail, ticks: s.tick() - start };
    const p = s.sdk.getState()?.player;
    if (!p || p.level !== 0) return done(false, `ferry needs ${need} coins in the pack`);
    let bank = FARE_BANKS[0]!;
    let bestDist = Math.max(Math.abs(bank.x - p.worldX), Math.abs(bank.z - p.worldZ));
    for (let i = 1; i < FARE_BANKS.length; i++) {
        const b = FARE_BANKS[i]!;
        const d = Math.max(Math.abs(b.x - p.worldX), Math.abs(b.z - p.worldZ));
        if (d < bestDist) {
            bestDist = d;
            bank = b;
        }
    }
    const there = await walk(bank, FERRY_LEG_PLAN_MS);
    if (!there.ok) return { ...there, ticks: s.tick() - start };
    const generation = s.bankObservation?.()?.generation ?? 0;
    if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 20 })) {
        return done(false, `ferry fare: the bank at ${bank.x},${bank.z} did not open`);
    }
    const missing = need - held();
    const row = s.sdk.getState()?.bank?.items.find(i => i.id === COINS);
    const spare = missing > 0 ? fareSpare(s.sdk.getInventory()) : null;
    const item = spare && s.sdk.getInventory().find(i => i.id === spare.id);
    if (spare && (!item || !(await s.bot.depositItem(item, spare.all ? -1 : 1)).success || !await waitUntil(s, () => s.sdk.getInventory().length < PACK_SLOTS, { timeoutTicks: 10 }))) {
        await s.bot.closeBank();
        return done(false, `ferry fare: a full pack and the deposit of item ${spare.id} failed`);
    }
    const took = missing <= 0 || (!!row && row.count >= missing
        && (await s.bot.withdrawItem(row, missing, { asNote: false })).success
        && await waitUntil(s, () => held() >= need, { timeoutTicks: 20 }));
    await s.bot.closeBank();
    return took ? done(true, '') : done(false, fareFault(need, missing, row?.count ?? 0));
}

export const onStarterIsland = (p: { worldX: number; worldZ: number; level?: number } | null | undefined): boolean =>
    !!p && p.worldX >= 3050 && p.worldX <= 3160 && p.worldZ >= 3050 && p.worldZ <= 3140;

const PORT_SARIM_FERRY = 'npc:captain_tobias:karamja-musa-point@3028,3216';
const ARDOUGNE_FERRY = 'npc:customs_officer:ardougne@2772,3225';
const BRIMHAVEN_FERRY = 'npc:captain_barnaby:brimhaven@2679,3275';
const MUSA_POINT_FERRY = 'npc:customs_officer:port-sarim@2953,3147';
const AL_KHARID_TOLL = 'npc:borderguard2:lumbridge-side-west-of-the-toll-gate@3268,3226';
const LUMBRIDGE: Tile = { x: 3222, z: 3218, level: 0 };
const DRAYNOR: Tile = { x: 3092, z: 3243, level: 0 };
const inEast = (t: Tile) => t.level === 0 && t.x >= 2870 && t.x <= 3280 && t.z >= 3150 && t.z <= 3510;
const inArdougne = (t: Tile) => t.level === 0 && t.x >= 2550 && t.x <= 2700 && t.z >= 3240 && t.z <= 3400;
const ARDOUGNE_NORTH: Tile = { x: 2619, z: 3332, level: 0 };
const inKandarin = (t: Tile) => t.level === 0 && t.x >= 2440 && t.x < 2870 && t.z >= 3040 && t.z <= 3530;
export const ZANARIS_SHED: Tile = { x: 3201, z: 3169, level: 0 };
export const inZanaris = (t: Tile) => t.level === 0 && t.x >= 3136 && t.x < 3264 && t.z >= 9536 && t.z < 9600;

export function stagedBoat(boat: Travel | undefined, from: Tile, to: Tile, account: Account) {
    if (!boat?.from || boat.kind !== 'boat' || boat.run.how !== 'npc') throw Error('known NPC boat required');
    if (from.level !== boat.from.level || Math.max(Math.abs(from.x - boat.from.x), Math.abs(from.z - boat.from.z)) > 8) {
        throw Error('boat departure not reached');
    }
    if (to.x !== boat.to.x || to.z !== boat.to.z || to.level !== boat.to.level) throw Error('boat arrival differs from target');
    if (!travelAllowed(boat, account)) throw Error('boat unavailable for this account');
    return { kind: 'travel' as const, travel: boat, at: boat.from, to: boat.to };
}

export async function walkWithFerryFallback(
    from: Tile,
    to: Tile,
    walk: (to: Tile, budgetMs?: number) => Promise<Outcome>,
    sail: (boat: Travel) => Promise<Outcome>,
    coins: () => number,
    stageFare?: (need: number) => Promise<Outcome>,
): Promise<Outcome> {
    let ticks = 0;
    if (inZanaris(from) && !inZanaris(to) && !(to.x === ZANARIS_SHED.x && to.z === ZANARIS_SHED.z)) {
        const out = await walk(ZANARIS_SHED, FERRY_LEG_PLAN_MS);
        ticks += out.ticks;
        if (!out.ok) return { ...out, ticks };
        from = ZANARIS_SHED;
    }
    const upstairs = from.level > 0 && inArdougne({ ...from, level: 0 });
    if ((upstairs || (!inArdougne(from) && inKandarin(from))) && inEast(to)) {
        const home = await walk(ARDOUGNE_NORTH, FERRY_LEG_PLAN_MS);
        ticks += home.ticks;
        // No route to Ardougne North (a weak account east of White Wolf Mountain is still inside the Kandarin box):
        // the walk below searches its own route from where the account stands, as in logistics/walk.ts.
        if (home.ok) from = ARDOUGNE_NORTH;
        else if (home.reason !== 'precondition' || !home.detail.startsWith('no route to ')) return { ...home, ticks };
    }
    const west = inEast(from) && to.level === 0 && to.x >= 2600 && to.x <= 2690 && to.z >= 3260 && to.z <= 3360;
    const east = !west && inArdougne(from) && inEast(to);
    const travel = west || east ? loadTravel() : [];
    const first = travel.find(t => t.id === (west ? PORT_SARIM_FERRY : BRIMHAVEN_FERRY));
    const second = travel.find(t => t.id === (west ? ARDOUGNE_FERRY : MUSA_POINT_FERRY));
    const toll = west && from.x >= 3250 && from.z <= 3230 ? travel.find(t => t.id === AL_KHARID_TOLL) : undefined;
    const need = first?.from && second?.from ? first.coins + second.coins + (toll?.coins ?? 0) : 0;
    if (need && coins() < need && stageFare) {
        const staged = await stageFare(need);
        ticks += staged.ticks;
        if (!staged.ok) return { ...staged, ticks };
    }
    const direct = await walk(to, need && first?.from && second?.from ? FERRY_LEG_PLAN_MS : undefined);
    if (direct.ok || direct.reason !== 'precondition' || !direct.detail.startsWith('no route to ') || !need || !first?.from || !second?.from) {
        return ticks ? { ...direct, ticks: ticks + direct.ticks } : direct;
    }
    ticks += direct.ticks;
    let fare = first.coins + second.coins;
    const missingFare = (wanted: number): Outcome => ({
        ok: false,
        reason: 'precondition',
        detail: `${west ? 'westbound' : 'eastbound'} ferry needs ${wanted} coins in the pack`,
        ticks,
    });
    if (coins() < need) return missingFare(need);
    const through = !west || from.x < 3060 ? [] : from.x >= 3200 ? [LUMBRIDGE, DRAYNOR] : Math.max(Math.abs(from.x - DRAYNOR.x), Math.abs(from.z - DRAYNOR.z)) <= 3 ? [] : [DRAYNOR];
    for (const tile of through) {
        const leg = await walk(tile, FERRY_LEG_PLAN_MS);
        ticks += leg.ticks;
        if (!leg.ok) return { ...leg, ticks };
    }
    for (const [boat, departure] of [[first, first.from], [second, second.from]] as const) {
        const approachTile = await walk(departure, FERRY_LEG_PLAN_MS);
        ticks += approachTile.ticks;
        if (!approachTile.ok) return { ...approachTile, ticks };
        if (coins() < fare) return missingFare(fare);
        const crossed = await sail(boat);
        ticks += crossed.ticks;
        if (!crossed.ok) return { ...crossed, ticks };
        fare -= boat.coins;
    }
    const final = await walk(to, FERRY_LEG_PLAN_MS);
    return { ...final, ticks: ticks + final.ticks };
}

export async function ferryWalk(
    s: Session,
    to: Tile,
    walk: (to: Tile, budgetMs?: number) => Promise<Outcome>,
    stop: () => boolean = () => false,
): Promise<Outcome> {
    const p = s.sdk.getState()?.player;
    if (onStarterIsland(p)) {
        return { ok: false, reason: 'precondition', detail: 'market worker cannot run on Tutorial Island', ticks: 0 };
    }
    if (!p) return walk(to);
    return walkWithFerryFallback(
        { x: p.worldX, z: p.worldZ, level: p.level },
        to,
        walk,
        boat => {
            if (stop()) return Promise.resolve({ ok: false, reason: 'aborted', detail: 'stopped during ferry crossing', ticks: 0 });
            const at = s.sdk.getState()?.player;
            if (!at) return Promise.resolve({ ok: false, reason: 'precondition', detail: 'ferry departure state unavailable', ticks: 0 });
            return walkRoute(s, [stagedBoat(boat, { x: at.worldX, z: at.worldZ, level: at.level }, boat.to, accountOf(s))], {
                maxRetriesPerLeg: 1,
                legTimeoutTicks: 150,
            });
        },
        () => accountOf(s).coins ?? 0,
        need => bankFare(s, need, walk),
    );
}

type WalkOperations = { planned(s: Session, to: Tile): Promise<{ ok: boolean }>; ground(s: Session, to: Tile): Promise<{ ok: boolean }> };
export async function walkTarget(s: Session, to: Tile, ground: boolean, operations?: WalkOperations, walkOpts?: { noJewelry?: boolean }) {
    const ops: WalkOperations = operations ?? {
        planned: async (sess, target) => {
            const world = await getWorld();
            return ferryWalk(sess, target, (tile, planBudgetMs) => goTo(sess, world, tile, accountOf(sess), {
                legTimeoutTicks: 100,
                planBudgetMs,
                ...(walkOpts?.noJewelry ? { noJewelry: true } : {}),
            }));
        },
        ground: async (sess, target) => walkPath(await sessionWalker(sess), [{ ...target, tol: 1 }], { maxTicks: 600 }),
    };
    if (ground && s.sdk.getState()?.player?.level !== to.level) throw Error('ground walk requires a known start on the same plane');
    return ground ? ops.ground(s, to) : ops.planned(s, to);
}

export function awayFrom(p: { worldX: number; worldZ: number; level?: number } | null | undefined, to: Tile, tiles: number): boolean {
    return !!p && ((p.level ?? 0) !== to.level || Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) > tiles);
}

export async function approach(s: Session, to: Tile, stop: () => boolean = () => false): Promise<Outcome> {
    const cancel = new AbortController();
    const off = s.onTick(() => { if (stop()) cancel.abort('stop requested'); });
    try {
        const world = await getWorld();
        return await ferryWalk(
            s,
            to,
            (tile, planBudgetMs) => goTo(s, world, tile, accountOf(s), { maxRetriesPerLeg: 2, legTimeoutTicks: 150, signal: cancel.signal, planBudgetMs }),
            () => stop() || cancel.signal.aborted,
        );
    } finally {
        off();
    }
}

export async function walkTargetPersist(
    s: Session,
    to: Tile,
    tries = 4,
    walk: (to: Tile) => Promise<{ ok: boolean; reason?: string; detail?: string }> = t => walkTarget(s, t, false),
) {
    let best = Infinity;
    let last: { ok: boolean; reason?: string; detail?: string } = { ok: false };
    const tileOf = () => { const p = s.sdk.getState()?.player; return p ? `${p.worldX},${p.worldZ},${p.level}` : ''; };
    for (let n = 1; n <= tries; n++) {
        const before = tileOf();
        last = await walk(to);
        if (last.ok) return last;
        const p = s.sdk.getState()?.player;
        const distance = p && p.level === to.level ? Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) : Infinity;
        console.log(`WALK_RETRY try=${n} reason=${last.reason ?? '-'} detail=${last.detail ?? '-'} distance=${distance}`);
        // A route search that found no route from a tile finds none again from it: each try costs the full search
        // budget. A walk that moved first (a leg, a boat) plans again from where it ended.
        if (noRouteResult(last) && tileOf() === before) break;
        if (distance >= best) break;
        best = distance;
    }
    return last;
}

// A goTo result whose route search found no route (walk/goto.ts WALK_NO_ROUTE). The same search from the same tile
// with the same pack and bank gives the same answer.
export const noRouteResult = (r: { reason?: string; detail?: string }) => r.reason === 'precondition' && /^no route\b/.test(r.detail ?? '');

export function productionStopRequested(
    actor: string | undefined,
    stop: () => boolean = () => false,
    exists: (path: string) => boolean = existsSync,
    role: string | undefined = process.env.STOP_FILE,
) {
    return stop() || isStopFilePresent(actor, [], exists, role);
}

export function watchProductionLife(s: Session, stop: () => boolean = () => false, options: { allowDamage?: boolean } = {}) {
    const allowDamage = options.allowDamage === true;
    const initial = s.sdk.getState()?.player;
    const initialHp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    if (!initial || initialHp <= 0 || (allowDamage && !Number.isFinite(initialHp))) throw Error('production life unobserved');
    const initialRespawns = initial.respawnCount ?? 0;
    const initialLife = initial.lifeId;
    let ended = false;
    let why = '';
    void s.ended?.then(() => { ended = true; });
    const reason = () => {
        const p = s.sdk.getState()?.player;
        const hp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
        if (why) return why;
        if (ended) why = 'session ended';
        else if (productionStopRequested(s.name, stop)) why = 'stop requested';
        else if (!p || hp <= 0 || p.isDead || (allowDamage && !Number.isFinite(hp))) why = 'dead or player unavailable';
        else if ((allowDamage ? (p.respawnCount ?? 0) !== initialRespawns : (p.respawnCount ?? 0) > initialRespawns)
            || (initialLife !== undefined && p.lifeId !== initialLife)) why = 'life changed';
        else if (!allowDamage && hp < initialHp) why = 'damage observed';
        return why;
    };
    return { reason, stopped: () => !!reason() };
}
