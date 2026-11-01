import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,settle,serverFromEnv} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import type {GEOffer} from '../vendor/rs-sdk/sdk/ge-types';
import {waitUntil} from '../packages/core/src/ticks';
import {marketProgress,type MarketProgress} from '../packages/planner/src/market-progress';
import {orderPaths,collectClaim,marketEntryFailure} from './buy-owned-ge-item';
export interface SaleRequest {actor:string;server:string;goal:string;item:number;quantity:number;price:number;floor:number;reserveItems:number;deadline:number}
export interface SaleJournal {version:1;request:SaleRequest;phase:'prepared'|'attempted'|'open'|'cancelling'|'collecting'|'settled';coinsBefore:number;itemsBefore:number;previousIds:number[];offerId?:number;progress?:MarketProgress;claim?:{items:number;coins:number};failure?:string}
export interface SaleView {actor:string;server:string;coins:number;items:number;offers:readonly GEOffer[]}
export function validateSale(r:SaleRequest){if(!/^[a-z0-9]{1,12}$/i.test(r.actor)||!r.server||!/^[a-z0-9_-]{1,64}$/i.test(r.goal)||![r.item,r.quantity,r.price,r.floor,r.deadline].every(n=>Number.isSafeInteger(n)&&n>0)||!Number.isSafeInteger(r.reserveItems)||r.reserveItems<0||r.price<r.floor||r.price*r.quantity>2147483647||r.item===995)throw Error('invalid finite sale request');}
function identity(j:SaleJournal,v:SaleView){if(j.request.actor.toLowerCase()!==v.actor.toLowerCase()||j.request.server!==v.server)throw Error('sale actor/server changed');}
function matches(j:SaleJournal,o:GEOffer){const r=j.request;return o.item===r.item&&o.quantity===r.quantity&&o.price===r.price&&o.side==='sell';}
export function saleProgress(j:SaleJournal,o:GEOffer){if(o.id!==j.offerId||!matches(j,o)||o.tax!==Math.floor(o.gross/20))throw Error('sale identity/cumulative tax mismatch');return marketProgress(j.progress??null,{actor:j.request.actor,server:j.request.server,offerId:o.id,itemId:o.item,side:o.side,quantity:o.quantity,limit:o.price,filled:o.filled,gross:o.gross,tax:o.tax,at:Date.now()}).current;}
export function salePlacement(j:SaleJournal,v:SaleView){identity(j,v);const found=v.offers.filter(o=>!j.previousIds.includes(o.id)&&matches(j,o));if(found.length>1)throw Error('ambiguous sale placement');if(!found.length)return;if(v.items!==j.itemsBefore-j.request.quantity||v.coins!==j.coinsBefore)throw Error('sale escrow debit mismatch');return found[0];}
// Private offers and the pack can publish on adjacent ticks. Only the bounded wait tolerates this gap.
export function salePlacementReady(j:SaleJournal,v:SaleView){try{return !!salePlacement(j,v);}catch(e){if(String(e).includes('sale escrow debit mismatch'))return false;throw e;}}
export function saleClaim(j:SaleJournal,o:GEOffer){saleProgress(j,o);if(o.state==='open'||o.remaining!==0||o.items!==j.request.quantity-o.filled||o.coins!==o.gross-o.tax||o.state==='completed'&&o.filled!==j.request.quantity)throw Error('sale terminal escrow mismatch');return{items:o.items,coins:o.coins};}
export function saleCollected(j:SaleJournal,v:SaleView){identity(j,v);return !!j.claim&&!!j.progress&&j.claim.items===j.request.quantity-j.progress.filled&&j.claim.coins===j.progress.gross-j.progress.tax&&!v.offers.some(o=>o.id===j.offerId)&&v.items===j.itemsBefore-j.request.quantity+j.claim.items&&v.coins===j.coinsBefore+j.claim.coins;}
// The caller supplies a genuine surplus lot in the normal-item pack. Reserved stock stays carried.
// No repricing, replacement orders, auto-repeat or partial collection is permitted.
export async function runOwnedSale(s:Session,r:SaleRequest,path:string,stop:()=>boolean,waitTicks=40,cancel=false){
 validateSale(r);if(s.name.toLowerCase()!==r.actor.toLowerCase()||!Number.isSafeInteger(waitTicks)||waitTicks<0||waitTicks>200)throw Error('sale actor/wait invalid');
 if(!await waitUntil(s,()=>!!s.sdk.getState()?.player&&s.sdk.getStateAge()<5000,{timeoutTicks:15}))throw Error('fresh sale entry absent');
 const entry=marketEntryFailure(s.sdk.getState()?.player,s.sdk.getSkill('Hitpoints')?.level??0);if(entry)throw Error(entry);
 const start=s.tick(),hp=s.sdk.getSkill('Hitpoints')!.level;let ended=false;void s.ended.then(()=>{ended=true;});
 const unsafe=()=>ended||stop()||s.tick()-start>350||(s.sdk.getSkill('Hitpoints')?.level??0)<hp;
 const held=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 let j:SaleJournal|undefined=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):undefined;
 if(j&&(j.version!==1||JSON.stringify(j.request)!==JSON.stringify(r)||!['prepared','attempted','open','cancelling','collecting','settled'].includes(j.phase)))throw Error('sale journal identity/config changed');
 const save=()=>{writeFileSync(path+'.tmp',JSON.stringify(j,null,2));renameSync(path+'.tmp',path);};
 const view=():SaleView=>{const ge=s.sdk.getGEState();if(!ge||s.sdk.getStateAge()>5000)throw Error('fresh private sale observation absent');return{actor:s.name,server:r.server,coins:held(995),items:held(r.item),offers:ge.offers};};
 try{
  if(unsafe())throw Error('sale stopped before exchange');if(!(await s.bot.openGE(15000)).success)throw Error('sale exchange unavailable');
  if(!j){const v=view();if(cancel||Date.now()>=r.deadline||v.items<r.quantity+r.reserveItems||s.sdk.getInventory().length>26)throw Error('sale surplus/deadline/collection space missing');j={version:1,request:r,phase:'prepared',coinsBefore:v.coins,itemsBefore:v.items,previousIds:v.offers.map(o=>o.id)};save();}
  if(j.phase==='settled'){if(!saleCollected(j,view()))throw Error('settled sale assets changed');return{ok:true,journal:j,replay:true};}
  if(j.phase==='prepared'){
   const v=view();if(unsafe()||cancel||Date.now()>=r.deadline||v.items!==j.itemsBefore||v.coins!==j.coinsBefore||v.offers.length!==j.previousIds.length||!v.offers.every(o=>j!.previousIds.includes(o.id)))throw Error('prepared sale baseline changed');
   j.phase='attempted';save();try{await s.bot.placeGEOffer({item:r.item,quantity:r.quantity,side:'sell',price:r.price},20000);}catch{/* Reconcile native effects before any retry. */}
  }
  if(j.phase==='attempted'){await waitUntil(s,()=>salePlacementReady(j!,view()),{timeoutTicks:10});const o=salePlacement(j,view());if(!o)throw Error('sale dispatch unknown; no second sell authorized');j.offerId=o.id;j.phase='open';save();}
  if(j.phase==='open'&&!cancel&&!unsafe()&&Date.now()<r.deadline&&waitTicks)await waitUntil(s,()=>unsafe()||Date.now()>=r.deadline||view().offers.find(o=>o.id===j!.offerId)?.state!=='open',{timeoutTicks:waitTicks});
  if(j.phase==='open'||j.phase==='cancelling'){
   let v=view(),o=v.offers.find(o=>o.id===j!.offerId);if(!o||v.items!==j.itemsBefore-r.quantity||v.coins!==j.coinsBefore)throw Error('sale escrow/offer changed');j.progress=saleProgress(j,o);save();
   if(o.state==='open'){if(ended)throw Error('sale disconnected');j.phase='cancelling';save();try{await s.bot.cancelGEOffer(o.id,15000);}catch{/* A lost response can still have cancelled. */}await waitUntil(s,()=>view().offers.find(o=>o.id===j!.offerId)?.state!=='open',{timeoutTicks:10});v=view();o=v.offers.find(o=>o.id===j!.offerId);if(!o)throw Error('cancelled sale absent');}
   j.progress=saleProgress(j,o);j.claim=saleClaim(j,o);j.phase='collecting';save();
  }
  if(j.phase==='collecting'){
   let v=view();if(!saleCollected(j,v)){const o=v.offers.find(o=>o.id===j!.offerId);if(!o||JSON.stringify(saleClaim(j,o))!==JSON.stringify(j.claim)||v.coins!==j.coinsBefore||v.items!==j.itemsBefore-r.quantity)throw Error('sale collection outcome unknown');
    try{await collectClaim((id,notes)=>s.bot.collectGEOffer(id,notes,15000),j.offerId!,false);}catch{/* Verify exact pack credit. */}
    if(!await waitUntil(s,()=>saleCollected(j!,view()),{timeoutTicks:10}))throw Error('sale collection not reconciled');
   }j.phase='settled';delete j.failure;save();
  }
  return{ok:j.phase==='settled',journal:j,replay:false};
 }catch(e){if(j){j.failure=String(e);save();}return{ok:false,journal:j,error:String(e)};}
}
if(import.meta.main){
 const actor=process.argv[2]!,goal=process.env.ORDER_KEY??'owned-surplus-sale',server=serverFromEnv(readFileSync(resolve('vendor/rs-sdk/bots',actor,'bot.env'),'utf8'));
 const paths=orderPaths(server,actor,'sell-'+goal);mkdirSync(paths.base,{recursive:true});if(existsSync(paths.lock)){const owner=JSON.parse(readFileSync(paths.lock,'utf8'));if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw Error('unknown market lock owner');let alive=true;try{process.kill(owner.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw e;}if(alive)throw Error('market actor already owned');unlinkSync(paths.lock);}const fd=openSync(paths.lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,actor,goal}));closeSync(fd);let s:Session|undefined;
 try{const old:SaleJournal|undefined=existsSync(paths.journal)?JSON.parse(readFileSync(paths.journal,'utf8')):undefined,r=old?.request??{actor,server,goal,item:Number(process.env.ITEM_ID),quantity:Number(process.env.QUANTITY),price:Number(process.env.SELL_PRICE),floor:Number(process.env.FLOOR_PRICE),reserveItems:Number(process.env.RESERVE_ITEMS??0),deadline:Date.now()+Number(process.env.ORDER_MS??60000)};
 if(r.actor!==actor||r.server!==server||r.goal!==goal)throw Error('sale CLI identity mismatch');for(const[key,field]of [['ITEM_ID','item'],['QUANTITY','quantity'],['SELL_PRICE','price'],['FLOOR_PRICE','floor'],['RESERVE_ITEMS','reserveItems']]as const)if(process.env[key]!==undefined&&Number(process.env[key])!==r[field])throw Error('sale CLI budget mismatch');validateSale(r);
 s=await openBot(actor);const result=await runOwnedSale(s,r,paths.journal,()=>existsSync(resolve('.practice','stop-'+actor)),Number(process.env.FILL_WAIT_TICKS??40),process.env.CANCEL==='1');console.log('OWNED_GE_SALE '+JSON.stringify(result));process.exitCode=await settle([s],result.ok,JSON.stringify(result))?0:1;
 }catch(e){if(s)await settle([s],false,String(e));throw e;}finally{unlinkSync(paths.lock);}
}
