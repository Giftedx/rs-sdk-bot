import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {openBot,settle,serverFromEnv,getWorld} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {assertSideOwns} from '../packages/core/src/fleet';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {xpForLevel} from '../packages/planner/src/curve';
import {transfer,ownedSwap,ess,state,runeOpening,runeConfirmation} from './rune-carrier-trade';
import {restock,inside,stopCarriers,bankCarrier,withdrawCarrier,closeCarrierBank,stageCarrier} from './rune-carrier-bank';
import {freshBodyStart} from './rune-carrier-start';
import {runeCarrierRoster,assertFreshRuneSkills,assertRuneDonor} from './rune-carrier-roster';
import {observeCraftCompletion,runeHandoffPipeline} from './rune-pipeline';

export function runeCraftAfter(value=process.env.RUNE_CRAFT_AFTER??'inventory'):'inventory'|'trade-message'{
 if(value!=='inventory'&&value!=='trade-message')throw Error('RUNE_CRAFT_AFTER must be inventory or trade-message');
 return value;
}
function bodyCraft(s:Session,n:number,previousXp:number,level:number,runes:number,rate:number,stop:()=>boolean,pipeline=false){
 const complete=()=>ess(s)===0&&Math.abs((s.sdk.getSkillXp('Runecraft')??0)-previousXp-n*rate)<=1
  &&s.sdk.getInventory().filter(i=>i.id===559).reduce((sum,i)=>sum+i.count,0)-runes===n*(Math.floor(level/46)+1);
 const boundary=pipeline?observeCraftCompletion(s,complete,stop):undefined;
 return {complete,boundary,dispose:()=>boundary?.dispose(),send:async()=>{
  if(stop())throw Error('body craft stopped');
  const altar=state(s).nearbyLocs.find(l=>l.id===2483);if(!altar||!inside(s))throw Error('body altar unobserved');
  const r=await s.direct({type:'interactLoc',x:altar.x,z:altar.z,locId:altar.id,optionIndex:1,reason:'SDK'});
  if(!(r as {success?:boolean})?.success)throw Error('body craft dispatch refused');
 }};
}

