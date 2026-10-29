import {test,expect} from 'bun:test';
import {initialState,addTasks,startTask,finishTask,chooseTask,refreshQualifications,qualificationDemand,buildWorkOrder,fleetExpansion,activeBuildFocus,preparedNativeDelivery,type CoordTask} from '../src/coordinator';
import {acceptProposal,gameCoverage,GAME_SKILLS,queueFacts} from '../src/coordinator-planner';
import {buildBrief} from '../src/author';
const task=(id:string,extra:Partial<CoordTask>={}):CoordTask=>({id,kind:'qualify',goal:'quests',capability:'quest-order',dependsOn:[],priority:5,estimatedMs:60000,why:'Finish useful quest',...extra});
const run=(id:string,deps:string[]=[])=>task(id,{kind:'run',account:'Helper',dependsOn:deps,accept:{quests:["Cook's Assistant"]}});
function complete(s:ReturnType<typeof initialState>,id:string,ok:boolean,at:number,output:any={}){startTask(s,id,at-1,id);finishTask(s,{taskId:id,runId:id,ok,at,output});}

test('an exact repair and raw evidence reach the author brief, not only a generic goal',()=>{
 const t=task('repair',{kind:'build',why:'Repair generated save prefix; read retained failure.log',dependsOn:['old']});
 const work=buildWorkOrder(t,{old:{error:'requires generated fleet practice save'}},'/owned/run');
 const brief=buildBrief({id:'repair',goal:'Generic buy goal\n'+work,preset:''},'scripts/example.ts');
 expect(brief).toContain(t.why);expect(brief).toContain('requires generated fleet practice save');expect(brief).toContain('/owned/run');
});
test('a new source replaces failed refresh edges without erasing failures or build prerequisites',()=>{
 const s=initialState();addTasks(s,[task('refresh-quest-order-old'),task('actual-build',{kind:'build'}),run('consumer',['refresh-quest-order-old','actual-build'])],0);
 complete(s,'refresh-quest-order-old',false,2);refreshQualifications(s,{'quest-order':'newsource'});
 expect(s.tasks[0]!.status).toBe('failed');expect(s.tasks[2]!.spec.dependsOn).toEqual(['actual-build','refresh-quest-order-newsource']);
 refreshQualifications(s,{'quest-order':'newsource'});expect(s.tasks.filter(r=>r.spec.id==='refresh-quest-order-newsource')).toHaveLength(1);
});
test('already qualified source is reused and undemanded capabilities do not spawn practice work',()=>{
 const s=initialState();addTasks(s,[task('proved'),run('consumer'),task('refresh-wine-order-old',{capability:'wine-order'})],0);
 complete(s,'proved',true,3,{delivery:{ok:true,source:'current'}});
 refreshQualifications(s,{'quest-order':'current','wine-order':'unused'});
 expect(s.tasks[1]!.spec.dependsOn).toEqual(['proved']);expect(s.tasks[2]!.status).toBe('superseded');expect(s.tasks).toHaveLength(3);
});
test('failed actual prerequisites create repair demand, not another wasted source qualification',()=>{
 const s=initialState();addTasks(s,[task('broken',{kind:'build'}),run('blocked',['broken']),run('ready')],0);complete(s,'broken',false,2);
 expect(qualificationDemand(s).map(r=>r.spec.id)).toEqual(['ready']);
});
test('never-attempted refresh resumes when demand returns; failed refresh never retries automatically',()=>{
 const s=initialState();addTasks(s,[task('refresh-quest-order-current')],0);refreshQualifications(s,{});expect(s.tasks[0]!.status).toBe('superseded');
 addTasks(s,[run('consumer')],1);refreshQualifications(s,{'quest-order':'current'});expect(s.tasks[0]!.status).toBe('pending');
 complete(s,'refresh-quest-order-current',false,4);refreshQualifications(s,{'quest-order':'current'});expect(s.tasks[0]!.status).toBe('failed');expect(s.tasks[0]!.attempts).toBe(1);
});
test('explicit replacement reconnects a consumer while retaining the exact failed receipt',()=>{
 const s=initialState();addTasks(s,[task('broken',{kind:'build'}),run('consume',['broken'])],0);complete(s,'broken',false,4,{error:'wrong fixture prefix'});
 acceptProposal(s,{reason:'Repair actual input',capabilities:[],tasks:[task('repaired',{kind:'build',why:'Fix prefix, not generic buy'})],replacements:[{from:'broken',to:'repaired'}]});
 expect(s.tasks[0]!.receipt?.output.error).toBe('wrong fixture prefix');expect(s.tasks[1]!.spec.dependsOn).toEqual(['repaired']);expect(s.tasks[0]!.supersededBy).toBe('repaired');
});
test('planner cannot pile another numbered build onto an existing open capability',()=>{
 const s=initialState();addTasks(s,[task('old',{kind:'build'}),run('consumer',['old'])],0);
 expect(()=>acceptProposal(s,{reason:'duplicate',capabilities:[],tasks:[task('new',{kind:'build'})]})).toThrow('duplicating');expect(s.tasks).toHaveLength(2);
 acceptProposal(s,{reason:'replace',capabilities:[],tasks:[task('new',{kind:'build'})],replacements:[{from:'old',to:'new'}]});expect(s.tasks[0]!.status).toBe('superseded');
});
test('an isolated producer build is rejected until a finite live consumer is included',()=>{
 const s=initialState();expect(()=>acceptProposal(s,{reason:'proof only',capabilities:[],tasks:[task('build',{kind:'build'})]})).toThrow('finite live consumer');expect(s.tasks).toHaveLength(0);
 acceptProposal(s,{reason:'whole outcome',capabilities:[],tasks:[task('build',{kind:'build'}),run('consumer',['build'])]});expect(s.tasks).toHaveLength(2);
});
test('replacement cycles, identity swaps and successful-work replacements fail atomically',()=>{
 const s=initialState();addTasks(s,[task('old',{kind:'build'})],0);complete(s,'old',false,2);const before=JSON.stringify(s);
 expect(()=>acceptProposal(s,{reason:'bad',capabilities:[],tasks:[task('cycle',{kind:'build',dependsOn:['old']})],replacements:[{from:'old',to:'cycle'}]})).toThrow('cycle');expect(JSON.stringify(s)).toBe(before);
 const r=initialState();addTasks(r,[run('one'),task('two',{...run('two'),account:'Other'})],0);
 expect(()=>acceptProposal(r,{reason:'bad',capabilities:[],tasks:[],replacements:[{from:'one',to:'two'}]})).toThrow('replacement');
 addTasks(s,[task('verified',{kind:'build'}),task('replacement',{kind:'build'})],0);complete(s,'verified',true,2);
 expect(()=>acceptProposal(s,{reason:'bad',capabilities:[],tasks:[],replacements:[{from:'verified',to:'replacement'}]})).toThrow('replacement');
});
test('a freshly qualified finite live consumer gets one turn before an unrelated build, then builders drain it',()=>{
 const s=initialState();addTasks(s,[task('proof'),run('use-proof',['proof']),task('build',{kind:'build',priority:100})],0);
 complete(s,'proof',true,10,{delivery:{ok:true}});expect(chooseTask(s,11)?.id).toBe('use-proof');
 startTask(s,'use-proof',11,'live');expect(chooseTask(s,12)).toBeNull();
 finishTask(s,{taskId:'use-proof',runId:'live',ok:true,at:13,output:{}});expect(chooseTask(s,14)?.id).toBe('build');
});
test('native resource shortage defers heavy work without failing it or blocking independent live work',()=>{
 const s=initialState();addTasks(s,[task('native'),task('build',{kind:'build',priority:100}),run('live')],0);
 expect(chooseTask(s,1,{nativeReady:false})?.id).toBe('live');expect(s.tasks.every(t=>t.status==='pending')).toBe(true);
 expect(chooseTask(s,2,{nativeReady:true})?.id).toBe('build');
});

