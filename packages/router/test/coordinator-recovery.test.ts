import {test,expect,beforeEach,afterEach,spyOn} from 'bun:test';
import * as os from 'node:os';
// Recovery fixtures model an admitted host. Admission limits have their own explicit memory cases.
let memory:{mockRestore():void}|undefined;
beforeEach(()=>{memory=spyOn(os,'freemem').mockReturnValue(8*2**30);});
afterEach(()=>{memory?.mockRestore();});
import {mkdtempSync,readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync,renameSync,unlinkSync} from 'node:fs';
import {applyEndRepair,loadEnded,persistEnded} from '../../../scripts/swarm';
import {beginSessionAttempt,readLogoutProof,verifyLegacyLogout} from '../../core/src/session-lifecycle';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialState,addTasks,startTask,chooseTask,validateTask} from '../src/coordinator';
import {atomicJson,saveState,loadState,runDirectory} from '../src/coordinator-store';
import {readMergedPlan,coordinatorJobsPath,writeCoordinatorJobs,emptyCoordinatorJobs} from '../../core/src/coordinator-jobs';
const jobOf=(base:string,account:string)=>readMergedPlan(base).jobs.find((j:any)=>(j.accounts??[j.account]).includes(account));
import {claimCoordinatorState,pauseCoordinator,reconcile} from '../src/coordinator-cli';
import {acceptProposal,parseModelObject} from '../src/coordinator-planner';
import {replaceAssignments,prepareLiveRecovery,requestLiveRecovery,requestAuthenticatedRecovery,recoveryQualification,installJob,awaitControllerDrain,ensureSwarm,preserveCompletedLiveEnd} from '../src/coordinator-live';
import type {CoordTask} from '../src/coordinator';
const seed=()=>{const s=initialState();addTasks(s,[{id:'producer',goal:'skills',kind:'qualify',capability:'wine-order',dependsOn:[],priority:2,estimatedMs:1,why:'native producer'},{id:'consumer',goal:'gear',kind:'qualify',capability:'ammo-order',dependsOn:['producer'],priority:2,estimatedMs:1,why:'next useful consumer'}]);startTask(s,'producer',Date.now()-20000,'recovery-run');return s;};
test('owner pause persists a receipt written during worker shutdown',async()=>{
 const base=mkdtempSync(join(tmpdir(),'coord-pause-')),practice=join(base,'.practice'),dir=join(practice,'coordinator');
 const state=initialState(),runId='blood-pause',taskId='run-blood';
 addTasks(state,[
  {id:taskId,goal:'main24',kind:'run',capability:'blood-chest-order',account:'Miner',accept:{bank:{565:1018}},dependsOn:[],priority:1,estimatedMs:1000,why:'bank runes'},
  {id:'next-batch',goal:'main24',kind:'run',capability:'blood-chest-order',account:'Miner',accept:{bank:{565:1618}},dependsOn:[taskId],priority:1,estimatedMs:1000,why:'next batch'},
  {id:'starting',goal:'skills',kind:'qualify',capability:'wine-order',dependsOn:[],priority:1,estimatedMs:1000,why:'not spawned yet'},
 ]);
 startTask(state,taskId,Date.now(),runId).pid=process.pid;
 startTask(state,'starting',Date.now(),'starting-run');
 const runDir=runDirectory(runId,dir);
 saveState(state,dir);
 const own=emptyCoordinatorJobs();
 own.jobs.push({account:'Miner',script:'scripts/blood-chest.ts',enabled:true,coordinatorOwner:'coordinator',env:{COORDINATOR_RUN_ID:runId}});
 writeCoordinatorJobs(base,own);
 const stopFile=join(practice,'stop-coordinator');
 writeFileSync(stopFile,'owner pause');
 const receipt={taskId,runId,ok:false,at:Date.now(),output:null,error:'Error: coordinator stopped'};
 const receiptFile=join(runDir,'receipt.json');
 const worker=(async()=>{
  const deadline=Date.now()+2000;
  while(!existsSync(join(practice,'stop-Miner'))&&Date.now()<deadline)await Bun.sleep(10);
  expect(JSON.parse(readFileSync(coordinatorJobsPath(base),'utf8')).jobs[0].enabled).toBe(false);
  expect(existsSync(join(practice,'stop-Miner'))).toBe(true);
  await Bun.sleep(50);
  atomicJson(receiptFile,receipt);
 })();
 const pause=pauseCoordinator(state,base,async(pid,marker)=>{
  expect(pid).toBe(process.pid);expect(marker).toBe(runId);
  expect(existsSync(receiptFile)).toBe(true);
  return true;
 });
 await Promise.all([worker,pause]);
 const saved=loadState(dir);
 expect(saved.tasks.map(row=>row.status)).toEqual(['failed','pending','failed']);
 expect(saved.tasks[0]!.receipt).toEqual(receipt);
 expect(saved.tasks[2]!.receipt?.error).toContain('worker ended without a receipt');
 expect(readFileSync(stopFile,'utf8')).toBe('owner pause');
 expect(chooseTask(saved,Date.now())).toBeNull();
});
test('owner pause reports a worker that could not be stopped without inventing a receipt',async()=>{
 const base=mkdtempSync(join(tmpdir(),'coord-pause-')),dir=join(base,'.practice','coordinator');
 const state=seed();
 state.tasks[0]!.pid=process.pid;
 mkdirSync(dir,{recursive:true});
 saveState(state,dir);
 await pauseCoordinator(state,base,async()=>false);
 expect(loadState(dir).tasks[0]).toMatchObject({status:'running',runId:'recovery-run'});
 expect(loadState(dir).tasks[0]!.receipt).toBeUndefined();
 expect(JSON.parse(readFileSync(join(dir,'events.jsonl'),'utf8')).detail.unsettledRuns).toEqual(['recovery-run']);
});
test('concurrent coordinator starts leave exactly one owner',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'coord-owner-'));
 const nonces=['start-a','start-b'];
 const starts=await Promise.allSettled(nonces.map(nonce=>claimCoordinatorState(nonce,dir,()=>true)));
 const winner=starts.findIndex(result=>result.status==='fulfilled');
 expect(starts.filter(result=>result.status==='fulfilled')).toHaveLength(1);
 expect(starts.find(result=>result.status==='rejected')?.reason.message).toMatch(/coordinator already owned/);
 expect(JSON.parse(readFileSync(join(dir,'owner.json'),'utf8')).nonce).toBe(nonces[winner]);
});
test('a reload reads state written while its predecessor still owns the queue',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'coord-reload-'));
 const state=initialState();
 saveState(state,dir);
 atomicJson(join(dir,'owner.json'),{pid:123,nonce:'old',at:1});
 let alive=true;
 const reload=claimCoordinatorState('reload-test',dir,()=>alive);
 addTasks(state,[{id:'late',goal:'skills',kind:'qualify',capability:'wine-order',dependsOn:[],priority:2,estimatedMs:1,why:'late predecessor write'}]);
 saveState(state,dir);
 alive=false;
 expect((await reload).tasks.map(task=>task.spec.id)).toEqual(['late']);
 expect(JSON.parse(readFileSync(join(dir,'owner.json'),'utf8')).nonce).toBe('reload-test');
});
function recoveryFixture(){
 const base=mkdtempSync(join(tmpdir(),'live-repair-')),run='test-run',prac=join(base,'.practice');
 mkdirSync(join(prac,'status'),{recursive:true});mkdirSync(join(prac,'coordinator/runs',run),{recursive:true});
 atomicJson(join(base,'swarm.json'),{minFreeGB:0,maxBots:17,jobs:[{account:'Mightyrod',script:'old.ts',enabled:true,repeat:true},{account:'Other',script:'keep.ts',enabled:true}]});
 atomicJson(join(prac,'swarm-deaths.json'),{Mightyrod:{at:1,reason:'blocked after 1 runs',revision:JSON.stringify(['old.ts',false,['mightyrod'],[]])}});
 atomicJson(join(prac,'status/Mightyrod.json'),{name:'Mightyrod',server:'rs-sdk-demo.fly.dev',result:'ok prior observed run'});
 beginSessionAttempt({account:'Mightyrod',server:'rs-sdk-demo.fly.dev'},{root:join(prac,'session-lifecycle')}).record('ended','logged-out');
 const task:CoordTask={id:'pilot',goal:'gear',kind:'run',capability:'shark-supply-order',account:'Mightyrod',dependsOn:[],priority:1,estimatedMs:1,why:'finite pilot',repairs:[{account:'Mightyrod',endedAt:1}]};
 const deps={build:{delivery:{id:task.capability,stage:'delivered',ok:true,at:2,runtimeRevision:'new'}}};
 return{base,run,prac,task,deps,prepare:()=>prepareLiveRecovery(task,'Mightyrod','new.ts',run,'new',deps,base,'new',{freeGB:64})};
}
function authenticatedFixture(){
 const f=recoveryFixture();f.task.sessionRecovery={account:'Mightyrod',endedAt:1};f.task.accept={counters:{cooked:25}};
 const directory=join(f.prac,'deliveries/native');mkdirSync(directory,{recursive:true});
 const out=join(directory,'gate.out.log');writeFileSync(out,'RECOVERY_NATIVE_PROOF '+JSON.stringify({path:join(directory,'proof.json'),sha256:'0'.repeat(64)})+'\n');
 const delivery={...f.deps.build.delivery,directory,source:'fixture',checks:[{id:'native-session-recovery',phase:'practice',exitCode:0,detail:JSON.stringify({stdout:out})}]};
 writeFileSync(join(directory,'report.json'),JSON.stringify(delivery));Object.assign(f.deps.build.delivery,delivery);return f;
}