// One composed swarm job owns the complete roster; openBot retains fleet-side,
// worker-release and server admission for each session.
export async function runRuneCarriers(roster:readonly string[],cap=2800,options:{bodyContinuation?:boolean;measurePacks?:number}={}){
 if(options.bodyContinuation&&options.measurePacks!==undefined)throw Error('choose one body mode');
 const confirmation=runeConfirmation(),craftAfter=runeCraftAfter(),pipeline=runeHandoffPipeline(undefined,craftAfter);
 const names=runeCarrierRoster([...roster,options.measurePacks!==undefined?'--body-measure='+options.measurePacks:options.bodyContinuation?'--body-continuation':'--carriers']),root=resolve(import.meta.dir,'..');
 if(!Number.isSafeInteger(cap)||cap<1||cap>10000)throw Error('carrier tick budget must be1..10000');
 const servers=names.map(n=>{assertSideOwns(n);return serverFromEnv(readFileSync(join(root,'vendor/rs-sdk/bots',n,'bot.env'),'utf8'));});
 if(new Set(servers.map(s=>s.toLowerCase())).size!==1)throw Error('carrier participants must share one server');
 type Carrier={s:Session;ready:boolean;deliveries:number;refills:number[];flight?:Promise<void>};
 const opened:Session[]=[],crew:Carrier[]=[],rows:unknown[]=[],cancel=new AbortController(),crafts=new Set<ReturnType<typeof bodyCraft>>();let done=false,failure:unknown,monitor:(()=>void)|undefined;
 const stop=()=>{
  if(cancel.signal.aborted)return true;
  if(done||failure||opened.some(s=>s.tick()>cap)||names.some(n=>existsSync(join(root,'.practice/stop-'+n)))){cancel.abort(failure??Error('carrier route stopped'));stopCarriers();return true;}
  return false;
 };
 const fail=(s:Session,detail:string)=>{failure??=Error(s.name+': '+detail);cancel.abort(failure);stopCarriers();};
 const open=async(name:string)=>{const s=await openBot(name,{onStop:async(s,d)=>fail(s,d),onSessionEnd:async(s,d)=>fail(s,d)});opened.push(s);if(opened.length===1)monitor=s.onTick(()=>{stop();});return s;};
 const openTogether=async(list:readonly string[],ready:(s:Session)=>Promise<void>=async()=>{})=>{
  let firstFailure:{reason:unknown}|undefined;
  const results=await Promise.allSettled(list.map(async name=>{
   try{if(stop())throw Error('carrier opening stopped');const s=await open(name);await ready(s);if(stop())throw Error('carrier opening stopped');return s;}
   catch(reason){firstFailure??={reason};cancel.abort(reason);stopCarriers();throw reason;}
  }));
  // A rejected open cannot leave another connection arriving after cleanup.
  if(firstFailure)throw firstFailure.reason;
  return results.map(r=>(r as PromiseFulfilledResult<Session>).value);
 };
 const launchRefill=(d:Carrier)=>{d.flight=restock(d.s).then(t=>{d.refills.push(t);d.ready=true;}).catch(e=>{if(!done){failure=e;cancel.abort(e);stopCarriers();}});};
 try{
  await getWorld();
  if(options.bodyContinuation||options.measurePacks!==undefined){
   if(stop())throw Error('continuation opening stopped');const s=await open(names[0]!);
   const helpers=await openTogether(names.slice(1));
   const result=await continueRuneBody(s,helpers,stop,{measurePacks:options.measurePacks,craftAfter,pipeline});
   if(stop())throw Error('continuation stopped before logout');
   done=true;const logout=await settle(opened,true,options.measurePacks===undefined?'persisted body Runecraft99 banked':'bounded body measurement banked');return {ok:logout,...result,logout};
  }
  const donor=await open(names[1]!);await waitTicks(donor,3);assertRuneDonor(state(donor).player,donor.sdk.getInventory());
  if(stop()||cap-donor.tick()<2300)throw Error('donor warmup leaves insufficient fresh route budget');
  const s=await open(names[0]!);if(!await waitUntil(s,()=>!!state(s)?.player&&!!s.sdk.getSkill('Runecraft'),{timeoutTicks:10}))throw Error('fresh player state unavailable');
  assertFreshRuneSkills(state(s).skills);
  const prefix=await freshBodyStart(s,donor,stop,async()=>{
   // Same-address player turns follow login order. Open carriers after the
   // crafter, during its travel, so its expired craft delay clears first.
   const helpers=await openTogether(names.slice(2),async h=>{
    await waitTicks(h,3);
    if(!inside(h)||ess(h)!==27||h.sdk.getInventory().filter(i=>i.id===1446).reduce((sum,i)=>sum+i.count,0)!==1)throw Error('staged carrier not observed');
    if(stop()||cap-h.tick()<2300)throw Error('helper warmup leaves insufficient fresh route budget');
   });
   crew.push(...helpers.map(s=>({s,ready:true,deliveries:0,refills:[]})));
   console.log('RUNE_CARRIER_READY '+JSON.stringify({masterTick:s.tick(),actors:crew.map(h=>({name:h.s.name,tick:h.s.tick(),remaining:cap-h.s.tick()}))}));
  },cancel);
  const initial:Carrier={s:donor,ready:false,deliveries:1,refills:[]};crew.push(initial);launchRefill(initial);
  const xp=()=>s.sdk.getSkillXp('Runecraft')??0,start=s.tick(),startedAt=performance.now();let batches=1,waiting=0,previousCraft:ReturnType<typeof bodyCraft>|undefined;
  while(xp()<xpForLevel(99)){
   if(stop())throw failure??Error('carrier route stopped or over budget');
   let d=crew.filter(h=>h.ready).sort((a,b)=>a.deliveries-b.deliveries)[0];
   if(!d){const at=s.tick();if(!await waitUntil(s,()=>stop()||crew.some(h=>h.ready),{timeoutTicks:190}))throw Error('no carrier returned');waiting+=s.tick()-at;if(stop())throw failure??Error('carrier route stopped');d=crew.filter(h=>h.ready).sort((a,b)=>a.deliveries-b.deliveries)[0];}
   if(!d)throw Error('no owned ready carrier');d.ready=false;const before=xp(),at=s.tick();
   const tal=s.sdk.getInventory().filter(i=>i.id===1446).reduce((n,i)=>n+i.count,0),runes=s.sdk.getInventory().filter(i=>i.id===559).reduce((n,i)=>n+i.count,0);
   const craft=bodyCraft(s,27,before,s.sdk.getSkill('Runecraft')?.baseLevel??0,runes,Number(process.env.BODY_XP_RATE??25)*7.5,stop,pipeline),coupled=craftAfter==='trade-message'&&tal!==1;crafts.add(craft);
   const tradeTicks=tal===1?(await ownedSwap(s,d.s,{1446:1},{1436:27},stop)).ticks:await transfer(s,d.s,stop,27,coupled?craft:undefined,pipeline?{boundary:previousCraft?.boundary}:undefined);
   if(stop())throw failure??Error('carrier route stopped');d.deliveries++;launchRefill(d);
   if(!coupled)await craft.send();
   if(!await waitUntil(s,()=>stop()||craft.complete(),{timeoutTicks:15})||stop())throw Error('body craft effect unobserved or stopped');
   batches++;const row={batch:batches,helper:d.s.name,tick:s.tick(),elapsedMs:performance.now()-startedAt,ticks:s.tick()-at,tradeTicks,xp:xp(),level:s.sdk.getSkill('Runecraft')?.baseLevel,waiting};rows.push(row);console.log('RUNE_CARRIER_BATCH '+JSON.stringify(row));
   if(previousCraft){previousCraft.dispose();crafts.delete(previousCraft);}previousCraft=craft;
  }
  const levelTick=s.tick();done=true;stopCarriers();await Promise.allSettled(crew.map(h=>h.flight));
  const result={craftAfter,pipeline,opening:runeOpening(),confirmation,prefix,batches,xp:xp(),level:s.sdk.getSkill('Runecraft')?.baseLevel,levelTick,masterTicks:s.tick(),bodyLoopTicks:levelTick-start,waiting,rows,crew:crew.map(h=>({name:h.s.name,deliveries:h.deliveries,refills:h.refills}))};
  const logout=await settle(opened,true,'fresh Runecraft99 with carrier banks');return {ok:logout,...result,logout};
 }catch(error){for(const craft of crafts)craft.dispose();const reason=failure??error;done=true;cancel.abort(reason);stopCarriers();await Promise.allSettled(crew.map(h=>h.flight));const logout=await settle(opened,false,String(reason));return {ok:false,confirmation,failure:String(reason),logout};}finally{for(const craft of crafts)craft.dispose();monitor?.();}
}

