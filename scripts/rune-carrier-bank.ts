import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {walkPath,walkRoute,sessionWalker} from '../packages/core/src/walk';
import {interactionApproach} from '../packages/core/src/world';
import {depositObserved} from '../packages/core/src/deposit';
import {RUNE_ALTARS,ruinTarget,dispatchRuneEntry} from './rune-bank-craft';
import {ess,state} from './rune-carrier-trade';
import {BODY_CARRIER_ALTAR,insideCarrierAltar,type RuneCarrierAltar} from './rune-carrier-altar';
// The continuation path (bankCarrier, stageCarrier) stays at the body altar and the Edgeville booth.
const ruinsOf=(a:RuneCarrierAltar)=>{const r=RUNE_ALTARS.find(r=>r.name===a.name);if(!r)throw Error('no ruins for altar '+a.name);return r;};
const bank={x:BODY_CARRIER_ALTAR.bank.x,z:BODY_CARRIER_ALTAR.bank.z};
const events:unknown[]=[];
const pos=(s:Session)=>state(s).player!;
const inside=(s:Session,a:RuneCarrierAltar=BODY_CARRIER_ALTAR)=>insideCarrierAltar(a,pos(s));
const count=(s:Session,id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
let stopped=false;const cancellation=new AbortController();
const check=(s:Session)=>{if(stopped||s.tick()>Number(process.env.CAP??2800)||s.sdk.getSkill('Hitpoints')?.level===0)throw Error('carrier stopped or over budget');};
async function walk(s:Session,p:{x:number;z:number},tol=0){
 check(s);const r=await walkPath(await sessionWalker(s),[{...p,tol}],{maxTicks:150,stop:()=>stopped});
 check(s);if(!r.ok||Math.max(Math.abs(pos(s).worldX-p.x),Math.abs(pos(s).worldZ-p.z))>tol)throw Error('carrier walk '+JSON.stringify({p,r,position:pos(s)}));
}
async function leaveBody(s:Session,a:RuneCarrierAltar=BODY_CARRIER_ALTAR){
 check(s);const ruins=ruinsOf(a);
 if(inside(s,a)){
 const portal=state(s).nearbyLocs.find(l=>l.id===ruins.portal);if(!portal)throw Error(a.name+' portal missing');
 const edges=[{x:portal.x,z:portal.z+1},{x:portal.x+1,z:portal.z},{x:portal.x,z:portal.z-1},{x:portal.x-1,z:portal.z}];
 const edge=edges.find(p=>{const path=s.sdk.findPath(p.x,p.z);return path.success&&path.reachedDestination===true;});
 if(!edge)throw Error(a.name+' portal edge missing');await walk(s,edge);
 const exit=await s.sdk.sendInteractLoc(portal.x,portal.z,portal.id,1);if(!exit.success)throw Error(a.name+' exit refused');
 if(!await waitUntil(s,()=>!inside(s,a),{timeoutTicks:15}))throw Error(a.name+' exit unobserved');
 }else if(pos(s).level!==0||Math.max(Math.abs(pos(s).worldX-ruins.outside.x),Math.abs(pos(s).worldZ-ruins.outside.z))>5)throw Error(`carrier outside ${a.name} entry unobserved`);
}
async function restock(s:Session,a:RuneCarrierAltar=BODY_CARRIER_ALTAR){
 if(!s.bankObservation)throw Error('carrier bank observation unavailable');
 const start=s.tick(),record=(stage:string)=>{const row={account:s.name,stage,tick:s.tick(),essence:ess(s),position:{x:pos(s).worldX,z:pos(s).worldZ,level:pos(s).level}};events.push(row);console.log('CARRIER '+JSON.stringify(row));};
 check(s);if(ess(s)!==0)throw Error('carrier must deliver before restocking');
 const tal=a.talisman;
 record('exit');await leaveBody(s,a);
 record('bank-travel');await walk(s,a.bank,2);
 const gen=s.bankObservation!()?.generation??0;
 if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state(s).bank.isOpen&&(s.bankObservation!()?.generation??0)>gen,{timeoutTicks:15}))throw Error('fresh bank unavailable');
 check(s);
 for(const id of new Set(s.sdk.getInventory().filter(i=>i.id!==tal||count(s,tal)!==1).map(i=>i.id))){
  check(s);const item=s.sdk.getInventory().find(i=>i.id===id)!;await depositObserved(s,item);
 }
 if(count(s,tal)===0){
  check(s);
  const stock=s.bankObservation!()!.items.filter(i=>i.id===tal).reduce((n,i)=>n+i.count,0),slot=state(s).bank.items.find(i=>i.id===tal);
  if(stock<1||!slot)throw Error(`carrier ${a.name} talisman unavailable`);
  if(!(await s.bot.withdrawItem(slot,1)).success||!await waitUntil(s,()=>count(s,tal)===1&&(s.bankObservation!()?.items.filter(i=>i.id===tal).reduce((n,i)=>n+i.count,0)??NaN)===stock-1,{timeoutTicks:15}))throw Error('carrier talisman debit/credit mismatch');
 }
 check(s);const before=s.bankObservation!()!.items.filter(i=>i.id===1436).reduce((n,i)=>n+i.count,0);
 if(before<27||ess(s)!==0||count(s,tal)!==1)throw Error('carrier bank entry stock mismatch');
 const item=state(s).bank.items.find(i=>i.id===1436);if(!item)throw Error('essence bank slot missing');
 const reply=await s.bot.withdrawItem(item,27);if(!reply.success)throw Error('carrier withdrawal refused');
 if(!await waitUntil(s,()=>ess(s)===27&&(s.bankObservation!()?.items.filter(i=>i.id===1436).reduce((n,i)=>n+i.count,0)??NaN)===before-27,{timeoutTicks:15}))throw Error('carrier debit/credit mismatch');
 check(s);if(!(await s.bot.closeBank()).success)throw Error('carrier bank close refused');
 record('ruins-travel');await enterBody(s,a);record('ready');return s.tick()-start;
}
async function enterBody(s:Session,a:RuneCarrierAltar=BODY_CARRIER_ALTAR){
 const ruins=ruinsOf(a);
 await walk(s,ruins.outside);
 const {at,q}=ruinTarget(ruins),face=await interactionApproach(s.sdk,at,q);if(!face)throw Error(a.name+' ruins face missing');
 await walk(s,face);const tal=s.sdk.getInventory().find(i=>i.id===a.talisman);if(!tal)throw Error(a.name+' talisman missing');
 const entered=await dispatchRuneEntry(s,{entered:()=>inside(s,a),stop:()=>stopped,dispatch:()=>s.sdk.sendUseItemOnLoc(tal.slot,at.x,at.z,q.id)});
 if(!entered.entered)throw Error(a.name+' entry unobserved '+JSON.stringify(entered));
 await walk(s,a.staging);
}

