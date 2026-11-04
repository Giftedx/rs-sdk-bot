import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {RouteGate} from './transport-requirements';

// Travel between activities on the Haggis clock.
//
// Every activity has a place (`at`, and `endAt` when it ends somewhere else). The scheduler adds the run ticks from
// the player's place to the next activity's place. Two special places: 'anywhere' (inventory work or helper trades,
// the player stays where it is) and 'bank' (the bank nearest to the player's place).
//
// Leg price, in this order:
//   1. world.json nearest.bank runTicks (UberMouse world.json, format 21) for a place with a world.json site.
//   2. A path leg from the cache haggis-travel.json, made by travel-gen.ts with the rs-sdk pathfinder
//      (vendor/rs-sdk/sdk/pathfinding.ts findLongPath): run ticks = path tiles / 2.
//   3. Else an estimate: Chebyshev distance x RUN_TICKS_PER_TILE (fit on 1,087 world.json nearest.bank legs).
// Each leg then adds START_TICKS (the first click shows in the state after 2 ticks, research/walking.md cause 5).
// A place on an island (Karamja, Entrana) is reached through its port: walk to the port, boat, walk on.
//
// Running covers 2 tiles per tick (research/walking.md: measured legs are tiles / 2 + 1 to 6 ticks). The model is
// deterministic: the cache is a committed file; nothing here runs a pathfinder.

export const START_TICKS = 2;
// Median of runTicks / Chebyshev distance over 1,087 world.json nearest.bank legs (level 0, no requirements,
// 20-300 tiles); the least-squares slope is 0.584. ESTIMATE.
export const RUN_TICKS_PER_TILE = 0.6;

export interface Island { id: string; port: string; landing: string; boatTicks: number; source: string }
export interface Place {
    x: number; z: number; level?: number;
    site?: string; // world.json site id
    island?: Island;
    note?: string;
}
export interface Leg { ticks: number; method: 'same' | 'world.json' | 'path' | 'estimate' | 'boat' | 'bank-trip'; detail?: string;gates?:RouteGate[] }
export type CachedPathLeg={runTicks:number;tiles:number;toll?:number;locked?:string[];gates?:RouteGate[]};
export interface TravelCache {
    generatedFrom?: string;
    // Older caches sort ids. New directed caches contain each measured direction.
    directed?:true;
    legs: Record<string,CachedPathLeg>;
    // world.json nearest.bank of a place with a site, and the bank tile.
    nearestBank: Record<string, { bank: string; runTicks: number; method: 'world.json' | 'path';gates?:RouteGate[] }>;
    banks: Record<string, Place>;
    // Pathfinder run ticks for MEASURED_LEGS (calibration only).
    calibration?: Record<string, { runTicks: number; tiles: number }>;
}
export interface TravelModel { places: Record<string, Place>; cache: TravelCache; start?: string }

export const ANYWHERE = 'anywhere';
export const BANK = 'bank';

// Reuse the east road and Lumbridge toll approach. These are corridor
// points, not a measured speed claim.
// Each segment still uses sessionWalker collision/door planning. Avoid the
// Varrock south wizard circle and the Al Kharid mine/scorpions.
// Varrock East bank to the west side of the Al Kharid toll gate.
const TOLL_CORRIDOR=[
    // m51_52.jm2 places giant rats at 3292,3377 and a bear at 3296,3347.
    // Stay east of their spawns, then cross west below the mine.
    [3290,3404],[3308,3404],[3308,3370],[3308,3330],[3265,3330],[3255,3330],
    // South past the cow field, east of the giant spiders' reach (SPIDER_REACH).
    [3262,3250],[3262,3232],[3266,3227],
].map(([x,z])=>({x:x!,z:z!}));
// m50_50.jm2 giant spiders (npc 59) at 3243,3236 and 3245,3232: huntmode=cowardly attacks a player of
// combat level 4 or lower from 1 tile, and wanderrange=10 lets them stand anywhere in this box.
export const SPIDER_REACH={minX:3233,maxX:3255,minZ:3222,maxZ:3246,huntRange:1};
const nearBank=(p:{worldX:number;worldZ:number;level:number},x:number,z:number)=>p.level===0&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=5;

