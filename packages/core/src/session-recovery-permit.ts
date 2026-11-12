import {existsSync,mkdirSync,readFileSync,writeFileSync,linkSync,realpathSync,unlinkSync,readdirSync,lstatSync} from 'node:fs';
import {join,resolve,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {capabilityRevision,cachedLaunchRevision} from './worker-release';
import {processMatchesRecent,safeKill,commandLine} from '../../practice/src/proc';
import {readLogoutProof,listAttempts} from './session-lifecycle';
import {isLocalServer} from './localserver';
import {missionSignature,successfulEnd} from './session-admission';
import {readMergedPlan} from './coordinator-jobs';

export const RECOVERY_SCHEMA='session-recovery/1';
export const RECOVERY_BINDING_MS=45000;
// The controller heartbeat (.practice/swarm-state.json, written every 2 s) counts as current for this long. A heartbeat
// older than this means the controller stalled or died, so the window stays short; the checks between a fleet read and
// its use must stay fast. The controller's own heartbeat cannot advance while it issues and binds synchronously, so
// the launch reuses the issue-time process observations at binding (launchObservations) and the source check is cached.
export const FLEET_HEARTBEAT_MAX_MS=10000;
export const RECOVERY_SCRIPT='packages/core/src/session-recovery.ts';
export type RecoveryRequest={schema:typeof RECOVERY_SCHEMA;account:string;server:string;runId:string;nonce:string;endedAt:number;source:string};
type EvidenceRef={path:string;sha256:string};
export type ControlledRecoveryRequest=RecoveryRequest&{kind:'session-recovery';qualification:{delivery:EvidenceRef;proof:EvidenceRef}};
export type RecoveryPermitChecks={now?:()=>number;matches?:(pid:number,marker:string)=>boolean;source?:()=>string;capability?:(capability:unknown)=>string|undefined;nativeFixture?:boolean};
type Checks=RecoveryPermitChecks;
type ProducerRef={attemptId:string;sha256:string|null};
type Permit={schema:'session-recovery-permit/1';request:ControlledRecoveryRequest;controller:{pid:number;nonce:string;source:string};issuedAt:number;expiresAt:number;runnerSha256:string;nativeFixture:boolean;completedEnd?:unknown;missionRevision?:string;producerHistory?:ProducerRef[]};
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const json=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const same=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export function assertNativeFixtureRoot(base:string,server:string){
 try{
  if(!isLocalServer(server))throw Error('not local');
  const key=(p:string)=>{const v=p.replaceAll('\\','/').replace(/\/+$/,'');return process.platform==='win32'?v.toLowerCase():v;};
  const repo=key(realpathSync(resolve(import.meta.dir,'../../..'))),actual=key(realpathSync(base));
  const controlPath=resolve(import.meta.dir,'../../../.practice/coordinator'),control=key(existsSync(controlPath)?realpathSync(controlPath):controlPath);
  const inside=(p:string,parent:string)=>p===parent||p.startsWith(parent+'/');
  if(actual===repo||inside(actual,control))throw Error('production root');
  const privatePath=(path:string)=>{
   try{const info=lstatSync(path);if(info.isSymbolicLink())throw Error('control links are not private fixtures');
    if(info.isDirectory())for(const child of readdirSync(path))privatePath(join(path,child));}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  };
  privatePath(join(base,'.practice'));privatePath(join(base,'swarm.json'));
  const candidate=join(base,'.practice/coordinator');
  if(existsSync(candidate)&&inside(key(realpathSync(candidate)),control))throw Error('production control alias');
 }catch{throw Error('native fixture boundary invalid');}
}
export function assertRecoveryNotStopped(account:string,base:string,present:(path:string)=>boolean=existsSync){
 for(const root of new Set([resolve(base),resolve(import.meta.dir,'../../..')]))
  for(const flag of ['stop-coordinator','stop-swarm','stop-'+account])if(present(join(root,'.practice',flag)))throw Error('recovery owner stopped');
}
export function validateRecoveryRequest(r:any):asserts r is RecoveryRequest{
 if(!r||r.schema!==RECOVERY_SCHEMA||! /^[A-Za-z0-9_ -]{1,12}$/.test(r.account??'')
  ||['haggis','shaftshooter','polevaulter'].includes(r.account.toLowerCase())
  ||typeof r.server!=='string'||! /^[A-Za-z0-9.:[\]-]{1,253}$/.test(r.server)
  ||! /^[a-zA-Z0-9-]{1,100}$/.test(r.runId??'')||! /^[a-zA-Z0-9-]{1,100}$/.test(r.nonce??'')
  ||!Number.isFinite(r.endedAt)||r.endedAt<0||! /^[a-f0-9]{64}$/.test(r.source??''))throw Error('invalid or protected session recovery request');
}
export function recoveryPermitPaths(r:RecoveryRequest,base:string){
 validateRecoveryRequest(r);
 const account=join(base,'.practice/coordinator/session-recovery/accounts',r.account.toLowerCase()),attempt=join(account,r.nonce);
 return {lease:join(account,'lease.json'),permit:join(attempt,'permit.json'),child:join(attempt,'child.json'),used:join(attempt,'used.json'),input:join(attempt,'input.json'),output:join(attempt,'output'),completed:join(attempt,'completed.json')};
}
export function assertNoRecoveryLease(account:string,base:string){
 if(! /^[A-Za-z0-9_ -]{1,12}$/.test(account))throw Error('invalid recovery lease identity');
 if(existsSync(join(base,'.practice/coordinator/session-recovery/accounts',account.toLowerCase(),'lease.json')))throw Error('account has an unresolved recovery lease: '+account);
}
function evidence(ref:EvidenceRef,base:string){
 if(!ref||typeof ref.path!=='string'||! /^[a-f0-9]{64}$/.test(ref.sha256))throw Error('recovery qualification missing');
 const path=realpathSync(resolve(base,ref.path)),allowed=realpathSync(join(base,'.practice/deliveries'))+sep;
 if(!path.startsWith(allowed))throw Error('recovery qualification outside delivery');
 const bytes=readFileSync(path);if(sha(bytes)!==ref.sha256)throw Error('recovery qualification changed');return JSON.parse(bytes.toString('utf8'));
}
export const NATIVE_RECOVERY_CHECKS=['offline','orphan','modal','authFailure','cooldown','partial','timeout','lateCallback','ownership','stop','singleUse','stock','completed'] as const;
// A native proof names, for every check, the observed cases, their proof level and the raw saved files behind them.
// Boolean flags alone are refused. Every evidence file must stay inside the proof directory at its recorded hash.
export function verifyNativeRecoveryProof(proof:any,proofDirectory:string,expected:{runtimeRevision:string;runnerSha256:string}){
 const fail=(why:string)=>{throw Error('recovery lacks current controller-native qualification: '+why);};
 if(proof?.ok!==true||proof.level!=='native-controller-recovery'||proof.runtimeRevision!==expected.runtimeRevision||proof.runnerSha256!==expected.runnerSha256)fail('report');
 if(!Array.isArray(proof.cases))fail('cases');
 const root=realpathSync(proofDirectory)+sep,cases=new Map<string,any>();
 for(const c of proof.cases){if(typeof c?.id!=='string'||cases.has(c.id))fail('case identity');cases.set(c.id,c);}
 const file=(e:any)=>{
  if(typeof e?.path!=='string'||! /^[a-f0-9]{64}$/.test(e.sha256??'')||/^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$)/.test(e.path))fail('evidence reference');
  let path='';try{path=realpathSync(resolve(proofDirectory,e.path));}catch{fail('evidence missing');}
  if(!path.startsWith(root))fail('evidence outside proof');if(sha(readFileSync(path))!==e.sha256)fail('evidence changed');
 };
 for(const key of NATIVE_RECOVERY_CHECKS){
  const check=proof.checks?.[key];
  if(!check||check.ok!==true||typeof check.level!=='string'||! /^native-/.test(check.level)||!Array.isArray(check.cases)||!check.cases.length||!Array.isArray(check.evidence)||!check.evidence.length)fail(key);
  for(const id of check.cases){const c=cases.get(id);if(!c||c.ok!==true||typeof c.level!=='string'||! /^native-/.test(c.level)||!Array.isArray(c.evidence)||!c.evidence.length)fail(key+' case '+id);c.evidence.forEach(file);}
  check.evidence.forEach(file);
 }
 return true;
}
export const FLEET_REFUSALS=['missing','malformed','controller','future','stale','account-active'] as const;
// The controller publishes fleet state from its own process. The age is measured from a clock read taken after the
// fleet read, never from an earlier one, and FLEET_HEARTBEAT_MAX_MS bounds it.
export function assertFleetResolved(path:string,account:string,controllerPid:number,clock:()=>number=Date.now){
 const refuse=(field:(typeof FLEET_REFUSALS)[number])=>{throw Error('recovery fleet ownership unresolved: '+field);};
 let raw:string;try{raw=readFileSync(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')refuse('missing');throw error;}
 let fleet:any;try{fleet=JSON.parse(raw);}catch{refuse('malformed');}
 const observedAt=clock();
 if(!fleet||typeof fleet!=='object'||!Number.isFinite(fleet.at)||!Array.isArray(fleet.jobs)||fleet.jobs.some((j:any)=>!j||typeof j!=='object'))refuse('malformed');
 if(fleet.controllerPid!==controllerPid)refuse('controller');
 if(observedAt-fleet.at<0)refuse('future');
 if(observedAt-fleet.at>FLEET_HEARTBEAT_MAX_MS)refuse('stale');
 if(fleet.jobs.some((j:any)=>(same(j.account,account)||Array.isArray(j.accounts)&&j.accounts.some((a:unknown)=>same(a,account)))
  &&/^(?:running|starting|stopping)/.test(typeof j.state==='string'?j.state:'')))refuse('account-active');
}
function authority(r:ControlledRecoveryRequest,base:string,options:Checks,issuing=false,ownedChild=false){
 validateRecoveryRequest(r);if(r.kind!=='session-recovery')throw Error('not a controlled recovery request');
 if(options.nativeFixture)assertNativeFixtureRoot(base,r.server);
 // Observation of the owners, not kill authorization: the cached lookup is allowed here (see proc.ts).
 const now=(options.now??Date.now)(),matches=options.matches??processMatchesRecent;
 const owner=json(join(base,'.practice/coordinator/swarm-owner.json'));
 if(!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.nonce!=='string'||!owner.nonce
  ||owner.source!==r.source||!matches(owner.pid,owner.nonce)||(issuing&&owner.pid!==process.pid))throw Error('recovery controller owner changed');
 if((options.source??(()=>cachedLaunchRevision(base)))()!==r.source)throw Error('recovery source changed');
 assertRecoveryNotStopped(r.account,base);
 const record=json(join(base,'.practice/coordinator/state.json')).tasks?.find((t:any)=>t.status==='running'&&t.runId===r.runId);
 const spec=record?.spec,authorization=spec?.sessionRecovery;
 if(spec?.kind!=='run'||!same(spec.account,r.account)||!same(authorization?.account,r.account)||authorization?.endedAt!==r.endedAt
  ||!spec.repairs?.some((p:any)=>same(p.account,r.account)&&p.endedAt===r.endedAt))throw Error('recovery task authorization missing');
 const taskOwner=json(join(base,'.practice/coordinator/runs',r.runId,'owner.json'));
 if(taskOwner.runId!==r.runId||taskOwner.pid!==record.pid||!matches(taskOwner.pid,r.runId))throw Error('recovery task owner changed');
 const requestLease=json(join(base,'.practice/swarm-repair.json.lease'));
 if(requestLease.pid!==taskOwner.pid||requestLease.runId!==r.runId||requestLease.nonce!==r.nonce)throw Error('recovery request lease changed');
 const end=Object.entries(json(join(base,'.practice/swarm-deaths.json'))).find(([a])=>same(a,r.account))?.[1] as any;
 const completed=successfulEnd(end?.reason??'');
 if(end?.at!==r.endedAt||!completed&&! /^(?:blocked|died|gave-up|exit|no-progress|stopped)(?:\b| )/.test(end.reason??''))throw Error('recovery exact failure changed');
 const assignments=readMergedPlan(base).jobs.filter((j:any)=>(j.accounts??[j.account]).some((a:any)=>same(a,r.account)));
 if(assignments.some((j:any)=>j.enabled||!j.script||/fresh.clock|24 boards|main simultaneous/i.test(j.goal??'')))throw Error('recovery assignment is active or reserved');
 let missionRevision:string|undefined;
 if(completed){
  // Only an ordinary retired assignment may bootstrap a new mission. Cleanup never clears its successful end.
  if(assignments.length!==1||assignments[0].enabled!==false||assignments[0].host||assignments[0].orchestrate||assignments[0].accounts
   ||spec.participants?.length||spec.launch)throw Error('recovery completed assignment is not ordinary retired work');
  const holdsPath=join(base,'.practice/swarm-script-holds.json'),holds=existsSync(holdsPath)?json(holdsPath):[];
  if(!Array.isArray(holds)||holds.some((h:any)=>!h||typeof h.account!=='string'||same(h.account,r.account)))throw Error('recovery completed account has an open hold');
  if(!/^[a-z0-9-]+$/.test(spec.capability??''))throw Error('recovery completed mission unavailable');
  // Read the existing definition as data; runtime core must not import the router.
  const definition=json(join(base,'packages/router/tasks',spec.capability+'.json'));
  if(definition.id!==spec.capability||typeof definition.entry!=='string'||!/^scripts\/[A-Za-z0-9_/-]+\.ts$/.test(definition.entry))throw Error('recovery completed mission unavailable');
  missionRevision=missionSignature({account:r.account,script:definition.entry,args:spec.args??[],env:{...spec.env,CAP:spec.env?.CAP??'1600',COORDINATOR_RUN_ID:r.runId}});
  if(typeof end.revision!=='string'||!end.revision||end.revision===missionRevision)throw Error('recovery completed work needs a different mission');
 }
 assertFleetResolved(join(base,'.practice/swarm-state.json'),r.account,owner.pid,options.now??Date.now);
 const statusFile=join(base,'.practice/status',r.account+'.json'),status=existsSync(statusFile)?json(statusFile):null;
 if(status&&status.server===r.server&&!status.result&&(!Number.isFinite(status.at)||now-status.at<30000))throw Error('recovery account has an active external observation');
 const lifecycleRoot=join(base,'.practice/session-lifecycle'),latest=readLogoutProof(r.account,r.server,{root:lifecycleRoot});
 if(latest.state==='invalid')throw Error('recovery lifecycle ownership malformed');
 if(latest.state==='none'&&status?.server===r.server&&!status.result)throw Error('recovery orphan owner unknown');
 if(latest.state==='held'){
  const attempt=listAttempts(r.account,r.server,{root:lifecycleRoot}).find(a=>a.attemptId===latest.attemptId)?.receipt;
  if(!Number.isSafeInteger(attempt?.owner.pid)||attempt!.owner.pid<1)throw Error('recovery orphan owner unknown');
  const own=ownedChild&&attempt!.owner.pid===process.pid&&attempt!.owner.coordinatorRunId===r.runId&&attempt!.owner.workerRelease===r.source&&attempt!.owner.script===RECOVERY_SCRIPT;
  if(!own)try{process.kill(attempt!.owner.pid,0);throw Error('recovery previous session owner still alive');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
 }
 const runnerSha256=sha(readFileSync(join(base,RECOVERY_SCRIPT)));
 if(!options.nativeFixture){
 const delivery=evidence(r.qualification?.delivery,base),proof=evidence(r.qualification?.proof,base);
 const gate=delivery.checks?.find((c:any)=>c.id==='native-session-recovery'&&c.phase==='practice');
 // The delivery records its capability release (delivery-cli.ts); the native proof and r.source are the launch release.
 if(delivery.ok!==true||delivery.stage!=='delivered'||delivery.id!==spec.capability||typeof delivery.runtimeRevision!=='string'||delivery.runtimeRevision!==(options.capability??(c=>capabilityRelease(c,base)))(spec.capability)
  ||!Number.isFinite(delivery.at)||delivery.at<=r.endedAt||delivery.at>now
  ||!gate||delivery.checks.some((c:any)=>c.exitCode!==0||c.timedOut)
  ||proof.ok!==true)throw Error('recovery lacks current controller-native qualification');
 verifyNativeRecoveryProof(proof,dirname(realpathSync(resolve(base,r.qualification.proof.path))),{runtimeRevision:r.source,runnerSha256});
 const logPath=realpathSync(JSON.parse(gate.detail).stdout),deliveryDir=dirname(realpathSync(resolve(base,r.qualification.delivery.path)))+sep;
 if(!logPath.startsWith(deliveryDir))throw Error('recovery native output outside delivery');
 const markers=readFileSync(logPath,'utf8').split(/\r?\n/).filter(l=>l.startsWith('RECOVERY_NATIVE_PROOF '));
 if(markers.length!==1)throw Error('recovery native proof is not linked to its gate');
 const emitted=JSON.parse(markers[0]!.slice('RECOVERY_NATIVE_PROOF '.length));
 if(emitted.sha256!==r.qualification.proof.sha256||realpathSync(resolve(base,emitted.path))!==realpathSync(resolve(base,r.qualification.proof.path)))throw Error('recovery native proof gate binding changed');
 }
 return {owner:{pid:owner.pid,nonce:owner.nonce,source:owner.source},now,runnerSha256,completedEnd:completed?end:undefined,missionRevision,latest};
}
// The current capability release of a delivery task's entry, read as data (runtime core must not import the router).
function capabilityRelease(capability:unknown,base:string):string|undefined{
 try{
  if(typeof capability!=='string'||!/^[a-z0-9-]+$/.test(capability))return undefined;
  const definition=json(join(base,'packages/router/tasks',capability+'.json'));
  return definition.id===capability&&typeof definition.entry==='string'?capabilityRevision([definition.entry],base):undefined;
 }catch{return undefined;}
}
// The controller publishes a complete immutable permit, then atomically claims the account.
// A crash, malformed marker or failed child leaves its lease held. This module never clears an end or retries.
export function issueRecoveryPermit(r:ControlledRecoveryRequest,base:string,options:Checks={}):Permit{
 const checked=authority(r,base,options,true),paths=recoveryPermitPaths(r,base);
 let producerHistory:ProducerRef[]|undefined;
 if(checked.completedEnd){
  const attempts=listAttempts(r.account,r.server,{root:join(base,'.practice/session-lifecycle')}),last=attempts.at(-1),a=last?.receipt;
  // A retired producer that reached START but disconnected needs cleanup, not a new owner for its history.
  // authority already checks that its owner is gone. Partial intents and confirmed histories stay refused.
  const held=checked.latest.state==='held'&&checked.latest.attemptId===last?.attemptId&&a
   &&attempts.every(t=>t.receipt&&same(t.receipt.account,r.account)&&t.receipt.server===r.server&&t.receipt.attemptId===t.attemptId)
   &&a.createdAt<=a.updatedAt&&a.updatedAt<=r.endedAt
   &&a.events.some(e=>e.kind==='ready')&&a.events.find(e=>e.kind==='ended')?.detail==='disconnected'
   &&a.events.filter(e=>e.kind==='logout').at(-1)?.detail==='disconnected';
  if(!(checked.latest.state==='none'&&attempts.length===0)&&!held)throw Error('recovery completed account already has producer history');
  producerHistory=attempts.map(({attemptId,sha256})=>({attemptId,sha256}));
 }
 assertNoRecoveryLease(r.account,base);
 const permit:Permit={schema:'session-recovery-permit/1',request:r,controller:checked.owner,issuedAt:checked.now,expiresAt:checked.now+150000,runnerSha256:checked.runnerSha256,nativeFixture:!!options.nativeFixture,
  ...(checked.completedEnd?{completedEnd:checked.completedEnd,missionRevision:checked.missionRevision,producerHistory}:{})};
 mkdirSync(dirname(paths.permit),{recursive:true});writeFileSync(paths.permit,JSON.stringify(permit),{flag:'wx'});linkSync(paths.permit,paths.lease);return permit;
}
function current(r:ControlledRecoveryRequest,base:string,options:Checks,controller=false,ownedChild=false):Permit{
 const checked=authority(r,base,options,controller,ownedChild),paths=recoveryPermitPaths(r,base),p=json(paths.permit);
 if(!isDeepStrictEqual(p.completedEnd,checked.completedEnd)||p.missionRevision!==checked.missionRevision)throw Error('recovery completed end or mission changed');
 if(p.completedEnd){
  const attempts=listAttempts(r.account,r.server,{root:join(base,'.practice/session-lifecycle')});
  const history:ProducerRef[]=p.producerHistory??[],retained=attempts.slice(0,history.length).map(({attemptId,sha256})=>({attemptId,sha256}));
  if(!isDeepStrictEqual(history,retained))throw Error('recovery completed producer ownership changed');
  const fresh=attempts.slice(history.length);
  if(fresh.length){
   const child=existsSync(paths.child)?json(paths.child):null,used=existsSync(paths.used)?json(paths.used):null,a=fresh[0]?.receipt;
   if(fresh.length!==1||!a||child?.pid!==used?.pid||used?.nonce!==r.nonce||a.createdAt<p.issuedAt
    ||!('attemptId' in checked.latest)||checked.latest.attemptId!==fresh[0]?.attemptId
    ||a.owner.pid!==child.pid||a.owner.coordinatorRunId!==r.runId||a.owner.workerRelease!==r.source||a.owner.script!==RECOVERY_SCRIPT)
    throw Error('recovery completed producer ownership changed');
  }else if(history.length?checked.latest.state!=='held'||checked.latest.attemptId!==history.at(-1)?.attemptId:checked.latest.state!=='none')throw Error('recovery completed producer ownership changed');
 }
 if(p.schema!=='session-recovery-permit/1'||p.nativeFixture!==!!options.nativeFixture||!isDeepStrictEqual(p.request,r)||!isDeepStrictEqual(p.controller,checked.owner)
  ||p.runnerSha256!==checked.runnerSha256||!Number.isFinite(p.issuedAt)||p.issuedAt>checked.now||p.expiresAt!==p.issuedAt+150000||checked.now>=p.expiresAt
  ||sha(readFileSync(paths.lease))!==sha(readFileSync(paths.permit)))throw Error('recovery permit expired or changed');
 return p;
}
export function bindRecoveryChild(r:ControlledRecoveryRequest,pid:number,base:string,options:Checks={}){
 current(r,base,options,true);if(!Number.isSafeInteger(pid)||pid<1)throw Error('invalid recovery child');
 writeFileSync(recoveryPermitPaths(r,base).child,JSON.stringify({pid,nonce:r.nonce,runId:r.runId}),{flag:'wx'});
}
// The controller sends readiness on its private pipe after current validation and child publication.
// Readiness is not admission: consumeRecoveryConnection still checks all authority and single-use guards.
export async function waitForRecoveryChildBinding(r:ControlledRecoveryRequest,base:string,ready:ReadableStream<Uint8Array>){
 const paths=recoveryPermitPaths(r,base),permit=json(paths.permit);
 // A recovery child is a fresh bun process that loads the SDK and the collision data before it binds: on this PC with
 // builds running that takes longer than 10 s. The window stays well inside the 150 s permit lifetime.
 const deadline=permit.issuedAt+RECOVERY_BINDING_MS;
 if(!Number.isFinite(permit.issuedAt)||Date.now()<permit.issuedAt||Date.now()>=deadline)throw Error('recovery connection admission expired');
 const reader=ready.getReader();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const raw=await Promise.race([
   (async()=>{let text='';const decoder=new TextDecoder();let bytes=0;
    for(;;){const {value,done}=await reader.read();if(done)break;
     bytes+=value.byteLength;if(bytes>1024)throw Error('recovery child identity changed');text+=decoder.decode(value,{stream:true});}
    return text+decoder.decode();})(),
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('recovery child not bound')),Math.max(0,deadline-Date.now()));}),
  ]);
  if(Date.now()>=deadline)throw Error('recovery connection admission expired');
  if(!raw||!existsSync(paths.child))throw Error('recovery child not bound');
  let message,child;try{message=JSON.parse(raw);child=json(paths.child);}catch{throw Error('recovery child identity changed');}
  if(message?.pid!==process.pid||message.nonce!==r.nonce||message.runId!==r.runId||message.source!==r.source
   ||child?.pid!==process.pid||child.nonce!==r.nonce||child.runId!==r.runId)throw Error('recovery child identity changed');
 }finally{clearTimeout(timer);await reader.cancel().catch(()=>{});}
}
// Called exactly once before connect. The returned guard may run again before cleanup.
export function consumeRecoveryPermit(r:ControlledRecoveryRequest,base:string,options:Checks={}){
 return consumeRecoveryConnection(r,base,options).guard;
}
// An opaque in-process token. Only consumeRecoveryConnection creates one, for this exact request and child PID.
// recoverSession spends it once for its connection; the guard stays reusable for cleanup checks.
export type RecoveryConnectionAdmission={readonly nonce:string};
const admissions=new WeakMap<object,{request:ControlledRecoveryRequest;pid:number;nativeFixture:boolean;guard:()=>void;spent:boolean}>();
export function consumeRecoveryConnection(r:ControlledRecoveryRequest,base:string,options:Checks={}){
 const paths=recoveryPermitPaths(r,base);
 const check=(ownedChild=false)=>{
  current(r,base,options,false,ownedChild);if(!existsSync(paths.child))throw Error('recovery child not bound');
  const child=json(paths.child);if(child.pid!==process.pid||child.nonce!==r.nonce||child.runId!==r.runId)throw Error('recovery child identity changed');
 };
 check();const permit=json(paths.permit);if((options.now??Date.now)()>permit.issuedAt+RECOVERY_BINDING_MS)throw Error('recovery connection admission expired');
 if(existsSync(paths.used))throw Error('recovery nonce already consumed');
 writeFileSync(paths.used,JSON.stringify({pid:process.pid,nonce:r.nonce,permitSha256:sha(readFileSync(paths.permit))}),{flag:'wx'});
 const used=readFileSync(paths.used,'utf8');
 const guard=()=>{check(true);if(readFileSync(paths.used,'utf8')!==used)throw Error('recovery consumption marker changed');};
 const admission:RecoveryConnectionAdmission=Object.freeze({nonce:r.nonce});
 admissions.set(admission,{request:structuredClone(r),pid:process.pid,nativeFixture:permit.nativeFixture===true,guard,spent:false});
 return {guard,admission};
}
// Spends the admission for one connection. A copied, forged, reused or crossed token refuses before any intent.
export function spendRecoveryConnection(admission:unknown,r:RecoveryRequest){
 const entry=admission&&typeof admission==='object'?admissions.get(admission):undefined;
 if(!entry||entry.spent||entry.pid!==process.pid||!isDeepStrictEqual(entry.request,r)||entry.nativeFixture&&!isLocalServer(r.server))
  throw Error('recovery connection admission invalid; no connection attempted');
 entry.spent=true;entry.guard();
}
export function assertSpentRecoveryConnection(admission:RecoveryConnectionAdmission,account:string,server:string){
 const entry=admissions.get(admission);
 if(!entry?.spent||entry.pid!==process.pid||!same(entry.request.account,account)||entry.request.server!==server||entry.nativeFixture)
  throw Error('recovery connection admission invalid; no connection attempted');
 entry.guard();
}

