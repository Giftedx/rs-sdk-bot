// Quest sweep: run one generated quest (scripts/generated/quest-<quest>.ts) on an ordinary account from wherever it
// stands. The quest's practice preset names its start tile and pack. This runner takes the missing pack items from the
// nearest bank, walks to the start tile and hands its session to the quest script, which owns the quest, the RESULT
// line and the logout. A missing item ends the run before travel with `missing id:count` (acquisition work).
// Usage: bun scripts/quest-sweep.ts <account> <quest>      e.g. bun scripts/quest-sweep.ts Mightyrod blackknight
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,finish,getWorld,accountOf,finishHooks,sessionDied} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {goTo,sessionWalker,walkPath,walkRoute,type PathDeps} from '../packages/core/src/walk';
import type {World} from '../packages/core/src/world';
import {loadTravel} from '../packages/core/src/travel';
import {nearestSeller,sellersByDistance,shopSellers} from '../packages/core/src/shop-index';
import {spawnsByDistance} from '../packages/core/src/spawn-index';
import {gatherPlan,gatherItems} from '../packages/core/src/gather';
import {questFlags} from '../packages/core/src/quest-status';
import {PRESETS,type SaveConfig} from '../packages/practice/src/presets';
import travel from '../packages/planner/src/haggis-travel.json';
import {retainedGhostSkull,retainedGhostBankSkull} from './ghost-basement-exit';
import {walkQuestCorridor} from './quest-walk';
import {crossStrongholdGate,STRONGHOLD_GATE,type GateDeps} from './agility-order';

type Item={id:number;count:number};
type Tile={x:number;z:number;level:number};
const BANKS:Tile[]=Object.values((travel as unknown as {banks:Record<string,Tile>}).banks);

export function presetFor(quest:string):SaveConfig&{position:Tile}{
 const p=PRESETS['quest_'+quest];
 if(!p?.position)throw Error(`quest sweep: no preset quest_${quest} with a start tile`);
 return{...p,position:{level:0,...p.position},...(quest==='hazeelcult'?{inventory:[{id:385,count:4}]}:{}),
  ...(quest==='totem'?{coins:90,inventory:[...(p.inventory??[]),{id:1891,count:8},{id:1893,count:1},{id:1895,count:2}]}:{})};
}
// Preset food (lobster, shark) only feeds the quest's eat-at threshold, and teleport runes (fire, water, air, earth,
// law) only save walking (quest-lib teleport walks without a law rune): the runner takes what the bank holds of both.
export const FOOD=new Set([379,385,1891,1893,1895,554,555,556,557,563]),COINS=995;
export function needs(preset:SaveConfig,food=false):Map<number,number>{
 const m=new Map<number,number>();
 for(const i of preset.inventory??[])if(FOOD.has(i.id)===food)m.set(i.id,(m.get(i.id)??0)+i.count);
 if(!food&&preset.coins)m.set(COINS,(m.get(COINS)??0)+preset.coins);
 return m;
}
const count=(rows:readonly Item[],id:number)=>rows.filter(r=>r.id===id).reduce((n,r)=>n+r.count,0);
const WORN_KIT:Record<string,readonly {id:number;required:boolean}[]>={ball:[{id:1059,required:true},{id:1331,required:false}]};
export function wornKitPlan(quest:string,base:ReadonlyMap<number,number>,pack:readonly Item[],bank:readonly Item[],equipment:readonly Item[]){
 const wear=(WORN_KIT[quest]??[]).filter(i=>i.required||count(bank,i.id)>0||count(pack,i.id)>0||count(equipment,i.id)>0);
 const need=new Map(base);
 for(const i of wear)if(!count(equipment,i.id))need.set(i.id,Math.max(1,need.get(i.id)??0));
 return{need,wear};
}
export async function wearQuestKit(s:Session,wear:readonly {id:number;required:boolean}[]):Promise<string|null>{
 for(const i of wear){
  if(s.sdk.getEquipment().some(e=>e.id===i.id&&e.count>0))continue;
  const row=s.sdk.getState()?.inventory.find(e=>e.id===i.id&&e.count>0);
  if(!row)return `${i.required?'required':'selected'} worn item ${i.id} unavailable`;
  await s.bot.equipItem(row);
  const observed=await waitUntil(s,()=>s.sdk.getEquipment().some(e=>e.id===i.id&&e.count>0),{timeoutTicks:10});
  console.log(`QUEST_SWEEP_WORN ${JSON.stringify({id:i.id,required:i.required,observed})}`);
  if(!observed)return `${i.required?'required':'selected'} worn item ${i.id} equip unobserved`;
 }
 return null;
}
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
// Reserve the whole acquisition batch before leaving the bank. Existing stacks need no new slot.
export async function reserveInputSlots(s:Session,inputs:readonly Item[],keep:ReadonlySet<number>):Promise<string|null>{
 const pack=()=>s.sdk.getState()?.inventory??[],bank=()=>s.sdk.getState()?.bank?.items??[];
 const client=s.client as {objType?:(id:number)=>{stackable:boolean}};
 const slots=()=>{
  const stacks=new Set(pack().map(i=>i.id));let n=0;
  for(const i of inputs)if(client.objType?.(i.id)?.stackable){if(!stacks.has(i.id)){n++;stacks.add(i.id);}}else n+=i.count;
  return n;
 };
 for(const id of new Set(pack().map(i=>i.id))){
  if(28-pack().length>=slots())break;
  if(keep.has(id))continue;
  const row=pack().find(i=>i.id===id)!,held=count(pack(),id),stored=count(bank(),id);
  await s.bot.depositItem(row,-1);
  if(!await waitUntil(s,()=>count(pack(),id)===0&&count(bank(),id)===stored+held,{timeoutTicks:10}))return `capacity deposit unobserved ${id}:${held}`;
 }
 const required=slots(),free=28-pack().length;
 console.log(`QUEST_SWEEP_CAPACITY ${JSON.stringify({required,free})}`);
 return free>=required?null:`input capacity short: free ${free}, required ${required}`;
}
export function nearestBanks(at:Tile):Tile[]{
 return BANKS.filter(b=>b.level===at.level).sort((a,b)=>Math.max(Math.abs(a.x-at.x),Math.abs(a.z-at.z))-Math.max(Math.abs(b.x-at.x),Math.abs(b.z-at.z)));
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
 // The Heckel ladder lands behind the Grand Tree doors. A path west from 2466,3494 misses their anchors.
 // gnome_gate.rs2 open_tree_door aligns treedoorr to x2466 and force-moves two tiles south.
 if(p.worldX>=2464&&p.worldX<=2467&&p.worldZ>=3493&&p.worldZ<=3495){
  await s.direct({type:'interactLoc',x:2466,z:3492,locId:1968,optionIndex:1,reason:'SDK'});
  const outside=await waitUntil(s,()=>{const q=pos();return q?.level===0&&q.worldX===2466&&q.worldZ===3491;},{timeoutTicks:30});
  console.log(`QUEST_SWEEP_TREE_EXIT ${JSON.stringify({ok:outside,at:pos()&&{x:pos()!.worldX,z:pos()!.worldZ,level:pos()!.level}})}`);
  if(!outside)return{ok:false,detail:'Grand Tree southern landing unobserved'};
 }
 const walked=await approach({x:2461,z:3385,level:0});
 if(!walked.ok)return{ok:false,detail:'Stronghold north gate approach failed'};
 const n=pos();
 if(n?.worldX!==2461||n.worldZ!==3385||n.level!==0)return{ok:false,detail:'Stronghold north landing unobserved'};
 await s.direct({type:'interactLoc',x:2459,z:3383,locId:190,optionIndex:1,reason:'SDK'});
 const crossed=await waitUntil(s,()=>{const p=pos();return p?.worldX===2461&&p.worldZ===3382&&p.level===0;},{timeoutTicks:30});
 console.log(`QUEST_SWEEP_GATE ${JSON.stringify({ok:crossed,at:pos()&&{x:pos()!.worldX,z:pos()!.worldZ,level:pos()!.level}})}`);
 return{ok:crossed,detail:crossed?undefined:'Stronghold southern landing unobserved'};
}

