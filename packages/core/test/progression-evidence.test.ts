import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeProgressionEvidence,readProgressionMeasurements,type ProgressionEvidenceWriter} from '../src/progression-evidence';
test('independent account evidence retains both raw sample streams in one context',()=>{
 const dir=mkdtempSync(join(tmpdir(),'progression-evidence-')),conditions=JSON.stringify([80,[[3,841]],0,'server']);
 try{
  for(const [account,units]of [['First',10],['Second',20]]as const)expect(writeProgressionEvidence(join(dir,'context',account+'.json'),{method:'ranged',source:'s',conditions:JSON.parse(conditions),windows:[{source:'s',conditions,units,ticks:150,setupTicks:0}]})).toBe(true);
  const r=readProgressionMeasurements(join(dir,'context'),'ranged','s',conditions);
  expect(r.windows.map(w=>w.units).sort((a,b)=>a-b)).toEqual([10,20]);expect(r.evidence).toHaveLength(2);
  expect(readdirSync(join(dir,'context')).filter(n=>n.includes('.tmp'))).toEqual([]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('write and rename failure cannot escape the optional telemetry writer',()=>{
 const removed:string[]=[],logs:string[]=[],temps:string[]=[];
 const writer:ProgressionEvidenceWriter={pid:123,nonce:()=>String(temps.length),mkdir:()=>{},write:(path)=>{temps.push(path);throw Error('injected write fault');},rename:()=>{},remove:path=>{removed.push(path);}};
 expect(writeProgressionEvidence('account.json',{units:1},line=>logs.push(line),writer)).toBe(false);
 writer.write=path=>{temps.push(path);};writer.rename=()=>{throw Error('injected rename fault');};
 expect(writeProgressionEvidence('account.json',{units:1},()=>{throw Error('broken logger');},writer)).toBe(false);
 expect(new Set(temps).size).toBe(2);expect(removed).toEqual(temps);expect(logs[0]?.length).toBeLessThanOrEqual(240);
});
test('different sources and conditions or a malformed account file cannot enter a shared comparison',()=>{
 const dir=mkdtempSync(join(tmpdir(),'progression-evidence-')),conditions='[80]';
 try{
  writeProgressionEvidence(join(dir,'Good.json'),{method:'ranged',source:'s',conditions:[80],windows:[{source:'s',conditions,units:1},{source:'old',conditions,units:999},{source:'s',conditions:'[90]',units:999}]});
  writeProgressionEvidence(join(dir,'Other.json'),{method:'other',source:'s',conditions:[80],windows:[{source:'s',conditions,units:999}]});
  writeFileSync(join(dir,'Broken.json'),'{');
  const r=readProgressionMeasurements(dir,'ranged','s',conditions);expect(r.windows.map(w=>w.units)).toEqual([1]);expect(r.evidence).toHaveLength(1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('measurement reads stop at the account-file bound and ignore temp files',()=>{
 const dir=mkdtempSync(join(tmpdir(),'progression-evidence-'));
 try{
  for(let n=0;n<70;n++)writeProgressionEvidence(join(dir,'A'+n+'.json'),{method:'m',source:'s',conditions:[],windows:[{source:'s',conditions:'[]',units:n}]});
  writeFileSync(join(dir,'A0.json.tmp.fake'),'secret unrelated bytes');
  const r=readProgressionMeasurements(dir,'m','s','[]');expect(r.evidence).toHaveLength(64);expect(r.windows).toHaveLength(64);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
