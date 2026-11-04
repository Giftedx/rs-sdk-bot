// Quest sweep: run one generated quest (scripts/generated/quest-<quest>.ts) on an ordinary account from wherever it
// stands. The quest's practice preset names its start tile and pack. This runner takes the missing pack items from the
// nearest bank, walks to the start tile and hands its session to the quest script, which owns the quest, the RESULT
// line and the logout. A missing item ends the run before travel with `missing id:count` (acquisition work).
// Usage: bun scripts/quest-sweep.ts <account> <quest>      e.g. bun scripts/quest-sweep.ts Mightyrod blackknight
// tbwt/itwatchtower require a third finite-options JSON path and stage mandatory owned pack/wear kits.
// Trio stages inside the observed Shilo bank and reuses its protected stockade exit; full28 pack carries no ferry fare.
// Heroes uses the explicit owned-pair quest-hero.ts CLI/API, never this single-account entry.
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,finish,getWorld,accountOf,finishHooks} from '../packages/core/src/bot';
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
import {BotActions} from '../vendor/rs-sdk/sdk/actions';
import {runOwnedLoadout,validateOwnedKit,type OwnedKit} from './microbot-owned-loadout';
import {productionStopRequested} from './microbot-c-lifetime';
import {createShiloTransit,NATURE} from './microbot-rune-trip';

type Item={id:number;count:number};
type Tile={x:number;z:number;level:number};
const BANKS:Tile[]=Object.values((travel as unknown as {banks:Record<string,Tile>}).banks);