// Black Knights' Fortress box room (level 1, south of the cabbage hole wall): its only exit is the secret wall
// bksecretdoor 2341 on the south edge of 3030,3510 (quest_blackknight.rs2:86-88). The nearest climb-down there,
// 3021,3510, sits behind the sturdy door and gets "I can't reach that!". quest-blackknight.ts step 7 reversed:
// push the wall north, the corridor to 3022,3517, laddertop 1749 at 3022,3518 down to the hall, out by the
// guards' door to the fortress front (both doors open from inside, :14-22,56-66).
const inBoxRoom=(p:{worldX:number;worldZ:number;level:number})=>p.level===1&&p.worldX>=3026&&p.worldX<=3031&&p.worldZ>=3504&&p.worldZ<=3509;
export async function leaveFortress(s:Session,approach:(to:readonly Tile[])=>Promise<{ok:boolean}>=async(to)=>walkPath(await sessionWalker(s),to.map(t=>({x:t.x,z:t.z,tol:0})),{maxTicks:150})){
 const pos=()=>s.sdk.getState()?.player;
 const at=(x:number,z:number,level:number,tol=0)=>{const p=pos();return !!p&&p.level===level&&Math.abs(p.worldX-x)<=tol&&Math.abs(p.worldZ-z)<=tol;};
 const where=()=>{const p=pos();return p?`${p.worldX},${p.worldZ},${p.level}`:'unknown';};
 const p=pos();
 if(!p||!inBoxRoom(p))return{ok:true};
 const log=(step:string,ok:boolean)=>console.log(`QUEST_SWEEP_FORTRESS ${JSON.stringify({step,ok,at:where()})}`);
 if(!(await approach([{x:3030,z:3509,level:1}])).ok||!at(3030,3509,1)){log('wall tile',false);return{ok:false,detail:`fortress secret wall tile 3030,3509,1 unobserved at ${where()}`};}
 await s.direct({type:'interactLoc',x:3030,z:3510,locId:2341,optionIndex:1,reason:'SDK'});
 const pushed=await waitUntil(s,()=>{const p=pos();return !!p&&p.level===1&&p.worldZ>=3510;},{timeoutTicks:20});
 log('secret wall',pushed);
 if(!pushed)return{ok:false,detail:`fortress secret wall push unobserved at ${where()}`};
 if(!(await approach([{x:3030,z:3516,level:1},{x:3029,z:3517,level:1},{x:3022,z:3517,level:1}])).ok||!at(3022,3517,1)){log('corridor',false);return{ok:false,detail:`fortress corridor 3022,3517,1 unobserved at ${where()}`};}
 await s.direct({type:'interactLoc',x:3022,z:3518,locId:1749,optionIndex:1,reason:'SDK'});
 const down=await waitUntil(s,()=>pos()?.level===0,{timeoutTicks:20});
 log('hall ladder',down);
 if(!down)return{ok:false,detail:`fortress hall ladder descent unobserved at ${where()}`};
 const out=(await approach([{x:3016,z:3512,level:0}])).ok&&at(3016,3512,0,1);
 log('front',out);
 return out?{ok:true}:{ok:false,detail:`fortress front 3016,3512,0 unobserved at ${where()}`};
}

// Ernest the Chicken's fish food has one spawn, upstairs in Draynor Manor (maps/m48_52.jm2:9477, 3108,3356,1).
// spawn-index.ts lists sources on the player's plane only, so gatherPlan leaves it missing. In by the front door
// (opens from the south only, quest_haunted.rs2:4-8), spookystairs 3108,3363 up (+4 z) and spookystairstop
// 3108,3364 down (-4 z, stairs.rs2:106-120), out by hauntedbackdoor 3123,3360 (north wall; opens from both sides).
export const MANOR_FOOD={id:272,x:3108,z:3356,level:1};
export const manorFoodNeed=(quest:string,missing:readonly Item[])=>quest==='haunted'&&missing.some(m=>m.id===MANOR_FOOD.id&&m.count===1);
type ManorLoc={id:number;x:number;z:number};
export type ManorIO={pos:()=>Tile|undefined;held:()=>number;ground:()=>{x:number;z:number}|undefined;
 travel:(to:Tile)=>Promise<{ok:boolean;detail?:string}>;walk:(to:readonly Tile[])=>Promise<{ok:boolean;detail?:string}>;
 op:(loc:ManorLoc,re:RegExp)=>Promise<unknown>;pickup:(at:{x:number;z:number})=>Promise<unknown>;wait:(ok:()=>boolean,ticks:number)=>Promise<boolean>};
