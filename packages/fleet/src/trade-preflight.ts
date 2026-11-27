// Checks before the fleet agent starts a party of an order: would its login be admitted, and can it reach the meet?
// A party that fails one of them is not started, and through planTradePass its partner on this side waits with it.
// Each check reads files only. The causes are the first failed steps of the trade failures in .practice/fleet-agent.log:
// - "no worker progress: release peer state unknown" and the other release holds refused the login of one party;
//   the other party then stopped with "partner failed before login", or stood at the meet for "partner failed: no trade".
// - a login refused in the last PRELOGIN_RETRY_MS (prelogin-failed/<order>.<role>.json): the agent started both
//   parties again each pass, and the same refusal came back.
// - "precondition no route to <meet>": the account's own route search found no route from where it stands, and the
//   brain keeps that fact (packages/brain/src/no-route.ts) while the account stays there.
// - "precondition ferry needs 60 coins and the bank holds 0": the walk to the meet takes boats that the account cannot
//   pay for (packages/brain/src/ferry-fare.ts prices the same fallback as the worker walk).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPreloginFailure, type Order, type TradeRole } from '../../core/src/fleet-trade-settlement';
import { liveRoot, statusReadDirs } from '../../core/src/practice-paths';
import { assertLiveWorkerRelease } from '../../core/src/worker-release';
import type { Tile } from '../../core/src/world';
import { ferryFallbackFare } from '../../brain/src/ferry-fare';
import { isNoRouteFact, noRouteTo, type NoRouteFact } from '../../brain/src/no-route';
import { meetingTiles } from '../../workers/src/logistics/location';

// A refused login is not tried again for this long; the agent passes run each minute while an order is due.
export const PRELOGIN_RETRY_MS = 5 * 60_000;
const COINS_ID = 995;
const DEFAULT_BANK = { x: 3185, z: 3436 };

// The tile the party walks to (workers/src/logistics/trade.ts runFleetTrade).
export function meetTile(order: Pick<Order, 'meet'>, role: TradeRole): Tile | null {
    const meet = order.meet ?? meetingTiles(DEFAULT_BANK);
    return meet ? (role === 'from' ? meet[0] : meet[1]) ?? null : null;
}

type StatusRow = { pos?: Tile | null; inventory?: readonly { id?: number; count?: number }[]; bank?: readonly { id?: number; count?: number }[] | null; bankAt?: number };
const coinsIn = (rows: readonly { id?: number; count?: number }[] | null | undefined) =>
    (rows ?? []).reduce((n, r) => n + (r?.id === COINS_ID && Number.isFinite(r.count) ? r.count! : 0), 0);
const isTile = (t: unknown): t is Tile => !!t && Number.isInteger((t as Tile).x) && Number.isInteger((t as Tile).z) && Number.isInteger((t as Tile).level);
const tileText = (t: Tile) => `${t.x},${t.z},${t.level}`;

// The route and fare check for a party that stands at `pos`. `coins` is undefined when the bank was never observed:
// then only a pack that holds the fare passes the fare check as proof, and no fare refusal is given.
export function routeRefusal(pos: Tile | null, tile: Tile, facts: readonly NoRouteFact[] | undefined, coins: { pack: number; bank?: number }, now: number, travel?: Parameters<typeof ferryFallbackFare>[2]): string | undefined {
    if (!pos) return undefined;
    const fact = noRouteTo(facts, pos, tile, now);
    if (fact) return `no route to the meet ${tileText(tile)}: its route search from ${tileText(fact.from)} found none to ${tileText(fact.to)}`;
    const fare = ferryFallbackFare(pos, tile, travel, t => !noRouteTo(facts, pos, t, now));
    if (fare <= 0 || coins.bank === undefined) return undefined;
    const owned = coins.pack + coins.bank;
    return owned < fare ? `the walk to the meet ${tileText(tile)} takes boats that need ${fare} coins, and the account owns ${owned}` : undefined;
}

export type PreflightInput = {
    base: string;
    // The fleet directory (FLEET_DIR) that holds prelogin-failed.
    dir: string;
    now: number;
    // The trade worker's environment (tradeEnvironment): the release check runs as the login runs it.
    env: () => Record<string, string | undefined>;
    release?: (server: string) => void;
    status?: (account: string) => StatusRow | null;
    noRoutes?: (account: string) => readonly NoRouteFact[] | undefined;
};

// One preflight for one agent pass: the release check runs once for each server.
export function tradePreflight(o: PreflightInput): (account: string, order: Order, role: TradeRole) => string | undefined {
    const releaseHold = new Map<string, string | undefined>();
    const release = o.release ?? ((server: string) => assertLiveWorkerRelease(server, o.env(), o.base));
    const status = o.status ?? ((account: string) => readStatus(o.base, account));
    let facts: Readonly<Record<string, readonly NoRouteFact[]>> | undefined;
    const noRoutes = o.noRoutes ?? ((account: string) => (facts ??= readNoRoutes(o.base))[account.toLowerCase()]);
    const prelogin = join(o.dir, 'prelogin-failed');
    return (account, order, role) => {
        if (!releaseHold.has(order.server)) {
            let why: string | undefined;
            try { release(order.server); } catch (error) { why = (error instanceof Error ? error.message : String(error)).slice(0, 160); }
            releaseHold.set(order.server, why);
        }
        const held = releaseHold.get(order.server);
        if (held) return `login would fail: ${held}`;
        const failed = readPreloginFailure(prelogin, order, role);
        if (failed && o.now - failed.at < PRELOGIN_RETRY_MS) {
            return `login refused ${Math.max(0, Math.round((o.now - failed.at) / 1000))} s ago: ${failed.detail.replace(/^Error: /, '').slice(0, 120)}`;
        }
        const tile = meetTile(order, role);
        if (!tile) return undefined;
        const row = status(account);
        const pos = isTile(row?.pos) ? row!.pos! : null;
        const bank = Number.isFinite(row?.bankAt) && Array.isArray(row?.bank) ? coinsIn(row!.bank) : undefined;
        return routeRefusal(pos, tile, noRoutes(account), { pack: coinsIn(row?.inventory), ...(bank === undefined ? {} : { bank }) }, o.now);
    };
}

function readStatus(base: string, account: string): StatusRow | null {
    for (const dir of statusReadDirs(base)) {
        for (const name of new Set([`${account}.json`, `${account.toLowerCase()}.json`])) {
            const file = join(dir, name);
            if (!existsSync(file)) continue;
            try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
        }
    }
    return null;
}

// The brain's no-route facts (outcome-classifier.ts, outcome-state.json), by lower-case account.
function readNoRoutes(base: string): Readonly<Record<string, readonly NoRouteFact[]>> {
    try {
        const raw = JSON.parse(readFileSync(join(liveRoot(base), 'outcome-state.json'), 'utf8'))?.noRoutes;
        if (!raw || typeof raw !== 'object') return {};
        const out: Record<string, NoRouteFact[]> = {};
        for (const [account, list] of Object.entries(raw)) {
            if (Array.isArray(list)) out[account.toLowerCase()] = list.filter(isNoRouteFact);
        }
        return out;
    } catch { return {}; }
}
