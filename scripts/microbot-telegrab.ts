import type {Session} from '../packages/core/src/inprocess';
import type {GroundItem} from '../vendor/rs-sdk/sdk/types';
import {componentId} from '../packages/core/src/logout';
import {waitUntil} from '../packages/core/src/ticks';
import {elementalRuneCost} from './microbot-magic-items';
import {createCombatAlch,combatAlchCounts,combatLootReceipt,type PreparedCombatAlch} from './microbot-combat-alch';
export type TelegrabPolicy={maximum:number;cap:number;xpMultiplier?:number;stop?:()=>boolean};
export function telegrabPolicy(env:Record<string,string|undefined>=process.env):TelegrabPolicy|undefined{
 if(env.TELEGRAB_MAX===undefined)return;
 const p={maximum:Number(env.TELEGRAB_MAX),cap:Number(env.TELEGRAB_CAP??env.CAP??10000),xpMultiplier:Number(env.TELEGRAB_XP_MULTIPLIER??1)};validate(p);return p;
}
function validate(p:TelegrabPolicy){if(!Number.isSafeInteger(p.maximum)||p.maximum<1||p.maximum>1000||!Number.isSafeInteger(p.cap)||p.cap<1||p.cap>100000||!Number.isFinite(p.xpMultiplier??1)||(p.xpMultiplier??1)<=0)throw Error('finite Telegrab maximum1..1000,cap1..100000 and positive XP multiplier required');}
const counts=(items:readonly{id:number;count:number}[])=>{const out:Record<number,number>={};for(const i of items)out[i.id]=(out[i.id]??0)+i.count;return out;};
export function telegrabReceipt(item:{id:number;count:number},costs:Record<number,number>,before:Record<number,number>,after:Record<number,number>,xp:number,expectedXp:number){return xp===expectedXp&&[...new Set([...Object.keys(before),...Object.keys(after),...Object.keys(costs),String(item.id)])].every(key=>{const id=Number(key);return(after[id]??0)-(before[id]??0)===(id===item.id?item.count:0)-(costs[id]??0);});}
export function telegrabCapacity(item:{id:number;count:number},pack:readonly{id:number;count:number}[],stackable:boolean){if(!Number.isSafeInteger(item.count)||item.count<1||item.count>2147483647||pack.length>28)return false;const held=pack.filter(i=>i.id===item.id).reduce((n,i)=>n+i.count,0);return stackable?held+item.count<=2147483647&&(held>0||pack.length<28):item.count<=28-pack.length;}
// The caller keeps its existing wanted-loot/kill-credit filters. The server resolves the observed pile with player.hash64.
export function createCombatLoot(s:Session,policy?:TelegrabPolicy,alchPolicy?:PreparedCombatAlch){
 if(policy)validate(policy);const start=s.tick(),first=s.sdk.getState()?.player,life=first?.lifeId,respawns=first?.respawnCount??0,plane=first?.level;
 let casts=0,blocked=false,busy=false;const runesUsed:Record<number,number>={556:0,563:0};
 const fatal=()=>{const p=s.sdk.getState()?.player;return life===undefined||!p||p.isDead||p.lifeId!==life||(p.respawnCount??0)!==respawns||p.level!==plane||(s.sdk.getSkill('Hitpoints')?.level??0)<1;};
 const basePickup=async(item:GroundItem):Promise<{success:boolean;telegrab:boolean;skipped?:boolean}>=>{
  if(!policy||item.reachable!==false)return{success:(await s.bot.pickupItem(item)).success,telegrab:false};
  if(busy||blocked)throw Error('Telegrab prior attempted outcome unresolved');
  const state=s.sdk.getState(),p=state?.player,fresh=state?.groundItems.find(i=>i.id===item.id&&i.x===item.x&&i.z===item.z&&i.count===item.count);
  if(fatal()||policy.stop?.()||s.tick()-start>=policy.cap||casts>=policy.maximum||!fresh||fresh.reachable!==false||!Number.isSafeInteger(item.count)||item.count<1||!p||Math.max(Math.abs(p.worldX-item.x),Math.abs(p.worldZ-item.z))>10||(s.sdk.getSkill('Magic')?.level??0)<33)return{success:false,telegrab:true,skipped:true};
  const before=counts(s.sdk.getInventory()),xp=s.sdk.getSkillXp('Magic')??0,costs={556:elementalRuneCost(556,1,s.sdk.getEquipment(),(s.client as any).membersAccount===1),563:1};
  if(Object.entries(costs).some(([id,n])=>(before[Number(id)]??0)<n))return{success:false,telegrab:true,skipped:true};
  const stackable=(s.client as any).objType?.(item.id)?.stackable;
  // Native pickup_obj_check_for_space precedes rune deletion; later freed rune slots do not qualify.
  if(typeof stackable!=='boolean'||!telegrabCapacity(item,s.sdk.getInventory(),stackable))return{success:false,telegrab:true,skipped:true};
  busy=true;blocked=true;casts++;
  try{
   // One dispatch only. A transport failure can still follow a paid server cast.
   try{await s.sdk.sendSpellOnGroundItem(item.x,item.z,item.id,componentId('magic:telekinetic_grab'));}catch{}
   const paid=()=>telegrabReceipt(item,costs,before,counts(s.sdk.getInventory()),(s.sdk.getSkillXp('Magic')??0)-xp,43*(policy.xpMultiplier??1));
   await waitUntil(s,()=>fatal()||paid(),{timeoutTicks:40});
   const after=counts(s.sdk.getInventory());for(const id of[556,563])runesUsed[id]!+=paid()?costs[id as 556|563]:Math.min(costs[id as 556|563],Math.max(0,(before[id]??0)-(after[id]??0)));
   if(fatal()||!paid())throw Error('Telegrab exact rune/XP/loot receipt unconfirmed');
   blocked=false;console.log('COMBAT_TELEGRAB '+JSON.stringify({id:item.id,x:item.x,z:item.z,count:item.count,costs,xp:43*(policy.xpMultiplier??1),casts,tick:s.tick()}));return{success:true,telegrab:true};
  }finally{busy=false;}
 };
 const alch=alchPolicy?createCombatAlch(s,alchPolicy):undefined;let alchPickupBlocked=false;
 const pickup=async(item:GroundItem):Promise<{success:boolean;telegrab:boolean;skipped?:boolean;acquired?:number;alched?:number}>=>{
  if(!alch)return basePickup(item);
  if(alchPickupBlocked||alch.stopped())throw Error('owned loot alchemy stopped before pickup');alchPickupBlocked=true;
  const before=combatAlchCounts(s.sdk.getInventory()),used={...runesUsed},reply=await basePickup(item);
  const debit=Object.fromEntries(Object.entries(runesUsed).map(([id,n])=>[id,n-(used[+id]??0)])),paid=()=>combatLootReceipt(before,combatAlchCounts(s.sdk.getInventory()),item,debit);
  if(reply.skipped){alchPickupBlocked=false;return reply;}
  if(!await waitUntil(s,()=>alch.stopped()||paid(),{timeoutTicks:8})||alch.stopped()||!paid())throw Error('owned pickup whole-pack receipt unconfirmed; no alchemy');
  const alched=await alch.afterPickup(item);alchPickupBlocked=false;return{...reply,success:true,acquired:item.count,alched};
 };
 return{pickup,get casts(){return casts;},runesUsed,alch};
}
