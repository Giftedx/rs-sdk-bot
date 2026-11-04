import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,unlinkSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {atomicJson} from '../src/coordinator-store';
import {prepareLiveRecovery,installJob,requestAuthenticatedRecovery,requestLiveRecovery,awaitRecoveryInstallPreflight} from '../src/coordinator-live';
import {beginSessionAttempt} from '../../core/src/session-lifecycle';
import {emptyCoordinatorJobs,readCoordinatorJobs,writeCoordinatorJobs} from '../../core/src/coordinator-jobs';
import {validateTask,type CoordTask} from '../src/coordinator';

function fixture(){
 const base=mkdtempSync(join(tmpdir(),'retired-cohort-')),prac=join(base,'.practice'),names=['Ballspinner','Shaftsinker'];
 mkdirSync(join(prac,'status'),{recursive:true});mkdirSync(join(prac,'coordinator/runs/task-retired'),{recursive:true});
 atomicJson(join(base,'swarm.json'),{maxBots:17,minFreeGB:0,jobs:[]});
 atomicJson(join(prac,'swarm-runs.json'),[]);
 atomicJson(join(prac,'coordinator/runs/task-retired/receipt.json'),{taskId:'retired',runId:'task-retired',ok:false});
 const job={accounts:names,orchestrate:true,script:'old.ts',enabled:false,coordinatorOwner:'coordinator',coordinatorTask:'retired',env:{COORDINATOR_RUN_ID:'task-retired'}};
 writeCoordinatorJobs(base,{...emptyCoordinatorJobs(),jobs:[job]});
 const ends=Object.fromEntries(names.map((name,i)=>[name,{at:i+1,reason:'disconnected',revision:JSON.stringify(['old.ts',false,names,[]])}]));
 atomicJson(join(prac,'swarm-deaths.json'),ends);
 for(const name of names){
  const a=beginSessionAttempt({account:name,server:'rs-sdk-demo.fly.dev'},{root:join(prac,'session-lifecycle')});a.record('ended','disconnected');
  atomicJson(join(prac,'status',name+'.json'),{name,server:'rs-sdk-demo.fly.dev',result:'fail retired',started:1,at:2,sessionAttemptId:a.attemptId});
 }
 const directory=join(prac,'deliveries/native');mkdirSync(directory,{recursive:true});
 const out=join(directory,'gate.log');writeFileSync(out,'RECOVERY_NATIVE_PROOF '+JSON.stringify({path:join(directory,'proof.json'),sha256:'0'.repeat(64)})+'\n');
 const delivery={id:'session-recovery-only',stage:'delivered',ok:true,at:3,runtimeRevision:'new',source:'fixture',directory,
  checks:[{id:'native-session-recovery',phase:'practice',exitCode:0,detail:JSON.stringify({stdout:out})}]};
 atomicJson(join(directory,'report.json'),delivery);
 const tasks=names.map((name,i):CoordTask=>({id:'recover-'+i,kind:'run',goal:'gear',capability:'session-recovery-only',account:name,dependsOn:[],priority:1,estimatedMs:1,
  why:'Recover one exact failed actor while retaining its retired cohort.',repairs:[{account:name,endedAt:i+1}],sessionRecovery:{account:name,endedAt:i+1},accept:{counters:{sessionChecked:1}}}));
 for(const task of tasks){validateTask(task);mkdirSync(join(prac,'coordinator/runs',task.id),{recursive:true});}
 const deps={native:{delivery}};
 return{base,prac,names,job,tasks,deps,prepare:(i:number)=>prepareLiveRecovery(tasks[i]!,names[i]!,'check.ts',tasks[i]!.id,'new',deps,base),
  confirm:(i:number)=>beginSessionAttempt({account:names[i]!,server:'rs-sdk-demo.fly.dev'},{root:join(prac,'session-lifecycle')}).record('ended','logged-out')};
}

