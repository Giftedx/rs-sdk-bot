import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {pathfindingSourceKey,decodePathfindingSnapshot,verifyPathfindingSnapshotFile,writePathfindingSnapshot} from '../src/pathcache';

const api={pathfindingSourceKey,decodePathfindingSnapshot,verifyPathfindingSnapshotFile,writePathfindingSnapshot};
const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function fixture(payload=Buffer.alloc(65536,7),key='fixture'){
 const header=Buffer.from(JSON.stringify({format:2,key,bytes:payload.length,sha256:digest(payload)}));
 const length=Buffer.alloc(4);length.writeUInt32LE(header.length);
 return Buffer.concat([length,header,payload]);
}

test('source identity changes when bytes change despite identical size and timestamp',()=>{
 const root=mkdtempSync(join(tmpdir(),'pathcache-source-')),wasm=join(root,'module'),collision=join(root,'collision');
 writeFileSync(wasm,'AAAA');writeFileSync(collision,'BBBB');
 const stamp=new Date('2026-01-01T00:00:00Z');utimesSync(wasm,stamp,stamp);utimesSync(collision,stamp,stamp);
 const before=api.pathfindingSourceKey(wasm,collision);
 writeFileSync(collision,'CCCC');utimesSync(collision,stamp,stamp);
 expect(api.pathfindingSourceKey(wasm,collision)).not.toBe(before);
 const changed=api.pathfindingSourceKey(wasm,collision);
 utimesSync(collision,new Date(),new Date());
 expect(api.pathfindingSourceKey(wasm,collision)).toBe(changed);
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
