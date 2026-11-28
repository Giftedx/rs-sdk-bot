// World walking, ferry fallbacks, bank/knight relocation, Edgeville walking, and Draynor staging.
import type { Outcome } from '../../../core/src/act';
import { accountOf, getWorld } from '../../../core/src/bot';
import type { Session } from '../../../core/src/inprocess';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { loadTravel, travelAllowed, type Travel } from '../../../core/src/travel';
import { knownBanks } from '../../../core/src/trip';
import { goTo, sessionWalker, walkPath, walkRoute, type PathDeps } from '../../../core/src/walk';
import type { Account, Tile } from '../../../core/src/world';
import { guardCowWalker, leaveRuneStarter, onStarterIsland } from './walk-helpers';

export function parseTarget(args: string[]): { account: string; to: { x: number; z: number; level: number } } {
    const [account, x, z, level] = args;
    const to = { x: Number(x), z: Number(z), level: Number(level ?? 0) };
    if (!account || ![to.x, to.z, to.level].every(Number.isInteger)) throw Error('usage: walk-to.ts <account> <x> <z> [level]');
    return { account, to };
}

export type WalkOperations = {
    planned(s: Session, to: Tile): Promise<{ ok: boolean }>;
    ground(s: Session, to: Tile): Promise<{ ok: boolean }>;
};

export async function walkTarget(s: Session, to: Tile, ground: boolean, operations?: WalkOperations, walkOpts?: { noJewelry?: boolean }) {
    const ops: WalkOperations = operations ?? {
        planned: async (sess, tile) => {
            const world = await getWorld();
            return ferryWalk(sess, tile, (dest, planBudgetMs) => goTo(sess, world, dest, accountOf(sess), {
                legTimeoutTicks: 100,
                planBudgetMs,
                ...(walkOpts?.noJewelry ? { noJewelry: true } : {}),
            }));
        },
        ground: async (sess, tile) => walkPath(await sessionWalker(sess), [{ ...tile, tol: 1 }], { maxTicks: 600 }),
    };
    if (ground && s.sdk.getState()?.player?.level !== to.level) throw Error('ground walk requires a known start on the same plane');
    return ground ? ops.ground(s, to) : ops.planned(s, to);
}

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
const FERRY_LEG_PLAN_MS = 15_000;

export function fareSpare(pack: readonly { id: number }[]): { id: number; all: boolean } | null {
    if (pack.length < PACK_SLOTS) return null;
    const rows = new Map<number, number>();
    for (let i = 0; i < pack.length; i++) {
        const id = pack[i]!.id;
        if (id === COINS) return null;
        rows.set(id, (rows.get(id) ?? 0) + 1);
    }
    let bestId = 0;
    let bestN = -1;
    for (const [id, n] of rows) {
        if (n > bestN) {
            bestN = n;
            bestId = id;
        }
    }
    return { id: bestId, all: bestN === 1 };
}

export const fareFault = (need: number, missing: number, banked: number): string =>
    banked >= missing ? `ferry fare: the withdrawal of ${missing} coins failed, the bank holds ${banked}` : `ferry needs ${need} coins and the bank holds ${banked}`;

export async function bankFare(s: Session, need: number, walk: (to: Tile, budgetMs?: number) => Promise<Outcome>): Promise<Outcome> {
    const start = s.tick();
    const held = () => s.sdk.getInventory().filter(i => i.id === COINS).reduce((n, i) => n + i.count, 0);
    const done = (ok: boolean, detail: string): Outcome =>
        ok ? { ok: true, ticks: s.tick() - start } : { ok: false, reason: 'precondition', detail, ticks: s.tick() - start };
    const p = s.sdk.getState()?.player;
    if (!p || p.level !== 0) return done(false, `ferry needs ${need} coins in the pack`);
    const bank = [...FARE_BANKS].sort((a, b) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ)) - Math.max(Math.abs(b.x - p.worldX), Math.abs(b.z - p.worldZ)))[0]!;
    const there = await walk(bank, FERRY_LEG_PLAN_MS);
    if (!there.ok) return { ...there, ticks: s.tick() - start };
    const generation = s.bankObservation?.()?.generation ?? 0;
    if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 20 })) {
        return done(false, `ferry fare: the bank at ${bank.x},${bank.z} did not open`);
    }
    const missing = need - held(), row = s.sdk.getState()?.bank?.items.find(i => i.id === COINS);
    const spare = missing > 0 ? fareSpare(s.sdk.getInventory()) : null, item = spare && s.sdk.getInventory().find(i => i.id === spare.id);
    if (spare && (!item || !(await s.bot.depositItem(item, spare.all ? -1 : 1)).success || !await waitUntil(s, () => s.sdk.getInventory().length < PACK_SLOTS, { timeoutTicks: 10 }))) {
        await s.bot.closeBank();
        return done(false, `ferry fare: a full pack and the deposit of item ${spare.id} failed`);
    }
    const took = missing <= 0
        || !!row && row.count >= missing && (await s.bot.withdrawItem(row, missing, { asNote: false })).success && await waitUntil(s, () => held() >= need, { timeoutTicks: 20 });
    await s.bot.closeBank();
    return took ? done(true, '') : done(false, fareFault(need, missing, row?.count ?? 0));
}

