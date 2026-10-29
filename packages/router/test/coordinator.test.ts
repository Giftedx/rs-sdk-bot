import {test,expect} from 'bun:test';
import {GOALS,initialState,addTasks,chooseTask,startTask,finishTask,acceptStatus,boundAccounts,failedBuildStreak,activeBuildFocus,type CoordTask} from '../src/coordinator';
const task=(id:string,extra:Partial<CoordTask>={}):CoordTask=>({id,goal:'skills',kind:'qualify',capability:'wine-order',dependsOn:[],priority:5,estimatedMs:1000,why:'Close a useful consumer dependency',...extra});
test('all owner goals survive and a dependency chain advances without another prompt',()=>{
 const s=initialState();expect(s.goals.map(g=>g.id)).toEqual([...GOALS]);
 addTasks(s,[task('prepare'),task('consume',{dependsOn:['prepare']})]);
 expect(chooseTask(s,100)?.id).toBe('prepare');const r=startTask(s,'prepare',100,'r1');
 expect(chooseTask(s,101)).toBeNull();
 expect(finishTask(s,{taskId:'prepare',runId:r.runId!,ok:true,at:102,output:{evidence:'native'}})).toBe(true);
 expect(chooseTask(s,103)?.id).toBe('consume');
});
test('failed dependencies leave other goals eligible and cannot be replayed as new success',()=>{
 const s=initialState();addTasks(s,[task('bad'),task('child',{dependsOn:['bad']}),task('other',{goal:'wealth',priority:1})]);startTask(s,'bad',1,'r');
 expect(finishTask(s,{taskId:'bad',runId:'wrong',ok:true,at:2,output:{}})).toBe(false);
 finishTask(s,{taskId:'bad',runId:'r',ok:false,at:2,error:'failed',output:{}});
 expect(chooseTask(s,3)?.id).toBe('other');
 expect(finishTask(s,{taskId:'bad',runId:'r',ok:true,at:4,output:{}})).toBe(false);
});
test('invalid graphs and attempts to replace existing tasks are rejected atomically',()=>{
 const s=initialState();addTasks(s,[task('existing')]);
 expect(()=>addTasks(s,[task('a',{dependsOn:['b']}),task('b',{dependsOn:['a']})])).toThrow('cycle');
 expect(s.tasks).toHaveLength(1);
 expect(()=>addTasks(s,[task('existing',{goal:'wealth'})])).toThrow('exists');
 expect(()=>addTasks(s,[task('a',{dependsOn:['missing']})])).toThrow('missing');
});
test('source-editing/practice work is exclusive; independent live accounts can overlap',()=>{
 const s=initialState();addTasks(s,[task('live',{kind:'run',account:'Helper1',accept:{skills:{Cooking:99}}}),task('live2',{kind:'run',account:'Helper2',accept:{skills:{Cooking:99}}}),task('native')]);
 startTask(s,'live',1,'r');expect(chooseTask(s,2)?.id).toBe('live2');
 startTask(s,'native',2,'n');expect(chooseTask(s,3)?.id).toBe('live2');
});
test('live completion requires the exact run, source, identity, result and useful effect',()=>{
 const spec=task('job',{kind:'run',account:'Helper1',accept:{skills:{Cooking:99},counters:{banked:90}}});
 const row={name:'Helper1',server:'rs-sdk-demo.fly.dev',goal:'job [run1]',at:101,started:100,workRevision:'pin',result:'ok done',skills:[{name:'Cooking',level:99}],counters:{banked:90}};
 expect(acceptStatus(spec,row,{account:'Helper1',goal:row.goal,source:'pin',startedAt:100,now:102})).toBe(true);
 for(const change of [{name:'other'},{at:99},{goal:'old'},{workRevision:'old'},{result:'fail'},{counters:{banked:89}},{skills:[{name:'Cooking',level:98}]}])expect(acceptStatus(spec,{...row,...change},{account:'Helper1',goal:row.goal,source:'pin',startedAt:100,now:102})).toBe(false);
});

