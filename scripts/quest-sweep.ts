// Quest sweep: run one generated quest (scripts/generated/quest-<quest>.ts) on an ordinary account from wherever it
// stands. The quest's practice preset names its start tile and pack. This runner takes the missing pack items from the
// nearest bank, walks to the start tile and hands its session to the quest script, which owns the quest, the RESULT
// line and the logout. A missing item ends the run before travel with `missing id:count` (acquisition work).
// Usage: bun scripts/quest-sweep.ts <account> <quest>      e.g. bun scripts/quest-sweep.ts Mightyrod blackknight
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,finish,getWorld,accountOf,finishHooks} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {goTo,sessionWalker,walkPath,walkRoute,type PathDeps} from '../packages/core/src/walk';
import type {World,Transport} from '../packages/core/src/world';
import {loadTravel} from '../packages/core/src/travel';
import {sellersByDistance,shopSellers} from '../packages/core/src/shop-index';
import {spawnsByDistance} from '../packages/core/src/spawn-index';
import {gatherPlan,gatherItems,rangedKit,arrowsFor,ARROWS,NPC_SOURCES} from '../packages/core/src/gather';
import {questFlags} from '../packages/core/src/quest-status';
import {PRESETS,type SaveConfig} from '../packages/practice/src/presets';
import travel from '../packages/planner/src/haggis-travel.json';
import {retainedGhostSkull,retainedGhostBankSkull,leaveGhostBasement,inGhostBasement} from './ghost-basement-exit';
import {crossesSea} from '../packages/core/src/spawn-index';
import {startQuestSustain,questFoodDefinitions} from './quest-sustain';

type Item={id:number;count:number};
type Tile={x:number;z:number;level:number};
const BANKS:Tile[]=Object.values((travel as unknown as {banks:Record<string,Tile>}).banks);

