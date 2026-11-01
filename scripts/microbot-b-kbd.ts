// One staged native KBD kill, guaranteed-drop collection, then Varrock teleport.
// Caller owns staging, gear acquisition, banking and practice qualification.
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
export function kbdEntryFailure(s:BotWorldState|null){
 if(!s?.player||!inKbdLair(s))return 'stage inside native KBD lair';
 if(hp(s)<70)return 'KBD needs at least 70 current HP';
 if(!s.equipment.some(i=>i.id===1540&&i.slot===5))return 'KBD needs worn anti-dragon shield';
 if(!s.equipment.some(i=>i.slot===3))return 'KBD needs equipped weapon';
 if((s.skills.find(k=>k.name==='Magic')?.level??0)<25)return 'KBD needs Magic25 emergency teleport';
 if((s.prayers?.prayerLevel??0)<43||(s.prayers?.prayerPoints??0)<30)return 'KBD needs Prayer43 and 30 points';
 if(count(s,385)<6)return 'KBD needs six staged sharks';
 if(!count(s,2448)||!count(s,2452))return 'KBD needs super antipoison(4) and antifire(4)';
 if(count(s,563)<1||count(s,556)<3||count(s,554)<1)return 'KBD needs reserved Varrock runes';
 if(s.inventory.length>26)return 'KBD needs two free drop slots';
 if(s.nearbyPlayers.length)return 'KBD needs an uncontested lair';
 const target=s.nearbyNpcs.find(n=>n.id===50&&n.reachable!==false&&(n.hp===null||n.maxHp===null||n.hp===n.maxHp)&&!n.inCombat);
 if(!target)return 'KBD needs free native dragon50 without known damage';
 return null;
}
export function kbdKillCredit(gone:boolean,xpGain:number,drops:readonly number[]){return gone&&xpGain>0&&drops.length===2&&drops.every(n=>n===1);}
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
 if(!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>300)throw Error('KBD CAP must be 1..300 ticks');
 const initial=s.sdk.getState(),preflight=kbdEntryFailure(initial);if(preflight)throw Error(preflight);
 const start=s.tick(),life=initial!.player!.lifeId,heldStart=new Map(KBD_DROP_IDS.map(id=>[id,count(initial!,id)]));
 let ended=false;void s.ended.then(()=>{ended=true;});let attacked=false,credited=false,looted=0,foods=0,failure='',escaped=false;
 const wait=o.wait??((test:()=>boolean,ticks:number)=>waitUntil(s,test,{timeoutTicks:ticks})),step=o.step??(()=>waitTicks(s,1));
 const st=()=>{const current=s.sdk.getState();if(ended||!current?.player)throw Error('KBD session ended');if(current.player.lifeId!==life||current.player.isDead||hp(current)<1)throw Error('KBD life changed');return current;};
 const pendingStop=()=>ended||o.stop()||!!kbdRetreatReason(st(),s.tick()-start,o.cap);
 const usePotion=async(id:number,next:number)=>{
  const before=st(),item=before.inventory.find(i=>i.id===id),op=item?.optionsWithIndex.find(v=>/^drink$/i.test(v.text));
  if(!item||!op)throw Error(`KBD potion ${id} unavailable`);
  const reply=await s.direct({type:'useInventoryItem',slot:item.slot,optionIndex:op.opIndex,reason:'SDK'}) as {success?:boolean}|undefined;
  if(reply?.success!==true)throw Error('KBD potion refused');
  if(!await wait(()=>{if(hp(st())<35)throw Error('KBD low HP during potion');return count(st(),id)===count(before,id)-1&&count(st(),next)===count(before,next)+1;},8))throw Error('KBD potion transform unobserved');
 };
 const escape=async()=>{
  if(ended)return;
  const before=st();if(!inKbdLair(before)){escaped=before.player!.level===0&&Math.max(Math.abs(before.player!.worldX-3213),Math.abs(before.player!.worldZ-3424))<=5;return;}
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
  if(!st().prayers.activePrayers[14]){
   if(!(await s.sdk.sendTogglePrayer(14)).success||!await wait(()=>!!st().prayers.activePrayers[14],5))throw Error('KBD melee protection unobserved');
  }
  await usePotion(2448,181);
  if(hp(st())<=50){const food=await eatBetweenCasts(s,{food:[385],eatAt:50,timeoutTicks:5,attempts:2});if(food)foods++;}
  await usePotion(2452,2454);
  if(pendingStop())throw Error('KBD stop before attack');
  const before=st(),target=before.nearbyNpcs.find(n=>n.id===50&&!n.inCombat&&(n.hp===null||n.maxHp===null||n.hp===n.maxHp));
  if(!target)throw Error('KBD target changed');
  const ground=(state:BotWorldState,id:number,x:number,z:number)=>state.groundItems.filter(i=>i.id===id&&i.x===x&&i.z===z).reduce((n,i)=>n+i.count,0);
  const beforeGround=new Map<string,number>();for(const item of before.groundItems)if(KBD_DROP_IDS.includes(item.id as 536|1747))beforeGround.set(`${item.id}:${item.x}:${item.z}`,(beforeGround.get(`${item.id}:${item.x}:${item.z}`)??0)+item.count);
  const attackOp=target.optionsWithIndex.find(v=>/^attack$/i.test(v.text));if(!attackOp)throw Error('KBD attack option missing');
  if(!(await s.sdk.sendInteractNpc(target.index,attackOp.opIndex)).success)throw Error('KBD attack refused');attacked=true;
  let x=target.tileX??target.x,z=target.tileZ??target.z,progress=s.tick(),lastXp=combatXp(before),gone=false;
  while(true){
   let current=st();const reason=kbdRetreatReason(current,s.tick()-start,o.cap);if(o.stop()||reason)throw Error(reason??'KBD stopped');
   if(!current.prayers.activePrayers[14])throw Error('KBD protection dropped');
   if(hp(current)<=50){const food=await eatBetweenCasts(s,{food:[385],eatAt:50,timeoutTicks:5,attempts:2});if(food)foods++;current=st();}
   const npc=current.nearbyNpcs.find(n=>n.index===target.index&&n.id===50);
   if(npc){x=npc.tileX??npc.x;z=npc.tileZ??npc.z;}else gone=true;
   const gain=combatXp(current)-combatXp(before),drops=KBD_DROP_IDS.map(id=>ground(current,id,x,z)-(beforeGround.get(`${id}:${x}:${z}`)??0));
   if(kbdKillCredit(gone,gain,drops)){credited=true;break;}
   if(combatXp(current)>lastXp){lastXp=combatXp(current);progress=s.tick();}
   if(s.tick()-progress>=80)throw Error('KBD no damage or credited drop progress');
   await step();
  }
  for(const id of KBD_DROP_IDS){
   if(pendingStop())throw Error('KBD stop before loot');
   const item=st().groundItems.find(i=>i.id===id&&i.x===x&&i.z===z&&i.reachable!==false),before=count(st(),id);
   if(!item||!(await s.bot.pickupItem(item)).success||!await wait(()=>count(st(),id)===before+1,10))throw Error('KBD guaranteed drop pickup unobserved');looted++;
  }
 }catch(e){failure=String(e);}
 finally{try{await escape();}catch(e){failure=[failure,String(e)].filter(Boolean).join('; ');}}
 if(escaped&&st().prayers.activePrayers[14]){await s.sdk.sendTogglePrayer(14);if(!await wait(()=>!st().prayers.activePrayers[14],5))failure+='; protection cleanup unobserved';}
 const final=st(),drops=Object.fromEntries(KBD_DROP_IDS.map(id=>[id,count(final,id)-(heldStart.get(id)??0)]));
 if(!credited||looted!==2||!escaped||Object.values(drops).some(n=>n!==1))failure ||= 'KBD kill, loot and escape target incomplete';
 return{ok:!failure,attacked,credited,looted,escaped,foods,drops,ticks:s.tick()-start,failure};
}
if(import.meta.main){
 const name=process.argv[2],cap=Number(process.env.CAP??300);if(!name)throw Error('account required');
 const s=await openBot(name).catch(e=>finish([],false,`login: ${String(e)}`));
 try{const result=await runKbdOne(s,{cap,stop:()=>existsSync(`.practice/stop-${name}`)||existsSync('.practice/stop-all')});await finish([s],result.ok,JSON.stringify(result));}catch(e){await finish([s],false,String(e));}
}
