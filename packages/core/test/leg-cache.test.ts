import {expect,test,spyOn} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,truncateSync} from 'node:fs';
import * as fs from 'node:fs';
import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {legCache,PRIOR_KEEP_MS,removeSupersededLegFiles,routeDangerHash} from '../src/leg-cache';
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
test('ROUTE_LEG_CACHE=0 reads and writes no saved length; a length measured in the process stays for the process',()=>{
 const dir=mkdtempSync(join(tmpdir(),'route-leg-off-')),file=join(dir,'legs.sqlite'),prior=process.env.ROUTE_LEG_CACHE;
 try{
  const warm=legCache(file,'source');warm.set('a>b',12);warm.save();warm.close();
  process.env.ROUTE_LEG_CACHE='0';
  const cold=legCache(file,'source');
  expect(cold.get('a>b')).toBeUndefined();
  cold.set('c>d',7);expect(cold.get('c>d')).toBe(7);cold.save();cold.close();
  delete process.env.ROUTE_LEG_CACHE;
  const again=legCache(file,'source');
  try{expect(again.get('a>b')).toBe(12);expect(again.get('c>d')).toBeUndefined();}finally{again.close();}
 }finally{if(prior===undefined)delete process.env.ROUTE_LEG_CACHE;else process.env.ROUTE_LEG_CACHE=prior;rmSync(dir,{recursive:true,force:true});}
});
test('the first store is read only and feeds the v2 store; it goes when nothing wrote it for 7 days, its unread forms at once',()=>{
 const dir=mkdtempSync(join(tmpdir(),'route-leg-old-')),file=join(dir,'route-legs-v2.sqlite');
 try{
  const first=new Database(join(dir,'route-legs.sqlite'));
  first.exec("CREATE TABLE legs (source TEXT, key TEXT, value INTEGER, PRIMARY KEY (source, key)) WITHOUT ROWID");
  const ns=(source:string)=>require('node:crypto').createHash('sha256').update(source).digest('base64url');
  first.query('INSERT INTO legs VALUES (?, ?, ?)').run(ns('source'),'a>b',12);first.query('INSERT INTO legs VALUES (?, ?, ?)').run(ns('other'),'c>d',5);first.close();
  for(const name of ['route-legs.json','route-legs.json.4752.1.zro24n.tmp','route-areas.bin'])writeFileSync(join(dir,name),'x');
  const cache=legCache(file,'source');
  // The unread forms went at the open; the first store stays, because it was written now.
  expect(fs.readdirSync(dir).filter(n=>!n.startsWith('route-legs-v2')).sort()).toEqual(['route-areas.bin','route-legs.sqlite']);
  expect(cache.get('a>b')).toBe(12);expect(cache.get('c>d')).toBeUndefined();expect(cache.get('x>y')).toBeUndefined();
  cache.set('x>y',3);cache.save();cache.close();
  // The length that was found is in the v2 store now, and the first store has no new row.
  const v2=new Database(file,{readonly:true}),again=new Database(join(dir,'route-legs.sqlite'),{readonly:true});
  expect(v2.query('SELECT key FROM legs ORDER BY key').all()).toEqual([{key:'a>b'},{key:'x>y'}]);
  expect(again.query('SELECT COUNT(*) AS n FROM legs').get()).toEqual({n:2});
  v2.close();again.close();
  expect(removeSupersededLegFiles(file,Date.now()+PRIOR_KEEP_MS-60_000)).toEqual([]);
  expect(removeSupersededLegFiles(file,Date.now()+PRIOR_KEEP_MS+60_000)).toEqual(['route-legs.sqlite']);
  expect(fs.readdirSync(dir).filter(n=>!n.startsWith('route-legs-v2')).sort()).toEqual(['route-areas.bin']);
  expect(removeSupersededLegFiles(join(dir,'missing','route-legs-v2.sqlite'))).toEqual([]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('bulk read-ahead preload after 256 lookups preserves exact hits, nulls, misses, and later peer writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-leg-preload-')), file = join(dir, 'legs.sqlite');
    const writer = legCache(file, 'source');
    try {
        for (let i = 0; i < 320; i++) writer.set(`k:${i}`, i % 7 === 0 ? null : i);
        writer.save();
        const reader = legCache(file, 'source');
        try {
            for (let i = 0; i < 320; i++) {
                expect(reader.get(`k:${i}`)).toBe(i % 7 === 0 ? null : i);
            }
            expect(reader.get('k:absent')).toBeUndefined();
            writer.set('k:later', 99);
            writer.save();
            expect(reader.get('k:later')).toBe(99);
        } finally {
            reader.close();
        }
    } finally {
        writer.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
