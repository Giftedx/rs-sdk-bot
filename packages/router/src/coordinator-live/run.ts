import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {loadEnded} from '../../../../scripts/swarm';
import {cachedLaunchRevision,cachedReleaseFor,workerEntries} from '../../../core/src/worker-release';
import {acceptStatus,boundedWorkerEndMessage,type CoordTask} from '../coordinator';
import {projectRoot,withPlanWrite} from '../coordinator-store';
import {installJob} from './install';
import {awaitRecoveryInstallPreflight,prepareLiveRecovery,preserveCompletedLiveEnd,requestAuthenticatedRecovery,requestLiveRecovery} from './recovery';
import type {RetiredRecoveryCohort} from './recovery-evidence';
import {disableOwnJob} from './release';
import {ensureSwarm} from './rollout';
import {accountFor,deferredLiveAccount,liveAccountStops,LiveAccountWaitError,liveTaskWindowMs} from './status';
import {liveAccountWait} from './wait';

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
