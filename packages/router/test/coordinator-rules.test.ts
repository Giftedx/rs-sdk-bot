import {test,expect} from 'bun:test';
import {initialState,addTasks,startTask,finishTask,chooseTask,compactState,type CoordTask,type CoordinatorState} from '../src/coordinator';
import {applyRules,nextBand,retarget,type RuleDeps,type RuleSkip} from '../src/coordinator-rules';
import type {CoordinatorProgressionResult} from '../src/coordinator-progression';

const NOW=10_000_000;
const deps=(extra:Partial<RuleDeps>={}):RuleDeps=>({fingerprint:()=>'src-a',unlocks:()=>[20,30,31,40,50],level:()=>undefined,paused:()=>false,maxOpen:4,
 side:'local',fleetBest:()=>({best:30,account:'Bigchopper',side:'local'}),...extra});
const finish=(s:CoordinatorState,id:string,ok:boolean,output:any,at:number)=>{startTask(s,id,at-10,'run-'+id);finishTask(s,{taskId:id,runId:'run-'+id,ok,at,output});};
const band=(id:string,level:number,extra:Partial<CoordTask>={}):CoordTask=>({id,goal:'skills',kind:'run',capability:'ranged-train',account:'Bigchopper',dependsOn:['qualify-ranged'],priority:40,estimatedMs:600000,
 why:'Ranged band',args:[String(level),'10000'],env:{CAP:'10000',MIN_ARROWS:'200'},accept:{skills:{Ranged:level}},...extra});
// A capability qualified at source src-a with an approved review and a successful live band to Ranged 30. The planner
// failed on its last round.
function chain(){
 const s=initialState();s.lastPlanReason='planner failed: subscription planner unavailable';
 addTasks(s,[{id:'qualify-ranged',goal:'skills',kind:'qualify',capability:'ranged-train',dependsOn:[],priority:15,estimatedMs:1000,why:'Qualify ranged'},
  {id:'review-ranged',goal:'skills',kind:'review',capability:'ranged-train',dependsOn:[],priority:15,estimatedMs:1000,why:'Review ranged'},band('run-ranged-30',30)],NOW-5000);
 finish(s,'qualify-ranged',true,{delivery:{ok:true,source:'src-a',id:'ranged-train'},evidence:'native'},NOW-4000);
 finish(s,'review-ranged',true,{review:{approved:true,reason:''},evidence:'source-review'},NOW-3000);
 finish(s,'run-ranged-30',true,{evidence:'live',account:'Bigchopper'},NOW-2000);
 return s;
}

test('with the planner failed, a band that reached its target queues the next band of the same capability',()=>{
 const s=chain(),added=applyRules(s,deps(),NOW);
 expect(added.map(t=>t.id)).toEqual(['chain-ranged-train-bigchopper-ranged40']);
 const t=added[0]!;
 expect(t).toMatchObject({kind:'run',capability:'ranged-train',account:'Bigchopper',rule:'next-band',args:['40','10000'],env:{CAP:'10000',MIN_ARROWS:'200'},accept:{skills:{Ranged:40}},dependsOn:['qualify-ranged','run-ranged-30']});
 expect(t.why).toStartWith('Rule next-band:');
 // The normal dispatcher picks it up; nothing waits for a model round.
 expect(chooseTask(s,NOW)?.id).toBe(t.id);
});
test('no task without a readable source and an approved review',()=>{
 expect(applyRules(chain(),deps({fingerprint:()=>{throw Error('source missing');}}),NOW)).toEqual([]);
 const rejected=chain();addTasks(rejected,[{id:'review-ranged-2',goal:'skills',kind:'review',capability:'ranged-train',dependsOn:[],priority:15,estimatedMs:1000,why:'Review ranged'}],NOW);
 finish(rejected,'review-ranged-2',true,{review:{approved:false,reason:'scripts/ranged-train.ts:10 death risk'},evidence:'source-review'},NOW-1000);
 expect(applyRules(rejected,deps(),NOW)).toEqual([]);
 const noReview=chain();noReview.tasks=noReview.tasks.filter(r=>r.spec.kind!=='review');
 expect(applyRules(noReview,deps(),NOW)).toEqual([]);
 expect(applyRules(chain(),deps(),NOW+25*60*60*1000)).toEqual([]);
});
test('a stale qualification after a successful band queues one refresh qualify and the next band behind it',()=>{
 const s=chain(),added=applyRules(s,deps({fingerprint:()=>'src-b'}),NOW);
 expect(added.map(t=>[t.id,t.kind])).toEqual([['refresh-ranged-train-src-b','qualify'],['chain-ranged-train-bigchopper-ranged40','run']]);
 expect(added[0]).toMatchObject({capability:'ranged-train',dependsOn:[]});
 expect(added[1]).toMatchObject({rule:'next-band',accept:{skills:{Ranged:40}},dependsOn:['refresh-ranged-train-src-b','run-ranged-30']});
 // The qualify runs first; the band waits for it.
 expect(chooseTask(s,NOW)?.id).toBe('refresh-ranged-train-src-b');
 expect(applyRules(s,deps({fingerprint:()=>'src-b'}),NOW+1)).toEqual([]);
 // A refresh already queued for another consumer is reused, never duplicated.
 const queued=chain();addTasks(queued,[{id:'refresh-ranged-train-src-b',goal:'skills',kind:'qualify',capability:'ranged-train',dependsOn:[],priority:15,estimatedMs:240000,why:'Refresh'}],NOW);
 expect(applyRules(queued,deps({fingerprint:()=>'src-b'}),NOW).map(t=>[t.id,t.dependsOn])).toEqual([['chain-ranged-train-bigchopper-ranged40',['refresh-ranged-train-src-b','run-ranged-30']]]);
});
test('a current qualification queues only the run',()=>{
 expect(applyRules(chain(),deps(),NOW).map(t=>t.kind)).toEqual(['run']);
});
test('a failed refresh stops the rule',()=>{
 const s=chain(),[refresh]=applyRules(s,deps({fingerprint:()=>'src-b'}),NOW);
 finish(s,refresh!.id,false,{delivery:{ok:false,source:'src-b'},error:'native qualification failed'},NOW+1000);
 expect(applyRules(s,deps({fingerprint:()=>'src-b'}),NOW+1500)).toEqual([]);
 // The blocked band stays pending until the planner clears it; the failed refresh still stops the rule after that.
 s.tasks.find(r=>r.spec.rule)!.status='superseded';
 expect(applyRules(s,deps({fingerprint:()=>'src-b'}),NOW+2000)).toEqual([]);
});
test('the fleet leader of a skill continues its chain',()=>{
 expect(applyRules(chain(),deps({fleetBest:()=>({best:30,account:'bigchopper',side:'local'})}),NOW).map(t=>t.accept)).toEqual([{skills:{Ranged:40}}]);
});