test('authenticated recovery selects the newest current delivery after its exact failed end',()=>{
 const f=authenticatedFixture();f.task.sessionRecovery!.endedAt=20;
 const gate=(name:string,at:number,runtimeRevision='new')=>{
  const directory=join(f.prac,'deliveries',name);mkdirSync(directory,{recursive:true});
  const out=join(directory,'gate.out.log');
  writeFileSync(out,'RECOVERY_NATIVE_PROOF '+JSON.stringify({path:join(directory,'proof.json'),sha256:'0'.repeat(64)})+'\n');
  const delivery={...f.deps.build.delivery,directory,at,runtimeRevision,
   checks:[{id:'native-session-recovery',phase:'practice',exitCode:0,detail:JSON.stringify({stdout:out})}]};
  writeFileSync(join(directory,'report.json'),JSON.stringify(delivery));return{delivery};
 };
 const newest=gate('newest',40),deps={old:f.deps.build,future:gate('future',Date.now()+60000),
  fresh:gate('fresh',30),wrongSource:gate('wrong-source',50,'other'),newest};
 for(const dependencies of [deps,Object.fromEntries(Object.entries(deps).reverse())]){
  const qualification=recoveryQualification(f.task,dependencies,'new',f.base);
  expect(qualification.delivery.path).toBe(join(newest.delivery.directory,'report.json'));
  expect(qualification.proof.path).toBe(join(newest.delivery.directory,'proof.json'));
 }
});

test('authenticated recovery refuses deliveries at or before the failed end',()=>{
 const f=authenticatedFixture();f.task.sessionRecovery!.endedAt=2;
 expect(()=>recoveryQualification(f.task,f.deps,'new',f.base)).toThrow('current native delivery');
 f.task.sessionRecovery!.endedAt=3;
 expect(()=>recoveryQualification(f.task,f.deps,'new',f.base)).toThrow('current native delivery');
});