export function presetFor(quest:string):SaveConfig&{position:Tile}{
 const p=PRESETS['quest_'+quest];
 if(!p?.position)throw Error(`quest sweep: no preset quest_${quest} with a start tile`);
 return{...p,position:{level:0,...p.position},...(quest==='hazeelcult'?{inventory:[{id:385,count:4}]}:{})};
}
// Preset food (lobster, shark) only feeds the quest's eat-at threshold, and teleport runes (fire, water, air, earth,
// law) only save walking (quest-lib teleport walks without a law rune): the runner takes what the bank holds of both.
// Fish, bread, lobster and shark are the food presets carry (quest_death: 10 bread, 10 trout); a banana or a cake can be
// a quest's own item (Pirate's Treasure smuggles bananas), so only these count as optional.
export const FOOD=new Set([329,333,361,365,373,379,385,2309,554,555,556,557,563]),COINS=995;
export function needs(preset:SaveConfig,food=false):Map<number,number>{
 const m=new Map<number,number>();
 for(const i of preset.inventory??[])if(FOOD.has(i.id)===food)m.set(i.id,(m.get(i.id)??0)+i.count);
 if(!food&&preset.coins)m.set(COINS,(m.get(COINS)??0)+preset.coins);
 return m;
}
const count=(rows:readonly Item[],id:number)=>rows.filter(r=>r.id===id).reduce((n,r)=>n+r.count,0);
// What the pack still lacks, and what the bank cannot cover.
export function plan(need:ReadonlyMap<number,number>,pack:readonly Item[],bank:readonly Item[]){
 const withdraw:Item[]=[],missing:Item[]=[];
 for(const [id,n] of need){
  const lack=n-count(pack,id);if(lack<=0)continue;
  const take=Math.min(lack,count(bank,id));
  if(take>0)withdraw.push({id,count:take});
  if(take<lack)missing.push({id,count:lack-take});
 }
 return{withdraw,missing};
}
// A quest's own items: never deposited as unneeded, and withdrawn when the bank holds them, since the server counts
// them in the bank (obj_gettotal) and then neither re-issues nor accepts them (sedridor.rs2, duke_horacio.rs2, aubury.rs2).
// An untradeable item is kept the same way: quest and reward items are the untradeable ones a pack carries.
export const QUEST_KEEP:Record<string,number[]>={runemysteries:[1438,290,291],totem:[1858,1857]};
export function keepsItem(quest:string,id:number,tradeable:(id:number)=>boolean|undefined):boolean{
 return (QUEST_KEEP[quest]??[]).includes(id)||tradeable(id)===false;
}
// Pack slots a withdrawal list needs: a stack (coins, runes, anything the pack already holds as a stack) takes one slot
// whatever its count; everything else one slot per unit.
// Coins, runes and arrows stack: 238 bronze arrows for a goblin series take one slot, not 238.
export const STACKS=new Set([COINS,554,555,556,557,558,559,560,561,562,563,564,565,566,...ARROWS]);
export function slotsFor(withdraw:readonly Item[],pack:readonly Item[]):number{
 const stack=(id:number)=>STACKS.has(id)||pack.some(i=>i.id===id&&i.count>1);
 return withdraw.reduce((n,w)=>n+(stack(w.id)?(pack.some(i=>i.id===w.id)?0:1):w.count),0);
}
// What to deposit so the pack has `need` free slots: first whole kinds the quest does not use (count -1: one deposit
// banks the kind; a second deposit of the same kind from a stale slot waits out its timeout), never coins, runes, the
// quest's own items or what the preset needs; then food units beyond a KEEP_FOOD allowance, as many as still needed.
export const KEEP_FOOD=8;
// Everything that heals (consume_normal.dbrow): FOOD above names what a preset carries as optional; this is what the
// deposit plan protects and the sweep's eater eats (an account arrives with swordfish and cake slices, not lobsters).
let edible:Set<number>|undefined;
export const isEdible=(id:number)=>FOOD.has(id)||(edible??=new Set(questFoodDefinitions().keys())).has(id);
// The preset's edible ingredients (Family Crest's cooked fish, Pirate's Treasure's bananas): the sweep's eater and, after
// the handover, the quest's own eater leave them alone.
export const reservedEdible=(need:ReadonlyMap<number,number>):Record<number,number>=>Object.fromEntries([...need].filter(([id])=>isEdible(id)));
// Slots a quest script fills on its own, undeclared by its preset: what it picks up and is handed (Murder Mystery takes
// the dagger, flypaper, a suspect's item and its dust and print, and a full pack fails its first pickup). The reserve
// gives way to the supplies down to MIN_PICKUP_SLOTS, before the food allowance does: Demon Slayer's 25 bones and two
// rune stacks beside the coins leave nothing else.
export const QUEST_PICKUP_SLOTS=8,MIN_PICKUP_SLOTS=2;
// What the pack keeps whatever the plan: coins, the quest's and the preset's own items, and rune stacks.
export const staysCount=(pack:readonly Item[],keep:(id:number)=>boolean)=>pack.filter(i=>i.id===COINS||keep(i.id)||(STACKS.has(i.id)&&isEdible(i.id))).length;
// The slots the bank pass frees: the supplies plus as much pickup reserve as leaves the food allowance room, at least
// MIN_PICKUP_SLOTS, never beyond what the pack can hold next to what stays.
export function slotNeed(supplies:number,stays:number):number{
 const room=28-supplies-stays,reserve=Math.max(MIN_PICKUP_SLOTS,Math.min(QUEST_PICKUP_SLOTS,room-KEEP_FOOD));
 return Math.min(28-stays,supplies+reserve);
}
export function depositPlan(pack:readonly Item[],need:number,keep:(id:number)=>boolean):Item[]{
 let free=28-pack.length;
 const out:Item[]=[];
 for(const id of [...new Set(pack.map(i=>i.id))]){
  if(free>=need)break;
  if(id===COINS||isEdible(id)||keep(id))continue;
  out.push({id,count:-1});free+=pack.filter(i=>i.id===id).length;
 }
 // The allowance gives way to the supplies: 25 bones, two rune stacks and the coins leave no slot for food.
 let allowance=Math.max(0,Math.min(KEEP_FOOD,28-need-staysCount(pack,keep)));
 for(const id of [...new Set(pack.filter(i=>isEdible(i.id)&&!STACKS.has(i.id)&&!keep(i.id)).map(i=>i.id))]){
  if(free>=need)break;
  const held=pack.filter(i=>i.id===id).length,kept=Math.min(held,allowance);allowance-=kept;
  const bank=Math.min(held-kept,need-free);
  if(bank>0){out.push({id,count:bank});free+=bank;}
 }
 return out;
}
// A far start walks hub to hub: each hop is a short route search (a search for a 900-tile route plans for hundreds of
// ticks before the first step, live and on practice, and the session's status row goes stale meanwhile). Hubs are the
// known banks and Lumbridge; a hop is at most MAX_HOP tiles (a 150-tile search plans in a few ticks) and must bring
// the goal nearer by HOP_GAIN.
export const MAX_HOP=150,HOP_GAIN=50;
const cheb=(a:Tile,b:Tile)=>Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z));
export function hopsTo(from:Tile,to:Tile,hubs:readonly Tile[]=[...BANKS,{x:3222,z:3218,level:0}]):Tile[]{
 const out:Tile[]=[];let at=from;
 for(let i=0;i<12&&cheb(at,to)>MAX_HOP;i++){
  const next=hubs.filter(h=>h.level===to.level&&cheb(at,h)<=MAX_HOP&&cheb(h,to)<=cheb(at,to)-HOP_GAIN).sort((a,b)=>(cheb(at,a)+cheb(a,to))-(cheb(at,b)+cheb(b,to)))[0];
  if(!next)break;
  out.push(next);at=next;
 }
 return out;
}
// A dungeon tile lies 6400 north of the surface it is under (the Wizards' Tower basement, 3120,9567, under 3120,3167):
// banks rank by the surface tile, so an account left underground heads for the bank above it, not across the map.
export const UNDERGROUND=6400;
export const surfaceOf=(t:Tile):Tile=>t.z>=UNDERGROUND?{...t,z:t.z-UNDERGROUND}:t;
export function nearestBanks(at:Tile):Tile[]{
 const a=surfaceOf(at);
 return BANKS.filter(b=>b.level===a.level).sort((x,y)=>Math.max(Math.abs(x.x-a.x),Math.abs(x.z-a.z))-Math.max(Math.abs(y.x-a.x),Math.abs(y.z-a.z)));
}
// The sweep eats on its own walks (the quest script brings its own eater at the handover): anything that heals, from
// 60 percent of the account's hitpoints down. A quest that failed leaves the account where it stood, and the next
// sweep logs in there: Restless Ghost's skull skeleton killed a 37-hitpoint account on the bank walk.
export function eatAtFor(maxHp:number):number{return Math.max(10,Math.floor(maxHp*0.6));}
// Straight-line distance plus a boat: a seller across the water (Hamab in Tai Bwo Wannai, 488 tiles from Al Kharid as the
// crow flies; the Miscellania food shop, 581 from Ardougne) ranks behind one on the same landmass (Kortan in Ardougne,
// 654), since the world router's search for the crossing idles hundreds of ticks.
import {SEA} from '../packages/core/src/spawn-index';
export {SEA};
// The farthest seller a sweep walks to: Al Kharid to Ardougne is 654 tiles; a crossing costs SEA on top.
export const FAR_SELLER=800;
export function travelDistance(from:Tile,to:Tile):number{return cheb(from,to)+(crossesSea(from,to)?SEA:0);}
export function sellersByTravel<S extends {tile:Tile}>(sellers:readonly S[],at:Tile):S[]{
 return [...sellers].sort((a,b)=>travelDistance(at,a.tile)-travelDistance(at,b.tile));
}
export function nearestBank(at:Tile):Tile{
 return BANKS.filter(b=>b.level===at.level).sort((a,b)=>Math.max(Math.abs(a.x-at.x),Math.abs(a.z-at.z))-Math.max(Math.abs(b.x-at.x),Math.abs(b.z-at.z)))[0]??BANKS[0]!;
}

