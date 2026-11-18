import {expect,test} from 'bun:test';
import {chooseProgression,progressionFingerprint,type ObservedAccount,type ProgressionMethod,type WorkIntent} from '../src/progression';
import {xpForLevel} from '../src/curve';
const now=100000,obs=<T>(value:T)=>({at:now,value});
const account=(over:Partial<ObservedAccount>={}):ObservedAccount=>({account:'Trainee',at:now,skills:{Ranged:{level:40,xp:xpForLevel(40)}},inventory:obs({}),equipment:obs({}),bank:obs({}),quests:obs({}),...over});
const intent:WorkIntent={kind:'train',skill:'Ranged',targetLevel:50};
const method=(id:string,rate:number|null,over:Partial<ProgressionMethod>={}):ProgressionMethod=>({id,step:{script:`scripts/${id}.ts`,args:[],env:{}},source:'s1',effects:{xp:{Ranged:1}},rate:{unitsPerTick:rate,basis:rate===null?'unknown':'model',evidence:'content fixture'},costs:{setupTicks:0,travelTicks:0,acquisitionTicks:0,unlockTicks:0},...over});

test('compound training completes only after every observed skill reaches its target',()=>{
 const goal={kind:'train-all',targets:{Ranged:50,Defence:50}} as unknown as WorkIntent;
 const a=account({skills:{Ranged:{level:50,xp:xpForLevel(50)},Defence:{level:40,xp:xpForLevel(40)}}});
 const defence=method('defence',100,{effects:{xp:{Defence:1}}});
 const pending=chooseProgression(goal,a,[defence,method('unknown',null)],{now});
 expect(pending.state).toBe('execute');expect(pending.selected).toBe('defence');
 expect(pending.expectedTicks).toBe((xpForLevel(50)-xpForLevel(40))/100);
 expect(chooseProgression(goal,{...a,skills:{...a.skills,Defence:{level:50,xp:xpForLevel(50)}}},[],{now}).state).toBe('complete');
 expect(chooseProgression(goal,account(),[defence],{now}).state).toBe('observe');
});

test('compound training joins finite methods and preserves each qualification and build ceiling',()=>{
 const goal={kind:'train-all',targets:{Ranged:41,Defence:41}} as unknown as WorkIntent;
 const a=account({skills:{Ranged:{level:40,xp:xpForLevel(40)},Defence:{level:40,xp:xpForLevel(40)}}});
 const ranged=method('ranged',100,{qualification:{source:'s1',bands:[{}]}}),defence=method('defence',100,{effects:{xp:{Defence:1}},qualification:{source:'s1',bands:[{}]}});
 const both=chooseProgression(goal,a,[ranged,defence],{now,requireQualification:true});
 expect(both.state).toBe('execute');expect(both.path.map(step=>step.method).sort()).toEqual(['defence','ranged']);
 const missing={...defence,qualification:undefined};
 expect(chooseProgression(goal,a,[ranged,missing],{now,requireQualification:true}).state).not.toBe('execute');
 expect(chooseProgression(goal,{...a,build:{maxLevels:{Defence:40}}},[ranged,defence],{now}).state).toBe('blocked');
 expect(chooseProgression(goal,a,[method('side-xp',100,{effects:{xp:{Ranged:1,Defence:1,Strength:100}}})],{now}).state).toBe('execute');
 const capped={...a,skills:{...a.skills,Strength:{level:1,xp:0}},build:{maxLevels:{Strength:1}}};
 expect(chooseProgression(goal,capped,[method('side-xp',100,{effects:{xp:{Ranged:1,Defence:1,Strength:100}}})],{now}).state).toBe('blocked');
});

test('compound training refuses empty, invalid, duplicate and unobserved target maps',()=>{
 for(const targets of [{},{Ranged:100},{Ranged:0},{Ranged:40.5},{Ranged:41,ranged:41},{Nonsense:41}]){
  const goal={kind:'train-all',targets} as unknown as WorkIntent;
  expect(chooseProgression(goal,account(),[method('ranged',100)],{now}).state).toBe('observe');
 }
});

