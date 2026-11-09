// One bank-owned native KBD trip. STAGED=1 runs the lair consumer alone.
import {campOwnershipConflict} from './microbot-a-ranged-camp';
import {runVisibleGroundLoot} from './microbot-b-mining-loot';
import {combatTrip} from './microbot-combat-trip';
import {existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import {componentId} from '../packages/core/src/logout';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {eatBetweenCasts} from './magic-order';
import type {Session} from '../packages/core/src/inprocess';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';

export const KBD_DROP_IDS=[536,1747] as const;
const count=(s:BotWorldState,id:number)=>s.inventory.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const hp=(s:BotWorldState)=>s.skills.find(k=>k.name==='Hitpoints')?.level??0;
const combatXp=(s:BotWorldState)=>s.skills.filter(k=>['Attack','Strength','Defence','Ranged','Magic'].includes(k.name)).reduce((n,k)=>n+k.experience,0);
export function inKbdLair(s:BotWorldState){const p=s.player;return !!p&&p.level===0&&p.worldX>=2688&&p.worldX<2752&&p.worldZ>=9792&&p.worldZ<9856;}
export function selectKbdTarget(s:BotWorldState,selfSlot?:number){return s.nearbyNpcs.find(n=>n.id===50&&n.reachable!==false&&
 ((n.hp===null&&n.maxHp===null)||n.hp===240&&n.maxHp===240)&&(!n.inCombat||Number.isInteger(selfSlot)&&n.targetIndex===32768+selfSlot!));}
export function kbdEntryFailure(s:BotWorldState|null,selfSlot?:number){
 if(!s?.player||!inKbdLair(s))return 'stage inside native KBD lair';
 if(hp(s)<70)return 'KBD needs at least 70 current HP';
 if(!s.equipment.some(i=>i.id===1540&&i.slot===5))return 'KBD needs worn anti-dragon shield';
 if(!s.equipment.some(i=>i.slot===3&&i.id===1289))return 'KBD needs native rune sword';
 if(!s.equipment.some(i=>i.slot===4&&i.id===1113)||!s.equipment.some(i=>i.slot===7&&i.id===1079))return 'KBD needs native rune chainbody and platelegs';
 if((s.skills.find(k=>k.name==='Attack')?.level??0)<40||(s.skills.find(k=>k.name==='Defence')?.level??0)<40)return 'KBD needs native Attack40 and Defence40';
 if((s.skills.find(k=>k.name==='Magic')?.level??0)<25)return 'KBD needs Magic25 emergency teleport';
 if((s.prayers?.prayerLevel??0)<43||(s.prayers?.prayerPoints??0)<30)return 'KBD needs Prayer43 and 30 points';
 if(count(s,385)<6)return 'KBD needs six staged sharks';
 if(!count(s,2448)||!count(s,2452))return 'KBD needs super antipoison(4) and antifire(4)';
 if(!count(s,2436)||!count(s,2440)||count(s,2434)<2)return 'KBD needs native super attack, super strength and two prayer potions';
 if(count(s,563)<1||count(s,556)<3||count(s,554)<1)return 'KBD needs reserved Varrock runes';
 if(s.inventory.length>26)return 'KBD needs two free drop slots';
 if(s.nearbyPlayers.length)return 'KBD needs an uncontested lair';
 const target=selectKbdTarget(s,selfSlot);
 if(!target)return 'KBD needs free native dragon50 without known damage';
 return null;
}
export function kbdKillCredit(gone:boolean,xpGain:number,drops:readonly number[]){return gone&&xpGain>=240*4&&drops.length===2&&drops.every(n=>n===1);}
export function kbdRetreatReason(s:BotWorldState,used:number,cap:number){
 if(!inKbdLair(s))return 'left lair';
 if(hp(s)<35)return 'low HP';
 if((s.prayers?.prayerPoints??0)<10)return 'low prayer';
 if(!s.equipment.some(i=>i.id===1540&&i.slot===5))return 'shield missing';
 if(s.nearbyPlayers.length)return 'another player entered';
 if(used>=cap)return 'combat cap';
 if(hp(s)<=50&&count(s,385)===0)return 'food exhausted';
 return null;
}
export async function runKbdOne(s:Session,o:{cap:number;stop:()=>boolean;wait?:(test:()=>boolean,ticks:number)=>Promise<boolean>;step?:()=>Promise<void>}){
 if(!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>1000)throw Error('KBD CAP must be 1..1000 ticks');
 const own=(s.client as {selfSlot?:number}|undefined)?.selfSlot;
 const initial=s.sdk.getState(),preflight=kbdEntryFailure(initial,own);if(preflight)throw Error(preflight);
 const start=s.tick(),life=initial!.player!.lifeId,heldStart=new Map(initial!.inventory.map(i=>[i.id,count(initial!,i.id)]));
 let ended=false;void s.ended.then(()=>{ended=true;});let attacked=false,credited=false,looted=0,foods=0,failure='',escaped=false,protectionTick=s.tick(),actionReadyAt=s.tick();let acquired:Record<number,number>={};const potions:Record<number,number>={};
 const wait=o.wait??((test:()=>boolean,ticks:number)=>waitUntil(s,test,{timeoutTicks:ticks})),step=o.step??(()=>waitTicks(s,1));
 const st=()=>{const current=s.sdk.getState();if(ended||!current?.player)throw Error('KBD session ended');if(current.player.lifeId!==life||current.player.isDead||hp(current)<1)throw Error('KBD life changed');return current;};
 const pendingStop=()=>ended||o.stop()||!!kbdRetreatReason(st(),s.tick()-start,o.cap);
 const eat=async()=>{
  const food=await eatBetweenCasts(s,{food:[385],eatAt:50,timeoutTicks:5,attempts:2});
  if(food){foods++;actionReadyAt=s.tick()+3;while(s.tick()<actionReadyAt){await step();st();}}
 };
 const usePotion=async(id:number,next:number)=>{
  if(pendingStop())throw Error('KBD stopped before potion');if(hp(st())<=50)await eat();const before=st(),old=count(before,id),oldNext=count(before,next),item=before.inventory.find(i=>i.id===id),op=item?.optionsWithIndex.find(v=>/^drink$/i.test(v.text));
  if(!item||!op)throw Error(`KBD potion ${id} unavailable`);
  const reply=await s.direct({type:'useInventoryItem',slot:item.slot,optionIndex:op.opIndex,reason:'SDK'}) as {success?:boolean}|undefined;
  if(reply?.success!==true)throw Error('KBD potion refused');
  if(!await wait(()=>{if(hp(st())<35)throw Error('KBD low HP during potion');return count(st(),id)===old-1&&count(st(),next)===oldNext+1;},8))throw Error('KBD potion transform unobserved');
  potions[id]=(potions[id]??0)-1;potions[next]=(potions[next]??0)+1;
  // Native potion text/delay continues after its inventory transform publishes.
  actionReadyAt=s.tick()+3;while(s.tick()<actionReadyAt){await step();if(hp(st())<35)throw Error('KBD low HP settling potion');}
 };
 const escape=async()=>{
  if(ended)return;
  const before=st();if(!inKbdLair(before)){escaped=before.player!.level===0&&Math.max(Math.abs(before.player!.worldX-3213),Math.abs(before.player!.worldZ-3424))<=5;return;}
  while(s.tick()<actionReadyAt){await step();st();}
  // Emergency return is allowed to finish a bounded cleanup even after CAP or a stop file.
  for(let n=0;n<2;n++){
   await s.sdk.sendCloseModal();
   const r=await s.direct({type:'clickComponent',componentId:componentId('magic:varrock_teleport'),reason:'SDK'}) as {success?:boolean}|undefined;
   if(r?.success===true&&await wait(()=>{const p=s.sdk.getState()?.player;return !!p&&p.level===0&&Math.max(Math.abs(p.worldX-3213),Math.abs(p.worldZ-3424))<=5;},12)){escaped=true;break;}
  }
  if(!escaped)throw Error('KBD emergency teleport unobserved');
  const after=st();if(count(before,563)-count(after,563)!==1)throw Error('KBD teleport law debit invalid');
 };
 try{
  if(o.stop())throw Error('KBD stopped before combat');
  await s.sdk.sendCloseModal();
  if(!(await s.sdk.sendSetCombatStyle(0)).success||!await wait(()=>{const c=st().combatStyle;return !!c?.known&&c.currentStyle===0&&c.weaponName==='Rune sword'&&c.styles.some(v=>v.index===0&&v.damageType==='Stab'&&v.trainsSkills.includes('Attack'));},8))throw Error('KBD accurate native Stab style unknown');
  if(!st().prayers.activePrayers[14]){
   if(!(await s.sdk.sendTogglePrayer(14)).success||!await wait(()=>!!st().prayers.activePrayers[14],5))throw Error('KBD melee protection unobserved');
  }
  await usePotion(2448,181);
  if(hp(st())<=50)await eat();
  await usePotion(2452,2454);
  protectionTick=s.tick();await usePotion(2436,145);await usePotion(2440,157);
  if(pendingStop())throw Error('KBD stop before attack');
  const before=st(),xpBefore=combatXp(before),target=selectKbdTarget(before,own);
  if(!target)throw Error('KBD target changed');
  const ground=(state:BotWorldState,id:number,x:number,z:number)=>state.groundItems.filter(i=>i.id===id&&i.x===x&&i.z===z).reduce((n,i)=>n+i.count,0);
  const beforeGround=new Map<string,number>();for(const item of before.groundItems)beforeGround.set(`${item.id}:${item.x}:${item.z}`,(beforeGround.get(`${item.id}:${item.x}:${item.z}`)??0)+item.count);
  const attackOp=target.optionsWithIndex.find(v=>/^attack$/i.test(v.text));if(!attackOp)throw Error('KBD attack option missing');
  if(!(await s.sdk.sendInteractNpc(target.index,attackOp.opIndex)).success)throw Error('KBD attack refused');attacked=true;
  let x=target.tileX??target.x,z=target.tileZ??target.z,progress=s.tick(),lastXp=xpBefore,gone=false,lastAttack=s.tick();
  while(true){
   let current=st();const reason=kbdRetreatReason(current,s.tick()-start,o.cap);if(o.stop()||reason)throw Error(reason??'KBD stopped');
   if(!current.prayers.activePrayers[14])throw Error('KBD protection dropped');
   if(hp(current)<=50){await eat();current=st();}
   if(current.prayers.prayerPoints<=30){const stages=[2434,139,141,143,229],id=stages.slice(0,-1).find(id=>count(current,id)>0);if(id===undefined)throw Error('KBD prayer refill exhausted');const before=current.prayers.prayerPoints;await usePotion(id,stages[stages.indexOf(id)+1]!);if(st().prayers.prayerPoints<=before)throw Error('KBD prayer refill effect missing');current=st();}
   // Native antifire lasts600 ticks; refresh both protections before that window closes.
   if(s.tick()-protectionTick>=450){for(const stages of [[2448,181,183,185,229],[2452,2454,2456,2458,229]]){const id=stages.slice(0,-1).find(id=>count(st(),id)>0);if(id===undefined)throw Error('KBD protection refill exhausted');await usePotion(id,stages[stages.indexOf(id)+1]!);}protectionTick=s.tick();current=st();}
   const npc=current.nearbyNpcs.find(n=>n.index===target.index&&n.id===50);
   if(npc&&Number.isInteger(own)&&campOwnershipConflict(npc,own!))throw Error('KBD target ownership changed');
   if(npc){x=npc.tileX??npc.x;z=npc.tileZ??npc.z;}else gone=true;
   const gain=combatXp(current)-xpBefore,drops=KBD_DROP_IDS.map(id=>ground(current,id,x,z)-(beforeGround.get(`${id}:${x}:${z}`)??0));
   if(kbdKillCredit(gone,gain,drops)){credited=true;break;}
   if(combatXp(current)>lastXp){lastXp=combatXp(current);progress=s.tick();}
   // Native zero-damage hits are real paid swings, not a stopped attack loop.
   for(const event of current.combatEvents??[])if(event.type==='damage_dealt'&&event.sourceType==='player'&&event.targetType==='npc'&&event.targetIndex===target.index&&event.tick>=start&&event.tick<=s.tick())progress=Math.max(progress,event.tick);
   // Food and the native frozen-walk trigger can clear the paid attack action.
   // Reissue only this still-owned living dragon, with bounded packet spacing.
   if(npc&&npc.hp!==0&&s.tick()-lastAttack>=12&&
      (current.player!.combat?.targetIndex!==target.index||s.tick()-progress>=24)){
    if(!(await s.sdk.sendInteractNpc(target.index,attackOp.opIndex)).success)throw Error('KBD resume attack refused');
    lastAttack=s.tick();
   }
   if(s.tick()-progress>=80)throw Error('KBD no observed attack or credited drop progress');
   await step();
  }
  const fresh=st().groundItems.filter(i=>i.x===x&&i.z===z);
  if(fresh.some(i=>(beforeGround.get(`${i.id}:${x}:${z}`)??0)>0))throw Error('KBD drop pile attribution ambiguous');
  const ids=[...new Set(fresh.map(i=>i.id))],units=fresh.reduce((n,i)=>n+i.count,0);
  const client=s.client as {objType?:(id:number)=>{cost:number;stackable:boolean}}|undefined;
  const loot=await runVisibleGroundLoot({state:()=>{const v=st();return{...v,groundItems:v.groundItems.filter(i=>i.x===x&&i.z===z&&ids.includes(i.id))};},tick:()=>s.tick(),stop:pendingStop,definition:id=>client?.objType?.(id),pickup:async i=>(await s.sdk.sendPickup(i.x,i.z,i.id)).success,wait,step,clearModal:async()=>{await s.sdk.sendCloseModal();}},{mode:'list',ids,names:[],minimumValue:0,maximumValue:2147483647,radius:12,maximumUnits:units,cap:40,idleTicks:12});
  acquired=loot.acquired;looted=KBD_DROP_IDS.filter(id=>loot.acquired[id]===1).length;
 }catch(e){failure=String(e);}
 finally{try{await escape();}catch(e){failure=[failure,String(e)].filter(Boolean).join('; ');}}
 if(escaped&&st().prayers.activePrayers[14]){await s.sdk.sendTogglePrayer(14);if(!await wait(()=>!st().prayers.activePrayers[14],5))failure+='; protection cleanup unobserved';}
 const final=st(),drops=acquired;
 if(!credited||looted!==2||!escaped||KBD_DROP_IDS.some(id=>(drops[id]??0)!==1||count(final,id)-(heldStart.get(id)??0)!==1))failure ||= 'KBD kill, loot and escape target incomplete';
 return{ok:!failure,attacked,credited,looted,escaped,foods,potions,drops,ticks:s.tick()-start,failure};
}
if(import.meta.main){
 const name=process.argv[2],cap=Number(process.env.CAP??1000);if(!name)throw Error('account required');
 let stopped=false;const s=await openBot(name,{onStop:async()=>{stopped=true;}}).catch(e=>finish([],false,`login: ${String(e)}`));
 try{const stop=()=>stopped||existsSync(`.practice/stop-${name}`)||existsSync('.practice/stop-all');const result=process.env.STAGED==='1'?await runKbdOne(s,{cap,stop}):await combatTrip(s,'kbd',tripStop=>runKbdOne(s,{cap,stop:tripStop}),{cap:Number(process.env.TRIP_CAP??5000),stop});await finish([s],result.ok,JSON.stringify(result));}catch(e){await finish([s],false,String(e));}
}
