import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {questSpec,questPreflight,questSavedChecks,savedQuest,runQuestOrder,questOrderRuntime} from './quest-order';

const spec=questSpec('cook');
const quest=[{id:1944,count:1},{id:1927,count:1},{id:1933,count:1}];
const save=(vars:Record<number,number>,pack:{id:number;count:number}[],bank:{id:number;count:number}[]=[])=>({version:9,position:{x:3208,z:3214,level:0},skills:[],vars,
 inventories:{93:pack.map((i,slot)=>({...i,slot})),95:bank.map((i,slot)=>({...i,slot}))}}) as any;

test('cook spec is resolved from the pinned varp pack and quest knowledge',()=>{
 expect(spec).toMatchObject({varpId:29,qpVarpId:101,complete:2,questPoints:1,script:'scripts/generated/quest-cook.ts'});
 expect(()=>questSpec('nope')).toThrow('unknown quest');expect(()=>questSpec('constructor')).toThrow('unknown quest');
});
test('preflight refuses a finished quest, unknown state and missing or surplus items',()=>{
 expect(questPreflight(spec,{progress:0,pack:quest})).toEqual({ok:true});
 expect(questPreflight(spec,{flag:'started',pack:quest})).toEqual({ok:true});
 expect(questPreflight(spec,{progress:2,pack:quest})).toEqual({ok:false,refused:'quest already complete'});
 expect(questPreflight(spec,{flag:'complete',pack:quest})).toEqual({ok:false,refused:'quest already complete'});
 for(const flag of ['unknown',null] as const)expect(questPreflight(spec,{flag,pack:quest}).ok).toBe(false);
 expect(questPreflight(spec,{progress:0,pack:null}).ok).toBe(false);
 expect(questPreflight(spec,{progress:0,pack:quest.slice(1)})).toEqual({ok:false,refused:'missing item Egg 0/1'});
 expect(questPreflight(spec,{progress:0,pack:[...quest,{id:1944,count:1}]})).toEqual({ok:false,refused:'surplus item Egg 2/1'});
});
test('saved checks need the complete varp, exact QP rise, consumed items and banked leftovers',()=>{
 const before=save({101:3},[...quest,{id:1351,count:1}],[{id:1351,count:2}]);
 const after=save({29:2,101:4},[],[{id:1351,count:3}]);
 expect(Object.values(questSavedChecks(spec,before,after)).every(Boolean)).toBe(true);
 expect(savedQuest(save({},[]),spec)).toEqual({progress:0,qp:0,done:false});
 expect(questSavedChecks(spec,before,{...after,vars:{29:1,101:4}}).varp).toBe(false);
 expect(questSavedChecks(spec,before,{...after,vars:{29:2,101:3}}).questPoints).toBe(false);
 expect(questSavedChecks(spec,before,save({29:2,101:4},[{id:1351,count:1}],[{id:1351,count:2}])).banked).toBe(false);
 expect(questSavedChecks(spec,before,save({29:2,101:4},[{id:1944,count:1}],[{id:1351,count:3}])).consumed).toBe(false);
 expect(questSavedChecks(spec,save({29:2,101:4},quest),after).entry).toBe(false);
});
test('a missing save refuses without any login',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'quest-order-'));
 try{expect(await runQuestOrder('nobody1','cook',{save:join(dir,'nobody1.sav'),timeoutMs:60000})).toMatchObject({ok:false,refused:'save not found'});}
 finally{rmSync(dir,{recursive:true,force:true});}
});

test('saved acceptance rejects surplus entry items and ingredients moved to the bank',()=>{
 const before=save({},[...quest,{id:1351,count:1}],[{id:1944,count:2}]);
 const after=save({29:2,101:1},[],[{id:1351,count:1},{id:1944,count:2}]);
 expect(Object.values(questSavedChecks(spec,before,after)).every(Boolean)).toBe(true);
 expect(questSavedChecks(spec,save({},[...quest,{id:1944,count:1}]),after).entry).toBe(false);
 expect(questSavedChecks(spec,before,save({29:2,101:1},[],[{id:1351,count:1},{id:1944,count:3}])).consumed).toBe(false);
});

