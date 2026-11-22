import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {RECOVERY_SCRIPT,assertFleetResolved,verifyNativeRecoveryProof,type ControlledRecoveryRequest} from '../../../core/src/session-recovery-permit';
import {launchRevision} from '../../../core/src/worker-release';
import {admissionDecision,admitRecovery} from '../../../../scripts/swarm';

export const root=resolve(import.meta.dir,'../../../..'),engine=join(root,'vendor/rs-sdk/server/engine'),runner=join(root,RECOVERY_SCRIPT);
export const CONTROLLER_MARKER='packages/practice/src/session-recovery-proof.ts';
export const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex'),hash=(p:string)=>sha(readFileSync(p));

// The private world listens on 0.0.0.0 only (engine WebTransportServer.ts). On Windows 'localhost' tries ::1 first, where
// another process can accept and drop the connection, and canBind checks IPv4 only. Clients use the IPv4 address the world binds.
export const worldHost=(port:number)=>`127.0.0.1:${port}`;

// Native observation only: allow fixed local errors, never arbitrary exception text (which may contain secrets).
const RECOVERY_BOUNDARY_REASONS=new Set([
 'recovery account still active','recovery admission waiting: invalid','recovery admission waiting: maxBots','recovery admission waiting: memory',
 'no worker progress: release pin missing; live starts paused','no worker progress: release source changed; live starts paused',
 'no worker progress: linked release source unsupported',
 'native fixture boundary invalid','recovery controller owner changed','recovery source changed','recovery owner stopped',
 'recovery task authorization missing','recovery task owner changed','recovery request lease changed','recovery exact failure changed',
 'recovery assignment is active or reserved','recovery completed assignment is not ordinary retired work',
 'recovery completed account has an open hold','recovery completed mission unavailable','recovery completed work needs a different mission',
 'recovery account has an active external observation','recovery lifecycle ownership malformed','recovery orphan owner unknown',
 'recovery previous session owner still alive','recovery completed account already has producer history','recovery runner differs from permit',
 ...['missing','malformed','controller','future','stale','account-active'].map(r=>'recovery fleet ownership unresolved: '+r),
]);
export type RecoveryBoundary={phase:'admitRecovery'|'launchPermittedRecovery';at:number;outcome:'entered'|'returned'|'threw';reason:string|null;hostDeferred:boolean;inputs:unknown};
export function observeRecoveryBoundary<T>(phase:RecoveryBoundary['phase'],inputs:unknown,call:()=>T,record:(event:RecoveryBoundary)=>void):T{
 const emit=(outcome:RecoveryBoundary['outcome'],reason:string|null)=>{
  try{record({phase,at:Date.now(),outcome,reason,hostDeferred:phase==='admitRecovery'&&reason==='recovery admission waiting: memory',inputs});}
  catch{/* An evidence writer cannot change admission, ownership, return values or the original exception. */}
 };
 emit('entered',null);
 let value:T;
 try{value=call();}catch(error){
  const message=error instanceof Error?error.message:'';
  const code=(error as NodeJS.ErrnoException|null)?.code;
  const reason=RECOVERY_BOUNDARY_REASONS.has(message)?message:
   ['ENOENT','EACCES','EPERM','EEXIST','ENOSPC'].includes(code??'')?'filesystem '+code:'unclassified boundary error';
  emit('threw',reason);throw error;
 }
 emit('returned',null);return value;
}

// Dispatch refuses a request once and never retries it, and other builds can lower free memory during the proof.
// The proof waits for one admissible start before each request. One budget covers every wait: a proof takes 400-529 s
// of its 900 s check, and each fixture owner holds its session for 300 s.
export const RECOVERY_MEMORY_WAIT_MS=240000;
export function recoveryMemoryGate(budgetMs=RECOVERY_MEMORY_WAIT_MS,pollMs=1000){
 let left=budgetMs;
 return async(read:()=>Parameters<typeof admitRecovery>[0])=>{
  const from=Date.now();
  try{
   for(;;){
    const v=read(),d=admissionDecision({running:v.running,external:v.external,pending:v.pending,starting:1,startingReserve:1,freeGB:v.freeGB,minFreeGB:v.minFreeGB,maxBots:v.maxBots});
    if(d.reason!=='memory')return; // admitRecovery owns every other refusal.
    const remaining=left-(Date.now()-from);
    if(remaining<=0)throw Error(`native recovery memory wait expired: ${v.freeGB.toFixed(2)}GiB free, ${d.floorGB+d.reserveGB}GiB needed, ${budgetMs}ms budget used; no request submitted`);
    await Bun.sleep(Math.min(pollMs,remaining));
   }
  }finally{left=Math.max(0,left-(Date.now()-from));}
 };
}

