import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {walkPath,sessionWalker} from '../packages/core/src/walk';
import {interactionApproach} from '../packages/core/src/world';
import {depositObserved} from '../packages/core/src/deposit';
import {RUNE_ALTARS,ruinTarget,dispatchRuneEntry} from './rune-bank-craft';
import {ess,state} from './rune-carrier-trade';
const body=RUNE_ALTARS.find(a=>a.name==='body')!,bank={x:3092,z:3496},staging={x:2523,z:4833};
const events:unknown[]=[];
const pos=(s:Session)=>state(s).player!;
const inside=(s:Session)=>pos(s).level===0&&Math.floor(pos(s).worldX/64)===39&&Math.floor(pos(s).worldZ/64)===75;
const count=(s:Session,id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
let stopped=false;
const check=(s:Session)=>{if(stopped||s.tick()>Number(process.env.CAP??2800)||s.sdk.getSkill('Hitpoints')?.level===0)throw Error('carrier stopped or over budget');};
async function walk(s:Session,p:{x:number;z:number},tol=0){
 check(s);const r=await walkPath(await sessionWalker(s),[{...p,tol}],{maxTicks:150,stop:()=>stopped});
 check(s);if(!r.ok||Math.max(Math.abs(pos(s).worldX-p.x),Math.abs(pos(s).worldZ-p.z))>tol)throw Error('carrier walk '+JSON.stringify({p,r,position:pos(s)}));
}
async function restock(s:Session){
 if(!s.bankObservation)throw Error('carrier bank observation unavailable');
 const start=s.tick(),record=(stage:string)=>{const row={account:s.name,stage,tick:s.tick(),essence:ess(s),position:{x:pos(s).worldX,z:pos(s).worldZ,level:pos(s).level}};events.push(row);console.log('CARRIER '+JSON.stringify(row));};
 check(s);if(ess(s)!==0)throw Error('carrier must deliver before restocking');
 record('exit');
 if(inside(s)){
 const portal=state(s).nearbyLocs.find(l=>l.id===body.portal);if(!portal)throw Error('body portal missing');
 const edges=[{x:portal.x,z:portal.z+1},{x:portal.x+1,z:portal.z},{x:portal.x,z:portal.z-1},{x:portal.x-1,z:portal.z}];
 const edge=edges.find(p=>{const path=s.sdk.findPath(p.x,p.z);return path.success&&path.reachedDestination===true;});
 if(!edge)throw Error('body portal edge missing');await walk(s,edge);
 const exit=await s.sdk.sendInteractLoc(portal.x,portal.z,portal.id,1);if(!exit.success)throw Error('body exit refused');
 if(!await waitUntil(s,()=>!inside(s),{timeoutTicks:15}))throw Error('body exit unobserved');
 }else if(pos(s).level!==0||Math.max(Math.abs(pos(s).worldX-body.outside.x),Math.abs(pos(s).worldZ-body.outside.z))>5)throw Error('carrier outside body entry unobserved');
 record('bank-travel');await walk(s,bank,2);
 const gen=s.bankObservation!()?.generation??0;
 if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state(s).bank.isOpen&&(s.bankObservation!()?.generation??0)>gen,{timeoutTicks:15}))throw Error('fresh bank unavailable');
 check(s);
 for(const id of new Set(s.sdk.getInventory().filter(i=>i.id!==1446||count(s,1446)!==1).map(i=>i.id))){
  check(s);const item=s.sdk.getInventory().find(i=>i.id===id)!;await depositObserved(s,item);
 }
 if(count(s,1446)===0){
  check(s);
  const stock=s.bankObservation!()!.items.filter(i=>i.id===1446).reduce((n,i)=>n+i.count,0),tal=state(s).bank.items.find(i=>i.id===1446);
  if(stock<1||!tal)throw Error('carrier body talisman unavailable');
  if(!(await s.bot.withdrawItem(tal,1)).success||!await waitUntil(s,()=>count(s,1446)===1&&(s.bankObservation!()?.items.filter(i=>i.id===1446).reduce((n,i)=>n+i.count,0)??NaN)===stock-1,{timeoutTicks:15}))throw Error('carrier talisman debit/credit mismatch');
 }
 check(s);const before=s.bankObservation!()!.items.filter(i=>i.id===1436).reduce((n,i)=>n+i.count,0);
 if(before<27||ess(s)!==0||count(s,1446)!==1)throw Error('carrier bank entry stock mismatch');
 const item=state(s).bank.items.find(i=>i.id===1436);if(!item)throw Error('essence bank slot missing');
 const reply=await s.bot.withdrawItem(item,27);if(!reply.success)throw Error('carrier withdrawal refused');
 if(!await waitUntil(s,()=>ess(s)===27&&(s.bankObservation!()?.items.filter(i=>i.id===1436).reduce((n,i)=>n+i.count,0)??NaN)===before-27,{timeoutTicks:15}))throw Error('carrier debit/credit mismatch');
 check(s);if(!(await s.bot.closeBank()).success)throw Error('carrier bank close refused');
 record('ruins-travel');await walk(s,body.outside);
 const {at,q}=ruinTarget(body),face=await interactionApproach(s.sdk,at,q);if(!face)throw Error('body ruins face missing');
 await walk(s,face);const tal=s.sdk.getInventory().find(i=>i.id===1446);if(!tal)throw Error('body talisman missing');
 const entered=await dispatchRuneEntry(s,{entered:()=>inside(s),stop:()=>stopped,dispatch:()=>s.sdk.sendUseItemOnLoc(tal.slot,at.x,at.z,q.id)});
 if(!entered.entered)throw Error('body entry unobserved '+JSON.stringify(entered));
 await walk(s,staging);record('ready');return s.tick()-start;
}

export {restock,inside};
export const stopCarriers=()=>{stopped=true;};
