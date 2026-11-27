// The "no route" that a worker's route search found for one account. The live planner has no route world
// (fleet/src/brain-runtime.ts), so its region rules (preflight.ts) pass targets that the danger rule or a shut door
// closes for this account: MeatNTwoVeg (combat 30, 0 coins) at 2793,3516 got one Ardougne job after another and each
// failed with "precondition no route to" an Ardougne tile. The worker's own search is the evidence. While the account
// stands where that search started, the planner refuses the same activity and each target near the tile that the
// search could not reach.
import { createHash } from 'node:crypto';
import { isWorkerTile, type WorkerAccountView, type WorkerTile } from '../../workers/src/contracts';

// A worker's route search for this account found no route from `from` to `to`. It holds while the account stands at
// `from`, while its state is `state`, and until `expiresAt` (AccountState.noRoutes).
export interface NoRouteFact {
    readonly from: WorkerTile;
    readonly to: WorkerTile;
    readonly activityId: string;
    readonly observedAt: number;
    readonly expiresAt: number;
    // noRouteState of the account that the search ran for. The outcome classifier sets it on the first snapshot
    // after the run, while the account is still logged out where the run ended.
    readonly state?: string;
}

// A fact ends when the account moves or its state changes. A walker change can still open the route, so a fact also
// ends 3 days after its search.
export const NO_ROUTE_TTL_MS = 72 * 3_600_000;
// The account stands where the search started while it is this many tiles or fewer from `from`, on the same floor.
export const NO_ROUTE_FROM_TILES = 8;
// A target this near the tile with no route, and nearer to it than to the account, is in the same place. Ardougne
// market (2654,3283) and the Ardougne knights (2662,3305) are 49 and 43 tiles from the Ardougne north bank (2619,3332).
export const NO_ROUTE_TARGET_TILES = 64;
export const NO_ROUTE_FACTS_PER_ACCOUNT = 16;

// The walker's failure text (core/src/walk/goto.ts). A search that used all of its budget without the bank stop
// prints "no route (search over N ms) to", which this pattern does not match.
const NO_ROUTE_RE = /\bno route to (-?\d+),(-?\d+),(\d+)\b/;
// Where the failed search started, as the workers print it before the "no route" text.
const FROM_RES: readonly RegExp[] = [
    /\bfrom (-?\d+),(-?\d+)(?:,(\d+))?\b/g, // travel to Ardougne from 2793,3516,0 failed
    /\bat \{"x":(-?\d+),"z":(-?\d+),"level":(\d+)\}/g, // quest-sweep <quest> bank walk failed at {...}
    /\bposition=(-?\d+),(-?\d+),(\d+)\b/g, // market bank travel failed: position=...
];

