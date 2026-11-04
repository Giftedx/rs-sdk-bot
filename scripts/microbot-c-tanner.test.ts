import {expect,test} from 'bun:test';
import {tanningEffect,tanningRecipes,tanInventory} from './microbot-c-tanner';
test('all six native tanning variants have exact per-hide prices',()=>{
 expect(Object.values(tanningRecipes).map(r=>r.cost)).toEqual([1,3,20,20,20,20]);
 expect(new Set(Object.values(tanningRecipes).map(r=>r.output)).size).toBe(6);
});
test('tanning requires matching hide debit, leather credit and coin fee',()=>{
 const before={input:4,output:2,coins:100};
 expect(tanningEffect(before,{input:3,output:3,coins:80},20)).toBe(true);
 for(const after of [{input:4,output:3,coins:80},{input:3,output:2,coins:80},{input:3,output:3,coins:100},{input:2,output:4,coins:60}])expect(tanningEffect(before,after,20)).toBe(false);
});
test('invalid orders fail before accessing a session',async()=>{
 await expect(tanInventory(null as any,'soft',0,10)).rejects.toThrow('invalid tanning order');
});
test('finite tanner stops at exact order and preserves unrelated assets',async()=>{
 const items=[{id:1739,count:3},{id:1741,count:4},{id:995,count:8},{id:2347,count:1}];let clicks=0;
 const s:any={tick:()=>0,sdk:{getSkill:()=>({level:10}),getInventory:()=>items,getState:()=>({player:{lifeId:1},nearbyNpcs:[{name:'Tanner',index:12}],interface:{isOpen:true}}),sendInteractNpc:async(index:number,op:number)=>{expect([index,op]).toEqual([12,3]);return{success:true};},sendClickComponent:async()=>{clicks++;items[0]!.count--;items[1]!.count++;items[2]!.count--;return{success:true};}}};
 const result=await tanInventory(s,'soft',2,80);
 expect(result).toMatchObject({ok:true,made:2,coinsSpent:2,preserved:true,conserved:true});expect(clicks).toBe(2);expect(items[3]!.count).toBe(1);
});
test('missing tanning supplies never trade or spend',async()=>{
 let trades=0;const s:any={tick:()=>0,sdk:{getSkill:()=>({level:10}),getState:()=>({player:{lifeId:1}}),getInventory:()=>[],sendInteractNpc:async()=>{trades++;}}};
 const result=await tanInventory(s,'black',1,20);expect(result.ok).toBe(false);expect(trades).toBe(0);
});