// Samples of the actual private authority files, not substituted authority or credentials.
export function recoveryAuthorityInputs(base:string,r:ControlledRecoveryRequest){
 const read=(path:string):any=>{try{return JSON.parse(readFileSync(join(base,path),'utf8'));}catch{return null;}};
 const owner=read('.practice/coordinator/swarm-owner.json'),state=read('.practice/coordinator/state.json');
 const task=Array.isArray(state?.tasks)?state.tasks.find((t:any)=>t?.status==='running'&&t.runId===r.runId):null;
 const taskOwner=read('.practice/coordinator/runs/'+r.runId+'/owner.json'),lease=read('.practice/swarm-repair.json.lease');
 const fleet=read('.practice/swarm-state.json'),end=read('.practice/swarm-deaths.json')?.[r.account];
 return {sampledAt:Date.now(),request:{account:r.account,server:r.server,runId:r.runId,nonce:r.nonce,source:r.source,endedAt:r.endedAt},
  controller:owner?{pid:owner.pid,nonce:owner.nonce,source:owner.source}:null,processPid:process.pid,
  task:task?{pid:task.pid,runId:task.runId,status:task.status,kind:task.spec?.kind,account:task.spec?.account,
   sessionRecovery:task.spec?.sessionRecovery,repairs:task.spec?.repairs}:null,
  taskOwner:taskOwner?{pid:taskOwner.pid,runId:taskOwner.runId}:null,
  requestLease:lease?{pid:lease.pid,runId:lease.runId,nonce:lease.nonce}:null,
  fleet:fleet?{at:fleet.at,controllerPid:fleet.controllerPid}:null,end:end?{at:end.at,reason:end.reason}:null,
  releasePinMatches:process.env.WORKER_RELEASE===r.source};
}

export function recoveryCapability(id=process.env.DELIVERY_ID??'shark-supply-order'){
 if(!/^[a-z0-9-]+$/.test(id))throw Error('invalid recovery delivery capability');return id;
}
export function verifyCompletedRouterPins(base=root){
 const paths=['packages/router/src/coordinator-live.ts','packages/router/test/coordinator-recovery.test.ts'];
 return paths.map(path=>({path,sha256:hash(join(base,path))}));
}
export function verifyCompletedRecoveryDelivery(directory:string){
 const proof=JSON.parse(readFileSync(join(directory,'proof.json'),'utf8'));
 if(proof.capability!=='cow-progress-order'||!isDeepStrictEqual(proof.routerPins,verifyCompletedRouterPins()))throw Error('completed recovery delivery integration changed');
 verifyNativeRecoveryProof(proof,directory,{runtimeRevision:launchRevision(),runnerSha256:hash(runner)});
 return true;
}

