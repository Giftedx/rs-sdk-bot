// Route planning and single-plane pathfinding off the game thread. A cold route search can take a minute; run on the
// bot's own thread it stops the client from reading packets, and its next walk click fails with "RangeError: Out of
// bounds access". This worker owns a separate pathfinder (its own rsmod wasm instance) and answers trip plans plus
// lightweight walk/SDK/harm/approach queries by message, so live bot processes never initialize rsmod WASM locally.
// Pattern follows rs2b0t src/bot/event/webwalk/NavWorker.ts (commit ae56ccc9, MIT License, Copyright (c) 2026 N64Jive).
import { join, resolve } from 'node:path';
import type { InteractionTarget } from '../../knowledge/src/transports';
import type { DoorInfo } from '../../../vendor/rs-sdk/sdk/pathfinding';
import type { SharedLabels } from './components';
import {
    dangerSummary, guardWalk, npcReach, planAroundHarm, routeExposure, setDangerDoorAt, walkExposure, walkVerdict,
    withDanger, type NpcReach, type RouteLegLike, type WalkExposure, type WalkProfile,
} from './danger';
import { withDoorPolicy } from './door-policy';
import { loadPathfinding } from './pathcache';
import { planTrip, type BankStock } from './trip';
import {
    createWorld, doorBlock, doorBlocks, getKnownDoorFacts, rsPathLength, withNpcBlocks,
    type Account, type DoorBlock, type Tile, type World,
} from './world';

const worldRepoRoot = resolve(import.meta.dir, '..', '..', '..');

export type PlanRequest = {
    id: number;
    kind?: 'plan';
    from: Tile;
    to: Tile;
    acct: Account;
    stock?: BankStock;
    budgetMs?: number;
    sharedAreas?: SharedLabels;
};

export type SdkFindPathResult = {
    success: boolean;
    waypoints: Array<{ x: number; z: number; level: number }>;
    reachedDestination?: boolean;
    error?: string;
};

export type SdkFindPathQuery = {
    kind: 'sdk-find-path';
    from: Tile;
    to: { x: number; z: number };
    maxWaypoints?: number;
    tempDoors?: DoorInfo[];
    policy?: {
        acct: Account;
        profile: WalkProfile;
        blocks: DoorBlock[];
        npcTiles: Tile[];
    };
};

export type WalkPlanQuery = {
    kind: 'walk-plan';
    level: number;
    from: { x: number; z: number };
    to: { x: number; z: number };
    avoid?: { x: number; z: number }[];
    blocks: DoorBlock[];
    tempDoors?: DoorInfo[];
    acct: Account;
    profile: WalkProfile;
};

export type WalkDangerQuery = {
    kind: 'walk-danger';
    level: number;
    tiles: { x: number; z: number }[];
    profile: WalkProfile;
};

export type WalkDangerResult = {
    verdict: 'clear' | 'eat' | 'refuse';
    start: boolean;
    summary: ReturnType<typeof dangerSummary>;
};

export type RouteExposureQuery = {
    kind: 'route-exposure';
    from: Tile;
    legs: RouteLegLike[];
    profile: WalkProfile;
};

export type ApproachQuery = {
    kind: 'approach';
    from: Tile;
    at: Tile;
    q: InteractionTarget;
    acct: Account;
};

export type RouteQuery = SdkFindPathQuery | WalkPlanQuery | WalkDangerQuery | RouteExposureQuery | ApproachQuery;
export type RouteWorkerRequest = PlanRequest | (RouteQuery & { id: number });

declare const self: { onmessage: ((e: MessageEvent<RouteWorkerRequest>) => void) | null; postMessage(m: unknown): void };

type PfEnv = { pf: any; grid: any; reach: NpcReach };
let pfReady: Promise<PfEnv> | null = null;
let world: Promise<World> | null = null;

