import {test,expect} from 'bun:test';
import {wineSaveChecks} from '../src/wine-order-proof';
test('a reached target preserves unused bulk instead of requiring wasteful consumption',()=>{
 const save=(level:number,xp:number,raw:number,good:number,notes:number)=>({version:9,position:{x:3092,z:3243,level:0},vars:{},skills:Array.from({length:21},(_,i)=>({index:i,level:i===7?level:i===3?10:1,xp:i===7?xp:0,rawExperience:0})),inventories:{93:notes?[{slot:0,id:1996,count:notes}]:[],95:[{slot:0,id:1995,count:raw},{slot:1,id:1993,count:good}].filter(i=>i.count>0)}});
 const before=save(1,0,600,0,600),early=save(99,1650000,0,600,600),full=save(99,2970000,0,1200,0);
 expect(Object.values(wineSaveChecks(before,early)).every(Boolean)).toBe(true);
 expect(Object.values(wineSaveChecks(before,full)).every(Boolean)).toBe(true);
 expect(wineSaveChecks(before,save(99,1650000,0,599,600)).accounting).toBe(false);
 expect(wineSaveChecks(before,save(98,1000000,0,1200,0)).target).toBe(false);
});
