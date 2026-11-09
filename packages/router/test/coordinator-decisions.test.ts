import {test,expect} from 'bun:test';
import {initialState,addTasks,chooseTask,startTask,finishTask,type CoordTask,type CoordinatorState} from '../src/coordinator';
import {DEAD_TASK_MS,DISK_FLOOR_GB,IDLE_PLAN_MS,PLAN_GAP_MS,deadRoots,diskFreeGB,finishPlan,plannerDue,planRetryMs,retireDeadTasks,reviewHold} from '../src/coordinator-decisions';
import {plannerPrompt,queueFacts} from '../src/coordinator-planner';

const task=(id:string,extra:Partial<CoordTask>={}):CoordTask=>({id,goal:'skills',kind:'qualify',capability:'wine-order',dependsOn:[],priority:5,estimatedMs:1000,why:'Close a useful consumer dependency',...extra});
const run=(id:string,extra:Partial<CoordTask>={})=>task(id,{kind:'run',account:'Helper1',accept:{skills:{Cooking:99}},...extra});
function finish(s:CoordinatorState,id:string,at:number,ok:boolean,output:any={}){
 const r=startTask(s,id,at-1,'r-'+id);finishTask(s,{taskId:id,runId:r.runId!,ok,at,output,...(ok?{}:{error:'failed'})});
}
const due=(s:CoordinatorState,now:number,requested=false)=>plannerDue(s,now,30000,requested);

test('a pending task behind a failed task has that task as its dead root, through any depth',()=>{
 const s=initialState();addTasks(s,[task('bad'),task('mid',{dependsOn:['bad']}),task('leaf',{dependsOn:['mid']}),task('free')]);finish(s,'bad',10,false);
 const roots=deadRoots(s);
 expect(roots.get('mid')?.root).toBe('bad');expect(roots.get('leaf')?.root).toBe('bad');expect(roots.has('free')).toBe(false);
});
test('a running or succeeded dependency leaves its consumer alive',()=>{
 const s=initialState();addTasks(s,[task('good'),task('busy'),task('a',{dependsOn:['good']}),task('b',{dependsOn:['busy']})]);
 finish(s,'good',10,true);startTask(s,'busy',11,'r');
 expect(deadRoots(s).size).toBe(0);
});
test('a failed refresh qualification does not condemn a run: a source change links a new one',()=>{
 const s=initialState();addTasks(s,[task('refresh-wine-order-abc'),run('live',{dependsOn:['refresh-wine-order-abc']})]);finish(s,'refresh-wine-order-abc',10,false);
 expect(deadRoots(s).size).toBe(0);
});
test('a dead task retires only after DEAD_TASK_MS from its root and its own creation',()=>{
 const s=initialState();addTasks(s,[task('bad'),task('old',{dependsOn:['bad']})],0);finish(s,'bad',1000,false);
 addTasks(s,[task('late',{dependsOn:['bad']})],5000);
 expect(retireDeadTasks(s,1000+DEAD_TASK_MS-1)).toEqual([]);
 expect(retireDeadTasks(s,1000+DEAD_TASK_MS).map(r=>r.id)).toEqual(['old']);
 const old=s.tasks.find(r=>r.spec.id==='old')!;expect(old.status).toBe('superseded');expect(old.supersededBy).toBe('dead-dependency:bad');
 expect(s.tasks.find(r=>r.spec.id==='late')!.status).toBe('pending');
 expect(retireDeadTasks(s,5000+DEAD_TASK_MS).map(r=>r.id)).toEqual(['late']);
});
test('a newer failed dependency does not reset the retirement clock for an older dead root',()=>{
 const s=initialState();
 addTasks(s,[task('older'),task('newer'),task('chain',{dependsOn:['newer','older']}),
  run('direct',{dependsOn:['newer','older']}),run('transitive',{dependsOn:['newer','chain']})],0);
 finish(s,'older',1000,false);finish(s,'newer',5000,false);
 expect(retireDeadTasks(s,1000+DEAD_TASK_MS-1)).toEqual([]);
 expect(retireDeadTasks(s,1000+DEAD_TASK_MS)).toEqual([
  {id:'chain',root:'older'},{id:'direct',root:'older'},{id:'transitive',root:'older'},
 ]);
});
test('main and specialist launches stay pending behind a failure',()=>{
 const s=initialState();addTasks(s,[task('bad'),run('main',{dependsOn:['bad'],launch:'main'}),run('spec',{dependsOn:['bad'],launch:'specialist',account:'Helper2'})],0);finish(s,'bad',1,false);
 expect(retireDeadTasks(s,1+DEAD_TASK_MS*2)).toEqual([]);
});