export function smeltEntryRoute(p:{worldX:number;worldZ:number;level:number}) {
    if(nearBank(p,3269,3167))return {name:'al-kharid-bank',fare:0,points:[] as {x:number;z:number}[]};
    if(!nearBank(p,3253,3420))throw Error('smelt entry requires Varrock East or Al Kharid bank');
    return {name:'varrock-east-toll',fare:10,points:TOLL_CORRIDOR.map(t=>({...t}))};
}

// Anvil staging: Varrock West bank and the smithy anvils (m49_53.jm2 loc 2783 at 3188,3421/3424/3426),
// the pair scripts/measure/floor-smithing.ts uses. Al Kharid has no anvil. From Al Kharid the route reverses
// the toll corridor: the east-side guard (borderguard2, npc 926) passes the player to 3267,3227.
export const SMITH_BANK={x:3185,z:3436},SMITH_ANVIL={x:3189,z:3422};
export function smithStageRoute(p:{worldX:number;worldZ:number;level:number}) {
    const tiles=(a:number[][])=>a.map(([x,z])=>({x:x!,z:z!}));
    if(nearBank(p,SMITH_BANK.x,SMITH_BANK.z))return {name:'varrock-west-bank',fare:0,toll:[] as {x:number;z:number}[],points:[] as {x:number;z:number}[]};
    if(nearBank(p,3253,3420))return {name:'varrock-east-walk',fare:0,toll:[] as {x:number;z:number}[],points:tiles([[3254,3428],[SMITH_BANK.x,SMITH_BANK.z]])};
    if(!nearBank(p,3269,3167))throw Error('smith staging requires Al Kharid, Varrock East or Varrock West bank');
    return {name:'al-kharid-toll',fare:10,
        // The smelt destination corridor, reversed, to the east side of the gate.
        toll:tiles([[3273,3194],[3275,3212],[3272,3227]]),
        points:[...TOLL_CORRIDOR.slice(0,-1).reverse().map(t=>({...t})),...tiles([[3254,3428],[SMITH_BANK.x,SMITH_BANK.z]])]};
}

const key = (a: string, b: string) => (a < b ? `${a}>${b}` : `${b}>${a}`);
const cheb = (a: Place, b: Place) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const gateMetadata=(path:{gates?:RouteGate[];locked?:string[]}):RouteGate[]=>path.gates?.length?path.gates:(path.locked??[]).map(id=>({id,source:'legacy travel cache; prerequisites not retained',requires:[['other:unparsed gate '+id]]}));

export function place(m: TravelModel, id: string): Place {
    const p = m.places[id] ?? m.cache.banks[id];
    if (!p) throw new Error(`travel: unknown place ${id}`);
    return p;
}

// One walk on the same land mass, start ticks included.
function walk(m: TravelModel, a: string, b: string): Leg {
    if (a === b) return { ticks: 0, method: 'same' };
    const pa = place(m, a), pb = place(m, b);
    // Directed-edge pattern: Skretzo/shortest-path@142e73e2, Transport.java (BSD-2-Clause).
    // nearestBank was measured from a site to its bank. It says nothing about
    // the return. Use an explicit legacy symmetric path or a labelled estimate.
    const nb = m.cache.nearestBank[a]?.bank === b ? m.cache.nearestBank[a] : undefined;
    if (nb) return { ticks: Math.ceil(nb.runTicks) + START_TICKS, method: nb.method,...(nb.gates?.length?{gates:nb.gates}:{}) };
    const c = m.cache.legs[m.cache.directed?`${a}>${b}`:key(a,b)];
    if (c) {const gates=gateMetadata(c);return { ticks: Math.ceil(c.runTicks) + START_TICKS, method: 'path',...(gates.length?{gates}:{}) };}
    return { ticks: Math.ceil(cheb(pa, pb) * RUN_TICKS_PER_TILE) + START_TICKS, method: 'estimate' };
}

