import {expect,test} from 'bun:test';
import {waitPracticeSave,readPracticeSave,setPracticeSkills} from './fleet-player-save';
import {mkdirSync,writeFileSync,rmSync,realpathSync,mkdtempSync,copyFileSync} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {applyPreset} from '../../packages/practice/src/presets';
const saved=(stage:number):ReturnType<typeof readPracticeSave>=>({version:9,position:{x:0,z:0,level:0},skills:[],vars:{65:stage},inventories:{}});
test('waits for the real quest save after a stale logout acknowledgement',async()=>{
 let stage=3;const timer=setTimeout(()=>{stage=10;},15);
 try{const r=await waitPracticeSave('',s=>s.vars[65]===10,{read:()=>saved(stage),intervalMs:1,timeoutMs:100});expect(r.matched).toBe(true);expect(r.first!.vars[65]).toBe(3);expect(r.save.vars[65]).toBe(10);expect(r.reads).toBeGreaterThan(1);}finally{clearTimeout(timer);}
});
test('permanently stale state remains a failed gate',async()=>{
 const r=await waitPracticeSave('',s=>s.vars[65]===10,{read:()=>saved(3),intervalMs:1,timeoutMs:10});expect(r.matched).toBe(false);expect(r.save.vars[65]).toBe(3);
});

function fixture(prefix='flst'){
 const dir=resolve(import.meta.dir,'../../vendor/rs-sdk/server/engine/data/players/main');mkdirSync(dir,{recursive:true});
 const path=resolve(dir,prefix+randomUUID().replaceAll('-','').slice(0,12-prefix.length)+'.sav'),b=Buffer.alloc(140);
 b.writeUInt16BE(0x2004,0);b.writeUInt16BE(9,2);b.writeUInt16BE(3000,4);b.writeUInt16BE(3200,6);b.writeUInt16BE(10000,22);
 for(let i=0;i<21;i++)b.writeUInt8(i===3?10:1,32+i*5);
 b.writeUInt32BE(Bun.hash.crc32(b.subarray(0,-4))>>>0,136);writeFileSync(path,b);return path;
}
test('a generated aiobfl fixture reaches the exact skill helper and the bench seed anchor',()=>{
 const path=fixture('aiobfl');try{
  const skills=readPracticeSave(path).skills.map(s=>({level:s.level,xp:s.xp}));skills[4]={level:80,xp:285700};
  expect(/^aiob/i.test(basename(path))).toBe(true);setPracticeSkills(path,skills);
  expect(readPracticeSave(path).skills[4]).toMatchObject({level:80,xp:285700});
 }finally{rmSync(path);}
});
test('exact skill writes reject arbitrary identities and paths outside the native practice directory',()=>{
 const path=fixture('unowned'),allowed=fixture('aiobfl'),outside=mkdtempSync(join(tmpdir(),'fleet-save-'));
 try{
  const skills=readPracticeSave(path).skills.map(s=>({level:s.level,xp:s.xp})),other=join(outside,basename(allowed));copyFileSync(allowed,other);
  expect(()=>setPracticeSkills(path,skills)).toThrow('requires generated fleet practice save');
  expect(()=>setPracticeSkills(other,skills)).toThrow('requires generated fleet practice save');
 }finally{rmSync(path);rmSync(allowed);rmSync(outside,{recursive:true,force:true});}
});
test('the generated path returned by applyPreset reaches the exact practice skill helper',async()=>{
 const name='flst'+randomUUID().replaceAll('-','').slice(0,8);
 const path=await applyPreset(name,{position:{x:3000,z:3200,level:0},skills:{Hitpoints:10},bank:[{id:995,count:2000}]});
 try{
  const before=readPracticeSave(path),skills=before.skills.map(s=>({level:s.index===3?3:s.level,xp:s.xp}));
  expect(path).toBe(resolve(realpathSync(resolve(import.meta.dir,'../../vendor/rs-sdk')),'server/engine/data/players/main',name+'.sav'));
  setPracticeSkills(path,skills);
  const after=readPracticeSave(path);
  expect(after.skills.map(s=>({level:s.level,xp:s.xp}))).toEqual(skills);
  expect(after.version).toBe(before.version);expect(after.position).toEqual(before.position);
  expect(after.inventories).toEqual(before.inventories);expect(after.vars).toEqual(before.vars);
 }finally{rmSync(path);}
});

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
