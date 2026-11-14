import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {withDoorPolicy,accountForSdk,registerRouteActor} from './door-policy';
import type {TransportMeta,InteractionTarget} from '../../knowledge/src/transports';
import type {OpenDoorVariant} from '../../knowledge/src/doors';

export type Tile = { x: number; z: number; level: number };
export type Leg =
    | { kind: 'walk'; to: Tile;tolerance?:number }
    | ({ kind: 'transport'; loc: string; option: string; at: Tile; to: Tile; exact: boolean }&TransportMeta)
    | { kind: 'travel'; travel: Travel; at: Tile | null; to: Tile };
// The search does not carry coins spent along a route. It first lets each boat take one fare and keeps the route
// when its fares add up to the coins held (OreElse: 40 coins, one 30-coin boat off Karamja). Otherwise it
// searches again with a fare and one more held for every boat: an Ardougne to Port Sarim trip takes two boats.
const oneFare = (t: Travel, a: Account) => travelAllowed(t, a);
const fareAndOne = (t: Travel, a: Account) => travelAllowed(t, t.coins > 0 ? { ...a, coins: (a.coins ?? 0) - t.coins } : a);
export const routeFares = (legs: readonly Leg[]) => legs.reduce((n, l) => n + (l.kind === 'travel' ? l.travel.coins : 0), 0);
export interface Account { skills: Record<string, number>; varps: Record<string, number>; items: string[]; coins?: number; counts?: Record<string, number>; worn?:string[]; unlocks?:string[];questStages?:Record<string,number>;castlewarsTeam?:0|1;doorStates?:Record<string,boolean>;visibleLocs?:ReadonlyArray<Tile&{id:number}> }

export interface Transport extends TransportMeta { locName: string; option: string; from: Tile; to: Tile; exact: boolean; src: string; toSrc: string; handler: string }
export interface Door { id: number; loc: string; x: number; z: number; level: number; angle?:number; shape?:number;open?:OpenDoorVariant; kind: string; need?: { skill?: string; level?: number; varp?: string; item?: string;worn?:string;whenAxis?:boolean;minimum?:number;team?:0|1 }; trigger: string; src: string }
export type DoorBlock=Tile&{whenAxis?:boolean;angle?:number;shape?:number;blockrange?:boolean};

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
function transportLowerBounds(transports: Transport[], goal: Tile,relaxedRadius=PORTAL_TOL): Map<string, number> {
    const byKey = new Map<string, number>(), nodes: Tile[] = [], keys: string[] = [];
    const add = (tile: Tile) => {
        const k = key(tile), old = byKey.get(k);
        if (old !== undefined) return old;
        const i = nodes.length; byKey.set(k, i); nodes.push(tile); keys.push(k); return i;
    };
    add(goal);
    for (const t of transports) { add(entryOf(t)); add(t.to); }
    const incoming: number[][] = Array.from({ length: nodes.length }, () => []);
    const radii = new Float64Array(nodes.length).fill(PORTAL_TOL);
    for (const t of transports) {
        const from = byKey.get(key(entryOf(t)))!, to = byKey.get(key(t.to))!;
        incoming[to]!.push(from);
        radii[from] = Math.max(radii[from]!, t.interaction?.width ?? 1, t.interaction?.height ?? 1);
    }
    const best = new Float64Array(nodes.length).fill(Infinity); best[0] = 0;
    const queue = new MinHeap<{ index: number; cost: number }>(entry => entry.cost);
    queue.push({ index: 0, cost: 0 });
    const relax = (index: number, cost: number) => {
        if (cost >= best[index]!) return;
        best[index] = cost; queue.push({ index, cost });
    };
    while (queue.size) {
        const e = queue.pop()!;
        if (e.cost !== best[e.index]) continue;
        const tile = nodes[e.index]!, tolerance = e.index === 0 ? GOAL_TOL : Math.max(relaxedRadius, radii[e.index]!);
        for (let i = 0; i < nodes.length; i++) if (nodes[i]!.level === tile.level)
            relax(i, e.cost + Math.max(0, cheb(nodes[i]!, tile) - tolerance));
        for (const from of incoming[e.index]!) relax(from, e.cost + TRANSPORT_COST);
    }
    return new Map(keys.flatMap((k, i) => Number.isFinite(best[i]) ? [[k, best[i]!] as const] : []));
}

