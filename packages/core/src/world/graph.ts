import type { InteractionTarget } from '../../../knowledge/src/transports';
import { crossingTravel, loadCrossings, loadTravel, RIVER_LOG_TRAVEL, type Travel } from '../travel';
import { normalizeTransports } from './filters';
import { entryOf, GOAL_TOL, loadKnowledgeJson, PORTAL_TOL, tileKey, TRANSPORT_COST, type Door, type Leg, type Tile, type Transport, type WorldOptions } from './model';

export type LevelBuckets = {
    ids: Int32Array[];
    xs: Int32Array[];
    zs: Int32Array[];
};

/** Groups nodes by plane and sorts each plane by x then z for bounded range scans. */
export function bucketByLevel<T>(items: readonly T[], getTile: (item: T) => Tile, getId: (item: T, index: number) => number): LevelBuckets {
    const lists: { id: number; x: number; z: number }[][] = [[], [], [], []];
    for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const t = getTile(item);
        const lvl = t.level;
        if (lvl >= 0 && lvl < 4) lists[lvl]!.push({ id: getId(item, i), x: t.x, z: t.z });
    }
    const ids: Int32Array[] = [], xs: Int32Array[] = [], zs: Int32Array[] = [];
    for (let lvl = 0; lvl < 4; lvl++) {
        const list = lists[lvl]!;
        list.sort((a, b) => a.x - b.x || a.z - b.z);
        const iArr = new Int32Array(list.length), xArr = new Int32Array(list.length), zArr = new Int32Array(list.length);
        for (let k = 0; k < list.length; k++) {
            const e = list[k]!;
            iArr[k] = e.id; xArr[k] = e.x; zArr[k] = e.z;
        }
        ids.push(iArr); xs.push(xArr); zs.push(zArr);
    }
    return { ids, xs, zs };
}

