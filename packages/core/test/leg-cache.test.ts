import {expect,test,spyOn} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {legCache,routeDangerHash} from '../src/leg-cache';
test('walk cache preserves null, merges other writers, and invalidates changed collision sources',()=>{
 const dir=mkdtempSync(join(tmpdir(),'route-leg-cache-')),file=join(dir,'legs.json');
 try{
  const a=legCache(file,'source'),b=legCache(file,'source');a.set('closed',null);a.set('__proto__',3);a.save();b.set('walk',12);b.save();
  const c=legCache(file,'source');expect(c.has('closed')).toBe(true);expect(c.get('closed')).toBeNull();expect(c.get('walk')).toBe(12);expect(c.get('__proto__')).toBe(3);expect(c.get('absent')).toBeUndefined();
  expect(legCache(file,'different source').has('walk')).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('ENOSPC during cache creation or writing retains computed legs and the published cache',()=>{
 const dir=mkdtempSync(join(tmpdir(),'route-leg-enospc-')),file=join(dir,'legs.json');
 const originalWrite=fs.writeFileSync;
 try{
  const seed=legCache(file,'source');seed.set('closed',null);seed.save();
  const published=readFileSync(file),otherTemp=join(dir,'legs.json.other.tmp');
  writeFileSync(otherTemp,'another writer');
  for(const stage of ['mkdir','write'] as const){
   const target=stage==='mkdir'?join(dir,'missing','legs.json'):file;
   const cache=legCache(target,'source');cache.set('computed',12);cache.set('unreachable',null);
   const full=Object.assign(new Error('no space left on device'),{code:'ENOSPC'});
   const mock=stage==='mkdir'?spyOn(fs,'mkdirSync').mockImplementation(()=>{throw full;})
    :spyOn(fs,'writeFileSync').mockImplementation((...args:Parameters<typeof fs.writeFileSync>)=>{
     originalWrite(args[0],'partial');throw full;
    });
   try{expect(()=>cache.save()).not.toThrow();}finally{mock.mockRestore();}
   expect(cache.has('computed')).toBe(true);expect(cache.get('computed')).toBe(12);
   expect(cache.has('unreachable')).toBe(true);expect(cache.get('unreachable')).toBeNull();
   expect(readFileSync(file)).toEqual(published);
   expect(readdirSync(dir).filter(n=>n.endsWith('.tmp'))).toEqual(['legs.json.other.tmp']);
   // A later save must publish the retained legs and merge another writer's legs.
   const peer=legCache(target,'source');peer.set('peer',7);peer.save();cache.save();
   const saved=legCache(target,'source');
   expect(saved.get('computed')).toBe(12);expect(saved.has('unreachable')).toBe(true);
   expect(saved.get('unreachable')).toBeNull();expect(saved.get('peer')).toBe(7);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('danger cache scopes include every opened tile and ignore set insertion order',()=>{
 const cache={hash:JSON.stringify};
 const a={key:'same hunters',kept:new Set(['0,1,2','0,3,4'])},b={key:a.key,kept:new Set(['0,1,2','0,5,6'])};
 expect(routeDangerHash(a,cache)).not.toBe(routeDangerHash(b,cache));
 expect(routeDangerHash(a,cache)).toBe(routeDangerHash({...a,kept:new Set([...a.kept].reverse())},cache));
});
