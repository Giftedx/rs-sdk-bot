import {expect,test} from 'bun:test';
import {waitPracticeSave,readPracticeSave,setPracticeSkills} from './fleet-player-save';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const saved=(stage:number):ReturnType<typeof readPracticeSave>=>({version:9,position:{x:0,z:0,level:0},skills:[],vars:{65:stage},inventories:{}});
test('waits for the real quest save after a stale logout acknowledgement',async()=>{
 let stage=3;const timer=setTimeout(()=>{stage=10;},15);
 try{const r=await waitPracticeSave('',s=>s.vars[65]===10,{read:()=>saved(stage),intervalMs:1,timeoutMs:100});expect(r.matched).toBe(true);expect(r.first!.vars[65]).toBe(3);expect(r.save.vars[65]).toBe(10);expect(r.reads).toBeGreaterThan(1);}finally{clearTimeout(timer);}
});
test('permanently stale state remains a failed gate',async()=>{
 const r=await waitPracticeSave('',s=>s.vars[65]===10,{read:()=>saved(3),intervalMs:1,timeoutMs:10});expect(r.matched).toBe(false);expect(r.save.vars[65]).toBe(3);
});

function fixture(){
 const dir=resolve(import.meta.dir,'../../vendor/rs-sdk/server/engine/data/players/main');mkdirSync(dir,{recursive:true});
 const path=resolve(dir,'flst'+randomUUID().replaceAll('-','').slice(0,8)+'.sav'),b=Buffer.alloc(140);
 b.writeUInt16BE(0x2004,0);b.writeUInt16BE(9,2);b.writeUInt16BE(3000,4);b.writeUInt16BE(3200,6);b.writeUInt16BE(10000,22);
 for(let i=0;i<21;i++)b.writeUInt8(i===3?10:1,32+i*5);
 b.writeUInt32BE(Bun.hash.crc32(b.subarray(0,-4))>>>0,136);writeFileSync(path,b);return path;
}
test('an exact native fixture retains drained Prayer0 and its base-level XP',()=>{
 const path=fixture();try{
  const skills=readPracticeSave(path).skills.map(s=>({level:s.level,xp:s.xp}));skills[5]={level:0,xp:19687};
  setPracticeSkills(path,skills);const saved=readPracticeSave(path);
  expect(saved.skills[5]!.level).toBe(0);expect(saved.skills[5]!.xp).toBe(19687);expect(saved.skills[3]!.level).toBe(10);
 }finally{rmSync(path);}
});
test('a living native fixture still rejects zero Hitpoints',()=>{
 const path=fixture();try{
  const skills=readPracticeSave(path).skills.map(s=>({level:s.level,xp:s.xp}));skills[3]!.level=0;
  expect(()=>setPracticeSkills(path,skills)).toThrow('invalid exact practice skill');
 }finally{rmSync(path);}
});
