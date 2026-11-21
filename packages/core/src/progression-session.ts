import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import type {SessionCore as Session,BankObservation} from './session-types';
import {isLocalServer} from './localserver';
import {equipmentObserved} from './container-observation';
import {questFlags} from './quest-status';
import {createProgressionMonitor,methodSupportsWork,snapshotForProgression,type WorkDescriptor,type PolicyEvaluation} from './progression-policy';
import {requireProgressionAdapter,type CatalogAccept,type ObservedAccount,type PerformanceWindow,type ProgressionAdapter,type ProgressionAdmission,type ProgressionCatalog,type ProgressionDecision,type ProgressionMethod,type WorkIntent} from './progression-adapter';
import {cachedReleaseFor} from './worker-release';
import {readProgressionMeasurements,writeProgressionEvidence} from './progression-evidence';
import {DISEMBARK_PLANK_IDS} from './boat';

const root=resolve(import.meta.dir,'../../..');
const read=(file:string)=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
const entry=(file:string)=>file.replace(/\\/g,'/').replace(/^.*?\/(scripts|packages)\//,'$1/');
const catalogs=new WeakMap<ProgressionAdapter,ProgressionCatalog>();
const catalog=(adapter:ProgressionAdapter)=>{let c=catalogs.get(adapter);if(!c){c=adapter.loadProgressionCatalog(root);catalogs.set(adapter,c);}return c;};
export function processWork(script=process.argv[1]??'',argv=process.argv.slice(3),env=process.env):WorkDescriptor{return{script:entry(script),args:[...argv],env:{...env}};}

export interface ProgressionSession{
 decision():ProgressionDecision|null;
 evaluation():PolicyEvaluation|null;
 refresh(boundary?:string):PolicyEvaluation|null;
 refusal(action:unknown):string|null;
 onHandoff(handler:(detail:string)=>void):void;
 executing(method:string):void;
 method():string|null;
 binding():{boundMethod:string|null;source:string|null;consumer:CatalogAccept|null};
}

export function finiteProgressionAccept(value:unknown):CatalogAccept|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const v=value as CatalogAccept,keys=Object.keys(v);
 if(!keys.length||keys.some(k=>!['skills','bank','quests','counters'].includes(k)))return;
 const counts=(rows:unknown,kind:'skill'|'item'|'counter')=>!!rows&&typeof rows==='object'&&!Array.isArray(rows)&&Object.keys(rows).length>0&&Object.entries(rows).every(([key,n])=>key.trim().length>0&&typeof n==='number'&&Number.isSafeInteger(n)&&n>0&&(kind!=='skill'||n<=99)&&(kind!=='item'||/^[1-9]\d*$/.test(key)));
 if(v.skills!==undefined&&!counts(v.skills,'skill')||v.bank!==undefined&&!counts(v.bank,'item')||v.counters!==undefined&&!counts(v.counters,'counter')||v.quests!==undefined&&(!Array.isArray(v.quests)||!v.quests.length||!v.quests.every(q=>typeof q==='string'&&q.trim().length>0)))return;
 return structuredClone(v);
}
export function parentProgressionAccept(work:WorkDescriptor,account?:string,base=root):CatalogAccept|undefined{
 const id=work.env.COORDINATOR_RUN_ID;
 const record=id?read(join(base,'.practice/coordinator/state.json'))?.tasks?.find((r:any)=>r.runId===id&&(!account||r.spec?.account?.toLowerCase()===account.toLowerCase())):undefined;
 if(record)return finiteProgressionAccept(record.spec?.accept);
 try{return finiteProgressionAccept(JSON.parse(work.env.PROGRESSION_CONSUMER??'null'));}catch{return;}
}
export function preflightProgressionWork(work:WorkDescriptor,server:string,c?:ProgressionCatalog,account?:string,adapter?:ProgressionAdapter):void{
 if(isLocalServer(server))return;
 if(work.env.PROGRESSION_SOURCE&&work.env.WORKER_RELEASE&&work.env.PROGRESSION_SOURCE!==work.env.WORKER_RELEASE)throw Error('progression source claim differs from the admitted worker release');
 const p=requireProgressionAdapter(adapter),cat=c??catalog(p);
 const file=entry(work.script),record=cat.entries.find(e=>entry(e.script)===file);
 if(!record)throw Error('progression entry is unmapped: '+file);
 if((record as {practiceOnly?:boolean}).practiceOnly)throw Error('progression measurement entry is local practice only: '+file);
 if(!p.intentForEntry(file,work.args,work.env,parentProgressionAccept(work,account),cat))throw Error('progression entry requires a finite goal: '+file);
}

