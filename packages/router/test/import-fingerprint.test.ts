import {expect,spyOn,test} from 'bun:test';
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {deliveryFingerprint,importClosure} from '../src/delivery-cli';
import type {DeliveryTask} from '../src/delivery';

test('delivery fingerprints retain exact bytes with one fresh read per source',()=>{
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
 for(const file of sources)legacy.update(file+'\0').update(fs.readFileSync(join(base,file))).update('\0');
 const expected=legacy.digest('hex'),nativeRead=fs.readFileSync,counts=new Map<string,number>();
 const read=spyOn(fs,'readFileSync').mockImplementation(((path:any,...args:any[])=>{
  const file=String(path);counts.set(file,(counts.get(file)??0)+1);
  return(nativeRead as any)(path,...args);
 }) as typeof fs.readFileSync);
 try{
  const first=deliveryFingerprint(task,base);
  expect(first).toBe(expected);
  for(const file of sources)expect(counts.get(join(base,file))).toBe(1);
  fs.writeFileSync(join(base,'scripts/shared.ts'),'export const shared = 2;');
  expect(deliveryFingerprint(task,base)).not.toBe(first);
  for(const file of sources)expect(counts.get(join(base,file))).toBe(2);
 }finally{read.mockRestore();fs.rmSync(base,{recursive:true,force:true});}
});
