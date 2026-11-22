import {test,expect} from 'bun:test';
import {boundedRecoveryPlan,prepareBoundedRecovery,releaseForBoundedInspection,assertCompletedInspectionMission} from './cloud-recovery';
import {beginSessionAttempt,readLogoutProof,listAttempts,accountDir,lifecycleOwner} from '../packages/core/src/session-lifecycle';
import {missionSignature} from '../packages/core/src/session-admission';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fleetGitWindow,fleetCheckoutId,commitFleetGitRecord,pushFleetGitRecord} from '../packages/core/src/fleet-lease';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { assertBoundedRecoveryAssignments, validateBoundedRecovery } from '../packages/core/src/bounded-recovery';
const targets=[{account:'Rod',attemptId:'1794807014059-0000010716-0000000001',endedAt:1794807014127}];
const plan={maxBots:4,minFreeGB:4,fleetCapacity:4,jobs:[{account:'Rod',enabled:true,repeat:false,script:'scripts/aio-logistics.ts',args:['inspect'],maxRestarts:0,standingRetry:false,env:{LOOT_WATCH:'0',RANDOM_EVENTS:'0'}},{account:'Other',enabled:false,repeat:false,role:'reserved'}]};
test('bounded recovery parks only its inspectors and preserves reservation bytes and limits',()=>{
 const next=boundedRecoveryPlan(plan,targets,['Rod','Other']);
 expect(plan.jobs[0]!.enabled).toBe(true);expect(next.jobs[0].enabled).toBe(false);
 expect(next.jobs[1]).toBe(plan.jobs[1]);expect(next).toMatchObject({maxBots:4,minFreeGB:4,fleetCapacity:4});
 expect(next.boundedRecovery.targets).toEqual(targets);
 expect(() => validateBoundedRecovery(next.boundedRecovery)).not.toThrow();
 expect(() => assertBoundedRecoveryAssignments(next.boundedRecovery, next.jobs)).not.toThrow();
 for(const change of [{...plan,maxBots:3},{...plan,jobs:[plan.jobs[0],{...plan.jobs[1],enabled:true}]},{...plan,jobs:[plan.jobs[0],{...plan.jobs[1],script:'old.ts'}]}])
  expect(()=>boundedRecoveryPlan(change,targets,['Rod','Other'])).toThrow();
});
test('bounded recovery validates exact producer proof and held claim without mutating state',()=>{
 const base=mkdtempSync(join(tmpdir(),'bounded-parked-')),dir=join(base,'.practice/live');mkdirSync(dir,{recursive:true});
 const git=(...args:string[])=>execFileSync('git',args,{cwd:base,encoding:'utf8',stdio:'pipe',windowsHide:true}).trim();
 try{
  const remote=join(base,'origin.git');git('init','--bare',remote);git('init');git('remote','add','origin',remote);
  const nonce=randomUUID(),pid=2147483646,server='rs-sdk-demo.fly.dev',root=join(base,'.practice/session-lifecycle');
  const attempt=beginSessionAttempt({account:'Rod',server},{root,owner:{...lifecycleOwner(),pid,sharedClaimNonce:nonce}});attempt.record('connect-failed');
  const receipt=listAttempts('Rod',server,{root})[0]!,scope=[{account:'Rod',attemptId:attempt.attemptId,endedAt:receipt.receipt!.updatedAt+1}];
  const authority=fleetGitWindow(base),tree=authority(['hash-object','-w','-t','tree','--stdin'],'');
  const claim={kind:'swarm',account:'rod',server,side:'cloud',checkout:fleetCheckoutId(base),host:'previous-fixture-host',pid,nonce,phase:'held',at:receipt.receipt!.createdAt};
  const ref='refs/heads/fleet-trade-claim/rod',head=commitFleetGitRecord(authority,undefined,tree,'Fixture held claim\n\n'+JSON.stringify(claim));pushFleetGitRecord(authority,ref,head);
  const ends=join(base,'.practice/swarm-deaths.json'),state=join(dir,'fleet-state.json');
  writeFileSync(ends,JSON.stringify({Rod:{at:scope[0]!.endedAt,reason:'exit 1 after 1 runs'}}));writeFileSync(state,JSON.stringify({version:1,tasks:[]}));
  const receiptFile=join(accountDir('Rod',server,root),'attempts',attempt.attemptId+'.json');
  const before={end:readFileSync(ends),state:readFileSync(state),receipt:readFileSync(receiptFile)};
  const next=prepareBoundedRecovery(base,plan,scope,['Rod','Other'],'cloud');
  expect(next.jobs[1]).toBe(plan.jobs[1]);expect(next.jobs[0].enabled).toBe(false);
  expect(readFileSync(ends)).toEqual(before.end);expect(readFileSync(state)).toEqual(before.state);expect(readFileSync(receiptFile)).toEqual(before.receipt);
  expect(authority(['ls-remote','--refs','origin',ref]).split(/\s/)[0]).toBe(head);
  for(const changed of [[{...scope[0]!,endedAt:scope[0]!.endedAt+1}],[{...scope[0]!,attemptId:'1794807014059-0000010716-0000000001'}]]){
   expect(()=>prepareBoundedRecovery(base,plan,changed,['Rod','Other'],'cloud')).toThrow();
  }
  expect(()=>prepareBoundedRecovery(base,plan,scope,['Rod','Other'],'other')).toThrow();
 }finally{rmSync(base,{recursive:true,force:true});}
},30000);
test('completed recovery admits only its new inspector mission and retains exact success/producer lineage',()=>{
 const root=mkdtempSync(join(tmpdir(),'completed-inspection-')),source='a'.repeat(64),server='rs-sdk-demo.fly.dev',runId='task-native-recovery';
 const attempt=beginSessionAttempt({account:'Rod',server},{root,owner:{pid:process.pid,coordinatorRunId:runId,workerRelease:source,script:'scripts/session-check.ts',role:'recovery',participants:null}});
 attempt.record('connected');attempt.record('ready');attempt.record('ended','logged-out');attempt.record('logout','logged-out');attempt.record('closed');
 const proof=readLogoutProof('Rod',server,{root}),producer=listAttempts('Rod',server,{root}).find(p=>p.attemptId===attempt.attemptId)!;
 const end={at:producer.receipt!.updatedAt+1,reason:'done after 1 runs',revision:missionSignature({account:'Rod',script:'scripts/session-check.ts',env:{COORDINATOR_RUN_ID:runId}})};
 const prior={status:'succeeded',runId,spec:{id:'recover-rod',account:'Rod',sessionRecovery:{endedAt:targets[0]!.endedAt}},receipt:{ok:true,output:{status:{sessionAttemptId:attempt.attemptId,workRevision:source,coordinatorRunId:runId}}}};
 const v={account:'Rod',proof,producer,end,prior,bound:{targets,taskIds:['qualify-rod','recover-rod']},target:targets[0]!,job:plan.jobs[0],source};
 const before=JSON.stringify({end,producer});expect(()=>assertCompletedInspectionMission(v)).not.toThrow();expect(JSON.stringify({end,producer})).toBe(before);
 for(const patch of [{source:'b'.repeat(64)},{target:{...targets[0]!,attemptId:'1794807014059-0000010716-0000000002'}},{account:'Other'},{end:{...end,reason:'gave-up after 1 runs'}},{end:{...end,revision:missionSignature(plan.jobs[0] as any)}},{proof:{...proof,state:'held'}}])
  expect(()=>assertCompletedInspectionMission({...v,...patch})).toThrow();
 expect(JSON.stringify({end,producer})).toBe(before);
});
test('invalid manifest, side or owner plan fails preflight',async()=>{
 const base=mkdtempSync(join(tmpdir(),'bounded-preflight-'));
 let releases=0;
 try{
  for(const [p,t,owned] of [[plan,[],['Rod','Other']],[plan,targets,['Other']],[{...plan,maxBots:1},targets,['Rod','Other']]] as const){
   await expect(releaseForBoundedInspection(base,p,t as any,owned,'cloud',()=>{releases++;return true;})).rejects.toThrow();
  }
 }finally{rmSync(base,{recursive:true,force:true});}
});
