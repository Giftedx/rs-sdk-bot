import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {freemem} from 'node:os';
import {join,resolve} from 'node:path';
import {FREE_FLOOR_GB} from '../../../core/src/memory';
import {killTree} from '../../../core/src/proc';
import {createBot} from '../bots';
import {readPracticeSave,waitPracticeSave} from '../fleet-player-save';
import {applyPreset,type SaveConfig} from '../presets';
import {runBotName} from '../prove';
import {
 agilityFixturePreset,ARDOUGNE_ENTRY_CONFIGURATION,type Child,CHILD_TIMEOUT_MS,type EvidenceHashes,
 FOOD_RECOVERY_CONFIGURATION,GNOME_FOOD_RESTART_CONFIGURATION,INFLIGHT_FOOD_CONFIGURATION,
 INITIALIZATION_CONFIGURATION,initializationBinding,type Mode,repoRoot,type Save,SAVE_WAIT_MS,sha256,
} from './contracts';
import {agilitySaveDifferences,initializationEvidenceChecks,retainedApproachChecks} from './save-checks';

export async function child(directory:string,label:string,name:string,course:string,target:number,interrupt=false,budget:{entryTicks?:number;maxTicks?:number;timeoutMs?:number}={}):Promise<Child>{
 if(freemem()/2**30<FREE_FLOOR_GB)throw Error('practice memory floor reached before child');
 const log=join(directory,label+'.log');writeFileSync(log,'');
 const proc=Bun.spawn(['bun','scripts/agility-order.ts',name,course,String(target)],{cwd:repoRoot,env:{...process.env,DEMO_OK:'',...INITIALIZATION_CONFIGURATION.env,AGI_MAX_TICKS:String(budget.maxTicks??2500),AGI_ENTRY_TICKS:String(budget.entryTicks??400)},stdout:Bun.file(log),stderr:Bun.file(join(directory,label+'.err')),windowsHide:true});
 let timedOut=false,interrupted=false,termination:Promise<void>|undefined;
 const timer=setTimeout(()=>{timedOut=true;termination=killTree(proc.pid);},budget.timeoutMs??CHILD_TIMEOUT_MS);
 const memory=setInterval(()=>{if(freemem()/2**30<FREE_FLOOR_GB&&!termination){timedOut=true;termination=killTree(proc.pid);}},1000);
 try{
  if(interrupt){const deadline=Date.now()+90000;while(proc.exitCode===null&&Date.now()<deadline){if(readFileSync(log,'utf8').includes('AGILITY_PROGRESS ')){interrupted=true;await killTree(proc.pid);break;}await Bun.sleep(50);}if(!interrupted)throw Error('could not interrupt an active order after progress');}
  const code=await proc.exited;return{code,timedOut,interrupted};
 }finally{clearTimeout(timer);clearInterval(memory);if(proc.exitCode===null)await killTree(proc.pid);await termination;}
}

export const caseHashes=(directory:string,label:string):EvidenceHashes=>{
 const h=(f:string)=>sha256(existsSync(join(directory,f))?readFileSync(join(directory,f)):'');
 return{before:h(`${label}-before.sav`),after:h(`${label}-after.sav`),log:h(`${label}.log`)};
};

export function foodChildBudget(started:number){
 const C=FOOD_RECOVERY_CONFIGURATION,remaining=Math.floor(C.deadlineMs-(performance.now()-started)-C.cleanupReserveMs-SAVE_WAIT_MS);
 if(remaining<1)throw Error('food recovery envelope exhausted; preserving cleanup reserve');
 return{timeoutMs:Math.min(CHILD_TIMEOUT_MS,remaining)};
}

export async function runCourseApproach(directory:string,source:unknown,retainedPath?:string){
 if(!retainedPath)throw Error('course approach requires an explicit retained save');
 const original=resolve(retainedPath),before=readPracticeSave(original),bytes=readFileSync(original);
 if(before.position.x!==2494||before.position.z!==3437||before.position.level!==0||before.skills[3]?.level!==10)
  throw Error('retained ordinary approach state required');
 const name=runBotName('agi',7),botDir=join(repoRoot,'vendor/rs-sdk/bots',name);
 const path=join(repoRoot,'vendor/rs-sdk/server/engine/data/players/main',name+'.sav');
 if(existsSync(botDir)||existsSync(path))throw Error('fresh diagnostic copy required');
 await createBot(name);
 if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local diagnostic required');
 // Copy exact bytes. No preset, supply seed, relocation or initialization run.
 writeFileSync(path,bytes,{flag:'wx'});copyFileSync(path,join(directory,'course-approach-before.sav'));
 const stamp=statSync(path).mtimeMs,logPath=join(directory,'course-approach.log');
 const record:any={at:Date.now(),source,name,original,originalSha256:createHash('sha256').update(bytes).digest('hex')};
 try{
  record.child=await child(directory,'course-approach',name,'gnome',10);
  const saved=await waitPracticeSave(path,s=>statSync(path).mtimeMs>stamp
   &&Object.values(retainedApproachChecks(before,s,10,readFileSync(logPath,'utf8'),record.child)).every(Boolean),{timeoutMs:15000});
  record.saveMatched=saved.matched;
 }finally{
  copyFileSync(path,join(directory,'course-approach-after.sav'));
  const after=readPracticeSave(path),log=existsSync(logPath)?readFileSync(logPath,'utf8'):'';
  record.checks={saveMatched:record.saveMatched===true,originalPreserved:readFileSync(original).equals(bytes),
   ...(record.child?retainedApproachChecks(before,after,10,log,record.child):{child:false})};
  record.differences=agilitySaveDifferences(before,after);
  record.walks=log.split(/\r?\n/).filter(l=>l.startsWith('AGILITY_ENTRY_WALK '));
  // Evidence fields for --verify-gnome. The gate's checks and meaning are unchanged.
  Object.assign(record,{label:'course-approach',fixture:null,course:'gnome',target:10,initialization:null,sha256:caseHashes(directory,'course-approach')});
  record.ok=Object.values(record.checks).every(Boolean);
  record.scope='Reduced retained-save course approach only. Does not replace Draynor or full delivery.';
  writeFileSync(join(directory,'course-approach.json'),JSON.stringify(record,null,2));
 }
 console.log(JSON.stringify({ok:record.ok,scope:record.scope,checks:record.checks}));return record;
}