export function recoveryStatePreserved(before:any,after:any){
 return !!before&&!!after&&same(before.player?.name,after.player?.name)
  &&before.player.x===after.player.x&&before.player.z===after.player.z&&before.player.level===after.player.level
  &&after.player.hp>=before.player.hp&&after.player.hp>0
  &&isDeepStrictEqual(before.inventory,after.inventory)&&isDeepStrictEqual(before.equipment,after.equipment)&&isDeepStrictEqual(before.skills,after.skills)
  &&(before.bank===null||after.bank===null||isDeepStrictEqual(before.bank,after.bank))&&!after.modalOpen;
}
// The existing controller calls this only after its tracked child exits. It reads that child's fixed output,
// then re-reads the producer. No caller-provided success JSON, account-end mutation or script qualification.
export function finishRecoveryPermit(r:ControlledRecoveryRequest,exitCode:number,base:string,options:Checks={}){
 const p=current(r,base,options,true),paths=recoveryPermitPaths(r,base),child=json(paths.child),used=json(paths.used);
 if(child.pid!==used.pid||used.nonce!==r.nonce||used.permitSha256!==sha(readFileSync(paths.permit)))throw Error('recovery child consumption not bound');
 const receiptPath=join(paths.output,'receipt.json'),raw=readFileSync(receiptPath),receipt=JSON.parse(raw.toString('utf8'));
 if(exitCode!==0||receipt.state!=='confirmed'||receipt.logout!=='logged-out'||receipt.failure||!isDeepStrictEqual(receipt.request,r)
  ||receipt.runnerSha256!==p.runnerSha256||!Number.isFinite(receipt.startedAt)||receipt.startedAt<p.issuedAt
  ||!Number.isFinite(receipt.endedAt)||receipt.endedAt<receipt.startedAt||receipt.endedAt>(options.now??Date.now)()
  ||receipt.scope?.gameplay!==false||receipt.scope.production!==0||receipt.scope.repairsFailure!==false||receipt.scope.qualifiesScript!==false
  ||!same(receipt.before?.player?.name,r.account)||!recoveryStatePreserved(receipt.before,receipt.after))throw Error('recovery child did not confirm preserved cleanup');
 const root=join(base,'.practice/session-lifecycle'),proof=readLogoutProof(r.account,r.server,{root});
 const attempt=listAttempts(r.account,r.server,{root}).find(a=>a.attemptId===receipt.attemptId);
 if(proof.state!=='confirmed'||proof.attemptId!==receipt.attemptId||proof.receiptSha256!==receipt.lifecycleSha256||attempt?.sha256!==proof.receiptSha256
  ||!attempt.receipt||attempt.receipt.createdAt<receipt.startedAt||proof.loggedOutAt<receipt.startedAt
  ||attempt.receipt.owner.pid!==child.pid||attempt.receipt.owner.coordinatorRunId!==r.runId||attempt.receipt.owner.workerRelease!==r.source
  ||attempt.receipt.owner.script!==RECOVERY_SCRIPT)throw Error('recovery producer result superseded or crossed');
 const completed={at:(options.now??Date.now)(),request:r,childPid:child.pid,receiptPath,receiptSha256:sha(raw),proof,nativeFixture:p.nativeFixture,scope:{repairsFailure:false,qualifiesScript:false,production:0}};
 writeFileSync(paths.completed,JSON.stringify(completed),{flag:'wx'});
 // Both hard links still contain the exact immutable permit. Never remove a different owner's lease.
 if(sha(readFileSync(paths.lease))!==sha(readFileSync(paths.permit)))throw Error('recovery lease changed before release');
 unlinkSync(paths.lease);return completed;
}