test('completed recovery preserves success and refuses missing authorization, same mission or unrelated producer proof',()=>{
 for(const scenario of ['authorization','same-mission','missing-revision','unrelated-proof','changed-end','stop']){
  const f=recoveryFixture(),file=join(f.prac,'swarm-deaths.json');
  f.task.sessionRecovery={account:'Mightyrod',endedAt:1};
  const revision=installJob(f.task,'Mightyrod','new.ts',f.run,'new',f.deps,{base:f.base,preflight:true}).revision;
  atomicJson(file,{Mightyrod:{at:scenario==='changed-end'?2:1,reason:'done after 1 runs',...(scenario==='missing-revision'?{}:{revision:scenario==='same-mission'?revision:'old-mission'})}});
  if(scenario==='authorization')delete f.task.sessionRecovery;
  if(scenario==='stop')writeFileSync(join(f.prac,'stop-Mightyrod'),'owner pause');
  const before=readFileSync(file,'utf8'),plan=readFileSync(join(f.base,'swarm.json'),'utf8');
  const reason=scenario==='authorization'?'exact authenticated':scenario==='same-mission'||scenario==='missing-revision'?'different mission':scenario==='changed-end'?'end record changed':scenario==='stop'?'stop file':'current run producer cleanup';
  expect(()=>preserveCompletedLiveEnd(f.task,{account:'Mightyrod',endedAt:1},'new.ts',f.run,'new',f.deps,f.base)).toThrow(reason);
  expect(readFileSync(file,'utf8')).toBe(before);expect(readFileSync(join(f.base,'swarm.json'),'utf8')).toBe(plan);
  expect(existsSync(join(f.prac,'swarm-repair.json'))).toBe(false);
 }
 const f=recoveryFixture(),before=readFileSync(join(f.prac,'swarm-deaths.json'),'utf8');
 expect(preserveCompletedLiveEnd(f.task,{account:'Mightyrod',endedAt:1},'new.ts',f.run,'new',f.deps,f.base)).toBe(false);
 expect(readFileSync(join(f.prac,'swarm-deaths.json'),'utf8')).toBe(before);
});
test('authenticated recovery authorization is exact and ordinary-account only',()=>{
 const f=authenticatedFixture();expect(()=>validateTask(f.task)).not.toThrow();
 for(const patch of [{kind:'review'},{account:'Other'},{launch:'main'},{sessionRecovery:{account:'Haggis',endedAt:1}},{sessionRecovery:{account:'Mightyrod',endedAt:2}}])
  expect(()=>validateTask({...f.task,...patch} as CoordTask)).toThrow('authenticated');
});
test('only authenticated preflight may park an uncertain session; production install still refuses it',()=>{
 const f=authenticatedFixture();beginSessionAttempt({account:'Mightyrod',server:'rs-sdk-demo.fly.dev'},{root:join(f.prac,'session-lifecycle')});
 const before=readFileSync(join(f.prac,'swarm-deaths.json'),'utf8'),owner=readFileSync(join(f.base,'swarm.json'),'utf8');expect(f.prepare).not.toThrow();
 expect(jobOf(f.base,'Mightyrod').enabled).toBe(false);expect(readFileSync(join(f.base,'swarm.json'),'utf8')).toBe(owner);
 expect(()=>installJob(f.task,'Mightyrod','new.ts',f.run,'new',f.deps,{base:f.base})).toThrow('not confirmed');
 expect(()=>installJob(f.task,'Mightyrod','new.ts',f.run,'new',f.deps,{base:f.base,recoveryPreflight:true})).toThrow('only preflight');
 expect(readFileSync(join(f.prac,'swarm-deaths.json'),'utf8')).toBe(before);
});
test('authenticated request timeout cancels only its unclaimed input and never changes the failure',async()=>{
 const f=authenticatedFixture(),before=readFileSync(join(f.prac,'swarm-deaths.json'),'utf8');
 await expect(requestAuthenticatedRecovery(f.task,f.deps,'new',f.run,f.base,10)).rejects.toThrow('timed out');
 expect(existsSync(join(f.prac,'swarm-repair.json'))).toBe(false);expect(existsSync(join(f.prac,'swarm-repair.json.lease'))).toBe(false);
 expect(readFileSync(join(f.prac,'swarm-deaths.json'),'utf8')).toBe(before);
});
// A full fleet of one bot: `Busy` holds the only slot until its status shows a result.
function fullFleetFixture(){
 const f=authenticatedFixture(),file=join(f.prac,'swarm-repair.json'),busy=join(f.prac,'status/Busy.json'),plan=JSON.parse(readFileSync(join(f.base,'swarm.json'),'utf8'));
 atomicJson(join(f.base,'swarm.json'),{...plan,maxBots:1});
 atomicJson(busy,{name:'Busy',server:'rs-sdk-demo.fly.dev',at:Date.now()});
 // The controller's part: it answers the request with a confirmed session cleanup.
 const controller=()=>{
  if(!existsSync(file))return false;
  const raw=readFileSync(file,'utf8');unlinkSync(file);writeFileSync(file+'.results.jsonl',JSON.stringify({raw,result:{sessionRecovered:true}})+'\n');return true;
 };
 return{...f,file,controller,free:()=>atomicJson(busy,{name:'Busy',server:'rs-sdk-demo.fly.dev',at:Date.now(),result:'ok done'})};
}
test('an authenticated recovery waits at a full fleet under its lease and takes the bot slot that frees',async()=>{
 const f=fullFleetFixture(),parked=readFileSync(join(f.base,'swarm.json'),'utf8');
 expect(f.prepare).toThrow('live admission waiting: maxBots');
 let waitedUnderLease=false,requestAtFullFleet=false,freed=false;
 const started=Date.now(),timer=setInterval(()=>{
  if(!freed&&existsSync(f.file))requestAtFullFleet=true;
  if(!freed&&Date.now()-started>=150){waitedUnderLease=existsSync(f.file+'.lease')&&jobOf(f.base,'Mightyrod').enabled===true;f.free();freed=true;}
  if(freed&&f.controller())clearInterval(timer);
 },10);
 try{
  await requestAuthenticatedRecovery(f.task,f.deps,'new',f.run,f.base,3000,'new',async()=>{f.prepare();},3000);
  // The lease, which holds the slot at the controller, stayed for the whole wait; no request went out before the slot.
  expect(waitedUnderLease).toBe(true);expect(requestAtFullFleet).toBe(false);
  expect(jobOf(f.base,'Mightyrod').enabled).toBe(false);expect(readFileSync(join(f.base,'swarm.json'),'utf8')).toBe(parked);
  expect(existsSync(f.file+'.lease')).toBe(false);
 }finally{clearInterval(timer);}
},10000);
test('the wait for a bot slot is bounded, and a memory refusal does not wait',async()=>{
 const f=fullFleetFixture(),jobs=()=>existsSync(coordinatorJobsPath(f.base))?readFileSync(coordinatorJobsPath(f.base),'utf8'):null,before=jobs();
 let attempts=0;
 await expect(requestAuthenticatedRecovery(f.task,f.deps,'new',f.run,f.base,3000,'new',async()=>{attempts++;f.prepare();},60)).rejects.toThrow('live admission waiting: maxBots');
 expect(attempts).toBeGreaterThan(1);
 expect(existsSync(f.file)).toBe(false);expect(existsSync(f.file+'.lease')).toBe(false);expect(jobs()).toBe(before);
 f.free();attempts=0;
 const started=Date.now();
 await expect(requestAuthenticatedRecovery(f.task,f.deps,'new',f.run,f.base,3000,'new',async()=>{attempts++;prepareLiveRecovery(f.task,'Mightyrod','new.ts',f.run,'new',f.deps,f.base,'new',{freeGB:0});},3000)).rejects.toThrow('live admission waiting: memory');
 expect(attempts).toBe(1);expect(Date.now()-started).toBeLessThan(1000);
 expect(existsSync(f.file)).toBe(false);expect(existsSync(f.file+'.lease')).toBe(false);expect(jobs()).toBe(before);
 // An owner stop ends the wait.
 atomicJson(join(f.prac,'status/Busy.json'),{name:'Busy',server:'rs-sdk-demo.fly.dev',at:Date.now()});
 writeFileSync(join(f.prac,'stop-Mightyrod'),'owner pause');
 await expect(requestAuthenticatedRecovery(f.task,f.deps,'new',f.run,f.base,3000,'new',async()=>{f.prepare();},3000)).rejects.toThrow('recovery owner stopped');
 expect(existsSync(f.file+'.lease')).toBe(false);
});
test('the wait reads the bot count of the controller, which has a bot that wrote no status yet',async()=>{
 const f=fullFleetFixture(),state=join(f.prac,'swarm-state.json');
 // The status rows show a free slot. The controller counts one bot that it started a moment before.
 f.free();atomicJson(state,{at:Date.now(),running:1,externalRunning:0,maxBots:1});
 let attempts=0;
 await expect(requestAuthenticatedRecovery(f.task,f.deps,'new',f.run,f.base,3000,'new',async()=>{attempts++;f.prepare();},60)).rejects.toThrow('live admission waiting: maxBots');
 expect(attempts).toBe(0);
 // A state that the controller no longer writes decides nothing.
 atomicJson(state,{at:Date.now()-60000,running:1,externalRunning:0,maxBots:1});
 const timer=setInterval(()=>{if(f.controller())clearInterval(timer);},10);
 try{await requestAuthenticatedRecovery(f.task,f.deps,'new',f.run,f.base,3000,'new',async()=>{attempts++;f.prepare();},3000);expect(attempts).toBe(1);}
 finally{clearInterval(timer);}
});
test('rollout waits for a post-lock tick and never kills a child omitted by the old state',async()=>{
 for(const outcome of ['spawn','drained','changed','timeout']){
  const f=recoveryFixture(),owner={pid:123,nonce:'controller',source:'old'},fence=1000;let now=fence,kills=0;
  const state={at:fence-1,controllerPid:owner.pid,coordinatorOwner:owner.nonce,release:owner.source,running:0,pendingStartup:0,externalRunning:0};
  atomicJson(join(f.prac,'swarm-state.json'),state);
  const wait=awaitControllerDrain(owner,fence,f.base,500,{now:()=>now,pause:async()=>{now+=100;if(outcome!=='timeout')atomicJson(join(f.prac,'swarm-state.json'),{...state,at:now,
   running:outcome==='spawn'?1:0,pendingStartup:outcome==='spawn'?1:0,coordinatorOwner:outcome==='changed'?'other':owner.nonce});}}).then(()=>{kills++;});
  if(outcome==='drained'){await wait;expect(kills).toBe(1);}
  else{await expect(wait).rejects.toThrow(outcome==='spawn'?'owned or external':outcome==='changed'?'ownership changed':'timed out');expect(kills).toBe(0);}
 }
});
test('actual rollout handles lock/repair refusals and failed new-controller acknowledgement without open admission',async()=>{
 for(const scenario of ['lock','repair-lease','pending','processing','busy','source','source-after-stop','source-after-ack','paused','pause-before-spawn','pause-after-start','ack-failed','ack-unconfirmed','foreign-finally','success']){
  const f=recoveryFixture(),dir=join(f.prac,'coordinator'),lock=join(dir,'build-lock.json'),lease=join(f.prac,'swarm-repair.json.lease'),ownerFile=join(dir,'swarm-owner.json');
  const old={pid:11,nonce:'old-controller',source:'old'},live=new Set([11]),events:string[]=[];let current='new';
  atomicJson(ownerFile,old);const foreign={pid:999,runId:'other-owner'};
  if(scenario==='lock')atomicJson(lock,foreign);if(scenario==='repair-lease')atomicJson(lease,foreign);
  if(scenario==='paused')writeFileSync(join(f.prac,'stop-swarm'),'owner pause');
  if(scenario==='pending'||scenario==='processing')writeFileSync(join(f.prac,'swarm-repair.json'+(scenario==='processing'?'.processing':'')),'owned request');
  const deps={base:f.base,currentSource:()=>'new',diskSource:()=>current,matches:(pid:number,_nonce:string)=>live.has(pid),pidExists:(pid:number)=>live.has(pid),processes:()=>[...live],rows:()=>[],now:()=>1000,
   stop:async(pid:number,nonce:string)=>{events.push('stop:'+pid+':'+nonce);if(scenario==='ack-unconfirmed'&&pid===22)return false;live.delete(pid);if(scenario==='source-after-stop'&&pid===11)current='changed';return true;},
   spawn:(_source:string,_nonce:string)=>{events.push('spawn');live.add(22);if(scenario==='foreign-finally')atomicJson(lock,foreign);return 22;},
   drain:async(owner:{pid:number},_after:number)=>{events.push('drain:'+owner.pid);if(scenario==='busy'&&owner.pid===11)throw Error('owned sessions');if(scenario==='source'&&owner.pid===11)current='changed';
    if(scenario==='source-after-ack'&&owner.pid===22)current='changed';
    if(scenario==='pause-before-spawn'&&owner.pid===11||scenario==='pause-after-start'&&owner.pid===22)writeFileSync(join(f.prac,'stop-swarm'),'owner pause');
    if(['ack-failed','ack-unconfirmed'].includes(scenario)&&owner.pid===22)throw Error('new acknowledgement missing');}};
  const action=ensureSwarm('new',deps);
  if(['success','foreign-finally'].includes(scenario))await action;else await expect(action).rejects.toThrow();
  if(['lock','repair-lease','pending','processing','busy','source','source-after-stop','paused','pause-before-spawn'].includes(scenario))expect(events).not.toContain('spawn');
  if(scenario==='lock')expect(JSON.parse(readFileSync(lock,'utf8'))).toEqual(foreign);
  else if(scenario==='ack-unconfirmed'){
   expect(JSON.parse(readFileSync(lock,'utf8')).pid).toBe(22);expect(live.has(22)).toBe(true);
   await expect(ensureSwarm('new',deps)).rejects.toThrow('remains fenced');
  }else if(scenario==='foreign-finally')expect(JSON.parse(readFileSync(lock,'utf8'))).toEqual(foreign);
  else expect(existsSync(lock)).toBe(false);
  if(scenario==='repair-lease')expect(JSON.parse(readFileSync(lease,'utf8'))).toEqual(foreign);else expect(existsSync(lease)).toBe(false);
  if(scenario==='ack-failed'||scenario==='pause-after-start'||scenario==='source-after-ack'){expect(live.has(22)).toBe(false);expect(existsSync(ownerFile)).toBe(false);expect(events.some(e=>e.startsWith('stop:22:'))).toBe(true);}
  if(scenario==='pending'||scenario==='processing')expect(readFileSync(join(f.prac,'swarm-repair.json'+(scenario==='processing'?'.processing':'')),'utf8')).toBe('owned request');
 }
});
test('a rollout fence is archived once its controller is gone, and holds while it lives',async()=>{
 const f=recoveryFixture(),dir=join(f.prac,'coordinator'),lock=join(dir,'build-lock.json'),runId='rollout-0f3c2b9e-1d2a-4c5b-8e7f-123456789abc';
 const live=new Set<number>([44]),events:string[]=[];
 const deps={base:f.base,currentSource:()=>'new',diskSource:()=>'new',matches:(pid:number,_nonce:string)=>live.has(pid),pidExists:(pid:number)=>live.has(pid),processes:()=>[...live].filter(p=>p!==44),rows:()=>[],now:()=>1000,
  stop:async(pid:number)=>{live.delete(pid);return true;},spawn:(_source:string,_nonce:string)=>{events.push('spawn');live.add(33);return 33;},drain:async()=>{}};
 atomicJson(lock,{pid:44,runId,nonce:'unconfirmed',source:'old',at:1,reason:'controller stop/acknowledgement unconfirmed; preserve admission fence'});
 await expect(ensureSwarm('new',deps)).rejects.toThrow('remains fenced');
 expect(events).not.toContain('spawn');
 live.delete(44);
 await ensureSwarm('new',deps);
 expect(existsSync(join(dir,'runs',runId,'expired-build-lock.json'))).toBe(true);
 expect(events).toContain('spawn');expect(existsSync(lock)).toBe(false);
});
test('recovery preflight leaves the block and assignments untouched on stop, session, binding or reservation refusal',()=>{
 for(const cause of ['stop','session','capability','time','reserved','composed']){
  const f=recoveryFixture(),path=join(f.base,'swarm.json');
  if(cause==='stop')writeFileSync(join(f.prac,'stop-Mightyrod'),'owner stop');
  if(cause==='session')atomicJson(join(f.prac,'status/Mightyrod.json'),{name:'Mightyrod',server:'rs-sdk-demo.fly.dev'});
  if(cause==='capability')f.deps.build.delivery.id='other';if(cause==='time')f.task.repairs![0]!.endedAt=9;
  if(cause==='reserved')atomicJson(path,{minFreeGB:0,maxBots:17,jobs:[{account:'Mightyrod',goal:'main simultaneous24'}]});
  if(cause==='composed')atomicJson(path,{minFreeGB:0,maxBots:17,jobs:[{accounts:['Mightyrod','Other'],orchestrate:true,script:'old.ts'}]});
  const before=readFileSync(path,'utf8'),ended=readFileSync(join(f.prac,'swarm-deaths.json'),'utf8');
  expect(f.prepare).toThrow();expect(readFileSync(path,'utf8')).toBe(before);expect(readFileSync(join(f.prac,'swarm-deaths.json'),'utf8')).toBe(ended);expect(existsSync(join(f.prac,'swarm-repair.json'))).toBe(false);
 }
});
test('successful preflight parks the failed assignment and retains its evidence before any controller request',()=>{
 const f=recoveryFixture(),owner=readFileSync(join(f.base,'swarm.json'),'utf8');f.prepare();
 // The parked copy lives in the coordinator's file and shadows the owner job; swarm.json keeps its bytes.
 expect(jobOf(f.base,'Mightyrod')).toMatchObject({account:'Mightyrod',enabled:false,repeat:true,script:'old.ts'});expect(jobOf(f.base,'Other').enabled).toBe(true);
 expect(readMergedPlan(f.base).jobs.filter((j:any)=>j.account==='Mightyrod')).toHaveLength(1);
 expect(readFileSync(join(f.base,'swarm.json'),'utf8')).toBe(owner);
 expect(JSON.parse(readFileSync(coordinatorJobsPath(f.base),'utf8')).jobs).toEqual([{account:'Mightyrod',script:'old.ts',enabled:false,repeat:true}]);
 expect(JSON.parse(readFileSync(join(f.prac,'swarm-deaths.json'),'utf8')).Mightyrod.at).toBe(1);
 const proof=JSON.parse(readFileSync(join(f.prac,'coordinator/runs',f.run,'recovery-before.json'),'utf8'));expect(proof.assignments[0].enabled).toBe(true);expect(proof.ended.Mightyrod.at).toBe(1);
});
test('same-script death repair refuses before spending the failure or disabling the old assignment',()=>{
 const f=recoveryFixture(),path=join(f.base,'swarm.json'),before=readFileSync(path,'utf8');
 atomicJson(join(f.prac,'swarm-deaths.json'),{Mightyrod:{at:1,reason:'died',revision:JSON.stringify(['old.ts',false,['mightyrod'],[]])}});
 expect(()=>prepareLiveRecovery(f.task,'Mightyrod','./old.ts',f.run,'new',f.deps,f.base,'new',{freeGB:64})).toThrow('same-script');
 expect(readFileSync(path,'utf8')).toBe(before);expect(loadEnded(join(f.prac,'swarm-deaths.json')).get('Mightyrod')?.at).toBe(1);
});