test('exact authenticated preflight parks the whole retired cohort; ordinary release still needs both logouts',()=>{
 const f=fixture(),before=readFileSync(join(f.prac,'swarm-deaths.json'),'utf8');
 expect(()=>f.prepare(0)).not.toThrow();expect(()=>f.prepare(1)).not.toThrow();
 expect(readCoordinatorJobs(f.base).jobs).toEqual([f.job]);
 expect(readFileSync(join(f.prac,'swarm-deaths.json'),'utf8')).toBe(before);
 const install=(i:number)=>installJob(f.tasks[i]!,f.names[i]!,'check.ts',f.tasks[i]!.id,'new',f.deps,{base:f.base,preflight:true,freeGB:64});
 expect(()=>install(0)).toThrow('logout');
 f.confirm(0);expect(()=>install(0)).toThrow('composed assignment');
 expect(readCoordinatorJobs(f.base).jobs).toEqual([f.job]);
 f.confirm(1);expect(()=>install(0)).not.toThrow();expect(()=>install(1)).not.toThrow();
 expect(readCoordinatorJobs(f.base).jobs).toEqual([f.job]);
});

test('paired exact recoveries serialize their requests and wait outside the plan lock for peer logout',async()=>{
 const f=fixture(),file=join(f.prac,'swarm-repair.json'),seen=new Set<string>(),order:string[]=[];
 let controllerFailure:unknown,handling=false,firstStillHeld=false;
 const timer=setInterval(()=>{
  if(handling||!existsSync(file))return;
  handling=true;
  try{
   const raw=readFileSync(file,'utf8'),r=JSON.parse(raw);if(seen.has(r.nonce))return;seen.add(r.nonce);
   const i=f.names.indexOf(r.account);expect(i).toBeGreaterThanOrEqual(0);expect(r.endedAt).toBe(i+1);
   expect(readCoordinatorJobs(f.base).jobs).toEqual([f.job]);
   f.confirm(i);order.push(r.account);
   if(order.length===1){
    expect(()=>installJob(f.tasks[i]!,r.account,'check.ts',r.runId,'new',f.deps,{base:f.base,preflight:true,freeGB:64})).toThrow('composed assignment');
    firstStillHeld=true;
   }
   unlinkSync(file);appendFileSync(file+'.results.jsonl',JSON.stringify({raw,result:{sessionRecovered:true}})+'\n');
  }catch(error){controllerFailure=error;}finally{handling=false;}
 },5);
 try{
  await Promise.all(f.tasks.map(async(task,i)=>{
   let retained:ReturnType<typeof prepareLiveRecovery>;
   await requestAuthenticatedRecovery(task,f.deps,'new',task.id,f.base,3000,'new',async()=>{retained=f.prepare(i);});
   await awaitRecoveryInstallPreflight(task,f.names[i]!,'check.ts',task.id,'new',f.deps,retained,f.base,'new',3000);
  }));
  if(controllerFailure)throw controllerFailure;
  expect(firstStillHeld).toBe(true);expect(new Set(order)).toEqual(new Set(f.names));
  expect(readCoordinatorJobs(f.base).jobs).toEqual([f.job]);
  expect(existsSync(file+'.lease')).toBe(false);
 }finally{clearInterval(timer);}
},10000);

test('a peer check starting after ordinary cohort release does not hold the remaining recovery',async()=>{
 const f=fixture(),retained=f.prepare(0);f.confirm(0);f.confirm(1);
 // The normal install consumes the exact cleared end after controller acknowledgement.
 atomicJson(join(f.prac,'swarm-deaths.json'),{Shaftsinker:{at:2,reason:'disconnected',revision:JSON.stringify(['old.ts',false,f.names,[]])}});
 mkdirSync(join(f.prac,'coordinator/runs/check-first'),{recursive:true});
 installJob({...f.tasks[0]!,repairs:undefined,sessionRecovery:undefined},f.names[0]!,'check.ts','check-first','new',f.deps,{base:f.base,freeGB:64});
 beginSessionAttempt({account:f.names[0]!,server:'rs-sdk-demo.fly.dev'},{root:join(f.prac,'session-lifecycle')});
 await expect(awaitRecoveryInstallPreflight(f.tasks[1]!,f.names[1]!,'check.ts',f.tasks[1]!.id,'new',f.deps,retained,f.base,'new',30)).resolves.toBeDefined();
});

