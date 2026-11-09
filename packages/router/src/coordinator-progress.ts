// Side evidence for fleet-sync; observes existing owners without assigning, restarting or stopping workers.
// Usage: FLEET_SIDE=local bun packages/router/src/coordinator-progress.ts [--daemon] [--interval-ms=30000]
import {existsSync,mkdirSync,readFileSync,statSync,writeFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {deadRoots,provisionRefs,usefulLiveReceipt,type CoordinatorState,type TaskRecord} from './coordinator';
import {atomicJson} from './coordinator-store';
import {FLEET_DIR,mySide} from '../../core/src/fleet';
import {cachedLaunchRevision} from '../../core/src/worker-release';

type Model='claude'|'codex'|'unassigned';
export type ProcessObservation='alive'|'dead'|'unknown';
type Input<T>={value:T|null;observedAt:number|null;error?:'missing'|'unreadable'};
type Swarm={at?:number;controllerPid?:number;coordinatorOwner?:string;release?:string;running?:number;jobs?:{account?:string;script?:string;state?:string}[]};
type ControllerLease={pid?:number;nonce?:string;source?:string;at?:number};
export const STALE_MS=120000;
const validTime=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const model=(t:TaskRecord):Model=>t.agent==='claude'||t.agent==='codex'?t.agent:t.spec.agent==='claude'||t.spec.agent==='codex'?t.spec.agent:'unassigned';
const matchedReceipt=(r:TaskRecord)=>r.receipt?.taskId===r.spec.id&&!!r.runId&&r.receipt?.runId===r.runId;
const task=(r:TaskRecord)=>({id:r.spec.id,kind:r.spec.kind,goal:r.spec.goal,capability:r.spec.capability??null,runId:r.runId??null,startedAt:validTime(r.startedAt)?r.startedAt:null});
function freshness<T>(input:Input<T>,now:number){
 const ageMs=validTime(input.observedAt)?now-input.observedAt:null;
 return{observedAt:input.observedAt,ageMs,stale:ageMs===null||ageMs<0||ageMs>STALE_MS,error:input.error??null};
}
export function observeProcess(pid:unknown):ProcessObservation{
 if(!Number.isSafeInteger(pid)||(pid as number)<1)return'unknown';
 try{process.kill(pid as number,0);return'alive';}catch(e){return(e as NodeJS.ErrnoException).code==='ESRCH'?'dead':'unknown';}
}
const releaseHash=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)?value:null;
function controllerRelease(swarm:Swarm|null,lease:ControllerLease|null|undefined,disk:unknown,stale:boolean){
 const reported=releaseHash(swarm?.release),onDisk=releaseHash(disk);
 let state:'unknown'|'lease-mismatch'|'matches-disk'|'disk-drift'='unknown';
 if(!stale&&reported&&lease&&releaseHash(lease.source)&&typeof lease.pid==='number'&&Number.isSafeInteger(lease.pid)&&lease.pid>0&&typeof lease.nonce==='string'&&lease.nonce
  &&validTime(lease.at)&&validTime(swarm?.at)&&swarm.at>lease.at){
  if(swarm.controllerPid!==lease.pid||swarm.coordinatorOwner!==lease.nonce||reported!==lease.source)state='lease-mismatch';
  else if(onDisk)state=reported===onDisk?'matches-disk':'disk-drift';
 }
 return{state,reported,onDisk};
}
export function summarizeProgress(input:{side:string;now:number;state:Input<CoordinatorState>;swarm:Input<Swarm>;owner:Input<{pid?:number;at?:number}>;paused:boolean;process?:(pid:unknown)=>ProcessObservation;controllerLease?:ControllerLease|null;launchSource?:string}){
 const probe=input.process??observeProcess,records=input.state.value?.tasks??[],byId=new Map(records.map(r=>[r.spec.id,r]));
 const terminal=input.state.value?deadRoots(input.state.value,byId):null;
 const stateFreshness=freshness(input.state,input.now),swarmFreshness=freshness(input.swarm,input.now);
 const workers=Object.fromEntries((['claude','codex','unassigned'] as const).map(agent=>{
  const mine=records.filter(r=>model(r)===agent);
  const running=mine.filter(r=>r.status==='running').map(r=>{
   const processState=probe(r.pid);
   return{...task(r),recordStatus:r.status,pid:r.pid??null,processState,processIdentity:'unverified',observationStale:stateFreshness.stale,
    blocker:processState==='dead'?'recorded worker PID is gone':processState==='unknown'?'worker process state is unknown':null};
  });
  const pending=mine.filter(r=>r.status==='pending').map(r=>{
   const dependencies=[...new Set([...r.spec.dependsOn,...provisionRefs(r.spec)])]
    .filter(id=>byId.get(id)?.status!=='succeeded').map(id=>({id,status:byId.get(id)?.status??'missing'}));
   const root=terminal?.get(r.spec.id)?.root;
   return{...task(r),status:dependencies.length?'waiting-dependencies':'queued',dependencies,
    terminalBlocker:root?{id:root,status:byId.get(root)?.status??'missing'}:null};
  });
  const useful=mine.filter(r=>usefulLiveReceipt(r,input.now))
   .sort((a,b)=>b.receipt!.at-a.receipt!.at)[0];
  const recovery=mine.filter(r=>r.spec.sessionRecovery&&r.status==='succeeded'&&matchedReceipt(r)&&r.receipt?.ok===true&&r.receipt.output?.ok===true&&r.receipt.output?.evidence==='live'&&validTime(r.receipt.at)&&r.receipt.at<=input.now).sort((a,b)=>b.receipt!.at-a.receipt!.at)[0];
  const preparation=mine.filter(r=>r.status==='succeeded'&&r.spec.kind!=='run'&&matchedReceipt(r)&&r.receipt?.ok===true&&validTime(r.receipt.at)&&r.receipt.at<=input.now).sort((a,b)=>b.receipt!.at-a.receipt!.at)[0];
  const failed=mine.filter(r=>r.status==='failed').map(r=>({...task(r),at:r.receipt?.at??null,blocker:'task failed; inspect the preserved local receipt'}));
  return[agent,{running,pending,failed,lastUsefulLive:useful?{...task(useful),at:useful.receipt!.at,evidence:'live'}:null,
   lastRecovery:recovery?{...task(recovery),at:recovery.receipt!.at,evidence:'live-session-recovery'}:null,
   lastPreparation:preparation?{...task(preparation),at:preparation.receipt!.at,evidence:preparation.spec.kind}:null}];
 }));
 const ownerPid=input.owner.value?.pid;
 return{schema:'coordinator-progress/1',side:input.side,exportedAt:input.now,
  sources:{state:stateFreshness,swarm:swarmFreshness,owner:freshness(input.owner,input.now)},
  coordinator:{paused:input.paused,pid:ownerPid??null,processState:probe(ownerPid),processIdentity:'unverified',
   planner:input.state.value?.planner?{runId:input.state.value.planner.runId,agent:input.state.value.planner.agent??'unassigned',startedAt:input.state.value.planner.startedAt,processState:probe(input.state.value.planner.pid)}:null},
  workers,swarm:{controllerPid:input.swarm.value?.controllerPid??null,processState:probe(input.swarm.value?.controllerPid),
   reportedRunning:input.swarm.value?.running??null,observationStale:swarmFreshness.stale,
   release:controllerRelease(input.swarm.value,input.controllerLease,input.launchSource,swarmFreshness.stale),
   jobs:(input.swarm.value?.jobs??[]).filter(j=>!/haggis/i.test(j.account??'')).map(j=>({account:j.account??null,script:j.script??null,state:j.state??'unknown'}))},
  limits:['PID existence does not establish process identity or useful output.','Source freshness is separate from export freshness.','Only succeeded live gameplay run receipts count as useful live coordinator results; session recovery is separate.','Model attribution covers coordinator tasks; swarm gameplay is reported separately.','Archived coordinator task history is not included.']};
}
function readInput<T>(file:string):Input<T>{
 try{return{value:JSON.parse(readFileSync(file,'utf8')),observedAt:statSync(file).mtimeMs};}
 catch(e){return{value:null,observedAt:null,error:(e as NodeJS.ErrnoException).code==='ENOENT'?'missing':'unreadable'};}
}
export function exportProgress(root=resolve(import.meta.dir,'../../..'),fleet=FLEET_DIR(),side=mySide(),now=Date.now()){
 const state=readInput<CoordinatorState>(join(root,'.practice/coordinator/state.json'));
 if(!state.error&&(!state.value||!Array.isArray(state.value.tasks)||state.value.version!==1||state.value.tasks.some(r=>!r||!r.spec
  ||typeof r.spec.id!=='string'||!Array.isArray(r.spec.dependsOn)||r.spec.dependsOn.some(id=>typeof id!=='string')
  ||r.spec.accountFrom!==undefined&&typeof r.spec.accountFrom!=='string'
  ||r.spec.participants!==undefined&&(!Array.isArray(r.spec.participants)||r.spec.participants.some(name=>typeof name!=='string'))))){
  Object.assign(state,{value:null,error:'unreadable',observedAt:null});
 }
 const swarm=readInput<Swarm>(join(root,'.practice/swarm-state.json'));
 if(!swarm.error&&(!swarm.value||!Array.isArray(swarm.value.jobs)||!validTime(swarm.value.at)||swarm.value.jobs.some(j=>!j||typeof j!=='object')))Object.assign(swarm,{value:null,error:'unreadable',observedAt:null});
 // A copied or unchanged file cannot refresh the controller's own heartbeat.
 if(swarm.value)swarm.observedAt=swarm.value.at!;
 const controllerLease=readInput<ControllerLease>(join(root,'.practice/coordinator/swarm-owner.json')).value;
 let launchSource:string|undefined;
 if(releaseHash(swarm.value?.release)&&!freshness(swarm,now).stale)try{launchSource=cachedLaunchRevision(root);}catch{/* incomplete checkout leaves the comparison unknown */}
 const report=summarizeProgress({side,now,state,swarm,controllerLease,launchSource,owner:readInput(join(root,'.practice/coordinator/owner.json')),paused:existsSync(join(root,'.practice/stop-coordinator'))||existsSync(join(root,'.practice/stop-swarm'))});
 const dir=join(fleet,'evidence');mkdirSync(dir,{recursive:true});const file=join(dir,`${side}-coordinator.json`);atomicJson(file,report);return{file,report};
}
export function acquireExporterLock(file:string){
 mkdirSync(resolve(file,'..'),{recursive:true});const nonce=randomUUID(),body=JSON.stringify({pid:process.pid,nonce});
 let fd:number;try{fd=openSync(file,'wx');}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('progress exporter lock exists; inspect its owner before removal');throw e;}
 try{writeFileSync(fd,body);}finally{closeSync(fd);}
 return()=>{try{if(readFileSync(file,'utf8')===body)unlinkSync(file);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}};
}
if(import.meta.main){
 const args=process.argv.slice(2),daemon=args.includes('--daemon'),interval=Number(args.find(a=>a.startsWith('--interval-ms='))?.split('=')[1]??30000);
 if(args.some(a=>a!=='--daemon'&&!a.startsWith('--interval-ms='))||!Number.isSafeInteger(interval)||interval<15000||interval>300000)throw Error('Use [--daemon] [--interval-ms=15000..300000]');
 const root=resolve(import.meta.dir,'../../..'),release=acquireExporterLock(join(root,'.practice/coordinator-progress.lock'));
 const done=()=>{release();process.exit(0);};process.on('SIGINT',done);process.on('SIGTERM',done);
 try{do{const result=exportProgress();console.log(`COORDINATOR_PROGRESS side=${result.report.side} file=${result.file}`);if(!daemon)break;await Bun.sleep(interval);}while(true);}finally{release();}
}