test('goal continuation supports an army account below fleet best and rejects a pointless leader',()=>{
 const evaluate=()=>({value:1,reason:'army Ranged deficit'});
 expect(applyRules(chain(),deps({fleetBest:()=>({best:99,account:'Shaftshooter',side:'local'}),goalValue:evaluate}),NOW).map(t=>t.accept)).toEqual([{skills:{Ranged:40}}]);
 const skipped:RuleSkip[]=[];
 expect(applyRules(chain(),deps({goalValue:()=>({value:0,reason:'No goal or supply consumer'}),skipped:s=>skipped.push(s)}),NOW)).toEqual([]);
 expect(skipped[0]?.reason).toBe('No goal or supply consumer');
});
test('a band far below a 99 held by another account is skipped and reported',()=>{
 const skips:RuleSkip[]=[];
 expect(applyRules(chain(),deps({fleetBest:()=>({best:99,account:'Shaftshooter',side:'local'}),skipped:s=>skips.push(s)}),NOW)).toEqual([]);
 expect(skips).toEqual([{capability:'ranged-train',account:'Bigchopper',skill:'Ranged',next:40,reason:'fleet best Ranged 99 is held by Shaftshooter (local); Bigchopper band to 40 does not reach it'}]);
 // The same account name on another side is not this account.
 expect(applyRules(chain(),deps({fleetBest:()=>({best:99,account:'Bigchopper',side:'cloud'})}),NOW)).toEqual([]);
 expect(applyRules(chain(),deps({fleetBest:()=>undefined}),NOW)).toEqual([]);
 // A skipped band adds no refresh qualify either.
 expect(applyRules(chain(),deps({fingerprint:()=>'src-b',fleetBest:()=>({best:99,account:'Shaftshooter',side:'cloud'})}),NOW)).toEqual([]);
});
test('a non-leader whose next band reaches the fleet best continues',()=>{
 expect(applyRules(chain(),deps({fleetBest:()=>({best:40,account:'Shaftshooter',side:'cloud'})}),NOW).map(t=>t.accept)).toEqual([{skills:{Ranged:40}}]);
 expect(applyRules(chain(),deps({fleetBest:()=>({best:35,account:'Shaftshooter',side:'local'})}),NOW).map(t=>t.accept)).toEqual([{skills:{Ranged:40}}]);
});
test('no duplicate run for the same account and capability',()=>{
 const s=chain();expect(applyRules(s,deps(),NOW)).toHaveLength(1);
 expect(applyRules(s,deps(),NOW+1)).toEqual([]);
 const planned=chain();addTasks(planned,[band('run-ranged-planner-40',40,{dependsOn:['qualify-ranged']})],NOW);
 expect(applyRules(planned,deps(),NOW)).toEqual([]);
 expect(applyRules(chain(),deps({maxOpen:0}),NOW)).toEqual([]);
});
test('a failed rule output stops the rule until a planner or owner run succeeds',()=>{
 const s=chain(),[t]=applyRules(s,deps(),NOW);
 finish(s,t!.id,false,{evidence:'live',error:'worker result did not meet the useful-effect contract'},NOW+1000);
 expect(applyRules(s,deps(),NOW+2000)).toEqual([]);
 addTasks(s,[band('run-ranged-repair-40',40)],NOW+3000);finish(s,'run-ranged-repair-40',true,{evidence:'live'},NOW+4000);
 expect(applyRules(s,deps(),NOW+5000).map(r=>r.accept)).toEqual([{skills:{Ranged:50}}]);
});
test('a rule leaves supply chains, paused, protected and multi-target runs to the planner',()=>{
 const supply=chain();
 addTasks(supply,[{...band('run-ge-arrows',1),capability:'ge-bulk-order',accept:{bank:{'884':100}},args:undefined,env:undefined,dependsOn:[]}],NOW);
 finish(supply,'run-ge-arrows',true,{evidence:'live'},NOW-1500);
 addTasks(supply,[band('run-ranged-35',35,{dependsOn:['qualify-ranged','run-ge-arrows']})],NOW);finish(supply,'run-ranged-35',true,{evidence:'live'},NOW-1000);
 expect(applyRules(supply,deps(),NOW)).toEqual([]);
 expect(applyRules(chain(),deps({paused:a=>a==='Bigchopper'}),NOW)).toEqual([]);
 const main=chain();main.tasks.find(r=>r.spec.id==='run-ranged-30')!.spec.account='Haggis';
 expect(applyRules(main,deps(),NOW)).toEqual([]);
 const bank=chain();bank.tasks.find(r=>r.spec.id==='run-ranged-30')!.spec.accept={skills:{Ranged:30},bank:{'884':10}};
 expect(applyRules(bank,deps(),NOW)).toEqual([]);
});
test('band targets follow method unlocks and the observed level',()=>{
 expect(nextBand(30,[31,40,50])).toBe(40);
 expect(nextBand(45,[])).toBe(55);
 expect(nextBand(95,[])).toBe(99);
 expect(nextBand(99,[])).toBeNull();
 const [t]=applyRules(chain(),deps({level:()=>42}),NOW);
 expect(t!.accept).toEqual({skills:{Ranged:50}});
 expect(retarget(band('x',30,{args:['10000'],env:{CAP:'30'}}),'Ranged',30,40)).toBeNull();
 expect(retarget(band('x',37,{args:undefined,env:{TARGET_LEVEL:'37',CAP:'6000'}}),'Magic',37,45)?.env).toEqual({TARGET_LEVEL:'45',CAP:'6000'});
});
test('archived dependencies of a finished band do not block its next band',()=>{
 const s=initialState();
 addTasks(s,[{id:'old-qualify',goal:'skills',kind:'qualify',capability:'ranged-train',dependsOn:[],priority:15,estimatedMs:1000,why:'Old qualify'}],0);
 finish(s,'old-qualify',true,{delivery:{ok:true,source:'old'}},10);
 const fresh=chain();s.tasks.push(...fresh.tasks);s.tasks.find(r=>r.spec.id==='run-ranged-30')!.spec.dependsOn.push('old-qualify');
 expect(compactState(s,NOW,1000).map(r=>r.spec.id)).toEqual(['old-qualify']);
 expect(applyRules(s,deps(),NOW).map(t=>t.id)).toEqual(['chain-ranged-train-bigchopper-ranged40']);
});
const progressionResult=(over:Partial<CoordinatorProgressionResult>={}):CoordinatorProgressionResult=>({action:'handoff',intent:{kind:'train',skill:'Ranged',targetLevel:40},step:{script:'scripts/faster.ts',args:['40'],env:{TRAIN_SKILL:'Ranged'}},capability:'faster-ranged',decision:null,stepAccept:{skills:{Ranged:40}},consumer:{skills:{Ranged:40}},requests:[],reason:'Faster qualified finite method',...over});
function qualifyRival(s:CoordinatorState,capability='faster-ranged'){
 addTasks(s,[{id:'qualify-'+capability,kind:'qualify',goal:'skills',capability,dependsOn:[],priority:15,estimatedMs:1000,why:'Qualify finite method'},
  {id:'review-'+capability,kind:'review',goal:'skills',capability,dependsOn:[],priority:15,estimatedMs:1000,why:'Review finite method'}],NOW-1000);
 finish(s,'qualify-'+capability,true,{delivery:{ok:true,id:capability,source:'src-a'},evidence:'native'},NOW-900);
 finish(s,'review-'+capability,true,{review:{approved:true,reason:''},evidence:'source-review'},NOW-800);
}
test('state-aware continuation replaces the obsolete worker and binds the rival qualification',()=>{
 const s=chain();qualifyRival(s);
 const added=applyRules(s,deps({progression:()=>progressionResult()}),NOW);
 expect(added).toHaveLength(1);expect(added[0]).toMatchObject({capability:'faster-ranged',args:['40'],accept:{skills:{Ranged:40}},dependsOn:['qualify-faster-ranged','run-ranged-30']});
 expect(applyRules(s,deps({progression:()=>progressionResult()}),NOW+1)).toEqual([]);
});
test('a missing native state proof stops only that continuation and does not retarget the obsolete worker',()=>{
 const s=chain();const result=progressionResult({action:'measure',step:null,capability:null,stepAccept:null,requests:[{method:'fast',action:'qualify',reason:'state proof missing'}]});
 expect(applyRules(s,deps({progression:()=>result}),NOW)).toEqual([]);
});
test('an unknown rival does not stop a qualified current method from its next finite band',()=>{
 const result=progressionResult({action:'continue',capability:'ranged-train',step:{script:'scripts/ranged-train.ts',args:['40','10000'],env:{CAP:'10000'}},requests:[{method:'rival',action:'measure',reason:'rate unknown'}]});
 expect(applyRules(chain(),deps({progression:()=>result}),NOW)[0]).toMatchObject({capability:'ranged-train',accept:{skills:{Ranged:40}}});
});
test('a prerequisite and its original useful consumer stay linked through their own qualifications',()=>{
 const s=chain();qualifyRival(s);qualifyRival(s,'unlock-quest');
 const step={script:'scripts/quest.ts',args:['unlock'],env:{}};
 const result=progressionResult({capability:'unlock-quest',step,stepAccept:{quests:['unlock']},route:[{capability:'unlock-quest',step,accept:{quests:['unlock']}},{capability:'faster-ranged',step:{script:'scripts/faster.ts',args:['40'],env:{}},accept:{skills:{Ranged:40}}}]});
 const added=applyRules(s,deps({progression:()=>result,goalValue:(task,prerequisites=[])=>({value:task.dependsOn.every(id=>s.tasks.some(r=>r.spec.id===id)||prerequisites.some(r=>r.id===id))?1:null,reason:'Finite chain dependencies are present'})}),NOW),first=added.find(t=>t.capability==='unlock-quest'),consumer=added.find(t=>t.capability==='faster-ranged');
 expect(first?.accept).toEqual({quests:['unlock']});expect(consumer?.accept).toEqual({skills:{Ranged:40}});
 expect(consumer?.dependsOn).toContain(first!.id);expect(consumer?.dependsOn).toContain('qualify-faster-ranged');
});
test('a callback cannot bypass a rival review or source qualification',()=>{
 expect(applyRules(chain(),deps({progression:()=>progressionResult()}),NOW)).toEqual([]);
 const s=chain();qualifyRival(s);
 expect(applyRules(s,deps({fingerprint:cap=>cap==='faster-ranged'?'changed':'src-a',progression:()=>progressionResult()}),NOW)).toEqual([]);
});

