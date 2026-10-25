import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Tile = { x: number; z: number; level: number };
export type Leg =
    | { kind: 'walk'; to: Tile }
    | { kind: 'transport'; loc: string; option: string; at: Tile; to: Tile; exact: boolean };
export interface Account { skills: Record<string, number>; varps: Record<string, number>; items: string[] }

export interface Transport { locName: string; option: string; from: Tile; to: Tile; exact: boolean; src: string; toSrc: string; handler: string }
export interface Door { id: number; loc: string; x: number; z: number; level: number; kind: string; need?: { skill?: string; level?: number; varp?: string; item?: string }; trigger: string; src: string }

// Walk cost on one level, or null when the path cannot end within `tol` tiles of `to`. `blocked` are door
// tiles to keep shut. Stair and ladder tiles are objects, not floor, so they are reached from next to them.
export type PathLength = (from: Tile, to: Tile, blocked: Tile[], tol: number) => number | null;

const PORTAL_TOL = 2; // stairs can be 2x2 or larger
const GOAL_TOL = 1;

export interface World {
    route(from: Tile, to: Tile, acct: Account): { ok: true; legs: Leg[]; cost: number } | { ok: false; reason: 'no_route' };
    // Door tiles this account cannot pass (doorBlocks), for the walker to block in the SDK pathfinder too.
    blockedDoors(acct: Account): Tile[];
}

const TRANSPORT_COST = 3; // ticks to climb or descend, roughly
const MAX_LEG = 300; // walk legs longer than this (Chebyshev) are not tried
const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const key = (t: Tile) => `${t.x},${t.z},${t.level}`;
const cheb = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

// Conservative: a door passes only when the account clearly meets its rule. Quest doors need the varp set
// above 0 (the exact complete value is not mined yet). One-way, conditional, locked and unknown doors never pass.
export function doorBlocks(d: Door, a: Account): boolean {
    switch (d.kind) {
        case 'open': return false;
        case 'skill': return !(d.need?.skill && d.need.level !== undefined && (a.skills[d.need.skill] ?? 1) >= d.need.level);
        case 'key': return !(d.need?.item && a.items.includes(d.need.item));
        case 'quest': return !(d.need?.varp && (a.varps[d.need.varp] ?? 0) > 0);
        default: return true;
    }
}

let knownDoorFacts: Door[] | null = null;
// Same account policy as the route planner, bounded to the current same-floor leg plus32tiles.
// This loader does not initialize the pathfinder or construct the transport graph.
export function blockedDoorsNear(from: Tile, to: Tile, acct: Account, doors?: readonly Door[]): Tile[] {
    if (from.level !== to.level) return [];
    const minX = Math.min(from.x, to.x) - 32, maxX = Math.max(from.x, to.x) + 32;
    const minZ = Math.min(from.z, to.z) - 32, maxZ = Math.max(from.z, to.z) + 32;
    const facts = doors ?? (knownDoorFacts ??= loadJson<Door[]>('doors.json'));
    return facts.filter(d => d.level === from.level && d.x >= minX && d.x <= maxX && d.z >= minZ && d.z <= maxZ && doorBlocks(d, acct))
        .map(d => ({ x: d.x, z: d.z, level: d.level }));
}

let rsPath: { findLongPath: Function; getDoorAt: Function } | null = null;
async function loadPathfinding() {
    if (!rsPath) rsPath = await import(join(repoRoot, 'vendor', 'rs-sdk', 'sdk', 'pathfinding.ts'));
    return rsPath!;
}

// Default walk cost: rs-sdk findLongPath turn points, summed as Chebyshev steps. Null if the path stops short.
export async function rsPathLength(): Promise<PathLength> {
    const pf = await loadPathfinding();
    return (from, to, blocked, tol) => {
        if (from.level !== to.level) return null;
        const doors = blocked.map(b => pf.getDoorAt(b.level, b.x, b.z)).filter(Boolean);
        const pts: Tile[] = pf.findLongPath(from.level, from.x, from.z, to.x, to.z, 500, doors);
        if (pts.length === 0) return cheb(from, to) <= tol ? 0 : null;
        const last = pts[pts.length - 1]!;
        if (cheb(last, to) > tol) return null;
        let len = 0;
        let prev = from;
        for (const p of pts) { len += cheb(prev, p); prev = p; }
        return len;
    };
}

class MinHeap<T> {
    private a: T[] = [];
    constructor(private score: (t: T) => number) {}
    get size() { return this.a.length; }
    push(t: T) {
        const a = this.a;
        a.push(t);
        for (let i = a.length - 1; i > 0;) {
            const p = (i - 1) >> 1;
            if (this.score(a[p]!) <= this.score(a[i]!)) break;
            [a[p], a[i]] = [a[i]!, a[p]!];
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
                [a[m], a[i]] = [a[i]!, a[m]!];
                i = m;
            }
        }
        return top;
    }
}

