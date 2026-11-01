import {test,expect} from 'bun:test';
import {CANNON,cannonballEffect,runCannonballs} from './microbot-a-cannonballs';
test('native cannonball recipe preserves mould and all unrelated assets',()=>{
 const b=[{id:CANNON.bar,count:2},{id:CANNON.mould,count:1},{id:995,count:100}];
 const a=[{id:CANNON.bar,count:1},{id:CANNON.mould,count:1},{id:995,count:100},{id:CANNON.ball,count:4}];
 expect(cannonballEffect(b,a,0,37.5)).toBe('made');expect(cannonballEffect(b,b,0,0)).toBe('none');
 expect(cannonballEffect(b,a.map(i=>i.id===4?{...i,count:0}:i),0,37.5)).toBe('invalid');
 expect(cannonballEffect(b,a.map(i=>i.id===2?{...i,count:8}:i),0,37.5)).toBe('invalid');expect(cannonballEffect(b,a,0,0)).toBe('invalid');
});
test('cannonball entry rejects invalid and unsupported stage before action',async()=>{
 await expect(runCannonballs({} as any,{bars:27,cap:10})).rejects.toThrow('invalid');
 const s:any={sdk:{getState:()=>null,getSkill:()=>undefined}};await expect(runCannonballs(s,{bars:1,cap:10})).rejects.toThrow('stage');
});
