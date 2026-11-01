// The Earth order's owned alternative to an empty rune shop. One account; finite hunts and exact input ledgers.
import {existsSync} from 'node:fs';
import {openBot,settle,getWorld,accountOf,sessionDied} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {goTo,walkPath,sessionWalker} from '../packages/core/src/walk';
import {interactionApproach} from '../packages/core/src/world';
import {equipmentObserved} from '../packages/core/src/container-observation';
import {depositObserved} from '../packages/core/src/deposit';
import {xpForLevel} from '../packages/planner/src/curve';
import {startQuestSustain,questFoodDefinitions} from './quest-sustain';
import {openEarthBankObserved,retainedEarthBank} from './earth-shop';
import {enterAirAltar,craftAirRunes,exitAirAltar,insideAirAltar} from './generated/rcair';

const EARTH=557,ESSENCE=1436,AIR=556;
const WEST={x:3185,z:3436},EAST={x:3253,z:3420},DRAYNOR={x:3092,z:3243};
const FOOD=[1891,1893,1895,1985,329,333,379];
export function productionBatch(level:number,xp:number,missing:number,available:number){
 if(!Number.isSafeInteger(level)||level<1||level>99||![xp,missing,available].every(n=>Number.isFinite(n)&&n>=0)||![missing,available].every(Number.isSafeInteger))throw Error('earth production quantities unknown');
 const air=level<9,multiple=air?Math.floor(level/11)+1:Math.floor(level/26)+1;
 const needed=air?Math.max(0,Math.ceil((xpForLevel(9)-xp)/125)):Math.ceil(missing/multiple);
 return{rune:air?AIR:EARTH,talisman:air?1438:1440,essence:missing?Math.min(27,available,needed):0,multiple};
}
export function talismanTarget(id:number){
 if(id===1440)return{id,npcIds:[1,2,3,4,5,6],spot:{x:3221,z:3219}};
 if(id===1438)return{id,npcIds:[100],spot:{x:3255,z:3226}};
 throw Error('unsupported earth access drop');
}
export const productionMode=(profile:string)=>profile==='owned-talismans'?'talismans':profile==='owned-craft'?'craft':undefined;
export async function collectHuntLoot(s:Session,stop:()=>boolean,afterKill=false){
 const loot=()=>s.sdk.getState()?.groundItems.find(i=>[1438,1440,557].includes(i.id)&&i.distance<=10);
 if(stop())throw Error('earth hunt pickup stopped');
 // npc_death waits for arrival (up to two ticks), then its animation, before the drop table runs.
 if(afterKill)await waitUntil(s,()=>stop()||!!loot(),{timeoutTicks:6});
 if(stop())throw Error('earth hunt pickup stopped');const item=loot();if(!item)return null;
 const count=()=>s.sdk.getInventory().filter(i=>i.id===item.id).reduce((n,i)=>n+i.count,0),before=count();
 await s.bot.pickupItem(item);
 const observed=await waitUntil(s,()=>stop()||count()===before+item.count,{timeoutTicks:10});
 if(stop()||!observed||count()!==before+item.count)throw Error('earth hunt pickup settlement unobserved');
 return{id:item.id,count:item.count};
}
export async function huntFight(s:Session,npc:{id:number;index:number},stop:()=>boolean,foodEpoch:()=>number){
 const before=s.sdk.getSkillXp('Strength')??0,start=s.tick();let sent=start,food=foodEpoch(),retries=0;
 await s.bot.attack(npc as Parameters<typeof s.bot.attack>[0]);
 while(s.tick()-start<100){
  if(stop())throw Error('earth hunt fight stopped');
  const current=s.sdk.getState()?.nearbyNpcs.find(n=>n.index===npc.index&&n.id===npc.id&&(n.hp??1)>0);
  if(!current&&(s.sdk.getSkillXp('Strength')??0)>before)return;
  const epoch=foodEpoch();
  if(current&&retries<3&&(epoch!==food||s.tick()-sent>=16)){
   food=epoch;sent=s.tick();retries++;await s.bot.attack(current);
  }
  await waitTicks(s,1);
 }
 throw Error('earth hunt fight credit deadline');
}
type Ledger={consumed:number;crafted:number;air:number;eaten:Record<number,number>;found?:Record<number,number>};
export function productionConserved(before:ReadonlyMap<number,number>,after:ReadonlyMap<number,number>,l:Ledger){
 const expected=new Map(before),add=(id:number,n:number)=>expected.set(id,(expected.get(id)??0)+n);
 add(ESSENCE,-l.consumed);add(EARTH,l.crafted);add(AIR,l.air);
 for(const [id,n] of Object.entries(l.found??{}))add(Number(id),n);
 for(const [id,n] of Object.entries(l.eaten)){const def=questFoodDefinitions().get(Number(id));if(!def||!Number.isSafeInteger(n)||n<0)return false;add(Number(id),-n);if(def.next)add(def.next,n);}
 return [...new Set([...expected.keys(),...after.keys()])].every(id=>(expected.get(id)??0)===(after.get(id)??0)&&(expected.get(id)??0)>=0);
}