export async function fetchManorFishFood(io:ManorIO,start:Tile):Promise<{ok:boolean;detail?:string}>{
 const where=()=>{const p=io.pos();return p?`${p.x},${p.z},${p.level}`:'unknown';};
 const at=(x:number,z:number,level:number,tol=0)=>{const p=io.pos();return !!p&&p.level===level&&Math.max(Math.abs(p.x-x),Math.abs(p.z-z))<=tol;};
 const log=(step:string,ok:boolean,extra:object={})=>console.log(`QUEST_SWEEP_MANOR ${JSON.stringify({step,ok,at:where(),...extra})}`);
 const fail=(step:string,what:string)=>{log(step,false);return{ok:false,detail:`manor fish food ${what} unobserved at ${where()}`};};
 const before=io.held();
 const travelled=await io.travel(start);
 if(!travelled.ok){log('travel',false);return{ok:false,detail:`manor fish food travel to ${start.x},${start.z} failed: ${travelled.detail}`};}
 if(!(await io.walk([{x:3108,z:3352,level:0}])).ok||!at(3108,3352,0))return fail('front','front door tile 3108,3352,0');
 await io.op({id:134,x:3108,z:3353},/^open$/i);
 if(!await io.wait(()=>{const p=io.pos();return !!p&&p.level===0&&p.z>=3354;},20))return fail('front door','front door entry');
 log('front door',true);
 if(!(await io.walk([{x:3108,z:3362,level:0}])).ok||!at(3108,3362,0))return fail('hall','stairs tile 3108,3362,0');
 await io.op({id:1730,x:3108,z:3363},/climb-up/i);
 if(!await io.wait(()=>io.pos()?.level===1,20))return fail('stairs up','level 1');
 log('stairs up',true);
 if(!(await io.walk([MANOR_FOOD])).ok||!at(MANOR_FOOD.x,MANOR_FOOD.z,1,1))return fail('food tile','food tile 3108,3356,1');
 if(!io.ground()&&!await io.wait(()=>!!io.ground(),60))return fail('food','ground fish food');
 for(let i=0;i<3&&io.held()<before+1;i++){
  const g=io.ground();
  if(g)await io.pickup(g);
  await io.wait(()=>io.held()>=before+1,10);
 }
 const got=io.held()===before+1;
 log('pickup',got,{before,after:io.held()});
 if(!got)return{ok:false,detail:`manor fish food inventory credit unobserved: ${before} -> ${io.held()} at ${where()}`};
 if(!(await io.walk([{x:3108,z:3366,level:1}])).ok||!at(3108,3366,1,1))return fail('landing','stairs landing 3108,3366,1');
 await io.op({id:1731,x:3108,z:3364},/climb-down/i);
 if(!await io.wait(()=>io.pos()?.level===0,20))return fail('stairs down','level 0');
 log('stairs down',true);
 if(!(await io.walk([{x:3123,z:3361,level:0}])).ok||!at(3123,3361,0))return fail('back door','back door exit 3123,3361,0');
 log('back door',true);
 return{ok:true};
}
export function manorIO(s:Session,world:World):ManorIO{
 const st=()=>s.sdk.getState() as any;
 return{
  pos:()=>{const p=st()?.player;return p?{x:p.worldX,z:p.worldZ,level:p.level}:undefined;},
  held:()=>count((st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count})),MANOR_FOOD.id),
  ground:()=>st()?.player?.level===MANOR_FOOD.level?(st()?.groundItems??[]).find((g:any)=>g.id===MANOR_FOOD.id&&g.x===MANOR_FOOD.x&&g.z===MANOR_FOOD.z):undefined,
  travel:async to=>{const r=await goTo(s,world,to,accountOf(s),{legTimeoutTicks:150});return r.ok?{ok:true}:{ok:false,detail:`${r.reason} ${r.detail}`};},
  walk:async to=>walkPath(await sessionWalker(s),to.map(t=>({x:t.x,z:t.z,tol:0})),{maxTicks:150}),
  op:async(loc,re)=>{
   const l=(st()?.nearbyLocs??[]).find((n:any)=>n.x===loc.x&&n.z===loc.z&&(n.optionsWithIndex??[]).some((o:any)=>re.test(o.text)));
   await s.direct({type:'interactLoc',x:loc.x,z:loc.z,locId:l?.id??loc.id,optionIndex:l?.optionsWithIndex.find((o:any)=>re.test(o.text)).opIndex??1,reason:'SDK'});
  },
  pickup:async g=>s.direct({type:'pickupItem',x:g.x,z:g.z,itemId:MANOR_FOOD.id,reason:'SDK'}),
  wait:(ok,ticks)=>waitUntil(s,ok,{timeoutTicks:ticks}),
 };
}

// m38_54.jm2 LOC: 0/1_38_54_34_39, ladder1747 / laddermiddle1748.
// ladders.rs2: ground op1 climbs up, middle op3 climbs down without a choice menu.
export const HECKEL_DUST={id:1975,coins:106,ground:{x:2493,z:3488,level:0},ladder:{x:2466,z:3495}};
export const heckelDustNeed=(quest:string,missing:readonly Item[])=>quest==='elena'&&missing.some(m=>m.id===1975&&m.count===1);
export const groundShopNeeds=(quest:string,missing:readonly Item[])=>missing.filter(m=>!(heckelDustNeed(quest,missing)&&m.id===1975));
export type HeckelIO={pos:()=>Tile|undefined;held:()=>number;coins:()=>number;
 gate:()=>Promise<unknown>;
 travel:(to:Tile)=>Promise<{ok:boolean;detail?:string}>;walk:(to:Tile)=>Promise<{ok:boolean}>;
 climb:(up:boolean)=>Promise<unknown>;open:()=>Promise<boolean>;row:()=>Item|undefined;
 buy:(row:Item)=>Promise<unknown>;close:()=>Promise<unknown>;wait:(ok:()=>boolean,ticks:number)=>Promise<boolean>};