// gnome_gate.rs2: gate190 at 2459,3383 walks to loc+(2,2), then force-moves three tiles south.
// special-crossings.json instead names the southern landing as the interaction tile. Leave the interior before
// asking the shared route planner for the bank, so it does not select that malformed crossing.
export async function leaveStronghold(s:Session,approach:(to:Tile)=>Promise<{ok:boolean}>=async(to)=>walkPath(await sessionWalker(s),[{...to,tol:0}],{maxTicks:150})){
 const pos=()=>s.sdk.getState()?.player;
 const p=pos();
 if(!p||p.level!==0||p.worldX<2369||p.worldX>2505||p.worldZ<3385||p.worldZ>3524)return{ok:true};
 const walked=await approach({x:2461,z:3385,level:0});
 if(!walked.ok)return{ok:false,detail:'Stronghold north gate approach failed'};
 const n=pos();
 if(n?.worldX!==2461||n.worldZ!==3385||n.level!==0)return{ok:false,detail:'Stronghold north landing unobserved'};
 await s.direct({type:'interactLoc',x:2459,z:3383,locId:190,optionIndex:1,reason:'SDK'});
 const crossed=await waitUntil(s,()=>{const p=pos();return p?.worldX===2461&&p.worldZ===3382&&p.level===0;},{timeoutTicks:30});
 console.log(`QUEST_SWEEP_GATE ${JSON.stringify({ok:crossed,at:pos()&&{x:pos()!.worldX,z:pos()!.worldZ,level:pos()!.level}})}`);
 return{ok:crossed,detail:crossed?undefined:'Stronghold southern landing unobserved'};
}

// courier-route.ts / foodcourier.ts: two 30-coin boats bypass White Wolf Mountain for the HP10 mainland entry.
// The corridors are courier waypoints [x,z,tolerance], walked with walkPath as foodcourier.ts walks them. A waypoint
// is a pass-by tile, not a world-route goal: goTo found no route to 2850,3175, while walkPath plans each leg on
// rs-sdk collision and clicks straight on where that plan is empty. Only the last tile's tolerance is checked.
type Pt=[number,number,number];
export const KARAMJA:Pt[]=[[2774,3228,3],[2800,3200,5],[2850,3175,5],[2920,3160,5],[2956,3146,3]];
// SARIM_TO_DRAYNOR's first legs, then LUMBRIDGE_TO_DRAYNOR reversed: north of the jail guards.
export const SARIM_NORTH:Pt[]=[[3047,3237,3],[3060,3265,3],[3089,3266,2],[3100,3285,3],[3180,3258,3]];
export async function walkCorridor(deps:PathDeps,points:readonly Pt[],walk:typeof walkPath=walkPath){
 const [gx,gz,gtol]=points[points.length-1]!;
 const at=()=>{const p=deps.pos();return p&&{x:p.x,z:p.z,level:p.level};};
 const near=()=>{const p=at();return !!p&&p.level===0&&Math.max(Math.abs(p.x-gx),Math.abs(p.z-gz))<=gtol+1;};
 let left=points.map(([x,z,tol])=>({x,z,tol}));
 for(let i=0;i<3&&!near();i++){
  const r=await walk(deps,left);
  console.log(`QUEST_SWEEP_CORRIDOR ${JSON.stringify({to:{x:gx,z:gz},try:i+1,ok:r.ok,next:r.next,at:at(),detail:r.detail})}`);
  left=left.slice(Math.min(r.next,left.length-1));
 }
 return{ok:near(),at:at()};
}

