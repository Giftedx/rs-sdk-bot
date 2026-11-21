import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {withDoorPolicy,accountForSdk,registerRouteActor} from './door-policy';
import type {TransportMeta,InteractionTarget} from '../../knowledge/src/transports';
import type { Tile, Account, Door, DoorBlock } from './world-types';
export type { Tile, Account, Door, DoorBlock } from './world-types';
export type Leg =
    | { kind: 'walk'; to: Tile;tolerance?:number }
    | ({ kind: 'transport'; loc: string; option: string; at: Tile; to: Tile; exact: boolean }&TransportMeta)
    | { kind: 'travel'; travel: Travel; at: Tile | null; to: Tile };
export const routeFares = (legs: readonly Leg[]) => legs.reduce((n, l) => n + (l.kind === 'travel' ? l.travel.coins : 0), 0);

export interface Transport extends TransportMeta { locName: string; option: string; from: Tile; to: Tile; exact: boolean; src: string; toSrc: string; handler: string }

// Walk cost on one level, or null when the path cannot end within `tol` tiles of `to`. `blocked` are door
// tiles to keep shut. Stair and ladder tiles are objects, not floor, so they are reached from next to them.
// A search stops at its deadline (performance.now() ms) with reason 'budget': a cold search for a crossing the account
// cannot make, or a far shore, otherwise measures paths for hundreds of ticks while the bot stands still (938 ticks for
// Al Kharid to Tai Bwo Wannai on practice). The caller then tries its next source or fails fast.
export type RouteOptions = { deadline?: number };
export const ROUTE_BUDGET_MS = 45_000;
export type PathLength = ((from: Tile, to: Tile, blocked: DoorBlock[], tol: number,interaction?:InteractionTarget) => number | null)&{withPolicy?<T>(blocked:DoorBlock[],query:()=>T):T;withDanger?<T>(acct:Account,from:Tile,to:Tile,query:()=>T):T;walkable?(t:Tile):boolean;areaOf?(t:Tile):number};

const PORTAL_TOL = 2; // stairs can be 2x2 or larger
const GOAL_TOL = 1;

export interface World {
    navigationGraph?(): {transports: readonly Transport[]; travel: readonly Travel[]};
    route(from: Tile, to: Tile, acct: Account, opts?: RouteOptions): { ok: true; legs: Leg[]; cost: number } | { ok: false; reason: 'no_route' | 'budget' };
    // Set on the shared world (bot.ts getWorld): goTo plans in route-worker.ts so a long search never blocks the client.
    offThread?: boolean;
    // Door tiles this account cannot pass (doorBlocks), for the walker to block in the SDK pathfinder too.
    blockedDoors(acct: Account): DoorBlock[];
    // Whether account `b` may take a travel or pass a key door that account `a` may not. Routes read items and coins
    // only there (travelAllowed, doorBlocks), so with equal coins and no gain the two accounts have the same routes.
    routeGain?(a: Account, b: Account): boolean;
}

const TRANSPORT_COST = 3; // ticks to climb or descend, roughly
const MAX_LEG = 300; // walk legs longer than this (Chebyshev) are not tried
const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const key = (t: Tile) => `${t.x},${t.z},${t.level}`;
const cheb = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const entryOf=(t:Transport)=>t.entry??t.from;
export function transportAllowed(t:TransportMeta,a:Account):boolean {
    const r=t.requires;if(!r)return true;
    if(r.visibleLoc&&!a.visibleLocs?.some(l=>l.id===r.visibleLoc!.id&&key(l)===key(r.visibleLoc!)))return false;
    if(r.unlock&&!a.unlocks?.includes(r.unlock))return false;
    if(r.skill&&(a.skills[r.skill.name]??-1)<r.skill.level)return false;
    if(r.notOwnBanner){const b=r.notOwnBanner;if(a.castlewarsTeam!==undefined&&a.castlewarsTeam!==b.team)return true;if(!a.worn)return false;if(a.worn.includes(b.item))return false;}
    return true;
}