export {restock,inside,leaveBody,enterBody};
export const stopCarriers=()=>{stopped=true;cancellation.abort();};

export type CarrierAssets=Record<number,number>;
export const carrierAssets=(items:readonly {id:number;count:number}[])=>{
 const totals:CarrierAssets={};for(const i of items)totals[i.id]=(totals[i.id]??0)+i.count;return totals;
};
// Continuation observes the bank before it allocates retained stock.
export async function bankCarrier(s:Session):Promise<CarrierAssets>{
 check(s);if(!s.bankObservation)throw Error('carrier bank observation unavailable');
 const fromFalador=pos(s).level===0&&pos(s).worldX>=3010&&pos(s).worldX<=3016&&pos(s).worldZ>=3352&&pos(s).worldZ<=3358;
 if(inside(s))await leaveBody(s);
 else if(pos(s).level!==0||!((pos(s).worldX>=3035&&pos(s).worldX<=3105&&pos(s).worldZ>=3410&&pos(s).worldZ<=3510)
  ||fromFalador))throw Error('continuation bank route position unavailable');
 if(fromFalador){
  const r=await walkRoute(s,[{kind:'walk',to:{...bank,level:0},tolerance:2}],{signal:cancellation.signal});check(s);
  if(!r.ok)throw Error('continuation staging walk '+JSON.stringify(r));
 }else await walk(s,bank,2);
 // maps/m48_54.jm2:6375 places bankbooth as shape10 angle3; bank_booth.loc is 1x1 with no forceapproach.
 // Travel tolerance leaves the SDK free to walk at the counter and enter unrelated door recovery.
 const at={x:3095,z:3491,level:0},q={id:2213,shape:10,angle:3,width:1,height:1,blockAccessFlags:0,
  src:'maps/m48_54.jm2:6375',configSrc:'scripts/interface_bank/configs/bank_booth.loc'};
 const face=await interactionApproach(s.sdk,at,q);check(s);
 if(!face)throw Error(s.name+': continuation bank interaction face unavailable');
 await walk(s,face);
 const gen=s.bankObservation()?.generation??0,reply=await s.bot.openBank();
 check(s);
 if(!reply.success||!await waitUntil(s,()=>stopped||!!state(s).bank.isOpen&&(s.bankObservation!()?.generation??0)>gen,{timeoutTicks:15}))throw Error(s.name+': continuation bank unobserved '+JSON.stringify({reply,generation:gen,position:pos(s)}));
 check(s);const before=carrierAssets([...s.sdk.getInventory(),...s.bankObservation()!.items]);
 for(const id of new Set(s.sdk.getInventory().map(i=>i.id))){check(s);await depositObserved(s,s.sdk.getInventory().find(i=>i.id===id)!);}
 check(s);const after=carrierAssets(s.bankObservation()!.items);
 if(s.sdk.getInventory().length||JSON.stringify(Object.entries(before).sort())!==JSON.stringify(Object.entries(after).sort()))throw Error('continuation deposit mismatch');
 return after;
}
export async function withdrawCarrier(s:Session,id:number,n:number){
 check(s);const held=count(s,id),stock=s.bankObservation!()?.items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0)??0;
 const item=state(s).bank.items.find(i=>i.id===id);
 if(!Number.isSafeInteger(n)||n<1||stock<n||!item)throw Error(`continuation supply shortage item${id} needs${n} has${stock}`);
 if(!(await s.bot.withdrawItem(item,n)).success||!await waitUntil(s,()=>stopped||count(s,id)===held+n&&(s.bankObservation!()?.items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0)??NaN)===stock-n,{timeoutTicks:15}))throw Error('continuation withdrawal mismatch');
 check(s);
}
export async function closeCarrierBank(s:Session){check(s);if(!(await s.bot.closeBank()).success)throw Error('continuation bank close refused');check(s);}
export async function stageCarrier(s:Session,n:number,fromBank=false){
 if(!fromBank)await bankCarrier(s);
 await withdrawCarrier(s,1446,1);if(n>0)await withdrawCarrier(s,1436,n);
 await closeCarrierBank(s);await enterBody(s);
}
