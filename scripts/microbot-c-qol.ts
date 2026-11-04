import {readFileSync,existsSync} from 'node:fs';
import {equipmentObserved} from '../packages/core/src/container-observation';
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

export type QolDropOrder={ids:number[];names:string[];mode:'listed'|'except';order:'slot'|'reverse'|'column';maximumDrops:number;cap:number};
export function qolDropSelection(rows:readonly {id:number;name:string;slot:number;count:number}[],o:QolDropOrder){
 if(!o||!Array.isArray(o.ids)||!Array.isArray(o.names)||!['listed','except'].includes(o.mode)||!['slot','reverse','column'].includes(o.order)||!Number.isSafeInteger(o.maximumDrops)||o.maximumDrops<1||o.maximumDrops>28||!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>1000||o.ids.some(id=>!Number.isSafeInteger(id)||id<0)||o.names.some(n=>typeof n!=='string'||!n.trim())||o.ids.length+o.names.length<1)throw Error('explicit finite native drop selection required');
 if(new Set(rows.map(i=>i.slot)).size!==rows.length||rows.some(i=>!Number.isSafeInteger(i.slot)||i.slot<0||i.slot>27||!Number.isSafeInteger(i.count)||i.count<1))throw Error('drop inventory unknown');
 const names=o.names.map(n=>n.trim().toLowerCase()),selected=rows.filter(i=>{const listed=o.ids.includes(i.id)||names.includes(i.name.toLowerCase());return o.mode==='listed'?listed:!listed;});
 return selected.sort((a,b)=>o.order==='reverse'?b.slot-a.slot:o.order==='column'?(a.slot%4-b.slot%4)||Math.floor(a.slot/4)-Math.floor(b.slot/4):a.slot-b.slot).slice(0,o.maximumDrops);
}
function qolOwnedState(s:Session,stop:()=>boolean){
 const client=s.client as any,executor=client?.executeBotAction,first=s.sdk.getState(),p=first?.player,hp=s.sdk.getSkill('Hitpoints')?.level,life=p?.lifeId,respawns=p?.respawnCount??0;
 if(!client||typeof executor!=='function'||!p||!Number.isSafeInteger(life)||!Number.isSafeInteger(hp)||hp!<1||!equipmentObserved(client))throw Error('QoL owned state/gear/life unknown');
 const gear=JSON.stringify(first!.equipment),xp=JSON.stringify(first!.skills.map(i=>i.experience)),x=p.worldX,z=p.worldZ,plane=p.level;let ended=false;void s.ended.then(()=>{ended=true;});
 const unsafe=()=>{const st=s.sdk.getState(),me=st?.player;return ended||s.client!==client||client.executeBotAction!==executor||stop()||existsSync('.practice/stop-all')||existsSync(`.practice/stop-${s.name}`)||!!process.env.STOP_FILE&&existsSync(process.env.STOP_FILE)||!me||me.isDead||me.lifeId!==life||(me.respawnCount??0)!==respawns||s.sdk.getSkill('Hitpoints')?.level!==hp||me.worldX!==x||me.worldZ!==z||me.level!==plane||!equipmentObserved(client)||s.sdk.getStateAge()>5000||JSON.stringify(st!.equipment)!==gear||JSON.stringify(st!.skills.map(i=>i.experience))!==xp;};
 return{client,unsafe};
}
const qolPack=(s:Session)=>{const a:Record<number,number>={};for(const i of s.sdk.getInventory())a[i.id]=(a[i.id]??0)+i.count;return a;};
const qolPackEffect=(a:Record<number,number>,b:Record<number,number>,delta:Record<number,number>)=>[...new Set([...Object.keys(a),...Object.keys(b),...Object.keys(delta)])].every(k=>(b[Number(k)]??0)-(a[Number(k)]??0)===(delta[Number(k)]??0));
// Donor excludes(!listed) then dropAllExcept negates it, so its exclude flag also
// drops listed names. The explicit 'except' policy deliberately fixes that UI
// ambiguity; deterministic slot orders do not claim donor random-order parity.
export async function dropQolItems(s:Session,o:QolDropOrder,stop:()=>boolean=()=>false){
 const selected=qolDropSelection(s.sdk.getInventory(),o),guard=qolOwnedState(s,stop),began=s.tick(),initial=qolPack(s),dropped:Record<number,number>={};let slots=0,units=0,uncertain=false,failure='';
 const clear=()=>{const st=s.sdk.getState();return !!st&&!st.bank.isOpen&&!st.interface.isOpen&&!st.dialog.isOpen;};
 try{if(guard.unsafe())throw Error('QoL drop stopped/owner/life/assets');if(s.sdk.getInventory().length!==28)return{ok:true,slots,units,dropped,uncertain:false,skipped:'pack not full',ticks:0,failure:''};if(!clear())throw Error('QoL drop needs ordinary inventory');
  for(const original of selected){if(guard.unsafe()||s.tick()-began>=o.cap||!clear())throw Error('QoL drop stopped/owner/cap/interface');const row=s.sdk.getInventory().find(i=>i.slot===original.slot&&i.id===original.id&&i.count===original.count),custom=row?.optionsWithIndex.filter(v=>v.opIndex===5)??[];if(!row||custom.length>1||custom.some(v=>!/^drop$/i.test(v.text)))throw Error('fresh native Drop slot required');
   const before=qolPack(s);uncertain=true;try{if(guard.unsafe())throw Error('QoL drop ownership changed');await s.direct({type:'dropItem',slot:row.slot,reason:'declared finite full-pack QoL drop'});}catch{}
   const paid=()=>qolPackEffect(before,qolPack(s),{[row.id]:-row.count});if(!await waitUntil(s,()=>guard.unsafe()||paid(),{timeoutTicks:Math.min(8,Math.max(1,o.cap-(s.tick()-began)))})||guard.unsafe()||!paid())throw Error('native QoL drop exact effect unconfirmed');uncertain=false;slots++;units+=row.count;dropped[row.id]=(dropped[row.id]??0)+row.count;
  }
  const delta=Object.fromEntries(Object.entries(dropped).map(([id,n])=>[Number(id),-n]));if(!qolPackEffect(initial,qolPack(s),delta))throw Error('QoL final drop assets changed');
 }catch(error){failure=String(error);}return{ok:!failure&&!uncertain,slots,units,dropped,uncertain,failure,ticks:s.tick()-began};
}
export async function enableQolRun(s:Session,threshold:number,cap:number,stop:()=>boolean=()=>false){
 if(!Number.isSafeInteger(threshold)||threshold<0||threshold>100||!Number.isSafeInteger(cap)||cap<1||cap>100)throw Error('finite run threshold0..100/cap1..100 required');const guard=qolOwnedState(s,stop),c=guard.client,initial=s.sdk.getState(),energy=initial?.player?.runEnergy,before=c.var?.[173],stock=qolPack(s),began=s.tick();let uncertain=false,failure='';
 if(!Number.isSafeInteger(energy)||energy!<0||energy!>100||![0,1].includes(before))throw Error('native public run state/energy unknown');
 try{if(guard.unsafe())throw Error('QoL run stopped/owner/life/assets');if(before===1||energy!<=threshold)return{ok:true,changed:false,enabled:before===1,energyBefore:energy,energyAfter:energy,skipped:before===1?'already enabled':'energy threshold',ticks:0,uncertain:false,failure:''};if(initial!.player!.combat.targetType!=='none'||c.localPlayer?.routeLength!==0||initial!.bank.isOpen||initial!.interface.isOpen||initial!.dialog.isOpen)throw Error('QoL run requires idle ordinary controls');
  uncertain=true;try{if(guard.unsafe())throw Error('QoL run ownership changed');await s.direct({type:'clickComponent',componentId:153,reason:'explicit finite native run threshold'});}catch{}
  if(!await waitUntil(s,()=>guard.unsafe()||s.tick()>began&&c.var[173]===1,{timeoutTicks:cap})||guard.unsafe()||c.var[173]!==1||!qolPackEffect(stock,qolPack(s),{}))throw Error('native run enable unconfirmed');uncertain=false;
 }catch(error){failure=String(error);}return{ok:!failure&&!uncertain,changed:!failure,enabled:c.var?.[173]===1,energyBefore:energy,energyAfter:s.sdk.getState()?.player?.runEnergy,ticks:s.tick()-began,uncertain,failure};
}
if(import.meta.main){
 const name=process.argv[2]??'',mode=process.argv[3]??'',arg=process.argv[4]??'',value=Number(process.argv[5]??30),cap=Number(process.argv[6]??40);
 if(!name||!['prayer','special','cannon','drop','run'].includes(mode)||!Number.isSafeInteger(value)||!Number.isSafeInteger(cap)||cap<1)throw Error('Usage: bun scripts/microbot-c-qol.ts <account> <prayer|special|cannon|drop|run> <prayer-index|bar-name|x> <hold-ticks|energy|z> [cap]');
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(name);let ok=false;
 try{const r=mode==='drop'?await dropQolItems(s,JSON.parse(readFileSync(arg,'utf8')),()=>stopped):mode==='run'?await enableQolRun(s,Number(arg),cap,()=>stopped):mode==='prayer'?await holdPrayer(s,Number(arg),value,()=>stopped):mode==='special'?await enableSpecial(s,arg,value,cap,()=>stopped):await refillCannon(s,Number(arg),value,cap,()=>stopped);console.log('QOL_RESULT '+JSON.stringify(r));ok=r.ok;}finally{ok=await settle([s],ok,'finite native QOL order');}process.exitCode=ok?0:1;
}