export async function runEarthProduction(s:Session,o:{mode:'talismans'|'craft';cap:number;target:number;reserve:number;killsPerTarget?:number;stop:()=>boolean}){
 if(!['talismans','craft'].includes(o.mode)||![o.cap,o.target,o.reserve].every(n=>Number.isSafeInteger(n)&&n>=0)||o.cap<1||o.cap>20000||o.target<1)throw Error('invalid earth production bounds');
 if(o.killsPerTarget!==undefined&&(!Number.isSafeInteger(o.killsPerTarget)||o.killsPerTarget<0||o.killsPerTarget>3))throw Error('invalid finite hunt pilot');
 const st=()=>s.sdk.getState(),pos=()=>st()?.player,inv=()=>s.sdk.getInventory(),eq=()=>s.sdk.getEquipment();
 const start=s.tick(),held=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
 const banks=retainedEarthBank(()=>s.bankObservation?.());
 const owned=()=>{const m=new Map<number,number>();for(const i of [...inv(),...eq(),...banks()])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
 const banked=(id:number)=>banks().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 if(!await waitUntil(s,()=>!!pos()&&hp()>12&&!!s.client&&equipmentObserved(s.client as object),{timeoutTicks:25}))throw Error('earth production entry life/equipment unknown');
 const life=pos(),originalEquipment=eq().map(i=>i.id),style=st()?.combatStyle?.currentStyle,retaliate=st()?.autoRetaliateEnabled;
 let ended=false,cleanup=false,hpMin=hp(),failure='',kills=0,trips=0,lastOutput=start,initial:Map<number,number>|undefined;
 void s.ended.then(()=>{ended=true;});
 const ledger:Ledger={consumed:0,crafted:0,air:0,eaten:{},found:{}};
 const terminal=()=>ended||sessionDied(life,pos())||hp()<=0;
 const stopped=()=>o.stop()||existsSync(`.practice/stop-${s.name}`);
 const over=()=>terminal()||stopped()||s.tick()-start>=o.cap+(cleanup?1500:0);
 const off=s.onTick(()=>{hpMin=Math.min(hpMin,hp());});
 const sustain=startQuestSustain({sdk:s.sdk,tick:()=>s.tick(),onTick:cb=>s.onTick(cb),ended:s.ended,direct:async a=>{const r=await s.direct(a);return{success:!!r&&typeof r==='object'&&'success'in r&&r.success===true};}},
  {food:FOOD,eatAt:25,onConsumed:e=>{ledger.eaten[e.id]=(ledger.eaten[e.id]??0)+1;}});
 const check=()=>{if(over()||sustain.failure()||hp()<=6)throw Error('earth production stop/life/deadline: '+(sustain.failure()??''));};
 const travel=async(to:{x:number;z:number})=>{
  check();const ac=new AbortController(),guard=()=>{if(over()||sustain.failure()||hp()<=6)ac.abort();},off=s.onTick(guard);
  const a=accountOf(s),actor={...a,skills:{...a.skills,magic:0},items:[],counts:{},worn:[],coins:0};
  try{const r=await goTo(s,await getWorld(),{...to,level:0},actor,{legTimeoutTicks:150,signal:ac.signal});if(!r.ok)throw Error('earth production route: '+JSON.stringify(r));}finally{off();}check();
 };
 const open=async()=>{check();await s.bot.dismissBlockingUI();await openEarthBankObserved(s);banks();};
 const deposit=async()=>{for(const i of [...inv()]){check();await depositObserved(s,i);}banks();};
 const withdraw=async(id:number,n:number)=>{if(!n)return;check();const item=st()?.bank.items.find(i=>i.id===id),b=banked(id),p=held(id);if(!item||b<n)throw Error('earth production missing owned '+id);await s.bot.withdrawItem(item,n);if(!await waitUntil(s,()=>over()||held(id)===p+n&&banked(id)===b-n,{timeoutTicks:12})||over())throw Error('earth production withdrawal unobserved '+id);};
 const equip=async(id:number)=>{if(eq().some(i=>i.id===id))return;const item=inv().find(i=>i.id===id);if(!item)throw Error('earth production kit missing '+id);await s.bot.equipItem(item);if(!await waitUntil(s,()=>over()||eq().some(i=>i.id===id),{timeoutTicks:10})||over())throw Error('earth production equip unobserved');};
 const insideEarth=()=>!!pos()&&pos()!.level===0&&pos()!.worldX>=2645&&pos()!.worldX<=2670&&pos()!.worldZ>=4820&&pos()!.worldZ<=4845;
 const exitEarth=async()=>{
  const p=st()?.nearbyLocs.find(l=>l.id===2468&&l.optionsWithIndex.some(o=>o.opIndex===1&&/^use$/i.test(o.text)));if(!p)throw Error('earth exit portal unobserved');
  const edge=[{x:p.x,z:p.z+1},{x:p.x+1,z:p.z},{x:p.x,z:p.z-1},{x:p.x-1,z:p.z}].find(t=>s.sdk.findPath(t.x,t.z).reachedDestination===true);
  if(!edge)throw Error('earth exit face unavailable');await s.bot.walkTo(edge.x,edge.z,0,{timeout:10000});check();
  if(pos()?.worldX!==edge.x||pos()?.worldZ!==edge.z)throw Error('earth exit face unobserved');
  if(!(await s.sdk.sendInteractLoc(p.x,p.z,p.id,1)).success||!await waitUntil(s,()=>over()||!insideEarth(),{timeoutTicks:20})||insideEarth())throw Error('earth exit unobserved');check();
 };
 const enterEarth=async()=>{
  await travel({x:3303,z:3477});await s.bot.dismissBlockingUI();
  const at={x:3305,z:3473,level:0},q={id:2455,shape:10,angle:0,width:3,height:3,blockAccessFlags:0,src:'maps/m51_54.jm2',configSrc:'scripts/skill_runecraft/configs/runecraft.loc'};
  const loc=st()?.nearbyLocs.find(l=>l.id===q.id&&l.x===at.x&&l.z===at.z),item=inv().find(i=>i.id===1440);
  if(!loc||!item)throw Error('earth ruins/talisman unobserved');const face=await interactionApproach(s.sdk,at,q);if(!face)throw Error('earth ruins face unavailable');
  const w=await walkPath(await sessionWalker(s),[{x:face.x,z:face.z,tol:0}],{maxTicks:60,stop:over});check();if(!w.ok||pos()?.worldX!==face.x||pos()?.worldZ!==face.z)throw Error('earth ruins face unobserved');
  if(!(await s.sdk.sendUseItemOnLoc(item.slot,at.x,at.z,q.id)).success||!await waitUntil(s,()=>over()||insideEarth(),{timeoutTicks:20})||!insideEarth())throw Error('earth entry unobserved');check();
 };
 try{
  const p=pos()!,near=[DRAYNOR,WEST,EAST].sort((a,b)=>Math.max(Math.abs(a.x-p.worldX),Math.abs(a.z-p.worldZ))-Math.max(Math.abs(b.x-p.worldX),Math.abs(b.z-p.worldZ)))[0]!;
  await travel(near);await open();await deposit();initial=owned();
  if((initial.get(995)??0)<o.reserve)throw Error('earth production reserve unavailable');
  if(o.mode==='talismans'){
   if(!Number.isSafeInteger(style)||typeof retaliate!=='boolean')throw Error('earth production combat controls unknown');
   if(s.sdk.getSkill('Attack')!.baseLevel<30||s.sdk.getSkill('Defence')!.baseLevel<10)throw Error('earth hunt combat prerequisites');
   for(const id of [1277,1171,1115]){if(!eq().some(i=>i.id===id)){await withdraw(id,1);await equip(id);}}
   let slots=0;for(const id of FOOD){const n=Math.min(banked(id),Math.max(0,12-slots));await withdraw(id,n);slots+=n;}
   if(!slots)throw Error('earth hunt owned food required');await s.bot.closeBank();
   if(!(await s.sdk.sendSetCombatStyle(1)).success||!await waitUntil(s,()=>st()?.combatStyle?.currentStyle===1,{timeoutTicks:8}))throw Error('earth hunt strength style unobserved');
   if(retaliate){await s.direct({type:'clickComponent',componentId:151,reason:'owned talisman hunt controls'});if(!await waitUntil(s,()=>st()?.autoRetaliateEnabled===false,{timeoutTicks:8}))throw Error('earth hunt auto-retaliate unobserved');}
   for(const id of [1440,1438]){
    const target=talismanTarget(id);if((initial.get(id)??0)>0&&!o.killsPerTarget)continue;await travel(target.spot);lastOutput=s.tick();const firstKill=kills;
    while(o.killsPerTarget?kills-firstKill<o.killsPerTarget:!held(id)){
     check();if(kills>=500||s.tick()-lastOutput>240)throw Error('earth hunt no kill progress');
     if(hp()<18&&!inv().some(i=>FOOD.includes(i.id)))throw Error('earth hunt food exhausted; retreat');
     const loot=await collectHuntLoot(s,over);if(loot)ledger.found![loot.id]=(ledger.found![loot.id]??0)+loot.count;
     if(held(id)&&!o.killsPerTarget)break;
     const npc=st()?.nearbyNpcs.filter(n=>target.npcIds.includes(n.id)&&!n.inCombat&&(n.hp??1)>0&&n.reachable!==false&&Math.max(Math.abs(n.x-target.spot.x),Math.abs(n.z-target.spot.z))<=18).sort((a,b)=>a.distance-b.distance)[0];
     if(!npc){await waitTicks(s,1);continue;}
     await huntFight(s,npc,()=>over()||!!sustain.failure()||hp()<=6,()=>Object.values(ledger.eaten).reduce((n,v)=>n+v,0));kills++;lastOutput=s.tick();
     const dropped=await collectHuntLoot(s,over,true);if(dropped)ledger.found![dropped.id]=(ledger.found![dropped.id]??0)+dropped.count;
     console.log('EARTH_PRODUCTION_KILL '+JSON.stringify({kills,target:id,hp:hp(),tick:s.tick()}));
    }
   }
  }else{
   while((owned().get(EARTH)??0)<o.target){
    check();const level=s.sdk.getSkill('Runecraft')?.baseLevel??0,xp=s.sdk.getSkillXp('Runecraft')??0;
    const batch=productionBatch(level,xp,o.target-(owned().get(EARTH)??0),banked(ESSENCE));if(!batch.essence)throw Error('earth production essence exhausted before target');
    await withdraw(batch.talisman,1);await withdraw(ESSENCE,batch.essence);await s.bot.closeBank();
    const before=held(batch.rune),beforeXp=s.sdk.getSkillXp('Runecraft')??0;
    if(batch.rune===AIR){await travel({x:2983,z:3288});await enterAirAltar(s);check();await craftAirRunes(s,over);}
    else{await enterEarth();const altar=st()?.nearbyLocs.find(l=>l.id===2481&&l.optionsWithIndex.some(o=>/craft/i.test(o.text)));if(!altar)throw Error('earth craft altar unobserved');await s.bot.interactLoc(altar,/craft/i);}
    if(!await waitUntil(s,()=>over()||held(ESSENCE)===0&&held(batch.rune)===before+batch.essence*batch.multiple&&(s.sdk.getSkillXp('Runecraft')??0)>beforeXp,{timeoutTicks:15}))throw Error('earth craft paired effects unobserved');check();
    if(held(ESSENCE)!==0||held(batch.rune)!==before+batch.essence*batch.multiple)throw Error('earth craft accounting mismatch');
    ledger.consumed+=batch.essence;if(batch.rune===AIR)ledger.air+=batch.essence*batch.multiple;else ledger.crafted+=batch.essence*batch.multiple;
    if(batch.rune===AIR)await exitAirAltar(s,over);else await exitEarth();trips++;
    await travel(EAST);await open();await deposit();console.log('EARTH_PRODUCTION_BATCH '+JSON.stringify({trips,...batch,crafted:ledger.crafted,consumed:ledger.consumed,earth:banked(EARTH),level:s.sdk.getSkill('Runecraft')?.baseLevel,tick:s.tick()}));
   }
  }
 }catch(e){failure=String(e);}
 finally{
  cleanup=true;
  try{if(!terminal()&&!stopped()){
   if(insideAirAltar(pos()))await exitAirAltar(s,over);if(insideEarth())await exitEarth();
   await travel(o.mode==='talismans'?WEST:EAST);
   for(const item of [...eq()])if(!originalEquipment.includes(item.id)){await s.bot.unequipItem(item);if(!await waitUntil(s,()=>!eq().some(i=>i.id===item.id),{timeoutTicks:10}))throw Error('earth kit unequip unobserved');}
   await sustain.settle();if(sustain.failure())throw Error(sustain.failure()!);await open();await deposit();
   for(const id of originalEquipment)if(!eq().some(i=>i.id===id)){await withdraw(id,1);await equip(id);}banks();await s.bot.closeBank();
   if(o.mode==='talismans'){
    if(style!==undefined&&st()?.combatStyle?.currentStyle!==style){await s.sdk.sendSetCombatStyle(style);if(!await waitUntil(s,()=>st()?.combatStyle?.currentStyle===style,{timeoutTicks:8}))throw Error('earth style restore unobserved');}
    if(retaliate!==undefined&&st()?.autoRetaliateEnabled!==retaliate){await s.direct({type:'clickComponent',componentId:retaliate?150:151,reason:'restore earth hunt controls'});if(!await waitUntil(s,()=>st()?.autoRetaliateEnabled===retaliate,{timeoutTicks:8}))throw Error('earth auto-retaliate restore unobserved');}
   }
  }}catch(e){failure+='; cleanup '+String(e);}await sustain.stop();off();
 }
 const final=owned(),conserved=!!initial&&productionConserved(initial,final,ledger),equipmentRestored=JSON.stringify(eq().map(i=>i.id).sort())===JSON.stringify(originalEquipment.sort());
 const talismansReady=banked(1438)>=1&&banked(1440)>=1,targetMet=banked(EARTH)>=o.target;
 const pilotReady=!!o.killsPerTarget&&kills>=2*o.killsPerTarget;
 const ok=!failure&&!terminal()&&!stopped()&&conserved&&equipmentRestored&&(o.mode==='talismans'?(o.killsPerTarget?pilotReady:talismansReady):targetMet);
 return{ok,mode:o.mode,talismansReady:talismansReady?1:0,pilotReady:pilotReady?1:0,targetMet:targetMet?1:0,finalEarth:banked(EARTH),fire:banked(554),finalCoins:final.get(995)??0,spentTotal:0,seeded:0,conserved,equipmentRestored,kills,trips,hpMin,hp:hp(),ticks:s.tick()-start,...ledger,failure:failure||'-'};
}
if(import.meta.main){
 let stopped=false;const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}});
 try{const r=await runEarthProduction(s,{mode:process.argv[3] as 'talismans'|'craft',cap:Number(process.argv[4]),target:Number(process.env.STOCK_TARGET),reserve:Number(process.env.COIN_RESERVE),killsPerTarget:Number(process.env.HUNT_KILLS_PER_TARGET??0),stop:()=>stopped});console.log('EARTH_PRODUCTION '+JSON.stringify(r));process.exitCode=await settle([s],r.ok,Object.entries(r).map(([k,v])=>`${k}=${typeof v==='object'?JSON.stringify(v):v}`).join(' '))?0:1;}
 catch(e){await settle([s],false,String(e));process.exitCode=1;}
}