test('compound side XP needs an observed starting level for every protected build skill',()=>{
 const goal={kind:'train-all',targets:{Ranged:41,Defence:41}} as unknown as WorkIntent;
 const a=account({skills:{Ranged:{level:40,xp:xpForLevel(40)},Defence:{level:40,xp:xpForLevel(40)}},build:{maxLevels:{Strength:50}}});
 const result=chooseProgression(goal,a,[method('side-xp',100,{effects:{xp:{Ranged:1,Defence:1,Strength:1}}})],{now});
 expect(result.state).toBe('observe');expect(result.reason).toContain('Strength');
});
test('total time includes setup, travel and recurring resupply',()=>{
 const fast=method('fast',100,{costs:{setupTicks:1000,travelTicks:1000,acquisitionTicks:0,unlockTicks:0,resupply:{everyUnits:100,ticks:2}}});
 expect(chooseProgression(intent,account(),[fast,method('near',10)],{now}).selected).toBe('near');
});
test('unknown rivals request measurement while a ready method continues',()=>{
 const r=chooseProgression(intent,account(),[method('unknown',null),method('ready',10)],{now,currentMethod:'ready'});
 expect(r.state).toBe('execute');expect(r.selected).toBe('ready');expect(r.followUps).toContainEqual(expect.objectContaining({method:'unknown',state:'measure'}));
});
test('stale bank never becomes fresh from account timestamp',()=>{
 const bow=method('bow',10,{requirements:{items:{861:1}}});
 const r=chooseProgression(intent,account({bank:{at:0,value:{861:1}}}),[bow],{now,maxAgeMs:1000});
 expect(r.state).toBe('observe');expect(r.selected).toBeNull();
});
test('reservations prevent the same finite inputs from funding the whole route',()=>{
 const r=chooseProgression({kind:'produce',items:{2:10},consumer:'quest'},account({bank:obs({1:10}),reservations:{1:5}}),[method('craft',1,{effects:{items:{2:1}},inputs:{1:1}})],{now});
 expect(r.state).toBe('acquire');expect(r.selected).toBeNull();
});
test('finite acquisition can unlock a faster route and appears before its consumer',()=>{
 const buy=method('buy',1,{effects:{items:{861:1}},repeatable:false,costs:{setupTicks:2,travelTicks:0,acquisitionTicks:0,unlockTicks:0}});
 const train=method('train',100,{requirements:{items:{861:1}}});
 const r=chooseProgression(intent,account(),[method('slow',1),train,buy],{now});
 expect(r.selected).toBe('buy');expect(r.path.map(s=>s.method)).toEqual(['buy','train']);
});
test('quest reward and unlock are one finite transition with useful side XP',()=>{
 const q=method('quest',1,{effects:{quests:['unlock'],xp:{Ranged:xpForLevel(45)-xpForLevel(40)}},repeatable:false});
 const fast=method('unlocked',100,{requirements:{quests:['unlock']}});
 const r=chooseProgression(intent,account({quests:obs({unlock:false})}),[method('slow',1),q,fast],{now});
 expect(r.path.map(s=>s.method)).toEqual(['quest','unlocked']);expect(r.path[0]?.units).toBe(1);
});
test('method changes at a better unlock rather than taking starter to target',()=>{
 const r=chooseProgression(intent,account(),[method('starter',1),method('higher',100,{requirements:{levels:{Ranged:45}}})],{now});
 expect(r.path.map(s=>s.method)).toEqual(['starter','higher']);
 expect(r.path[0]?.units).toBe(xpForLevel(45)-xpForLevel(40));
});
test('side XP cannot breach an account build or a protected clock',()=>{
 const harmful=method('harmful',100,{effects:{xp:{Ranged:1,Defence:100}}});
 const a=account({skills:{...account().skills,Defence:{level:1,xp:0}},build:{maxLevels:{Defence:1}}});
 expect(chooseProgression(intent,a,[harmful,method('safe',1)],{now}).selected).toBe('safe');
 expect(chooseProgression(intent,account({clock:{protected:true,fresh:true,authorized:false}}),[method('ready',1)],{now}).state).toBe('blocked');
});
test('source and account-state qualification must both match',()=>{
 const bad=method('bad',100,{qualification:{source:'old',bands:[{}]}});
 const wrongBand=method('band',100,{qualification:{source:'s1',bands:[{levels:{Ranged:{min:70}}}]}});
 const good=method('good',1,{qualification:{source:'s1',bands:[{levels:{Ranged:{min:1,max:60}}}]}});
 const r=chooseProgression(intent,account(),[bad,wrongBand,good],{now,requireQualification:true});
 expect(r.selected).toBe('good');expect(r.followUps.filter(f=>f.state==='qualify')).toHaveLength(2);
});
test('finite item and quest goals retain their authored output',()=>{
 const r=chooseProgression({kind:'produce',items:{2:3},consumer:'unlock'},account(),[method('xp',100),method('item',1,{effects:{items:{2:1}}})],{now});
 expect(r.selected).toBe('item');expect(r.path[0]?.units).toBe(3);
 expect(chooseProgression({kind:'quest',quest:'q'},account({quests:obs({q:true})}),[],{now}).state).toBe('complete');
});
test('fingerprint is deterministic and changes with state, goal, source or rates',()=>{
 const a=account(),m=[method('m',1)],ctx={now};const f=progressionFingerprint(intent,a,m,ctx);
 expect(progressionFingerprint(intent,a,m,ctx)).toBe(f);
 for(const b of [account({reservations:{1:1}}),account({position:obs({x:1,z:2,level:0})}),account({source:'other'})])expect(progressionFingerprint(intent,b,m,ctx)).not.toBe(f);
 expect(progressionFingerprint({...intent,targetLevel:60},a,m,ctx)).not.toBe(f);
 expect(progressionFingerprint(intent,a,[method('m',2)],ctx)).not.toBe(f);
});
test('bounded search reports its limit rather than claiming global optimality',()=>{
 const r=chooseProgression(intent,account(),[method('a',1),method('b',2)],{now,maxSearchNodes:1,maxDepth:1});
 expect(r.search.exhausted).toBe(true);expect(r.gaps.join(' ')).toMatch(/bound|supplied/i);
 expect(r.selected).toBe('b');
});
test('a long target can repay an upgrade that loses on a near target',()=>{
 const fast=method('fast',100,{costs:{setupTicks:1000,travelTicks:1000,acquisitionTicks:0,unlockTicks:0}}),near=method('near',10);
 expect(chooseProgression({...intent,targetLevel:41},account(),[fast,near],{now}).selected).toBe('near');
 expect(chooseProgression({...intent,targetLevel:99},account(),[fast,near],{now}).selected).toBe('fast');
});
test('crowding and changed-source samples do not license a measured speed',()=>{
 const measured=method('measured',100,{rate:{unitsPerTick:100,basis:'measured',evidence:'raw',conditions:{maxCrowding:1},samples:[{units:1000,ticks:10,source:'old',conditions:{},evidence:'raw'}]}});
 for(const crowding of [0,3]){
  const r=chooseProgression(intent,account(),[measured,method('fallback',1)],{now,crowding});
  expect(r.selected).toBe('fallback');expect(r.followUps).toContainEqual(expect.objectContaining({method:'measured',state:'measure'}));
 }
});
test('a state-band proof and rate cannot be extrapolated past the next level boundary',()=>{
 const starter=method('starter',100,{rate:{unitsPerTick:100,basis:'measured',evidence:'40-44 sample',conditions:{levels:{Ranged:{min:40,max:44}}}},qualification:{source:'s1',bands:[{levels:{Ranged:{min:40,max:44}}}]}});
 const later=method('later',1,{requirements:{levels:{Ranged:45}},qualification:{source:'s1',bands:[{levels:{Ranged:{min:45,max:99}}}]}});
 const r=chooseProgression(intent,account(),[starter,later],{now,requireQualification:true});
 expect(r.path.map(s=>s.method)).toEqual(['starter','later']);
 expect(r.path[0]?.units).toBe(xpForLevel(45)-xpForLevel(40));
});
test('an admitted entry supply count does not become a remaining-stock minimum after one shot',()=>{
 const m=method('ranged',10,{requirements:{items:{882:3}},qualification:{source:'s1',bands:[{items:{882:149},levels:{Ranged:{min:40,max:50}},loadout:[841]}]}});
 const entry=account({bank:obs({882:149}),equipment:obs({841:1})}),live=account({bank:obs({882:148}),equipment:obs({841:1})});
 const admitted={method:'ranged',source:'s1',intent,account:entry};
 expect(chooseProgression(intent,live,[m],{now,requireQualification:true,admitted}).state).toBe('execute');
 expect(chooseProgression(intent,live,[m],{now,requireQualification:true}).state).toBe('qualify');
});
test('admission never reuses an old source, goal, account, level or equipped kit',()=>{
 const m=method('ranged',10,{requirements:{items:{882:3}},qualification:{source:'s1',bands:[{items:{882:149},levels:{Ranged:{min:40,max:50}},loadout:[841]}]}});
 const entry=account({bank:obs({882:149}),equipment:obs({841:1})}),live=account({bank:obs({882:148}),equipment:obs({841:1})}),admitted={method:'ranged',source:'s1',intent,account:entry};
 expect(chooseProgression({...intent,targetLevel:49},live,[m],{now,requireQualification:true,admitted}).state).toBe('qualify');
 expect(chooseProgression(intent,live,[{...m,source:'changed'}],{now,requireQualification:true,admitted}).state).toBe('qualify');
 expect(chooseProgression(intent,{...live,account:'Other'},[m],{now,requireQualification:true,admitted}).state).toBe('qualify');
 expect(chooseProgression(intent,{...live,equipment:obs({843:1})},[m],{now,requireQualification:true,admitted}).state).toBe('qualify');
 expect(chooseProgression({...intent,targetLevel:60},{...live,skills:{Ranged:{level:51,xp:xpForLevel(51)}}},[m],{now,requireQualification:true,admitted:{...admitted,intent:{...intent,targetLevel:60}}}).state).toBe('qualify');
 expect(chooseProgression(intent,{...live,bank:obs({882:2})},[m],{now,requireQualification:true,admitted}).state).toBe('acquire');
});
test('measured work rates do not turn modeled setup and resupply costs into measured route time',()=>{
 const m=method('measured',10,{rate:{unitsPerTick:10,basis:'measured',evidence:'native work samples'},costs:{setupTicks:20,travelTicks:0,acquisitionTicks:0,unlockTicks:0}});
 expect(chooseProgression(intent,account(),[m],{now}).basis).toBe('model');
 const matched={...m,costs:{...m.costs,measured:{source:'s1',evidence:'native whole-trip timing',conditions:{levels:{Ranged:{min:40,max:50}}}}}};
 expect(chooseProgression(intent,account(),[matched],{now}).basis).toBe('measured');
 expect(chooseProgression(intent,account(),[{...matched,source:'changed'}],{now}).basis).toBe('model');
 const resupply={...m,costs:{setupTicks:0,travelTicks:0,acquisitionTicks:0,unlockTicks:0,resupply:{everyUnits:100,ticks:5}}};
 expect(chooseProgression(intent,account(),[resupply],{now}).basis).toBe('model');
});
test('an envelope proof admits an account at or above its entry, refuses one below, and bounds a step to the proved gain',()=>{
 // One proof run from Ranged 40 with the smallest kit, 5 levels long.
 const envelope={levels:{Ranged:{min:40},Hitpoints:{min:30}},gain:{Ranged:5},items:{882:100},loadout:[841]};
 const m=method('ranged',10,{qualification:{source:'s1',bands:[envelope]}});
 const at=(ranged:number,hitpoints:number,arrows=100,worn:Record<number,number>={841:1})=>account({skills:{Ranged:{level:ranged,xp:xpForLevel(ranged)},Hitpoints:{level:hitpoints,xp:xpForLevel(hitpoints)}},bank:obs({882:arrows}),equipment:obs(worn)});
 const choose=(a:ObservedAccount,levels=5)=>chooseProgression({kind:'train',skill:'Ranged',targetLevel:a.skills.Ranged!.level+levels},a,[m],{now,requireQualification:true});
 // The entry state and every stronger state execute: higher levels, more arrows, more worn items.
 for(const a of [at(40,30),at(63,30),at(40,99),at(70,70,5000,{841:1,1129:1})])expect(choose(a).state).toBe('execute');
 // A weaker state in one dimension is not admitted: the proof never ran from it.
 for(const a of [at(39,30),at(40,29),at(40,30,99),at(40,30,100,{})]){const r=choose(a);expect(r.state).not.toBe('execute');expect(r.selected).toBeNull();}
 // One step adds the proved 5 levels at most, from the level the account has now. A longer goal is more steps.
 expect(choose(at(40,30)).path.map(s=>s.units)).toEqual([xpForLevel(45)-xpForLevel(40)]);
 expect(choose(at(63,30),8).path.map(s=>s.units)).toEqual([xpForLevel(68)-xpForLevel(63),xpForLevel(71)-xpForLevel(68)]);
});
