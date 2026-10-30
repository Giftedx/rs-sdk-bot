import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {withDoorPolicy,accountForSdk,registerRouteActor} from './door-policy';
import type {TransportMeta,InteractionTarget} from '../../knowledge/src/transports';
import type {OpenDoorVariant} from '../../knowledge/src/doors';

export type Tile = { x: number; z: number; level: number };
export type Leg =
    | { kind: 'walk'; to: Tile;tolerance?:number }
    | ({ kind: 'transport'; loc: string; option: string; at: Tile; to: Tile; exact: boolean }&TransportMeta)
    | { kind: 'boat'; boat: Boat; at: Tile; to: Tile };
// A paid ship between two docks. Talk to `npc` on the dock, pick `choices` in dialogue, land on `deck` (level 1),
// cross the gangplank (packages/core/src/boat.ts). Docks, NPCs and dialogue are the ones scripts/foodcourier.ts
// sails live. A boat avoids White Wolf Mountain, which kills low-level accounts (danger.ts).
export interface Boat { name: string; npc: string; choices: string[]; from: Tile; to: Tile; deck: { x: number; z: number }; fare: number }
const SAILOR = ['^yes please'], CUSTOMS = ['journey on this ship', 'search away', '^ok[.]?$'];
const ARDY_DOCK = { x: 2679, z: 3275, level: 0 }, BRIM_DOCK = { x: 2773, z: 3228, level: 0 }, MUSA_DOCK = { x: 2956, z: 3146, level: 0 }, SARIM_DOCK = { x: 3029, z: 3217, level: 0 };
export const BOATS: Boat[] = [
    { name: 'Ardougne to Brimhaven', npc: '^captain barnaby$', choices: SAILOR, from: ARDY_DOCK, to: BRIM_DOCK, deck: { x: 2775, z: 3234 }, fare: 30 },
    { name: 'Brimhaven to Ardougne', npc: '^customs officer$', choices: CUSTOMS, from: BRIM_DOCK, to: ARDY_DOCK, deck: { x: 2683, z: 3268 }, fare: 30 },
    { name: 'Musa Point to Port Sarim', npc: '^customs officer$', choices: CUSTOMS, from: MUSA_DOCK, to: SARIM_DOCK, deck: { x: 3032, z: 3217 }, fare: 30 },
    { name: 'Port Sarim to Musa Point', npc: '^(seaman|captain tobias)', choices: SAILOR, from: SARIM_DOCK, to: MUSA_DOCK, deck: { x: 2956, z: 3143 }, fare: 30 },
];
const BOAT_COST = 40; // estimate: talk, sail and cross the gangplank, in ticks
// Coins held must pay this fare and one more: an Ardougne to Port Sarim trip takes two boats.
export const boatAllowed = (b: Boat, a: Account) => (a.coins ?? 0) >= 2 * b.fare;
export interface Account { skills: Record<string, number>; varps: Record<string, number>; items: string[]; coins?: number; worn?:string[]; unlocks?:string[];questStages?:Record<string,number>;castlewarsTeam?:0|1;doorStates?:Record<string,boolean>;visibleLocs?:ReadonlyArray<Tile&{id:number}> }

export interface Transport extends TransportMeta { locName: string; option: string; from: Tile; to: Tile; exact: boolean; src: string; toSrc: string; handler: string }
export interface Door { id: number; loc: string; x: number; z: number; level: number; angle?:number; shape?:number;open?:OpenDoorVariant; kind: string; need?: { skill?: string; level?: number; varp?: string; item?: string;worn?:string;whenAxis?:boolean;minimum?:number;team?:0|1 }; trigger: string; src: string }
export type DoorBlock=Tile&{whenAxis?:boolean;angle?:number;shape?:number;blockrange?:boolean};

// Walk cost on one level, or null when the path cannot end within `tol` tiles of `to`. `blocked` are door
// tiles to keep shut. Stair and ladder tiles are objects, not floor, so they are reached from next to them.
export type PathLength = ((from: Tile, to: Tile, blocked: DoorBlock[], tol: number,interaction?:InteractionTarget) => number | null)&{withPolicy?<T>(blocked:DoorBlock[],query:()=>T):T;withDanger?<T>(acct:Account,from:Tile,to:Tile,query:()=>T):T};

const PORTAL_TOL = 2; // stairs can be 2x2 or larger
const GOAL_TOL = 1;