// Only a source-backed identical physical route can supersede a legacy literal.
export function canonicalTransport(t:Transport):Transport|null {
    const c=t.canonical;if(!c)return t;
    if(c.option!==t.option||c.exact!==t.exact||key(c.from)!==key(t.from)||key(c.to)!==key(t.to)||!c.interaction||c.id!==c.interaction.id||!c.handler||!c.src)return null;
    if(t.requires&&c.requires&&JSON.stringify(t.requires)!==JSON.stringify(c.requires))return null;
    return {...t,...c,requires:t.requires??c.requires,unplaced:undefined,canonical:undefined};
}
let transportAliases:Transport[]|undefined;
export function canonicalTransportLeg(leg:Extract<Leg,{kind:'transport'}>,aliases?:Transport[]):Extract<Leg,{kind:'transport'}>|null {
    const rows=aliases??(transportAliases??=loadJson<Transport[]>('transports.json').filter(t=>t.canonical));
    const old=rows.find(t=>t.locName===leg.loc&&t.option===leg.option&&key(t.from)===key(leg.at));
    if(!old)return leg;
    if(key(old.to)!==key(leg.to)||old.exact!==leg.exact)return null;
    const c=canonicalTransport(old);if(!c||c.unplaced)return null;
    if(leg.requires&&c.requires&&JSON.stringify(leg.requires)!==JSON.stringify(c.requires))return null;
    return {...leg,loc:c.locName,interaction:c.interaction,requires:leg.requires??c.requires,entry:c.entry,landing:c.landing,requireSrc:c.requireSrc};
}

// Only an observed value meeting a mined threshold admits quest gates. The SDK state has no varps, so a quest that the
// quest list shows complete (unlock complete:<varp>, guild-observation.ts completedQuestUnlocks) stands for its
// complete value while its stage is not observed: a gate whose threshold is at or below that value opens.
const questGateValue = (varp: string, a: Account): number | undefined => {
    const seen = varp === 'qp' ? a.varps.qp : a.questStages?.[varp] ?? a.varps[varp];
    return seen ?? (a.unlocks?.includes(`complete:${varp}`) ? questCompleteValue(varp) : undefined);
};
export function doorBlocks(d: Door, a: Account): boolean {
    switch (d.kind) {
        case 'open': return false;
        case 'skill': return !(d.need?.skill && d.need.level !== undefined && (a.skills[d.need.skill] ?? 1) >= d.need.level && (!d.need.worn || a.worn?.includes(d.need.worn)));
        case 'key': return !(d.need?.item && a.items.includes(d.need.item));
        case 'team': return !(d.need?.team!==undefined&&(a.castlewarsTeam===d.need.team||a.doorStates?.[`${d.level},${d.x},${d.z}`]===true));
        case 'quest': return !(d.need?.varp && d.need.minimum!==undefined && (questGateValue(d.need.varp, a) ?? -Infinity) >= d.need.minimum);
        default: return true;
    }
}

let knownDoorFacts: Door[] | null = null;
// Same account policy as the route planner, bounded to the current same-floor leg plus32tiles.
// This loader does not initialize the pathfinder or construct the transport graph.
export function blockedDoorsNear(from: Tile, to: Tile, acct: Account, doors?: readonly Door[]): DoorBlock[] {
    if (from.level !== to.level) return [];
    const minX = Math.min(from.x, to.x) - 32, maxX = Math.max(from.x, to.x) + 32;
    const minZ = Math.min(from.z, to.z) - 32, maxZ = Math.max(from.z, to.z) + 32;
    const facts = doors ?? (knownDoorFacts ??= loadJson<Door[]>('doors.json'));
    return facts.filter(d => d.level === from.level && d.x >= minX && d.x <= maxX && d.z >= minZ && d.z <= maxZ && doorBlocks(d, acct))
        .map(doorBlock);
}
export function doorBlock(d:Door):DoorBlock {
    return {x:d.x,z:d.z,level:d.level,...(d.need?.whenAxis!==undefined&&Number.isInteger(d.angle)&&d.shape===0?{whenAxis:d.need.whenAxis,angle:d.angle}:{})};
}

