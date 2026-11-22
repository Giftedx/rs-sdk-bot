import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {LIVE_SERVER} from '../../../../scripts/swarm';
import {jobAccounts,parkedCoordinatorAccounts,readCoordinatorJobs,writeCoordinatorJobs,type CoordinatorJobs} from '../../../core/src/coordinator-jobs';
import {readLogoutProof} from '../../../core/src/session-lifecycle';
import {heldRecoveryOwners} from '../../../core/src/session-recovery-permit';
import {projectRoot,withPlanWrite} from '../coordinator-store';
import {swarmRunAccounts} from './status';

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

export async function disableOwnJob(runId:string,base=projectRoot){return withPlanWrite(()=>{
 const own=readCoordinatorJobs(base);let changed=false;
 for(const job of own.jobs)if(job.coordinatorOwner==='coordinator'&&job.env?.COORDINATOR_RUN_ID===runId&&job.enabled!==false){job.enabled=false;changed=true;}
 if(changed)writeCoordinatorJobs(base,own);
},join(base,'.practice/coordinator'));}
