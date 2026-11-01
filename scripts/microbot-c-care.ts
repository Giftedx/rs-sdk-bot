import {openBot,settle} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {watchProductionLife} from './microbot-c-lifetime';
const fishIds=[317,321,327,335,333,331,329,359,361];
const marker=(s:Session)=>Math.max(-1,...(s.sdk.getState()?.gameMessages??[]).map(m=>m.observationId??m.tick),...(s.sdk.getState()?.recentDialogs??[]).map(m=>m.observationId??m.tick));
const fresh=(s:Session,cursor:number,re:RegExp)=>(s.sdk.getState()?.gameMessages??[]).some(m=>m.type===0&&(m.observationId??m.tick)>cursor&&re.test(m.text))||(s.sdk.getState()?.recentDialogs??[]).some(m=>(m.observationId??m.tick)>cursor&&re.test(m.text.join(' ')));
const count=(s:Session,id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
// Native kitten care is ownership-checked by opnpcu/_petcat. The caller selects
// the exact NPC index; no nearest-pet assumption or timer varp default is used.
export async function kittenCare(s:Session,npcIndex:number,mode:'feed'|'wool'|'stroke',cap:number,stop:()=>boolean=()=>false){
 if(!Number.isSafeInteger(npcIndex)||npcIndex<0||!['feed','wool','stroke'].includes(mode)||!Number.isSafeInteger(cap)||cap<1)throw Error('invalid kitten care');
 const life=watchProductionLife(s,stop),start=s.tick(),over=()=>life.stopped()||s.tick()-start>=cap;
 const target=s.sdk.getState()?.nearbyNpcs.find(n=>n.index===npcIndex&&/^Kitten$/i.test(n.name));
 if(!target)throw Error('selected kitten not nearby');
 const stock=s.sdk.getInventory().map(i=>({id:i.id,count:count(s,i.id)})),cursor=marker(s);
 let input:number|undefined,ok=false,detail='';
 try{
  if(over())throw Error(life.reason()||'kitten budget');
  if(mode==='stroke')await s.sdk.sendInteractNpc(npcIndex,3);
  else{
   const item=s.sdk.getInventory().find(i=>mode==='wool'?i.id===1759:fishIds.includes(i.id));
   if(!item)throw Error(mode==='wool'?'stage a ball of wool':'stage a native kitten fish');input=item.id;
   await s.sdk.sendUseItemOnNpc(item.slot,npcIndex);
  }
  const expected=mode==='feed'?/kitten gobbles up/:mode==='wool'?/kitten loves to play with that ball of wool/:/softly stroke your cat/;
  await waitUntil(s,()=>fresh(s,cursor,expected)||over(),{timeoutTicks:cap});
  const conserved=stock.every(i=>count(s,i.id)===i.count-(mode==='feed'&&i.id===input?1:0));
  ok=fresh(s,cursor,expected)&&conserved&&!life.stopped();if(!ok)detail=life.reason()||'kitten care effect/stock unconfirmed';
 }catch(error){detail=String(error);}
 return{ok,mode,npcIndex,input:input??null,ticks:s.tick()-start,detail,proof:'fresh native care message and exact fish debit or wool preservation; hidden hunger/attention varp is not read'};
}
// The pinned native garden predates rake patches. It requires level 35
// Herblore and a worn sickle; each success grants XP and increments approval.
export async function weedMiscellania(s:Session,maximum:number,cap:number,stop:()=>boolean=()=>false){
 if(!Number.isSafeInteger(maximum)||maximum<1||!Number.isSafeInteger(cap)||cap<1)throw Error('invalid miscellania order');
 const life=watchProductionLife(s,stop),start=s.tick(),over=()=>life.stopped()||s.tick()-start>=cap,xp=()=>s.sdk.getSkillXp('Herblore')??0;
 const stock=s.sdk.getInventory().map(i=>({id:i.id,count:count(s,i.id)}));let made=0,detail='';
 try{
  if((s.sdk.getSkill('Herblore')?.level??0)<35)throw Error('Miscellania weeding requires 35 Herblore');
  if(!s.sdk.getEquipment().some(i=>i.slot===3&&[3899,2961,2963].includes(i.id)))throw Error('Miscellania weeding requires worn sickle');
  while(made<maximum&&!over()){
   const loc=()=>s.sdk.getState()?.nearbyLocs.find(l=>[4677,4678,4679].includes(l.id));
   if(!loc())await waitUntil(s,()=>!!loc()||over(),{timeoutTicks:Math.min(60,Math.max(1,cap-(s.tick()-start)))});
   if(over())break;const target=loc();if(!target)throw Error('Miscellania herb patch unavailable');
   const before=xp(),cursor=marker(s);await s.sdk.sendInteractLoc(target.x,target.z,target.id,1);
   await waitUntil(s,()=>xp()>before&&fresh(s,cursor,/manage to weed some herbs and give them to Gardener Gunnhild/)||over(),{timeoutTicks:Math.min(40,Math.max(1,cap-(s.tick()-start)))});
   if(!(xp()>before&&fresh(s,cursor,/manage to weed some herbs and give them to Gardener Gunnhild/)))throw Error('Miscellania weeding no effect; approval may already be full');
   made++;if(made<maximum&&!over())await waitTicks(s,Math.min(2,Math.max(1,cap-(s.tick()-start))));
  }
  if(made!==maximum)throw Error(life.reason()||'Miscellania tick budget');
 }catch(error){detail=String(error);}
 const preserved=stock.every(i=>count(s,i.id)===i.count);detail ||= life.reason();
 return{ok:!detail&&made===maximum&&preserved,made,preserved,ticks:s.tick()-start,detail,approval:'native success handler increments up to 127; numeric approval is not exposed by this observation'};
}
if(import.meta.main){
 const name=process.argv[2]??'',mode=process.argv[3]??'',value=Number(process.argv[4]??1),cap=Number(process.argv[5]??80);
 if(!name||!['feed','wool','stroke','miscellania'].includes(mode)||!Number.isSafeInteger(value)||value<0||!Number.isSafeInteger(cap)||cap<1)throw Error('Usage: bun scripts/microbot-c-care.ts <account> <feed|wool|stroke|miscellania> <npc-index|weed-count> [ticks]');
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(name);let ok=false;
 try{const result=mode==='miscellania'?await weedMiscellania(s,value,cap,()=>stopped):await kittenCare(s,value,mode as 'feed'|'wool'|'stroke',cap,()=>stopped);console.log('CARE_RESULT '+JSON.stringify(result));ok=result.ok;}finally{ok=await settle([s],ok,'finite native care order');}process.exitCode=ok?0:1;
}
