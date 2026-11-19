import {expect,test} from 'bun:test';
import {evaluateCoordinatorProgression,type CoordinatorProgressionOptions} from '../src/coordinator-progression';
import type {CoordTask} from '../src/coordinator';
import type {ProgressionMethod} from '../../planner/src/progression';
import {levelForXp,xpForLevel} from '../../planner/src/curve';
const now=100000;
const task:CoordTask={id:'next',goal:'skills',kind:'run',capability:'ranged-train',account:'A',dependsOn:['qualified'],priority:10,estimatedMs:1000,why:'Ranged50',args:['50'],accept:{skills:{Ranged:50}}};
const method=(id:string,rate:number|null,script=`scripts/${id}.ts`):ProgressionMethod=>({id,source:'content-source',step:{script,args:['50'],env:{}},effects:{xp:{ranged:1}},rate:{unitsPerTick:rate,basis:rate===null?'unknown':'model',evidence:rate===null?'':'content'},costs:{setupTicks:0,travelTicks:0,acquisitionTicks:0,unlockTicks:0}});
const options=(over:Partial<CoordinatorProgressionOptions>={}):CoordinatorProgressionOptions=>({task,entry:'scripts/current.ts',status:{name:'A',at:now,server:'rs-sdk-demo.fly.dev',skills:[{name:'Ranged',level:40,xp:xpForLevel(40)}],inventory:[],equipment:[],equipmentObserved:true,bank:[],bankAt:now,quests:[],questsAt:now},now,
 methods:()=>[method('current',1),method('fast',10)],bindingFor:m=>({capability:m.id==='current'?'ranged-train':'faster-ranged',methodId:m.id,source:'native-source:'+m.id,qualification:{source:'native-source:'+m.id,bands:[{}]},reviewed:true}),...over});
test('a qualified mapped rival stops same-worker retargeting and returns an existing-capability handoff',()=>{
 const r=evaluateCoordinatorProgression(options());
 expect(r.action).toBe('handoff');expect(r.capability).toBe('faster-ranged');expect(r.step?.script).toBe('scripts/fast.ts');expect(r.consumer).toEqual(task.accept!);
});
test('unknown rivals request measurement while a supported current worker continues',()=>{
 const r=evaluateCoordinatorProgression(options({methods:()=>[method('current',1),method('unknown',null)]}));
 expect(r.action).toBe('continue');expect(r.requests.some(q=>q.method==='unknown'&&q.action==='measure')).toBe(true);
});
test('a script match alone cannot manufacture another capability or state-band proof',()=>{
 const r=evaluateCoordinatorProgression(options({bindingFor:m=>m.id==='current'?{capability:'ranged-train',methodId:'current',source:'native',qualification:{source:'native',bands:[{}]},reviewed:true}:null}));
 expect(r.action).toBe('continue');expect(r.capability).toBe('ranged-train');expect(r.requests.some(q=>q.method==='fast'&&q.action==='qualify')).toBe(true);
});
test('stale status and old bank remain observations rather than an authorized new band',()=>{
 const o=options();o.status={...o.status,at:now-10000,bankAt:now-10000};o.maxAgeMs=100;
 expect(evaluateCoordinatorProgression(o).action).toBe('observe');
});
test('paused protected and authored multigoal tasks are not rewritten',()=>{
 expect(evaluateCoordinatorProgression(options({paused:true})).action).toBe('blocked');
 expect(evaluateCoordinatorProgression(options({protected:true})).action).toBe('blocked');
 expect(evaluateCoordinatorProgression(options({task:{...task,accept:{skills:{Ranged:50},quests:['q']}}})).action).toBe('blocked');
});
test('a mismatched proof identity is not reused for a rival method',()=>{
 const o=options(),normal=o.bindingFor!;
 o.bindingFor=(m,a)=>m.id==='fast'?{...normal(m,a)!,methodId:'current'}:normal(m,a);
 const r=evaluateCoordinatorProgression(o);expect(r.action).toBe('continue');expect(r.requests.some(q=>q.method==='fast'&&q.action==='qualify')).toBe(true);
});
test('finite item acceptance keeps its consumer and ignores unrelated high XP',()=>{
 const current=method('current',1);current.effects={items:{2:1}};
 const fast=method('fast',10);fast.effects={items:{2:1}};
 const r=evaluateCoordinatorProgression(options({task:{...task,accept:{bank:{2:3}}},methods:()=>[current,fast,method('xp',10000)]}));
 expect(r.action).toBe('handoff');expect(r.intent).toMatchObject({kind:'acquire',items:{2:3}});expect(r.stepAccept?.bank?.['2']).toBe(3);
});
test('a completed finite consumer adds no continuation',()=>{
 const o=options();o.status={...o.status,skills:[{name:'Ranged',level:50,xp:xpForLevel(50)}]};
 expect(evaluateCoordinatorProgression(o).action).toBe('complete');
});
test('a quest unlock route returns each finite step with the original final training consumer',()=>{
 const q=method('unlock',1,'scripts/quest.ts');q.effects={quests:['unlock'],xp:{ranged:xpForLevel(45)-xpForLevel(40)}};q.repeatable=false;
 const fast=method('fast',10);fast.requirements={quests:['unlock']};
 const o=options({methods:()=>[method('current',1),q,fast],bindingFor:m=>({capability:m.id==='current'?'ranged-train':m.id==='unlock'?'unlock-quest':'faster-ranged',methodId:m.id,source:'native:'+m.id,qualification:{source:'native:'+m.id,bands:[{}]},reviewed:true})});
 o.status={...o.status,quests:[{name:'unlock',state:'not started'}]};
 const r=evaluateCoordinatorProgression(o);
 expect(r.route?.map(s=>s.capability)).toEqual(['unlock-quest','faster-ranged']);
 expect(r.route?.[0]?.accept).toEqual({quests:['unlock']});expect(r.route?.[1]?.accept).toEqual({skills:{Ranged:50}});expect(r.consumer).toEqual({skills:{Ranged:50}});
});

test('a next-band first step stops at the level inside the proved XP, never at the consumer target',()=>{
 // Ranged 85 to 90 needs more XP than the proof run made: the step is cut to the level that the proved XP reaches.
 const proved=123160,start=xpForLevel(85),reached=levelForXp(start+proved);
 expect(reached).toBeGreaterThanOrEqual(85);expect(reached).toBeLessThan(90);
 const ranged:ProgressionMethod=({...method('fast',10,'scripts/ranged-train.ts'),step:{script:'scripts/ranged-train.ts',args:['90'],env:{TARGET_LEVEL:'90'}},
  execution:{targetArg:0,targetEnv:['TARGET_LEVEL']}} as ProgressionMethod);
 const band={levels:{Ranged:{min:80}},gainXp:{Ranged:proved}};
 const o=options({task:{...task,args:['90'],accept:{skills:{Ranged:90}}},methods:()=>[ranged],
  status:{...options().status,skills:[{name:'Ranged',level:85,xp:start}]},
  bindingFor:m=>({capability:'ranged-train',methodId:m.id,source:'native-source:'+m.id,qualification:{source:'native-source:'+m.id,bands:[band]},reviewed:true})});
 const r=evaluateCoordinatorProgression(o);
 // The planner cap on units is the proved XP: the step that it plans holds one whole level, and its target is never 90.
 expect(r.step).not.toBeNull();
 const target=Number(r.step!.env.TARGET_LEVEL);
 expect(target).toBe(reached);
 expect(target).toBeLessThan(90);
 expect(Number(r.step!.args[0])).toBe(target);
 expect(r.stepAccept).toEqual({skills:{Ranged:reached}});
});
