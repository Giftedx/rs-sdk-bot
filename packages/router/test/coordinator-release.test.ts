import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beginSessionAttempt} from '../../core/src/session-lifecycle';
import {atomicJson} from '../src/coordinator-store';
import {installJob,releaseCompletedOwnJobs,releaseFinishedOwnJobs} from '../src/coordinator-live';
import {readCoordinatorJobs,readMergedPlan,writeCoordinatorJobs} from '../../core/src/coordinator-jobs';
import type {CoordTask} from '../src/coordinator';
import {parseJob} from '../../../scripts/swarm';

const server='rs-sdk-demo.fly.dev';
const handoff={accounts:['BowBeforeMe','Shaftmaker'],orchestrate:true,script:'handoff.ts',enabled:false,repeat:false,coordinatorOwner:'coordinator',coordinatorTask:'run-handoff',env:{COORDINATOR_RUN_ID:'run-1'}};
const magic:CoordTask={id:'run-magic',goal:'skills',kind:'run',capability:'magic-order',account:'Shaftmaker',dependsOn:[],priority:1,estimatedMs:1,why:'single-account consumer of the handoff'};
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'coordinator-release-')),prac=join(base,'.practice');
 mkdirSync(join(prac,'status'),{recursive:true});for(const run of ['run-1','run-2'])mkdirSync(join(prac,'coordinator/runs',run),{recursive:true});
 atomicJson(join(base,'swarm.json'),{minFreeGB:0,maxBots:17,jobs:[{account:'BowBeforeMe',script:'bow.ts',enabled:true,repeat:true}]});
 atomicJson(join(prac,'swarm-deaths.json'),{});
 atomicJson(join(prac,'coordinator/runs/run-1/receipt.json'),{taskId:'run-handoff',runId:'run-1',ok:true,at:1});
 for(const account of handoff.accounts)beginSessionAttempt({account,server},{root:join(prac,'session-lifecycle')}).record('ended','logged-out');
 writeCoordinatorJobs(base,{jobs:[handoff],coordination:{}});
 return{base,prac,install:()=>installJob(magic,'Shaftmaker','magic.ts','run-2','src',{},{base,freeGB:100})};
}

test('a completed composed job releases the run account; the unused partner stays shadowed by a disabled job',()=>{
 const f=fixture();
 f.install();
 const jobs=readCoordinatorJobs(f.base).jobs;
 expect(jobs[0]).toEqual({account:'BowBeforeMe',script:'handoff.ts',enabled:false,repeat:false,coordinatorOwner:'coordinator',coordinatorTask:'run-handoff',env:{COORDINATOR_RUN_ID:'run-1'}});
 expect(parseJob(jobs[0])).toMatchObject({accounts:['BowBeforeMe'],host:false});
 expect(jobs[1]).toMatchObject({account:'Shaftmaker',script:'magic.ts',enabled:true,coordinatorTask:'run-magic',env:{COORDINATOR_RUN_ID:'run-2'}});
 expect(readMergedPlan(f.base).jobs.find((j:any)=>j.script==='bow.ts')).toBeUndefined();
});

test('a failed but settled composed job releases its run account; a missing receipt still refuses',()=>{
 const released=fixture();
 atomicJson(join(released.prac,'coordinator/runs/run-1/receipt.json'),{taskId:'run-handoff',runId:'run-1',ok:false,at:1});
 released.install();
 const jobs=readCoordinatorJobs(released.base).jobs;
 expect(jobs[0]).toEqual({account:'BowBeforeMe',script:'handoff.ts',enabled:false,repeat:false,coordinatorOwner:'coordinator',coordinatorTask:'run-handoff',env:{COORDINATOR_RUN_ID:'run-1'}});
 expect(jobs[1]).toMatchObject({account:'Shaftmaker',script:'magic.ts',enabled:true,coordinatorTask:'run-magic',env:{COORDINATOR_RUN_ID:'run-2'}});
 const missing=fixture();
 rmSync(join(missing.prac,'coordinator/runs/run-1/receipt.json'));
 expect(missing.install).toThrow('a composed assignment needs all its participants');
});

test('the composed job keeps its ownership when the receipt is missing or unreadable, a participant still runs or a logout is unconfirmed',()=>{
 for(const cause of ['other-task','running','runs-unreadable','logout','active']){
  const f=fixture();
  if(cause==='other-task')atomicJson(join(f.prac,'coordinator/runs/run-1/receipt.json'),{taskId:'other',runId:'run-1',ok:true,at:1});
  if(cause==='running')atomicJson(join(f.prac,'swarm-runs.json'),[{key:'k',accounts:['BowBeforeMe'],log:'x',offset:0}]);
  if(cause==='runs-unreadable')atomicJson(join(f.prac,'swarm-runs.json'),{not:'a list'});
  if(cause==='logout')beginSessionAttempt({account:'BowBeforeMe',server},{root:join(f.prac,'session-lifecycle')});
  if(cause==='active')writeCoordinatorJobs(f.base,{jobs:[{...handoff,enabled:true}],coordination:{}});
  const before=readCoordinatorJobs(f.base);
  expect(f.install).toThrow('a composed assignment needs all its participants');
  expect(readCoordinatorJobs(f.base)).toEqual(before);
 }
});