export const onTutorialIsland = onStarterIsland;

export async function leaveTutorial(
    s: Session,
    skip?: () => Promise<{ success: boolean; message?: string }>,
    ready?: () => Promise<unknown>,
    stop: () => boolean = () => false,
): Promise<Outcome | null> {
    if (!onTutorialIsland(s.sdk.getState()?.player)) return null;
    const start = s.tick?.() ?? 0;
    try {
        if (stop()) throw Error('stopped during starter exit');
        if (ready) await ready();
        if (stop()) throw Error('stopped during starter exit');
        if (skip) {
            const r = await skip();
            console.log(`MILESTONE tutorial ${r.success ? 'ok' : 'fail'}`);
            if (!r.success) return { ok: false, reason: 'precondition', detail: `tutorial skip failed: ${r.message ?? ''}`, ticks: 0 };
        } else {
            await leaveRuneStarter(s, stop);
        }
        if (stop()) throw Error('stopped during starter exit');
        return null;
    } catch (error) {
        return { ok: false, reason: stop() ? 'aborted' : 'precondition', detail: String(error), ticks: (s.tick?.() ?? start) - start };
    }
}

export async function ferryWalk(
    s: Session,
    to: Tile,
    walk: (to: Tile, budgetMs?: number) => Promise<Outcome>,
    stop: () => boolean = () => false,
): Promise<Outcome> {
    const stuck = await leaveTutorial(s, undefined, undefined, stop);
    if (stuck) return stuck;
    const p = s.sdk.getState()?.player;
    if (!p) return walk(to);
    return walkWithFerryFallback({ x: p.worldX, z: p.worldZ, level: p.level }, to, walk, boat => {
        const at = s.sdk.getState()?.player;
        if (!at) return Promise.resolve({ ok: false, reason: 'precondition', detail: 'ferry departure state unavailable', ticks: 0 });
        return walkRoute(s, [stagedBoat(boat, { x: at.worldX, z: at.worldZ, level: at.level }, boat.to, accountOf(s))], { maxRetriesPerLeg: 1, legTimeoutTicks: 150 });
    }, () => accountOf(s).coins ?? 0, need => bankFare(s, need, walk));
}

export function awayFrom(p: { worldX: number; worldZ: number; level?: number } | null | undefined, to: Tile, tiles: number): boolean {
    return !!p && ((p.level ?? 0) !== to.level || Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) > tiles);
}

export async function approach(s: Session, to: Tile, stop: () => boolean = () => false): Promise<Outcome> {
    const cancel = new AbortController(), off = s.onTick(() => { if (stop()) cancel.abort('stop requested'); });
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
    let best = Infinity, last: { ok: boolean; reason?: string; detail?: string } = { ok: false };
    for (let n = 1; n <= tries; n++) {
        last = await walk(to);
        if (last.ok) return last;
        const p = s.sdk.getState()?.player, distance = p && p.level === to.level ? Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) : Infinity;
        console.log(`WALK_RETRY try=${n} reason=${last.reason ?? '-'} detail=${last.detail ?? '-'} distance=${distance}`);
        if (distance >= best) break;
        best = distance;
    }
    return last;
}

const PORT_SARIM_FERRY = 'npc:captain_tobias:karamja-musa-point@3028,3216';
const ARDOUGNE_FERRY = 'npc:customs_officer:ardougne@2772,3225';
const BRIMHAVEN_FERRY = 'npc:captain_barnaby:brimhaven@2679,3275';
const MUSA_POINT_FERRY = 'npc:customs_officer:port-sarim@2953,3147';
const AL_KHARID_TOLL = 'npc:borderguard2:lumbridge-side-west-of-the-toll-gate@3268,3226';
const LUMBRIDGE: Tile = { x: 3222, z: 3218, level: 0 }, DRAYNOR: Tile = { x: 3092, z: 3243, level: 0 };
const inEast = (t: Tile) => t.level === 0 && t.x >= 2870 && t.x <= 3280 && t.z >= 3150 && t.z <= 3510;
const inArdougne = (t: Tile) => t.level === 0 && t.x >= 2550 && t.x <= 2700 && t.z >= 3240 && t.z <= 3400;
const ARDOUGNE_NORTH: Tile = { x: 2619, z: 3332, level: 0 };
const inKandarin = (t: Tile) => t.level === 0 && t.x >= 2440 && t.x < 2870 && t.z >= 3040 && t.z <= 3530;