let rsPath: { findLongPath: Function; getDoorAt: Function } | null = null;
let activePathPolicy:{owner:object;blocked:DoorBlock[]}|null=null;
const policySdks=new WeakSet<object>();
export async function installDoorPolicy(sdk:any,client?:unknown):Promise<void>{
    registerRouteActor(sdk,client);
    if(typeof sdk?.findPath!=='function'||policySdks.has(sdk))return;
    const pf=await loadPathfinding();
    const grid=await import('../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
    if(policySdks.has(sdk))return;
    const original=sdk.findPath;
    sdk.findPath=function(x:number,z:number,...args:unknown[]){
        const state=sdk.getState(),p=state?.player;
        if(!p)return original.call(sdk,x,z,...args);
        (pf as any).initPathfinding();
        const from={x:p.worldX,z:p.worldZ,level:p.level};
        const blocks=blockedDoorsNear(from,{x,z,level:p.level},accountForSdk(sdk))
            .map(b=>b.whenAxis===undefined?{...b,...pf.getDoorAt(b.level,b.x,b.z)}:b);
        return guardWalk(grid,accountForSdk(sdk),from,{x,z,level:p.level},32,()=>withDoorPolicy(grid,blocks,()=>original.call(sdk,x,z,...args)));
    };
    policySdks.add(sdk);
}
import { mapAreas, separated } from './components';
import { activeDanger, guardRoute, guardWalk } from './danger';
import { crossingTravel, loadCrossings, loadTravel, questCompleteValue, travelAllowed, type Travel } from './travel';
import { legCache, routeDangerHash } from './leg-cache';
async function loadPathfinding() {
    if (!rsPath) rsPath = await import(join(repoRoot, 'vendor', 'rs-sdk', 'sdk', 'pathfinding.ts'));
    return rsPath!;
}

// Default walk cost: rs-sdk findLongPath turn points, summed as Chebyshev steps. Null if the path stops short.
export async function rsPathLength(): Promise<PathLength> {
    const pf = await loadPathfinding();
    const grid=await import('../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
    const owner={};
    const scoped=<T>(blocked:DoorBlock[],query:()=>T):T=>{
        if(activePathPolicy?.owner===owner&&activePathPolicy.blocked===blocked)return query();
        if(activePathPolicy)throw Error('A different route policy cannot nest inside an active query');
        (pf as any).initPathfinding();
        const policy=blocked.map(b=>b.whenAxis===undefined?{...b,...pf.getDoorAt(b.level,b.x,b.z)}:b);
        return withDoorPolicy(grid,policy,()=>{activePathPolicy={owner,blocked};try{return query();}finally{activePathPolicy=null;}});
    };
    // Searched legs are kept on disk (leg-cache.ts) under hashes of the doors kept shut and the danger key. A leg
    // the cheap checks refuse is not stored: refusing it again costs less than reading it back.
    const cache=legCache(),policyKeys=new WeakMap<DoorBlock[],string>(),dangerKeys=new WeakMap<object,string>();
    const measure:PathLength=(from, to, blocked, tol,interaction) => {
        if (from.level !== to.level) return null;
        (pf as any).initPathfinding();
        if(!interaction&&tol===0&&key(from)!==key(to)&&!(pf as any).isTileWalkable(to.level,to.x,to.z))return null;
        // Different connected areas: no walk exists, and the search would scan the whole grid (components.ts).
        if(separated(mapAreas(pf,grid,repoRoot),from,to,tol,interaction,interaction&&((x,z)=>grid.reached(to.level,x,z,to.x,to.z,interaction.width,interaction.height,1,interaction.angle,interaction.shape,interaction.blockAccessFlags))))return null;
        const d=activeDanger(),shut=policyKeys.get(blocked)??(policyKeys.set(blocked,cache.hash(blocked)),policyKeys.get(blocked)!);
        const dk=d?dangerKeys.get(d)??(dangerKeys.set(d,routeDangerHash(d,cache)),dangerKeys.get(d)!):'-';
        const k=`kept:${shut}${dk}${key(from)}>${key(to)}:${tol}${interaction?':'+cache.hash(interaction):''}`;
        const cached=cache.get(k);
        if(cached!==undefined)return cached;
        const v=measureNow(from,to,blocked,tol,interaction);
        cache.set(k,v);
        return v;
    };
    const measureNow=(from:Tile, to:Tile, blocked:DoorBlock[], tol:number,interaction?:InteractionTarget):number|null => {
        const pts:Tile[]|null=scoped(blocked,()=>{
            if(!interaction)return pf.findLongPath(from.level,from.x,from.z,to.x,to.z,500);
            const q=interaction;
            if(grid.reached(from.level,from.x,from.z,to.x,to.z,q.width,q.height,1,q.angle,q.shape,q.blockAccessFlags))return [];
            const raw=grid.findLongPath(from.level,from.x,from.z,to.x,to.z,1,q.width,q.height,q.angle,q.shape,false,q.blockAccessFlags,500,grid.CollisionType.NORMAL);
            const path=Array.from(raw,p=>({x:(p>>>14)&0x3fff,z:p&0x3fff,level:(p>>>28)&3}));
            const end=path.at(-1)??from;
            return grid.reached(from.level,end.x,end.z,to.x,to.z,q.width,q.height,1,q.angle,q.shape,q.blockAccessFlags)?path:null;
        });
        if(pts===null)return null;
        if(interaction){let len=0,prev=from;for(const p of pts){len+=cheb(prev,p);prev=p;}return len;}
        if (pts.length === 0) return cheb(from, to) <= tol ? 0 : null;
        const last = pts[pts.length - 1]!;
        if (cheb(last, to) > tol) return null;
        let len = 0;
        let prev = from;
        for (const p of pts) { len += cheb(prev, p); prev = p; }
        return len;
    };
    measure.withPolicy=scoped;
    measure.walkable=t=>{(pf as any).initPathfinding();return (pf as any).isTileWalkable(t.level,t.x,t.z);};
    measure.areaOf=t=>mapAreas(pf,grid,repoRoot).area(t.level,t.x,t.z);
    // Ground of monsters that would kill this account is closed for the whole search (danger.ts).
    // Labels first: built under closed danger tiles they would carry one account's danger to every account.
    measure.withDanger=(acct,from,to,query)=>{mapAreas(pf,grid,repoRoot);try{return guardRoute(grid,acct,[from,to],query);}finally{cache.save();}};
    return measure;
}

// Finds the operable face of the exact placed transport, with the same native
// reach semantics and current account policy as its route cost. No grid mask
// stays active while the caller awaits movement.
export async function interactionApproach(sdk:any,at:Tile,q:InteractionTarget):Promise<Tile|null>{
    const pf=await loadPathfinding(),grid=await import('../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
    const state=sdk.getState(),p=state?.player;
    if(!p||p.level!==at.level||!state.nearbyLocs?.some((l:any)=>l.id===q.id&&l.x===at.x&&l.z===at.z&&l.level===at.level))return null;
    (pf as any).initPathfinding();
    const acct=accountForSdk(sdk),facts=knownDoorFacts??=loadJson<Door[]>('doors.json');
    const blocked=facts.filter(d=>doorBlocks(d,acct)).map(doorBlock).map(b=>b.whenAxis===undefined?{...b,...pf.getDoorAt(b.level,b.x,b.z)}:b);
    return withDoorPolicy(grid,blocked,()=>{
        const from={x:p.worldX,z:p.worldZ,level:p.level},reached=(t:Tile)=>grid.reached(t.level,t.x,t.z,at.x,at.z,q.width,q.height,1,q.angle,q.shape,q.blockAccessFlags);
        if(reached(from))return from;
        const path=grid.findLongPath(from.level,from.x,from.z,at.x,at.z,1,q.width,q.height,q.angle,q.shape,false,q.blockAccessFlags,500,grid.CollisionType.NORMAL);
        if(!path.length)return null;
        const packed=path[path.length-1]!,end={x:(packed>>>14)&0x3fff,z:packed&0x3fff,level:(packed>>>28)&3};
        return reached(end)?end:null;
    });
}

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

// A direct-distance goal heuristic is not a lower bound when a transport can
// jump toward the goal. Settle a relaxed portal graph by accumulated cost
// (OlZe PathfinderDijkstra). Collision-free walk costs only underestimate the
// real walks, retaining lazy path measurements without pruning cheap detours.
type LevelBuckets = {
    ids: Int32Array[];
    xs: Int32Array[];
    zs: Int32Array[];
};

function bucketByLevel<T>(items: readonly T[], getTile: (item: T) => Tile, getId: (item: T) => number): LevelBuckets {
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

function lowerBoundX(xs: Int32Array, target: number): number {
    let lo = 0, hi = xs.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (xs[mid]! < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function upperBoundX(xs: Int32Array, target: number): number {
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

type LowerBoundGraph = {
    nodeCount: number;
    xs: Int32Array;
    zs: Int32Array;
    levels: Int8Array;
    radii: Float64Array;
    incoming: Int32Array[];
    levelNodes: Int32Array[];
};

function buildLowerBoundGraph(
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
        const from = waypointIndex.get(key(entryOf(t)))!, to = waypointIndex.get(key(t.to))!;
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
function solveLowerBounds(graph: LowerBoundGraph, goalBoundIdx: number, goalTile: Tile, relaxedRadius: number): Float64Array {
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

// Ordinary navigation may stop beside its goal; entry qualification requests the exact tile.
type WorldOptions = { transports?: Transport[]; doors?: Door[]; travel?: Travel[]; pathLength: PathLength; goalTolerance?: 0 | 1 };

// The route graph (waypoint tables, lower-bound graphs, approach tables: about 405 MB of RSS and 3.19 million objects, with the collision grid that its travel snap makes the SDK build) builds on the
// first route(), navigationGraph() or routeGain() call. A process that plans its trips off the main thread
// (bot.ts getWorld: offThread) and only asks for the doors that an account cannot pass never builds it.
export function createWorld(opts: WorldOptions): World {
    let doors: Door[] | undefined = opts.doors, full: World | undefined;
    const doorList = () => doors ??= loadJson<Door[]>('doors.json');
    const built = () => full ??= buildWorld({ ...opts, doors: doorList() });
    return {
        navigationGraph: () => built().navigationGraph!(),
        blockedDoors: acct => doorList().filter(d => doorBlocks(d, acct)).map(doorBlock),
        routeGain: (a, b) => built().routeGain!(a, b),
        route: (from, to, acct, routeOpts) => built().route(from, to, acct, routeOpts),
    };
}

function buildWorld(opts: WorldOptions): World {
    // A stair with direct op2/op3 links (Climb-up / Climb-down) uses op1 for a "which way?" menu
    // (e.g. spiralstairsmiddle op1=Climb). Clicking op1 opens a dialog and never changes floor, so drop it.
    const raw=opts.transports??loadJson<Transport[]>('transports.json');
    const all=[...new Map(raw.map(canonicalTransport).filter((t):t is Transport=>t!==null).map(t=>[`${t.locName}:${t.option}:${key(t.from)}>${key(t.to)}:${JSON.stringify([t.requires,t.entry,t.landing])}`,t])).values()];
    const hasDirect = new Set(all.filter(t => t.option !== 'op1').map(t => `${t.locName}@${key(t.from)}`));
    const transports = all.filter(t => !t.unplaced&&!(t.option === 'op1' && hasDirect.has(`${t.locName}@${key(t.from)}`)));
    const doors = opts.doors ?? loadJson<Door[]>('doors.json');
    // Travel with a start tile is an edge between two nodes; travel from anywhere (a teleport) leaves the route start.
    // An NPC's spawn or a computed shore tile can sit on a blocked tile; use the nearest walkable one within 3.
    const snap=(t:Tile):Tile=>{
        const ok=opts.pathLength.walkable;if(!ok||ok(t))return t;
        for(let r=1;r<=3;r++)for(let dx=-r;dx<=r;dx++)for(let dz=-r;dz<=r;dz++)if(Math.max(Math.abs(dx),Math.abs(dz))===r&&ok({...t,x:t.x+dx,z:t.z+dz}))return {...t,x:t.x+dx,z:t.z+dz};
        return t;
    };
    // A world given its own transports (a test) gets no default travel; the real world loads all of it.
    const real=!opts.travel&&!opts.transports&&opts.pathLength.areaOf;
    const travel=(opts.travel??(opts.transports?[]:[...loadTravel(),...(real?crossingTravel(loadCrossings(),opts.pathLength.areaOf!):[])])).map(t=>({...t,from:t.from&&snap(t.from),to:snap(t.to)})),fixed=travel.filter(t=>t.from),anywhere=travel.filter(t=>!t.from);

    // Dense waypoint table indexed once per world to eliminate per-route graph and key allocations.
    const waypointIndex = new Map<string, number>();
    const waypoints: Tile[] = [];
    const addWaypoint = (t: Tile): number => {
        const k = key(t);
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

    type OutEdge = { t: Transport; index: number; toIdx: number; leg: Leg };
    type InEdge = { t: Transport; index: number; fromIdx: number; leg: Leg; entryTile: Tile; fromTile: Tile };
    const outgoingByIdx: OutEdge[][] = Array.from({ length: W }, () => []);
    const incomingByIdx: InEdge[][] = Array.from({ length: W }, () => []);
    const transportFromIdx = new Int32Array(transports.length);
    const transportToIdx = new Int32Array(transports.length);
    const strictMask = new Uint8Array(W);
    for (let index = 0; index < transports.length; index++) {
        const t = transports[index]!;
        const entryTile = entryOf(t);
        const entryIdx = waypointIndex.get(key(entryTile))!;
        const rawFromIdx = waypointIndex.get(key(t.from)) ?? entryIdx;
        const toIdx = waypointIndex.get(key(t.to))!;
        const leg = legByTransport[index]!;
        transportFromIdx[index] = rawFromIdx;
        transportToIdx[index] = toIdx;
        outgoingByIdx[entryIdx]!.push({ t, index, toIdx, leg });
        incomingByIdx[toIdx]!.push({ t, index, fromIdx: entryIdx, leg, entryTile, fromTile: t.from });
        if (t.entry) strictMask[waypointIndex.get(key(t.entry))!] = 1;
    }

    type FwdTravel = { t: Travel; toIdx: number };
    type BwdTravel = { t: Travel; fromIdx: number };
    const travelFromByIdx: FwdTravel[][] = Array.from({ length: W }, () => []);
    const travelToByIdx: BwdTravel[][] = Array.from({ length: W }, () => []);
    const anywhereIndexed: FwdTravel[] = [];
    for (let i = 0; i < fixed.length; i++) {
        const t = fixed[i]!;
        const fromIdx = waypointIndex.get(key(t.from!))!;
        const toIdx = waypointIndex.get(key(t.to))!;
        travelFromByIdx[fromIdx]!.push({ t, toIdx });
        travelToByIdx[toIdx]!.push({ t, fromIdx });
    }
    for (const t of anywhere) {
        const toIdx = waypointIndex.get(key(t.to))!;
        anywhereIndexed.push({ t, toIdx });
        travelToByIdx[toIdx]!.push({ t, fromIdx: -1 });
    }

    const levelNodes = bucketByLevel(waypoints.map((tile, idx) => ({ tile, idx })), e => e.tile, e => e.idx);
    type ApproachTransport = {
        t: Transport; index: number; fromIdx: number; toIdx: number; tol: number;
        q: InteractionTarget; leg: Leg; endAreas?: number[] | null;
    };
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
    const areasDisjoint = (a: number[] | null, b: number[] | null): boolean => {
        if (!a || !b || a.length === 0 || b.length === 0) return false;
        if (a.length === 1 && b.length === 1) return a[0] !== b[0];
        for (let i = 0; i < a.length; i++) if (b.includes(a[i]!)) return false;
        return true;
    };

    return {
        navigationGraph: () => ({transports,travel}),
        blockedDoors: acct => doors.filter(d => doorBlocks(d, acct)).map(doorBlock),
        routeGain: (a, b) => travel.some(t => travelAllowed(t, b) && !travelAllowed(t, a)) || doors.some(d => doorBlocks(d, a) && !doorBlocks(d, b)),
        route(from, to, acct, routeOpts) {
            const deadline = routeOpts?.deadline ?? Infinity;
            const fromKey = key(from), toKey = key(to);
            const fromExisting = waypointIndex.get(fromKey);
            const toExisting = waypointIndex.get(toKey);
            const dynTiles: Tile[] = [];
            const dynStartAreas: (number[] | null | undefined)[] = [];
            const dynEnd0Areas: (number[] | null | undefined)[] = [];
            const dynEnd1Areas: (number[] | null | undefined)[] = [];
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
            const nodeTile = (idx: number): Tile => idx < W ? waypoints[idx]! : dynTiles[idx - W]!;

            const startAreasOf = (idx: number): number[] | null => {
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
            };
            const endAreasOf = (idx: number, tol: number, q?: InteractionTarget, app?: ApproachTransport): number[] | null => {
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
            };

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

                type Entry = {
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
                const heap = new MinHeap<Entry>(e => e.f);
                // Fast flat arrays when trackFares is false (only fare=0 exists), numeric state ids when fares vary.
                const doneFast = trackFares ? null : new Uint8Array(totalStates);
                const bestFast = trackFares ? null : new Float64Array(totalStates);
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
                        // Both orientations measure the original FORWARD edge,
                        // under the same synchronous policy and shared cache.
                        const c = walk(e.walkFromIdx!, e.walkFromTile!, e.walkToIdx!, e.walkToTile, e.tol!, e.interaction, e.qId);
                        if (c !== null) {
                            const prevBest = trackFares ? bestMap!.get(e.prev)! : bestFast![e.prev]!;
                            const g = prevBest + c;
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
                        heap.push({
                            nodeIdx: nextNodeIdx, stateBase: nextStateBase, id, fare: e.fare,
                            tile: nextTile, g, f: g + h(nextNodeIdx), prev: e.id, leg, approach, approachIdx,
                        });
                    };
                    const enqueueWalk = (
                        nextNodeIdx: number, nextStateBase: number, nextTile: Tile,
                        targetIdx: number, targetTile: Tile, tol: number,
                        interaction?: InteractionTarget, qId = -1, appObj?: ApproachTransport, approach?: Transport,
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
                        if (areaOf) {
                            const sA = startAreasOf(wFromIdx);
                            const eA = endAreasOf(targetIdx, tol, interaction, appObj);
                            if (areasDisjoint(sA, eA)) return;
                        }
                        const rem = dist - tol;
                        const g = e.g + (rem > 0 ? rem : 0);
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
                        const allowed = e.fare ? travelAllowed(t, { ...acct, coins: (acct.coins ?? 0) - e.fare }) : travelZeroOk.get(t)!;
                        if (!allowed) return;
                        const g = e.g + t.cost;
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
                        if (eLvl >= 0 && eLvl < 4) {
                            const xs = levelNodes.xs[eLvl]!, zs = levelNodes.zs[eLvl]!, ids = levelNodes.ids[eLvl]!;
                            const lo = lowerBoundX(xs, targetTile.x - MAX_LEG), hi = upperBoundX(xs, targetTile.x + MAX_LEG);
                            for (let k = lo; k < hi; k++) {
                                if (Math.abs(zs[k]! - targetTile.z) > MAX_LEG) continue;
                                const pIdx = ids[k]!;
                                enqueueWalk(pIdx, pIdx, waypoints[pIdx]!, targetIdx, targetTile, tol, q, qId);
                            }
                        }
                        for (let d = 0; d < dynTiles.length; d++) {
                            const pIdx = W + d;
                            enqueueWalk(pIdx, pIdx, dynTiles[d]!, targetIdx, targetTile, tol, q, qId);
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
                        if (eLvl >= 0 && eLvl < 4) {
                            const xs = levelNodes.xs[eLvl]!, zs = levelNodes.zs[eLvl]!, ids = levelNodes.ids[eLvl]!;
                            const lo = lowerBoundX(xs, e.tile.x - MAX_LEG), hi = upperBoundX(xs, e.tile.x + MAX_LEG);
                            for (let k = lo; k < hi; k++) {
                                if (Math.abs(zs[k]! - e.tile.z) > MAX_LEG) continue;
                                const tIdx = ids[k]!;
                                const tol = tIdx === toIdx && !strictTo ? goalTol : 0;
                                enqueueWalk(tIdx, tIdx, waypoints[tIdx]!, tIdx, waypoints[tIdx]!, tol);
                            }
                            const appList = approachesByLevel[eLvl]!, appXs = approachLevelXs[eLvl]!;
                            const aLo = lowerBoundX(appXs, e.tile.x - MAX_LEG), aHi = upperBoundX(appXs, e.tile.x + MAX_LEG);
                            for (let k = aLo; k < aHi; k++) {
                                const app = appList[k]!;
                                if (!allowedT[app.index] || Math.abs(app.t.from.z - e.tile.z) > MAX_LEG) continue;
                                enqueueWalk(app.fromIdx, approachOffset + app.index, app.t.from, app.fromIdx, app.t.from, app.tol, app.q, app.index, app, app.t);
                            }
                        }
                        for (let d = 0; d < dynTiles.length; d++) {
                            const tIdx = W + d, tTile = dynTiles[d]!;
                            const tol = tIdx === toIdx && !strictTo ? goalTol : 0;
                            enqueueWalk(tIdx, tIdx, tTile, tIdx, tTile, tol);
                        }
                    }
                }
                return {ok:false,reason:'no_route'};
                } finally { heap.clear(); doneMap?.clear(); viaMap?.clear(); bestMap?.clear(); settledMap?.clear(); }
            }
            const forward=run(false),backward=run(true);
            try { for(;;){
                if(performance.now()>deadline)return {ok:false,reason:'budget'};
                const a=forward.next();if(a.done)return a.value;
                const b=backward.next();if(b.done)return b.value;
            } } finally { forward.return({ok:false,reason:'no_route'}); backward.return({ok:false,reason:'no_route'}); numCache.clear(); strCache.clear(); }
            };
            // An affordable unconstrained optimum is also the affordable optimum.
            // Keep one state per tile in that common case; only an unfunded result
            // needs the cost/fare frontier. Both passes share the route's deadline.
            const funded=()=>{const r=search(false);return !r.ok||routeFares(r.legs)<=(acct.coins??0)?r:search(true);};
            const policed=()=>opts.pathLength.withPolicy?opts.pathLength.withPolicy(blocked,funded):funded();
            return opts.pathLength.withDanger?opts.pathLength.withDanger(acct,from,to,policed):policed();
        },
    };
}
