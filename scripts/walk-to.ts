// Walk one account to a tile with the shared walker (packages/core/src/walk.ts goTo): the route search, travel,
// danger avoidance and bank stops it plans for this account. Prints WALK_PLAN when the plan starts walking and
// RESULT with the ticks used and the final tile, then logs out.
// Usage: bun scripts/walk-to.ts <account> <x> <z> [level] [--ground|--boat=<travel-id>]
// --ground uses the local walker for an inspected same-plane corridor, without transport or bank planning.
import { openBot, finish, getWorld, accountOf } from '../packages/core/src/bot';
import { goTo, walkPath, sessionWalker, walkRoute } from '../packages/core/src/walk';
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
        const world = await getWorld(), p = s.sdk.getState()?.player;
        const walk = (tile: Tile, planBudgetMs?: number) => goTo(s, world, tile, accountOf(s), { legTimeoutTicks: 100, planBudgetMs });
        if (!p) return walk(to);
        const from = { x: p.worldX, z: p.worldZ, level: p.level };
        return walkWithFerryFallback(from, to, walk, boat => {
            const at = s.sdk.getState()?.player;
            if (!at) return Promise.resolve({ ok: false, reason: 'precondition', detail: 'ferry departure state unavailable', ticks: 0 });
            return walkRoute(s, [stagedBoat(boat, { x: at.worldX, z: at.worldZ, level: at.level }, boat.to, accountOf(s))],
                { maxRetriesPerLeg: 1, legTimeoutTicks: 150 });
        }, () => accountOf(s).coins ?? 0);
    },
    ground: async (s, to) => walkPath(await sessionWalker(s), [{ ...to, tol: 1 }], { maxTicks: 600 }),
}) {
    if (ground && s.sdk.getState()?.player?.level !== to.level) throw Error('ground walk requires a known start on the same plane');
    return ground ? operations.ground(s, to) : operations.planned(s, to);
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
// Lumbridge, Draynor and Varrock (z up to 3510), and East Ardougne with its north bank and cow field.
const inEast = (t: Tile) => t.level === 0 && t.x >= 3080 && t.x <= 3280 && t.z >= 3150 && t.z <= 3510;
const inArdougne = (t: Tile) => t.level === 0 && t.x >= 2550 && t.x <= 2700 && t.z >= 3240 && t.z <= 3400;

export async function walkWithFerryFallback(from: Tile, to: Tile, walk: (to: Tile, budgetMs?: number) => Promise<Outcome>,
    sail: (boat: Travel) => Promise<Outcome>, coins: () => number): Promise<Outcome> {
    const direct = await walk(to);
    if (direct.ok || direct.reason !== 'precondition' || !direct.detail.startsWith('no route to ')) return direct;
    // The planner has no land route between the Varrock side and Ardougne, in either direction (practice: "no route to
    // 2619,3332,0" from Varrock West; live: "no route to 3185,3436,0" from Ardougne). Westbound walks to Draynor and
    // sails Port Sarim -> Musa Point, then Brimhaven -> Ardougne. Eastbound sails Ardougne -> Brimhaven, then
    // Musa Point -> Port Sarim. The walk across Karamja between the two docks is the same ground both ways.
    const west = inEast(from) && to.level === 0 && to.x >= 2600 && to.x <= 2690 && to.z >= 3260 && to.z <= 3360;
    const east = !west && inArdougne(from) && inEast(to);
    if (!west && !east) return direct;

    const travel = loadTravel(), first = travel.find(t => t.id === (west ? PORT_SARIM_FERRY : BRIMHAVEN_FERRY)), second = travel.find(t => t.id === (west ? ARDOUGNE_FERRY : MUSA_POINT_FERRY));
    if (!first?.from || !second?.from) return direct;
    const toll = west && from.x >= 3250 && from.z <= 3230 ? travel.find(t => t.id === AL_KHARID_TOLL) : undefined;
    let ticks = direct.ticks, fare = first.coins + second.coins;
    const missingFare = (need: number): Outcome => ({ ok: false, reason: 'precondition', detail: `${west ? 'westbound' : 'eastbound'} ferry needs ${need} coins in the pack`, ticks });
    if (coins() < fare + (toll?.coins ?? 0)) return missingFare(fare + (toll?.coins ?? 0));
    const through = !west ? [] : from.x >= 3200 ? [LUMBRIDGE, DRAYNOR] : Math.max(Math.abs(from.x - DRAYNOR.x), Math.abs(from.z - DRAYNOR.z)) <= 3 ? [] : [DRAYNOR];
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