export async function fetchHeckelDust(io:HeckelIO):Promise<{ok:boolean;detail?:string}>{
 const at=(to:Tile,tol=2)=>{const p=io.pos();return !!p&&p.level===to.level&&Math.max(Math.abs(p.x-to.x),Math.abs(p.z-to.z))<=tol;};
 const fail=(detail:string)=>({ok:false,detail:`Heckel dust ${detail}`});
 const before=io.held();
 const p=io.pos();
 if(!p)return fail('Stronghold entry location unobserved');
 if(!(p.level===0&&p.x>=2369&&p.x<=2505&&p.z>=3385&&p.z<=3524)){
  const south={...STRONGHOLD_GATE.south,level:0};
  const approach=await io.travel(south);
  if(!approach.ok||!at(south,1))return fail(`Stronghold south leg to 2461,3382,0 failed: ${approach.detail??'arrival unobserved'}`);
  try{await io.gate();}catch(error){return fail(`Stronghold gate leg 2461,3382,0 -> 2461,3385,0 failed: ${String(error)}`);}
  if(!at({...STRONGHOLD_GATE.north,level:0},0))return fail('Stronghold gate leg to 2461,3385,0 failed: north arrival unobserved');
 }
 const travelled=await io.travel(HECKEL_DUST.ground);
 if(!travelled.ok)return fail(`Stronghold ground leg to 2493,3488,0 failed: ${travelled.detail}`);
 if(!at(HECKEL_DUST.ground))return fail('Stronghold ground arrival 2493,3488,0 unobserved');
 const landing={x:2466,z:3494,level:0};
 if(!(await io.walk(landing)).ok||!at(landing,0))return fail('ladder approach 2466,3494,0 unobserved');
 await io.climb(true);
 if(!await io.wait(()=>at({...landing,level:1}),20))return fail('ladder up 2466,3495,1 unobserved');
 const seller={x:2493,z:3488,level:1};
 if(!(await io.walk(seller)).ok||!at(seller))return fail('seller leg to 2493,3488,1 unobserved');
 if(!await io.open())return fail('shop open unobserved');
 let got=false,paid=false;
 try{
  // gnomeshop_heck stock13=chocolate_dust,5,100. Wait for one restock, then send one purchase only.
  if(!await io.wait(()=>{const row=io.row();return !!row&&row.id===1975&&row.count>0;},110))return fail('stock 1975 unobserved');
  const row=io.row();
  if(!row||row.id!==1975||row.count<1)return fail('stock 1975 vanished');
  const coinsBefore=io.coins();
  await io.buy(row);
  await io.wait(()=>io.held()===before+1&&io.coins()<coinsBefore,10);
  got=io.held()===before+1;paid=io.coins()<coinsBefore;
  console.log(`QUEST_SWEEP_HECKEL ${JSON.stringify({item:1975,before,after:io.held(),coinsBefore,coins:io.coins(),observed:got&&paid})}`);
 }finally{await io.close();}
 if(!got)return fail(`inventory credit unobserved: ${before} -> ${io.held()}`);
 if(!paid)return fail('coin debit unobserved');
 if(!(await io.walk({...landing,level:1})).ok||!at({...landing,level:1},0))return fail('ladder return 2466,3494,1 unobserved');
 await io.climb(false);
 if(!await io.wait(()=>at(landing),20))return fail('ladder down 2466,3495,0 unobserved');
 return{ok:true};
}
export function heckelIO(s:Session,world:World):HeckelIO{
 const st=()=>s.sdk.getState(),held=(id:number)=>count(st()?.inventory??[],id);
 const gate=async()=>{
  const initial=st()?.player;
  const live=()=>{if(!st()?.inGame)throw Error('session interrupted');if(sessionDied(initial,st()?.player)||(s.sdk.getSkill('Hitpoints')?.level??0)<=0)throw Error('died');};
  const end=s.tick()+200;
  const deps:GateDeps={live,left:label=>{live();if(s.tick()>=end)throw Error(`${label}: tick budget exhausted`);},health:async()=>{live();}};
  return crossStrongholdGate(s,deps);
 };
 return{
  gate,
  pos:()=>{const p=st()?.player;return p?{x:p.worldX,z:p.worldZ,level:p.level}:undefined;},held:()=>held(1975),coins:()=>held(COINS),
  travel:async to=>{const r=await goTo(s,world,to,accountOf(s),{legTimeoutTicks:150,maxRetriesPerLeg:1});return r.ok?{ok:true}:{ok:false,detail:`${r.reason} ${r.detail}`};},
  walk:async to=>walkPath(await sessionWalker(s),[{x:to.x,z:to.z,tol:0}],{maxTicks:150}),
  climb:async up=>s.direct({type:'interactLoc',...HECKEL_DUST.ladder,locId:up?1747:1748,optionIndex:up?1:3,reason:'SDK'}),
  open:async()=>{const npc=st()?.nearbyNpcs.find(n=>n.id===603);if(!npc)return false;await s.bot.openShop(npc);return waitUntil(s,()=>!!st()?.shop?.isOpen,{timeoutTicks:10});},
  row:()=>st()?.shop?.shopItems.find(i=>i.id===1975&&i.count>0),
  buy:async row=>{const observed=st()?.shop?.shopItems.find(i=>i.id===row.id&&i.count>0);if(observed)await s.bot.buyFromShop(observed,1);},
  close:()=>s.bot.closeShop(),wait:(ok,ticks)=>waitUntil(s,ok,{timeoutTicks:ticks}),
 };
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

export async function reachStart(s:Session,world:World,start:Tile,quest?:string,walker=()=>sessionWalker(s),route=walkRoute){
 const p=s.sdk.getState()?.player;
 const totemMainland=quest==='totem'&&p?.level===0&&p.worldX<2745&&p.worldZ>=3200;
 // The mainland-to-tower whole-world bank comparison waits before the first walk leg;
 // legTimeoutTicks cannot bound that planner. Reuse the courier's two boats and corridors.
 if(totemMainland||quest==='cog'&&p?.level===0&&p.worldX>=2950&&p.worldZ<3500&&start.level===0){
  const fares=totemMainland?90:60,label=totemMainland?'Tribal Totem':'Clock Tower';
  if(count(s.sdk.getState()?.inventory??[],COINS)<fares)throw Error(`missing 995:${fares} for ${label} boat route`);
  const deps=await walker(),deadline=s.tick()+1800;
  const near=(point:{x:number;z:number},tol:number)=>{const at=deps.pos();return !!at&&at.level===0&&Math.max(Math.abs(at.x-point.x),Math.abs(at.z-point.z))<=tol;};
  const corridor=async(points:readonly Pt[])=>{
   const r=await walkQuestCorridor({tick:()=>s.tick(),stop:()=>s.sdk.getState()?.player?.isDead===true,near,
    walk:(points,opts)=>walkPath(deps,points,opts),
   },points.map(([x,z,tol])=>({x,z,tol})),Math.min(deadline,s.tick()+600));
   if(!r.ok)throw Error(`${label} corridor failed: ${r.detail}`);
  };
  const sail=async(id:string)=>{
   const t=loadTravel().find(t=>t.id===id);
   if(!t?.from||!near(t.from,8))throw Error(`${label} boat approach unobserved: ${id}`);
   if(s.tick()>=deadline)throw Error(`${label} entry deadline`);
   const r=await route(s,[{kind:'travel',travel:t,at:t.from,to:t.to}],{maxRetriesPerLeg:1,legTimeoutTicks:150});
   if(!r.ok||!near(t.to,8))throw Error(`${label} boat failed: ${id} ${r.ok?'arrival unobserved':r.detail}`);
   console.log(`QUEST_SWEEP_BOAT ${JSON.stringify({id,coins:t.coins})}`);
  };
  if(totemMainland){
   await corridor([[2644,3293,2],[2669,3284,2],[2679,3275,2]]);
   await sail('npc:captain_barnaby:brimhaven@2679,3275');
   await corridor([[2774,3228,2],[start.x,start.z,2]]);
   return;
  }
  await corridor([...SARIM_NORTH].reverse().concat([[3029,3217,2]]));
  await sail('npc:captain_tobias:karamja-musa-point@3028,3216');
  await corridor([...KARAMJA].reverse().concat([[2772,3231,2]]));
  await sail('npc:customs_officer:ardougne@2772,3231');
  await corridor([[2669,3284,2],[2644,3293,2],[2610,3290,3],[2580,3260,2],[2575,3250,0],[start.x,start.z,2]]);
  return;
 }
 // m44_54.jm2 tunnel_dwarf spawns at 2820,3487 (wanderrange=2). The pinned collision has a ground path
 // from Ardougne; the world graph refuses the preset goal. Use the same bounded corridor as quest-lib,
 // then let the generated quest's talk helper walk to the observed NPC and open its dialogue.
 if(quest==='fishingcompo'&&start.level===0){
  if(p?.level!==0)throw Error('Fishing Contest west dwarf approach requires ground entry');
  const deps=await walker(),goal={x:2820,z:3487,tol:2};
  const near=(t:{x:number;z:number},tol:number)=>{const at=deps.pos();return !!at&&at.level===0&&Math.max(Math.abs(at.x-t.x),Math.abs(at.z-t.z))<=tol;};
  const r=await walkQuestCorridor({tick:()=>s.tick(),stop:()=>s.sdk.getState()?.player?.isDead===true,
   near,walk:(points,options)=>walkPath(deps,points,options),
  },[goal],s.tick()+600);
  if(!r.ok)throw Error(`Fishing Contest west dwarf approach failed: ${r.detail}`);
  const observed=()=>near(goal,3)&&(s.sdk.getState()?.nearbyNpcs??[]).some(n=>n.id===232&&/^mountain dwarf$/i.test(n.name)
   &&Math.max(Math.abs(n.x-goal.x),Math.abs(n.z-goal.z))<=4);
  if(!await waitUntil(s,observed,{timeoutTicks:10}))throw Error('Fishing Contest west dwarf unobserved');
  console.log(`QUEST_SWEEP_DWARF ${JSON.stringify({at:deps.pos(),observed:true})}`);
  return;
 }
 const walk=async(to:Tile)=>{
  const r=await goTo(s,world,to,accountOf(s),{legTimeoutTicks:150});
  if(!r.ok)throw Error(`start walk failed to ${JSON.stringify(to)}: ${r.reason} ${r.detail}`);
 };
 const corridor=async(points:readonly Pt[])=>{
  const r=await walkCorridor(await sessionWalker(s),points);
  if(!r.ok)throw Error(`corridor walk failed to ${points[points.length-1]!.join(',')} at ${JSON.stringify(r.at)}`);
 };
 if(p?.level===0&&p.worldX<2800&&p.worldZ>=3270&&start.level===0&&start.x>=2950){
  if(count(s.sdk.getState()?.inventory??[],COINS)<60)throw Error('missing 995:60 for safe boat route');
  const sail=async(id:string)=>{
   const t=loadTravel().find(t=>t.id===id);
   if(!t?.from)throw Error(`safe boat route unavailable: ${id}`);
   // KARAMJA ends within 4 tiles of 2956,3146, so within 7 of the customs officer at 2953,3147. The travel leg
   // only needs the NPC in view; goTo has no Karamja route there.
   const q=s.sdk.getState()?.player;
   if(!q||q.level!==t.from.level||Math.max(Math.abs(q.worldX-t.from.x),Math.abs(q.worldZ-t.from.z))>8)await walk(t.from);
   const r=await walkRoute(s,[{kind:'travel',travel:t,at:t.from,to:t.to}],{maxRetriesPerLeg:1,legTimeoutTicks:150});
   if(!r.ok)throw Error(`safe boat route failed: ${r.reason} ${r.detail}`);
   console.log(`QUEST_SWEEP_BOAT ${JSON.stringify({id,coins:t.coins})}`);
  };
  await sail('npc:captain_barnaby:brimhaven@2679,3275');
  await corridor(KARAMJA);
  await sail('npc:customs_officer:port-sarim@2953,3147');
  await corridor(SARIM_NORTH);
 }
 await walk(start);
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

export function questGatherPlan(quest:string,missing:readonly Item[],at:Tile,seller:(id:number)=>number){
 // Wydin's apron spawn is behind wydindoor: employment and a worn apron are required (food_store.rs2).
 // Hunt stages its first apron through the existing clotheshop purchase path.
 return gatherPlan(missing,at,(id,tile)=>quest==='hunt'&&id===1005||WORN_KIT[quest]?.some(i=>i.required&&i.id===id)?[]:spawnsByDistance(id,tile),seller);
}

// Walk to each seller, open its shop and buy. Ok when the pack holds the bought counts.
async function buyFromShops(s:Session,world:World,buys:readonly Buy[]):Promise<string|null>{
 const st=()=>s.sdk.getState() as any,held=(id:number)=>count((st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count})),id);
 for(let b of buys){
  // The nearest seller may be out of reach (a quest area, deadly ground): try the next ones.
  let walked:{ok:boolean;reason?:string;detail?:string}={ok:false},via=b;
  for(const c of [b,...(b.alts??[])]){walked=await goTo(s,world,c.tile,accountOf(s),{legTimeoutTicks:100});if(walked.ok){via={...b,...c};break;}}
  if(!walked.ok)return `shop walk to ${b.npc} at ${b.tile.x},${b.tile.z} and ${b.alts?.length??0} more failed: ${walked.reason} ${walked.detail}`;
  b=via;
  const npc=(st()?.nearbyNpcs??[]).filter((n:any)=>n.id===b.npcId).sort((x:any,y:any)=>x.distance-y.distance)[0];
  if(!npc)return `${b.npc} not in sight at ${b.tile.x},${b.tile.z}`;
  if(!(await s.bot.openShop(npc)).success)return `${b.npc} shop did not open`;
  await waitUntil(s,()=>!!st()?.shop?.isOpen,{timeoutTicks:10});
  // Another bot may have emptied the shelf: buy what is there, wait for the restock, buy the rest. Small shops
  // restock one item per 100 ticks (wydinstore: 3 flour), so this waits up to 12 x 50 ticks.
  const before=held(b.id),coinsBefore=held(COINS);
  for(let i=0;i<12&&held(b.id)<before+b.count;i++){
   const row=(st()?.shop?.shopItems??[]).find((x:any)=>x.id===b.id);
   if(!row||row.count<1){await waitTicks(s,50);continue;}
   const want=Math.min(before+b.count-held(b.id),row.count),had=held(b.id);
   await s.bot.buyFromShop(row,want);
   await waitUntil(s,()=>held(b.id)>=had+want,{timeoutTicks:10});
  }
  const got=held(b.id)>=before+b.count;
  console.log(`QUEST_SWEEP_BUY ${JSON.stringify({item:b.id,name:b.name,count:b.count,npc:b.npc,before,after:held(b.id),coinsBefore,coins:held(COINS)})}`);
  await s.bot.closeShop();
  if(!got)return `bought ${held(b.id)-before} of ${b.count} ${b.name} from ${b.npc}`;
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

// Ladders say Climb-down. Draynor Manor's spookystairstop says Walk-down (all.loc op1, stairs.rs2 [oploc1,spookystairstop]).
const DOWN=/(climb|walk)-down/i;
type DownLoc={distance:number;optionsWithIndex?:{text:string;opIndex:number}[]};
export function downward<L extends DownLoc>(locs:readonly L[]):{loc:L;opIndex:number}|undefined{
 const loc=locs.filter(l=>(l.optionsWithIndex??[]).some(o=>DOWN.test(o.text))).sort((a,b)=>a.distance-b.distance)[0];
 const opIndex=loc?.optionsWithIndex?.find(o=>DOWN.test(o.text))?.opIndex;
 return loc&&opIndex!==undefined?{loc,opIndex}:undefined;
}

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

export const returnToAmik=(quest:string,state:string)=>quest==='blackknight'&&state==='started';
export type AmikIO={pos:()=>Tile|undefined;travel:(to:Tile)=>Promise<{ok:boolean;detail?:string}>;
 climb:(loc:{id:number;x:number;z:number},level:number)=>Promise<boolean>;
 talk:()=>Promise<string>;complete:()=>boolean};
export async function finishBlackKnight(io:AmikIO):Promise<{ok:boolean;detail?:string}>{
 const to={x:2955,z:3337,level:0},r=await io.travel(to),p=io.pos();
 if(!r.ok||!p||p.level!==0||Math.max(Math.abs(p.x-to.x),Math.abs(p.z-to.z))>2)return{ok:false,detail:`Amik castle leg to 2955,3337,0 failed: ${r.detail??'arrival unobserved'}`};
 for(const [x,level] of [[2954,1],[2960,2]] as const){
  if(!await io.climb({id:1738,x,z:3338},level)||io.pos()?.level!==level)return{ok:false,detail:`Amik stairs leg at ${x},3338 to level ${level} unobserved`};
 }
 const dialogue=await io.talk();
 return io.complete()?{ok:true}:{ok:false,detail:`Sir Amik did not complete quest; observed dialogue: ${JSON.stringify(dialogue)}`};
}
export function amikIO(s:Session,world:World):AmikIO{
 const st=()=>s.sdk.getState(),initial=st()?.player;
 const state=()=>questFlags(s.client)?.find(f=>f.name==="Black Knight's Fortress")?.state;
 const text:string[]=[],messages=new Set((st()?.gameMessages??[]).map(m=>m));
 let questComplete=false;
 const observe=()=>{
  const d=st()?.dialog;
  const page=[d?.text??'',...(d?.allComponents??[]).map(c=>c.text)].filter(Boolean).join('\n');
  if(d?.isOpen&&page&&text.at(-1)!==page)text.push(page);
  if((st()?.gameMessages??[]).some(m=>!messages.has(m)&&/quest complete/i.test(m.text)))questComplete=true;
 };
 const live=()=>{if(!st()?.inGame||sessionDied(initial,st()?.player)||(s.sdk.getSkill('Hitpoints')?.level??0)<=0)throw Error('Amik return session interrupted or died');};
 return{
  pos:()=>{const p=st()?.player;return p?{x:p.worldX,z:p.worldZ,level:p.level}:undefined;},
  travel:async to=>{const r=await goTo(s,world,to,accountOf(s),{legTimeoutTicks:150,maxRetriesPerLeg:1});return r.ok?{ok:true}:{ok:false,detail:`${r.reason} ${r.detail}`};},
  climb:async(loc,level)=>{
   live();
   const r=await walkPath(await sessionWalker(s),[{x:loc.x,z:loc.z,tol:1}],{maxTicks:60});
   if(!r.ok)return false;
   const l=st()?.nearbyLocs.find(l=>l.x===loc.x&&l.z===loc.z);
   if(!l)return false;
   await s.bot.interactLoc(l,/climb/i);
   return waitUntil(s,()=>st()?.player?.level===level,{timeoutTicks:20});
  },
  talk:async()=>{
   const off=s.onTick(observe);
   try{
    live();
    const r=await walkPath(await sessionWalker(s),[{x:2960,z:3336,tol:1}],{maxTicks:60});
    if(!r.ok)return 'Sir Amik approach 2960,3336,2 failed';
    await s.bot.talkTo(/^sir amik varze$/i);
    for(let i=0;i<60;i++){
     live();observe();
     if(state()==='complete'&&questComplete)return text.join('\n');
     const d=st()?.dialog;
     if(d?.isOpen&&!d.isWaiting){
      if(d.options.some(o=>!/click here to continue/i.test(o.text)))return text.concat(d.options.map(o=>o.text)).join('\n');
      const reply=await s.sdk.sendClickDialog(0);
      if(!reply.success)return text.concat(reply.message??'dialogue click refused').join('\n');
     }
     await waitTicks(s,1);
    }
    return text.join('\n');
   }finally{off();}
  },
  complete:()=>state()==='complete'&&questComplete,
 };
}

function observeQuestFlags(s:Session){
 const seen=new Map<number,string>();
 const observe=()=>{for(const q of questFlags(s.client)??[])if(seen.get(q.id)!==q.state){seen.set(q.id,q.state);console.log(`QUEST_SWEEP_FLAG ${JSON.stringify(q)}`);}};
 observe();const off=s.onTick(observe);void s.ended.then(off);
}
export async function sweep(account:string,quest:string,fresh?:string){
 const script=resolve(import.meta.dir,'generated',`quest-${quest}.ts`);
 if(!existsSync(script))throw Error(`quest sweep: no script ${script}`);
 const preset=presetFor(quest),base=needs(preset),food=needs(preset,true);
 const s:Session=await openBot(account);
 const fail=(why:string)=>finish([s],false,`quest-sweep ${quest} ${why}`);
 let handed=false;
 try {
 const st=()=>s.sdk.getState();
 if(!await waitUntil(s,()=>!!st()?.player,{timeoutTicks:20}))return fail('entry state unavailable');
 let kit=wornKitPlan(quest,base,st()?.inventory??[],[],s.sdk.getEquipment()),need=kit.need;
 const ghostState=()=>questFlags(s.client)?.find(f=>f.name==='The Restless Ghost')?.state??'unknown';
 const retained=()=>quest==='priest'&&retainedGhostSkull(ghostState(),st()?.inventory??[],s.sdk.getEquipment());
 const returnSkull=async()=>{
  console.log('QUEST_SWEEP_RETAINED_SKULL '+JSON.stringify({state:ghostState(),position:st()?.player&&{x:st()!.player!.worldX,z:st()!.player!.worldZ,level:st()!.player!.level}}));
  observeQuestFlags(s);handed=true;await handOver(s,script,fresh);return;
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
 const fortress=await leaveFortress(s);
 if(!fortress.ok)return fail(fortress.detail!);
 // The world walker plans from the ground floor: an account left upstairs (Hazeel Cult ends there) climbs down first.
 for(let i=0;i<3&&(st()?.player?.level??0)>0;i++){
  const way=downward(st()?.nearbyLocs??[]);
  if(!way)return fail(`no way down from level ${st()?.player?.level}`);
  const level=st()?.player?.level??0;
  // bot.interactLoc opens a shut door on the way (Juliet's room door stands between her and the stairs).
  await s.bot.interactLoc(way.loc,way.opIndex);
  await waitUntil(s,()=>(st()?.player?.level??level)<level,{timeoutTicks:30});
 }
 if((st()?.player?.level??0)>0)return fail(`no observed descent from ${JSON.stringify(here())}`);
 if(quest==='blackknight'){
  const state=()=>questFlags(s.client)?.find(f=>f.name==="Black Knight's Fortress")?.state??'unknown';
  if(!await waitUntil(s,()=>state()!=='unknown',{timeoutTicks:20}))return fail('Black Knight journal state unavailable');
  if(returnToAmik(quest,state())){
   observeQuestFlags(s);
   const result=await finishBlackKnight(amikIO(s,world));
   if(!result.ok)return fail(result.detail!);
   return finish([s],true,'quest-sweep blackknight quest complete qp=3');
  }
 }
 const pack=():Item[]=>(st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count}));
 const seekGhostSkull=quest==='priest'&&ghostState()==='started'&&s.sdk.getEquipment().some(i=>i.id===552);
 if(seekGhostSkull||WORN_KIT[quest]?.some(i=>!i.required&&!s.sdk.getEquipment().some(e=>e.id===i.id))||plan(need,pack(),[]).missing.length||plan(food,pack(),[]).missing.length){
  const exit=await leaveStronghold(s);
  if(!exit.ok)return fail(exit.detail!);
  // The nearest bank may be out of reach: try the next three.
  let walked:Awaited<ReturnType<typeof goTo>>={ok:false,reason:'precondition',detail:'no bank tried',ticks:0};
  for(const bank of nearestBanks(here()).slice(0,4)){
   console.log(`QUEST_SWEEP_BANK ${JSON.stringify({from:here(),to:bank})}`);
   walked=await goTo(s,world,bank,accountOf(s),{legTimeoutTicks:100});
   console.log(`QUEST_SWEEP_BANK_WALK ${JSON.stringify({at:here(),to:bank,outcome:walked})}`);
   if(walked.ok)break;
  }
  // No bank in reach with few coins: the exit may be a fare. Raise it at a general store and try again.
  if(!walked.ok&&count(pack(),COINS)<200&&await raiseFare(s,world))for(const bank of nearestBanks(here()).slice(0,4)){
   walked=await goTo(s,world,bank,accountOf(s),{legTimeoutTicks:100});
   console.log(`QUEST_SWEEP_BANK_WALK ${JSON.stringify({at:here(),to:bank,outcome:walked})}`);
   if(walked.ok)break;
  }
  if(!walked.ok)return fail(`bank walk failed at ${JSON.stringify(here())}: ${walked.reason} ${walked.detail}`);
  const opened=await s.bot.openBank();
  if(!opened.success)return fail('bank did not open');
  await waitUntil(s,()=>(st()?.bank?.items?.length??0)>0,{timeoutTicks:10});
  const rows=():Item[]=>(st()?.bank?.items??[]).map((i:any)=>({id:i.id,count:i.count}));
  kit=wornKitPlan(quest,base,pack(),rows(),s.sdk.getEquipment());need=kit.need;
  const p=plan(need,pack(),rows()),meal=plan(food,pack(),rows()).withdraw;
  p.withdraw.push(...meal);
  if(seekGhostSkull&&retainedGhostBankSkull(ghostState(),pack(),s.sdk.getEquipment(),rows()))p.withdraw.push({id:553,count:1});
  // A missing item a shop sells is bought after the bank: take coins for it now.
  const shops=(items:readonly Item[])=>shopPlan(items,here(),catalogItem,(d,at)=>{const n=nearestSeller(d,at);return n&&{npc:n.npc,npcId:n.npcId,tile:n.tile};},(d,at)=>sellersByDistance(d,at).map(n=>({npc:n.npc,npcId:n.npcId,tile:n.tile})));
  // What no shop sells is gathered after the shops; a gather tool comes from the bank or a shop.
  const sellerAt=(id:number)=>{const it=catalogItem(id),n=it&&id!==COINS?nearestSeller(it.debugname,here()):null;return n?Math.max(Math.abs(n.tile.x-here().x),Math.abs(n.tile.z-here().z)):Infinity;};
  const gather=questGatherPlan(quest,p.missing,here(),sellerAt),tools=plan(new Map(gather.tools.map(t=>[t.id,t.count])),pack(),rows());
  p.withdraw.push(...tools.withdraw);
  const manorFood=manorFoodNeed(quest,p.missing),heckelDust=heckelDustNeed(quest,p.missing);
  const shop=shops([...groundShopNeeds(quest,p.missing).filter(m=>!gather.gathers.some(g=>g.id===m.id)&&!(manorFood&&m.id===MANOR_FOOD.id)),...tools.missing]);
  if(gather.gathers.length)console.log(`QUEST_SWEEP_GATHER_PLAN ${JSON.stringify(gather)}`);
  if(shop.unsold.length){await s.bot.closeBank();return fail('missing '+shop.unsold.map(i=>`${i.id}:${i.count}`).join(',')+(shop.buys.length?' (unsold; others in shops)':''));}
  const purchaseCoins=shop.coins+(heckelDust?HECKEL_DUST.coins:0);
  if(purchaseCoins){
   const take=Math.max(0,purchaseCoins-count(pack(),COINS)-(p.withdraw.find(w=>w.id===COINS)?.count??0));
   if(count(rows(),COINS)<take){await s.bot.closeBank();return fail(`missing ${COINS}:${take} to buy ${[...shop.buys.map(b=>b.id),...(heckelDust?[1975]:[])].join(',')}`+(shop.buys.some(b=>kit.wear.some(i=>i.required&&i.id===b.id))?' (required worn kit unavailable)':''));}
   if(take>0){const c=p.withdraw.find(w=>w.id===COINS);if(c)c.count+=take;else p.withdraw.push({id:COINS,count:take});}
   console.log(`QUEST_SWEEP_SHOP_PLAN ${JSON.stringify({buys:shop.buys,coins:shop.coins})}`);
  }
  // Milk replaces its staged bucket. Other gathered inputs need additional slots.
  const inputs=[...p.withdraw,...shop.buys,...gather.gathers.filter(g=>g.how!=='milk'),...(manorFood?[{id:MANOR_FOOD.id,count:1}]:[]),...(heckelDust?[{id:1975,count:1}]:[])];
  const capacity=await reserveInputSlots(s,inputs,new Set([...need.keys(),...FOOD,...gather.tools.map(i=>i.id),...inputs.map(i=>i.id)]));
  if(capacity){await s.bot.closeBank();return fail(capacity);}
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
  if(shop.buys.length){const why=await buyFromShops(s,world,shop.buys);if(why)return fail(why);}
  if(heckelDust){const dust=await fetchHeckelDust(heckelIO(s,world));if(!dust.ok)return fail(dust.detail!);}
  if(manorFood){const food=await fetchManorFishFood(manorIO(s,world),preset.position);if(!food.ok)return fail(food.detail!);}
  if(gather.gathers.length){const why=await gatherItems(s,world,gather.gathers);if(why)return fail(why);}
  const left=plan(need,pack(),[]).missing;
  if(left.length)return fail('withdraw short '+left.map(i=>`${i.id}:${i.count}`).join(','));
 }
 const worn=await wearQuestKit(s,kit.wear);
 if(worn)return fail(worn);
 if(retained())return await returnSkull();
 const start=preset.position;
 const exit=await leaveStronghold(s);
 if(!exit.ok)return fail(exit.detail!);
 await reachStart(s,world,start,quest);
 if(kit.wear.some(i=>!s.sdk.getEquipment().some(e=>e.id===i.id&&e.count>0)))return fail('worn kit missing before handover');
 console.log(`MILESTONE quest-sweep ${quest} staged at ${JSON.stringify(here())}`);
 observeQuestFlags(s);
 handed=true;
 await handOver(s,script,fresh);
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