export interface World {
    route(from: Tile, to: Tile, acct: Account): { ok: true; legs: Leg[]; cost: number } | { ok: false; reason: 'no_route' };
    // Door tiles this account cannot pass (doorBlocks), for the walker to block in the SDK pathfinder too.
    blockedDoors(acct: Account): DoorBlock[];
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

// Only an observed value meeting a mined threshold admits quest gates.
export function doorBlocks(d: Door, a: Account): boolean {
    switch (d.kind) {
        case 'open': return false;
        case 'skill': return !(d.need?.skill && d.need.level !== undefined && (a.skills[d.need.skill] ?? 1) >= d.need.level && (!d.need.worn || a.worn?.includes(d.need.worn)));
        case 'key': return !(d.need?.item && a.items.includes(d.need.item));
        case 'team': return !(d.need?.team!==undefined&&(a.castlewarsTeam===d.need.team||a.doorStates?.[`${d.level},${d.x},${d.z}`]===true));
        case 'quest': return !(d.need?.varp && d.need.minimum!==undefined && (d.need.varp==='qp'?a.varps.qp:a.questStages?.[d.need.varp]??a.varps[d.need.varp])! >= d.need.minimum);
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
import { guardWalk } from './danger';
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
    const measure:PathLength=(from, to, blocked, tol,interaction) => {
        if (from.level !== to.level) return null;
        (pf as any).initPathfinding();
        if(!interaction&&tol===0&&key(from)!==key(to)&&!(pf as any).isTileWalkable(to.level,to.x,to.z))return null;
        // Different connected areas: no walk exists, and the search would scan the whole grid (components.ts).
        if(separated(mapAreas(pf,grid,repoRoot),from,to,tol,interaction,interaction&&((x,z)=>grid.reached(to.level,x,z,to.x,to.z,interaction.width,interaction.height,1,interaction.angle,interaction.shape,interaction.blockAccessFlags))))return null;
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
    // Ground of monsters that would kill this account is closed for the whole search (danger.ts).
    // Labels first: built under closed danger tiles they would carry one account's danger to every account.
    measure.withDanger=(acct,from,to,query)=>{mapAreas(pf,grid,repoRoot);return guardWalk(grid,acct,from,to,64,query);};
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
    const nodes = [...new Map([goal, ...transports.flatMap(t => [entryOf(t), t.to])].map(tile => [key(tile), tile])).values()];
    const incoming = new Map<string, Transport[]>();
    const radii=new Map<string,number>();for(const t of transports){const q=t.interaction,k=key(entryOf(t));radii.set(k,Math.max(radii.get(k)??PORTAL_TOL,q?.width??1,q?.height??1));}
    for (const t of transports) incoming.set(key(t.to), [...(incoming.get(key(t.to)) ?? []), t]);
    const best = new Map<string, number>([[key(goal), 0]]);
    const queue = new MinHeap<{ tile: Tile; cost: number }>(entry => entry.cost);
    queue.push({ tile: goal, cost: 0 });
    const relax = (tile: Tile, cost: number) => {
        if (cost >= (best.get(key(tile)) ?? Infinity)) return;
        best.set(key(tile), cost); queue.push({ tile, cost });
    };
    while (queue.size) {
        const entry = queue.pop()!;
        if (entry.cost !== best.get(key(entry.tile))) continue;
        const tolerance = key(entry.tile) === key(goal) ? GOAL_TOL : Math.max(relaxedRadius,radii.get(key(entry.tile))??PORTAL_TOL);
        for (const predecessor of nodes) if (predecessor.level === entry.tile.level)
            relax(predecessor, entry.cost + Math.max(0, cheb(predecessor, entry.tile) - tolerance));
        for (const edge of incoming.get(key(entry.tile)) ?? []) relax(entryOf(edge), entry.cost + TRANSPORT_COST);
    }
    return best;
}

// Ordinary navigation may stop beside its goal; entry qualification requests the exact tile.
export function createWorld(opts: { transports?: Transport[]; doors?: Door[]; boats?: Boat[]; pathLength: PathLength; goalTolerance?: 0 | 1 }): World {
    // A stair with direct op2/op3 links (Climb-up / Climb-down) uses op1 for a "which way?" menu
    // (e.g. spiralstairsmiddle op1=Climb). Clicking op1 opens a dialog and never changes floor, so drop it.
    const raw=opts.transports??loadJson<Transport[]>('transports.json');
    const all=[...new Map(raw.map(canonicalTransport).filter((t):t is Transport=>t!==null).map(t=>[`${t.locName}:${t.option}:${key(t.from)}>${key(t.to)}:${JSON.stringify([t.requires,t.entry,t.landing])}`,t])).values()];
    const hasDirect = new Set(all.filter(t => t.option !== 'op1').map(t => `${t.locName}@${key(t.from)}`));
    const transports = all.filter(t => !t.unplaced&&!(t.option === 'op1' && hasDirect.has(`${t.locName}@${key(t.from)}`)));
    const doors = opts.doors ?? loadJson<Door[]>('doors.json');
    const incoming=new Map<string,{t:Transport;index:number}[]>();
    transports.forEach((t,index)=>incoming.set(key(t.to),[...incoming.get(key(t.to))??[],{t,index}]));
    const boats=opts.boats??BOATS,boatsFrom=new Map<string,Boat[]>(),boatsTo=new Map<string,Boat[]>();
    for(const b of boats){boatsFrom.set(key(b.from),[...boatsFrom.get(key(b.from))??[],b]);boatsTo.set(key(b.to),[...boatsTo.get(key(b.to))??[],b]);}
    // For the heuristic only: a boat is a jump, so it lowers the bound like any transport.
    const boatJumps=boats.map(b=>({from:b.from,to:b.to}) as Transport),boatJumpsBack=boats.map(b=>({from:b.to,to:b.from}) as Transport);
    const waypoints=[...new Map([...transports.flatMap(t=>[entryOf(t),t.to]),...boats.flatMap(b=>[b.from,b.to])].map(p=>[key(p),p])).values()];
    const strictEntries=new Set(transports.filter(t=>t.entry).map(t=>key(t.entry!)));

    return {
        blockedDoors: acct => doors.filter(d => doorBlocks(d, acct)).map(doorBlock),
        route(from, to, acct) {
            const blocked = doors.filter(d => doorBlocks(d, acct)).map(doorBlock);
            const search=():ReturnType<World['route']>=>{
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
                const lower=transportLowerBounds(backward?[...reversed,...boatJumpsBack]:[...transports,...boatJumps],finish,radius);
                const h=(tile:Tile)=>lower.get(key(tile))??0;
                type Entry={k:string;tile:Tile;g:number;f:number;prev:string|null;leg:Leg|null;walkFrom?:Tile;walkTo?:Tile;tol?:number;approach?:Transport;interaction?:InteractionTarget};
                const heap=new MinHeap<Entry>(e=>e.f),done=new Set<string>(),via=new Map<string,{prev:string;leg:Leg}>(),best=new Map<string,number>();
                heap.push({k:root,tile:start,g:0,f:h(start),prev:null,leg:null});
                while(heap.size){
                    const e=heap.pop()!;
                    if(done.has(e.k))continue;
                    if(e.walkTo){
                        // Both orientations measure the original FORWARD edge,
                        // under the same synchronous policy and shared cache.
                        const c=walk(e.walkFrom!,e.walkTo,e.tol!,e.interaction);
                        if(c!==null){const g=best.get(e.prev!)!+c;heap.push({...e,walkTo:undefined,g,f:g+h(e.tile)});}
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
                        heap.push({k,tile,g,f:g+h(tile),prev:e.k,leg:{kind:'walk',to:target,tolerance:tol},walkFrom,walkTo:target,tol,interaction,approach});
                    };
                    const enqueueBoat=(b:Boat,tile:Tile)=>{
                        const k=key(tile);if(done.has(k)||!boatAllowed(b,acct))return;
                        const g=e.g+BOAT_COST;heap.push({k,tile,g,f:g+h(tile),prev:e.k,leg:{kind:'boat',boat:b,at:b.from,to:b.to}});
                    };
                    if(!e.approach)for(const b of (backward?boatsTo:boatsFrom).get(e.k)??[])enqueueBoat(b,backward?b.from:b.to);
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
            }
            const forward=run(false),backward=run(true);
            for(;;){
                const a=forward.next();if(a.done)return a.value;
                const b=backward.next();if(b.done)return b.value;
            }
            };
            const policed=()=>opts.pathLength.withPolicy?opts.pathLength.withPolicy(blocked,search):search();
            return opts.pathLength.withDanger?opts.pathLength.withDanger(acct,from,to,policed):policed();
        },
    };
}
