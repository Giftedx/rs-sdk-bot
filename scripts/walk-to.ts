// Walk one account to a tile with the shared walker (packages/core/src/walk.ts goTo): the route search, travel,
// danger avoidance and bank stops it plans for this account. Prints WALK_PLAN when the plan starts walking and
// RESULT with the ticks used and the final tile, then logs out.
// Usage: bun scripts/walk-to.ts <account> <x> <z> [level] [--ground|--boat=<travel-id>]
// --ground uses the local walker for an inspected same-plane corridor, without transport or bank planning.
import { openBot, finish, getWorld, accountOf } from '../packages/core/src/bot';
import { goTo, walkPath, sessionWalker, walkRoute } from '../packages/core/src/walk';
import { waitUntil } from '../packages/core/src/ticks';
import type { Session } from '../packages/core/src/inprocess';
import type { Tile, Account } from '../packages/core/src/world';
import type { Outcome } from '../packages/core/src/act';
import { loadTravel, travelAllowed, type Travel } from '../packages/core/src/travel';

export function parseTarget(args: string[]): { account: string; to: { x: number; z: number; level: number } } {
    const [account, x, z, level] = args;
    const to = { x: Number(x), z: Number(z), level: Number(level ?? 0) };
    if (!account || ![to.x, to.z, to.level].every(Number.isInteger)) throw Error('usage: walk-to.ts <account> <x> <z> [level]');
    return { account, to };
}

type WalkOperations = { planned(s: Session, to: Tile): Promise<{ ok: boolean }>; ground(s: Session, to: Tile): Promise<{ ok: boolean }> };
export async function walkTarget(s: Session, to: Tile, ground: boolean, operations: WalkOperations = {
    planned: async (s, to) => {
        const world = await getWorld();
        return ferryWalk(s, to, (tile, planBudgetMs) => goTo(s, world, tile, accountOf(s), { legTimeoutTicks: 100, planBudgetMs }));
    },
    ground: async (s, to) => walkPath(await sessionWalker(s), [{ ...to, tol: 1 }], { maxTicks: 600 }),
}) {
    if (ground && s.sdk.getState()?.player?.level !== to.level) throw Error('ground walk requires a known start on the same plane');
    return ground ? operations.ground(s, to) : operations.planned(s, to);
}

// Banks where a walker fetches a ferry fare: Varrock West and East, Draynor, Falador East and West, and Ardougne's
// north and south banks.
const FARE_BANKS: readonly Tile[] = [{ x: 3185, z: 3436, level: 0 }, { x: 3253, z: 3420, level: 0 }, { x: 3092, z: 3243, level: 0 },
    { x: 3013, z: 3355, level: 0 }, { x: 2946, z: 3368, level: 0 }, { x: 2619, z: 3332, level: 0 }, { x: 2655, z: 3283, level: 0 }];
const COINS = 995, PACK_SLOTS = 28;
// A full pack with no coin stack has no slot for the fare (live: 22 flax and 6 slices of cake, "ferry needs 60 coins
// and the bank holds 11000"). The item to bank for one free slot: one of the kind that fills the most slots, or the
// whole stack when every kind fills one slot.
export function fareSpare(pack: readonly { id: number }[]): { id: number; all: boolean } | null {
    if (pack.length < PACK_SLOTS || pack.some(i => i.id === COINS)) return null;
    const rows = new Map<number, number>();
    for (const i of pack) rows.set(i.id, (rows.get(i.id) ?? 0) + 1);
    const [id, n] = [...rows].sort((x, y) => y[1] - x[1])[0]!;
    return { id, all: n === 1 };
}
// Takes the missing coins of a ferry fare from the nearest of those banks, and no more.
export async function bankFare(s: Session, need: number, walk: (to: Tile, budgetMs?: number) => Promise<Outcome>): Promise<Outcome> {
    const start = s.tick(), held = () => s.sdk.getInventory().filter(i => i.id === COINS).reduce((n, i) => n + i.count, 0);
    const done = (ok: boolean, detail: string): Outcome => ok ? { ok: true, ticks: s.tick() - start } : { ok: false, reason: 'precondition', detail, ticks: s.tick() - start };
    const p = s.sdk.getState()?.player;
    if (!p || p.level !== 0) return done(false, `ferry needs ${need} coins in the pack`);
    const bank = [...FARE_BANKS].sort((a, b) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ)) - Math.max(Math.abs(b.x - p.worldX), Math.abs(b.z - p.worldZ)))[0]!;
    const there = await walk(bank, FERRY_LEG_PLAN_MS);
    if (!there.ok) return { ...there, ticks: s.tick() - start };
    const generation = s.bankObservation?.()?.generation ?? 0;
    if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 20 }))
        return done(false, `ferry fare: the bank at ${bank.x},${bank.z} did not open`);
    const missing = need - held(), row = s.sdk.getState()?.bank?.items.find(i => i.id === COINS);
    const spare = missing > 0 ? fareSpare(s.sdk.getInventory()) : null, item = spare && s.sdk.getInventory().find(i => i.id === spare.id);
    if (spare && (!item || !(await s.bot.depositItem(item, spare.all ? -1 : 1)).success || !await waitUntil(s, () => s.sdk.getInventory().length < PACK_SLOTS, { timeoutTicks: 10 }))) {
        await s.bot.closeBank();
        return done(false, `ferry fare: a full pack and the deposit of item ${spare.id} failed`);
    }
    const took = missing <= 0 || !!row && row.count >= missing && (await s.bot.withdrawItem(row, missing, { asNote: false })).success
        && await waitUntil(s, () => held() >= need, { timeoutTicks: 20 });
    await s.bot.closeBank();
    return took ? done(true, '') : done(false, `ferry needs ${need} coins and the bank holds ${row?.count ?? 0}`);
}

