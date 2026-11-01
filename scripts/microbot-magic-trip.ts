import {readFileSync,existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {runBankProfile,validateBankRouteJob,type BankRouteJob,type BankProfile} from './microbot-bank-jobs';
import {nativeNpcSpell,runNpcMagic} from './microbot-magic-npc';
import {nativeTeleport,runTeleportMagic,teleportReceipt,type NativeTeleport} from './microbot-magic-teleport';
import {componentId} from '../packages/core/src/logout';
import {combatTeleportAllowed} from './microbot-combat-trip';
import {elementalRuneCost,itemMagicRecipe,itemSpellCosts} from './microbot-magic-items';
export type MagicBankJob=BankRouteJob&{family:'magic-npc'|'magic-teleport';npc?:number;splashOnly?:boolean;comboAlch?:'low-alch'|'high-alch';comboTeleport?:string;returnTeleport?:string;protectPrayer?:12|13|14};
export function validateMagicBankJob(j:MagicBankJob){
 validateBankRouteJob(j);if(!['magic-npc','magic-teleport'].includes(j.family)||!j.bank||j.batch>1000)throw Error('magic bank job needs known family, bank and batch<=1000');
 if(j.family==='magic-npc'&&(!j.site||!Number.isSafeInteger(j.npc)||j.npc!<0))throw Error('NPC magic bank job needs exact site and native NPC ID');
 if(j.protectPrayer!==undefined&&(j.family!=='magic-npc'||![12,13,14].includes(j.protectPrayer)))throw Error('unsupported magic protection prayer');
 if(j.splashOnly!==undefined&&typeof j.splashOnly!=='boolean')throw Error('invalid splash-only scope');
 if(j.comboAlch!==undefined&&!['low-alch','high-alch'].includes(j.comboAlch))throw Error('unsupported finite alchemy combo');
 const spell=j.family==='magic-npc'?nativeNpcSpell(j.recipe):nativeTeleport(j.recipe);
 if(spell.members&&!j.members)throw Error('member magic job needs member scope');
 if(j.comboAlch)itemMagicRecipe(j.comboAlch,j.alchemyTarget);
 if(j.returnTeleport){const t=nativeTeleport(j.returnTeleport);if(j.batch!==1)throw Error('return teleport needs one-cast bank batches');if(t.members&&!j.members)throw Error('member return teleport needs member scope');}
 if(j.comboTeleport){const t=nativeTeleport(j.comboTeleport);if(j.family!=='magic-npc'||j.batch!==1)throw Error('NPC teleport combo needs one-cast bank batches');if(t.members&&!j.members)throw Error('member combo needs member scope');}
}
export async function returnMagicTrip(s:Session,t:NativeTeleport,members:boolean,budget:number){
 const initial=s.sdk.getState()?.player,life=initial?.lifeId,start=s.tick(),fatal=()=>{const p=s.sdk.getState()?.player;return !p||p.isDead||p.lifeId!==life||(s.sdk.getSkill('Hitpoints')?.level??0)<1||s.tick()-start>=budget;};
 const landed=()=>{const p=s.sdk.getState()?.player;return !!p&&p.level===t.to.level&&Math.max(Math.abs(p.worldX-t.to.x),Math.abs(p.worldZ-t.to.z))<=2;};
 if(!initial||fatal())throw Error('magic return life/budget unavailable');if(landed())return;
 if(!combatTeleportAllowed(initial))throw Error('magic return needs legal Wilderness exit');
 // Settle the paid cast or consumable that caused the production loop to stop.
 for(let n=0;n<3;n++){if(fatal())throw Error('magic return life/budget changed');await waitTicks(s,1);}
 const counts=()=>{const out:Record<number,number>={};for(const i of s.sdk.getInventory())out[i.id]=(out[i.id]??0)+i.count;return out;},before=counts(),xp=s.sdk.getSkillXp('Magic')??0,costs=Object.fromEntries(Object.entries(t.runes).map(([id,n])=>[id,elementalRuneCost(Number(id),n,s.sdk.getEquipment(),members)]));
 if(Object.entries(costs).some(([id,n])=>(before[Number(id)]??0)<n))throw Error('magic return owned runes short');
 await s.sdk.sendCloseModal();try{await s.direct({type:'clickComponent',componentId:componentId(t.component),reason:'bounded owned magic trip return'});}catch{/* Observe the single authorized dispatch before deciding its outcome. */}
 const paid=()=>teleportReceipt(t,costs,before,counts(),xp,s.sdk.getSkillXp('Magic')??0,s.sdk.getState()?.player);
 if(!await waitUntil(s,()=>fatal()||paid(),{timeoutTicks:Math.max(1,Math.min(20,budget-(s.tick()-start)))})||fatal()||!paid())throw Error('magic return rune/XP/landing unconfirmed');
 for(let n=0;n<3;n++){if(fatal())throw Error('magic return settlement life/budget changed');await waitTicks(s,1);}
}
export function magicBankProfile(s:Session,j:MagicBankJob):BankProfile{
 validateMagicBankJob(j);const spell=j.family==='magic-npc'?nativeNpcSpell(j.recipe):nativeTeleport(j.recipe),combo=j.comboAlch?itemMagicRecipe(j.comboAlch,j.alchemyTarget):undefined,tele=j.comboTeleport?nativeTeleport(j.comboTeleport):undefined,back=j.returnTeleport?nativeTeleport(j.returnTeleport):undefined;
 if(j.protectPrayer!==undefined&&((s.sdk.getState()?.prayers.prayerLevel??0)<({12:37,13:40,14:43}[j.protectPrayer])||(s.sdk.getState()?.prayers.prayerPoints??0)<10))throw Error('magic trip protection level/points short');
 if('requiredWorn' in spell&&spell.requiredWorn!==undefined&&!s.sdk.getEquipment().some(i=>i.slot===3&&i.id===spell.requiredWorn))throw Error('magic trip needs native required staff');
 const inputs:Record<number,number>={};const add=(costs:Record<number,number>)=>{for(const[id,n]of Object.entries(costs))if(n)inputs[Number(id)]=(inputs[Number(id)]??0)+n;};
 const costs=(r:Record<number,number>)=>Object.fromEntries(Object.entries(r).map(([id,n])=>[id,elementalRuneCost(Number(id),n,s.sdk.getEquipment(),j.members)]));
 add(costs(spell.runes));if(combo)add(itemSpellCosts(combo,s.sdk.getEquipment(),j.members));if(tele)add(costs(tele.runes));if(back)add(costs(back.runes));
 if((s.sdk.getSkill('Magic')?.level??0)<Math.max(spell.level,combo?.level??0,tele?.level??0,back?.level??0))throw Error('magic bank level short');
 const prepare=async(stop:()=>boolean)=>{if(stop())throw Error('magic trip stopped before preparation');
  if(s.sdk.getState()?.autoRetaliateEnabled!==false){await s.direct({type:'clickComponent',componentId:151,reason:'finite magic trip ownership'});if(!await waitUntil(s,()=>s.sdk.getState()?.autoRetaliateEnabled===false,{timeoutTicks:8}))throw Error('magic trip retaliation unobserved');}
  if(j.protectPrayer!==undefined&&!s.sdk.isPrayerActive(j.protectPrayer)){if(!(await s.sdk.sendTogglePrayer(j.protectPrayer)).success||!await waitUntil(s,()=>s.sdk.isPrayerActive(j.protectPrayer!),{timeoutTicks:8}))throw Error('magic trip protection unobserved');}
 };
 return{inputs,tools:[],outputs:combo?[combo.product]:[],bank:j.bank!,site:j.site??j.bank!,prepare,run:async(n,cap,stop)=>{
  await prepare(stop);
  const guardedStop=()=>stop()||j.protectPrayer!==undefined&&(!s.sdk.isPrayerActive(j.protectPrayer)||(s.sdk.getState()?.prayers.prayerPoints??0)<10);
  let failure='',result:{ok:boolean;casts:number;stop:string;failure:string}|undefined;
  try{result=j.family==='magic-npc'?await runNpcMagic(s,nativeNpcSpell(j.recipe),{npc:j.npc!,casts:n,cap,splashOnly:j.splashOnly,combo,teleport:j.comboTeleport,members:j.members,stop:guardedStop}):await runTeleportMagic(s,nativeTeleport(j.recipe),{casts:n,cap,combo,members:j.members,stop});if(!result.ok||result.casts!==n)failure='bank magic '+result.stop+': '+result.failure;}
  catch(e){failure=String(e);}
  // Return remains authorized after a job stop or failed cast; it cannot start another batch.
  const escape=back??(failure?tele:undefined);if(escape)try{await returnMagicTrip(s,escape,j.members,Math.min(40,j.returnTicks));}catch(e){failure+=[failure?'; ':'',String(e)].join('');}
  if(failure||!result)throw Error(failure||'bank magic result absent');return result.casts;
 }};
}
export async function runMagicBankTrips(s:Session,j:MagicBankJob,stop:()=>boolean=()=>false){
 const profile=magicBankProfile(s,j),prayer=j.protectPrayer===undefined?undefined:s.sdk.isPrayerActive(j.protectPrayer),retaliate=s.sdk.getState()?.autoRetaliateEnabled;if(typeof retaliate!=='boolean')throw Error('magic trip retaliation unknown');
 const names=['Attack','Strength','Defence','Ranged'],before=names.map(n=>s.sdk.getSkillXp(n)??0),result=await runBankProfile(s,j,profile,()=>stop()||j.protectPrayer!==undefined&&(s.sdk.getState()?.prayers.prayerPoints??0)<10);let prayerRestored=j.protectPrayer===undefined||s.sdk.isPrayerActive(j.protectPrayer)===prayer;
 if(result.atBank&&!prayerRestored){await s.sdk.sendTogglePrayer(j.protectPrayer!);prayerRestored=await waitUntil(s,()=>s.sdk.isPrayerActive(j.protectPrayer!)===prayer,{timeoutTicks:8});}
 let restored=s.sdk.getState()?.autoRetaliateEnabled===retaliate;
 if(result.atBank&&!restored){await s.direct({type:'clickComponent',componentId:retaliate?150:151,reason:'restore finite magic trip ownership'});restored=await waitUntil(s,()=>s.sdk.getState()?.autoRetaliateEnabled===retaliate,{timeoutTicks:8});}
 const combatPreserved=names.every((n,i)=>(s.sdk.getSkillXp(n)??0)===before[i]);return{...result,ok:result.ok&&restored&&prayerRestored&&combatPreserved,retaliateRestored:restored,prayerRestored,combatPreserved};
}
if(import.meta.main){const[name,path]=process.argv.slice(2);if(!name||!path)throw Error('usage: microbot-magic-trip.ts account job.json');const job=JSON.parse(readFileSync(path,'utf8'))as MagicBankJob;validateMagicBankJob(job);let stopped=false;const s=await openBot(name,{onStop:async()=>{stopped=true;}});try{const result=await runMagicBankTrips(s,job,()=>stopped||existsSync('.practice/stop-'+name)||existsSync('.practice/stop-all')||existsSync('.practice/stop-microbot-magic')||!!process.env.STOP_FILE&&existsSync(process.env.STOP_FILE));await finish([s],result.ok,JSON.stringify(result));}catch(e){await finish([s],false,String(e));}}
