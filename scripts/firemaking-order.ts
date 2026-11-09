// bun scripts/firemaking-order.ts <account>
// TARGET_LEVEL (required), MAX_LOGS=10000, CAP=20000 ticks, LOG=normal|oak|willow|maple|yew|magic.
// PROGRESSIVE=1 reselects the highest native tier after each BATCH=27 logs, with no stock fallback.
// Server comes from openBot's account config. Acceptance belongs to packages/practice/src/firemaking-order-proof.ts.
// Source decision: scripts/measure/fm-line-search.ts --from 3092,3243 --safe -> BURN_ROWS (danger 0, 3 and 9 tiles
// from the Draynor booths); floor-fm-line.ts push/turn rules -> burn(). Reuse by import: gather-yews.ts session, walk
// and bank modules, shop-buyer.ts planShopPurchases/buyWithBudget. Reject the measurement CLIs (they log in on load).
// skill_firemaking/scripts/firemaking.rs2: light_logs_inv refuses "You can't light a fire here." before it drops the
// log; firemaking_success deletes the ground log, then stat_advance. push_player tries west, east, south, north.
import {openBot,finish,getWorld,accountOf} from '../packages/core/src/bot';
import {BotActions} from '../vendor/rs-sdk/sdk/actions';
import {productionStopRequested} from './microbot-c-lifetime';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {walkPath,sessionWalker,walkRoute,FAR_WALK_TILES,type PathPoint} from '../packages/core/src/walk';
import {installDoorPolicy,type Account,type Leg} from '../packages/core/src/world';
import {loadTravel,travelAllowed,type Travel} from '../packages/core/src/travel';
import {planTripOffThread} from '../packages/core/src/route-plan';
import {depositObserved} from '../packages/core/src/deposit';
import {planShopPurchases,buyWithBudget,maximumUnitCost} from './shop-buyer';

// Native skill_firemaking/configs/firemaking.obj levelrequire; modern log families are absent.
export const LOGS={normal:{id:1511,name:'Logs',level:1},oak:{id:1521,name:'Oak logs',level:15},willow:{id:1519,name:'Willow logs',level:30},maple:{id:1517,name:'Maple logs',level:45},yew:{id:1515,name:'Yew logs',level:60},magic:{id:1513,name:'Magic logs',level:75}} as const;
export type LogKind=keyof typeof LOGS;
export function progressiveFiremakingLog(level:number):LogKind{
 if(!Number.isSafeInteger(level)||level<1||level>99)throw Error('native Firemaking base level unknown');
 return(Object.keys(LOGS)as LogKind[]).filter(k=>LOGS[k].level<=level).at(-1)!;
}
export const TINDERBOX=590,COINS=995,FIREMAKING='Firemaking';
export const DRAYNOR_BANK={x:3092,z:3243};
export const BURN_ROWS=[{z:3248,sx:3098,ex:3072},{z:3250,sx:3105,ex:3077}] as const;
export type BurnRow={z:number;sx:number;ex:number};
export interface FiremakingSite{name:string;bank:{x:number;z:number};rows:readonly BurnRow[];localEntry?:boolean}
export const DRAYNOR_SITE:FiremakingSite={name:'Draynor',bank:DRAYNOR_BANK,rows:BURN_ROWS};
// Bank: gather-fish.ts and shark-supply.ts. Rows: fm-line-search.ts --from 2809,3441 --safe --need 27 --turns 0.
// Each 24-tile row passes the active-loc, collision, bank-zone and hunter checks on pinned content.
export const CATHERBY_SITE:FiremakingSite={name:'Catherby',bank:{x:2809,z:3441},
 rows:[{z:3433,sx:2812,ex:2789},{z:3436,sx:2829,ex:2806}],localEntry:true};
// Nearby western entries use the ground walker and its account danger mask. Other entries retain Draynor.
export const firemakingSite=(p:{x:number;z:number;level:number}):FiremakingSite=>
 p.level===0&&Math.max(Math.abs(p.x-CATHERBY_SITE.bank.x),Math.abs(p.z-CATHERBY_SITE.bank.z))<=64?CATHERBY_SITE:DRAYNOR_SITE;
