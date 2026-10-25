import {test,expect} from 'bun:test';
import {reclaimInputs,reclaimAssetsValid,withdrawFireOwned,fireHomeEntryPoints} from './gather-fire-giants';
import type {Session} from '../packages/core/src/inprocess';
test('actual South entry uses ONLY the proven North-bank two-leg route; North stays home',()=>{
 expect(fireHomeEntryPoints({x:2655,z:3283,level:0})).toEqual([{x:2644,z:3293,tol:0},{x:2619,z:3332,tol:0}]);
 expect(fireHomeEntryPoints({x:2619,z:3332,level:0})).toEqual([]);
 expect(()=>fireHomeEntryPoints({x:2657,z:3382,level:0})).toThrow('actual Ardy South or North bank');
 expect(()=>fireHomeEntryPoints({x:2655,z:3283,level:1})).toThrow('known surface bank');
});
test('reclaim requires owned pebble, all sixteen Salmon and no already owned amulet',()=>{
 expect(reclaimInputs([{id:294,count:1},{id:329,count:16}])).toBe(true);
 expect(reclaimInputs([{id:329,count:16}])).toBe(false);
 expect(reclaimInputs([{id:294,count:1},{id:329,count:15}])).toBe(false);
 expect(reclaimInputs([{id:294,count:1},{id:329,count:16},{id:295,count:1}])).toBe(false);
});
test('owned withdrawal passes actual item294 at bank slot5, never numeric item-id294 as slot',async()=>{
 const inventory:{id:number;count:number}[]=[],bankItem={id:294,name:"Glarial's pebble",count:1,slot:5},calls:unknown[]=[];
 const session={tick:()=>1,sdk:{getInventory:()=>inventory,getState:()=>({bank:{items:[bankItem]}})},bankObservation:()=>({generation:1,at:1,items:[{id:294,name:bankItem.name,count:1}]}),bot:{withdrawItem:async(target:unknown,amount:number)=>{calls.push(target);if(typeof target!=='object'||target===null||!('slot'in target)||target.slot!==5)return{success:false};inventory.push({id:294,count:amount});return{success:true};}}} as unknown as Session;
 await withdrawFireOwned(session,294,1);
 expect(calls).toEqual([bankItem]);expect(calls[0]).not.toBe(294);expect(inventory).toEqual([{id:294,count:1}]);
});
test('unknown or inconsistent fresh bank count blocks withdrawal before dispatch',async()=>{
 let calls=0;const session={sdk:{getInventory:()=>[],getState:()=>({bank:{items:[{id:294,slot:5,name:'Pebble',count:1}]}})},bankObservation:()=>({generation:1,at:1,items:[{id:294,name:'Pebble',count:2}]}),bot:{withdrawItem:async()=>{calls++;return{success:true};}}} as unknown as Session;
 await expect(withdrawFireOwned(session,294,1)).rejects.toThrow('OWN bank item/count unknown');expect(calls).toBe(0);
});
test('only one new amulet and actual Salmon consumption may change total owned assets',()=>{
 const before=new Map([[294,1],[329,378],[1277,1],[1171,1],[1601,2],[995,178]]),after=new Map(before);after.set(295,1);after.set(329,376);
 expect(reclaimAssetsValid(before,after,2)).toBe(true);
 after.set(1601,1);expect(reclaimAssetsValid(before,after,2)).toBe(false);
 after.set(1601,2);after.set(295,2);expect(reclaimAssetsValid(before,after,2)).toBe(false);
 after.set(295,1);expect(reclaimAssetsValid(before,after,1)).toBe(false);
 expect(reclaimAssetsValid(before,after,-1)).toBe(false);
});