test('owner, held and unrelated jobs pass through the release unchanged',()=>{
 const f=fixture();
 const owner={accounts:['BowBeforeMe','Shaftmaker'],orchestrate:true,script:'owner.ts',enabled:false};
 const held={...handoff,coordinatorOwner:undefined};
 const other={...handoff,accounts:['Other'],orchestrate:undefined};
 const own={jobs:[owner,held,other],coordination:{}};
 expect(releaseCompletedOwnJobs(own,['Shaftmaker'],f.base)).toEqual(own);
});

test('the release pass gives each account of a finished job back to the owner plan and writes the file',async()=>{
 const f=fixture();
 expect(readMergedPlan(f.base).jobs.find((j:any)=>j.script==='bow.ts')).toBeUndefined();
 expect(await releaseFinishedOwnJobs(f.base)).toEqual(['BowBeforeMe','Shaftmaker']);
 expect(readCoordinatorJobs(f.base).jobs).toEqual([]);
 expect(readMergedPlan(f.base).jobs).toEqual([{account:'BowBeforeMe',script:'bow.ts',enabled:true,repeat:true}]);
 // Nothing is left to release: the pass names no account and does not write the file again.
 const file=join(f.prac,'coordinator/jobs.json'),written=statSync(file).mtimeMs,bytes=readFileSync(file,'utf8');
 expect(await releaseFinishedOwnJobs(f.base)).toEqual([]);
 expect(statSync(file).mtimeMs).toBe(written);expect(readFileSync(file,'utf8')).toBe(bytes);
});

test('the release pass releases the partner that an install left parked, and keeps the job of the new run',async()=>{
 const f=fixture();
 f.install();
 expect(await releaseFinishedOwnJobs(f.base)).toEqual(['BowBeforeMe']);
 const jobs=readCoordinatorJobs(f.base).jobs;
 expect(jobs).toHaveLength(1);
 expect(jobs[0]).toMatchObject({account:'Shaftmaker',script:'magic.ts',enabled:true,coordinatorTask:'run-magic'});
 expect(readMergedPlan(f.base).jobs.find((j:any)=>j.script==='bow.ts')).toMatchObject({account:'BowBeforeMe',enabled:true});
});

test('the release pass keeps each job that is not finished and settled, and the other parts of the file',async()=>{
 const f=fixture(),root=join(f.prac,'session-lifecycle');
 const own=(account:string,run:string,more:object={})=>({account,script:'session-check.ts',enabled:false,repeat:false,coordinatorOwner:'coordinator',coordinatorTask:'task-'+run,env:{COORDINATOR_RUN_ID:run},...more});
 const receipt=(run:string,ok:boolean)=>{mkdirSync(join(f.prac,'coordinator/runs',run),{recursive:true});atomicJson(join(f.prac,'coordinator/runs',run,'receipt.json'),{taskId:'task-'+run,runId:run,ok,at:1});};
 const loggedOut=(account:string)=>beginSessionAttempt({account,server},{root}).record('ended','logged-out');
 for(const [run,ok] of [['run-done',true],['run-failed',false],['run-active',true],['run-swarm',true],['run-session',true]] as const)receipt(run,ok);
 for(const account of ['Done','Failed','Active','NoReceipt','InSwarm','Parked'])loggedOut(account);
 // The session of this account has no confirmed logout.
 beginSessionAttempt({account:'OpenSession',server},{root});
 atomicJson(join(f.prac,'swarm-runs.json'),[{key:'k',accounts:['InSwarm'],log:'x',offset:0}]);
 const kept=[own('Active','run-active',{enabled:true}),own('NoReceipt','run-none'),own('InSwarm','run-swarm'),own('OpenSession','run-session'),
  // An owner job that a recovery parked: it names no coordinator task.
  {account:'Parked',script:'goldfarm.ts',enabled:false,standing:true,coordinatorOwner:'coordinator'}];
 writeCoordinatorJobs(f.base,{jobs:[own('Done','run-done'),...kept.slice(0,2),own('Failed','run-failed'),...kept.slice(2)],coordination:{focusCapability:'cap'},paused:['Swordinhand'],expansion:{maxBots:18,over:17}});
 expect(await releaseFinishedOwnJobs(f.base)).toEqual(['Done','Failed']);
 expect(readCoordinatorJobs(f.base)).toEqual({jobs:kept,coordination:{focusCapability:'cap'},paused:['Swordinhand'],expansion:{maxBots:18,over:17}});
 // A list of swarm runs that does not read: no job is known as idle, so nothing goes.
 writeCoordinatorJobs(f.base,{jobs:[own('Done','run-done')],coordination:{}});
 atomicJson(join(f.prac,'swarm-runs.json'),{not:'a list'});
 expect(await releaseFinishedOwnJobs(f.base)).toEqual([]);
 expect(readCoordinatorJobs(f.base).jobs).toEqual([own('Done','run-done')]);
});