export const ZANARIS_SHED: Tile = { x: 3201, z: 3169, level: 0 };
export const inZanaris = (t: Tile) => t.level === 0 && t.x >= 3136 && t.x < 3264 && t.z >= 9536 && t.z < 9600;

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
    if ((upstairs || !inArdougne(from) && inKandarin(from)) && inEast(to)) {
        const home = await walk(ARDOUGNE_NORTH, FERRY_LEG_PLAN_MS);
        ticks += home.ticks;
        // No route to Ardougne North (a weak account east of White Wolf Mountain is still inside the Kandarin box,
        // MeatNTwoVeg at 2793,3516): the walk below searches its own route from where the account stands.
        if (home.ok) from = ARDOUGNE_NORTH;
        else if (!noRoute(home)) return { ...home, ticks };
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
    const missingFare = (wanted: number): Outcome => ({ ok: false, reason: 'precondition', detail: `${west ? 'westbound' : 'eastbound'} ferry needs ${wanted} coins in the pack`, ticks });
    if (coins() < need) return missingFare(need);
    const through = !west || from.x < 3060 ? [] : from.x >= 3200 ? [LUMBRIDGE, DRAYNOR] : Math.max(Math.abs(from.x - DRAYNOR.x), Math.abs(from.z - DRAYNOR.z)) <= 3 ? [] : [DRAYNOR];
    for (const tile of through) {
        const leg = await walk(tile, FERRY_LEG_PLAN_MS);
        ticks += leg.ticks;
        if (!leg.ok) return { ...leg, ticks };
    }
    for (const [boat, departure] of [[first, first.from], [second, second.from]] as const) {
        const legStart = await walk(departure, FERRY_LEG_PLAN_MS);
        ticks += legStart.ticks;
        if (!legStart.ok) return { ...legStart, ticks };
        if (coins() < fare) return missingFare(fare);
        const crossed = await sail(boat);
        ticks += crossed.ticks;
        if (!crossed.ok) return { ...crossed, ticks };
        fare -= boat.coins;
    }
    const final = await walk(to, FERRY_LEG_PLAN_MS);
    return { ...final, ticks: ticks + final.ticks };
}

export function stagedBoat(boat: Travel | undefined, from: Tile, to: Tile, account: Account) {
    if (!boat?.from || boat.kind !== 'boat' || boat.run.how !== 'npc') throw Error('known NPC boat required');
    if (from.level !== boat.from.level || Math.max(Math.abs(from.x - boat.from.x), Math.abs(from.z - boat.from.z)) > 8) throw Error('boat departure not reached');
    if (to.x !== boat.to.x || to.z !== boat.to.z || to.level !== boat.to.level) throw Error('boat arrival differs from target');
    if (!travelAllowed(boat, account)) throw Error('boat unavailable for this account');
    return { kind: 'travel' as const, travel: boat, at: boat.from, to: boat.to };
}

// Options after `<x> <z> [level]`: one of `--ground` or `--boat=<id>`, or the fallbacks of a planned walk:
// `--or=<x>,<z>,<level>[;...]` tiles to try in order, and `--or-bank` for the known banks nearest the account.
export type WalkToOptions = { ground: boolean; boatId?: string; or: Tile[]; orBank: boolean };
export function parseWalkOptions(opts: readonly string[]): WalkToOptions {
    const out: WalkToOptions = { ground: false, or: [], orBank: false };
    for (const o of opts) {
        if (o === '--ground' && !out.ground) out.ground = true;
        else if (o.startsWith('--boat=') && out.boatId === undefined) out.boatId = o.slice(7);
        else if (o === '--or-bank') out.orBank = true;
        else if (o.startsWith('--or=')) {
            for (const part of o.slice(5).split(';')) {
                const [x, z, level, extra] = part.split(',').map(Number);
                if (extra !== undefined || ![x, z, level].every(Number.isInteger)) throw Error(`bad walk fallback tile "${part}"`);
                out.or.push({ x: x!, z: z!, level: level! });
            }
        } else throw Error('unknown walk option');
    }
    if (Number(out.ground) + Number(out.boatId !== undefined) + Number(out.or.length > 0 || out.orBank) > 1) throw Error('unknown walk option');
    return out;
}

