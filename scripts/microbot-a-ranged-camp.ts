// Behaviour source: pinned Microbot-Hub; BSD notice: research/microbot-ports-LICENSE.txt.
// Finite native ranged camp: bun scripts/microbot-a-ranged-camp.ts <account> [cap=3000].
// Stage at Taverley safespot with crossbow837, bolts877, anti-dragon shield1540 and Ranged40.
import {existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import type {NearbyNpc} from '../vendor/rs-sdk/sdk/types';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {walkPath,sessionWalker} from '../packages/core/src/walk';
export const BLUE_DRAGON={name:'blue-dragon',npc:55,deathAnim:92,hp:105,safe:{x:2918,z:9781},loot:[536,1751],weapon:837,ammo:877,shield:1540,rangeLevel:40} as const;
export type CampProfile={name:string;npc:number;deathAnim:number;hp:number;safe:{x:number;z:number};loot:readonly number[];weapon:number;ammo:number;shield:number;rangeLevel:number};
export function selectCampTarget(npcs:readonly NearbyNpc[],p:CampProfile){
 return npcs.filter(n=>n.id===p.npc&&n.reachable!==false&&!n.inCombat&&n.hp===p.hp&&n.maxHp===p.hp&&Math.max(Math.abs(n.x-p.safe.x),Math.abs(n.z-p.safe.z))<=10&&n.optionsWithIndex.some(o=>/^attack$/i.test(o.text))).sort((a,b)=>a.distance-b.distance)[0];
}
export function campDeathCredit(o:{witness:boolean;foreign:boolean;xp:number;loot:readonly number[]},p:CampProfile){return o.witness&&!o.foreign&&o.xp>0&&o.loot.length===p.loot.length&&o.loot.every(n=>n===1);}
export async function runRangedCamp(s:Session,p:CampProfile,o:{cap:number;stop?:()=>boolean}){
 if(!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>10000)throw Error('invalid camp cap');
 const st=()=>s.sdk.getState(),player=()=>st()?.player,inv=()=>s.sdk.getInventory(),eq=()=>s.sdk.getEquipment(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,xp=()=>s.sdk.getSkillXp('Ranged')??0;
 const count=(rows:readonly{id:number;count:number}[],id:number)=>rows.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),held=(id:number)=>count(inv(),id);
 const p0=player(),hp0=hp(),near=()=>{const q=player();return !!q&&q.level===0&&Math.max(Math.abs(q.worldX-p.safe.x),Math.abs(q.worldZ-p.safe.z))<=1;};
 const own=(s.client as {selfSlot?:number}|undefined)?.selfSlot;
 if(!p0||!near()||hp0<30||(s.sdk.getSkill('Ranged')?.level??0)<p.rangeLevel||!Number.isInteger(own)||!eq().some(i=>i.slot===3&&i.id===p.weapon)||!eq().some(i=>i.slot===5&&i.id===p.shield)||count(eq(),p.ammo)<100||inv().length>26)throw Error('stage ranged camp position, HP30, level, crossbow/shield/100 bolts and two free slots');
 if(typeof st()?.autoRetaliateEnabled!=='boolean')throw Error('auto-retaliate state unknown');
 let ended=false,foreign=false,witness=false,injured=false,failure='',targetIndex:number|undefined,death:{x:number;z:number}|undefined;void s.ended.then(()=>{ended=true;});
 const initialRetaliate=st()!.autoRetaliateEnabled,start=s.tick(),xp0=xp(),loot0=p.loot.map(held),ammo0=count(eq(),p.ammo)+held(p.ammo);
 const otherPlayers=()=>st()?.nearbyPlayers.some(n=>n.name.toLowerCase()!==p0.name.toLowerCase())??true;
 const unsafe=()=>{const q=player();return !q||q.isDead||q.lifeId!==p0.lifeId||q.level!==0||hp()<hp0;};
 const over=()=>ended||unsafe()||foreign||!!o.stop?.()||s.tick()-start>=o.cap;
 const off=s.onTick(()=>{injured||=unsafe();foreign||=otherPlayers();if(targetIndex!==undefined){const n=st()?.nearbyNpcs.find(n=>n.index===targetIndex&&n.id===p.npc);if(n){if(n.inCombat&&n.targetIndex!==32768+own!)foreign=true;if(n.hp===0||n.animId===p.deathAnim){witness=true;death={x:n.tileX??n.x,z:n.tileZ??n.z};}}}});
 try{
  if(otherPlayers())throw Error('isolated camp required for exclusive kill credit');
  if(initialRetaliate){await s.direct({type:'clickComponent',componentId:151,reason:'finite camp target ownership'});if(!await waitUntil(s,()=>st()?.autoRetaliateEnabled===false,{timeoutTicks:8}))throw Error('auto-retaliate off unobserved');}
  if(over())throw Error('camp stopped before attack');
  const target=selectCampTarget(st()?.nearbyNpcs??[],p);if(!target)throw Error('fresh full-health native camp target missing');targetIndex=target.index;
  const option=target.optionsWithIndex.find(v=>/^attack$/i.test(v.text))!;
  if(!(await s.sdk.sendInteractNpc(target.index,option.opIndex)).success)throw Error('camp attack refused');
  let lastProgress=s.tick(),lastXp=xp();
  while(!over()&&!witness){
   await waitTicks(s,1);if(xp()>lastXp){lastXp=xp();lastProgress=s.tick();}
   if(s.tick()-lastProgress>180)throw Error('camp no ranged damage for180 ticks');
   // A safespot that fails to hold is a failed profile, not permission to fight in melee.
   if(!near())throw Error('camp attack moved off safespot');
   if(count(eq(),p.ammo)+held(p.ammo)<1)throw Error('camp ammo depleted');
  }
  if(over()||!witness||!death)throw Error('camp death not observed inside budget');
  for(const [n,id] of p.loot.entries()){
   if(!await waitUntil(s,()=>s.sdk.getGroundItems().some(i=>i.id===id&&i.x===death!.x&&i.z===death!.z),{timeoutTicks:12}))throw Error('camp loot missing '+id);
   const item=s.sdk.getGroundItems().find(i=>i.id===id&&i.x===death!.x&&i.z===death!.z)!;
   if(!(await s.sdk.sendPickup(item.x,item.z,id)).success||!await waitUntil(s,()=>held(id)===loot0[n]!+1,{timeoutTicks:30}))throw Error('camp loot pickup missing '+id);
  }
 }catch(e){failure=String(e);}
 finally{off();if(!ended&&player()?.lifeId===p0.lifeId&&!player()?.isDead)try{
  const result=await walkPath(await sessionWalker(s),[{...p.safe,tol:0}],{maxTicks:60,stop:()=>ended||!!player()?.isDead});if(!result.ok||!near())throw Error('safespot return failed');
  if(st()?.autoRetaliateEnabled!==initialRetaliate){await s.direct({type:'clickComponent',componentId:initialRetaliate?150:151,reason:'restore camp auto-retaliate'});if(!await waitUntil(s,()=>st()?.autoRetaliateEnabled===initialRetaliate,{timeoutTicks:8}))throw Error('retaliate restore missing');}
 }catch(e){failure+='; cleanup '+String(e);}}
 const loot=p.loot.map((id,n)=>held(id)-loot0[n]!),gain=xp()-xp0;
 const credited=campDeathCredit({witness,foreign,xp:gain,loot},p);
 return{ok:!failure&&!ended&&!injured&&!o.stop?.()&&near()&&credited,profile:p.name,failure,witness,foreign,injured,loot,credited,rangedXp:gain,ammoUsed:ammo0-count(eq(),p.ammo)-held(p.ammo),ticks:s.tick()-start};
}
if(import.meta.main){let s:Session|undefined,stopped=false;try{const [account,cap]=process.argv.slice(2);if(!account)throw Error('account required');s=await openBot(account,{onStop:async()=>{stopped=true;}});const r=await runRangedCamp(s,BLUE_DRAGON,{cap:Number(cap??3000),stop:()=>stopped||existsSync('.practice/stop-microbot-camp')});console.log('RANGED_CAMP_RESULT '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));}catch(e){await finish(s?[s]:[],false,String(e));}}
