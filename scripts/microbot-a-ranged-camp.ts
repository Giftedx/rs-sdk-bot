// Behaviour source: pinned Microbot-Hub; BSD notice: research/microbot-ports-LICENSE.txt.
// Finite bank-owned ranged trip: bun scripts/microbot-a-ranged-camp.ts <account> [cap=5000].
// STAGED=1 admits an equipped Taverley safespot consumer without bank travel.
import {runVisibleGroundLoot} from './microbot-b-mining-loot';
import {combatTrip} from './microbot-combat-trip';
import {existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import type {NearbyNpc,BotWorldState} from '../vendor/rs-sdk/sdk/types';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {walkPath,sessionWalker} from '../packages/core/src/walk';
export const BLUE_DRAGON={name:'blue-dragon',npc:55,deathAnim:92,hp:105,safe:{x:2895,z:9792},loot:[536,1751],weapon:837,ammo:877,shield:1540,rangeLevel:40} as const;
export type CampProfile={name:string;npc:number;deathAnim:number;hp:number;safe:{x:number;z:number};loot:readonly number[];weapon:number;ammo:number;shield:number;rangeLevel:number};
export function selectCampTarget(npcs:readonly NearbyNpc[],p:CampProfile,selfSlot?:number){
 return npcs.filter(n=>n.id===p.npc&&n.reachable!==false&&(!n.inCombat||Number.isInteger(selfSlot)&&n.targetIndex===32768+selfSlot!)&&((n.hp===null&&n.maxHp===null)||(n.hp===p.hp&&n.maxHp===p.hp))&&Math.max(Math.abs(n.x-p.safe.x),Math.abs(n.z-p.safe.z))<=10&&n.optionsWithIndex.some(o=>/^attack$/i.test(o.text))).sort((a,b)=>Number(b.inCombat&&b.targetIndex===32768+selfSlot!)-Number(a.inCombat&&a.targetIndex===32768+selfSlot!)||a.distance-b.distance)[0];
}
export function campCombatRefusal(messages:BotWorldState['gameMessages'],revision:number,tick:number){return messages.some(m=>m.type===0&&!m.sender&&!m.fromSelf&&(m.observationId!==undefined?m.observationId>revision:m.tick>tick)&&/^I.m already under attack[!.]?$/i.test(m.text));}
export function campOwnershipConflict(n:Pick<NearbyNpc,'hp'|'inCombat'|'targetIndex'>,selfSlot:number){return n.hp!==0&&n.inCombat&&n.targetIndex!==32768+selfSlot;}
export function campDeathCredit(o:{witness:boolean;foreign:boolean;xp:number;loot:readonly number[]},p:CampProfile){return o.witness&&!o.foreign&&o.xp>=p.hp*4&&o.loot.length===p.loot.length&&o.loot.every(n=>n===1);}
export async function runRangedCamp(s:Session,p:CampProfile,o:{cap:number;stop?:()=>boolean;returnSafe?:boolean}){
 if(!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>10000)throw Error('invalid camp cap');
 const st=()=>s.sdk.getState(),player=()=>st()?.player,inv=()=>s.sdk.getInventory(),eq=()=>s.sdk.getEquipment(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,xp=()=>s.sdk.getSkillXp('Ranged')??0;
 const count=(rows:readonly{id:number;count:number}[],id:number)=>rows.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),held=(id:number)=>count(inv(),id);
 const p0=player(),hp0=hp(),near=()=>{const q=player();return !!q&&q.level===0&&Math.max(Math.abs(q.worldX-p.safe.x),Math.abs(q.worldZ-p.safe.z))<=1;};
 const own=(s.client as {selfSlot?:number}|undefined)?.selfSlot;
 if(!p0||!near()||hp0<30||(s.sdk.getSkill('Ranged')?.level??0)<p.rangeLevel||!Number.isInteger(own)||!eq().some(i=>i.slot===3&&i.id===p.weapon)||!eq().some(i=>i.slot===5&&i.id===p.shield)||count(eq(),p.ammo)<100||inv().length>26)throw Error('stage ranged camp position, HP30, level, crossbow/shield/100 bolts and two free slots');
 if(typeof st()?.autoRetaliateEnabled!=='boolean')throw Error('auto-retaliate state unknown');
 let drops:Record<number,number>={};const ground0=new Map<string,number>();for(const i of st()!.groundItems){const key=`${i.id}:${i.x}:${i.z}`;ground0.set(key,(ground0.get(key)??0)+i.count);}
 let ended=false,foreign=false,witness=false,injured=false,failure='',targetIndex:number|undefined,death:{x:number;z:number}|undefined;void s.ended.then(()=>{ended=true;});
 const initialRetaliate=st()!.autoRetaliateEnabled,start=s.tick(),xp0=xp(),loot0=p.loot.map(held),ammo0=count(eq(),p.ammo)+held(p.ammo);
 const otherPlayers=()=>st()?.nearbyPlayers.some(n=>n.name.toLowerCase()!==p0.name.toLowerCase())??true;
 const unsafe=()=>{const q=player();return !q||q.isDead||q.lifeId!==p0.lifeId||q.level!==0||hp()<hp0;};
 const over=()=>ended||unsafe()||foreign||!!o.stop?.()||s.tick()-start>=o.cap;
 const off=s.onTick(()=>{injured||=!witness&&unsafe();foreign||=otherPlayers();if(targetIndex!==undefined){const n=st()?.nearbyNpcs.find(n=>n.index===targetIndex&&n.id===p.npc);if(n){if(campOwnershipConflict(n,own!))foreign=true;if(n.hp===0||n.animId===p.deathAnim){witness=true;death={x:n.tileX??n.x,z:n.tileZ??n.z};}}}});
 try{
  if(otherPlayers())throw Error('isolated camp required for exclusive kill credit');
  if(initialRetaliate){await s.direct({type:'clickComponent',componentId:151,reason:'finite camp target ownership'});if(!await waitUntil(s,()=>st()?.autoRetaliateEnabled===false,{timeoutTicks:8}))throw Error('auto-retaliate off unobserved');}
  if(over())throw Error('camp stopped before attack');
  // Native single combat holds a previous attacker for eight ticks after its last attack.
  for(let i=0;i<8&&!over();i++)await waitTicks(s,1);
  let acknowledged=false;
  for(let attempt=0;attempt<2&&!over();attempt++){
   const before=st()!,revision=Math.max(0,...before.gameMessages.map(m=>m.observationId??0)),tick=s.tick();
   const target=selectCampTarget(before.nearbyNpcs,p,own);if(!target)throw Error('fresh or undamaged native camp target missing');targetIndex=target.index;
   const option=target.optionsWithIndex.find(v=>/^attack$/i.test(v.text))!;
   if(!(await s.sdk.sendInteractNpc(target.index,option.opIndex)).success)throw Error('camp attack refused');
   await waitUntil(s,()=>over()||xp()>xp0||count(eq(),p.ammo)+held(p.ammo)<ammo0||campCombatRefusal(st()?.gameMessages??[],revision,tick),{timeoutTicks:12});
   if(xp()>xp0||count(eq(),p.ammo)+held(p.ammo)<ammo0){acknowledged=true;break;}
   if(!campCombatRefusal(st()?.gameMessages??[],revision,tick))throw Error('camp attack had no observed ammo or damage effect');
   for(let i=0;i<8&&!over();i++)await waitTicks(s,1);
  }
  if(!acknowledged)throw Error('camp single-combat admission did not settle');
  let lastProgress=s.tick(),lastXp=xp();
  while(!over()&&!witness){
   await waitTicks(s,1);if(xp()>lastXp){lastXp=xp();lastProgress=s.tick();}
   if(s.tick()-lastProgress>180)throw Error('camp no ranged damage for180 ticks');
   // A safespot that fails to hold is a failed profile, not permission to fight in melee.
   if(!near())throw Error('camp attack moved off safespot');
   if(count(eq(),p.ammo)+held(p.ammo)<1)throw Error('camp ammo depleted');
  }
  if(over()||!witness||!death)throw Error('camp death not observed inside budget');
  if(!await waitUntil(s,()=>p.loot.every(id=>s.sdk.getGroundItems().some(i=>i.id===id&&i.x===death!.x&&i.z===death!.z)),{timeoutTicks:12}))throw Error('camp guaranteed loot missing');
  // Recover monster rewards only; overlapping spent-bolt stacks have ambiguous client counts.
  const fresh=s.sdk.getGroundItems().filter(i=>i.x===death!.x&&i.z===death!.z&&i.id!==p.ammo);
  if(fresh.some(i=>(ground0.get(`${i.id}:${i.x}:${i.z}`)??0)>0))throw Error('camp drop attribution ambiguous');
  const ids=[...new Set(fresh.map(i=>i.id))],client=s.client as {objType:(id:number)=>{cost:number;stackable:boolean}};
  const picked=await runVisibleGroundLoot({state:()=>{const v=st();return v&&{...v,groundItems:v.groundItems.filter(i=>i.x===death!.x&&i.z===death!.z&&ids.includes(i.id))};},tick:()=>s.tick(),stop:over,definition:id=>client.objType(id),pickup:async i=>(await s.sdk.sendPickup(i.x,i.z,i.id)).success,wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1),clearModal:async()=>{await s.sdk.sendCloseModal();}},{mode:'list',ids,names:[],minimumValue:0,maximumValue:2147483647,radius:12,maximumUnits:fresh.reduce((n,i)=>n+i.count,0),cap:40,idleTicks:12});
  // Ammunition accounting already uses the final pack/equipment balance.
  drops=Object.fromEntries(Object.entries(picked.acquired).filter(([id])=>Number(id)!==p.ammo));
 }catch(e){failure=String(e);}
 finally{off();if(!ended&&player()?.lifeId===p0.lifeId&&!player()?.isDead)try{
  if(o.returnSafe!==false){const result=await walkPath(await sessionWalker(s),[{...p.safe,tol:0}],{maxTicks:60,stop:()=>ended||!!player()?.isDead});if(!result.ok||!near())throw Error('safespot return failed');}
  if(st()?.autoRetaliateEnabled!==initialRetaliate){await s.direct({type:'clickComponent',componentId:initialRetaliate?150:151,reason:'restore camp auto-retaliate'});if(!await waitUntil(s,()=>st()?.autoRetaliateEnabled===initialRetaliate,{timeoutTicks:8}))throw Error('retaliate restore missing');}
 }catch(e){failure+='; cleanup '+String(e);}}
 const loot=p.loot.map((id,n)=>held(id)-loot0[n]!),gain=xp()-xp0;
 const credited=campDeathCredit({witness,foreign,xp:gain,loot},p);
 return{ok:!failure&&!ended&&!injured&&!o.stop?.()&&(o.returnSafe===false||near())&&player()?.lifeId===p0.lifeId&&!player()?.isDead&&hp()>0&&credited,profile:p.name,failure,witness,foreign,injured,loot,drops,credited,rangedXp:gain,ammoUsed:ammo0-count(eq(),p.ammo)-held(p.ammo),ticks:s.tick()-start};
}
if(import.meta.main){let s:Session|undefined,stopped=false;try{const [account,cap]=process.argv.slice(2);if(!account)throw Error('account required');s=await openBot(account,{onStop:async()=>{stopped=true;}});const stop=()=>stopped||existsSync('.practice/stop-microbot-camp')||existsSync('.practice/stop-all');const r=process.env.STAGED==='1'?await runRangedCamp(s,BLUE_DRAGON,{cap:Number(cap??3000),stop}):await combatTrip(s,'blue',tripStop=>runRangedCamp(s!,BLUE_DRAGON,{cap:2500,stop:tripStop,returnSafe:false}),{cap:Number(cap??5000),stop});console.log('RANGED_CAMP_RESULT '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));}catch(e){await finish(s?[s]:[],false,String(e));}}