for(const reason of ['blocked after 1 runs','gave-up after 1 runs'])test('qualified same-script '+reason+' preflights without clearing its exact end or enabling the job',()=>{
 const f=recoveryFixture(),path=join(f.base,'swarm.json');
 atomicJson(path,{minFreeGB:0,maxBots:17,jobs:[{account:'Mightyrod',script:'old.ts',enabled:false,repeat:false},{account:'Other',script:'keep.ts',enabled:true}]});
 atomicJson(join(f.prac,'status/Mightyrod.json'),{name:'Mightyrod',server:'rs-sdk-demo.fly.dev',result:'fail prior job'});
 atomicJson(join(f.prac,'swarm-deaths.json'),{Mightyrod:{at:1,reason,revision:JSON.stringify(['old.ts',false,['mightyrod'],[]])}});
 const owner=readFileSync(path,'utf8');
 expect(()=>prepareLiveRecovery(f.task,'Mightyrod','old.ts',f.run,'new',f.deps,f.base,'new',{freeGB:64})).not.toThrow();
 expect(readFileSync(path,'utf8')).toBe(owner);expect(loadEnded(join(f.prac,'swarm-deaths.json')).get('Mightyrod')?.at).toBe(1);
 expect(jobOf(f.base,'Mightyrod').enabled).toBe(false);expect(jobOf(f.base,'Other').enabled).toBe(true);
 expect(()=>installJob(f.task,'Mightyrod','old.ts',f.run,'new',f.deps,{base:f.base,freeGB:64})).toThrow('recovery');
});

