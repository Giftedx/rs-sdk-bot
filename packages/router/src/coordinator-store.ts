import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync,copyFileSync,linkSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {openSync,closeSync} from 'node:fs';
import {initialState,GOALS,validateTask,type CoordinatorState} from './coordinator';

export const projectRoot=resolve(import.meta.dir,'../../..');
export const coordinationDir=join(projectRoot,'.practice/coordinator');
export {withPlanWrite,recoverPlanWrite} from '../../core/src/plan-lock';
export function spawnDetached(args:string[],cwd:string,stdout:string,stderr:string,env:NodeJS.ProcessEnv=process.env){
 const out=openSync(stdout,'w'),err=openSync(stderr,'w');
 try{const child=spawn(args[0]!,args.slice(1),{cwd,env,detached:true,windowsHide:true,stdio:['ignore',out,err]});child.unref();if(!child.pid)throw Error('detached child did not start');return child.pid;}
 finally{closeSync(out);closeSync(err);}
}
// On Windows a reader that holds the target open (jq, an editor, the dashboard) makes the rename fail for a moment.
export function atomicJson(file:string,value:unknown,rename:(from:string,to:string)=>void=renameSync){
 atomicText(file,JSON.stringify(value,null,2),rename);
}
export function atomicText(file:string,text:string,rename:(from:string,to:string)=>void=renameSync){
 const temporary=file+`.tmp-${process.pid}`;writeFileSync(temporary,text);
 for(let attempt=0;;attempt++){
  try{rename(temporary,file);return;}
  catch(e){if(attempt>=20||!['EPERM','EBUSY','EACCES'].includes((e as NodeJS.ErrnoException).code??''))throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);}
 }
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
// The bytes this process last wrote per file. An unchanged state (the common idle loop) writes nothing: the file
// is several MB and would otherwise be rewritten, with its .previous copy, on every loop.
const savedBytes=new Map<string,string>();
export function saveState(state:CoordinatorState,directory=coordinationDir):boolean{
 const file=join(directory,'state.json'),bytes=JSON.stringify(state,null,2);
 if(savedBytes.get(file)===bytes&&existsSync(file))return false;
 if(existsSync(file))copyFileSync(file,file+'.previous');atomicText(file,bytes);savedBytes.set(file,bytes);return true;
}
/** Hash of a capability's owned files: the source a review verdict names. */
export function capabilitySource(files:readonly string[],root=projectRoot){
 return createHash('sha256').update(JSON.stringify(files.map(file=>[file,readFileSync(join(root,file),'utf8')]))).digest('hex');
}
export function runDirectory(runId:string,directory=coordinationDir){
 if(!/^[-a-z0-9]+$/.test(runId))throw Error('invalid run identity');const path=join(directory,'runs',runId);mkdirSync(path,{recursive:true});return path;
}
export function event(kind:string,detail:unknown,directory=coordinationDir){
 const line=JSON.stringify({at:Date.now(),kind,detail});
 const fs=require('node:fs') as typeof import('node:fs');fs.appendFileSync(join(directory,'events.jsonl'),line+'\n');
 console.log(line);
}