// lumbridge.npc shop_keeper generalshop1 (sell multiplier 1300); lumbridge.inv stock5=tinderbox; tinderbox cost 1.
// Route legs: the Draynor <-> Lumbridge road used by scripts/gather-yews.ts.
export const TINDER_SHOP={npc:/^(shopkeeper|shop assistant)$/i,item:/^tinderbox$/i,baseCost:1,sellMultiplier:1300,
 route:[{x:3092,z:3250,tol:1},{x:3089,z:3266,tol:2},{x:3100,z:3270,tol:2},{x:3140,z:3270,tol:2},{x:3180,z:3258,tol:2},{x:3212,z:3246,tol:2}] as PathPoint[]};
export const PACK_LOGS=27,LIGHT_TICKS=120,TILE_WAIT_TICKS=40;

export interface FiremakingOptions{target:number;maxLogs:number;cap:number;log:LogKind;toolBudget:number;cashReserve:number;progressive?:boolean;batch?:number;burnOnly?:boolean}
export function firemakingOptions(env:Record<string,string|undefined>=process.env):FiremakingOptions{
 const int=(key:string,fallback:number|undefined,min:number,max:number)=>{
  const n=Number(env[key]??fallback);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(`invalid ${key}`);return n;};
 const log=(env.LOG??'normal').toLowerCase();if(!Object.hasOwn(LOGS,log))throw Error('invalid native LOG');
 if(env.BURN_ONLY!==undefined&&!['0','1'].includes(env.BURN_ONLY))throw Error('invalid BURN_ONLY');
 if(env.PROGRESSIVE!==undefined&&!['0','1'].includes(env.PROGRESSIVE))throw Error('invalid PROGRESSIVE');
 return{...env.BURN_ONLY==='1'?{burnOnly:true}:{},target:int('TARGET_LEVEL',env.BURN_ONLY==='1'?99:undefined,2,99),maxLogs:int('MAX_LOGS',10000,1,1000000),cap:int('CAP',20000,1,10000000),
  log:log as LogKind,toolBudget:int('TOOL_BUDGET',50,0,1000000),cashReserve:int('CASH_RESERVE',0,0,2000000000),...env.PROGRESSIVE==='1'?{progressive:true,batch:int('BATCH',27,1,27)}:{}};
}
// Player.ts levelExperience: this server uses 2^(level/10), not the 2^(level/7) table.
export function xpForLevel(level:number){let points=0;for(let l=1;l<level;l++)points+=Math.floor(l+300*2**(l/10));return Math.floor(points/4);}
export function levelForXp(xp:number){let level=1;while(level<99&&xp>=xpForLevel(level+1))level++;return level;}
// Logs still needed to reach the target at the observed XP per log.
export function logShortfall(target:number,xp:number,xpPerLog:number,owned:number){
 if(!(xpPerLog>0))return Math.max(1-owned,0);
 return Math.max(0,Math.ceil((xpForLevel(target)-xp)/xpPerLog)-owned);
}
export function firemakingPreflight(o:FiremakingOptions,s:{plane:number;baseLevel:number;level:number}){
 if(!Number.isSafeInteger(s.baseLevel)||s.baseLevel<1)return 'firemaking state unknown';
 if(!o.burnOnly&&s.baseLevel>=o.target)return 'already at target';
 if(s.plane!==0)return 'off plane 0';
 if(s.level<LOGS[o.log].level)return `${LOGS[o.log].name} need Firemaking ${LOGS[o.log].level}`;
 return null;
}
export const lineTiles=(rows:readonly BurnRow[]=BURN_ROWS)=>rows.flatMap((r,row)=>Array.from({length:r.sx-r.ex+1},(_,i)=>({x:r.sx-i,z:r.z,row})));
// First usable tile from `from`, cyclic over the line. -1 when every tile is on fire or refused.
export function nextFreeTile(tiles:readonly {x:number;z:number}[],from:number,blocked:(t:{x:number;z:number})=>boolean){
 for(let i=0;i<tiles.length;i++){const k=(from+i)%tiles.length;if(!blocked(tiles[k]!))return k;}
 return -1;
}
// Logs to withdraw: one pack of unnoted logs (one slot each), bounded by free slots and the MAX_LOGS remainder.
export function packWant(heldLogs:number,usedSlots:number,remaining:number){
 return Math.max(0,Math.min(PACK_LOGS,28-usedSlots+heldLogs,remaining)-heldLogs);
}
export function rowStart(row:number,rows:readonly BurnRow[]=BURN_ROWS){return rows.slice(0,row%rows.length).reduce((n,r)=>n+r.sx-r.ex+1,0);}
// One tinderbox only when none is owned in the pack, bank or equipment.
export function tinderboxPlan(owned:number,shop:{name:string;count:number;buyPrice:number}[],inventory:{name:string;count:number}[],budget:number){
 if(owned>0)return [];
 return planShopPurchases([{re:TINDER_SHOP.item,buyPerTick:1}],shop,inventory,new Map(),budget,1,1);
}
export const tinderboxUnitMax=()=>maximumUnitCost({baseCost:TINDER_SHOP.baseCost},{sellMultiplier:TINDER_SHOP.sellMultiplier});
export class Refusal extends Error{}
// The distant bank entry plans with no coins and no consumable travel items (runes, rubbed jewellery, consumed
// passes), so the planner can pick only free legs. Keys, worn gear, skills, quest stages and danger keep their checks.
export function freeRouteAccount(a:Account,travel:readonly Travel[]=loadTravel()):Account{
 const used=new Set(travel.flatMap(t=>[...t.runes.map(r=>r.item),...(t.run.how==='rub'?t.run.items:[]),...t.needs.flatMap(n=>'held' in n?[n.held]:[])]));
 return{...a,coins:0,counts:Object.fromEntries(Object.entries(a.counts??{}).filter(([i])=>!used.has(i))),items:a.items.filter(i=>!used.has(i))};
}
// Travel legs that would take a fare or a consumable from the masked account. Empty for a free route.
export const routeDebits=(legs:readonly Leg[],free:Account)=>
 legs.flatMap(l=>l.kind==='travel'&&(l.travel.coins>0||!travelAllowed(l.travel,free))?[l.travel.name]:[]);
