import {expect,test} from 'bun:test';
import {productionBatch} from '../src/production-batch';

const bronze=[{id:436,available:12,reserved:2,units:1,stackable:false},{id:438,available:7,reserved:2,units:1,stackable:false}];
test('recipe batch respects each ingredient, reserves and pack slots',()=>{
 expect(productionBatch(bronze,20,9,'best-effort')).toEqual({possible:5,planned:5,targetMet:false});
 expect(productionBatch(bronze,7,9,'best-effort').planned).toBe(3);
 expect(productionBatch(bronze,20,9,'exact')).toEqual({possible:5,planned:0,targetMet:false});
 expect(productionBatch(bronze,20,5,'exact')).toEqual({possible:5,planned:5,targetMet:true});
});
test('multi-unit recipes spend all ingredients and stackable inputs take one slot each',()=>{
 const steel=[{id:440,available:20,reserved:1,units:1,stackable:false},{id:453,available:14,reserved:2,units:2,stackable:false}];
 expect(productionBatch(steel,28,10,'best-effort').planned).toBe(6);
 expect(productionBatch(steel,5,10,'best-effort').planned).toBe(1);
 const arrows=[{id:52,available:100,reserved:10,units:15,stackable:true},{id:314,available:45,reserved:0,units:15,stackable:true}];
 expect(productionBatch(arrows,2,10,'best-effort').planned).toBe(3);
 expect(productionBatch(arrows,1,10,'best-effort').planned).toBe(0);
});
test('empty, duplicate and invalid recipe inputs cannot imply stock exists',()=>{
 expect(()=>productionBatch([],28,1,'exact')).toThrow();
 expect(()=>productionBatch([...bronze,bronze[0]!],28,1,'exact')).toThrow();
 for(const bad of [-1,NaN,1.5,Number.MAX_SAFE_INTEGER+1]){
  expect(()=>productionBatch([{...bronze[0]!,available:bad}],28,1,'exact')).toThrow();
  expect(()=>productionBatch(bronze,bad,1,'exact')).toThrow();
 }
 expect(()=>productionBatch([{...bronze[0]!,units:0}],28,1,'exact')).toThrow();
 expect(productionBatch([{...bronze[0]!,reserved:20}],28,1,'exact').planned).toBe(0);
});

test('planner matches exhaustive feasible withdrawals for mixed stack recipes',()=>{
 for(let a=0;a<=8;a++)for(let b=0;b<=8;b++)for(let slots=0;slots<=7;slots++){
  const recipe=[{id:1,available:a,reserved:1,units:2,stackable:false},{id:2,available:b,reserved:2,units:1,stackable:true}];
  const feasible=[0,1,2,3,4].filter(n=>n===0||(a-2*n>=1&&b-n>=2&&2*n+1<=slots));
  const expected=Math.max(...feasible),actual=productionBatch(recipe,slots,4,'best-effort').planned;
  if(actual!==expected)throw Error(JSON.stringify({a,b,slots,expected,actual}));
 }
});
