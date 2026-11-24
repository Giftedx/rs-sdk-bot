import type { InteractionTarget } from '../../../knowledge/src/transports';
import { travelAllowed, type Travel } from '../travel';
import { doorBlock, doorBlocks, transportAllowed } from './filters';
import { areasDisjoint, buildWorldGraph, lowerBoundX, solveLowerBounds, upperBoundX, type ApproachTransport, type WorldGraph } from './graph';
import { GOAL_TOL, loadKnowledgeJson, MAX_LEG, PORTAL_TOL, routeFares, tileKey, TRANSPORT_COST, type Account, type Door, type Leg, type RouteOptions, type Tile, type Transport, type World, type WorldOptions } from './model';

class MinHeap<T> {
    private a: T[] = [];
    constructor(private score: (t: T) => number) {}
    get size() { return this.a.length; }
    clear() { this.a = []; }
    push(t: T) {
        const a = this.a;
        a.push(t);
        for (let i = a.length - 1; i > 0;) {
            const p = (i - 1) >> 1;
            if (this.score(a[p]!) <= this.score(a[i]!)) break;
            const tmp = a[p]!; a[p] = a[i]!; a[i] = tmp;
            i = p;
        }
    }
    pop(): T | undefined {
        const a = this.a;
        const top = a[0];
        const last = a.pop();
        if (a.length > 0 && last !== undefined) {
            a[0] = last;
            for (let i = 0; ;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < a.length && this.score(a[l]!) < this.score(a[m]!)) m = l;
                if (r < a.length && this.score(a[r]!) < this.score(a[m]!)) m = r;
                if (m === i) break;
                const tmp = a[m]!; a[m] = a[i]!; a[i] = tmp;
                i = m;
            }
        }
        return top;
    }
}

type SearchEntry = {
    nodeIdx: number;
    stateBase: number;
    id: number;
    fare: number;
    tile: Tile;
    g: number;
    f: number;
    prev: number;
    leg: Leg | null;
    walkFromIdx?: number;
    walkFromTile?: Tile;
    walkToIdx?: number;
    walkToTile?: Tile;
    tol?: number;
    interaction?: InteractionTarget;
    qId?: number;
    approach?: Transport;
    approachIdx?: number;
};