// A planned walk that takes the Ardougne ferries when the planner has no route, with the fare from the bank. `walk`
// is the caller's planned walk for one leg.
export function ferryWalk(s: Session, to: Tile, walk: (to: Tile, budgetMs?: number) => Promise<Outcome>): Promise<Outcome> {
    const p = s.sdk.getState()?.player;
    if (!p) return walk(to);
    return walkWithFerryFallback({ x: p.worldX, z: p.worldZ, level: p.level }, to, walk, boat => {
        const at = s.sdk.getState()?.player;
        if (!at) return Promise.resolve({ ok: false, reason: 'precondition', detail: 'ferry departure state unavailable', ticks: 0 });
        return walkRoute(s, [stagedBoat(boat, { x: at.worldX, z: at.worldZ, level: at.level }, boat.to, accountOf(s))],
            { maxRetriesPerLeg: 1, legTimeoutTicks: 150 });
    }, () => accountOf(s).coins ?? 0, need => bankFare(s, need, walk));
}

// A worker that walks on one floor (walkPath, bot.walkTo) cannot leave another floor, and its long walks cross no
// ferry. `awayFrom` is true for a start on another floor than `to` or more than `tiles` from it; `approach` is the
// walk from such a start: the planned walk with the stairs, the doors and the ferries, cancelled when `stop` is true.
export function awayFrom(p: { worldX: number; worldZ: number; level?: number } | null | undefined, to: Tile, tiles: number): boolean {
    return !!p && ((p.level ?? 0) !== to.level || Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) > tiles);
}
export async function approach(s: Session, to: Tile, stop: () => boolean = () => false): Promise<Outcome> {
    const cancel = new AbortController(), off = s.onTick(() => { if (stop()) cancel.abort('stop requested'); });
    try {
        const world = await getWorld();
        return await ferryWalk(s, to, (tile, planBudgetMs) => goTo(s, world, tile, accountOf(s), { maxRetriesPerLeg: 2, legTimeoutTicks: 150, signal: cancel.signal, planBudgetMs }));
    } finally { off(); }
}

