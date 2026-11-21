import {existsSync,readFileSync,writeFileSync,appendFileSync,statSync,truncateSync,unlinkSync,watch,mkdirSync,readdirSync,renameSync} from 'node:fs';
import {basename,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {freemem,cpus} from 'node:os';
import {addTasks,chooseTask,startTask,finishTask,refreshQualifications,qualificationRefreshCapabilities,boundAccounts,fleetExpansion,activeBuildFocus,failedBuildStreak,heldBuilds,compactState,usefulLiveReceipt,preparedProvisionClaims,needsFreshQualification,recoverySlotBusy,FOCUS_FAILURE_LIMIT,type CoordinatorState,type CoordTask} from './coordinator';
import {buildFailureEvidence} from './build-fault';
import {projectRoot,coordinationDir,loadState,saveState,runDirectory,atomicJson,atomicText,event,spawnDetached,recoverPlanWrite,withPlanWrite,capabilitySource,publishCapabilityChanges} from './coordinator-store';
import {DISK_FLOOR_GB,diskFreeGB,finishPlan,plannerDue,retireDeadTasks,reviewHold} from './coordinator-decisions';
import {planWork,prepareProposal,readPlannerControllerCapacity} from './coordinator-planner';
import {executeTask,provisionParticipantHold} from './coordinator-worker';
import {deliveryTask,deliveryFingerprint,SOURCE_STARTUP_GB,NATIVE_STARTUP_GB} from './delivery-cli';
import {disableOwnJob,ensureSwarm,liveRows,releaseFinishedOwnJobs,recoveryWaitsForMemory,liveAccountWait,ordinaryRunWaitsForMemory,validLiveMemoryWait} from './coordinator-live';
import {cachedLaunchRevision,cachedReleaseFor} from '../../core/src/worker-release';
import {readCoordinatorJobs,writeCoordinatorJobs,readMergedPlan,ownerPlanPath,jobAccounts,COORDINATOR_JOBS_FILE} from '../../core/src/coordinator-jobs';
import {validateBoundedRecovery,assertBoundedRecoveryQueue} from '../../core/src/bounded-recovery';
import {boundedOwnerBinding} from '../../core/src/bounded-owners';
import {assignedWorker,type ModelWorker} from './model-worker';
import {commandLine,processMatches,processStartTimes,safeKill} from '../../core/src/proc';
import {observePracticeTurn} from '../../practice/src/proof-lock';
import {SWARM_STOP,writeSwarmStop,swarmWroteStop} from '../../../scripts/swarm';
import {prepareWorkspace,sharedWorkspacePlan} from './build-workspace';
import {applyRules,skillUnlocks,currentQualification,reviewApproved,retarget} from './coordinator-rules';
import {evaluateCoordinatorProgression,type CoordinatorProgressionResult} from './coordinator-progression';
import {applyObservationRequests,observationConsumerHeld,observationBudget,prepareObservationBand} from './coordinator-observations';
import {loadOwners,mySide} from '../../core/src/fleet';
import {readLogoutProof} from '../../core/src/session-lifecycle';
import {prayerBank} from '../../../scripts/train-prayer';
import {rangedEntry} from '../../../scripts/ranged-train';
import {evaluateProgressionWork,progressionProofs} from '../../core/src/progression-session';
import {processDeliveryPrs} from './delivery-pr';
import {freshScoreboard} from './coverage';
import {goalWork,ruleGoalValue} from './goal-work';
import {loginAfter} from './login-attempts';
import {liveHelperStatuses} from '../../planner/src/supply-bill';
import {recoverConcurrentPlanWrite} from '../../core/src/plan-lock';
import {createProgressionProofReconciler} from './progression-proof-reconcile';

const cli='packages/router/src/coordinator-cli.ts';
// Only the installing controller clears a reusable system stop. Unknown text and
// unreadable files remain owner pauses, including lowercase paths on Linux.
export function coordinatorAccountPaused(account:string,base=projectRoot):boolean{
 for(const name of new Set([account,account.toLowerCase()])){
  try{if(!swarmWroteStop(readFileSync(join(base,'.practice','stop-'+name),'utf8')))return true;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return true;}
 }
 return false;
}
const json=(file:string)=>JSON.parse(readFileSync(file,'utf8'));
// The owner's swarm.json with the coordinator's own jobs and settings merged in (packages/core/src/coordinator-jobs.ts).
const readPlan=()=>readMergedPlan(projectRoot);
// The controller's launch release (packages/core/src/worker-release.ts) reads its release files (about 500 ms);
// cachedLaunchRevision recomputes it only when one of those files or folders changed size or modification time.
// One loop reuses the answer; a rollout's post-drain check minutes later looks again.
export const REVISION_FRESH_MS=2000;
let revisionCache:{value:string;at:number}|undefined;
export function currentRevision(now=Date.now(),compute=cachedLaunchRevision):string{
 if(!revisionCache||now-revisionCache.at>=REVISION_FRESH_MS||now<revisionCache.at)revisionCache={value:compute(),at:now};
 return revisionCache.value;
}
// The start step archives a dead writer's lock before it takes the lock: a crash can leave one, and the tick that
// recovers locks runs only after this step. A live writer can hold the lock for longer than one wait. An exit then
// leaves the fleet with no coordinator until the next watchdog pass, so the start step waits again, for
// START_PLAN_WAIT_MS at most.
export const START_PLAN_WAIT_MS=5*60_000;
export async function migrateJobsAtStart(base=projectRoot,waitMs=START_PLAN_WAIT_MS,attemptMs=15000,
 note:(line:string)=>void=line=>console.error(line)){
 const directory=join(base,'.practice/coordinator'),deadline=Date.now()+waitMs;
 for(;;){
  recoverPlanWrite(directory);
  try{return await withPlanWrite(()=>migrateCoordinatorJobs(base),directory,attemptMs);}
  catch(error){
   if(!String(error).includes('account plan writer waits for its existing owner')||Date.now()>=deadline)throw error;
   note(`coordinator start: ${String(error)}; waits again for ${Math.max(0,Math.round((deadline-Date.now())/1000))} s at most`);
  }
 }
}
// Coordinator-owned jobs and settings written into swarm.json by an earlier coordinator move to the coordinator's
// file; the owner's jobs keep their order. Returns what moved, or null when swarm.json holds none.
export function migrateCoordinatorJobs(base=projectRoot){
 const path=ownerPlanPath(base),raw=readFileSync(path,'utf8'),plan=JSON.parse(raw);
 const owned=(plan.jobs??[]).filter((j:any)=>j.coordinatorOwner==='coordinator');
 const settings=['focusCapability','focusSince','lastExpansionAt'].filter(k=>plan.coordination&&k in plan.coordination);
 if(!owned.length&&!settings.length)return null;
 const own=readCoordinatorJobs(base);
 own.jobs=[...own.jobs,...owned];
 for(const key of settings){(own.coordination as any)[key]??=plan.coordination[key];delete plan.coordination[key];}
 plan.jobs=(plan.jobs??[]).filter((j:any)=>j.coordinatorOwner!=='coordinator');
 writeCoordinatorJobs(base,own);
 atomicText(path,JSON.stringify(plan,null,2)+(raw.endsWith('\n')?'\n':''));
 return{jobs:owned.length,settings,file:COORDINATOR_JOBS_FILE};
}
const stop=join(projectRoot,'.practice/stop-coordinator');
const restart=join(coordinationDir,'restart');
const planRequest=join(coordinationDir,'plan-request');
const sourceErrors=new Map<string,string>();
const cpuTotals=()=>cpus().reduce((s,c)=>({idle:s.idle+c.times.idle,total:s.total+Object.values(c.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
let previousCpu=cpuTotals();
const tickSamples=new Map<string,{started:number;tick:number;at:number;latency:number|null}>();
export function fleetExpansionDemand(state:CoordinatorState,runHeld:(task:CoordTask)=>boolean){
 const records=new Map(state.tasks.map(r=>[r.spec.id,r]));
 const running=state.tasks.filter(r=>r.status==='running'&&r.spec.kind==='run');
 const ready=state.tasks.filter(r=>r.status==='pending'&&r.spec.kind==='run'
  &&r.spec.dependsOn.every(id=>records.get(id)?.status==='succeeded')&&!runHeld(r.spec));
 const preparedClaims=preparedProvisionClaims(state,records,undefined,runHeld);
 const active=new Set(running.flatMap(r=>boundAccounts(r.spec,state)??[]).map(n=>n.toLowerCase()));
 const demand=new Set([...active,...ready.flatMap(r=>boundAccounts(r.spec,state)??[]).map(n=>n.toLowerCase())]).size+preparedClaims.size;
 return {active,demand};
}
async function expandUsefulFleet(state:CoordinatorState,config:any,runHeld:(task:CoordTask)=>boolean){
 if(!config.autoExpand)return;
 const now=Date.now(),cpu=cpuTotals(),delta=cpu.total-previousCpu.total,usage=delta>0?1-(cpu.idle-previousCpu.idle)/delta:null;previousCpu=cpu;
 const {active,demand}=fleetExpansionDemand(state,runHeld);
 const rows=new Map(liveRows().map(r=>[String(r.name).toLowerCase(),r]));let stalled=false;const latencies:number[]=[];
 for(const name of active){
  const row=rows.get(name);if(!row||row.server!=='rs-sdk-demo.fly.dev'||now-row.at>5000||!Number.isFinite(row.tick)){stalled=true;continue;}
  const old=tickSamples.get(name),same=old?.started===row.started;let latency=same?old!.latency:null;
  if(same&&row.at>old!.at)latency=row.tick>old!.tick?(row.at-old!.at)/(row.tick-old!.tick):null;
  tickSamples.set(name,{started:row.started,tick:row.tick,at:row.at,latency});if(latency===null)stalled=true;else latencies.push(latency);
 }
 const plan=readPlan(),last=plan.coordination?.lastExpansionAt??0;
 const useful=state.tasks.filter(r=>(usefulLiveReceipt(r,now)?.at??0)>Math.max(last,now-900000)).length;
 const target=fleetExpansion({limit:plan.maxBots,demand,freeGB:freemem()/2**30,reserveGB:plan.minFreeGB,cpu:usage,tickMs:latencies.length?Math.max(...latencies):null,stalled,usefulResults:useful,now,lastExpandedAt:last});
 if(target===plan.maxBots)return;
 // The grant lives in the coordinator's file over the owner's current maxBots; an owner edit of maxBots discards it.
 await withPlanWrite(()=>{const current=readPlan();if(current.maxBots!==plan.maxBots)return;const own=readCoordinatorJobs(projectRoot);own.expansion={maxBots:target,over:json(ownerPlanPath(projectRoot)).maxBots};own.coordination.lastExpansionAt=now;writeCoordinatorJobs(projectRoot,own);config.maxLive=target;config.lastExpansionAt=now;event('fleet-capacity-expanded',{from:plan.maxBots,to:target,freeGB:freemem()/2**30,cpu:usage,tickMs:Math.max(...latencies),usefulResults:useful});});
}
const existsPid=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
// Windows reuses a pid, so a running pid alone does not prove that the saved process is the one that runs. The planner
// starts as `coordinator-cli.ts --planner <runId>`, so its command line holds the run id. A command line that cannot be read
// proves nothing, and then a running pid counts.
export const plannerHolds=(pid:number,runId:string,read:(pid:number)=>string|null=commandLine,exists:(pid:number)=>boolean=existsPid):boolean=>{
 const line=read(pid);
 return line===null?exists(pid):line.includes(runId);
};
// A coordinator that started without a token has a random nonce that its command line does not hold. Its saved start
// time decides then: the coordinator process starts before it writes the claim, and a process that reused the pid
// starts after it.
export const OWNER_START_SLACK_MS=5000;
export const ownerHolds=(owner:{pid:number;nonce:string;at?:number},read:(pid:number)=>string|null=commandLine,exists:(pid:number)=>boolean=existsPid,
 starts:(pids:number[])=>Map<number,number>|null=processStartTimes):boolean=>{
 const line=read(owner.pid);
 if(line?.includes(owner.nonce))return true;
 if(!exists(owner.pid))return false;
 if(line===null||!Number.isFinite(owner.at))return true;
 const table=starts([owner.pid]);
 if(table===null)return true;
 const started=table.get(owner.pid);
 return started===undefined?false:started<=owner.at!+OWNER_START_SLACK_MS;
};
// A worker writes its owner file with its own pid and the time `at` right after it starts, so a process that started after
// `at` is not that worker. The check reads the process table once for the pid, so a worker that passed it is not checked
// again for WORKER_CHECK_MS. An unreadable table proves nothing, and then a running pid counts.
export const WORKER_CHECK_MS=60000,WORKER_START_SLACK_MS=5000;
const workerChecks=new Map<string,number>();
export const workerHolds=(pid:number,runId:string,at:number,starts:(pids:number[])=>Map<number,number>|null=processStartTimes,
 checks:Map<string,number>=workerChecks,now:number=Date.now()):boolean=>{
 const key=runId+'|'+pid,seen=checks.get(key);
 if(seen!==undefined&&now-seen<WORKER_CHECK_MS)return true;
 const table=starts([pid]);
 if(table===null)return true;
 const started=table.get(pid);
 if(started===undefined||started>at+WORKER_START_SLACK_MS){checks.delete(key);return false;}
 checks.set(key,now);
 return true;
};
export function reconcile(state:CoordinatorState,alive:(pid:number,marker:string)=>boolean=processMatches,directory=coordinationDir,pidExists=existsPid,startupGraceMs=15000,holds:(pid:number,runId:string,at:number)=>boolean=workerHolds){
 for(const record of state.tasks.filter(r=>r.status==='failed'&&r.receipt?.error?.startsWith('worker ended without a receipt'))){
  const file=join(runDirectory(record.runId!,directory),'receipt.json');
  if(existsSync(file)){
   const old=record.receipt;record.status='running';
   if(finishTask(state,json(file)))event('late-worker-receipt-recovered',{id:record.spec.id,previousFailure:old,receipt:file},directory);
   else{record.status='failed';record.receipt=old;}
  }
 }
 for(const record of state.tasks.filter(r=>r.status==='running')){
  const dir=runDirectory(record.runId!,directory),receipt=join(dir,'receipt.json'),owner=join(dir,'owner.json');
  if(existsSync(receipt)){
   const result=json(receipt),wait=result.output?.liveDeferred;
   const attempt=(v:unknown)=>typeof v==='string'&&/^\d{13}-\d{1,10}-\d{1,10}$/.test(v),pid=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>0;
   if(record.spec.kind==='run'&&!record.spec.sessionRecovery&&!record.spec.repairs?.length&&(!record.spec.launch||record.spec.launch==='ordinary')
    &&result.taskId===record.spec.id&&result.runId===record.runId&&result.ok===false&&result.error===undefined
    &&Number.isFinite(result.at)&&result.at>=(record.startedAt??Infinity)&&result.output?.ok===false&&result.output.evidence==='live-deferred'&&result.output.installed===false
    &&typeof wait?.account==='string'&&(boundAccounts(record.spec,state)??[]).some(n=>n.toLowerCase()===wait.account.toLowerCase())
    &&(wait.reason==='active-session'&&attempt(wait.attemptId)&&pid(wait.pid)
     ||wait.reason==='autopilot-assignment'&&(wait.attemptId===null||attempt(wait.attemptId))&&(wait.pid===null||pid(wait.pid))
     ||(wait.reason==='fleet-order'||wait.reason==='reserved')&&wait.attemptId===null&&wait.pid===null
     ||validLiveMemoryWait(wait,boundAccounts(record.spec,state)??[]))){
    const runId=record.runId;record.status='pending';delete record.runId;delete record.startedAt;delete record.pid;delete record.receipt;
    state.sequence++;event('task-deferred',{id:record.spec.id,runId,wait,receipt},directory);continue;
   }
   if(finishTask(state,result))event('task-finished',{id:record.spec.id,status:record.status,runId:record.runId},directory);
   else finishTask(state,{taskId:record.spec.id,runId:record.runId!,ok:false,at:Date.now(),output:null,error:'mismatched receipt; original bytes retained'});
   continue;
  }
  const claim=existsSync(owner)?json(owner):null,pid=claim?claim.pid:record.pid;
  // CIM can briefly return no command line under load. That is not evidence
  // that a process ended. Keep its ownership until OS liveness also fails.
  // Check OS liveness first: command-line lookup starts PowerShell on Windows.
  // The existing rule retains a live PID even when CIM cannot identify it. A PID that started after the worker wrote its
  // owner file belongs to another program, which reused the PID.
  if(pid&&(pidExists(pid)?!Number.isFinite(claim?.at)||holds(pid,record.runId!,claim.at)||alive(pid,record.runId!):alive(pid,record.runId!)))continue;
  if(Date.now()-(record.startedAt??0)>=startupGraceMs)finishTask(state,{taskId:record.spec.id,runId:record.runId!,ok:false,at:Date.now(),output:null,error:'worker ended without a receipt; inspect preserved run before repair'});
 }
}
function spawn(mode:string,id:string,directory:string,cwd=projectRoot){
 return spawnDetached([process.execPath,join(cwd,cli),mode,id],cwd,join(directory,'stdout.log'),join(directory,'stderr.log'),cwd===projectRoot?process.env:{...process.env,COORDINATOR_MAIN_ROOT:projectRoot,SWARM_PLAN:sharedWorkspacePlan(projectRoot,cwd,process.env.SWARM_PLAN),CLOUD_WATCH_ID:''});
}
function launchTask(state:CoordinatorState,id:string){
 const runId='task-'+randomUUID(),record=startTask(state,id,Date.now(),runId),dir=runDirectory(runId);
 record.agent=assignedWorker(record.spec.kind,state.tasks.filter(r=>r!==record),record.spec.agent);
 const dependencies=Object.fromEntries(state.tasks.filter(r=>r.status==='succeeded'||r.receipt&&r.spec.capability===record.spec.capability).map(r=>[r.spec.id,{...r.receipt?.output,_task:{capability:r.spec.capability,status:r.status,at:r.receipt?.at,runId:r.runId,error:r.receipt?.error,evidence:r.runId?join(coordinationDir,'runs',r.runId):undefined}}]));
 atomicJson(join(dir,'input.json'),{task:record.spec,dependencies,runId,startedAt:record.startedAt,agent:record.agent});saveState(state);
 // A build runs from its own source workspace, so live workers keep the main checkout (build-workspace.ts).
 const workspace=record.spec.kind==='build'&&record.spec.capability?prepareWorkspace(projectRoot,record.spec.capability,deliveryTask(record.spec.capability).files).root:projectRoot;
 record.pid=spawn('--worker',runId,dir,workspace);saveState(state);event('task-started',{id,runId,pid:record.pid,agent:record.agent,...(workspace!==projectRoot?{workspace}:{})});
}
// A planner run's input names the state file (about 100 bytes) instead of carrying the state (about 4.9 MB per run).
export function plannerState(input:{state?:CoordinatorState;statePath?:string}):CoordinatorState{
 if(input.state)return input.state;
 if(typeof input.statePath!=='string')throw Error('planner input names no state');
 return json(input.statePath);
}
// Old finished tasks move to an append-only archive before the state is saved; nothing is deleted.
export function archiveFinishedTasks(state:CoordinatorState,now=Date.now(),directory=coordinationDir,append:(file:string,data:string)=>void=appendFileSync){
 const candidate={...state};
 const archived=compactState(candidate,now);
 if(!archived.length)return 0;
 const archive=join(directory,'archive');mkdirSync(archive,{recursive:true});
 const file=join(archive,'tasks.jsonl');
 const prior=existsSync(file)?readFileSync(file):Buffer.alloc(0);
 const contents=prior.toString('utf8');
 // A restart before the queue save can replay a batch that already reached the archive.
 const written=new Set(contents.split(/\r?\n/));
 const pending=archived.map(record=>JSON.stringify(record)).filter(line=>!written.has(line));
 if(pending.length){
  const separator=contents&&!contents.endsWith('\n')?'\n':'';
  try{
   append(file,separator+pending.join('\n')+'\n');
  }catch(error){
   // The controller owns the archive. Remove bytes left by a failed append.
   if((statSync(file,{throwIfNoEntry:false})?.size??0)>prior.length)truncateSync(file,prior.length);
   throw error;
  }
 }
 state.tasks=candidate.tasks;
 return archived.length;
}
async function child(mode:string,runId:string){
 const dir=runDirectory(runId);atomicJson(join(dir,'owner.json'),{pid:process.pid,runId,at:Date.now()});
 try{
  const input=json(join(dir,'input.json'));
  if(mode==='--planner'){const proposal=await planWork(plannerState(input),dir,input.timeoutMs,input.agent??'claude');atomicJson(join(dir,'proposal.json'),proposal);}
  else{
   const result=await executeTask(input.task,input.dependencies,dir,runId,input.startedAt,input.agent??'claude');
   const build=input.task.kind==='build';
   const failure=build||input.task.kind==='qualify'?buildFailureEvidence(result,build):{};
   const output={...result,...failure};
   atomicJson(join(dir,'receipt.json'),{taskId:input.task.id,runId,agent:input.agent??'claude',ok:output.ok===true,at:Date.now(),output});
  }
 }catch(error){
  if(mode==='--planner')atomicJson(join(dir,'planner-error.json'),{error:String(error)});
  else{const input=json(join(dir,'input.json'));atomicJson(join(dir,'receipt.json'),{taskId:input.task.id,runId,ok:false,at:Date.now(),output:existsSync(join(dir,'identity.json'))?json(join(dir,'identity.json')):null,error:String(error)});}
  process.exitCode=1;
 }
}
function clearFocus(capability:string){
 const own=readCoordinatorJobs(projectRoot);
 if(own.coordination.focusCapability!==capability)return;
 delete own.coordination.focusCapability;delete own.coordination.focusSince;writeCoordinatorJobs(projectRoot,own);
}
// Rules (coordinator-rules.ts) run before any model round and whatever the planner's state. A fingerprint reads each
// candidate's import closure, so a pass runs on a new receipt or every RULE_RECHECK_MS, not every loop.
const RULE_RECHECK_MS=5*60*1000;
// The rule reads the fleet best from the scoreboard file; it rebuilds the scoreboard only when the file is older than this.
const RULE_BOARD_MAX_AGE_MS=60*60*1000;
type RulePass={at:number;receiptSequence:number};
let rulePass:RulePass={at:0,receiptSequence:-1};
let lowDisk=false;

export function rulePassDue(state:Pick<CoordinatorState,'latestReceiptSequence'>,previous:RulePass,now:number):boolean{
 return (state.latestReceiptSequence??0)!==previous.receiptSequence||now-previous.at>=RULE_RECHECK_MS;
}
let unlocks:((skill:string)=>number[])|undefined;
// A skipped chain is reported once per reason, not on every pass.
const ruleSkips=new Set<string>();
function runRules(state:CoordinatorState,liveLimit:number){
 const now=Date.now();
 if(!rulePassDue(state,rulePass,now))return;
 rulePass={at:now,receiptSequence:state.latestReceiptSequence??0};
 try{
  let board:any;try{board=freshScoreboard(projectRoot,RULE_BOARD_MAX_AGE_MS);}catch{board=null;}
  const fleetSkills:any[]|undefined=Array.isArray(board?.fleetSkills)?board.fleetSkills:undefined;
  const goalStatuses=liveHelperStatuses(projectRoot),entryOf=(capability:string)=>{try{return deliveryTask(capability).entry;}catch{return undefined;}};
  const definitions=readdirSync(join(projectRoot,'packages/router/tasks')).filter(name=>name.endsWith('.json')).flatMap(name=>{try{return[deliveryTask(name.slice(0,-5))];}catch(error){event('progression-definition-unavailable',{file:name,reason:String(error)});return[];}});
  const proofs=progressionProofs(projectRoot),progressionRows:unknown[]=[];
  const observedSources=new Map<string,string>();
  const observedSource=(id:string)=>{let source=observedSources.get(id);if(!source){source=deliveryFingerprint(deliveryTask(id));observedSources.set(id,source);}return source;};
  const progression=(task:CoordTask,account:string):CoordinatorProgressionResult=>{
    const entry=entryOf(task.capability!);if(!entry)return{action:'measure',intent:null,step:null,capability:null,decision:null,stepAccept:null,consumer:task.accept??null,requests:[],reason:'Existing capability entry is unavailable.'};
    const status=goalStatuses.find((row:any)=>row.name?.toLowerCase()===account.toLowerCase())??null;
    const work={script:entry,args:task.args??[],env:task.env??{}};
    const shared=evaluateProgressionWork(work,status,{accept:task.accept,now,base:projectRoot,requireQualification:false});
    const result=evaluateCoordinatorProgression({task,entry,status,now,observed:shared.account,methods:()=>shared.methods??[],
     bindingFor:method=>{
      const proof=proofs[method.id];if(!proof)return null;
      let source:string;try{source=cachedReleaseFor([method.step.script],projectRoot);}catch{return null;}
      if(proof.source!==source||method.source!==source)return null;
      const matches=definitions.filter(d=>d.entry===method.step.script).sort((a,b)=>Number(b.id===task.capability)-Number(a.id===task.capability)||a.id.localeCompare(b.id));
      for(const definition of matches){const fingerprint=observedSource(definition.id);if(reviewApproved(state,definition.id)&&currentQualification(state,definition.id,fingerprint))return{capability:definition.id,methodId:method.id,source,qualification:{source,bands:proof.bands},reviewed:true};}
      return null;
     }});
    progressionRows.push({account,task:task.id,statusAt:status?.at??null,bankAt:status?.bankAt??null,consumer:result.consumer,action:result.action,reason:result.reason,
     method:result.decision?.selected??null,stateFingerprint:result.decision?.stateFingerprint??null,requests:result.requests});
    return result;
   };
  const side=board?.fleet?.side??mySide(),owners=loadOwners();
  const workStatus=(account:string)=>goalStatuses.find((s:any)=>s.name?.toLowerCase()===account.toLowerCase());
  const budget=(task:CoordTask)=>observationBudget(task,entryOf(task.capability!)!);
  const finiteBand=(task:CoordTask,account:string)=>prepareObservationBand(task,workStatus(account),entryOf(task.capability!)!,trial=>progression(trial,account),()=>cachedReleaseFor([entryOf(task.capability!)!],projectRoot));
  let observationRequests:any[]=[];
  try{const saved=json(join(projectRoot,'.practice/progression-system',`fleet-${side}.json`));if(saved.version===1&&saved.side===side&&Number.isFinite(saved.at)&&saved.at>0&&saved.at<=now&&now-saved.at<=900000&&Array.isArray(saved.requests))observationRequests=saved.requests;}catch{/* No request is authority to invent a finite consumer. */}
  const observations=board?.goals?applyObservationRequests(state,observationRequests,{now,side,goals:board.goals,statuses:goalStatuses,
   allowed:account=>owners.get(account.toLowerCase())?.side===side&&owners.get(account.toLowerCase())?.server==='rs-sdk-demo.fly.dev'&&['confirmed','none'].includes(readLogoutProof(account,'rs-sdk-demo.fly.dev',{root:join(projectRoot,'.practice/session-lifecycle')}).state),
   paused:account=>coordinatorAccountPaused(account),
   definition:id=>{const def=deliveryTask(id);return{id:def.id,entry:def.entry,source:observedSource(id)};},
   loginAfter:loginAfter(projectRoot),
   capabilityFor:entry=>entry==='scripts/ranged-train.ts'?definitions.filter(d=>d.entry===entry&&reviewApproved(state,d.id)).sort((a,b)=>Number(!!currentQualification(state,b.id,observedSource(b.id)))-Number(!!currentQualification(state,a.id,observedSource(a.id)))||a.id.localeCompare(b.id))[0]?.id??null:null,
   prepare:finiteBand,
   needsEntryObservation:(task,_account,status)=>{
    if(entryOf(task.capability!)!=='scripts/ranged-train.ts'||!status?.pos||status.pos.level!==0)return false;
    let nearby=false;for(const locate of [prayerBank,rangedEntry])try{const bank=locate({worldX:status.pos.x,worldZ:status.pos.z,level:status.pos.level});if(bank&&Math.max(Math.abs(bank.x-status.pos.x),Math.abs(bank.z-status.pos.z))<=3)nearby=true;}catch{/* Unsupported entry never implies a bank journey. */}
    if(!nearby)return false;
    return status.equipmentObserved!==true||!Number.isFinite(status.bankAt)||status.bankAt<status.started||now-status.bankAt>=300000;
   },
   qualificationFor:(task,account,status)=>{
    if(entryOf(task.capability!)!=='scripts/ranged-train.ts')return null;
    let bytes:Buffer,raw:any;try{bytes=readFileSync(join(projectRoot,'.practice/status',account+'.json'));raw=JSON.parse(bytes.toString());}catch{return null;}
    const proof=readLogoutProof(account,'rs-sdk-demo.fly.dev',{root:join(projectRoot,'.practice/session-lifecycle')});
    if(raw.at!==status.at||raw.name?.toLowerCase()!==account.toLowerCase()||raw.equipmentObserved!==true||!Number.isFinite(raw.bankAt)||raw.bankAt<raw.started||now-raw.bankAt>=300000||proof.state!=='confirmed'||proof.attemptId!==raw.sessionAttemptId)return null;
    const [skill,target]=Object.entries(task.accept?.skills??{})[0]??[],level=raw.skills?.find((s:any)=>s.name?.toLowerCase()===skill?.toLowerCase())?.level;if(!skill||!Number.isSafeInteger(level)||!Number.isSafeInteger(target)||target!<=level)return null;
    let next=level+1;
    for(let candidate=Math.min(target!,level+5);candidate>level;candidate--){const moved=retarget(task,skill,target!,candidate);if(!moved)continue;const priced=evaluateProgressionWork({script:entryOf(task.capability!)!,args:moved.args??[],env:moved.env??{}},raw,{accept:moved.accept,now,base:projectRoot,requireQualification:false}).decision?.expectedTicks;if(priced!=null&&priced<=budget(task)){next=candidate;break;}}
    const source=observedSource(task.capability!),hash=createHash('sha256').update(bytes).digest('hex');
    return{id:'qualify-progression-'+task.capability+'-'+createHash('sha256').update(JSON.stringify([source,account,hash,next])).digest('hex').slice(0,20),kind:'qualify',goal:task.goal,capability:task.capability,account,dependsOn:[...task.dependsOn],priority:Math.min(100,task.priority+1),estimatedMs:600000,timeoutMs:1200000,
     env:{PROGRESSION_ACCOUNT:account,PROGRESSION_TARGET_LEVEL:String(next),PROGRESSION_ENTRY_AT:String(raw.at),PROGRESSION_ENTRY_SHA256:hash,PROGRESSION_CONSUMER:JSON.stringify(task.accept)},
     why:'Qualify the next bounded owned state band before '+task.id+'. Preserve its original finite consumer and all source, actual equipment, bank and logout checks.'};
   }}):{added:[],linked:[],prepared:[],invalidated:[]};
  const added=applyRules(state,{fingerprint:cap=>deliveryFingerprint(deliveryTask(cap)),unlocks:unlocks??=skillUnlocks(projectRoot),maxOpen:liveLimit,progression,
   goalValue:board?.goals?(task,prerequisites=[])=>ruleGoalValue({...state,tasks:[...state.tasks,...prerequisites.map(spec=>({spec,status:'pending' as const,createdAt:now,attempts:0}))]},board.goals,goalStatuses,now,{entryOf})(task):()=>({value:null,reason:'Owner goal observations unavailable'}),
   side:board?.fleet?.side??process.env.FLEET_SIDE??'local',
   fleetBest:skill=>fleetSkills?.find(r=>String(r.skill).toLowerCase()===skill.toLowerCase()),
   skipped:skip=>{const key=JSON.stringify(skip);if(!ruleSkips.has(key)){ruleSkips.add(key);event('rule-skipped',{rule:'next-band',...skip});}},
   paused:account=>coordinatorAccountPaused(account),
   level:(account,skill)=>goalStatuses.find((row:any)=>row.name?.toLowerCase()===account.toLowerCase())?.skills?.find((v:any)=>v.name?.toLowerCase()===skill.toLowerCase())?.level},now);
  atomicJson(join(coordinationDir,'progression-requests.json'),{at:now,rows:progressionRows});
  if(added.length||observations.added.length||observations.linked.length||observations.prepared.length||observations.invalidated.length){saveState(state);event('rule-tasks-added',{tasks:[...added,...observations.added].map(t=>({id:t.id,rule:t.rule,account:t.account,accept:t.accept})),observations:{linked:observations.linked,prepared:observations.prepared,invalidated:observations.invalidated}});}
 }catch(error){event('rule-pass-failed',String(error));}
}
// Opens staged delivery PRs (delivery-pr.ts) beside the loop: git and gh never hold dispatch or live delivery.
let deliveryPrs:Promise<void>|undefined;
function openDeliveryPrs(){
 deliveryPrs??=processDeliveryPrs(coordinationDir,projectRoot).then(({opened,failed,conflicts})=>{
  for(const pr of opened)event('delivery-pr-opened',{task:pr.taskId,branch:pr.branch,state:pr.state,url:pr.url});
  for(const pr of failed)event('delivery-pr-failed',{task:pr.taskId,branch:pr.branch,attempts:pr.attempts,nextAt:pr.nextAt,error:pr.lastError});
  for(const pr of conflicts)event('delivery-pr-conflict',{task:pr.taskId,branch:pr.branch,error:pr.lastError});
 }).catch(error=>event('delivery-pr-failed',String(error))).finally(()=>{deliveryPrs=undefined;});
}
export function nativeDispatchReady(state:Pick<CoordinatorState,'tasks'>,freeGB:number,
 observe:()=>Pick<ReturnType<typeof observePracticeTurn>,'holder'|'liveWaiters'>=()=>observePracticeTurn(join(projectRoot,'.practice/delivery-native.lock'))){
 if(!(freeGB>=NATIVE_STARTUP_GB)||state.tasks.some(r=>r.status==='running'&&r.spec.kind==='qualify'))return false;
 const {holder,liveWaiters}=observe();
 return holder!=='pid-present'&&(liveWaiters??0)===0;
}
const submissionDigest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function acknowledgeSubmission(state:CoordinatorState,base:string,publish:typeof publishCapabilityChanges,move=renameSync){
 const pending=state.pendingSubmission;
 if(!pending)return;
 const directory=join(base,'.practice/coordinator'),{sha256,capabilities}=pending;
 if('file' in pending){
  const {file}=pending;
  if(typeof file!=='string'||basename(file)!==file||!file.endsWith('.request.json'))throw Error('invalid pending submission name');
  const path=join(directory,'requests',file),accepted=path+'.accepted';
  const alreadyAccepted=existsSync(accepted);
  if(alreadyAccepted&&existsSync(path))throw Error('duplicate pending and accepted submission: '+file);
  if(submissionDigest(readFileSync(alreadyAccepted?accepted:path))!==sha256)throw Error('pending submission bytes changed: '+file);
  if(!alreadyAccepted){
   publish(base,capabilities);
   move(path,accepted);
   event('queue-submitted',{file},directory);
  }
 }else{
  const {runId,count}=pending,dir=runDirectory(runId,directory),accepted=join(dir,'plan-accepted.json');
  if(submissionDigest(readFileSync(join(dir,'proposal.json')))!==sha256)throw Error('pending model proposal bytes changed: '+runId);
  const receipt=JSON.stringify({runId,sha256,count},null,2);
  if(existsSync(accepted)){
   if(readFileSync(accepted,'utf8')!==receipt)throw Error('model acknowledgement bytes changed: '+runId);
  }else{
   publish(base,capabilities);
   atomicText(accepted,receipt);
   event('plan-accepted',{runId,count,reason:state.lastPlanReason},directory);
  }
 }
 delete state.pendingSubmission;
}
export function intakeRequests(state:CoordinatorState,base=projectRoot,{save=saveState,move=renameSync,publish=publishCapabilityChanges}={}){
 const directory=join(base,'.practice/coordinator'),requests=join(directory,'requests');mkdirSync(requests,{recursive:true});
 // Recover before reading another request or dispatching from the committed queue.
 acknowledgeSubmission(state,base,publish,move);
 for(const file of readdirSync(requests).filter(f=>f.endsWith('.request.json'))){
  const path=join(requests,file),bytes=readFileSync(path);
  let prepared:ReturnType<typeof prepareProposal>;
  try{
   prepared=prepareProposal(state,JSON.parse(bytes.toString('utf8')),base);
   const scope=existsSync(ownerPlanPath(base))?readMergedPlan(base).coordination?.boundedRecovery:undefined;
   if(scope){if(prepared.capabilities.length)throw Error('bounded recovery refuses capability publication');assertBoundedRecoveryQueue(validateBoundedRecovery(scope),prepared.candidate);}
  }
  catch(error){
   if(typeof (error as NodeJS.ErrnoException)?.code==='string')throw error;
   move(path,path+'.rejected');
   event('queue-submit-failed',{file,error:String(error)},directory);
   continue;
  }
  const {candidate,capabilities}=prepared;
  candidate.pendingSubmission={file,sha256:submissionDigest(bytes),capabilities};
  save(candidate,directory);
  Object.assign(state,candidate);
  acknowledgeSubmission(state,base,publish,move);
 }
}
export function settlePlanner(state:CoordinatorState,base=projectRoot,{save=saveState,publish=publishCapabilityChanges,holds=plannerHolds}={}){
 acknowledgeSubmission(state,base,publish);
 if(!state.planner)return;
 const directory=join(base,'.practice/coordinator');
 const {runId,pid}=state.planner,dir=runDirectory(runId,directory),proposal=join(dir,'proposal.json'),error=join(dir,'planner-error.json');
 const hasProposal=existsSync(proposal),hasError=existsSync(error);
 if(!hasProposal&&!hasError&&pid&&holds(pid,runId))return;
 let bytes:Buffer,prepared:ReturnType<typeof prepareProposal>;
 try{
  if(!hasProposal)throw Error(hasError?json(error).error:'planner ended without proposal');
  bytes=readFileSync(proposal);
  prepared=prepareProposal(state,JSON.parse(bytes.toString('utf8')),base,'model');
 }catch(error){
  if(typeof (error as NodeJS.ErrnoException)?.code==='string')throw error;
  // A refused proposal stays on disk. A planner that ended with no proposal leaves nothing to correct.
  const failed={...state,lastPlanReason:'planner failed: '+String(error),...(hasProposal?{rejectedPlan:{runId,error:String(error)}}:{})};
  finishPlan(failed,Date.now(),false);
  save(failed,directory);
  Object.assign(state,failed);
  delete state.planner;
  event('plan-failed',String(error),directory);
  return;
 }
 const {candidate,capabilities,count}=prepared;
 finishPlan(candidate,Date.now(),true);
 candidate.pendingSubmission={runId,count,sha256:submissionDigest(bytes),capabilities};
 save(candidate,directory);
 Object.assign(state,candidate);
 // Object.assign copies keys. It does not remove the keys that finishPlan deleted from the candidate.
 delete state.planner;
 delete state.planFailures;
 delete state.rejectedPlan;
 acknowledgeSubmission(state,base,publish);
}
// A finished job that still holds an account is released at most this often (releaseFinishedOwnJobs). For each job in
// the coordinator's file the pass reads one receipt, and one logout proof for each account of the job.
const RELEASE_EVERY_MS=60_000;
let releasedAt=0;
const reconcileProgressionProofs=createProgressionProofReconciler(projectRoot);
let proofPublicationPass={at:0,receiptSequence:-1};
// A run task with a repair is a recovery: it parks owner jobs and needs them until its install.
export const recoveryRuns=(state:Pick<CoordinatorState,'tasks'>)=>state.tasks.some(r=>r.status==='running'&&r.spec.kind==='run'&&(!!r.spec.repairs?.length||!!r.spec.sessionRecovery));
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
  let publishing:string|undefined;try{publishing=existsSync(request)?json(request).capability:undefined;}catch{/* a request being written */}
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
  state.planner={runId,agent,startedAt:Date.now()};saveState(state);state.planner.pid=spawn('--planner',runId,dir);event('planner-started',{runId,pid:state.planner.pid,agent,reason:planReason});
 }
 const archived=archiveFinishedTasks(state);if(archived)event('tasks-archived',{count:archived,remaining:state.tasks.length});
 saveState(state);
}
export function plannerPaused(base=projectRoot):boolean{return existsSync(join(base,'.practice','stop-planner'));}
export function plannerAgent(configured:readonly ModelWorker[]|undefined,records:readonly {status:string;agent?:ModelWorker;spec:{kind:string}}[]):ModelWorker|null{
 const allowed=(['codex','claude'] as const).filter(agent=>configured===undefined||configured.includes(agent));
 const preferred=assignedWorker('build',records.filter(r=>r.status==='running'&&r.spec.kind==='build'));
 return allowed.includes(preferred)?preferred:allowed[0]??null;
}
// One recursive watch is one OS handle on Windows: 16 ms CPU per 10 s over 2,447 run folders, against 63 ms for a
// watch per open folder. The folder count does not make it dearer.
export function waitForWork(timeoutMs=1000,directory=coordinationDir){
 return new Promise<void>(resolve=>{
  let watcher:ReturnType<typeof watch>|undefined;
  const done=()=>{clearTimeout(timer);watcher?.close();resolve();};const timer=setTimeout(done,timeoutMs);
  try{watcher=watch(directory,{recursive:true},(_,file)=>{if(/(?:receipt\.json|proposal\.json|planner-error\.json|\.request\.json|plan-request|restart)$/.test(String(file)))done();});}catch{/* bounded fallback also observes stop files */}
 });
}
type CoordinatorOwner={pid:number;nonce:string;at?:number};
export async function claimCoordinatorState(nonce:string,directory=coordinationDir,
 held=(owner:CoordinatorOwner)=>owner.pid!==process.pid&&ownerHolds(owner)){
 const lease=join(directory,'owner.json');
 const activeOwner=():CoordinatorOwner|null=>{
  if(!existsSync(lease))return null;
  const owner:CoordinatorOwner=json(lease);
  return held(owner)?owner:null;
 };
 // The predecessor can still save the queue while its reload successor waits.
 const deadline=Date.now()+60000;
 while(nonce.startsWith('reload-')&&activeOwner()&&Date.now()<deadline)await Bun.sleep(1000);
 const rejectActiveOwner=()=>{
  const owner=activeOwner();if(owner)throw Error('coordinator already owned by PID '+owner.pid);
 };
 rejectActiveOwner();
 // Cold starts can compete before a dispatcher owns the queue. Recover through the dead writer's unique intent.
 return withPlanWrite(()=>{
  rejectActiveOwner();
  const state=loadState(directory);
  atomicJson(lease,{pid:process.pid,nonce,at:Date.now(),...boundedOwnerBinding(projectRoot)});
  return state;
 },directory,15000,recoverConcurrentPlanWrite);
}
export async function pauseCoordinator(state:CoordinatorState,base=projectRoot,stopWorker=safeKill){
 const practice=join(base,'.practice'),directory=join(practice,'coordinator');
 const swarmStop=join(practice,'stop-swarm');
 const systemDrain=!existsSync(join(practice,'stop-coordinator'))&&existsSync(swarmStop)&&readFileSync(swarmStop,'utf8').trim()===SWARM_STOP.all;
 for(const job of readCoordinatorJobs(base).jobs.filter((j:any)=>j.coordinatorOwner==='coordinator'&&j.enabled!==false)){
  await disableOwnJob(job.env?.COORDINATOR_RUN_ID,base);
  for(const account of job.accounts??[job.account])if(account)writeSwarmStop(join(practice,'stop-'+account),systemDrain?SWARM_STOP.all:'coordinator owner pause');
 }
 const running=state.tasks.filter(r=>r.status==='running');
 // Live task watchers check for the pause once a second, then disable their job before writing the receipt.
 const deadline=Date.now()+3000;
 while(Date.now()<deadline&&running.some(r=>r.spec.kind==='run'&&r.pid&&existsPid(r.pid)
  &&!existsSync(join(directory,'runs',r.runId!,'receipt.json'))))await Bun.sleep(100);
 for(const r of running)if(r.pid)await stopWorker(r.pid,r.runId!);
 if(state.planner?.pid)await stopWorker(state.planner.pid,state.planner.runId);
 // Workers can write their terminal receipt while the pause is stopping them.
 // No more workers will start, so a dead worker needs no startup grace period.
 reconcile(state,undefined,directory,undefined,0);
 saveState(state,directory);
 const unsettledRuns=running.filter(r=>r.status==='running').map(r=>r.runId);
 event('coordinator-paused',{reason:systemDrain?'cloud watch drain':'owner stop file',unsettledRuns},directory);
}
async function main(){
 const mode=process.argv[2]??'--status',arg=process.argv[3];
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
   if(!arg)throw Error('proposal file required');const request=json(arg),requests=join(coordinationDir,'requests');mkdirSync(requests,{recursive:true});
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
  const pid=spawnDetached([process.execPath,join(projectRoot,'packages/router/src/coordinator-cli.ts'),'--run',token],projectRoot,join(coordinationDir,`daemon-${stamp}.out.log`),join(coordinationDir,`daemon-${stamp}.err.log`));
  // Publish the handoff before this process exits. The watch must count a successor that has not claimed yet.
  await withPlanWrite(()=>{const file=join(coordinationDir,'owner.json'),owner=json(file);if(owner.pid!==process.pid||owner.nonce!==nonce)throw Error('coordinator reload owner changed');atomicJson(file,{...owner,successor:{pid,nonce:token}});});
  event('coordinator-reload',{children:'preserved for adoption',successor:pid});return;
 }
 if(existsSync(stop)||existsSync(join(projectRoot,'.practice/stop-swarm')))await pauseCoordinator(state);
}
if(import.meta.main)await main().catch(e=>{console.error(String(e));process.exitCode=1;});