test('an order without a save refuses before opening a session',async()=>{
 expect(await runQuestOrder('nobody1','cook',{timeoutMs:60000})).toMatchObject({ok:false,refused:'save required',login:false});
});

test('saved completed and missing-item orders refuse before any account access',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'quest-order-'));
 try{
  // Minimal v9 engine save: header, 21 skills, one varp, no inventories, CRC.
  const path=join(dir,'nobody1.sav'),bytes=Buffer.alloc(143);
  bytes.writeUInt16BE(0x2004,0);bytes.writeUInt16BE(9,2);
  bytes.writeUInt16BE(1,133);bytes.writeUInt16BE(spec.varpId,135);bytes[137]=spec.complete;
  const publish=()=>{bytes.writeUInt32BE(Bun.hash.crc32(bytes.subarray(0,-4))>>>0,bytes.length-4);writeFileSync(path,bytes);};
  publish();
  expect(await runQuestOrder('nobody1','cook',{save:path,timeoutMs:60000})).toMatchObject({ok:false,refused:'quest already complete',login:false});
  bytes[137]=0;publish();
  expect(await runQuestOrder('nobody1','cook',{save:path,timeoutMs:60000})).toMatchObject({ok:false,refused:'missing item Egg 0/1',login:false});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

// Exercise the actual durable orchestrator across separate calls. No client or server is opened here.
function recoveryFixture(){
 const dir=mkdtempSync(join(tmpdir(),'quest-recovery-')),path=join(dir,'nobody1.sav');writeFileSync(path,'fixture');
 const before=save({101:3},[...quest,{id:1351,count:1},{id:995,count:37}],[{id:1351,count:2},{id:995,count:100},{id:1511,count:8}]);
 const complete=save({29:2,101:4},[{id:1351,count:1},{id:995,count:37}],before.inventories[95]);
 const after=save({29:2,101:4},[],[{id:1351,count:3},{id:995,count:137},{id:1511,count:8}]);
 let current=before,children=0,banks=0;
 const runtime={...questOrderRuntime,server:()=> 'localhost:8888',read:()=>current,
  wait:async(_path:string,ready:(s:any)=>boolean)=>({matched:ready(current),save:current,first:current,reads:1,lastError:''}),
  child:async()=>{children++;current=complete;return{ok:true,logout:true,code:0,result:'RESULT ok'};},
  bank:async()=>{banks++;current=after;return{ok:true,logout:true,detail:'banked',banked:38};}};
 return{dir,path,before,complete,after,runtime,set:(s:any)=>{current=s;},counts:()=>({children,banks}),
  record:()=>JSON.parse(readFileSync(path+'.quest-order.json','utf8')),clean:()=>rmSync(dir,{recursive:true,force:true})};
}
test('fresh completion settles a durable account order and rerun refuses without acting',async()=>{
 const f=recoveryFixture();try{
  expect(await runQuestOrder('nobody1','cook',{save:f.path,timeoutMs:60000},f.runtime)).toMatchObject({ok:true});
  expect(f.record()).toMatchObject({account:'nobody1',quest:'cook',state:'settled',before:f.before});
  expect(await runQuestOrder('nobody1','cook',{save:f.path,timeoutMs:60000},f.runtime)).toMatchObject({ok:false,login:false,refused:'quest already complete'});
  expect(f.counts()).toEqual({children:1,banks:1});
 }finally{f.clean();}
});
test('child failure after independently saved completion still banks and retains the failure',async()=>{
 const f=recoveryFixture();try{
  f.runtime.child=async()=>{f.set(f.complete);return{ok:false,logout:true,code:1,result:'RESULT fail after completion'};};
  expect(await runQuestOrder('nobody1','cook',{save:f.path,timeoutMs:60000},f.runtime)).toMatchObject({ok:true,stages:{quest:{ok:false,code:1},bank:{ok:true}}});
  expect(f.record().child.code).toBe(1);
 }finally{f.clean();}
});
test('failed banking resumes against the original baseline without replay, including partial deposits',async()=>{
 const f=recoveryFixture();try{
  const bank=f.runtime.bank;
  f.runtime.bank=async()=>{f.set(save({29:2,101:4},[{id:995,count:37}],[{id:1351,count:3},{id:995,count:100},{id:1511,count:8}]));return{ok:false,logout:true,detail:'interrupted deposit',banked:1};};
  expect(await runQuestOrder('nobody1','cook',{save:f.path,timeoutMs:60000},f.runtime)).toMatchObject({ok:false,failed:'bank'});
  expect(f.record().state).toBe('pending');f.runtime.bank=bank;
  expect(await runQuestOrder('nobody1','cook',{save:f.path,timeoutMs:60000},f.runtime)).toMatchObject({ok:true,stages:{resumed:true}});
  expect(f.counts()).toEqual({children:1,banks:1});expect(f.record().before).toEqual(f.before);
 }finally{f.clean();}
});
test('completion, asset and logout contradictions cannot authorize bank recovery',async()=>{
 for(const fault of ['varp','qp','asset','logout'] as const){
  const f=recoveryFixture();try{
   f.runtime.child=async()=>{f.set(fault==='varp'?save({29:1,101:4},[],[]):fault==='qp'?save({29:2,101:99},[],[]):fault==='asset'?save({29:2,101:4},[],[]):f.complete);return{ok:false,logout:fault!=='logout',code:1,result:'RESULT fail'};};
   expect((await runQuestOrder('nobody1','cook',{save:f.path,timeoutMs:60000},f.runtime)).ok).toBe(false);
   expect(f.counts().banks).toBe(0);
   expect(await runQuestOrder('nobody1','cook',{save:f.path,timeoutMs:60000},f.runtime)).toMatchObject({ok:false,login:false,refused:'pending quest requires reconciliation'});
  }finally{f.clean();}
 }
});
test('pending journal rejects another account, save, quest, server, and unconfirmed bank logout',async()=>{
 for(const field of ['account','save','quest','server','logout']){
  const f=recoveryFixture();try{
   f.runtime.bank=async()=>({ok:false,logout:true,detail:'bank refused',banked:0});
   await runQuestOrder('nobody1','cook',{save:f.path,timeoutMs:60000},f.runtime);
   const record=f.record();if(field==='logout')record.bank.logout=false;else record[field]='unrelated';
   writeFileSync(f.path+'.quest-order.json',JSON.stringify(record));
   expect(await runQuestOrder('nobody1','cook',{save:f.path,timeoutMs:60000},f.runtime)).toMatchObject({ok:false,login:false});
   expect(f.counts().children).toBe(1);
  }finally{f.clean();}
 }
});
test('saved asset checks include bank-only reserves, exact credit, extra items and worn kit',()=>{
 const f=recoveryFixture();try{
  for(const bank of [[{id:1351,count:3},{id:995,count:137}], [{id:1351,count:4},{id:995,count:137},{id:1511,count:8}], [{id:1351,count:3},{id:995,count:137},{id:1511,count:8},{id:526,count:1}]]){
   expect(questSavedChecks(spec,f.before,save({29:2,101:4},[],bank)).assets).toBe(false);
  }
  const before={...f.before,inventories:{...f.before.inventories,94:[{id:1205,count:1,slot:3}]}};
  expect(questSavedChecks(spec,before,f.after).assets).toBe(false);
 }finally{f.clean();}
});
test('concurrent calls cannot replace the pending baseline or start another child',async()=>{
 const f=recoveryFixture();try{
  const child=f.runtime.child;let resume!:()=>void;
  const held=new Promise<void>(resolve=>{resume=resolve;});let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  f.runtime.child=async()=>{entered();await held;return child();};
  const running=runQuestOrder('nobody1','cook',{save:f.path,timeoutMs:60000},f.runtime);
  await started;
  try{
   expect(await runQuestOrder('nobody1','cook',{save:f.path,timeoutMs:60000},f.runtime)).toMatchObject({ok:false,login:false,refused:'quest order owned'});
   expect(f.record().before).toEqual(f.before);
  }finally{resume();}
  expect((await running).ok).toBe(true);expect(f.counts()).toEqual({children:1,banks:1});
 }finally{f.clean();}
});
