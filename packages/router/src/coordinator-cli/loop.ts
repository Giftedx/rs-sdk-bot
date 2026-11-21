import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {freemem} from 'node:os';
import {join} from 'node:path';
import {assertBoundedRecoveryQueue,validateBoundedRecovery} from '../../../core/src/bounded-recovery';
import {jobAccounts,readCoordinatorJobs,writeCoordinatorJobs} from '../../../core/src/coordinator-jobs';
import {liveHelperStatuses} from '../../../planner/src/supply-bill';
import {FOCUS_FAILURE_LIMIT,activeBuildFocus,addTasks,boundAccounts,chooseTask,failedBuildStreak,heldBuilds,needsFreshQualification,qualificationRefreshCapabilities,recoverySlotBusy,refreshQualifications,usefulLiveReceipt,type CoordTask,type CoordinatorState} from '../coordinator';
import {DISK_FLOOR_GB,diskFreeGB,plannerDue,retireDeadTasks,reviewHold} from '../coordinator-decisions';
import {ensureSwarm,liveAccountWait,ordinaryRunWaitsForMemory,recoveryWaitsForMemory,releaseFinishedOwnJobs} from '../coordinator-live';
import {observationConsumerHeld} from '../coordinator-observations';
import {readPlannerControllerCapacity} from '../coordinator-planner';
import {atomicJson,capabilitySource,coordinationDir,event,loadState,projectRoot,recoverPlanWrite,runDirectory,saveState,spawnDetached,withPlanWrite} from '../coordinator-store';
import {provisionParticipantHold} from '../coordinator-worker';
import {freshScoreboard} from '../coverage';
import {SOURCE_STARTUP_GB,deliveryFingerprint,deliveryTask} from '../delivery-cli';
import {processDeliveryPrs} from '../delivery-pr';
import {goalWork} from '../goal-work';
import {loginAfter} from '../login-attempts';
import {createProgressionProofReconciler} from '../progression-proof-reconcile';
import {child,expandUsefulFleet,launchTask,nativeDispatchReady,spawnCoordinatorChild} from './dispatch';
import {COORDINATOR_CLI_PATH,plannerAgent,plannerPaused,readJson,recoveryRuns,waitForWork} from './holds';
import {intakeRequests,settlePlanner} from './intake';
import {runRules} from './rules';
import {archiveFinishedTasks,claimCoordinatorState,clearFocus,currentRevision,migrateJobsAtStart,pauseCoordinator,readPlan,reconcile} from './state';

const stop=join(projectRoot,'.practice/stop-coordinator');
const restart=join(coordinationDir,'restart');
const planRequest=join(coordinationDir,'plan-request');
const sourceErrors=new Map<string,string>();
let lowDisk=false;

// Opens staged delivery PRs (delivery-pr.ts) beside the loop: git and gh never hold dispatch or live delivery.
let deliveryPrs:Promise<void>|undefined;
function openDeliveryPrs(){
 deliveryPrs??=processDeliveryPrs(coordinationDir,projectRoot).then(({opened,failed,conflicts})=>{
  for(const pr of opened)event('delivery-pr-opened',{task:pr.taskId,branch:pr.branch,state:pr.state,url:pr.url});
  for(const pr of failed)event('delivery-pr-failed',{task:pr.taskId,branch:pr.branch,attempts:pr.attempts,nextAt:pr.nextAt,error:pr.lastError});
  for(const pr of conflicts)event('delivery-pr-conflict',{task:pr.taskId,branch:pr.branch,error:pr.lastError});
 }).catch(error=>event('delivery-pr-failed',String(error))).finally(()=>{deliveryPrs=undefined;});
}

// A finished job that still holds an account is released at most this often (releaseFinishedOwnJobs). For each job in
// the coordinator's file the pass reads one receipt, and one logout proof for each account of the job.
const RELEASE_EVERY_MS=60_000;
let releasedAt=0;
const reconcileProgressionProofs=createProgressionProofReconciler(projectRoot);
let proofPublicationPass={at:0,receiptSequence:-1};