// Every far walk of the sweep (bank, shop, gather source, quest start) goes hub to hub: a ground hop walks on rs-sdk
// collision first (walkPath plans a 450-tile leg in a few ticks; the world router's search for Falador to Catherby alone
// idled 920 ticks on practice, and Al Kharid to a Karamja shop idled 938), and takes the world router only when that
// walk fails or the legs change level.
export type Walked={ok:boolean;reason?:string;detail?:string;ticks?:number};
// The sweep's route searches get 15 s each: a legitimate leg plans in well under that, and the 900-tick watchdog runs at
// 150 ms ticks on practice (135 s), so three 45 s searches for one unreachable spawn cluster ended a run.
export const SWEEP_PLAN_BUDGET_MS=15_000;
export async function walkFar(s:Session,world:World,to:Tile,legTimeoutTicks=150):Promise<Walked>{
 const from=at(s);
 const r=await walkFarLegs(s,world,to,legTimeoutTicks);
 if(!r.ok)console.log(`QUEST_SWEEP_WALK_FAIL ${JSON.stringify({from,to,at:at(s),reason:r.reason,detail:r.detail})}`);
 return r;
}
const at=(s:Session):Tile=>{const q=s.sdk.getState()?.player;return{x:q?.worldX??0,z:q?.worldZ??0,level:q?.level??0};};
async function walkFarLegs(s:Session,world:World,to:Tile,legTimeoutTicks:number):Promise<Walked>{
 const router=(t:Tile)=>goTo(s,world,t,accountOf(s),{legTimeoutTicks,planBudgetMs:SWEEP_PLAN_BUDGET_MS});
 const ground=async(t:Tile):Promise<Walked>=>{
  const r=at(s).level===0&&t.level===0?await walkCorridor(await sessionWalker(s),[[t.x,t.z,3]]):{ok:false};
  return r.ok?{ok:true}:router(t);
 };
 // A far walk that starts upstairs (Hudo's shop on the Grand Tree's first floor, bound for Port Sarim) first comes down by
 // the nearest way down: the boats and hubs are ground legs, and asked from the first floor the world router found no route.
 for(let i=0;i<3&&at(s).level!==0&&cheb(at(s),to)>MAX_HOP;i++){
  const down=wayDown(world.navigationGraph?.().transports??[],at(s));
  console.log(`QUEST_SWEEP_DOWN ${JSON.stringify({from:at(s),to:down})}`);
  const r=await router(down);if(!r.ok)return r;
 }
 if(eastOfArdougne(at(s),to)){const r=await crossEast(s,world,to);if(!r.ok)return r;}
 // An upstairs target (Morgan's garlic cupboard in Draynor) is approached by the hubs toward the ground beneath it;
 // only the last leg, with its stairs, is the world router's.
 const beneath={x:to.x,z:to.z,level:0};
 for(const hop of at(s).level===0?hopsTo(at(s),beneath):[]){
  console.log(`QUEST_SWEEP_HOP ${JSON.stringify({from:at(s),to:hop})}`);
  const r=await ground(hop);if(!r.ok)return r;
 }
 // A far upstairs target with no hub on the way (Hudo's shop on the Grand Tree's first floor, 226 tiles from the Ardougne
 // bank) is still approached by the ground beneath it: asked from Ardougne, the world router took an Ardougne staircase
 // and a 240-tile walk on the first floor, where no floor lies, and the search ran out the plan budget.
 if(to.level!==0&&at(s).level===0&&cheb(at(s),beneath)>MAX_HOP){const r=await ground(beneath);if(!r.ok)return r;}
 return to.level===0&&at(s).level===0&&cheb(at(s),to)>30?ground(to):router(to);
}
// The landing of the nearest way down from this floor (the Grand Tree ladder, 2466,3495): the tile beneath an upstairs shop
// is a wall as often as a floor (under Hudo's counter, 2449,3508, the router found no route).
export function wayDown(transports:readonly Transport[],at:Tile):Tile{
 const downs=transports.filter(t=>t.from.level===at.level&&t.to.level<at.level&&cheb(t.from,at)<=80).sort((a,b)=>cheb(a.from,at)-cheb(b.from,at));
 return downs[0]?.to??{x:at.x,z:at.z,level:0};
}
// From the Ardougne side (x under 2800, z 3270 and up) to anywhere east of x 2950 the way is the two boats, Brimhaven and
// Port Sarim, with the Karamja and Port Sarim corridors between: no hub lies within a hop of Ardougne to the east, and
// the world router's search for the land way round idles out the budget. Two fares of 30 coins.
export const eastOfArdougne=(from:Tile,to:Tile)=>from.level===0&&from.x<2800&&from.z>=3270&&to.x>=2950;
export const BOAT_FARES=60;
export const fares=(from:Tile,targets:readonly Tile[])=>targets.some(t=>eastOfArdougne(from,t))?BOAT_FARES:0;
// The Port Sarim landing: a target in the town itself (Wydin's shop, 3014,3204) needs no walk north past the jail.
export const SARIM_LANDING:Tile={x:3029,z:3217,level:0};
async function crossEast(s:Session,world:World,to:Tile):Promise<Walked>{
 if(count(s.sdk.getState()?.inventory??[],COINS)<BOAT_FARES)return{ok:false,reason:'precondition',detail:`missing 995:${BOAT_FARES} for safe boat route`};
 const walk=(to:Tile)=>goTo(s,world,to,accountOf(s),{legTimeoutTicks:150,planBudgetMs:SWEEP_PLAN_BUDGET_MS});
 const corridor=async(points:readonly Pt[]):Promise<Walked>=>{
  const r=await walkCorridor(await sessionWalker(s),points);
  return r.ok?{ok:true}:{ok:false,reason:'corridor',detail:`corridor walk failed to ${points[points.length-1]!.join(',')} at ${JSON.stringify(r.at)}`};
 };
 const sail=async(id:string):Promise<Walked>=>{
  const t=loadTravel().find(t=>t.id===id);
  if(!t?.from)return{ok:false,reason:'precondition',detail:`safe boat route unavailable: ${id}`};
  // KARAMJA ends within 4 tiles of 2956,3146, so within 7 of the customs officer at 2953,3147. The travel leg
  // only needs the NPC in view; goTo has no Karamja route there.
  const q=s.sdk.getState()?.player;
  if(!q||q.level!==t.from.level||Math.max(Math.abs(q.worldX-t.from.x),Math.abs(q.worldZ-t.from.z))>8){const w=await walk(t.from);if(!w.ok)return w;}
  const r=await walkRoute(s,[{kind:'travel',travel:t,at:t.from,to:t.to}],{maxRetriesPerLeg:1,legTimeoutTicks:150});
  if(!r.ok)return{ok:false,reason:r.reason,detail:`safe boat route failed: ${r.detail}`};
  console.log(`QUEST_SWEEP_BOAT ${JSON.stringify({id,coins:t.coins})}`);
  return{ok:true};
 };
 for(const leg of [()=>sail('npc:captain_barnaby:brimhaven@2679,3275'),()=>corridor(KARAMJA),()=>sail('npc:customs_officer:port-sarim@2953,3147')]){
  const r=await leg();if(!r.ok)return r;
 }
 return cheb(to,SARIM_LANDING)<=60?{ok:true}:corridor(SARIM_NORTH);
}
async function reachStart(s:Session,world:World,start:Tile){
 const r=await walkFar(s,world,start);
 if(!r.ok)throw Error(`start walk failed to ${JSON.stringify(start)}: ${r.reason} ${r.detail}`);
}

// Missing quest items a shop sells: the nearest seller of each (shop-index.ts), and the coins to take for them
// (3 times the item's base cost, plus 100). Items no shop sells stay missing.
export type Buy={id:number;count:number;name:string;npcId:number;npc:string;tile:Tile;alts?:{npc:string;npcId:number;tile:Tile}[]};
export function shopPlan(missing:readonly Item[],at:Tile,item:(id:number)=>{debugname:string;name:string;cost:number}|undefined,
 seller:(debugname:string,at:Tile)=>{npc:string;npcId:number;tile:Tile}|null,alts:(debugname:string,at:Tile)=>{npc:string;npcId:number;tile:Tile}[]=()=>[]){
 const buys:Buy[]=[],unsold:Item[]=[];let coins=0;
 for(const m of missing){
  const it=item(m.id),s=it&&m.id!==COINS?seller(it.debugname,at):null;
  if(!it||!s){unsold.push(m);continue;}
  buys.push({id:m.id,count:m.count,name:it.name,npcId:s.npcId,npc:s.npc,tile:s.tile,alts:alts(it.debugname,at).filter(a=>a.npcId!==s.npcId||a.tile.x!==s.tile.x||a.tile.z!==s.tile.z).slice(0,8)});coins+=3*Math.max(1,it.cost)*m.count;
 }
 return{buys,unsold,coins:buys.length?coins+100:0};
}
let itemCatalog:Map<number,{debugname:string;name:string;cost:number}>|undefined;
const catalogItem=(id:number)=>(itemCatalog??=new Map((JSON.parse(readFileSync(resolve(import.meta.dir,'../knowledge/items.json'),'utf8')) as {id:number;debugname:string;name:string;cost:number}[]).map(i=>[i.id,i])) ).get(id);

