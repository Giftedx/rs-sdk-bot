import {expect,test} from 'bun:test';
import {waitPracticeSave,type readPracticeSave} from './fleet-player-save';
const saved=(stage:number):ReturnType<typeof readPracticeSave>=>({version:9,position:{x:0,z:0,level:0},skills:[],vars:{65:stage},inventories:{}});
test('waits for the real quest save after a stale logout acknowledgement',async()=>{
 let stage=3;const timer=setTimeout(()=>{stage=10;},15);
 try{const r=await waitPracticeSave('',s=>s.vars[65]===10,{read:()=>saved(stage),intervalMs:1,timeoutMs:100});expect(r.matched).toBe(true);expect(r.first!.vars[65]).toBe(3);expect(r.save.vars[65]).toBe(10);expect(r.reads).toBeGreaterThan(1);}finally{clearTimeout(timer);}
});
test('permanently stale state remains a failed gate',async()=>{
 const r=await waitPracticeSave('',s=>s.vars[65]===10,{read:()=>saved(3),intervalMs:1,timeoutMs:10});expect(r.matched).toBe(false);expect(r.save.vars[65]).toBe(3);
});