test('a missing peer logout or owner pause leaves the whole retired assignment disabled',async()=>{
 const f=fixture(),retained=f.prepare(0);f.confirm(0);
 await expect(awaitRecoveryInstallPreflight(f.tasks[0]!,f.names[0]!,'check.ts',f.tasks[0]!.id,'new',f.deps,retained,f.base,'new',10)).rejects.toThrow('still lacks confirmed logout');
 expect(readCoordinatorJobs(f.base).jobs).toEqual([f.job]);
 writeFileSync(join(f.prac,'stop-'+f.names[1]),'owner pause');
 await expect(awaitRecoveryInstallPreflight(f.tasks[0]!,f.names[0]!,'check.ts',f.tasks[0]!.id,'new',f.deps,retained,f.base,'new',10)).rejects.toThrow('owner stopped');
 expect(readCoordinatorJobs(f.base).jobs).toEqual([f.job]);
});

test('retired cohort inference refuses active, stopped, unowned and mismatched work without changing assignments',()=>{
 for(const cause of ['enabled','unowned','receipt','running','stop','lease','failure']){
  const f=fixture();
  if(cause==='enabled'||cause==='unowned')writeCoordinatorJobs(f.base,{...emptyCoordinatorJobs(),jobs:[{...f.job,...(cause==='enabled'?{enabled:true}:{coordinatorOwner:'other'})}]});
  if(cause==='receipt')atomicJson(join(f.prac,'coordinator/runs/task-retired/receipt.json'),{taskId:'wrong',runId:'task-retired',ok:false});
  if(cause==='running')atomicJson(join(f.prac,'swarm-runs.json'),[{accounts:[f.names[1]],pid:process.pid}]);
  if(cause==='stop')writeFileSync(join(f.prac,'stop-'+f.names[1]),'owner pause');
  if(cause==='lease'){const path=join(f.prac,'coordinator/session-recovery/accounts',f.names[1]!.toLowerCase());mkdirSync(path,{recursive:true});writeFileSync(join(path,'lease.json'),'owned');}
  if(cause==='failure')f.tasks[0]!.sessionRecovery!.endedAt=99;
  const before=readFileSync(join(f.prac,'coordinator/jobs.json'),'utf8'),ends=readFileSync(join(f.prac,'swarm-deaths.json'),'utf8');
  expect(()=>f.prepare(0)).toThrow();expect(readFileSync(join(f.prac,'coordinator/jobs.json'),'utf8')).toBe(before);
  expect(readFileSync(join(f.prac,'swarm-deaths.json'),'utf8')).toBe(ends);
 }
});

test('ordinary failure-clear waits for the authenticated request to release the same repair slot',async()=>{
 const f=fixture(),file=join(f.prac,'swarm-repair.json');f.confirm(1);
 let authenticated=false,controllerFailure:unknown;
 const timer=setInterval(()=>{
  if(!existsSync(file))return;
  try{
   const raw=readFileSync(file,'utf8'),r=JSON.parse(raw);
   if(r.kind==='session-recovery'){f.confirm(0);authenticated=true;unlinkSync(file);appendFileSync(file+'.results.jsonl',JSON.stringify({raw,result:{sessionRecovered:true}})+'\n');}
   else{expect(authenticated).toBe(true);atomicJson(join(f.prac,'swarm-deaths.json'),{Ballspinner:{at:1,reason:'disconnected'}});unlinkSync(file);}
  }catch(error){controllerFailure=error;}
 },5);
 try{
  const auth=requestAuthenticatedRecovery(f.tasks[0]!,f.deps,'new',f.tasks[0]!.id,f.base,2000,'new',async()=>{f.prepare(0);});
  await Bun.sleep(5);
  await Promise.all([auth,requestLiveRecovery({account:f.names[1]!,endedAt:2},f.tasks[1]!.id,f.base,2000)]);
  if(controllerFailure)throw controllerFailure;
  expect(authenticated).toBe(true);expect(existsSync(file+'.lease')).toBe(false);
 }finally{clearInterval(timer);}
},10000);
