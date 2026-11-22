import { test, expect } from 'bun:test';
import { assertBoundedRecoveryQueue, assertBoundedRecoveryAssignments, assertBoundedInspectionAssignments, validateBoundedRecovery } from '../src/bounded-recovery';
const scope = {targets:[{account:'Rod',attemptId:'1794807014059-0000010716-0000000001',endedAt:1794807014127}],taskIds:['qualify-rod','recover-rod']};
const qualify = {id:'qualify-rod',kind:'qualify',capability:'session-recovery-only'};
const run = {id:'recover-rod',kind:'run',capability:'session-recovery-only',account:'Rod',sessionRecovery:{account:'Rod',endedAt:1794807014127},repairs:[{account:'Rod',endedAt:1794807014127}]};
test('only the exact finite recovery proposal can dispatch; old tasks remain retained',()=>{
    expect(()=>assertBoundedRecoveryQueue(scope,{tasks:[{status:'pending',spec:qualify},{status:'pending',spec:run},{status:'succeeded',spec:{kind:'build'}}]})).not.toThrow();
    for(const spec of [{...run,account:'Other'},{...run,sessionRecovery:{account:'Rod',endedAt:1}},{...run,kind:'build'}, {...qualify,capability:'wine-order'}, {...run,participants:['Rod','Other']}, {...run,env:{LOOT_WATCH:'1'}}, {...run,id:'different'}])
        expect(()=>assertBoundedRecoveryQueue(scope,{tasks:[{status:'pending',spec}]})).toThrow('outside bounded');
    expect(()=>assertBoundedRecoveryQueue(scope,{tasks:[],planner:{pid:1}})).toThrow('planner');
    expect(()=>assertBoundedRecoveryQueue(scope,{tasks:[],pendingSubmission:{capabilities:['other']}})).toThrow('unresolved submission');
    expect(()=>validateBoundedRecovery({...scope,targets:[...scope.targets,...scope.targets]})).toThrow('invalid');
});
test('a bounded swarm refuses an enabled owner job or a foreign overlay before dispatch',()=>{
    expect(()=>assertBoundedRecoveryAssignments(scope,[{account:'Rod',enabled:false}],[])).not.toThrow();
    expect(()=>assertBoundedRecoveryAssignments(scope,[{account:'Other',enabled:true}],[])).toThrow('disabled');
    expect(()=>assertBoundedRecoveryAssignments(scope,[],[{account:'Other',enabled:false}])).toThrow('outside');
    expect(()=>assertBoundedRecoveryAssignments(scope,[],[{account:'Rod',enabled:true,script:'old.ts',coordinatorOwner:'coordinator'}])).toThrow('outside');
    expect(()=>assertBoundedRecoveryAssignments(scope,[],[{account:'Rod',enabled:true,script:'scripts/session-check.ts',repeat:false,coordinatorOwner:'coordinator',coordinatorTask:'recover-rod'}])).not.toThrow();
});
test('inspection accepts only finite selected inspectors and disabled reservations with no remaining overlay',()=>{
    const jobs=[{account:'Rod',script:'scripts/aio-logistics.ts',args:['inspect'],enabled:true,repeat:false,maxRestarts:0,standingRetry:false,env:{LOOT_WATCH:'0',RANDOM_EVENTS:'0',REQUIRE_BANK:'1'}},{account:'Other',enabled:false,repeat:false,role:'reserved'}];
    expect(()=>assertBoundedInspectionAssignments(['Rod'],jobs,[])).not.toThrow();
    expect(()=>assertBoundedInspectionAssignments(['Rod'],jobs,[{account:'Rod',enabled:false}])).toThrow('unresolved');
    for(const change of [{...jobs[0],repeat:true},{...jobs[0],script:'old.ts'},{...jobs[0],autopilot:'gold'},{...jobs[1],enabled:true}])
        expect(()=>assertBoundedInspectionAssignments(['Rod'],[change],[])).toThrow();
});
