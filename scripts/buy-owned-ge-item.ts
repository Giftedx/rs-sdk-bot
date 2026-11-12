// One owned item/order of an exact quantity. Persistent intent, capped unit price and observed bank settlement.
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';import {createHash} from 'node:crypto';
import {openBot,settle,serverFromEnv,getWorld,accountOf} from '../packages/core/src/bot';import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';import {depositObserved} from '../packages/core/src/deposit';import {sessionWalker,walkPath,expandPath,goTo} from '../packages/core/src/walk';
import type {GEOffer,GEActionResult} from '../vendor/rs-sdk/sdk/ge-types';
import {marketProgress,type MarketProgress} from '../packages/planner/src/market-progress';
import {LUMBRIDGE_TO_DRAYNOR,DRAYNOR_BANK} from './courier-route';
import {ferryWalk,walkTargetPersist} from './walk-to';import {ROUTE_BUDGET_MS} from '../packages/core/src/world';
import {equipmentObserved} from '../packages/core/src/container-observation';
import {productionMode} from './earth-production';
// quantity is absent in journals written before bulk orders; those orders are quantity 1.
// expectedOwned (EXPECTED_OWNED) authorizes topping up exactly that many already held units. Absent, any held unit refuses the order.
export interface ItemRequest {actor:string;server:string;goal:string;item:number;quantity?:number;expectedOwned?:number;rescueMode?:'npc-respawn-once';limit:number;reserve:number;createdAt:number;reviewAt:number;deadline:number}
export interface OrderView {actor:string;server:string;offers:readonly GEOffer[];coins:number;items:number}
// Root acquired/refund stay cumulative. Root refund is the unused original budget.
// Each archived round retains its actual returned escrow and private fill evidence.
export interface SettledRound {offerId:number;quantity:number;acquired:number;refund:number;progress?:MarketProgress}
export interface RescueReceipt {phase:'attempted'|'respawned'|'bank-reconciled';lifeId:number;respawnCount:number;targetIndex:number;bank:{id:number;count:number}[];bankAt:number}
export interface ItemOrder {rescue?:RescueReceipt;submission?:'prepared'|'attempted';rounds?:SettledRound[];version:1;request:ItemRequest;phase:'entry'|'placing'|'open'|'cancelling'|'collecting'|'settled';coinsBefore:number;itemsBefore:number;previousIds:number[];at:number;offerId?:number;progress?:MarketProgress;claim?:{coinsBefore:number;itemsBefore:number;coins:number;items:number};acquired?:number;refund?:number;failure?:string}
export const orderQuantity=(r:ItemRequest)=>r.quantity??1;
export const orderEscrow=(r:ItemRequest)=>orderQuantity(r)*r.limit;
// Older journals have one round and no submission marker. They remain readable, but an
// old placing record cannot prove that its mutation was never dispatched.
function priorRounds(j:ItemOrder){
 let acquired=0,spent=0;const ids=new Set<number>(),total=orderQuantity(j.request);
 if(j.rounds&&!Array.isArray(j.rounds)|| (j.rounds?.length??0)>16)throw Error('invalid settled rounds');
 for(const r of j.rounds??[]){
  const gross=r.quantity*j.request.limit-r.refund;
  if(!Number.isSafeInteger(r.offerId)||r.offerId<=0||ids.has(r.offerId)||r.quantity!==total-acquired
   ||!Number.isSafeInteger(r.acquired)||r.acquired<0||r.acquired>=r.quantity
   ||!Number.isSafeInteger(r.refund)||r.refund<0||r.refund>r.quantity*j.request.limit
   ||(r.acquired===0?gross!==0:gross<r.acquired||gross>r.acquired*j.request.limit))throw Error('invalid settled round');
  if(r.progress){marketProgress(null,r.progress);if(r.progress.actor.toLowerCase()!==j.request.actor.toLowerCase()||r.progress.server!==j.request.server
   ||r.progress.offerId!==r.offerId||r.progress.itemId!==j.request.item||r.progress.side!=='buy'||r.progress.quantity!==r.quantity
   ||r.progress.limit!==j.request.limit||r.progress.filled!==r.acquired||r.progress.gross!==gross||r.progress.tax!==0)throw Error('invalid settled round progress');}
  ids.add(r.offerId);acquired+=r.acquired;spent+=gross;
 }
 if(j.offerId!==undefined&&ids.has(j.offerId))throw Error('reused settled offer ID');
 return{acquired,spent,quantity:total-acquired,escrow:(total-acquired)*j.request.limit};
}
export function orderAccounting(journal?:ItemOrder){
 if(!journal)return{acquired:0,refund:0,spent:0,escrow:0,maximumExposure:0,outcomeUnresolved:false};
 const total=orderEscrow(journal.request);let prior:{acquired:number;spent:number;quantity:number;escrow:number};
 try{prior=priorRounds(journal);}catch{return{acquired:0,refund:0,spent:0,escrow:null,maximumExposure:total,outcomeUnresolved:true};}
 let valid=true;
 if(journal.progress)try{
  marketProgress(null,journal.progress);const p=journal.progress;
  valid=p.actor.toLowerCase()===journal.request.actor.toLowerCase()&&p.server===journal.request.server&&p.offerId===journal.offerId
   &&p.itemId===journal.request.item&&p.side==='buy'&&p.quantity===prior.quantity&&p.limit===journal.request.limit;
 }catch{valid=false;}
 const settled=journal.phase==='settled',a=journal.acquired!,refund=journal.refund!,spent=total-refund,active=a-prior.acquired,gross=spent-prior.spent;
 if(settled)valid=valid&&Number.isSafeInteger(a)&&active>=0&&active<=prior.quantity&&Number.isSafeInteger(refund)&&refund>=0&&refund<=total
  &&(active===0?gross===0:gross>=active&&gross<=active*journal.request.limit)
  &&(!journal.progress||journal.progress.filled===active&&journal.progress.gross===gross&&journal.progress.tax===0);
 const unresolved=!valid||['entry','placing','cancelling','collecting'].includes(journal.phase);
 const knownSpent=settled&&valid?spent:prior.spent+(journal.phase==='open'&&valid?(journal.progress?.gross??0):0);
 return{acquired:settled&&valid?a:prior.acquired,refund:settled&&valid?refund:0,spent:knownSpent,
  escrow:unresolved?null:settled?0:prior.escrow-(journal.progress?.gross??0),maximumExposure:settled&&valid?0:prior.escrow,outcomeUnresolved:unresolved};
}
// A different finite acquisition method may use a fully refunded zero-fill intent, never an unresolved offer.
export function earthShopFallback(request:ItemRequest,journal:ItemOrder|undefined,cap:number,spent=0,profile='aubury'){
 validateRequest(request);const q=orderQuantity(request),a=orderAccounting(journal);
 const production=productionMode(profile),refill=profile.endsWith('-refill'),shop=refill?profile.slice(0,-7):profile;
 if(!journal||journal.phase!=='settled'||JSON.stringify(journal.request)!==JSON.stringify(request)
  ||request.item!==557||request.rescueMode||request.expectedOwned===undefined||journal.itemsBefore!==request.expectedOwned
  ||a.outcomeUnresolved||a.escrow!==0||a.acquired!==0||a.spent!==0||a.refund!==orderEscrow(request)
  ||!production&&!['aubury','betty'].includes(shop)||!Number.isSafeInteger(cap)||cap<1||cap>(production?20000:refill?16000:shop==='betty'?3000:1600)||!Number.isSafeInteger(spent)||spent<0||spent>=orderEscrow(request))throw Error('earth shop fallback requires the matching fully refunded zero-fill intent and bounded acquisition cap');
 return{entry:production?'scripts/earth-production.ts':refill?'scripts/earth-shop.ts':'scripts/shop-buyer.ts',args:production?[production,String(cap)]:[shop,String(cap),'2000'],env:{ITEMS:'earth rune',STOP_AT_TARGET:'1',STOCK_TARGET:String(request.expectedOwned+q),MAX_ITEMS:String(q),
  MAX_SPEND:String(orderEscrow(request)-spent),COIN_RESERVE:String(request.reserve),FLOAT:String(request.reserve+orderEscrow(request)-spent),NO_BUY_TICKS:'25',BANK_PACK:'1'}};
}
export function shopFallbackSpent(state:any,request:ItemRequest){
 if(state===undefined)return 0;
 if(state?.phase!=='settled'||JSON.stringify(state.request)!==JSON.stringify(request)||!Number.isSafeInteger(state.spent)||state.spent<0||state.spent>orderEscrow(request))throw Error('shop fallback spend is unresolved; reconcile retained intent before retry');
 return state.spent as number;
}
function roundBaseline(j:ItemOrder){const p=priorRounds(j);return{...p,coins:j.coinsBefore-p.spent,items:j.itemsBefore+p.acquired};}
function claimSettlement(j:ItemOrder,c:{items:number;coins:number}){
 const p=priorRounds(j);return{acquired:p.acquired+c.items,refund:orderEscrow(j.request)-p.spent-p.escrow+c.coins};
}
export function validateRequest(r:ItemRequest){
 if(r.rescueMode!==undefined&&r.rescueMode!=='npc-respawn-once')throw Error('unsupported RESCUE_MODE');
 if(!/^[a-z0-9]{1,12}$/i.test(r.actor)||!r.server||!/^[a-z0-9_-]{1,64}$/i.test(r.goal)||![r.item,r.limit].every(n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647)||r.quantity!==undefined&&!(Number.isSafeInteger(r.quantity)&&r.quantity>0)||r.expectedOwned!==undefined&&!(Number.isSafeInteger(r.expectedOwned)&&r.expectedOwned>=0&&r.expectedOwned<=2147483647)||orderEscrow(r)>2147483647||!Number.isSafeInteger(r.reserve)||r.reserve<0||![r.createdAt,r.reviewAt,r.deadline].every(n=>Number.isSafeInteger(n)&&n>0)||r.reviewAt<r.createdAt||r.deadline<=r.reviewAt)throw Error('invalid item order request');
}
// Banknotes share the item's published name and have no config (knowledge/BUILD.md), so they are absent from the catalogue.
// A catalogued item with the same name is a different item and never counts.
export function orderItemMatcher(item:number,catalogue:readonly {id:number;name:string}[]){
 const name=catalogue.find(i=>i.id===item)?.name.toLowerCase(),known=new Set(catalogue.map(i=>i.id));
 return(i:{id:number;name?:string})=>i.id===item||!!name&&i.name?.toLowerCase()===name&&!known.has(i.id);
}
export function orderPaths(server:string,actor:string,goal:string){
 const base=resolve(import.meta.dir,'../.practice/market-orders',createHash('sha256').update(server).digest('hex').slice(0,12));
 return{base,lock:base+'/'+actor.toLowerCase()+'.lock',journal:base+'/'+actor.toLowerCase()+'-'+goal+'.json'};
}
function identity(j:ItemOrder,v:OrderView){if(j.request.actor.toLowerCase()!==v.actor.toLowerCase()||j.request.server!==v.server)throw Error('order identity mismatch');}
const matches=(j:ItemOrder,o:GEOffer)=>o.item===j.request.item&&o.side==='buy'&&o.quantity===priorRounds(j).quantity&&o.price===j.request.limit;
export function observeOrderProgress(j:ItemOrder,o:GEOffer,at:number){
 if(j.offerId!==o.id||!matches(j,o))throw Error('private progress order identity mismatch');
 return marketProgress(j.progress??null,{actor:j.request.actor,server:j.request.server,offerId:o.id,itemId:o.item,side:o.side,quantity:o.quantity,limit:o.price,filled:o.filled,gross:o.gross,tax:o.tax,at});
}
export function terminalOrderClaim(j:ItemOrder,o:GEOffer){
 observeOrderProgress(j,o,Math.max(j.progress?.at??1,j.at));
 if(!['completed','cancelled'].includes(o.state)||o.items!==o.filled||o.coins!==priorRounds(j).escrow-o.gross||!Number.isSafeInteger(o.coins)||o.coins<0||o.remaining!==0
  ||o.state==='completed'&&o.filled!==priorRounds(j).quantity)throw Error('terminal order fill/refund does not conserve escrow');
 return{items:o.items,coins:o.coins};
}
export function reconcilePlacement(j:ItemOrder,v:OrderView):GEOffer|undefined{
 identity(j,v);const found=v.offers.filter(o=>!j.previousIds.includes(o.id)&&matches(j,o));if(found.length>1)throw Error('ambiguous new GE offers');if(!found.length)return;
 if(v.coins!==roundBaseline(j).coins-priorRounds(j).escrow)throw Error('owned escrow debit mismatch');if(v.items!==roundBaseline(j).items)throw Error('owned item baseline changed');return found[0];
}
// Unchanged balances alone do not prove a failed submission. Only a record saved
// before the attempted marker can authorize submission. Unknown/legacy intents stay held.
export function placementRetrySafe(j:ItemOrder,v:OrderView):boolean{
 identity(j,v);const p=roundBaseline(j);
 return j.phase==='placing'&&j.submission==='prepared'&&j.offerId===undefined
  &&v.coins===p.coins&&v.items===p.items&&v.offers.length===j.previousIds.length
  &&v.offers.every(o=>j.previousIds.includes(o.id));
}
export function collectionApplied(j:ItemOrder,v:OrderView):boolean{
 identity(j,v);const c=j.claim;return j.phase==='collecting'&&j.offerId!==undefined&&!!c
  &&c.coinsBefore===roundBaseline(j).coins-priorRounds(j).escrow&&c.itemsBefore===roundBaseline(j).items
  &&!orderAccounting({...j,phase:'settled',...claimSettlement(j,c)}).outcomeUnresolved
  &&!v.offers.some(o=>o.id===j.offerId)&&v.coins===c.coinsBefore+c.coins&&v.items===c.itemsBefore+c.items;
}
export function collectionRetrySafe(j:ItemOrder,v:OrderView):boolean{
 identity(j,v);const c=j.claim,o=v.offers.find(o=>o.id===j.offerId);
 if(j.phase!=='collecting'||!c||!o||v.coins!==c.coinsBefore||v.items!==c.itemsBefore
  ||c.coinsBefore!==roundBaseline(j).coins-priorRounds(j).escrow||c.itemsBefore!==roundBaseline(j).items)return false;
 try{const claim=terminalOrderClaim(j,o);return claim.coins===c.coins&&claim.items===c.items;}catch{return false;}
}
// The live exchange shows "Collect as notes" only for a claim with a notable item. The SDK refuses a
// missing control before it sends the click, so plain collect then takes the same claim.
export async function collectClaim(collect:(offerId:number,notes:boolean)=>Promise<GEActionResult>,offerId:number,notes:boolean){
 const result=await collect(offerId,notes);
 return !result.success&&notes&&result.reason==='no_control'?collect(offerId,false):result;
}
const BANK={x:3185,z:3436},GE={x:3181,z:3443};
export const marketTileSafe=(p:{x:number;z:number;level:number})=>p.level===0&&p.x>=3180&&p.x<=3188&&p.z>=3433&&p.z<=3447;
// North Varrock arrival observed live at 3165,3487,0. Its only pinned exit is north-east, and findLongPath
// enters Varrock from the north. The 3241,3507 waypoint keeps the path 6+ tiles from the brownbear spawn at
// 3230,3500 (research/route-danger.ts with margin 5: 0 danger spawns).
export const NORTH_ENTRY={x:3165,z:3487},NORTH_APPROACH=[{x:3198,z:3508},{x:3241,z:3507},{x:3244,z:3503},{...BANK,tol:1}];
const BROWN_BEAR={x:3230,z:3500};
export const northEntryTile=(p:{x:number;z:number;level:number})=>p.level===0&&Math.max(Math.abs(p.x-NORTH_ENTRY.x),Math.abs(p.z-NORTH_ENTRY.z))<=3;
export const northApproachTile=(p:{x:number;z:number;level:number})=>p.level===0&&p.x>=3160&&p.x<=3248&&p.z>=3428&&p.z<=3512
 &&Math.max(Math.abs(p.x-BROWN_BEAR.x),Math.abs(p.z-BROWN_BEAR.z))>=6;