const FALLBACK_BANKS = 3;     // known banks a fallback walk tries after its listed tiles
const SAME_PLACE_TILES = 8;   // a bank this near a tile already in the list is the same place
const noRoute = (r: { ok: boolean; reason?: string; detail?: string }) => !r.ok && r.reason === 'precondition' && /^no route\b/.test(r.detail ?? '');
const cheb = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

// The tiles a fallback walk tries, in order: the target, the listed tiles, then (orBank) the known banks on the
// account's floor nearest it. A tile within SAME_PLACE_TILES of an earlier one is left out.
export function fallbackTiles(to: Tile, or: readonly Tile[], orBank: boolean, at: Tile | null, banks: readonly Tile[]): Tile[] {
    const list: Tile[] = [];
    const add = (t: Tile) => { if (!list.some(u => u.level === t.level && cheb(u, t) <= SAME_PLACE_TILES)) list.push(t); };
    add(to);
    for (const t of or) add(t);
    if (orBank && at) {
        const near = banks.filter(b => b.level === at.level).sort((a, b) => cheb(a, at) - cheb(b, at));
        let n = 0;
        for (const b of near) {
            if (n >= FALLBACK_BANKS) break;
            const before = list.length;
            add(b);
            if (list.length > before) n++;
        }
    }
    return list;
}

// Walks to the first tile the route search reaches for this account. A tile is passed over only when the search
// found no route to it; any other failure, a walk that started and stopped included, ends the walk there.
export async function walkFirstReachable(
    tiles: readonly Tile[],
    walk: (to: Tile) => Promise<{ ok: boolean; reason?: string; detail?: string }>,
    log: (line: string) => void = console.log,
): Promise<{ ok: boolean; reason?: string; detail?: string }> {
    let last: { ok: boolean; reason?: string; detail?: string } = { ok: false, reason: 'precondition', detail: 'no walk target' };
    for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i]!;
        last = await walk(t);
        if (!noRoute(last)) {
            if (i > 0) log(`WALK_FALLBACK_TARGET ${JSON.stringify({ to: t, ok: last.ok, tried: i })}`);
            return last;
        }
        log(`WALK_FALLBACK ${JSON.stringify({ to: t, detail: last.detail, next: tiles[i + 1] ?? null })}`);
    }
    return last;
}

export async function runWalkTo(s: Session, args: readonly string[]): Promise<{ ok: boolean; summary: string }> {
    const { to } = parseTarget([s.name, ...args.slice(0, 3)]);
    const opts = parseWalkOptions(args.slice(3));
    const { ground, boatId } = opts;
    const boat = boatId ? loadTravel().find(t => t.id === boatId) : undefined;
    if (boatId && !boat) throw Error('unknown boat');
    const here = () => {
        const p = s.sdk.getState()?.player;
        return p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown';
    };
    const t0 = s.tick();
    console.log(`WALK_START from=${here()} to=${to.x},${to.z},${to.level} mode=${ground ? 'ground' : boat ? 'boat' : 'planned'}`);
    const p = s.sdk.getState()!.player!;
    const fallback = opts.or.length > 0 || opts.orBank;
    const r = boat
        ? await walkRoute(s, [stagedBoat(boat, { x: p.worldX, z: p.worldZ, level: p.level }, to, accountOf(s))], { maxRetriesPerLeg: 1, legTimeoutTicks: 150 })
        : fallback
            ? await walkFirstReachable(fallbackTiles(to, opts.or, opts.orBank, { x: p.worldX, z: p.worldZ, level: p.level }, knownBanks()), t => walkTarget(s, t, false))
            : await walkTarget(s, to, ground);
    return { ok: r.ok, summary: `walk-to ${JSON.stringify(r)} at=${here()} ticks=${s.tick() - t0}` };
}

const EDGEVILLE_BANK: Tile = { x: 3094, z: 3492, level: 0 };
const WALK_EDGE_WAYPOINTS: readonly Tile[] = [{ x: 2897, z: 3428, level: 0 }, EDGEVILLE_BANK];
const WALK_EDGE_BUDGET_MS = 180_000;