export async function createAgilityFixture(directory:string,mode:Mode,source:unknown,started:number,index:number,preset:SaveConfig,
 assets:Pick<SaveConfig,'bank'|'equipment'>={bank:[{id:995,count:12345},{id:1511,count:13}],equipment:[{id:1351,count:1,slot:3}]},recoveryHp?:number){
 const name=runBotName('agi',index),botDir=join(repoRoot,'vendor/rs-sdk/bots',name);
 if(existsSync(botDir))throw Error('fresh fixture required');await createBot(name);
 if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
 const path=await applyPreset(name,agilityFixturePreset({...preset,...assets}));
 if(recoveryHp!==undefined){
  // Only this fresh, generated, offline recovery fixture gets depleted HP.
  // Leave trained XP, all other current skills and ordinary supplies untouched.
  const labelled=mode==='food-recovery'&&(index===10&&recoveryHp===FOOD_RECOVERY_CONFIGURATION.currentHp
   ||(INFLIGHT_FOOD_CONFIGURATION.fixtures as readonly number[]).includes(index)&&recoveryHp===INFLIGHT_FOOD_CONFIGURATION.currentHp)
   ||mode==='gnome-food'&&(index===FOOD_RECOVERY_CONFIGURATION.fixture||index===GNOME_FOOD_RESTART_CONFIGURATION.fixture)&&recoveryHp===FOOD_RECOVERY_CONFIGURATION.currentHp
   ||mode==='ardougne'&&index===ARDOUGNE_ENTRY_CONFIGURATION.fixture&&recoveryHp===ARDOUGNE_ENTRY_CONFIGURATION.currentHp;
  if(!labelled)throw Error('invalid recovery fixture');
  const saved=readPracticeSave(path),bytes=readFileSync(path);
  if(saved.version!==6||saved.skills[3]?.level!==(mode==='ardougne'?ARDOUGNE_ENTRY_CONFIGURATION.baseHp:70))throw Error('unexpected generated recovery save');
  bytes.writeUInt8(recoveryHp,32+3*5);bytes.writeUInt32BE(Bun.hash.crc32(bytes.subarray(0,-4))>>>0,bytes.length-4);
  writeFileSync(path,bytes);readPracticeSave(path);
 }
 // Capture source-backed login effects separately. The seeded typed-null subset
 // and special energy have ordinary values. Do not exempt mutations in training.
 copyFileSync(path,join(directory,`initial-${index}-before.sav`));
 const initial=readPracticeSave(path),stamp=statSync(path).mtimeMs;
 let init:Child|undefined,initialized:Awaited<ReturnType<typeof waitPracticeSave>>|undefined;
 let error:string|undefined,checks:Record<string,boolean>={};
 try{
  init=await child(directory,`initial-${index}`,name,INITIALIZATION_CONFIGURATION.course,INITIALIZATION_CONFIGURATION.target,false,
   mode==='food-recovery'||mode==='gnome-food'?foodChildBudget(started):{});
  initialized=await waitPracticeSave(path,s=>s.version>=9&&statSync(path).mtimeMs>stamp,{timeoutMs:SAVE_WAIT_MS});
 }catch(e){error=String(e);}finally{
  // Retain raw bytes even if CRC/decode or child checks fail. Never restore them.
  let saved:Save|undefined,captureError:string|undefined;
  try{copyFileSync(path,join(directory,`initial-${index}-after.sav`));saved=readPracticeSave(path);}catch(e){captureError=String(e);}
  const logPath=join(directory,`initial-${index}.log`);
  checks=saved&&init?initializationEvidenceChecks(initial,saved,existsSync(logPath)?readFileSync(logPath,'utf8'):'',init,name)
   :{saveMatched:false,readable:false};
  checks.saveMatched=checks.saveMatched&&initialized?.matched===true;
  let binding:ReturnType<typeof initializationBinding>|undefined;
  try{binding=initializationBinding(name,index,source,{
   before:sha256(readFileSync(join(directory,`initial-${index}-before.sav`))),
   after:sha256(readFileSync(join(directory,`initial-${index}-after.sav`))),log:sha256(readFileSync(logPath))});
  }catch(e){captureError??=String(e);checks.readable=false;}
  const report={name,index,child:init??null,checks,error,captureError,
   binding,
   differences:saved?agilitySaveDifferences(initial,saved):null};
  writeFileSync(join(directory,`initial-${index}.json`),JSON.stringify(report,null,2));
  console.log('AGILITY_INITIALIZATION_CHECK '+JSON.stringify(report));
 }
 if(error)throw Error('fixture initialization failed: '+error);
 if(!Object.values(checks).every(Boolean))throw Error('fixture initialization changed player assets, skills or position');
 return{name,path};
}
