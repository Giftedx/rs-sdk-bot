import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {freemem} from 'node:os';
import {join} from 'node:path';
import {activeExternalLive,admissionDecision,clearSwarmStop,failedScript,LIVE_SERVER,loadEnded,loadHolds,missionSignature,openHold,persistentEnd,scriptKey,startReserve} from '../../../../scripts/swarm';
import {COORDINATOR_JOBS_FILE,mergedPlan,ownerPlanPath,readCoordinatorJobs,writeCoordinatorJobs} from '../../../core/src/coordinator-jobs';
import {loadOwners} from '../../../core/src/fleet';
import {readLogoutProof} from '../../../core/src/session-lifecycle';
import {recoveredSessionForRun} from '../../../core/src/session-recovery-permit';
import {evaluateSpecialist,MAX_SPECIALIST_RUN_MS,SPECIALIST_BOARDS,specialistTokenPath} from '../../../core/src/specialist-launch';
import type {CoordTask} from '../coordinator';
import {liveLogoutRef} from '../coordinator-session';
import {atomicJson,projectRoot} from '../coordinator-store';
import {evaluateLaunch} from '../../../../scripts/haggis-gate';
import {recoveryQualification,retiredRecoveryCohort} from './recovery-evidence';
import {releaseCompletedOwnJobs,replaceAssignments} from './release';
import {liveAccountStops,LiveAccountWaitError,liveRows,liveTaskWindowMs,ordinaryDeferrable} from './status';
import {liveAccountWait,settledAutopilotJob} from './wait';

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