async function northApproach(s:Session,signal:AbortSignal){
 const deps=await sessionWalker(s),plan=deps.plan;
 deps.plan=(level,from,goal)=>{const corners=plan(level,from,goal);if(!corners.length||[from,...expandPath(from,corners)].some(p=>!northApproachTile({...p,level})))throw Error('north approach path outside known corridor');return corners;};
 return walkPath(deps,NORTH_APPROACH,{signal,maxTicks:400});
}
function marketHealthFailure(p:{worldX:number;worldZ:number;level:number}|null|undefined,hp:number){
 const where=p?`${p.worldX},${p.worldZ},${p.level}`:'unknown';
 if(!p||!Number.isFinite(hp)||hp<=0)return `market entry: position=${where} currentHP=${hp}; living actor required`;
 if(hp<=6&&(p.level!==0||Math.max(Math.abs(p.worldX-BANK.x),Math.abs(p.worldZ-BANK.z))>3))return `market health preparation: position=${where} currentHP=${hp}; requires bank approach within3 before healing`;
 return null;
}
export function marketEntryFailure(p:{worldX:number;worldZ:number;level:number}|null|undefined,hp:number){
 const health=marketHealthFailure(p,hp);if(health)return health;
 if(!p||!marketTileSafe({x:p.worldX,z:p.worldZ,level:p.level}))return `unsupported market entry: position=${p?.worldX},${p?.worldZ},${p?.level} currentHP=${hp}; requires observed Varrock West/GE arrival`;
 return null;
}
function marketEntryTrace(s:Session,stage:string,detail:Record<string,unknown>={}){
 const p=s.sdk.getState()?.player;
 console.log('GE_MARKET_ENTRY '+JSON.stringify({stage,at:Date.now(),tick:s.tick(),position:p?{x:p.worldX,z:p.worldZ,level:p.level}:null,
  hp:s.sdk.getSkill('Hitpoints')?.level??null,stateAge:s.sdk.getStateAge(),...detail}));
}
// A run the relay cut on the Gnome battlefield leaves the account among the Khazard troopers, and the market trip
// below aborts on the first lost hit point. So from the battlefield a buy first walks to the Ardougne north bank, with
// auto-retaliate off as the trooper trainer retreats (scripts/gather-combat.ts leave), and starts the guarded trip
// there. Live claude-cloud: Fatstack's scimitar buy, three runs from 2529,3236, "no route to 3185,3436,0".
export const BATTLEFIELD=[2480,3200,2600,3290] as const,ARDOUGNE_NORTH={x:2619,z:3332,level:0};
export const onBattlefield=(p:{x:number;z:number;level:number})=>p.level===0&&p.x>=BATTLEFIELD[0]&&p.z>=BATTLEFIELD[1]&&p.x<=BATTLEFIELD[2]&&p.z<=BATTLEFIELD[3];
export async function leaveBattlefield(s:Session,stop:()=>boolean,walk:(to:{x:number;z:number;level:number})=>Promise<{ok:boolean;detail?:string}>=to=>walkTargetPersist(s,to)){
 const at=()=>s.sdk.getState()?.player,p=at();
 if(!p||!onBattlefield({x:p.worldX,z:p.worldZ,level:p.level}))return false;
 if((s.sdk.getSkill('Hitpoints')?.level??0)<=10)throw Error(`market entry: on the battlefield at ${p.worldX},${p.worldZ} with 10 HP or less; the trooper trainer's retreat eats first`);
 const retaliate=async(on:boolean)=>{
  const state=()=>s.sdk.getState() as {autoRetaliateEnabled?:boolean}|null;
  if(state()?.autoRetaliateEnabled===on||state()?.autoRetaliateEnabled===undefined)return false;
  await s.direct({type:'clickComponent',componentId:on?150:151,reason:`market entry auto-retaliate ${on?'ON':'OFF'}`});
  return await waitUntil(s,()=>state()?.autoRetaliateEnabled===on,{timeoutTicks:5});
 };
 const start=s.tick(),off=await retaliate(false);
 marketEntryTrace(s,'battlefield-leave',{autoRetaliateOff:off});
 try{
  const result=stop()?{ok:false,detail:'stop requested'}:await walk(ARDOUGNE_NORTH);
  const q=at(),near=!!q&&q.level===0&&Math.max(Math.abs(q.worldX-ARDOUGNE_NORTH.x),Math.abs(q.worldZ-ARDOUGNE_NORTH.z))<=6;
  marketEntryTrace(s,'battlefield-left',{ok:result.ok&&near,ticks:s.tick()-start,detail:result.detail});
  if(!result.ok||!near)throw Error(`market entry: walk from the battlefield to the Ardougne north bank failed: ${result.detail??'not at the bank'}`);
  return true;
 }finally{if(off)await retaliate(true);}
}
// The leg that ends at the market bank plans with the full route budget. ferryWalk gives each leg after a ferry 15 s,
// and the search from the Port Sarim dock to Varrock West can take longer (live: NabTheKnob off both eastbound ferries
// at 3029,3217, "WALK_NO_ROUTE ms 15817 budgetMs 15000", then "no route to 3185,3436,0").
export const marketLeg=<T>(walk:(tile:{x:number;z:number;level:number},planBudgetMs?:number)=>Promise<T>)=>
 (tile:{x:number;z:number;level:number},planBudgetMs?:number)=>walk(tile,tile.level===0&&tile.x===BANK.x&&tile.z===BANK.z?ROUTE_BUDGET_MS:planBudgetMs);