// Issue and binding run in one synchronous controller call, which blocks the controller's heartbeat writer. Each
// PowerShell command-line lookup costs over 1 s under load, so repeating the lookups at binding can age the heartbeat
// past FLEET_HEARTBEAT_MAX_MS. Binding reuses the issue observations of this one call; it still re-reads every file and the
// source stamp, and the child's consumeRecoveryConnection observes both processes again in its own process.
export function launchObservations(options:Checks):Checks{
 const lookup=options.matches??processMatchesRecent,seen=new Map<string,boolean>();
 return {...options,matches:(pid,marker)=>{const key=pid+' '+marker;let hit=seen.get(key);if(hit===undefined){hit=lookup(pid,marker);seen.set(key,hit);}return hit;}};
}
export function launchPermittedRecovery(r:ControlledRecoveryRequest,base:string,options:Checks={}){
 // Remote issuance requires the current same-capability delivered native proof (authority); a fixture is local-only.
 if(!isLocalServer(r.server)&&(options.nativeFixture||resolve(base)!==resolve(import.meta.dir,'../../..')))throw Error('recovery remote launch outside the repository controller; no lease issued');
 const repo=resolve(import.meta.dir,'../../..'),runner=join(repo,RECOVERY_SCRIPT);
 const launch=launchObservations(options),permit=issueRecoveryPermit(r,base,launch),paths=recoveryPermitPaths(r,base);
 if(sha(readFileSync(runner))!==permit.runnerSha256)throw Error('recovery runner differs from permit');
 writeFileSync(paths.input,JSON.stringify(r),{flag:'wx'});mkdirSync(paths.output,{recursive:true});
 const child=Bun.spawn([process.execPath,runner,paths.input,paths.output,...(options.nativeFixture?['--permit-base='+base]:[])],{
  cwd:repo,env:{...process.env,WORKER_RELEASE:r.source,WORKER_ENTRY:''},windowsHide:true,stdin:'pipe',
  stdout:Bun.file(join(dirname(paths.input),'worker.log')),stderr:Bun.file(join(dirname(paths.input),'worker.err'))});
 let bindError:unknown;try{bindRecoveryChild(r,child.pid,base,launch);}catch(error){bindError=error;}
 const completion=(async()=>{
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;void safeKill(child.pid,r.nonce);},125000);timer.unref();
  try{
   try{if(!bindError)await child.stdin.write(JSON.stringify({pid:child.pid,nonce:r.nonce,runId:r.runId,source:r.source}));}
   catch(error){bindError??=error;}
   finally{try{await child.stdin.end();}catch(error){bindError??=error;}}
   const code=await child.exited;if(bindError)throw bindError;if(timedOut)throw Error('recovery child deadline; lease held');return finishRecoveryPermit(r,code,base,options);
  }
  finally{clearTimeout(timer);}
 })();
 return {child,completion,paths};
}

