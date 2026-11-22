import {existsSync,mkdirSync,readFileSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {LIVE_SERVER} from '../../../../scripts/swarm';
import {boundedOwnerBinding,boundedProcessAlive} from '../../../core/src/bounded-owners';
import {jobAccounts,ownerPlanPath,readCoordinatorJobs,readMergedPlan,writeCoordinatorJobs} from '../../../core/src/coordinator-jobs';
import {processMatches,safeKill,safeKillOne} from '../../../core/src/proc';
import {BOOTSTRAP_STATUS_AGE_MS} from '../../../core/src/session-admission';
import {cachedLaunchRevision} from '../../../core/src/worker-release';
import {atomicJson,projectRoot,spawnDetached,withPlanWrite} from '../coordinator-store';
import {hashImportClosure} from '../delivery-cli';
import {controllerStateFresh,liveRows,swarmProcesses} from './status';

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