function measurementNeed(xp:number,rate:number,packs:number){
 if(!Number.isSafeInteger(packs)||packs<12||packs>48)throw Error('body measurement requires12..48 full packs');
 if(!Number.isFinite(xp)||xp<xpForLevel(99)||!Number.isFinite(rate)||rate<=0||xp+packs*27*rate>200000000)throw Error('body measurement needs99 with observable XP headroom');
 return packs*27;
}
export function continuationLoads(xp:number,stocks:readonly number[],xpPerEssence=187.5,measurePacks?:number){
 const measure=measurePacks!==undefined;
 if(!Number.isFinite(xp)||(!measure&&(xp<xpForLevel(20)||xp>=xpForLevel(99))))throw Error('body continuation needs an existing supplied body crafter below99');
 if(!Number.isFinite(xpPerEssence)||xpPerEssence<=0||stocks.some(n=>!Number.isSafeInteger(n)||n<0))throw Error('invalid continuation supply or XP rate');
 const needed=measure?measurementNeed(xp,xpPerEssence,measurePacks):Math.ceil((xpForLevel(99)-xp)/xpPerEssence),remaining=[...stocks],loads=stocks.map(()=>[] as number[]);
 if(stocks.reduce((a,b)=>a+(measure?Math.floor(b/27)*27:b),0)<needed)throw Error(`continuation essence shortage: need${needed}`);
 let left=needed;
 while(left>0){let advanced=false;
  for(let i=0;i<stocks.length&&left>0;i++){
   const n=measure?(remaining[i]!>=27?27:0):Math.min(27,left,remaining[i]!);if(!n)continue;
   loads[i]!.push(n);remaining[i]!-=n;left-=n;advanced=true;
  }
  if(!advanced)throw Error('continuation allocation made no progress');
 }
 return {needed,loads,xpPerEssence};
}