test('a qualified five-actor non-death repair checks every exact end and keeps all actors disabled',()=>{
 const f=recoveryFixture(),names=['Mightyrod','Carrier1','Carrier2','Carrier3','Carrier4'],path=join(f.base,'swarm.json');
 atomicJson(path,{minFreeGB:0,maxBots:17,jobs:names.map(account=>({account,script:'old.ts',enabled:false,repeat:false}))});
 const ends=Object.fromEntries(names.map((name,i)=>[name,{at:i+1,reason:'gave-up after 1 runs',revision:JSON.stringify(['old.ts',false,names.map(n=>n.toLowerCase()),[]])}]));
 atomicJson(join(f.prac,'swarm-deaths.json'),ends);
 for(const name of names){atomicJson(join(f.prac,'status',name+'.json'),{name,server:'rs-sdk-demo.fly.dev',result:'fail prior composed job'});beginSessionAttempt({account:name,server:'rs-sdk-demo.fly.dev'},{root:join(f.prac,'session-lifecycle')}).record('ended','logged-out');}
 delete f.task.account;f.task.participants=names;f.task.repairs=names.map((account,i)=>({account,endedAt:i+1}));f.deps.build.delivery.at=10;
 const owner=readFileSync(path,'utf8');
 expect(()=>prepareLiveRecovery(f.task,names[0]!,'old.ts',f.run,'new',f.deps,f.base,'new',{freeGB:64})).not.toThrow();
 expect(readFileSync(path,'utf8')).toBe(owner);expect(Object.fromEntries(loadEnded(join(f.prac,'swarm-deaths.json')))).toEqual(ends);
 expect(names.every(name=>jobOf(f.base,name).enabled===false)).toBe(true);
 expect(()=>installJob(f.task,names[0]!,'old.ts',f.run,'new',f.deps,{base:f.base,freeGB:64})).toThrow('participant assignment is not confirmed complete');
});