export function lowerBoundX(xs: Int32Array, target: number): number {
    let lo = 0, hi = xs.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (xs[mid]! < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export function upperBoundX(xs: Int32Array, target: number): number {
    let lo = 0, hi = xs.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (xs[mid]! <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export const LOWER_BOUND_CACHE_LIMIT = 64;

export type LowerBoundGraph = {
    nodeCount: number;
    xs: Int32Array;
    zs: Int32Array;
    levels: Int8Array;
    radii: Float32Array;
    incomingOffsets: Int32Array;
    incomingNodes: Int32Array;
    levelNodes: Int32Array[];
    levelXs: Int32Array[];
    levelZs: Int32Array[];
    cachedRadius?: number;
    cachedByGoal?: Map<number, Float32Array>;
};

export function buildLowerBoundGraph(
    waypoints: readonly Tile[],
    waypointIndex: Map<string, number>,
    transports: readonly Transport[],
    fixedTravel: readonly Travel[] = [],
    backward = false,
): LowerBoundGraph {
    const n = waypoints.length;
    const xs = new Int32Array(n), zs = new Int32Array(n), levels = new Int8Array(n);
    const radii = new Float32Array(n).fill(PORTAL_TOL);
    const byLvl: number[][] = [[], [], [], []];
    for (let i = 0; i < n; i++) {
        const w = waypoints[i]!;
        xs[i] = w.x; zs[i] = w.z; levels[i] = w.level;
        if (w.level >= 0 && w.level < 4) byLvl[w.level]!.push(i);
    }
    const edgeCount = transports.length + fixedTravel.length;
    const edgeFrom = new Int32Array(edgeCount);
    const edgeTo = new Int32Array(edgeCount);
    const counts = new Int32Array(n);
    let e = 0;
    for (let i = 0; i < transports.length; i++) {
        const t = transports[i]!;
        const eIdx = waypointIndex.get(tileKey(entryOf(t)))!, tIdx = waypointIndex.get(tileKey(t.to))!;
        const from = backward ? tIdx : eIdx;
        const to = backward ? eIdx : tIdx;
        edgeFrom[e] = from;
        edgeTo[e] = to;
        counts[to] = counts[to]! + 1;
        e++;
        if (!backward) radii[from] = Math.max(radii[from]!, t.interaction?.width ?? 1, t.interaction?.height ?? 1);
    }
    for (let i = 0; i < fixedTravel.length; i++) {
        const t = fixedTravel[i]!;
        const fIdx = waypointIndex.get(tileKey(t.from!))!, tIdx = waypointIndex.get(tileKey(t.to))!;
        const from = backward ? tIdx : fIdx;
        const to = backward ? fIdx : tIdx;
        edgeFrom[e] = from;
        edgeTo[e] = to;
        counts[to] = counts[to]! + 1;
        e++;
    }
    const incomingOffsets = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) incomingOffsets[i + 1] = incomingOffsets[i]! + counts[i]!;
    const incomingNodes = new Int32Array(edgeCount);
    const cursor = incomingOffsets.slice(0, n);
    for (let i = 0; i < edgeCount; i++) {
        const to = edgeTo[i]!;
        incomingNodes[cursor[to]!] = edgeFrom[i]!;
        cursor[to] = cursor[to]! + 1;
    }
    const levelNodes = byLvl.map(l => new Int32Array(l));
    const levelXs = byLvl.map(l => {
        const arr = new Int32Array(l.length);
        for (let k = 0; k < l.length; k++) arr[k] = xs[l[k]!]!;
        return arr;
    });
    const levelZs = byLvl.map(l => {
        const arr = new Int32Array(l.length);
        for (let k = 0; k < l.length; k++) arr[k] = zs[l[k]!]!;
        return arr;
    });
    return {
        nodeCount: n,
        xs,
        zs,
        levels,
        radii,
        incomingOffsets,
        incomingNodes,
        levelNodes,
        levelXs,
        levelZs,
    };
}

// A direct-distance goal heuristic is not a lower bound when a transport can
// jump toward the goal. Settle a relaxed portal graph by accumulated cost
// (OlZe PathfinderDijkstra). Collision-free walk costs only underestimate the
// real walks, retaining lazy path measurements without pruning cheap detours.
export function solveLowerBounds(graph: LowerBoundGraph, goalBoundIdx: number, goalTile: Tile, relaxedRadius: number): Float32Array {
    const baseN = graph.nodeCount;
    if (goalBoundIdx < baseN) {
        if (graph.cachedRadius !== relaxedRadius) {
            graph.cachedRadius = relaxedRadius;
            graph.cachedByGoal = new Map();
        }
        const hit = graph.cachedByGoal!.get(goalBoundIdx);
        if (hit) return hit;
    }
    const totalN = goalBoundIdx < baseN ? baseN : baseN + 1;
    const best = new Float32Array(totalN).fill(Infinity);
    best[goalBoundIdx] = 0;
    const settled = new Uint8Array(totalN);
    const heapIdx = new Int32Array(totalN);
    const heapCost = new Float32Array(totalN);
    const heapPos = new Int32Array(totalN).fill(-1);
    let heapSize = 1;
    heapIdx[0] = goalBoundIdx;
    heapCost[0] = 0;
    heapPos[goalBoundIdx] = 0;

    const pushOrDecrease = (node: number, cost: number) => {
        let pos = heapPos[node]!;
        if (pos < 0) pos = heapSize++;
        while (pos > 0) {
            const parentPos = (pos - 1) >> 1;
            const parentCost = heapCost[parentPos]!;
            if (parentCost <= cost) break;
            const parentNode = heapIdx[parentPos]!;
            heapIdx[pos] = parentNode;
            heapCost[pos] = parentCost;
            heapPos[parentNode] = pos;
            pos = parentPos;
        }
        heapIdx[pos] = node;
        heapCost[pos] = cost;
        heapPos[node] = pos;
    };

    const { xs, zs, levels, radii, incomingOffsets, incomingNodes, levelNodes, levelXs, levelZs } = graph;
    while (heapSize > 0) {
        const u = heapIdx[0]!;
        const uCost = heapCost[0]!;
        heapPos[u] = -1;
        const n = --heapSize;
        if (n > 0) {
            const lastNode = heapIdx[n]!, lastCost = heapCost[n]!;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                if (l >= n) break;
                const r = l + 1;
                const c = r < n && heapCost[r]! < heapCost[l]! ? r : l;
                if (lastCost <= heapCost[c]!) break;
                const childNode = heapIdx[c]!;
                heapIdx[i] = childNode;
                heapCost[i] = heapCost[c]!;
                heapPos[childNode] = i;
                i = c;
            }
            heapIdx[i] = lastNode;
            heapCost[i] = lastCost;
            heapPos[lastNode] = i;
        }
        settled[u] = 1;
        const isGoal = u === goalBoundIdx;
        const tx = u < baseN ? xs[u]! : goalTile.x;
        const tz = u < baseN ? zs[u]! : goalTile.z;
        const tLvl = u < baseN ? levels[u]! : goalTile.level;
        const tolerance = isGoal ? GOAL_TOL : Math.max(relaxedRadius, u < baseN ? radii[u]! : PORTAL_TOL);
        if (tLvl >= 0 && tLvl < 4) {
            const peers = levelNodes[tLvl]!, pXs = levelXs[tLvl]!, pZs = levelZs[tLvl]!, len = peers.length;
            for (let k = 0; k < len; k++) {
                const i = peers[k]!;
                if (settled[i] || best[i]! <= uCost) continue;
                const dx = pXs[k]! - tx, dz = pZs[k]! - tz;
                const adx = dx < 0 ? -dx : dx, adz = dz < 0 ? -dz : dz;
                const d = (adx > adz ? adx : adz) - tolerance;
                const nc = uCost + (d > 0 ? d : 0);
                if (nc < best[i]!) { best[i] = nc; pushOrDecrease(i, nc); }
            }
            if (goalBoundIdx >= baseN && goalTile.level === tLvl && !settled[goalBoundIdx]) {
                const dx = goalTile.x - tx, dz = goalTile.z - tz;
                const adx = dx < 0 ? -dx : dx, adz = dz < 0 ? -dz : dz;
                const d = (adx > adz ? adx : adz) - tolerance;
                const nc = uCost + (d > 0 ? d : 0);
                if (nc < best[goalBoundIdx]!) { best[goalBoundIdx] = nc; pushOrDecrease(goalBoundIdx, nc); }
            }
        }
        if (u < baseN) {
            const start = incomingOffsets[u]!, end = incomingOffsets[u + 1]!;
            const nextCost = uCost + TRANSPORT_COST;
            for (let k = start; k < end; k++) {
                const idx = incomingNodes[k]!;
                if (nextCost < best[idx]!) { best[idx] = nextCost; pushOrDecrease(idx, nextCost); }
            }
        }
    }
    if (goalBoundIdx < baseN) {
        const cache = graph.cachedByGoal!;
        if (cache.size >= LOWER_BOUND_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
        cache.set(goalBoundIdx, best);
    }
    return best;
}

export type OutEdge = { t: Transport; index: number; toIdx: number; leg: Leg };
export type InEdge = { t: Transport; index: number; fromIdx: number; leg: Leg; entryTile: Tile; fromTile: Tile };
export type FwdTravel = { t: Travel; toIdx: number };
export type BwdTravel = { t: Travel; fromIdx: number };
export type ApproachTransport = {
    t: Transport;
    index: number;
    fromIdx: number;
    toIdx: number;
    tol: number;
    q: InteractionTarget;
    leg: Leg;
    endAreas?: number[] | null;
};

export type RouteAreaScope = {
    startAreasOf(idx: number): number[] | null;
    endAreasOf(idx: number, tol: number, q?: InteractionTarget, app?: ApproachTransport): number[] | null;
};

/** Returns whether two cached area label lists share no connected region. */
export function areasDisjoint(a: number[] | null, b: number[] | null): boolean {
    if (!a || !b || a.length === 0 || b.length === 0) return false;
    if (a.length === 1 && b.length === 1) return a[0] !== b[0];
    for (let i = 0; i < a.length; i++) if (b.includes(a[i]!)) return false;
    return true;
}

export interface WorldGraph {
    transports: Transport[];
    doors: Door[];
    travel: Travel[];
    anywhere: Travel[];
    waypoints: Tile[];
    waypointIndex: Map<string, number>;
    legByTransport: Leg[];
    outgoingByIdx: OutEdge[][];
    incomingByIdx: InEdge[][];
    transportFromIdx: Int32Array;
    transportToIdx: Int32Array;
    strictMask: Uint8Array;
    travelFromByIdx: FwdTravel[][];
    travelToByIdx: BwdTravel[][];
    anywhereIndexed: FwdTravel[];
    levelNodes: LevelBuckets;
    walkableMask: Uint8Array;
    walkableLevelNodes: LevelBuckets;
    approachesByLevel: ApproachTransport[][];
    approachByIndex: (ApproachTransport | undefined)[];
    approachLevelXs: Int32Array[];
    radius: number;
    forwardLBGraph: LowerBoundGraph;
    backwardLBGraph: LowerBoundGraph;
    hasAreaOf: boolean;
    routeAreas(dynTiles: readonly Tile[]): RouteAreaScope;
}

function createAreaScopeFactory(
    areaOf: ((t: Tile) => number) | undefined,
    waypoints: readonly Tile[],
): (dynTiles: readonly Tile[]) => RouteAreaScope {
    const W = waypoints.length;
    const baseStartAreas: (number[] | null | undefined)[] | null = areaOf ? new Array(W) : null;
    const baseEnd0Areas: (number[] | null | undefined)[] | null = areaOf ? new Array(W) : null;
    const baseEnd1Areas: (number[] | null | undefined)[] | null = areaOf ? new Array(W) : null;

    const computeBoxAreas = (tile: Tile, r: number, w = 1, h = 1): number[] | null => {
        if (!areaOf) return null;
        const out: number[] = [];
        const x1 = tile.x + w - 1 + r, z1 = tile.z + h - 1 + r;
        const probe: Tile = { level: tile.level, x: 0, z: 0 };
        for (let x = tile.x - r; x <= x1; x++) {
            probe.x = x;
            for (let z = tile.z - r; z <= z1; z++) {
                probe.z = z;
                const v = areaOf(probe);
                if (v === -2) return null;
                if (v >= 0 && !out.includes(v)) out.push(v);
            }
        }
        return out;
    };
    const computeStartAreas = (tile: Tile): number[] | null => {
        if (!areaOf) return null;
        const own = areaOf(tile);
        if (own === -2) return null;
        if (own >= 0) return [own];
        return computeBoxAreas(tile, 1);
    };

    return (dynTiles: readonly Tile[]): RouteAreaScope => {
        const dynStartAreas: (number[] | null | undefined)[] = [];
        const dynEnd0Areas: (number[] | null | undefined)[] = [];
        const dynEnd1Areas: (number[] | null | undefined)[] = [];
        const nodeTile = (idx: number): Tile => idx < W ? waypoints[idx]! : dynTiles[idx - W]!;

        return {
            startAreasOf(idx: number): number[] | null {
                if (!areaOf) return null;
                if (idx < W) {
                    let cached = baseStartAreas![idx];
                    if (cached === undefined) cached = baseStartAreas![idx] = computeStartAreas(waypoints[idx]!);
                    return cached;
                }
                const d = idx - W;
                let cached = dynStartAreas[d];
                if (cached === undefined) cached = dynStartAreas[d] = computeStartAreas(dynTiles[d]!);
                return cached;
            },
            endAreasOf(idx: number, tol: number, q?: InteractionTarget, app?: ApproachTransport): number[] | null {
                if (!areaOf) return null;
                if (q) {
                    if (app) {
                        if (app.endAreas === undefined) {
                            app.endAreas = computeBoxAreas(app.t.from, Math.max(tol, 1), q.width, q.height);
                        }
                        return app.endAreas;
                    }
                    return computeBoxAreas(nodeTile(idx), Math.max(tol, 1), q.width, q.height);
                }
                if (tol === 0) {
                    if (idx < W) {
                        let cached = baseEnd0Areas![idx];
                        if (cached === undefined) {
                            const v = areaOf(waypoints[idx]!);
                            cached = baseEnd0Areas![idx] = v === -2 ? null : v >= 0 ? [v] : [];
                        }
                        return cached;
                    }
                    const d = idx - W;
                    let cached = dynEnd0Areas[d];
                    if (cached === undefined) {
                        const v = areaOf(dynTiles[d]!);
                        cached = dynEnd0Areas[d] = v === -2 ? null : v >= 0 ? [v] : [];
                    }
                    return cached;
                }
                if (tol === 1) {
                    if (idx < W) {
                        let cached = baseEnd1Areas![idx];
                        if (cached === undefined) cached = baseEnd1Areas![idx] = computeBoxAreas(waypoints[idx]!, 1);
                        return cached;
                    }
                    const d = idx - W;
                    let cached = dynEnd1Areas[d];
                    if (cached === undefined) cached = dynEnd1Areas[d] = computeBoxAreas(dynTiles[d]!, 1);
                    return cached;
                }
                return null;
            },
        };
    };
}

/** Builds dense waypoint tables, spatial indices, area caches, and lower-bound graphs for route search. */
export function buildWorldGraph(opts: WorldOptions): WorldGraph {
    const raw = opts.transports ?? loadKnowledgeJson<Transport[]>('transports.json');
    const transports = normalizeTransports(raw);
    const doors = opts.doors ?? loadKnowledgeJson<Door[]>('doors.json');
    // Travel with a start tile is an edge between two nodes; travel from anywhere (a teleport) leaves the route start.
    // An NPC's spawn or a computed shore tile can sit on a blocked tile; use the nearest walkable one within 3.
    const snap = (t: Tile): Tile => {
        const ok = opts.pathLength.walkable;
        if (!ok || ok(t)) return t;
        for (let r = 1; r <= 3; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dz = -r; dz <= r; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) === r && ok({ ...t, x: t.x + dx, z: t.z + dz })) {
                        return { ...t, x: t.x + dx, z: t.z + dz };
                    }
                }
            }
        }
        return t;
    };
    // A world given its own transports (a test) gets no default travel; the real world loads all of it.
    const real = !opts.travel && !opts.transports && opts.pathLength.areaOf;
    const travel = (opts.travel ?? (opts.transports ? [] : [...loadTravel(), ...(real ? [...crossingTravel(loadCrossings(), opts.pathLength.areaOf!), ...RIVER_LOG_TRAVEL] : [])]))
        .map(t => ({ ...t, from: t.from && snap(t.from), to: snap(t.to) }));
    const fixed = travel.filter(t => t.from);
    const anywhere = travel.filter(t => !t.from);

    // Dense waypoint table indexed once per world to eliminate per-route graph and key allocations.
    const waypointIndex = new Map<string, number>();
    const waypoints: Tile[] = [];
    const addWaypoint = (t: Tile): number => {
        const k = tileKey(t);
        const existing = waypointIndex.get(k);
        if (existing !== undefined) return existing;
        const idx = waypoints.length;
        waypointIndex.set(k, idx);
        waypoints.push(t);
        return idx;
    };
    for (const t of transports) { addWaypoint(entryOf(t)); addWaypoint(t.to); }
    for (const t of travel) { if (t.from) addWaypoint(t.from); addWaypoint(t.to); }
    const W = waypoints.length;

    const legByTransport: Leg[] = transports.map(t => ({
        kind: 'transport', loc: t.locName, option: t.option, at: t.from, to: t.to,
        exact: t.exact, requires: t.requires, entry: t.entry, landing: t.landing,
        requireSrc: t.requireSrc, interaction: t.interaction,
    }));

    const emptyOut: OutEdge[] = [];
    const emptyIn: InEdge[] = [];
    const emptyFwd: FwdTravel[] = [];
    const emptyBwd: BwdTravel[] = [];
    const outgoingByIdx: OutEdge[][] = new Array(W).fill(emptyOut);
    const incomingByIdx: InEdge[][] = new Array(W).fill(emptyIn);
    const transportFromIdx = new Int32Array(transports.length);
    const transportToIdx = new Int32Array(transports.length);
    const strictMask = new Uint8Array(W);
    for (let index = 0; index < transports.length; index++) {
        const t = transports[index]!;
        const entryTile = entryOf(t);
        const entryIdx = waypointIndex.get(tileKey(entryTile))!;
        const rawFromIdx = waypointIndex.get(tileKey(t.from)) ?? entryIdx;
        const toIdx = waypointIndex.get(tileKey(t.to))!;
        const leg = legByTransport[index]!;
        transportFromIdx[index] = rawFromIdx;
        transportToIdx[index] = toIdx;
        const outList = outgoingByIdx[entryIdx] === emptyOut ? (outgoingByIdx[entryIdx] = []) : outgoingByIdx[entryIdx]!;
        outList.push({ t, index, toIdx, leg });
        const inList = incomingByIdx[toIdx] === emptyIn ? (incomingByIdx[toIdx] = []) : incomingByIdx[toIdx]!;
        inList.push({ t, index, fromIdx: entryIdx, leg, entryTile, fromTile: t.from });
        if (t.entry) strictMask[waypointIndex.get(tileKey(t.entry))!] = 1;
    }

    const travelFromByIdx: FwdTravel[][] = new Array(W).fill(emptyFwd);
    const travelToByIdx: BwdTravel[][] = new Array(W).fill(emptyBwd);
    const anywhereIndexed: FwdTravel[] = [];
    for (let i = 0; i < fixed.length; i++) {
        const t = fixed[i]!;
        const fromIdx = waypointIndex.get(tileKey(t.from!))!;
        const toIdx = waypointIndex.get(tileKey(t.to))!;
        const fList = travelFromByIdx[fromIdx] === emptyFwd ? (travelFromByIdx[fromIdx] = []) : travelFromByIdx[fromIdx]!;
        fList.push({ t, toIdx });
        const bList = travelToByIdx[toIdx] === emptyBwd ? (travelToByIdx[toIdx] = []) : travelToByIdx[toIdx]!;
        bList.push({ t, fromIdx });
    }
    for (const t of anywhere) {
        const toIdx = waypointIndex.get(tileKey(t.to))!;
        anywhereIndexed.push({ t, toIdx });
        const bList = travelToByIdx[toIdx] === emptyBwd ? (travelToByIdx[toIdx] = []) : travelToByIdx[toIdx]!;
        bList.push({ t, fromIdx: -1 });
    }

    const walkableFn = opts.pathLength.walkable;
    const walkableMask = new Uint8Array(W);
    const walkableIdx: number[] = [];
    for (let idx = 0; idx < W; idx++) {
        const ok = !walkableFn || walkableFn(waypoints[idx]!);
        walkableMask[idx] = ok ? 1 : 0;
        if (ok) walkableIdx.push(idx);
    }
    const levelNodes = bucketByLevel(waypoints, t => t, (_t, i) => i);
    const walkableLevelNodes = bucketByLevel(walkableIdx, idx => waypoints[idx]!, idx => idx);
    const approachTransports: ApproachTransport[] = [];
    const approachByIndex: (ApproachTransport | undefined)[] = new Array(transports.length);
    for (let index = 0; index < transports.length; index++) {
        const t = transports[index]!;
        if (!t.entry && t.interaction) {
            const q = t.interaction;
            const app: ApproachTransport = {
                t, index,
                fromIdx: transportFromIdx[index]!,
                toIdx: transportToIdx[index]!,
                tol: Math.max(PORTAL_TOL, q.width, q.height),
                q, leg: legByTransport[index]!,
            };
            approachTransports.push(app);
            approachByIndex[index] = app;
        }
    }
    const approachesByLevel: ApproachTransport[][] = [[], [], [], []];
    for (const a of approachTransports) {
        const lvl = a.t.from.level;
        if (lvl >= 0 && lvl < 4) approachesByLevel[lvl]!.push(a);
    }
    const approachLevelXs: Int32Array[] = [];
    for (let lvl = 0; lvl < 4; lvl++) {
        const list = approachesByLevel[lvl]!;
        list.sort((a, b) => a.t.from.x - b.t.from.x || a.t.from.z - b.t.from.z);
        const xs = new Int32Array(list.length);
        for (let k = 0; k < list.length; k++) xs[k] = list[k]!.t.from.x;
        approachLevelXs.push(xs);
    }

    let radius = PORTAL_TOL;
    for (let i = 0; i < transports.length; i++) {
        const q = transports[i]!.interaction;
        if (q) {
            if (q.width > radius) radius = q.width;
            if (q.height > radius) radius = q.height;
        }
    }
    const forwardLBGraph = buildLowerBoundGraph(waypoints, waypointIndex, transports, fixed, false);
    const backwardLBGraph = buildLowerBoundGraph(waypoints, waypointIndex, transports, fixed, true);

    const areaOf = opts.pathLength.areaOf;
    return {
        transports,
        doors,
        travel,
        anywhere,
        waypoints,
        waypointIndex,
        legByTransport,
        outgoingByIdx,
        incomingByIdx,
        transportFromIdx,
        transportToIdx,
        strictMask,
        travelFromByIdx,
        travelToByIdx,
        anywhereIndexed,
        levelNodes,
        walkableMask,
        walkableLevelNodes,
        approachesByLevel,
        approachByIndex,
        approachLevelXs,
        radius,
        forwardLBGraph,
        backwardLBGraph,
        hasAreaOf: Boolean(areaOf),
        routeAreas: createAreaScopeFactory(areaOf, waypoints),
    };
}