export function recoveredSessionForRun(account:string,server:string,runId:string,source:string,base:string):boolean{
 if(! /^[A-Za-z0-9_ -]{1,12}$/.test(account))return false;
 const root=join(base,'.practice/session-lifecycle'),proof=readLogoutProof(account,server,{root});
 if(proof.state!=='confirmed'||proof.ownerRun!==runId)return false;
 const statusFile=join(base,'.practice/status',account+'.json'),status=existsSync(statusFile)?json(statusFile):null;
 if(status?.server===server&&!status.result&&(!Number.isFinite(status.at)||status.at>proof.loggedOutAt))return false;
 const dir=join(base,'.practice/coordinator/session-recovery/accounts',account.toLowerCase());
 if(!existsSync(dir)||existsSync(join(dir,'lease.json')))return false;
 const attempt=listAttempts(account,server,{root}).find(a=>a.attemptId===proof.attemptId);
 if(!attempt?.receipt||attempt.sha256!==proof.receiptSha256||attempt.receipt.owner.script!==RECOVERY_SCRIPT||attempt.receipt.owner.workerRelease!==source)return false;
 for(const nonce of readdirSync(dir)){
  const file=join(dir,nonce,'completed.json');if(!existsSync(file))continue;
  const completed=json(file);
  if(same(completed.request?.account,account)&&completed.request.server===server&&completed.request.runId===runId&&completed.request.source===source
   &&completed.proof?.attemptId===proof.attemptId&&completed.proof.receiptSha256===proof.receiptSha256&&completed.childPid===attempt.receipt.owner.pid){
   const paths=recoveryPermitPaths(completed.request,base),p=json(paths.permit),child=json(paths.child),used=json(paths.used);
   if(resolve(paths.completed)!==resolve(file)||resolve(completed.receiptPath)!==resolve(paths.output,'receipt.json'))return false;
   const raw=readFileSync(completed.receiptPath),r=JSON.parse(raw.toString('utf8'));
   if(p.nativeFixture&&!isLocalServer(server)||!isDeepStrictEqual(p.request,completed.request)||child.pid!==completed.childPid||used.pid!==child.pid
    ||used.nonce!==nonce||used.permitSha256!==sha(readFileSync(paths.permit))||completed.receiptSha256!==sha(raw)
    ||r.state!=='confirmed'||r.logout!=='logged-out'||r.failure||!isDeepStrictEqual(r.request,p.request)||r.lifecycleSha256!==proof.receiptSha256||r.attemptId!==proof.attemptId
    ||r.runnerSha256!==p.runnerSha256||p.runnerSha256!==sha(readFileSync(join(base,RECOVERY_SCRIPT)))||!recoveryStatePreserved(r.before,r.after)
    ||r.scope?.gameplay!==false||r.scope.production!==0||r.scope.repairsFailure!==false||r.scope.qualifiesScript!==false)return false;
   return true;
  }
 }
 return false;
}

