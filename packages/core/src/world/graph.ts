import type { InteractionTarget } from '../../../knowledge/src/transports';
import { crossingTravel, loadCrossings, loadTravel, type Travel } from '../travel';
import { normalizeTransports } from './filters';
import { entryOf, GOAL_TOL, loadKnowledgeJson, PORTAL_TOL, tileKey, TRANSPORT_COST, type Door, type Leg, type Tile, type Transport, type WorldOptions } from './model';

export type LevelBuckets = {
    ids: Int32Array[];
    xs: Int32Array[];
    zs: Int32Array[];
};

/** Groups nodes by plane and sorts each plane by x then z for bounded range scans. */
export function bucketByLevel<T>(items: readonly T[], getTile: (item: T) => Tile, getId: (item: T) => number): LevelBuckets {
    const lists: { id: number; x: number; z: number }[][] = [[], [], [], []];
    for (const item of items) {
        const t = getTile(item);
        const lvl = t.level;
        if (lvl >= 0 && lvl < 4) lists[lvl]!.push({ id: getId(item), x: t.x, z: t.z });
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

class CostMinHeap {
    private idx: Int32Array;
    private cost: Float64Array;
    size = 0;
    constructor(cap: number) {
        const n = Math.max(16, cap);
        this.idx = new Int32Array(n);
        this.cost = new Float64Array(n);
    }
    push(index: number, c: number): void {
        if (this.size >= this.idx.length) {
            const nextIdx = new Int32Array(this.idx.length * 2);
            nextIdx.set(this.idx);
            this.idx = nextIdx;
            const nextCost = new Float64Array(this.cost.length * 2);
            nextCost.set(this.cost);
            this.cost = nextCost;
        }
        let i = this.size++;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.cost[p]! <= c) break;
            this.idx[i] = this.idx[p]!;
            this.cost[i] = this.cost[p]!;
            i = p;
        }
        this.idx[i] = index;
        this.cost[i] = c;
    }
    popIndex(): { index: number; cost: number } {
        const topIdx = this.idx[0]!, topCost = this.cost[0]!;
        const n = --this.size;
        if (n > 0) {
            const lastIdx = this.idx[n]!, lastCost = this.cost[n]!;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                if (l >= n) break;
                const r = l + 1;
                const c = r < n && this.cost[r]! < this.cost[l]! ? r : l;
                if (lastCost <= this.cost[c]!) break;
                this.idx[i] = this.idx[c]!;
                this.cost[i] = this.cost[c]!;
                i = c;
            }
            this.idx[i] = lastIdx;
            this.cost[i] = lastCost;
        }
        return { index: topIdx, cost: topCost };
    }
}

export type LowerBoundGraph = {
    nodeCount: number;
    xs: Int32Array;
    zs: Int32Array;
    levels: Int8Array;
    radii: Float64Array;
    incoming: Int32Array[];
    levelNodes: Int32Array[];
};

export function buildLowerBoundGraph(
    waypoints: readonly Tile[],
    waypointIndex: Map<string, number>,
    transports: readonly Transport[],
): LowerBoundGraph {
    const n = waypoints.length;
    const xs = new Int32Array(n), zs = new Int32Array(n), levels = new Int8Array(n);
    const radii = new Float64Array(n).fill(PORTAL_TOL);
    const byLvl: number[][] = [[], [], [], []];
    for (let i = 0; i < n; i++) {
        const w = waypoints[i]!;
        xs[i] = w.x; zs[i] = w.z; levels[i] = w.level;
        if (w.level >= 0 && w.level < 4) byLvl[w.level]!.push(i);
    }
    const incLists: number[][] = Array.from({ length: n }, () => []);
    for (const t of transports) {
        const from = waypointIndex.get(tileKey(entryOf(t)))!, to = waypointIndex.get(tileKey(t.to))!;
        incLists[to]!.push(from);
        radii[from] = Math.max(radii[from]!, t.interaction?.width ?? 1, t.interaction?.height ?? 1);
    }
    return {
        nodeCount: n,
        xs,
        zs,
        levels,
        radii,
        incoming: incLists.map(l => new Int32Array(l)),
        levelNodes: byLvl.map(l => new Int32Array(l)),
    };
}

