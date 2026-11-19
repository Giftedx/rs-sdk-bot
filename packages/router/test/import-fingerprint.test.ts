import {expect,spyOn,test} from 'bun:test';
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {deliveryFingerprint,importClosure} from '../src/delivery-cli';
import type {DeliveryTask} from '../src/delivery';
import ts from 'typescript';
import {releaseFileDigest} from '../../core/src/release-digest';

test('delivery fingerprints hold the program digest of each source with one fresh read per source',()=>{
 const base=fs.mkdtempSync(join(tmpdir(),'fingerprint-reads-'));
 const task:DeliveryTask={id:'read-once',goal:'Keep qualification current',entry:'scripts/entry.ts',files:['scripts/entry.ts','scripts/data.json'],consumer:'Current source',checks:[]};
 fs.mkdirSync(join(base,'scripts'),{recursive:true});
 fs.mkdirSync(join(base,'packages/router/src'),{recursive:true});
 fs.writeFileSync(join(base,'packages/router/src/saved-proof-verifiers.json'),'{}');
 fs.writeFileSync(join(base,'scripts/entry.ts'),"import './shared';\nexport const value = '£';");
 fs.writeFileSync(join(base,'scripts/shared.ts'),'export const shared = 1;');
 fs.writeFileSync(join(base,'scripts/data.json'),Buffer.from([0xff,0x00,0x7f]));
 const sources=importClosure([task.entry,...task.files],base);
 const legacy=createHash('sha256').update(JSON.stringify(task)).update('\0saved-proof-policy\0').update('[]');
 for(const file of sources)legacy.update(file+'\0').update(releaseFileDigest(file,fs.readFileSync(join(base,file)),ts)).update('\0');
 const expected=legacy.digest('hex'),nativeRead=fs.readFileSync,counts=new Map<string,number>();
 const read=spyOn(fs,'readFileSync').mockImplementation(((path:any,...args:any[])=>{
  const file=String(path);counts.set(file,(counts.get(file)??0)+1);
  return(nativeRead as any)(path,...args);
 }) as typeof fs.readFileSync);
 try{
  const first=deliveryFingerprint(task,base);
  expect(first).toBe(expected);
  // One value that this file does not compute with the function under test: the fingerprint of the fixture under
  // release-digest-2 and TypeScript 5.8. A change of the digest rule changes it, and RELEASE_DIGEST_VERSION with it.
  expect(first).toBe('ceb8c504c062d33cd9b25df9f5fe585ddb3b74a381a1b6bb9a7b84fe10f05aef');
  for(const file of sources)expect(counts.get(join(base,file))).toBe(1);
  fs.writeFileSync(join(base,'scripts/shared.ts'),'export const shared = 2;');
  expect(deliveryFingerprint(task,base)).not.toBe(first);
  for(const file of sources)expect(counts.get(join(base,file))).toBe(2);
  // A comment, a blank line and CRLF line endings keep the source; a type import adds no file to it.
  const second=deliveryFingerprint(task,base);
  fs.writeFileSync(join(base,'scripts/shared.ts'),'// why\r\nexport const shared = 2; /* note */\r\n\r\n');
  expect(deliveryFingerprint(task,base)).toBe(second);
  fs.writeFileSync(join(base,'scripts/types.ts'),'export interface T{n:number}');
  fs.writeFileSync(join(base,'scripts/shared.ts'),"import type {T} from './types';\nexport const shared = 2 as unknown as T;");
  expect(importClosure([task.entry,...task.files],base)).not.toContain('scripts/types.ts');
 }finally{read.mockRestore();fs.rmSync(base,{recursive:true,force:true});}
});
