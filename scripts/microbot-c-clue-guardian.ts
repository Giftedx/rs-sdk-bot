import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,settle} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {nativeClueSteps,nativeCluePoint} from './microbot-c-clues';
import {nativeNpcSpell,runNpcMagic} from './microbot-magic-npc';
import {nativeTeleport,runTeleportMagic} from './microbot-magic-teleport';
import {elementalRuneCost} from './microbot-magic-items';
const root=resolve(import.meta.dir,'../vendor/rs-sdk/server/content');
function pack(file:string){return new Map(readFileSync(resolve(root,'pack',file),'utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(.+)$/);return m?[[m[2]!,Number(m[1])] as const]:[];}));}
export function nativeGuardianClue(id:number){
 const row=nativeClueSteps().find(r=>r.id===id),objs=pack('obj.pack'),npcs=pack('npc.pack'),field=(key:string)=>row?.nativeParams?.find(v=>v.startsWith(key+','))?.slice(key.length+1);
 if(!row||!field('trail_guardian')||!field('trail_coord')||!field('trail_casket'))throw Error('not a native guardian clue');
 const guardian=field('trail_guardian')!,npc=npcs.get(guardian),casket=objs.get(field('trail_casket')!);
 if(!['trail_hard','trail_hard2'].includes(guardian)||npc===undefined||casket===undefined)throw Error('native guardian mapping unresolved');
 return{id,name:row.name,guardian,npc,casket,point:nativeCluePoint(field('trail_coord')!),tools:['spade','trail_watch','trail_chart','trail_sextant'].map(n=>objs.get(n)!),source:row.source,line:row.line};
}
type Options={spell:string;maximumCasts:number;cap:number;stop?:()=>boolean};
type NativeIO={cast:(remaining:number)=>Promise<{ok:boolean;failure?:string}>;escape:()=>Promise<{ok:boolean;failure?:string}>};
// One staged guardian only. Existing standard-magic primitive rejects all HP
// damage. Any damage triggers bounded food/Varrock recovery, never another cast.
// A casket from the second dig proves native hero credit without reading varps.
export async function runGuardianClue(s:Session,id:number,o:Options,io?:NativeIO){
 if(!Number.isSafeInteger(o.maximumCasts)||o.maximumCasts<1||o.maximumCasts>40||!Number.isSafeInteger(o.cap)||o.cap<30||o.cap>400)throw Error('guardian cap30..400 and casts1..40 required');
 const r=nativeGuardianClue(id),spell=nativeNpcSpell(o.spell),tele=nativeTeleport('varrock');if(spell.debuff)throw Error('guardian requires damaging standard spell');
 const st=()=>s.sdk.getState(),player=()=>st()?.player,inv=()=>s.sdk.getInventory(),count=(n:number)=>inv().filter(i=>i.id===n).reduce((v,i)=>v+i.count,0),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
 const initial=player(),initialHp=hp(),own=(s.client as any)?.selfSlot,start=s.tick(),initialClue=count(id),initialCasket=count(r.casket),prayerBefore=s.sdk.isPrayerActive(12),xp0=s.sdk.getSkillXp('Magic')??0;
 const gear=s.sdk.getEquipment().map(i=>({id:i.id,slot:i.slot,count:i.count})),stock=new Map(inv().map(i=>[i.id,count(i.id)]));
 if(!initial||!Number.isSafeInteger(own)||initialHp<70||(s.sdk.getSkill('Prayer')?.level??0)<40||(s.sdk.getSkill('Magic')?.level??0)<Math.max(spell.level,tele.level)||st()?.autoRetaliateEnabled!==false)throw Error('stage HP70, Prayer40, spell level, native owner and auto-retaliate off');
 let ended=false;void s.ended?.then(()=>{ended=true;});const life=initial.lifeId,respawns=initial.respawnCount??0;
 const foreign=()=>st()?.nearbyPlayers.some(p=>p.name.toLowerCase()!==initial.name.toLowerCase())??true;
 const unsafe=()=>ended||!!o.stop?.()||(!!process.env.STOP_FILE&&existsSync(process.env.STOP_FILE))||!player()||player()!.isDead||player()!.lifeId!==life||(player()!.respawnCount??0)>respawns||hp()<initialHp||foreign();
 const over=()=>unsafe()||s.tick()-start>=o.cap;
 const atDig=()=>{const p=player();return!!p&&p.level===r.point.level&&Math.max(Math.abs(p.worldX-r.point.x),Math.abs(p.worldZ-r.point.z))<=1;};
 const converted=()=>initialClue-count(id)===1&&count(r.casket)-initialCasket===1;
 let index:number|undefined,casts=0,detail='',escaped=false,owned=false,prayerRestored=false,antidote=false,foodEaten=0,engaged=false;
 const allGuardIds=[pack('npc.pack').get('trail_hard')!,pack('npc.pack').get('trail_hard2')!];
 const guard=()=>st()?.nearbyNpcs.find(n=>n.index===index&&n.id===r.npc);
 const nativeIO:NativeIO=io??{cast:remaining=>runNpcMagic(s,spell,{npc:r.npc,casts:1,cap:remaining,members:true,stop:over}),escape:()=>runTeleportMagic(s,tele,{casts:1,cap:35,members:true,stop:()=>ended||!!player()?.isDead||player()?.lifeId!==life})};
 const dig=async()=>{const item=inv().find(i=>i.id===r.tools[0]);if(!item)throw Error('guardian spade unavailable');await s.sdk.sendUseItem(item.slot,1);};
 try{
  if(!atDig()||foreign()||initialClue!==1||r.tools.some(n=>count(n)<1)||inv().length>19||count(379)<4||!gear.some(i=>i.slot===3)||!gear.some(i=>i.slot===5))throw Error('stage isolated exact dig tile, one clue, instruments, weapon/shield, four lobsters and nine free slots');
  if(st()?.nearbyNpcs.some(n=>allGuardIds.includes(n.id)))throw Error('existing guardian makes spawn ownership ambiguous');
  const runeNeeds:Record<number,number>={};for(const [key,units] of Object.entries(spell.runes)){const rune=Number(key);runeNeeds[rune]=(runeNeeds[rune]??0)+elementalRuneCost(rune,units,gear,true)*o.maximumCasts;}
  for(const [key,units] of Object.entries(tele.runes)){const rune=Number(key);runeNeeds[rune]=(runeNeeds[rune]??0)+elementalRuneCost(rune,units,gear,true);}
  if(Object.entries(runeNeeds).some(([n,c])=>count(Number(n))<c))throw Error('stage full cast budget plus reserved Varrock recovery runes');
  if(r.guardian==='trail_hard2'){
   const potion=inv().find(i=>i.id===2448),before=count(181);if(!potion)throw Error('stage Superantipoison(4) for native Saradomin poison');
   const old=count(2448);await s.sdk.sendUseItem(potion.slot,1);if(!await waitUntil(s,()=>count(2448)===old-1&&count(181)===before+1||over(),{timeoutTicks:8})||count(2448)!==old-1||count(181)!==before+1)throw Error('superantipoison dose conversion unobserved');antidote=true;
   // Native immunity20 * poison timer30 =600ticks; this order caps at400.
   await waitTicks(s,3);
  }
  if(!prayerBefore){const p=await s.bot.activatePrayer(12);if(!p.success||!s.sdk.isPrayerActive(12))throw Error('Protect from Magic unobserved');}
  if(over())throw Error('guardian stopped before dig');engaged=true;await dig();
  await waitUntil(s,()=>converted()||st()?.nearbyNpcs.some(n=>n.id===r.npc&&n.targetIndex===32768+own)||over(),{timeoutTicks:10});
  if(!converted()){
   const spawned=st()?.nearbyNpcs.filter(n=>allGuardIds.includes(n.id))??[];
   if(spawned.length!==1||spawned[0]!.id!==r.npc||spawned[0]!.targetIndex!==32768+own)throw Error('new unique guardian target ownership unobserved');index=spawned[0]!.index;owned=true;
   while(!over()&&guard()&&guard()!.hp!==0&&casts<o.maximumCasts){
    if(guard()!.targetIndex!==32768+own)throw Error('guardian changed target ownership');
    if(!s.sdk.isPrayerActive(12)||(s.sdk.getSkill('Prayer')?.level??0)<5)throw Error('guardian protection/points exhausted');
    const result=await nativeIO.cast(Math.min(60,Math.max(1,o.cap-(s.tick()-start))));casts++;
    if(!result.ok&&guard()&&guard()!.hp!==0)throw Error('guardian native cast failed: '+(result.failure??'no receipt'));
   }
   if(over())throw Error('guardian stop/damage/foreign player/tick budget');
   if(guard()&&guard()!.hp!==0)throw Error('guardian cast budget exhausted');
   await waitUntil(s,()=>!guard()||over(),{timeoutTicks:12});if(over())throw Error('guardian death settlement stopped');
   if(!atDig())throw Error('guardian moved player off exact staged dig tile');await dig();
   await waitUntil(s,()=>converted()||over(),{timeoutTicks:10});if(!converted())throw Error('repeat dig native hero/casket receipt unconfirmed');
  }
 }catch(error){detail=String(error);}
 finally{
  if(!engaged){
   if(!prayerBefore&&s.sdk.isPrayerActive(12)){try{const p=await s.bot.deactivatePrayer(12);prayerRestored=p.success&&!s.sdk.isPrayerActive(12);}catch(error){detail ||= String(error);}}
   else prayerRestored=s.sdk.isPrayerActive(12)===prayerBefore;
  }else if(!ended&&player()&&!player()!.isDead&&player()!.lifeId===life){
   // Heal once for bounded recovery only; never resume the fight after damage.
   if(hp()<initialHp&&count(379)>0){const old=count(379),h=hp();try{await s.bot.eatFood(/^lobster$/i);await waitUntil(s,()=>count(379)===old-1&&hp()>h||ended,{timeoutTicks:6});foodEaten=old-count(379);}catch(error){detail ||= String(error);}}
   try{const result=await nativeIO.escape();const p=player();escaped=result.ok&&!!p&&p.level===tele.to.level&&Math.max(Math.abs(p.worldX-tele.to.x),Math.abs(p.worldZ-tele.to.z))<=2;if(!escaped)detail ||= 'guardian Varrock recovery unconfirmed';}catch(error){detail ||= String(error);}
   if(escaped){if(!prayerBefore){try{const p=await s.bot.deactivatePrayer(12);prayerRestored=p.success&&!s.sdk.isPrayerActive(12);}catch(error){detail ||= String(error);}}else prayerRestored=s.sdk.isPrayerActive(12);}
  }
 }
 const runes=new Set([...Object.keys(spell.runes),...Object.keys(tele.runes)].map(Number));const exempt=new Set([id,r.casket,379,...runes,...(antidote?[2448,181]:[])]);
 const preserved=[...stock].every(([id,n])=>exempt.has(id)||count(id)===n)&&gear.every(g=>s.sdk.getEquipment().some(i=>i.slot===g.slot&&i.id===g.id&&i.count===g.count));
 const cancelled=!!o.stop?.()||(!!process.env.STOP_FILE&&existsSync(process.env.STOP_FILE));
 return{ok:!cancelled&&!ended&&player()?.lifeId===life&&!player()?.isDead&&!detail&&converted()&&preserved&&escaped&&prayerRestored,clue:r.name,guardian:r.guardian,owned,casts,casket:converted(),escaped,prayerRestored,preserved,antidote,foodEaten,magicXp:(s.sdk.getSkillXp('Magic')??0)-xp0,ticks:s.tick()-start,detail,cancelled,scope:'one staged guardian; any HP damage aborts combat; hidden hero flag proved only by repeat-dig casket; no route or practice qualification'};
}
if(import.meta.main){
 const name=process.argv[2]??'',id=Number(process.argv[3]),spell=process.argv[4]??'fire_blast',maximumCasts=Number(process.argv[5]??30),cap=Number(process.argv[6]??350);if(!name||!Number.isSafeInteger(id))throw Error('Usage (members): bun scripts/microbot-c-clue-guardian.ts <account> <native-clue-id> [standard-damage-spell] [max-casts] [ticks]');let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(name);let ok=false;try{const r=await runGuardianClue(s,id,{spell,maximumCasts,cap,stop:()=>stopped});console.log('NATIVE_GUARDIAN_RESULT '+JSON.stringify(r));ok=r.ok;}finally{ok=await settle([s],ok,'finite native guardian clue');}process.exitCode=ok?0:1;
}