// A child that did not confirm preserved cleanup leaves its lease held (finishRecoveryPermit), and assertNoRecoveryLease
// then refuses every later session and recovery of the account. The controller removes only that exact lease: its
// permit has expired, its bound child is gone, and the newest session attempt of the account ends in a confirmed
// logout (readLogoutProof). That attempt must show one of three things:
// - It is the child's own attempt, and the child's receipt names it.
// - `superseded`: a different run made it after the permit was issued. That session got into the account and left it,
//   so the dead child holds nothing.
// - `not-connected`: it is older than the permit, so the account has no attempt from the permit's time. Each session
//   writes its attempt before it connects (openBot), so the child did not connect. The child's receipt, if it wrote
//   one, must say that it did not try to log out.
// Any other evidence keeps the lease. The release writes released.json and keeps the permit, child, used, output, end,
// assignments and stops. It never writes completed.json, so recoveredSessionForRun still refuses this run. A later
// call completes a release that stopped after it wrote released.json.
export type LeaseReleaseChecks={now?:()=>number;matches?:(pid:number,marker:string)=>boolean;childAlive?:(pid:number,nonce:string)=>boolean};
const childRunning=(pid:number,nonce:string)=>{
 try{process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return false;}
 // A reused PID without the child's nonce on its command line is not the child. An unreadable command line counts as live.
 const line=commandLine(pid);return line===null||line.includes(nonce);
};
export function releaseExpiredRecoveryLease(account:string,base:string,options:LeaseReleaseChecks={}){
 if(! /^[A-Za-z0-9_ -]{1,12}$/.test(account))throw Error('invalid recovery lease identity');
 const now=(options.now??Date.now)(),matches=options.matches??processMatchesRecent,alive=options.childAlive??childRunning;
 const owner=json(join(base,'.practice/coordinator/swarm-owner.json'));
 if(owner.pid!==process.pid||typeof owner.nonce!=='string'||!owner.nonce||!matches(owner.pid,owner.nonce))throw Error('recovery lease release needs the controller');
 const leasePath=join(base,'.practice/coordinator/session-recovery/accounts',account.toLowerCase(),'lease.json');
 if(!existsSync(leasePath))throw Error('recovery lease absent');
 const leaseRaw=readFileSync(leasePath),p=JSON.parse(leaseRaw.toString('utf8')),r=p?.request as ControlledRecoveryRequest;
 validateRecoveryRequest(r);if(!same(r.account,account)||r.kind!=='session-recovery')throw Error('recovery lease crossed');
 const paths=recoveryPermitPaths(r,base),leaseSha256=sha(leaseRaw);
 if(!existsSync(paths.permit)||sha(readFileSync(paths.permit))!==leaseSha256||p.schema!=='session-recovery-permit/1')throw Error('recovery lease changed');
 if(p.nativeFixture)assertNativeFixtureRoot(base,r.server);
 if(!Number.isFinite(p.issuedAt)||p.expiresAt!==p.issuedAt+150000||now<p.expiresAt)throw Error('recovery permit not expired');
 assertRecoveryNotStopped(r.account,base);
 const child=existsSync(paths.child)?json(paths.child):null,used=existsSync(paths.used)?json(paths.used):null;
 if(!child||!Number.isSafeInteger(child.pid)||child.pid<1||child.nonce!==r.nonce||child.runId!==r.runId
  ||!used||used.pid!==child.pid||used.nonce!==r.nonce||used.permitSha256!==leaseSha256)throw Error('recovery lease child not bound');
 if(alive(child.pid,r.nonce))throw Error('recovery lease child still alive');
 const root=join(base,'.practice/session-lifecycle'),proof=readLogoutProof(r.account,r.server,{root});
 if(proof.state!=='confirmed')throw Error('recovery lease producer logout not confirmed');
 const attempt=listAttempts(r.account,r.server,{root}).find(a=>a.attemptId===proof.attemptId),a=attempt?.receipt;
 const receiptPath=join(paths.output,'receipt.json'),receipt=existsSync(receiptPath)?json(receiptPath):null;
 if(!a||attempt?.sha256!==proof.receiptSha256)throw Error('recovery lease producer proof mismatched');
 const own=proof.ownerRun===r.runId&&a.owner.pid===child.pid&&a.owner.coordinatorRunId===r.runId
  &&a.owner.workerRelease===r.source&&a.owner.script===RECOVERY_SCRIPT&&a.createdAt>=p.issuedAt&&proof.loggedOutAt>=p.issuedAt
  &&!!receipt&&receipt.logout==='logged-out'&&isDeepStrictEqual(receipt.request,r)&&receipt.runnerSha256===p.runnerSha256
  &&receipt.attemptId===proof.attemptId&&receipt.lifecycleSha256===proof.receiptSha256&&receipt.scope?.gameplay===false&&receipt.scope.production===0;
 const basis=own?null:a.owner.coordinatorRunId!==r.runId&&a.createdAt>=p.issuedAt&&proof.loggedOutAt>=p.issuedAt?'superseded'
  :a.createdAt<p.issuedAt&&proof.loggedOutAt<p.issuedAt&&(!receipt||receipt.logout==='not-attempted')?'not-connected':undefined;
 if(basis===undefined)throw Error('recovery lease producer proof mismatched');
 const released={schema:'session-recovery-release/1',at:now,account:r.account,nonce:r.nonce,runId:r.runId,leaseSha256,childPid:child.pid,
  attemptId:proof.attemptId,lifecycleSha256:proof.receiptSha256,receiptSha256:receipt?sha(readFileSync(receiptPath)):null,...(basis?{basis}:{}),
  controller:{pid:owner.pid,nonce:owner.nonce},scope:{repairsFailure:false,qualifiesScript:false,production:0}};
 // A release that stopped between the marker and the removal leaves released.json beside the lease. That marker must
 // name this exact lease, child and producer proof; only its time and its controller can differ. Then the removal
 // runs again and the first marker stays. A marker that does not parse or does not match keeps the lease.
 const markerPath=join(dirname(paths.permit),'released.json');let marker=released;
 if(existsSync(markerPath)){
  let prior:any;try{prior=json(markerPath);}catch{prior=null;}
  if(!prior||!Number.isFinite(prior.at)||prior.at<p.expiresAt||!Number.isSafeInteger(prior.controller?.pid)||typeof prior.controller.nonce!=='string'
   ||!isDeepStrictEqual({...prior,at:released.at,controller:released.controller},released))throw Error('recovery lease release marker mismatched');
  marker=prior;
 }else writeFileSync(markerPath,JSON.stringify(released),{flag:'wx'});
 if(sha(readFileSync(leasePath))!==leaseSha256)throw Error('recovery lease changed before release');
 unlinkSync(leasePath);return marker;
}
// The controller's sweep: each unmanaged lease either releases or keeps its fixed refusal reason.
export function releaseExpiredRecoveryLeases(base:string,managed:readonly string[]=[],options:LeaseReleaseChecks={}){
 const root=join(base,'.practice/coordinator/session-recovery/accounts'),results:{account:string;released:boolean;reason:string}[]=[];
 if(!existsSync(root))return results;
 for(const account of readdirSync(root)){
  if(managed.some(a=>same(a,account))||!existsSync(join(root,account,'lease.json')))continue;
  try{releaseExpiredRecoveryLease(account,base,options);results.push({account,released:true,reason:'released'});}
  catch(error){results.push({account,released:false,reason:error instanceof Error&&/^recovery |^invalid /.test(error.message)?error.message:'unclassified release error'});}
 }
 return results;
}

