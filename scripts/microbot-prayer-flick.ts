import {existsSync} from 'node:fs';
import {openBot,settle} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {PRAYER_LEVELS} from '../vendor/rs-sdk/sdk/types';
import {runCows} from './gather-combat';

export type CombatPrayerOptions={prayer:number;cap:number;hpFloor:number;stop?:()=>boolean;mode?:'flick'|'hold'};
// Native prayer.rs2 starts a five-tick drain timer and clears it when all
// prayers stop. Each reset observes OFF before sending ON. This does not
// predict attacks, promise uninterrupted buffs or flick incoming protection.
export async function withCombatPrayer<T>(s:Session,o:CombatPrayerOptions,run:(stop:()=>boolean)=>Promise<T>){
 if(![1,2,4,5,10,11].includes(o.prayer)||!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>15000||!Number.isSafeInteger(o.hpFloor)||o.hpFloor<1||o.mode!==undefined&&!['flick','hold'].includes(o.mode))throw Error('invalid finite offensive prayer');
 const initial=s.sdk.getState()?.player,life=initial?.lifeId,respawns=initial?.respawnCount??0,prayers=s.sdk.getPrayerState(),start=s.tick();
 if(!initial||life===undefined||!prayers||prayers.activePrayers.some(Boolean)||prayers.prayerPoints<1||prayers.prayerLevel<PRAYER_LEVELS[o.prayer]!||(s.sdk.getSkill('Hitpoints')?.level??0)<o.hpFloor)throw Error('offensive prayer requires original healthy life, eligible level and all prayers off');
 const pointsBefore=prayers.prayerPoints,self=(s.client as any).selfSlot,plane=initial.level,originalAttack=s.bot?.attack;if(!Number.isSafeInteger(self)||self<0||self>2047||typeof originalAttack!=='function')throw Error('offensive prayer requires observed original attack input owner');const ownTarget=32768+self;type Bound={id:number;index:number;op:number;epoch:number;started:number;accepted:boolean};let bound:Bound|undefined,epoch=0,accepting=true,attackUncertain=false,attackResumptions=0;
 let ended=false,failure='',uncertain=false,pending:Promise<void>|undefined,lastReset=-Infinity,toggles=0,cycles=0,attacks=0,covered=0;
 void s.ended.then(()=>{ended=true;});const seen=new Set<string>();
 const alive=()=>{const p=s.sdk.getState()?.player;return !ended&&!!p&&!p.isDead&&p.lifeId===life&&(p.respawnCount??0)===respawns;};
 const stop=()=>{if(!failure){if(!alive())failure='original combat life unavailable';else if(o.stop?.())failure='combat prayer stopped';else if(s.tick()-start>=o.cap)failure='combat prayer cap';else if((s.sdk.getSkill('Hitpoints')?.level??0)<o.hpFloor)failure='combat prayer HP floor';}return !!failure;};
 const active=()=>s.sdk.isPrayerActive(o.prayer);
 const setPrayer=async(on:boolean)=>{
  if(uncertain||!alive())throw Error('no prayer input on uncertain or replaced life');if(active()===on)return;
  let dispatch='';toggles++;try{const r=await s.sdk.sendTogglePrayer(o.prayer);if(!r.success)dispatch=r.message;}catch(error){dispatch=String(error);}
  // A dispatch reply only acknowledges the client packet. The opposite-to-
  // desired observed transition reconciles a lost reply without another toggle.
  try{if(!await waitUntil(s,()=>!alive()||active()===on,{timeoutTicks:8})||!alive()||active()!==on)throw Error('prayer dispatch outcome uncertain: '+dispatch);}
  catch(error){uncertain=true;throw error;}
 };
 const target=()=>{if(!bound?.accepted)return;const st=s.sdk.getState()!,n=st.nearbyNpcs.find(n=>n.index===bound!.index);if(!n||(n.hp!==null&&n.hp!==undefined&&n.hp<=0)){bound=undefined;return;}if(n.id!==bound.id){failure='bound cow identity changed';return;}if(n.distance>2||n.reachable===false||st.player!.level!==plane){failure='bound cow reach/plane changed';return;}if(st.nearbyPlayers.some(p=>Math.max(Math.abs(p.x-n.x),Math.abs(p.z-n.z))<=12)){failure='another player near combat target';return;}if(n.targetIndex!==ownTarget){if(n.inCombat||(n.targetIndex??-1)>=0)failure='bound cow private combat owner changed';return;}return n;};
 const workerAttack:typeof originalAttack=async(input,timeout)=>{
  const ticket=++epoch;bound=undefined;if(pending)await pending;if(stop()||!accepting||s.bot.attack!==workerAttack)throw Error('owned prayer worker attack stopped');
  if(typeof input!=='object'||!input||!('id'in input)||input.id!==81||!('index'in input))throw Error('prayer attack input must bind the existing worker cow');
  const n=s.sdk.getState()?.nearbyNpcs.find(n=>n.index===input.index&&n.id===81),op=n?.optionsWithIndex.find(o=>/^Attack$/i.test(o.text));
  if(!n||!op||n.inCombat||n.distance>2||n.reachable===false||s.sdk.getState()!.nearbyPlayers.some(p=>Math.max(Math.abs(p.x-n.x),Math.abs(p.z-n.z))<=12))throw Error('prayer original cow input unavailable/foreign');
  const b:Bound={id:n.id,index:n.index,op:op.opIndex,epoch:ticket,started:s.tick(),accepted:false};bound=b;
  try{const result=await originalAttack.call(s.bot,n,timeout);if(bound===b&&result.success)b.accepted=true;else if(bound===b){bound=undefined;failure ||= 'existing worker attack outcome unconfirmed';}return result;}catch(error){if(bound===b)bound=undefined;throw error;}
 };
 s.bot.attack=workerAttack;
 const resume=async(ticket:number)=>{
  if(stop()||!accepting||!bound||bound.epoch!==ticket)return;if(attackUncertain||s.bot.attack!==workerAttack)throw Error('owned prayer attack input outcome/owner uncertain');
  const n=target();if(!n||stop())return;const before=s.tick();let dispatch='';attackResumptions++;
  try{const r=await s.sdk.sendInteractNpc(n.index,bound.op);if(!r.success)dispatch=r.message;}catch(error){dispatch=String(error);}
  const engaged=()=>{const st=s.sdk.getState(),c=st?.player?.combat;return s.tick()>before&&c?.targetType==='npc'&&c.targetIndex===n.index&&!!st?.nearbyNpcs.some(v=>v.id===n.id&&v.index===n.index&&v.targetIndex===ownTarget);};
  // Settle before the next three-tick prayer reset; never repeat an unknown attack input.
  try{if(!await waitUntil(s,()=>stop()||!bound||bound.epoch!==ticket||engaged(),{timeoutTicks:2})||stop())throw Error('owned prayer same-cow attack outcome unconfirmed: '+dispatch);if(!bound||bound.epoch!==ticket)return;if(!engaged())throw Error('owned prayer same-cow attack observation absent');console.log('PRAYER_ATTACK_RESUME '+JSON.stringify({id:n.id,index:n.index,owner:ownTarget,tick:s.tick()}));}catch(error){attackUncertain=true;throw error;}
 };
 const off=s.onTick(()=>{
  if(stop())return;if(s.bot.attack!==workerAttack){failure='worker attack input owner changed';return;}
  const state=s.sdk.getState()!,combat=state.player!.combat,prayer=s.sdk.getPrayerState();
  if(!prayer||prayer.prayerPoints<1||(o.mode!=='hold'&&prayer.prayerPoints!==pointsBefore)){failure='combat prayer point budget changed';return;}
  if(prayer.activePrayers.some((on,index)=>on&&index!==o.prayer)){failure='another prayer changed the owned reset timer';return;}
  if(combat.inCombat&&combat.targetType==='player'){failure='player combat is outside this consumer';return;}
  if(bound&&!bound.accepted)return;const n=target();if(failure)return;if(n&&combat.targetType==='npc'&&combat.targetIndex!==n.index){failure='worker combat target changed';return;}
  for(const event of state.combatEvents??[]){if(event.type!=='damage_dealt'||event.sourceType!=='player'||event.targetType!=='npc'||event.tick<(bound?.started??start)||!n||event.targetIndex!==n.index)continue;const key=event.observationId===undefined?`${event.tick}:${event.targetIndex}:${event.damage}`:String(event.observationId);if(!seen.has(key)){seen.add(key);attacks++;if(active())covered++;}}
  if(pending)return;
  const reset=!!n&&active()&&o.mode!=='hold'&&s.tick()-lastReset>=3;
  if(!!n===active()&&!reset)return;
  const ticket=bound?.epoch;
  pending=(async()=>{
   if(stop())return;
   if(reset){await setPrayer(false);if(stop()||bound?.epoch!==ticket||!target())return;await setPrayer(true);cycles++;lastReset=s.tick();await resume(ticket!);}
   else{await setPrayer(!!n);lastReset=s.tick();if(n&&ticket!==undefined)await resume(ticket);}
  })().catch(error=>{failure ||= String(error);}).finally(()=>{pending=undefined;});
 });
 let result:T|undefined,error:unknown;
 try{result=await run(stop);}catch(e){error=e;failure ||= String(e);}
 finally{accepting=false;off();await pending;if(s.bot.attack===workerAttack)s.bot.attack=originalAttack;if(!uncertain&&alive()&&active()){try{await setPrayer(false);}catch(e){failure ||= String(e);}}}
 const after=s.sdk.getPrayerState(),restored=!uncertain&&alive()&&!!after&&!after.activePrayers.some(Boolean),spent=pointsBefore-(after?.prayerPoints??0);
 if(!attacks||!covered||(o.mode!=='hold'&&!cycles))failure ||= 'no observed offensive prayer combat/reset output';
 if(o.mode!=='hold'&&spent!==0)failure ||= 'native prayer points changed';
 return{ok:!failure&&restored,result,error:error===undefined?undefined:String(error),failure:failure||'-',restored,prayerStateUncertain:uncertain,attackStateUncertain:attackUncertain,attackResumptions,attacksObserved:attacks,attacksWithPrayerObserved:covered,toggles,cycles,pointsBefore,pointsAfter:after?.prayerPoints,spent,ticks:s.tick()-start};
}
if(import.meta.main){
 const[actor,prayer='10',maximum='1',cap='1500']=process.argv.slice(2);if(!actor)throw Error('usage: microbot-prayer-flick.ts account [offensive-prayer] [cow-kills] [cap]');
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(actor,{onStop:async()=>{stopped=true;}});let ok=false;
 try{const result=await withCombatPrayer(s,{prayer:Number(prayer),cap:Number(cap),hpFloor:40,stop:()=>stopped||existsSync('.practice/stop-all')||existsSync(`.practice/stop-${actor}`)||existsSync('.practice/stop-microbot-prayer-flick')},stop=>runCows(s,{cap:Number(cap),maximum:Number(maximum),stop}));ok=result.ok&&!!result.result?.ok;console.log('PRAYER_FLICK '+JSON.stringify({...result,ok}));}finally{process.exitCode=await settle([s],ok,'finite offensive prayer with owned cow output')?0:1;}
}
