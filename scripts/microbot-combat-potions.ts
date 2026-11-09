// AIOFighter PotionManagerScript: serialized finite upkeep beside AttackNpc.
// BSD attribution: research/microbot-ports-LICENSE.txt. Native dose policy lives in potion-care.
import{readFileSync}from'node:fs';
import{BotActions}from'../vendor/rs-sdk/sdk/actions';
import{waitUntil}from'../packages/core/src/ticks';
import type{Session}from'../packages/core/src/inprocess';
import{productionStopRequested}from'./microbot-c-lifetime';
import{createPotionCareSession,potionCareRecipe,validatePotionCare,type PotionCareOrder}from'./microbot-potion-care';
export type CombatPotionPolicy={actor:string;server:string;hpFloor:number;order:PotionCareOrder};
export function prepareCombatPotions(p:CombatPotionPolicy){
 if(!p||!p.actor||!p.server||!Number.isSafeInteger(p.hpFloor)||p.hpFloor<10||p.hpFloor>99||p.order?.monitor)throw Error('finite actor/server/HP combat potion policy required');validatePotionCare(p.order);
 return Object.freeze({...p,order:Object.freeze({...p.order,monitor:false,policies:p.order.policies.map(r=>Object.freeze({...r}))})});
}
export function combatPotionPolicy(env:Record<string,string|undefined>=process.env){if(!env.COMBAT_POTIONS_FILE)return;const bytes=readFileSync(env.COMBAT_POTIONS_FILE);if(bytes.length>16384)throw Error('combat potion policy too large');return prepareCombatPotions(JSON.parse(bytes.toString('utf8')));}
// Native prayer.rs2 accumulates rate*5 each five ticks; all pinned native
// equipment has nonnegative prayerbonus, so resistance is at least60. Unknown
// timer/counter phase contributes at most one partial drain interval.
const prayerScript=readFileSync('vendor/rs-sdk/server/content/scripts/skill_prayer/scripts/prayer.rs2','utf8'),prayerEnum=readFileSync('vendor/rs-sdk/server/content/scripts/skill_prayer/configs/prayers.enum','utf8').split('[prayer_headicons]')[0]!;
const prayerRates=Array.from({length:15},(_,index)=>{const name=[...prayerScript.matchAll(/case \^(\w+) :\s*if \(%prayer(\d+) =/g)].find(m=>Number(m[2])===index)?.[1],rate=Number(prayerEnum.match(new RegExp('val=\\^'+name+',([0-9]+)'))?.[1]);if(!Number.isSafeInteger(rate)||rate<1)throw Error('native prayer drain mapping absent');return rate;});
export function combatPrayerLoss(active:readonly boolean[],elapsed:number){if(active.length!==15||!Number.isSafeInteger(elapsed)||elapsed<0)throw Error('native prayer observation absent');const rate=active.reduce((sum,on,i)=>sum+(on?prayerRates[i]!:0),0);return Math.ceil(rate*5*Math.ceil((elapsed+1)/5)/60);}
const canonical=(rows:readonly{id:number;count:number;slot:number}[])=>JSON.stringify(rows.map(r=>({id:r.id,count:r.count,slot:r.slot})).sort((a,b)=>a.slot-b.slot));
// Use the existing BotActions implementation with an owner-bound SDK receiver;
// its nested sends after modal/reconnection waits cross the same guard.
export function combatPotionSession(s:Session,stop:()=>boolean,cap:number){
 if(!Number.isSafeInteger(cap)||cap<1)throw Error('finite combat cleanup cap required');let cleanup=false;const deadline=s.tick()+cap;
 const client=s.client as any,owner=client.executeBotAction,first=s.sdk.getState()?.player,life=first?.lifeId,respawns=first?.respawnCount??0;let ended=false;void s.ended.then(()=>{ended=true;});
 const check=()=>{const p=s.sdk.getState()?.player;if(ended||s.client!==client||client.executeBotAction!==owner||!Number.isSafeInteger(life)||!p||p.isDead||p.lifeId!==life||(p.respawnCount??0)!==respawns||(s.sdk.getSkill('Hitpoints')?.level??0)<=0||s.sdk.getStateAge()>5000||s.tick()>=deadline||!cleanup&&productionStopRequested(s.name,stop))throw Error('combat potion consumer original owner/life/stop');};
 // Native banker.rs2 opens the bank at OP3; other NPC actions remain combat inputs.
 const bankAction=(a:any)=>a?.type==='interactNpc'&&a.optionIndex===3&&s.sdk.getState()?.nearbyNpcs.some(n=>n.index===a.npcIndex&&[494,495,496,497,498,499,953,1036,1360].includes(n.id)&&Number.isFinite(n.distance)&&n.distance>=0&&n.distance<=2&&client.npc?.[n.index]?.type?.id===n.id&&n.optionsWithIndex.some(o=>o.opIndex===3&&/^bank$/i.test(o.text)))===true;
 const checkAction=(a:any)=>{check();if(cleanup&&((/Npc|Player|[Ss]pell/.test(a?.type??'')&&!bankAction(a))||a?.type==='useInventoryItem'&&isPotion(a.slot)))throw Error('combat cleanup refuses new paid combat/potion');};
 const isPotion=(slot:number)=>{const row=s.sdk.getInventory().find(i=>i.slot===slot);if(!row)return false;try{potionCareRecipe(row.id);return true;}catch{return false;}};
 const sdk=new Proxy(s.sdk,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);return typeof value==='function'?function(...args:unknown[]){if(typeof key==='string'&&key.startsWith('send')){check();if(key==='sendAction')checkAction(args[0]);if(cleanup&&key==='sendUseItem'&&isPotion(args[0] as number))throw Error('combat cleanup refuses potion');}return value.apply(receiver,args);}:value;}}),view=Object.create(s)as Session&{withCombatPotionCleanup:(task:()=>Promise<void>)=>Promise<void>};
 Object.defineProperties(view,{sdk:{value:sdk},bot:{value:new BotActions(sdk)},direct:{value:(...args:unknown[])=>{checkAction(args[0]);return(s.direct as any)(...args);}},withCombatPotionCleanup:{value:async(task:()=>Promise<void>)=>{if(cleanup)throw Error('combat cleanup already active');cleanup=true;try{await task();}finally{cleanup=false;}}}});return view;
}
export function combatPotionRecovery(scope:{withCombatPotionCleanup:(task:()=>Promise<void>)=>Promise<void>},blocked:()=>boolean,bank:()=>Promise<void>,setRecovering:(active:boolean)=>void){
 let attempted=false;return async()=>{if(attempted)return;if(blocked())throw Error('combat potion unresolved input parks bank recovery');attempted=true;setRecovering(true);try{await scope.withCombatPotionCleanup(bank);}finally{setRecovering(false);}};
}
export function createCombatPotions(s:Session,p:CombatPotionPolicy,skills:readonly string[],stop:()=>boolean,ammoId?:number){
 if(s.name.toLowerCase()!==p.actor.toLowerCase()||s.lifecycle?.account.toLowerCase()!==p.actor.toLowerCase()||s.lifecycle.server!==p.server||skills.some(k=>!['Attack','Strength','Defence','Hitpoints','Ranged','Magic'].includes(k))||ammoId!==undefined&&ammoId!==884)throw Error('combat potion owned actor/server/style differs');
 const client=s.client as any,owner=client.executeBotAction,first=s.sdk.getState()?.player,life=first?.lifeId,respawns=first?.respawnCount??0,plane=first?.level;let ended=false,busy=false,blocked=false,resumes=0;void s.ended.then(()=>{ended=true;});
 const delta:Record<number,number>={},ids=new Set<number>([229]);for(const policy of p.order.policies){let id=policy.id;while(id!==229){ids.add(id);id=potionCareRecipe(id).next;}}
 const base=()=>{const st=s.sdk.getState(),me=st?.player;return !ended&&s.client===client&&client.executeBotAction===owner&&Number.isSafeInteger(life)&&!!me&&!me.isDead&&me.lifeId===life&&(me.respawnCount??0)===respawns&&me.level===plane&&(s.sdk.getSkill('Hitpoints')?.level??0)>=p.hpFloor&&s.sdk.getStateAge()<=5000&&st!.nearbyPlayers.length===0&&!productionStopRequested(s.name,stop);};
 let observation=base,inCombat=false,activePrayers:boolean[]=Array(15).fill(false);const care=createPotionCareSession(s,p.order,()=>observation(),()=>!base(),kind=>inCombat||['prayer','antipoison','antifire'].includes(kind),(skill,elapsed)=>skill==='Prayer'?combatPrayerLoss(activePrayers,elapsed):Math.ceil((elapsed+1)/100));
 const sync=()=>{for(const key of Object.keys(delta))delete delta[+key];for(const receipt of care.receipts)for(const[id,n]of Object.entries(receipt.delta as Record<number,number>))delta[+id]=(delta[+id]??0)+n;delta[229]=(delta[229]??0)-care.vials;};
 return{delta,depositIds:[...ids],get doses(){return care.doses;},get resumes(){return resumes;},get blocked(){return blocked||care.blocked;},receipts:care.receipts,async poll(target?:{index:number;id:number}){
  if(busy||blocked)throw Error('combat potion outcome unresolved');if(!base())throw Error('combat potion original owner/life/HP/stop');
  const st=s.sdk.getState()!,me=st.player!,at=s.tick(),style=JSON.stringify(st.combatStyle),retaliate=st.autoRetaliateEnabled,hp=s.sdk.getSkill('Hitpoints')!.level,xp=st.skills.map(k=>({name:k.name,xp:k.experience})),gear=s.sdk.getEquipment().map(r=>({...r})),quiver=gear.find(r=>r.slot===13),uid=32768+client.selfSlot;
  const npc=target?st.nearbyNpcs.find(n=>n.index===target.index&&n.id===target.id):undefined,native=target?client.npc?.[target.index]:undefined;
  if(target&&npc?.targetIndex===-1)return;
  if(target&&(!native||native.type?.id!==target.id||!npc||me.combat.targetType!=='npc'||me.combat.targetIndex!==target.index||npc.targetIndex!==uid))throw Error('combat potion selected owned NPC absent');
  activePrayers=[...(st.prayers?.activePrayers??[])];if(activePrayers.length!==15)throw Error('combat potion prayer state absent');inCombat=!!target;observation=()=>{if(!base())return false;const current=s.sdk.getState()!,player=current.player!;if(JSON.stringify(current.prayers.activePrayers)!==JSON.stringify(activePrayers)||JSON.stringify(current.combatStyle)!==style||current.autoRetaliateEnabled!==retaliate)return false;if(current.nearbyNpcs.some(n=>n.targetIndex===uid&&(!target||n.index!==target.index||n.id!==target.id)))return false;if(target){if(client.npc?.[target.index]&&client.npc[target.index]!==native)return false;if(player.combat.targetType!=='none'&&(player.combat.targetType!=='npc'||player.combat.targetIndex!==target.index))return false;const n=current.nearbyNpcs.find(n=>n.index===target.index);if(n&&(n.id!==target.id||n.targetIndex!==uid&&n.targetIndex!==-1))return false;}else if(player.combat.targetType!=='none'||s.sdk.getSkill('Hitpoints')?.level!==hp)return false;
   if(xp.some(k=>{const now=current.skills.find(v=>v.name===k.name)?.experience;return now===undefined||!Number.isFinite(now)||now<k.xp||(!target||!skills.includes(k.name))&&now!==k.xp;}))return false;
   const eq=s.sdk.getEquipment();if(!target||ammoId===undefined)return canonical(eq)===canonical(gear);const q=eq.find(r=>r.slot===13);return canonical(eq.filter(r=>r.slot!==13))===canonical(gear.filter(r=>r.slot!==13))&&!!quiver&&quiver.id===ammoId&&(!q||q.id===ammoId)&&quiver.count-(q?.count??0)>=0&&quiver.count-(q?.count??0)<=s.tick()-at+1;
  };
  busy=true;try{const result=await care.poll();if(!observation())throw Error('combat potion final observation differs');
   // OPHELD clears Native pending combat. Resume only the same witnessed NPC
   // after a confirmed dose/vial action and full protected consume settlement.
   if(target&&result&&(result.doses>0||result.vials>0)){const state=s.sdk.getState()!,n=state.nearbyNpcs.find(n=>n.index===target.index&&n.id===target.id);if(n&&n.hp!==0&&state.player?.combat.targetType==='none'){if(!observation()||client.npc?.[target.index]!==native||n.targetIndex!==uid)throw Error('combat potion resume target changed');await s.direct({type:'interactNpc',npcIndex:target.index,optionIndex:2,reason:'resume exact owned NPC after confirmed potion care'});resumes++;if(!await waitUntil(s,()=>!observation()||s.sdk.getState()?.player?.combat.targetType==='npc'&&s.sdk.getState()?.player?.combat.targetIndex===target.index||!s.sdk.getState()?.nearbyNpcs.some(n=>n.index===target.index),{timeoutTicks:8})||!observation())throw Error('combat potion resume unconfirmed');}}
   return result;}catch(error){blocked=true;throw error;}finally{sync();observation=base;busy=false;}
 }};
}