// A controller restart must still count an inherited child's resource ownership. It may observe that child,
// but cannot replay its nonce, take over its permit or turn a lost completion into a success.
export function heldRecoveryOwners(base:string,managed:readonly string[]=[],alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=='ESRCH';}},now=Date.now()){
 const root=join(base,'.practice/coordinator/session-recovery/accounts'),held:{account:string;pid:number|null;started:number;source:string|null}[]=[];
 if(!existsSync(root))return held;
 for(const account of readdirSync(root)){
  if(managed.some(a=>same(a,account))||!existsSync(join(root,account,'lease.json')))continue;
  try{
   const permit=json(join(root,account,'lease.json')),r=permit.request as ControlledRecoveryRequest;validateRecoveryRequest(r);
   if(!same(r.account,account))throw Error('crossed lease');const paths=recoveryPermitPaths(r,base);
   const child=existsSync(paths.child)?json(paths.child):null;
   if(child&&(!Number.isSafeInteger(child.pid)||child.pid<1||child.nonce!==r.nonce||child.runId!==r.runId))throw Error('unbound child');
   if(child?alive(child.pid):!Number.isFinite(permit.expiresAt)||permit.expiresAt>now)held.push({account:r.account,pid:child?.pid??null,started:permit.issuedAt,source:r.source});
  }catch{held.push({account,pid:null,started:now,source:null});}
 }
 return held;
}
