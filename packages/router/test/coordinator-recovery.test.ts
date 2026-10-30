import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync,renameSync,unlinkSync} from 'node:fs';
import {applyEndRepair,loadEnded,persistEnded} from '../../../scripts/swarm';
import {beginSessionAttempt,readLogoutProof,verifyLegacyLogout} from '../../core/src/session-lifecycle';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialState,addTasks,startTask,chooseTask,validateTask} from '../src/coordinator';
import {atomicJson,saveState,loadState,runDirectory} from '../src/coordinator-store';
import {reconcile} from '../src/coordinator-cli';
import {acceptProposal,parseModelObject} from '../src/coordinator-planner';
import {replaceAssignments,prepareLiveRecovery,requestLiveRecovery,requestAuthenticatedRecovery,installJob,awaitControllerDrain,ensureSwarm,preserveCompletedLiveEnd} from '../src/coordinator-live';
import type {CoordTask} from '../src/coordinator';
const seed=()=>{const s=initialState();addTasks(s,[{id:'producer',goal:'skills',kind:'qualify',capability:'wine-order',dependsOn:[],priority:2,estimatedMs:1,why:'native producer'},{id:'consumer',goal:'gear',kind:'qualify',capability:'ammo-order',dependsOn:['producer'],priority:2,estimatedMs:1,why:'next useful consumer'}]);startTask(s,'producer',Date.now()-20000,'recovery-run');return s;};
function recoveryFixture(){
 const base=mkdtempSync(join(tmpdir(),'live-repair-')),run='test-run',prac=join(base,'.practice');
 mkdirSync(join(prac,'status'),{recursive:true});mkdirSync(join(prac,'coordinator/runs',run),{recursive:true});
 atomicJson(join(base,'swarm.json'),{minFreeGB:0,maxBots:17,jobs:[{account:'Mightyrod',script:'old.ts',enabled:true,repeat:true},{account:'Other',script:'keep.ts',enabled:true}]});
 atomicJson(join(prac,'swarm-deaths.json'),{Mightyrod:{at:1,reason:'blocked after 1 runs',revision:JSON.stringify(['old.ts',false,['mightyrod'],[]])}});
 atomicJson(join(prac,'status/Mightyrod.json'),{name:'Mightyrod',server:'rs-sdk-demo.fly.dev',result:'ok prior observed run'});
 beginSessionAttempt({account:'Mightyrod',server:'rs-sdk-demo.fly.dev'},{root:join(prac,'session-lifecycle')}).record('ended','logged-out');
 const task:CoordTask={id:'pilot',goal:'gear',kind:'run',capability:'shark-supply-order',account:'Mightyrod',dependsOn:[],priority:1,estimatedMs:1,why:'finite pilot',repairs:[{account:'Mightyrod',endedAt:1}]};
 const deps={build:{delivery:{id:task.capability,stage:'delivered',ok:true,at:2,runtimeRevision:'new'}}};
 return{base,run,prac,task,deps,prepare:()=>prepareLiveRecovery(task,'Mightyrod','new.ts',run,'new',deps,base)};
}
function authenticatedFixture(){
 const f=recoveryFixture();f.task.sessionRecovery={account:'Mightyrod',endedAt:1};f.task.accept={counters:{cooked:25}};
 const directory=join(f.prac,'deliveries/native');mkdirSync(directory,{recursive:true});
 const out=join(directory,'gate.out.log');writeFileSync(out,'RECOVERY_NATIVE_PROOF '+JSON.stringify({path:join(directory,'proof.json'),sha256:'0'.repeat(64)})+'\n');
 const delivery={...f.deps.build.delivery,directory,source:'fixture',checks:[{id:'native-session-recovery',phase:'practice',exitCode:0,detail:JSON.stringify({stdout:out})}]};
 writeFileSync(join(directory,'report.json'),JSON.stringify(delivery));Object.assign(f.deps.build.delivery,delivery);return f;
}

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
 const before=readFileSync(join(f.prac,'swarm-deaths.json'),'utf8');expect(f.prepare).not.toThrow();
 expect(JSON.parse(readFileSync(join(f.base,'swarm.json'),'utf8')).jobs[0].enabled).toBe(false);
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
 for(const scenario of ['lock','repair-lease','pending','processing','busy','source','paused','pause-before-spawn','pause-after-start','ack-failed','ack-unconfirmed','foreign-finally','success']){
  const f=recoveryFixture(),dir=join(f.prac,'coordinator'),lock=join(dir,'build-lock.json'),lease=join(f.prac,'swarm-repair.json.lease'),ownerFile=join(dir,'swarm-owner.json');
  const old={pid:11,nonce:'old-controller',source:'old'},live=new Set([11]),events:string[]=[];let current='new';
  atomicJson(ownerFile,old);const foreign={pid:999,runId:'other-owner'};
  if(scenario==='lock')atomicJson(lock,foreign);if(scenario==='repair-lease')atomicJson(lease,foreign);
  if(scenario==='paused')writeFileSync(join(f.prac,'stop-swarm'),'owner pause');
  if(scenario==='pending'||scenario==='processing')writeFileSync(join(f.prac,'swarm-repair.json'+(scenario==='processing'?'.processing':'')),'owned request');
  const deps={base:f.base,currentSource:()=>current,matches:(pid:number,_nonce:string)=>live.has(pid),pidExists:(pid:number)=>live.has(pid),processes:()=>[...live],rows:()=>[],now:()=>1000,
   stop:async(pid:number,nonce:string)=>{events.push('stop:'+pid+':'+nonce);if(scenario==='ack-unconfirmed'&&pid===22)return false;live.delete(pid);return true;},
   spawn:(_source:string,_nonce:string)=>{events.push('spawn');live.add(22);if(scenario==='foreign-finally')atomicJson(lock,foreign);return 22;},
   drain:async(owner:{pid:number},_after:number)=>{events.push('drain:'+owner.pid);if(scenario==='busy'&&owner.pid===11)throw Error('owned sessions');if(scenario==='source'&&owner.pid===11)current='changed';
    if(scenario==='pause-before-spawn'&&owner.pid===11||scenario==='pause-after-start'&&owner.pid===22)writeFileSync(join(f.prac,'stop-swarm'),'owner pause');
    if(['ack-failed','ack-unconfirmed'].includes(scenario)&&owner.pid===22)throw Error('new acknowledgement missing');}};
  const action=ensureSwarm('new',deps);
  if(['success','foreign-finally'].includes(scenario))await action;else await expect(action).rejects.toThrow();
  if(['lock','repair-lease','pending','processing','busy','source','paused','pause-before-spawn'].includes(scenario))expect(events).not.toContain('spawn');
  if(scenario==='lock')expect(JSON.parse(readFileSync(lock,'utf8'))).toEqual(foreign);
  else if(scenario==='ack-unconfirmed'){
   expect(JSON.parse(readFileSync(lock,'utf8')).pid).toBe(22);expect(live.has(22)).toBe(true);
   await expect(ensureSwarm('new',deps)).rejects.toThrow('remains fenced');
  }else if(scenario==='foreign-finally')expect(JSON.parse(readFileSync(lock,'utf8'))).toEqual(foreign);
  else expect(existsSync(lock)).toBe(false);
  if(scenario==='repair-lease')expect(JSON.parse(readFileSync(lease,'utf8'))).toEqual(foreign);else expect(existsSync(lease)).toBe(false);
  if(scenario==='ack-failed'||scenario==='pause-after-start'){expect(live.has(22)).toBe(false);expect(existsSync(ownerFile)).toBe(false);expect(events.some(e=>e.startsWith('stop:22:'))).toBe(true);}
  if(scenario==='pending'||scenario==='processing')expect(readFileSync(join(f.prac,'swarm-repair.json'+(scenario==='processing'?'.processing':'')),'utf8')).toBe('owned request');
 }
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
 const f=recoveryFixture();f.prepare();const plan=JSON.parse(readFileSync(join(f.base,'swarm.json'),'utf8'));
 expect(plan.jobs[0]).toMatchObject({account:'Mightyrod',enabled:false,repeat:true,script:'old.ts'});expect(plan.jobs[1].enabled).toBe(true);
 expect(JSON.parse(readFileSync(join(f.prac,'swarm-deaths.json'),'utf8')).Mightyrod.at).toBe(1);
 const proof=JSON.parse(readFileSync(join(f.prac,'coordinator/runs',f.run,'recovery-before.json'),'utf8'));expect(proof.assignments[0].enabled).toBe(true);expect(proof.ended.Mightyrod.at).toBe(1);
});
test('same-script repair refuses before spending the failure or disabling the old assignment',()=>{
 const f=recoveryFixture(),path=join(f.base,'swarm.json'),before=readFileSync(path,'utf8');
 expect(()=>prepareLiveRecovery(f.task,'Mightyrod','./old.ts',f.run,'new',f.deps,f.base)).toThrow('same-script');
 expect(readFileSync(path,'utf8')).toBe(before);expect(loadEnded(join(f.prac,'swarm-deaths.json')).get('Mightyrod')?.at).toBe(1);
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
 const controller=(async()=>{await Bun.sleep(20);expect(JSON.parse(readFileSync(join(f.base,'swarm.json'),'utf8')).jobs[0].enabled).toBe(false);
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
 const deps = { base: f.base, currentSource: () => 'new', matches: (pid: number) => live.has(pid), pidExists: (pid: number) => live.has(pid), processes: () => [...live], now: () => 1000,
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
