import {getWorld,accountOf} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {goTo,walkPath,sessionWalker} from '../packages/core/src/walk';
import {depositObserved} from '../packages/core/src/deposit';
import {interactionApproach} from '../packages/core/src/world';
import {leaveRuneStarter,runeSupplyAssets} from './rune-supply';
import {enterAirAltar,craftAirRunes,exitAirAltar} from './generated/rcair';
import {RUNE_ALTARS,ruinTarget,dispatchRuneEntry} from './rune-bank-craft';
import {ownedSwap} from './rune-carrier-trade';
import {state,ess} from './rune-carrier-trade';

export async function freshBodyStart(s:Session,h:Session,stop:()=>boolean,prepareCarriers:()=>Promise<void>){
 const body=RUNE_ALTARS.find(a=>a.name==='body')!,events:unknown[]=[];
 let donorFlight:Promise<void>|undefined,carrierFlight:Promise<void>|undefined,failure:unknown;
 const record=(actor:Session,stage:string)=>{const p=state(actor).player!;const row={account:actor.name,stage,tick:actor.tick(),position:{x:p.worldX,z:p.worldZ,level:p.level},inventory:runeSupplyAssets(actor.sdk.getInventory())};events.push(row);console.log('FRESH_PREFIX '+JSON.stringify(row));};
 const travel=async(actor:Session,x:number,z:number)=>{if(stop())throw Error('fresh start stopped');const r=await goTo(actor,await getWorld(),{x,z,level:0},accountOf(actor),{legTimeoutTicks:180});if(!r.ok)throw Error('fresh travel '+JSON.stringify({to:{x,z},r}));};
 const withdraw=async(id:number,n:number)=>{
  const before=h.bankObservation()!.items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),item=state(h).bank.items.find(i=>i.id===id);
  if(!item||before<n)throw Error('fresh donor bank shortage '+id);const r=await h.bot.withdrawItem(item,n);if(!r.success)throw Error('fresh donor withdrawal refused');
  if(!await waitUntil(h,()=>h.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0)===n&&(h.bankObservation()?.items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0)??NaN)===before-n,{timeoutTicks:15}))throw Error('fresh donor debit/credit mismatch');
 };
 try{
  record(s,'first-login');if(s.sdk.getSkillXp('Runecraft')!==0)throw Error('fresh account has Runecraft XP');
  await leaveRuneStarter(s,stop);record(s,'tutorial-complete');
  const kit=runeSupplyAssets(s.sdk.getInventory());await ownedSwap(s,h,kit,{1436:27,1438:1},stop);record(s,'air-pack-received');
  donorFlight=(async()=>{
   await travel(h,3092,3244);const generation=h.bankObservation()?.generation??0;
   if(!(await h.bot.openBank()).success||!await waitUntil(h,()=>!!state(h).bank.isOpen&&(h.bankObservation()?.generation??0)>generation,{timeoutTicks:15}))throw Error('fresh donor bank unobserved');
   for(const id of new Set(h.sdk.getInventory().map(i=>i.id))){const item=h.sdk.getInventory().find(i=>i.id===id)!;await depositObserved(h,item);}
   await withdraw(1446,1);await withdraw(1436,27);if(!(await h.bot.closeBank()).success)throw Error('fresh donor bank close refused');
   await travel(h,body.outside.x,body.outside.z);record(h,'body-donor-ready');
  })().catch(e=>{failure=e;});
  await travel(s,2986,3294);record(s,'air-ruins');await enterAirAltar(s);const air=await craftAirRunes(s,stop);record(s,'air-crafted');
  carrierFlight=prepareCarriers().catch(e=>{failure=e;});
  await exitAirAltar(s,stop);await travel(s,body.outside.x,body.outside.z);record(s,'body-ruins');await donorFlight;if(failure)throw failure;
  await ownedSwap(s,h,{1438:1,556:27},{1436:27,1446:1},stop);record(s,'body-pack-received');
  const {at,q}=ruinTarget(body),face=await interactionApproach(s.sdk,at,q);if(!face)throw Error('body entry face unobserved');
  const approach=await walkPath(await sessionWalker(s),[{...face,tol:0}],{maxTicks:30,stop});if(!approach.ok)throw Error('body approach failed');
  const tal=s.sdk.getInventory().find(i=>i.id===1446)!;
  const inside=()=>{const p=state(s).player!;return Math.floor(p.worldX/64)===39&&Math.floor(p.worldZ/64)===75;};
  const entry=await dispatchRuneEntry(s,{entered:inside,stop,dispatch:()=>s.sdk.sendUseItemOnLoc(tal.slot,at.x,at.z,q.id)});if(!entry.entered)throw Error('body entry unobserved');
  const walk=await walkPath(await sessionWalker(s),[{x:2523,z:4832,tol:0}],{maxTicks:30,stop});if(!walk.ok)throw Error('body altar walk failed');
  const altar=state(s).nearbyLocs.find(l=>l.id===2483);if(!altar)throw Error('body altar unobserved');
  await s.direct({type:'interactLoc',x:altar.x,z:altar.z,locId:altar.id,optionIndex:1,reason:'SDK'});
  if(!await waitUntil(s,()=>ess(s)===0&&(s.sdk.getSkillXp('Runecraft')??0)>=8437,{timeoutTicks:15}))throw Error('first body craft effects missing');record(s,'first-body-crafted');
  await carrierFlight;if(failure)throw failure;
  return {air,masterTicks:s.tick(),helperTicks:h.tick(),events,starterKit:kit,xp:s.sdk.getSkillXp('Runecraft')};
 }finally{await Promise.allSettled([donorFlight,carrierFlight]);}
}
