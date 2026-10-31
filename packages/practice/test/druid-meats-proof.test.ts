import {expect,test} from 'bun:test';
import {druidSaveChecks,druidChildChecks,druidMemoryGate,DRUID_FIXTURE} from '../src/druid-meats-proof';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
test('memory uses the shared startup reserve and running floor',()=>{
 expect(()=>druidMemoryGate(PRACTICE_STARTUP_GB,true)).not.toThrow();
 expect(()=>druidMemoryGate(PRACTICE_STARTUP_GB-0.1,true)).toThrow();
 expect(()=>druidMemoryGate(FREE_FLOOR_GB,false)).not.toThrow();
 expect(()=>druidMemoryGate(FREE_FLOOR_GB-0.1,false)).toThrow();
 expect(DRUID_FIXTURE.skills?.Hitpoints).toBe(75);
});
test('child requires successful logout and rejects an ambiguous refusal',()=>{
 expect(Object.values(druidChildChecks(0,false,'LOGOUT logged-out\nRESULT ok mode=druid-meats banked=2132,2134,2136,2138\n')).every(Boolean)).toBe(true);
 expect(druidChildChecks(0,false,'RESULT ok mode=druid-meats\n').logout).toBe(false);
 expect(druidChildChecks(1,false,'LOGOUT logged-out\nRESULT fail mode=druid-meats Error: all-meats-owned\n',true).result).toBe(true);
 expect(druidChildChecks(1,false,'LOGOUT logged-out\nRESULT fail mode=druid-meats Error: route-failed\n',true).result).toBe(false);
});
test('save checks reject carried meat, unrelated asset loss, and death',()=>{
 const skills=Array.from({length:21},(_,index)=>({index,level:index===3?75:1,xp:0,rawExperience:0}));
 const before:any={position:{x:2572,z:3268,level:1},skills,vars:{},inventories:{93:[{id:954,count:1}],94:[{id:1289,count:1}],95:[{id:995,count:1000}]}};
 const after=structuredClone(before);after.position={x:2654,z:3283,level:0};after.inventories[95].push(...[2132,2134,2136,2138].map(id=>({id,count:1})));
 const r={ok:true,died:false,hpMin:70,kills:4,acquired:[2132,2134,2136,2138],skipped:[]};
 expect(Object.values(druidSaveChecks(before,after,r)).every(Boolean)).toBe(true);
 const carried=structuredClone(after);carried.inventories[93].push(carried.inventories[95].pop());
 expect(druidSaveChecks(before,carried,r).meats).toBe(false);
 const lost=structuredClone(after);lost.inventories[95][0].count--;
 expect(druidSaveChecks(before,lost,r).assets).toBe(false);
 expect(druidSaveChecks(before,after,{...r,died:true}).life).toBe(false);
 expect(druidSaveChecks(before,after,{...r,acquired:[2132,2136,2138,2134]}).kills).toBe(true);
 expect(druidSaveChecks(before,after,{...r,acquired:[2132,2136,2136,2134]}).kills).toBe(false);
});
