import {test,expect} from 'bun:test';
import {rangedAmmo,rangedCredit,selectRangedTarget,makeRangedHealer} from './gather-ranged';
test('ammo includes quiver and pack, keeps unknown distinct and ignores other arrows',()=>{
 expect(rangedAmmo([{id:884,count:2},{id:886,count:100}],[{id:884,count:7}])).toBe(9);
 expect(rangedAmmo(undefined,[])).toBeNull();expect(rangedAmmo([],undefined)).toBeNull();
 expect(rangedAmmo([],[])).toBe(0);expect(rangedAmmo([{id:884,count:-1}],[])).toBeNull();
});
test('credit needs own XP, disappearance and new paired drops; old or missing evidence is no kill',()=>{
 expect(rangedCredit(true,300,1,1)).toBe(true);
 for(const args of [[false,300,1,1],[true,0,1,1],[true,100,1,1],[true,200,1,1],[true,600,1,1],[true,300,0,1],[true,300,1,0],[true,NaN,1,1]] as const)expect(rangedCredit(args[0],args[1],args[2],args[3])).toBe(false);
});
test('target remains the chicken family, field, plane and uncontested identity',()=>{
 const chicken:any={index:10,id:41,x:3235,z:3295,level:0,distance:2,inCombat:false,hp:3,maxHp:3};
 expect(selectRangedTarget([chicken],0)?.index).toBe(10);
 for(const patch of [{id:1},{x:3300},{inCombat:true,targetIndex:32769},{hp:1},{reachable:false}])expect(selectRangedTarget([{...chicken,...patch}],0)).toBeUndefined();
 expect(selectRangedTarget([chicken],1)).toBeUndefined();expect(selectRangedTarget([chicken],undefined)).toBeUndefined();
});


import type {Session} from '../packages/core/src/inprocess';
for(const foodId of [329,333])for(const effect of ['matched','debit-only','none'])test('overlapping walk heals '+foodId+' '+effect,async()=>{
 let hp=4,food=3,calls=0,consumed=0,tick=0;
 const callbacks=new Set<()=>void>(),timer=setInterval(()=>{tick++;for(const cb of [...callbacks])cb();},1);
 const s={tick:()=>tick,onTick:(f:()=>void)=>{callbacks.add(f);return()=>callbacks.delete(f);},sdk:{getState:()=>({}),getSkill:()=>({level:hp}),getInventory:()=>[{id:foodId,name:'Fish',count:food,slot:1}]},bot:{eatFood:async()=>{calls++;await new Promise(r=>setTimeout(r,5));if(effect!=='none')food--;if(effect==='matched')hp=10;return {success:true};}}}as unknown as Session;
 try{const heal=makeRangedHealer(s,()=>{consumed++;},foodId),results=await Promise.allSettled([heal(),heal(),heal()]);expect(calls).toBe(1);expect(consumed).toBe(effect==='matched'?1:0);expect(results.every(r=>r.status===(effect==='matched'?'fulfilled':'rejected'))).toBe(true);if(effect==='matched')expect(food).toBe(2);else for(const r of results)if(r.status==='rejected')expect(String(r.reason)).toContain('debit/health unobserved');}finally{clearInterval(timer);}
});

import {supervise} from '../packages/practice/src/supervise';
test('finite Ranged refusal is blocked after one login, not twenty repeats',async()=>{
 let calls=0;const r=await supervise({run:async()=>{calls++;return{exitCode:1,stdout:'RESULT fail no Ranged progress: {"ok":false,"failure":"ranged prerequisite: stage owned bow,ammo and selected unnoted food"}'};},stopped:()=>false,pause:async()=>{},maxRestarts:20});expect(r).toEqual({reason:'blocked',runs:1});expect(calls).toBe(1);
});
test('owned interruption remains stopped with its target unmet',async()=>{
 const r=await supervise({run:async()=>({exitCode:1,stdout:'RESULT fail stop file {"ok":false,"targetMet":false}'}),stopped:()=>false,pause:async()=>{},maxRestarts:20});expect(r).toEqual({reason:'stopped',runs:1});
});

test('regen credit is bounded: own3HP beats every other contributor within180ticks',()=>{expect(rangedCredit(true,400,1,1,170)).toBe(true);expect(rangedCredit(true,500,1,1,180)).toBe(true);expect(rangedCredit(true,300,1,1,181)).toBe(false);expect(rangedCredit(true,200,1,1,50)).toBe(false);});