for(const invalid of ['stale','failed','foreign capability','wrong source','unconfirmed logout'])test('same-script non-death repair preserves its end on '+invalid,()=>{
 const f=recoveryFixture(),path=join(f.base,'swarm.json');
 atomicJson(path,{minFreeGB:0,maxBots:17,jobs:[{account:'Mightyrod',script:'old.ts',enabled:false,repeat:false}]});
 atomicJson(join(f.prac,'status/Mightyrod.json'),{name:'Mightyrod',server:'rs-sdk-demo.fly.dev',result:'fail prior job'});
 if(invalid==='stale')f.deps.build.delivery.at=1;
 if(invalid==='failed')f.deps.build.delivery.ok=false;
 if(invalid==='foreign capability')f.deps.build.delivery.id='other';
 if(invalid==='wrong source')f.deps.build.delivery.runtimeRevision='old';
 if(invalid==='unconfirmed logout')beginSessionAttempt({account:'Mightyrod',server:'rs-sdk-demo.fly.dev'},{root:join(f.prac,'session-lifecycle')});
 const owner=readFileSync(path,'utf8');
 expect(()=>prepareLiveRecovery(f.task,'Mightyrod','old.ts',f.run,'new',f.deps,f.base,'new',{freeGB:64})).toThrow(invalid==='unconfirmed logout'?'logout':'fresh post-failure');
 expect(readFileSync(path,'utf8')).toBe(owner);expect(loadEnded(join(f.prac,'swarm-deaths.json')).get('Mightyrod')?.at).toBe(1);
});
test('a recovery timeout fails, cancels its own unclaimed request and never writes controller end state',async()=>{
 const f=recoveryFixture();f.prepare();const end=readFileSync(join(f.prac,'swarm-deaths.json'),'utf8');
 await expect(requestLiveRecovery({account:'Mightyrod',endedAt:1},f.run,f.base,10)).rejects.toThrow('timed out');
 expect(existsSync(join(f.prac,'swarm-repair.json'))).toBe(false);expect(readFileSync(join(f.prac,'swarm-deaths.json'),'utf8')).toBe(end);
 expect(readdirSync(join(f.prac,'coordinator/runs',f.run)).some(n=>n.startsWith('recovery-cancelled-'))).toBe(true);
});
test('an owned controller processing file and another repair lease are preserved',async()=>{
 const f=recoveryFixture(),file=join(f.prac,'swarm-repair.json');writeFileSync(file+'.processing','controller owned');
 await expect(requestLiveRecovery({account:'Mightyrod',endedAt:1},f.run,f.base,10)).rejects.toThrow('owns');expect(readFileSync(file+'.processing','utf8')).toBe('controller owned');
 writeFileSync(file+'.lease','other owner');await expect(requestLiveRecovery({account:'Mightyrod',endedAt:1},f.run,f.base,10)).rejects.toThrow();expect(readFileSync(file+'.lease','utf8')).toBe('other owner');
});
test('a new partial connection after preflight prevents the repair request',async()=>{
 const f=recoveryFixture();f.prepare();
 beginSessionAttempt({account:'Mightyrod',server:'rs-sdk-demo.fly.dev'},{root:join(f.prac,'session-lifecycle')});
 await expect(requestLiveRecovery({account:'Mightyrod',endedAt:1},f.run,f.base,10)).rejects.toThrow('not confirmed');
 expect(existsSync(join(f.prac,'swarm-repair.json'))).toBe(false);
 expect(loadEnded(join(f.prac,'swarm-deaths.json')).get('Mightyrod')?.at).toBe(1);
});
test('an exact controller refusal keeps its reason and a different nonce cannot fail our request',async()=>{
 const f=recoveryFixture();f.prepare();const file=join(f.prac,'swarm-repair.json');
 const controller=(async()=>{await Bun.sleep(20);const raw=readFileSync(file,'utf8'),request=JSON.parse(raw);
  writeFileSync(file+'.results.jsonl',JSON.stringify({raw:JSON.stringify({...request,nonce:'foreign'}),result:{changed:false,reason:'foreign'}})+'\n'+JSON.stringify({raw,result:{changed:false,reason:'logout proof superseded'}})+'\n');unlinkSync(file);})();
 await expect(requestLiveRecovery({account:'Mightyrod',endedAt:1},f.run,f.base,1500)).rejects.toThrow('controller refused exact recovery: logout proof superseded');await controller;
 expect(loadEnded(join(f.prac,'swarm-deaths.json')).get('Mightyrod')?.at).toBe(1);
});
test('controller acknowledgement clears only the exact block after the old assignment is parked',async()=>{
 const f=recoveryFixture();f.prepare();const file=join(f.prac,'swarm-repair.json'),deaths=join(f.prac,'swarm-deaths.json');
 const controller=(async()=>{await Bun.sleep(20);expect(jobOf(f.base,'Mightyrod').enabled).toBe(false);
  renameSync(file,file+'.processing');const request=JSON.parse(readFileSync(file+'.processing','utf8')),ends=loadEnded(deaths);
  const root=join(f.prac,'session-lifecycle');
  expect(applyEndRepair(request,ends,[],{readProof:(a,s)=>readLogoutProof(a,s,{root}),verifyLegacy:c=>verifyLegacyLogout(c,{root})}).changed).toBe(true);persistEnded(deaths,ends);unlinkSync(file+'.processing');})();
 await requestLiveRecovery({account:'Mightyrod',endedAt:1},f.run,f.base,1500);await controller;
 expect(loadEnded(deaths).has('Mightyrod')).toBe(false);expect(existsSync(file+'.lease')).toBe(false);
});
test('reassignment retains unrelated group partners and removes overlapping old assignments',()=>{
 const old=[{accounts:['Donor','Partner'],host:true,script:'earn',enabled:true},{account:'Receiver',script:'old'},{account:'Other',script:'keep'}],replacement={accounts:['Donor','Receiver'],orchestrate:true,script:'handoff'};
 const result=replaceAssignments(old,['Donor','Receiver'],replacement);
 expect(result).toEqual([{...old[0],accounts:['Partner']},old[2],replacement]);expect(old[0]!.accounts).toEqual(['Donor','Partner']);
 expect(()=>replaceAssignments([{accounts:['Donor','Partner'],orchestrate:true}],['Donor'],replacement)).toThrow('composed assignment');
});
test('restart adopts a matching child receipt and advances dependent work exactly once',()=>{
 const dir=mkdtempSync(join(tmpdir(),'coord-recovery-')),s=seed();saveState(s,dir);const run=runDirectory('recovery-run',dir);
 atomicJson(join(run,'receipt.json'),{taskId:'producer',runId:'recovery-run',ok:true,at:Date.now(),output:{evidence:'native'}});
 const restored=loadState(dir);reconcile(restored,()=>{throw Error('completed child must not be spawned or probed');},dir);saveState(restored,dir);
 expect(chooseTask(restored,Date.now())?.id).toBe('consumer');reconcile(restored,()=>false,dir);expect(restored.goals.find(g=>g.id==='skills')?.completedTasks).toBe(1);
 expect(readFileSync(join(dir,'state.json.previous'),'utf8')).toContain('running');
});
test('restart keeps an owned live worker and retains a lost worker as failure',()=>{
 const dir=mkdtempSync(join(tmpdir(),'coord-recovery-')),s=seed();atomicJson(join(runDirectory('recovery-run',dir),'owner.json'),{pid:123});
 reconcile(s,(pid,marker)=>pid===123&&marker==='recovery-run',dir);expect(s.tasks[0]!.status).toBe('running');
 reconcile(s,()=>false,dir,()=>true);expect(s.tasks[0]!.status).toBe('running');
 reconcile(s,()=>false,dir,()=>false);expect(s.tasks[0]!.status).toBe('failed');expect(chooseTask(s,Date.now())).toBeNull();
});
test('a mismatched receipt cannot complete a different run',()=>{
 const dir=mkdtempSync(join(tmpdir(),'coord-recovery-')),s=seed();atomicJson(join(runDirectory('recovery-run',dir),'receipt.json'),{taskId:'producer',runId:'other-run',ok:true,at:Date.now(),output:{}});
 reconcile(s,()=>false,dir);expect(s.tasks[0]!.status).toBe('failed');expect(s.goals[1]!.completedTasks).toBe(0);
});
test('live child polling does not launch command-line inspection while OS liveness is known',()=>{
 const dir=mkdtempSync(join(tmpdir(),'coord-quiet-')),s=seed();
 atomicJson(join(runDirectory('recovery-run',dir),'owner.json'),{pid:123});
 reconcile(s,()=>{throw Error('poll must not spawn PowerShell for a live process');},dir,()=>true);
 expect(s.tasks[0]!.status).toBe('running');
});
test('planner rejects unknown capabilities and credentials without changing queue',()=>{
 const s=initialState();expect(()=>acceptProposal(s,{reason:'bad',capabilities:[],tasks:[{id:'unknown',goal:'wealth',kind:'run',capability:'does-not-exist',account:'Test',dependsOn:[],priority:2,estimatedMs:1,why:'bad',accept:{bank:{'995':1}}}]})).toThrow('unknown capability');expect(s.tasks).toHaveLength(0);
 expect(parseModelObject('```json\n{"tasks":[]}\n```')).toEqual({tasks:[]});
});

