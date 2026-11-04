import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
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
test('danger cache scopes include every opened tile and ignore set insertion order',()=>{
 const cache={hash:JSON.stringify};
 const a={key:'same hunters',kept:new Set(['0,1,2','0,3,4'])},b={key:a.key,kept:new Set(['0,1,2','0,5,6'])};
 expect(routeDangerHash(a,cache)).not.toBe(routeDangerHash(b,cache));
 expect(routeDangerHash(a,cache)).toBe(routeDangerHash({...a,kept:new Set([...a.kept].reverse())},cache));
});
