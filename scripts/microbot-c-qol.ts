import {openBot,settle} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {componentId} from '../packages/core/src/logout';
import {waitUntil} from '../packages/core/src/ticks';
import {watchProductionLife} from './microbot-c-lifetime';
// Finite prayer activation preserves the caller's original prayer state.
// This is not attack-cycle flicking or a claim of combat output.
export async function holdPrayer(s:Session,index:number,ticks:number,stop:()=>boolean=()=>false){
 if(!Number.isSafeInteger(index)||index<0||index>14||!Number.isSafeInteger(ticks)||ticks<1)throw Error('invalid prayer hold');
 const life=watchProductionLife(s,stop),start=s.tick(),initial=s.sdk.isPrayerActive(index);let activated=false,restored=initial,detail='';
 try{
  if(life.stopped())throw Error(life.reason());
  if(!initial){const result=await s.bot.activatePrayer(index);if(!result.success)throw Error(result.message);activated=true;}
  if(!s.sdk.isPrayerActive(index))throw Error('prayer activation unobserved');
  await waitUntil(s,()=>life.stopped()||!s.sdk.isPrayerActive(index)||s.tick()-start>=ticks,{timeoutTicks:ticks});
  detail=life.reason()||(!s.sdk.isPrayerActive(index)?'prayer hold ended early':'');
 }catch(error){detail=String(error);}
 finally{if(activated){try{const r=await s.bot.deactivatePrayer(index);restored=r.success&&!s.sdk.isPrayerActive(index);}catch(error){detail ||= String(error);}}}
 return{ok:!detail&&restored,activated,restored,ticks:s.tick()-start,detail};
}
// Explicit native special bar, staged weapon, no weapon swapping or attacking.
export async function enableSpecial(s:Session,bar:string,minimumEnergy:number,cap:number,stop:()=>boolean=()=>false){
 if(!/^combat_(blunt|axe|crossbow|bow|stabsword|hacksword|spiked|thrown|spear|claw|pickaxe|polearm|heavysword|unarmed):specbar$/.test(bar)||!Number.isSafeInteger(minimumEnergy)||minimumEnergy<1||minimumEnergy>1000||!Number.isSafeInteger(cap)||cap<1)throw Error('invalid special order');
 const life=watchProductionLife(s,stop),start=s.tick(),c=s.client as any;
 if(!Number.isSafeInteger(c?.var?.[300])||!Number.isSafeInteger(c?.var?.[301]))throw Error('native transmitted special vars unavailable');
 if(!s.sdk.getEquipment().some(i=>i.slot===3))throw Error('stage a special weapon');
 const before={energy:c.var[300] as number,enabled:c.var[301] as number};
 if(before.energy<minimumEnergy)throw Error('special energy below explicit threshold');
 if(life.stopped())return{ok:false,changed:false,energy:before.energy,ticks:0,detail:life.reason()};
 if(before.enabled===1)return{ok:true,changed:false,energy:before.energy,ticks:0,detail:'special already enabled'};
 await s.sdk.sendClickComponent(componentId(bar));
 await waitUntil(s,()=>c.var[301]===1||c.var[300]<before.energy||life.stopped(),{timeoutTicks:cap});
 const ok=!life.stopped()&&(c.var[301]===1||c.var[300]<before.energy);
 return{ok,changed:ok,energy:c.var[300],ticks:s.tick()-start,detail:life.reason()|| (ok?'native special state/energy effect':'special effect unconfirmed')};
}
// Refill one owned, fully assembled native cannon. Server owns the ownership
// check and 30-ball capacity; exact fresh load message must match item debit.
export async function refillCannon(s:Session,x:number,z:number,cap:number,stop:()=>boolean=()=>false){
 if(![x,z,cap].every(Number.isSafeInteger)||x<0||z<0||cap<1)throw Error('invalid cannon refill');
 const life=watchProductionLife(s,stop),start=s.tick(),count=()=>s.sdk.getInventory().filter(i=>i.id===2).reduce((n,i)=>n+i.count,0);
 const loc=s.sdk.getState()?.nearbyLocs.find(l=>l.id===6&&l.x===x&&l.z===z),item=s.sdk.getInventory().find(i=>i.id===2);
 if(!loc||!item)throw Error('stage cannonballs beside selected assembled cannon');
 if(life.stopped())return{ok:false,loaded:0,ticks:0,detail:life.reason()};
 const before=count(),cursor=Math.max(-1,...(s.sdk.getState()?.gameMessages??[]).map(m=>m.observationId??m.tick));
 const messageCount=()=>{const m=(s.sdk.getState()?.gameMessages??[]).find(m=>m.type===0&&(m.observationId??m.tick)>cursor&&/You load the cannon with (\d+) cannonballs\./.test(m.text));return m?Number(m.text.match(/with (\d+) cannonballs/)![1]):0;};
 await s.sdk.sendUseItemOnLoc(item.slot,x,z,6);
 await waitUntil(s,()=>before>count()&&messageCount()===before-count()||life.stopped(),{timeoutTicks:cap});
 const loaded=before-count(),ok=!life.stopped()&&loaded>0&&loaded<=30&&messageCount()===loaded;
 return{ok,loaded,ticks:s.tick()-start,detail:life.reason()||(ok?'owned native cannon loaded':'cannon ownership/capacity/load effect unconfirmed')};
}
if(import.meta.main){
 const name=process.argv[2]??'',mode=process.argv[3]??'',arg=process.argv[4]??'',value=Number(process.argv[5]??30),cap=Number(process.argv[6]??40);
 if(!name||!['prayer','special','cannon'].includes(mode)||!Number.isSafeInteger(value)||!Number.isSafeInteger(cap)||cap<1)throw Error('Usage: bun scripts/microbot-c-qol.ts <account> <prayer|special|cannon> <prayer-index|bar-name|x> <hold-ticks|energy|z> [cap]');
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(name);let ok=false;
 try{const r=mode==='prayer'?await holdPrayer(s,Number(arg),value,()=>stopped):mode==='special'?await enableSpecial(s,arg,value,cap,()=>stopped):await refillCannon(s,Number(arg),value,cap,()=>stopped);console.log('QOL_RESULT '+JSON.stringify(r));ok=r.ok;}finally{ok=await settle([s],ok,'finite native QOL order');}process.exitCode=ok?0:1;
}
