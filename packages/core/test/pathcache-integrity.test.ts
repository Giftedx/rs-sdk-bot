import {test,expect,spyOn} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,utimesSync,rmSync} from 'node:fs';
import * as fs from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {pathfindingSourceKey,decodePathfindingSnapshot,verifyPathfindingSnapshotFile,writePathfindingSnapshot,restorePathfindingSnapshotFile} from '../src/pathcache';

const api={pathfindingSourceKey,decodePathfindingSnapshot,verifyPathfindingSnapshotFile,writePathfindingSnapshot};
const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function fixture(payload=Buffer.alloc(65536,7),key='fixture'){
 const header=Buffer.from(JSON.stringify({format:2,key,bytes:payload.length,sha256:digest(payload)}));
 const length=Buffer.alloc(4);length.writeUInt32LE(header.length);
 return Buffer.concat([length,header,payload]);
}

test('source identity changes when bytes change despite identical size and timestamp',()=>{
 const root=mkdtempSync(join(tmpdir(),'pathcache-source-')),wasm=join(root,'module'),collision=join(root,'collision'),doors=join(root,'doors.json'),initializer=join(root,'pathfinding.ts');
 try{
  writeFileSync(wasm,'AAAA');writeFileSync(collision,'BBBB');writeFileSync(doors,'[]');writeFileSync(initializer,'policy A');
  const source=()=>api.pathfindingSourceKey(wasm,collision,doors,initializer);
  const stamp=new Date('2026-01-01T00:00:00Z');utimesSync(wasm,stamp,stamp);utimesSync(collision,stamp,stamp);utimesSync(initializer,stamp,stamp);
  const before=source();
  writeFileSync(collision,'CCCC');utimesSync(collision,stamp,stamp);
  expect(source()).not.toBe(before);
  const changed=source();
  utimesSync(collision,new Date(),new Date());
  expect(source()).toBe(changed);
  writeFileSync(initializer,'policy B');utimesSync(initializer,stamp,stamp);
  expect(source()).not.toBe(changed);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('valid snapshot restores only for the matching source identity',()=>{
 const bytes=fixture();
 expect(api.decodePathfindingSnapshot(bytes,'fixture')).toEqual(new Uint8Array(65536).fill(7));
 expect(api.decodePathfindingSnapshot(bytes,'other')).toBeNull();
});

test('a same-length payload bitflip, truncation or oversized header is rejected',()=>{
 const bytes=fixture(),changed=Buffer.from(bytes);changed[changed.length-1]^=1;
 expect(api.decodePathfindingSnapshot(changed,'fixture')).toBeNull();
 expect(api.decodePathfindingSnapshot(bytes.subarray(0,bytes.length-1),'fixture')).toBeNull();
 const oversized=Buffer.from(bytes);oversized.writeUInt32LE(0xffffffff);
 expect(api.decodePathfindingSnapshot(oversized,'fixture')).toBeNull();
 expect(api.decodePathfindingSnapshot(Buffer.from([1,2,3]),'fixture')).toBeNull();
});

test('old or malformed snapshot metadata does not restore',()=>{
 const payload=Buffer.alloc(65536),headers=[
  JSON.stringify({format:1,key:'fixture',bytes:payload.length,sha256:digest(payload)}),
  JSON.stringify({format:2,key:'fixture',bytes:payload.length,sha256:'invalid'}),
  JSON.stringify({v:1,wasm:[4,0],data:[4,0]})+':'+payload.length,
  '{not json',
 ];
 for(const text of headers){const head=Buffer.from(text),length=Buffer.alloc(4);length.writeUInt32LE(head.length);expect(api.decodePathfindingSnapshot(Buffer.concat([length,head,payload]),'fixture')).toBeNull();}
});

test('written snapshot is checked from disk before replacing an existing snapshot',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pathcache-write-')),file=join(dir,'world.snap');
 writeFileSync(file,'old completed bytes');
 expect(()=>api.writePathfindingSnapshot(file,'fixture',new Uint8Array(1))).toThrow();
 expect(readFileSync(file,'utf8')).toBe('old completed bytes');
 api.writePathfindingSnapshot(file,'fixture',new Uint8Array(65536).fill(3));
 expect(api.verifyPathfindingSnapshotFile(file,'fixture')).toBe(true);
 const bytes=readFileSync(file);bytes[bytes.length-123]^=1;writeFileSync(file,bytes);
 expect(api.verifyPathfindingSnapshotFile(file,'fixture')).toBe(false);
});

test('snapshot read failures and invalid payloads leave native memory untouched',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pathcache-read-')),file=join(dir,'world.snap'),memory=new WebAssembly.Memory({initial:1});
 new Uint8Array(memory.buffer).fill(19);
 try{
  expect(restorePathfindingSnapshotFile(dir,'fixture',memory)).toBe(false);
  const bytes=fixture(Buffer.alloc(2*65536,7));writeFileSync(file,bytes);
  const read=fs.readSync;
  const fault=spyOn(fs,'readSync').mockImplementation(((fd:number,buffer:Buffer,offset:number,length:number,position:number)=>{
   if(buffer.length===2*65536){
    if(offset>0)throw Object.assign(Error('fixture read failure'),{code:'EIO'});
    return read(fd,buffer,offset,65536,position);
   }
   return read(fd,buffer,offset,length,position);
  }) as typeof fs.readSync);
  try{expect(restorePathfindingSnapshotFile(file,'fixture',memory)).toBe(false);}finally{fault.mockRestore();}
  expect(memory.buffer.byteLength).toBe(65536);
  expect(new Uint8Array(memory.buffer).every(value=>value===19)).toBe(true);
  bytes[bytes.length-1]^=1;writeFileSync(file,bytes);
  expect(restorePathfindingSnapshotFile(file,'fixture',memory)).toBe(false);
  expect(new Uint8Array(memory.buffer).every(value=>value===19)).toBe(true);
  writeFileSync(file,fixture(Buffer.alloc(2*65536,7)));
  const capped=new WebAssembly.Memory({initial:1,maximum:1});new Uint8Array(capped.buffer).fill(23);
  expect(restorePathfindingSnapshotFile(file,'fixture',capped)).toBe(false);
  expect(capped.buffer.byteLength).toBe(65536);
  expect(new Uint8Array(capped.buffer).every(value=>value===23)).toBe(true);
  expect(restorePathfindingSnapshotFile(file,'fixture',memory)).toBe(true);
  expect(memory.buffer.byteLength).toBe(2*65536);
  expect(new Uint8Array(memory.buffer).every(value=>value===7)).toBe(true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('native initialization errors remain visible, can retry, and cache writes are optional',async()=>{
 const root=resolve(import.meta.dir,'../../..');
 const probe=`
  import assert from 'node:assert/strict';
  import {mock} from 'bun:test';
  import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
  import {tmpdir} from 'node:os';
  import {join,resolve} from 'node:path';
  const dir=mkdtempSync(join(tmpdir(),'pathcache-load-')),blocker=join(dir,'not-a-directory');
  writeFileSync(blocker,'cache unavailable');
  const memory=new WebAssembly.Memory({initial:1});
  let calls=0;
  mock.module(resolve('vendor/rs-sdk/server/vendor/rsmod-pathfinder/rsmod-pathfinder.js'),()=>({__wasm:{memory},changeLoc(){}}));
  mock.module(resolve('vendor/rs-sdk/sdk/pathfinding.ts'),()=>({initPathfinding(){calls++;if(calls===1)throw Error('native initialization failed');new Uint8Array(memory.buffer)[0]=42;}}));
  const {loadPathfinding}=await import('./packages/core/src/pathcache');
  const opts={cacheFile:join(blocker,'world.snap')};
  try{
   const first=loadPathfinding(opts);
   assert.equal(loadPathfinding(opts),first);
   await assert.rejects(first,/native initialization failed/);
   const retry=loadPathfinding(opts);
   assert.equal(loadPathfinding(opts),retry);
   assert.equal((await retry).restored,false);
   assert.equal(calls,2);
   assert.equal(new Uint8Array(memory.buffer)[0],42);
  }finally{rmSync(dir,{recursive:true,force:true});}
 `;
 const child=Bun.spawn([process.execPath,'-e',probe],{cwd:root,stdout:'pipe',stderr:'pipe',windowsHide:true});
 const deadline=setTimeout(()=>child.kill(),10000);
 try{
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({code,stdout,stderr}).toEqual({code:0,stdout:'',stderr:''});
 }finally{clearTimeout(deadline);}
});