test('participant provision references form dependency edges and resolve identities before overlap checks',()=>{
 const s=initialState();
 addTasks(s,[task('new-helper',{kind:'provision',role:'helper'}),task('handoff',{kind:'run',participants:['Donor','@new-helper'],args:['batch'],acceptIndex:1,accept:{bank:{'333':10}}}),
  task('conflict',{kind:'run',account:'DONOR',accept:{counters:{made:1}}})],0);
 expect(boundAccounts(s.tasks[1]!.spec,s)).toBeNull();
 startTask(s,'new-helper',1,'p');finishTask(s,{taskId:'new-helper',runId:'p',ok:true,at:2,output:{account:'Helper1'}});
 expect(boundAccounts(s.tasks[1]!.spec,s)).toEqual(['Donor','Helper1']);
 startTask(s,'handoff',3,'h');expect(chooseTask(s,4)).toBeNull();
 const other=initialState();
 expect(()=>addTasks(other,[task('loop',{kind:'run',participants:['Donor','@loop'],accept:{counters:{made:1}}})])).toThrow();
 expect(()=>addTasks(other,[task('missing',{kind:'run',participants:['Donor','@unknown'],accept:{counters:{made:1}}})])).toThrow('missing');
});

test('provision-derived aliases cannot overlap or supply duplicate participants',()=>{
 const s=initialState();addTasks(s,[task('helper',{kind:'provision',role:'helper'}),task('run1',{kind:'run',accountFrom:'helper',accept:{counters:{made:1}}}),task('run2',{kind:'run',account:'Helper1',accept:{counters:{made:1}}}),task('duplicate',{kind:'run',participants:['Helper1','@helper'],accept:{counters:{made:1}}})],0);
 startTask(s,'helper',1,'p');finishTask(s,{taskId:'helper',runId:'p',ok:true,at:2,output:{account:'Helper1'}});
 expect(boundAccounts(s.tasks[3]!.spec,s)).toBeNull();startTask(s,'run1',3,'r');expect(chooseTask(s,4)).toBeNull();
});

test('ready source builds drain live runs and keep all live work offline until build settles',()=>{
 const s=initialState();addTasks(s,[task('live',{kind:'run',account:'Helper1',accept:{counters:{made:1}}}),task('next',{kind:'run',account:'Helper2',priority:100,accept:{counters:{made:1}}}),task('build',{kind:'build'})],0);
 startTask(s,'live',1,'l');expect(chooseTask(s,2)).toBeNull();
 finishTask(s,{taskId:'live',runId:'l',ok:true,at:3,output:{}});expect(chooseTask(s,4)?.id).toBe('build');
 startTask(s,'build',5,'b');expect(chooseTask(s,6)).toBeNull();
 finishTask(s,{taskId:'build',runId:'b',ok:true,at:7,output:{}});expect(chooseTask(s,8)?.id).toBe('next');
});

test('provision attempts serialize; goals overdue thirty minutes outrank fresh high-score work',()=>{
 const s=initialState();addTasks(s,[task('p1',{kind:'provision',role:'helper'}),task('p2',{kind:'provision',role:'helper'})],0);
 startTask(s,'p1',1,'p');expect(chooseTask(s,2)).toBeNull();
 const fair=initialState();addTasks(fair,[task('old',{goal:'quests',priority:1,estimatedMs:3600000}),task('fresh',{goal:'wealth',priority:100,estimatedMs:1}),task('older',{goal:'gear',priority:1,estimatedMs:3600000})],0);
 fair.goals.find(g=>g.id==='quests')!.lastStartedAt=10;fair.goals.find(g=>g.id==='gear')!.lastStartedAt=0;fair.goals.find(g=>g.id==='wealth')!.lastStartedAt=1800000;
 expect(chooseTask(fair,1800010)?.id).toBe('older');
});

