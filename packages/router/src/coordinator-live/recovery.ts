import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {failedScript,LIVE_SERVER,loadEnded,RECOVERY_SLOT_WAIT_MS,scriptKey} from '../../../../scripts/swarm';
import {COORDINATOR_JOBS_FILE,jobAccounts,mergedPlan,ownerPlanPath,readCoordinatorJobs,shadowAssignments,writeCoordinatorJobs} from '../../../core/src/coordinator-jobs';
import {assertNoRecoveryLease,RECOVERY_SCHEMA,recoveredSessionForRun,type ControlledRecoveryRequest} from '../../../core/src/session-recovery-permit';
import type {CoordTask} from '../coordinator';
import {liveLogoutRef} from '../coordinator-session';
import {atomicJson,projectRoot,withPlanWrite} from '../coordinator-store';
import {installJob} from './install';
import {recoveryQualification,repairLogoutProof,retiredRecoveryCohort,type RetiredRecoveryCohort} from './recovery-evidence';
import {releaseCompletedOwnJobs} from './release';

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
