import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrateCoordinatorJobs,currentRevision,REVISION_FRESH_MS,plannerDue,rulePassDue} from '../src/coordinator-cli';
import {disableOwnJob,ensureSwarm,controllerStateFresh,CONTROLLER_STATE_FRESH_MS} from '../src/coordinator-live';
import {atomicJson,saveState,loadState} from '../src/coordinator-store';
import {initialState,addTasks,startTask,finishTask,type CoordTask} from '../src/coordinator';
import {readCoordinatorJobs,readMergedPlan,writeCoordinatorJobs,coordinatorJobsPath} from '../../core/src/coordinator-jobs';

const owner=[{account:'Haggis',script:'',goal:'main simultaneous24 fresh clock',enabled:false},{accounts:['A','B'],host:true,script:'host.ts',enabled:true,standing:true}];
const coordinatorJob=(account:string,runId:string,enabled=true)=>({account,script:'run.ts',enabled,repeat:false,coordinatorOwner:'coordinator',coordinatorTask:'t-'+account,env:{COORDINATOR_RUN_ID:runId}});
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'coordinator-jobs-file-'));mkdirSync(join(base,'.practice/coordinator'),{recursive:true});return base;
}
test('migration moves coordinator jobs and focus settings out of swarm.json once; owner jobs keep their order and the file its newline',()=>{
 const base=fixture(),path=join(base,'swarm.json');
 const plan={maxBots:17,minFreeGB:4,jobs:[owner[0],coordinatorJob('Rod','run-1'),owner[1],coordinatorJob('Cod','run-2',false)],coordination:{enabled:true,maxLive:17,focusCapability:'wine-order',focusSince:5,lastExpansionAt:9,directive:'go'}};
 writeFileSync(path,JSON.stringify(plan,null,2)+'\n');
 expect(migrateCoordinatorJobs(base)).toEqual({jobs:2,settings:['focusCapability','focusSince','lastExpansionAt'],file:'.practice/coordinator/jobs.json'});
 const after=readFileSync(path,'utf8');
 expect(after.endsWith('\n')).toBe(true);
 expect(JSON.parse(after)).toEqual({maxBots:17,minFreeGB:4,jobs:owner,coordination:{enabled:true,maxLive:17,directive:'go'}});
 expect(readCoordinatorJobs(base)).toEqual({jobs:[coordinatorJob('Rod','run-1'),coordinatorJob('Cod','run-2',false)],coordination:{focusCapability:'wine-order',focusSince:5,lastExpansionAt:9}});
 // The merged plan is the plan the swarm ran before the move.
 expect(readMergedPlan(base)).toMatchObject({maxBots:17,coordination:{enabled:true,focusCapability:'wine-order',focusSince:5,lastExpansionAt:9}});
 expect(readMergedPlan(base).jobs.map((j:any)=>j.account??j.accounts.join('+'))).toEqual(['Haggis','A+B','Rod','Cod']);
 expect(migrateCoordinatorJobs(base)).toBeNull();
 expect(readFileSync(path,'utf8')).toBe(after);
});
test('disabling an own job touches only the coordinator file',async()=>{
 const base=fixture(),path=join(base,'swarm.json'),raw=JSON.stringify({maxBots:17,minFreeGB:4,jobs:owner},null,2)+'\n';
 writeFileSync(path,raw);writeCoordinatorJobs(base,{jobs:[coordinatorJob('Rod','run-1'),coordinatorJob('Cod','run-2')],coordination:{}});
 await disableOwnJob('run-1',base);
 expect(readCoordinatorJobs(base).jobs.map((j:any)=>j.enabled)).toEqual([false,true]);
 expect(readFileSync(path,'utf8')).toBe(raw);
 expect(existsSync(join(base,'.practice/coordinator/plan-write-lock.json'))).toBe(false);
});
test('a fresh controller state under the saved pid and nonce replaces the command-line probe',async()=>{
 const base=fixture(),dir=join(base,'.practice/coordinator'),owner={pid:process.pid,nonce:'controller',source:'new',swarmSource:'stale',detached:true};
 writeFileSync(join(base,'swarm.json'),JSON.stringify({maxBots:17,minFreeGB:4,jobs:[]}));
 atomicJson(join(dir,'swarm-owner.json'),owner);atomicJson(join(dir,'rollout-backoff.json'),{until:5000});
 atomicJson(join(base,'.practice/swarm-state.json'),{at:1000,controllerPid:process.pid,coordinatorOwner:'controller'});
 expect(controllerStateFresh(owner,base,1000+CONTROLLER_STATE_FRESH_MS-1)).toBe(true);
 expect(controllerStateFresh(owner,base,1000+CONTROLLER_STATE_FRESH_MS)).toBe(false);
 expect(controllerStateFresh({pid:process.pid,nonce:'other'},base,1000)).toBe(false);
 expect(controllerStateFresh(owner,base,999)).toBe(false);
 let probes=0;
 const deps={base,currentSource:()=>'new',matches:()=>{probes++;return false;},pidExists:(pid:number)=>pid===process.pid,now:()=>1000,processes:()=>{throw Error('no rollout');}};
 await ensureSwarm('new',deps as any,false);
 expect(probes).toBe(0);
 // A stale state falls back to the probe, whose answer stands.
 atomicJson(join(base,'.practice/swarm-state.json'),{at:1000-CONTROLLER_STATE_FRESH_MS,controllerPid:process.pid,coordinatorOwner:'controller'});
 await expect(ensureSwarm('new',deps as any,false)).rejects.toThrow('command ownership is unknown');
 expect(probes).toBe(1);
});
test('a standing rollout pauses and resumes jobs through the coordinator file; swarm.json keeps its bytes',async()=>{
 const base=fixture(),dir=join(base,'.practice/coordinator'),path=join(base,'swarm.json'),raw=JSON.stringify({maxBots:17,minFreeGB:4,jobs:owner},null,2)+'\n';
 writeFileSync(path,raw);mkdirSync(join(base,'.practice/status'),{recursive:true});
 atomicJson(join(dir,'swarm-owner.json'),{pid:11,nonce:'old',source:'new',swarmSource:'stale',detached:false});
 const deps={base,currentSource:()=>'new',matches:(pid:number)=>pid===11,pidExists:(pid:number)=>pid===11,processes:()=>[11],now:()=>1000,
  rows:()=>[{server:'rs-sdk-demo.fly.dev',name:'a',at:1000}],drain:async()=>{throw Error('no drain while a session is open');}};
 await expect(ensureSwarm('new',deps as any,false)).rejects.toThrow('waits for existing sessions');
 expect(JSON.parse(readFileSync(join(dir,'rollout-paused.json'),'utf8'))).toEqual(['A','B']);
 expect(readCoordinatorJobs(base).paused).toEqual(['a','b']);
 expect(readMergedPlan(base).jobs[1]).toMatchObject({accounts:['A','B'],standing:true,enabled:false});
 expect(readFileSync(path,'utf8')).toBe(raw);
 // The backoff keeps the running controller; the paused jobs resume.
 atomicJson(join(dir,'rollout-backoff.json'),{until:5000});
 await ensureSwarm('new',deps as any,false);
 expect(existsSync(join(dir,'rollout-paused.json'))).toBe(false);
 expect(readCoordinatorJobs(base).paused).toBeUndefined();
 expect(readMergedPlan(base).jobs[1].enabled).toBe(true);
 expect(readFileSync(path,'utf8')).toBe(raw);
});
test('the runtime revision is computed once per freshness window',()=>{
 let computed=0;const compute=()=>{computed++;return 'r'+computed;};
 expect(currentRevision(1000,compute)).toBe('r1');expect(currentRevision(1000+REVISION_FRESH_MS-1,compute)).toBe('r1');
 expect(currentRevision(1000+REVISION_FRESH_MS,compute)).toBe('r2');expect(currentRevision(999,compute)).toBe('r3');
 expect(computed).toBe(3);
});
test('an unchanged state is not rewritten',()=>{
 const dir=mkdtempSync(join(tmpdir(),'coord-state-')),state=initialState(),file=join(dir,'state.json');
 expect(saveState(state,dir)).toBe(true);expect(existsSync(file+'.previous')).toBe(false);
 const bytes=readFileSync(file,'utf8');
 expect(saveState(state,dir)).toBe(false);expect(existsSync(file+'.previous')).toBe(false);expect(readFileSync(file,'utf8')).toBe(bytes);
 addTasks(state,[{id:'one',goal:'skills',kind:'qualify',capability:'wine-order',dependsOn:[],priority:1,estimatedMs:1,why:'change'}]);
 expect(saveState(state,dir)).toBe(true);expect(readFileSync(file+'.previous','utf8')).toBe(bytes);
 expect(loadState(dir).tasks).toHaveLength(1);
});
import {compactState,replaceTasks,ARCHIVE_AFTER_MS,type TaskRecord} from '../src/coordinator';
import {archiveFinishedTasks,plannerState} from '../src/coordinator-cli';
const record=(id:string,status:TaskRecord['status'],at:number,spec:Partial<TaskRecord['spec']>={}):TaskRecord=>({
 spec:{id,goal:'skills',kind:'qualify',capability:'wine-order',dependsOn:[],priority:1,estimatedMs:1,why:'t',...spec},status,createdAt:at,attempts:1,
 ...(status==='pending'?{}:{startedAt:at,runId:'task-'+id,receipt:{taskId:id,runId:'task-'+id,ok:status==='succeeded',at,output:{big:'x'.repeat(100)}}})});