export type SweepApiOptions={cap:number;prepareTicks:number;xpRate:number;maximumCasts?:number};
type ApiSweepDeps={open:typeof openBot;world:typeof getWorld;go:typeof goTo;loadout:typeof runOwnedLoadout;load:(path:string)=>Promise<Record<string,unknown>>;finish:(sessions:Session[],ok:boolean,detail:string)=>Promise<unknown>;exists:(path:string)=>boolean;stop:()=>boolean;transit:typeof createShiloTransit};
function apiOptions(quest:string,value:unknown):SweepApiOptions{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('quest sweep API requires explicit bounded options');const o=value as SweepApiOptions;
 if(Object.keys(o).some(k=>!['cap','prepareTicks','xpRate','maximumCasts'].includes(k))||![o.cap,o.prepareTicks,o.xpRate].every(Number.isSafeInteger)||o.cap<1000||o.cap>(quest==='tbwt'?15000:12000)||o.prepareTicks<200||o.prepareTicks>4000||o.xpRate<1||o.xpRate>1000||quest==='tbwt'&&(!Number.isSafeInteger(o.maximumCasts)||o.maximumCasts!<1||o.maximumCasts!>40)||quest==='itwatchtower'&&o.maximumCasts!==undefined)throw Error('quest sweep API invalid finite options');return{...o};
}
async function apiSweep(account:string,quest:'tbwt'|'itwatchtower',fresh:string|undefined,value:unknown,injected:Partial<ApiSweepDeps>){
 const o=apiOptions(quest,value),d:ApiSweepDeps={open:openBot,world:getWorld,go:goTo,loadout:runOwnedLoadout,load:path=>import(path),finish,exists:existsSync,stop:()=>false,transit:createShiloTransit,...injected};
 let signalled=false;const requested=()=>productionStopRequested(account,()=>signalled||d.stop(),d.exists)||d.exists('.practice/stop-quest-sweep');if(requested())throw Error('quest sweep API stopped before login');
 const path=resolve(import.meta.dir,'generated',`quest-${quest}.ts`),m=await d.load(fresh?`${path}?${fresh}`:path),run=m[quest==='tbwt'?'runTaiBwoWannaiTrio':'runWatchtower'];if(typeof run!=='function')throw Error('quest sweep explicit API export missing');
 const pack=quest==='tbwt'?Object.entries({3150:21,3032:1,3171:1,3128:1,3164:1,401:1,379:1,558:Math.max(20,o.maximumCasts!)}).map(([id,count])=>({id:Number(id),count})):Object.entries(m.WATCH_SUPPLIES as Record<number,number>).map(([id,count])=>({id:Number(id),count}));
 const wear=(quest==='tbwt'?[[1381,3],[1540,5],[577,4],[1011,7],[579,0]]:[[1289,3],[1540,5],[1127,4],[1079,7],[1163,0]]).map(([id,slot])=>({id:id!,slot:slot!,count:1})),start:Tile=quest==='tbwt'?{x:2781,z:3086,level:0}:{x:2548,z:3118,level:0};
 validateOwnedKit({bank:BANKS[0]!,pack,wear,cap:600,maximumMoves:160});if(requested())throw Error('quest sweep API stopped before login');
 const raw=await d.open(account,{onStop:async()=>{signalled=true;}}),client=raw.client as any,owner=client?.executeBotAction,self=client?.selfSlot,initial=raw.sdk.getState()?.player,life=initial?.lifeId,respawns=initial?.respawnCount??0,began=raw.tick();let ended=false,preparing=true,ok=false,detail='quest sweep API incomplete',transit:ReturnType<typeof createShiloTransit>|undefined,departed=false,recoveryDeferred=false;const cleanupReserve=quest==='tbwt'?Math.min(600,Math.floor(o.prepareTicks/2)):0;void raw.ended.then(()=>{ended=true;});
 const own=()=>{const p=raw.sdk.getState()?.player;return !ended&&!!initial&&typeof owner==='function'&&raw.client===client&&client.executeBotAction===owner&&client.selfSlot===self&&!!p&&!p.isDead&&p.lifeId===life&&(p.respawnCount??0)===respawns;};
 const stop=()=>!own()||requested()||preparing&&raw.tick()-began>=o.prepareTicks-cleanupReserve,guard=()=>{if(!own()||raw.sdk.getStateAge()>5000)throw Error('quest sweep original client/life/input owner unavailable');};
 // Keep the receiver through SDK reconnect and BotActions door/UI awaits.
 // Helpers retain their own ordinary-stop and owned-cleanup distinction.
 const sdk=new Proxy(raw.sdk,{get(target,key,receiver){const v=Reflect.get(target,key,receiver);return typeof v==='function'?function(...args:unknown[]){if(String(key).startsWith('send'))guard();return v.apply(receiver,args);}:v;}}),s=Object.create(raw)as Session;
 Object.defineProperties(s,{sdk:{value:sdk},bot:{value:new BotActions(sdk)},direct:{value:(action:Parameters<Session['direct']>[0])=>{guard();return raw.direct(action);}}});
 const controller=new AbortController(),off=raw.onTick(()=>{if(stop())controller.abort('quest sweep preparation stop/owner/budget');});
 const position=()=>{const p=s.sdk.getState()?.player;return p&&{x:p.worldX,z:p.worldZ,level:p.level};},near=(to:Tile,tol=3)=>{const p=position();return !!p&&p.level===to.level&&Math.max(Math.abs(p.x-to.x),Math.abs(p.z-to.z))<=tol;};
 const move=async(world:World,to:Tile)=>{guard();if(stop())throw Error('quest sweep preparation stopped');const r=await d.go(s,world,to,accountOf(s),{signal:controller.signal,legTimeoutTicks:120,maxRetriesPerLeg:1});guard();if(stop()||!r.ok||!near(to))throw Error('quest sweep preparation route unconfirmed '+(r.ok?'arrival/stop':r.detail));};
 try{
  guard();if(stop())throw Error('quest sweep preparation stopped');const flags=questFlags(client),journal=flags?.find(f=>f.name===(quest==='tbwt'?'Tai Bwo Wannai Trio':'Watch Tower'));if(journal?.state!=='not started'||quest==='tbwt'&&!flags?.some(f=>f.name==='Jungle Potion'&&f.state==='complete')||client.membersAccount!==1)throw Error('quest sweep observed member/journal/prerequisite unavailable');
  if(quest==='tbwt'&&(!flags?.some(f=>f.name==='Shilo Village'&&f.state==='complete')||(s.sdk.getSkill('Prayer')?.baseLevel??0)<43||(s.sdk.getState()?.prayers.prayerPoints??0)<40||s.sdk.getSkill('Hitpoints')?.level!==s.sdk.getSkill('Hitpoints')?.baseLevel||s.sdk.getState()?.autoRetaliateEnabled!==false||s.sdk.getState()?.prayers.activePrayers.some(Boolean)))throw Error('Trio sweep requires observed Shilo access, full health, Prayer43/40 points and original all-off controls');
  const world=await d.world();guard();if(stop())throw Error('quest sweep preparation stopped');
  const exit=await leaveStronghold(s,async to=>{await move(world,to);return{ok:true};});guard();if(!exit.ok||stop())throw Error('quest sweep observed Stronghold exit unavailable');
  const at=position();if(!at)throw Error('quest sweep initial position unknown');let bank:Tile|undefined,last='';for(const candidate of (quest==='tbwt'?[NATURE.bank]:nearestBanks({...at,level:0}).slice(0,4))){try{await move(world,candidate);bank=candidate;break;}catch(e){last=String(e);if(stop()||!own())throw e;}}if(!bank)throw Error('quest sweep reachable owned bank unavailable '+last);
  const remaining=o.prepareTicks-(s.tick()-began);if(remaining<120)throw Error('quest sweep owned kit preparation budget');const kit:OwnedKit={bank,pack,wear,cap:Math.min(600,remaining),maximumMoves:160},staged=await d.loadout(s,kit,stop);guard();if(staged.ok!==true||stop())throw Error('quest sweep mandatory owned kit unconfirmed '+staged.failure);
  const totals=(rows:readonly{id:number;count:number}[])=>Object.entries(rows.reduce((a,r)=>(a[r.id]=(a[r.id]??0)+r.count,a),{}as Record<number,number>)).sort(([a],[b])=>Number(a)-Number(b));
  if(JSON.stringify(totals(s.sdk.getInventory()))!==JSON.stringify(totals(pack))||JSON.stringify(s.sdk.getEquipment().map(i=>[i.slot,i.id,i.count]).sort((a,b)=>a[0]!-b[0]!))!==JSON.stringify(wear.map(i=>[i.slot,i.id,i.count]).sort((a,b)=>a[0]!-b[0]!)))throw Error('quest sweep mandatory observed pack/wear differs');
  if(quest==='tbwt'){transit=d.transit(s,{protectMelee:true},()=>own()&&(s.sdk.getSkill('Hitpoints')?.level??0)===(s.sdk.getSkill('Hitpoints')?.baseLevel??-1));departed=true;await transit.outbound(stop);guard();if(stop())throw Error('Trio Shilo departure unconfirmed');}
  await move(world,start);guard();if(stop())throw Error('quest sweep stopped before API dispatch');off();preparing=false;
  console.log('QUEST_SWEEP_API '+JSON.stringify({quest,phase:'dispatch',start,options:o}));const result=quest==='tbwt'?await run(s,{cap:o.cap,xpRate:o.xpRate,maximumCasts:o.maximumCasts},stop):await run(s,{cap:o.cap,xpRate:o.xpRate,stop});guard();
  if(!result||typeof result.ok!=='boolean'||result.complete!==true)throw Error('quest sweep API completion unknown');ok=result.ok&&!requested();detail=JSON.stringify({quest,scope:'explicit API on mandatory owned bank kit',result});
 }catch(error){detail=`quest-sweep ${quest} ${String(error)}`;if(preparing&&departed&&transit&&own()){if(transit.pending()){recoveryDeferred=true;detail+='; Shilo crossing outcome unknown; no repeat or bank movement';}else{const cleanupStop=()=>!own()||raw.tick()-began>=o.prepareTicks||(s.sdk.getSkill('Hitpoints')?.level??0)!==(s.sdk.getSkill('Hitpoints')?.baseLevel??-1);try{await transit.returnVillage(cleanupStop);guard();if(cleanupStop()||!near(NATURE.bank,0)||s.sdk.getState()?.prayers.activePrayers[14]!==false)throw Error('Shilo bank/protection restoration unconfirmed');}catch(cleanup){recoveryDeferred=true;detail+='; Shilo cleanup '+String(cleanup);}}}}finally{off();preparing=false;}
 if(recoveryDeferred||!own()){console.log('QUEST_SWEEP_SETTLEMENT_DEFERRED '+detail);return{ok:false,recoveryDeferred:true,detail};}return d.finish([s],ok,detail);
}