test('invalid bindings, references, priorities and env values are rejected before state mutation',()=>{
 for(const patch of [{account:'bad/name'},{accountFrom:'bad/ref'},{participants:['Donor','donor']},{participants:['@BAD']},{participants:['Donor'],acceptIndex:1},{priority:101},{env:{COUNT:2}},{env:{'BAD-NAME':'v'}},{args:[2]},{account:'Donor',participants:['Receiver']}]){
  const binding='participants' in patch||'accountFrom' in patch?{}:{account:'Donor'};
  const s=initialState();expect(()=>addTasks(s,[task('invalid',{kind:'run',accept:{counters:{made:1}},...binding,...patch} as Partial<CoordTask>)] )).toThrow();expect(s.tasks).toEqual([]);
 }
 const s=initialState();expect(()=>addTasks(s,[task('not-provision'),task('consumer',{kind:'run',accountFrom:'not-provision',accept:{counters:{made:1}}})])).toThrow();
});

test('composed child goals retain one exact coordinator run identity',()=>{
 const t=task('combined',{kind:'run',account:'Receiver',accept:{counters:{made:1}}});
 const ctx={account:'Receiver',goal:'combined [run-1]',source:'source',startedAt:100,now:200,runId:'run-1'};
 const status={name:'Receiver',server:'rs-sdk-demo.fly.dev',goal:'handoff token receiver',coordinatorRunId:'run-1',workRevision:'source',at:200,started:110,result:'ok delivered',counters:{made:1}};
 expect(acceptStatus(t,status,ctx)).toBe(true);
 expect(acceptStatus(t,{...status,coordinatorRunId:'other-run'},ctx)).toBe(false);
 expect(acceptStatus(t,{...status,coordinatorRunId:null},ctx)).toBe(false);
});

test('isolated builds overlap live runs; a pending publish holds only new live starts',()=>{
 const opts={isolatedBuilds:true};
 const s=initialState();addTasks(s,[task('live',{kind:'run',account:'Helper1',accept:{counters:{made:1}}}),task('next',{kind:'run',account:'Helper2',priority:100,accept:{counters:{made:1}}}),task('build',{kind:'build'})],0);
 startTask(s,'live',1,'l');expect(chooseTask(s,2,{...opts,publishPending:true})?.id).toBe('build');
 startTask(s,'build',3,'b');expect(chooseTask(s,4,opts)?.id).toBe('next');
 expect(chooseTask(s,4,{...opts,publishPending:true})).toBeNull();
 expect(chooseTask(s,4)).toBeNull(); // without isolation a running build still keeps live work offline
});

test('with isolated builds a qualification for a waiting live run passes a waiting build and another focus',()=>{
 const s=initialState();addTasks(s,[task('build',{kind:'build',capability:'other-order'}),task('q',{kind:'qualify',capability:'quest-sweep',priority:50}),
  task('run',{kind:'run',capability:'quest-sweep',account:'Helper1',dependsOn:['q'],accept:{quests:['Hazeel Cult']}}),task('q-alone',{kind:'qualify',capability:'other-order'})],0);
 expect(chooseTask(s,2,{isolatedBuilds:true,focusCapability:'other-order'})?.id).toBe('q');
 expect(chooseTask(s,2,{focusCapability:'other-order'})?.id).toBe('build'); // without isolation the qualification waits for the build
 startTask(s,'build',3,'b');expect(chooseTask(s,4,{isolatedBuilds:true})).toBeNull(); // the practice server is shared
});

test('a focus that failed three builds in a row is not re-adopted',()=>{
 const s=initialState();addTasks(s,['b1','b2','b3','b4'].map(id=>task(id,{kind:'build',capability:'agility-order'})),0);
 for(const [i,id] of ['b1','b2','b3'].entries()){const r=startTask(s,id,10+i,'r'+id);finishTask(s,{taskId:id,runId:r.runId!,ok:false,at:20+i,error:'check failed',output:{}});}
 expect(failedBuildStreak(s,'agility-order')).toBe(3);
 startTask(s,'b4',30,'rb4');expect(activeBuildFocus(s)).toBeNull();
 const ok=initialState();addTasks(ok,[task('a',{kind:'build',capability:'wine-order'}),task('b',{kind:'build',capability:'wine-order'})],0);
 const r=startTask(ok,'a',1,'ra');finishTask(ok,{taskId:'a',runId:r.runId!,ok:false,at:2,error:'x',output:{}});startTask(ok,'b',3,'rb');
 expect(activeBuildFocus(ok)?.capability).toBe('wine-order');
});