test('old finished tasks leave the state except those open tasks name and the newest of each capability and kind',()=>{
 const day=24*60*60*1000,now=10*day,state=initialState();
 state.tasks=[
  record('old-fail',  'failed',   now-5*day),
  record('old-ok',    'succeeded',now-4*day),
  record('named-ok',  'succeeded',now-6*day,{capability:'ammo-order'}),
  record('newest-ammo','failed',  now-3*day,{capability:'ammo-order'}),
  record('old-build', 'failed',   now-5*day,{kind:'build'}),
  record('new-build', 'failed',   now-4*day,{kind:'build'}),
  record('young-fail','failed',   now-1*day),
  record('supers',    'superseded',now-9*day,{capability:'fish-order'}),
  record('supers2',   'superseded',now-8*day,{capability:'fish-order'}),
  record('provider',  'succeeded',now-7*day,{kind:'provision',capability:undefined}),
  record('consumer',  'pending',  now-7*day,{kind:'run',dependsOn:['named-ok'],accountFrom:'provider'}),
 ];
 const archived=compactState(state,now);
 expect(archived.map(r=>r.spec.id)).toEqual(['supers','old-fail','old-build','old-ok']);
 expect(state.tasks.map(r=>r.spec.id)).toEqual(['named-ok','newest-ammo','new-build','young-fail','supers2','provider','consumer']);
 expect(compactState(state,now)).toEqual([]);
 expect(compactState(state,now+ARCHIVE_AFTER_MS)).toEqual([]);
});
test('archived tasks append to the archive file and the state shrinks; a planner input names the state file',()=>{
 const dir=mkdtempSync(join(tmpdir(),'coord-archive-')),day=24*60*60*1000,now=10*day,state=initialState();
 state.tasks=[record('a','failed',now-5*day),record('b','failed',now-4*day),record('c','failed',now-3*day)];
 expect(archiveFinishedTasks(state,now,dir)).toBe(2);
 const lines=readFileSync(join(dir,'archive/tasks.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
 expect(lines.map(r=>r.spec.id)).toEqual(['a','b']);expect(state.tasks.map(r=>r.spec.id)).toEqual(['c']);
 expect(archiveFinishedTasks(state,now,dir)).toBe(0);
 saveState(state,dir);
 expect(plannerState({statePath:join(dir,'state.json')}).tasks.map(r=>r.spec.id)).toEqual(['c']);
 expect(plannerState({state}).tasks).toBe(state.tasks);
 expect(()=>plannerState({})).toThrow('names no state');
});
test('a replacement plan ignores archived dependencies of finished tasks but still refuses them for open tasks',()=>{
 const day=24*60*60*1000,now=10*day,state=initialState();
 state.tasks=[
  record('kept-build','succeeded',now-1*day,{kind:'build',dependsOn:['archived-build']}),
  record('old-run','failed',now-1*day,{kind:'run',account:'Rod'}),
  record('new-run','pending',now,{kind:'run',account:'Rod'}),
  record('waiter','pending',now,{kind:'run',capability:'ammo-order',dependsOn:['old-run']}),
 ];
 expect(()=>replaceTasks(state,[{from:'old-run',to:'new-run'}])).not.toThrow();
 expect(state.tasks.find(r=>r.spec.id==='waiter')!.spec.dependsOn).toEqual(['new-run']);
 state.tasks.push(record('broken','pending',now,{kind:'run',capability:'fish-order',dependsOn:['archived-build']}));
 expect(()=>replaceTasks(state,[])).toThrow('missing replacement dependency');
});

test('a late receipt triggers a new planning pass even with an older timestamp', () => {
 const state = initialState();
 addTasks(state, [
  {id:'older',kind:'qualify',goal:'quests',capability:'quest-order',dependsOn:[],priority:1,estimatedMs:1000,why:'Prove a quest worker'},
  {id:'newer',kind:'qualify',goal:'quests',capability:'quest-order',dependsOn:[],priority:1,estimatedMs:1000,why:'Prove a quest worker'},
 ], 0);
 startTask(state, 'older', 1000, 'older');
 startTask(state, 'newer', 2000, 'newer');
 expect(finishTask(state, {taskId:'newer',runId:'newer',ok:true,at:4000,output:null})).toBe(true);
 const firstReceiptSequence = state.latestReceiptSequence;
 expect(firstReceiptSequence).toBe(state.sequence);
 state.plannerReceiptSequence = firstReceiptSequence;
 state.planner = {runId:'planner', startedAt:5000};
 expect(plannerDue(state, 7000, 0, false)).toBe(false);
 expect(finishTask(state, {taskId:'older',runId:'older',ok:false,at:3000,output:null})).toBe(true);
 expect(state.latestReceiptSequence).toBe(state.sequence);
 expect(state.latestReceiptSequence!).toBeGreaterThan(firstReceiptSequence!);
 expect(plannerDue(state, 7000, 0, false)).toBe(false);
 delete state.planner;
 state.lastPlanAt = 7000;
 expect(plannerDue(state, 7500, 0, false)).toBe(false);
 expect(plannerDue(state, 8001, 0, false)).toBe(true);
 state.plannerReceiptSequence = state.latestReceiptSequence;
 expect(plannerDue(state, 9000, 0, false)).toBe(false);
 expect(plannerDue(state, 9000, 0, true)).toBe(true);
});

test('rules notice a new receipt even when archive and settlement leave the same count', () => {
 const state=initialState();
 const spec=(id:string):CoordTask=>({id,kind:'qualify',goal:'quests',capability:'quest-order',dependsOn:[],
  priority:1,estimatedMs:1000,why:'Prove the quest worker'});
 const settle=(id:string,at:number)=>{
  addTasks(state,[spec(id)],at-2);
  startTask(state,id,at-1,id);
  expect(finishTask(state,{taskId:id,runId:id,ok:true,at,output:null})).toBe(true);
 };
 settle('old-proof',2);
 settle('recent-proof',4);
 const previous={at:10,receiptSequence:state.latestReceiptSequence!};
 expect(rulePassDue(state,previous,10)).toBe(false);
 expect(compactState(state,10,1).map(r=>r.spec.id)).toEqual(['old-proof']);
 expect(rulePassDue(state,previous,10)).toBe(false);
 settle('fresh-proof',12);
 expect(state.tasks.filter(r=>r.receipt)).toHaveLength(2);
 expect(rulePassDue(state,previous,12)).toBe(true);
 const current={at:12,receiptSequence:state.latestReceiptSequence!};
 expect(rulePassDue(state,current,300011)).toBe(false);
 expect(rulePassDue(state,current,300012)).toBe(true);
});
