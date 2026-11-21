import {existsSync,readFileSync,watch} from 'node:fs';
import {join} from 'node:path';
import {commandLine,processStartTimes} from '../../../core/src/proc';
import {swarmWroteStop} from '../../../../scripts/swarm';
import type {CoordinatorState} from '../coordinator';
import {coordinationDir,projectRoot} from '../coordinator-store';
import {assignedWorker,type ModelWorker} from '../model-worker';

export const COORDINATOR_CLI_PATH='packages/router/src/coordinator-cli.ts';
export const readJson=(file:string)=>JSON.parse(readFileSync(file,'utf8'));
export const existsPid=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};

// Only the installing controller clears a reusable system stop. Unknown text and
// unreadable files remain owner pauses, including lowercase paths on Linux.
export function coordinatorAccountPaused(account:string,base=projectRoot):boolean{
 for(const name of new Set([account,account.toLowerCase()])){
  try{if(!swarmWroteStop(readFileSync(join(base,'.practice','stop-'+name),'utf8')))return true;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return true;}
 }
 return false;
}

// Windows reuses a pid, so a running pid alone does not prove that the saved process is the one that runs. The planner
// starts as `coordinator-cli.ts --planner <runId>`, so its command line holds the run id. A command line that cannot be read
// proves nothing, and then a running pid counts.
export const plannerHolds=(pid:number,runId:string,read:(pid:number)=>string|null=commandLine,exists:(pid:number)=>boolean=existsPid):boolean=>{
 const line=read(pid);
 return line===null?exists(pid):line.includes(runId);
};

// A coordinator that started without a token has a random nonce that its command line does not hold. Its saved start
// time decides then: the coordinator process starts before it writes the claim, and a process that reused the pid
// starts after it.
export const OWNER_START_SLACK_MS=5000;
export const ownerHolds=(owner:{pid:number;nonce:string;at?:number},read:(pid:number)=>string|null=commandLine,exists:(pid:number)=>boolean=existsPid,
 starts:(pids:number[])=>Map<number,number>|null=processStartTimes):boolean=>{
 const line=read(owner.pid);
 if(line?.includes(owner.nonce))return true;
 if(!exists(owner.pid))return false;
 if(line===null||!Number.isFinite(owner.at))return true;
 const table=starts([owner.pid]);
 if(table===null)return true;
 const started=table.get(owner.pid);
 return started===undefined?false:started<=owner.at!+OWNER_START_SLACK_MS;
};

// A worker writes its owner file with its own pid and the time `at` right after it starts, so a process that started after
// `at` is not that worker. The check reads the process table once for the pid, so a worker that passed it is not checked
// again for WORKER_CHECK_MS. An unreadable table proves nothing, and then a running pid counts.
export const WORKER_CHECK_MS=60000,WORKER_START_SLACK_MS=5000;
const workerChecks=new Map<string,number>();
export const workerHolds=(pid:number,runId:string,at:number,starts:(pids:number[])=>Map<number,number>|null=processStartTimes,
 checks:Map<string,number>=workerChecks,now:number=Date.now()):boolean=>{
 const key=runId+'|'+pid,seen=checks.get(key);
 if(seen!==undefined&&now-seen<WORKER_CHECK_MS)return true;
 const table=starts([pid]);
 if(table===null)return true;
 const started=table.get(pid);
 if(started===undefined||started>at+WORKER_START_SLACK_MS){checks.delete(key);return false;}
 checks.set(key,now);
 return true;
};

// A run task with a repair is a recovery: it parks owner jobs and needs them until its install.
export const recoveryRuns=(state:Pick<CoordinatorState,'tasks'>)=>state.tasks.some(r=>r.status==='running'&&r.spec.kind==='run'&&(!!r.spec.repairs?.length||!!r.spec.sessionRecovery));

export function plannerPaused(base=projectRoot):boolean{return existsSync(join(base,'.practice','stop-planner'));}

export function plannerAgent(configured:readonly ModelWorker[]|undefined,records:readonly {status:string;agent?:ModelWorker;spec:{kind:string}}[]):ModelWorker|null{
 const allowed=(['codex','claude'] as const).filter(agent=>configured===undefined||configured.includes(agent));
 const preferred=assignedWorker('build',records.filter(r=>r.status==='running'&&r.spec.kind==='build'));
 return allowed.includes(preferred)?preferred:allowed[0]??null;
}

// One recursive watch is one OS handle on Windows: 16 ms CPU per 10 s over 2,447 run folders, against 63 ms for a
// watch per open folder. The folder count does not make it dearer.
export function waitForWork(timeoutMs=1000,directory=coordinationDir){
 return new Promise<void>(resolve=>{
  let watcher:ReturnType<typeof watch>|undefined;
  const done=()=>{clearTimeout(timer);watcher?.close();resolve();};const timer=setTimeout(done,timeoutMs);
  try{watcher=watch(directory,{recursive:true},(_,file)=>{if(/(?:receipt\.json|proposal\.json|planner-error\.json|\.request\.json|plan-request|restart)$/.test(String(file)))done();});}catch{/* bounded fallback also observes stop files */}
 });
}
