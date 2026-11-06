import {test,expect} from 'bun:test';
import {GOALS,initialState,addTasks,chooseTask,startTask,finishTask,acceptStatus,boundedWorkerEndMessage,boundAccounts,failedBuildStreak,activeBuildFocus,repeatedBuildFault,heldBuilds,validateTask,BUILD_HOLD_MS,type CoordTask} from '../src/coordinator';
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
test('a consumer with a terminal prerequisite no longer boosts another prerequisite',()=>{
 const s=initialState();addTasks(s,[task('root',{priority:1}),task('blocked',{dependsOn:['root']}),
  task('repair',{priority:8}),task('useful',{priority:10}),task('consumer',{dependsOn:['repair','blocked']})],0);
 expect(chooseTask(s,1)?.id).toBe('repair');
 startTask(s,'root',1,'root-run');finishTask(s,{taskId:'root',runId:'root-run',ok:false,at:2,output:{}});
 expect(chooseTask(s,3)?.id).toBe('useful');
 expect(s.tasks.find(r=>r.spec.id==='consumer')?.status).toBe('pending');
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

test('each viable run adds one priority boost to the provision task it needs',()=>{
 for(const binding of [{accountFrom:'helper'},{participants:['Donor','@helper']}]){
  const s=initialState();
  addTasks(s,[task('helper',{kind:'provision',role:'helper',priority:5}),task('other',{priority:8}),
   task('run',{kind:'run',...binding,accept:{counters:{made:1}}})],0);
  expect(chooseTask(s,1)?.id).toBe('helper');
  s.tasks.find(r=>r.spec.id==='run')!.spec.dependsOn.push('helper');
  addTasks(s,[task('higher',{priority:12})],0);
  expect(chooseTask(s,2)?.id).toBe('higher');
 }
});

test('provision-derived aliases cannot overlap or supply duplicate participants',()=>{
 const s=initialState();addTasks(s,[task('helper',{kind:'provision',role:'helper'}),task('run1',{kind:'run',accountFrom:'helper',accept:{counters:{made:1}}}),task('run2',{kind:'run',account:'Helper1',accept:{counters:{made:1}}}),task('duplicate',{kind:'run',participants:['Helper1','@helper'],accept:{counters:{made:1}}})],0);
 startTask(s,'helper',1,'p');finishTask(s,{taskId:'helper',runId:'p',ok:true,at:2,output:{account:'Helper1'}});
 expect(boundAccounts(s.tasks[3]!.spec,s)).toBeNull();startTask(s,'run1',3,'r');expect(chooseTask(s,4)).toBeNull();
});

test('account setup waits for a prepared first run and follows its review hold',()=>{
 const s=initialState();
 addTasks(s,[task('helper',{kind:'provision',role:'helper',priority:50}),
  task('orphan',{kind:'provision',role:'helper',priority:100}),task('proof'),
  task('first-job',{kind:'run',accountFrom:'helper',dependsOn:['proof'],accept:{counters:{made:1}}})],0);
 expect(chooseTask(s,1)?.id).toBe('proof');
 startTask(s,'proof',2,'p');
 expect(chooseTask(s,3)).toBeNull();
 const failed=structuredClone(s);
 finishTask(failed,{taskId:'proof',runId:'p',ok:false,at:4,output:{}});
 expect(chooseTask(failed,5)).toBeNull();
 finishTask(s,{taskId:'proof',runId:'p',ok:true,at:4,output:{}});
 expect(chooseTask(s,5,{runHeld:()=>true})).toBeNull();
 expect(chooseTask(s,5)?.id).toBe('helper');
});

test('a prepared run can provision two participants without claiming after either setup fails',()=>{
 const s=initialState();
 addTasks(s,[task('first',{kind:'provision',role:'helper'}),task('second',{kind:'provision',role:'helper'}),
  task('trade',{kind:'run',participants:['@first','@second'],dependsOn:['second'],accept:{bank:{'333':10}}})],0);
 expect(chooseTask(s,1)?.id).toBe('first');
 startTask(s,'first',2,'p');
 const failed=structuredClone(s);
 finishTask(failed,{taskId:'first',runId:'p',ok:false,at:3,output:{}});
 expect(chooseTask(failed,4)).toBeNull();
 finishTask(s,{taskId:'first',runId:'p',ok:true,at:3,output:{account:'Helper1'}});
 expect(chooseTask(s,4)?.id).toBe('second');
});

test('ready source builds drain live runs and keep all live work offline until build settles',()=>{
 const s=initialState();addTasks(s,[task('live',{kind:'run',account:'Helper1',accept:{counters:{made:1}}}),task('next',{kind:'run',account:'Helper2',priority:100,accept:{counters:{made:1}}}),task('build',{kind:'build'})],0);
 startTask(s,'live',1,'l');expect(chooseTask(s,2)).toBeNull();
 finishTask(s,{taskId:'live',runId:'l',ok:true,at:3,output:{}});expect(chooseTask(s,4)?.id).toBe('build');
 startTask(s,'build',5,'b');expect(chooseTask(s,6)).toBeNull();
 finishTask(s,{taskId:'build',runId:'b',ok:true,at:7,output:{}});expect(chooseTask(s,8)?.id).toBe('next');
});

test('provision attempts serialize; goals overdue thirty minutes outrank fresh high-score work',()=>{
 const s=initialState();addTasks(s,[task('p1',{kind:'provision',role:'helper'}),task('p2',{kind:'provision',role:'helper'}),
  task('trade',{kind:'run',participants:['@p1','@p2'],accept:{bank:{'333':10}}})],0);
 expect(chooseTask(s,1)?.id).toBe('p1');
 startTask(s,'p1',1,'p');expect(chooseTask(s,2)).toBeNull();
 finishTask(s,{taskId:'p1',runId:'p',ok:true,at:3,output:{account:'Helper1'}});
 expect(chooseTask(s,4)?.id).toBe('p2');
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

test('an isolated build waits while a build that owns the same files runs or publishes; disjoint builds run in parallel',()=>{
 const owned:Record<string,string[]>={'iron-progress-order':['scripts/smelt-batch.ts','scripts/smelt-bars.ts'],'smelt-extra':['scripts/smelt-batch.ts'],'wine-order':['scripts/wine.ts']};
 const opts={isolatedBuilds:true,developmentLimit:4,ownedFiles:(cap:string)=>owned[cap]!};
 const s=initialState();addTasks(s,[task('repair-1',{kind:'build',capability:'iron-progress-order',priority:90}),task('repair-2',{kind:'build',capability:'iron-progress-order',priority:80}),
  task('shared',{kind:'build',capability:'smelt-extra',priority:70}),task('wine',{kind:'build',capability:'wine-order',priority:10})],0);
 expect(chooseTask(s,1,opts)?.id).toBe('repair-1');startTask(s,'repair-1',1,'r1');
 expect(chooseTask(s,2,opts)?.id).toBe('wine'); // repair-2 shares the capability, shared shares smelt-batch.ts
 expect(chooseTask(s,2,{...opts,ownedFiles:undefined})?.id).toBe('shared'); // without file lists only the capability serializes
 startTask(s,'wine',2,'w');expect(chooseTask(s,3,opts)).toBeNull();
 finishTask(s,{taskId:'repair-1',runId:'r1',ok:true,at:4,output:{}});
 expect(chooseTask(s,5,{...opts,publishing:'iron-progress-order'})).toBeNull(); // a waiting publish still owns its files
 expect(chooseTask(s,5,opts)?.id).toBe('repair-2');
});

test('with isolated builds a qualification for a waiting live run passes a waiting build and another focus',()=>{
 const s=initialState();addTasks(s,[task('build',{kind:'build',capability:'other-order'}),task('q',{kind:'qualify',capability:'quest-sweep',priority:50}),
  task('run',{kind:'run',capability:'quest-sweep',account:'Helper1',dependsOn:['q'],accept:{quests:['Hazeel Cult']}}),task('q-alone',{kind:'qualify',capability:'other-order'})],0);
 expect(chooseTask(s,2,{isolatedBuilds:true,focusCapability:'other-order'})?.id).toBe('q');
 expect(chooseTask(s,2,{focusCapability:'other-order'})?.id).toBe('build'); // without isolation the qualification waits for the build
 startTask(s,'build',3,'b');expect(chooseTask(s,4,{isolatedBuilds:true,developmentLimit:2})?.id).toBe('q');
 expect(chooseTask(s,4,{isolatedBuilds:true,developmentLimit:1})).toBeNull();
 expect(chooseTask(s,4,{developmentLimit:2})).toBeNull(); // without isolation builds and checks take turns
});

test('a blocked live consumer does not give its qualification a practice slot ahead of a build',()=>{
 const s=initialState();addTasks(s,[task('failed',{priority:1}),task('blocked',{dependsOn:['failed']}),
  task('build',{kind:'build',capability:'other-order'}),task('q',{capability:'quest-sweep',priority:50}),
  task('run',{kind:'run',capability:'quest-sweep',account:'Helper1',dependsOn:['q','blocked'],accept:{quests:['Hazeel Cult']}})],0);
 const options={isolatedBuilds:true,focusCapability:'other-order'};
 expect(chooseTask(s,1,options)?.id).toBe('q');
 startTask(s,'failed',1,'failed-run');finishTask(s,{taskId:'failed',runId:'failed-run',ok:false,at:2,output:{}});
 expect(chooseTask(s,3,options)?.id).toBe('build');
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

const failBuild=(s:ReturnType<typeof initialState>,id:string,at:number,buildFault?:string)=>{const r=startTask(s,id,at,'r'+id);finishTask(s,{taskId:id,runId:r.runId!,ok:false,at:at+1,error:'check failed',output:buildFault?{buildFault}:{}});};
const build=(id:string,extra:Partial<CoordTask>={})=>task(id,{kind:'build',capability:'herblore-order',...extra});
test('two builds with one fault hold the next build and leave other lanes eligible',()=>{
 const s=initialState();addTasks(s,[build('b1'),build('b2'),build('b3'),task('other',{kind:'build',capability:'wine-order',priority:1})],0);
 failBuild(s,'b1',10,'practice: vial-shortfall');expect(repeatedBuildFault(s,'herblore-order')).toBeNull();
 failBuild(s,'b2',20,'practice: vial-shortfall');
 expect(repeatedBuildFault(s,'herblore-order')).toEqual({capability:'herblore-order',fault:'practice: vial-shortfall',builds:2,at:21});
 expect(heldBuilds(s,22).map(h=>h.capability)).toEqual(['herblore-order']);
 expect(chooseTask(s,22)?.id).toBe('other');
 s.tasks.find(r=>r.spec.id==='other')!.status='superseded';
 expect(chooseTask(s,21+BUILD_HOLD_MS-1)).toBeNull();
 expect(chooseTask(s,21+BUILD_HOLD_MS)?.id).toBe('b3');expect(heldBuilds(s,21+BUILD_HOLD_MS)).toEqual([]);
});
test('different faults, unknown faults and a newer success do not hold a build',()=>{
 const differ=initialState();addTasks(differ,[build('b1'),build('b2'),build('b3')],0);
 failBuild(differ,'b1',10,'practice: clock-stage');failBuild(differ,'b2',20,'practice: vampire-started');expect(chooseTask(differ,22)?.id).toBe('b3');
 const unknown=initialState();addTasks(unknown,[build('b1'),build('b2'),build('b3')],0);
 failBuild(unknown,'b1',10);failBuild(unknown,'b2',20);expect(chooseTask(unknown,22)?.id).toBe('b3');
 const passed=initialState();addTasks(passed,[build('b1'),build('b2'),build('b3'),build('b4')],0);
 failBuild(passed,'b1',10,'x');failBuild(passed,'b2',20,'x');
 const r=startTask(passed,'b3',30,'r');finishTask(passed,{taskId:'b3',runId:r.runId!,ok:true,at:31,output:{}});
 expect(repeatedBuildFault(passed,'herblore-order')).toBeNull();expect(chooseTask(passed,32)?.id).toBe('b4');
});
test('new evidence passes the first hold only',()=>{
 const s=initialState();addTasks(s,[build('b1'),build('b2'),build('b3',{newEvidence:'route trace shows the failing leg'}),build('b4',{newEvidence:'another claim'})],0);
 failBuild(s,'b1',10,'x');failBuild(s,'b2',20,'x');
 expect(chooseTask(s,22)?.id).toBe('b3');
 failBuild(s,'b3',30,'x');expect(repeatedBuildFault(s,'herblore-order')?.builds).toBe(3);
 expect(chooseTask(s,32)).toBeNull();
 expect(()=>validateTask(task('q',{newEvidence:'x'}))).toThrow('invalid new evidence');
 expect(()=>validateTask(build('b',{newEvidence:' '}))).toThrow('invalid new evidence');
});

test('worker end evidence names only the result from that live attempt', () => {
 const ctx={account:'Helper1',goal:'goal',source:'pin',startedAt:100,now:120,runId:'this-run'};
 const end={reason:'gave-up after 1 runs',at:115};
 const status={name:'Helper1',server:'rs-sdk-demo.fly.dev',workRevision:'pin',coordinatorRunId:'this-run',
  started:101,at:110,result:'fail missing coins for the fare'};
 const generic='bounded worker ended: gave-up after 1 runs';
 expect(boundedWorkerEndMessage(end,status,ctx)).toBe(generic+' | worker result: fail missing coins for the fare');
 for(const patch of [{coordinatorRunId:'other-run'},{workRevision:'old'},{practice:true},{at:116},{started:99},{result:null}]){
  expect(boundedWorkerEndMessage(end,{...status,...patch},ctx)).toBe(generic);
 }
});
