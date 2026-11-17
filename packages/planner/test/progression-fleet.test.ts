import {expect,test} from 'bun:test';
import {selectProgressionFleet,type FleetProgressionOptions} from '../src/progression-fleet';
import type {Assignment} from '../src/autopilot';
import type {ObservedAccount,ProgressionMethod} from '../src/progression';
import {xpForLevel} from '../src/curve';
const now=100000,remaining=xpForLevel(50)-xpForLevel(40);
const account=(name:string):ObservedAccount=>({account:name,at:now,skills:{ranged:{level:40,xp:xpForLevel(40)}},inventory:{at:now,value:{}},equipment:{at:now,value:{}},bank:{at:now,value:{}},quests:{at:now,value:{unlock:false}}});
const method=(id:string,rate=1,over:Partial<ProgressionMethod>={}):ProgressionMethod=>({id,step:{script:`scripts/${id}.ts`,args:['50'],env:{}},source:'source',effects:{xp:{ranged:1}},rate:{unitsPerTick:rate,basis:'measured',evidence:'matched native samples'},costs:{setupTicks:0,travelTicks:0,acquisitionTicks:0,unlockTicks:0},qualification:{source:'source',bands:[{}]},...over});
const assignment=(name:string,resources:string[]=[]):Assignment=>({account:name,value:1,reason:'army',resources,template:{id:'baseline',script:'scripts/slow.ts',args:['50'],role:'combat',goal:'Ranged50',family:'combat-train',trains:{skill:'Ranged',to:50,unlocks:[]},yields:()=>[]}});
const options=(over:Partial<FleetProgressionOptions>={}):FleetProgressionOptions=>({baseline:[assignment('A')],accounts:[account('A')],intents:new Map([['a',{kind:'train',skill:'ranged',targetLevel:50}]]),methods:()=>[method('slow'),method('fast',10)],currentMethods:new Map([['a','slow']]),now,...over});

