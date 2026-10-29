// One owned item/order of an exact quantity. Persistent intent, capped unit price and observed bank settlement.
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';import {createHash} from 'node:crypto';
import {openBot,settle,serverFromEnv} from '../packages/core/src/bot';import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';import {depositObserved} from '../packages/core/src/deposit';import {sessionWalker,walkPath,expandPath} from '../packages/core/src/walk';
import type {GEOffer} from '../vendor/rs-sdk/sdk/ge-types';
import {marketProgress,type MarketProgress} from '../packages/planner/src/market-progress';
// quantity is absent in journals written before bulk orders; those orders are quantity 1.
export interface ItemRequest {actor:string;server:string;goal:string;item:number;quantity?:number;limit:number;reserve:number;createdAt:number;reviewAt:number;deadline:number}
export interface OrderView {actor:string;server:string;offers:readonly GEOffer[];coins:number;items:number}
// Root acquired/refund stay cumulative. Root refund is the unused original budget.
// Each archived round retains its actual returned escrow and private fill evidence.
export interface SettledRound {offerId:number;quantity:number;acquired:number;refund:number;progress?:MarketProgress}
export interface ItemOrder {submission?:'prepared'|'attempted';rounds?:SettledRound[];version:1;request:ItemRequest;phase:'placing'|'open'|'cancelling'|'collecting'|'settled';coinsBefore:number;itemsBefore:number;previousIds:number[];at:number;offerId?:number;progress?:MarketProgress;claim?:{coinsBefore:number;itemsBefore:number;coins:number;items:number};acquired?:number;refund?:number;failure?:string}
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
 const unresolved=!valid||['placing','cancelling','collecting'].includes(journal.phase);
 const knownSpent=settled&&valid?spent:prior.spent+(journal.phase==='open'&&valid?(journal.progress?.gross??0):0);
 return{acquired:settled&&valid?a:prior.acquired,refund:settled&&valid?refund:0,spent:knownSpent,
  escrow:unresolved?null:settled?0:prior.escrow-(journal.progress?.gross??0),maximumExposure:settled&&valid?0:prior.escrow,outcomeUnresolved:unresolved};
}
function roundBaseline(j:ItemOrder){const p=priorRounds(j);return{...p,coins:j.coinsBefore-p.spent,items:j.itemsBefore+p.acquired};}
function claimSettlement(j:ItemOrder,c:{items:number;coins:number}){
 const p=priorRounds(j);return{acquired:p.acquired+c.items,refund:orderEscrow(j.request)-p.spent-p.escrow+c.coins};
}
export function validateRequest(r:ItemRequest){
 if(!/^[a-z0-9]{1,12}$/i.test(r.actor)||!r.server||!/^[a-z0-9_-]{1,64}$/i.test(r.goal)||![r.item,r.limit].every(n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647)||r.quantity!==undefined&&!(Number.isSafeInteger(r.quantity)&&r.quantity>0)||orderEscrow(r)>2147483647||!Number.isSafeInteger(r.reserve)||r.reserve<0||![r.createdAt,r.reviewAt,r.deadline].every(n=>Number.isSafeInteger(n)&&n>0)||r.reviewAt<r.createdAt||r.deadline<=r.reviewAt)throw Error('invalid item order request');
}
// Banknotes share the item's published name and have no config (knowledge/BUILD.md), so they are absent from the catalogue.
// A catalogued item with the same name is a different item and never counts.
export function orderItemMatcher(item:number,catalogue:readonly {id:number;name:string}[]){
 const name=catalogue.find(i=>i.id===item)?.name.toLowerCase(),known=new Set(catalogue.map(i=>i.id));
 return(i:{id:number;name?:string})=>i.id===item||!!name&&i.name?.toLowerCase()===name&&!known.has(i.id);
}
export function orderPaths(server:string,actor:string,goal:string){
 const base=resolve('.practice/market-orders',createHash('sha256').update(server).digest('hex').slice(0,12));
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
const BANK={x:3185,z:3436},GE={x:3181,z:3443};
export const marketTileSafe=(p:{x:number;z:number;level:number})=>p.level===0&&p.x>=3180&&p.x<=3188&&p.z>=3433&&p.z<=3447;
// Remote bank travel needs a shared, session-neutral ferry helper.
export function marketEntryFailure(p:{worldX:number;worldZ:number;level:number}|null|undefined,hp:number){
 const where=p?`${p.worldX},${p.worldZ},${p.level}`:'unknown';
 if(!p||!marketTileSafe({x:p.worldX,z:p.worldZ,level:p.level}))return `unsupported market entry: position=${where} currentHP=${hp}; requires observed Varrock West/GE start; remote bank relocation unavailable in this worker`;
 if(!Number.isFinite(hp)||hp<=0)return `market entry: position=${where} currentHP=${hp}; living actor required`;
 if(hp<=6&&Math.max(Math.abs(p.worldX-BANK.x),Math.abs(p.worldZ-BANK.z))>3)return `market health preparation: position=${where} currentHP=${hp}; requires bank approach within3 before healing`;
 return null;
}
const catalogue=():{id:number;name:string}[]=>JSON.parse(readFileSync(new URL('../knowledge/items.json',import.meta.url),'utf8'));

export async function runOwnedItem(s:Session,request:ItemRequest,journalPath:string,stop:()=>boolean,cancel:boolean,fillWaitTicks:number){
 validateRequest(request);const quantity=orderQuantity(request),isItem=orderItemMatcher(request.item,catalogue());
 if(s.name.toLowerCase()!==request.actor.toLowerCase())throw Error('order actor identity mismatch');
 if(!await waitUntil(s,()=>stop()||!!s.sdk.getState()?.player&&s.sdk.getStateAge()<=5000&&!!s.sdk.getSkill('Hitpoints'),{timeoutTicks:15})||stop())throw Error('observed market entry state deadline/stop');
 const state=()=>s.sdk.getState(),held=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,start=s.tick(),hp0=hp(),p0=state()?.player;
 const entryFailure=marketEntryFailure(p0,hp0);if(entryFailure)throw Error(entryFailure);
 if(!p0)throw Error('market position unknown');
 let hpGuard=hp0;const foodUsed:{id:number;count:number}[]=[],preparationFood=new Set<number>();
 let ended=false,died=false,damaged=false,hpMin=hp0,failure='',bankItems:readonly {id:number;name:string;count:number}[]=[],baseline:Map<number,number>|undefined,journal:ItemOrder|undefined;
 if(existsSync(journalPath)){journal=JSON.parse(readFileSync(journalPath,'utf8'));if(journal?.version!==1||!['placing','open','cancelling','collecting','settled'].includes(journal.phase)||!Array.isArray(journal.previousIds)||JSON.stringify(journal.request)!==JSON.stringify(request))throw Error('journal request identity/config/state changed');}
 const save=()=>{if(!journal)throw Error('missing order journal');journal.at=Date.now();writeFileSync(journalPath+'.tmp',JSON.stringify(journal,null,2));renameSync(journalPath+'.tmp',journalPath);};
 void s.ended.then(()=>{ended=true;});const off=s.onTick(()=>{const p=state()?.player;hpMin=Math.min(hpMin,hp());damaged||=hp()<hpGuard||!!p&&!marketTileSafe({x:p.worldX,z:p.worldZ,level:p.level});died||=hp()<=0||!!p?.isDead||p?.lifeId!==p0.lifeId||(p?.respawnCount??0)>(p0.respawnCount??0);});
 const terminal=()=>ended||died,over=()=>terminal()||damaged||stop()||s.tick()-start>=500;
 // Item totals join the item with its banknote. Coins are counted by ID.
 const count=(a:readonly {id:number;name:string;count:number}[],match:(i:{id:number;name:string})=>boolean)=>a.filter(match).reduce((n,i)=>n+i.count,0);
 const coinsTotal=()=>held(995)+count(bankItems,i=>i.id===995)+count(s.sdk.getEquipment(),i=>i.id===995),itemTotal=()=>count(s.sdk.getInventory(),isItem)+count(bankItems,isItem)+count(s.sdk.getEquipment(),isItem);
 const assets=()=>{const m=new Map<number,number>();for(const i of [...s.sdk.getInventory(),...bankItems,...s.sdk.getEquipment()]){const id=isItem(i)?request.item:i.id;m.set(id,(m.get(id)??0)+i.count);}return m;};
 const capture=()=>{if(!state()?.bank.isOpen||!s.bankObservation?.())throw Error('fresh bank observation required');bankItems=s.bankObservation()!.items.map(i=>({id:i.id,name:i.name,count:i.count}));};
 const walk=async(to:{x:number;z:number},cleanup=false)=>{const end=()=>terminal()||(!cleanup&&over())||s.tick()-start>=680;if(end())throw Error('market route stopped');const p=state()?.player;if(p&&Math.max(Math.abs(p.worldX-to.x),Math.abs(p.worldZ-to.z))<=1)return;const deps=await sessionWalker(s),plan=deps.plan;deps.plan=(level,from,goal)=>{const corners=plan(level,from,goal);if(!corners.length||[from,...expandPath(from,corners)].some(p=>!marketTileSafe({...p,level})))throw Error('market full path outside known bank rectangle');return corners;};if(!(await walkPath(deps,[{...to,tol:1}],{maxTicks:120,stop:end})).ok)throw Error('market bank/GE route failed');};
 const openBank=async()=>{await s.bot.dismissBlockingUI();const gen=s.bankObservation?.()?.generation??0;if(!state()?.bank.isOpen&&(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>gen||terminal(),{timeoutTicks:15})||terminal()))throw Error('market bank open unproved');capture();};
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
  await walk(BANK);await openBank();baseline=assets();await bankPack();
  // One owned salmon/trout/lobster crosses the >6 HP entry floor. Cash is never spent on preparation.
  if(hp()<=6){
   if(over())throw Error('market health preparation stopped');
   const food=bankItems.find(i=>[329,333,379].includes(i.id)&&i.id!==request.item&&i.count>0);
   if(!food)throw Error(`market health preparation: currentHP=${hp()}; acquire 1 owned salmon(329),trout(333) or lobster(379) at this bank`);
   preparationFood.add(food.id);const n=held(food.id),bankBefore=count(bankItems,i=>i.id===food.id),gen=s.bankObservation?.()?.generation??0;
   const live=state()?.bank.items.find(i=>i.id===food.id);if(!live)throw Error('market health preparation food missing from open bank');
   await s.bot.withdrawItem(live,1,{asNote:false});
   if(!await waitUntil(s,()=>terminal()||held(food.id)===n+1&&(s.bankObservation?.()?.generation??0)>gen&&count(s.bankObservation?.()?.items??[],i=>i.id===food.id)===bankBefore-1,{timeoutTicks:10})||terminal())throw Error('market health preparation withdrawal unobserved');
   capture();await s.bot.closeBank();if(over())throw Error('market health preparation stopped');
   const target=s.sdk.getInventory().find(i=>i.id===food.id),beforeHp=hp();if(!target)throw Error('market health preparation food missing');
   try{await s.bot.eatFood(target);}catch{/* Observe a possibly applied action. */}
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
   const needsFunding=!journal||journal.phase==='settled'||journal.phase==='placing'&&journal.submission==='prepared';
   if(needsFunding){
    if(cancel)throw Error('no submitted order to cancel');if(!journal&&itemTotal()>0)throw Error('owned item already present;allocate it instead of buying duplicate stock');
    if(Date.now()>=request.deadline||over()||coinsTotal()<roundEscrow+request.reserve||s.sdk.getInventory().length>26)throw Error('order expired,owned reserve missing or two collection slots unavailable');
    if(journal&&journal.phase==='placing'&&(coinsTotal()!==roundBaseline(journal).coins||itemTotal()!==roundBaseline(journal).items))throw Error('prepared order asset baseline changed');
    const coins=s.sdk.findBankItem(/^coins$/i),beforeBank=count(bankItems,i=>i.id===995),gen=s.bankObservation?.()?.generation??0;
    if(!coins||!(await s.bot.withdrawItem(coins,roundEscrow,{asNote:false})).success||!await waitUntil(s,()=>held(995)===roundEscrow&&(s.bankObservation?.()?.generation??0)>gen&&count(s.bankObservation?.()?.items??[],i=>i.id===995)===beforeBank-roundEscrow,{timeoutTicks:10}))throw Error('owned order funding unobserved');
    capture();if(count(bankItems,i=>i.id===995)!==beforeBank-roundEscrow)throw Error('owned order bank debit mismatch');
   }
   await s.bot.closeBank();if(over())throw Error('market budget/stop before GE');
   await walk(GE);if(!(await s.bot.openGE(15000)).success)throw Error('GE interface unavailable');if(over())throw Error('market operation budget/stop');
   if(journal?.phase==='settled'){
    const prior=priorRounds(journal),accounted=orderAccounting(journal),v=view();
    if(journal.offerId===undefined||v.offers.some(o=>o.id===journal!.offerId)||accounted.outcomeUnresolved)throw Error('previous settled offer still visible or unproved');
    const round:SettledRound={offerId:journal.offerId,quantity:prior.quantity,acquired:accounted.acquired-prior.acquired,refund:prior.escrow-(accounted.spent-prior.spent),progress:journal.progress};
    journal={version:1,request,phase:'placing',submission:'prepared',coinsBefore:journal.coinsBefore,itemsBefore:journal.itemsBefore,
     previousIds:v.offers.map(o=>o.id),at:Date.now(),rounds:[...(journal.rounds??[]),round]};save();
   }
   if(!journal){const v=view();journal={version:1,request,phase:'placing',submission:'prepared',coinsBefore:v.coins,itemsBefore:v.items,previousIds:v.offers.map(o=>o.id),at:Date.now()};save();}
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
     await s.bot.collectGEOffer(journal.offerId!,remaining>1,15000);
     if(!await waitUntil(s,()=>collectionApplied(journal!,view()),{timeoutTicks:10}))throw Error('resumed exact collection unproved');
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
     if(terminal()||s.tick()-start>=600)throw Error('market settlement budget exhausted');journal.claim={coinsBefore:v.coins,itemsBefore:v.items,coins:offer.coins,items:offer.items};journal.phase='collecting';save();await s.bot.collectGEOffer(offer.id,remaining>1,15000);
     if(!await waitUntil(s,()=>collectionApplied(journal!,view()),{timeoutTicks:10}))throw Error('exact order collection unproved;inspect journal before retry');Object.assign(journal,claimSettlement(journal,journal.claim));journal.phase='settled';delete journal.failure;save();
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
 const server=serverFromEnv(readFileSync(resolve('vendor/rs-sdk/bots',actor,'bot.env'),'utf8')),{base,lock,journal:journalPath}=orderPaths(server,actor,goal);mkdirSync(base,{recursive:true});
 if(existsSync(lock)){const owner=JSON.parse(readFileSync(lock,'utf8'));if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw Error('unknown market lock owner');let alive=true;try{process.kill(owner.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw e;}if(alive)throw Error('market actor already owned');unlinkSync(lock);}
 const fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,actor,server,goal,at:Date.now()}));closeSync(fd);let s:Session|undefined,stopped=false;
 try{
  const old=existsSync(journalPath)?JSON.parse(readFileSync(journalPath,'utf8')) as ItemOrder:undefined,now=Date.now(),period=Number(process.env.ORDER_MS??900000),request:ItemRequest=old?.request??{actor,server,goal,item:Number(process.env.ITEM_ID??1331),quantity:Number(process.env.QUANTITY??1),limit:Number(process.env.LIMIT_PRICE??45000),reserve:Number(process.env.CASH_RESERVE??5000),createdAt:now,reviewAt:now+Math.min(300000,Math.max(1,Math.floor(period/3))),deadline:now+period};
  if(request.actor.toLowerCase()!==actor.toLowerCase()||request.server!==server||request.goal!==goal||process.env.ITEM_ID&&Number(process.env.ITEM_ID)!==request.item||process.env.QUANTITY&&Number(process.env.QUANTITY)!==orderQuantity(request)||process.env.LIMIT_PRICE&&Number(process.env.LIMIT_PRICE)!==request.limit||process.env.CASH_RESERVE&&Number(process.env.CASH_RESERVE)!==request.reserve||process.env.ORDER_MS&&Number(process.env.ORDER_MS)!==request.deadline-request.createdAt)throw Error('existing request identity/budget mismatch');
  validateRequest(request);s=await openBot(actor,{onStop:async()=>{stopped=true;}});const result=await runOwnedItem(s,request,journalPath,()=>stopped,process.env.CANCEL==='1',fillWaitTicks);console.log('OWNED_GE_ITEM '+JSON.stringify(result));const ok=await settle([s],result.ok,JSON.stringify(result));unlinkSync(lock);process.exit(ok?0:1);
 }catch(error){if(s){await settle([s],false,String(error));if(existsSync(lock))unlinkSync(lock);process.exit(1);}if(existsSync(lock))unlinkSync(lock);throw error;}
}
