// bun scripts/firemaking-order.ts <account>
// TARGET_LEVEL (required), MAX_LOGS=10000, CAP=20000 ticks, LOG=normal|oak|willow, TOOL_BUDGET=50, CASH_RESERVE=0.
// Server comes from openBot's account config. Acceptance belongs to packages/practice/src/firemaking-order-proof.ts.
// Source decision: scripts/measure/fm-line-search.ts --from 3092,3243 --safe -> BURN_ROWS (danger 0, 3 and 9 tiles
// from the Draynor booths); floor-fm-line.ts push/turn rules -> burn(). Reuse by import: gather-yews.ts session, walk
// and bank modules, shop-buyer.ts planShopPurchases/buyWithBudget. Reject the measurement CLIs (they log in on load).
// skill_firemaking/scripts/firemaking.rs2: light_logs_inv refuses "You can't light a fire here." before it drops the
// log; firemaking_success deletes the ground log, then stat_advance. push_player tries west, east, south, north.
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {walkPath,sessionWalker,type PathPoint} from '../packages/core/src/walk';
import {depositObserved} from '../packages/core/src/deposit';
import {planShopPurchases,buyWithBudget,maximumUnitCost} from './shop-buyer';

export const LOGS={normal:{id:1511,name:'Logs',level:1},oak:{id:1521,name:'Oak logs',level:15},willow:{id:1519,name:'Willow logs',level:30}} as const;
export type LogKind=keyof typeof LOGS;
export const TINDERBOX=590,COINS=995,FIREMAKING='Firemaking';
export const DRAYNOR_BANK={x:3092,z:3243};
export const BURN_ROWS=[{z:3248,sx:3098,ex:3072},{z:3250,sx:3105,ex:3077}] as const;
// lumbridge.npc shop_keeper generalshop1 (sell multiplier 1300); lumbridge.inv stock5=tinderbox; tinderbox cost 1.
// Route legs: the Draynor <-> Lumbridge road used by scripts/gather-yews.ts.
export const TINDER_SHOP={npc:/^(shopkeeper|shop assistant)$/i,item:/^tinderbox$/i,baseCost:1,sellMultiplier:1300,
 route:[{x:3092,z:3250,tol:1},{x:3089,z:3266,tol:2},{x:3100,z:3270,tol:2},{x:3140,z:3270,tol:2},{x:3180,z:3258,tol:2},{x:3212,z:3246,tol:2}] as PathPoint[]};
export const PACK_LOGS=27,LIGHT_TICKS=120,TILE_WAIT_TICKS=40;