/** Executes bidirectional lazy A* over a built world graph under an account's door, danger, and coin budgets. */
export function routeOnGraph(
    graph: WorldGraph,
    opts: WorldOptions,
    from: Tile,
    to: Tile,
    acct: Account,
    routeOpts?: RouteOptions,
): ReturnType<World['route']> {
    const {
        transports, doors, travel, waypoints, waypointIndex, legByTransport,
        outgoingByIdx, incomingByIdx, transportFromIdx, transportToIdx, strictMask,
        travelFromByIdx, travelToByIdx, anywhereIndexed, levelNodes,
        walkableMask, walkableLevelNodes, approachesByLevel, approachByIndex,
        approachLevelXs, radius, forwardLBGraph, backwardLBGraph, hasAreaOf,
    } = graph;
    const W = waypoints.length;
    const deadline = routeOpts?.deadline ?? Infinity;
    const fromKey = tileKey(from), toKey = tileKey(to);
    const fromExisting = waypointIndex.get(fromKey);
    const toExisting = waypointIndex.get(toKey);
    const dynTiles: Tile[] = [];
    let fromIdx: number;
    if (fromExisting !== undefined) fromIdx = fromExisting;
    else { fromIdx = W + dynTiles.length; dynTiles.push(from); }
    let toIdx: number;
    if (toKey === fromKey) toIdx = fromIdx;
    else if (toExisting !== undefined) toIdx = toExisting;
    else { toIdx = W + dynTiles.length; dynTiles.push(to); }

    const totalNodes = W + dynTiles.length;
    const approachOffset = totalNodes;
    const totalStates = totalNodes + transports.length;
    const strictTo = toIdx < W ? strictMask[toIdx] === 1 : false;
    const walkableFn = opts.pathLength.walkable;
    const dynWalkable = new Uint8Array(dynTiles.length);
    for (let d = 0; d < dynTiles.length; d++) dynWalkable[d] = !walkableFn || walkableFn(dynTiles[d]!) ? 1 : 0;
    const isWalkable = (idx: number): boolean => idx < W ? walkableMask[idx] === 1 : dynWalkable[idx - W] === 1;
    const { startAreasOf, endAreasOf } = graph.routeAreas(dynTiles);

    const allowedT = new Uint8Array(transports.length);
    for (let i = 0; i < transports.length; i++) allowedT[i] = transportAllowed(transports[i]!, acct) ? 1 : 0;
    const travelZeroOk = new Map<Travel, boolean>();
    for (const t of travel) travelZeroOk.set(t, travelAllowed(t, acct));
    const blocked = doors.filter(d => doorBlocks(d, acct)).map(doorBlock);

    const search = (trackFares: boolean): ReturnType<World['route']> => {
        const numCache = new Map<number, number | null>();
        const strCache = new Map<string, number | null>();
        const fastWalkKeyOk = totalNodes < 16384 && transports.length < 16384;
        const walk = (aIdx: number, aTile: Tile, bIdx: number, bTile: Tile, tol: number, interaction?: InteractionTarget, qId = -1) => {
            if (fastWalkKeyOk && tol >= 0 && tol < 64 && qId >= -1 && qId < 16383) {
                const k = ((aIdx * 16384 + bIdx) * 64 + tol) * 16384 + (qId + 1);
                let v = numCache.get(k);
                if (v === undefined) {
                    v = opts.pathLength(aTile, bTile, blocked, tol, interaction);
                    numCache.set(k, v);
                }
                return v;
            }
            const k = `${aIdx}>${bIdx}:${tol}:${qId >= 0 ? qId : interaction ? JSON.stringify(interaction) : ''}`;
            let v = strCache.get(k);
            if (v === undefined) {
                v = opts.pathLength(aTile, bTile, blocked, tol, interaction);
                strCache.set(k, v);
            }
            return v;
        };

        // Each orientation is a complete lazy A* over the same directed graph.
        // Interleave path measurements; return only a settled goal or an empty
        // frontier, never the first meeting of two unfinished searches.
        function* run(backward: boolean): Generator<void, ReturnType<World['route']>, void> {
            const startTile = backward ? to : from, finishTile = backward ? from : to;
            const rootIdx = backward ? toIdx : fromIdx, goalIdx = backward ? fromIdx : toIdx;
            const goalBoundIdx = goalIdx < W ? goalIdx : W;
            const lower = solveLowerBounds(backward ? backwardLBGraph : forwardLBGraph, goalBoundIdx, finishTile, radius);
            const h = (idx: number) => idx === goalIdx ? 0 : idx < W ? lower[idx]! : 0;

            const heap = new MinHeap<SearchEntry>(e => e.f);
            // Fast flat arrays when trackFares is false (only fare=0 exists), numeric state ids when fares vary.
            const doneFast = trackFares ? null : new Uint8Array(totalStates);
            const bestFast = trackFares ? null : new Float64Array(totalStates);
            const bestResolvedFast = trackFares ? null : new Float64Array(totalStates).fill(Infinity);
            const prevFast = trackFares ? null : new Int32Array(totalStates).fill(-1);
            const legFast = trackFares ? null : new Array<Leg | null>(totalStates).fill(null);
            const doneMap = trackFares ? new Set<number>() : null;
            const bestMap = trackFares ? new Map<number, number>() : null;
            const viaMap = trackFares ? new Map<number, { prev: number; leg: Leg }>() : null;
            const settledMap = trackFares ? new Map<number, { fare: number; cost: number }[]>() : null;

            const isDone = (id: number): boolean => trackFares ? doneMap!.has(id) : doneFast![id] === 1;
            const dominated = (stateBase: number, fare: number, cost: number): boolean => {
                if (!trackFares) return false;
                const list = settledMap!.get(stateBase);
                if (!list) return false;
                for (let i = 0; i < list.length; i++) {
                    const s = list[i]!;
                    if (s.fare <= fare && s.cost <= cost) return true;
                }
                return false;
            };
            const makeId = (stateBase: number, fare: number): number => trackFares ? fare * totalStates + stateBase : stateBase;

            const rootId = makeId(rootIdx, 0);
            if (!trackFares) bestResolvedFast![rootId] = 0;
            heap.push({
                nodeIdx: rootIdx, stateBase: rootIdx, id: rootId, fare: 0,
                tile: startTile, g: 0, f: h(rootIdx), prev: -1, leg: null,
            });
            const goalTol = opts.goalTolerance ?? GOAL_TOL;
            try {
                while (heap.size) {
                    const e = heap.pop()!;
                    if (isDone(e.id) || dominated(e.stateBase, e.fare, e.g)) continue;
                    if (e.walkToTile) {
                        if (!trackFares && e.g >= bestResolvedFast![e.id]!) continue;
                        // Both orientations measure the original FORWARD edge,
                        // under the same synchronous policy and shared cache.
                        const c = walk(e.walkFromIdx!, e.walkFromTile!, e.walkToIdx!, e.walkToTile, e.tol!, e.interaction, e.qId);
                        if (c !== null) {
                            const prevBest = trackFares ? bestMap!.get(e.prev)! : bestFast![e.prev]!;
                            const g = prevBest + c;
                            if (!trackFares) {
                                if (g >= bestResolvedFast![e.id]!) { yield; continue; }
                                bestResolvedFast![e.id] = g;
                            }
                            e.leg = { kind: 'walk', to: e.walkToTile, tolerance: e.tol };
                            e.walkToTile = undefined;
                            e.g = g;
                            e.f = g + h(e.nodeIdx);
                            heap.push(e);
                        }
                        yield;
                        continue;
                    }
                    if (trackFares) {
                        doneMap!.add(e.id);
                        bestMap!.set(e.id, e.g);
                        const prevList = settledMap!.get(e.stateBase);
                        const filtered = prevList ? prevList.filter(s => s.fare < e.fare || s.cost < e.g) : [];
                        filtered.push({ fare: e.fare, cost: e.g });
                        settledMap!.set(e.stateBase, filtered);
                        if (e.prev >= 0) viaMap!.set(e.id, { prev: e.prev, leg: e.leg! });
                    } else {
                        doneFast![e.id] = 1;
                        bestFast![e.id] = e.g;
                        prevFast![e.id] = e.prev;
                        legFast![e.id] = e.leg;
                    }
                    if (e.stateBase === goalIdx) {
                        const legs: Leg[] = [];
                        if (trackFares) {
                            for (let k = e.id; k !== rootId;) { const v = viaMap!.get(k)!; legs.push(v.leg); k = v.prev; }
                        } else {
                            for (let k = e.id; k !== rootId;) { legs.push(legFast![k]!); k = prevFast![k]!; }
                        }
                        if (!backward) legs.reverse();
                        return { ok: true, legs, cost: e.g };
                    }
                    const enqueueTransport = (nextNodeIdx: number, nextStateBase: number, nextTile: Tile, leg: Leg, approach?: Transport, approachIdx?: number) => {
                        const id = makeId(nextStateBase, e.fare);
                        if (isDone(id)) return;
                        const g = e.g + TRANSPORT_COST;
                        if (!trackFares) {
                            if (g >= bestResolvedFast![id]!) return;
                            bestResolvedFast![id] = g;
                        }
                        heap.push({
                            nodeIdx: nextNodeIdx, stateBase: nextStateBase, id, fare: e.fare,
                            tile: nextTile, g, f: g + h(nextNodeIdx), prev: e.id, leg, approach, approachIdx,
                        });
                    };
                    const enqueueWalk = (
                        nextNodeIdx: number, nextStateBase: number, nextTile: Tile,
                        targetIdx: number, targetTile: Tile, tol: number,
                        interaction?: InteractionTarget, qId = -1, appObj?: ApproachTransport, approach?: Transport,
                        preStartA?: number[] | null, preEndA?: number[] | null,
                    ) => {
                        if (nextStateBase === e.stateBase) return;
                        const wFromIdx = backward ? nextNodeIdx : e.nodeIdx;
                        const wFromTile = backward ? nextTile : e.tile;
                        if (wFromTile.level !== targetTile.level) return;
                        const dx = Math.abs(wFromTile.x - targetTile.x), dz = Math.abs(wFromTile.z - targetTile.z);
                        const dist = dx > dz ? dx : dz;
                        if (dist > MAX_LEG) return;
                        const id = makeId(nextStateBase, e.fare);
                        if (isDone(id)) return;
                        const rem = dist - tol;
                        const g = e.g + (rem > 0 ? rem : 0);
                        if (!trackFares && g >= bestResolvedFast![id]!) return;
                        if (hasAreaOf) {
                            const sA = preStartA !== undefined ? preStartA : startAreasOf(wFromIdx);
                            const eA = preEndA !== undefined ? preEndA : endAreasOf(targetIdx, tol, interaction, appObj);
                            if (areasDisjoint(sA, eA)) return;
                        }
                        heap.push({
                            nodeIdx: nextNodeIdx, stateBase: nextStateBase, id, fare: e.fare,
                            tile: nextTile, g, f: g + h(nextNodeIdx), prev: e.id, leg: null,
                            walkFromIdx: wFromIdx, walkFromTile: wFromTile,
                            walkToIdx: targetIdx, walkToTile: targetTile, tol, interaction, qId, approach,
                            approachIdx: approach ? qId : undefined,
                        });
                    };
                    const enqueueTravel = (t: Travel, nextIdx: number, nextTile: Tile) => {
                        const fare = e.fare + (trackFares ? t.coins : 0);
                        const id = makeId(nextIdx, fare);
                        if (isDone(id)) return;
                        const g = e.g + t.cost;
                        if (!trackFares && g >= bestResolvedFast![id]!) return;
                        const allowed = e.fare ? travelAllowed(t, { ...acct, coins: (acct.coins ?? 0) - e.fare }) : travelZeroOk.get(t)!;
                        if (!allowed) return;
                        if (!trackFares) bestResolvedFast![id] = g;
                        heap.push({
                            nodeIdx: nextIdx, stateBase: nextIdx, id, fare, tile: nextTile,
                            g, f: g + h(nextIdx), prev: e.id, leg: { kind: 'travel', travel: t, at: t.from, to: t.to },
                        });
                    };

                    if (!e.approach) {
                        if (!backward) {
                            if (e.nodeIdx < W) {
                                const trList = travelFromByIdx[e.nodeIdx]!;
                                for (let i = 0; i < trList.length; i++) {
                                    const tr = trList[i]!;
                                    enqueueTravel(tr.t, tr.toIdx, tr.t.to);
                                }
                            }
                            if (e.stateBase === rootIdx) {
                                for (let i = 0; i < anywhereIndexed.length; i++) {
                                    const tr = anywhereIndexed[i]!;
                                    enqueueTravel(tr.t, tr.toIdx, tr.t.to);
                                }
                            }
                        } else if (e.nodeIdx < W) {
                            // Backward, a teleport's arrival leads back to the route start, where it is cast.
                            const trList = travelToByIdx[e.nodeIdx]!;
                            for (let i = 0; i < trList.length; i++) {
                                const tr = trList[i]!;
                                const destIdx = tr.fromIdx >= 0 ? tr.fromIdx : goalIdx;
                                enqueueTravel(tr.t, destIdx, tr.t.from ?? finishTile);
                            }
                        }
                    }

                    const eLvl = e.tile.level;
                    if (backward) {
                        if (!e.approach && e.nodeIdx < W) {
                            const inc = incomingByIdx[e.nodeIdx]!;
                            for (let i = 0; i < inc.length; i++) {
                                const edge = inc[i]!;
                                if (!allowedT[edge.index]) continue;
                                enqueueTransport(edge.fromIdx, edge.fromIdx, edge.entryTile, edge.leg);
                                if (!edge.t.entry && edge.t.interaction) {
                                    enqueueTransport(transportFromIdx[edge.index]!, approachOffset + edge.index, edge.fromTile, edge.leg, edge.t, edge.index);
                                }
                            }
                        }
                        const targetTile = e.approach?.from ?? e.tile;
                        const targetIdx = e.approach ? transportFromIdx[e.approachIdx!]! : e.nodeIdx;
                        const q = e.approach?.interaction;
                        const qId = q ? e.approachIdx! : -1;
                        const tol = q ? Math.max(PORTAL_TOL, q.width, q.height) : e.stateBase === toIdx && !strictTo ? goalTol : 0;
                        if (q || tol > 0 || isWalkable(targetIdx)) {
                            const appObj = e.approachIdx !== undefined ? approachByIndex[e.approachIdx] : undefined;
                            const curEndA = hasAreaOf ? endAreasOf(targetIdx, tol, q, appObj) : undefined;
                            if (eLvl >= 0 && eLvl < 4) {
                                const xs = levelNodes.xs[eLvl]!, zs = levelNodes.zs[eLvl]!, ids = levelNodes.ids[eLvl]!;
                                const lo = lowerBoundX(xs, targetTile.x - MAX_LEG), hi = upperBoundX(xs, targetTile.x + MAX_LEG);
                                for (let k = lo; k < hi; k++) {
                                    if (Math.abs(zs[k]! - targetTile.z) > MAX_LEG) continue;
                                    const pIdx = ids[k]!;
                                    enqueueWalk(pIdx, pIdx, waypoints[pIdx]!, targetIdx, targetTile, tol, q, qId, appObj, undefined, undefined, curEndA);
                                }
                            }
                            for (let d = 0; d < dynTiles.length; d++) {
                                const pIdx = W + d;
                                enqueueWalk(pIdx, pIdx, dynTiles[d]!, targetIdx, targetTile, tol, q, qId, appObj, undefined, undefined, curEndA);
                            }
                        }
                    } else {
                        if (e.approach) {
                            const appIdx = e.approachIdx!;
                            enqueueTransport(transportToIdx[appIdx]!, transportToIdx[appIdx]!, e.approach.to, legByTransport[appIdx]!);
                            continue;
                        }
                        if (e.nodeIdx < W) {
                            const out = outgoingByIdx[e.nodeIdx]!;
                            for (let i = 0; i < out.length; i++) {
                                const edge = out[i]!;
                                if (allowedT[edge.index]) enqueueTransport(edge.toIdx, edge.toIdx, edge.t.to, edge.leg);
                            }
                        }
                        const curStartA = hasAreaOf ? startAreasOf(e.nodeIdx) : undefined;
                        if (eLvl >= 0 && eLvl < 4) {
                            const xs = walkableLevelNodes.xs[eLvl]!, zs = walkableLevelNodes.zs[eLvl]!, ids = walkableLevelNodes.ids[eLvl]!;
                            const lo = lowerBoundX(xs, e.tile.x - MAX_LEG), hi = upperBoundX(xs, e.tile.x + MAX_LEG);
                            for (let k = lo; k < hi; k++) {
                                if (Math.abs(zs[k]! - e.tile.z) > MAX_LEG) continue;
                                const tIdx = ids[k]!;
                                const tol = tIdx === toIdx && !strictTo ? goalTol : 0;
                                enqueueWalk(tIdx, tIdx, waypoints[tIdx]!, tIdx, waypoints[tIdx]!, tol, undefined, -1, undefined, undefined, curStartA);
                            }
                            if (toIdx < W && !strictTo && goalTol > 0 && walkableMask[toIdx] === 0 && waypoints[toIdx]!.level === eLvl) {
                                const tTile = waypoints[toIdx]!;
                                enqueueWalk(toIdx, toIdx, tTile, toIdx, tTile, goalTol, undefined, -1, undefined, undefined, curStartA);
                            }
                            const appList = approachesByLevel[eLvl]!, appXs = approachLevelXs[eLvl]!;
                            const aLo = lowerBoundX(appXs, e.tile.x - MAX_LEG), aHi = upperBoundX(appXs, e.tile.x + MAX_LEG);
                            for (let k = aLo; k < aHi; k++) {
                                const app = appList[k]!;
                                if (!allowedT[app.index] || Math.abs(app.t.from.z - e.tile.z) > MAX_LEG) continue;
                                enqueueWalk(app.fromIdx, approachOffset + app.index, app.t.from, app.fromIdx, app.t.from, app.tol, app.q, app.index, app, app.t, curStartA);
                            }
                        }
                        for (let d = 0; d < dynTiles.length; d++) {
                            const tIdx = W + d, tTile = dynTiles[d]!;
                            const tol = tIdx === toIdx && !strictTo ? goalTol : 0;
                            if (tol === 0 && !isWalkable(tIdx)) continue;
                            enqueueWalk(tIdx, tIdx, tTile, tIdx, tTile, tol, undefined, -1, undefined, undefined, curStartA);
                        }
                    }
                }
                return { ok: false, reason: 'no_route' };
            } finally {
                heap.clear();
                doneMap?.clear();
                viaMap?.clear();
                bestMap?.clear();
                settledMap?.clear();
            }
        }

        const forward = run(false), backward = run(true);
        try {
            for (;;) {
                if (performance.now() > deadline) return { ok: false, reason: 'budget' };
                const a = forward.next();
                if (a.done) return a.value;
                const b = backward.next();
                if (b.done) return b.value;
            }
        } finally {
            forward.return({ ok: false, reason: 'no_route' });
            backward.return({ ok: false, reason: 'no_route' });
            numCache.clear();
            strCache.clear();
        }
    };

    // An affordable unconstrained optimum is also the affordable optimum.
    // Keep one state per tile in that common case; only an unfunded result
    // needs the cost/fare frontier. Both passes share the route's deadline.
    const funded = () => {
        const r = search(false);
        return !r.ok || routeFares(r.legs) <= (acct.coins ?? 0) ? r : search(true);
    };
    const policed = () => opts.pathLength.withPolicy ? opts.pathLength.withPolicy(blocked, funded) : funded();
    return opts.pathLength.withDanger ? opts.pathLength.withDanger(acct, from, to, policed) : policed();
}