// Estimates in ticks kept back from the entry for one bank stop and the burns of one pack.
export const ENTRY_BANK_TICKS=40,ENTRY_BURN_TICKS=20;
export const entryBudget=(o:FiremakingOptions,used:number)=>o.cap-used-ENTRY_BANK_TICKS-ENTRY_BURN_TICKS*Math.min(o.maxLogs,PACK_LOGS);

export async function runFiremaking(s:Session,o:FiremakingOptions,selectedSite?:FiremakingSite){
 let L=LOGS[o.log];const start=s.tick();let ended=false;
 void s.ended.then(()=>{ended=true;});
 const st=()=>s.sdk.getState(),pos=()=>st()!.player!;
 const inv=()=>s.sdk.getInventory(),held=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const worn=(id:number)=>(st()?.equipment??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const xp=()=>s.sdk.getSkillXp(FIREMAKING)!,base=()=>s.sdk.getSkill(FIREMAKING)!.baseLevel,hp=()=>s.sdk.getSkill('Hitpoints')!.level;
 const ready=()=>{const p=st()?.player,f=s.sdk.getSkill(FIREMAKING),h=s.sdk.getSkill('Hitpoints');
  return !!p&&p.worldX>0&&!!f&&f.baseLevel>0&&!!h&&h.baseLevel>0&&Number.isFinite(s.sdk.getSkillXp(FIREMAKING))&&Array.isArray(st()?.inventory);};
 if(!await waitUntil(s,ready,{timeoutTicks:20}))throw Error('entry state unobserved');
 const guarded=!!o.burnOnly||!!o.progressive||L.level>=45;
 let continuation=()=>{};
 if(guarded){
  const original=s,client=s.client,executor=(client as any)?.executeBotAction,p=st()!.player!,life=p.lifeId,respawns=p.respawnCount??0,plane=p.level,initialHP=hp();let lost=false;
  continuation=()=>{const now=original.sdk.getState()?.player;if(original.client!==client||(client as any)?.executeBotAction!==executor)lost=true;
   if(lost||typeof executor!=='function'||ended||life===undefined||!now||now.isDead||now.lifeId!==life||(now.respawnCount??0)!==respawns||now.level!==plane||(original.sdk.getSkill('Hitpoints')?.level??0)<initialHP||original.tick()-start>=o.cap||productionStopRequested(original.name))throw Error('firemaking original owner/life/HP/stop/budget unavailable');};
  const sdk=new Proxy(original.sdk,{get(target,key,receiver){const v=Reflect.get(target,key,receiver);return typeof v==='function'?function(...args:unknown[]){if(typeof key==='string'&&key.startsWith('send'))continuation();return v.apply(receiver,args);}:v;}});
  s={...original,sdk,bot:new BotActions(sdk),direct:async(action:Parameters<Session['direct']>[0])=>{continuation();return original.direct(action);}}as Session;
 }
 let hpMin=hp();const off=s.onTick(()=>{const h=s.sdk.getSkill('Hitpoints')?.level;if(h!==undefined)hpMin=Math.min(hpMin,h);});
 const project=(list:{slot:number;id:number;count:number}[]|undefined)=>(list??[]).map(({slot,id,count})=>({slot,id,count}));
 const at=()=>({x:pos().worldX,z:pos().worldZ,level:pos().level});
 const site=selectedSite??firemakingSite(at()),bank=site.bank;
 const startXp=xp(),startLevel=base();if(o.progressive){if(!Number.isSafeInteger(o.batch)||o.batch!<1||o.batch!>27)throw Error('invalid progressive batch');L=LOGS[progressiveFiremakingLog(startLevel)];}
 console.log('FIREMAKING_INITIAL '+JSON.stringify({name:s.name,options:o,tick:s.tick(),position:at(),hp:hp(),xp:startXp,level:startLevel,
  inventory:project(st()?.inventory),equipment:project(st()?.equipment)}));
 const live=()=>{if(guarded)continuation();if(ended)throw Error('session interrupted');if(hp()<=0)throw Error('died');};
 const r={ok:false,stop:'',target:o.target,log:o.log,startLevel,level:startLevel,xpGained:0,logsBurnt:0,xpPerLog:0,ticks:0,logsPer1kTicks:0,
  hpMin,bankTrips:0,tinderbox:{source:'',spent:0},ownedLogs:0,shortfall:0,refused:'',failure:''};
 const seen=new Set<string>();
 const fresh=(re:RegExp)=>{let hit=false;for(const m of st()?.gameMessages??[]){const k=`${(m as any).observationId}:${m.tick}:${m.text}`;if(seen.has(k))continue;seen.add(k);if(re.test(m.text))hit=true;}return hit;};
 fresh(/$^/);
 const walk=async(points:PathPoint[],label:string,maxTicks=400)=>{
  live();const w=await walkPath(await sessionWalker(s),points,{maxTicks,stop:()=>ended||hp()<=0});
  live();const p=pos(),goal=points.at(-1)!;
  if(!w.ok||p.level!==0||Math.max(Math.abs(p.worldX-goal.x),Math.abs(p.worldZ-goal.z))>(goal.tol??0))
   throw Error(`${label}: walk unobserved ${JSON.stringify({detail:w.detail,at:at(),goal})}`);
 };
 let bankItems:{id:number;name:string;count:number}[]=[];
 const banked=(id:number)=>bankItems.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const openBank=async()=>{
  if(st()?.bank?.isOpen&&s.bankObservation?.()){refresh();return;}
  const p=pos(),distance=Math.max(Math.abs(p.worldX-bank.x),Math.abs(p.worldZ-bank.z));
  if(site.localEntry&&distance>3){
   const budget=entryBudget(o,s.tick()-start);
   if(budget<=0)throw new Refusal(`no entry budget: CAP ${o.cap}, used ${s.tick()-start}`);
   await walk([{...bank,tol:2}],`walk to ${site.name} bank`,budget);
  }else if(distance>FAR_WALK_TILES){
   // World routes preserve account access and danger masks across distant region boundaries. goTo replans with
   // the full observed account (coins, runes, bank fares), so the free route is planned and checked here first.
   // Keep rebanking and burn-line clicks on the existing local walker.
   live();const began=s.tick(),budget=entryBudget(o,began-start);
   if(budget<=0)throw new Refusal(`no entry budget: CAP ${o.cap}, used ${began-start}`);
   const free=freeRouteAccount(accountOf(s)),world=await getWorld();
   await installDoorPolicy(s.sdk,s.client);
   const from={x:p.worldX,z:p.worldZ,level:p.level},to={...bank,level:0};
   const plan=world.offThread?await planTripOffThread(from,to,free):(()=>{const d=world.route(from,to,free);return d.ok?d:null;})();
   live();
   if(!plan)throw new Refusal(`no free route to ${site.name} bank from ${from.x},${from.z}`);
   const debits=routeDebits(plan.legs,free);
   if(debits.length)throw new Refusal(`route to ${site.name} bank takes fares or consumables: ${debits.join(', ')}`);
   if(plan.cost>budget)throw new Refusal(`route to ${site.name} bank estimates ${plan.cost} ticks, entry budget ${budget}`);
   console.log('FIREMAKING_ENTRY '+JSON.stringify({tick:s.tick(),from,cost:plan.cost,budget,legs:plan.legs.length,fares:0}));
   const ac=new AbortController();
   const stop=()=>{if(ended||hp()<=0||s.tick()-began>=budget)ac.abort('bank entry stopped or tick budget reached');};
   const unwatch=s.onTick(stop);stop();
   try{
    const w=await walkRoute(s,plan.legs,{legTimeoutTicks:150,signal:ac.signal});
    live();const arrived=pos();
    if(!w.ok||arrived.level!==0||Math.max(Math.abs(arrived.worldX-bank.x),Math.abs(arrived.worldZ-bank.z))>3)
     throw Error(`walk to ${site.name} bank: route unobserved ${JSON.stringify({outcome:w,at:at()})}`);
   }finally{unwatch();ac.abort('bank entry finished');}
  }else if(distance>3)await walk([{...bank,tol:2}],`walk to ${site.name} bank`);
  const g=s.bankObservation?.()?.generation??0,b=await s.bot.openBank();live();
  if(!b.success||!await waitUntil(s,()=>!!st()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>g,{timeoutTicks:20}))throw Error(`bank open unobserved: ${b.message}`);
  r.bankTrips++;refresh();
  console.log('FIREMAKING_BANK '+JSON.stringify({tick:s.tick(),trip:r.bankTrips,logs:banked(L.id),tinderbox:banked(TINDERBOX),coins:banked(COINS),pack:project(st()?.inventory)}));
 };
 const refresh=()=>{const b=s.bankObservation?.();if(!b)throw Error('bank contents unobserved');bankItems=b.items.map(i=>({...i}));};
 // Pack credit and bank debit in a newer bank observation (the depositObserved rule): the pack can update first.
 const withdraw=async(id:number,n:number)=>{
  const item=st()?.bank?.items.find(i=>i.id===id),h0=held(id),b0=banked(id),g=s.bankObservation?.()?.generation??0;
  if(!item||n<1)throw Error(`bank item ${id} unavailable`);
  const w=await s.bot.withdrawItem(item,n,{asNote:false});live();
  const done=()=>{const b=s.bankObservation?.();return !!b&&b.generation>g&&held(id)===h0+n&&b.items.filter(i=>i.id===id).reduce((k,i)=>k+i.count,0)===b0-n;};
  if(!await waitUntil(s,done,{timeoutTicks:10}))throw Error(`withdraw ${id} x${n} unobserved: ${w.message}`);
  refresh();
 };
 const deposit=async(id:number)=>{
  const item=inv().find(i=>i.id===id);if(!item)return;
  await depositObserved(s,{id,name:item.name});live();refresh();
 };
 const closeBank=async()=>{if(st()?.bank?.isOpen){await s.bot.closeBank();live();}
  if(!await waitUntil(s,()=>!st()?.bank?.isOpen,{timeoutTicks:10}))throw Error('bank close unobserved');};
 const coins=()=>held(COINS);
 const buyTinderbox=async()=>{
  const unit=tinderboxUnitMax(),total=coins()+banked(COINS);
  if(Math.min(o.toolBudget,total-o.cashReserve)<unit)throw new Refusal(`tinderbox unaffordable: budget ${o.toolBudget}, coins ${total}, reserve ${o.cashReserve}, unit max ${unit}`);
  if(site.localEntry)throw new Refusal(`${site.name} site requires an owned tinderbox`);
  if(coins()<unit)await withdraw(COINS,Math.min(banked(COINS),o.toolBudget));
  const reserve=Math.max(0,o.cashReserve-banked(COINS)),coins0=coins();
  await closeBank();
  await walk(TINDER_SHOP.route,'walk to Lumbridge general store',600);
  const shop=await s.bot.openShop(TINDER_SHOP.npc);live();
  if(!shop.success||!await waitUntil(s,()=>!!st()?.shop?.isOpen,{timeoutTicks:10}))throw Error(`tinderbox shop unobserved: ${shop.message}`);
  let bought=0,spent=0;
  try{
   const plan=tinderboxPlan(0,st()!.shop!.shopItems,inv(),Math.min(o.toolBudget,coins()-reserve));
   if(plan.length!==1)throw Error(`tinderbox unavailable inside budget ${JSON.stringify(st()?.shop?.shopItems?.filter(i=>TINDER_SHOP.item.test(i.name)))}`);
   ({bought,spent}=await buyWithBudget(s.bot,s.sdk as any,plan[0]!.name,1,reserve,o.toolBudget));live();
  }finally{await s.bot.closeShop();}
  if(bought!==1||held(TINDERBOX)!==1||spent<=0||spent>o.toolBudget||coins0-coins()!==spent)throw Error(`tinderbox purchase effect unobserved ${JSON.stringify({bought,spent,coins:coins(),coins0})}`);
  r.tinderbox={source:'bought',spent};
  console.log('FIREMAKING_PURCHASE '+JSON.stringify({tick:s.tick(),item:'tinderbox',bought,spent,budget:o.toolBudget,coins:coins()}));
  await walk([...TINDER_SHOP.route].reverse().slice(1).concat([{...bank,tol:2}]),`walk back to ${site.name} bank`,600);
  await openBank();
 };
 // ---- Light one log on the current tile. Returns the XP gain, or 'blocked' when the tile refuses a fire.
 const light=async():Promise<number|'blocked'>=>{
  const tb=inv().find(i=>i.id===TINDERBOX),log=inv().find(i=>i.id===L.id);
  if(!tb||!log)throw Error('tinderbox or log missing from pack');
  if(st()?.dialog?.isOpen||st()?.modalOpen)await s.direct({type:'closeModal',reason:'SDK'});
  const inventoryTotals=()=>{const out:Record<number,number>={};for(const i of inv())out[i.id]=(out[i.id]??0)+i.count;return out;};
  const expected=guarded?inventoryTotals():undefined;if(expected)expected[L.id]=(expected[L.id]??0)-1;
  const gear=guarded?JSON.stringify(project(st()?.equipment)):undefined,otherXP=()=>JSON.stringify((st()?.skills??[]).filter(k=>k.name!==FIREMAKING).map(k=>[k.name,k.experience]));
  const xpOther=guarded?otherXP():undefined;
  const x0=xp(),n0=held(L.id),sent=s.tick();fresh(/$^/);
  await s.sdk.sendUseItemOnItem(tb.slot,log.slot);
  let resends=0;
  while(s.tick()-sent<LIGHT_TICKS){
   await waitTicks(s,1);live();
   if(xp()>x0){await waitUntil(s,()=>held(L.id)===n0-1,{timeoutTicks:3});if(guarded){
    const receipt=()=>{live();const actual=inventoryTotals();if([...new Set([...Object.keys(expected!),...Object.keys(actual)])].some(id=>(actual[+id]??0)!==(expected![+id]??0))||JSON.stringify(project(st()?.equipment))!==gear||otherXP()!==xpOther)throw Error('native burn whole-pack/gear/other-XP receipt differs');};receipt();
    // firemaking_success -> push_player p_delay(0): one suspension plus one publication tick.
    for(let settle=0;settle<2;settle++){await waitTicks(s,1);receipt();}
   }return xp()-x0;}
   if(fresh(/can't light a fire here/i))return 'blocked';
   if(fresh(/need a firemaking level|need a tinderbox/i))throw Error('light refused by server');
   // A modal (a level-up dialog) can swallow the packet: close it and resend only while the log is still in the
   // pack, never after the drop.
   if(!guarded&&held(L.id)===n0&&s.tick()-sent>=4*(resends+1)&&resends<3){
    resends++;if(st()?.dialog?.isOpen||st()?.modalOpen)await s.direct({type:'closeModal',reason:'SDK'});
    const t=inv().find(i=>i.id===TINDERBOX),l=inv().find(i=>i.id===L.id);if(t&&l)await s.sdk.sendUseItemOnItem(t.slot,l.slot);
   }
  }
  throw Error(`light effect unobserved ${JSON.stringify({at:at(),ticks:s.tick()-sent,held:held(L.id),n0})}`);
 };
 const tiles=lineTiles(site.rows),refused=new Map<string,number>();
 const key=(t:{x:number;z:number})=>`${t.x},${t.z}`;
 const fireAt=(t:{x:number;z:number})=>(st()?.nearbyLocs??[]).some(l=>l.x===t.x&&l.z===t.z&&/^fire$/i.test(l.name));
 const blocked=(t:{x:number;z:number})=>fireAt(t)||(refused.get(key(t))??-1)>s.tick();
 let cursor=0;
 const owned=()=>held(L.id)+banked(L.id);
 const stopReason=()=>!o.burnOnly&&base()>=o.target?'target':r.logsBurnt>=o.maxLogs?'max-logs':s.tick()-start>=o.cap?'cap':owned()<1?'logs-exhausted':'';
 try{
  if(guarded)continuation();
  const pre=firemakingPreflight(o.progressive?{...o,log:progressiveFiremakingLog(startLevel)}:o,{plane:pos().level,baseLevel:startLevel,level:s.sdk.getSkill(FIREMAKING)!.level});
  if(pre)throw new Refusal(pre);
  await openBank();
  r.ownedLogs=owned();
  if(r.ownedLogs<1){r.shortfall=1;throw new Refusal(`short log stock: need 1 ${L.name}, own 0, shortfall 1`);}
  const tinderOwned=held(TINDERBOX)+banked(TINDERBOX)+worn(TINDERBOX);
  if(held(TINDERBOX)+worn(TINDERBOX)>0)r.tinderbox.source='pack';
  else if(banked(TINDERBOX)>0){await withdraw(TINDERBOX,1);r.tinderbox.source='bank';}
  else if(tinderOwned===0)await buyTinderbox();
  let row=0;
  for(;;){
   if(o.progressive){L=LOGS[progressiveFiremakingLog(base())];if(s.sdk.getSkill(FIREMAKING)!.level<L.level)throw new Refusal('selected progressive Firemaking level drained');}
   r.stop=stopReason();if(r.stop)break;
   // At the bank: carry up to one pack of logs, bounded by MAX_LOGS.
   const want=packWant(held(L.id),inv().length,Math.min(o.maxLogs-r.logsBurnt,o.progressive?o.batch!:Infinity));
   if(want>0&&banked(L.id)>0)await withdraw(L.id,Math.min(want,banked(L.id)));
   if(held(L.id)<1)throw Error('pack has no logs after withdrawal');
   await closeBank();
   cursor=rowStart(row,site.rows);row++;
   const batchStart=r.logsBurnt;
   while(held(L.id)>0&&(!o.progressive||r.logsBurnt-batchStart<o.batch!)){
    r.stop=stopReason();if(r.stop)break;
    let i=nextFreeTile(tiles,cursor,blocked);
    for(let w=0;i<0&&w<TILE_WAIT_TICKS;w++){await waitTicks(s,1);live();i=nextFreeTile(tiles,cursor,blocked);}
    if(i<0)throw Error('no free line tile within the wait bound');
    const t=tiles[i]!,p=pos();
    if(p.worldX!==t.x||p.worldZ!==t.z)await walk([{x:t.x,z:t.z,tol:0}],`walk to line tile ${key(t)}`,60);
    const gain=await light();
    if(gain==='blocked'){refused.set(key(t),s.tick()+200);cursor=i+1;continue;}
    r.logsBurnt++;r.xpPerLog||=gain;
    if(gain!==r.xpPerLog)console.log('FIREMAKING_WARN '+JSON.stringify({event:'xp-per-log-changed',gain,xpPerLog:r.xpPerLog}));
    cursor=i+1;
    console.log('FIREMAKING_PROGRESS '+JSON.stringify({burns:r.logsBurnt,xp:xp(),level:base(),tick:s.tick(),x:t.x,z:t.z,...o.progressive?{logId:L.id}: {}}));
   }
   if(r.stop)break;
   await openBank();
   if(o.progressive&&held(L.id)>0)await deposit(L.id);
  }
  // Rebank leftover logs; the tinderbox stays in the pack.
  if(held(L.id)>0){await openBank();await deposit(L.id);}
  if(st()?.bank?.isOpen)await closeBank();
  r.ownedLogs=owned();
  if(r.stop==='logs-exhausted'&&o.burnOnly)r.shortfall=Math.max(0,o.maxLogs-r.logsBurnt);
  if(r.stop==='logs-exhausted'&&!o.burnOnly&&base()<o.target)r.shortfall=logShortfall(o.target,xp(),r.xpPerLog,0);
  r.ok=r.stop==='target'||r.stop==='max-logs';
  if(r.stop==='logs-exhausted')r.failure=`log stock exhausted: shortfall ${r.shortfall} ${L.name}`;
  else if(r.stop==='cap')r.failure='tick cap reached before target';
 }catch(e){
  if(e instanceof Refusal){r.stop='refused';r.refused=e.message;}
  else{r.stop||='error';r.failure=String(e);}
 }finally{off();}
 r.level=base();r.xpGained=xp()-startXp;r.ticks=s.tick()-start;r.hpMin=hpMin;
 r.logsPer1kTicks=Number((r.logsBurnt*1000/Math.max(1,r.ticks)).toFixed(2));
 return r;
}

if(import.meta.main){
 let s:Session|undefined;
 try{
  const name=process.argv[2];
  if(!name||!/^[a-z0-9]{1,12}$/i.test(name)||process.argv.length>3)throw Error('usage: firemaking-order.ts <account>');
  const o=firemakingOptions();
  s=await openBot(name);
  const r=await runFiremaking(s,o);
  console.log('FIREMAKING_ORDER_RESULT '+JSON.stringify(r));
  await finish([s],r.ok,`firemaking-order stop=${r.stop} level=${r.level} target=${r.target} logs=${r.logsBurnt} xp=${r.xpGained}${r.refused?` refused: ${r.refused}`:''}${r.failure?` failure: ${r.failure}`:''}`);
 }catch(error){await finish(s?[s]:[],false,String(error));}
}