export function evidenceFiles(directory:string,folder:string){
 const out:{path:string;sha256:string}[]=[];
 const walk=(dir:string)=>{for(const name of readdirSync(dir).sort()){const p=join(dir,name),info=lstatSync(p);if(info.isSymbolicLink())continue;if(info.isDirectory())walk(p);else out.push({path:relative(directory,p).replaceAll('\\','/'),sha256:hash(p)});}};
 walk(join(directory,folder));return out;
}
// Retain the complete first case before stopping. Its account lease is never released here.
export function retainRequiredRecoveryCase<T extends {id:string;ok:boolean;checks:Record<string,boolean>}>(row:T,retain:(row:T)=>void){
 retain(row);
 const reason=(row as {reason?:unknown}).reason;
 if(!row.ok)throw Error('native recovery required case failed: '+row.id+':'+Object.entries(row.checks).filter(([,ok])=>ok!==true).map(([key])=>key).join('/')+(typeof reason==='string'?' ('+reason+')':''));
 return row;
}
export function requireRecoveryRegistration(offlineConfirmed:boolean,registered:boolean){
 if(!offlineConfirmed||!registered)throw Error('native recovery authentication precondition failed: confirmed offline recovery and independent registration required');
}
export function recoveryArtifactPresence(paths:{used:string;output:string;completed:string}){
 return {nonceConsumed:existsSync(paths.used),receiptPresent:existsSync(join(paths.output,'receipt.json')),completedIndexed:existsSync(paths.completed)};
}
// Source decision: verified stat/read/unlink race -> native recovery stop fixtures -> retain evidence
// under retired identities instead of deleting -> adverse unit checks and both actual native refusals.
// Exclusive creation never adopts an existing stop. Node path operations cannot compare-and-delete
// atomically. Normal and final cleanup therefore make NO filesystem observation or mutation here.
export type OwnedStop={path:string;marker:string;ino:bigint;dev:bigint};
export function claimStopArtifact(path:string,marker:string):OwnedStop{
 try{writeFileSync(path,marker,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('stop path already exists');throw error;}
 const info=statSync(path,{bigint:true});return {path,marker,ino:info.ino,dev:info.dev};
}
export function releaseStopArtifact(_stop:OwnedStop):'retained'{
 return 'retained';
}
export function recoveryConsumptionBytes(path:string){
 try{return readFileSync(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
// The fixture controller's one-second timer can be starved by synchronous case setup. Each actual submit
// first republishes the fixture's own fleet view, then reads it back through the unchanged strict check.
// The verdict is evidence only: a refusal is retained, never replaced, so a pre-child boundary keeps its name.
export function fleetHandoff(publish:()=>void,path:string,account:string,controllerPid:number,clock:()=>number=Date.now){
 publish();
 let at:unknown=null;try{at=JSON.parse(readFileSync(path,'utf8'))?.at??null;}catch{/* assertFleetResolved names the fault */}
 const observedAt=clock();let verdict='resolved';
 try{assertFleetResolved(path,account,controllerPid,()=>observedAt);}catch(error){verdict=String((error as Error).message).replace(/^recovery fleet ownership unresolved: /,'')||'error';}
 return {at,observedAt,ageMs:typeof at==='number'?observedAt-at:null,verdict};
}
// The recovery child reads the fixture's control files from its own process at any moment. A direct overwrite
// truncates first, so the child can read an empty or partial fleet view ('fleet-malformed') and hold its lease.
// Publish a complete private file, then rename it over the old one. Windows can briefly refuse the rename while
// a reader has the target open; after the bounded retry the previous complete view stays and ages honestly.
export type ControlWriteOps={write:(path:string,data:string)=>void;rename:(from:string,to:string)=>void;pause:(ms:number)=>void};
const controlWriteOps:ControlWriteOps={write:(p,d)=>writeFileSync(p,d,{flag:'wx'}),rename:renameSync,pause:ms=>Bun.sleepSync(ms)};
export function publishControlFile(path:string,value:unknown,ops:ControlWriteOps=controlWriteOps){
 mkdirSync(dirname(path),{recursive:true});
 const temp=`${path}.${process.pid}.${randomUUID()}.tmp`;ops.write(temp,JSON.stringify(value,null,1));
 for(let attempt=1;;attempt++){
  try{ops.rename(temp,path);return;}
  catch(error){
   if(attempt>=20||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')){try{unlinkSync(temp);}catch{}throw error;}
   ops.pause(10);
  }
 }
}

// Dual-stack '::' where the host has IPv6; a container without it refuses that bind (EAFNOSUPPORT) and gets IPv4 loopback.
export function serveAnyHost<T>(options:Omit<Parameters<typeof Bun.serve<T>>[0],'hostname'>,serve:typeof Bun.serve=Bun.serve){
 try{return serve<T>({...options,hostname:'::'} as any);}
 catch(error){if((error as NodeJS.ErrnoException)?.code!=='EAFNOSUPPORT'&&!/EAFNOSUPPORT/.test(String(error)))throw error;return serve<T>({...options,hostname:'127.0.0.1'} as any);}
}