export function progressionProofs(base=root):Record<string,{source:string;bands:any[];samples?:any[]}>{
 const index=read(join(base,'.practice/progression-system/qualifications.json')),result:Record<string,{source:string;bands:any[];samples?:any[]}>={};
 for(const reference of Array.isArray(index?.proofs)?index.proofs:[]){
  try{
   const bytes=readFileSync(reference.path),proof=JSON.parse(bytes.toString());
   if(createHash('sha256').update(bytes).digest('hex')!==reference.sha256||proof.ok!==true||!proof.source||!Array.isArray(proof.supportedMethods))continue;
   for(const method of proof.supportedMethods)if(method.source===proof.source&&Array.isArray(method.bands)&&method.bands.length){
    const prior=result[method.id],bands=prior?.source===proof.source?[...prior.bands,...method.bands]:method.bands;
    result[method.id]={source:proof.source,bands:[...new Map(bands.map((band:any)=>[JSON.stringify(band),band])).values()]};
   }
  }catch{/* An absent or modified native artifact never authorizes a route. */}
 }
 return result;
}
export function progressionRateConditions(status:any):string{
 return JSON.stringify([status.skills?.map((k:any)=>[k.name,k.baseLevel??k.level,k.currentLevel??null]).sort((a:any,b:any)=>String(a[0]).localeCompare(String(b[0]))),status.equipment?.map((i:any)=>[i.slot,i.id]).sort((a:any,b:any)=>a[0]-b[0]),status.progressionCrowding??null,status.server,status.progressionContext??null]);
}
function measuredWorkRates(methods:ProgressionMethod[],work:WorkDescriptor,status:any,base:string):ProgressionMethod[]{
 return methods.map(method=>{
  const skill=Object.keys(method.effects.xp??{})[0],level=status?.skills?.find((k:any)=>k.name?.toLowerCase()===skill?.toLowerCase())?.level;
  if(!skill||!Number.isSafeInteger(level))return method;
  const source=entry(method.step.script)===entry(work.script)&&work.env.WORKER_RELEASE?work.env.WORKER_RELEASE:method.source;
  if(!status.progressionContext)return method;
  const conditions=progressionRateConditions(status);
  const path=join(base,'.practice/progression-system/measurements',createHash('sha256').update(method.id+'|'+source+'|'+conditions).digest('hex'));
  const observed=readProgressionMeasurements(path,method.id,source,conditions);
  const windows=observed.windows.filter((w:any)=>w.ticks-w.setupTicks>=100&&Number.isFinite(w.units)&&w.units>0);
  if(windows.length<3)return method;
  const rates=windows.map((w:any)=>w.units/(w.ticks-w.setupTicks)).sort((a:number,b:number)=>a-b),mid=Math.floor(rates.length/2),rate=rates.length%2?rates[mid]!:(rates[mid-1]!+rates[mid]!)/2;
  return{...method,source,rate:{unitsPerTick:rate,basis:'measured' as const,evidence:path,
   samples:windows.map((w:any)=>({units:w.units,ticks:w.ticks,setupTicks:w.setupTicks,evidence:path,source,conditions:{levels:{[skill]:{min:level,max:level}},loadout:status.equipment?.map((i:any)=>i.id),server:status.server}}))}};
 });
}
export function evaluateProgressionWork(work:WorkDescriptor,status:any,options:{now?:number;catalog?:ProgressionCatalog;accept?:CatalogAccept;requireQualification?:boolean;continuing?:boolean;currentMethod?:string;admitted?:ProgressionAdmission;base?:string;adapter?:ProgressionAdapter}={}):PolicyEvaluation{
 const p=requireProgressionAdapter(options.adapter);
 const c=options.catalog??catalog(p),now=options.now??Date.now(),base=options.base??root,intent=p.intentForEntry(entry(work.script),work.args,work.env,options.accept??parentProgressionAccept(work,status?.name,base),c);
 if(!intent)return{supported:false,intent:null,decision:null,reason:'unmapped progression entry or finite consumer: '+entry(work.script)};
 const plan=read(join(base,'swarm.json')),kit=Object.entries(plan?.builds??{}).find(([name])=>name.toLowerCase()===status?.name?.toLowerCase())?.[1];
 const account=p.accountFromStatus(status?.name??'unknown',status,now);
 if(typeof kit==='string'&&c.buildLimits?.[kit])account.build={maxLevels:c.buildLimits[kit]};
 const listed=p.progressionMethods(intent,account,c,{now});
 const sources:Record<string,string>={},qualifications:Record<string,NonNullable<ProgressionMethod['qualification']>>={};
 // A native state-band proof is additional to the controller's existing source
 // qualification. It cannot authorize an entry whose worker pin differs.
 const proofs=progressionProofs(base);
 for(const method of listed.methods){
  const proof=proofs[method.id];if(!proof)continue;
  const source=entry(method.step.script)===entry(work.script)&&work.env.WORKER_RELEASE?work.env.WORKER_RELEASE:cachedReleaseFor([method.step.script],base);
  if(proof.source!==source)continue;
  sources[method.id]=source;qualifications[method.id]={source,bands:proof.bands};
 }
 const methods=measuredWorkRates(Object.keys(qualifications).length?p.progressionMethods(intent,account,c,{now,sources,qualifications}).methods:listed.methods,work,status,base);
 const current=methods.find(m=>m.id===options.currentMethod)??methods.find(m=>methodSupportsWork(m.step,work,p));
 // Unpriced methods stay in the evidence ledger. They cannot participate in a
 // timed route yet; excluding them from the search avoids repeated quadratic
 // dependency scans over the same unresolved catalog rows on every boundary.
 const timed=methods.filter(m=>m.rate.unitsPerTick!==null&&Object.values(m.costs).every(v=>v!==null));
 const decision=p.chooseProgression(intent,account,timed,{now,currentMethod:current?.id,continuing:options.continuing,admitted:options.admitted,requireQualification:options.requireQualification??false,crowding:status.progressionCrowding,maxSearchNodes:256,maxDepth:6});
 let projected=account;
 for(const path of decision.path){const method=methods.find(m=>m.id===path.method);if(method){
  const gain=intent.kind==='train'?Object.entries(method.effects.xp??{}).find(([name])=>name.toLowerCase()===intent.skill.toLowerCase())?.[1]??0:0;
  const from=intent.kind==='train'?Object.entries(projected.skills).find(([name])=>name.toLowerCase()===intent.skill.toLowerCase())?.[1].xp??0:0;
  const boundary=intent.kind==='train'&&gain>0?{...intent,targetLevel:Math.min(intent.targetLevel,p.levelForXp(from+path.units*gain))}:intent;
  path.step=p.progressionStep(method,path.units,boundary,projected,c);
  const skills={...projected.skills};for(const [skill,xpGain]of Object.entries(method.effects.xp??{})){
   const name=Object.keys(skills).find(name=>name.toLowerCase()===skill.toLowerCase())??skill,xp=(skills[name]?.xp??0)+xpGain*path.units;
   skills[name]={xp,level:p.levelForXp(xp)};
  }
  projected={...projected,skills};
 }}
 if(decision.path[0])decision.step=decision.path[0].step;
 decision.gaps=[...new Set([...decision.gaps,...listed.gaps.map(g=>g.method+': '+g.reason)])];
 const selected=decision.path[0]?.step??decision.step;
 // Unknown comparisons request evidence. They do not turn an already admitted,
 // finite authored job into either a measured winner or an unbounded idle loop.
 const expired=!!options.currentMethod&&!!qualifications[options.currentMethod]&&decision.alternatives.some(a=>a.method===options.currentMethod&&a.state==='qualify');
 const targets=p.trainingTargets(intent),aboveBuild=targets&&Object.entries(account.build?.maxLevels??{}).some(([skill,cap])=>targets[skill.toLowerCase()]!==undefined&&targets[skill.toLowerCase()]!>cap);
 const missingTargets=intent.kind==='train-all'&&(!targets||account.at<=0||account.at>now||now-account.at>300000||Object.keys(targets).some(skill=>!Object.hasOwn(account.skills,skill)));
 const unknownBuild=!!current&&Object.keys(account.build?.maxLevels??{}).some(skill=>Object.entries(current.effects.xp??{}).some(([name,gain])=>name.toLowerCase()===skill.toLowerCase()&&gain>0)&&!Object.keys(account.skills).some(name=>name.toLowerCase()===skill.toLowerCase()));
 const constraint=aboveBuild?'finite goal exceeds the account build ceiling':missingTargets?'finite training goal needs valid observations for every target':unknownBuild?'side XP requires observations for the account build':account.clock?.protected&&!account.clock.authorized?'protected account clock needs its authorized launch':decision.state==='blocked'&&decision.followUps.some(f=>f.reason.some(r=>r.includes('account build')))?'side XP exceeds the account build ceiling':undefined;
 if(intent.kind==='train-all')decision.gaps.push('Compound training has no scalar live-rate sample; compare source/state-matched per-skill effects before claiming a measured finish time.');
 const claimed=work.env.PROGRESSION_METHOD,claimMismatch=!!claimed&&decision.state==='execute'&&claimed!==decision.selected;
 const supported=decision.state==='complete'||expired||constraint||claimMismatch?false:decision.state!=='execute'||!selected?true:methodSupportsWork(selected,work,p);
 const reason=supported?undefined:constraint??(claimMismatch?'progression resource claim '+claimed+' does not cover selected method '+decision.selected:decision.state==='complete'?'finite progression goal complete':expired?'current method left its qualified state band':selected?'selected method '+decision.selected+' requires '+selected.script:'progression needs an observed supported route');
 return{supported,intent,decision,reason,methods,account};
}

