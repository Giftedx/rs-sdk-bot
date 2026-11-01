import {existsSync,readFileSync,writeFileSync,appendFileSync,unlinkSync,watch,mkdirSync,readdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {freemem,cpus} from 'node:os';
import {addTasks,chooseTask,startTask,finishTask,refreshQualifications,qualificationDemand,boundAccounts,fleetExpansion,activeBuildFocus,failedBuildStreak,compactState,FOCUS_FAILURE_LIMIT,type CoordinatorState} from './coordinator';
import {projectRoot,coordinationDir,loadState,saveState,runDirectory,atomicJson,atomicText,event,spawnDetached,recoverPlanWrite,withPlanWrite} from './coordinator-store';
import {planWork,acceptProposal} from './coordinator-planner';
import {executeTask} from './coordinator-worker';
import {deliveryTask,deliveryFingerprint,SOURCE_STARTUP_GB,NATIVE_STARTUP_GB} from './delivery-cli';
import {disableOwnJob,ensureSwarm,liveRows} from './coordinator-live';
import {cachedLaunchRevision} from '../../core/src/worker-release';
import {readCoordinatorJobs,writeCoordinatorJobs,readMergedPlan,COORDINATOR_JOBS_FILE} from '../../core/src/coordinator-jobs';
import {assignedWorker} from './model-worker';
import {processMatches,killTree} from '../../practice/src/proc';
import {prepareWorkspace} from './build-workspace';
import {applyRules,skillUnlocks} from './coordinator-rules';
import {processDeliveryPrs} from './delivery-pr';

const cli='packages/router/src/coordinator-cli.ts';
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
// Coordinator-owned jobs and settings written into swarm.json by an earlier coordinator move to the coordinator's
// file; the owner's jobs keep their order. Returns what moved, or null when swarm.json holds none.
export function migrateCoordinatorJobs(base=projectRoot){
 const path=join(base,'swarm.json'),raw=readFileSync(path,'utf8'),plan=JSON.parse(raw);
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
const IDLE_PLAN_MS=30*60*1000;
const sourceErrors=new Map<string,string>();
const cpuTotals=()=>cpus().reduce((s,c)=>({idle:s.idle+c.times.idle,total:s.total+Object.values(c.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
let previousCpu=cpuTotals();
const tickSamples=new Map<string,{started:number;tick:number;at:number;latency:number|null}>();
async function expandUsefulFleet(state:CoordinatorState,config:any){
 if(!config.autoExpand)return;
 const now=Date.now(),cpu=cpuTotals(),delta=cpu.total-previousCpu.total,usage=delta>0?1-(cpu.idle-previousCpu.idle)/delta:null;previousCpu=cpu;
 const records=new Map(state.tasks.map(r=>[r.spec.id,r]));
 const running=state.tasks.filter(r=>r.status==='running'&&r.spec.kind==='run');
 const ready=state.tasks.filter(r=>r.status==='pending'&&r.spec.kind==='run'&&r.spec.dependsOn.every(id=>records.get(id)?.status==='succeeded'));
 const preparedClaims=state.tasks.filter(r=>r.status==='pending'&&r.spec.kind==='provision'&&r.spec.dependsOn.every(id=>records.get(id)?.status==='succeeded')&&state.tasks.some(child=>child.status==='pending'&&child.spec.kind==='run'&&(child.spec.accountFrom===r.spec.id||child.spec.participants?.includes('@'+r.spec.id))));
 const demand=new Set([...running,...ready].flatMap(r=>boundAccounts(r.spec,state)??[]).map(n=>n.toLowerCase())).size+preparedClaims.length;
 const active=new Set(running.flatMap(r=>boundAccounts(r.spec,state)??[]).map(n=>n.toLowerCase()));
 const rows=new Map(liveRows().map(r=>[String(r.name).toLowerCase(),r]));let stalled=false;const latencies:number[]=[];
 for(const name of active){
  const row=rows.get(name);if(!row||row.server!=='rs-sdk-demo.fly.dev'||now-row.at>5000||!Number.isFinite(row.tick)){stalled=true;continue;}
  const old=tickSamples.get(name),same=old?.started===row.started;let latency=same?old!.latency:null;
  if(same&&row.at>old!.at)latency=row.tick>old!.tick?(row.at-old!.at)/(row.tick-old!.tick):null;
  tickSamples.set(name,{started:row.started,tick:row.tick,at:row.at,latency});if(latency===null)stalled=true;else latencies.push(latency);
 }
 const plan=readPlan(),last=plan.coordination?.lastExpansionAt??0;
 const useful=state.tasks.filter(r=>r.spec.kind==='run'&&r.status==='succeeded'&&r.receipt?.output?.evidence==='live'&&r.receipt.at>last&&now-r.receipt.at<900000).length;
 const target=fleetExpansion({limit:plan.maxBots,demand,freeGB:freemem()/2**30,reserveGB:plan.minFreeGB,cpu:usage,tickMs:latencies.length?Math.max(...latencies):null,stalled,usefulResults:useful,now,lastExpandedAt:last});
 if(target===plan.maxBots)return;
 // The grant lives in the coordinator's file over the owner's current maxBots; an owner edit of maxBots discards it.
 await withPlanWrite(()=>{const current=readPlan();if(current.maxBots!==plan.maxBots)return;const own=readCoordinatorJobs(projectRoot);own.expansion={maxBots:target,over:json(join(projectRoot,'swarm.json')).maxBots};own.coordination.lastExpansionAt=now;writeCoordinatorJobs(projectRoot,own);config.maxLive=target;config.lastExpansionAt=now;event('fleet-capacity-expanded',{from:plan.maxBots,to:target,freeGB:freemem()/2**30,cpu:usage,tickMs:Math.max(...latencies),usefulResults:useful});});
}
const existsPid=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
export function reconcile(state:CoordinatorState,alive:(pid:number,marker:string)=>boolean=processMatches,directory=coordinationDir,pidExists=existsPid){
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
   if(finishTask(state,json(receipt)))event('task-finished',{id:record.spec.id,status:record.status,runId:record.runId},directory);
   else finishTask(state,{taskId:record.spec.id,runId:record.runId!,ok:false,at:Date.now(),output:null,error:'mismatched receipt; original bytes retained'});
   continue;
  }
  const pid=existsSync(owner)?json(owner).pid:record.pid;
  // CIM can briefly return no command line under load. That is not evidence
  // that a process ended. Keep its ownership until OS liveness also fails.
  // Check OS liveness first: command-line lookup starts PowerShell on Windows.
  // The existing rule retains a live PID even when CIM cannot identify it.
  if(pid&&(pidExists(pid)||alive(pid,record.runId!)))continue;
  if(Date.now()-(record.startedAt??0)>15000)finishTask(state,{taskId:record.spec.id,runId:record.runId!,ok:false,at:Date.now(),output:null,error:'worker ended without a receipt; inspect preserved run before repair'});
 }
}
function spawn(mode:string,id:string,directory:string,cwd=projectRoot){
 return spawnDetached([process.execPath,cli,mode,id],cwd,join(directory,'stdout.log'),join(directory,'stderr.log'),cwd===projectRoot?process.env:{...process.env,COORDINATOR_MAIN_ROOT:projectRoot});
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
export function archiveFinishedTasks(state:CoordinatorState,now=Date.now(),directory=coordinationDir){
 const archived=compactState(state,now);
 if(!archived.length)return 0;
 const archive=join(directory,'archive');mkdirSync(archive,{recursive:true});
 appendFileSync(join(archive,'tasks.jsonl'),archived.map(r=>JSON.stringify(r)).join('\n')+'\n');
 return archived.length;
}
async function child(mode:string,runId:string){
 const dir=runDirectory(runId);atomicJson(join(dir,'owner.json'),{pid:process.pid,runId,at:Date.now()});
 try{
  const input=json(join(dir,'input.json'));
  if(mode==='--planner'){const proposal=await planWork(plannerState(input),dir,input.timeoutMs,input.agent??'claude');atomicJson(join(dir,'proposal.json'),proposal);}
  else{const output=await executeTask(input.task,input.dependencies,dir,runId,input.startedAt,input.agent??'claude');atomicJson(join(dir,'receipt.json'),{taskId:input.task.id,runId,agent:input.agent??'claude',ok:output.ok===true,at:Date.now(),output});}
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
let rulePass={at:0,receipts:-1};
let unlocks:((skill:string)=>number[])|undefined;
function runRules(state:CoordinatorState,liveLimit:number){
 const receipts=state.tasks.filter(r=>r.receipt).length,now=Date.now();
 if(receipts===rulePass.receipts&&now-rulePass.at<RULE_RECHECK_MS)return;
 rulePass={at:now,receipts};
 try{
  const added=applyRules(state,{fingerprint:cap=>deliveryFingerprint(deliveryTask(cap)),unlocks:unlocks??=skillUnlocks(projectRoot),maxOpen:liveLimit,
   paused:account=>existsSync(join(projectRoot,'.practice','stop-'+account)),
   level:(account,skill)=>{try{return json(join(projectRoot,'.practice/status',account+'.json')).skills?.find((v:any)=>v.name===skill)?.level;}catch{return undefined;}}},now);
  if(added.length){saveState(state);event('rule-tasks-added',{tasks:added.map(t=>({id:t.id,rule:t.rule,account:t.account,accept:t.accept}))});}
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
async function tick(state:CoordinatorState,config:any){
 recoverPlanWrite();
 openDeliveryPrs();
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
 const requests=join(coordinationDir,'requests');mkdirSync(requests,{recursive:true});
 for(const file of readdirSync(requests).filter(f=>f.endsWith('.request.json'))){
  const path=join(requests,file);
  try{acceptProposal(state,json(path));saveState(state);renameSync(path,path+'.accepted');event('queue-submitted',{file});}
  catch(error){renameSync(path,path+'.rejected');event('queue-submit-failed',{file,error:String(error)});}
 }
 // Reuse current evidence; refresh only capabilities with waiting live consumers.
 if(!state.tasks.some(r=>r.status==='running'&&r.spec.kind==='build')){
  const caps=[...new Set(qualificationDemand(state).map(r=>r.spec.capability!))];
  const fingerprints:Record<string,string>={};
  for(const cap of caps)try{fingerprints[cap]=deliveryFingerprint(deliveryTask(cap));sourceErrors.delete(cap);}
  catch(error){const detail=String(error);if(sourceErrors.get(cap)!==detail)event('qualification-source-unavailable',{cap,error:detail});sourceErrors.set(cap,detail);}
  refreshQualifications(state,fingerprints);
 }
 if(state.planner){
  const pending=state.planner,dir=runDirectory(pending.runId),proposal=join(dir,'proposal.json'),error=join(dir,'planner-error.json');
  if(existsSync(proposal)||existsSync(error)||(!existsPid(pending.pid!)&&!processMatches(pending.pid!,pending.runId))){
   try{if(!existsSync(proposal))throw Error(existsSync(error)?json(error).error:'planner ended without proposal');const count=acceptProposal(state,json(proposal));event('plan-accepted',{count,reason:state.lastPlanReason});}
   catch(e){state.lastPlanReason='planner failed: '+String(e);event('plan-failed',String(e));}
   state.lastPlanAt=Date.now();delete state.planner;saveState(state);
  }
 }
 // Model/native capacity is independent from finite live account jobs.
 if(config.focusCapability&&state.tasks.some(r=>r.spec.capability===config.focusCapability&&r.spec.kind==='run'&&r.status==='succeeded'&&r.receipt?.output?.evidence==='live'&&r.receipt.at>=(config.focusSince??0))){
  await withPlanWrite(()=>{clearFocus(config.focusCapability);delete config.focusCapability;delete config.focusSince;event('fleet-focus-delivered',{evidence:'live'});});
 }
 // A focus that failed FOCUS_FAILURE_LIMIT builds in a row releases the other lanes; activeBuildFocus does not re-adopt it.
 if(config.focusCapability&&failedBuildStreak(state,config.focusCapability)>=FOCUS_FAILURE_LIMIT){
  const released=config.focusCapability;
  await withPlanWrite(()=>{clearFocus(released);delete config.focusCapability;delete config.focusSince;event('fleet-focus-released',{capability:released,failedBuilds:failedBuildStreak(state,released)});});
 }
 await expandUsefulFleet(state,config);
 const developmentLimit=config.maxActive??2,liveLimit=config.maxLive??readPlan().maxBots;
 runRules(state,liveLimit);
 let controllerPrepared=false,liveBlocked=false;
 // Standing swarm jobs run without a coordinator task, so the controller must run whenever one is enabled.
 // Also while a rollout has standing jobs paused: they are off then, and only this call turns them on again.
 if((readPlan().jobs??[]).some((j:any)=>j.standing===true&&j.enabled)||existsSync(join(coordinationDir,'rollout-paused.json'))){
  try{await ensureSwarm(currentRevision(),{currentSource:()=>currentRevision()},false);sourceErrors.delete('controller');}
  catch(error){const detail=String(error);if(sourceErrors.get('controller')!==detail)event('live-controller-wait',{error:detail});sourceErrors.set('controller',detail);}
 }
 const owned=new Map<string,readonly string[]>(),ownedFiles=(cap:string)=>{if(!owned.has(cap))owned.set(cap,deliveryTask(cap).files);return owned.get(cap)!;};
 for(let dispatch=0;dispatch<developmentLimit+liveLimit;dispatch++){
  const freeGB=freemem()/2**30,request=join(coordinationDir,'publish-request.json');
  let publishing:string|undefined;try{publishing=existsSync(request)?json(request).capability:undefined;}catch{/* a request being written */}
  const task=chooseTask(state,Date.now(),{sourceReady:freeGB>=SOURCE_STARTUP_GB,nativeReady:freeGB>=NATIVE_STARTUP_GB,developmentLimit,liveLimit:liveBlocked?0:liveLimit,preferLive:config.preferLive===true,focusCapability:config.focusCapability,isolatedBuilds:true,publishPending:existsSync(request),publishing,ownedFiles});
  if(!task)break;
  // The single dispatcher prepares the controller before parallel live children
  // can race to create it. Controller startup does not log accounts in.
  if(task.kind==='run'&&!controllerPrepared){
   try{await ensureSwarm(currentRevision(),{currentSource:()=>currentRevision()});controllerPrepared=true;sourceErrors.delete('controller');}
   catch(error){const detail=String(error);if(sourceErrors.get('controller')!==detail)event('live-controller-wait',{error:detail});sourceErrors.set('controller',detail);liveBlocked=true;continue;}
  }
  launchTask(state,task.id);
 }
 const pending=state.tasks.some(r=>r.status==='pending'),failure=state.tasks.some(r=>r.status==='failed'&&(r.receipt?.at??0)>state.lastPlanAt);
 const newOutcome=state.tasks.some(r=>r.receipt&&r.receipt.at>state.lastPlanAt);
 const actionable=existsSync(planRequest)||newOutcome||failure;
 // Without a new receipt, failure or request the planner only rechecks every IDLE_PLAN_MS: 1,491 of 1,603
 // plans on a 30 s timer proposed no work (research/bot-host.md "Isolated build workspaces").
 if(!state.planner&&(actionable||state.lastPlanReason.startsWith('planner failed:')||Date.now()-state.lastPlanAt>Math.max(config.plannerIntervalMs??0,IDLE_PLAN_MS))&&Date.now()-state.lastPlanAt>(actionable?1000:30000)){
  if(existsSync(planRequest))unlinkSync(planRequest);
  const agent=state.tasks.some(r=>r.status==='running'&&r.agent==='codex'&&r.spec.kind==='build')?'claude':'codex';
  const runId='plan-'+randomUUID(),dir=runDirectory(runId);atomicJson(join(dir,'input.json'),{statePath:join(coordinationDir,'state.json'),agent,timeoutMs:config.modelTimeoutMs??600000});
  state.planner={runId,agent,startedAt:Date.now()};saveState(state);state.planner.pid=spawn('--planner',runId,dir);event('planner-started',{runId,pid:state.planner.pid,agent});
 }
 const archived=archiveFinishedTasks(state);if(archived)event('tasks-archived',{count:archived,remaining:state.tasks.length});
 saveState(state);
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
async function main(){
 const mode=process.argv[2]??'--status',arg=process.argv[3];
 if(mode==='--worker'||mode==='--planner'){if(!arg)throw Error('run identity required');await child(mode,arg);return;}
 const state=loadState();
 if(mode==='--status'){console.log(JSON.stringify(state,null,2));return;}
 if(mode==='--submit'){
  if(!arg)throw Error('proposal file required');const request=json(arg),requests=join(coordinationDir,'requests');mkdirSync(requests,{recursive:true});
  atomicJson(join(requests,randomUUID()+'.request.json'),request);console.log('Submitted to shared queue');return;
 }
 if(mode==='--plan'){writeFileSync(planRequest,'refresh priorities from observed state');console.log('Planning requested');return;}
 if(mode==='--restart'){writeFileSync(restart,'reload coordinator; preserve owned children');console.log('Coordinator reload requested');return;}
 if(mode==='--stop'){writeFileSync(stop,'owner pause '+new Date().toISOString());console.log('Coordinator stop requested');return;}
 if(mode!=='--run'&&mode!=='--once')throw Error('Use --run, --once, --status or --stop');
 const config=readPlan().coordination;if(!config?.enabled)throw Error('swarm.json coordination.enabled required');
 const lease=join(coordinationDir,'owner.json');
 if(existsSync(lease)){
  const owner=json(lease),held=()=>owner.pid!==process.pid&&(processMatches(owner.pid,owner.nonce)||existsPid(owner.pid));
  // A reload successor starts while its predecessor finishes the current loop.
  for(let waited=0;held()&&arg?.startsWith('reload-')&&waited<60000;waited+=1000)await Bun.sleep(1000);
  if(held())throw Error('coordinator already owned by PID '+owner.pid);
 }
 const nonce=arg??randomUUID();atomicJson(lease,{pid:process.pid,nonce,at:Date.now()});
 if(existsSync(stop)||existsSync(join(projectRoot,'.practice/stop-swarm')))throw Error('coordinator or swarm is paused; resume only under owner authority');
 if(!state.tasks.length){addTasks(state,config.bootstrap??[]);saveState(state);}
 event('coordinator-started',{pid:process.pid,nonce});
 {const moved=await withPlanWrite(()=>migrateCoordinatorJobs());if(moved)event('coordinator-jobs-moved',moved);}
 do{
  try{await tick(state,config);}catch(error){event('loop-error',String(error));await Bun.sleep(7000);}
  if(mode==='--once')break;await waitForWork();
 }while(!existsSync(stop)&&!existsSync(restart)&&!existsSync(join(projectRoot,'.practice/stop-swarm')));
 if(existsSync(restart)){
  unlinkSync(restart);
  // The successor loads the current code at once instead of waiting up to five minutes for the watchdog.
  const token='reload-'+randomUUID(),stamp=Date.now();
  const pid=spawnDetached([process.execPath,'packages/router/src/coordinator-cli.ts','--run',token],projectRoot,join(coordinationDir,`daemon-${stamp}.out.log`),join(coordinationDir,`daemon-${stamp}.err.log`));
  event('coordinator-reload',{children:'preserved for adoption',successor:pid});return;
 }
 if(existsSync(stop)||existsSync(join(projectRoot,'.practice/stop-swarm'))){
  for(const job of readCoordinatorJobs(projectRoot).jobs.filter((j:any)=>j.coordinatorOwner==='coordinator'&&j.enabled!==false)){
   await disableOwnJob(job.env?.COORDINATOR_RUN_ID);
   for(const account of job.accounts??[job.account])if(account){const file=join(projectRoot,'.practice','stop-'+account);if(!existsSync(file))writeFileSync(file,'coordinator owner pause');}
  }
  for(const r of state.tasks.filter(r=>r.status==='running'))if(r.pid&&processMatches(r.pid,r.runId!))await killTree(r.pid);
  if(state.planner?.pid&&processMatches(state.planner.pid,state.planner.runId))await killTree(state.planner.pid);
  event('coordinator-paused',{reason:'owner stop file'});
 }
}
if(import.meta.main)await main().catch(e=>{console.error(String(e));process.exitCode=1;});