// Ticks from place `a` to place `b`. `b` may be 'anywhere' (0) or 'bank' (resolved by resolve()).
export function leg(m: TravelModel, a: string, b: string): Leg {
    if (b === ANYWHERE || a === b) return { ticks: 0, method: 'same' };
    const ia = place(m, a).island, ib = place(m, b).island;
    if (ia?.id === ib?.id) return walk(m, a, b);
    let ticks = 0;
    let cur = a;
    const parts: string[] = [];
    const gates:RouteGate[]=[];
    if (ia) { const w = walk(m, cur, ia.landing);gates.push(...w.gates??[]); ticks += w.ticks + ia.boatTicks; parts.push(`${w.method} to ${ia.landing}, boat ${ia.boatTicks}`); cur = ia.port; }
    if (ib) {
        const w = walk(m, cur, ib.port); ticks += w.ticks + ib.boatTicks; cur = ib.landing;
        gates.push(...w.gates??[]);
        parts.push(`${w.method} to ${ib.port}, boat ${ib.boatTicks}`);
    }
    const w = walk(m, cur, b); ticks += w.ticks; parts.push(`${w.method} to ${b}`);
    gates.push(...w.gates??[]);
    return { ticks, method: 'boat', detail: parts.join('; '),...(gates.length?{gates}:{}) };
}

// The concrete place an activity goes to: 'bank' = the nearest bank of the current place.
export function resolve(m: TravelModel, here: string, at: string): string {
    if (at !== BANK) return at;
    if (m.cache.banks[here]) return here;
    const nb = m.cache.nearestBank[here];
    if (nb) return nb.bank;
    // No cached nearest bank: the bank with the cheapest leg.
    let best = '';
    let bestT = Infinity;
    for (const b of Object.keys(m.cache.banks).sort()) {
        const t = leg(m, here, b).ticks;
        if (t < bestT) { bestT = t; best = b; }
    }
    return best;
}

// Ticks for `trips` round trips from a place to its nearest bank (bank open time is inside the activity rate).
export function bankTrips(m: TravelModel, at: string, trips: number): Leg {
    if (trips <= 0) return { ticks: 0, method: 'bank-trip' };
    const b = resolve(m, at, BANK);
    const one = leg(m, at, b).ticks;
    const back = leg(m, b, at).ticks;
    return { ticks: trips * (one + back), method: 'bank-trip', detail: `${trips} x (${one} + ${back}) (${b})` };
}

export const TRAVEL_FILE = join(import.meta.dir, 'haggis-travel.json');

export function loadTravel(places: Record<string, Place>, cachePath = TRAVEL_FILE): TravelModel {
    const cache: TravelCache = existsSync(cachePath)
        ? (JSON.parse(readFileSync(cachePath, 'utf8')) as TravelCache)
        : { legs: {}, nearestBank: {}, banks: {} };
    return { places, cache };
}

// Measured legs (research/walking.md, MEASURED practice, walkPath, 3 runs each) for the calibration report.
export const MEASURED_LEGS: { id: string; from: [number, number]; to: [number, number]; runs: number[]; tiles?: number; note?: string }[] = [
    { id: 'Musa Point -> Brimhaven', from: [2956, 3146], to: [2774, 3228], runs: [110, 107, 106], tiles: 207, note: 'tiles from the run with 106 ticks' },
    { id: 'Port Sarim -> GE', from: [3029, 3217], to: [3181, 3440], runs: [241, 241, 241], tiles: 474, note: 'bench route goes through Lumbridge (danger-checked waypoints), not the shortest path' },
    { id: 'GE -> Port Sarim', from: [3181, 3440], to: [3029, 3217], runs: [240, 238, 241], note: 'same waypoints as above, reversed' },
    { id: 'Brimhaven -> Musa Point', from: [2772, 3225], to: [2956, 3146], runs: [107, 104, 107], note: 'floor 100-112' },
    { id: 'Lumbridge -> Port Sarim', from: [3222, 3218], to: [3029, 3217], runs: [142, 143, 143], note: 'floor 139-144' },
];