function observedStatus(s:Session,prior:any,now:number):any{
 const state=s.sdk.getState(),bank=s.bankObservation?.()??null;
 const merged=snapshotForProgression(prior,state,bank,now),flags=questFlags(s.client);
 merged.name=s.name;merged.server=prior.server;merged.equipmentObserved=!!s.client&&equipmentObserved(s.client);merged.progressionCrowding=state?.nearbyPlayers?.length??0;
 merged.progressionContext={style:state?.combatStyle??null,prayers:state?.prayers?.activePrayers??null};
 if(flags){merged.quests=flags;merged.questsAt=now;}
 return merged;
}
function writeDecision(base:string,s:Session,work:WorkDescriptor,evaluation:PolicyEvaluation,now:number,performance?:unknown,executing?:string){
 const dir=join(base,'.practice/progression-system/decisions');
 const file=join(dir,s.name+'.json');
 const value={version:1,account:s.name,at:now,source:work.env.WORKER_RELEASE??null,entry:entry(work.script),intent:evaluation.intent,
  supported:evaluation.supported,decision:evaluation.decision,reason:evaluation.reason??null,...performance?{performance}:{},...executing?{executing}:{}};
 writeProgressionEvidence(file,value,console.warn);
}

export function attachProgressionSession(s:Session&{progression?:ProgressionSession},work:WorkDescriptor,server:string,options:{base?:string;evaluate?:(status:any)=>PolicyEvaluation;log?:(line:string)=>void;adapter?:ProgressionAdapter}={}):ProgressionSession{
 const base=options.base??root,log=options.log??console.log;
 work=structuredClone(work);
 const consumer=parentProgressionAccept(work,s.name,base);
 const previous=read(join(base,'.practice/status',s.name+'.json'));
 let prior=previous?.name?.toLowerCase()===s.name.toLowerCase()&&previous.server===server?previous:{name:s.name,server};
 let handler:((detail:string)=>void)|undefined,stopped=false,lastWritten='',lastCheck=-100,dirty='',lastGeneration=-1,wasInCombat=false;
 let current:PolicyEvaluation|null=null,executing:string|undefined,admitted:ProgressionAdmission|undefined;
 type CannonPlacement={x:number;z:number;level:number;baseCount:number;tick:number;messages:Set<string>};
 let pendingCannon:CannonPlacement|undefined,ownedCannon:CannonPlacement|undefined;
 const cannonWorker=entry(work.script)==='scripts/cannon-fight.ts';
 const cannonLoc=(loc:any)=>Number.isSafeInteger(loc?.id)&&loc.id>=6&&loc.id<=9;
 const baseCount=(state:any)=>(state?.inventory??[]).filter((i:any)=>i.id===6&&Number.isSafeInteger(i.count)&&i.count>0).reduce((n:number,i:any)=>n+i.count,0);
 const messageKey=(message:any)=>`${message.observationId??''}:${message.tick}:${message.text}`;
 // cannon_setup.rs2 binds ownedmcannon to the centre's south-west tile when it consumes one base and adds loc7.
 // Remember only this session's observed placement. The server also checks ownership before native Pick-up.
 const observeCannon=()=>{
  if(!cannonWorker)return;
  const state=s.sdk.getState(),count=baseCount(state),locs=state?.nearbyLocs??[];
  if(ownedCannon&&count>=ownedCannon.baseCount&&!locs.some((loc:any)=>cannonLoc(loc)&&loc.x===ownedCannon!.x&&loc.z===ownedCannon!.z))ownedCannon=undefined;
  if(!pendingCannon)return;
  if(s.tick()-pendingCannon.tick>10||s.tick()<pendingCannon.tick){pendingCannon=undefined;return;}
  if(s.tick()>pendingCannon.tick&&count===pendingCannon.baseCount-1&&state?.player?.level===pendingCannon.level
   &&(state?.gameMessages??[]).some((message:any)=>message.text==='You place the cannon base on the ground.'&&!pendingCannon!.messages.has(messageKey(message)))
   &&locs.some((loc:any)=>loc.id===7&&loc.x===pendingCannon!.x&&loc.z===pendingCannon!.z)){
   ownedCannon=pendingCannon;pendingCannon=undefined;
  }
 };
 const windows:PerformanceWindow[]=[];
 let window:{tick:number;xp:number;setup:number;started:boolean;lastTick:number;conditions:string}|null=null;
 const evaluate=()=>{
  prior=observedStatus(s,prior,Date.now());
  current=options.evaluate?.(prior)??evaluateProgressionWork(work,prior,{base,accept:consumer,requireQualification:true,continuing:!!executing,currentMethod:executing,admitted,adapter:options.adapter});
  const key=JSON.stringify([current.supported,current.decision?.selected,current.decision?.state,current.decision?.followUps]);
  if(key!==lastWritten){
   writeDecision(base,s,work,current,Date.now(),undefined,executing);lastWritten=key;
   log('PROGRESSION '+JSON.stringify({account:s.name,intent:current.intent,selected:current.decision?.selected??null,state:current.decision?.state??'unmapped',basis:current.decision?.basis??'unknown',expectedTicks:current.decision?.expectedTicks??null,supported:current.supported,followUps:current.decision?.followUps.length??0}));
  }
  return current;
 };
 const monitor=createProgressionMonitor({evaluate,onHandoff:e=>{
  log('PROGRESSION_HANDOFF '+JSON.stringify({account:s.name,selected:e.decision?.selected??null,reason:e.reason??e.decision?.reason}));
  handler?.('progression handoff: '+(e.reason??e.decision?.reason??'unmapped worker'));
 }});
 const observe=(force=false)=>{
  if(stopped)return;
  observeCannon();
  const state=s.sdk.getState();if(!state?.inGame||!state.player||!state.skills?.some((k:any)=>k.name==='Hitpoints'&&k.baseLevel>0))return;
  const bank=s.bankObservation?.(),inCombat=state.player.combat?.inCombat===true;
  if(!force&&s.tick()-lastCheck<25&&(bank?.generation??0)===lastGeneration&&inCombat===wasInCombat)return;
  const key=JSON.stringify([state.skills.map((k:any)=>[k.name,k.baseLevel,k.experience]),
   state.equipment?.map((i:any)=>[i.id,i.slot,i.count]),bank?.generation,state.player.worldX,state.player.worldZ,
   state.inventory?.map((i:any)=>[i.id,i.count]),questFlags(s.client),prior.reservations,work.env.WORKER_RELEASE,Math.floor(Date.now()/30000)]);
  lastCheck=s.tick();dirty=key;
  lastGeneration=bank?.generation??0;wasInCombat=inCombat;
  monitor.observe({tick:s.tick(),inCombat,combatTargetIndex:state.player.combat?.targetType==='npc'?state.player.combat.targetIndex:undefined,bankGeneration:bank?.generation??0,stateKey:force?key+'|'+s.tick():key});
 };
 const measure=()=>{
  if(!current?.intent||current.intent.kind!=='train'||!executing)return;
  const state=s.sdk.getState();if(!state?.inGame)return;
  const intent=current.intent,row=state.skills.find((k:any)=>k.name.toLowerCase()===intent.skill.toLowerCase());if(!row)return;
  const conditions=progressionRateConditions({...observedStatus(s,prior,Date.now()),server});
  if(!window||window.conditions!==conditions){window={tick:s.tick(),xp:row.experience,setup:0,started:false,lastTick:s.tick(),conditions};return;}
  const delta=s.tick()-window.lastTick;window.lastTick=s.tick();
  if(row.experience>window.xp)window.started=true;
  if(!window.started||state.bank?.isOpen||state.shop?.isOpen)window.setup+=delta;
  if(s.tick()-window.tick<150)return;
  const p=requireProgressionAdapter(options.adapter),observed=p.accountFromStatus(s.name,prior,Date.now()),method=p.progressionMethods(intent,observed,catalog(p)).methods.find(m=>m.id===executing);
  if(!method){window=null;return;}
  const gain=Object.entries(method.effects.xp??{}).find(([name])=>name.toLowerCase()===intent.skill.toLowerCase())?.[1]??0;
  if(gain<=0){window=null;return;}
  const sample:PerformanceWindow={units:Math.max(0,row.experience-window.xp)/gain,ticks:s.tick()-window.tick,setupTicks:window.setup,source:work.env.WORKER_RELEASE??method.source,conditions};
  windows.push(sample);if(windows.length>16)windows.shift();
  const assessment=p.assessProgressionPerformance({unitsPerTick:method.rate.unitsPerTick,minimumTicks:100,minimumFraction:.5,sustainedWindows:2,source:sample.source,conditions},windows);
  const dir=join(base,'.practice/progression-system/measurements',createHash('sha256').update(executing+'|'+sample.source+'|'+conditions).digest('hex'));
  const file=join(dir,s.name.toLowerCase()+'.json');
  const record={method:executing,source:sample.source,account:s.name,at:Date.now(),conditions:JSON.parse(conditions),basis:method.rate.basis,expectedRate:method.rate.unitsPerTick,windows:[...(read(file)?.windows??[]),sample].slice(-32),assessment};
  writeProgressionEvidence(file,record,log);
  if(assessment.state==='replan'){
   writeDecision(base,s,work,current,Date.now(),assessment,executing);
   log('PROGRESSION_SLOW '+JSON.stringify({account:s.name,method:executing,...assessment}));
   observe(true);
  }
  window={tick:s.tick(),xp:row.experience,setup:0,started:true,lastTick:s.tick(),conditions};
 };
 const off=s.onTick(()=>{observe();measure();});
 void s.ended.then(()=>{stopped=true;off();});
 const result:ProgressionSession={decision:()=>monitor.current()?.decision??null,evaluation:()=>monitor.current(),refresh:()=>{observe(true);return monitor.current();},
  refusal(action){observe();const a=action as any,state=s.sdk.getState();
   let option:string|undefined,bankCleanup=false,cannonCleanup=false,portalExit=false;
   if(a?.type==='interactNpc')option=state?.nearbyNpcs?.find((n:any)=>n.index===a.npcIndex)?.optionsWithIndex?.find((o:any)=>o.opIndex===a.optionIndex)?.text;
   if(a?.type==='useInventoryItem')option=state?.inventory?.find((i:any)=>i.slot===a.slot)?.optionsWithIndex?.find((o:any)=>o.opIndex===a.optionIndex)?.text;
   if(a?.type==='interactLoc'){
    const loc=state?.nearbyLocs?.find((l:any)=>l.id===a.locId&&l.x===a.x&&l.z===a.z);option=loc?.optionsWithIndex?.find((o:any)=>o.opIndex===a.optionIndex)?.text;
    bankCleanup=!!loc&&/bank booth|bank chest/i.test(loc.name)&&!/^closed/i.test(loc.name)&&/^(bank|use-quickly|use quickly|use)$/i.test(option??'');
    portalExit=!!loc&&((/^portal$/i.test(loc.name??'')&&/^use$/i.test(option??''))||(DISEMBARK_PLANK_IDS.has(loc.id)&&/^cross$/i.test(option??'')));
    cannonCleanup=!!ownedCannon&&cannonLoc(loc)&&a.x===ownedCannon.x&&a.z===ownedCannon.z&&state?.player?.level===ownedCannon.level&&/^pick-up$/i.test(option??'');
   }
   const refusal=monitor.refusal({...a,...option?{progressionOption:option}:{},progressionBankCleanup:bankCleanup,progressionCannonCleanup:cannonCleanup,progressionPortalExit:portalExit});
   if(!refusal&&cannonWorker&&!ownedCannon&&a?.type==='useInventoryItem'&&/^set-up$/i.test(option??'')){
    const item=state?.inventory?.find((i:any)=>i.slot===a.slot),p=state?.player;
    if(item?.id===6&&[p?.worldX,p?.worldZ,p?.level].every(Number.isSafeInteger)&&baseCount(state)>0){
     const placement={x:p!.worldX-1,z:p!.worldZ-1,level:p!.level,baseCount:baseCount(state),tick:s.tick(),messages:new Set((state?.gameMessages??[]).map(messageKey))};
     if(!state?.nearbyLocs?.some((loc:any)=>cannonLoc(loc)&&loc.x===placement.x&&loc.z===placement.z))pendingCannon=placement;
    }
   }
   return refusal;
  },onHandoff(next){handler=next;const e=monitor.current();if(e&&!e.supported&&e.decision?.state!=='complete'&&s.sdk.getState()?.player?.combat?.inCombat!==true)handler('progression handoff: '+(e.reason??e.decision?.reason??'unmapped worker'));},
  executing(method){
   const p=requireProgressionAdapter(options.adapter);
   const status=observedStatus(s,prior,Date.now()),account=p.accountFromStatus(s.name,status,Date.now()),intent=p.intentForEntry(work.script,work.args,work.env,consumer,catalog(p));
   if(!intent)throw Error('progression cannot bind an unknown consumer');
   const candidate=p.progressionMethods(intent,account,catalog(p)).methods.find(m=>m.id===method);
   if(!candidate||!methodSupportsWork(candidate.step,work,p))throw Error('progression method does not belong to this worker: '+method);
   const claimed=work.env.PROGRESSION_METHOD;
   if(claimed&&claimed!==method){
    const reason='progression resource claim '+claimed+' does not cover selected method '+method;
    const evaluation:PolicyEvaluation={...current,supported:false,intent,decision:current?.decision??null,reason};
    writeDecision(base,s,work,evaluation,Date.now());handler?.(reason);throw Error(reason);
   }
   const checked=evaluateProgressionWork(work,status,{base,accept:consumer,requireQualification:!isLocalServer(server),continuing:executing===method,currentMethod:method,admitted,adapter:p});
   const bound=checked.methods?.find(m=>m.id===method);
   if(!isLocalServer(server)&&(!bound?.qualification||checked.decision?.state!=='execute'||checked.decision.selected!==method))throw Error('progression method lacks current source/state admission: '+method);
   if(bound?.qualification&&checked.account&&checked.intent)admitted=structuredClone({method,source:bound.source,intent:checked.intent,account:checked.account});
   executing=method;window=null;observe(true);
  },
  method:()=>executing??null,
  binding:()=>({boundMethod:work.env.PROGRESSION_METHOD??null,source:work.env.WORKER_RELEASE??null,consumer:consumer?structuredClone(consumer):null}),
 };
 s.progression=result;
 return result;
}

