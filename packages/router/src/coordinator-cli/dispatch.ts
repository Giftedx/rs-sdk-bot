import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {cpus,freemem} from 'node:os';
import {join} from 'node:path';
import {ownerPlanPath,readCoordinatorJobs,writeCoordinatorJobs} from '../../../core/src/coordinator-jobs';
import {observePracticeTurn} from '../../../practice/src/proof-lock';
import {buildFailureEvidence} from '../build-fault';
import {prepareWorkspace,sharedWorkspacePlan} from '../build-workspace';
import {boundAccounts,fleetExpansion,preparedProvisionClaims,startTask,usefulLiveReceipt,type CoordTask,type CoordinatorState} from '../coordinator';
import {liveRows} from '../coordinator-live';
import {planWork} from '../coordinator-planner';
import {atomicJson,coordinationDir,event,projectRoot,runDirectory,saveState,spawnDetached,withPlanWrite} from '../coordinator-store';
import {executeTask} from '../coordinator-worker';
import {deliveryTask,NATIVE_STARTUP_GB} from '../delivery-cli';
import {assignedWorker} from '../model-worker';
import {COORDINATOR_CLI_PATH,readJson} from './holds';
import {plannerState,readPlan} from './state';

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

export async function expandUsefulFleet(state:CoordinatorState,config:any,runHeld:(task:CoordTask)=>boolean){
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
 await withPlanWrite(()=>{const current=readPlan();if(current.maxBots!==plan.maxBots)return;const own=readCoordinatorJobs(projectRoot);own.expansion={maxBots:target,over:readJson(ownerPlanPath(projectRoot)).maxBots};own.coordination.lastExpansionAt=now;writeCoordinatorJobs(projectRoot,own);config.maxLive=target;config.lastExpansionAt=now;event('fleet-capacity-expanded',{from:plan.maxBots,to:target,freeGB:freemem()/2**30,cpu:usage,tickMs:Math.max(...latencies),usefulResults:useful});});
}

export function nativeDispatchReady(state:Pick<CoordinatorState,'tasks'>,freeGB:number,
 observe:()=>Pick<ReturnType<typeof observePracticeTurn>,'holder'|'liveWaiters'>=()=>observePracticeTurn(join(projectRoot,'.practice/delivery-native.lock'))){
 if(!(freeGB>=NATIVE_STARTUP_GB)||state.tasks.some(r=>r.status==='running'&&r.spec.kind==='qualify'))return false;
 const {holder,liveWaiters}=observe();
 return holder!=='pid-present'&&(liveWaiters??0)===0;
}

export function spawnCoordinatorChild(mode:string,id:string,directory:string,cwd=projectRoot){
 return spawnDetached([process.execPath,join(cwd,COORDINATOR_CLI_PATH),mode,id],cwd,join(directory,'stdout.log'),join(directory,'stderr.log'),cwd===projectRoot?process.env:{...process.env,COORDINATOR_MAIN_ROOT:projectRoot,SWARM_PLAN:sharedWorkspacePlan(projectRoot,cwd,process.env.SWARM_PLAN),CLOUD_WATCH_ID:''});
}

export function launchTask(state:CoordinatorState,id:string){
 const runId='task-'+randomUUID(),record=startTask(state,id,Date.now(),runId),dir=runDirectory(runId);
 record.agent=assignedWorker(record.spec.kind,state.tasks.filter(r=>r!==record),record.spec.agent);
 const dependencies=Object.fromEntries(state.tasks.filter(r=>r.status==='succeeded'||r.receipt&&r.spec.capability===record.spec.capability).map(r=>[r.spec.id,{...r.receipt?.output,_task:{capability:r.spec.capability,status:r.status,at:r.receipt?.at,runId:r.runId,error:r.receipt?.error,evidence:r.runId?join(coordinationDir,'runs',r.runId):undefined}}]));
 atomicJson(join(dir,'input.json'),{task:record.spec,dependencies,runId,startedAt:record.startedAt,agent:record.agent});saveState(state);
 // A build runs from its own source workspace, so live workers keep the main checkout (build-workspace.ts).
 const workspace=record.spec.kind==='build'&&record.spec.capability?prepareWorkspace(projectRoot,record.spec.capability,deliveryTask(record.spec.capability).files).root:projectRoot;
 record.pid=spawnCoordinatorChild('--worker',runId,dir,workspace);saveState(state);event('task-started',{id,runId,pid:record.pid,agent:record.agent,...(workspace!==projectRoot?{workspace}:{})});
}

export async function child(mode:string,runId:string){
 const dir=runDirectory(runId);atomicJson(join(dir,'owner.json'),{pid:process.pid,runId,at:Date.now()});
 try{
  const input=readJson(join(dir,'input.json'));
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
  else{const input=readJson(join(dir,'input.json'));atomicJson(join(dir,'receipt.json'),{taskId:input.task.id,runId,ok:false,at:Date.now(),output:existsSync(join(dir,'identity.json'))?readJson(join(dir,'identity.json')):null,error:String(error)});}
  process.exitCode=1;
 }
}
