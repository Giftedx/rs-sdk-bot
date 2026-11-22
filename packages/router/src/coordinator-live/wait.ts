import {createHash} from 'node:crypto';
import {existsSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {inOpenOrder} from '../../../../scripts/autopilot';
import {admissionDecision,LIVE_SERVER,loadEnded,missionSignature,standingRetryable,startReserve,supplyExhaustedResult} from '../../../../scripts/swarm';
import {jobAccounts,ownerPlanPath,readCoordinatorJobs,readMergedPlan} from '../../../core/src/coordinator-jobs';
import {FLEET_DIR} from '../../../core/src/fleet';
import {readHeldFleetTradeClaims} from '../../../core/src/fleet-trade-claim';
import {validOrder,type Order,type Receipt} from '../../../core/src/fleet-trade-settlement';
import {listAttempts,readLogoutProof} from '../../../core/src/session-lifecycle';
import {assertNoRecoveryLease} from '../../../core/src/session-recovery-permit';
import {pidAlive} from '../../../core/src/session-takeover';
import {workerEntries} from '../../../core/src/worker-release';
import {boundAccounts,type CoordinatorState,type CoordTask} from '../coordinator';
import {projectRoot} from '../coordinator-store';
import {liveRows,ordinaryDeferrable,swarmRunAccounts,type LiveAccountWait} from './status';

// The swarm refuses a session recovery when memory is short (admitRecovery in scripts/swarm.ts). That refusal is
// final for the run, and each run chained behind it then waits for a new proposal. So a recovery run stays in the
// queue while the controller's last state shows that refusal. The margin covers what the swarm counts after this
// read: the dispatched recovery is one more pending start (pendingCount in scripts/swarm.ts), and the processes of
// the run take memory before the admission (live: free fell from 10.55 to 8.78 GiB in the 11 s of one dispatch).
export const RECOVERY_MEMORY_MARGIN_GB=3;
export function recoveryWaitsForMemory(task:Pick<CoordTask,'sessionRecovery'>,capacity:{running:number|null;externalRunning:number|null;pendingStartup:number|null;freeGB:number|null;minFreeGB:number|null;maxBots:number|null}|null):boolean{
 if(!task.sessionRecovery||!capacity||capacity.freeGB===null||capacity.minFreeGB===null)return false;
 // The memory numbers decide, not the reason: with every bot slot taken the decision names the slot first, and the
 // swarm, which keeps a slot for a recovery, still refuses on memory.
 const d=admissionDecision({running:capacity.running??0,external:capacity.externalRunning??0,pending:capacity.pendingStartup??0,starting:1,startingReserve:1,
  freeGB:Math.max(0,capacity.freeGB-RECOVERY_MEMORY_MARGIN_GB),minFreeGB:capacity.minFreeGB,maxBots:capacity.maxBots??Number.MAX_SAFE_INTEGER});
 return d.reason!=='invalid'&&d.projectedFreeGB<d.floorGB;
}

// An enabled autopilot row can yield between runs after its exact mission succeeded (or exhausted supplies) and logged out.
// A row prepared for a different, unstarted mission cannot inherit the previous mission's outcome.
export function settledAutopilotJob(job:any,account:string,base:string):boolean{
 if(job?.standing!==true||job.enabled!==true||typeof job.autopilot!=='string'||!job.autopilot)return false;
 const root=join(base,'.practice/session-lifecycle'),proof=readLogoutProof(account,LIVE_SERVER,{root});
 if(proof.state!=='confirmed')return false;
 const receipt=listAttempts(account,LIVE_SERVER,{root}).find(a=>a.attemptId===proof.attemptId)?.receipt;
 const running=swarmRunAccounts(base);if(!receipt||!running||running.has(account.toLowerCase()))return false;
 try{assertNoRecoveryLease(account,base);}catch{return false;}
 const end=[...loadEnded(join(base,'.practice/swarm-deaths.json'))].find(([n])=>n.toLowerCase()===account.toLowerCase())?.[1];
 const status=liveRows(base).find(s=>s.name?.toLowerCase()===account.toLowerCase()),entries=workerEntries(job.script,job.args??[],base);
 const okEnd=!!end&&/^done(?: after \d+ runs)?$/.test(end.reason)&&/^ok(?:\s|$)/.test(status?.result??'');
 const supplyEnd=!!end&&/^(?:blocked|stopped)(?: after \d+ runs)?$/.test(end.reason)
  &&supplyExhaustedResult(status?.result,job.env)
  &&!standingRetryable(end.reason,status?.result,job.standingRetry,job.env);
 return (okEnd||supplyEnd)&&end.revision===missionSignature(job)&&end.at>=proof.loggedOutAt
  &&receipt.owner.coordinatorRunId===null&&entries.includes(receipt.owner.script)&&/^[0-9a-f]{64}$/.test(receipt.owner.workerRelease??'')
  &&status?.server===LIVE_SERVER&&status.goal===job.goal
  &&status.sessionAttemptId===proof.attemptId&&status.workRevision===receipt.owner.workerRelease&&status.workEntry===entries.join(',')
  &&(status.coordinatorRunId??null)===null&&Number.isFinite(status.started)&&status.started>=receipt.createdAt&&status.started<=proof.loggedOutAt
  &&Number.isFinite(status.at)&&status.at>=status.started&&status.at<=end.at;
}
export function validLiveMemoryWait(wait:any,accounts:readonly string[]):boolean{
 const v=wait?.capacity,reserve=startReserve({host:false,job:{script:'',enabled:true,orchestrate:accounts.length>1}},accounts.length);
 return wait?.reason==='memory'&&accounts.length>0&&wait.account?.toLowerCase()===accounts[0]!.toLowerCase()&&!!v
  &&['running','external','starting','startingReserve','pending','maxBots'].every(k=>Number.isSafeInteger(v[k])&&v[k]>=0)
  &&['freeGB','minFreeGB'].every(k=>typeof v[k]==='number'&&Number.isFinite(v[k])&&v[k]>=0)
  &&v.starting===accounts.length&&v.startingReserve===reserve&&admissionDecision(v).reason==='memory';
}
type DispatchCapacity={at:number;running:number|null;externalRunning:number|null;pendingStartup:number|null;pendingReserveGB?:number|null;freeGB:number|null;minFreeGB:number|null;maxBots:number|null};
export function ordinaryRunWaitsForMemory(task:CoordTask,state:CoordinatorState,capacity:DispatchCapacity|null,freeGB:number,base=projectRoot):boolean{
 if(!ordinaryDeferrable(task))return false;
 if(!capacity||[capacity.at,capacity.running,capacity.externalRunning,capacity.pendingStartup,capacity.freeGB,capacity.minFreeGB,capacity.maxBots,freeGB].some(v=>v===null||!Number.isFinite(v)||v<0))return true;
 if(capacity.pendingReserveGB!=null&&(!Number.isFinite(capacity.pendingReserveGB)||capacity.pendingReserveGB<0))return true;
 const names=boundAccounts(task,state);if(!names?.length)return true;
 let jobs:any[]=[],runs:any[]=[];
 try{jobs=readCoordinatorJobs(base).jobs;const saved=JSON.parse(readFileSync(join(base,'.practice/swarm-runs.json'),'utf8'));if(Array.isArray(saved))runs=saved;}catch{/* unseen children retain their reservation */}
 let slots=0,reserve=0;
 for(const record of state.tasks.filter(r=>r.status==='running'&&r.spec.kind==='run'&&!r.spec.sessionRecovery)){
  const accounts=boundAccounts(record.spec,state);if(!accounts?.length)return true;
  const job=jobs.find(j=>j.coordinatorOwner==='coordinator'&&j.coordinatorTask===record.spec.id&&j.env?.COORDINATOR_RUN_ID===record.runId);
  // The snapshot already counts a registered run. Children not yet represented still need their startup heap.
  const counted=job&&runs.some(r=>Number.isFinite(r.started)&&r.started<=capacity.at&&r.revision===missionSignature(job)
   &&Array.isArray(r.accounts)&&r.accounts.length===accounts.length&&accounts.every(n=>r.accounts.some((a:string)=>a.toLowerCase()===n.toLowerCase())));
  if(!counted){slots+=accounts.length;reserve+=startReserve({host:false,job:{script:'',enabled:true,orchestrate:accounts.length>1}},accounts.length);}
 }
 return !admissionDecision({running:capacity.running!+slots,external:capacity.externalRunning!,pending:(capacity.pendingReserveGB??capacity.pendingStartup!)+reserve,
  starting:names.length,startingReserve:startReserve({host:false,job:{script:'',enabled:true,orchestrate:names.length>1}},names.length),
  freeGB:Math.min(freeGB,capacity.freeGB!),minFreeGB:capacity.minFreeGB!,maxBots:capacity.maxBots!}).allowed;
}
type OrderClaimAuthority={readHeld?:(base:string,accounts:readonly string[])=>ReturnType<typeof readHeldFleetTradeClaims>;now?:()=>number};
type OrderClaimCache={authority:string;resolved:Set<string>;retryAt:Map<string,number>};
const orderClaimCaches=new Map<string,OrderClaimCache>();
// A published trade nonce only moves held -> released; only swarm claims have an inherited-hold restore path.
// Cache that exact negative proof, never an account-wide absence. Held or unknown claims are checked again later.
function fleetOrderClaimsHeld(base:string,orders:readonly Order[],receipts:readonly Receipt[],accounts:readonly string[],now:number,readHeld:NonNullable<OrderClaimAuthority['readHeld']>){
 const root=resolve(base),wanted=new Set(accounts.map(n=>n.toLowerCase()));
 type Binding={key:string;account:string;orderId:string;role:string};
 const bindings=new Map<string,Binding|null>();
 for(const order of orders)if(now>=order.end)for(const receipt of receipts){
  if(!receipt||typeof receipt!=='object'||receipt.id!==order.id||receipt.version!==2||!['prepared','reconcile'].includes(receipt.state))continue;
  const role=receipt.role,other=role==='from'?'to':'from',same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
  const coherent=(role==='from'||role==='to')&&same(receipt.account,order[role])&&same(receipt.partner,order[other])&&same(receipt.server,order.server)
   &&same(receipt.item,order.item)&&receipt.requested===order.count&&receipt.ok===false&&Number.isSafeInteger(receipt.count)&&receipt.count>=0&&receipt.count<=order.count
   &&Number.isSafeInteger(receipt.at)&&receipt.at>=order.start&&receipt.at<=now&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt.claim);
  if(!coherent){bindings.set(receipt.claim,null);continue;}
  const key=JSON.stringify([receipt.account.toLowerCase(),order.server.toLowerCase(),receipt.claim]),prior=bindings.get(receipt.claim);
  if(bindings.has(receipt.claim)&&(!prior||prior.key!==key||prior.orderId!==order.id||prior.role!==role))bindings.set(receipt.claim,null);
  else bindings.set(receipt.claim,{key,account:order[role],orderId:order.id,role});
 }
 const candidates=[...bindings.values()].filter((v):v is Binding=>v!==null),keys=new Set(candidates.map(v=>v.key));
 let cache=orderClaimCaches.get(root);
 if(cache)for(const key of new Set([...cache.resolved,...cache.retryAt.keys()]))if(wanted.has(JSON.parse(key)[0])&&!keys.has(key)){cache.resolved.delete(key);cache.retryAt.delete(key);}
 if(!candidates.length)return()=>true;
 let authority:string;
 try{
  const dotGit=join(root,'.git'),gitDir=statSync(dotGit).isDirectory()?dotGit:resolve(root,readFileSync(dotGit,'utf8').match(/^gitdir:\s*(.+)\s*$/)![1]!.trim());
  const common=existsSync(join(gitDir,'commondir'))?resolve(gitDir,readFileSync(join(gitDir,'commondir'),'utf8').trim()):gitDir;
  authority=createHash('sha256').update(common+'\0'+readFileSync(join(common,'config'),'utf8')+'\0'+(existsSync(join(gitDir,'config.worktree'))?readFileSync(join(gitDir,'config.worktree'),'utf8'):'')).digest('hex');
 }catch{orderClaimCaches.delete(root);return()=>true;}
 if(!cache||cache.authority!==authority){cache={authority,resolved:new Set(),retryAt:new Map()};orderClaimCaches.set(root,cache);}
 const due=candidates.filter(v=>!cache!.resolved.has(v.key)&&now>=(cache!.retryAt.get(v.key)??0));
 if(due.length){
  for(const v of due)cache.retryAt.set(v.key,now+60000);
  try{
   const held=new Set(readHeld(base,[...new Set(due.map(v=>v.account))]).map(c=>c.nonce));
   for(const v of due)if(!held.has(JSON.parse(v.key)[2])){cache.resolved.add(v.key);cache.retryAt.delete(v.key);}
  }catch{/* Authority failure supplies no release proof. */}
 }
 return(nonce:string)=>{const v=bindings.get(nonce);return !v||!cache!.resolved.has(v.key);};
}
// An owner's reservation row is disabled and names no script. It holds the account for its role. It is read from the
// owner's plan, because a coordinator job for the same account shadows the row in the merged plan. A finished hand job
// names its script, so only a reservation matches. The task waits as it does for an owner's order, and no run installs over it.
const reservedByOwner=(account:string,base:string):boolean=>{
 try{return(JSON.parse(readFileSync(ownerPlanPath(base),'utf8')).jobs as any[]).some(j=>j?.coordinatorOwner===undefined&&j.enabled===false&&(typeof j.script!=='string'||!j.script.trim())&&jobAccounts(j).some(n=>n.toLowerCase()===account.toLowerCase()));}catch{return false;}
};
export function liveAccountWait(task:Pick<CoordTask,'kind'|'sessionRecovery'|'repairs'|'launch'>,accounts:readonly string[],base=projectRoot,alive=pidAlive,authority:OrderClaimAuthority={}):LiveAccountWait|null{
 if(!ordinaryDeferrable(task))return null;
 const root=join(base,'.practice/session-lifecycle');
 let ordered:Set<string>|undefined;
 for(const account of accounts){
  const proof=readLogoutProof(account,LIVE_SERVER,{root});
  const receipt=(proof.state==='held'||proof.state==='confirmed')?listAttempts(account,LIVE_SERVER,{root}).find(a=>a.attemptId===proof.attemptId)?.receipt:null;
  // A status row is no proof of a live owner. The current producer and its live process own this wait.
  if(proof.state==='held'&&receipt&&Number.isSafeInteger(receipt.owner.pid)&&receipt.owner.pid>0&&receipt.owner.script
   &&!receipt.events.some(e=>['ended','connect-failed','logout','closed'].includes(e.kind))&&alive(receipt.owner.pid))
   return{account,reason:'active-session',attemptId:receipt.attemptId,pid:receipt.owner.pid};
  if(!ordered){
   const synced=join(base,'.practice/fleet-data/fleet'),fleet=base===projectRoot?FLEET_DIR():existsSync(join(synced,'owners.json'))?synced:join(base,'fleet');
   const rows=(folder:string)=>{const dir=join(fleet,folder);return existsSync(dir)?readdirSync(dir).filter(f=>f.endsWith('.json')).flatMap(file=>{try{return[JSON.parse(readFileSync(join(dir,file),'utf8'))];}catch{return[];}}):[];};
   const names=new Set(accounts.map(n=>n.toLowerCase()));
   const orders=rows('orders').filter(validOrder).filter(o=>o.server.toLowerCase()===LIVE_SERVER&&(names.has(o.from.toLowerCase())||names.has(o.to.toLowerCase())));
   // The order intent precedes login claims. Reuse the autopilot's settlement rules, including unresolved receipts.
   const receipts=rows('receipts'),now=authority.now?.()??Date.now();
   const claimHeld=fleetOrderClaimsHeld(base,orders,receipts,accounts,now,authority.readHeld??readHeldFleetTradeClaims);
   ordered=inOpenOrder(orders,receipts,now,()=>true,claimHeld);
  }
  if(ordered.has(account.toLowerCase()))return{account,reason:'fleet-order',attemptId:null,pid:null};
  let job:any;try{job=readMergedPlan(base).jobs.find((j:any)=>jobAccounts(j).some(n=>n.toLowerCase()===account.toLowerCase()));}catch{continue;}
  if(job?.standing===true&&job.enabled===true&&typeof job.autopilot==='string'&&job.autopilot&&!settledAutopilotJob(job,account,base))
   return{account,reason:'autopilot-assignment',attemptId:receipt?.attemptId??null,pid:receipt?.owner.pid??null};
  if(reservedByOwner(account,base))return{account,reason:'reserved',attemptId:null,pid:null};
 }
 return null;
}
