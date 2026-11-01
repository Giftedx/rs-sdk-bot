import {existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {depositObserved} from '../packages/core/src/deposit';
import {questFlags} from '../packages/core/src/quest-status';
import {runBankProfile,validateBankRouteJob,type BankProfile,type BankRouteJob} from './microbot-bank-jobs';
import {CHOMPY,bellowsCharges,runChompy} from './microbot-a-chompy';
import {runVisibleGroundLoot} from './microbot-b-mining-loot';
export const CHOMPY_TRIP={bank:{x:2614,z:3093,level:0},site:{x:2594,z:2966,level:0},raw:2876,arrowsPerKill:32,bellows:[2871,2872,2873,2874]} as const;
export type ChompyTripJob={kills:number;perTrip:number;cap:number;returnTicks:number};
export function chompyRouteJob(o:ChompyTripJob):BankRouteJob{
 if(!Number.isSafeInteger(o.kills)||o.kills<1||o.kills>20||!Number.isSafeInteger(o.perTrip)||o.perTrip<1||o.perTrip>5)throw Error('Chompy trip kills1..20 and batch1..5 required');
 const job={family:'chompy',recipe:'post-quest-swamp',target:o.kills,batch:o.perTrip,cap:o.cap,returnTicks:o.returnTicks,members:true};validateBankRouteJob(job);return job;
}
export function chompyTripAssets(before:ReadonlyMap<number,number>,after:ReadonlyMap<number,number>,r:{kills:number;baits:number;raw:number;feathers:number;rangedXp:number}){
 const delta=(id:number)=>(after.get(id)??0)-(before.get(id)??0),rows=(a:ReadonlyMap<number,number>)=>[...a].map(([id,count])=>({id,count}));
 const bellows=(a:ReadonlyMap<number,number>)=>CHOMPY_TRIP.bellows.reduce((n,id)=>n+(a.get(id)??0),0),fills=(bellowsCharges(rows(after))+r.baits-bellowsCharges(rows(before)))/3;
 const ammoUsed=(before.get(CHOMPY.arrow)??0)-(after.get(CHOMPY.arrow)??0),allowed=new Set<number>([...CHOMPY_TRIP.bellows,CHOMPY.arrow,CHOMPY_TRIP.raw,CHOMPY.feather]);
 if(bellows(before)!==1||bellows(after)!==1||!Number.isSafeInteger(fills)||fills<0||delta(CHOMPY.bait)!==0||r.baits<r.kills||r.baits>15||r.raw!==r.kills||delta(CHOMPY_TRIP.raw)!==r.kills||delta(CHOMPY.feather)!==r.feathers||r.feathers<10*r.kills||r.feathers>29*r.kills||r.rangedXp<40*r.kills||ammoUsed<0||ammoUsed>CHOMPY_TRIP.arrowsPerKill*r.kills||[...new Set([...before.keys(),...after.keys()])].some(id=>!allowed.has(id)&&delta(id)!==0))throw Error('Chompy trip assets or native output do not reconcile');
 return{ammoUsed,baits:r.baits,fills,raw:r.raw,feathers:r.feathers,rangedXp:r.rangedXp};
}
export async function restoreChompyStyle(s:Session,style:number,alive:()=>boolean){
 const value=()=>s.sdk.getState()?.combatStyle,matched=()=>value()?.known===true&&value()?.weaponName==='Unarmed'&&value()?.currentStyle===style;
 if(!alive()||value()?.known!==true||value()?.weaponName!=='Unarmed'||!Number.isSafeInteger(style)||style<0||style>2||!value()?.styles.some(v=>v.index===style))return false;
 if(matched())return true;if(!(await s.sdk.sendSetCombatStyle(style)).success)return false;
 await waitUntil(s,()=>!alive()||matched(),{timeoutTicks:8});return alive()&&matched();
}
export async function runChompyTrip(s:Session,o:ChompyTripJob,requestStop:()=>boolean=()=>false){
 const job=chompyRouteJob(o),state=()=>s.sdk.getState(),first=state()?.player,hp0=s.sdk.getSkill('Hitpoints')?.level??0,start=s.tick();
 if(!first||hp0<30||(s.sdk.getSkill('Ranged')?.level??0)<30||!questFlags(s.client)?.some(q=>/chompy/i.test(q.name)&&q.state==='complete')||first.level!==0||Math.max(Math.abs(first.worldX-CHOMPY_TRIP.bank.x),Math.abs(first.worldZ-CHOMPY_TRIP.bank.z))>3)throw Error('stage HP30, Ranged30 and observed completed Chompy quest at owned Yanille bank');
 if(s.sdk.getInventory().some(i=>[CHOMPY.bow,CHOMPY.arrow,CHOMPY.bait,...CHOMPY_TRIP.bellows].includes(i.id as any)))throw Error('stage the ogre kit in owned bank stock');
 const retaliate=state()?.autoRetaliateEnabled;if(typeof retaliate!=='boolean')throw Error('Chompy initial auto-retaliate unknown');
 const style=state()?.combatStyle;if(!style?.known||style.weaponName!=='Unarmed'||!Number.isSafeInteger(style.currentStyle)||style.currentStyle<0||style.currentStyle>2||!style.styles.some(v=>v.index===style.currentStyle))throw Error('Chompy initial native unarmed style unknown');const initialStyle=style.currentStyle;
 const initialGear=s.sdk.getEquipment().map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot);if(initialGear.some(i=>[3,5,13].includes(i.slot)))throw Error('stage free weapon, shield and ammo slots for bank-owned ogre kit');
 const firstLife=first.lifeId,firstRespawns=first.respawnCount??0;let ended=false;void s.ended.then(()=>{ended=true;});const life=()=>{const player=state()?.player;return !ended&&!!player&&player.lifeId===firstLife&&(player.respawnCount??0)<=firstRespawns&&!player.isDead&&(s.sdk.getSkill('Hitpoints')?.level??0)>0;};
 const stop=()=>!life()||requestStop()||existsSync('.practice/stop-microbot-chompy')||existsSync('.practice/stop-all')||existsSync(`.practice/stop-${s.name}`)||s.tick()-start>=o.cap;
 const peers=()=>state()?.nearbyPlayers.some(p=>p.name.toLowerCase()!==first.name.toLowerCase())??true,receipts:ReturnType<typeof chompyTripAssets>[]=[];
 const assets=()=>{const a=new Map<number,number>();for(const i of [...s.sdk.getInventory(),...s.sdk.getEquipment()])a.set(i.id,(a.get(i.id)??0)+i.count);return a;},count=(id:number)=>assets().get(id)??0;
 const open=async()=>{if(!life()||s.tick()-start>=o.cap)throw Error('Chompy kit bank cleanup bound');if(state()?.bank.isOpen&&s.bankObservation?.())return;await s.sdk.sendCloseModal();const generation=s.bankObservation?.()?.generation??-1;if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!life()||!!state()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:12})||!life())throw Error('Chompy kit fresh bank unavailable');};
 let result:Awaited<ReturnType<typeof runBankProfile>>|undefined,cleanup='',kitStaged=false;
 try{
  if(stop())throw Error('Chompy stopped before kit staging');await open();
  const bellows=[CHOMPY.full,CHOMPY.two,CHOMPY.one,CHOMPY.empty].find(id=>(s.bankObservation?.()?.items??[]).some(i=>i.id===id&&i.count>=1));if(bellows===undefined)throw Error('owned bank bellows missing');
  for(const [id,n]of [[CHOMPY.bow,1],[CHOMPY.arrow,CHOMPY_TRIP.arrowsPerKill*o.kills]]){
   if(stop())throw Error('Chompy stopped before kit withdrawal');const item=state()!.bank.items.find(i=>i.id===id),before=count(id!),stored=(s.bankObservation?.()?.items??[]).find(i=>i.id===id)?.count??0,generation=s.bankObservation!()!.generation;if(!item||stored<n!)throw Error('owned bank ogre kit stock short');
   await s.bot.withdrawItem(item,n!,{asNote:false});kitStaged=true;if(!await waitUntil(s,()=>!life()||count(id!)===before+n!&&(s.bankObservation?.()?.items.find(i=>i.id===id)?.count??0)===stored-n!&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:10})||!life())throw Error('owned ogre kit withdrawal does not reconcile');
  }
  await s.bot.closeBank();if(!await waitUntil(s,()=>!state()?.bank.isOpen,{timeoutTicks:8}))throw Error('Chompy kit bank remains open');
  if(retaliate){await s.direct({type:'clickComponent',componentId:151,reason:'Chompy route disables automatic foreign attacks'});if(!await waitUntil(s,()=>state()?.autoRetaliateEnabled===false,{timeoutTicks:8}))throw Error('Chompy auto-retaliate off unobserved');}
  for(const [id,slot]of [[CHOMPY.bow,3],[CHOMPY.arrow,13]]){if(stop())throw Error('Chompy stopped before kit wield');const item=s.sdk.getInventory().find(i=>i.id===id);if(!item)throw Error('bank-owned ogre kit missing '+id);await s.bot.equipItem(item);if(!await waitUntil(s,()=>!life()||s.sdk.getEquipment().some(i=>i.id===id&&i.slot===slot),{timeoutTicks:8})||!life())throw Error('native ogre kit wield unobserved');}
  if(!(await s.sdk.sendSetCombatStyle(0)).success||!await waitUntil(s,()=>state()?.combatStyle?.known===true&&state()?.combatStyle?.currentStyle===0&&state()?.combatStyle?.weaponName==='Ogre bow',{timeoutTicks:8}))throw Error('native accurate ogre bow style unobserved');
  const profile:BankProfile={bank:CHOMPY_TRIP.bank,site:CHOMPY_TRIP.site,inputs:{},tools:[bellows],outputs:[CHOMPY_TRIP.raw,CHOMPY.feather,...CHOMPY_TRIP.bellows],capacityOutputs:{[CHOMPY_TRIP.raw]:1,[CHOMPY.feather]:29,[CHOMPY.arrow]:CHOMPY_TRIP.arrowsPerKill},run:async(n,cap,halt)=>{
   if(cap<=45||peers()||state()?.groundItems.some(i=>i.id===CHOMPY.arrow))throw Error('Chompy hunt needs isolated site, empty arrow baseline and cleanup budget');
   const before=assets(),positions=new Set<string>(),off=s.onTick(()=>{for(const bird of state()?.nearbyNpcs??[])if(bird.id===CHOMPY.live)positions.add(`${bird.x},${bird.z}`);});
   try{
    const hunt=await runChompy(s,{kills:n,cap:Math.min(20000,cap-45),maxBaits:Math.min(15,n*5),stop:()=>halt()||peers()});if(!hunt.ok)throw Error('staged Chompy hunt '+hunt.failure+' '+hunt.stop);
    await waitTicks(s,3);const spent=(before.get(CHOMPY.arrow)??0)-count(CHOMPY.arrow);if(spent<1||spent>CHOMPY_TRIP.arrowsPerKill*n)throw Error('native ogre arrow debit absent');
    if(peers())throw Error('Chompy arrow attribution changed');const arrows=state()!.groundItems.filter(i=>i.id===CHOMPY.arrow);if(arrows.some(i=>!positions.has(`${i.x},${i.z}`))||arrows.reduce((a,i)=>a+i.count,0)>spent)throw Error('Chompy ground arrow attribution ambiguous');
    const units=arrows.reduce((a,i)=>a+i.count,0);
    if(units){const client=s.client as {objType:(id:number)=>{cost:number;stackable:boolean}};const recovered=await runVisibleGroundLoot({state:()=>{const st=state();return st&&{...st,groundItems:st.groundItems.filter(i=>i.id===CHOMPY.arrow&&positions.has(`${i.x},${i.z}`))};},tick:()=>s.tick(),stop:()=>!life()||peers()||halt(),definition:id=>client.objType(id),pickup:async i=>(await s.sdk.sendPickup(i.x,i.z,i.id)).success,wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1),clearModal:async()=>{await s.sdk.sendCloseModal();}},{mode:'list',ids:[CHOMPY.arrow],names:[],minimumValue:0,maximumValue:2147483647,radius:12,maximumUnits:units,cap:35,idleTicks:5});if(recovered.units!==units)throw Error('Chompy visible arrows remain');}
    const receipt=chompyTripAssets(before,assets(),hunt);receipts.push(receipt);console.log('CHOMPY_TRIP_KILL '+JSON.stringify(receipt));return hunt.raw;
   }finally{off();const rows=s.sdk.getInventory().filter(i=>CHOMPY_TRIP.bellows.includes(i.id as any));if(rows.length===1&&rows[0]!.count===1)profile.tools[0]=rows[0]!.id;}
  }};
  result=await runBankProfile(s,{...job,cap:o.cap-(s.tick()-start)-100},profile,stop);
 }catch(error){cleanup=String(error);}
 finally{
  if(kitStaged&&life())try{
   const at=state()?.player;if(!at||at.level!==0||Math.max(Math.abs(at.worldX-CHOMPY_TRIP.bank.x),Math.abs(at.worldZ-CHOMPY_TRIP.bank.z))>3)throw Error('Chompy kit return bank unobserved');
   await s.bot.closeBank();if(!await waitUntil(s,()=>!state()?.bank.isOpen,{timeoutTicks:8}))throw Error('Chompy kit bank remains open');for(const slot of [13,3]){const item=s.sdk.getEquipment().find(i=>i.slot===slot);if(item){const total=count(item.id),held=s.sdk.getInventory().filter(i=>i.id===item.id).reduce((a,i)=>a+i.count,0);await s.bot.unequipItem(item);if(!await waitUntil(s,()=>!life()||!s.sdk.getEquipment().some(i=>i.slot===slot)&&s.sdk.getInventory().filter(i=>i.id===item.id).reduce((a,i)=>a+i.count,0)===held+item.count,{timeoutTicks:8})||!life()||count(item.id)!==total)throw Error('Chompy return kit unequip does not reconcile');}}
   await open();for(const id of [CHOMPY.arrow,CHOMPY.bow]){const item=s.sdk.getInventory().find(i=>i.id===id);if(item)await depositObserved(s,item);}await s.bot.closeBank();
   if(!await restoreChompyStyle(s,initialStyle,life))throw Error('Chompy initial unarmed style restore unobserved');
   if(retaliate&&state()?.autoRetaliateEnabled!==true){await s.direct({type:'clickComponent',componentId:150,reason:'restore Chompy route auto-retaliate at bank'});if(!await waitUntil(s,()=>state()?.autoRetaliateEnabled===true,{timeoutTicks:8}))throw Error('Chompy auto-retaliate restore unobserved');}
  }catch(error){cleanup+='; kit recovery '+String(error);}
 }
 const retaliateRestored=state()?.autoRetaliateEnabled===retaliate,styleRestored=state()?.combatStyle?.known===true&&state()?.combatStyle?.weaponName==='Unarmed'&&state()?.combatStyle?.currentStyle===initialStyle;
 const banked={raw:result?.banked[CHOMPY_TRIP.raw]??0,feathers:result?.banked[CHOMPY.feather]??0},gearPreserved=JSON.stringify(initialGear)===JSON.stringify(s.sdk.getEquipment().map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot));
 return{...result,ok:!!result?.ok&&!cleanup&&gearPreserved&&styleRestored&&retaliateRestored&&banked.raw===o.kills&&banked.feathers===receipts.reduce((n,r)=>n+r.feathers,0),banked,receipts,ammoUsed:receipts.reduce((n,r)=>n+r.ammoUsed,0),gearPreserved,styleRestored,retaliateRestored,cleanup:cleanup||'-',ticks:s.tick()-start};
}
if(import.meta.main){const account=process.argv[2];if(!account)throw Error('usage: microbot-chompy-trip.ts account [kills=2] [per-trip=1] [cap=5000]');let stopped=false;const s=await openBot(account,{onStop:async()=>{stopped=true;}});try{const result=await runChompyTrip(s,{kills:Number(process.argv[3]??2),perTrip:Number(process.argv[4]??1),cap:Number(process.argv[5]??5000),returnTicks:800},()=>stopped);console.log('CHOMPY_TRIP '+JSON.stringify(result));await finish([s],result.ok,JSON.stringify(result));}catch(error){await finish([s],false,String(error));}}