function buildWorld(opts: WorldOptions): World {
    const graph = buildWorldGraph(opts);
    const { transports, travel, doors } = graph;
    return {
        navigationGraph: () => ({ transports, travel }),
        blockedDoors: acct => doors.filter(d => doorBlocks(d, acct)).map(doorBlock),
        routeGain: (a, b) => travel.some(t => travelAllowed(t, b) && !travelAllowed(t, a)) || doors.some(d => doorBlocks(d, a) && !doorBlocks(d, b)),
        route: (from, to, acct, routeOpts) => routeOnGraph(graph, opts, from, to, acct, routeOpts),
    };
}

// The route graph (waypoint tables, lower-bound graphs, approach tables: about 405 MB of RSS and 3.19 million objects, with the collision grid that its travel snap makes the SDK build) builds on the
// first route(), navigationGraph() or routeGain() call. A process that plans its trips off the main thread
// (bot.ts getWorld: offThread) and only asks for the doors that an account cannot pass never builds it.
export function createWorld(opts: WorldOptions): World {
    let doors: Door[] | undefined = opts.doors, full: World | undefined;
    const doorList = () => doors ??= loadKnowledgeJson<Door[]>('doors.json');
    const built = () => full ??= buildWorld({ ...opts, doors: doorList() });
    return {
        navigationGraph: () => built().navigationGraph!(),
        blockedDoors: acct => doorList().filter(d => doorBlocks(d, acct)).map(doorBlock),
        routeGain: (a, b) => built().routeGain!(a, b),
        route: (from, to, acct, routeOpts) => built().route(from, to, acct, routeOpts),
    };
}