test('22 selected finite consumers request their stale observations with exact work, without changing assignments',()=>{
 const names=Array.from({length:22},(_,i)=>'Helper'+i),baseline=names.map(n=>assignment(n));
 const result=selectProgressionFleet(options({now:now+400000,baseline,accounts:names.map(account),intents:new Map(names.map(n=>[n.toLowerCase(),{kind:'train',skill:'ranged',targetLevel:50}])),currentMethods:new Map(names.map(n=>[n.toLowerCase(),'slow']))}));
 const requests=result.requests.filter(r=>r.action==='observe');
 expect(requests).toHaveLength(22);
 expect(new Set(requests.map(r=>r.account)).size).toBe(22);
 expect(requests[0]).toMatchObject({account:'Helper0',consumer:{work:{script:'scripts/slow.ts',args:['50'],env:{}},accept:{skills:{Ranged:50}}}});
 expect(result.assignments).toEqual(baseline);expect(result.changes).toEqual([]);
});
test('a measured qualified improvement refines the existing assignment and finite consumer',()=>{
 const r=selectProgressionFleet(options());
 expect(r.changes[0]?.method).toBe('fast');expect(r.assignments[0]?.template?.id).toBe('baseline');
 expect(r.assignments[0]?.template?.script).toBe('scripts/fast.ts');expect(r.assignments[0]?.template?.goal).toBe('Ranged50');
});
test('busy paused and protected accounts remain byte-for-byte baseline choices',()=>{
 for(const held of ['busy','paused','protected']as const){const o=options({[held]:new Set(['a'])}),r=selectProgressionFleet(o);expect(r.changes).toEqual([]);expect(r.assignments[0]).toBe(o.baseline[0]);}
});
test('modeled alternatives stay requests rather than replacing measured allocations',()=>{
 const r=selectProgressionFleet(options({methods:()=>[method('slow'),method('model',100,{rate:{unitsPerTick:100,basis:'model',evidence:'estimate'}})]}));
 expect(r.changes).toEqual([]);expect(r.requests.some(q=>q.method==='model'&&q.action==='measure')).toBe(true);
});
test('a helper cost can consume the whole apparent speed gain',()=>{
 const r=selectProgressionFleet(options({supportFor:m=>m.id==='fast'?[{helper:'Helper',opportunityTicks:remaining,deliveryTicks:100}]:[]}));
 expect(r.changes).toEqual([]);
});
test('full allocation checks prevent taking a field another side already holds',()=>{
 const r=selectProgressionFleet(options({resourcesFor:m=>m.id==='fast'?['field']:[],taken:{field:1},capacity:{field:1}}));
 expect(r.changes).toEqual([]);
});
test('a joint reassignment can swap resources while preserving every capacity',()=>{
 const a=account('A'),b=account('B');
 const r=selectProgressionFleet(options({baseline:[assignment('A',['left']),assignment('B',['right'])],accounts:[a,b],intents:new Map([['a',{kind:'train',skill:'ranged',targetLevel:50}],['b',{kind:'train',skill:'ranged',targetLevel:50}]]),currentMethods:new Map([['a','slow'],['b','slow']]),resourcesFor:(m,a)=>m.id==='fast'?[a.account==='A'?'right':'left']:[]}));
 expect(r.changes).toHaveLength(2);
});
test('the same external stack cannot fund two faster consumers',()=>{
 const r=selectProgressionFleet(options({baseline:[assignment('A'),assignment('B')],accounts:[account('A'),account('B')],intents:new Map([['a',{kind:'train',skill:'ranged',targetLevel:50}],['b',{kind:'train',skill:'ranged',targetLevel:50}]]),currentMethods:new Map([['a','slow'],['b','slow']]),
  methods:()=>[method('slow'),method('fast',10,{inputs:{1:1}})],stocks:[{holder:'Supplier',at:now,items:{1:remaining},delivery:{ticks:10,basis:'measured',source:'transfer-source',evidence:'matched transfer'}}],sourcesFor:()=>['Supplier']}));
 expect(r.changes).toHaveLength(1);expect(r.changes[0]?.ready).toBe(false);expect(r.assignments.every(a=>a.template?.script==='scripts/slow.ts')).toBe(true);
 expect(r.requests.some(q=>q.action==='transfer')).toBe(true);expect(r.reservations.reduce((n,r)=>n+r.count,0)).toBe(remaining);
});
test('unqualified sources and unknown baseline finish do not claim a beneficial reallocation',()=>{
 const r=selectProgressionFleet(options({methods:()=>[method('slow',1,{rate:{unitsPerTick:null,basis:'unknown',evidence:''}}),method('fast',10,{qualification:{source:'old',bands:[{}]}})]}));
 expect(r.changes).toEqual([]);expect(r.requests.length).toBeGreaterThan(0);
});
test('bounded search retains a feasible baseline without an optimality claim',()=>{
 const o=options({maxCombinations:1}),r=selectProgressionFleet(o);
 expect(r.search.exhausted).toBe(true);expect(r.gaps.join(' ')).toMatch(/bound/);expect(r.assignments).toHaveLength(1);
});
test('unpriced external stock requests proof and cannot enable a training switch',()=>{
 const r=selectProgressionFleet(options({methods:()=>[method('slow'),method('fast',10,{inputs:{1:1}})],stocks:[{holder:'Supplier',at:now,items:{1:remaining}}],sourcesFor:()=>['Supplier']}));
 expect(r.changes).toEqual([]);expect(r.requests.some(q=>q.holder==='Supplier'&&q.action==='measure')).toBe(true);
});
test('a busy helper does not lose its current work for an apparent improvement',()=>{
 const r=selectProgressionFleet(options({busy:new Set(['helper']),supportFor:m=>m.id==='fast'?[{helper:'Helper',opportunityTicks:0,deliveryTicks:0}]:[]}));
 expect(r.changes).toEqual([]);
});
test('finite quest intent is preserved despite a faster unrelated skill method',()=>{
 const q=method('quest',1,{effects:{quests:['unlock'],xp:{ranged:100}},repeatable:false}),fast=method('fast-quest',2,{effects:{quests:['unlock'],xp:{ranged:100}},repeatable:false});
 const r=selectProgressionFleet(options({intents:new Map([['a',{kind:'quest',quest:'unlock'}]]),methods:()=>[q,fast,method('xp',10000)],currentMethods:new Map([['a','quest']])}));
 expect(r.changes[0]?.method).toBe('fast-quest');expect(r.changes[0]?.intent).toEqual({kind:'quest',quest:'unlock'});
});
