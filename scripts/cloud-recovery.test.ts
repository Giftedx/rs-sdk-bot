import {test,expect} from 'bun:test';
import {boundedRecoveryPlan,releaseForBoundedInspection,assertCompletedInspectionMission} from './cloud-recovery';
import {beginSessionAttempt,readLogoutProof,listAttempts} from '../packages/core/src/session-lifecycle';
import {missionSignature} from '../packages/core/src/session-admission';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertBoundedRecoveryQueue} from '../packages/core/src/bounded-recovery';
const targets=[{account:'Rod',attemptId:'1794807014059-0000010716-0000000001',endedAt:1794807014127}];
const plan={maxBots:4,minFreeGB:4,fleetCapacity:4,jobs:[{account:'Rod',enabled:true,repeat:false,script:'scripts/fleet-inspect.ts',maxRestarts:0,standingRetry:false,env:{LOOT_WATCH:'0',RANDOM_EVENTS:'0'}},{account:'Other',enabled:false,repeat:false,role:'reserved'}]};
test('bounded recovery parks only its inspectors and preserves reservation bytes and limits',()=>{
 const next=boundedRecoveryPlan(plan,targets,['Rod','Other']);
 expect(plan.jobs[0]!.enabled).toBe(true);expect(next.jobs[0].enabled).toBe(false);
 expect(next.jobs[1]).toBe(plan.jobs[1]);expect(next).toMatchObject({maxBots:4,minFreeGB:4,fleetCapacity:4});
 expect(next.coordination.bootstrap).toHaveLength(2);
 expect(()=>assertBoundedRecoveryQueue(next.coordination.boundedRecovery,{tasks:next.coordination.bootstrap.map((spec:any)=>({spec,status:'pending'}))})).not.toThrow();
 for(const change of [{...plan,maxBots:3},{...plan,jobs:[plan.jobs[0],{...plan.jobs[1],enabled:true}]},{...plan,jobs:[plan.jobs[0],{...plan.jobs[1],script:'old.ts'}]}])
  expect(()=>boundedRecoveryPlan(change,targets,['Rod','Other'])).toThrow();
});
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
test('invalid manifest, side or owner plan cannot release a retained overlay',async()=>{
 const base=mkdtempSync(join(tmpdir(),'bounded-preflight-')),dir=join(base,'.practice/coordinator');mkdirSync(dir,{recursive:true});
 const file=join(dir,'jobs.json'),bytes=JSON.stringify({jobs:[{account:'Other',enabled:false}],coordination:{}});writeFileSync(file,bytes);
 let releases=0;
 for(const [p,t,owned] of [[plan,[],['Rod','Other']],[plan,targets,['Other']],[{...plan,maxBots:1},targets,['Rod','Other']]] as const){
  await expect(releaseForBoundedInspection(base,p,t as any,owned,'cloud',()=>{releases++;writeFileSync(file,'mutated');return true;})).rejects.toThrow();
  expect(readFileSync(file,'utf8')).toBe(bytes);
 }
 expect(releases).toBe(0);
});