// Walk to each seller, open its shop and buy. Ok when the pack holds the bought counts.
async function buyFromShops(s:Session,world:World,buys:readonly Buy[]):Promise<string|null>{
 const st=()=>s.sdk.getState() as any,held=(id:number)=>count((st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count})),id);
 // Purchases go nearest seller first from wherever the bot stands (onions from Hudo in the Gnome Stronghold before
 // redberries from Wydin in Port Sarim, from Ardougne), so a walk east by boat is not followed by a walk back west.
 const here=():Tile=>{const q=st()?.player;return{x:q?.worldX??0,z:q?.worldZ??0,level:q?.level??0};};
 const left=[...buys];
 while(left.length){
  const b=left.sort((x,y)=>travelDistance(here(),x.tile)-travelDistance(here(),y.tile)).shift()!;
  // The nearest seller may be out of reach (a quest area, deadly ground) or short (Kortan holds 14 balls of wool, the
  // quest wants 20): the next sellers take over, nearest first, for the rest.
  const before=held(b.id),target=before+b.count,sellers=[b,...(b.alts??[])];
  let walked:{ok:boolean;reason?:string;detail?:string}={ok:false},tried=0;
  for(const [k,c] of sellers.entries()){
   if(held(b.id)>=target)break;
   // A seller across the sea or the map is not worth the search: the sweep fails fast and the shortfall is acquisition work.
   if(travelDistance(here(),c.tile)>FAR_SELLER){console.log(`QUEST_SWEEP_SELLER_FAR ${JSON.stringify({npc:c.npc,tile:c.tile,from:here()})}`);continue;}
   walked=await walkFar(s,world,c.tile,100);
   if(!walked.ok)continue;
   tried++;
   const npc=(st()?.nearbyNpcs??[]).filter((n:any)=>n.id===c.npcId).sort((x:any,y:any)=>x.distance-y.distance)[0];
   if(!npc)return `${c.npc} not in sight at ${c.tile.x},${c.tile.z}`;
   if(!(await s.bot.openShop(npc)).success)return `${c.npc} shop did not open`;
   await waitUntil(s,()=>!!st()?.shop?.isOpen,{timeoutTicks:10});
   // Another bot may have emptied the shelf: buy what is there, wait for the restock, buy the rest. Small shops
   // restock one item per 100 ticks (wydinstore: 3 flour), so the last seller waits up to 12 x 50 ticks; an earlier
   // one waits 3 rounds before the next seller is tried.
   const rounds=k===sellers.length-1?12:3,had0=held(b.id);
   for(let i=0;i<rounds&&held(b.id)<target;i++){
    const row=(st()?.shop?.shopItems??[]).find((x:any)=>x.id===b.id);
    if(!row||row.count<1){await waitTicks(s,50);continue;}
    const want=Math.min(target-held(b.id),row.count),had=held(b.id);
    await s.bot.buyFromShop(row,want);
    await waitUntil(s,()=>held(b.id)>=had+want,{timeoutTicks:10});
   }
   console.log(`QUEST_SWEEP_BUY ${JSON.stringify({item:b.id,name:b.name,count:b.count,npc:c.npc,before:had0,after:held(b.id),coins:held(COINS)})}`);
   await s.bot.closeShop();
  }
  if(!tried)return `shop walk to ${b.npc} at ${b.tile.x},${b.tile.z} and ${b.alts?.length??0} more failed: ${walked.reason?`${walked.reason} ${walked.detail}`:`no seller within ${FAR_SELLER} tiles`}`;
  if(held(b.id)<target)return `bought ${held(b.id)-before} of ${b.count} ${b.name} from ${tried} sellers`;
 }
 return null;
}

// General stores nearest `at`, one tile per keeper. A general store buys any item (shop/scripts/shop.rs2
// can_sell_obj: inv_allstock).
export function generalStores(at:Tile,sellers=shopSellers()):{npcId:number;npc:string;tile:Tile}[]{
 const seen=new Map<string,{npcId:number;npc:string;tile:Tile}>();
 for(const list of sellers.values())for(const s of list)if(s.shop.startsWith('general'))for(const t of s.spawns)if(t.level===at.level)seen.set(`${s.npcId}@${t.x},${t.z}`,{npcId:s.npcId,npc:s.npc,tile:t});
 const d=(t:Tile)=>Math.max(Math.abs(t.x-at.x),Math.abs(t.z-at.z));
 return [...seen.values()].sort((a,b)=>d(a.tile)-d(b.tile));
}
// The way to every bank can cost a fare the pack cannot pay (OreElse on Karamja: 24 coins, 30 to Port Sarim, no
// bank on the island). Sell the pack at the nearest reachable general store, cheapest item first.
async function raiseFare(s:Session,world:World):Promise<boolean>{
 const st=()=>s.sdk.getState() as any,coins=()=>count((st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count})),COINS);
 const here=():Tile=>{const p=st()?.player;return{x:p?.worldX??0,z:p?.worldZ??0,level:p?.level??0};};
 const start=coins();
 for(const store of generalStores(here()).slice(0,3)){
  const walked=await goTo(s,world,store.tile,accountOf(s),{legTimeoutTicks:100});
  console.log(`QUEST_SWEEP_FARE_WALK ${JSON.stringify({npc:store.npc,to:store.tile,ok:walked.ok,detail:"detail" in walked?walked.detail:undefined})}`);
  if(!walked.ok)continue;
  const npc=(st()?.nearbyNpcs??[]).filter((n:any)=>n.id===store.npcId).sort((a:any,b:any)=>a.distance-b.distance)[0];
  if(!npc||!(await s.bot.openShop(npc)).success)continue;
  await waitUntil(s,()=>!!st()?.shop?.isOpen,{timeoutTicks:10});
  const items=[...(st()?.inventory??[])].filter((i:any)=>i.id!==COINS).sort((a:any,b:any)=>(catalogItem(a.id)?.cost??0)-(catalogItem(b.id)?.cost??0));
  for(const i of items){const before=coins();await s.bot.sellToShop(i,'all');await waitUntil(s,()=>coins()>before,{timeoutTicks:10});}
  await s.bot.closeShop();
  console.log(`QUEST_SWEEP_FARE ${JSON.stringify({npc:store.npc,before:start,after:coins()})}`);
  return coins()>start;
 }
 return false;
}

