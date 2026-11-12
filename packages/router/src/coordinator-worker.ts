import {existsSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {freemem} from 'node:os';
import {admissionDecision,activeExternalLive} from '../../../scripts/swarm';
import {authorLoop,runClaude,fileExists,type AuthorResult} from './author';
import {deliveryTask,deliveryFingerprint,runDeliveryTask,runDiagnosticTask} from './delivery-cli';
import {createAccountProvisionDeps,provisionAccount,REGISTRATION_SCRIPT} from './account-provision';
import {readWorld,parseModelObject} from './coordinator-planner';
import {assertProvisionCrew,type ProvisionCrew} from '../../../scripts/provision-readiness';
import {runLiveTask,liveRows,swarmProcesses} from './coordinator-live';
import {projectRoot,coordinationDir,atomicJson,capabilitySource} from './coordinator-store';
import {isWorkspace,publishWorkspace,workspaceChanges,prepareReplayRoot,removeReplayRoot} from './build-workspace';
import {recentRecords} from '../../core/src/tick-record';
import {stageDeliveryPr,deliverySourceSet} from './delivery-pr';

// A drained fleet for a publish: finite live runs end within their own timeouts (at most 30 minutes in practice).
const PUBLISH_WAIT_MS=45*60*1000;
import {buildWorkOrder,preparedNativeDelivery,preparedProvisionRuns,provisionRefs,type CoordinatorState,type CoordTask,type TaskRecord} from './coordinator';
import {reviewHold} from './coordinator-decisions';
import {loadState} from './coordinator-store';
import {capabilityRevision} from '../../core/src/worker-release';
import {runModel,rejectedReview,type ModelWorker,reviewDependencies,reviewVerdict,reviewGate,REPLAY_RUNS,type ReplayOutcome} from './model-worker';
import type {DeliveryResult} from './delivery';

type BuildStageResult=Pick<AuthorResult,'ok'|'delivery'|'diagnostic'|'blocked'|'lastTail'>&{resumedPreparedSource?:string};
// `gate` decides whether the review blocks delivery (model-worker.ts reviewGate). Without it every review blocks.
export async function finishBuildDelivery(capability:string,prepared:any,deps:{fingerprint:()=>string;author:()=>Promise<BuildStageResult>;deliver:()=>Promise<DeliveryResult>;review:(result:BuildStageResult,source:string)=>Promise<{approved:boolean;reason:string}>;record:(result:BuildStageResult)=>void;gate?:()=>Promise<{blocking:boolean;reason:string}>},agent:ModelWorker){
 let resume=false;if(prepared&&!prepared.diagnostic)try{resume=prepared.source===deps.fingerprint();}catch{/* missing or changed source needs the author */}
 const result:BuildStageResult=resume?await(async()=>{const delivery=await deps.deliver();return{ok:delivery.ok,delivery,lastTail:delivery.reason,resumedPreparedSource:prepared.source};})():await deps.author();
 deps.record(result);
 const deferred=result.delivery?.hostDeferred&&!result.delivery.diagnostic?result.delivery:null;
 if(deferred)return{ok:false,evidence:'host-deferred',hostDeferred:true,sourcePrepared:true,delivery:deferred,error:deferred.reason};
 if(result.diagnostic?.hostDeferred)return{ok:false,evidence:'host-deferred-diagnostic',hostDeferred:true,sourcePrepared:false,diagnostic:result.diagnostic,error:'Native diagnostic deferred; prior defect remains unrepaired. '+result.diagnostic.reason};
 if(!result.ok||!result.delivery?.ok||result.delivery.stage!=='delivered')return{ok:false,evidence:result.delivery?'native':'source',delivery:result.delivery,diagnostic:result.diagnostic,blocked:result.blocked,error:result.lastTail};
 const source=deps.fingerprint();
 if(result.delivery.source!==source)return{ok:false,evidence:'native',delivery:result.delivery,error:'delivered source changed before review'};
 const gate=deps.gate?await deps.gate().catch(error=>({blocking:true,reason:'review blocks: gate failed: '+String(error)})):{blocking:true,reason:'review blocks'};
 if(!gate.blocking){
  const unchanged=deps.fingerprint()===source;
  return{ok:unchanged,delivery:{...result.delivery,id:capability},review:{deferred:true,reason:gate.reason},evidence:'native',agent,...(!unchanged?{error:'source changed during replay'}:{})};
 }
 const verdict=await deps.review(result,source),unchanged=deps.fingerprint()===source;
 return{ok:verdict.approved===true&&unchanged,delivery:{...result.delivery,id:capability},review:verdict,gate:gate.reason,evidence:'native',agent,...(!unchanged?{error:'source changed during review'}:{})};
}

// Replays one recorded run against this checkout's worker code (packages/core/src/replay.ts) in its own process.
export async function replayRun(root:string,file:string,allow:readonly string[]=[],timeoutMs=180000):Promise<ReplayOutcome>{
 const child=Bun.spawn([process.execPath,'packages/core/src/replay.ts','--json',file,...(allow.length?['--allow',allow.join(',')]:[])],{cwd:root,stdout:'pipe',stderr:'pipe',windowsHide:true});
 const timer=setTimeout(()=>child.kill(),timeoutMs);
 const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
 await child.exited;clearTimeout(timer);
 try{const line=out.trim().split(/\r?\n/).at(-1)!;const r=JSON.parse(line);return{...r,file};}
 catch{return{status:'error',file,error:'replay printed no result: '+(err||out).slice(-300)};}
}
// The review gate's inputs for one build: its changed files (isolated workspace only) and replays of the newest
// recorded runs that started before the build.
export async function buildReviewGate(input:{root:string;isolated:boolean;entry:string;owned:readonly string[];startedAt:number;allow?:readonly string[];replay?:(file:string)=>Promise<ReplayOutcome>;recordRoot?:string}){
 const changes=input.isolated?workspaceChanges(input.root):{known:false,changed:[]};
 const scope={...changes,owned:input.owned,reason:input.isolated?'build workspace has no file list':'build edits the main checkout'};
 const outside=scope.changed.filter(f=>!input.owned.includes(f));
 const records=scope.known&&!outside.length?recentRecords(input.entry,input.startedAt,REPLAY_RUNS,input.recordRoot??input.root):[];
 const replays:ReplayOutcome[]=[];
 let scratch:string|undefined;
 const replay=input.replay??(file=>replayRun(scratch??=prepareReplayRoot(input.root),file,input.allow));
 try{
  if(records.length===REPLAY_RUNS)for(const file of records){
   const r=await replay(file);replays.push(r);
   if(r.status==='error')break;
  }
 }finally{if(scratch)removeReplayRoot(scratch);}
 return reviewGate({scope,records:records.length,replays,allow:input.allow});
}

function preparedCrew(run:CoordTask,records:ReadonlyMap<string,TaskRecord>,entry:()=>string|undefined,base:string):ProvisionCrew|undefined{
 if(!run.participants){
  const script=entry();
  return script?{accounts:[],slots:1,script}:undefined;
 }
 const accounts=run.participants.flatMap(binding=>{
  if(!binding.startsWith('@'))return [binding];
  const record=records.get(binding.slice(1));
  if(record?.status!=='succeeded')return [];
  const account=record.receipt?.output?.account;
  if(!record.receipt?.ok||typeof account!=='string'||! /^[A-Za-z0-9_ -]{1,12}$/.test(account))throw Error('participant binding unavailable: '+binding);
  return [account];
 });
 const script=entry();
 if(!script)throw Error('prepared worker entry unavailable');
 const crew={accounts,script,slots:run.participants.length};
 assertProvisionCrew(crew,base);
 return crew;
}

export function provisionParticipantHold(run:CoordTask,records:ReadonlyMap<string,TaskRecord>,entry:()=>string|undefined,base=projectRoot):string|null{
 try{preparedCrew(run,records,entry,base);return null;}
 catch(error){return error instanceof Error?error.message:String(error);}
}

export function preparedProvisionProof(state:CoordinatorState,id:string,source:(capability:string)=>{fingerprint:string;runtime:string;entry?:string}|null,options:{base?:string;held?:(error:unknown)=>void;ready?:(crew:ProvisionCrew|undefined)=>void}={}):boolean{
 const records=new Map(state.tasks.map(r=>[r.spec.id,r]));
 for(const runId of preparedProvisionRuns(state,records)){
  const run=records.get(runId)!.spec;
  if(!provisionRefs(run).includes(id))continue;
  const current=source(run.capability!);if(!current)continue;
  if(!run.dependsOn.some(dep=>{
   const proof=records.get(dep),delivery=proof?.receipt?.output?.delivery;
   return proof?.status==='succeeded'&&(proof.spec.kind==='build'||proof.spec.kind==='qualify')
    &&proof.spec.capability===run.capability&&delivery?.id===run.capability&&delivery.ok===true&&delivery.stage==='delivered'
    &&delivery.source===current.fingerprint&&delivery.runtimeRevision===current.runtime;
  }))continue;
  try{
   const crew=preparedCrew(run,records,()=>current.entry,options.base??projectRoot);
   options.ready?.(crew);
   return true;
  }catch(error){options.held?.(error);}
 }
 return false;
}

export async function executeTask(task:CoordTask,dependencies:Record<string,any>,directory:string,runId:string,startedAt:number,agent:ModelWorker='claude'){
 if(task.kind==='provision'){
  const requirePreparedJob=()=>{
   const state=loadState();
   let hold:unknown,crew:ProvisionCrew|undefined;
   if(!preparedProvisionProof(state,task.id,capability=>{
    try{
     const definition=deliveryTask(capability);
     if(reviewHold(state,capability,()=>capabilitySource(definition.files)))return null;
     return{fingerprint:deliveryFingerprint(definition),runtime:capabilityRevision([definition.entry]),entry:definition.entry};
    }catch{return null;}
   },{held:error=>{hold=error;},ready:value=>{crew=value;}}))throw Error(hold?'account creation waits for a prepared participant: '+String(hold):'account creation waits for fresh native proof of its prepared first job');
   return crew;
  };
  requirePreparedJob();
  const world=readWorld(),deps=createAccountProvisionDeps({workerRelease:capabilityRevision([REGISTRATION_SCRIPT]),reservation:runId});
  const admission=admissionDecision({running:activeExternalLive(world.statuses,[],Date.now()).length,external:0,starting:1,startingReserve:1,pending:0,freeGB:freemem()/2**30,minFreeGB:world.capacity.minFreeGB,maxBots:world.capacity.maxBots});
  if(!admission.allowed)throw Error('account claim waits for measured capacity: '+admission.reason);
  const reserve=deps.reserveLiveAccount;
  deps.reserveLiveAccount=async(name,server)=>{requirePreparedJob();atomicJson(join(directory,'identity.json'),{account:name,server,purpose:task.why,at:Date.now()});return reserve(name,server);};
  const register=deps.registerAccount;
  deps.registerAccount=async(name,server)=>{const crew=requirePreparedJob();const result=await register(name,server,crew);atomicJson(join(directory,'claim.json'),result);return result;};
  const result=await provisionAccount({role:task.role as any,purpose:task.why,server:'rs-sdk-demo.fly.dev',reservedNames:world.jobs.flatMap((j:any)=>j.accounts??[j.account]).filter(Boolean)},deps);
  return{...result,ok:result.registered,evidence:'registered'};
 }
 const definition=deliveryTask(task.capability!);
 const ownedSource=()=>capabilitySource(definition.files);
 if(task.kind==='review'){
  const fingerprint=ownedSource;
  const before=fingerprint();
  const review=await runModel(agent,'Independently review this delivered capability: its code, callers, tests and saved delivery logs. Do not edit or launch anything. Return ONLY JSON {approved:boolean,reason:string}. Review rule (docs/script-contract.md, Review): approve unless you find a concrete defect in the claimed scope: a wrong game action, asset loss, a death risk, an unbounded loop, a missing logout, a crash, or a broken existing caller. Each rejection names file:line, the scenario and the consequence. Do not reject for missing live results (live runs follow approval), for proof-tooling style, for tests you would add, or for later stages; put those in reason as notes. Some receipts summarize delivery files and live status. Read receipt.json under _task.evidence for the complete record. Claimed review work order: '+task.why+' Definition: '+JSON.stringify(definition)+' Relevant completed dependency receipts: '+JSON.stringify(reviewDependencies(dependencies,definition.id,task.dependsOn)),task.timeoutMs??300000,true);
  atomicJson(join(directory,'review-model.json'),review);
  const verdict=reviewVerdict(review,parseModelObject);
  return{ok:verdict.approved===true&&fingerprint()===before,review:verdict,evidence:'source-review',source:before,agent};
 }
 if(task.kind==='run'){
  const rejection=rejectedReview(dependencies,definition.id,ownedSource());if(rejection)throw Error('cross-model review requires repair before live delivery: '+rejection);
  const fingerprint=deliveryFingerprint(definition);
  if(!Object.values(dependencies).some((r:any)=>r?.delivery?.ok&&r.delivery.id===definition.id&&r.delivery.source===fingerprint))throw Error('fresh same-capability native qualification required');
  return runLiveTask(task,dependencies,definition,runId,startedAt);
 }
 if(task.kind==='qualify'){const delivery=await runDeliveryTask(definition);return{ok:delivery.ok,delivery,evidence:'native'};}
 const lock=join(coordinationDir,'build-lock.json'),request=join(coordinationDir,'publish-request.json');
 // The source lock guards every write to the main checkout that live workers run from.
 const takeSourceLock=async()=>{
  if(existsSync(lock)){
   const owner=JSON.parse(readFileSync(lock,'utf8'));let alive=true;try{process.kill(owner.pid,0);}catch{alive=false;}
   if(alive&&owner.runId!==runId)throw Error('another builder owns runtime source');if(owner.runId!==runId)unlinkSync(lock);
  }
  // No fleet drain: a live worker loads its code at start and carries the release it started on (swarm.ts), so a
  // publish changes only later starts. The lock holds new starts for the moment the files are copied.
  if(!existsSync(lock))writeFileSync(lock,JSON.stringify({pid:process.pid,runId,at:Date.now()}),{flag:'wx'});
 };
 // An isolated build (build-workspace.ts) edits its own copy: it takes the lock only to publish.
 const mainRoot=process.env.COORDINATOR_MAIN_ROOT,isolated=!!mainRoot&&mainRoot!==projectRoot&&isWorkspace(projectRoot);
 const publish=async(result:any)=>{
  atomicJson(request,{runId,capability:definition.id,at:Date.now()});
  const deadline=Date.now()+PUBLISH_WAIT_MS;let last='';
  try{
   for(;;){
    try{await takeSourceLock();break;}catch(error){
     last=String(error);if(owned())unlinkSync(lock);
     if(Date.now()>deadline)return{...result,ok:false,sourcePrepared:true,error:'publish waited '+PUBLISH_WAIT_MS/60000+' min for a drained fleet: '+last};
     await Bun.sleep(15000);
    }
   }
   const out=publishWorkspace(mainRoot!,definition.id,definition.files);atomicJson(join(directory,'publish.json'),{...out,at:Date.now(),from:projectRoot,to:mainRoot});
   // The coordinator opens the PR later (delivery-pr.ts); a staging failure never fails the delivered build.
   let deliveryPr:any=null;
   try{const pr=stageDeliveryPr({workspace:projectRoot,runDir:directory,coordinationDir,taskId:task.id,capability:definition.id,files:out.published,sourceSet:deliverySourceSet(definition.entry,definition.files,projectRoot),result:{...result,published:out}});deliveryPr=pr&&{branch:pr.branch,state:pr.state};}
   catch(error){deliveryPr={error:String(error)};}
   return{...result,published:out,deliveryPr};
  }finally{if(existsSync(request)&&JSON.parse(readFileSync(request,'utf8')).runId===runId)unlinkSync(request);}
 };
 const owned=()=>existsSync(lock)&&JSON.parse(readFileSync(lock,'utf8')).runId===runId;
 try{
 if(!isolated)await takeSourceLock();
 // Preserve every declared pre-existing file before an author edits it.
 for(const file of definition.files)if(existsSync(join(projectRoot,file))){const out=join(directory,'before',file);mkdirSync(dirname(out),{recursive:true});copyFileSync(join(projectRoot,file),out);}
 const authorDeadline=Date.now()+(task.timeoutMs??900000);
 let authorCalls=0;
 const authorModel=async(prompt:string)=>{
  const attempt=++authorCalls;writeFileSync(join(directory,`author-prompt-${attempt}.txt`),prompt);
  const response=await runModel(agent,prompt,Math.max(1,authorDeadline-Date.now()),false);
  atomicJson(join(directory,`author-response-${attempt}.json`),response);return response;
 };
 let prepared:any=null;try{prepared=preparedNativeDelivery(loadState(),definition.id,deliveryFingerprint(definition),task.resumeSource);}catch{/* incomplete or changed source needs the ordinary author */}
 if(task.resumeSource&&!prepared)throw Error('explicit prepared source continuation no longer matches a native delivery');
 const built=await finishBuildDelivery(definition.id,prepared,{fingerprint:()=>deliveryFingerprint(definition),
 author:()=>authorLoop({id:definition.id,goal:definition.goal+'\n'+buildWorkOrder(task,dependencies,directory),preset:'',delivery:definition},{maxFixes:2,proveRuns:1,repairRegressions:true},{runModel:authorModel,exists:fileExists,prove:async()=>{throw Error('delivery required');},deliver:runDeliveryTask,diagnose:runDiagnosticTask}),
 deliver:()=>runDeliveryTask(definition),record:result=>atomicJson(join(directory,'author.json'),result),
 gate:async()=>{const gate=await buildReviewGate({root:projectRoot,isolated,entry:definition.entry,owned:definition.files,startedAt,allow:task.replayAllow});atomicJson(join(directory,'review-gate.json'),{...gate,at:Date.now()});return gate;},
 review:async(result)=>{
 const review=await runModel(agent==='claude'?'codex':'claude','Review this completed capability independently: the declared source, callers, tests and delivery logs. Do not edit or launch anything. Return ONLY JSON {approved:boolean,reason:string}. Check that the work order was fulfilled through its real worker and that the acceptance bar in docs/script-contract.md holds. Review rule (docs/script-contract.md, Review): approve unless you find a concrete defect in the claimed scope: a wrong game action, asset loss, a death risk, an unbounded loop, a missing logout, a crash, or a broken existing caller. Each rejection names file:line, the scenario and the consequence. Do not reject for missing live results (live runs follow approval), for proof-tooling style, for tests you would add, or for later stages; put those in reason as notes. Work order: '+buildWorkOrder(task,dependencies,directory)+' Definition: '+JSON.stringify(definition)+' Delivery: '+JSON.stringify(result.delivery),300000,true);
 atomicJson(join(directory,'review-model.json'),review);
 const verdict=review.ok?parseModelObject(review.text):{approved:false,reason:review.text};atomicJson(join(directory,'review.json'),verdict);
 return verdict;
 }},agent);
 return isolated&&built.ok?await publish(built):built;
 }finally{if(owned())unlinkSync(lock);}
}
