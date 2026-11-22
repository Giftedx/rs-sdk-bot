import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {failedScript,LIVE_SERVER,loadEnded,scriptKey} from '../../../../scripts/swarm';
import {jobAccounts,readCoordinatorJobs} from '../../../core/src/coordinator-jobs';
import {processMatches} from '../../../core/src/proc';
import {readLogoutProof} from '../../../core/src/session-lifecycle';
import {assertNoRecoveryLease,type ControlledRecoveryRequest} from '../../../core/src/session-recovery-permit';
import {RESERVED_ACCOUNTS} from '../../../core/src/specialist-boards';
import {SPECIALIST_BOARDS} from '../../../core/src/specialist-launch';
import type {CoordTask} from '../coordinator';
import {liveLogoutRef} from '../coordinator-session';
import {projectRoot} from '../coordinator-store';
import {liveRows} from './status';

export type RetiredRecoveryCohort={accounts:string[];runId:string;taskId:string};
export function retiredRecoveryCohort(task:CoordTask,account:string,base:string):RetiredRecoveryCohort|undefined{
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