test('detached worker survives its launcher exiting and writes its own receipt',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'coord-detached-')),receipt=join(dir,'receipt.json');
 const store=new URL('../src/coordinator-store.ts',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');
 const child=join(dir,'child.ts'),parent=join(dir,'parent.ts');
 writeFileSync(child,`await Bun.sleep(800);await Bun.write(${JSON.stringify(receipt)},'owned child completed');`);
 writeFileSync(parent,`import {spawnDetached} from ${JSON.stringify(store)};spawnDetached([process.execPath,${JSON.stringify(child)}],${JSON.stringify(dir)},${JSON.stringify(join(dir,'out'))},${JSON.stringify(join(dir,'err'))});`);
 const launcher=Bun.spawn([process.execPath,parent],{stdout:'pipe',stderr:'pipe'});expect(await launcher.exited).toBe(0);
 const limit=Date.now()+5000;while(!existsSync(receipt)&&Date.now()<limit)await Bun.sleep(100);
 expect(existsSync(receipt)).toBe(true);expect(readFileSync(receipt,'utf8')).toBe('owned child completed');
},10000);

test('a detached-run controller rolls over without drain or pause, and is stopped alone', async () => {
 const f = recoveryFixture(), dir = join(f.prac, 'coordinator'), ownerFile = join(dir, 'swarm-owner.json');
 atomicJson(ownerFile, { pid: 11, nonce: 'old-controller', source: 'old', swarmSource: 'stale', detached: true });
 const live = new Set([11]), events: string[] = [];
 const deps = { base: f.base, currentSource: () => 'new', diskSource: () => 'new', matches: (pid: number) => live.has(pid), pidExists: (pid: number) => live.has(pid), processes: () => [...live], now: () => 1000,
  rows: () => [{ server: 'rs-sdk-demo.fly.dev', name: 'Busy', at: 1000 }],
  stop: async () => { events.push('tree-stop'); return true; },
  stopOne: async (pid: number) => { events.push('stop-one:' + pid); live.delete(pid); return true; },
  spawn: () => { events.push('spawn'); live.add(22); return 22; },
  drain: async (o: { pid: number }) => { events.push('drain:' + o.pid); },
  ack: async (o: { pid: number }) => { events.push('ack:' + o.pid); } };
 await ensureSwarm('new', deps as any);
 expect(events).toEqual(['stop-one:11', 'spawn', 'ack:22']);
 expect(JSON.parse(readFileSync(ownerFile, 'utf8'))).toMatchObject({ pid: 22, detached: true });
 expect(existsSync(join(dir, 'rollout-paused.json'))).toBe(false);
});

