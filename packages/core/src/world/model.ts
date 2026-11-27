import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { InteractionTarget, TransportMeta } from '../../../knowledge/src/transports';
import type { Account, Door, DoorBlock, Tile } from '../world-types';
import type { Travel } from '../travel';

export type { Account, Door, DoorBlock, Tile } from '../world-types';

export type Leg =
    | { kind: 'walk'; to: Tile; tolerance?: number }
    | ({ kind: 'transport'; loc: string; option: string; at: Tile; to: Tile; exact: boolean } & TransportMeta)
    | { kind: 'travel'; travel: Travel; at: Tile | null; to: Tile };

export const routeFares = (legs: readonly Leg[]) => legs.reduce((n, l) => n + (l.kind === 'travel' ? l.travel.coins : 0), 0);

export interface Transport extends TransportMeta {
    locName: string;
    option: string;
    from: Tile;
    to: Tile;
    exact: boolean;
    src: string;
    toSrc: string;
    handler: string;
}

// Walk cost on one level, or null when the path cannot end within `tol` tiles of `to`. `blocked` are door
// tiles to keep shut. Stair and ladder tiles are objects, not floor, so they are reached from next to them.
// A search stops at its deadline (performance.now() ms) with reason 'budget': a cold search for a crossing the account
// cannot make, or a far shore, otherwise measures paths for hundreds of ticks while the bot stands still (938 ticks for
// Al Kharid to Tai Bwo Wannai on practice). The caller then tries its next source or fails fast.
export type RouteOptions = { deadline?: number };
export const ROUTE_BUDGET_MS = 45_000;

export type ScopeAreas = { area(level: number, x: number, z: number): number; reach(to: Tile, tol: number, q: InteractionTarget): number[] | null; step(t: Tile): number[] | null };
export type PathLength = ((from: Tile, to: Tile, blocked: DoorBlock[], tol: number, interaction?: InteractionTarget) => number | null) & {
    withPolicy?<T>(blocked: DoorBlock[], query: () => T): T;
    withDanger?<T>(acct: Account, from: Tile, to: Tile, query: () => T): T;
    walkable?(t: Tile): boolean;
    areaOf?(t: Tile): number;
    // The area labels of the active scope (shut doors and closed danger ground), built when missing. `area`: >= 0 an
    // area, -1 not walkable, -2 outside the loaded map. `reach`: the areas of the tiles that reach loc `q` at `to`, null
    // when one is outside the map. Called inside withPolicy and withDanger.
    scopeAreas?(blocked: DoorBlock[]): ScopeAreas;
    measurePrechecked?(from: Tile, to: Tile, blocked: DoorBlock[], tol: number, interaction?: InteractionTarget): number | null;
};

export interface World {
    navigationGraph?(): { transports: readonly Transport[]; travel: readonly Travel[] };
    route(from: Tile, to: Tile, acct: Account, opts?: RouteOptions): { ok: true; legs: Leg[]; cost: number } | { ok: false; reason: 'no_route' | 'budget' };
    // Set on the shared world (bot.ts getWorld): goTo plans in route-worker.ts so a long search never blocks the client.
    offThread?: boolean;
    // Door tiles this account cannot pass (doorBlocks), for the walker to block in the SDK pathfinder too.
    blockedDoors(acct: Account): DoorBlock[];
    // Whether account `b` may take a travel or pass a key door that account `a` may not. Routes read items and coins
    // only there (travelAllowed, doorBlocks), so with equal coins and no gain the two accounts have the same routes.
    routeGain?(a: Account, b: Account): boolean;
}

// Ordinary navigation may stop beside its goal; entry qualification requests the exact tile.
export type WorldOptions = {
    transports?: Transport[];
    doors?: Door[];
    travel?: Travel[];
    pathLength: PathLength;
    goalTolerance?: 0 | 1;
};

export const PORTAL_TOL = 2; // stairs can be 2x2 or larger
export const GOAL_TOL = 1;
export const TRANSPORT_COST = 3; // ticks to climb or descend, roughly
export const MAX_LEG = 300; // walk legs longer than this (Chebyshev) are not tried
export const worldRepoRoot = resolve(import.meta.dir, '..', '..', '..', '..');

export const tileKey = (t: Tile) => `${t.x},${t.z},${t.level}`;
export const cheb = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
export const entryOf = (t: Transport) => t.entry ?? t.from;

/** Reads a JSON asset from the knowledge directory. */
export function loadKnowledgeJson<T>(name: string): T {
    return JSON.parse(readFileSync(join(worldRepoRoot, 'knowledge', name), 'utf8'));
}