export async function runWalkEdge(s: Session): Promise<{ ok: boolean; detail: string; at: Tile | null }> {
    const here = () => {
        const p = s.sdk.getState()?.player;
        return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null;
    };
    const near = (a: { x: number; z: number }, b: { x: number; z: number }, r: number) =>
        Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) <= r;
    const world = await getWorld();
    const start = here();
    console.log('WALK_EDGE_START ' + JSON.stringify({ at: start }));
    const legs = start && near(start, EDGEVILLE_BANK, 150) ? [EDGEVILLE_BANK] : WALK_EDGE_WAYPOINTS;
    let detail = '';
    for (const wp of legs) {
        const t0 = s.tick();
        const r = await goTo(s, world, wp, accountOf(s), { legTimeoutTicks: 150, planBudgetMs: WALK_EDGE_BUDGET_MS });
        console.log('WALK_EDGE_LEG ' + JSON.stringify({ to: wp, ok: r.ok, ticks: s.tick() - t0, at: here(), outcome: r }).slice(0, 600));
        if (!r.ok) {
            detail = `leg to ${wp.x},${wp.z} failed: ${JSON.stringify(r).slice(0, 200)}`;
            break;
        }
    }
    const end = here();
    const ok = !!end && near(end, EDGEVILLE_BANK, 6);
    if (!ok && !detail) detail = `ended at ${JSON.stringify(end)}`;
    console.log('WALK_EDGE ' + JSON.stringify({ ok, detail, at: end }));
    return { ok, detail: ok ? 'at Edgeville bank' : detail, at: end };
}

type RelocationPosition = { worldX: number; worldZ: number; level: number };
type RelocationProfile = { name: string; start: { x: number; z: number; radius: number }; points: number[][] };

const KNIGHT_RELOCATION_PROFILES: readonly RelocationProfile[] = [
    { name: 'seers', start: { x: 2727, z: 3492, radius: 6 }, points: [[2763, 3472], [2800, 3457], [2809, 3441], [2677, 3358], [2648, 3358], [2654, 3283]] },
    { name: 'catherby', start: { x: 2809, z: 3441, radius: 6 }, points: [[2809, 3441], [2677, 3358], [2648, 3358], [2654, 3283]] },
    { name: 'ardougne-north', start: { x: 2619, z: 3332, radius: 3 }, points: [[2644, 3293], [2655, 3283]] },
    { name: 'ardougne-south', start: { x: 2655, z: 3283, radius: 3 }, points: [[2655, 3283]] },
];
const LEGACY_RELOCATION_PROFILES: Readonly<Record<string, { route: string; name: string }>> = {
    pocketrocket: { route: 'seers', name: 'Pocketrocket' },
    mmtha0205: { route: 'catherby', name: 'mmtha0205' },
    mightyrod: { route: 'ardougne-north', name: 'Mightyrod' },
};

export function knightRelocationProfile(name: string, position?: RelocationPosition): RelocationProfile {
    const key = name.toLowerCase(), alias = LEGACY_RELOCATION_PROFILES[key];
    const profile = position
        ? KNIGHT_RELOCATION_PROFILES.find(candidate => relocationStart(position, candidate))
        : KNIGHT_RELOCATION_PROFILES.find(candidate => candidate.name === (alias?.route ?? key));
    if (!profile) throw new Error('no relocation progress: supported ground-floor bank start required (Seers, Catherby or Ardougne)');
    return { name: !position && alias ? alias.name : profile.name, start: { ...profile.start }, points: profile.points.map(point => [...point]) };
}

export function relocationStart(p: RelocationPosition | null | undefined, profile: { start: { x: number; z: number; radius: number } }) {
    return !!p && p.level === 0 && Math.max(Math.abs(p.worldX - profile.start.x), Math.abs(p.worldZ - profile.start.z)) <= profile.start.radius;
}

export function relocationAssets(items: readonly { id: number; count: number }[]) {
    const out = new Map<number, number>();
    for (const i of items) out.set(i.id, (out.get(i.id) ?? 0) + i.count);
    return out;
}

export function relocationPreserved(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>) {
    for (const [id, count] of a) {
        if (count !== (b.get(id) ?? 0)) return false;
    }
    for (const [id, count] of b) {
        if (count !== (a.get(id) ?? 0)) return false;
    }
    return true;
}

export function bankRelocationProfile() {
    return {
        name: 'draynor-west',
        start: { x: 3092, z: 3243, radius: 4 },
        points: [[3092, 3250], [3089, 3266], [3100, 3270], [3140, 3270], [3180, 3258], [3218, 3256], [3242, 3248], [3255, 3295], [3255, 3330], [3265, 3350], [3265, 3370], [3295, 3370], [3290, 3404], [3253, 3420], [3212, 3424], [3185, 3436]],
    };
}