export async function prepareMarketEntry(s:Session,stop:()=>boolean,travel:(signal:AbortSignal)=>Promise<{ok:boolean;ticks:number;detail?:string}>=async signal=>{
 const at=s.sdk.getState()?.player;
 if(at&&northEntryTile({x:at.worldX,z:at.worldZ,level:at.level})){marketEntryTrace(s,'north-approach',{waypoints:NORTH_APPROACH});return northApproach(s,signal);}
 marketEntryTrace(s,'world-start');const loadingAt=Date.now(),world=await getWorld();
 marketEntryTrace(s,'world-ready',{elapsedMs:Date.now()-loadingAt});signal.throwIfAborted();
 const observedWorld={...world,route:(...args:Parameters<typeof world.route>)=>{
  const planningAt=Date.now();marketEntryTrace(s,'route-start',{from:args[0],to:args[1]});
  const result=world.route(...args);
  marketEntryTrace(s,'route-returned',{elapsedMs:Date.now()-planningAt,ok:result.ok,...(result.ok?{legs:result.legs.length,cost:result.cost}:{reason:result.reason})});
  return result;
 }};
 const account=accountOf(s);marketEntryTrace(s,'go-to-start');
 // The planner has no route from Ardougne to Varrock (live: every army kit buy failed "no route to 3185,3436,0").
 // ferryWalk (scripts/walk-to.ts) then takes the two ferries, with the 60-coin fare from the nearest bank.
 return ferryWalk(s,{...BANK,level:0},marketLeg((tile,planBudgetMs)=>goTo(s,observedWorld,tile,account,{signal,maxRetriesPerLeg:1,legTimeoutTicks:1200,planBudgetMs})));
}){
 const hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,initial=s.sdk.getState()?.player,p0=initial?{...initial}:undefined,hp0=hp();
 const health=marketHealthFailure(p0,hp0);if(health||p0?.isDead)throw Error(health??'market entry: living actor required');
 if(!p0)throw Error('market position unknown');
 if(marketTileSafe({x:p0.worldX,z:p0.worldZ,level:p0.level}))return;
 const start=s.tick(),ac=new AbortController();let ended=false,lastTrace=start;
 const guard=()=>{
  const p=s.sdk.getState()?.player;
  if(ended||stop()||s.tick()-start>=1200||!p||hp()<hp0||!Number.isFinite(hp())||hp()<=0||p.isDead||p.lifeId!==p0.lifeId||(p.respawnCount??0)>(p0.respawnCount??0)){
   if(!ac.signal.aborted)marketEntryTrace(s,'travel-abort',{ended,elapsedTicks:s.tick()-start});
   ac.abort('market trip health/stop/tick budget');
  }
  if(!ac.signal.aborted&&s.tick()-lastTrace>=100){lastTrace=s.tick();marketEntryTrace(s,'travel-pending',{elapsedTicks:s.tick()-start});}
 };
 const off=s.onTick(guard);void s.ended.then(()=>{ended=true;guard();});
 try{
  guard();ac.signal.throwIfAborted();marketEntryTrace(s,'travel-start');const result=await travel(ac.signal);
  marketEntryTrace(s,'travel-returned',{ok:result.ok,ticks:result.ticks,detail:result.detail});guard();
  const p=s.sdk.getState()?.player,entry=marketEntryFailure(p,hp());
  if(!result.ok||ac.signal.aborted||entry||s.sdk.getStateAge()>5000)throw Error(result.detail??entry??'bank arrival unproved');
 }catch(error){
  marketEntryTrace(s,'travel-error',{error:String(error)});
  const p=s.sdk.getState()?.player;
  throw Error(`market bank travel failed: position=${p?`${p.worldX},${p.worldZ},${p.level}`:'unknown'} currentHP=${hp()} ticks=${s.tick()-start}; ${String(error)}`);
 }finally{off();ac.abort('market trip ended');}
}
// A new order starts only from the fresh holding its request names: none by default, or exactly expectedOwned.
export function ownedBaseline(r:ItemRequest,held:number){
 if(r.expectedOwned===undefined){if(held>0)throw Error('owned item already present;allocate it instead of buying duplicate stock');}
 else if(held!==r.expectedOwned)throw Error(`owned item baseline ${held} differs from EXPECTED_OWNED ${r.expectedOwned}`);
}
const catalogue=():{id:number;name:string}[]=>JSON.parse(readFileSync(new URL('../knowledge/items.json',import.meta.url),'utf8'));

