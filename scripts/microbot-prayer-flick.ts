import {existsSync,readFileSync} from 'node:fs';
import {BotActions} from '../vendor/rs-sdk/sdk/actions';
import {nativeNpcSpell,npcCastEffect,runNpcMagic} from './microbot-magic-npc';
import {elementalRuneCost} from './microbot-magic-items';
import {componentId} from '../packages/core/src/logout';
import {nativeTeleport,runTeleportMagic} from './microbot-magic-teleport';
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
export function incomingFarmerProfile(){
 const base='vendor/rs-sdk/server/content/',row=readFileSync(base+'scripts/_unpack/225/all.npc','utf8').split('[farmer1]')[1]?.split('\n[')[0]??'',rate=Number(row.match(/^param=attackrate,(\d+)/m)?.[1]),name=row.match(/^param=attack_anim,([^\r\n]+)/m)?.[1],anim=Number(readFileSync(base+'pack/seq.pack','utf8').split(/\r?\n/).find(l=>l.endsWith('='+name))?.split('=')[0]);
 if(rate!==6||anim!==433||!/^param=damagetype,\^stab_style$/m.test(row))throw Error('native Farmer incoming profile changed');return{npc:7,prayer:14,rate,anim,lead:2,source:'_unpack/225/all.npc farmer1; melee protection before queue0'}as const;
}
export async function withIncomingProtection<T>(s:Session,o:{cap:number;hpFloor:number;spell:string;stop?:()=>boolean},run:(owned:Session,stop:()=>boolean,finishCombat:()=>void)=>Promise<T>){
 const profile=incomingFarmerProfile(),spell=nativeNpcSpell(o.spell),initial=s.sdk.getState()?.player,client=s.client as any,executor=client.executeBotAction,life=initial?.lifeId,respawns=initial?.respawnCount??0,start=s.tick(),prayers=s.sdk.getPrayerState(),points=prayers?.prayerPoints;
 if(!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>5000||!Number.isSafeInteger(o.hpFloor)||o.hpFloor<1||!initial||!Number.isSafeInteger(life)||!Number.isSafeInteger(client.selfSlot)||typeof executor!=='function'||!prayers||prayers.activePrayers.some(Boolean)||prayers.prayerLevel<PRAYER_LEVELS[profile.prayer]!||prayers.prayerPoints<1||(s.sdk.getSkill('Hitpoints')?.level??0)<o.hpFloor||spell.debuff)throw Error('incoming protection needs finite healthy original life, eligible all-off prayers and damaging native spell');
 let ended=false,failure='',uncertain=false,retiring=false,pending:Promise<void>|undefined,result:T|undefined,error:unknown,toggles=0,cycles=0,attacks=0,protectedAttacks=0,lastAnim=-1,lastEdge=-Infinity;
 type Binding={index:number;id:number;native:any};let bound:Binding|undefined,paidPending:{before:Record<number,number>;costs:Record<number,number>;xp:number}|undefined;
 void s.ended.then(()=>{ended=true;});const state=()=>s.sdk.getState(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,alive=()=>{const p=state()?.player;return !ended&&s.client===client&&client.executeBotAction===executor&&!!p&&!p.isDead&&p.lifeId===life&&(p.respawnCount??0)===respawns&&p.level===initial.level&&hp()>=o.hpFloor&&s.sdk.getStateAge()<=5000;},active=()=>s.sdk.isPrayerActive(profile.prayer),stock=()=>{const out:Record<number,number>={};for(const i of s.sdk.getInventory())out[i.id]=(out[i.id]??0)+i.count;return out;};
 const stopped=()=>{if(!failure){if(!alive())failure='incoming original client/life/HP/input owner unavailable';else if(o.stop?.())failure='incoming operator stop';else if(s.tick()-start>=o.cap)failure='incoming cap';}return !!failure;};
 const guard=()=>{if(!alive()||uncertain)throw Error('incoming original owner/life or prayer outcome unavailable');};
 const sdk=new Proxy(s.sdk,{get(t,k,r){const v=Reflect.get(t,k,r);return typeof v==='function'?function(...args:unknown[]){if(typeof k==='string'&&k.startsWith('send'))guard();return v.apply(r,args);}:v;}});
 const target=()=>{if(!bound)return;const n=state()?.nearbyNpcs.find(n=>n.index===bound!.index);if(!n||n.hp===0)return;if(n.distance>2&&attacks===0)return;if(n.id!==profile.npc||client.npc?.[n.index]!==bound.native||bound.native?.type?.id!==profile.npc||n.distance>2||n.reachable===false||state()?.nearbyPlayers.length||n.targetIndex!==32768+client.selfSlot){failure='incoming bound native Farmer identity/reach/private ownership changed';return;}return n;};
 const set=async(on:boolean)=>{guard();if(active()===on)return;toggles++;try{await sdk.sendTogglePrayer(profile.prayer);}catch{}try{if(!await waitUntil(s,()=>!alive()||active()===on,{timeoutTicks:2})||!alive()||active()!==on)throw Error('incoming prayer transition unconfirmed; no retry');}catch(e){uncertain=true;throw e;}};
 const view=Object.create(s)as Session;Object.defineProperties(view,{sdk:{value:sdk},bot:{value:new BotActions(sdk)},direct:{value:async(a:any)=>{
  if(pending)await pending;guard();if(a?.type==='spellOnNpc'){
   if(stopped()||retiring||paidPending)throw Error('incoming paid worker cast stopped/previous outcome unknown');
   const n=state()?.nearbyNpcs.find(n=>n.index===a.npcIndex&&n.id===profile.npc),native=n&&client.npc?.[n.index];
   if(!n||!native||native.type?.id!==profile.npc||n.distance>10||n.reachable===false||n.hp===0||state()?.nearbyPlayers.length||n.inCombat&&n.targetIndex!==32768+client.selfSlot||a.spellComponent!==componentId(spell.component))throw Error('incoming original worker Farmer cast binding refused');
   if(bound&&(bound.index!==n.index||bound.native!==native))throw Error('incoming worker cannot replace its bound Farmer');bound={index:n.index,id:n.id,native};await set(true);const live=state()?.nearbyNpcs.find(v=>v.index===n.index);if(!live||live.id!==profile.npc||client.npc?.[n.index]!==native||live.distance>10||live.reachable===false||live.hp===0||state()?.nearbyPlayers.length||live.inCombat&&live.targetIndex!==32768+client.selfSlot)throw Error('incoming binding changed during initial protection');if(stopped())throw Error('incoming stopped before first protected cast');
   paidPending={before:stock(),costs:Object.fromEntries(Object.entries(spell.runes).map(([id,q])=>[id,elementalRuneCost(+id,q,s.sdk.getEquipment(),true)])),xp:s.sdk.getSkillXp('Magic')??0};
  }
  guard();return s.direct(a);
 }}});
 const off=s.onTick(()=>{
  if(retiring||stopped())return;if((s.sdk.getPrayerState()?.prayerPoints??0)<1){failure='incoming prayer points exhausted';return;}if(s.sdk.getPrayerState()?.activePrayers.some((on,i)=>on&&i!==profile.prayer)){failure='incoming conflicting prayer';return;}if(state()?.nearbyPlayers.length){failure='incoming foreign player';return;}
  if(paidPending){const effect=npcCastEffect(paidPending.costs,paidPending.before,stock(),paidPending.xp,s.sdk.getSkillXp('Magic')??0);if(effect==='cast')paidPending=undefined;else if(effect==='invalid'){failure='incoming worker paid effect changed';return;}}
  if(!bound||pending)return;const n=state()?.nearbyNpcs.find(n=>n.id===profile.npc&&n.index===bound!.index);if(!n||n.hp===0)return;
  if(n.targetIndex===-1&&!n.inCombat)return;const own=target();if(!own||failure)return;
  if(own.animId===profile.anim&&lastAnim!==profile.anim){lastEdge=s.tick();attacks++;if(active())protectedAttacks++;else{failure='incoming attack observed without protection';return;}
   // OFF follows a confirmed protected attack. ON must settle two ticks before
   // the next native rate6 attack; any pending paid cast holds protection ON.
   if(!paidPending){const deadline=lastEdge+profile.rate-profile.lead;pending=(async()=>{await set(false);if(stopped()||retiring||!target())return;await set(true);if(s.tick()>deadline)throw Error('incoming protection missed conservative lead');cycles++;})().catch(e=>{failure ||=String(e);}).finally(()=>{pending=undefined;});}
  }lastAnim=own.animId??-1;
 });
 try{result=await run(view,stopped,()=>{if(paidPending)throw Error('incoming last worker cast outcome unconfirmed');retiring=true;});}catch(e){error=e;failure ||=String(e);}finally{retiring=true;off();await pending;if(!uncertain&&alive()&&active())try{await set(false);}catch(e){failure ||=String(e);}}
 const after=s.sdk.getPrayerState(),restored=!uncertain&&alive()&&!!after&&!after.activePrayers.some(Boolean);if(!attacks||!cycles||protectedAttacks!==attacks)failure ||= 'no productive incoming attack/flick receipt';
 return{ok:!failure&&restored,result,error:error===undefined?undefined:String(error),failure,restored,prayerStateUncertain:uncertain,profile,attacksObserved:attacks,attacksProtected:protectedAttacks,cycles,toggles,pointsBefore:points,pointsAfter:after?.prayerPoints,spent:(points??0)-(after?.prayerPoints??0),ticks:s.tick()-start,scope:'finite fixed native Farmer melee attack timing; no magic/projectile/mixed NPC or live qualification'};
}
if(import.meta.main){
 if(process.env.INCOMING_PROTECTION==='1'){const[actor,casts='3',cap='500']=process.argv.slice(2);if(!actor||!Number.isSafeInteger(Number(casts))||Number(casts)<1||Number(casts)>3||!Number.isSafeInteger(Number(cap))||Number(cap)<100||Number(cap)>1000)throw Error('incoming account/casts1..3/cap100..1000 required');incomingFarmerProfile();nativeNpcSpell('wind_strike');nativeTeleport('varrock');let stop=false;process.once('SIGINT',()=>{stop=true;});process.once('SIGTERM',()=>{stop=true;});const session=await openBot(actor);let ok=false;try{const r=await withIncomingProtection(session,{cap:Number(cap),hpFloor:70,spell:'wind_strike',stop:()=>stop||existsSync('.practice/stop-all')||existsSync(`.practice/stop-${actor}`)||existsSync('.practice/stop-microbot-prayer-flick')||!!process.env.STOP_FILE&&existsSync(process.env.STOP_FILE)},async(owned,stopped,finishCombat)=>{const magic=await runNpcMagic(owned,nativeNpcSpell('wind_strike'),{npc:7,casts:Number(casts),cap:Number(cap)-30,members:true,stop:stopped});finishCombat();if(magic.casts===0)return{ok:false,magic,escape:{ok:false,stop:'no owned paid combat; no escape input'}};const escape=await runTeleportMagic(owned,nativeTeleport('varrock'),{casts:1,cap:30,members:true,stop:()=>false});return{ok:magic.ok&&escape.ok,magic,escape};});ok=r.ok&&!!r.result?.ok;console.log('INCOMING_PRAYER '+JSON.stringify({...r,ok}));}finally{process.exitCode=await settle([session],ok,'finite Farmer incoming prayer and paid native magic')?0:1;}process.exit();}
 const[actor,prayer='10',maximum='1',cap='1500']=process.argv.slice(2);if(!actor)throw Error('usage: microbot-prayer-flick.ts account [offensive-prayer] [cow-kills] [cap]');
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(actor,{onStop:async()=>{stopped=true;}});let ok=false;
 try{const result=await withCombatPrayer(s,{prayer:Number(prayer),cap:Number(cap),hpFloor:40,stop:()=>stopped||existsSync('.practice/stop-all')||existsSync(`.practice/stop-${actor}`)||existsSync('.practice/stop-microbot-prayer-flick')},stop=>runCows(s,{cap:Number(cap),maximum:Number(maximum),stop}));ok=result.ok&&!!result.result?.ok;console.log('PRAYER_FLICK '+JSON.stringify({...result,ok}));}finally{process.exitCode=await settle([s],ok,'finite offensive prayer with owned cow output')?0:1;}
}