export function completeBankPlan(plan: PathDeps['plan']): PathDeps['plan'] {
    return (level, from, goal) => {
        const corners = plan(level, from, goal), end = corners.at(-1);
        if (!end || end.x !== goal.x || end.z !== goal.z) throw Error('no relocation progress: incomplete waypoint plan');
        return corners;
    };
}

export async function relocateBank(s: Session, options: { stop?: () => boolean; walker?: PathDeps } = {}) {
    const profile = bankRelocationProfile(), state = () => s.sdk.getState(), hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    if (!await waitUntil(s, () => hp() > 0 && !!state()?.player, { timeoutTicks: 15 })) throw new Error('no relocation progress: HP/position unknown');
    const first = state()!.player!, hpStart = hp(), start = s.tick();
    if (!relocationStart(first, profile)) throw new Error('no relocation progress: explicit profile requires its known ground-floor bank start');
    if (!Array.isArray(state()?.equipment)) throw new Error('no relocation progress: worn equipment unknown');
    if (state()?.skills.length !== 21 || state()!.skills.some(v => !Number.isFinite(v.experience))) throw new Error('no relocation progress: all21 XP observations required');
    const observe = s.bankObservation?.bind(s);
    if (!observe) throw new Error('no relocation progress: fresh bank observation unavailable');
    let ended = false, died = false, damaged = false, hpMin = hpStart, failure = '';
    const safety = () => {
        const st = state(), p = st?.player;
        hpMin = Math.min(hpMin, hp());
        damaged ||= hp() < hpStart;
        died ||= !!p?.isDead || (p?.respawnCount ?? 0) > (first.respawnCount ?? 0) || (first.lifeId !== undefined && (p?.lifeId ?? first.lifeId) !== first.lifeId);
        if (ended || died) return 'relocation ended/dead';
        if (damaged) return 'relocation first HP drop';
        if (options.stop?.()) return 'relocation stop requested';
        if (!p || p.level !== 0) return 'relocation unexpected floor';
        if (st?.nearbyNpcs.some(n => /bear/i.test(n.name) && n.distance <= 6)) return 'relocation observed bear within6';
        return null;
    };
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(safety);
    const open = async (generation: number) => {
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!observe() && (observe()?.generation ?? 0) > generation, { timeoutTicks: 20 })) {
            throw new Error('no relocation progress: fresh bank inventory unobserved');
        }
        return observe()!;
    };
    const assets = () => relocationAssets([...s.sdk.getInventory(), ...s.sdk.getEquipment(), ...(observe()?.items ?? [])]);
    const xp = () => JSON.stringify((state()?.skills ?? []).map(v => [v.name, v.experience]));
    let initial: Map<number, number> | undefined, initialXp = '', initialGeneration = 0, finalGeneration = 0, atBank = false, walkTicks = 0, finalAssets: Map<number, number> | undefined;
    try {
        const initialBank = await open(observe()?.generation ?? 0);
        initialGeneration = initialBank.generation;
        initial = assets();
        initialXp = xp();
        if (safety()) throw new Error(`no relocation progress: ${safety()}`);
        const cash = s.sdk.getInventory().find(i => i.id === 995);
        if (cash) {
            const amount = s.sdk.getInventory().filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
            const before = initialBank.items.filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
            if (!(await s.bot.depositItem(cash, -1)).success
                || !await waitUntil(s, () => !s.sdk.getInventory().some(i => i.id === 995) && (observe()?.items.filter(i => i.id === 995).reduce((n, i) => n + i.count, 0) ?? -1) === before + amount, { timeoutTicks: 10 })) {
                throw new Error('no relocation progress: held coins not fully secured');
            }
        }
        if (!relocationPreserved(initial, assets())) throw new Error('no relocation progress: initial asset mismatch');
        await s.bot.closeBank();
        const walker = options.walker ?? await sessionWalker(s);
        walker.plan = completeBankPlan(walker.plan);
        const guard = guardCowWalker(walker, safety);
        const points = profile.points.map(([x, z]) => ({ x: x!, z: z!, tol: 2 }));
        const r = await walkPath(guard.deps, points, { look: 6, maxTicks: 900, stop: () => !!guard.reason() });
        walkTicks = r.ticks;
        if (!r.ok || guard.reason()) throw new Error(`no relocation progress: route ${guard.reason() ?? r.detail}`);
        const finalBank = await open(initialGeneration);
        finalGeneration = finalBank.generation;
        finalAssets = assets();
        const p = state()!.player!;
        atBank = p.level === 0 && Math.max(Math.abs(p.worldX - 3185), Math.abs(p.worldZ - 3436)) <= 3;
    } catch (e) {
        failure = String(e);
    } finally {
        off();
    }
    safety();
    const preserved = !!initial && !!finalAssets && relocationPreserved(initial, finalAssets), xpPreserved = !!initialXp && initialXp === xp();
    const ok = !failure && preserved && xpPreserved && atBank && !ended && !died && !damaged && !options.stop?.() && finalGeneration > initialGeneration;
    return {
        ok, profile: profile.name, ticks: s.tick() - start, walkTicks, hpStart, hpMin, died, damaged, preserved, xpPreserved, atBank, initialGeneration, finalGeneration,
        position: state()?.player ? { x: state()!.player!.worldX, z: state()!.player!.worldZ, level: state()!.player!.level } : null,
        inventory: s.sdk.getInventory(), equipment: s.sdk.getEquipment(), bank: observe()?.items ?? null,
        failure: failure || (!ok ? 'no relocation progress: final observation gate failed' : '-'),
    };
}