// The session owner retains cleanup. This path never calls the tutorial or starter swaps.
export async function continueRuneBody(s:Session,helpers:readonly Session[],stop:()=>boolean,options:{measurePacks?:number;craftAfter?:'inventory'|'trade-message';pipeline?:boolean}={}){
 if(helpers.length!==16)throw Error('body continuation requires16 helpers');
 const confirmation=runeConfirmation(),craftAfter=runeCraftAfter(options.craftAfter),pipeline=runeHandoffPipeline(options.pipeline===undefined?undefined:options.pipeline?'1':'0',craftAfter);
 const all=[s,...helpers],check=()=>{if(stop())throw Error('body continuation stopped or over budget');};
 const xp=()=>s.sdk.getSkillXp('Runecraft')??0;
 if(!await waitUntil(s,()=>stop()||!!state(s)?.player&&!!s.sdk.getSkill('Runecraft'),{timeoutTicks:20}))throw Error('continuation entry unobserved');check();
 const xp0=xp(),measure=options.measurePacks!==undefined;
 if(ess(s)!==0||!measure&&(xp0<xpForLevel(20)||xp0>=xpForLevel(99)))throw Error('body continuation needs a persisted body crafter below99 with no carried essence');
 if(measure&&(s.sdk.getSkill('Runecraft')?.baseLevel!==99||!Number.isFinite(xp0)||xp0<xpForLevel(99)))throw Error('body measurement requires an existing99 crafter');
 if(measure)measurementNeed(xp0,Number(process.env.BODY_XP_RATE??25)*7.5,options.measurePacks!);
 const health=all.map(a=>a.sdk.getSkill('Hitpoints')?.level),equipment=all.map(a=>JSON.stringify(a.sdk.getEquipment()));
 const parallel=async<T>(work:Promise<T>[])=>{
  let firstFailure: {reason:unknown}|undefined;
  const results=await Promise.allSettled(work.map(p=>p.catch(e=>{firstFailure??={reason:e};stopCarriers();throw e;})));
  if(firstFailure)throw firstFailure.reason;
  return results.map(r=>(r as PromiseFulfilledResult<T>).value);
 };
 const before=await parallel(all.map(a=>bankCarrier(a)));check();
 const plan=continuationLoads(xp0,before.slice(1).map(b=>b[1436]??0),Number(process.env.BODY_XP_RATE??25)*7.5,options.measurePacks);
 const loan=helpers.findIndex((_,i)=>(before[i+1]![1446]??0)>=2&&plan.loads[i]!.length>0);
 if(loan<0||before.slice(1).some(b=>(b[1446]??0)<1))throw Error('continuation needs retained helper talismans and one spare owned access talisman');
 const donor=helpers[loan]!;
 await withdrawCarrier(donor,1446,1);await closeCarrierBank(donor);await closeCarrierBank(s);
 await ownedSwap(s,donor,{}, {1446:1},stop);check();
 // The first delivery returns the loan to this helper before its next bank visit.
 await bankCarrier(donor);
 const crew=helpers.map((h,i)=>({s:h,loads:[...plan.loads[i]!],ready:false,amount:0,spent:0,flight:undefined as Promise<void>|undefined}));
 let childFailure:unknown;
 const launch=(d:typeof crew[number],fromBank=false)=>{
  const n=d.loads.shift();if(n===undefined){if(fromBank)d.flight=closeCarrierBank(d.s).catch(e=>{childFailure??=e;stopCarriers();});return;}
  d.amount=n;d.flight=stageCarrier(d.s,n,fromBank).then(()=>{d.ready=true;}).catch(e=>{childFailure??=e;stopCarriers();});
 };
 let consumed=0,crafted=0,batches=0;const rows:unknown[]=[],crafts=new Set<ReturnType<typeof bodyCraft>>();let startedAt=0,previousCraft:ReturnType<typeof bodyCraft>|undefined;
 try{
  // Every helper starts with an observed, reconciled bank. Only finite allocated loads leave it.
  crew.forEach(d=>launch(d,true));
  const {enterBody}=await import('./rune-carrier-bank');await enterBody(s);check();
  startedAt=performance.now();
  while(consumed<plan.needed){
   if(childFailure)throw childFailure;check();
   const ready=()=>batches===0?crew[loan]!.ready:crew.some(d=>d.ready);
   if(!await waitUntil(s,()=>stop()||!!childFailure||ready(),{timeoutTicks:250}))throw Error('continuation carrier return unobserved');
   if(childFailure)throw childFailure;check();
   const d=batches===0?crew[loan]!:crew.filter(d=>d.ready).sort((a,b)=>a.spent-b.spent)[0]!;d.ready=false;
   const n=d.amount,prev=xp(),level=s.sdk.getSkill('Runecraft')?.baseLevel??0,runes=s.sdk.getInventory().filter(i=>i.id===559).reduce((a,b)=>a+b.count,0);
   const craft=bodyCraft(s,n,prev,level,runes,plan.xpPerEssence,stop,pipeline),coupled=batches!==0&&craftAfter==='trade-message';crafts.add(craft);
   if(batches===0)await ownedSwap(s,d.s,{1446:1},{1436:n},stop);
   else await transfer(s,d.s,stop,n,coupled?craft:undefined,pipeline?{boundary:previousCraft?.boundary}:undefined);
   check();if(!coupled&&ess(s)!==n)throw Error('continuation transfer count mismatch');
   d.spent+=n;launch(d);
   if(!coupled){await s.bot.dismissBlockingUI();check();await craft.send();}
   if(!await waitUntil(s,()=>stop()||craft.complete(),{timeoutTicks:15}))throw Error('continuation craft effects unobserved');check();
   const made=s.sdk.getInventory().filter(i=>i.id===559).reduce((a,b)=>a+b.count,0)-runes;
   if(ess(s)!==0||made!==n*(Math.floor(level/46)+1)||Math.abs(xp()-prev-n*plan.xpPerEssence)>1)throw Error('continuation craft debit, product or XP mismatch');
   consumed+=n;crafted+=made;batches++;rows.push({batch:batches,helper:d.s.name,consumed:n,crafted:made,xp:xp(),tick:s.tick(),elapsedMs:performance.now()-startedAt});
   console.log('RUNE_CONTINUATION_BATCH '+JSON.stringify(rows.at(-1)));
   if(previousCraft){previousCraft.dispose();crafts.delete(previousCraft);}previousCraft=craft;
  }
  await Promise.all(crew.map(d=>d.flight));if(childFailure)throw childFailure;check();
  if(xp()<xpForLevel(99)||s.sdk.getSkill('Runecraft')?.baseLevel!==99)throw Error('continuation99 unobserved');
  if(measure&&(batches!==options.measurePacks||consumed!==options.measurePacks!*27||Math.abs(xp()-xp0-consumed*plan.xpPerEssence)>1))throw Error('bounded measurement effects unobserved');
  const after=await parallel(all.map(a=>bankCarrier(a)));check();
  for(let i=0;i<all.length;i++){
   const ids=new Set([...Object.keys(before[i]!),...Object.keys(after[i]!)]);
   for(const key of ids){const id=Number(key),delta=(after[i]![id]??0)-(before[i]![id]??0),expected=id===1436?(i===0?0:-crew[i-1]!.spent):id===559&&i===0?crafted:0;
    if(delta!==expected)throw Error(`continuation asset mismatch ${all[i]!.name} item${id}: ${delta} expected${expected}`);
   }
   if((all[i]!.sdk.getSkill('Hitpoints')?.level??0)<(health[i]??1)||ess(all[i]!)!==0||JSON.stringify(all[i]!.sdk.getEquipment())!==equipment[i])throw Error('continuation health, equipment or pack mismatch');
  }
  await Promise.all(all.map(a=>closeCarrierBank(a)));check();
  return {mode:measure?'body-measure':'body-continuation',craftAfter,pipeline,opening:runeOpening(),confirmation,requestedPacks:options.measurePacks,xp0,xp:xp(),level:s.sdk.getSkill('Runecraft')?.baseLevel,batches,consumed,crafted,plan,before,after,rows,masterTicks:s.tick(),accountTicks:all.map(a=>({name:a.name,ticks:a.tick()}))};
 }catch(error){for(const craft of crafts)craft.dispose();stopCarriers();throw error;}finally{for(const craft of crafts)craft.dispose();await Promise.allSettled(crew.map(d=>d.flight));}
}