async function tick(state:CoordinatorState,config:any){
 const bounded=config.boundedRecovery?validateBoundedRecovery(config.boundedRecovery):null;
 if(bounded)assertBoundedRecoveryQueue(bounded,state);
 recoverPlanWrite();
 if(!bounded)openDeliveryPrs();
 if(Date.now()-releasedAt>=RELEASE_EVERY_MS){
  releasedAt=Date.now();
  try{const freed=await releaseFinishedOwnJobs(projectRoot,!recoveryRuns(state));if(freed.length)event('own-jobs-released',{accounts:freed});}
  catch(error){event('own-jobs-release-failed',String(error));}
 }
 // Adopt before reconciliation: even a just-finished failed build keeps its
 // delivery focus while the planner prepares its exact repair.
 const focus=!config.focusCapability&&activeBuildFocus(state);
 if(focus)await withPlanWrite(()=>{
  const own=readCoordinatorJobs(projectRoot),coordination=own.coordination;
  coordination.focusCapability??=focus.capability;coordination.focusSince??=focus.since;
  writeCoordinatorJobs(projectRoot,own);config.focusCapability=coordination.focusCapability;config.focusSince=coordination.focusSince;
  event('fleet-focus-adopted',{capability:config.focusCapability,since:config.focusSince});
 });
 reconcile(state);
 const proofSequence=state.latestReceiptSequence??0,proofAt=Date.now();
 if(proofPublicationPass.receiptSequence!==proofSequence||proofAt-proofPublicationPass.at>=60_000){
  proofPublicationPass={at:proofAt,receiptSequence:proofSequence};
  for(const publication of await reconcileProgressionProofs(state)){
   const key='progression-proof:'+(publication.runId??publication.directory??'discovery'),seen=publication.status+':'+publication.reason;
   if(sourceErrors.get(key)!==seen){sourceErrors.set(key,seen);if(publication.status!=='unchanged')event('progression-proof-'+publication.status,publication);}
  }
 }
 intakeRequests(state);
 if(bounded)assertBoundedRecoveryQueue(bounded,state);
 // Reuse current evidence; refresh only capabilities with waiting live consumers.
 {
  const caps=qualificationRefreshCapabilities(state,cap=>deliveryTask(cap).files);
  const fingerprints:Record<string,string>={};
  for(const cap of caps)try{fingerprints[cap]=deliveryFingerprint(deliveryTask(cap));sourceErrors.delete(cap);}
  catch(error){const detail=String(error);if(sourceErrors.get(cap)!==detail)event('qualification-source-unavailable',{cap,error:detail});sourceErrors.set(cap,detail);}
  refreshQualifications(state,fingerprints);
 }
 if(!bounded)settlePlanner(state);
 const retired=retireDeadTasks(state,Date.now());
 if(retired.length){saveState(state);event('tasks-retired',{count:retired.length,tasks:retired});}
 // Model/native capacity is independent from finite live account jobs.
 const focusObservedAt=Date.now();
 if(config.focusCapability&&state.tasks.some(r=>{
  if(r.spec.capability!==config.focusCapability)return false;
  const receipt=usefulLiveReceipt(r,focusObservedAt);
  return !!receipt&&receipt.at>=(config.focusSince??0);
 })){
  await withPlanWrite(()=>{clearFocus(config.focusCapability);delete config.focusCapability;delete config.focusSince;event('fleet-focus-delivered',{evidence:'live'});});
 }
 // A focus that failed FOCUS_FAILURE_LIMIT builds in a row releases the other lanes; activeBuildFocus does not re-adopt it.
 if(config.focusCapability&&failedBuildStreak(state,config.focusCapability)>=FOCUS_FAILURE_LIMIT){
  const released=config.focusCapability;
  await withPlanWrite(()=>{clearFocus(released);delete config.focusCapability;delete config.focusSince;event('fleet-focus-released',{capability:released,failedBuilds:failedBuildStreak(state,released)});});
 }
 const owned=new Map<string,readonly string[]>(),ownedFiles=(cap:string)=>{if(!owned.has(cap))owned.set(cap,deliveryTask(cap).files);return owned.get(cap)!;};
 // A rejected review holds its capability's runs in the queue until a repair changes the owned files. The worker repeats
 // the check at start (coordinator-worker.ts), so a read error here holds nothing.
 const reviewHolds=new Map<string,boolean>(),runHeld=(task:CoordTask)=>{
  const cap=task.capability!;if(reviewHolds.has(cap))return reviewHolds.get(cap)!;
  let held=false;try{held=reviewHold(state,cap,()=>capabilitySource(ownedFiles(cap)))!==null;}catch{/* the worker reports an unreadable source */}
  reviewHolds.set(cap,held);return held;
 };
 if(!bounded)await expandUsefulFleet(state,config,runHeld);
 const developmentLimit=config.maxActive??2,liveLimit=config.maxLive??readPlan().maxBots;
 if(!bounded)runRules(state,liveLimit);
 let controllerPrepared=false,liveBlocked=false;
 // Standing swarm jobs run without a coordinator task, so the controller must run whenever one is enabled.
 // Also while a rollout has standing jobs paused: they are off then, and only this call turns them on again.
 if((readPlan().jobs??[]).some((j:any)=>j.standing===true&&j.enabled)||existsSync(join(coordinationDir,'rollout-paused.json'))){
  try{await ensureSwarm(currentRevision(),{currentSource:()=>currentRevision()},false);sourceErrors.delete('controller');}
  catch(error){const detail=String(error);if(sourceErrors.get('controller')!==detail)event('live-controller-wait',{error:detail});sourceErrors.set('controller',detail);}
 }
 // Expansion may have sampled review holds before controller preparation waited for a source rollout.
 reviewHolds.clear();owned.clear();
 for(const held of heldBuilds(state,Date.now())){const key='hold:'+held.capability,seen=held.fault+'@'+held.at;if(sourceErrors.get(key)!==seen){event('build-held',held);sourceErrors.set(key,seen);}}
 // Running tasks finish. A full disk stops the whole loop, so new work stops first.
 const diskGB=diskFreeGB(projectRoot),diskLow=diskGB!==null&&diskGB<DISK_FLOOR_GB;
 if(diskLow!==lowDisk){lowDisk=diskLow;event(diskLow?'disk-low':'disk-recovered',{freeGB:diskGB,floorGB:DISK_FLOOR_GB});}
 // A recovery that the swarm would refuse for memory waits in the queue (recoveryWaitsForMemory).
 const capacity=readPlannerControllerCapacity(),memoryHeld=state.tasks.filter(r=>r.status==='pending'&&recoveryWaitsForMemory(r.spec,capacity)).map(r=>r.spec.id);
 {const seen=memoryHeld.length?'held':'';if((sourceErrors.get('recovery-memory')??'')!==seen){event(seen?'recovery-memory-wait':'recovery-memory-ready',{tasks:memoryHeld.length,freeGB:capacity?.freeGB??null,pendingStartup:capacity?.pendingStartup??null});sourceErrors.set('recovery-memory',seen);}}
 // A run whose dependencies hold no qualification on the current source waits for the refresh (needsFreshQualification).
 const sources=new Map<string,string|null>();
 const sourceOf=(cap:string)=>{if(!sources.has(cap)){let s:string|null=null;try{s=deliveryFingerprint(deliveryTask(cap));}catch{/* no source now: hold */}sources.set(cap,s);}return sources.get(cap)!;};
 const staleRun=(task:CoordTask)=>task.kind==='run'&&!!task.capability&&needsFreshQualification(task,new Map(state.tasks.map(r=>[r.spec.id,r])),sourceOf(task.capability));
 const liveRunHeld=(task:CoordTask)=>runHeld(task)||observationConsumerHeld(task)||recoveryWaitsForMemory(task,capacity)||staleRun(task)||recoverySlotBusy(task,state.tasks)
  ||liveAccountWait(task,boundAccounts(task,state)??[])!==null||ordinaryRunWaitsForMemory(task,state,capacity,freemem()/2**30);
 let goalValues:ReturnType<typeof goalWork>=new Map();
 try{
  const observedAt=Date.now(),board=freshScoreboard(projectRoot);
  goalValues=goalWork(state,board.goals,liveHelperStatuses(projectRoot),observedAt,{entryOf:capability=>{try{return deliveryTask(capability).entry;}catch{return undefined;}},loginAfter:loginAfter(projectRoot)});
 }catch(error){event('goal-observation-wait',String(error));}
 for(let dispatch=0;!diskLow&&dispatch<developmentLimit+liveLimit;dispatch++){
  const freeGB=freemem()/2**30,request=join(coordinationDir,'publish-request.json');
  let publishing:string|undefined;try{publishing=existsSync(request)?readJson(request).capability:undefined;}catch{/* a request being written */}
  const task=chooseTask(state,Date.now(),{goalValue:candidate=>goalValues.get(candidate.id)?.value??null,sourceReady:freeGB>=SOURCE_STARTUP_GB,nativeReady:nativeDispatchReady(state,freeGB),developmentLimit,liveLimit:liveBlocked?0:liveLimit,preferLive:config.preferLive===true,focusCapability:config.focusCapability,isolatedBuilds:true,publishPending:existsSync(request),publishing,ownedFiles,runHeld:liveRunHeld,
   provisionRunHeld:(run,records)=>provisionParticipantHold(run,records,()=>deliveryTask(run.capability!).entry)!==null});
  if(!task)break;
  // The single dispatcher prepares the controller before parallel live children
  // can race to create it. Controller startup does not log accounts in.
  if(task.kind==='run'&&!controllerPrepared){
   try{await ensureSwarm(currentRevision(),{currentSource:()=>currentRevision()});controllerPrepared=true;sourceErrors.delete('controller');}
   catch(error){const detail=String(error);if(sourceErrors.get('controller')!==detail)event('live-controller-wait',{error:detail});sourceErrors.set('controller',detail);liveBlocked=true;continue;}
  }
  launchTask(state,task.id);
 }
 const planReason=diskLow||bounded||plannerPaused()?null:plannerDue(state,Date.now(),config.plannerIntervalMs??0,existsSync(planRequest));
 const agent=plannerAgent(config.agents,state.tasks);
 if(planReason&&agent){
  if(existsSync(planRequest))unlinkSync(planRequest);
  const runId='plan-'+randomUUID(),dir=runDirectory(runId);atomicJson(join(dir,'input.json'),{statePath:join(coordinationDir,'state.json'),agent,timeoutMs:config.modelTimeoutMs??600000});
  // Snapshot the receipts available when the planner starts. Receipts settled during its call trigger the next pass.
  state.plannerReceiptSequence=state.latestReceiptSequence??0;
  state.planner={runId,agent,startedAt:Date.now()};saveState(state);state.planner.pid=spawnCoordinatorChild('--planner',runId,dir);event('planner-started',{runId,pid:state.planner.pid,agent,reason:planReason});
 }
 const archived=archiveFinishedTasks(state);if(archived)event('tasks-archived',{count:archived,remaining:state.tasks.length});
 saveState(state);
}