// Gathering (ground spawns, milk, loc sources) lives in packages/core/src/gather.ts, shared with scripts/gather-spawn.ts.
export {gatherPlan,MILK,BUCKET,LOC_SOURCES,type Gather} from '../packages/core/src/gather';

// One bot at a time hands its session over through globalThis.QUEST_SESSION, until quest-lib's openQuest has taken
// it (QUEST_SESSION_TAKEN) or 60 s pass. `fresh` imports the quest module under a unique query, so every bot in one
// process runs the quest's top-level code again.
let handoff:Promise<void>=Promise.resolve();
export function handOver(s:Session,script:string,fresh?:string):Promise<unknown>{
 const g=globalThis as {QUEST_SESSION?:Session;QUEST_SESSION_TAKEN?:()=>void};
 let started!:(p:Promise<unknown>)=>void;const run=new Promise<Promise<unknown>>(r=>{started=r;});
 handoff=handoff.then(()=>new Promise<void>(release=>{
  const done=()=>{clearTimeout(timer);if(g.QUEST_SESSION===s)delete g.QUEST_SESSION;if(g.QUEST_SESSION_TAKEN===done)delete g.QUEST_SESSION_TAKEN;release();};
  const timer=setTimeout(done,60_000);
  g.QUEST_SESSION=s;g.QUEST_SESSION_TAKEN=done;
  started(import(fresh?`${script}?${fresh}`:script).finally(()=>{if(g.QUEST_SESSION_TAKEN===done)done();}));
 }));
 return run.then(p=>p);
}

