import {test,expect} from 'bun:test';
import {requirements} from '../src/requirements';
test('shared unlock is evaluated for both goals; absent and false facts differ',()=>{
 const g={unlock:{fact:'quest'},one:{ref:'unlock'},two:{ref:'unlock'}};
 for(const state of [true,false,null] as const){const r=requirements(g,{quest:state},['one','two']);expect(r.one?.state).toBe(state);expect(r.two?.state).toBe(state);}
 expect(requirements(g,{},['one']).one?.blockers).toEqual(['quest unknown']);
});
test('alternatives can satisfy readiness without turning missing facts into success',()=>{
 const g={goal:{all:[{fact:'quest'},{any:[{fact:'bronze'},{fact:'iron'}]}]}};
 expect(requirements(g,{quest:true,iron:true},['goal']).goal?.state).toBe(true);
 expect(requirements(g,{quest:true,bronze:false},['goal']).goal?.state).toBeNull();
 expect(requirements(g,{quest:false,iron:true},['goal']).goal?.state).toBe(false);
});
test('cycles and missing nodes cannot yield readiness',()=>{
 const g={a:{ref:'b'},b:{ref:'a'}};
 expect(requirements(g,{},['a']).a).toEqual({state:null,blockers:['cycle:a']});
 expect(requirements({}, {}, ['missing']).missing?.state).toBeNull();
});
test('an independently satisfied alternative resolves regardless of goal order',()=>{
 const g={a:{any:[{ref:'b'},{fact:'observed'}]},b:{ref:'a'}};
 expect(requirements(g,{observed:true},['a','b']).b?.state).toBe(true);
 expect(requirements(g,{observed:true},['b','a']).b?.state).toBe(true);
});
