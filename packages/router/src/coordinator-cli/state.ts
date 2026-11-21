import {appendFileSync,existsSync,mkdirSync,readFileSync,statSync,truncateSync} from 'node:fs';
import {join} from 'node:path';
import {boundedOwnerBinding} from '../../../core/src/bounded-owners';
import {COORDINATOR_JOBS_FILE,ownerPlanPath,readCoordinatorJobs,readMergedPlan,writeCoordinatorJobs} from '../../../core/src/coordinator-jobs';
import {recoverConcurrentPlanWrite} from '../../../core/src/plan-lock';
import {processMatches,safeKill} from '../../../core/src/proc';
import {cachedLaunchRevision} from '../../../core/src/worker-release';
import {SWARM_STOP,writeSwarmStop} from '../../../../scripts/swarm';
import {boundAccounts,compactState,finishTask,type CoordinatorState} from '../coordinator';
import {disableOwnJob,validLiveMemoryWait} from '../coordinator-live';
import {atomicJson,atomicText,coordinationDir,event,loadState,projectRoot,recoverPlanWrite,runDirectory,saveState,withPlanWrite} from '../coordinator-store';
import {existsPid,ownerHolds,readJson,recoveryRuns,workerHolds} from './holds';

// The owner's swarm.json with the coordinator's own jobs and settings merged in (packages/core/src/coordinator-jobs.ts).
export const readPlan=()=>readMergedPlan(projectRoot);

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

export function clearFocus(capability:string){
 const own=readCoordinatorJobs(projectRoot);
 if(own.coordination.focusCapability!==capability)return;
 delete own.coordination.focusCapability;delete own.coordination.focusSince;writeCoordinatorJobs(projectRoot,own);
}

export function reconcile(state:CoordinatorState,alive:(pid:number,marker:string)=>boolean=processMatches,directory=coordinationDir,pidExists=existsPid,startupGraceMs=15000,holds:(pid:number,runId:string,at:number)=>boolean=workerHolds){
 for(const record of state.tasks.filter(r=>r.status==='failed'&&r.receipt?.error?.startsWith('worker ended without a receipt'))){
  const file=join(runDirectory(record.runId!,directory),'receipt.json');
  if(existsSync(file)){
   const old=record.receipt;record.status='running';
   if(finishTask(state,readJson(file)))event('late-worker-receipt-recovered',{id:record.spec.id,previousFailure:old,receipt:file},directory);
   else{record.status='failed';record.receipt=old;}
  }
 }
 for(const record of state.tasks.filter(r=>r.status==='running')){
  const dir=runDirectory(record.runId!,directory),receipt=join(dir,'receipt.json'),owner=join(dir,'owner.json');
  if(existsSync(receipt)){
   const result=readJson(receipt),wait=result.output?.liveDeferred;
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
  const claim=existsSync(owner)?readJson(owner):null,pid=claim?claim.pid:record.pid;
  // CIM can briefly return no command line under load. That is not evidence
  // that a process ended. Keep its ownership until OS liveness also fails.
  // Check OS liveness first: command-line lookup starts PowerShell on Windows.
  // The existing rule retains a live PID even when CIM cannot identify it. A PID that started after the worker wrote its
  // owner file belongs to another program, which reused the PID.
  if(pid&&(pidExists(pid)?!Number.isFinite(claim?.at)||holds(pid,record.runId!,claim.at)||alive(pid,record.runId!):alive(pid,record.runId!)))continue;
  if(Date.now()-(record.startedAt??0)>=startupGraceMs)finishTask(state,{taskId:record.spec.id,runId:record.runId!,ok:false,at:Date.now(),output:null,error:'worker ended without a receipt; inspect preserved run before repair'});
 }
}

// A planner run's input names the state file (about 100 bytes) instead of carrying the state (about 4.9 MB per run).
export function plannerState(input:{state?:CoordinatorState;statePath?:string}):CoordinatorState{
 if(input.state)return input.state;
 if(typeof input.statePath!=='string')throw Error('planner input names no state');
 return readJson(input.statePath);
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

type CoordinatorOwner={pid:number;nonce:string;at?:number};
export async function claimCoordinatorState(nonce:string,directory=coordinationDir,
 held=(owner:CoordinatorOwner)=>owner.pid!==process.pid&&ownerHolds(owner)){
 const lease=join(directory,'owner.json');
 const activeOwner=():CoordinatorOwner|null=>{
  if(!existsSync(lease))return null;
  const owner:CoordinatorOwner=readJson(lease);
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

export {recoveryRuns};