// RESCUE_MODE=npc-respawn-once authorizes one NPC death only from this observed pocket.
// Source: death.rs2 keeps three items when unskulled and restores stats near 3221,3218.
// Reuse that mechanic here; ordinary walking, admission and sessionDied remain guarded.
export const rescuePocket=(p:{worldX:number;worldZ:number;level:number}|null|undefined)=>!!p&&p.level===0&&p.worldX===2853&&p.worldZ===3452;
export function rescueKit(s:Session){
 const st=s.sdk.getState(),p=st?.player,pack=s.sdk.getInventory();
 return !!st&&s.sdk.getStateAge()<=5000&&st.isSkulled===false&&!!p
  &&!!s.client&&typeof s.client==='object'&&equipmentObserved(s.client)&&Array.isArray(st.equipment)&&st.equipment.length===0&&s.sdk.getEquipment().length===0
  &&pack.length===1&&pack[0]?.id===590&&pack[0].count===1;
}
export function bankTotals(rows:readonly {id:number;count:number}[]){
 const m=new Map<number,number>();
 for(const r of rows){if(!Number.isSafeInteger(r.id)||r.id<0||!Number.isSafeInteger(r.count)||r.count<=0)throw Error('invalid rescue bank snapshot');m.set(r.id,(m.get(r.id)??0)+r.count);}
 return [...m].sort((a,b)=>a[0]-b[0]);
}
function rescueBank(request:ItemRequest){
 const snapshot=JSON.parse(readFileSync(resolve(import.meta.dir,'../.practice/status',request.actor+'.json'),'utf8'));
 if(snapshot.name?.toLowerCase()!==request.actor.toLowerCase()||snapshot.server!==request.server||!Number.isSafeInteger(snapshot.bankAt)
  ||snapshot.bankAt<=0||snapshot.bankAt>Date.now()||!Array.isArray(snapshot.bank))throw Error('owned rescue bank snapshot required');
 bankTotals(snapshot.bank);
 return{bank:snapshot.bank.map((i:{id:number;count:number})=>({id:i.id,count:i.count})),bankAt:snapshot.bankAt};
}
export type RescueControl={active:boolean;start:number;lifeId:number;respawnCount:number};
// Only the worker's onStop callback may acknowledge the single expected death. A disconnect is never accepted.
export function expectedRescueStop(s:Session,detail:string,c:RescueControl){
 const p=s.sdk.getState()?.player;
 return detail==='died'&&c.active&&s.tick()-c.start<240&&!!p&&s.sdk.getStateAge()<=5000
  &&p.lifeId>=c.lifeId&&p.lifeId<=c.lifeId+1&&p.respawnCount>=c.respawnCount&&p.respawnCount<=c.respawnCount+1;
}
export async function rescueMarketEntry(s:Session,request:ItemRequest,journalPath:string,stop:()=>boolean,c:RescueControl,
 suppliedSnapshot:ReturnType<typeof rescueBank>|undefined=undefined,stage:(signal:AbortSignal)=>Promise<{ok:boolean}>=async signal=>{
  return walkPath(await sessionWalker(s),LUMBRIDGE_TO_DRAYNOR.map(([x,z,tol])=>({x,z,tol})),{signal,maxTicks:500});
 }){
 const st=s.sdk.getState(),p=st?.player,hp=s.sdk.getSkill('Hitpoints');
 if(existsSync(journalPath))throw Error('rescue intent already exists; uncertain rescue cannot repeat');
 if(stop()||!rescuePocket(p)||!rescueKit(s)||!p||p.isDead||!hp||!Number.isFinite(hp.level)||hp.level<=0
  ||!Number.isSafeInteger(p.lifeId)||!Number.isSafeInteger(p.respawnCount)||!Number.isFinite(hp.baseLevel)||hp.baseLevel<=6)throw Error('rescue refused: pocket, fresh unskulled state, sole tinderbox590 and no equipment required');
 const wolf=st?.nearbyNpcs.filter(n=>n.kind==='npc'&&/^white wolf$/i.test(n.name)&&n.reachable===true&&n.combatLevel===25
  &&Number.isSafeInteger(n.index)&&n.index>=0&&Number.isFinite(n.distance)&&n.distance<=16&&n.distance>0
  &&n.optionsWithIndex.some(o=>/^attack$/i.test(o.text))).sort((a,b)=>a.distance-b.distance)[0];
 if(!wolf)throw Error('rescue refused: observed reachable White wolf25 required');
 const snapshot=suppliedSnapshot??rescueBank(request);
 const totals=new Map(bankTotals(snapshot.bank));ownedBaseline(request,totals.get(request.item)??0);
 if((totals.get(995)??0)<orderEscrow(request)+request.reserve)throw Error('rescue refused: owned bank funding/reserve missing');
 const receipt:RescueReceipt={phase:'attempted',lifeId:p.lifeId,respawnCount:p.respawnCount,targetIndex:wolf.index,...snapshot};
 const j:ItemOrder={version:1,request,phase:'entry',coinsBefore:totals.get(995)??0,itemsBefore:totals.get(request.item)??0,previousIds:[],at:Date.now(),rescue:receipt};
 const save=()=>{j.at=Date.now();writeFileSync(journalPath+'.tmp',JSON.stringify(j,null,2));renameSync(journalPath+'.tmp',journalPath);};
 const initial={lifeId:p.lifeId,respawnCount:p.respawnCount},baseHp=hp.baseLevel,start=s.tick();
 let ended=false;void s.ended.then(()=>{ended=true;});
 const halted=()=>ended||stop()||Date.now()>=request.deadline;
 try{
  if(halted()||!rescueKit(s)||!rescuePocket(s.sdk.getState()?.player))throw Error('rescue pre-engagement state changed');
  save();Object.assign(c,{active:true,start, ...initial});
  marketEntryTrace(s,'rescue-intent',{targetIndex:wolf.index,lifeId:initial.lifeId,respawnCount:initial.respawnCount});
  // The attempted marker precedes the only attack call, including a call that mutates then throws.
  try{await s.sdk.sendInteractNpc(wolf.index,wolf.optionsWithIndex.find(o=>/^attack$/i.test(o.text))!.opIndex);}catch(error){marketEntryTrace(s,'rescue-attack-return',{error:String(error)});}
  const observed=await waitUntil(s,()=>{
   const q=s.sdk.getState()?.player;
   if(halted())throw Error('rescue stopped/disconnected/deadline');
   if(s.sdk.getStateAge()>5000||!q)throw Error('rescue state unknown');
   if(q.lifeId>initial.lifeId+1||q.respawnCount>initial.respawnCount+1)throw Error('rescue unexpected second death');
   return q.lifeId===initial.lifeId+1&&q.respawnCount===initial.respawnCount+1&&!q.isDead
    &&q.level===0&&Math.max(Math.abs(q.worldX-3221),Math.abs(q.worldZ-3218))<=3
    &&s.sdk.getSkill('Hitpoints')?.level===baseHp&&rescueKit(s);
  },{timeoutTicks:Math.max(1,240-(s.tick()-start))});
  if(!observed||halted()||s.tick()-start>=240)throw Error('rescue single Lumbridge respawn/retained kit/restored HP unproved');
  c.active=false;receipt.phase='respawned';save();marketEntryTrace(s,'rescue-respawned',{...initial});
  const ac=new AbortController(),q0={...s.sdk.getState()!.player!},stageStart=s.tick();
  const guard=()=>{const q=s.sdk.getState()?.player;if(halted()||s.tick()-stageStart>=500||!q||q.isDead||q.lifeId!==q0.lifeId||q.respawnCount!==q0.respawnCount||s.sdk.getSkill('Hitpoints')?.level!==baseHp||!rescueKit(s))ac.abort('rescue staging health/stop/state');};
  const off=s.onTick(guard);
  try{
   guard();ac.signal.throwIfAborted();const walked=await stage(ac.signal);guard();ac.signal.throwIfAborted();
   const q=s.sdk.getState()?.player;
   if(!walked.ok||!q||q.level!==0||Math.max(Math.abs(q.worldX-DRAYNOR_BANK.x),Math.abs(q.worldZ-DRAYNOR_BANK.z))>2)throw Error('rescue Draynor arrival unproved');
   const generation=s.bankObservation?.()?.generation??0;
   if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>{guard();return ac.signal.aborted||!!s.sdk.getState()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>generation;},{timeoutTicks:15,signal:ac.signal}))throw Error('rescue fresh Draynor bank unproved');
   guard();ac.signal.throwIfAborted();const bank=s.bankObservation?.();
   if(!bank||JSON.stringify(bankTotals(bank.items))!==JSON.stringify(bankTotals(snapshot.bank)))throw Error('rescue complete bank assets changed');
   await s.bot.closeBank();guard();ac.signal.throwIfAborted();receipt.phase='bank-reconciled';save();marketEntryTrace(s,'rescue-bank-reconciled',{bank:bank.items});
  }finally{off();ac.abort();}
  return j;
 }catch(error){j.failure=String(error);save();throw error;}
 finally{c.active=false;}
}

