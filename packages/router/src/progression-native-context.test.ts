import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import fixture from '../../practice/src/ranged-progression-entry.json';
import * as native from './progression-native-context';

const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function setup(){
 const base=mkdtempSync(join(tmpdir(),'progression-context-')),at=Date.now();
 const status:any={...structuredClone(fixture),name:'Testarmy',server:'rs-sdk-demo.fly.dev',at,bankAt:at-50,started:at-1000,
  result:'ok inspection',sessionAttemptId:'attempt-test',coordinatorRunId:'task-observer',equipmentObserved:true};
 const path=join(base,'.practice/status/Testarmy.json');mkdirSync(join(base,'.practice/status'),{recursive:true});
 const save=()=>{const bytes=Buffer.from(JSON.stringify(status));writeFileSync(path,bytes);return hash(bytes);};
 const env={PROGRESSION_ACCOUNT:status.name,PROGRESSION_TARGET_LEVEL:'85',PROGRESSION_ENTRY_AT:String(at),PROGRESSION_ENTRY_SHA256:save(),PROGRESSION_CONSUMER:JSON.stringify({skills:{Ranged:99}})};
 const task={account:status.name,env},proof:any={state:'confirmed',account:status.name,server:status.server,domain:'live',attemptId:status.sessionAttemptId,
  loggedOutAt:at-10,ownerRun:status.coordinatorRunId,receiptSha256:'b'.repeat(64)};
 const deps={base,now:()=>at+10,owns:()=>true,logout:()=>proof};
 return{base,status,path,save,task,proof,deps,close:()=>rmSync(base,{recursive:true,force:true})};
}
test('a bound finite native qualification freezes the actual entry and scopes only practice context',async()=>{
 const s=setup(),oldEntry=process.env.RANGED_PROGRESSION_ENTRY,oldTarget=process.env.RANGED_PROGRESSION_TARGET;
 process.env.RANGED_PROGRESSION_ENTRY='old-entry';process.env.RANGED_PROGRESSION_TARGET='old-target';
 try{
  await native.runQualifiedDelivery({id:'ranged-train'},s.task,async()=>{
   const entry=JSON.parse(readFileSync(process.env.RANGED_PROGRESSION_ENTRY!,'utf8'));
   expect(entry.sourceSha256).toBe(s.task.env.PROGRESSION_ENTRY_SHA256);expect(entry.skills).toEqual(s.status.skills);
   expect(entry.equipment).toEqual(s.status.equipment);expect(process.env.RANGED_PROGRESSION_TARGET).toBe('85');
   return{ok:true};
  },s.deps);
  expect(process.env.RANGED_PROGRESSION_ENTRY).toBe('old-entry');expect(process.env.RANGED_PROGRESSION_TARGET).toBe('old-target');
  await expect(native.runQualifiedDelivery({id:'ranged-train'},s.task,async()=>{throw Error('native failed');},s.deps)).rejects.toThrow('native failed');
  expect(process.env.RANGED_PROGRESSION_TARGET).toBe('old-target');
 }finally{if(oldEntry===undefined)delete process.env.RANGED_PROGRESSION_ENTRY;else process.env.RANGED_PROGRESSION_ENTRY=oldEntry;if(oldTarget===undefined)delete process.env.RANGED_PROGRESSION_TARGET;else process.env.RANGED_PROGRESSION_TARGET=oldTarget;s.close();}
});
test('changed, unobserved, held, foreign or oversized entry contexts never start native practice',async()=>{
 for(const mutate of [(s:any)=>s.status.equipmentObserved=false,(s:any)=>s.proof.state='held',(s:any)=>s.proof.attemptId='new-attempt',
  (s:any)=>s.deps.owns=()=>false,(s:any)=>s.task.env.PROGRESSION_TARGET_LEVEL='99',(s:any)=>s.status.at--,
  (s:any)=>s.status.bankAt-=300001,(s:any)=>delete s.status.started,(s:any)=>s.task.account='Haggis']){
  const s=setup();try{mutate(s);s.task.env.PROGRESSION_ENTRY_SHA256=s.save();let called=false;await expect(native.runQualifiedDelivery({id:'ranged-train'},s.task,async()=>{called=true;},s.deps)).rejects.toThrow();expect(called).toBe(false);}finally{s.close();}
 }
});
test('a new account observation during native practice cannot authorize the old context',async()=>{
 const s=setup();try{await expect(native.runQualifiedDelivery({id:'ranged-train'},s.task,async()=>{s.status.at++;s.save();return{ok:true};},s.deps)).rejects.toThrow('changed');}finally{s.close();}
});
test('native context accepts one case-normalized Ranged consumer and rejects ambiguous aliases',async()=>{
 const s=setup();try{
  s.task.env.PROGRESSION_CONSUMER=JSON.stringify({skills:{ranged:99}});
  expect(await native.runQualifiedDelivery({id:'ranged-train'},s.task,async()=>true,s.deps)).toBe(true);
  for(const skills of [{Ranged:99,ranged:99},{Ranged:99,Prayer:99}]){
   s.task.env.PROGRESSION_CONSUMER=JSON.stringify({skills});
   await expect(native.runQualifiedDelivery({id:'ranged-train'},s.task,async()=>true,s.deps)).rejects.toThrow('consumer');
  }
 }finally{s.close();}
});
test('ordinary qualification clears inherited dynamic context then restores it',async()=>{
 const oldEntry=process.env.RANGED_PROGRESSION_ENTRY;process.env.RANGED_PROGRESSION_ENTRY='unbound';
 try{await native.runQualifiedDelivery({id:'ranged-train'},{},async()=>{expect(process.env.RANGED_PROGRESSION_ENTRY).toBeUndefined();});expect(process.env.RANGED_PROGRESSION_ENTRY).toBe('unbound');}
 finally{if(oldEntry===undefined)delete process.env.RANGED_PROGRESSION_ENTRY;else process.env.RANGED_PROGRESSION_ENTRY=oldEntry;}
});