function loadJson<T>(name: string): T {
    return JSON.parse(readFileSync(join(repoRoot, 'knowledge', name), 'utf8'));
}

export function createWorld(opts: { transports?: Transport[]; doors?: Door[]; pathLength: PathLength }): World {
    // A stair with direct op2/op3 links (Climb-up / Climb-down) uses op1 for a "which way?" menu
    // (e.g. spiralstairsmiddle op1=Climb). Clicking op1 opens a dialog and never changes floor, so drop it.
    const all = opts.transports ?? loadJson<Transport[]>('transports.json');
    const hasDirect = new Set(all.filter(t => t.option !== 'op1').map(t => `${t.locName}@${key(t.from)}`));
    const transports = all.filter(t => !(t.option === 'op1' && hasDirect.has(`${t.locName}@${key(t.from)}`)));
    const doors = opts.doors ?? loadJson<Door[]>('doors.json');
    const byAt = new Map<string, Transport[]>();
    for (const t of transports) byAt.set(key(t.from), [...(byAt.get(key(t.from)) ?? []), t]);
    const portals = transports.map(t => t.from);

    return {
        blockedDoors: acct => doors.filter(d => doorBlocks(d, acct)).map(d => ({ x: d.x, z: d.z, level: d.level })),
        route(from, to, acct) {
            const blocked: Tile[] = doors.filter(d => doorBlocks(d, acct)).map(d => ({ x: d.x, z: d.z, level: d.level }));
            const cache = new Map<string, number | null>();
            const walk = (a: Tile, b: Tile, tol: number) => {
                const k = `${key(a)}>${key(b)}`;
                if (!cache.has(k)) cache.set(k, opts.pathLength(a, b, blocked, tol));
                return cache.get(k)!;
            };
            // Lazy A*: a walk edge is first queued with a lower-bound cost (Chebyshev distance minus the
            // tolerance; a path can never be shorter). The real pathfinder runs only when that entry reaches
            // the front of the queue. Most far-away stairs are therefore never measured.
            const goal = key(to);
            // Underground areas share the level number but sit at z + 6400, and ladders link the two planes in a few
            // tiles. A straight-line bound across planes would overestimate by ~6400, so it is 0 there.
            const samePlane = (t: Tile) => t.level === to.level && Math.abs(t.z - to.z) <= 3200;
            const h = (t: Tile) => (samePlane(t) ? Math.max(0, cheb(t, to) - PORTAL_TOL) : 0);
            type Entry = { k: string; tile: Tile; g: number; f: number; prev: string | null; leg: Leg | null; from?: Tile; tol?: number };
            const heap = new MinHeap<Entry>(e => e.f);
            const done = new Set<string>();
            const via = new Map<string, { prev: string; leg: Leg }>();
            const best = new Map<string, number>();
            heap.push({ k: key(from), tile: from, g: 0, f: h(from), prev: null, leg: null });

            while (heap.size > 0) {
                const e = heap.pop()!;
                if (done.has(e.k)) continue;
                if (e.from) {
                    // Unverified walk: measure it now, then requeue with the real cost.
                    const c = walk(e.from, e.tile, e.tol!);
                    if (c === null) continue;
                    const g = (best.get(e.prev!) ?? 0) + c;
                    heap.push({ ...e, from: undefined, g, f: g + h(e.tile) });
                    continue;
                }
                done.add(e.k);
                best.set(e.k, e.g);
                if (e.prev !== null) via.set(e.k, { prev: e.prev, leg: e.leg! });
                if (e.k === goal) break;
                for (const t of byAt.get(e.k) ?? []) {
                    const v = key(t.to);
                    if (done.has(v)) continue;
                    const g = e.g + TRANSPORT_COST;
                    heap.push({ k: v, tile: t.to, g, f: g + h(t.to), prev: e.k, leg: { kind: 'transport', loc: t.locName, option: t.option, at: t.from, to: t.to, exact: t.exact } });
                }
                for (const p of [...portals, to]) {
                    const v = key(p);
                    if (p.level !== e.tile.level || done.has(v) || v === e.k || cheb(p, e.tile) > MAX_LEG) continue;
                    const tol = v === goal ? GOAL_TOL : PORTAL_TOL;
                    const g = e.g + Math.max(0, cheb(p, e.tile) - tol);
                    heap.push({ k: v, tile: p, g, f: g + h(p), prev: e.k, leg: { kind: 'walk', to: p }, from: e.tile, tol });
                }
            }
            if (!done.has(goal)) return { ok: false, reason: 'no_route' };
            const legs: Leg[] = [];
            for (let k = goal; k !== key(from); k = via.get(k)!.prev) legs.unshift(via.get(k)!.leg);
            return { ok: true, legs, cost: best.get(goal)! };
        },
    };
}