export async function relocateKnight(s: Session, name: string, options: { stop?: () => boolean; walker?: PathDeps } = {}) {
    const state = () => s.sdk.getState(), hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    if (!await waitUntil(s, () => hp() > 0 && !!state()?.player, { timeoutTicks: 15 })) throw new Error('no relocation progress: HP/position unknown');
    const first = state()!.player!, profile = knightRelocationProfile(name, first), lifeId = first.lifeId, respawns = first.respawnCount ?? 0, hpStart = hp(), start = s.tick();
    if (!relocationStart(first, profile)) throw new Error('no relocation progress: explicit profile requires its known ground-floor bank start');
    if (!Array.isArray(state()?.equipment)) throw new Error('no relocation progress: worn equipment unknown');
    if (state()?.skills.length !== 21 || state()!.skills.some(v => !Number.isFinite(v.experience))) throw new Error('no relocation progress: all21 XP observations required');
    const observe = s.bankObservation?.bind(s);
    if (!observe) throw new Error('no relocation progress: fresh bank observation unavailable');
    let ended = false, died = false, damaged = false, hpMin = hpStart, failure = '';
    const safety = () => {
        const st = state(), p = st?.player;
        hpMin = Math.min(hpMin, hp());
        damaged ||= hp() < hpStart;
        died ||= !!p?.isDead || (p?.respawnCount ?? 0) > respawns || (lifeId !== undefined && (p?.lifeId ?? lifeId) !== lifeId);
        if (ended || died) return 'relocation ended/dead';
        if (damaged) return 'relocation first HP drop';
        if (options.stop?.()) return 'relocation stop requested';
        if (!p || p.level !== 0) return 'relocation unexpected floor';
        if (st?.nearbyNpcs.some(n => /bear/i.test(n.name) && n.distance <= 6)) return 'relocation observed bear within6';
        return null;
    };
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(safety);
    const open = async (generation: number) => {
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!observe() && (observe()?.generation ?? 0) > generation, { timeoutTicks: 20 })) {
            throw new Error('no relocation progress: fresh bank inventory unobserved');
        }
        return observe()!;
    };
    const assets = () => relocationAssets([...s.sdk.getInventory(), ...s.sdk.getEquipment(), ...(observe()?.items ?? [])]);
    const xp = () => JSON.stringify((state()?.skills ?? []).map(v => [v.name, v.experience]));
    let initial: Map<number, number> | undefined, initialXp = '', initialGeneration = 0, finalGeneration = 0, atBank = false, walkTicks = 0, finalAssets: Map<number, number> | undefined;
    try {
        const initialBank = await open(observe()?.generation ?? 0);
        initialGeneration = initialBank.generation;
        initial = assets();
        initialXp = xp();
        if (safety()) throw new Error(`no relocation progress: ${safety()}`);
        const cash = s.sdk.getInventory().find(i => i.id === 995);
        if (cash) {
            const amount = s.sdk.getInventory().filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
            const before = initialBank.items.filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
            if (!(await s.bot.depositItem(cash, -1)).success
                || !await waitUntil(s, () => !s.sdk.getInventory().some(i => i.id === 995) && (observe()?.items.filter(i => i.id === 995).reduce((n, i) => n + i.count, 0) ?? -1) === before + amount, { timeoutTicks: 10 })) {
                throw new Error('no relocation progress: held coins not fully secured');
            }
        }
        if (!relocationPreserved(initial, assets())) throw new Error('no relocation progress: initial asset mismatch');
        await s.bot.closeBank();
        const guard = guardCowWalker(options.walker ?? await sessionWalker(s), safety);
        const points = profile.points.map(([x, z]) => ({ x: x!, z: z!, tol: 2 }));
        const r = await walkPath(guard.deps, points, { look: 6, maxTicks: 750, stop: () => !!guard.reason() });
        walkTicks = r.ticks;
        if (!r.ok || guard.reason()) throw new Error(`no relocation progress: route ${guard.reason() ?? r.detail}`);
        const finalBank = await open(initialGeneration);
        finalGeneration = finalBank.generation;
        finalAssets = assets();
        const p = state()!.player!;
        atBank = p.level === 0 && [3283, 3286].some(z => Math.max(Math.abs(p.worldX - 2656), Math.abs(p.worldZ - z)) <= 1);
    } catch (e) {
        failure = String(e);
    } finally {
        off();
    }
    safety();
    const preserved = !!initial && !!finalAssets && relocationPreserved(initial, finalAssets), xpPreserved = !!initialXp && initialXp === xp();
    const ok = !failure && preserved && xpPreserved && atBank && !ended && !died && !damaged && !options.stop?.() && finalGeneration > initialGeneration;
    return {
        ok, profile: profile.name, ticks: s.tick() - start, walkTicks, hpStart, hpMin, died, damaged, preserved, xpPreserved, atBank, initialGeneration, finalGeneration,
        position: state()?.player ? { x: state()!.player!.worldX, z: state()!.player!.worldZ, level: state()!.player!.level } : null,
        inventory: s.sdk.getInventory(), equipment: s.sdk.getEquipment(), bank: observe()?.items ?? null,
        failure: failure || (!ok ? 'no relocation progress: final observation gate failed' : '-'),
    };
}

