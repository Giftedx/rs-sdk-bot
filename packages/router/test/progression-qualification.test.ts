import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync,readdirSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';import {createHash} from 'node:crypto';
import {registerProgressionQualification,type ProgressionRegistrationOptions} from '../src/progression-qualification';
import {progressionProofs,evaluateProgressionWork} from '../../core/src/progression-session';
import type {DeliveryTask} from '../src/delivery';
const source='a'.repeat(64),runtime='b'.repeat(64),producer='c'.repeat(64),hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
function fixture(prayer=96){
 const base=mkdtempSync(join(tmpdir(),'progression-register-')),practice=join(base,'.practice'),directory=join(practice,'deliveries','ranged-train-fixture'),folder=join(practice,'progression-ranged','adaptive-fixture');
 mkdirSync(directory,{recursive:true});mkdirSync(folder,{recursive:true});mkdirSync(join(base,'scripts'),{recursive:true});
 writeFileSync(join(base,'scripts/ranged-train.ts'),'qualified worker');
 const task:DeliveryTask={id:'ranged-train',goal:'Finite Ranged band',entry:'scripts/ranged-train.ts',files:['scripts/ranged-train.ts'],consumer:'Ranged85 before99',checks:[{id:'regressions',phase:'regression',command:['bun','test'],timeoutMs:1000},{id:'adaptive-ranged-native',phase:'practice',command:['bun','proof.ts'],timeoutMs:1000},{id:'adaptive-ranged-saved',phase:'consumer',command:['bun','verify.ts','--verify'],timeoutMs:1000}]};
 const result={ok:true,targetMet:true,method:'ranged/troopers',finalLevel:85,xpGain:1};
 const proof={ok:true,at:100,code:0,source:runtime,proofSource:producer,entrySha256:hash('frozen entry'),target:85,mode:'adaptive',supportedMethods:[{id:'ranged/troopers',source:runtime,bands:[{levels:{Prayer:{min:prayer,max:prayer},Ranged:{min:80,max:85}},items:{882:149},loadout:[284,285]}]}],checks:{exit:true,result:true,exactEntry:true,xp:true,bank:true,assets:true,arrows:true,coins:true,accounting:true,health:true,logout:true,persisted:true,timeout:true,source:true},result};
 const report:any={ok:true,stage:'delivered',evidence:'native',id:task.id,source,runtimeRevision:runtime,at:200,directory,checks:task.checks.map((c,i)=>({id:c.id,phase:c.phase,exitCode:0,timedOut:false,detail:JSON.stringify({stdout:join(directory,i+'.out.log'),stderr:join(directory,i+'.err.log')})})),files:task.files.map(path=>({path,sha256:hash(readFileSync(join(base,path)))}))};
 const save=()=>{writeFileSync(join(directory,'task.json'),JSON.stringify(task));writeFileSync(join(directory,'report.json'),JSON.stringify(report));writeFileSync(join(folder,'proof.json'),JSON.stringify(proof));writeFileSync(join(folder,'entry.json'),'frozen entry');writeFileSync(join(folder,'before.sav'),'unit native save before');writeFileSync(join(folder,'after.sav'),'unit native save after');writeFileSync(join(folder,'worker.log'),'RANGED_TRAIN_RESULT '+JSON.stringify(result)+'\nLOGOUT logged-out\n');writeFileSync(join(directory,'ranged-adaptive-proof.json'),JSON.stringify({folder}));for(let i=0;i<task.checks.length;i++){writeFileSync(join(directory,i+'.out.log'),i===2?'RANGED_SAVED_PROOF '+JSON.stringify({ok:true,checks:{fresh:true,source:true,proofSource:true,entryHash:true,supportedMethods:true},evidence:folder}):'native accepted');writeFileSync(join(directory,i+'.err.log'),'');}};
 save();let verified=0;const options:ProgressionRegistrationOptions={base,task,fingerprint:()=>source,runtimeRevision:()=>runtime,verifyProof:()=>{verified++;return{checks:{frozenEntry:true,source:true,stateBands:true,rawSaves:true,rawResult:true}};}};
 return{base,practice,directory,folder,task,proof,report,options,save,verified:()=>verified,cleanup:()=>rmSync(base,{recursive:true,force:true})};
}
test('accepted native qualification publishes an immutable hash-bound proof and admission sees only its exact state band',async()=>{
 const f=fixture();try{
  expect(existsSync(join(f.practice,'progression-system/qualifications.json'))).toBe(false);
  expect((await registerProgressionQualification(f.directory,f.options)).registered).toBe(1);
  expect(f.verified()).toBe(1);expect(progressionProofs(f.base)['ranged/troopers']).toEqual({source:runtime,bands:f.proof.supportedMethods[0]!.bands});
  const index=JSON.parse(readFileSync(join(f.practice,'progression-system/qualifications.json'),'utf8'));expect(index.proofs).toHaveLength(1);expect(hash(readFileSync(index.proofs[0].path))).toBe(index.proofs[0].sha256);
  const now=Date.now(),work={script:'scripts/ranged-train.ts',args:['85'],env:{WORKER_RELEASE:runtime}},status={name:'Fixture',server:'rs-sdk-demo.fly.dev',at:now,bankAt:now,questsAt:now,equipmentObserved:true,skills:[{name:'Ranged',level:80,xp:285700},{name:'Prayer',level:96,xp:811012},{name:'Hitpoints',level:99,xp:1084907}],inventory:[],equipment:[{id:284,slot:4,count:1},{id:285,slot:7,count:1}],bank:[{id:841,count:1},{id:882,count:149},{id:2142,count:43},{id:995,count:382923}],quests:[],pos:{x:3253,z:3421,level:0}};
  expect(evaluateProgressionWork(work,status,{now,base:f.base,requireQualification:true}).decision?.selected).toBe('ranged/troopers');
  expect(evaluateProgressionWork(work,{...status,skills:status.skills.map(s=>s.name==='Prayer'?{...s,level:95,xp:758250}:s)},{now,base:f.base,requireQualification:true}).decision?.state).not.toBe('execute');
  writeFileSync(index.proofs[0].path,'corrupt');expect(progressionProofs(f.base)).toEqual({});
 }finally{f.cleanup();}
});
test('repeated accepted deliveries are idempotent and parallel state bands are retained',async()=>{
 const f=fixture();try{await Promise.all([registerProgressionQualification(f.directory,f.options),registerProgressionQualification(f.directory,f.options)]);expect(JSON.parse(readFileSync(join(f.practice,'progression-system/qualifications.json'),'utf8')).proofs).toHaveLength(1);
  const old=readFileSync(join(f.folder,'proof.json'));f.proof.supportedMethods[0]!.bands[0]!.levels.Prayer={min:95,max:95};f.save();await registerProgressionQualification(f.directory,f.options);expect(progressionProofs(f.base)['ranged/troopers']!.bands).toHaveLength(2);expect(old.equals(readFileSync(join(f.folder,'proof.json')))).toBe(false);
 }finally{f.cleanup();}
});
test('failed, diagnostic, incomplete and wrong-source native records publish no index',async()=>{
 const changes:((f:ReturnType<typeof fixture>)=>unknown)[]=[f=>f.report.ok=false,f=>f.report.diagnostic={complete:true},f=>f.report.checks.pop(),f=>f.report.checks[1].exitCode=1,f=>f.report.source='d'.repeat(64),f=>f.report.runtimeRevision='d'.repeat(64),f=>f.report.files[0].sha256='d'.repeat(64),f=>f.report.checks[1].timedOut='false'];
 for(const mutate of changes){const f=fixture();try{mutate(f);f.save();await expect(registerProgressionQualification(f.directory,f.options)).rejects.toThrow();expect(existsSync(join(f.practice,'progression-system/qualifications.json'))).toBe(false);}finally{f.cleanup();}}
});
test('wrong proof source, altered entry, broadened state bands and rejected raw saves publish nothing',async()=>{
 for(const change of ['source','entry','bands','saves','consumer','flags']as const){const f=fixture();try{if(change==='source'){f.proof.source='d'.repeat(64);f.save();}if(change==='entry')writeFileSync(join(f.folder,'entry.json'),'changed');if(change==='bands'||change==='saves')f.options.verifyProof=()=>({checks:{entry:true,stateBands:change!=='bands',rawSaves:change!=='saves'}});if(change==='consumer')writeFileSync(join(f.directory,'2.out.log'),'RANGED_SAVED_PROOF {"ok":false}');if(change==='flags'){(f.proof as any).checks={source:true};f.save();}await expect(registerProgressionQualification(f.directory,f.options)).rejects.toThrow();expect(existsSync(join(f.practice,'progression-system/qualifications.json'))).toBe(false);}finally{f.cleanup();}}
});
test('an unrelated native capability is unchanged and corrupt existing index is preserved',async()=>{
 const f=fixture();try{expect((await registerProgressionQualification(f.directory,{...f.options,task:{...f.task,id:'other'}})).registered).toBe(0);const index=join(f.practice,'progression-system/qualifications.json');mkdirSync(join(f.practice,'progression-system'),{recursive:true});writeFileSync(index,'broken');await expect(registerProgressionQualification(f.directory,f.options)).rejects.toThrow();expect(readFileSync(index,'utf8')).toBe('broken');}finally{f.cleanup();}
});
test('an additional saved native state band binds to the same complete qualified source without claiming its report pointed there',async()=>{
 const f=fixture(95);try{
  const folder=join(f.practice,'progression-ranged','additional');mkdirSync(folder,{recursive:true});const proof=structuredClone(f.proof);proof.at=300;proof.supportedMethods[0]!.bands[0]!.levels.Prayer={min:96,max:96};
  writeFileSync(join(folder,'proof.json'),JSON.stringify(proof));writeFileSync(join(folder,'entry.json'),'frozen entry');writeFileSync(join(folder,'before.sav'),'unit native save before');writeFileSync(join(folder,'after.sav'),'unit native save after');writeFileSync(join(folder,'worker.log'),'RANGED_TRAIN_RESULT '+JSON.stringify(proof.result)+'\nLOGOUT logged-out\n');
  const registration=await registerProgressionQualification(f.directory,{...f.options,additionalProof:{directory:folder}});expect(registration.registered).toBe(1);expect(f.verified()).toBe(2);
  const methods=progressionProofs(f.base)['ranged/troopers']!;expect(methods.bands[0]!.levels.Prayer).toEqual({min:96,max:96});
 }finally{f.cleanup();}
});
test('source, frozen input or raw saves changed during verification cannot cross the publication boundary',async()=>{
 for(const changed of ['source','runtime','entry','save']as const){const f=fixture();try{
  let calls=0;if(changed==='source')f.options.fingerprint=()=>++calls===1?source:'d'.repeat(64);if(changed==='runtime')f.options.runtimeRevision=()=>++calls===1?runtime:'d'.repeat(64);
  if(changed==='entry'||changed==='save')f.options.verifyProof=()=>{writeFileSync(join(f.folder,changed==='entry'?'entry.json':'after.sav'),'changed during validation');return{checks:{verified:true}};};
  await expect(registerProgressionQualification(f.directory,f.options)).rejects.toThrow();expect(existsSync(join(f.practice,'progression-system/qualifications.json'))).toBe(false);
 }finally{f.cleanup();}}
});
test('a short native run cannot register99 or bind an additional band from another worker runtime',async()=>{
 const f=fixture();try{f.proof.target=99;f.save();await expect(registerProgressionQualification(f.directory,f.options)).rejects.toThrow();expect(existsSync(join(f.practice,'progression-system/qualifications.json'))).toBe(false);}finally{f.cleanup();}
 const other=fixture();try{const folder=join(other.practice,'progression-ranged','wrong-source');mkdirSync(folder,{recursive:true});const p={...other.proof,source:'d'.repeat(64)};writeFileSync(join(folder,'proof.json'),JSON.stringify(p));await expect(registerProgressionQualification(other.directory,{...other.options,additionalProof:{directory:folder}})).rejects.toThrow();expect(existsSync(join(other.practice,'progression-system/qualifications.json'))).toBe(false);}finally{other.cleanup();}
});
test('hosted paths rebind within one selected artifact practice root and path traversal is refused',async()=>{
 const f=fixture();try{
  const remote='/home/runner/work/repo/repo/.practice',map=(p:string)=>p.replace(f.practice,remote).replaceAll('\\','/');f.report.directory=map(f.directory);for(const row of f.report.checks){const d=JSON.parse(row.detail);row.detail=JSON.stringify({stdout:map(d.stdout),stderr:map(d.stderr)});}f.save();
  writeFileSync(join(f.directory,'ranged-adaptive-proof.json'),JSON.stringify({folder:map(f.folder)}));writeFileSync(join(f.directory,'2.out.log'),'RANGED_SAVED_PROOF '+JSON.stringify({ok:true,checks:{fresh:true,source:true,proofSource:true,entryHash:true},evidence:map(f.folder)}));
  expect((await registerProgressionQualification(f.directory,{...f.options,practiceRoot:f.practice})).registered).toBe(1);
  writeFileSync(join(f.directory,'ranged-adaptive-proof.json'),JSON.stringify({folder:remote+'/../outside'}));await expect(registerProgressionQualification(f.directory,f.options)).rejects.toThrow();
 }finally{f.cleanup();}
});
test('complete native acceptance logs stay immutable and a changed saved-verifier log cannot publish',async()=>{
 const f=fixture();try{await registerProgressionQualification(f.directory,f.options);const index=JSON.parse(readFileSync(join(f.practice,'progression-system/qualifications.json'),'utf8')),bundle=dirname(index.proofs[0].path);
  for(let i=0;i<f.task.checks.length;i++)for(const kind of ['out','err'])expect(readFileSync(join(bundle,'checks',i+'.'+kind+'.log')).equals(readFileSync(join(f.directory,i+'.'+kind+'.log')))).toBe(true);
 }finally{f.cleanup();}
 const changed=fixture();try{changed.options.verifyProof=()=>{writeFileSync(join(changed.directory,'2.out.log'),'changed after native acceptance');return{checks:{verified:true}};};await expect(registerProgressionQualification(changed.directory,changed.options)).rejects.toThrow();expect(existsSync(join(changed.practice,'progression-system/qualifications.json'))).toBe(false);}finally{changed.cleanup();}
});
test('each fixed native artifact is bounded before verification or publication',async()=>{
 const MiB=1024*1024;
 for(const[name,limit,place]of [
  ['report.json',MiB,'delivery'],['task.json',MiB,'delivery'],['ranged-adaptive-proof.json',4096,'delivery'],
  ['proof.json',MiB,'method'],['entry.json',MiB,'method'],['before.sav',4*MiB,'method'],['after.sav',4*MiB,'method'],
  ['worker.log',16*MiB,'method'],['0.out.log',16*MiB,'delivery'],['2.out.log',16*MiB,'delivery'],['0.err.log',16*MiB,'delivery'],
 ]as const){
  const f=fixture();try{
   const file=join(place==='delivery'?f.directory:f.folder,name),original=readFileSync(file),oversized=Buffer.concat([original,Buffer.alloc(limit+1-original.length,32)]);
   writeFileSync(file,oversized);
   if(name==='entry.json'){f.proof.entrySha256=hash(oversized);writeFileSync(join(f.folder,'proof.json'),JSON.stringify(f.proof));}
   await expect(registerProgressionQualification(f.directory,f.options)).rejects.toThrow(/artifact.*(limit|bounded)/);
   expect(existsSync(join(f.practice,'progression-system/qualifications.json'))).toBe(false);
  }finally{f.cleanup();}
 }
},30000);
test('a fixed artifact symlink cannot leave its declared folder even within the selected practice root',async()=>{
 for(const[name,place]of [['report.json','delivery'],['entry.json','method'],['worker.log','method'],['before.sav','method']]as const){
  const f=fixture();try{
   const file=join(place==='delivery'?f.directory:f.folder,name),other=join(f.practice,'other');mkdirSync(other);
   const target=join(other,name);writeFileSync(target,readFileSync(file));rmSync(file);symlinkSync(target,file,'file');
   await expect(registerProgressionQualification(f.directory,f.options)).rejects.toThrow(/artifact.*(folder|root)/);
   expect(existsSync(join(f.practice,'progression-system/qualifications.json'))).toBe(false);
  }finally{f.cleanup();}
 }
});
test('an artifact directory is rejected as data before the verifier can run',async()=>{
 const f=fixture();try{
  const file=join(f.folder,'before.sav');rmSync(file);mkdirSync(file);
  await expect(registerProgressionQualification(f.directory,f.options)).rejects.toThrow(/artifact.*regular file/);
  expect(f.verified()).toBe(0);
 }finally{f.cleanup();}
});