export function progressionSummary(base=root):unknown[]{
 const dir=join(base,'.practice/progression-system/decisions');
 // Existing account/status discovery supplies names; do not walk the run tree.
 const names=existsSync(dir)?readdirSync(dir).filter(n=>/^[a-z0-9]+\.json$/i.test(n)).map(n=>n.slice(0,-5)):[];
 const sessions=names.slice(0,100).flatMap(name=>{const row=read(join(dir,name+'.json'));return row?[{account:row.account,at:row.at,entry:row.entry,intent:row.intent,supported:row.supported,selected:row.decision?.selected,executing:row.executing,expectedTicks:row.decision?.expectedTicks,basis:row.decision?.basis,state:row.decision?.state,followUps:row.decision?.followUps?.slice(0,8),followUpCount:row.decision?.followUps?.length??0,gaps:row.decision?.gaps?.slice(0,8),gapCount:row.decision?.gaps?.length??0,performance:row.performance,evidence:'.practice/progression-system/decisions/'+name+'.json'}]:[];});
 const ledger=join(base,'.practice/progression-system');
 const fleets=existsSync(ledger)?readdirSync(ledger).filter(n=>/^fleet-[a-z0-9-]+\.json$/i.test(n)).slice(0,16).flatMap(file=>{const row=read(join(ledger,file));return row?[{side:row.side,at:row.at,requests:row.requests?.slice(0,16),requestCount:row.requests?.length??0,gaps:row.gaps?.slice(0,16),gapCount:row.gaps?.length??0,reservations:row.reservations,evidence:'.practice/progression-system/'+file}]:[];}):[];
 return [...sessions,...fleets];
}