function ensurePf(): Promise<PfEnv> {
    pfReady ??= (async () => {
        await loadPathfinding();
        const [pf, grid] = await Promise.all([
            import(join(worldRepoRoot, 'vendor', 'rs-sdk', 'sdk', 'pathfinding.ts')) as Promise<any>,
            import(join(worldRepoRoot, 'vendor', 'rs-sdk', 'server', 'vendor', 'rsmod-pathfinder')) as Promise<any>,
        ]);
        pf.initPathfinding();
        setDangerDoorAt(pf.getDoorAt);
        return { pf, grid, reach: npcReach(grid, pf.getDoorAt) };
    })().catch(error => { pfReady = null; throw error; });
    return pfReady;
}

const resolveDoorBlocks = (pf: any, blocks: readonly DoorBlock[]): DoorBlock[] =>
    blocks.map(b => (b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b));

function runQuery(env: PfEnv, req: RouteQuery): unknown {
    const { pf, grid, reach } = env;
    switch (req.kind) {
        case 'sdk-find-path': {
            const { from, to, maxWaypoints = 500, tempDoors = [], policy } = req;
            const level = from.level;
            const raw = (): SdkFindPathResult => {
                if (!pf.isZoneAllocated(level, from.x, from.z)) {
                    return { success: false, waypoints: [], error: 'Source zone not allocated (no collision data for current position)' };
                }
                const destZoneAllocated = pf.isZoneAllocated(level, to.x, to.z);
                const waypoints = pf.findLongPath(level, from.x, from.z, to.x, to.z, maxWaypoints, tempDoors);
                if (waypoints.length === 0 && !destZoneAllocated) {
                    return { success: true, waypoints: [], reachedDestination: false, error: 'Destination zone not allocated - try walking toward it' };
                }
                const lastWaypoint = waypoints[waypoints.length - 1];
                const reachedDestination = lastWaypoint !== undefined && lastWaypoint.x === to.x && lastWaypoint.z === to.z;
                if (!reachedDestination && waypoints.length > 0) {
                    const remainDist = Math.abs(lastWaypoint!.x - to.x) + Math.abs(lastWaypoint!.z - to.z);
                    if (remainDist > 100) {
                        return {
                            success: false,
                            waypoints: [],
                            error: `Destination (${to.x}, ${to.z}) is unreachable — path ends ${remainDist} tiles away at (${lastWaypoint!.x}, ${lastWaypoint!.z}). The target may be underground or on a different plane that requires a ladder/stairs to access.`,
                        };
                    }
                }
                // Fill error on empty path so BotActions.walkTo does not invoke local isTileWalkable().
                const error = !waypoints.length ? (pf.isTileWalkable(level, to.x, to.z) ? 'no waypoints' : 'destination tile is blocked') : undefined;
                return { success: true, waypoints, reachedDestination, ...(error ? { error } : {}) };
            };
            if (!policy) return raw();
            const blocks = resolveDoorBlocks(pf, policy.blocks);
            const find = () => guardWalk(grid, policy.acct, from, { x: to.x, z: to.z, level }, 32,
                () => withDoorPolicy(grid, blocks, () => withNpcBlocks(grid, policy.npcTiles, raw)));
            return planAroundHarm(grid, policy.profile, level, from, to, 32, find, { reach });
        }
        case 'walk-plan': {
            const blocks = resolveDoorBlocks(pf, req.blocks);
            const find = () => withDoorPolicy(grid, blocks, () => pf.findLongPath(req.level, req.from.x, req.from.z, req.to.x, req.to.z, 500, req.tempDoors ?? []));
            const guarded = () => guardWalk(grid, req.acct, { ...req.from, level: req.level }, { ...req.to, level: req.level }, 32,
                () => req.avoid?.length ? withDanger(grid, req.avoid.map(t => ({ ...t, level: req.level })), [{ ...req.from, level: req.level }, { ...req.to, level: req.level }], find, 'live') : find());
            return planAroundHarm(grid, req.profile, req.level, req.from, req.to, 32, guarded, { reach });
        }
        case 'walk-danger': {
            const exposure = walkExposure(req.profile, req.level, req.tiles, { reach }), verdict = walkVerdict(req.profile, exposure);
            const out: WalkDangerResult = {
                verdict: verdict.verdict,
                start: walkExposure(req.profile, req.level, req.tiles.slice(0, 1), { reach }).tiles > 0,
                summary: dangerSummary(exposure, verdict),
            };
            return out;
        }
        case 'route-exposure': {
            const path = (level: number, a: { x: number; z: number }, b: { x: number; z: number }) =>
                planAroundHarm(grid, req.profile, level, a, b, 32, () => pf.findLongPath(level, a.x, a.z, b.x, b.z, 500), { reach });
            const exposure: WalkExposure = routeExposure(req.profile, req.from, req.legs, path, { reach });
            return exposure;
        }
        case 'approach': {
            const facts = getKnownDoorFacts();
            const blocked = resolveDoorBlocks(pf, facts.filter(d => doorBlocks(d, req.acct)).map(doorBlock));
            return withDoorPolicy(grid, blocked, () => {
                const reached = (t: Tile) => grid.reached(t.level, t.x, t.z, req.at.x, req.at.z, req.q.width, req.q.height, 1, req.q.angle, req.q.shape, req.q.blockAccessFlags);
                if (reached(req.from)) return req.from;
                const path = grid.findLongPath(req.from.level, req.from.x, req.from.z, req.at.x, req.at.z, 1, req.q.width, req.q.height, req.q.angle, req.q.shape, false, req.q.blockAccessFlags, 500, grid.CollisionType.NORMAL);
                if (!path.length) return null;
                const packed = path[path.length - 1]!, end = { x: (packed >>> 14) & 0x3fff, z: packed & 0x3fff, level: (packed >>> 28) & 3 };
                return reached(end) ? end : null;
            });
        }
    }
}