export async function runCoordinatorCli(argv=process.argv){
 const mode=argv[2]??'--status',arg=argv[3];
 if(mode==='--worker'||mode==='--planner'){if(!arg)throw Error('run identity required');await child(mode,arg);return;}
 if(mode!=='--run'&&mode!=='--once'){
  const state=loadState();
  if(mode==='--status'){console.log(JSON.stringify(state,null,2));return;}
  if(mode==='--release-finished'){
   if(recoveryRuns(state))throw Error('recovery still running; assignments preserved');
   const accounts=arg?.split(',');
   if(!accounts?.length||accounts.some(a=>!/^[A-Za-z0-9]{1,12}$/.test(a))||readCoordinatorJobs(projectRoot).jobs.some(j=>jobAccounts(j).some(a=>!accounts.includes(a))))throw Error('release accounts do not cover existing assignments');
   console.log(JSON.stringify({released:await releaseFinishedOwnJobs(projectRoot,true)}));return;
  }
  if(mode==='--submit'){
   if(!arg)throw Error('proposal file required');const request=readJson(arg),requests=join(coordinationDir,'requests');mkdirSync(requests,{recursive:true});
   atomicJson(join(requests,randomUUID()+'.request.json'),request);console.log('Submitted to shared queue');return;
  }
  if(mode==='--plan'){writeFileSync(planRequest,'refresh priorities from observed state');console.log('Planning requested');return;}
  if(mode==='--restart'){writeFileSync(restart,'reload coordinator; preserve owned children');console.log('Coordinator reload requested');return;}
  if(mode==='--stop'){writeFileSync(stop,'owner pause '+new Date().toISOString());console.log('Coordinator stop requested');return;}
  throw Error('Use --run, --once, --status or --stop');
 }
 const config=readPlan().coordination;if(!config?.enabled)throw Error('swarm.json coordination.enabled required');
 const nonce=arg??randomUUID(),state=await claimCoordinatorState(nonce);
 if(existsSync(stop)||existsSync(join(projectRoot,'.practice/stop-swarm')))throw Error('coordinator or swarm is paused; resume only under owner authority');
 if(!state.tasks.length){addTasks(state,config.bootstrap??[]);saveState(state);}
 if(config.boundedRecovery)assertBoundedRecoveryQueue(validateBoundedRecovery(config.boundedRecovery),state);
 event('coordinator-started',{pid:process.pid,nonce});
 {const moved=await migrateJobsAtStart();if(moved)event('coordinator-jobs-moved',moved);}
 do{
  try{await tick(state,config);}catch(error){event('loop-error',String(error));await Bun.sleep(7000);}
  if(mode==='--once')break;await waitForWork();
 }while(!existsSync(stop)&&!existsSync(restart)&&!existsSync(join(projectRoot,'.practice/stop-swarm')));
 if(existsSync(restart)){
  unlinkSync(restart);
  // The successor loads the current code at once instead of waiting up to five minutes for the watchdog.
  const token='reload-'+randomUUID(),stamp=Date.now();
  const pid=spawnDetached([process.execPath,join(projectRoot,COORDINATOR_CLI_PATH),'--run',token],projectRoot,join(coordinationDir,`daemon-${stamp}.out.log`),join(coordinationDir,`daemon-${stamp}.err.log`));
  // Publish the handoff before this process exits. The watch must count a successor that has not claimed yet.
  await withPlanWrite(()=>{const file=join(coordinationDir,'owner.json'),owner=readJson(file);if(owner.pid!==process.pid||owner.nonce!==nonce)throw Error('coordinator reload owner changed');atomicJson(file,{...owner,successor:{pid,nonce:token}});});
  event('coordinator-reload',{children:'preserved for adoption',successor:pid});return;
 }
 if(existsSync(stop)||existsSync(join(projectRoot,'.practice/stop-swarm')))await pauseCoordinator(state);
}