const cheb = (a: WorkerTile, b: WorkerTile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const tileText = (t: WorkerTile) => `${t.x},${t.z},${t.level}`;

function lastStart(head: string, levelIfAbsent: number): WorkerTile | null {
    let best: { index: number; tile: WorkerTile } | null = null;
    for (const re of FROM_RES) {
        for (const m of head.matchAll(re)) {
            const tile = { x: Number(m[1]), z: Number(m[2]), level: m[3] === undefined ? levelIfAbsent : Number(m[3]) };
            if (isWorkerTile(tile) && (!best || m.index! > best.index)) best = { index: m.index!, tile };
        }
    }
    return best?.tile ?? null;
}

// The start and target of the first "no route" in a worker's failure text. The start is the one that the text names
// before it, else `pos` (where the run ended). Null when the text has no "no route" or no start is known.
export function parseNoRoute(text: string, pos?: WorkerTile | null): { from: WorkerTile; to: WorkerTile } | null {
    const m = NO_ROUTE_RE.exec(text);
    if (!m) return null;
    const to = { x: Number(m[1]), z: Number(m[2]), level: Number(m[3]) };
    if (!isWorkerTile(to)) return null;
    const from = lastStart(text.slice(0, m.index), pos?.level ?? 0) ?? (pos && isWorkerTile(pos) ? pos : null);
    return from ? { from: { x: from.x, z: from.z, level: from.level }, to } : null;
}

export function isNoRouteFact(v: unknown): v is NoRouteFact {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const f = v as Record<string, unknown>;
    return isWorkerTile(f.from) && isWorkerTile(f.to) && typeof f.activityId === 'string' && f.activityId.trim().length > 0
        && typeof f.observedAt === 'number' && Number.isFinite(f.observedAt) && f.observedAt > 0
        && typeof f.expiresAt === 'number' && Number.isFinite(f.expiresAt) && f.expiresAt > 0
        && (f.state === undefined || (typeof f.state === 'string' && f.state.length > 0));
}

// What a route search for the account reads beside its position: the danger rule reads its levels, quest doors read
// its quests, and travel reads the coins, items and runes it holds, wears and banks (core/src/travel.ts travelAllowed,
// core/src/trip.ts planTrip). A change to any of them can open a route that had none.
export function noRouteState(acct: WorkerAccountView): string {
    const counts = (m: Readonly<Record<number, number>>) =>
        Object.entries(m).filter(([, n]) => n > 0).sort(([a], [b]) => Number(a) - Number(b)).map(([id, n]) => `${id}:${n}`).join(',');
    const skills = Object.entries(acct.skills).sort(([a], [b]) => a.localeCompare(b)).map(([s, v]) => `${s}:${v.level}`).join(',');
    const quests = Object.entries(acct.quests).sort(([a], [b]) => a.localeCompare(b)).map(([q, v]) => `${q}:${v}`).join(',');
    const text = [skills, quests, counts(acct.inventory), counts(acct.equipment), counts(acct.bank.items)].join('|');
    return createHash('sha1').update(text).digest('hex');
}

export function standsAt(pos: WorkerTile | null, from: WorkerTile): boolean {
    return pos !== null && pos.level === from.level && cheb(pos, from) <= NO_ROUTE_FROM_TILES;
}

// The fact holds while it has not expired and the account stands where the search started.
export function noRouteHolds(f: NoRouteFact, pos: WorkerTile | null, now: number): boolean {
    return now < f.expiresAt && standsAt(pos, f.from);
}

// The fact that refuses `target` for an account at `pos`, if one does.
export function noRouteTo(facts: readonly NoRouteFact[] | undefined, pos: WorkerTile | null, target: WorkerTile, now: number): NoRouteFact | undefined {
    if (!facts?.length || !pos) return undefined;
    return facts.find(f => noRouteHolds(f, pos, now) && target.level === f.to.level
        && cheb(target, f.to) <= NO_ROUTE_TARGET_TILES && cheb(target, f.to) < cheb(target, pos));
}

// A fact that shows the account cannot leave where it stands, if one does: two holding facts whose targets lie on
// other floors or more than 2 * NO_ROUTE_TARGET_TILES apart. The obstacle is then at the start, not near a target,
// so noRouteTo passes every other target and each job there fails the same way (an account shut in the West
// Ardougne Mourner HQ at 2546,3325 had no route to Varrock, Karamja or the Ardougne market).
export function enclosedAt(facts: readonly NoRouteFact[] | undefined, pos: WorkerTile | null, now: number): NoRouteFact | undefined {
    if (!facts || facts.length < 2 || !pos) return undefined;
    const held = facts.filter(f => noRouteHolds(f, pos, now));
    for (let i = 0; i < held.length; i++) {
        for (let j = i + 1; j < held.length; j++) {
            const a = held[i]!.to;
            const b = held[j]!.to;
            if (a.level !== b.level || cheb(a, b) > 2 * NO_ROUTE_TARGET_TILES) return held[j];
        }
    }
    return undefined;
}

// The fact that refuses `activityId` for an account at `pos`, if one does.
export function noRouteForActivity(facts: readonly NoRouteFact[] | undefined, pos: WorkerTile | null, activityId: string, now: number): NoRouteFact | undefined {
    return facts?.find(f => f.activityId === activityId && noRouteHolds(f, pos, now));
}

export function noRouteMessage(account: string, f: NoRouteFact): string {
    return `${account} has no route from ${tileText(f.from)} to ${tileText(f.to)} (${f.activityId})`;
}

// The facts after a new one: it replaces a fact of the same activity and target, and the newest facts are kept.
export function addNoRoute(facts: readonly NoRouteFact[], fact: NoRouteFact): NoRouteFact[] {
    const same = (f: NoRouteFact) => f.activityId === fact.activityId && tileText(f.to) === tileText(fact.to);
    return [...facts.filter(f => !same(f)), fact].slice(-NO_ROUTE_FACTS_PER_ACCOUNT);
}