function observeQuestFlags(s:Session){
 const seen=new Map<number,string>();
 const observe=()=>{for(const q of questFlags(s.client)??[])if(seen.get(q.id)!==q.state){seen.set(q.id,q.state);console.log(`QUEST_SWEEP_FLAG ${JSON.stringify(q)}`);}};
 observe();const off=s.onTick(observe);void s.ended.then(off);
}
export async function sweep(account:string,quest:string,fresh?:string){
 const script=resolve(import.meta.dir,'generated',`quest-${quest}.ts`);
 if(!existsSync(script))throw Error(`quest sweep: no script ${script}`);
 const preset=presetFor(quest),need=needs(preset),food=needs(preset,true);
 const s:Session=await openBot(account);
 const fail=(why:string)=>finish([s],false,`quest-sweep ${quest} ${why}`);
 let handed=false;
 try {
 const st=()=>s.sdk.getState();
 if(!await waitUntil(s,()=>!!st()?.player,{timeoutTicks:20}))return fail('entry state unavailable');
 const maxHp=()=>st()?.skills?.find((k:any)=>k.name==='Hitpoints')?.baseLevel??10;
 const sustain=startQuestSustain({sdk:s.sdk,tick:()=>s.tick(),onTick:cb=>s.onTick(cb),ended:s.ended,direct:async action=>{
  const reply:any=await s.direct(action);return{success:!!reply?.success,message:reply?.message===undefined?undefined:String(reply.message)};
 // An edible quest ingredient (Family Crest's cooked fish, The Knight's Sword's redberry pie) is reserved, never eaten.
 }},{food:[...questFoodDefinitions().keys()],eatAt:eatAtFor(maxHp()),reserved:reservedEdible(need)});
 void s.ended.then(()=>sustain.stop());
 sustain.aborted.addEventListener('abort',()=>console.log(`QUEST_SWEEP_SUSTAIN_FAIL ${JSON.stringify({failure:sustain.failure(),hp:st()?.player?.hp,at:at(s)})}`));
 const danger=()=>{const p=st()?.player;return!!p&&(p.combat?.inCombat||p.hp<=eatAtFor(maxHp()));};
 if(danger())console.log(`QUEST_SWEEP_DANGER ${JSON.stringify({hp:st()?.player?.hp,inCombat:st()?.player?.combat?.inCombat,at:{x:st()?.player?.worldX,z:st()?.player?.worldZ,level:st()?.player?.level}})}`);
 // The skull basement has no walk out that the world router plans: take its door, corridor and ladder first.
 if(inGhostBasement(st()?.player)){
  const locAt=(x:number,z:number)=>(st()?.nearbyLocs??[]).find((l:any)=>l.x===x&&l.z===z);
  const ops=(l:any)=>(l?.optionsWithIndex??[]) as {text:string;opIndex:number}[];
  const near=(x:number,z:number,tol:number)=>{const p=st()?.player;return!!p&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=tol;};
  await leaveGhostBasement({pos:()=>st()?.player,
   openDoor:async(_l,x,z)=>{const d=locAt(x,z),op=ops(d).find(o=>/^open$/i.test(o.text));if(d&&op){await s.bot.interactLoc(d,op.opIndex);await waitUntil(s,()=>!ops(locAt(x,z)).some(o=>/^open$/i.test(o.text)),{timeoutTicks:12});}},
   dash:async(_l,x,z,tol)=>{for(let i=0;i<3&&!near(x,z,tol);i++){await s.direct({type:'walkTo',x,z,running:true,reason:'SDK'});await waitUntil(s,()=>near(x,z,tol),{timeoutTicks:30});}},
   waitForLadder:()=>waitUntil(s,()=>!!locAt(3104,9576)||!!(st()?.nearbyLocs??[]).find((l:any)=>ops(l).some(o=>/climb-up|climb$/i.test(o.text))&&l.distance<=3),{timeoutTicks:15}),
   climbLadder:async()=>{const l=(st()?.nearbyLocs??[]).filter((l:any)=>ops(l).some(o=>/climb-up|^climb$/i.test(o.text))).sort((a:any,b:any)=>a.distance-b.distance)[0],op=ops(l).find(o=>/climb-up|^climb$/i.test(o.text));if(l&&op){const z0=st()?.player?.worldZ??0;await s.bot.interactLoc(l,op.opIndex);await waitUntil(s,()=>(st()?.player?.worldZ??z0)<UNDERGROUND,{timeoutTicks:30});}},
   waitForLanding:()=>waitUntil(s,()=>(st()?.player?.worldZ??UNDERGROUND)<UNDERGROUND,{timeoutTicks:15})});
  console.log(`QUEST_SWEEP_LEFT_BASEMENT ${JSON.stringify({x:st()?.player?.worldX,z:st()?.player?.worldZ,level:st()?.player?.level})}`);
 }
 const ghostState=()=>questFlags(s.client)?.find(f=>f.name==='The Restless Ghost')?.state??'unknown';
 const retained=()=>quest==='priest'&&retainedGhostSkull(ghostState(),st()?.inventory??[],s.sdk.getEquipment());
 const returnSkull=async()=>{
  console.log('QUEST_SWEEP_RETAINED_SKULL '+JSON.stringify({state:ghostState(),position:st()?.player&&{x:st()!.player!.worldX,z:st()!.player!.worldZ,level:st()!.player!.level}}));
  observeQuestFlags(s);sustain.stop();handed=true;(s as {questReserved?:Record<number,number>}).questReserved=reservedEdible(need);await handOver(s,script,fresh);return;
 };
 if(quest==='priest'){
  await waitUntil(s,()=>ghostState()!=='unknown',{timeoutTicks:20});
  if((st()?.inventory??[]).some(i=>i.id===553)){
   if(!retained())return fail('retained skull requires a started journal and worn ghostspeak amulet');
   return await returnSkull();
  }
 }
 const here=():Tile=>{const p=st()?.player;return p?{x:p.worldX,z:p.worldZ,level:p.level}:{x:0,z:0,level:-1};};
 const world=await getWorld();
 // The world walker plans from the ground floor: an account left upstairs (Hazeel Cult ends there) climbs down first.
 for(let i=0;i<3&&(st()?.player?.level??0)>0;i++){
  const down=(st()?.nearbyLocs??[]).filter((l:any)=>(l.optionsWithIndex??[]).some((o:any)=>/climb-down/i.test(o.text))).sort((a:any,b:any)=>a.distance-b.distance)[0];
  if(!down)return fail(`no way down from level ${st()?.player?.level}`);
  const level=st()?.player?.level??0,op=down.optionsWithIndex.find((o:any)=>/climb-down/i.test(o.text))?.opIndex??1;
  // bot.interactLoc opens a shut door on the way (Juliet's room door stands between her and the stairs).
  await s.bot.interactLoc(down,op);
  await waitUntil(s,()=>(st()?.player?.level??level)<level,{timeoutTicks:30});
 }
 const pack=():Item[]=>(st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count}));
 const seekGhostSkull=quest==='priest'&&ghostState()==='started'&&s.sdk.getEquipment().some(i=>i.id===552);
 if(seekGhostSkull||plan(need,pack(),[]).missing.length||plan(food,pack(),[]).missing.length){
  const exit=await leaveStronghold(s);
  if(!exit.ok)return fail(exit.detail!);
  // The nearest bank may be out of reach: try the next three.
  let walked:Walked={ok:false,reason:'precondition',detail:'no bank tried',ticks:0};
  for(const bank of nearestBanks(here()).slice(0,4)){
   console.log(`QUEST_SWEEP_BANK ${JSON.stringify({from:here(),to:bank})}`);
   walked=await walkFar(s,world,bank,100);
   console.log(`QUEST_SWEEP_BANK_WALK ${JSON.stringify({at:here(),to:bank,outcome:walked})}`);
   if(walked.ok)break;
  }
  // No bank in reach with few coins: the exit may be a fare. Raise it at a general store and try again.
  if(!walked.ok&&count(pack(),COINS)<200&&await raiseFare(s,world))for(const bank of nearestBanks(here()).slice(0,4)){
   walked=await walkFar(s,world,bank,100);
   console.log(`QUEST_SWEEP_BANK_WALK ${JSON.stringify({at:here(),to:bank,outcome:walked})}`);
   if(walked.ok)break;
  }
  if(!walked.ok)return fail(`bank walk failed at ${JSON.stringify(here())}: ${walked.reason} ${walked.detail}`);
  const opened=await s.bot.openBank();
  if(!opened.success)return fail('bank did not open');
  await waitUntil(s,()=>(st()?.bank?.items?.length??0)>0,{timeoutTicks:10});
  const rows=():Item[]=>(st()?.bank?.items??[]).map((i:any)=>({id:i.id,count:i.count}));
  const p=plan(need,pack(),rows()),meal=plan(food,pack(),rows()).withdraw;
  p.withdraw.push(...meal);
  for(const id of QUEST_KEEP[quest]??[])if(count(pack(),id)===0&&count(rows(),id)>0)p.withdraw.push({id,count:1});
  if(seekGhostSkull&&retainedGhostBankSkull(ghostState(),pack(),s.sdk.getEquipment(),rows()))p.withdraw.push({id:553,count:1});
  // A missing item a shop sells is bought after the bank: take coins for it now. Sellers rank by travel distance.
  const ranked=(d:string,at:Tile)=>sellersByTravel(sellersByDistance(d,at),at).map(n=>({npc:n.npc,npcId:n.npcId,tile:n.tile}));
  const shops=(items:readonly Item[])=>shopPlan(items,here(),catalogItem,(d,at)=>ranked(d,at)[0]??null,ranked);
  // What no shop sells is gathered after the shops; a gather tool comes from the bank or a shop.
  const sellerAt=(id:number)=>{const it=catalogItem(id),n=it&&id!==COINS?ranked(it.debugname,here())[0]:null;return n?travelDistance(here(),n.tile):Infinity;};
  const skill=(name:string)=>st()?.skills?.find((k:any)=>k.name===name)?.baseLevel??1;
  // A bow and arrows owned (pack, bank or worn) let the Ranged level count against an animal; the kit is withdrawn
  // with the gather's tools and wielded before the kill (UnderMyKilt: Ranged 97, Attack 6, a shortbow and iron arrows).
  const worn=():Item[]=>s.sdk.getEquipment().map((i:any)=>({id:i.id,count:i.count}));
  const owned=[...pack(),...rows(),...worn()];
  const kit=rangedKit(owned);
  const gather=gatherPlan(p.missing,here(),spawnsByDistance,sellerAt,undefined,skill('Attack'),kit?skill('Ranged'):1);
  if(kit&&gather.gathers.some(g=>g.kit==='ranged'))gather.tools.push({id:kit.bow,count:1},{id:kit.arrows,count:gather.gathers.filter(g=>g.kit==='ranged').reduce((n,g)=>n+arrowsFor(g.id,g.count),0)});
  // A tool already worn (the bow, the arrows) counts as held; the gather's tools are kept by the deposit pass.
  const tools=plan(new Map(gather.tools.map(t=>[t.id,t.count])),[...pack(),...worn()],rows());
  p.withdraw.push(...tools.withdraw);
  const toolIds=new Set(gather.tools.map(t=>t.id));
  const shop=shops([...gather.still,...tools.missing]);
  if(gather.gathers.length)console.log(`QUEST_SWEEP_GATHER_PLAN ${JSON.stringify(gather)}`);
  if(shop.unsold.length){await s.bot.closeBank();return fail('missing '+shop.unsold.map(i=>`${i.id}:${i.count}`).join(',')+(shop.buys.length?' (unsold; others in shops)':''));}
  // Recipes paid in dialogue (Aggie's dyes, Wyson's woad leaves) take their coins out with the shop money, and so do the
  // two boat fares when a destination lies east of Ardougne: a plan of Wyson's woad and Aggie's blue dye alone budgets 25
  // coins, and crossEast refuses the crossing below 60.
  shop.coins+=gather.coins+fares(here(),[...shop.buys.map(b=>b.tile),preset.position,...gather.gathers.flatMap(g=>g.how==='npc'&&NPC_SOURCES[g.id]?[NPC_SOURCES[g.id]!.tile]:[])]);
  if(shop.coins){
   const take=Math.max(0,shop.coins-count(pack(),COINS)-(p.withdraw.find(w=>w.id===COINS)?.count??0));
   if(count(rows(),COINS)<take){await s.bot.closeBank();return fail(`missing ${COINS}:${take} to buy ${shop.buys.map(b=>b.id).join(',')}`);}
   if(take>0){const c=p.withdraw.find(w=>w.id===COINS);if(c)c.count+=take;else p.withdraw.push({id:COINS,count:take});}
   console.log(`QUEST_SWEEP_SHOP_PLAN ${JSON.stringify({buys:shop.buys,coins:shop.coins})}`);
  }
  // Free the slots the withdrawals, the shop purchases and the gathered items need, plus the pickups: whole kinds the
  // quest does not use first, one deposit per kind, then food beyond the allowance.
  const keep=(id:number)=>need.has(id)||toolIds.has(id)||keepsItem(quest,id,id=>(catalogItem(id) as {tradeable?:boolean}|undefined)?.tradeable);
  const slots=slotNeed(slotsFor([...p.withdraw,...shop.buys.map(b=>({id:b.id,count:b.count})),...gather.gathers.map(g=>({id:g.id,count:g.count}))],pack()),staysCount(pack(),keep));
  for(const d of depositPlan(pack(),slots,keep)){
   const item=(st()?.inventory??[]).find((i:any)=>i.id===d.id);
   if(!item)continue;
   const r:any=await s.bot.depositItem(item,d.count);
   console.log(`QUEST_SWEEP_DEPOSIT ${JSON.stringify({id:d.id,count:d.count,success:r?.success,message:r?.message,free:28-(st()?.inventory?.length??0)})}`);
  }
  console.log(`QUEST_SWEEP_BANK_PASS ${JSON.stringify({withdraw:p.withdraw,slots,free:28-pack().length})}`);
  for(const w of p.withdraw){
   const row=(st()?.bank?.items??[]).find((i:any)=>i.id===w.id);
   const before=count(pack(),w.id),bankBefore=count(rows(),w.id);
   if(!row)return fail(`bank row ${w.id} vanished`);
   await s.bot.withdrawItem(row,w.count);
   const observed=await waitUntil(s,()=>count(pack(),w.id)===before+w.count&&count(rows(),w.id)===bankBefore-w.count,{timeoutTicks:10});
   console.log(`QUEST_SWEEP_WITHDRAW ${JSON.stringify({id:w.id,count:w.count,before,after:count(pack(),w.id),bankBefore,bankAfter:count(rows(),w.id),observed})}`);
   if(!observed)return fail(`withdraw debit unobserved ${w.id}:${w.count}`);
  }
  await s.bot.closeBank();
  console.log(`QUEST_SWEEP_BANK_DONE ${JSON.stringify({at:here(),buys:shop.buys.map(b=>b.id),gathers:gather.gathers.map(g=>g.id)})}`);
  if(shop.buys.length){const why=await buyFromShops(s,world,shop.buys);if(why)return fail(why);}
  if(gather.gathers.length){const why=await gatherItems(s,world,gather.gathers,(to)=>walkFar(s,world,to,100));if(why)return fail(why);}
  const left=plan(need,pack(),[]).missing;
  if(left.length)return fail('withdraw short '+left.map(i=>`${i.id}:${i.count}`).join(','));
 }
 if(retained())return await returnSkull();
 const start=preset.position;
 const exit=await leaveStronghold(s);
 if(!exit.ok)return fail(exit.detail!);
 await reachStart(s,world,start);
 console.log(`MILESTONE quest-sweep ${quest} staged at ${JSON.stringify(here())}`);
 observeQuestFlags(s);
 sustain.stop();
 handed=true;
 (s as {questReserved?:Record<number,number>}).questReserved=reservedEdible(need);await handOver(s,script,fresh);
 } catch(error) {
  if(handed)throw error;
  return fail(String(error));
 }
}

async function main(){
 const [account,quest]=process.argv.slice(2);
 if(!account||!quest)throw Error('usage: bun scripts/quest-sweep.ts <account> <quest>');
 // As a bot-host entry, the quest module's finish() (plain bot.ts) reports through this entry's own finish, which
 // the host rewrites to the per-bot one; without it the quest's finish would end the whole host.
 if((globalThis as {__rsBotHost?:unknown}).__rsBotHost)finishHooks.set(account.toLowerCase(),(ok,detail)=>{void finish([],ok,detail);});
 // A unique query: in a bot host, each account runs the quest module afresh.
 await sweep(account,quest,`run=${account.toLowerCase()}-${Date.now()}`);
}

if(import.meta.main)await main();