export function presetFor(quest:string):SaveConfig&{position:Tile}{
 const p=PRESETS['quest_'+quest];
 if(!p?.position)throw Error(`quest sweep: no preset quest_${quest} with a start tile`);
 return{...p,position:{level:0,...p.position},...(quest==='hazeelcult'?{inventory:[{id:385,count:4}]}:{})};
}
// Preset food (lobster, shark) only feeds the quest's eat-at threshold, and teleport runes (fire, water, air, earth,
// law) only save walking (quest-lib teleport walks without a law rune): the runner takes what the bank holds of both.
export const FOOD=new Set([379,385,554,555,556,557,563]),COINS=995;
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

async function reachStart(s:Session,world:World,start:Tile){
 const p=s.sdk.getState()?.player;
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
  const before=held(b.id);
  for(let i=0;i<12&&held(b.id)<before+b.count;i++){
   const row=(st()?.shop?.shopItems??[]).find((x:any)=>x.id===b.id);
   if(!row||row.count<1){await waitTicks(s,50);continue;}
   const want=Math.min(before+b.count-held(b.id),row.count),had=held(b.id);
   await s.bot.buyFromShop(row,want);
   await waitUntil(s,()=>held(b.id)>=had+want,{timeoutTicks:10});
  }
  const got=held(b.id)>=before+b.count;
  console.log(`QUEST_SWEEP_BUY ${JSON.stringify({item:b.id,name:b.name,count:b.count,npc:b.npc,before,after:held(b.id),coins:held(COINS)})}`);
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

export async function sweep(account:string,quest:string,fresh?:string,options?:SweepApiOptions,deps:Partial<ApiSweepDeps>={}){
 if(quest==='hero'||quest==='heroes')throw Error('Heroes requires the explicit owned pair CLI quest-hero.ts or runHeroesPair(original sessions, validated order); no single-actor partner login');
 if(quest==='tbwt'||quest==='itwatchtower')return apiSweep(account,quest,fresh,options,deps);
 const script=resolve(import.meta.dir,'generated',`quest-${quest}.ts`);
 if(!existsSync(script))throw Error(`quest sweep: no script ${script}`);
 const preset=presetFor(quest),need=needs(preset),food=needs(preset,true);
 const s:Session=await openBot(account);
 const fail=(why:string)=>finish([s],false,`quest-sweep ${quest} ${why}`);
 let handed=false;
 try {
 const st=()=>s.sdk.getState();
 if(!await waitUntil(s,()=>!!st()?.player,{timeoutTicks:20}))return fail('entry state unavailable');
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
 if(plan(need,pack(),[]).missing.length||plan(food,pack(),[]).missing.length){
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
  const p=plan(need,pack(),rows()),meal=plan(food,pack(),rows()).withdraw;
  p.withdraw.push(...meal);
  // A missing item a shop sells is bought after the bank: take coins for it now.
  const shops=(items:readonly Item[])=>shopPlan(items,here(),catalogItem,(d,at)=>{const n=nearestSeller(d,at);return n&&{npc:n.npc,npcId:n.npcId,tile:n.tile};},(d,at)=>sellersByDistance(d,at).map(n=>({npc:n.npc,npcId:n.npcId,tile:n.tile})));
  // What no shop sells is gathered after the shops; a gather tool comes from the bank or a shop.
  const sellerAt=(id:number)=>{const it=catalogItem(id),n=it&&id!==COINS?nearestSeller(it.debugname,here()):null;return n?Math.max(Math.abs(n.tile.x-here().x),Math.abs(n.tile.z-here().z)):Infinity;};
  const gather=gatherPlan(p.missing,here(),spawnsByDistance,sellerAt),tools=plan(new Map(gather.tools.map(t=>[t.id,t.count])),pack(),rows());
  p.withdraw.push(...tools.withdraw);
  const shop=shops([...p.missing.filter(m=>!gather.gathers.some(g=>g.id===m.id)),...tools.missing]);
  if(gather.gathers.length)console.log(`QUEST_SWEEP_GATHER_PLAN ${JSON.stringify(gather)}`);
  if(shop.unsold.length){await s.bot.closeBank();return fail('missing '+shop.unsold.map(i=>`${i.id}:${i.count}`).join(',')+(shop.buys.length?' (unsold; others in shops)':''));}
  if(shop.coins){
   const take=Math.max(0,shop.coins-count(pack(),COINS)-(p.withdraw.find(w=>w.id===COINS)?.count??0));
   if(count(rows(),COINS)<take){await s.bot.closeBank();return fail(`missing ${COINS}:${take} to buy ${shop.buys.map(b=>b.id).join(',')}`);}
   if(take>0){const c=p.withdraw.find(w=>w.id===COINS);if(c)c.count+=take;else p.withdraw.push({id:COINS,count:take});}
   console.log(`QUEST_SWEEP_SHOP_PLAN ${JSON.stringify({buys:shop.buys,coins:shop.coins})}`);
  }
  // Free the slots the withdrawals need: bank every pack item the quest does not use.
  const slots=p.withdraw.reduce((n,i)=>n+i.count,0);
  if(28-(st()?.inventory?.length??0)<slots)for(const i of [...(st()?.inventory??[])])if(!need.has(i.id))await s.bot.depositItem(i,-1);
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
  if(gather.gathers.length){const why=await gatherItems(s,world,gather.gathers);if(why)return fail(why);}
  const left=plan(need,pack(),[]).missing;
  if(left.length)return fail('withdraw short '+left.map(i=>`${i.id}:${i.count}`).join(','));
 }
 const start=preset.position;
 const exit=await leaveStronghold(s);
 if(!exit.ok)return fail(exit.detail!);
 await reachStart(s,world,start);
 console.log(`MILESTONE quest-sweep ${quest} staged at ${JSON.stringify(here())}`);
 const seen=new Map<number,string>();
 const observe=()=>{for(const q of questFlags(s.client)??[])if(seen.get(q.id)!==q.state){
  seen.set(q.id,q.state);console.log(`QUEST_SWEEP_FLAG ${JSON.stringify(q)}`);
 }};
 observe();const off=s.onTick(observe);void s.ended.then(off);
 handed=true;
 await handOver(s,script,fresh);
 } catch(error) {
  if(handed)throw error;
  return fail(String(error));
 }
}

async function main(){
 const [account,quest,optionsPath]=process.argv.slice(2);
 if(!account||!quest)throw Error('usage: bun scripts/quest-sweep.ts <account> <quest> [api-options.json]');
 let options:SweepApiOptions|undefined;if(quest==='tbwt'||quest==='itwatchtower'){if(!optionsPath)throw Error('quest sweep API requires an owned finite options JSON file');const bytes=readFileSync(optionsPath);if(bytes.length>32768)throw Error('quest sweep options file too large');let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw Error('invalid quest sweep options JSON');}options=apiOptions(quest,value);}
 // As a bot-host entry, the quest module's finish() (plain bot.ts) reports through this entry's own finish, which
 // the host rewrites to the per-bot one; without it the quest's finish would end the whole host.
 if((globalThis as {__rsBotHost?:unknown}).__rsBotHost)finishHooks.set(account.toLowerCase(),(ok,detail)=>{void finish([],ok,detail);});
 // A unique query: in a bot host, each account runs the quest module afresh.
 await sweep(account,quest,`run=${account.toLowerCase()}-${Date.now()}`,options);
}

if(import.meta.main)await main();