test('a run rolls a controller whose release differs from its source; a standing check reuses it', async () => {
 const f = recoveryFixture(), dir = join(f.prac, 'coordinator'), ownerFile = join(dir, 'swarm-owner.json');
 atomicJson(ownerFile, { pid: 11, nonce: 'old-controller', source: 'old', swarmSource: 'stale', detached: true });
 const live = new Set([11]), events: string[] = [];let next = 22,source='new';
 const deps = { base: f.base, currentSource: () => source, diskSource: () => source, matches: (pid: number) => live.has(pid), pidExists: (pid: number) => live.has(pid), processes: () => [...live], now: () => 1000,
  rows: () => [],
  stopOne: async (pid: number) => { events.push('stop-one:' + pid); live.delete(pid); return true; },
  spawn: () => { const pid = next++; events.push('spawn:' + pid); live.add(pid); return pid; },
  ack: async () => {} };
 await ensureSwarm('new', deps as any);
 atomicJson(join(dir, 'rollout-backoff.json'), { until: 5000 });
 source = 'newer';
 events.length = 0;
 await ensureSwarm('newer', deps as any, false);
 expect(events).toEqual([]);
 await ensureSwarm('newer', deps as any);
 expect(events).toEqual(['stop-one:22', 'spawn:23']);
 expect(JSON.parse(readFileSync(ownerFile, 'utf8'))).toMatchObject({ pid: 23, source: 'newer' });
});

test('the recovery preflight parks an enabled standing hand job whose last session failed; production install still checks',()=>{
 const f=authenticatedFixture();
 atomicJson(join(f.base,'swarm.json'),{minFreeGB:0,maxBots:17,jobs:[{account:'Mightyrod',script:'old.ts',enabled:true,repeat:true,standing:true},{account:'Other',script:'keep.ts',enabled:true}]});
 atomicJson(join(f.prac,'status/Mightyrod.json'),{name:'Mightyrod',server:'rs-sdk-demo.fly.dev',result:'fail session ended: disconnected'});
 const owner=readFileSync(join(f.base,'swarm.json'),'utf8');
 expect(f.prepare).not.toThrow();
 // The parked copy is in the coordinator's file; the merged plan the swarm runs shows the hand job off and still
 // standing, and the owner's swarm.json keeps its bytes.
 expect(jobOf(f.base,'Mightyrod')).toMatchObject({account:'Mightyrod',enabled:false,standing:true});
 expect(readFileSync(join(f.base,'swarm.json'),'utf8')).toBe(owner);
 expect(()=>installJob(f.task,'Mightyrod','new.ts',f.run,'new',f.deps,{base:f.base,preflight:true})).toThrow('not confirmed');
 const plain={...f.task};delete plain.sessionRecovery;
 writeCoordinatorJobs(f.base,emptyCoordinatorJobs());
 atomicJson(join(f.base,'swarm.json'),{minFreeGB:0,maxBots:17,jobs:[{account:'Mightyrod',script:'old.ts',enabled:true,repeat:true,standing:true}]});
 expect(()=>installJob(plain,'Mightyrod','new.ts',f.run,'new',f.deps,{base:f.base,preflight:true})).toThrow('owner standing job');
});

test('after the recovery, the production install treats the parked hand job as released only by this run confirmed recovery',()=>{
 const f=authenticatedFixture();
 atomicJson(join(f.base,'swarm.json'),{minFreeGB:0,maxBots:17,jobs:[{account:'Mightyrod',script:'old.ts',enabled:false,repeat:true,standing:true},{account:'Other',script:'keep.ts',enabled:true}]});
 atomicJson(join(f.prac,'status/Mightyrod.json'),{name:'Mightyrod',server:'rs-sdk-demo.fly.dev',result:'fail session ended: disconnected'});
 expect(()=>installJob(f.task,'Mightyrod','new.ts',f.run,'new',f.deps,{base:f.base,preflight:true,recovered:()=>false})).toThrow('not confirmed');
 expect(()=>installJob(f.task,'Mightyrod','new.ts',f.run,'new',f.deps,{base:f.base,preflight:true,recovered:()=>true})).not.toThrow();
 const plain={...f.task};delete plain.sessionRecovery;
 expect(()=>installJob(plain,'Mightyrod','new.ts',f.run,'new',f.deps,{base:f.base,preflight:true,recovered:()=>true})).toThrow('not confirmed');
});
