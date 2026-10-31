import {test,expect} from 'bun:test';
import {initialState,addTasks,startTask,finishTask,chooseTask,compactState,type CoordTask,type CoordinatorState} from '../src/coordinator';
import {applyRules,nextBand,retarget,type RuleDeps} from '../src/coordinator-rules';

const NOW=10_000_000;
const deps=(extra:Partial<RuleDeps>={}):RuleDeps=>({fingerprint:()=>'src-a',unlocks:()=>[20,30,31,40,50],level:()=>undefined,paused:()=>false,maxOpen:4,...extra});
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
test('no task without a fresh approved qualification',()=>{
 expect(applyRules(chain(),deps({fingerprint:()=>'src-b'}),NOW)).toEqual([]);
 expect(applyRules(chain(),deps({fingerprint:()=>{throw Error('source missing');}}),NOW)).toEqual([]);
 const rejected=chain();addTasks(rejected,[{id:'review-ranged-2',goal:'skills',kind:'review',capability:'ranged-train',dependsOn:[],priority:15,estimatedMs:1000,why:'Review ranged'}],NOW);
 finish(rejected,'review-ranged-2',true,{review:{approved:false,reason:'scripts/ranged-train.ts:10 death risk'},evidence:'source-review'},NOW-1000);
 expect(applyRules(rejected,deps(),NOW)).toEqual([]);
 const noReview=chain();noReview.tasks=noReview.tasks.filter(r=>r.spec.kind!=='review');
 expect(applyRules(noReview,deps(),NOW)).toEqual([]);
 expect(applyRules(chain(),deps(),NOW+25*60*60*1000)).toEqual([]);
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
