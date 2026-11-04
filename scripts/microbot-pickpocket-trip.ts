// Finite native pickpocket bank/refill consumer; donor ThievingScript.bankAndEquip.
import {readFileSync,existsSync} from 'node:fs';
import {openBot,settle} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {questFlags} from '../packages/core/src/quest-status';
import {equipmentObserved} from '../packages/core/src/container-observation';
import {BotActions} from '../vendor/rs-sdk/sdk/actions';
import {runBankProfile,validateBankRouteJob,type BankRouteJob,type BankProfile} from './microbot-bank-jobs';
import {pickpocketProfiles,runPickpockets,pocketEffect} from './microbot-a-pickpocket';
import {questFoodDefinitions} from './quest-sustain';

export type PickpocketTrip=Omit<BankRouteJob,'family'|'recipe'>&{profile:string;food:number;foodPerSuccess:number;attemptsPerSuccess:number;hpFloor:number;eatAt:number;xpRate:number};
export function validatePickpocketTrip(j:PickpocketTrip){
 validateBankRouteJob({...j,family:'pickpocket',recipe:j.profile});
 const p=pickpocketProfiles().find(p=>p.name===j.profile),food=questFoodDefinitions().get(j.food);
 if(!p||!j.bank||!j.site||!j.members||j.target>1000||j.batch>16||j.returnTicks<120||![j.food,j.foodPerSuccess,j.attemptsPerSuccess,j.hpFloor,j.eatAt].every(Number.isSafeInteger)||j.foodPerSuccess<1||j.foodPerSuccess>28||j.attemptsPerSuccess<1||j.attemptsPerSuccess>20||j.hpFloor<1||j.eatAt<j.hpFloor+p.damage||!Number.isFinite(j.xpRate)||j.xpRate<=0||j.xpRate>1000||!food||food.next!==undefined)throw Error('invalid finite native pickpocket trip/food budget');
 const spawns=JSON.parse(readFileSync('knowledge/npcs.json','utf8'))as{id:number;spawns:{x:number;z:number;level:number}[]}[];
 if(!spawns.some(n=>p.npcs.includes(n.id)&&n.spawns.some(s=>s.level===j.site!.level&&Math.max(Math.abs(s.x-j.site!.x),Math.abs(s.z-j.site!.z))<=8)))throw Error('pickpocket site lacks declared native profile spawn');
 return{profile:p,food};
}
export function pocketTripStop(actor:string,stop:()=>boolean=()=>false,exists:(p:string)=>boolean=existsSync){return stop()||exists('.practice/stop-all')||exists(`.practice/stop-${actor}`)||exists('.practice/stop-microbot-pickpocket-trip')||!!process.env.STOP_FILE&&exists(process.env.STOP_FILE);}
export function pocketOwnedActions(s:Session,allowed:()=>boolean){
 const requireOwner=()=>{if(!allowed())throw Error('pickpocket dispatch original client/life/input owner absent');};
 const sdk=new Proxy(s.sdk,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);return typeof value==='function'?function(...args:unknown[]){if(typeof key==='string'&&key.startsWith('send'))requireOwner();return value.apply(receiver,args);}:value;}});
 const bot=new BotActions(sdk);
 const view=Object.create(s)as Session;Object.defineProperties(view,{sdk:{value:sdk},bot:{value:bot},direct:{value:(...args:unknown[])=>{requireOwner();return(s.direct as any)(...args);}}});return view;
}
type Deps={bank?:typeof runBankProfile;pocket?:typeof runPickpockets};
export async function runPickpocketTrips(s:Session,j:PickpocketTrip,requestStop:()=>boolean=()=>false,deps:Deps={}){
 const {profile:p,food}=validatePickpocketTrip(j),start=s.tick(),state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),gear=()=>s.sdk.getEquipment(),initial=state()?.player,life=initial?.lifeId,respawns=initial?.respawnCount??0,hp0=s.sdk.getSkill('Hitpoints')?.level??0,baseHp=s.sdk.getSkill('Hitpoints')?.baseLevel??0,client=s.client as any,owner=client.executeBotAction;
 const hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,count=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),stock=(rows:readonly{id:number;count:number}[])=>{const out:Record<number,number>={};for(const i of rows){const t=client.objType?.(i.id),id=t?.certtemplate>=0?t.certlink:i.id;out[id]=(out[id]??0)+i.count;}return out;},same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),pack=()=>stock(inv()),xp=()=>s.sdk.getSkillXp('Thieving')??0;
 const controls=()=>({retaliate:state()?.autoRetaliateEnabled,style:state()?.combatStyle?.currentStyle,prayers:state()?.prayers?.activePrayers}),controls0=JSON.parse(JSON.stringify(controls())),loot:Record<number,number>={},gear0=gear().map(i=>({id:i.id,count:i.count,slot:i.slot})),xp0=xp(),otherXp=()=>JSON.stringify(state()?.skills.filter(i=>i.name!=='Thieving').map(i=>({name:i.name,experience:i.experience}))),other0=otherXp();
 let ended=false,uncertain=false,eaten=0,verifiedSuccesses=0,verifiedFailures=0,bankGeneration=-1;const receipts:Awaited<ReturnType<typeof runPickpockets>>[]=[];void s.ended?.then(()=>{ended=true;});
 const alive=()=>{const at=state()?.player;return s.client===client&&!ended&&!!initial&&!!at&&!at.isDead&&at.lifeId===life&&(at.respawnCount??0)===respawns&&hp()>0&&client.executeBotAction===owner&&s.sdk.getStateAge()<=5000&&otherXp()===other0;};
 s=pocketOwnedActions(s,alive);
 const stop=()=>!alive()||pocketTripStop(s.name??'',requestStop)||s.tick()-start>=j.cap-j.returnTicks;
 const cleanupStop=()=>!alive()||s.tick()-start>=j.cap-25;
 const atBank=()=>{const at=state()?.player;return alive()&&!!at&&at.level===j.bank!.level&&Math.max(Math.abs(at.worldX-j.bank!.x),Math.abs(at.worldZ-j.bank!.z))<=3;};
 const open=async()=>{if(cleanupStop()||!atBank())throw Error('pickpocket bank original life/site unavailable');bankGeneration=Math.max(bankGeneration,s.bankObservation?.()?.generation??-1);await s.sdk.sendCloseModal();if(!await waitUntil(s,()=>state()?.bank.isOpen===false&&state()?.interface.isOpen===false&&state()?.dialog.isOpen===false,{timeoutTicks:8}))throw Error('pickpocket bank closure unobserved');if(cleanupStop()||!atBank())throw Error('pickpocket bank owner lost during closure');await s.bot.openBank();if(!await waitUntil(s,()=>cleanupStop()||!!state()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>bankGeneration,{timeoutTicks:12})||cleanupStop()||!state()?.bank.isOpen||!s.bankObservation?.())throw Error('pickpocket fresh bank unobserved');bankGeneration=s.bankObservation!()!.generation;};
 const all=()=>{const b=s.bankObservation?.();if(!state()?.bank.isOpen||!b)throw Error('pickpocket fresh bank ledger unavailable');return stock([...inv(),...gear(),...b.items]);};
 if(!initial||!Number.isSafeInteger(life)||!equipmentObserved(client)||state()?.combatStyle?.known!==true||controls0.retaliate===undefined||!Array.isArray(controls0.prayers)||client.membersAccount!==1||(s.sdk.getSkill('Thieving')?.level??0)<p.level||hp0<=j.hpFloor+p.damage||baseHp<hp0||j.eatAt>=baseHp)throw Error('pickpocket observed member/level/original HP/kit controls missing');
 if(p.name==='viking'&&!questFlags(client)?.some(q=>/fremennik/i.test(q.name)&&q.state==='complete'))throw Error('Fremennik Trials completion unobserved before owned withdrawal');
 const minimumHeal=Math.min(food.heal,baseHp-j.eatAt),requiredPerSuccess=Math.ceil(p.damage*j.attemptsPerSuccess/minimumHeal)+1;if(j.foodPerSuccess<requiredPerSuccess)throw Error('declared food budget cannot fund native failure damage and return healing');
 const heal=async(goal:number,continuity:()=>boolean=()=>true)=>{const guarded=()=>{if(!continuity()){uncertain=true;return false;}return alive();},foodSession=pocketOwnedActions(s,guarded);while(hp()<goal){if(!guarded())throw Error('pickpocket healing damage/ownership continuity changed');if(cleanupStop()||hp()<=j.hpFloor||uncertain)throw Error('pickpocket healing life/budget/unknown input');const row=inv().find(i=>i.id===j.food),before=pack(),old=hp(),beforeXp=xp();if(!row)throw Error('pickpocket owned return food exhausted');uncertain=true;let reply:unknown;try{reply=await foodSession.bot.eatFood(row);}catch(e){reply=e;}if(!guarded())throw Error('pickpocket healing damage/ownership continuity changed');const expected=Math.min(baseHp,old+food.heal),effect=()=>{const after=pack(),ids=new Set([...Object.keys(before),...Object.keys(after)]);return hp()===expected&&xp()===beforeXp&&[...ids].every(id=>(after[Number(id)]??0)-(before[Number(id)]??0)===(Number(id)===j.food?-1:0));};if(!await waitUntil(s,()=>!guarded()||effect(),{timeoutTicks:8})||!guarded()||!effect())throw Error('pickpocket return food unknown; no retry '+String(reply));uncertain=false;eaten++;for(let settled=0;settled<3;settled++){await waitTicks(s,1);if(!guarded()||!effect()){uncertain=true;throw Error('pickpocket food settlement life/stock/HP/XP changed');}}}};
 if(stop())return{ok:false,failure:'pickpocket stopped before bank input',verifiedSuccesses:0,verifiedFailures:0,eaten:0,balanced:false,recoveryDeferred:false};
 await open();const baseline=all();if((baseline[j.food]??0)<j.target*j.foodPerSuccess+(j.reserve??0)){await s.bot.closeBank();return{ok:false,failure:'pickpocket owned food stock short before withdrawals',verifiedSuccesses:0,verifiedFailures:0,eaten:0,balanced:true,recoveryDeferred:false};}
 const profile:BankProfile={bank:j.bank!,site:j.site!,inputs:{[j.food]:j.foodPerSuccess},tools:[],outputs:p.loot.map(i=>i.id),capacityOutputs:Object.fromEntries(p.loot.map(i=>[i.id,i.max])),deferBankRecovery:()=>uncertain,run:async(n,cap,_baselineHpStop)=>{
  let made=0;try{for(let attempts=0;made<n&&attempts<n*j.attemptsPerSuccess;attempts++){
   if(stop())throw Error('pickpocket stopped before next owned attempt');if(hp()<=j.hpFloor+p.damage)await heal(Math.min(hp0,j.eatAt+1));
   const cursor=Math.max(-1,...(state()?.gameMessages??[]).map(m=>m.observationId??m.tick)),at=s.tick(),packBefore=pack(),xpBefore=xp(),hpBefore=hp();uncertain=true;
   let r=await(deps.pocket??runPickpockets)(s,p,{successes:1,attempts:1,maxNoProgress:2,cap:Math.max(1,Math.min(cap,j.cap-j.returnTicks-(s.tick()-start))),hpFloor:j.hpFloor,eatAt:j.eatAt,food:j.food,foodReserve:0,xpRate:j.xpRate,members:true,stop});
   const freshMessages=(state()?.gameMessages??[]).filter(m=>m.type===0&&m.sender===''&&m.fromSelf===false&&Number.isSafeInteger(m.observationId)&&m.observationId!>cursor&&m.tick>=at&&m.tick<=s.tick()),success=freshMessages.some(m=>m.text==='You pick the '+p.pocket+'.'),failed=freshMessages.some(m=>m.text==='You fail to pick the '+p.pocket+'.');
   if(r.attempts===1&&r.eaten===0&&success!==failed){const event=success?'success':'failure',effect=pocketEffect(p,{items:packBefore,xp:xpBefore,hp:hpBefore},{items:pack(),xp:xp(),hp:hp()},event,j.xpRate);if(effect===event)r={...r,successes:success?1:0,failures:failed?1:0,xp:xp()-xpBefore,kitPreserved:true,failure:''};}
   receipts.push(r);
   if(r.attempts===0&&r.eaten===0&&!r.failure&&r.kitPreserved&&same(pack(),packBefore)&&xp()===xpBefore&&hp()===hpBefore){uncertain=false;throw Error('pickpocket no submitted attempt: '+r.stop);}
   const known=r.attempts===1&&r.kitPreserved&&!r.failure&&(r.successes===1&&r.failures===0&&r.xp===p.xp*j.xpRate||r.failures===1&&r.successes===0&&r.xp===0),text=r.successes===1?'You pick the '+p.pocket+'.':'You fail to pick the '+p.pocket+'.',native=freshMessages.some(m=>m.text===text);
   if(!known||!native)throw Error('pickpocket attempted outcome unknown; no repeat or bank mutation');uncertain=false;for(const[id,n]of Object.entries(r.loot))loot[Number(id)]=(loot[Number(id)]??0)+n;eaten+=r.eaten;verifiedSuccesses+=r.successes;verifiedFailures+=r.failures;made+=r.successes;
   const settleAt=at+(r.failures?p.stunTicks+2:2);while(s.tick()<settleAt){if(cleanupStop())throw Error('pickpocket native stun/action settlement stopped');await waitTicks(s,1);}
   if(r.failures){
    // Native damage publishes a400-client-cycle combat grace, even without an
    // attack target. Keep the lower worker's combat guard; settle this known hit.
    if(state()?.player?.combat.targetType!=='none'||state()?.nearbyPlayers.length!==0){uncertain=true;throw Error('pickpocket known failure healing target/peer changed');}
    const knownDamage=state()?.player?.combat.lastDamageTick,knownCombatCycle=(client.localPlayer as any)?.combatCycle;
    const knownContinuity=()=>state()?.player?.combat.lastDamageTick===knownDamage&&(client.localPlayer as any)?.combatCycle===knownCombatCycle&&state()?.nearbyPlayers.length===0&&state()?.player?.combat.targetType==='none'&&same(controls(),controls0)&&same(gear().map(i=>({id:i.id,count:i.count,slot:i.slot})),gear0);
    await heal(hp0,knownContinuity);if(!knownContinuity()){uncertain=true;throw Error('pickpocket known failure damage changed during healing');}
    const after=pack(),afterHp=hp(),afterXp=xp(),damage=state()?.player?.combat.lastDamageTick,combatCycle=(client.localPlayer as any)?.combatCycle;
    const quietChecks=()=>({alive:alive(),budget:!cleanupStop(),pack:same(pack(),after),hp:hp()===afterHp,xp:xp()===afterXp,controls:same(controls(),controls0),gear:same(gear().map(i=>({id:i.id,count:i.count,slot:i.slot})),gear0),peers:state()?.nearbyPlayers.length===0,target:state()?.player?.combat.targetType==='none',damage:state()?.player?.combat.lastDamageTick===damage,combatCycle:(client.localPlayer as any)?.combatCycle===combatCycle});
    const quietValid=()=>Object.values(quietChecks()).every(Boolean),cycle=client.getClientCycle?.();
    if(!Number.isSafeInteger(cycle)||!Number.isSafeInteger(combatCycle)||combatCycle-cycle>400){uncertain=true;throw Error('pickpocket known damage native combat clock unavailable');}
    // Lite runs50Hz independently of accelerated server ticks. One received
    // observation need not represent vanilla30 client cycles: reserve at most
    // the remaining400 cycles plus2 publications, inside the existing job cap.
    const quietTicks=Math.max(2,Math.min(402,combatCycle-cycle+2,j.cap-25-(s.tick()-start)));
    if(!await waitUntil(s,()=>{if(!quietValid()){uncertain=true;throw Error('pickpocket known failure quiet settlement changed '+JSON.stringify({checks:quietChecks(),tick:s.tick(),cycle:client.getClientCycle?.(),combatCycle:(client.localPlayer as any)?.combatCycle,initialCombatCycle:combatCycle,damage:state()?.player?.combat.lastDamageTick,initialDamage:damage,age:s.sdk.getStateAge()}));}return state()?.player?.combat.inCombat===false;},{timeoutTicks:quietTicks})||!quietValid()||state()?.player?.combat.inCombat!==false){uncertain=true;throw Error('pickpocket known failure combat grace unconfirmed; no next attempt');}
   }
  }if(made!==n)throw Error('pickpocket finite success/attempt budget unmet');await heal(hp0);console.log('PICKPOCKET_TRIP_BANK_HANDOFF '+JSON.stringify({made,verifiedSuccesses,verifiedFailures,eaten,hp:hp(),tick:s.tick()}));return made;
  }catch(error){if(!uncertain&&alive())try{await heal(hp0);}catch(recovery){throw Error(String(error)+'; healing '+String(recovery));}throw error;}
 }};
 const result=await(deps.bank??runBankProfile)(s,{...j,family:'pickpocket',recipe:j.profile,cap:j.cap-20,returnTicks:j.returnTicks-20},profile,()=>pocketTripStop(s.name??'',requestStop)||!alive());
 let balanced=false,bankAudit:Record<number,number>|undefined;
 if(!result.recoveryDeferred&&!uncertain&&result.atBank&&atBank()){await open();const actual=all(),ids=new Set([...Object.keys(baseline),...Object.keys(actual),...Object.keys(loot)]);balanced=[...ids].every(id=>(actual[Number(id)]??0)-(baseline[Number(id)]??0)===(loot[Number(id)]??0)-(Number(id)===j.food?eaten:0));bankAudit=stock(s.bankObservation!()!.items);await s.bot.closeBank();}
 const preserved=same(gear().map(i=>({id:i.id,count:i.count,slot:i.slot})),gear0)&&same(controls(),controls0)&&alive(),paidXp=xp()-xp0,exactXp=paidXp===verifiedSuccesses*p.xp*j.xpRate;
 return{...result,ok:result.ok&&balanced&&preserved&&exactXp&&hp()>=hp0,verifiedSuccesses,verifiedFailures,eaten,loot,balanced,preserved,exactXp,paidXp,bankAudit,receipts,recoveryDeferred:result.recoveryDeferred||uncertain,scope:'finite declared native pickpocket profile, owned bank food/refills, single-attempt known receipts and final fresh bank audit'};
}
if(import.meta.main){const[actor,path]=process.argv.slice(2);if(!actor||!path)throw Error('usage: microbot-pickpocket-trip.ts actor job.json');const raw=readFileSync(path);if(raw.length>32768)throw Error('pickpocket trip file too large');const j=JSON.parse(raw.toString('utf8'))as PickpocketTrip;validatePickpocketTrip(j);let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(actor);let ok=false;try{const r=await runPickpocketTrips(s,j,()=>stopped);console.log('PICKPOCKET_TRIP '+JSON.stringify(r));ok=r.ok;}finally{ok=await settle([s],ok,'finite owned pickpocket bank trips');}process.exitCode=ok?0:1;}