test('a success whose next task is queued starts no plan',()=>{
 const s=initialState();addTasks(s,[task('prove'),run('live',{dependsOn:['prove']})]);finish(s,'prove',1000,true);
 expect(due(s,1000+PLAN_GAP_MS+1)).toBeNull();
});
test('a success with no open consumer starts a plan',()=>{
 const s=initialState();addTasks(s,[task('prove')]);finish(s,'prove',1000,true);
 expect(due(s,1000+PLAN_GAP_MS+1)).toBe('outcome');
});
test('a success whose only consumer is dead starts a plan',()=>{
 const s=initialState();addTasks(s,[task('bad'),task('prove'),run('live',{dependsOn:['prove','bad']})]);finish(s,'bad',500,false);finish(s,'prove',1000,true);s.lastPlanAt=600;
 expect(due(s,600+PLAN_GAP_MS+1000)).toBe('outcome');
});
test('a failure starts a plan, but no sooner than PLAN_GAP_MS after the last one',()=>{
 const s=initialState();addTasks(s,[task('bad')]);finish(s,'bad',1000,false);s.lastPlanAt=900;
 expect(due(s,900+PLAN_GAP_MS-1)).toBeNull();expect(due(s,900+PLAN_GAP_MS)).toBe('outcome');
});
test('an owner request skips the gap',()=>{
 const s=initialState();s.lastPlanAt=1000;expect(due(s,1000+1001,true)).toBe('request');
});
test('with no outcome the planner rechecks after the idle time',()=>{
 const s=initialState();s.lastPlanAt=1000;
 expect(due(s,1000+IDLE_PLAN_MS)).toBeNull();expect(due(s,1001+IDLE_PLAN_MS)).toBe('idle');
});
test('a plan in progress blocks another',()=>{
 const s=initialState();s.planner={runId:'p',startedAt:1};expect(due(s,1+IDLE_PLAN_MS*2,true)).toBeNull();
});
test('failed plans wait longer each time, to at most the idle time, and an accepted plan clears the wait',()=>{
 expect([1,2,3,4,5,6,7].map(planRetryMs)).toEqual([60000,120000,240000,480000,960000,1800000,1800000]);
 const s=initialState();addTasks(s,[task('bad')]);finish(s,'bad',1000,false);
 s.planner={runId:'p',startedAt:1000};finishPlan(s,2000,false);finishPlan(s,2000,false);
 expect(s.planFailures).toBe(2);expect(s.planner).toBeUndefined();
 expect(due(s,2000+planRetryMs(2)-1)).toBeNull();expect(due(s,2000+planRetryMs(2))).toBe('retry');
 finishPlan(s,3000,true);expect(s.planFailures).toBeUndefined();
});
test('a receipt that lands while a plan runs starts the next plan',()=>{
 const s=initialState();addTasks(s,[task('bad'),task('seen')]);finish(s,'seen',900,false);
 s.plannerReceiptSequence=s.latestReceiptSequence;s.planner={runId:'p',startedAt:1000};
 finishPlan(s,2000,true);expect(due(s,2000+PLAN_GAP_MS)).toBeNull();
 s.planner={runId:'p2',startedAt:3000};finish(s,'bad',3500,false);finishPlan(s,4000,true);
 expect(s.lastPlanAt).toBe(4000);expect(due(s,4000+PLAN_GAP_MS)).toBe('outcome');
});

const review=(s:CoordinatorState,id:string,at:number,source:string,approved:boolean)=>{
 addTasks(s,[task(id,{kind:'review'})]);finish(s,id,at,approved,{evidence:'source-review',source,review:{approved,reason:approved?'fine':'wrong item'}});
};
test('the newest review at the current source decides a hold',()=>{
 const s=initialState();review(s,'r1',10,'aaa',false);
 expect(reviewHold(s,'wine-order',()=>'aaa')).toBe('wrong item');
 expect(reviewHold(s,'wine-order',()=>'bbb')).toBeNull();
 review(s,'r2',20,'aaa',true);expect(reviewHold(s,'wine-order',()=>'aaa')).toBeNull();
});
test('a capability with no rejected review never reads its source',()=>{
 const s=initialState();review(s,'r1',10,'aaa',true);
 expect(reviewHold(s,'wine-order',()=>{throw Error('read');})).toBeNull();
 expect(reviewHold(s,'other',()=>{throw Error('read');})).toBeNull();
});
test('a held run waits in the queue and starts when the hold lifts',()=>{
 const s=initialState();addTasks(s,[run('live')]);
 expect(chooseTask(s,1,{runHeld:()=>true})).toBeNull();
 expect(s.tasks[0]!.status).toBe('pending');
 expect(chooseTask(s,2,{runHeld:()=>false})?.id).toBe('live');
});
test('a hold stops runs only',()=>{
 const s=initialState();addTasks(s,[task('prove')]);
 expect(chooseTask(s,1,{runHeld:()=>true})?.id).toBe('prove');
});

test('free disk comes from the volume, and an unreadable volume gives no number',()=>{
 expect(diskFreeGB('x',()=>({bsize:4096,bavail:524288}))).toBe(2);
 expect(diskFreeGB('x',()=>{throw Error('no volume');})).toBeNull();
 expect(DISK_FLOOR_GB).toBeGreaterThan(0);
});

test('the planner sees runs held by a rejected review',()=>{
 const s=initialState();addTasks(s,[run('live')]);
 expect(queueFacts(s,[{capability:'wine-order',reason:'wrong item',runs:['live']}]).heldRuns).toEqual([{capability:'wine-order',reason:'wrong item',runs:['live']}]);
 expect(queueFacts(s).heldRuns).toEqual([]);
});
test('the planner prompt gives the new-evidence limit, the retirement rule and the disk rule',()=>{
 const world:any={scoreboard:null,coverage:{quests:[],scriptCandidates:[]},statuses:[],jobs:[],capabilities:[]};
 const prompt=plannerPrompt(initialState(),world);
 expect(prompt).toContain('newEvidence is 1 to 500 characters');
 expect(prompt).toContain('retires after 24 hours');
 expect(prompt).toContain('world.capacity.diskFreeGB');
});