test('source admission can prepare a build while native admission stays closed',()=>{
 const s=initialState();addTasks(s,[task('native'),task('build',{kind:'build',priority:100})],0);
 expect(chooseTask(s,1,{sourceReady:false,nativeReady:false})).toBeNull();
 expect(chooseTask(s,2,{sourceReady:true,nativeReady:false})?.id).toBe('build');
 startTask(s,'build',3,'source-owner');expect(chooseTask(s,4,{sourceReady:true,nativeReady:false})).toBeNull();
 finishTask(s,{taskId:'build',runId:'source-owner',ok:false,at:5,output:{}});
 expect(chooseTask(s,6,{sourceReady:true,nativeReady:false})).toBeNull();
 expect(chooseTask(s,7,{sourceReady:true,nativeReady:true})?.id).toBe('native');
});

test('source preparation intentionally drains live writers; a host deferral does not strand independent live work',()=>{
 const s=initialState();addTasks(s,[task('build',{kind:'build',priority:100}),run('live')],0);
 const resources={sourceReady:true,nativeReady:false};
 expect(chooseTask(s,1,resources)?.id).toBe('build');startTask(s,'build',2,'prepare');
 expect(chooseTask(s,3,resources)).toBeNull();
 const delivery={hostDeferred:true,source:'a'.repeat(64),ok:false};
 finishTask(s,{taskId:'build',runId:'prepare',ok:false,at:4,output:{hostDeferred:true,sourcePrepared:true,delivery}});
 addTasks(s,[task('resume',{kind:'build',priority:100})],5);
 expect(chooseTask(s,6,resources)?.id).toBe('live');
 expect(chooseTask(s,7,{...resources,nativeReady:true})?.id).toBe('resume');
 expect(preparedNativeDelivery(s,'quest-order','a'.repeat(64))).toBe(delivery);
 expect(preparedNativeDelivery(s,'quest-order','b'.repeat(64))).toBeNull();
 startTask(s,'resume',8,'undrained');finishTask(s,{taskId:'resume',runId:'undrained',ok:false,at:9,output:null,error:'runtime build waits for a fresh actual fleet drain'});
 expect(preparedNativeDelivery(s,'quest-order','a'.repeat(64))).toBe(delivery);
 addTasks(s,[task('replacement',{kind:'build',priority:100})],10);
 expect(chooseTask(s,11,resources)?.id).toBe('live');
 startTask(s,'replacement',12,'new-code-failure');finishTask(s,{taskId:'replacement',runId:'new-code-failure',ok:false,at:13,output:{error:'real source failure'}});
 expect(preparedNativeDelivery(s,'quest-order','a'.repeat(64))).toBeNull();
});
test('live fleet slots are independent of development slots and production fills distinct account slots',()=>{
 const s=initialState();addTasks(s,[task('review',{kind:'review'}),task('native'),run('live1'),task('live2',{...run('live2'),account:'Other'}),task('writer',{kind:'build',priority:100})],0);
 startTask(s,'review',1,'r');startTask(s,'native',2,'n');
 const options={developmentLimit:2,liveLimit:2,preferLive:true};
 expect(chooseTask(s,3,options)?.id).toBe('live1');startTask(s,'live1',3,'l1');expect(chooseTask(s,4,options)?.id).toBe('live2');startTask(s,'live2',4,'l2');expect(chooseTask(s,5,options)).toBeNull();
});
test('live-first scheduling still never admits a live account during a source writer',()=>{
 const s=initialState();addTasks(s,[task('writer',{kind:'build'}),run('consumer')],0);startTask(s,'writer',1,'w');expect(chooseTask(s,2,{preferLive:true,liveLimit:17,developmentLimit:2})).toBeNull();
});
test('a controller hold can disable live dispatch while leaving development eligible',()=>{
 const s=initialState();addTasks(s,[run('live'),task('review',{kind:'review'})],0);expect(chooseTask(s,1,{preferLive:true})?.id).toBe('live');expect(chooseTask(s,2,{preferLive:true,liveLimit:0})?.id).toBe('review');expect(s.tasks[0]!.status).toBe('pending');
});
test('capacity grows only on useful live receipts, real demand and healthy measured headroom',()=>{
 const s={limit:17,demand:30,freeGB:16,reserveGB:8,cpu:.5,tickMs:400,stalled:false,usefulResults:2,now:1000000,lastExpandedAt:0};
 expect(fleetExpansion(s)).toBe(21);expect(fleetExpansion({...s,demand:19})).toBe(19);
 for(const change of [{usefulResults:0},{demand:17},{freeGB:11},{cpu:null},{cpu:.9},{tickMs:null},{tickMs:1000},{stalled:true},{lastExpandedAt:999999}])expect(fleetExpansion({...s,...change})).toBe(17);
});
test('registration is a live source boundary and waits for an actual fleet slot',()=>{
 const s=initialState();addTasks(s,[task('claim',{kind:'provision',role:'runecraft'}),task('writer',{kind:'build'})],0);startTask(s,'claim',1,'c');expect(chooseTask(s,2)).toBeNull();
 const full=initialState();addTasks(full,[run('live'),task('claim',{kind:'provision',role:'runecraft'})],0);startTask(full,'live',1,'l');expect(chooseTask(full,2,{liveLimit:1})).toBeNull();
});
test('a delivery focus finishes its fleet capability before unrelated source churn',()=>{
 const s=initialState();addTasks(s,[task('focus',{kind:'build',capability:'goldfarm-order',goal:'wealth'}),task('unrelated',{kind:'build',goal:'quests',priority:100}),task('independent-review',{kind:'review',goal:'gear'})],0);
 expect(chooseTask(s,Date.now(),{focusCapability:'goldfarm-order'})?.id).toBe('focus');startTask(s,'focus',Date.now(),'f');expect(chooseTask(s,Date.now(),{focusCapability:'goldfarm-order'})?.id).toBe('independent-review');
});
test('a delivery focus defers unrelated native refreshes while its exact repair is being prepared',()=>{
 const s=initialState();addTasks(s,[task('unrelated-proof',{kind:'qualify',capability:'agility-order',priority:100}),task('independent-review',{kind:'review',goal:'gear'})],0);
 expect(chooseTask(s,1,{focusCapability:'goldfarm-order'})?.id).toBe('independent-review');
 complete(s,'independent-review',true,2);
 expect(chooseTask(s,3,{focusCapability:'goldfarm-order'})).toBeNull();
 expect(chooseTask(s,4)?.id).toBe('unrelated-proof');
});
test('adopting an active source delivery prevents another lane replacing it after a failed check',()=>{
 const s=initialState();addTasks(s,[task('sharks',{kind:'build',capability:'shark-supply-order',goal:'skills'}),task('unrelated',{kind:'build',capability:'fresh-rune-supply-order',priority:100})],0);
 startTask(s,'sharks',10,'source');const focus=activeBuildFocus(s)!;
 finishTask(s,{taskId:'sharks',runId:'source',ok:false,at:20,output:null});
 expect(chooseTask(s,21)?.id).toBe('unrelated');
 expect(chooseTask(s,21,{focusCapability:focus.capability})).toBeNull();
 addTasks(s,[task('repair-sharks',{kind:'build',capability:'shark-supply-order',goal:'skills'})],22);
 expect(chooseTask(s,23,{focusCapability:focus.capability})?.id).toBe('repair-sharks');
 expect(focus.since).toBe(10);
});
test('delivery focus admits required supply work and waits for its source before qualifying',()=>{
 const s=initialState();addTasks(s,[
  run('quest',['supply','quest-proof']),
  task('quest-proof',{capability:'quest-order',priority:100}),
  task('supply',{kind:'run',account:'Courier',capability:'ge-bulk-order',dependsOn:['supply-build','supply-proof'],accept:{bank:{1987:1}}}),
  task('supply-build',{kind:'build',capability:'ge-bulk-order'}),
  task('supply-proof',{capability:'ge-bulk-order',dependsOn:['supply-build']}),
  task('unrelated',{kind:'build',capability:'shark-supply-order',priority:100})
 ],0);
 const resources={focusCapability:'quest-order'};
 expect(chooseTask(s,1,resources)?.id).toBe('supply-build');complete(s,'supply-build',true,2);
 expect(chooseTask(s,3,resources)?.id).toBe('quest-proof');complete(s,'quest-proof',true,4);
 expect(chooseTask(s,5,resources)?.id).toBe('supply-proof');complete(s,'supply-proof',true,6);
 expect(chooseTask(s,7,resources)?.id).toBe('supply');complete(s,'supply',true,8);
 expect(chooseTask(s,9,resources)?.id).toBe('quest');
});
test('whole-game view includes all19 skills, catalogue gaps and all active queue blockers',()=>{
 const c=gameCoverage([{skill:'cooking'}],[{varp:'cookquest'}],[{name:'Reserved',at:1,skills:[{name:'Cooking',level:99}]},{name:'Helper',at:2,skills:[{name:'Cooking',level:12}]}],['Reserved'],['scripts/generated/quest-cook.ts']);
 expect(c.skills.map(s=>s.name)).toEqual(GAME_SKILLS);expect(c.skills.find(s=>s.name==='Cooking')!.bestObserved?.level).toBe(12);
 expect(c.skills.find(s=>s.name==='Agility')!.cataloguedMethods).toBe(0);expect(c.unknown).toContain('not unavailable');expect(c.questCount).toBe(1);
 const s=initialState();addTasks(s,[task('bad'),run('waiting',['bad'])]);complete(s,'bad',false,2);
 expect(queueFacts(s).blocked[0]!.dependencies).toEqual([{id:'bad',status:'failed',replacement:undefined}]);expect(queueFacts(s).lastUsefulLiveAt).toBe(0);
});