export async function runOwnedItem(s:Session,request:ItemRequest,journalPath:string,stop:()=>boolean,cancel:boolean,fillWaitTicks:number,rescueControl:RescueControl={active:false,start:0,lifeId:0,respawnCount:0}){
 validateRequest(request);const quantity=orderQuantity(request),isItem=orderItemMatcher(request.item,catalogue());
 if(s.name.toLowerCase()!==request.actor.toLowerCase())throw Error('order actor identity mismatch');
 marketEntryTrace(s,'entry-state-wait');
 if(!await waitUntil(s,()=>stop()||!!s.sdk.getState()?.player&&s.sdk.getStateAge()<=5000&&!!s.sdk.getSkill('Hitpoints'),{timeoutTicks:15})||stop())throw Error('observed market entry state deadline/stop');
 marketEntryTrace(s,'entry-state-ready');
 let entryJournal:ItemOrder|undefined;
 if(existsSync(journalPath)){
  entryJournal=JSON.parse(readFileSync(journalPath,'utf8'));
  if(entryJournal?.version!==1||!['entry','placing','open','cancelling','collecting','settled'].includes(entryJournal.phase)||!Array.isArray(entryJournal.previousIds)||JSON.stringify(entryJournal.request)!==JSON.stringify(request))throw Error('journal request identity/config/state changed');
  if(entryJournal.rescue&&entryJournal.rescue.phase!=='bank-reconciled'||entryJournal.phase==='entry'&&entryJournal.rescue?.phase!=='bank-reconciled')throw Error('uncertain rescue intent; inspect before any action');
 }
 if(request.rescueMode&&!entryJournal){
  if(cancel)throw Error('cannot cancel unsubmitted rescue order');
  entryJournal=await rescueMarketEntry(s,request,journalPath,stop,rescueControl);
 }
 await leaveBattlefield(s,()=>stop()||Date.now()>=request.deadline);
 await prepareMarketEntry(s,()=>stop()||Date.now()>=request.deadline);
 const state=()=>s.sdk.getState(),held=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,start=s.tick(),hp0=hp(),p0=state()?.player;
 // Replay receives recorded SDK states, not the raw interface packets that feed bankObservation.
 // Live work still requires the packet-backed observation. The replay fallback keeps the recorded revision as its generation.
 const bankObservation=()=>{const observed=s.bankObservation?.();if(observed||process.env.REPLAY_ONLY!=='1')return observed;const q=state();return q?.bank.isOpen&&Array.isArray(q.bank.items)?{generation:q.revision??s.tick(),at:Date.now(),items:q.bank.items.map(i=>({id:i.id,name:i.name,count:i.count}))}:null;};
 const entryFailure=marketEntryFailure(p0,hp0);if(entryFailure)throw Error(entryFailure);
 if(!p0)throw Error('market position unknown');
 let hpGuard=hp0;const foodUsed:{id:number;count:number}[]=[],preparationFood=new Set<number>();
 let ended=false,died=false,damaged=false,hpMin=hp0,failure='',bankItems:readonly {id:number;name:string;count:number}[]=[],baseline:Map<number,number>|undefined,journal:ItemOrder|undefined=entryJournal;
 const save=()=>{if(!journal)throw Error('missing order journal');journal.at=Date.now();writeFileSync(journalPath+'.tmp',JSON.stringify(journal,null,2));renameSync(journalPath+'.tmp',journalPath);};
 void s.ended.then(()=>{ended=true;});const off=s.onTick(()=>{const p=state()?.player;hpMin=Math.min(hpMin,hp());damaged||=hp()<hpGuard||!!p&&!marketTileSafe({x:p.worldX,z:p.worldZ,level:p.level});died||=hp()<=0||!!p?.isDead||p?.lifeId!==p0.lifeId||(p?.respawnCount??0)>(p0.respawnCount??0);});
 const terminal=()=>ended||died,over=()=>terminal()||damaged||stop()||s.tick()-start>=500;
 // Item totals join the item with its banknote. Coins are counted by ID.
 const count=(a:readonly {id:number;name:string;count:number}[],match:(i:{id:number;name:string})=>boolean)=>a.filter(match).reduce((n,i)=>n+i.count,0);
 const coinsTotal=()=>held(995)+count(bankItems,i=>i.id===995)+count(s.sdk.getEquipment(),i=>i.id===995),itemTotal=()=>count(s.sdk.getInventory(),isItem)+count(bankItems,isItem)+count(s.sdk.getEquipment(),isItem);
 const assets=()=>{const m=new Map<number,number>();for(const i of [...s.sdk.getInventory(),...bankItems,...s.sdk.getEquipment()]){const id=isItem(i)?request.item:i.id;m.set(id,(m.get(id)??0)+i.count);}return m;};
 const capture=()=>{const bank=bankObservation();if(!state()?.bank.isOpen||!bank)throw Error('fresh bank observation required');bankItems=bank.items.map(i=>({id:i.id,name:i.name,count:i.count}));};
 const walk=async(to:{x:number;z:number},cleanup=false)=>{const end=()=>terminal()||(!cleanup&&over())||s.tick()-start>=680;if(end())throw Error('market route stopped');const p=state()?.player;if(p&&Math.max(Math.abs(p.worldX-to.x),Math.abs(p.worldZ-to.z))<=1)return;const deps=await sessionWalker(s),plan=deps.plan;deps.plan=(level,from,goal)=>{const corners=plan(level,from,goal);if(!corners.length||[from,...expandPath(from,corners)].some(p=>!marketTileSafe({...p,level})))throw Error('market full path outside known bank rectangle');return corners;};if(!(await walkPath(deps,[{...to,tol:1}],{maxTicks:120,stop:end})).ok)throw Error('market bank/GE route failed');};
 const openBank=async()=>{await s.bot.dismissBlockingUI();const gen=bankObservation()?.generation??0;if(!state()?.bank.isOpen&&(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank.isOpen&&(bankObservation()?.generation??0)>gen||terminal(),{timeoutTicks:15})||terminal()))throw Error('market bank open unproved');capture();};
 // Each held form (coins, item, banknote) is one deposit with a paired bank receipt.
 const bankPack=async()=>{for(const id of new Set([995,...preparationFood,...s.sdk.getInventory().filter(isItem).map(i=>i.id)])){const item=s.sdk.getInventory().find(i=>i.id===id);if(item){const amount=held(id);if(await depositObserved(s,item)!==amount)throw Error('market bank credit mismatch');capture();}}};
 const view=():OrderView=>{
  const ge=s.sdk.getGEState();if(!ge||s.sdk.getStateAge()>5000)throw Error('fresh private GE state required');
  const offer=journal?.offerId===undefined?undefined:ge.offers.find(o=>o.id===journal!.offerId);
  if(journal&&offer){const update=observeOrderProgress(journal,offer,Date.now());
   if(!journal.progress||update.delta.filled||update.delta.gross||update.delta.tax){journal.progress=update.current;save();}
  }
  return{actor:s.name,server:request.server,offers:ge.offers,coins:coinsTotal(),items:itemTotal()};
 };
 try{
  await walk(BANK);await openBank();baseline=assets();
  if(journal?.phase==='entry'&&(JSON.stringify(bankTotals(bankItems))!==JSON.stringify(bankTotals(journal.rescue!.bank))||!rescueKit(s)))throw Error('rescue market bank/kit changed');
  await bankPack();
  // One owned salmon/trout/lobster crosses the >6 HP entry floor. Cash is never spent on preparation.
  if(hp()<=6){
   if(over())throw Error('market health preparation stopped');
   const food=bankItems.find(i=>[329,333,379].includes(i.id)&&i.id!==request.item&&i.count>0);
   if(!food)throw Error(`market health preparation: currentHP=${hp()}; acquire 1 owned salmon(329),trout(333) or lobster(379) at this bank`);
   preparationFood.add(food.id);const n=held(food.id),bankBefore=count(bankItems,i=>i.id===food.id),gen=bankObservation()?.generation??0,beforeHp=hp();
   const live=state()?.bank.items.find(i=>i.id===food.id);if(!live)throw Error('market health preparation food missing from open bank');
   // The session eat guard can eat the withdrawn food at an urgent HP before this worker does. The bank debit with the HP gain proves that eat.
   const eaten=()=>held(food.id)===n&&hp()>beforeHp;
   await s.bot.withdrawItem(live,1,{asNote:false});
   if(!await waitUntil(s,()=>{const bank=bankObservation();return terminal()||(held(food.id)===n+1||eaten())&&(bank?.generation??0)>gen&&count(bank?.items??[],i=>i.id===food.id)===bankBefore-1;},{timeoutTicks:10})||terminal())throw Error('market health preparation withdrawal unobserved');
   capture();await s.bot.closeBank();if(over())throw Error('market health preparation stopped');
   const target=s.sdk.getInventory().find(i=>i.id===food.id);if(!target&&!eaten())throw Error('market health preparation food missing');
   if(target&&held(food.id)===n+1)try{await s.bot.eatFood(target);}catch{/* Observe a possibly applied action. */}
   const healed=await waitUntil(s,()=>terminal()||held(food.id)===n&&hp()>6&&hp()>beforeHp,{timeoutTicks:10});
   if(held(food.id)===n)foodUsed.push({id:food.id,count:1});
   if(!healed||terminal()||hp()<=6||hp()<=beforeHp)throw Error('market health preparation pack debit/HP gain unobserved');
   hpGuard=hp();await openBank();
  }
  // Four rounds per invocation, sixteen retained rounds per key. A zero-fill round
  // stops this invocation. A later funded attempt still keeps the original deadline.
  for(let attempt=0;attempt<4;attempt++){
   let remaining=journal?roundBaseline(journal).quantity:quantity,roundEscrow=remaining*request.limit;
   if(journal?.phase==='settled'){
    const accounted=orderAccounting(journal);
    if(accounted.outcomeUnresolved||coinsTotal()!==journal.coinsBefore-accounted.spent||itemTotal()!==journal.itemsBefore+accounted.acquired)throw Error('settled order assets changed');
    if(accounted.acquired===quantity)break;
    if(cancel||Date.now()>=request.deadline||over()||(journal.rounds?.length??0)>=16)throw Error('exact order deadline/cancel/recovery budget exhausted; accounted stock and refund retained');
    remaining=quantity-accounted.acquired;roundEscrow=remaining*request.limit;
   }
   const needsFunding=!journal||journal.phase==='entry'||journal.phase==='settled'||journal.phase==='placing'&&journal.submission==='prepared';
   if(needsFunding){
    if(cancel)throw Error('no submitted order to cancel');if(!journal)ownedBaseline(request,itemTotal());
    if(Date.now()>=request.deadline||over()||coinsTotal()<roundEscrow+request.reserve||s.sdk.getInventory().length>26)throw Error('order expired,owned reserve missing or two collection slots unavailable');
    if(journal&&journal.phase==='placing'&&(coinsTotal()!==roundBaseline(journal).coins||itemTotal()!==roundBaseline(journal).items))throw Error('prepared order asset baseline changed');
    const coins=s.sdk.findBankItem(/^coins$/i),beforeBank=count(bankItems,i=>i.id===995),gen=bankObservation()?.generation??0;
    if(!coins||!(await s.bot.withdrawItem(coins,roundEscrow,{asNote:false})).success||!await waitUntil(s,()=>{const bank=bankObservation();return held(995)===roundEscrow&&(bank?.generation??0)>gen&&count(bank?.items??[],i=>i.id===995)===beforeBank-roundEscrow;},{timeoutTicks:10}))throw Error('owned order funding unobserved');
    capture();if(count(bankItems,i=>i.id===995)!==beforeBank-roundEscrow)throw Error('owned order bank debit mismatch');
   }
   await s.bot.closeBank();if(over())throw Error('market budget/stop before GE');
   await walk(GE);if(!(await s.bot.openGE(15000)).success)throw Error('GE interface unavailable');if(over())throw Error('market operation budget/stop');
   if(journal?.phase==='settled'){
    const prior=priorRounds(journal),accounted=orderAccounting(journal),v=view();
    if(journal.offerId===undefined||v.offers.some(o=>o.id===journal!.offerId)||accounted.outcomeUnresolved)throw Error('previous settled offer still visible or unproved');
    const round:SettledRound={offerId:journal.offerId,quantity:prior.quantity,acquired:accounted.acquired-prior.acquired,refund:prior.escrow-(accounted.spent-prior.spent),progress:journal.progress};
     journal={rescue:journal.rescue,version:1,request,phase:'placing',submission:'prepared',coinsBefore:journal.coinsBefore,itemsBefore:journal.itemsBefore,
     previousIds:v.offers.map(o=>o.id),at:Date.now(),rounds:[...(journal.rounds??[]),round]};save();
   }
   if(!journal||journal.phase==='entry'){const v=view();ownedBaseline(request,v.items);journal={rescue:journal?.rescue,version:1,request,phase:'placing',submission:'prepared',coinsBefore:v.coins,itemsBefore:v.items,previousIds:v.offers.map(o=>o.id),at:Date.now()};save();}
   const acquiredBeforeRound=priorRounds(journal).acquired;
   if(journal.phase==='placing'&&placementRetrySafe(journal,view())){
    if(Date.now()>=request.deadline||over())throw Error('order deadline/stop before submission');
    // Save before invoking the SDK, which may mutate even when it throws. No await
    // separates this marker from the call. An interrupted attempted record stays held.
    journal.submission='attempted';save();await s.bot.placeGEOffer({item:request.item,side:'buy',quantity:priorRounds(journal).quantity,price:request.limit},20000);
   }
   if(journal.phase==='placing'){await waitUntil(s,()=>{try{return !!reconcilePlacement(journal!,view());}catch(e){if(String(e).includes('escrow'))return false;throw e;}},{timeoutTicks:10});const found=reconcilePlacement(journal,view());if(!found)throw Error('placement outcome unresolved;inspect before another order');journal.offerId=found.id;journal.phase='open';save();}
   if(journal.phase==='collecting'){
    const v=view();
    // Collection is addressed by offer ID. Retry only when its entire terminal claim and both asset baselines remain visible.
    if(!collectionApplied(journal,v)){
     if(!collectionRetrySafe(journal,v)||over())throw Error('collection outcome unresolved;inspect journal before retry');
     const collected=await collectClaim((id,notes)=>s.bot.collectGEOffer(id,notes,15000),journal.offerId!,remaining>1);
     if(!await waitUntil(s,()=>collectionApplied(journal!,view()),{timeoutTicks:10}))throw Error('resumed exact collection unproved: '+collected.message);
    }
    Object.assign(journal,claimSettlement(journal,journal.claim!));journal.phase='settled';delete journal.failure;save();
   }else if(journal.phase==='open'||journal.phase==='cancelling'){
    const find=(v:OrderView)=>v.offers.find(o=>o.id===journal!.offerId);let v=view(),offer=find(v);
    // A finite caller owns settlement. Reserve the remaining operation budget for cancellation, collection and banking.
    if(offer?.state==='open'&&journal.phase==='open'&&!cancel&&Date.now()<request.deadline&&fillWaitTicks>0&&!over()){
     await waitUntil(s,()=>over()||Date.now()>=request.deadline||s.sdk.getGEState()?.offers.find(o=>o.id===journal!.offerId)?.state!=='open',{timeoutTicks:fillWaitTicks});v=view();offer=find(v);
    }
    if(!offer||!matches(journal,offer)||v.coins!==roundBaseline(journal).coins-roundEscrow||v.items!==roundBaseline(journal).items)throw Error('private order/escrow identity changed');
    if(offer.state==='open'){
     if(terminal()||s.tick()-start>=580)throw Error('market settlement budget exhausted');journal.phase='cancelling';save();await s.bot.cancelGEOffer(offer.id,15000);
     if(!await waitUntil(s,()=>terminal()||s.sdk.getGEState()?.offers.find(o=>o.id===journal!.offerId)?.state!=='open',{timeoutTicks:10})||terminal())throw Error('cancellation not observed');
     v=view();offer=find(v);if(!offer||offer.state==='open')throw Error('cancellation not observed');journal.phase='open';save();
    }
     terminalOrderClaim(journal,offer);
     if(v.coins!==roundBaseline(journal).coins-roundEscrow||v.items!==roundBaseline(journal).items)throw Error('pre-collection asset baseline changed');
     if(s.sdk.getInventory().length>26||offer.items<0||offer.items>remaining||offer.coins<0||offer.coins>roundEscrow)throw Error('collection space or claim unproved');
     // A bulk claim is collected as banknotes so it fits one slot; overflow would stay in the exchange and fail the exact check.
     if(terminal()||s.tick()-start>=600)throw Error('market settlement budget exhausted');journal.claim={coinsBefore:v.coins,itemsBefore:v.items,coins:offer.coins,items:offer.items};journal.phase='collecting';save();const collected=await collectClaim((id,notes)=>s.bot.collectGEOffer(id,notes,15000),offer.id,remaining>1);
     if(!await waitUntil(s,()=>collectionApplied(journal!,view()),{timeoutTicks:10}))throw Error('exact order collection unproved;inspect journal before retry: '+collected.message);Object.assign(journal,claimSettlement(journal,journal.claim));journal.phase='settled';delete journal.failure;save();
   }
   if(journal.phase!=='settled'||orderAccounting(journal).acquired===quantity)break;
   if(orderAccounting(journal).acquired===acquiredBeforeRound)break;
   // Bank every accounted claim before placing the next finite remainder.
   await s.bot.dismissBlockingUI();await walk(BANK,true);await openBank();await bankPack();
  }
 }catch(error){failure=String(error);if(journal){journal.failure=failure;save();}}
 finally{if(!terminal())try{await s.bot.dismissBlockingUI();await walk(BANK,true);await openBank();await bankPack();await s.bot.closeBank();}catch(error){failure=[failure,String(error)].filter(Boolean).join('; ');}off();}
 const final=assets(),{acquired,refund,spent,escrow,maximumExposure,outcomeUnresolved}=orderAccounting(journal);
 const unrelated=!!baseline&&[...new Set([...baseline.keys(),...final.keys()])].every(id=>[995,request.item].includes(id)||(baseline!.get(id)??0)-foodUsed.filter(f=>f.id===id).reduce((n,f)=>n+f.count,0)===(final.get(id)??0));
 const conserved=!outcomeUnresolved&&escrow!==null&&!!journal&&(final.get(995)??0)===(journal.coinsBefore-escrow-spent)&&(final.get(request.item)??0)===journal.itemsBefore+acquired;
 const targetMet=journal?.phase==='settled'&&acquired===quantity;
 const banked=!!journal&&count(bankItems,i=>i.id===request.item)===journal.itemsBefore+acquired
  &&count(s.sdk.getInventory(),i=>isItem(i)||i.id===995)===0&&count(s.sdk.getEquipment(),isItem)===0;
 const reserveKept=(final.get(995)??0)>=request.reserve;
 if(!failure&&journal?.phase==='settled'&&!targetMet)failure=`exact order short: acquired ${acquired}/${quantity}; accounted stock and refund retained; ${Date.now()>=request.deadline?'deadline exhausted':'finite recovery/no-progress budget exhausted'}`;
 if(!failure&&(!banked||!reserveKept||!conserved||!unrelated))failure='final bank/reserve/asset reconciliation failed';
 const ok=!failure&&!terminal()&&!damaged&&!stop()&&unrelated&&conserved&&targetMet&&banked&&reserveKept;
 if(journal){if(failure)journal.failure=failure;else if(ok)delete journal.failure;save();}
 return{ok,foodUsed,phase:journal?.phase??'unplaced',pending:journal?.phase==='open',quantity,targetMet,banked,reserveKept,acquired,newItemsThisSession:(final.get(request.item)??0)-(baseline?.get(request.item)??0),cashDeltaThisSession:(final.get(995)??0)-(baseline?.get(995)??0),refund,spent,escrow,maximumExposure,outcomeUnresolved,offerId:journal?.offerId,progress:journal?.progress??null,costBasis:journal?.phase==='settled'&&!outcomeUnresolved?{units:acquired,coins:spent,scope:'Acquisition cost only; no sale, delivery or realized profit claimed'}:null,reviewAt:request.reviewAt,deadline:request.deadline,unrelated,conserved,hpMin,died,damaged,stopped:stop(),finalCoins:final.get(995)??0,finalItems:final.get(request.item)??0,ticks:s.tick()-start,failure:failure||'-'};
}