// A direct-distance goal heuristic is not a lower bound when a transport can
// jump toward the goal. Settle a relaxed portal graph by accumulated cost
// (OlZe PathfinderDijkstra). Collision-free walk costs only underestimate the
// real walks, retaining lazy path measurements without pruning cheap detours.
export function solveLowerBounds(graph: LowerBoundGraph, goalBoundIdx: number, goalTile: Tile, relaxedRadius: number): Float64Array {
    const baseN = graph.nodeCount;
    const totalN = goalBoundIdx < baseN ? baseN : baseN + 1;
    const best = new Float64Array(totalN).fill(Infinity);
    best[goalBoundIdx] = 0;
    const settled = new Uint8Array(totalN);
    const queue = new CostMinHeap(totalN);
    queue.push(goalBoundIdx, 0);
    const relax = (index: number, cost: number) => {
        if (cost >= best[index]!) return;
        best[index] = cost;
        queue.push(index, cost);
    };
    const { xs, zs, levels, radii, incoming, levelNodes } = graph;
    while (queue.size) {
        const e = queue.popIndex();
        const u = e.index;
        if (e.cost !== best[u]) continue;
        settled[u] = 1;
        const isGoal = u === goalBoundIdx;
        const tx = u < baseN ? xs[u]! : goalTile.x;
        const tz = u < baseN ? zs[u]! : goalTile.z;
        const tLvl = u < baseN ? levels[u]! : goalTile.level;
        const tolerance = isGoal ? GOAL_TOL : Math.max(relaxedRadius, u < baseN ? radii[u]! : PORTAL_TOL);
        if (tLvl >= 0 && tLvl < 4) {
            const peers = levelNodes[tLvl]!;
            for (let k = 0; k < peers.length; k++) {
                const i = peers[k]!;
                if (settled[i] || best[i]! <= e.cost) continue;
                const dx = Math.abs(xs[i]! - tx), dz = Math.abs(zs[i]! - tz);
                const d = (dx > dz ? dx : dz) - tolerance;
                relax(i, e.cost + (d > 0 ? d : 0));
            }
            if (goalBoundIdx >= baseN && goalTile.level === tLvl && !settled[goalBoundIdx]) {
                const dx = Math.abs(goalTile.x - tx), dz = Math.abs(goalTile.z - tz);
                const d = (dx > dz ? dx : dz) - tolerance;
                relax(goalBoundIdx, e.cost + (d > 0 ? d : 0));
            }
        }
        if (u < baseN) {
            const inc = incoming[u]!;
            for (let k = 0; k < inc.length; k++) relax(inc[k]!, e.cost + TRANSPORT_COST);
        }
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
    approachesByLevel: ApproachTransport[][];
    approachLevelXs: Int32Array[];
    radius: number;
    forwardLBGraph: LowerBoundGraph;
    backwardLBGraph: LowerBoundGraph;
    hasAreaOf: boolean;
    routeAreas(dynTiles: readonly Tile[]): RouteAreaScope;
}

function createAreaScopeFactory(areaOf: ((t: Tile) => number) | undefined, waypoints: readonly Tile[]): (dynTiles: readonly Tile[]) => RouteAreaScope {
    const W = waypoints.length;
    const baseStartAreas: (number[] | null | undefined)[] | null = areaOf ? new Array(W) : null;
    const baseEnd0Areas: (number[] | null | undefined)[] | null = areaOf ? new Array(W) : null;
    const baseEnd1Areas: (number[] | null | undefined)[] | null = areaOf ? new Array(W) : null;

    const computeBoxAreas = (tile: Tile, r: number, w = 1, h = 1): number[] | null => {
        if (!areaOf) return null;
        const out: number[] = [];
        const x1 = tile.x + w - 1 + r, z1 = tile.z + h - 1 + r;
        for (let x = tile.x - r; x <= x1; x++) {
            for (let z = tile.z - r; z <= z1; z++) {
                const v = areaOf({ level: tile.level, x, z });
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
                        if (app.endAreas === undefined) app.endAreas = computeBoxAreas(app.t.from, Math.max(tol, 1), q.width, q.height);
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
    const travel = (opts.travel ?? (opts.transports ? [] : [...loadTravel(), ...(real ? crossingTravel(loadCrossings(), opts.pathLength.areaOf!) : [])]))
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

    const outgoingByIdx: OutEdge[][] = Array.from({ length: W }, () => []);
    const incomingByIdx: InEdge[][] = Array.from({ length: W }, () => []);
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
        outgoingByIdx[entryIdx]!.push({ t, index, toIdx, leg });
        incomingByIdx[toIdx]!.push({ t, index, fromIdx: entryIdx, leg, entryTile, fromTile: t.from });
        if (t.entry) strictMask[waypointIndex.get(tileKey(t.entry))!] = 1;
    }

    const travelFromByIdx: FwdTravel[][] = Array.from({ length: W }, () => []);
    const travelToByIdx: BwdTravel[][] = Array.from({ length: W }, () => []);
    const anywhereIndexed: FwdTravel[] = [];
    for (let i = 0; i < fixed.length; i++) {
        const t = fixed[i]!;
        const fromIdx = waypointIndex.get(tileKey(t.from!))!;
        const toIdx = waypointIndex.get(tileKey(t.to))!;
        travelFromByIdx[fromIdx]!.push({ t, toIdx });
        travelToByIdx[toIdx]!.push({ t, fromIdx });
    }
    for (const t of anywhere) {
        const toIdx = waypointIndex.get(tileKey(t.to))!;
        anywhereIndexed.push({ t, toIdx });
        travelToByIdx[toIdx]!.push({ t, fromIdx: -1 });
    }

    const levelNodes = bucketByLevel(waypoints.map((tile, idx) => ({ tile, idx })), e => e.tile, e => e.idx);
    const approachTransports: ApproachTransport[] = [];
    for (let index = 0; index < transports.length; index++) {
        const t = transports[index]!;
        if (!t.entry && t.interaction) {
            const q = t.interaction;
            approachTransports.push({
                t, index,
                fromIdx: transportFromIdx[index]!,
                toIdx: transportToIdx[index]!,
                tol: Math.max(PORTAL_TOL, q.width, q.height),
                q, leg: legByTransport[index]!,
            });
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

    const radius = Math.max(PORTAL_TOL, ...transports.flatMap(t => [t.interaction?.width ?? 1, t.interaction?.height ?? 1]));
    const jumps = fixed.map(t => ({ from: t.from, to: t.to }) as Transport);
    const jumpsBack = fixed.map(t => ({ from: t.to, to: t.from }) as Transport);
    const reversed = transports.map(t => ({ ...t, from: t.to, to: entryOf(t), entry: undefined, interaction: undefined }));
    const forwardLBGraph = buildLowerBoundGraph(waypoints, waypointIndex, [...transports, ...jumps]);
    const backwardLBGraph = buildLowerBoundGraph(waypoints, waypointIndex, [...reversed, ...jumpsBack]);

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
        approachesByLevel,
        approachLevelXs,
        radius,
        forwardLBGraph,
        backwardLBGraph,
        hasAreaOf: Boolean(areaOf),
        routeAreas: createAreaScopeFactory(areaOf, waypoints),
    };
}
