import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync,copyFileSync,linkSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {openSync,closeSync} from 'node:fs';
import {initialState,GOALS,validateTask,type CoordinatorState} from './coordinator';

export const projectRoot=resolve(import.meta.dir,'../../..');
export const coordinationDir=join(projectRoot,'.practice/coordinator');
/** Serialize account-plan writes across independently running live jobs. */
export async function withPlanWrite<T>(action:()=>T|Promise<T>,directory=coordinationDir,timeoutMs=15000):Promise<T>{
 mkdirSync(directory,{recursive:true});const file=join(directory,'plan-write-lock.json'),nonce=randomUUID(),deadline=Date.now()+timeoutMs;
 const intent=join(directory,`plan-write-${nonce}.intent.json`);let acquired=false;
 // Publish complete ownership atomically: a killed writer cannot leave an empty
 // lock whose owner the dispatcher cannot identify.
 writeFileSync(intent,JSON.stringify({pid:process.pid,nonce,at:Date.now()}),{flag:'wx'});
 try{
  for(;;){
   try{linkSync(intent,file);acquired=true;break;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(Date.now()>=deadline)throw Error('account plan writer waits for its existing owner');await Bun.sleep(25);}
  }
  return await action();
 }finally{
  try{if(acquired){const owner=JSON.parse(readFileSync(file,'utf8'));if(owner.pid!==process.pid||owner.nonce!==nonce)throw Error('account plan write ownership changed');unlinkSync(file);}}
  finally{unlinkSync(intent);}
 }
}
/** Only the single dispatcher recovers abandoned write leases; workers wait. */
export function recoverPlanWrite(directory=coordinationDir,alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=='ESRCH';}}){
 const file=join(directory,'plan-write-lock.json');if(!existsSync(file))return false;
 let owner:any;try{owner=JSON.parse(readFileSync(file,'utf8'));}catch{return false;}
 if(!Number.isSafeInteger(owner.pid)||owner.pid<1||alive(owner.pid))return false;
 const archive=join(directory,'plan-lock-recovery');mkdirSync(archive,{recursive:true});renameSync(file,join(archive,`${Date.now()}-${randomUUID()}.json`));if(typeof owner.nonce==='string'&&/^[a-f0-9-]{36}$/.test(owner.nonce)){const intent=join(directory,`plan-write-${owner.nonce}.intent.json`);if(existsSync(intent))unlinkSync(intent);}return true;
}
export function spawnDetached(args:string[],cwd:string,stdout:string,stderr:string,env:NodeJS.ProcessEnv=process.env){
 const out=openSync(stdout,'w'),err=openSync(stderr,'w');
 try{const child=spawn(args[0]!,args.slice(1),{cwd,env,detached:true,windowsHide:true,stdio:['ignore',out,err]});child.unref();if(!child.pid)throw Error('detached child did not start');return child.pid;}
 finally{closeSync(out);closeSync(err);}
}
export function atomicJson(file:string,value:unknown){
 const temporary=file+`.tmp-${process.pid}`;writeFileSync(temporary,JSON.stringify(value,null,2));renameSync(temporary,file);
}
export function loadState(directory=coordinationDir):CoordinatorState{
 mkdirSync(join(directory,'runs'),{recursive:true});const file=join(directory,'state.json');
 if(!existsSync(file))return initialState();
 const state=JSON.parse(readFileSync(file,'utf8')) as CoordinatorState;
 if(state.version!==1||!Array.isArray(state.tasks)||!Array.isArray(state.goals)
  ||state.goals.length!==GOALS.length||!GOALS.every(id=>state.goals.some(g=>g.id===id)))throw Error('unsupported coordinator state; preserve and repair it');
 for(const record of state.tasks){validateTask(record.spec);if(!['pending','running','succeeded','failed','superseded'].includes(record.status))throw Error('invalid task state');}
 return state;
}
export function saveState(state:CoordinatorState,directory=coordinationDir){
 const file=join(directory,'state.json');if(existsSync(file))copyFileSync(file,file+'.previous');atomicJson(file,state);
}
export function runDirectory(runId:string,directory=coordinationDir){
 if(!/^[-a-z0-9]+$/.test(runId))throw Error('invalid run identity');const path=join(directory,'runs',runId);mkdirSync(path,{recursive:true});return path;
}
export function event(kind:string,detail:unknown,directory=coordinationDir){
 const line=JSON.stringify({at:Date.now(),kind,detail});
 const fs=require('node:fs') as typeof import('node:fs');fs.appendFileSync(join(directory,'events.jsonl'),line+'\n');
 console.log(line);
}
