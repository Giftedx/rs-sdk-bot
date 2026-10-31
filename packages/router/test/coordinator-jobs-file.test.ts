import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrateCoordinatorJobs,currentRevision,REVISION_FRESH_MS} from '../src/coordinator-cli';
import {disableOwnJob,ensureSwarm,controllerStateFresh,CONTROLLER_STATE_FRESH_MS} from '../src/coordinator-live';
import {atomicJson,saveState,loadState} from '../src/coordinator-store';
import {initialState,addTasks} from '../src/coordinator';
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
