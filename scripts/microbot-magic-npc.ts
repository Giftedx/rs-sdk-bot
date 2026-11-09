// Behaviour source: pinned Microbot-Hub; BSD notice: research/microbot-ports-LICENSE.txt.
// Finite staged standard-book casts: bun scripts/microbot-magic-npc.ts <account> <spell> <npc-id> [casts=1] [cap=1200].
// COMBO_ALCH=high-alch|low-alch, ALCH_ITEM=debugname; SPLASH_ONLY=1 requires no Hitpoints XP after impact.
// Debuffed/frozen targets can refuse repeat casts. Rotate observed targets, then stop after bounded no-effect attempts.
import {readFileSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import type {NearbyNpc} from '../vendor/rs-sdk/sdk/types';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {componentId} from '../packages/core/src/logout';
import {objId} from './measure/floor-bands';
import {nativeTeleport,runTeleportMagic,magicStopRequested} from './microbot-magic-teleport';
import {elementalRuneCost,itemMagicRecipe,runItemMagic,type Recipe} from './microbot-magic-items';
export interface NpcSpell{name:string;component:string;level:number;runes:Record<number,number>;debuff:boolean;members:boolean;requiredWorn?:number}
export function nativeNpcSpell(name:string):NpcSpell{
 if(!/^(?:(?:wind|water|earth|fire)_(?:strike|bolt|blast|wave)|confuse|weaken|curse|vulnerability|enfeeble|stun|bind|snare|entangle|crumble_undead|saradomin_strike|claws_of_guthix|flames_of_zamorak|iban_blast)$/.test(name))throw Error('unsupported standard NPC spell');
 const text=readFileSync('vendor/rs-sdk/server/content/scripts/skill_combat/configs/magic/magic_combat_spells.dbrow','utf8');
 const body=text.split('[magic_spell_'+name+']')[1]?.split('\n[')[0];if(!body)throw Error('native NPC spell missing');
 const field=(key:string)=>body.match(new RegExp('^data='+key+',(.+)$','m'))?.[1]?.trim();
 const runes=field('runesrequired')!.split(','),costs:Record<number,number>={};for(let i=0;i<runes.length;i+=2)if(runes[i]!=='null')costs[objId(runes[i]!)]=Number(runes[i+1]);
 const worn=field('wornrequired');return{name,component:field('spellcom')!,level:Number(field('levelrequired')),runes:costs,debuff:/stat_change|freeze_time/.test(body),members:field('members')==='true',...(worn&&worn!=='null'?{requiredWorn:objId(worn)}:{})};
}
export function selectMagicTarget(npcs:readonly NearbyNpc[],id:number,avoid:ReadonlySet<number>,own:number,ownedPassiveTarget?:(target:NearbyNpc)=>boolean){
 return npcs.filter(n=>n.id===id&&!avoid.has(n.index)&&(n.hp===null||n.hp>0)&&n.reachable!==false&&(!n.inCombat||n.targetIndex===32768+own||n.targetIndex===-1&&ownedPassiveTarget?.(n)===true)&&n.optionsWithIndex.some(o=>/^attack$/i.test(o.text))).sort((a,b)=>a.distance-b.distance)[0];
}
export function npcCastEffect(costs:Record<number,number>,before:Record<number,number>,after:Record<number,number>,xp0:number,xp1:number,environment:Readonly<Record<number,number>>={}){
 if(Object.entries(environment).some(([id,n])=>!Number.isSafeInteger(+id)||+id<0||!Number.isSafeInteger(n)||n!==0&&Object.hasOwn(costs,id)))return 'invalid';
 const keys=new Set([...Object.keys(before),...Object.keys(after),...Object.keys(costs),...Object.keys(environment)]);
 if([...keys].every(k=>(before[Number(k)]??0)===(after[Number(k)]??0)-(environment[Number(k)]??0))&&xp0===xp1)return 'none';
 return xp1>xp0&&[...keys].every(k=>(before[Number(k)]??0)-(after[Number(k)]??0)===(costs[Number(k)]??0)-(environment[Number(k)]??0))?'cast':'invalid';
}
export async function runNpcMagic(s:Session,spell:NpcSpell,o:{npc:number;casts:number;cap:number;splashOnly?:boolean;combo?:Recipe;teleport?:string;members?:boolean;hpFloor?:number;stop?:()=>boolean;environmentDelta?:()=>Readonly<Record<number,number>>;ownedPassiveTarget?:(target:NearbyNpc)=>boolean}){
 if(![o.npc,o.casts,o.cap].every(Number.isSafeInteger)||o.npc<0||o.casts<1||o.casts>1000||o.cap<1||o.cap>100000)throw Error('invalid finite NPC magic limits');
 const st=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),xp=()=>s.sdk.getSkillXp('Magic')??0,hpxp=()=>s.sdk.getSkillXp('Hitpoints')??0,hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
 const counts=()=>{const r:Record<number,number>={};for(const i of inv())r[i.id]=(r[i.id]??0)+i.count;return r;};
 if(spell.members&&!o.members)throw Error('member NPC spell requires explicit member batch scope');
 const checkWorn=()=>{if(spell.requiredWorn!==undefined&&!s.sdk.getEquipment().some(i=>i.slot===3&&i.id===spell.requiredWorn))throw Error('NPC spell requires worn staff '+spell.requiredWorn);};checkWorn();
 const p0=st()?.player,hp0=hp(),own=(s.client as {selfSlot?:number}|undefined)?.selfSlot;
 if(!p0||hp0<10||!Number.isInteger(own)||(s.sdk.getSkill('Magic')?.level??0)<spell.level)throw Error('NPC magic player/skill/owner state unknown');
 const hpFloor=o.hpFloor??hp0;if(!Number.isSafeInteger(hpFloor)||hpFloor<10||hpFloor>hp0)throw Error('NPC magic HP floor must be integer10..initialHP');
 const life0=p0.lifeId,respawns0=p0.respawnCount??0,level0=p0.level,x0=p0.worldX,z0=p0.worldZ;
 // attackstyle_magic is transmitted varp108. Native mode3 can enqueue
 // repeat casts during the receipt/cooldown wait, outside this finite batch.
 const autocastMode=(s.client as {var?:number[]}|undefined)?.var?.[108];
 if(!Number.isSafeInteger(autocastMode))throw Error('NPC magic autocast mode unknown');
 if(autocastMode===3)throw Error('disable native autocast before finite NPC magic');
 const teleport=o.teleport?nativeTeleport(o.teleport):undefined;if(teleport?.members&&!o.members)throw Error('member combo teleport requires member scope');
 const start=s.tick(),xp0=xp(),hpxp0=hpxp(),avoid=new Set<number>();let ended=false,casts=0,combos=0,attempts=0,failure='',stop='target';const environmentReceipts:{before:Record<number,number>;after:Record<number,number>;delta:Record<number,number>}[]=[];void s.ended.then(()=>{ended=true;});
 const unsafe=()=>{const p=st()?.player;return !p||p.isDead||p.lifeId!==life0||(p.respawnCount??0)>respawns0||hp()<hpFloor||!((p.level===level0&&Math.max(Math.abs(p.worldX-x0),Math.abs(p.worldZ-z0))<=10)||(teleport&&p.level===teleport.to.level&&Math.max(Math.abs(p.worldX-teleport.to.x),Math.abs(p.worldZ-teleport.to.z))<=10));};
 const over=()=>ended||unsafe()||!!o.stop?.()||s.tick()-start>=o.cap;
 const rest=async(n:number)=>{for(let i=0;i<n&&!over();i++)await waitTicks(s,1);};
 try{
 while(casts<o.casts&&attempts<o.casts*3&&!over()){
  checkWorn();
  await s.bot.dismissBlockingUI();if(over())break;
  const target=selectMagicTarget(st()?.nearbyNpcs??[],o.npc,avoid,own!,o.ownedPassiveTarget);if(!target){stop='no eligible target';break;}
  const costs=Object.fromEntries(Object.entries(spell.runes).map(([id,n])=>[id,elementalRuneCost(Number(id),n,s.sdk.getEquipment(),o.members??false)])) as Record<number,number>;
  const environmentBefore={...o.environmentDelta?.()},before=counts(),x0=xp(),hpXp0=hpxp();if(Object.entries(costs).some(([id,n])=>(before[Number(id)]??0)<n)){stop='runes';break;}
  if(target.inCombat&&target.targetIndex===-1){const current=st()?.nearbyNpcs.find(n=>n.index===target.index);if(!current||current.id!==target.id||current.targetIndex!==-1||!o.ownedPassiveTarget?.(current))throw Error('NPC passive target ownership changed before cast');}
  attempts++;
  const result=await s.direct({type:'spellOnNpc',npcIndex:target.index,spellComponent:componentId(spell.component),reason:'SDK'}) as {success?:boolean};if(result?.success===false)throw Error('NPC spell dispatch refused');
  await waitUntil(s,()=>over()||xp()!==x0||Object.keys(costs).some(id=>(counts()[Number(id)]??0)!==(before[Number(id)]??0)),{timeoutTicks:Math.min(12,Math.max(1,o.cap-(s.tick()-start)))});
  await rest(1);const environmentAfter=o.environmentDelta?.()??{},environment=Object.fromEntries([...new Set([...Object.keys(environmentBefore),...Object.keys(environmentAfter)])].map(k=>[k,(environmentAfter[+k]??0)-(environmentBefore[+k]??0)])),after=counts(),effect=npcCastEffect(costs,before,after,x0,xp(),environment);if(o.environmentDelta)environmentReceipts.push({before,after,delta:environment});
  if(effect==='none'){if(Object.values(environment).some(Boolean))throw Error('known environment settled without cast receipt; no repeated input');avoid.add(target.index);continue;}if(effect!=='cast')throw Error('NPC spell debit/XP mismatch');
  casts++;await rest(8); // settle projectile impact and standard five-tick action cooldown
  if(o.splashOnly&&hpxp()!==hpXp0)throw Error('splash-only cast dealt damage');
  if(o.combo&&!over()){
   const r=await runItemMagic(s,o.combo,{count:1,cap:Math.max(1,o.cap-(s.tick()-start)),members:o.members,stop:over});if(!r.ok)throw Error('combo item cast '+r.stop);combos++;await rest(6);
  }
  if(teleport&&!over()){const r=await runTeleportMagic(s,teleport,{casts:1,cap:Math.max(1,o.cap-(s.tick()-start)),members:o.members,stop:over});if(!r.ok)throw Error('NPC teleport combo '+r.stop);await rest(6);}
  console.log('NPC_MAGIC_CAST '+JSON.stringify({casts,combos,target:target.index,spell:spell.name,tick:s.tick()}));
 }
 if(casts!==o.casts&&stop==='target')stop=over()?'stopped/cap':'attempt budget';
 }catch(e){failure=String(e);stop='failure';}
 return{ok:!failure&&!over()&&casts===o.casts&&(!o.combo||combos===casts),stop,failure,casts,combos,attempts,magicXp:xp()-xp0,hitpointsXp:hpxp()-hpxp0,ticks:s.tick()-start,environmentReceipts};
}
if(import.meta.main){let s:Session|undefined,stopped=false;try{const [account,name,npc,casts,cap]=process.argv.slice(2);if(!account||!name||npc===undefined)throw Error('account, native spell and NPC ID required');const spell=nativeNpcSpell(name),combo=process.env.COMBO_ALCH?itemMagicRecipe(process.env.COMBO_ALCH,process.env.ALCH_ITEM):undefined;s=await openBot(account,{onStop:async()=>{stopped=true;}});const r=await runNpcMagic(s,spell,{npc:Number(npc),casts:Number(casts??1),cap:Number(cap??1200),splashOnly:process.env.SPLASH_ONLY==='1',combo,teleport:process.env.COMBO_TELEPORT,members:process.env.MEMBERS==='1',stop:()=>magicStopRequested(account,stopped)});console.log('NPC_MAGIC_RESULT '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));}catch(e){await finish(s?[s]:[],false,String(e));}}