// A long planned walk can stop on one leg (live: Varrock West to the Ardougne north bank failed twice after about 114
// ticks, then a third run arrived). Each try starts where the last stopped; it stops when a try ends no closer.
export async function walkTargetPersist(s: Session, to: Tile, tries = 4,
    walk: (to: Tile) => Promise<{ ok: boolean; reason?: string; detail?: string }> = t => walkTarget(s, t, false)) {
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

// The known mainland and Karamja approach to Ardougne uses two ferry edges, and so does the way back east.
const PORT_SARIM_FERRY = 'npc:captain_tobias:karamja-musa-point@3028,3216';
const ARDOUGNE_FERRY = 'npc:customs_officer:ardougne@2772,3225';
const BRIMHAVEN_FERRY = 'npc:captain_barnaby:brimhaven@2679,3275';
const MUSA_POINT_FERRY = 'npc:customs_officer:port-sarim@2953,3147';
const AL_KHARID_TOLL = 'npc:borderguard2:lumbridge-side-west-of-the-toll-gate@3268,3226';
const LUMBRIDGE: Tile = { x: 3222, z: 3218, level: 0 }, DRAYNOR: Tile = { x: 3092, z: 3243, level: 0 };
const FERRY_LEG_PLAN_MS = 15_000;
// Falador, Port Sarim, Draynor, Lumbridge and Varrock (z up to 3510), and East Ardougne with its north bank and cow
// field.
const inEast = (t: Tile) => t.level === 0 && t.x >= 2930 && t.x <= 3280 && t.z >= 3150 && t.z <= 3510;
const inArdougne = (t: Tile) => t.level === 0 && t.x >= 2550 && t.x <= 2700 && t.z >= 3240 && t.z <= 3400;
// The rest of Kandarin west of White Wolf Mountain: Catherby, Seers' Village, the Ranging Guild, Yanille and the Gnome
// battlefield. A trip east from there starts with a walk to the Ardougne north bank: the fare bank and the first dock
// are known from Ardougne, and with no fare in the pack the planner finds no route east from those places (live: kit
// buys that started at the Catherby bank and on the battlefield ended "no route to 3185,3436,0").
const ARDOUGNE_NORTH: Tile = { x: 2619, z: 3332, level: 0 };
const inKandarin = (t: Tile) => t.level === 0 && t.x >= 2440 && t.x < 2870 && t.z >= 3040 && t.z <= 3530;
// Zanaris (map square 50,149, under the Lumbridge swamp), where Lost City ends. Its exit by the entrance is a known
// transport to the swamp shed, but the planner finds no route from inside to anywhere farther (practice: "no route to
// 2619,3332,0" after 304 idle ticks, and the shed reached in 5). A trip out starts with that step.
export const ZANARIS_SHED: Tile = { x: 3201, z: 3169, level: 0 };
export const inZanaris = (t: Tile) => t.level === 0 && t.x >= 3200 && t.x < 3264 && t.z >= 9536 && t.z < 9600;

export async function walkWithFerryFallback(from: Tile, to: Tile, walk: (to: Tile, budgetMs?: number) => Promise<Outcome>,
    sail: (boat: Travel) => Promise<Outcome>, coins: () => number, stageFare?: (need: number) => Promise<Outcome>): Promise<Outcome> {
    // Between the Varrock side and Ardougne the way is two ferries: westbound Port Sarim -> Musa Point, then Brimhaven
    // -> Ardougne; eastbound Ardougne -> Brimhaven, then Musa Point -> Port Sarim. The walk across Karamja between the
    // docks is the same ground both ways.
    let ticks = 0;
    if (inZanaris(from) && !inZanaris(to) && !(to.x === ZANARIS_SHED.x && to.z === ZANARIS_SHED.z)) {
        const out = await walk(ZANARIS_SHED, FERRY_LEG_PLAN_MS); ticks += out.ticks;
        if (!out.ok) return { ...out, ticks };
        from = ZANARIS_SHED;
    }
    // A floor above East Ardougne starts the same way, so the fare is staged at that bank. With no fare the planner
    // gives no route east from such a floor, or one along level 1 that cannot be walked (live: from level 1 of a house
    // at 2575,3269, "far walk to 2834,3334,1: no progress: walk rejected 3 times").
    const upstairs = from.level > 0 && inArdougne({ ...from, level: 0 });
    if ((upstairs || !inArdougne(from) && inKandarin(from)) && inEast(to)) {
        const home = await walk(ARDOUGNE_NORTH, FERRY_LEG_PLAN_MS); ticks += home.ticks;
        if (!home.ok) return { ...home, ticks };
        from = ARDOUGNE_NORTH;
    }
    const west = inEast(from) && to.level === 0 && to.x >= 2600 && to.x <= 2690 && to.z >= 3260 && to.z <= 3360;
    const east = !west && inArdougne(from) && inEast(to);
    const travel = west || east ? loadTravel() : [], first = travel.find(t => t.id === (west ? PORT_SARIM_FERRY : BRIMHAVEN_FERRY)), second = travel.find(t => t.id === (west ? ARDOUGNE_FERRY : MUSA_POINT_FERRY));
    const toll = west && from.x >= 3250 && from.z <= 3230 ? travel.find(t => t.id === AL_KHARID_TOLL) : undefined;
    const need = first?.from && second?.from ? first.coins + second.coins + (toll?.coins ?? 0) : 0;
    // The planner routes over the ferries itself when the pack holds the fare. Without it, it finds no route, or one
    // that cannot be walked (practice: from the Ardougne north bank with no coins it sent the account up the castle
    // stairs and the walk was rejected). An account that banks its coins has no fare, so `stageFare` fetches it before
    // the first plan (walkTarget takes it from the nearest bank).
    if (need && coins() < need && stageFare) {
        const staged = await stageFare(need); ticks += staged.ticks;
        if (!staged.ok) return { ...staged, ticks };
    }
    const direct = await walk(to);
    if (direct.ok || direct.reason !== 'precondition' || !direct.detail.startsWith('no route to ') || !need || !first?.from || !second?.from)
        return ticks ? { ...direct, ticks: ticks + direct.ticks } : direct;
    ticks += direct.ticks;
    let fare = first.coins + second.coins;
    const missingFare = (wanted: number): Outcome => ({ ok: false, reason: 'precondition', detail: `${west ? 'westbound' : 'eastbound'} ferry needs ${wanted} coins in the pack`, ticks });
    if (coins() < need) return missingFare(need);
    // A start west of Draynor walks straight to the Port Sarim dock.
    const through = !west || from.x < 3060 ? [] : from.x >= 3200 ? [LUMBRIDGE, DRAYNOR] : Math.max(Math.abs(from.x - DRAYNOR.x), Math.abs(from.z - DRAYNOR.z)) <= 3 ? [] : [DRAYNOR];
    for (const tile of through) {
        const leg = await walk(tile, FERRY_LEG_PLAN_MS); ticks += leg.ticks;
        if (!leg.ok) return { ...leg, ticks };
    }
    for (const [boat, departure] of [[first, first.from], [second, second.from]] as const) {
        const approach = await walk(departure, FERRY_LEG_PLAN_MS); ticks += approach.ticks;
        if (!approach.ok) return { ...approach, ticks };
        if (coins() < fare) return missingFare(fare);
        const crossed = await sail(boat); ticks += crossed.ticks;
        if (!crossed.ok) return { ...crossed, ticks };
        fare -= boat.coins;
    }
    const final = await walk(to, FERRY_LEG_PLAN_MS);
    return { ...final, ticks: ticks + final.ticks };
}

// Explicit boats use the same eligibility and executor as a planned trip. They never search for a route.
export function stagedBoat(boat: Travel | undefined, from: Tile, to: Tile, account: Account) {
    if (!boat?.from || boat.kind !== 'boat' || boat.run.how !== 'npc') throw Error('known NPC boat required');
    if (from.level !== boat.from.level || Math.max(Math.abs(from.x - boat.from.x), Math.abs(from.z - boat.from.z)) > 8) throw Error('boat departure not reached');
    if (to.x !== boat.to.x || to.z !== boat.to.z || to.level !== boat.to.level) throw Error('boat arrival differs from target');
    if (!travelAllowed(boat, account)) throw Error('boat unavailable for this account');
    return { kind: 'travel' as const, travel: boat, at: boat.from, to: boat.to };
}

if (import.meta.main) {
    const args = process.argv.slice(2), { account, to } = parseTarget(args);
    const ground = args[4] === '--ground';
    const boatId = args[4]?.startsWith('--boat=') ? args[4].slice(7) : undefined;
    if (args.length > 5 || args[4] && !ground && !boatId) throw Error('unknown walk option');
    const boat = boatId ? loadTravel().find(t => t.id === boatId) : undefined;
    if (boatId && !boat) throw Error('unknown boat');
    const s = await openBot(account);
    const here = () => { const p = s.sdk.getState()?.player; return p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown'; };
    const t0 = s.tick();
    console.log(`WALK_START from=${here()} to=${to.x},${to.z},${to.level} mode=${ground ? 'ground' : boat ? 'boat' : 'planned'}`);
    try {
        const p = s.sdk.getState()!.player!;
        const r = boat ? await walkRoute(s, [stagedBoat(boat, { x: p.worldX, z: p.worldZ, level: p.level }, to, accountOf(s))], { maxRetriesPerLeg: 1, legTimeoutTicks: 150 })
            : await walkTarget(s, to, ground);
        await finish([s], r.ok, `walk-to ${JSON.stringify(r)} at=${here()} ticks=${s.tick() - t0}`);
    } catch (error) { await finish([s], false, String(error)); }
}