export async function runArriveDraynor(s: Session): Promise<{ ok: boolean; detail: string; ticks: number }> {
    const start = s.tick();
    await leaveRuneStarter(s, () => false);
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    let hpMin = hp();
    const off = s.onTick(() => { hpMin = Math.min(hpMin, hp()); });
    try {
        const p = s.sdk.getState()?.player;
        if (!p || p.level !== 0 || p.worldX < 3000 || p.worldX > 3280 || p.worldZ < 3180 || p.worldZ > 3300) {
            throw new Error('requires Lumbridge/Draynor ground-floor start');
        }
        await s.direct({ type: 'closeModal', reason: 'SDK' });
        const points = p.worldX > 3150
            ? [
                { x: 3218, z: 3256, tol: 2 }, { x: 3180, z: 3258, tol: 3 }, { x: 3140, z: 3270, tol: 2 },
                { x: 3100, z: 3270, tol: 2 }, { x: 3089, z: 3266, tol: 2 }, { x: 3092, z: 3250, tol: 1 }, { x: 3092, z: 3243, tol: 2 },
            ]
            : [{ x: 3092, z: 3250, tol: 1 }, { x: 3092, z: 3243, tol: 2 }];
        const r = await walkPath(await sessionWalker(s), points, { maxTicks: 600, stop: () => hp() < 7 });
        if (!r.ok) throw new Error(`entry ${r.detail}; hpMin=${hpMin}`);
        if (!(await s.bot.openBank()).success) throw new Error('entry bank failed');
        const ids = new Set(s.sdk.getInventory().filter(i => !/^(coins|bread|shrimps)$/i.test(i.name)).map(i => i.id));
        for (const id of ids) {
            const item = s.sdk.getInventory().find(i => i.id === id);
            if (item) await s.bot.depositItem(item, -1);
        }
        const bank = s.sdk.getState()?.bank?.items ?? [];
        const remaining = s.sdk.getInventory();
        if (remaining.some(i => !/^(coins|bread|shrimps)$/i.test(i.name))) throw new Error('starter kit deposit incomplete');
        console.log('ENTRY ' + JSON.stringify({ ticks: s.tick() - start, hpMin, held: remaining.map(i => ({ id: i.id, name: i.name, count: i.count })), bank: bank.map(i => ({ id: i.id, name: i.name, count: i.count })) }));
        await s.bot.closeBank();
        return { ok: hpMin >= 7, detail: `supplier staged ticks=${s.tick() - start} hpMin=${hpMin}`, ticks: s.tick() - start };
    } finally {
        off();
    }
}