const isRouteQuery = (r: RouteWorkerRequest): r is RouteQuery & { id: number } => Boolean(r.kind && r.kind !== 'plan');
const QUERY_GC_INTERVAL = 32;
let queryCount = 0;

self.onmessage = async e => {
    const req = e.data;
    const { id } = req;
    if (isRouteQuery(req)) {
        try {
            const env = await ensurePf();
            const result = runQuery(env, req);
            self.postMessage({ id, result });
            if (++queryCount % QUERY_GC_INTERVAL === 0) {
                (globalThis as { Bun?: { gc?: (sync?: boolean) => void } }).Bun?.gc?.(false);
            }
        } catch (error) {
            self.postMessage({ id, error: String((error as Error)?.stack ?? error) });
        }
        return;
    }
    const { from, to, acct, stock, budgetMs, sharedAreas } = req as PlanRequest;
    const started = performance.now();
    const trace = (phase: string) => { if (process.env.BENCH_TRACE || process.env.ROUTE_TRACE === '1') console.log('ROUTE_PHASE ' + JSON.stringify({ id, phase, at: Date.now(), elapsedMs: Math.round(performance.now() - started), from, to })); };
    try {
        trace('world-start');
        if (sharedAreas) {
            const { attachSharedLabels } = await import('./components');
            attachSharedLabels(sharedAreas);
        }
        world ??= (async () => { await loadPathfinding(); trace('pathfinding-ready'); const pathLength = await rsPathLength(); trace('path-length-ready'); return createWorld({ pathLength }); })().catch(error => { world = null; throw error; });
        const w = await world, deadline = budgetMs === undefined ? undefined : performance.now() + budgetMs;
        trace('world-ready');
        const plan = planTrip(w, from, to, acct, stock, undefined, undefined, { deadline });
        trace('search-ready');
        (globalThis as { Bun?: { gc?: (sync?: boolean) => void } }).Bun?.gc?.(true);
        self.postMessage({ id, plan });
    } catch (error) {
        self.postMessage({ id, error: String((error as Error)?.stack ?? error) });
    }
};