if(import.meta.main){
 const actor=process.argv[2]!,goal=process.env.ORDER_KEY??'combat-sword';if(!/^[a-z0-9]{1,12}$/i.test(actor)||!/^[a-z0-9_-]{1,64}$/i.test(goal))throw Error('explicit owned actor/order key required');
 const fillWaitTicks=Number(process.env.FILL_WAIT_TICKS??10);if(!Number.isSafeInteger(fillWaitTicks)||fillWaitTicks<0||fillWaitTicks>200)throw Error('FILL_WAIT_TICKS must be 0-200 game ticks');
 const server=serverFromEnv(readFileSync(resolve(import.meta.dir,'../vendor/rs-sdk/bots',actor,'bot.env'),'utf8')),{base,lock,journal:journalPath}=orderPaths(server,actor,goal);mkdirSync(base,{recursive:true});
 if(existsSync(lock)){const owner=JSON.parse(readFileSync(lock,'utf8'));if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw Error('unknown market lock owner');let alive=true;try{process.kill(owner.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw e;}if(alive)throw Error('market actor already owned');unlinkSync(lock);}
 const fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,actor,server,goal,at:Date.now()}));closeSync(fd);let s:Session|undefined,stopped=false;
 try{
  const old=existsSync(journalPath)?JSON.parse(readFileSync(journalPath,'utf8')) as ItemOrder:undefined,now=Date.now(),period=Number(process.env.ORDER_MS??900000),request:ItemRequest=old?.request??{actor,server,goal,item:Number(process.env.ITEM_ID??1331),quantity:Number(process.env.QUANTITY??1),...(process.env.EXPECTED_OWNED?{expectedOwned:Number(process.env.EXPECTED_OWNED)}:{}),...(process.env.RESCUE_MODE?{rescueMode:process.env.RESCUE_MODE as ItemRequest['rescueMode']}:{}),limit:Number(process.env.LIMIT_PRICE??45000),reserve:Number(process.env.CASH_RESERVE??5000),createdAt:now,reviewAt:now+Math.min(300000,Math.max(1,Math.floor(period/3))),deadline:now+period};
  if(process.env.RESCUE_MODE&&process.env.RESCUE_MODE!==request.rescueMode)throw Error('existing rescue mode mismatch');
  if(request.actor.toLowerCase()!==actor.toLowerCase()||request.server!==server||request.goal!==goal||process.env.ITEM_ID&&Number(process.env.ITEM_ID)!==request.item||process.env.QUANTITY&&Number(process.env.QUANTITY)!==orderQuantity(request)||process.env.EXPECTED_OWNED&&Number(process.env.EXPECTED_OWNED)!==request.expectedOwned||process.env.LIMIT_PRICE&&Number(process.env.LIMIT_PRICE)!==request.limit||process.env.CASH_RESERVE&&Number(process.env.CASH_RESERVE)!==request.reserve||process.env.ORDER_MS&&Number(process.env.ORDER_MS)!==request.deadline-request.createdAt)throw Error('existing request identity/budget mismatch');
  validateRequest(request);
  if(process.env.SHOP_PROFILE){
   if(process.env.CANCEL==='1')throw Error('shop fallback cannot cancel an order');
   const fallbackPath=journalPath+'.shop.json',fallback=existsSync(fallbackPath)?JSON.parse(readFileSync(fallbackPath,'utf8')):undefined;
   const saveFallback=(value:unknown)=>{writeFileSync(fallbackPath+'.tmp',JSON.stringify(value,null,2));renameSync(fallbackPath+'.tmp',fallbackPath);};
   const spent=shopFallbackSpent(fallback,request),plan=earthShopFallback(request,old,Number(process.env.CAP??1600),spent,process.env.SHOP_PROFILE);
   const seedUsed=fallback?.seeded??0;if(![0,1].includes(seedUsed))throw Error('earth fallback seed history unknown');
   console.log('SHOP_FALLBACK '+JSON.stringify({method:process.env.SHOP_PROFILE,originalOfferId:old!.offerId,originalJournalPreserved:true,item:request.item,quantity:orderQuantity(request),target:request.expectedOwned!+orderQuantity(request),maxSpend:orderEscrow(request)-spent,reserve:request.reserve}));
   saveFallback({request,phase:'running',spent,seeded:seedUsed,at:Date.now()});
   const child=Bun.spawn([process.execPath,plan.entry,actor,...plan.args],{windowsHide:true,stdout:'pipe',stderr:'pipe',env:{...process.env,...plan.env,EARTH_SEED_USED:String(seedUsed),SHOP_PROFILE:''}});
   const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
   process.stdout.write(out);process.stderr.write(err);
   const result=out.split(/\r?\n/).filter(l=>l.startsWith('RESULT ')).at(-1),debit=Number(result?.match(/\bspentTotal=(\d+)/)?.[1]??NaN);
   if(!Number.isSafeInteger(debit)||debit<0||debit>orderEscrow(request)-spent)throw Error('shop fallback spend unconfirmed; retained running intent refuses retry');
   const seeds=plan.entry==='scripts/earth-shop.ts'?Number(result?.match(/\bseeded=(\d+)/)?.[1]??NaN):0;
   if(![0,1].includes(seeds)||seedUsed+seeds>1)throw Error('earth fallback seed count unconfirmed; retained running intent refuses retry');
   saveFallback({request,phase:'settled',spent:spent+debit,seeded:seedUsed+seeds,at:Date.now()});
   unlinkSync(lock);process.exit(code);
  }
  const rescue:RescueControl={active:false,start:0,lifeId:0,respawnCount:0};
  s=await openBot(actor,{onStop:async(session,detail)=>{if(!expectedRescueStop(session,detail,rescue))stopped=true;},onSessionEnd:async()=>{stopped=true;}});
  const stop=()=>stopped||existsSync(resolve('.practice',`stop-${actor}`));
  const result=await runOwnedItem(s,request,journalPath,stop,process.env.CANCEL==='1',fillWaitTicks,rescue);console.log('OWNED_GE_ITEM '+JSON.stringify(result));const ok=await settle([s],result.ok,JSON.stringify(result));unlinkSync(lock);process.exit(ok?0:1);
 }catch(error){if(s){await settle([s],false,String(error));if(existsSync(lock))unlinkSync(lock);process.exit(1);}if(existsSync(lock))unlinkSync(lock);throw error;}
}
