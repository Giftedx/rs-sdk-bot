import {RESERVED_ACCOUNTS} from '../../core/src/specialist-boards';
import {readFileSync,existsSync,readdirSync,writeFileSync,renameSync,unlinkSync,mkdirSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {admissionDecision,startReserve,activeExternalLive,RECOVERY_SLOT_WAIT_MS,loadEnded,persistEnded,persistentEnd,loadHolds,openHold,LIVE_SERVER,failedScript,scriptKey,missionSignature,swarmWroteStop,clearSwarmStop,standingRetryable,supplyExhaustedResult} from '../../../scripts/swarm';
import {liveLogoutRef} from './coordinator-session';
import {BOOTSTRAP_STATUS_AGE_MS} from '../../core/src/session-admission';
import {evaluateLaunch} from '../../../scripts/haggis-gate';
import {evaluateSpecialist, MAX_SPECIALIST_RUN_MS, SPECIALIST_BOARDS, specialistTokenPath} from '../../core/src/specialist-launch';
import {loadOwners,FLEET_DIR} from '../../core/src/fleet';
import {inOpenOrder} from '../../../scripts/autopilot';
import {validOrder,type Order,type Receipt} from '../../../scripts/fleet-trade-settlement';
import {readHeldFleetTradeClaims} from '../../core/src/fleet-trade-claim';
import {cachedLaunchRevision,cachedReleaseFor,capabilityRevision,launchRevision,workerEntries} from '../../core/src/worker-release';
import {hashImportClosure} from './delivery-cli';
import {processMatches,safeKill,safeKillOne} from '../../core/src/proc';
import {acceptStatus,boundedWorkerEndMessage,boundAccounts,type CoordTask,type CoordinatorState} from './coordinator';
import {projectRoot,coordinationDir,atomicJson,spawnDetached,withPlanWrite} from './coordinator-store';
import {RECOVERY_SCHEMA,assertNoRecoveryLease,heldRecoveryOwners,recoveredSessionForRun,type ControlledRecoveryRequest} from '../../core/src/session-recovery-permit';
import {COORDINATOR_JOBS_FILE,readCoordinatorJobs,readMergedPlan,ownerPlanPath,writeCoordinatorJobs,mergedPlan,jobAccounts,parkedCoordinatorAccounts,shadowAssignments,type CoordinatorJobs} from '../../core/src/coordinator-jobs';
import {boundedOwnerBinding,boundedProcessAlive} from '../../core/src/bounded-owners';
import {readLogoutProof,listAttempts} from '../../core/src/session-lifecycle';
import {pidAlive} from '../../core/src/session-takeover';

// The swarm refuses a session recovery when memory is short (admitRecovery in scripts/swarm.ts). That refusal is
// final for the run, and each run chained behind it then waits for a new proposal. So a recovery run stays in the
// queue while the controller's last state shows that refusal. The margin covers what the swarm counts after this
// read: the dispatched recovery is one more pending start (pendingCount in scripts/swarm.ts), and the processes of
// the run take memory before the admission (live: free fell from 10.55 to 8.78 GiB in the 11 s of one dispatch).
export const RECOVERY_MEMORY_MARGIN_GB=3;
export function recoveryWaitsForMemory(task:Pick<CoordTask,'sessionRecovery'>,capacity:{running:number|null;externalRunning:number|null;pendingStartup:number|null;freeGB:number|null;minFreeGB:number|null;maxBots:number|null}|null):boolean{
 if(!task.sessionRecovery||!capacity||capacity.freeGB===null||capacity.minFreeGB===null)return false;
 // The memory numbers decide, not the reason: with every bot slot taken the decision names the slot first, and the
 // swarm, which keeps a slot for a recovery, still refuses on memory.
 const d=admissionDecision({running:capacity.running??0,external:capacity.externalRunning??0,pending:capacity.pendingStartup??0,starting:1,startingReserve:1,
  freeGB:Math.max(0,capacity.freeGB-RECOVERY_MEMORY_MARGIN_GB),minFreeGB:capacity.minFreeGB,maxBots:capacity.maxBots??Number.MAX_SAFE_INTEGER});
 return d.reason!=='invalid'&&d.projectedFreeGB<d.floorGB;
}
// A controller that wrote .practice/swarm-state.json under this pid and nonce within this window is the saved
// controller: no PowerShell command-line probe is needed while its pid is alive.
export const CONTROLLER_STATE_FRESH_MS=10_000;
export function readFreshControllerState(owner:{pid:number;nonce:string},base=projectRoot,now=Date.now()){
 try{const s=JSON.parse(readFileSync(join(base,'.practice/swarm-state.json'),'utf8'));
  return s.controllerPid===owner.pid&&s.coordinatorOwner===owner.nonce&&Number.isFinite(s.at)&&now-s.at>=0&&now-s.at<CONTROLLER_STATE_FRESH_MS?s:null;}
 catch{return null;}
}
export function controllerStateFresh(owner:{pid:number;nonce:string},base=projectRoot,now=Date.now()):boolean{
 return readFreshControllerState(owner,base,now)!==null;
}

export function liveRows(base=projectRoot){
 return readdirSync(join(base,'.practice/status')).filter(f=>f.endsWith('.json')).flatMap(f=>{try{return[JSON.parse(readFileSync(join(base,'.practice/status',f),'utf8'))]}catch{return[]}});
}
export function swarmProcesses():number[]{
 if(process.platform!=='win32')return [];
 const child=Bun.spawnSync(['powershell','-NoProfile','-Command',"@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -match 'scripts[\\/]swarm\\.ts' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress"],{stdout:'pipe',stderr:'ignore',windowsHide:true});
 if(child.exitCode!==0)throw Error('controller process ownership unavailable');
 const value=child.stdout.toString().trim();if(!value)return[];const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed:[parsed];
}
export async function awaitControllerDrain(owner:{pid:number;nonce:string;source:string},after:number,base=projectRoot,timeoutMs=15000,
 timing:{now?:()=>number;pause?:(ms:number)=>Promise<void>}={}){
 const now=timing.now??Date.now,pause=timing.pause??Bun.sleep,limit=now()+timeoutMs;
 while(now()<limit){
  let state:any;try{state=JSON.parse(readFileSync(join(base,'.practice/swarm-state.json'),'utf8'));}catch{await pause(100);continue;}
  if(!Number.isFinite(state.at)||state.at<=after){await pause(100);continue;}
  if(state.controllerPid!==owner.pid||state.coordinatorOwner!==owner.nonce||state.release!==owner.source)throw Error('controller drain ownership changed');
  if(state.running!==0||state.pendingStartup!==0||state.externalRunning!==0)throw Error('controller drain has owned or external sessions; preserve them');
  return state;
 }
 throw Error('controller drain acknowledgement timed out; no process stopped');
}
type ControllerIdentity={pid:number;nonce:string;source:string;at?:number;detached?:boolean};
// A detached-run controller (scripts/swarm.ts adopts its runs from .practice/swarm-runs.json) only has to be up and
// owned: its runs outlive it, so a rollout neither drains nor pauses them.
export async function awaitControllerAck(owner:{pid:number;nonce:string;source:string},after:number,base=projectRoot,timeoutMs=15000,
 timing:{now?:()=>number;pause?:(ms:number)=>Promise<void>}={}){
 const now=timing.now??Date.now,pause=timing.pause??Bun.sleep,limit=now()+timeoutMs;
 while(now()<limit){
  let state:any;try{state=JSON.parse(readFileSync(join(base,'.practice/swarm-state.json'),'utf8'));}catch{await pause(100);continue;}
  if(!Number.isFinite(state.at)||state.at<=after){await pause(100);continue;}
  if(state.controllerPid!==owner.pid||state.coordinatorOwner!==owner.nonce||state.release!==owner.source)throw Error('controller acknowledgement ownership changed');
  return state;
 }
 throw Error('controller acknowledgement timed out');
}
type SwarmRolloutDeps={base?:string;currentSource?:()=>string;diskSource?:()=>string;matches?:(pid:number,nonce:string)=>boolean;pidExists?:(pid:number)=>boolean;
 processes?:()=>number[];rows?:()=>any[];stop?:(pid:number,nonce:string)=>Promise<boolean>;spawn?:(source:string,nonce:string)=>number;
 drain?:(owner:ControllerIdentity,after:number)=>Promise<unknown>;ack?:(owner:ControllerIdentity,after:number)=>Promise<unknown>;stopOne?:(pid:number,nonce:string)=>Promise<boolean>;now?:()=>number};
// The swarm's own code: a standing job runs current worker source (STANDING=1), so only these files need a rollout.
export const ROLLOUT_DRAIN_MS=5*60*1000,ROLLOUT_BACKOFF_MS=60*60*1000;
export const SWARM_FILES=['scripts/swarm.ts','packages/practice/src/supervise.ts','packages/practice/src/supervise-host.ts'];
export async function ensureSwarm(source:string,deps:SwarmRolloutDeps={},forRun=true){
 const base=deps.base??projectRoot,dir=join(base,'.practice/coordinator'),ownerFile=join(dir,'swarm-owner.json'),lock=join(dir,'build-lock.json');
 const swarmSource=hashImportClosure(SWARM_FILES,base);
 const stopped=()=>existsSync(join(base,'.practice/stop-coordinator'))||existsSync(join(base,'.practice/stop-swarm'));
 if(stopped())throw Error('controller rollout owner stopped');
 const diskSource=deps.diskSource??(()=>cachedLaunchRevision(base));
 const currentSource=deps.currentSource??diskSource,matches=deps.matches??processMatches,now=deps.now??Date.now;
 const pidExists=deps.pidExists??boundedProcessAlive;
 const stop=deps.stop??safeKill,drain=deps.drain??((owner:ControllerIdentity,after:number)=>awaitControllerDrain(owner,after,base));
 const ack=deps.ack??deps.drain??((owner:ControllerIdentity,after:number)=>awaitControllerAck(owner,after,base));
 // Stop only the controller process: a tree kill would end the detached runs it adopted.
 const stopOne=deps.stopOne??deps.stop??safeKillOne;
 if(currentSource()!==source)throw Error('runtime changed before controller rollout');
 // A lock whose owner process is gone fences nothing: archive it into its run folder. A failed build can die holding
 // it, and so can a controller a rollout could not confirm stopped: the fence then names that controller's pid. The
 // process check below still refuses a second controller.
 if(existsSync(lock)){let held:any=null;try{held=JSON.parse(readFileSync(lock,'utf8'));}catch{/* unreadable lock stays a fence */}
  if(held&&Number.isSafeInteger(held.pid)&&held.pid>0&&!pidExists(held.pid)&&typeof held.runId==='string'&&/^(?:task|rollout)-[0-9a-f-]+$/.test(held.runId)){const runDir=join(dir,'runs',held.runId);mkdirSync(runDir,{recursive:true});renameSync(lock,join(runDir,'expired-build-lock.json'));}}
 if(existsSync(lock))throw Error('runtime owner or unacknowledged controller remains fenced');
 let owner:any=null;if(existsSync(ownerFile))owner=JSON.parse(readFileSync(ownerFile,'utf8'));
 if(existsSync(ownerFile)&&(!owner||!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.nonce!=='string'||!owner.nonce))throw Error('saved controller identity malformed; preserve ownership fence');
 const alive=owner&&(pidExists(owner.pid)&&controllerStateFresh(owner,base,now())||matches(owner.pid,owner.nonce));
 if(owner&&!alive&&pidExists(owner.pid))throw Error('saved controller is alive but command ownership is unknown; do not start a duplicate');
 // A rollout pauses standing jobs by listing their accounts in the coordinator's file (the merged plan shows them
 // off, so the swarm stops them at their next step) and clears the list once the current controller runs: that
 // off/on is the swarm's own resume path. swarm.json is not written.
 const pausedFile=join(dir,'rollout-paused.json');
 const paused=():string[]=>{try{return JSON.parse(readFileSync(pausedFile,'utf8'));}catch{return [];}};
 const standing=():string[]=>{try{return readMergedPlan(base).jobs.filter((j:any)=>j.standing===true&&j.enabled).flatMap(jobAccounts);}catch{return [];}};
 const setEnabled=(accounts:readonly string[],on:boolean)=>withPlanWrite(()=>{
  const own=readCoordinatorJobs(base),keys=new Set(accounts.map(a=>a.toLowerCase())),held=new Set((own.paused??[]).map(a=>a.toLowerCase()));
  for(const key of keys)if(on)held.delete(key);else held.add(key);
  if(held.size)own.paused=[...held];else delete own.paused;
  writeCoordinatorJobs(base,own);
 },dir);
 // The list in the coordinator's file has no other writer. A name there that the pause file does not hold is left
 // from a pause that did not finish, and nothing else turns that job on again: resume clears those names too.
 const resume=async()=>{const p=[...paused(),...(readCoordinatorJobs(base).paused??[])];if(p.length){await setEnabled(p,true);if(existsSync(pausedFile))unlinkSync(pausedFile);}};
 // `source` is the launch release (worker-release.ts): the swarm, its launchers and the recovery runner. A coordinator
 // run needs the controller on it, because recovery permits bind to the controller's WORKER_RELEASE; standing jobs need
 // only the swarm's own code current. Workers carry their own capability release (swarm.ts), so no rollout follows it.
 const runtimeCurrent=!forRun||owner?.source===source;
 if(alive&&owner.swarmSource===swarmSource&&runtimeCurrent){await resume();return;}
 // A standing rollout gets ROLLOUT_DRAIN_MS to drain; then the jobs run again and the next try waits ROLLOUT_BACKOFF_MS.
 const backoffFile=join(dir,'rollout-backoff.json');
 // The backoff spaces rollouts of a running swarm; a dead controller is started at once.
 {let until=0;try{until=JSON.parse(readFileSync(backoffFile,'utf8')).until;}catch{/* none */}if(alive&&now()<until&&runtimeCurrent){await resume();return;}}
 if((deps.processes??swarmProcesses)().some(pid=>!alive||pid!==owner.pid))throw Error('another controller owns the swarm; development remains eligible');
 // A live session rewrites its status every few seconds; one unchanged for BOOTSTRAP_STATUS_AGE_MS is not open (the
 // server drops a lost session after 200 s). A killed run's held record would otherwise block every rollout.
 // A detached-run controller keeps its runs through a restart: no session needs to settle first.
 const detached=alive&&owner?.detached===true;
 const open=alive&&!detached?(deps.rows??(()=>liveRows(base)))().filter(s=>s.server===LIVE_SERVER&&!s.result&&!(Number.isFinite(s.at)&&now()-s.at>=BOOTSTRAP_STATUS_AGE_MS)):[];
 if(open.length){
  // Every standing job counts here, on or off: a job just turned off still closes its last session.
  const allStanding=():string[]=>{try{return (JSON.parse(readFileSync(ownerPlanPath(base),'utf8')).jobs??[]).filter((j:any)=>j.standing===true).flatMap((j:any)=>j.accounts??(j.account?[j.account]:[]));}catch{return [];}};
  const names=new Set(allStanding().map(a=>a.toLowerCase())),own=open.filter(s=>names.has(String(s.name).toLowerCase())).map(s=>String(s.name));
  // Pause standing jobs only when nothing else holds the rollout; while a coordinator run does, they keep working.
  // Pause every enabled standing job, not only the open ones: a job paused alone restarts and reopens a session.
  const since=existsSync(pausedFile)?statSync(pausedFile).birthtimeMs||statSync(pausedFile).mtimeMs:now();
  if(!forRun&&existsSync(pausedFile)&&now()-since>ROLLOUT_DRAIN_MS){await resume();atomicJson(backoffFile,{until:now()+ROLLOUT_BACKOFF_MS,open:open.map(s=>s.name)});throw Error('standing rollout did not drain; jobs resumed, next try in '+ROLLOUT_BACKOFF_MS/60000+' min');}
  if(own.length===open.length){const all=standing();await setEnabled(all,false);if(!existsSync(pausedFile))atomicJson(pausedFile,[...new Set(all)]);else atomicJson(pausedFile,[...new Set([...paused(),...all])]);}
  // A coordinator run holds the rollout: standing jobs keep working, and the next standing try waits the backoff.
  else{await resume();if(!forRun)atomicJson(backoffFile,{until:now()+ROLLOUT_BACKOFF_MS,open:open.map(s=>s.name)});}
  throw Error('runtime rollout waits for existing sessions to settle');
 }
 const repair=join(base,'.practice/swarm-repair.json'),repairLease=repair+'.lease',rollout='rollout-'+randomUUID();let locked=false,repairLocked=false;
 let retainFence:ControllerIdentity|undefined;
 try{
  // The build lock suppresses all new launches, including if source bytes revert. A post-lock tick
  // includes a child whose start passed its checks before the lock. The repair lease fences state writers.
  writeFileSync(lock,JSON.stringify({pid:process.pid,runId:rollout,at:now()}),{flag:'wx'});locked=true;
  writeFileSync(repairLease,JSON.stringify({pid:process.pid,runId:rollout,nonce:rollout}),{flag:'wx'});repairLocked=true;
  if(existsSync(repair)||existsSync(repair+'.processing'))throw Error('controller rollout waits for its owned repair channel');
  if(alive){
   if(!detached)await drain(owner,now());if(stopped())throw Error('controller rollout owner stopped');if(diskSource()!==source)throw Error('runtime changed during controller rollout');
   try{await (detached?stopOne:stop)(owner.pid,owner.nonce);}catch(error){if(pidExists(owner.pid))retainFence=owner;throw error;}
   if(pidExists(owner.pid)){retainFence=owner;throw Error('old controller stop unconfirmed; admission remains fenced');}
  }
  if(stopped())throw Error('controller rollout owner stopped');
  if(diskSource()!==source)throw Error('runtime changed before controller spawn');
  const nonce=randomUUID(),pid=(deps.spawn??((release:string,marker:string)=>spawnDetached([process.execPath,join(base,'scripts/swarm.ts'),ownerPlanPath(base),'--coordinator='+marker],base,join(dir,'swarm.out.log'),join(dir,'swarm.err.log'),{...process.env,DEMO_OK:'1',WORKER_RELEASE:release,WORKER_ENTRY:''})))(source,nonce);
  const next={pid,nonce,source,swarmSource,at:now(),detached:true,...boundedOwnerBinding(base)};
  try{
   atomicJson(ownerFile,next);await ack(next,next.at);if(stopped())throw Error('controller rollout owner stopped');
   if(diskSource()!==source)throw Error('runtime changed before controller admission');
  }catch(error){
   try{await stopOne(pid,nonce);}catch{/* retain the fence unless process death can be confirmed */}
   if(pidExists(pid))retainFence=next;
   else if(existsSync(ownerFile)){const saved=JSON.parse(readFileSync(ownerFile,'utf8'));if(saved.pid===pid&&saved.nonce===nonce)unlinkSync(ownerFile);}
   throw error;
  }
 }finally{
  if(repairLocked&&existsSync(repairLease)){const held=JSON.parse(readFileSync(repairLease,'utf8'));if(held.pid===process.pid&&held.runId===rollout)unlinkSync(repairLease);}
  if(locked&&existsSync(lock)){const held=JSON.parse(readFileSync(lock,'utf8'));if(held.pid===process.pid&&held.runId===rollout){
   if(retainFence)atomicJson(lock,{pid:retainFence.pid,runId:rollout,nonce:retainFence.nonce,source:retainFence.source,at:now(),reason:'controller stop/acknowledgement unconfirmed; preserve admission fence'});
   else unlinkSync(lock);
  }}
 }
}
export function accountFor(task:CoordTask,dependencies:Record<string,any>):string{
 const account=task.account??dependencies[task.accountFrom??'']?.account;
 if(typeof account!=='string'||!/^[A-Za-z0-9_ -]{1,12}$/.test(account))throw Error('account binding unavailable');return account;
}
export function replaceAssignments(jobs:any[],accounts:string[],replacement:any){
 const selected=new Set(accounts.map(n=>n.toLowerCase()));
 return jobs.flatMap(job=>{
  const names:string[]=(job.accounts??[job.account]).filter(Boolean),remaining=names.filter(n=>!selected.has(n.toLowerCase()));
  if(remaining.length===names.length)return[job];
  if(job.orchestrate&&remaining.length)throw Error('a composed assignment needs all its participants; do not split its ownership');
  if(!remaining.length)return[];
  return[{...job,accounts:remaining}];
 }).concat([replacement]);
}
// A finished run leaves its job in the coordinator's file, turned off (disableOwnJob). That job still owns its accounts
// in the merged plan, and a composed one refuses a later run on one participant. Release the named accounts from a
// coordinator job when its run holds a terminal receipt for its task, the job is off, no swarm run holds any participant
// and every participant has a confirmed logout. A failed receipt is terminal: the confirmed logout releases the account,
// not the outcome of its work, so a dead job cannot shadow an account whose session is already settled. Other
// participants keep a disabled job, so their owner jobs stay shadowed until a call names them (releaseFinishedOwnJobs).
// Any other job (active, missing receipt, held, owner or unproved) is returned unchanged.
// The accounts that a swarm run holds, in lower case. null: the list of runs does not read, so no account is known as idle.
function swarmRunAccounts(base:string):Set<string>|null{
 try{const runs=JSON.parse(readFileSync(join(base,'.practice/swarm-runs.json'),'utf8'));
  return Array.isArray(runs)?new Set(runs.flatMap((r:any)=>Array.isArray(r?.accounts)?r.accounts:[null]).map((n:unknown)=>String(n).toLowerCase())):null;}
 catch(e){return (e as NodeJS.ErrnoException).code==='ENOENT'?new Set():null;}
}
// An enabled autopilot row can yield between runs after its exact mission succeeded (or exhausted supplies) and logged out.
// A row prepared for a different, unstarted mission cannot inherit the previous mission's outcome.
function settledAutopilotJob(job:any,account:string,base:string):boolean{
 if(job?.standing!==true||job.enabled!==true||typeof job.autopilot!=='string'||!job.autopilot)return false;
 const root=join(base,'.practice/session-lifecycle'),proof=readLogoutProof(account,LIVE_SERVER,{root});
 if(proof.state!=='confirmed')return false;
 const receipt=listAttempts(account,LIVE_SERVER,{root}).find(a=>a.attemptId===proof.attemptId)?.receipt;
 const running=swarmRunAccounts(base);if(!receipt||!running||running.has(account.toLowerCase()))return false;
 try{assertNoRecoveryLease(account,base);}catch{return false;}
 const end=[...loadEnded(join(base,'.practice/swarm-deaths.json'))].find(([n])=>n.toLowerCase()===account.toLowerCase())?.[1];
 const status=liveRows(base).find(s=>s.name?.toLowerCase()===account.toLowerCase()),entries=workerEntries(job.script,job.args??[],base);
 const okEnd=!!end&&/^done(?: after \d+ runs)?$/.test(end.reason)&&/^ok(?:\s|$)/.test(status?.result??'');
 const supplyEnd=!!end&&/^(?:blocked|stopped)(?: after \d+ runs)?$/.test(end.reason)
  &&supplyExhaustedResult(status?.result,job.env)
  &&!standingRetryable(end.reason,status?.result,job.standingRetry,job.env);
 return (okEnd||supplyEnd)&&end.revision===missionSignature(job)&&end.at>=proof.loggedOutAt
  &&receipt.owner.coordinatorRunId===null&&entries.includes(receipt.owner.script)&&/^[0-9a-f]{64}$/.test(receipt.owner.workerRelease??'')
  &&status?.server===LIVE_SERVER&&status.goal===job.goal
  &&status.sessionAttemptId===proof.attemptId&&status.workRevision===receipt.owner.workerRelease&&status.workEntry===entries.join(',')
  &&(status.coordinatorRunId??null)===null&&Number.isFinite(status.started)&&status.started>=receipt.createdAt&&status.started<=proof.loggedOutAt
  &&Number.isFinite(status.at)&&status.at>=status.started&&status.at<=end.at;
}
// `reserved`: swarm.json holds the account with a reservation row (disabled, no script), as for the gang squad's accounts.
export type LiveAccountWait={account:string;reason:'active-session'|'autopilot-assignment'|'fleet-order'|'reserved';attemptId:string|null;pid:number|null};
type MemoryCapacity=Parameters<typeof admissionDecision>[0];
type LiveMemoryWait={account:string;reason:'memory';capacity:MemoryCapacity};
type LiveWait=LiveAccountWait|LiveMemoryWait;
const ordinaryDeferrable=(task:Pick<CoordTask,'kind'|'sessionRecovery'|'repairs'|'launch'>)=>task.kind==='run'&&!task.sessionRecovery&&!task.repairs?.length&&(!task.launch||task.launch==='ordinary');
export function validLiveMemoryWait(wait:any,accounts:readonly string[]):boolean{
 const v=wait?.capacity,reserve=startReserve({host:false,job:{script:'',enabled:true,orchestrate:accounts.length>1}},accounts.length);
 return wait?.reason==='memory'&&accounts.length>0&&wait.account?.toLowerCase()===accounts[0]!.toLowerCase()&&!!v
  &&['running','external','starting','startingReserve','pending','maxBots'].every(k=>Number.isSafeInteger(v[k])&&v[k]>=0)
  &&['freeGB','minFreeGB'].every(k=>typeof v[k]==='number'&&Number.isFinite(v[k])&&v[k]>=0)
  &&v.starting===accounts.length&&v.startingReserve===reserve&&admissionDecision(v).reason==='memory';
}
type DispatchCapacity={at:number;running:number|null;externalRunning:number|null;pendingStartup:number|null;pendingReserveGB?:number|null;freeGB:number|null;minFreeGB:number|null;maxBots:number|null};
export function ordinaryRunWaitsForMemory(task:CoordTask,state:CoordinatorState,capacity:DispatchCapacity|null,freeGB:number,base=projectRoot):boolean{
 if(!ordinaryDeferrable(task))return false;
 if(!capacity||[capacity.at,capacity.running,capacity.externalRunning,capacity.pendingStartup,capacity.freeGB,capacity.minFreeGB,capacity.maxBots,freeGB].some(v=>v===null||!Number.isFinite(v)||v<0))return true;
 if(capacity.pendingReserveGB!=null&&(!Number.isFinite(capacity.pendingReserveGB)||capacity.pendingReserveGB<0))return true;
 const names=boundAccounts(task,state);if(!names?.length)return true;
 let jobs:any[]=[],runs:any[]=[];
 try{jobs=readCoordinatorJobs(base).jobs;const saved=JSON.parse(readFileSync(join(base,'.practice/swarm-runs.json'),'utf8'));if(Array.isArray(saved))runs=saved;}catch{/* unseen children retain their reservation */}
 let slots=0,reserve=0;
 for(const record of state.tasks.filter(r=>r.status==='running'&&r.spec.kind==='run'&&!r.spec.sessionRecovery)){
  const accounts=boundAccounts(record.spec,state);if(!accounts?.length)return true;
  const job=jobs.find(j=>j.coordinatorOwner==='coordinator'&&j.coordinatorTask===record.spec.id&&j.env?.COORDINATOR_RUN_ID===record.runId);
  // The snapshot already counts a registered run. Children not yet represented still need their startup heap.
  const counted=job&&runs.some(r=>Number.isFinite(r.started)&&r.started<=capacity.at&&r.revision===missionSignature(job)
   &&Array.isArray(r.accounts)&&r.accounts.length===accounts.length&&accounts.every(n=>r.accounts.some((a:string)=>a.toLowerCase()===n.toLowerCase())));
  if(!counted){slots+=accounts.length;reserve+=startReserve({host:false,job:{script:'',enabled:true,orchestrate:accounts.length>1}},accounts.length);}
 }
 return !admissionDecision({running:capacity.running!+slots,external:capacity.externalRunning!,pending:(capacity.pendingReserveGB??capacity.pendingStartup!)+reserve,
  starting:names.length,startingReserve:startReserve({host:false,job:{script:'',enabled:true,orchestrate:names.length>1}},names.length),
  freeGB:Math.min(freeGB,capacity.freeGB!),minFreeGB:capacity.minFreeGB!,maxBots:capacity.maxBots!}).allowed;
}
type OrderClaimAuthority={readHeld?:(base:string,accounts:readonly string[])=>ReturnType<typeof readHeldFleetTradeClaims>;now?:()=>number};
type OrderClaimCache={authority:string;resolved:Set<string>;retryAt:Map<string,number>};
const orderClaimCaches=new Map<string,OrderClaimCache>();
// A published trade nonce only moves held -> released; only swarm claims have an inherited-hold restore path.
// Cache that exact negative proof, never an account-wide absence. Held or unknown claims are checked again later.
function fleetOrderClaimsHeld(base:string,orders:readonly Order[],receipts:readonly Receipt[],accounts:readonly string[],now:number,readHeld:NonNullable<OrderClaimAuthority['readHeld']>){
 const root=resolve(base),wanted=new Set(accounts.map(n=>n.toLowerCase()));
 type Binding={key:string;account:string;orderId:string;role:string};
 const bindings=new Map<string,Binding|null>();
 for(const order of orders)if(now>=order.end)for(const receipt of receipts){
  if(!receipt||typeof receipt!=='object'||receipt.id!==order.id||receipt.version!==2||!['prepared','reconcile'].includes(receipt.state))continue;
  const role=receipt.role,other=role==='from'?'to':'from',same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
  const coherent=(role==='from'||role==='to')&&same(receipt.account,order[role])&&same(receipt.partner,order[other])&&same(receipt.server,order.server)
   &&same(receipt.item,order.item)&&receipt.requested===order.count&&receipt.ok===false&&Number.isSafeInteger(receipt.count)&&receipt.count>=0&&receipt.count<=order.count
   &&Number.isSafeInteger(receipt.at)&&receipt.at>=order.start&&receipt.at<=now&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt.claim);
  if(!coherent){bindings.set(receipt.claim,null);continue;}
  const key=JSON.stringify([receipt.account.toLowerCase(),order.server.toLowerCase(),receipt.claim]),prior=bindings.get(receipt.claim);
  if(bindings.has(receipt.claim)&&(!prior||prior.key!==key||prior.orderId!==order.id||prior.role!==role))bindings.set(receipt.claim,null);
  else bindings.set(receipt.claim,{key,account:order[role],orderId:order.id,role});
 }
 const candidates=[...bindings.values()].filter((v):v is Binding=>v!==null),keys=new Set(candidates.map(v=>v.key));
 let cache=orderClaimCaches.get(root);
 if(cache)for(const key of new Set([...cache.resolved,...cache.retryAt.keys()]))if(wanted.has(JSON.parse(key)[0])&&!keys.has(key)){cache.resolved.delete(key);cache.retryAt.delete(key);}
 if(!candidates.length)return()=>true;
 let authority:string;
 try{
  const dotGit=join(root,'.git'),gitDir=statSync(dotGit).isDirectory()?dotGit:resolve(root,readFileSync(dotGit,'utf8').match(/^gitdir:\s*(.+)\s*$/)![1]!.trim());
  const common=existsSync(join(gitDir,'commondir'))?resolve(gitDir,readFileSync(join(gitDir,'commondir'),'utf8').trim()):gitDir;
  authority=createHash('sha256').update(common+'\0'+readFileSync(join(common,'config'),'utf8')+'\0'+(existsSync(join(gitDir,'config.worktree'))?readFileSync(join(gitDir,'config.worktree'),'utf8'):'')).digest('hex');
 }catch{orderClaimCaches.delete(root);return()=>true;}
 if(!cache||cache.authority!==authority){cache={authority,resolved:new Set(),retryAt:new Map()};orderClaimCaches.set(root,cache);}
 const due=candidates.filter(v=>!cache!.resolved.has(v.key)&&now>=(cache!.retryAt.get(v.key)??0));
 if(due.length){
  for(const v of due)cache.retryAt.set(v.key,now+60000);
  try{
   const held=new Set(readHeld(base,[...new Set(due.map(v=>v.account))]).map(c=>c.nonce));
   for(const v of due)if(!held.has(JSON.parse(v.key)[2])){cache.resolved.add(v.key);cache.retryAt.delete(v.key);}
  }catch{/* Authority failure supplies no release proof. */}
 }
 return(nonce:string)=>{const v=bindings.get(nonce);return !v||!cache!.resolved.has(v.key);};
}
// An owner's reservation row is disabled and names no script. It holds the account for its role. It is read from the
// owner's plan, because a coordinator job for the same account shadows the row in the merged plan. A finished hand job
// names its script, so only a reservation matches. The task waits as it does for an owner's order, and no run installs over it.
const reservedByOwner=(account:string,base:string):boolean=>{
 try{return(JSON.parse(readFileSync(ownerPlanPath(base),'utf8')).jobs as any[]).some(j=>j?.coordinatorOwner===undefined&&j.enabled===false&&(typeof j.script!=='string'||!j.script.trim())&&jobAccounts(j).some(n=>n.toLowerCase()===account.toLowerCase()));}catch{return false;}
};
export function liveAccountWait(task:Pick<CoordTask,'kind'|'sessionRecovery'|'repairs'|'launch'>,accounts:readonly string[],base=projectRoot,alive=pidAlive,authority:OrderClaimAuthority={}):LiveAccountWait|null{
 if(!ordinaryDeferrable(task))return null;
 const root=join(base,'.practice/session-lifecycle');
 let ordered:Set<string>|undefined;
 for(const account of accounts){
  const proof=readLogoutProof(account,LIVE_SERVER,{root});
  const receipt=(proof.state==='held'||proof.state==='confirmed')?listAttempts(account,LIVE_SERVER,{root}).find(a=>a.attemptId===proof.attemptId)?.receipt:null;
  // A status row is no proof of a live owner. The current producer and its live process own this wait.
  if(proof.state==='held'&&receipt&&Number.isSafeInteger(receipt.owner.pid)&&receipt.owner.pid>0&&receipt.owner.script
   &&!receipt.events.some(e=>['ended','connect-failed','logout','closed'].includes(e.kind))&&alive(receipt.owner.pid))
   return{account,reason:'active-session',attemptId:receipt.attemptId,pid:receipt.owner.pid};
  if(!ordered){
   const synced=join(base,'.practice/fleet-data/fleet'),fleet=base===projectRoot?FLEET_DIR():existsSync(join(synced,'owners.json'))?synced:join(base,'fleet');
   const rows=(folder:string)=>{const dir=join(fleet,folder);return existsSync(dir)?readdirSync(dir).filter(f=>f.endsWith('.json')).flatMap(file=>{try{return[JSON.parse(readFileSync(join(dir,file),'utf8'))];}catch{return[];}}):[];};
   const names=new Set(accounts.map(n=>n.toLowerCase()));
   const orders=rows('orders').filter(validOrder).filter(o=>o.server.toLowerCase()===LIVE_SERVER&&(names.has(o.from.toLowerCase())||names.has(o.to.toLowerCase())));
   // The order intent precedes login claims. Reuse the autopilot's settlement rules, including unresolved receipts.
   const receipts=rows('receipts'),now=authority.now?.()??Date.now();
   const claimHeld=fleetOrderClaimsHeld(base,orders,receipts,accounts,now,authority.readHeld??readHeldFleetTradeClaims);
   ordered=inOpenOrder(orders,receipts,now,()=>true,claimHeld);
  }
  if(ordered.has(account.toLowerCase()))return{account,reason:'fleet-order',attemptId:null,pid:null};
  let job:any;try{job=readMergedPlan(base).jobs.find((j:any)=>jobAccounts(j).some(n=>n.toLowerCase()===account.toLowerCase()));}catch{continue;}
  if(job?.standing===true&&job.enabled===true&&typeof job.autopilot==='string'&&job.autopilot&&!settledAutopilotJob(job,account,base))
   return{account,reason:'autopilot-assignment',attemptId:receipt?.attemptId??null,pid:receipt?.owner.pid??null};
  if(reservedByOwner(account,base))return{account,reason:'reserved',attemptId:null,pid:null};
 }
 return null;
}
const deferredLiveAccount=(wait:LiveWait)=>({ok:false,evidence:'live-deferred',installed:false,liveDeferred:wait});
class LiveAccountWaitError extends Error{
 constructor(readonly wait:LiveWait){super(wait.reason==='memory'?'live admission waiting: memory':'live account ownership deferred: '+wait.account+' '+wait.reason);}
}
export function releaseCompletedOwnJobs(own:CoordinatorJobs,accounts:readonly string[],base=projectRoot):CoordinatorJobs{
 const wanted=new Set(accounts.map(n=>n.toLowerCase()));
 let running:Set<string>|null|undefined;
 const swarmRuns=()=>running===undefined?running=swarmRunAccounts(base):running;
 const completed=(job:any,names:string[])=>{
  const runId=job.env?.COORDINATOR_RUN_ID;
  if(job.coordinatorOwner!=='coordinator'||job.enabled!==false||typeof job.coordinatorTask!=='string'||typeof runId!=='string'||!/^[-a-z0-9]+$/.test(runId))return false;
  let receipt:any;try{receipt=JSON.parse(readFileSync(join(base,'.practice/coordinator/runs',runId,'receipt.json'),'utf8'));}catch{return false;}
  if(typeof receipt?.ok!=='boolean'||receipt.runId!==runId||receipt.taskId!==job.coordinatorTask)return false;
  const active=swarmRuns();if(!active||names.some(n=>active.has(n.toLowerCase())))return false;
  const root=join(base,'.practice/session-lifecycle');
  return names.every(n=>readLogoutProof(n,LIVE_SERVER,{root}).state==='confirmed');
 };
 const jobs=own.jobs.flatMap(job=>{
  const names=jobAccounts(job),remaining=names.filter(n=>!wanted.has(n.toLowerCase()));
  if(remaining.length===names.length||!completed(job,names))return[job];
  if(!remaining.length)return[];
  if(job.host)return[{...job,accounts:remaining,enabled:false}];
  return parkedCoordinatorAccounts(job,remaining);
 });
 return{...own,jobs};
}
// A recovery parks the owner's job of each account that it holds: a copy in the coordinator's file, turned off, with no
// run and no task (prepareLiveRecovery). The install of the recovery replaces the copy. A recovery that ends before its
// install leaves the copy, and the owner's job for the account then stays out of the merged plan. Remove such a copy
// when no swarm run holds one of its accounts, each account has a confirmed logout, and no recovery child holds a lease
// on one of them (heldRecoveryOwners: a live child, or a permit that has not expired). The caller makes sure that no
// recovery task runs: a recovery that runs needs its parked jobs until its install.
export function releaseParkedOwnerJobs(own:CoordinatorJobs,base=projectRoot):CoordinatorJobs{
 const parked=(job:any)=>job?.coordinatorOwner!=='coordinator'&&job?.enabled===false;
 if(!own.jobs.some(parked))return own;
 const running=swarmRunAccounts(base);if(!running)return own;
 const leased=new Set(heldRecoveryOwners(base).map(r=>r.account.toLowerCase())),root=join(base,'.practice/session-lifecycle');
 const settled=(n:string)=>!running.has(n.toLowerCase())&&!leased.has(n.toLowerCase())&&readLogoutProof(n,LIVE_SERVER,{root}).state==='confirmed';
 const jobs=own.jobs.filter(job=>{if(!parked(job))return true;const names=jobAccounts(job);return!names.length||!names.every(settled);});
 return jobs.length===own.jobs.length?own:{...own,jobs};
}
// The same release for each account in the coordinator's file, written to the file. An install releases only the
// accounts of its own run, and it writes nothing when it then refuses. Without this pass a finished job keeps its
// account for ever: the owner's standing job for that account stays out of the merged plan, and a later run on the
// account is refused because that standing job is enabled.
// `recoveryIdle` says that no recovery task runs. Only then does the pass also remove the owner jobs that a recovery
// parked (releaseParkedOwnerJobs).
// Returns the accounts that no job in the coordinator's file holds now. A job that the rules keep is not changed.
export async function releaseFinishedOwnJobs(base=projectRoot,recoveryIdle=false):Promise<string[]>{return withPlanWrite(()=>{
 const own=readCoordinatorJobs(base),accounts=[...new Set(own.jobs.flatMap(jobAccounts))];
 const finished=releaseCompletedOwnJobs(own,accounts,base),next=recoveryIdle?releaseParkedOwnerJobs(finished,base):finished;
 if(next.jobs.length===own.jobs.length&&next.jobs.every((job,i)=>job===own.jobs[i]))return[];
 const held=new Set(next.jobs.flatMap(jobAccounts).map(n=>n.toLowerCase()));
 writeCoordinatorJobs(base,next);
 return accounts.filter(n=>!held.has(n.toLowerCase()));
},join(base,'.practice/coordinator'));}
type RetiredRecoveryCohort={accounts:string[];runId:string;taskId:string};
function retiredRecoveryCohort(task:CoordTask,account:string,base:string):RetiredRecoveryCohort|undefined{
 if(task.sessionRecovery?.account!==account||!task.repairs?.some(r=>r.account===account&&r.endedAt===task.sessionRecovery!.endedAt))return;
 const job=readCoordinatorJobs(base).jobs.find(j=>j.orchestrate&&jobAccounts(j).some(n=>n.toLowerCase()===account.toLowerCase()));
 if(!job)return;
 const accounts=jobAccounts(job),runId=job.env?.COORDINATOR_RUN_ID,taskId=job.coordinatorTask;
 const refuse=()=>{throw Error('authenticated recovery cohort is not retired and idle');};
 if(job.enabled!==false||job.coordinatorOwner!=='coordinator'||accounts.length<2||typeof runId!=='string'||!/^task-[-a-z0-9]+$/.test(runId)||typeof taskId!=='string')refuse();
 let receipt:any,runs:any;
 try{receipt=JSON.parse(readFileSync(join(base,'.practice/coordinator/runs',runId,'receipt.json'),'utf8'));runs=JSON.parse(readFileSync(join(base,'.practice/swarm-runs.json'),'utf8'));}catch{refuse();}
 if(typeof receipt?.ok!=='boolean'||receipt.runId!==runId||receipt.taskId!==taskId||!Array.isArray(runs)||runs.some((r:any)=>(r.accounts??[]).some((n:string)=>accounts.some(a=>a.toLowerCase()===n.toLowerCase()))))refuse();
 const end=loadEnded(join(base,'.practice/swarm-deaths.json')).get(account);
 if(!end||end.at!==task.sessionRecovery.endedAt||failedScript(end)!==scriptKey(job.script))refuse();
 const ownerFile=join(base,'.practice/coordinator/runs',runId,'owner.json');
 if(existsSync(ownerFile)){const owner=JSON.parse(readFileSync(ownerFile,'utf8'));if(!Number.isSafeInteger(owner.pid)||owner.pid<1||processMatches(owner.pid,runId))refuse();}
 for(const name of accounts){
  if(RESERVED_ACCOUNTS.includes(name.toLowerCase())||['stop-coordinator','stop-swarm','stop-'+name].some(f=>existsSync(join(base,'.practice',f))))refuse();
  assertNoRecoveryLease(name,base);
  if(liveRows(base).some(s=>s.name?.toLowerCase()===name.toLowerCase()&&s.server===LIVE_SERVER&&!s.result))refuse();
 }
 return{accounts,runId,taskId};
}
const liveTaskWindowMs=(task:CoordTask)=>task.timeoutMs??Math.min(MAX_SPECIALIST_RUN_MS,Math.max(900_000,(task.estimatedMs??0)*1.5));
// A controller stop belongs to the retired job. Owner pauses and global stops still hold every replacement.
function liveAccountStops(accounts:readonly string[],base=projectRoot):{account:string;file:string}[]{
 for(const flag of ['stop-coordinator','stop-swarm'])if(existsSync(join(base,'.practice',flag)))throw Error('live owner stopped: '+flag);
 return accounts.flatMap(account=>[...new Set([account,account.toLowerCase()])].flatMap(name=>{
  const file=join(base,'.practice','stop-'+name);let text:string;
  try{text=readFileSync(file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;}
  if(!swarmWroteStop(text))throw Error('account has a stop file; preserve its owner: '+account);
  return[{account,file}];
 }));
}
export function installJob(task:CoordTask,account:string,script:string,runId:string,source:string,dependencies:Record<string,any>,options:{base?:string;preflight?:boolean;recoveryPreflight?:boolean;freeGB?:number;recovered?:(account:string)=>boolean;launch?:string}={}){
 // `source` is the run's capability release; a recovery session binds to the launch release (default: the same value).
 const base=options.base??projectRoot,rows=liveRows(base),launch=options.launch??source;
 if(options.recoveryPreflight&&(!options.preflight||!task.sessionRecovery||task.account!==account||task.sessionRecovery.account!==account))throw Error('authenticated recovery can only preflight its exact account');
 const pendingRepair=(name:string,end:any)=>options.preflight&&task.repairs?.some(r=>r.account.toLowerCase()===name.toLowerCase()&&r.endedAt===end.at);
 const retained=options.recoveryPreflight?retiredRecoveryCohort(task,account,base):undefined;
 if(retained)recoveryQualification(task,dependencies,source,base);
 const accounts=retained?.accounts??task.participants?.map(n=>n.startsWith('@')?dependencies[n.slice(1)]?.account:n)??[account];
 if(accounts.some(n=>typeof n!=='string'||! /^[A-Za-z0-9_ -]{1,12}$/.test(n)))throw Error('participant binding unavailable');
 const wait=liveAccountWait(task,accounts,base);if(wait)throw new LiveAccountWaitError(wait);
 const settledStops=()=>{
  const stops=liveAccountStops(accounts,base);
  for(const name of new Set(stops.map(s=>s.account)))if(readLogoutProof(name,LIVE_SERVER,{root:join(base,'.practice/session-lifecycle')}).state!=='confirmed')throw Error('controller stop handoff needs confirmed producer logout: '+name);
  return stops;
 };
 settledStops();
 const path=ownerPlanPath(base),raw=readFileSync(path,'utf8'),ownRaw=existsSync(join(base,COORDINATOR_JOBS_FILE))?readFileSync(join(base,COORDINATOR_JOBS_FILE),'utf8'):null;
 // Release first: the merged-plan split check and the overlay replacement below both read this result.
 const own=releaseCompletedOwnJobs(readCoordinatorJobs(base),accounts,base),plan=mergedPlan(JSON.parse(raw),own),now=Date.now();
 const existing=plan.jobs.find((j:any)=>(j.accounts??[j.account]).some((n:string)=>n?.toLowerCase()===account.toLowerCase()));
 const holds=loadHolds(join(base,'.practice/swarm-script-holds.json'));
 const sameScriptRepairPreflight=(name:string,end:any)=>!task.sessionRecovery&&end&&!/^died\b/.test(end.reason)&&failedScript(end)===scriptKey(script)&&pendingRepair(name,end);
 const settledOwnerJob=(job:any,name:string,end:any)=>job?.coordinatorOwner!=='coordinator'&&job?.enabled===false&&(!end||!persistentEnd(end.reason)||sameScriptRepairPreflight(name,end))&&readLogoutProof(name,LIVE_SERVER,{root:join(base,'.practice/session-lifecycle')}).state==='confirmed';
 for(const participant of accounts){
  if(!(options.recoveryPreflight&&(retained||participant===task.sessionRecovery?.account))){
   const prior=liveLogoutRef(participant,base);
   if(task.launch==='specialist'&&prior)throw Error('specialist launch evidence requires an unused clock');
  }
  if(openHold(holds,participant,script))throw Error('failed script still held for '+participant+': '+script);
 }
 const isOrdinaryRun=task.kind==='run'&&!task.sessionRecovery&&(!task.launch||task.launch==='ordinary');
 for(const participant of accounts.filter(n=>n.toLowerCase()!==account.toLowerCase())){
  // This is a read-only ownership preflight, not an authorization to log peers in.
  if(retained)continue;
  const occupied=plan.jobs.find((j:any)=>(j.accounts??[j.account]).some((n:string)=>n?.toLowerCase()===participant.toLowerCase()));
  const ended=[...loadEnded(join(base,'.practice/swarm-deaths.json'))].find(([n])=>n.toLowerCase()===participant.toLowerCase())?.[1];
  if(Object.hasOwn(SPECIALIST_BOARDS,participant.toLowerCase())||occupied&&(!occupied.script||/fresh.clock|24 boards|main simultaneous/i.test(occupied.goal??'')))throw Error('participant has a protected reservation: '+participant);
  const participantAutopilotSettled=isOrdinaryRun&&settledAutopilotJob(occupied,participant,base);
  if(occupied&&occupied.coordinatorOwner!=='coordinator'&&!settledOwnerJob(occupied,participant,ended)&&!participantAutopilotSettled&&!rows.some(s=>s.name?.toLowerCase()===participant.toLowerCase()&&/^ok(?:\s|$)/.test(s.result??'')))throw Error('participant assignment is not confirmed complete: '+participant);
  if(ended&&persistentEnd(ended.reason)&&!pendingRepair(participant,ended)&&!(participantAutopilotSettled&&/^blocked(?: after \d+ runs)?$/.test(ended.reason)))throw Error('participant needs verified recovery');
  if(rows.some(s=>s.name?.toLowerCase()===participant.toLowerCase()&&s.server==='rs-sdk-demo.fly.dev'&&!s.result))throw Error('participant session not settled');
 }
 const board=Object.hasOwn(SPECIALIST_BOARDS,account.toLowerCase())?SPECIALIST_BOARDS[account.toLowerCase()]:undefined;
 const reserved=board||existing&&(!existing.script||/fresh.clock|24 boards|main simultaneous/i.test(existing.goal??''));
 if(reserved){
  if(!board&&task.launch==='main'&&task.goal==='main24'){
   const launch=evaluateLaunch(base,'research/hiscores-live.json',now,true);
   if(!launch.go)throw Error('main launch evidence is not ready');if(!options.preflight)atomicJson(join(base,'.practice/haggis-go.json'),launch);
  }else if(task.launch!=='specialist'||task.goal!=='specialists'||!board)throw Error('reserved clock needs its scored launch and staging evidence');
 }
 const unfinished=rows.find(s=>s.name?.toLowerCase()===account.toLowerCase()&&s.server==='rs-sdk-demo.fly.dev'&&!s.result);
 if(unfinished&&!options.recoveryPreflight&&!recoveredSessionForRun(account,LIVE_SERVER,runId,launch,base))throw Error('account session ownership is not settled');
 const end=[...loadEnded(join(base,'.practice/swarm-deaths.json'))].find(([n])=>n.toLowerCase()===account.toLowerCase())?.[1];
 const autopilotSettled=isOrdinaryRun&&settledAutopilotJob(existing,account,base);
 if(end&&persistentEnd(end.reason)&&!pendingRepair(account,end)&&!(autopilotSettled&&/^blocked(?: after \d+ runs)?$/.test(end.reason)))throw Error('account recovery needs a verified repair: '+end.reason);
 // The recovery preflight of its own account parks the hand job next (prepareLiveRecovery turns it off), and the
 // account's last session ended without a result or with a failure: that is what the recovery repairs. The production
 // install after the recovery applies both checks against the parked job and the recovered status.
 const handJob=!!existing&&!reserved&&existing.coordinatorOwner!=='coordinator';
 const parkedForRecovery=!!options.recoveryPreflight&&task.sessionRecovery?.account===account&&handJob;
 // After the recovery, the parked hand job is released by this run's confirmed recovery logout: a recovery login writes
 // no ok result, so the status cannot show one.
 const recovered=options.recovered??((name:string)=>recoveredSessionForRun(name,LIVE_SERVER,runId,launch,base));
 const releasedByRecovery=!options.recoveryPreflight&&task.sessionRecovery?.account===account&&handJob&&existing.enabled===false&&recovered(account);
 // A disabled hand job whose account has no persistent end and a confirmed producer logout is settled: the owner
 // stopped the work and no session holds the account, so a new mission installs without an ok result or a recovery.
 const settled=handJob&&settledOwnerJob(existing,account,end);
 if(existing?.standing===true&&existing.enabled&&!parkedForRecovery&&!autopilotSettled)throw Error('account runs an owner standing job: '+existing.script);
 if(handJob&&!parkedForRecovery&&!releasedByRecovery&&!settled&&!autopilotSettled){
  const observed=rows.find(s=>s.name?.toLowerCase()===account.toLowerCase()&&/^ok(?:\s|$)/.test(s.result??''));
  if(!observed)throw Error('existing assignment is not confirmed complete');
 }
 const goal=`${task.id} [${runId}]`,job={...(accounts.length>1?{accounts,orchestrate:true}:{account}),args:task.args??[],maxRestarts:0,script,role:task.role??existing?.role??'helper',goal,enabled:true,repeat:false,coordinatorOwner:'coordinator',coordinatorTask:task.id,
  env:{...task.env,CAP:task.env?.CAP??'1600',COORDINATOR_RUN_ID:runId,...(task.launch==='main'?{HAGGIS_RUN:'1'}:{})}};
 const capacity={running:activeExternalLive(rows,[],now).length,external:0,starting:accounts.length,startingReserve:startReserve({host:false,job},accounts.length),pending:0,freeGB:options.freeGB??freemem()/2**30,minFreeGB:plan.minFreeGB,maxBots:plan.maxBots};
 const decision=admissionDecision(capacity);
 if(decision.reason==='memory'&&ordinaryDeferrable(task))throw new LiveAccountWaitError({account,reason:'memory',capacity});
 if(!decision.allowed)throw Error('live admission waiting: '+decision.reason);
 const revision=missionSignature(job);
 let specialist;
 if(task.launch==='specialist'){
  try{
   if(!board||accounts.length!==1||task.accept?.skills?.[board.name]!==99)throw Error('need a reserved single-account board and level 99 target');
   const owners=base===projectRoot?loadOwners():loadOwners(join(base,'fleet/owners.json'));
   const holders=[...owners].filter(([name,owner])=>name!==account.toLowerCase()&&name!=='haggis'&&!Object.hasOwn(SPECIALIST_BOARDS,name)&&owner.server===LIVE_SERVER).map(([name])=>name);
   const first=evaluateSpecialist(base,account,runId,source,missionSignature({...job,env:{...job.env,COORDINATOR_RUN_ID:''}}),holders,now);
   const runUntil=now+Math.floor(liveTaskWindowMs(task));
   if(!Number.isSafeInteger(runUntil)||runUntil<=now||runUntil>now+MAX_SPECIALIST_RUN_MS)throw Error('invalid specialist run window');
   specialist={...first,expiresAt:Math.min(first.expiresAt,runUntil),runUntil,mission:createHash('sha256').update(revision).digest('hex')};
  }catch(error){throw Error('specialist launch evidence: '+String(error));}
 }
 // The merged view checks the split (a composed owner job keeps all its participants); only the coordinator's own
 // file is written. swarm.json stays the owner's: the controller merges both files (packages/core/src/coordinator-jobs.ts).
 const before=plan.jobs;replaceAssignments(plan.jobs,accounts,job);
 if(options.preflight)return{goal,source,account,installedAt:now,revision};
 if(specialist)atomicJson(join(base,specialistTokenPath(account)),specialist);
 atomicJson(join(base,'.practice/coordinator','runs',runId,'assignments-before.json'),before);
 own.jobs=replaceAssignments(own.jobs,accounts,job);
 if(readFileSync(path,'utf8')!==raw||(existsSync(join(base,COORDINATOR_JOBS_FILE))?readFileSync(join(base,COORDINATOR_JOBS_FILE),'utf8'):null)!==ownRaw)throw Error('assignment plan changed; reconcile before writing');
 const stops=settledStops();
 // Publish the replacement before clearing its controller stop, so the retired job cannot restart in between.
 writeCoordinatorJobs(base,own);
 for(const {file} of stops)clearSwarmStop(file);
 return{goal,source,account,installedAt:now};
}
/** Unregistered specialists stay offline until launch, so a pre-login 404 snapshot is their repair proof. */
export function repairLogoutProof(account:string,endedAt:number,base=projectRoot,now=Date.now()){
 const key=account.toLowerCase();
 if(Object.hasOwn(SPECIALIST_BOARDS,key)&&readLogoutProof(account,LIVE_SERVER,{root:join(base,'.practice/session-lifecycle')}).state==='none'
  &&!existsSync(join(base,'.practice/status',account+'.json'))&&!existsSync(join(base,'.practice/status',key+'.json'))){
  const snapshotPath=join(base,'.practice/specialist-launch/hiscores.json');
  if(!existsSync(snapshotPath))throw Error('unregistered specialist repair needs a fresh 404 hiscores snapshot: '+account);
  const bytes=readFileSync(snapshotPath),snap=JSON.parse(bytes.toString('utf8'));
  const takenAt=Date.parse(snap?.takenAt);
  if(snap?.base!=='https://rs-sdk-demo.fly.dev'||snap?.tickMs!==400||!Number.isFinite(takenAt)||takenAt>now||now-takenAt>=3_600_000)
   throw Error('unregistered specialist repair snapshot is stale or invalid: '+account);
  const profiles=Array.isArray(snap.profiles)?snap.profiles.filter((p:any)=>p?.name===key):[];
  const profile=profiles[0];
  if(profiles.length!==1||profile?.status!==404||!Number.isFinite(profile.at)||profile.at<endedAt||profile.at>now||now-profile.at>=3_600_000)
   throw Error('unregistered specialist repair needs a post-failure 404 profile: '+account);
  return {kind:'unregistered-specialist' as const,account:key,snapshotPath,snapshotSha256:createHash('sha256').update(bytes).digest('hex'),profileAt:profile.at};
 }
 return liveLogoutRef(account,base,true)!;
}
/** Check admission while the failure still holds, then park its old assignment before the controller can clear it. */
export function prepareLiveRecovery(task:CoordTask,account:string,script:string,runId:string,source:string,dependencies:Record<string,any>,base=projectRoot,launch=source,admission:{freeGB?:number}={}){
 const retained=retiredRecoveryCohort(task,account,base);
 const participants=retained?.accounts??task.participants?.map(n=>n.startsWith('@')?dependencies[n.slice(1)]?.account:n)??[account];
 for(const repair of task.repairs??[]){
  if(!participants.some(n=>n?.toLowerCase()===repair.account.toLowerCase()))throw Error('repair must name a participant');
  assertNoRecoveryLease(repair.account,base);
  if(!(task.sessionRecovery?.account===repair.account&&task.sessionRecovery.endedAt===repair.endedAt))repairLogoutProof(repair.account,repair.endedAt,base);
  if(!Object.values(dependencies).some((d:any)=>d?.delivery?.ok&&d.delivery.stage==='delivered'&&d.delivery.id===task.capability&&d.delivery.at>repair.endedAt&&d.delivery.runtimeRevision===source))throw Error('recovery requires a fresh post-failure same-capability native delivery');
  const end=[...loadEnded(join(base,'.practice/swarm-deaths.json'))].find(([n])=>n.toLowerCase()===repair.account.toLowerCase())?.[1];
  if(!end||end.at!==repair.endedAt)throw Error('exact failure unavailable before recovery');
  if(/^died\b/.test(end.reason)&&failedScript(end)===scriptKey(script))throw Error('same-script recovery needs explicit script qualification before clearing the failure');
 }
 if(task.sessionRecovery)recoveryQualification(task,dependencies,source,base);
 installJob(task,account,script,runId,source,dependencies,{base,preflight:true,recoveryPreflight:!!task.sessionRecovery,launch,freeGB:admission.freeGB});
 const path=ownerPlanPath(base),raw=readFileSync(path,'utf8'),ownFile=join(base,COORDINATOR_JOBS_FILE),ownRaw=existsSync(ownFile)?readFileSync(ownFile,'utf8'):null;
 const own=releaseCompletedOwnJobs(readCoordinatorJobs(base),participants,base),plan=mergedPlan(JSON.parse(raw),own),names=new Set(participants.map(n=>n.toLowerCase()));
 const before=structuredClone(plan.jobs);
 // Park the held accounts: a disabled copy of their job goes into the coordinator's file, where it shadows the owner
 // job's accounts in the merged view. An owner job with other accounts keeps those.
 const split=(job:any)=>{
  const all=jobAccounts(job),held=all.filter(n=>names.has(n.toLowerCase())),remaining=all.filter(n=>!names.has(n.toLowerCase()));
  if(held.length&&remaining.length&&job.orchestrate)throw Error('a composed assignment needs all its participants');
  return{held,remaining};
 };
 const ownParked=own.jobs.flatMap((job:any)=>{
  const {held,remaining}=split(job);
  if(!held.length)return[job];
  if(!remaining.length)return[{...job,enabled:false}];
  return[{...job,accounts:remaining},{...job,accounts:held,enabled:false}];
 });
 const ownerParked=shadowAssignments(JSON.parse(raw).jobs??[],own.jobs.flatMap(jobAccounts)).flatMap((job:any)=>{
  const {held,remaining}=split(job);
  if(!held.length)return[];
  return[remaining.length?{...job,accounts:held,enabled:false}:{...job,enabled:false}];
 });
 own.jobs=[...ownParked,...ownerParked];
 atomicJson(join(base,'.practice/coordinator/runs',runId,'recovery-before.json'),{at:Date.now(),repairs:task.repairs,ended:JSON.parse(readFileSync(join(base,'.practice/swarm-deaths.json'),'utf8')),assignments:before});
 if(readFileSync(path,'utf8')!==raw||(existsSync(ownFile)?readFileSync(ownFile,'utf8'):null)!==ownRaw)throw Error('assignment plan changed before recovery');
 writeCoordinatorJobs(base,own);
 return retained;
}
export function recoveryQualification(task:CoordTask,dependencies:Record<string,any>,source:string,base=projectRoot):ControlledRecoveryRequest['qualification']{
 const endedAt=task.sessionRecovery?.endedAt??0,now=Date.now();
 const candidate=Object.values(dependencies).filter((d:any)=>d?.delivery?.ok&&d.delivery.stage==='delivered'&&d.delivery.id===task.capability&&d.delivery.runtimeRevision===source
  &&Number.isFinite(d.delivery.at)&&d.delivery.at>endedAt&&d.delivery.at<=now)
  .sort((a:any,b:any)=>b.delivery.at-a.delivery.at)[0];
 const reportPath=candidate?.delivery?.directory&&join(candidate.delivery.directory,'report.json');
 if(!reportPath)throw Error('authenticated recovery requires its current native delivery');
 const bytes=readFileSync(reportPath),report=JSON.parse(bytes.toString('utf8'));
 if(!report.ok||report.stage!=='delivered'||report.id!==task.capability||report.source!==candidate.delivery.source||report.runtimeRevision!==source)throw Error('authenticated recovery delivery binding changed');
 const gate=report.checks?.find((c:any)=>c.id==='native-session-recovery'&&c.phase==='practice'&&c.exitCode===0&&!c.timedOut);
 if(!gate)throw Error('authenticated recovery native gate missing');
 const markers=readFileSync(JSON.parse(gate.detail).stdout,'utf8').split(/\r?\n/).filter(l=>l.startsWith('RECOVERY_NATIVE_PROOF '));
 if(markers.length!==1)throw Error('authenticated recovery native artifact missing');
 const proof=JSON.parse(markers[0]!.slice('RECOVERY_NATIVE_PROOF '.length));
 if(typeof proof.path!=='string'||! /^[a-f0-9]{64}$/.test(proof.sha256??''))throw Error('authenticated recovery native artifact malformed');
 return{delivery:{path:reportPath,sha256:createHash('sha256').update(bytes).digest('hex')},proof};
}
// `source` is the capability release its delivery proved; the request binds to the controller's launch release.
async function acquireRecoverySlot(lease:string,owner:{pid:number;runId:string;nonce:string},account:string,base:string,limit:number){
 while(true){
  if(['stop-coordinator','stop-swarm','stop-'+account].some(f=>existsSync(join(base,'.practice',f))))throw Error('recovery owner stopped');
  try{writeFileSync(lease,JSON.stringify(owner),{flag:'wx'});return;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  if(Date.now()>=limit)throw Error('recovery repair slot timed out; existing owner preserved');
  await Bun.sleep(Math.min(100,Math.max(1,limit-Date.now())));
 }
}
// A full fleet is a wait for a recovery, not a refusal. The caller holds the repair lease, and while the lease exists
// the controller keeps the next free bot slot for the recovery (scripts/swarm.ts recoverySlot), so the wait ends when
// one bot ends. The controller's own bot count (swarm-state.json, written each tick) is read first: it has a bot
// that started and wrote no status yet, which the status rows of the preflight do not show, and the controller
// refuses a request at a full fleet with no retry. A memory refusal, and each other refusal, ends the wait at once.
async function awaitBotSlot(preflight:()=>Promise<unknown>,account:string,base:string,limit:number){
 const controllerFull=()=>{
  try{const s=JSON.parse(readFileSync(join(base,'.practice/swarm-state.json'),'utf8'));return Date.now()-s.at<10000&&s.running+s.externalRunning+1>s.maxBots;}
  catch{return false;}
 };
 while(true){
  if(['stop-coordinator','stop-swarm','stop-'+account].some(f=>existsSync(join(base,'.practice',f))))throw Error('recovery owner stopped');
  if(!controllerFull())try{await preflight();return;}catch(error){if(String(error)!=='Error: live admission waiting: maxBots')throw error;}
  if(Date.now()>=limit)throw Error('live admission waiting: maxBots');
  await Bun.sleep(Math.min(500,Math.max(1,limit-Date.now())));
 }
}
// `slotWaitMs` bounds the wait for a bot slot. `timeoutMs` bounds the controller's part, from the request to its
// result. The wait for the lease covers both parts of the request that holds it.
export async function requestAuthenticatedRecovery(task:CoordTask,dependencies:Record<string,any>,source:string,runId:string,base=projectRoot,timeoutMs=180000,launch=source,beforeRequest?:()=>Promise<unknown>,slotWaitMs=RECOVERY_SLOT_WAIT_MS){
 const authorization=task.sessionRecovery;if(!authorization)throw Error('authenticated recovery task flag missing');
 const request:ControlledRecoveryRequest={schema:RECOVERY_SCHEMA,kind:'session-recovery',...authorization,server:LIVE_SERVER,runId,nonce:randomUUID(),source:launch,
  qualification:recoveryQualification(task,dependencies,source,base)};
 const file=join(base,'.practice/swarm-repair.json'),lease=file+'.lease';
 const raw=JSON.stringify(request);
 await acquireRecoverySlot(lease,{pid:process.pid,runId,nonce:request.nonce},request.account,base,Date.now()+timeoutMs+(beforeRequest?slotWaitMs:0));
 try{
  if(beforeRequest)await awaitBotSlot(beforeRequest,request.account,base,Date.now()+slotWaitMs);
  const limit=Date.now()+timeoutMs;
  if(existsSync(file+'.processing'))throw Error('another exact recovery owns the repair slot');
  writeFileSync(file,raw,{flag:'wx'});
  while(Date.now()<limit){
   if(existsSync(join(base,'.practice/stop-coordinator'))||existsSync(join(base,'.practice/stop-swarm'))||existsSync(join(base,'.practice/stop-'+request.account)))throw Error('authenticated recovery owner stopped');
   const end=[...loadEnded(join(base,'.practice/swarm-deaths.json'))].find(([a])=>a.toLowerCase()===request.account.toLowerCase())?.[1];
   if(end?.at!==request.endedAt)throw Error('authenticated recovery exact failure changed');
   if(existsSync(file+'.results.jsonl'))for(const line of readFileSync(file+'.results.jsonl','utf8').trim().split('\n').slice(-100)){
    let result:any,owned:any;try{result=JSON.parse(line);owned=JSON.parse(result.raw);}catch{continue;}
    if(owned.nonce!==request.nonce||owned.runId!==runId)continue;
    if(result.result?.sessionRecovered!==true)throw Error('controller held authenticated recovery: '+(result.result?.reason??'unknown'));
    liveLogoutRef(request.account,base,true);return;
   }
   await Bun.sleep(Math.min(500,Math.max(1,limit-Date.now())));
  }
  throw Error('authenticated recovery acknowledgement timed out; inspect owned child before any retry');
 }catch(error){
  if(existsSync(file)&&readFileSync(file,'utf8')===raw)try{renameSync(file,join(base,'.practice/coordinator/runs',runId,'authenticated-recovery-cancelled-'+request.nonce+'.json'));}catch(e){if((e as any).code!=='ENOENT')throw e;}
  throw error;
 }finally{if(existsSync(lease)&&JSON.parse(readFileSync(lease,'utf8')).nonce===request.nonce)unlinkSync(lease);}
}
export async function requestLiveRecovery(repair:{account:string;endedAt:number},runId:string,base=projectRoot,timeoutMs=15000){
 const proof=repairLogoutProof(repair.account,repair.endedAt,base);
 const file=join(base,'.practice/swarm-repair.json'),request={...repair,server:LIVE_SERVER,proof,runId,nonce:randomUUID()};
 const lease=file+'.lease';
 const limit=Date.now()+timeoutMs;
 await acquireRecoverySlot(lease,{pid:process.pid,runId,nonce:request.nonce},repair.account,base,limit);
 try{
  request.proof=repairLogoutProof(repair.account,repair.endedAt,base);
  if(existsSync(file+'.processing'))throw Error('another exact recovery owns the repair slot');
  writeFileSync(file,JSON.stringify(request),{flag:'wx'});
  while(Date.now()<limit){
   const end=[...loadEnded(join(base,'.practice/swarm-deaths.json'))].find(([n])=>n.toLowerCase()===repair.account.toLowerCase())?.[1];
   if(!end)return;
   if(end.at!==repair.endedAt)throw Error('failure changed during recovery');
   const results=file+'.results.jsonl';
   if(existsSync(results))for(const line of readFileSync(results,'utf8').trim().split('\n').slice(-100)){
    let row:any,owned:any;try{row=JSON.parse(line);owned=JSON.parse(row.raw);}catch{continue;}
    if(owned.nonce===request.nonce&&owned.runId===runId&&row.result?.changed===false)throw Error('controller refused exact recovery: '+row.result.reason);
   }
   await Bun.sleep(Math.min(500,Math.max(1,limit-Date.now())));
  }
  throw Error('exact recovery acknowledgement timed out; old assignment remains disabled');
 }catch(error){
  // Claim only our unconsumed request. Never remove the controller's .processing file or write its end state.
  if(existsSync(file)&&readFileSync(file,'utf8')===JSON.stringify(request))try{renameSync(file,join(base,'.practice/coordinator/runs',runId,'recovery-cancelled-'+request.nonce+'.json'));}catch(e){if((e as any).code!=='ENOENT')throw e;}
  throw error;
 }finally{
  if(existsSync(lease)&&JSON.parse(readFileSync(lease,'utf8')).nonce===request.nonce)unlinkSync(lease);
 }
}
/** Completed work stays recorded. Only its authenticated cleanup may admit a different mission. */
export function preserveCompletedLiveEnd(task:CoordTask,repair:{account:string;endedAt:number},script:string,runId:string,source:string,dependencies:Record<string,any>,base=projectRoot,launch=source):boolean{
 const end=[...loadEnded(join(base,'.practice/swarm-deaths.json'))].find(([name])=>name.toLowerCase()===repair.account.toLowerCase())?.[1];
 if(!end||end.at!==repair.endedAt)throw Error('end record changed after session cleanup');
 if(!/^done(?: after \d+ runs)?$/.test(end.reason))return false;
 if(task.account!==repair.account||task.sessionRecovery?.account!==repair.account||task.sessionRecovery.endedAt!==repair.endedAt
  ||!task.repairs?.some(r=>r.account===repair.account&&r.endedAt===repair.endedAt))throw Error('completed end needs exact authenticated cleanup authorization');
 const installed=installJob(task,repair.account,script,runId,source,dependencies,{base,preflight:true,launch});
 if(typeof end.revision!=='string'||!end.revision||end.revision===installed.revision)throw Error('completed work needs a different mission');
 const proof=liveLogoutRef(repair.account,base,true);
 if(proof?.kind!=='producer'||!recoveredSessionForRun(repair.account,LIVE_SERVER,runId,launch,base))throw Error('completed end needs current run producer cleanup');
 return true;
}
export async function disableOwnJob(runId:string,base=projectRoot){return withPlanWrite(()=>{
 const own=readCoordinatorJobs(base);let changed=false;
 for(const job of own.jobs)if(job.coordinatorOwner==='coordinator'&&job.env?.COORDINATOR_RUN_ID===runId&&job.enabled!==false){job.enabled=false;changed=true;}
 if(changed)writeCoordinatorJobs(base,own);
},join(base,'.practice/coordinator'));}
export async function awaitRecoveryInstallPreflight(task:CoordTask,account:string,script:string,runId:string,source:string,dependencies:Record<string,any>,retained:RetiredRecoveryCohort|undefined,base=projectRoot,launch=source,timeoutMs=180000,admission:{freeGB?:number}={}){
 const limit=Date.now()+timeoutMs;
 while(true){
  if(['stop-coordinator','stop-swarm',...(retained?.accounts??[account]).map(n=>'stop-'+n)].some(f=>existsSync(join(base,'.practice',f))))throw Error('recovery owner stopped');
  try{return await withPlanWrite(()=>installJob(task,account,script,runId,source,dependencies,{base,preflight:true,launch,freeGB:admission.freeGB}),join(base,'.practice/coordinator'));}
  catch(error){
   if(!retained||String(error)!=='Error: a composed assignment needs all its participants; do not split its ownership')throw error;
   const job=readCoordinatorJobs(base).jobs.find(j=>j.coordinatorTask===retained.taskId&&j.env?.COORDINATOR_RUN_ID===retained.runId);
   if(!job||job.enabled!==false||!job.orchestrate||JSON.stringify(jobAccounts(job))!==JSON.stringify(retained.accounts))throw Error('retired recovery cohort owner changed');
   if(Date.now()>=limit)throw Error('retired recovery cohort still lacks confirmed logout; assignment preserved');
   await Bun.sleep(Math.min(100,Math.max(1,limit-Date.now())));
  }
 }
}
export async function runLiveTask(task:CoordTask,dependencies:Record<string,any>,definition:{entry:string},runId:string,startedAt:number){
 const accounts=task.participants?.map(n=>n.startsWith('@')?dependencies[n.slice(1)]?.account:n);
 const account=accounts?.[0]??accountFor(task,dependencies),target=accounts?.[task.acceptIndex??0]??account;
 const waiting=()=>liveAccountWait(task,accounts??[account]);
 const beforeSource=waiting();if(beforeSource)return deferredLiveAccount(beforeSource);
 // Three releases (docs/script-contract.md, Release scope): `capability` is what the entry's delivery recorded,
 // `source` is what the swarm pins on this job's worker (entry and the code files its arguments name), `launch` is the
 // controller's and its recovery runner's.
 const capability=cachedReleaseFor([definition.entry]),source=cachedReleaseFor(workerEntries(definition.entry,task.args??[])),launch=cachedLaunchRevision();
 liveAccountStops(accounts??[account]);
 const beforeController=waiting();if(beforeController)return deferredLiveAccount(beforeController);
 await ensureSwarm(launch);
 if(task.repairs?.length){
  if(task.sessionRecovery){
   let retained:RetiredRecoveryCohort|undefined;
   await requestAuthenticatedRecovery(task,dependencies,capability,runId,projectRoot,180000,launch,()=>withPlanWrite(()=>{
    retained=prepareLiveRecovery(task,account,definition.entry,runId,capability,dependencies,projectRoot,launch);
   }));
   // Check the indexed cleanup and every ordinary install condition before consuming the old end.
   await awaitRecoveryInstallPreflight(task,account,definition.entry,runId,source,dependencies,retained,projectRoot,launch);
  }else await withPlanWrite(()=>prepareLiveRecovery(task,account,definition.entry,runId,capability,dependencies,projectRoot,launch));
  for(const repair of task.repairs)if(!preserveCompletedLiveEnd(task,repair,definition.entry,runId,source,dependencies,projectRoot,launch))await requestLiveRecovery(repair,runId);
 }
 const installed=await withPlanWrite(()=>{
  const wait=waiting();if(wait)return deferredLiveAccount(wait);
  try{return installJob(task,account,definition.entry,runId,source,dependencies,{launch});}
  catch(error){if(error instanceof LiveAccountWaitError)return deferredLiveAccount(error.wait);throw error;}
 });
 if('liveDeferred' in installed)return installed;
 const deadline=(task.launch==='specialist'?installed.installedAt:Date.now())+Math.floor(liveTaskWindowMs(task));
 try{
  while(Date.now()<deadline){
   if(existsSync(join(projectRoot,'.practice/stop-coordinator')))throw Error('coordinator stopped');
   const end=loadEnded(join(projectRoot,'.practice/swarm-deaths.json')).get(target);
   const file=join(projectRoot,'.practice/status',target+'.json');
   if(end&&end.at>=installed.installedAt&&!/^done(?:\s|$)/.test(end.reason)){
    let status:unknown;
    try{status=JSON.parse(readFileSync(file,'utf8'));}catch{/* A missing observation leaves the supervisor reason intact. */}
    throw Error(boundedWorkerEndMessage(end,status,{account:target,goal:installed.goal,source,startedAt:installed.installedAt,now:Date.now(),runId}));
   }
   if(existsSync(file)){
    const status=JSON.parse(readFileSync(file,'utf8'));
    if(status.coordinatorRunId===runId&&status.at>=installed.installedAt&&status.result){
     const ok=acceptStatus(task,status,{account:target,goal:installed.goal,source,startedAt:installed.installedAt,now:Date.now(),runId});
     const ends=loadEnded(join(projectRoot,'.practice/swarm-deaths.json'));
     if(!(accounts??[account]).every(n=>(ends.get(n)?.at??0)>=installed.installedAt)){await Bun.sleep(1000);continue;}
     return{ok,evidence:'live',account,source,status,startedAt,error:ok?undefined:'worker result did not meet the useful-effect contract'};
    }
   }
   await Bun.sleep(1000);
  }
  throw Error('live task deadline expired');
 }finally{await disableOwnJob(runId);}
}