test.skipIf(process.platform==='win32')('a FIFO artifact is rejected without waiting for a writer',async()=>{
 const f=fixture();try{
  const file=join(f.folder,'before.sav');rmSync(file);
  expect(Bun.spawnSync(['mkfifo',file],{stdout:'pipe',stderr:'pipe'}).exitCode).toBe(0);
  const code=`import {readFileSync} from 'node:fs';import {registerProgressionQualification} from ${JSON.stringify(join(import.meta.dir,'../src/progression-qualification.ts'))};
   try{await registerProgressionQualification(process.argv[1],{base:process.argv[2],task:JSON.parse(readFileSync(process.argv[1]+'/task.json','utf8')),fingerprint:()=>${JSON.stringify(source)},runtimeRevision:()=>${JSON.stringify(runtime)},verifyProof:()=>({checks:{accepted:true}})});process.exitCode=2;}catch(error){console.error(String(error));process.exitCode=1;}`;
  const child=Bun.spawn([process.execPath,'-e',code,f.directory,f.base],{stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill('SIGKILL'),1500);
  try{
   const [exit,error]=await Promise.all([child.exited,new Response(child.stderr).text()]);
   expect(exit).toBe(1);expect(error).toMatch(/artifact is not a regular file/);
   expect(existsSync(join(f.practice,'progression-system/qualifications.json'))).toBe(false);
  }finally{clearTimeout(timer);}
 }finally{f.cleanup();}
});
test('the output system cannot follow a junction outside the actual base practice directory',async()=>{
 const f=fixture();try{
  const outside=join(f.base,'outside');mkdirSync(outside);symlinkSync(outside,join(f.practice,'progression-system'),'junction');
  await expect(registerProgressionQualification(f.directory,f.options)).rejects.toThrow(/output.*practice root/);
  expect(readdirSync(outside)).toEqual([]);
 }finally{f.cleanup();}
});
test('immutable destination ancestry is checked under the write lock and retains the index on escape',async()=>{
 const f=fixture();try{
  const system=join(f.practice,'progression-system'),outside=join(f.base,'outside'),index=join(system,'qualifications.json');mkdirSync(system);mkdirSync(outside);writeFileSync(index,'{"proofs":[],"keep":true}');
  let calls=0;f.options.fingerprint=()=>{
   if(++calls===2){const proofs=join(system,'proofs');mkdirSync(proofs);symlinkSync(outside,join(proofs,hash(readFileSync(join(f.folder,'proof.json')))),'junction');}
   return source;
  };
  await expect(registerProgressionQualification(f.directory,f.options)).rejects.toThrow(/output.*practice root/);
  expect(readFileSync(index,'utf8')).toBe('{"proofs":[],"keep":true}');expect(readdirSync(outside)).toEqual([]);
 }finally{f.cleanup();}
});
test('escaped immutable files and atomic index temporary files cannot redirect output writes',async()=>{
 for(const kind of ['proof','temporary']as const){const f=fixture();try{
  const system=join(f.practice,'progression-system'),outside=join(f.base,'outside'),index=join(system,'qualifications.json');mkdirSync(system);mkdirSync(outside);writeFileSync(index,'{"proofs":[],"keep":true}');
  const raw=readFileSync(join(f.folder,'proof.json')),target=join(outside,'sentinel');writeFileSync(target,kind==='proof'?raw:'retained outside');
  const bundle=join(system,'proofs',hash(raw));mkdirSync(bundle,{recursive:true});symlinkSync(target,kind==='proof'?join(bundle,'proof.json'):index+'.tmp-'+process.pid,'file');
  await expect(registerProgressionQualification(f.directory,f.options)).rejects.toThrow(/output.*practice root/);
  expect(readFileSync(index,'utf8')).toBe('{"proofs":[],"keep":true}');expect(readFileSync(target).equals(kind==='proof'?raw:Buffer.from('retained outside'))).toBe(true);
 }finally{f.cleanup();}}
});
test('a relocated artifact root stays valid while publication remains in the actual base practice root',async()=>{
 const f=fixture();try{
  const downloaded=join(f.base,'downloaded');cpSync(f.practice,downloaded,{recursive:true});
  const directory=join(downloaded,'deliveries','ranged-train-fixture');
  expect((await registerProgressionQualification(directory,{...f.options,practiceRoot:downloaded})).registered).toBe(1);
  expect(existsSync(join(f.practice,'progression-system/qualifications.json'))).toBe(true);
  expect(existsSync(join(downloaded,'progression-system'))).toBe(false);
 }finally{f.cleanup();}
});