test('a next-band route whose last step is cut below the consumer level queues nothing',()=>{
 // The planner cuts a step to the XP that its proof made (Ranged 85 to 89 inside 123,160 XP). The consumer asks for 40
 // here; a step that ends at 39 does not reach it, so the rule adds no task and names the reason.
 const s=chain();qualifyRival(s);
 const cut=progressionResult({stepAccept:{skills:{Ranged:39}},step:{script:'scripts/faster.ts',args:['39'],env:{TARGET_LEVEL:'39'}},
  route:[{capability:'faster-ranged',step:{script:'scripts/faster.ts',args:['39'],env:{TARGET_LEVEL:'39'}},accept:{skills:{Ranged:39}}}]});
 const skipped:RuleSkip[]=[];
 expect(applyRules(s,deps({progression:()=>cut,skipped:x=>{skipped.push(x);}}),NOW)).toEqual([]);
 expect(skipped.some(x=>/no bound step that reaches the original finite consumer/.test(x.reason))).toBe(true);
 // The same route cut exactly at the consumer level is queued with the cut step.
 const full=progressionResult({route:[{capability:'faster-ranged',step:{script:'scripts/faster.ts',args:['40'],env:{TARGET_LEVEL:'40'}},accept:{skills:{Ranged:40}}}]});
 const ready=chain();qualifyRival(ready);
 const added=applyRules(ready,deps({progression:()=>full}),NOW);
 expect(added.length).toBe(1);
 expect(added[0]).toMatchObject({capability:'faster-ranged',accept:{skills:{Ranged:40}},env:{TARGET_LEVEL:'40'}});
});