export interface FiremakingOptions{target:number;maxLogs:number;cap:number;log:LogKind;toolBudget:number;cashReserve:number}
export function firemakingOptions(env:Record<string,string|undefined>=process.env):FiremakingOptions{
 const int=(key:string,fallback:number|undefined,min:number,max:number)=>{
  const n=Number(env[key]??fallback);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(`invalid ${key}`);return n;};
 const log=(env.LOG??'normal').toLowerCase();if(!Object.hasOwn(LOGS,log))throw Error('invalid LOG: use normal, oak or willow');
 return{target:int('TARGET_LEVEL',undefined,2,99),maxLogs:int('MAX_LOGS',10000,1,1000000),cap:int('CAP',20000,1,10000000),
  log:log as LogKind,toolBudget:int('TOOL_BUDGET',50,0,1000000),cashReserve:int('CASH_RESERVE',0,0,2000000000)};
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
 if(s.baseLevel>=o.target)return 'already at target';
 if(s.plane!==0)return 'off plane 0';
 if(s.level<LOGS[o.log].level)return `${LOGS[o.log].name} need Firemaking ${LOGS[o.log].level}`;
 return null;
}
export const lineTiles=()=>BURN_ROWS.flatMap((r,row)=>Array.from({length:r.sx-r.ex+1},(_,i)=>({x:r.sx-i,z:r.z,row})));
// First usable tile from `from`, cyclic over the line. -1 when every tile is on fire or refused.
export function nextFreeTile(tiles:readonly {x:number;z:number}[],from:number,blocked:(t:{x:number;z:number})=>boolean){
 for(let i=0;i<tiles.length;i++){const k=(from+i)%tiles.length;if(!blocked(tiles[k]!))return k;}
 return -1;
}
// Logs to withdraw: one pack of unnoted logs (one slot each), bounded by free slots and the MAX_LOGS remainder.
export function packWant(heldLogs:number,usedSlots:number,remaining:number){
 return Math.max(0,Math.min(PACK_LOGS,28-usedSlots+heldLogs,remaining)-heldLogs);
}
export function rowStart(row:number){return BURN_ROWS.slice(0,row%BURN_ROWS.length).reduce((n,r)=>n+r.sx-r.ex+1,0);}
// One tinderbox only when none is owned in the pack, bank or equipment.
export function tinderboxPlan(owned:number,shop:{name:string;count:number;buyPrice:number}[],inventory:{name:string;count:number}[],budget:number){
 if(owned>0)return [];
 return planShopPurchases([{re:TINDER_SHOP.item,buyPerTick:1}],shop,inventory,new Map(),budget,1,1);
}
export const tinderboxUnitMax=()=>maximumUnitCost({baseCost:TINDER_SHOP.baseCost},{sellMultiplier:TINDER_SHOP.sellMultiplier});
export class Refusal extends Error{}