// Ordinary navigation may stop beside its goal; entry qualification requests the exact tile.
export function createWorld(opts: { transports?: Transport[]; doors?: Door[]; travel?: Travel[]; pathLength: PathLength; goalTolerance?: 0 | 1 }): World {
    // A stair with direct op2/op3 links (Climb-up / Climb-down) uses op1 for a "which way?" menu
    // (e.g. spiralstairsmiddle op1=Climb). Clicking op1 opens a dialog and never changes floor, so drop it.
    const raw=opts.transports??loadJson<Transport[]>('transports.json');
    const all=[...new Map(raw.map(canonicalTransport).filter((t):t is Transport=>t!==null).map(t=>[`${t.locName}:${t.option}:${key(t.from)}>${key(t.to)}:${JSON.stringify([t.requires,t.entry,t.landing])}`,t])).values()];
    const hasDirect = new Set(all.filter(t => t.option !== 'op1').map(t => `${t.locName}@${key(t.from)}`));
    const transports = all.filter(t => !t.unplaced&&!(t.option === 'op1' && hasDirect.has(`${t.locName}@${key(t.from)}`)));
    const doors = opts.doors ?? loadJson<Door[]>('doors.json');
    const incoming=new Map<string,{t:Transport;index:number}[]>();
    transports.forEach((t,index)=>incoming.set(key(t.to),[...incoming.get(key(t.to))??[],{t,index}]));
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
    const travelFrom=new Map<string,Travel[]>(),travelTo=new Map<string,Travel[]>();
    for(const t of fixed){travelFrom.set(key(t.from!),[...travelFrom.get(key(t.from!))??[],t]);travelTo.set(key(t.to),[...travelTo.get(key(t.to))??[],t]);}
    for(const t of anywhere)travelTo.set(key(t.to),[...travelTo.get(key(t.to))??[],t]);
    // For the heuristic only: fixed travel is a jump, so it lowers the bound like any transport.
    const jumps=fixed.map(t=>({from:t.from,to:t.to}) as Transport),jumpsBack=fixed.map(t=>({from:t.to,to:t.from}) as Transport);
    const waypoints=[...new Map([...transports.flatMap(t=>[entryOf(t),t.to]),...travel.flatMap(t=>t.from?[t.from,t.to]:[t.to])].map(p=>[key(p),p])).values()];
    const strictEntries=new Set(transports.filter(t=>t.entry).map(t=>key(t.entry!)));

    return {
        navigationGraph: () => ({transports,travel}),
        blockedDoors: acct => doors.filter(d => doorBlocks(d, acct)).map(doorBlock),
        routeGain: (a, b) => travel.some(t => travelAllowed(t, b) && !travelAllowed(t, a)) || doors.some(d => doorBlocks(d, a) && !doorBlocks(d, b)),
        route(from, to, acct, routeOpts) {
            const deadline=routeOpts?.deadline??Infinity;
            const tileKeys=new WeakMap<Tile,string>();
            const key=(tile:Tile)=>{let value=tileKeys.get(tile);if(value===undefined){value=`${tile.x},${tile.z},${tile.level}`;tileKeys.set(tile,value);}return value;};
            const blocked = doors.filter(d => doorBlocks(d, acct)).map(doorBlock);
            const search=(travelOk:(t:Travel,a:Account)=>boolean):ReturnType<World['route']>=>{
            const cache = new Map<string, number | null>();
            const walk = (a: Tile, b: Tile, tol: number,interaction?:InteractionTarget) => {
                const k = `${key(a)}>${key(b)}:${tol}:${interaction?JSON.stringify(interaction):''}`;
                if (!cache.has(k)) cache.set(k, opts.pathLength(a, b, blocked, tol,interaction));
                return cache.get(k)!;
            };
            // Each orientation is a complete lazy A* over the same directed graph.
            // Interleave path measurements; return only a settled goal or an empty
            // frontier, never the first meeting of two unfinished searches.
            const nodes=[...new Map([from,to,...waypoints].map(p=>[key(p),p])).values()];
            const radius=Math.max(PORTAL_TOL,...transports.flatMap(t=>[t.interaction?.width??1,t.interaction?.height??1]));
            const reversed=transports.map(t=>({...t,from:t.to,to:entryOf(t),entry:undefined,interaction:undefined}));
            const outgoing=new Map<string,{t:Transport;index:number}[]>();
            transports.forEach((t,index)=>outgoing.set(key(entryOf(t)),[...outgoing.get(key(entryOf(t)))??[],{t,index}]));
            const legOf=(t:Transport):Leg=>({kind:'transport',loc:t.locName,option:t.option,at:t.from,to:t.to,exact:t.exact,requires:t.requires,entry:t.entry,landing:t.landing,requireSrc:t.requireSrc,interaction:t.interaction});
            type Result=ReturnType<World['route']>;
            function* run(backward:boolean):Generator<void,Result,void>{
                const start=backward?to:from,finish=backward?from:to,goal=key(finish),root=key(start);
                const lower=transportLowerBounds(backward?[...reversed,...jumpsBack]:[...transports,...jumps],finish,radius);
                const h=(tile:Tile)=>lower.get(key(tile))??0;
                type Entry={k:string;tile:Tile;g:number;f:number;prev:string|null;leg:Leg|null;walkFrom?:Tile;walkTo?:Tile;tol?:number;approach?:Transport;interaction?:InteractionTarget};
                const heap=new MinHeap<Entry>(e=>e.f),done=new Set<string>(),via=new Map<string,{prev:string;leg:Leg}>(),best=new Map<string,number>();
                heap.push({k:root,tile:start,g:0,f:h(start),prev:null,leg:null});
                try {
                while(heap.size){
                    const e=heap.pop()!;
                    if(done.has(e.k))continue;
                    if(e.walkTo){
                        // Both orientations measure the original FORWARD edge,
                        // under the same synchronous policy and shared cache.
                        const c=walk(e.walkFrom!,e.walkTo,e.tol!,e.interaction);
                        if(c!==null){const g=best.get(e.prev!)!+c;heap.push({...e,leg:{kind:'walk',to:e.walkTo,tolerance:e.tol},walkTo:undefined,g,f:g+h(e.tile)});}
                        yield;
                        continue;
                    }
                    done.add(e.k);best.set(e.k,e.g);
                    if(e.prev!==null)via.set(e.k,{prev:e.prev,leg:e.leg!});
                    if(e.k===goal){
                        const legs:Leg[]=[];
                        for(let k=goal;k!==root;k=via.get(k)!.prev)legs.push(via.get(k)!.leg);
                        if(!backward)legs.reverse();
                        return {ok:true,legs,cost:e.g};
                    }
                    const enqueueTransport=(t:Transport,k:string,tile:Tile,approach?:Transport)=>{
                        if(done.has(k))return;
                        const g=e.g+TRANSPORT_COST;

                        heap.push({k,tile,g,f:g+h(tile),prev:e.k,leg:legOf(t),approach});
                    };
                    const enqueueWalk=(tile:Tile,k:string,target:Tile,tol:number,interaction?:InteractionTarget,approach?:Transport)=>{
                        const walkFrom=backward?tile:e.tile;
                        if(done.has(k)||k===e.k||walkFrom.level!==target.level||cheb(walkFrom,target)>MAX_LEG)return;
                        const g=e.g+Math.max(0,cheb(walkFrom,target)-tol);

                        heap.push({k,tile,g,f:g+h(tile),prev:e.k,leg:null,walkFrom,walkTo:target,tol,interaction,approach});
                    };
                    const enqueueTravel=(t:Travel,tile:Tile)=>{
                        const k=key(tile);if(done.has(k)||!travelOk(t,acct))return;
                        const g=e.g+t.cost;heap.push({k,tile,g,f:g+h(tile),prev:e.k,leg:{kind:'travel',travel:t,at:t.from,to:t.to}});
                    };
                    if(!e.approach){
                        if(!backward)for(const t of [...travelFrom.get(e.k)??[],...(e.k===root?anywhere:[])])enqueueTravel(t,t.to);
                        // Backward, a teleport's arrival leads back to the route start, where it is cast.
                        else for(const t of travelTo.get(e.k)??[])enqueueTravel(t,t.from??finish);
                    }
                    if(backward){
                        if(!e.approach)for(const {t,index} of incoming.get(e.k)??[]){
                            if(!transportAllowed(t,acct))continue;
                            const p=entryOf(t);enqueueTransport(t,key(p),p);
                            if(!t.entry&&t.interaction)enqueueTransport(t,`approach:${index}`,t.from,t);
                        }
                        const target=e.approach?.from??e.tile,q=e.approach?.interaction;
                        const tol=q?Math.max(PORTAL_TOL,q.width,q.height):e.k===key(to)&&!strictEntries.has(key(to))?(opts.goalTolerance??GOAL_TOL):0;
                        for(const p of nodes)enqueueWalk(p,key(p),target,tol,q);
                    }else{
                        if(e.approach){enqueueTransport(e.approach,key(e.approach.to),e.approach.to);continue;}
                        for(const {t} of outgoing.get(e.k)??[])if(transportAllowed(t,acct))enqueueTransport(t,key(t.to),t.to);
                        for(const target of nodes){const k=key(target),tol=k===key(to)&&!strictEntries.has(k)?(opts.goalTolerance??GOAL_TOL):0;enqueueWalk(target,k,target,tol);}
                        for(const [index,t] of transports.entries())if(!t.entry&&t.interaction&&transportAllowed(t,acct)){
                            const q=t.interaction;enqueueWalk(t.from,`approach:${index}`,t.from,Math.max(PORTAL_TOL,q.width,q.height),q,t);
                        }
                    }
                }
                return {ok:false,reason:'no_route'};
                } finally { heap.clear(); done.clear(); via.clear(); best.clear(); lower.clear(); }
            }
            const forward=run(false),backward=run(true);
            try { for(;;){
                if(performance.now()>deadline)return {ok:false,reason:'budget'};
                const a=forward.next();if(a.done)return a.value;
                const b=backward.next();if(b.done)return b.value;
            } } finally { forward.return({ok:false,reason:'no_route'}); backward.return({ok:false,reason:'no_route'}); cache.clear(); }
            };
            const fares=()=>{const r=search(oneFare);return r.ok&&routeFares(r.legs)<=(acct.coins??0)?r:search(fareAndOne);};
            const policed=()=>opts.pathLength.withPolicy?opts.pathLength.withPolicy(blocked,fares):fares();
            return opts.pathLength.withDanger?opts.pathLength.withDanger(acct,from,to,policed):policed();
        },
    };
}
