import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beginSessionAttempt} from '../../core/src/session-lifecycle';
import {atomicJson} from '../src/coordinator-store';
import {installJob,releaseCompletedOwnJobs} from '../src/coordinator-live';
import {readCoordinatorJobs,readMergedPlan,writeCoordinatorJobs} from '../../core/src/coordinator-jobs';
import type {CoordTask} from '../src/coordinator';

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
 expect(jobs[0]).toEqual({accounts:['BowBeforeMe'],script:'handoff.ts',enabled:false,repeat:false,coordinatorOwner:'coordinator',coordinatorTask:'run-handoff',env:{COORDINATOR_RUN_ID:'run-1'}});
 expect(jobs[1]).toMatchObject({account:'Shaftmaker',script:'magic.ts',enabled:true,coordinatorTask:'run-magic',env:{COORDINATOR_RUN_ID:'run-2'}});
 expect(readMergedPlan(f.base).jobs.find((j:any)=>j.script==='bow.ts')).toBeUndefined();
});

test('a failed but settled composed job releases its run account; a missing receipt still refuses',()=>{
 const released=fixture();
 atomicJson(join(released.prac,'coordinator/runs/run-1/receipt.json'),{taskId:'run-handoff',runId:'run-1',ok:false,at:1});
 released.install();
 const jobs=readCoordinatorJobs(released.base).jobs;
 expect(jobs[0]).toEqual({accounts:['BowBeforeMe'],script:'handoff.ts',enabled:false,repeat:false,coordinatorOwner:'coordinator',coordinatorTask:'run-handoff',env:{COORDINATOR_RUN_ID:'run-1'}});
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