export async function runFiremaking(s:Session,o:FiremakingOptions){
 const L=LOGS[o.log],start=s.tick();let ended=false;
 void s.ended.then(()=>{ended=true;});
 const st=()=>s.sdk.getState(),pos=()=>st()!.player!;
 const inv=()=>s.sdk.getInventory(),held=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const worn=(id:number)=>(st()?.equipment??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const xp=()=>s.sdk.getSkillXp(FIREMAKING)!,base=()=>s.sdk.getSkill(FIREMAKING)!.baseLevel,hp=()=>s.sdk.getSkill('Hitpoints')!.level;
 const ready=()=>{const p=st()?.player,f=s.sdk.getSkill(FIREMAKING),h=s.sdk.getSkill('Hitpoints');
  return !!p&&p.worldX>0&&!!f&&f.baseLevel>0&&!!h&&h.baseLevel>0&&Number.isFinite(s.sdk.getSkillXp(FIREMAKING))&&Array.isArray(st()?.inventory);};
 if(!await waitUntil(s,ready,{timeoutTicks:20}))throw Error('entry state unobserved');
 let hpMin=hp();const off=s.onTick(()=>{const h=s.sdk.getSkill('Hitpoints')?.level;if(h!==undefined)hpMin=Math.min(hpMin,h);});
 const project=(list:{slot:number;id:number;count:number}[]|undefined)=>(list??[]).map(({slot,id,count})=>({slot,id,count}));
 const at=()=>({x:pos().worldX,z:pos().worldZ,level:pos().level});
 const startXp=xp(),startLevel=base();
 console.log('FIREMAKING_INITIAL '+JSON.stringify({name:s.name,options:o,tick:s.tick(),position:at(),hp:hp(),xp:startXp,level:startLevel,
  inventory:project(st()?.inventory),equipment:project(st()?.equipment)}));
 const live=()=>{if(ended)throw Error('session interrupted');if(hp()<=0)throw Error('died');};
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
  const p=pos();if(Math.max(Math.abs(p.worldX-DRAYNOR_BANK.x),Math.abs(p.worldZ-DRAYNOR_BANK.z))>3)await walk([{...DRAYNOR_BANK,tol:2}],'walk to Draynor bank');
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
  await walk([...TINDER_SHOP.route].reverse().slice(1).concat([{...DRAYNOR_BANK,tol:2}]),'walk back to Draynor bank',600);
  await openBank();
 };
 // ---- Light one log on the current tile. Returns the XP gain, or 'blocked' when the tile refuses a fire.
 const light=async():Promise<number|'blocked'>=>{
  const tb=inv().find(i=>i.id===TINDERBOX),log=inv().find(i=>i.id===L.id);
  if(!tb||!log)throw Error('tinderbox or log missing from pack');
  if(st()?.dialog?.isOpen||st()?.modalOpen)await s.direct({type:'closeModal',reason:'SDK'});
  const x0=xp(),n0=held(L.id),sent=s.tick();fresh(/$^/);
  await s.sdk.sendUseItemOnItem(tb.slot,log.slot);
  let resends=0;
  while(s.tick()-sent<LIGHT_TICKS){
   await waitTicks(s,1);live();
   if(xp()>x0){await waitUntil(s,()=>held(L.id)===n0-1,{timeoutTicks:3});return xp()-x0;}
   if(fresh(/can't light a fire here/i))return 'blocked';
   if(fresh(/need a firemaking level|need a tinderbox/i))throw Error('light refused by server');
   // A modal (a level-up dialog) can swallow the packet: close it and resend only while the log is still in the
   // pack, never after the drop.
   if(held(L.id)===n0&&s.tick()-sent>=4*(resends+1)&&resends<3){
    resends++;if(st()?.dialog?.isOpen||st()?.modalOpen)await s.direct({type:'closeModal',reason:'SDK'});
    const t=inv().find(i=>i.id===TINDERBOX),l=inv().find(i=>i.id===L.id);if(t&&l)await s.sdk.sendUseItemOnItem(t.slot,l.slot);
   }
  }
  throw Error(`light effect unobserved ${JSON.stringify({at:at(),ticks:s.tick()-sent,held:held(L.id),n0})}`);
 };
 const tiles=lineTiles(),refused=new Map<string,number>();
 const key=(t:{x:number;z:number})=>`${t.x},${t.z}`;
 const fireAt=(t:{x:number;z:number})=>(st()?.nearbyLocs??[]).some(l=>l.x===t.x&&l.z===t.z&&/^fire$/i.test(l.name));
 const blocked=(t:{x:number;z:number})=>fireAt(t)||(refused.get(key(t))??-1)>s.tick();
 let cursor=0;
 const owned=()=>held(L.id)+banked(L.id);
 const stopReason=()=>base()>=o.target?'target':r.logsBurnt>=o.maxLogs?'max-logs':s.tick()-start>=o.cap?'cap':owned()<1?'logs-exhausted':'';
 try{
  const pre=firemakingPreflight(o,{plane:pos().level,baseLevel:startLevel,level:s.sdk.getSkill(FIREMAKING)!.level});
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
   r.stop=stopReason();if(r.stop)break;
   // At the bank: carry up to one pack of logs, bounded by MAX_LOGS.
   const want=packWant(held(L.id),inv().length,o.maxLogs-r.logsBurnt);
   if(want>0&&banked(L.id)>0)await withdraw(L.id,Math.min(want,banked(L.id)));
   if(held(L.id)<1)throw Error('pack has no logs after withdrawal');
   await closeBank();
   cursor=rowStart(row);row++;
   while(held(L.id)>0){
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
    console.log('FIREMAKING_PROGRESS '+JSON.stringify({burns:r.logsBurnt,xp:xp(),level:base(),tick:s.tick(),x:t.x,z:t.z}));
   }
   if(r.stop)break;
   await openBank();
  }
  // Rebank leftover logs; the tinderbox stays in the pack.
  if(held(L.id)>0){await openBank();await deposit(L.id);}
  if(st()?.bank?.isOpen)await closeBank();
  r.ownedLogs=owned();
  if(r.stop==='logs-exhausted'&&base()<o.target)r.shortfall=logShortfall(o.target,xp(),r.xpPerLog,0);
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
