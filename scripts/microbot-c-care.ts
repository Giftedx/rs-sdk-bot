import {openBot,settle} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {questFlags} from '../packages/core/src/quest-status';
import {existsSync} from 'node:fs';
import{equipmentObserved}from'../packages/core/src/container-observation';
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
export async function weedMiscellania(s:Session,maximum:number,cap:number,stop:()=>boolean=()=>false,xpMultiplier=25){
 if(!Number.isSafeInteger(maximum)||maximum<1||!Number.isSafeInteger(cap)||cap<1||!Number.isSafeInteger(xpMultiplier)||xpMultiplier<1||!Number.isSafeInteger(xpMultiplier*(maximum+1)))throw Error('invalid miscellania order/XP multiplier');
 const start=s.tick(),client=s.client as any,executor=client?.executeBotAction,state=()=>s.sdk.getState(),p0=state()?.player,life=p0?.lifeId,respawns=p0?.respawnCount??0,hp=s.sdk.getSkill('Hitpoints')?.level;
 const approval=()=>{const raw=client?.var?.[361];return Number.isSafeInteger(raw)&&raw>=-0x80000000&&raw<=0xffffffff?(raw>>>18)&127:undefined;};
 const pack=()=>{const out:Record<number,number>={};for(const row of s.sdk.getInventory())out[row.id]=(out[row.id]??0)+row.count;return Object.entries(out).sort((a,b)=>Number(a[0])-Number(b[0]));},gear=()=>JSON.stringify(s.sdk.getEquipment()),skills=()=>state()?.skills.map(k=>k.experience);
 const xpBounds=(n:number)=>[Math.floor(xpMultiplier*n/10),Math.ceil(xpMultiplier*n/10)]as const,originalPack=JSON.stringify(pack()),originalGear=gear(),originalSkills=skills(),initialApproval=approval();let ended=false,made=0,detail='';void s.ended?.then(()=>{ended=true;});
 if(!client||typeof executor!=='function'||!p0||!Number.isSafeInteger(life)||!Number.isSafeInteger(hp)||hp!<1||!equipmentObserved(client)||originalSkills?.length!==21||originalSkills.some(n=>!Number.isSafeInteger(n)||n<0)||initialApproval===undefined)throw Error('Miscellania public owned state/approval unknown');
 const unsafe=()=>{const p=state()?.player,xp=skills();return ended||s.client!==client||client.executeBotAction!==executor||stop()||existsSync('.practice/stop-all')||!!s.name&&existsSync('.practice/stop-'+s.name)||!!process.env.STOP_FILE&&existsSync(process.env.STOP_FILE)||!p||p.isDead||p.lifeId!==life||(p.respawnCount??0)!==respawns||s.sdk.getSkill('Hitpoints')?.level!==hp||s.sdk.getStateAge()>5000||!equipmentObserved(client)||JSON.stringify(pack())!==originalPack||gear()!==originalGear||xp?.length!==21||xp.some((n,i)=>!Number.isSafeInteger(n)||i!==15&&n!==originalSkills[i]||i===15&&(n<originalSkills[i]!+xpBounds(made)[0]||n>originalSkills[i]!+xpBounds(made+1)[1]));},over=()=>unsafe()||s.tick()-start>=cap;
 try{
  if((s.sdk.getSkill('Herblore')?.level??0)<35)throw Error('Miscellania weeding requires 35 Herblore');
  if(!s.sdk.getEquipment().some(i=>i.slot===3&&[3899,2961,2963].includes(i.id)))throw Error('Miscellania weeding requires worn sickle');
  while(made<maximum&&!over()){
   const loc=()=>state()?.nearbyLocs.find(l=>[4677,4678,4679].includes(l.id));
   if(!loc())await waitUntil(s,()=>!!loc()||over(),{timeoutTicks:Math.min(60,Math.max(1,cap-(s.tick()-start)))});
   if(over())break;const target=loc(),before=approval(),beforeXp=skills()![15]!,cursor=marker(s);if(!target||before===undefined||before>=127)throw Error('Miscellania patch/approval unavailable or full');
   const success=()=>(state()?.gameMessages??[]).some(m=>m.type===0&&(m.observationId??m.tick)>cursor&&m.text==='You manage to weed some herbs and give them to Gardener Gunnhild.');
   const paid=()=>success()&&approval()===before+1&&(skills()![15]!-beforeXp)>=xpBounds(1)[0]&&(skills()![15]!-beforeXp)<=xpBounds(1)[1];
   if(over())break;await s.direct({type:'interactLoc',x:target.x,z:target.z,locId:target.id,optionIndex:1,reason:'finite native Miscellania weed'});
   await waitUntil(s,()=>paid()||over(),{timeoutTicks:Math.min(40,Math.max(1,cap-(s.tick()-start)))});
   if(unsafe()||!paid())throw Error('Miscellania fresh system success/public approval or owned state unconfirmed');
   made++;if(made<maximum&&!over())await waitTicks(s,Math.min(2,Math.max(1,cap-(s.tick()-start))));
  }
  if(made!==maximum)throw Error('Miscellania stop/life/owner/state or tick budget');
 }catch(error){detail=String(error);}
 const preserved=JSON.stringify(pack())===originalPack&&gear()===originalGear;if(unsafe()||approval()!==initialApproval+made||(skills()![15]!-originalSkills[15]!)<xpBounds(made)[0]||(skills()![15]!-originalSkills[15]!)>xpBounds(made)[1])detail ||= 'Miscellania original owned state/approval lost';
 return{ok:!detail&&made===maximum&&preserved,made,preserved,ticks:s.tick()-start,detail,xpMultiplier,approval:{before:initialApproval,after:approval(),source:'public transmitted varp361 bits18..24'},herblorePublicXpDelta:(skills()?.[15]??NaN)-originalSkills[15]!,proof:'exact fresh native system success and approval increment; public XP floors raw tenths'};
}
export function druidPouchFillDelta(rows:readonly{id:number;count:number}[]){
 const held=(id:number)=>rows.filter(r=>r.id===id).reduce((n,r)=>n+r.count,0),empty=held(2957)>0;if(!empty&&held(2958)<1)throw Error('owned native Druid pouch absent');
 const delta:Record<number,number>={};let needed=3,charges=0;for(const[id,weight]of [[2974,3],[2972,2],[2970,1]]){const use=Math.min(needed,held(id!));if(use){delta[id!]=-use;charges+=use*weight!;needed-=use;}}if(needed)throw Error('Druid pouch requires three owned native harvests');if(empty)delta[2957]=-1;delta[2958]=charges;return{delta,charges,input:empty?2957:2958};
}
export async function fillDruidPouch(s:Session,maximum:number,cap:number,stop:()=>boolean=()=>false){
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>20||!Number.isSafeInteger(cap)||cap<1||cap>1000)throw Error('invalid finite Druid pouch order');
 if(!questFlags(s.client)?.some(q=>q.name==='Nature Spirit'&&q.state==='complete'))throw Error('Druid pouch utility requires observed completed Nature Spirit; staged quest fill remains in quest-druidspirit');
 const client=s.client,executor=(client as any)?.executeBotAction;if(!client||typeof executor!=='function'||!Number.isSafeInteger(s.sdk.getState()?.player?.lifeId))throw Error('Druid pouch executor unobserved');
 const life=watchProductionLife(s,stop),began=s.tick(),over=()=>s.client!==client||(client as any).executeBotAction!==executor||life.stopped()||s.tick()-began>=cap||existsSync('.practice/stop-all')||existsSync(`.practice/stop-${s.name}`),totals=()=>{const a:Record<number,number>={};for(const r of s.sdk.getInventory())a[r.id]=(a[r.id]??0)+r.count;return a;};let made=0,charges=0,uncertain=false,detail='';const receipts:unknown[]=[];
 try{while(made<maximum){if(over())throw Error(life.reason()||'Druid pouch stopped');const effect=druidPouchFillDelta(s.sdk.getInventory()),before=totals(),cursor=marker(s),row=s.sdk.getInventory().find(i=>i.id===effect.input),gear=JSON.stringify(s.sdk.getEquipment()),xp=JSON.stringify(s.sdk.getState()?.skills.map(i=>i.experience));
  if(!row)throw Error('Druid pouch selection lost');const paid=()=>{const now=totals();return[...new Set([...Object.keys(before),...Object.keys(now),...Object.keys(effect.delta)])].every(k=>(now[Number(k)]??0)-(before[Number(k)]??0)===(effect.delta[Number(k)]??0));};uncertain=true;try{if(over())throw Error('Druid pouch executor changed before fill');await s.direct({type:'useInventoryItem',slot:row.slot,optionIndex:1,reason:'owned finite native Druid pouch fill'});}catch{/* Exact fresh native credit alone may reconcile a lost reply. */}
  if(!await waitUntil(s,()=>over()||paid()&&fresh(s,cursor,new RegExp('^You add '+effect.charges+' natures harvests to your druid pouch\\.$')),{timeoutTicks:Math.min(8,Math.max(1,cap-(s.tick()-began)))})||over()||!paid()||JSON.stringify(s.sdk.getEquipment())!==gear||JSON.stringify(s.sdk.getState()?.skills.map(i=>i.experience))!==xp)throw Error('Druid pouch exact fresh fill unconfirmed');uncertain=false;made++;charges+=effect.charges;receipts.push(effect);
 }}catch(error){detail=String(error);}return{ok:!detail&&made===maximum,made,charges,receipts,uncertain,detail,ticks:s.tick()-began};
}
if(import.meta.main){
 const name=process.argv[2]??'',mode=process.argv[3]??'',value=Number(process.argv[4]??1),cap=Number(process.argv[5]??80);
 if(!name||!['feed','wool','stroke','miscellania','pouch'].includes(mode)||!Number.isSafeInteger(value)||value<0||!Number.isSafeInteger(cap)||cap<1)throw Error('Usage: bun scripts/microbot-c-care.ts <account> <feed|wool|stroke|miscellania|pouch> <npc-index|weed-count> [ticks]');
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(name);let ok=false;
 try{const result=mode==='pouch'?await fillDruidPouch(s,value,cap,()=>stopped):mode==='miscellania'?await weedMiscellania(s,value,cap,()=>stopped,Number(process.env.MISC_WEED_XP_RATE??25)):await kittenCare(s,value,mode as 'feed'|'wool'|'stroke',cap,()=>stopped);console.log('CARE_RESULT '+JSON.stringify(result));ok=result.ok;}finally{ok=await settle([s],ok,'finite native care order');}process.exitCode=ok?0:1;
}
