import {readFileSync} from 'node:fs';
import{productionStopRequested as guardianStopRequested}from'./microbot-c-lifetime';
import {resolve} from 'node:path';
import {openBot,settle} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {nativeClueSteps,nativeCluePoint} from './microbot-c-clues';
import {nativeNpcSpell,runNpcMagic} from './microbot-magic-npc';
import {nativeTeleport} from './microbot-magic-teleport';
import {guardianWalk,setupSaradominMage,recoverGuardian,guardianSaraLandingTail} from './microbot-c-clue-guardian-travel';
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
// Native swamp_decay.rs2 checks this inclusive surface zone and owned sickle.
export function guardianSwampPoint(p:{x:number;z:number;level:number}){return p.level===0&&p.x>=3392&&p.x<=3519&&p.z>=3328&&p.z<=3455;}
export function guardianFoodRotEffect(before:readonly{id:number;count:number}[],after:readonly{id:number;count:number}[],w:{freshSystem:boolean;nativeGhast:boolean;sameHpXpGear:boolean;sameLifeOwner:boolean;pairedAntidote?:boolean}){
 if(!w.freshSystem||!w.nativeGhast||!w.sameHpXpGear||!w.sameLifeOwner)return false;
 const sums=(rows:readonly{id:number;count:number}[])=>{const v:Record<number,number>={};for(const r of rows)v[r.id]=(v[r.id]??0)+r.count;return v;},b=sums(before),a=sums(after);
 return [...new Set([...Object.keys(b),...Object.keys(a)])].every(k=>(a[+k]??0)-(b[+k]??0)===(+k===379?-1:+k===2959?1:w.pairedAntidote&&+k===2448?-1:w.pairedAntidote&&+k===181?1:0));
}
type Options={spell:string;maximumCasts:number;cap:number;ambientDamage?:number;stop?:()=>boolean};
export{guardianStopRequested};
export async function guardianAntidote(s:Session,stop:()=>boolean,environment?:{delta:()=>Record<number,number>;onAttempt:(v:{slot:number;cursor:number;tick:number})=>void}){
 const state=()=>s.sdk.getState(),pack=()=>s.sdk.getInventory().map(i=>({id:i.id,count:i.count,slot:i.slot})).sort((a,b)=>a.slot-b.slot),initial=pack(),p0=state()?.player,life=p0?.lifeId,respawns=p0?.respawnCount??0,hp0=s.sdk.getSkill('Hitpoints')?.level??0,start=s.tick();
 const row=initial.find(i=>i.id===2448),cursor=Math.max(0,...(state()?.gameMessages??[]).map(m=>Number.isSafeInteger(m.observationId)?m.observationId!:0));
 const result={confirmed:false,unknown:false,attempted:false,paid:false,dispatch:'',detail:''};
 const guard=()=>{const p=state()?.player;if(stop()||!p||p.isDead||!Number.isSafeInteger(life)||p.lifeId!==life||(p.respawnCount??0)!==respawns||hp0<1||(s.sdk.getSkill('Hitpoints')?.level??0)!==hp0||s.sdk.getStateAge()>5000)throw Error('guardian antidote stop/original life/HP/state');};
 try{
  guard();if(!row||row.count!==1||!Number.isSafeInteger(row.slot))throw Error('stage Superantipoison(4) for native Saradomin poison');
  const expected=initial.map(i=>i.slot===row.slot?{...i,id:181}:i),same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),matches=(base:typeof initial)=>{const delta=environment!.delta(),sum=(rows:typeof initial)=>{const v:Record<number,number>={};for(const i of rows)v[i.id]=(v[i.id]??0)+i.count;return v;},b=sum(base),a=sum(pack());return[...new Set([...Object.keys(b),...Object.keys(a),...Object.keys(delta)])].every(k=>(a[+k]??0)-(b[+k]??0)===(delta[+k]??0));},paired=()=>environment?matches(expected)&&pack().some(i=>i.slot===row.slot&&i.id===181):same(pack(),expected);
  const messages=()=>state()?.gameMessages?.filter(m=>m.type===0&&m.sender===''&&m.fromSelf===false&&Number.isSafeInteger(m.observationId)&&m.observationId!>cursor&&m.tick>=start&&m.tick<=s.tick())??[];
  const began=()=>messages().find(m=>m.text==='You drink some of your antipoison potion.'),complete=()=>messages().some(m=>m.text==='You have 3 doses of potion left.'&&m.observationId!>(began()?.observationId??cursor));
  const checkPack=()=>{const actual=pack();if(environment?!matches(initial)&&!paired():!same(actual,initial)&&!same(actual,expected))throw Error('guardian antidote unrelated or wrong pack conversion');};
  guard();result.attempted=true;environment?.onAttempt({slot:row.slot,cursor,tick:start});
  try{const sent=await s.sdk.sendUseItem(row.slot,1);result.dispatch=sent.success?'acknowledged':'unknown: '+sent.message;}catch(error){result.dispatch='unknown: '+String(error);}
  // A dispatch reply is not native acceptance. The eight-tick admission is unchanged.
  const admitted=await waitUntil(s,()=>{guard();checkPack();return !!began()||paired();},{timeoutTicks:8});
  guard();checkPack();if(!admitted||!began()&&!paired())throw Error('guardian antidote native start unobserved; outcome unknown; no retry');
  // Native antipoison messages delay one tick; inventory can publish on the
  // following PLAYER_INFO. Only a witnessed start authorizes this two-tick tail.
  const settled=()=>{guard();checkPack();return paired()&&complete();};
  if(!settled()&&!await waitUntil(s,settled,{timeoutTicks:2})||!settled())throw Error('guardian antidote witnessed start settlement unconfirmed; no retry');
  result.paid=true;result.confirmed=true;return result;
 }catch(error){result.paid=!!row&&pack().some(i=>i.slot===row.slot&&i.id===181)&&!pack().some(i=>i.slot===row.slot&&i.id===2448);result.unknown=result.attempted;result.detail=String(error);return result;}
}
type NativeIO={setup?:()=>Promise<void>;cast:(remaining:number)=>Promise<{ok:boolean;failure?:string}>;escape:()=>Promise<{ok:boolean;failure?:string}>};
// Staged owned guardian: Sara AP setup precedes casting. A declared ambient
// HP budget keeps an HP70 minimum; the default permits no fighting HP loss.
// Native Wilderness legality and a separate finite budget govern recovery.
// A casket from the second dig proves native hero credit without reading varps.
export async function runGuardianClue(s:Session,id:number,o:Options,io?:NativeIO){
 if(!Number.isSafeInteger(o.maximumCasts)||o.maximumCasts<1||o.maximumCasts>40||!Number.isSafeInteger(o.cap)||o.cap<30||o.cap>400)throw Error('guardian cap30..400 and casts1..40 required');
 const ambientDamage=o.ambientDamage??0;if(!Number.isSafeInteger(ambientDamage)||ambientDamage<0||ambientDamage>24)throw Error('guardian declared ambient HP budget must be0..24');
 const r=nativeGuardianClue(id),spell=nativeNpcSpell(o.spell),tele=nativeTeleport('varrock');if(spell.debuff)throw Error('guardian requires damaging standard spell');
 const st=()=>s.sdk.getState(),player=()=>st()?.player,inv=()=>s.sdk.getInventory(),count=(n:number)=>inv().filter(i=>i.id===n).reduce((v,i)=>v+i.count,0),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
 const initialClient=s.client,initialExecutor=(s.client as any).executeBotAction,initial=player(),initialHp=hp(),own=(s.client as any)?.selfSlot,start=s.tick(),initialClue=count(id),initialCasket=count(r.casket),prayerBefore=s.sdk.isPrayerActive(12),xp0=s.sdk.getSkillXp('Magic')??0;
 const gear=s.sdk.getEquipment().map(i=>({id:i.id,slot:i.slot,count:i.count})),initialPack=inv().map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot),stock=new Map(inv().map(i=>[i.id,count(i.id)]));
 if(!initial||!Number.isSafeInteger(own)||initialHp<70||(s.sdk.getSkill('Prayer')?.level??0)<40||(s.sdk.getSkill('Magic')?.level??0)<Math.max(spell.level,tele.level)||st()?.autoRetaliateEnabled!==false)throw Error('stage HP70, Prayer40, spell level, native owner and auto-retaliate off');
 if(ambientDamage&&initialHp<70+ambientDamage)throw Error('guardian initial HP cannot fund declared ambient damage and HP70 floor');
 let ended=false;void s.ended?.then(()=>{ended=true;});const life=initial.lifeId,respawns=initial.respawnCount??0,initialPlane=initial.level;let phase:'setup'|'fight'|'return'='setup',fightHp=initialHp,fightHpLowest=initialHp;
 const foreign=()=>st()?.nearbyPlayers.some(p=>p.name.toLowerCase()!==initial.name.toLowerCase())??true;
 const fightHpFloor=()=>ambientDamage?Math.max(70,fightHp-ambientDamage):fightHp;
 const unsafe=()=>{const health=hp();if(phase==='fight')fightHpLowest=Math.min(fightHpLowest,health);return ended||!!rotFailure||guardianStopRequested(s.name,o.stop)||!player()||player()!.isDead||player()!.lifeId!==life||(player()!.respawnCount??0)>respawns||health<(phase==='fight'?fightHpFloor():35)||foreign();};
 const over=()=>unsafe()||s.tick()-start>=o.cap;
 const fatal=()=>ended||!player()||!!player()?.isDead||player()?.lifeId!==life||(player()?.respawnCount??0)>respawns||hp()<1;
 const atDig=()=>{const p=player();return!!p&&p.level===r.point.level&&Math.max(Math.abs(p.worldX-r.point.x),Math.abs(p.worldZ-r.point.z))<=1;};
 const converted=()=>initialClue-count(id)===1&&count(r.casket)-initialCasket===1;
 let rotFailure='',foodRot=0,doseAttempt:{slot:number;cursor:number;tick:number}|undefined,pendingRot:{before:ReturnType<typeof rotSnapshot>;after:ReturnType<typeof rotSnapshot>;slot:number;message:number;start:number;startId:number}|undefined;const rotReceipts:{tick:number;slot:number;message:number}[]=[];
 let index:number|undefined,casts=0,detail='',escaped=false,owned=false,prayerRestored=false,antidote=false,antidoteReceipt:Awaited<ReturnType<typeof guardianAntidote>>|undefined,foodEaten=0,engaged=false;
 const allGuardIds=[pack('npc.pack').get('trail_hard')!,pack('npc.pack').get('trail_hard2')!];
 const guard=()=>st()?.nearbyNpcs.find(n=>n.index===index&&n.id===r.npc);
 const rotSnapshot=()=>({pack:inv().map(i=>({...i})),hp:hp(),xp:JSON.stringify(st()?.skills?.map(k=>k.experience)??[s.sdk.getSkillXp('Magic')]),gear:JSON.stringify(s.sdk.getEquipment()),tick:s.tick(),cursor:Math.max(-1,...(st()?.gameMessages??[]).map(m=>m.observationId??-1))});let priorRot=rotSnapshot();
 const doseMessages=()=>st()?.gameMessages.filter(m=>m.type===0&&m.sender===''&&m.fromSelf===false&&Number.isSafeInteger(m.observationId)&&!!doseAttempt&&m.observationId!>doseAttempt.cursor&&m.tick>=doseAttempt.tick&&m.tick<=s.tick())??[];
 const observeRot=()=>{const now=rotSnapshot(),total=(rows:readonly{id:number;count:number}[],id:number)=>rows.filter(r=>r.id===id).reduce((n,r)=>n+r.count,0),sameOrigin=()=>s.client===initialClient&&(s.client as any).executeBotAction===initialExecutor&&!fatal()&&!foreign()&&s.sdk.getStateAge()<=5000&&guardianSwampPoint({x:player()!.worldX,z:player()!.worldZ,level:player()!.level}),sameState=(a:typeof now,b:typeof now)=>a.hp===b.hp&&a.xp===b.xp&&a.gear===b.gear;
  if(pendingRot){const done=doseMessages().some(m=>m.observationId!>pendingRot!.startId&&m.text==='You have 3 doses of potion left.');if(!sameOrigin()||!sameState(pendingRot.before,now)||JSON.stringify(now.pack)!==JSON.stringify(pendingRot.after.pack)||s.tick()-pendingRot.start>2)rotFailure='guardian composed dose/rot settlement changed or unconfirmed';else if(done){foodRot++;rotReceipts.push({tick:s.tick(),slot:pendingRot.slot,message:pendingRot.message});pendingRot=undefined;}priorRot=now;return;}
  if(total(now.pack,2959)!==total(priorRot.pack,2959)){
   const message=st()?.gameMessages.find(m=>m.type===0&&m.sender===''&&m.fromSelf===false&&Number.isSafeInteger(m.observationId)&&m.observationId!>priorRot.cursor&&m.tick>=priorRot.tick&&m.tick<=s.tick()&&m.text==='You feel something attacking your backpack, and smell a terrible stench.'),client=s.client as any,nativeGhast=!!st()?.nearbyNpcs.some(n=>n.id===1052&&n.distance<=1&&n.animId===1093&&client.npc?.[n.index]?.type?.id===1052),witness={freshSystem:!!message,nativeGhast,sameHpXpGear:sameState(now,priorRot),sameLifeOwner:sameOrigin()},startDose=doseMessages().find(m=>m.text==='You drink some of your antipoison potion.'),pairedDose=!!doseAttempt&&priorRot.pack.some(i=>i.slot===doseAttempt!.slot&&i.id===2448)&&now.pack.some(i=>i.slot===doseAttempt!.slot&&i.id===181)&&!!startDose;
   const ordinary=guardianFoodRotEffect(priorRot.pack,now.pack,witness),composed=pairedDose&&guardianFoodRotEffect(priorRot.pack,now.pack,{...witness,pairedAntidote:true});
   if(foodRot>=Math.max(0,(stock.get(379)??0)-1)||!ordinary&&!composed)rotFailure='guardian unconfirmed or additional native food rot';
   else{const row=now.pack.find(i=>i.id===2959&&!priorRot.pack.some(b=>b.slot===i.slot&&b.id===2959));if(!row)rotFailure='guardian ambiguous rotten-food slot';else if(composed&&!doseMessages().some(m=>m.observationId!>startDose!.observationId!&&m.text==='You have 3 doses of potion left.'))pendingRot={before:priorRot,after:now,slot:row.slot,message:message!.observationId!,start:s.tick(),startId:startDose!.observationId!};else{foodRot++;rotReceipts.push({tick:s.tick(),slot:row.slot,message:message!.observationId!});}}
  }priorRot=now;
 };
 const knownRotDelta=():Record<number,number>=>{observeRot();if(rotFailure)throw Error(rotFailure);const n=foodRot+(pendingRot?1:0);return n?{379:-n,2959:n}:{};};
 const offRot=guardianSwampPoint(r.point)?s.onTick(observeRot):()=>{};
 const nativeIO:NativeIO=io??{cast:remaining=>runNpcMagic(s,spell,{npc:r.npc,casts:1,cap:remaining,members:true,...guardianSwampPoint(r.point)?{environmentDelta:knownRotDelta}:{},...ambientDamage?{hpFloor:fightHpFloor()}:{},stop:over}),escape:()=>recoverGuardian(s,tele,{fatal,...(r.guardian==='trail_hard2'?{landingTail:guardianSaraLandingTail()}:{})},500)};
 const dig=async()=>{if(over())throw Error('guardian stopped before dig input');const item=inv().find(i=>i.id===r.tools[0]);if(!item)throw Error('guardian spade unavailable');if(over())throw Error('guardian stopped before dig input');await s.sdk.sendUseItem(item.slot,1);};
 try{
  if(over())throw Error('guardian stopped before preparation');
  if(guardianSwampPoint(r.point)&&count(2963)<1)throw Error('acquire and stage owned blessed Silver sickle2963 for native swamp decay');
  if(!atDig()||foreign()||initialClue!==1||r.tools.some(n=>count(n)<1)||inv().length>19||count(379)<4||!gear.some(i=>i.slot===3)||!gear.some(i=>i.slot===5))throw Error('stage isolated exact dig tile, one clue, instruments, weapon/shield, four lobsters and nine free slots');
  if(r.guardian==='trail_hard2'){
   if(count(837)!==1||!gear.some(i=>i.slot===3&&i.id===1381)||gear.some(i=>i.slot===13&&i.count>0))throw Error('stage one owned empty Crossbow837, worn Air staff1381 and empty quiver for Sara AP');
  }
  if(st()?.nearbyNpcs.some(n=>allGuardIds.includes(n.id)))throw Error('existing guardian makes spawn ownership ambiguous');
  const runeNeeds:Record<number,number>={};for(const [key,units] of Object.entries(spell.runes)){const rune=Number(key);runeNeeds[rune]=(runeNeeds[rune]??0)+elementalRuneCost(rune,units,gear,true)*o.maximumCasts;}
  for(const [key,units] of Object.entries(tele.runes)){const rune=Number(key);runeNeeds[rune]=(runeNeeds[rune]??0)+elementalRuneCost(rune,units,gear,true);}
  if(Object.entries(runeNeeds).some(([n,c])=>count(Number(n))<c))throw Error('stage full cast budget plus reserved Varrock recovery runes');
  if(r.guardian==='trail_hard2'){
   const admissionTick=s.tick(),plane=initialPlane,client=s.client as any;let observedCycle:number|undefined;
   // Configuration work can leave multiple PLAYER_INFO packets queued in one
   // client pump. Only a later native client cycle proves that backlog drained.
   const admitted=await waitUntil(s,()=>{
    if(over())return true;
    const pack=inv().map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot),worn=s.sdk.getEquipment().map(i=>({id:i.id,slot:i.slot,count:i.count}));
    if(player()!.level!==plane||hp()!==initialHp||s.sdk.getStateAge()>5000||JSON.stringify(pack)!==JSON.stringify(initialPack)||JSON.stringify(worn)!==JSON.stringify(gear)||st()?.nearbyNpcs.some(n=>allGuardIds.includes(n.id)))throw Error('Sara original preparation stock/gear/life/HP/state changed');
    const cycle=client.getClientCycle?.();if(!Number.isSafeInteger(cycle))throw Error('Sara native client cycle unavailable');
    if(s.tick()<=admissionTick)return false;
    if(observedCycle===undefined){observedCycle=cycle;return false;}
    return cycle>observedCycle&&!!st()?.combatStyle?.known;
   },{timeoutTicks:15});
   if(!admitted||over()||!st()?.combatStyle?.known)throw Error('Sara fresh native cycle and original AirStaff combat control unobserved');
   antidoteReceipt=await guardianAntidote(s,over,guardianSwampPoint(r.point)?{delta:knownRotDelta,onAttempt:v=>{doseAttempt=v;}}:undefined);if(!antidoteReceipt.confirmed)throw Error(antidoteReceipt.detail);antidote=true;
   // Native immunity20 * poison timer30 =600ticks; this order caps at400.
   await waitTicks(s,3);
   if(over())throw Error('guardian stopped during antidote settlement');
  }
  if(over())throw Error('guardian stopped before prayer input');
  if(!prayerBefore){const p=await s.bot.activatePrayer(12);if(!p.success||!s.sdk.isPrayerActive(12))throw Error('Protect from Magic unobserved');}
  if(over())throw Error('guardian stopped before dig');engaged=true;await dig();
  await waitUntil(s,()=>converted()||st()?.nearbyNpcs.some(n=>n.id===r.npc&&n.targetIndex===32768+own)||over(),{timeoutTicks:10});
  if(!converted()){
   const spawned=st()?.nearbyNpcs.filter(n=>allGuardIds.includes(n.id))??[];
   if(spawned.length!==1||spawned[0]!.id!==r.npc||spawned[0]!.targetIndex!==32768+own)throw Error('new unique guardian target ownership unobserved');index=spawned[0]!.index;owned=true;
   if(r.guardian==='trail_hard2'){if(nativeIO.setup)await nativeIO.setup();else await setupSaradominMage(s,index,r.npc,r.point,{fatal,stop:over});}fightHp=hp();phase='fight';console.log('GUARDIAN_PHASE '+JSON.stringify({phase,tick:s.tick(),clue:id,npcIndex:index,hp:hp()}));
   while(!over()&&guard()&&guard()!.hp!==0&&casts<o.maximumCasts){
    if(guard()!.targetIndex!==32768+own)throw Error('guardian changed target ownership');
    if(!s.sdk.isPrayerActive(12)||(s.sdk.getSkill('Prayer')?.level??0)<5)throw Error('guardian protection/points exhausted');
    const result=await nativeIO.cast(Math.min(60,Math.max(1,o.cap-(s.tick()-start))));casts++;
    if(!result.ok&&guard()&&guard()!.hp!==0)throw Error('guardian native cast failed: '+(result.failure??'no receipt'));
   }
   if(over())throw Error('guardian stop/damage/foreign player/tick budget');
   if(guard()&&guard()!.hp!==0)throw Error('guardian cast budget exhausted');
   await waitUntil(s,()=>!guard()||over(),{timeoutTicks:12});if(over())throw Error('guardian death settlement stopped');
   phase='return';console.log('GUARDIAN_PHASE '+JSON.stringify({phase,tick:s.tick(),clue:id,npcIndex:index,hp:hp()}));if(!atDig())await guardianWalk(s,r.point,{fatal,stop:over},60);if(!atDig())throw Error('guardian exact dig return unobserved');await dig();
   await waitUntil(s,()=>converted()||over(),{timeoutTicks:10});if(!converted())throw Error('repeat dig native hero/casket receipt unconfirmed');
  }
 }catch(error){detail=String(error);}
 finally{
  if(!engaged){
   if(!prayerBefore&&s.sdk.isPrayerActive(12)){try{const p=await s.bot.deactivatePrayer(12);prayerRestored=p.success&&!s.sdk.isPrayerActive(12);}catch(error){detail ||= String(error);}}
   else prayerRestored=s.sdk.isPrayerActive(12)===prayerBefore;
  }else if(!ended&&player()&&!player()!.isDead&&player()!.lifeId===life){
   try{const result=await nativeIO.escape();const p=player();escaped=result.ok&&!!p&&p.level===tele.to.level&&Math.max(Math.abs(p.worldX-tele.to.x),Math.abs(p.worldZ-tele.to.z))<=2;if(!escaped)detail ||= result.failure||'guardian Varrock recovery unconfirmed';}catch(error){detail ||= String(error);}
   if(escaped){if(!prayerBefore){try{const p=await s.bot.deactivatePrayer(12);prayerRestored=p.success&&!s.sdk.isPrayerActive(12);}catch(error){detail ||= String(error);}}else prayerRestored=s.sdk.isPrayerActive(12);}
  }
 }
 offRot();observeRot();if(pendingRot)rotFailure||='guardian composed dose/rot completion unresolved';if(rotFailure)detail ||=rotFailure;
 const runes=new Set([...Object.keys(spell.runes),...Object.keys(tele.runes)].map(Number));const exempt=new Set([id,r.casket,379,...runes,...(antidote?[2448,181]:[])]);
 const preserved=!antidoteReceipt?.unknown&&[...new Set([...stock.keys(),...inv().map(i=>i.id)])].every(id=>exempt.has(id)||count(id)===(stock.get(id)??0)+(id===2959?foodRot:0))&&gear.every(g=>s.sdk.getEquipment().some(i=>i.slot===g.slot&&i.id===g.id&&i.count===g.count));
 const cancelled=guardianStopRequested(s.name,o.stop);
 foodEaten=(stock.get(379)??0)-count(379)-foodRot;
 return{ok:!cancelled&&!ended&&player()?.lifeId===life&&!player()?.isDead&&!detail&&converted()&&preserved&&escaped&&prayerRestored,clue:r.name,guardian:r.guardian,owned,casts,casket:converted(),escaped,prayerRestored,preserved,antidote,antidoteReceipt,antidoteUnknown:antidoteReceipt?.unknown??false,foodEaten,foodRot,rotReceipts,allowedFightHpLoss:ambientDamage,fightHpBefore:fightHp,fightHpFloor:fightHpFloor(),fightHpLowest,fightHpLost:Math.max(0,fightHp-fightHpLowest),magicXp:(s.sdk.getSkillXp('Magic')??0)-xp0,ticks:s.tick()-start,detail,cancelled,scope:'one staged guardian; bounded Sara AP setup, declared fighting HP floor, exact dig return and legal bounded extraction; hidden hero flag proved by repeat-dig casket'};
}
if(import.meta.main){
 const name=process.argv[2]??'',id=Number(process.argv[3]),spell=process.argv[4]??'fire_blast',maximumCasts=Number(process.argv[5]??30),cap=Number(process.argv[6]??350);if(!name||!Number.isSafeInteger(id))throw Error('Usage (members): bun scripts/microbot-c-clue-guardian.ts <account> <native-clue-id> [standard-damage-spell] [max-casts] [ticks]');nativeGuardianClue(id);nativeNpcSpell(spell);nativeTeleport('varrock');let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(name);let ok=false;try{const r=await runGuardianClue(s,id,{spell,maximumCasts,cap,ambientDamage:Number(process.env.GUARDIAN_AMBIENT_DAMAGE??0),stop:()=>stopped});console.log('NATIVE_GUARDIAN_RESULT '+JSON.stringify(r));ok=r.ok;}finally{ok=await settle([s],ok,'finite native guardian clue');}process.exitCode=ok?0:1;
}
