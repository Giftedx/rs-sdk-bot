import {existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {sessionWalker,walkPath} from '../packages/core/src/walk';
import {depositObserved} from '../packages/core/src/deposit';
import {questFlags} from '../packages/core/src/quest-status';
import {runBankProfile,validateBankRouteJob,type BankProfile,type BankRouteJob} from './microbot-bank-jobs';
import {CHOMPY,bellowsCharges,runChompy} from './microbot-a-chompy';
import {ORB_ENERGY,drinkOrbEnergy,orbPackEffect} from './microbot-orb-trip';
import {runVisibleGroundLoot} from './microbot-b-mining-loot';
export const CHOMPY_TRIP={bank:{x:2614,z:3093,level:0},site:{x:2594,z:2966,level:0},raw:2876,arrowsPerKill:32,bellows:[2871,2872,2873,2874]} as const;
export type ChompyTripJob={kills:number;perTrip:number;cap:number;returnTicks:number;protectMelee?:boolean;prayerPotions?:number;energy?:{id:number;maximumUses:number;below:number}};
export function chompyRouteJob(o:ChompyTripJob):BankRouteJob{
 if(!Number.isSafeInteger(o.kills)||o.kills<1||o.kills>20||!Number.isSafeInteger(o.perTrip)||o.perTrip<1||o.perTrip>5)throw Error('Chompy trip kills1..20 and batch1..5 required');
 if(!Number.isSafeInteger(o.prayerPotions)||o.prayerPotions!==o.kills)throw Error('declare one bank-owned four-dose prayer potion per kill');
 if(o.protectMelee!==true)throw Error('Chompy trip requires declared Protect from Melee');
 if(o.energy&&(![3008,3016,464].includes(o.energy.id)||!Number.isSafeInteger(o.energy.maximumUses)||o.energy.maximumUses<1||o.energy.maximumUses>o.kills*(o.energy.id===464?1:4)||!Number.isSafeInteger(o.energy.below)||o.energy.below<1||o.energy.below>99))throw Error('invalid finite owned Chompy energy policy');
 const job={family:'chompy',recipe:'post-quest-swamp',target:o.kills,batch:o.perTrip,cap:o.cap,returnTicks:o.returnTicks,members:true};validateBankRouteJob(job);return job;
}
export const CHOMPY_ENERGY_IDS=[...ORB_ENERGY.map(r=>r.id),464,229];
export function chompyEnergyOption(env:Record<string,string|undefined>=process.env):ChompyTripJob['energy']{
 if(env.CHOMPY_ENERGY_ID===undefined){if(env.CHOMPY_ENERGY_USES!==undefined||env.CHOMPY_ENERGY_BELOW!==undefined)throw Error('Chompy energy policy needs native input ID');return;}
 return{id:Number(env.CHOMPY_ENERGY_ID),maximumUses:Number(env.CHOMPY_ENERGY_USES??1),below:Number(env.CHOMPY_ENERGY_BELOW??20)};
}
export async function drinkChompyEnergy(s:Session,id:number,alive:()=>boolean){
 const pack=()=>{const out:Record<number,number>={};for(const r of s.sdk.getInventory())out[r.id]=(out[r.id]??0)+r.count;return out;},before=pack(),began=s.tick(),agility=s.sdk.getSkill('Agility')?.baseLevel,energy=s.sdk.getState()?.player?.runEnergy,hp=s.sdk.getSkill('Hitpoints')?.level;
 if(!alive()||typeof energy!=='number'||energy<0||energy>=100||!Number.isSafeInteger(agility)||agility!<1||agility!>99)throw Error('Chompy native energy state absent');
 let delta:Record<number,number>;
 if(id===464){const row=s.sdk.getInventory().find(i=>i.id===id);if(!row)throw Error('Chompy owned strange fruit absent');delta={[id]:-1};try{await s.sdk.sendUseItem(row.slot,1);}catch{/* A single dispatch is reconciled by exact stock and energy. */}
  if(!await waitUntil(s,()=>!alive()||orbPackEffect(before,pack(),delta)&&(s.sdk.getState()?.player?.runEnergy??-1)>=Math.min(100,energy+30)-1,{timeoutTicks:8})||!alive()||!orbPackEffect(before,pack(),delta))throw Error('Chompy fruit stock/energy unconfirmed');
 }else delta=await drinkOrbEnergy(s,id,alive);
 // Native Player.updateEnergy recovers floor(baseAgility/6)+8 raw units per
 // non-delayed walking/idle tick; UPDATE_RUNENERGY truncates raw/100. Include
 // the publication phase tick and at most99 hidden raw units in the baseline.
 const elapsed=s.tick()-began,passiveMaximum=Math.ceil((Math.floor(agility!/6)+8)*(elapsed+1)/100);
 const after=s.sdk.getState()?.player?.runEnergy,gain=id===464?30:ORB_ENERGY.find(r=>r.id===id)?.gain;
 if(!alive()||s.sdk.getSkill('Hitpoints')?.level!==hp||gain===undefined||typeof after!=='number'||after<Math.min(100,energy+gain)-1||after>Math.min(100,energy+gain+passiveMaximum))throw Error('Chompy energy/HP unconfirmed');
 for(let i=0;i<3;i++){if(!alive())throw Error('Chompy energy settle stopped');await waitTicks(s,1);}if(!alive()||s.sdk.getSkill('Hitpoints')?.level!==hp)throw Error('Chompy energy settle health/stop');
 return{id,energyBefore:energy,energyAfter:after,gain,receiptTicks:elapsed,passiveMaximum,delta};
}
export function chompyEnergyUpkeep(s:Session,policy:NonNullable<ChompyTripJob['energy']>,receipts:Awaited<ReturnType<typeof drinkChompyEnergy>>[],alive:()=>boolean){
 const family=policy.id===464?[464]:ORB_ENERGY.filter(r=>r.gain===ORB_ENERGY.find(r=>r.id===policy.id)!.gain).map(r=>r.id as number),stock=()=>Object.fromEntries(family.map(id=>[id,s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0)]));
 let expected=stock(),uncertain=false;
 return{get uncertain(){return uncertain;},run:async()=>{
  if(uncertain||!alive())throw Error('Chompy energy stopped or uncertain');const now=stock();if(family.some(id=>now[id]!==expected[id]))throw Error('Chompy staged energy stock changed without receipt');
  if(receipts.length>=policy.maximumUses||(s.sdk.getState()?.player?.runEnergy??101)>=policy.below)return;
  const row=s.sdk.getInventory().find(i=>family.includes(i.id));
  // Exact paid receipts may exhaust this trip's finite stage. Ordinary movement
  // continues until the shared bank profile refills it; unknown loss never does.
  if(!row)return;
  uncertain=true;const receipt=await drinkChompyEnergy(s,row.id,alive);receipts.push(receipt);for(const id of family)expected[id]+=(receipt.delta[id]??0);uncertain=false;console.log('CHOMPY_ENERGY '+JSON.stringify(receipt));
 }};
}
export const CHOMPY_POTIONS=[2434,139,141,143,229] as const;
export function chompyTripAssets(before:ReadonlyMap<number,number>,after:ReadonlyMap<number,number>,r:{kills:number;baits:number;raw:number;feathers:number;rangedXp:number},potionChanges:ReadonlyMap<number,number>=new Map(),energyChanges:ReadonlyMap<number,number>=new Map()){
 const delta=(id:number)=>(after.get(id)??0)-(before.get(id)??0),rows=(a:ReadonlyMap<number,number>)=>[...a].map(([id,count])=>({id,count}));
 const bellows=(a:ReadonlyMap<number,number>)=>CHOMPY_TRIP.bellows.reduce((n,id)=>n+(a.get(id)??0),0),fills=(bellowsCharges(rows(after))+r.baits-bellowsCharges(rows(before)))/3;
 const ammoUsed=(before.get(CHOMPY.arrow)??0)-(after.get(CHOMPY.arrow)??0),allowed=new Set<number>([...CHOMPY_TRIP.bellows,CHOMPY.arrow,CHOMPY_TRIP.raw,CHOMPY.feather,...CHOMPY_POTIONS,...CHOMPY_ENERGY_IDS]);
 const changes=new Map(potionChanges);for(const[id,n]of energyChanges)changes.set(id,(changes.get(id)??0)+n);
 if(CHOMPY_ENERGY_IDS.some(id=>delta(id)!==(changes.get(id)??0)))throw Error('Chompy energy assets do not reconcile');
 if(CHOMPY_POTIONS.some(id=>delta(id)!==(changes.get(id)??0)))throw Error('Chompy potion assets do not reconcile');
 if(bellows(before)!==1||bellows(after)!==1||!Number.isSafeInteger(fills)||fills<0||delta(CHOMPY.bait)!==0||r.baits<r.kills||r.baits>15||r.raw!==r.kills||delta(CHOMPY_TRIP.raw)!==r.kills||delta(CHOMPY.feather)!==r.feathers||r.feathers<10*r.kills||r.feathers>29*r.kills||r.rangedXp<40*r.kills||ammoUsed<0||ammoUsed>CHOMPY_TRIP.arrowsPerKill*r.kills||[...new Set([...before.keys(),...after.keys()])].some(id=>!allowed.has(id)&&delta(id)!==0))throw Error('Chompy trip assets or native output do not reconcile');
 return{ammoUsed,baits:r.baits,fills,raw:r.raw,feathers:r.feathers,rangedXp:r.rangedXp,...potionChanges.size?{potionChanges:Object.fromEntries(potionChanges)}:{},...energyChanges.size?{energyChanges:Object.fromEntries(energyChanges)}:{}};
}
export async function restoreChompyStyle(s:Session,style:number,alive:()=>boolean){
 const value=()=>s.sdk.getState()?.combatStyle,matched=()=>value()?.known===true&&value()?.weaponName==='Unarmed'&&value()?.currentStyle===style;
 if(!alive()||value()?.known!==true||value()?.weaponName!=='Unarmed'||!Number.isSafeInteger(style)||style<0||style>2||!value()?.styles.some(v=>v.index===style))return false;
 if(matched())return true;if(!(await s.sdk.sendSetCombatStyle(style)).success)return false;
 await waitUntil(s,()=>!alive()||matched(),{timeoutTicks:8});return alive()&&matched();
}
// Native protection adds60 drain-counter units every five ticks. These three
// native items provide a conservative observed gear bonus; other gear gets no credit.
export function chompyPrayerReserve(returnTicks:number,gear:readonly {id:number}[]){
 const bonus=gear.reduce((n,i)=>n+(({544:6,542:5,1718:8} as Record<number,number>)[i.id]??0),0);
 return Math.ceil(Math.ceil(returnTicks/5)*60/(60+2*bonus))+2;
}
export function chompyProtection(s:Session,alive:()=>boolean){
 let uncertain=false;const active=()=>s.sdk.getState()?.prayers?.activePrayers[14];
 return{get uncertain(){return uncertain;},set:async(on:boolean)=>{
  if(uncertain||!alive())throw Error('Chompy prayer uncertain or original life unavailable');if(active()===on)return;
  try{try{await s.sdk.sendTogglePrayer(14);}catch{}if(!await waitUntil(s,()=>!alive()||active()===on,{timeoutTicks:8})||!alive()||active()!==on)throw Error('Chompy protection transition unobserved');}catch(error){uncertain=true;throw error;}
 }};
}
export async function drinkChompyPrayer(s:Session,stop:()=>boolean){
 const pack=()=>new Map(s.sdk.getInventory().map(i=>[i.id,s.sdk.getInventory().filter(r=>r.id===i.id).reduce((n,r)=>n+r.count,0)])),before=pack(),prayer=s.sdk.getState()?.prayers,points=prayer?.prayerPoints,hp=s.sdk.getSkill('Hitpoints')?.level;
 const id=CHOMPY_POTIONS.slice(0,-1).find(id=>(before.get(id)??0)>0),item=s.sdk.getInventory().find(i=>i.id===id),op=item?.optionsWithIndex.find(o=>/^drink$/i.test(o.text));
 if(stop()||id===undefined||!item||!op||points===undefined||!prayer||points>=prayer.prayerLevel)throw Error('Chompy owned prayer dose unavailable');
 const next=CHOMPY_POTIONS[CHOMPY_POTIONS.indexOf(id)+1]!,expected=Math.min(prayer.prayerLevel,points+7+Math.floor(prayer.prayerLevel/4)),paid=()=>{const now=pack();return[...new Set([...before.keys(),...now.keys()])].every(key=>(now.get(key)??0)-(before.get(key)??0)===(key===id?-1:key===next?1:0));};
 // One dispatch only; unknown dose outcome aborts rather than consuming again.
 let dispatchError:unknown;try{await s.direct({type:'useInventoryItem',slot:item.slot,optionIndex:op.opIndex,reason:'owned Chompy prayer dose'});}catch(e){dispatchError=e;}
 if(!await waitUntil(s,()=>stop()||paid()&&(s.sdk.getState()?.prayers.prayerPoints??0)>=expected-2,{timeoutTicks:8})||stop()||!paid()||(s.sdk.getState()?.prayers.prayerPoints??0)>expected||(s.sdk.getSkill('Hitpoints')?.level)!==hp)throw Error('Chompy prayer dose/points/HP unconfirmed '+String(dispatchError??''));
 const receipt={id,next,pointsBefore:points,pointsAfter:s.sdk.getState()!.prayers.prayerPoints};
 for(let i=0;i<3;i++){if(stop())throw Error('Chompy potion settle stopped');await waitTicks(s,1);}if(stop()||s.sdk.getSkill('Hitpoints')?.level!==hp)throw Error('Chompy potion settle health/stop');
 return receipt;
}
export async function waitChompyPressure(s:Session,stopped:()=>boolean){
 const own=(s.client as {selfSlot?:number}).selfSlot;if(!Number.isSafeInteger(own))throw Error('Chompy own native player slot unknown');
 let quietSince=s.tick(),damage=s.sdk.getState()?.player?.combat.lastDamageTick;
 if(!Number.isSafeInteger(damage))throw Error('Chompy damage publication unknown');
 const clear=()=>{const state=s.sdk.getState(),combat=state?.player?.combat;if(!combat||!Number.isSafeInteger(combat.lastDamageTick))throw Error('Chompy damage publication lost');
  if(combat.lastDamageTick!==damage){damage=combat.lastDamageTick;quietSince=s.tick();}
  if(combat.targetType==='player'||state!.nearbyNpcs.some(n=>n.targetIndex===32768+own!&&n.optionsWithIndex.some(o=>/^attack$/i.test(o.text))))quietSince=s.tick();
  return s.tick()-quietSince>=8;
 };
 return await waitUntil(s,()=>stopped()||clear(),{timeoutTicks:24})&&!stopped()&&clear();
}
export function chompyLocalReturn(p:{worldX:number;worldZ:number;level:number}|null|undefined){return!!p&&p.level===0&&Math.max(Math.abs(p.worldX-CHOMPY_TRIP.bank.x),Math.abs(p.worldZ-CHOMPY_TRIP.bank.z))<=128;}
export async function chompyReturnHandoff(s:Session,stopped:()=>boolean,walker=()=>sessionWalker(s)){
 if(stopped())throw Error('Chompy local return handoff stopped');
 const result=await walkPath(await walker(),[{...CHOMPY_TRIP.site,tol:0}],{maxTicks:40,stop:stopped});
 if(!result.ok||stopped()||!chompyLocalReturn(s.sdk.getState()?.player))throw Error('Chompy local return handoff '+result.detail);
}
export async function runChompyTrip(s:Session,o:ChompyTripJob,requestStop:()=>boolean=()=>false){
 const job=chompyRouteJob(o),state=()=>s.sdk.getState(),first=state()?.player,hp0=s.sdk.getSkill('Hitpoints')?.level??0,start=s.tick();
 if(!first||hp0<30||(s.sdk.getSkill('Ranged')?.level??0)<30||!questFlags(s.client)?.some(q=>/chompy/i.test(q.name)&&q.state==='complete')||first.level!==0||Math.max(Math.abs(first.worldX-CHOMPY_TRIP.bank.x),Math.abs(first.worldZ-CHOMPY_TRIP.bank.z))>3)throw Error('stage HP30, Ranged30 and observed completed Chompy quest at owned Yanille bank');
 if(s.sdk.getInventory().some(i=>[CHOMPY.bow,CHOMPY.arrow,CHOMPY.bait,...CHOMPY_TRIP.bellows,...CHOMPY_POTIONS,...CHOMPY_ENERGY_IDS].includes(i.id as any)))throw Error('stage the ogre kit in owned bank stock');
 const retaliate=state()?.autoRetaliateEnabled;if(typeof retaliate!=='boolean')throw Error('Chompy initial auto-retaliate unknown');
 const style=state()?.combatStyle;if(!style?.known||style.weaponName!=='Unarmed'||!Number.isSafeInteger(style.currentStyle)||style.currentStyle<0||style.currentStyle>2||!style.styles.some(v=>v.index===style.currentStyle))throw Error('Chompy initial native unarmed style unknown');const initialStyle=style.currentStyle;
 const initialGear=s.sdk.getEquipment().map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot);if(initialGear.some(i=>[3,5,13].includes(i.slot)))throw Error('stage free weapon, shield and ammo slots for bank-owned ogre kit');
 const prayer0=state()?.prayers;if(!prayer0||typeof prayer0.activePrayers[14]!=='boolean'||prayer0.activePrayers.some((v,i)=>v&&i!==14)||prayer0.prayerLevel<43)throw Error('Chompy requires observed Prayer43 and no other active prayers');const prayerInitial=prayer0.activePrayers[14],pointsBefore=prayer0.prayerPoints,prayerReserve=chompyPrayerReserve(o.returnTicks,initialGear);if(pointsBefore<prayerReserve+12)throw Error('Chompy owned prayer return budget short');
 const firstLife=first.lifeId,firstRespawns=first.respawnCount??0;let ended=false;void s.ended.then(()=>{ended=true;});const life=()=>{const player=state()?.player;return !ended&&!!player&&player.lifeId===firstLife&&(player.respawnCount??0)<=firstRespawns&&!player.isDead&&(s.sdk.getSkill('Hitpoints')?.level??0)>0;};
 const protection=chompyProtection(s,life);let protectionStarted=false;const prayerSafe=()=>!protection.uncertain&&!state()?.prayers.activePrayers.some((v,i)=>v&&i!==14)&&(!protectionStarted||state()?.prayers.activePrayers[14]===true)&&((state()?.prayers.prayerPoints??0)>prayerReserve||!!state()?.player&&Math.max(Math.abs(state()!.player!.worldX-CHOMPY_TRIP.bank.x),Math.abs(state()!.player!.worldZ-CHOMPY_TRIP.bank.z))<=3);
 const stop=()=>!life()||!prayerSafe()||requestStop()||existsSync('.practice/stop-microbot-chompy')||existsSync('.practice/stop-all')||existsSync(`.practice/stop-${s.name}`)||s.tick()-start>=o.cap;
 const energyReceipts:Awaited<ReturnType<typeof drinkChompyEnergy>>[]=[];let energyUncertain=false;
 const potions:Awaited<ReturnType<typeof drinkChompyPrayer>>[]=[];
 const peers=()=>state()?.nearbyPlayers.some(p=>p.name.toLowerCase()!==first.name.toLowerCase())??true,receipts:ReturnType<typeof chompyTripAssets>[]=[];
 const assets=()=>{const a=new Map<number,number>();for(const i of [...s.sdk.getInventory(),...s.sdk.getEquipment()])a.set(i.id,(a.get(i.id)??0)+i.count);return a;},count=(id:number)=>assets().get(id)??0;
 const open=async()=>{if(!life()||s.tick()-start>=o.cap)throw Error('Chompy kit bank cleanup bound');if(state()?.bank.isOpen&&s.bankObservation?.())return;await s.sdk.sendCloseModal();const generation=s.bankObservation?.()?.generation??-1;if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!life()||!!state()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:12})||!life())throw Error('Chompy kit fresh bank unavailable');};
 let result:Awaited<ReturnType<typeof runBankProfile>>|undefined,cleanup='',kitStaged=false;
 try{
  if(stop())throw Error('Chompy stopped before kit staging');await open();
  if(o.energy&&(s.bankObservation?.()?.items.find(i=>i.id===o.energy!.id)?.count??0)<o.kills)throw Error('declared owned Chompy energy bank stock short');
  if((s.bankObservation?.()?.items.find(i=>i.id===2434)?.count??0)<o.prayerPotions!)throw Error('declared owned prayer potion bank stock short');
  const bellows=[CHOMPY.full,CHOMPY.two,CHOMPY.one,CHOMPY.empty].find(id=>(s.bankObservation?.()?.items??[]).some(i=>i.id===id&&i.count>=1));if(bellows===undefined)throw Error('owned bank bellows missing');
  for(const [id,n]of [[CHOMPY.bow,1],[CHOMPY.arrow,CHOMPY_TRIP.arrowsPerKill*o.kills]]){
   if(stop())throw Error('Chompy stopped before kit withdrawal');const item=state()!.bank.items.find(i=>i.id===id),before=count(id!),stored=(s.bankObservation?.()?.items??[]).find(i=>i.id===id)?.count??0,generation=s.bankObservation!()!.generation;if(!item||stored<n!)throw Error('owned bank ogre kit stock short');
   await s.bot.withdrawItem(item,n!,{asNote:false});kitStaged=true;if(!await waitUntil(s,()=>!life()||count(id!)===before+n!&&(s.bankObservation?.()?.items.find(i=>i.id===id)?.count??0)===stored-n!&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:10})||!life())throw Error('owned ogre kit withdrawal does not reconcile');
  }
  await s.bot.closeBank();if(!await waitUntil(s,()=>!state()?.bank.isOpen,{timeoutTicks:8}))throw Error('Chompy kit bank remains open');
  if(retaliate){await s.direct({type:'clickComponent',componentId:151,reason:'Chompy route disables automatic foreign attacks'});if(!await waitUntil(s,()=>state()?.autoRetaliateEnabled===false,{timeoutTicks:8}))throw Error('Chompy auto-retaliate off unobserved');}
  for(const [id,slot]of [[CHOMPY.bow,3],[CHOMPY.arrow,13]]){if(stop())throw Error('Chompy stopped before kit wield');const item=s.sdk.getInventory().find(i=>i.id===id);if(!item)throw Error('bank-owned ogre kit missing '+id);await s.bot.equipItem(item);if(!await waitUntil(s,()=>!life()||s.sdk.getEquipment().some(i=>i.id===id&&i.slot===slot),{timeoutTicks:8})||!life())throw Error('native ogre kit wield unobserved');}
  if(!(await s.sdk.sendSetCombatStyle(0)).success||!await waitUntil(s,()=>state()?.combatStyle?.known===true&&state()?.combatStyle?.currentStyle===0&&state()?.combatStyle?.weaponName==='Ogre bow',{timeoutTicks:8}))throw Error('native accurate ogre bow style unobserved');
  const replenish=async(halt:()=>boolean)=>{while((state()?.prayers.prayerPoints??0)<Math.min(state()?.prayers.prayerLevel??0,Math.max(prayerReserve+12,75))){if(potions.length>=4*o.prayerPotions!)throw Error('Chompy declared dose budget exhausted');const receipt=await drinkChompyPrayer(s,()=>!life()||halt()||protection.uncertain||(s.sdk.getSkill('Hitpoints')?.level??0)<hp0);potions.push(receipt);console.log('CHOMPY_PRAYER_DOSE '+JSON.stringify(receipt));}};

  const profile:BankProfile={bank:CHOMPY_TRIP.bank,site:CHOMPY_TRIP.site,deferBankRecovery:()=>!chompyLocalReturn(state()?.player),inputs:{2434:1,...o.energy?{[o.energy.id]:1}:{}},tools:[bellows],outputs:[CHOMPY_TRIP.raw,CHOMPY.feather,...CHOMPY_TRIP.bellows,...CHOMPY_POTIONS,...CHOMPY_ENERGY_IDS],prepare:async halt=>{await replenish(halt);if(halt()||(state()?.prayers.prayerPoints??0)<prayerReserve+12)throw Error('Chompy outbound prayer budget short');await protection.set(true);protectionStarted=true;},capacityOutputs:{[CHOMPY_TRIP.raw]:1,[CHOMPY.feather]:29,[CHOMPY.arrow]:CHOMPY_TRIP.arrowsPerKill},run:async(n,cap,halt)=>{
   if(cap<=45||peers()||state()?.groundItems.some(i=>i.id===CHOMPY.arrow))throw Error('Chompy hunt needs isolated site, empty arrow baseline and cleanup budget');
   const energyUpkeep=o.energy?chompyEnergyUpkeep(s,o.energy,energyReceipts,()=>life()&&!halt()&&(s.sdk.getSkill('Hitpoints')?.level??0)===hp0):undefined;
   const upkeep=async()=>{await replenish(halt);try{await energyUpkeep?.run();}finally{energyUncertain=energyUpkeep?.uncertain??false;}};
   const before=assets(),potionStart=potions.length,energyStart=energyReceipts.length,positions=new Set<string>(),off=s.onTick(()=>{for(const bird of state()?.nearbyNpcs??[])if(bird.id===CHOMPY.live)positions.add(`${bird.x},${bird.z}`);});
   try{
    const hunt=await runChompy(s,{upkeep,stageBait:async stopped=>{
     const safe={x:2588,z:2966,level:0};if(stopped())throw Error('Chompy bait staging stopped');
     const walk=await walkPath(await sessionWalker(s),[{...safe,tol:0}],{maxTicks:60,stop:stopped});if(!walk.ok||stopped())throw Error('Chompy wolf separation '+walk.detail);
     if(!await waitChompyPressure(s,stopped))throw Error('Chompy wolf combat cooldown unavailable '+JSON.stringify({player:state()?.player,messages:state()?.gameMessages.filter(m=>m.type===0).slice(-3),attackers:state()?.nearbyNpcs.filter(n=>n.inCombat).map(n=>({id:n.id,index:n.index,target:n.targetIndex}))}));
    },kills:n,cap:Math.min(20000,cap-45),maxBaits:Math.min(15,n*5),stop:()=>halt()||peers()||!prayerSafe()});if(!hunt.ok)throw Error('staged Chompy hunt '+hunt.failure+' '+hunt.stop);
    await waitTicks(s,3);const spent=(before.get(CHOMPY.arrow)??0)-count(CHOMPY.arrow);if(spent<1||spent>CHOMPY_TRIP.arrowsPerKill*n)throw Error('native ogre arrow debit absent');
    if(peers())throw Error('Chompy arrow attribution changed');const arrows=state()!.groundItems.filter(i=>i.id===CHOMPY.arrow);if(arrows.some(i=>!positions.has(`${i.x},${i.z}`))||arrows.reduce((a,i)=>a+i.count,0)>spent)throw Error('Chompy ground arrow attribution ambiguous');
    const units=arrows.reduce((a,i)=>a+i.count,0);
    if(units){const client=s.client as {objType:(id:number)=>{cost:number;stackable:boolean}};const recovered=await runVisibleGroundLoot({state:()=>{const st=state();return st&&{...st,groundItems:st.groundItems.filter(i=>i.id===CHOMPY.arrow&&positions.has(`${i.x},${i.z}`))};},tick:()=>s.tick(),stop:()=>!life()||peers()||halt(),definition:id=>client.objType(id),pickup:async i=>(await s.sdk.sendPickup(i.x,i.z,i.id)).success,wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1),clearModal:async()=>{await s.sdk.sendCloseModal();}},{mode:'list',ids:[CHOMPY.arrow],names:[],minimumValue:0,maximumValue:2147483647,radius:12,maximumUnits:units,cap:35,idleTicks:5});if(recovered.units!==units)throw Error('Chompy visible arrows remain');}
    const potionChanges=new Map<number,number>();for(const r of potions.slice(potionStart)){potionChanges.set(r.id,(potionChanges.get(r.id)??0)-1);potionChanges.set(r.next,(potionChanges.get(r.next)??0)+1);}const energyChanges=new Map<number,number>();for(const r of energyReceipts.slice(energyStart))for(const[id,n]of Object.entries(r.delta))energyChanges.set(Number(id),(energyChanges.get(Number(id))??0)+n);const receipt=chompyTripAssets(before,assets(),hunt,potionChanges,energyChanges);receipts.push(receipt);console.log('CHOMPY_TRIP_KILL '+JSON.stringify(receipt));return hunt.raw;
   }finally{off();const rows=s.sdk.getInventory().filter(i=>CHOMPY_TRIP.bellows.includes(i.id as any));if(rows.length===1&&rows[0]!.count===1)profile.tools[0]=rows[0]!.id;await chompyReturnHandoff(s,()=>!life()||s.tick()-start>=o.cap-100||(s.sdk.getSkill('Hitpoints')?.level??0)<hp0);}
  }};
  result=await runBankProfile(s,{...job,cap:o.cap-(s.tick()-start)-100},profile,stop);
 }catch(error){cleanup=String(error);}
 finally{
  if(kitStaged&&life())try{
   const at=state()?.player;if(!at||at.level!==0||Math.max(Math.abs(at.worldX-CHOMPY_TRIP.bank.x),Math.abs(at.worldZ-CHOMPY_TRIP.bank.z))>3)throw Error('Chompy kit return bank unobserved');
   await s.bot.closeBank();if(!await waitUntil(s,()=>!state()?.bank.isOpen,{timeoutTicks:8}))throw Error('Chompy kit bank remains open');for(const slot of [13,3]){const item=s.sdk.getEquipment().find(i=>i.slot===slot);if(item){const total=count(item.id),held=s.sdk.getInventory().filter(i=>i.id===item.id).reduce((a,i)=>a+i.count,0);await s.bot.unequipItem(item);if(!await waitUntil(s,()=>!life()||!s.sdk.getEquipment().some(i=>i.slot===slot)&&s.sdk.getInventory().filter(i=>i.id===item.id).reduce((a,i)=>a+i.count,0)===held+item.count,{timeoutTicks:8})||!life()||count(item.id)!==total)throw Error('Chompy return kit unequip does not reconcile');}}
   await open();for(const id of [CHOMPY.arrow,CHOMPY.bow,...CHOMPY_POTIONS,...CHOMPY_ENERGY_IDS]){const item=s.sdk.getInventory().find(i=>i.id===id);if(item)await depositObserved(s,item);}await s.bot.closeBank();
   await protection.set(prayerInitial);
   if(!await restoreChompyStyle(s,initialStyle,life))throw Error('Chompy initial unarmed style restore unobserved');
   if(retaliate&&state()?.autoRetaliateEnabled!==true){await s.direct({type:'clickComponent',componentId:150,reason:'restore Chompy route auto-retaliate at bank'});if(!await waitUntil(s,()=>state()?.autoRetaliateEnabled===true,{timeoutTicks:8}))throw Error('Chompy auto-retaliate restore unobserved');}
  }catch(error){cleanup+='; kit recovery '+String(error);}
 }
 const prayerRestored=!protection.uncertain&&life()&&state()?.prayers.activePrayers[14]===prayerInitial,prayerPointsAfter=state()?.prayers.prayerPoints;
 const retaliateRestored=state()?.autoRetaliateEnabled===retaliate,styleRestored=state()?.combatStyle?.known===true&&state()?.combatStyle?.weaponName==='Unarmed'&&state()?.combatStyle?.currentStyle===initialStyle;
 const banked={raw:result?.banked[CHOMPY_TRIP.raw]??0,feathers:result?.banked[CHOMPY.feather]??0},gearPreserved=JSON.stringify(initialGear)===JSON.stringify(s.sdk.getEquipment().map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot));
 return{...result,ok:!!result?.ok&&!cleanup&&gearPreserved&&prayerRestored&&styleRestored&&retaliateRestored&&banked.raw===o.kills&&banked.feathers===receipts.reduce((n,r)=>n+r.feathers,0),banked,receipts,potions,energy:energyReceipts,energyStateUncertain:energyUncertain,maximumEnergyUses:o.energy?.maximumUses??0,maximumDoses:4*o.prayerPotions!,ammoUsed:receipts.reduce((n,r)=>n+r.ammoUsed,0),gearPreserved,prayerRestored,prayerStateUncertain:protection.uncertain,prayerReserve,prayerPointsBefore:pointsBefore,prayerPointsAfter,styleRestored,retaliateRestored,cleanup:cleanup||'-',ticks:s.tick()-start};
}
if(import.meta.main){const account=process.argv[2];if(!account)throw Error('usage: microbot-chompy-trip.ts account [kills=2] [per-trip=1] [cap=5000]');let stopped=false;const s=await openBot(account,{onStop:async()=>{stopped=true;}});try{const result=await runChompyTrip(s,{kills:Number(process.argv[3]??2),perTrip:Number(process.argv[4]??1),cap:Number(process.argv[5]??5000),returnTicks:300,protectMelee:true,prayerPotions:Number(process.argv[3]??2),energy:chompyEnergyOption()},()=>stopped);console.log('CHOMPY_TRIP '+JSON.stringify(result));await finish([s],result.ok,JSON.stringify(result));}catch(error){await finish([s],false,String(error));}}
