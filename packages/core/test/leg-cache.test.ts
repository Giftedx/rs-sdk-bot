import {expect,test,spyOn} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,truncateSync} from 'node:fs';
import * as fs from 'node:fs';
import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {legCache,routeDangerHash} from '../src/leg-cache';
test('a legacy cache can supply a hit without being rewritten by incremental saves',()=>{
 const dir=mkdtempSync(join(tmpdir(),'route-leg-legacy-')),file=join(dir,'legs.sqlite'),legacy=join(dir,'legs.json');
 const bytes=JSON.stringify({source:'source',legs:{legacy:23}});writeFileSync(legacy,bytes);
 const cache=legCache(file,'source');
 try{
  expect(cache.get('legacy')).toBe(23);
  cache.set('new',7);cache.save();
  expect(readFileSync(legacy,'utf8')).toBe(bytes);
  truncateSync(legacy,17*2**20);
  const read=spyOn(fs,'readFileSync');
  const reopened=legCache(file,'source');
  try{
   expect(reopened.get('new')).toBe(7);expect(reopened.get('legacy')).toBeUndefined();
   expect(read.mock.calls.some(([path])=>path===legacy)).toBe(false);
  }finally{read.mockRestore();reopened.close();}
 }finally{cache.close();rmSync(dir,{recursive:true,force:true});}
});
test('walk cache preserves null, merges other writers, and invalidates changed collision sources',()=>{
 const dir=mkdtempSync(join(tmpdir(),'route-leg-cache-')),file=join(dir,'legs.sqlite');
 const a=legCache(file,'source'),b=legCache(file,'source');
 try{
  a.set('closed',null);a.set('__proto__',3);a.save();b.set('walk',12);b.save();
  expect(b.has('closed')).toBe(true);expect(b.get('closed')).toBeNull();expect(a.get('walk')).toBe(12);expect(b.get('__proto__')).toBe(3);expect(b.get('absent')).toBeUndefined();
  const stale=legCache(file,'different source');
  try{expect(stale.has('walk')).toBe(false);}finally{stale.close();}
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('a busy store and an unavailable cache directory leave measurements available for retry',()=>{
 const dir=mkdtempSync(join(tmpdir(),'route-leg-enospc-')),file=join(dir,'missing','legs.sqlite');
 const cache=legCache(file,'source');cache.set('computed',12);
 try{
  const full=Object.assign(new Error('no space left on device'),{code:'ENOSPC'});
  const mock=spyOn(fs,'mkdirSync').mockImplementation(()=>{throw full;});
  try{expect(()=>cache.save()).not.toThrow();}finally{mock.mockRestore();}
  expect(cache.get('computed')).toBe(12);cache.save();
  const peer=legCache(file,'source'),lock=new Database(file);
  try{
   lock.exec('BEGIN IMMEDIATE');cache.set('unreachable',null);cache.save();
   expect(cache.get('unreachable')).toBeNull();expect(peer.get('unreachable')).toBeUndefined();
   lock.exec('ROLLBACK');peer.set('peer',7);peer.save();cache.save();
   expect(peer.get('computed')).toBe(12);expect(peer.get('unreachable')).toBeNull();expect(cache.get('peer')).toBe(7);
  }finally{lock.close();peer.close();}
 }finally{cache.close();rmSync(dir,{recursive:true,force:true});}
});
test('danger cache scopes include every opened tile and ignore set insertion order',()=>{
 const cache={hash:JSON.stringify};
 const a={key:'same hunters',kept:new Set(['0,1,2','0,3,4'])},b={key:a.key,kept:new Set(['0,1,2','0,5,6'])};
 expect(routeDangerHash(a,cache)).not.toBe(routeDangerHash(b,cache));
 expect(routeDangerHash(a,cache)).toBe(routeDangerHash({...a,kept:new Set([...a.kept].reverse())},cache));
});
