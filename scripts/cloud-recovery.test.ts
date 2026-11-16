import {test,expect} from 'bun:test';
import {boundedRecoveryPlan} from './cloud-recovery';
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
