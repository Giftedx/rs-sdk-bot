import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {connectInProcess,clientTransportState,observeClientTransport,inProcessRuntimePaths,type Session} from './inprocess';
import {logoutSession,closeWithin,serverFromEnv} from './bot';
import {isLocalServer} from './localserver';
import {readLogoutProof,listAttempts} from './session-lifecycle';
import {workerSourceRevision} from './worker-release';
import {waitUntil} from './ticks';

import {RECOVERY_SCHEMA,RECOVERY_SCRIPT,validateRecoveryRequest,recoveryStatePreserved,consumeRecoveryConnection,spendRecoveryConnection,recoveryPermitPaths,waitForRecoveryChildBinding,assertNativeFixtureRoot,assertRecoveryNotStopped,FLEET_REFUSALS,type RecoveryRequest,type ControlledRecoveryRequest,type RecoveryConnectionAdmission} from './session-recovery-permit';
export {RECOVERY_SCHEMA,RECOVERY_SCRIPT,validateRecoveryRequest,recoveryStatePreserved,type RecoveryRequest};
const repo=resolve(import.meta.dir,'../../..');
const sha=(raw:string|Buffer)=>createHash('sha256').update(raw).digest('hex');
// Closed vocabulary only. Never publish exception text, paths, credentials or environment values.
const setupReasons=new Map([
 ['recovery source changed','source-changed'],['native fixture boundary invalid','fixture-boundary'],
 ['recovery child not bound','child-unbound'],['recovery child identity changed','child-changed'],
 ['recovery controller owner changed','controller-changed'],['recovery task owner changed','task-owner-changed'],
 ['recovery task authorization missing','task-authorization'],['recovery request lease changed','request-lease-changed'],
 ['recovery exact failure changed','failure-changed'],['recovery assignment is active or reserved','assignment-held'],
 ['recovery completed assignment is not ordinary retired work','completed-assignment'],
 ['recovery completed account has an open hold','completed-hold'],['recovery completed mission unavailable','completed-mission'],
 ['recovery completed work needs a different mission','completed-same-mission'],['recovery completed account already has producer history','completed-history'],
 ['recovery completed end or mission changed','completed-changed'],['recovery completed producer ownership changed','completed-owner'],
 ['recovery fleet ownership unresolved','fleet-unresolved'],...FLEET_REFUSALS.map(f=>['recovery fleet ownership unresolved: '+f,'fleet-'+f] as const),
 ['recovery account has an active external observation','external-owner'],
 ['recovery lifecycle ownership malformed','lifecycle-malformed'],['recovery orphan owner unknown','orphan-unknown'],
 ['recovery previous session owner still alive','previous-owner-alive'],['recovery owner stopped','owner-stopped'],
 ['recovery permit expired or changed','permit-changed'],['recovery connection admission expired','admission-expired'],
 ['recovery nonce already consumed','nonce-consumed'],['recovery consumption marker changed','consumption-changed'],
 ['recovery account server mismatch','server-mismatch'],['recovery credential unavailable','credential-unavailable'],
 ['recovery child paths are not controller-owned','child-paths'],['nonlocal permit root override refused','remote-root'],
 ['live authenticated recovery is not qualified; no connection attempted','remote-unqualified'],
 ['invalid or protected session recovery request','request-invalid'],
]);
export const RECOVERY_SETUP_PHASES=['arguments','request-read','request-validation','remote-authority','source',
 'fixture-root','child-paths','child-binding','permit-read','permit-consumption','stop','credentials-read',
 'server-selection','credential-selection','output-request','session','output-receipt','deadline'] as const;
type SetupPhase=(typeof RECOVERY_SETUP_PHASES)[number];
class RecoveryBoundaryError extends Error{
 constructor(readonly phase:SetupPhase,readonly reason:string){super('recovery boundary held');}
}
export async function recoveryBoundary<T>(phase:SetupPhase,operation:()=>T|Promise<T>):Promise<T>{
 try{return await operation();}catch(error){
  if(error instanceof RecoveryBoundaryError)throw error;
  const code=(error as NodeJS.ErrnoException)?.code;
  const reason=setupReasons.get(error instanceof Error?error.message:'')
   ??(['ENOENT','EEXIST','EACCES','EPERM'].includes(code??'')?'io-'+code!.toLowerCase():'unresolved');
  throw new RecoveryBoundaryError(phase,reason);
 }
}
export function recoveryHeldDiagnostic(error:unknown){
 return {schema:'session-recovery-diagnostic/1',state:'held',phase:error instanceof RecoveryBoundaryError?error.phase:'arguments',
  reason:error instanceof RecoveryBoundaryError?error.reason:'unresolved',authorizesConnection:false,producerReceipt:false};
}
export function recoveryDiagnosticFromLog(log:string){
 const reasons=new Set([...setupReasons.values(),'unresolved','io-enoent','io-eexist','io-eacces','io-eperm','outer-deadline']);
 for(const line of log.split(/\r?\n/))if(line.startsWith('RECOVERY_HELD ')&&line.length<1024){
  try{const d=JSON.parse(line.slice('RECOVERY_HELD '.length));
   if(d?.schema==='session-recovery-diagnostic/1'&&d.state==='held'&&RECOVERY_SETUP_PHASES.includes(d.phase)&&reasons.has(d.reason)
    &&d.authorizesConnection===false&&d.producerReceipt===false)return {phase:d.phase as SetupPhase,reason:d.reason as string};
  }catch{/* Legacy or malformed diagnostics remain unknown; never copy arbitrary text. */}
 }
 return null;
}
export function recoverySnapshot(state:any){
 if(!state?.inGame||!state.player?.name)throw Error('recovery has no authenticated player observation');
 return structuredClone({player:{name:state.player.name,x:state.player.worldX,z:state.player.worldZ,level:state.player.level,hp:state.player.hp},
  // BotSDK wraps the skills array in a name-lookup Proxy. Copy its actual rows before structuredClone.
  inventory:state.inventory,equipment:state.equipment,skills:Array.from(state.skills,(skill:any)=>({...skill})),
  bank:state.bank?.isOpen?state.bank.items:null,modalOpen:state.modalOpen,modalInterface:state.modalInterface});
}
export const recoveryReady=(s:Session)=>waitUntil(s,st=>st?.inGame&&!!st.player&&st.player.hp>0,{timeoutTicks:100,idleMs:10000});
// Read-only diagnostic of the pinned LiteClient accept-button scan (clientCode 326).
// Never include arbitrary action messages, client objects or exception text.
export function recoveryModalObservation(s:Session){
 const state=s.sdk.getState(),client=s.client as {mainModalId?:number;interfaces?:{list?:{clientCode?:number;layerId?:number}[]}}|undefined;
 const integer=(value:unknown)=>Number.isSafeInteger(value)?value as number:null;
 const modal=integer(client?.mainModalId),candidates:{id:number;layerId:number|null}[]=[];
 client?.interfaces?.list?.forEach((com,id)=>{if(com?.clientCode===326)candidates.push({id,layerId:integer(com.layerId)});});
 const preferred=modal!==null&&modal!==-1?candidates.find(c=>c.layerId===modal||c.id===modal):undefined;
 return {tick:integer(s.tick()),inGame:state?.inGame===true,modalOpen:typeof state?.modalOpen==='boolean'?state.modalOpen:null,
  modalInterface:integer(state?.modalInterface),clientModal:modal,candidates,
  predictedAccept:(preferred??candidates[0])?.id??null,selection:preferred?'modal':candidates.length?'fallback':'none'};
}
// Read-only wire trace of one cleanup dispatch: the client design values, the bytes the action queued
// (opcodes are ISAAC-encoded; only the fixed payloads are plain) and the server opcodes that followed.
export function recoveryWireTrace(s:Session){
 const client=s.client as {out?:{data?:unknown;pos?:unknown};packetsReceived?:unknown;ptype0?:unknown;activate?:()=>void;
  designGender?:unknown;designKits?:unknown;designColours?:unknown}|undefined;
 const integer=(value:unknown)=>Number.isSafeInteger(value)?value as number:null;
 const bytes=(value:unknown,length:number)=>Array.isArray(value)&&value.length===length&&value.every(v=>Number.isSafeInteger(v))?[...value] as number[]:null;
 const start=integer(client?.out?.pos),incoming:{tick:number|null;opcode:number}[]=[];
 let seen=integer(client?.packetsReceived);
 // The lite dispatcher activates the client after it records ptype0 for each received packet.
 const original=client?.activate,own=!!client&&Object.prototype.hasOwnProperty.call(client,'activate');
 if(client&&typeof original==='function')client.activate=function(this:unknown){
  try{const n=integer(client.packetsReceived),op=integer(client.ptype0);
   if(n!==null&&n!==seen&&op!==null&&incoming.length<64){seen=n;incoming.push({tick:integer(s.tick()),opcode:op});}}
  catch{/* Tracing cannot change packet dispatch. */}
  return original.apply(this);
 };
 return {
  design:()=>({gender:typeof client?.designGender==='boolean'?client.designGender:null,kits:bytes(client?.designKits,7),colours:bytes(client?.designColours,5)}),
  outgoing(){
   const out=client?.out,end=integer(out?.pos);
   if(start===null||end===null||!(out?.data instanceof Uint8Array)||end<start)return null;
   const b=Array.from(out.data.subarray(start,end));
   // IDK_SAVEDESIGN (1+13) followed by IF_BUTTON (1+2).
   return b.length===17?{length:17,gender:b[1],kits:b.slice(2,9),colours:b.slice(9,14),button:(b[15]!<<8)|b[16]!}:{length:b.length};
  },
  incoming:()=>incoming.map(r=>({...r,ifClose:r.opcode===23,ifOpenMain:r.opcode===119})),
  restore(){if(!client||typeof original!=='function')return;if(own)client.activate=original;else delete client.activate;},
 };
}
// Pinned content/pack/idk.pack and scripts/player/configs/{man,woman}.idk:
// enabled inclusive ranges in hair, jaw, torso, arms, hands, legs, feet order.
// IdkSaveDesignHandler permits -1 only for the female jaw (encoded as 255).
const recoveryDesignKits=[
 [[0,8],[10,17],[18,25],[26,31],[33,34],[36,40],[42,43]],
 [[45,54],[-1,-1],[56,60],[61,65],[67,68],[70,77],[79,80]],
] as const;
// engine/src/engine/entity/Player.ts DESIGN_BODY_COLORS lengths.
const recoveryDesignColours=[12,16,16,6,8] as const;
function prepareRecoveryDesign(s:Session){
 const client=s.client as {designGender?:boolean;designKits?:number[];designColours?:number[]}|undefined;
 if(!client)return;
 if(typeof client.designGender!=='boolean')client.designGender=true;
 const ranges=recoveryDesignKits[client.designGender?0:1];
 const kits=client.designKits;
 const validKit=(id:unknown,i:number)=>Number.isInteger(id)&&Number(id)>=ranges[i]![0]&&Number(id)<=ranges[i]![1];
 if(!Array.isArray(kits)||kits.length!==7||ranges.some((_,i)=>!validKit(kits[i],i)))
  client.designKits=ranges.map(([first],i)=>validKit(kits?.[i],i)?kits![i]!:first);
 const colours=client.designColours;
 const validColour=(id:unknown,i:number)=>Number.isInteger(id)&&Number(id)>=0&&Number(id)<recoveryDesignColours[i]!;
 if(!Array.isArray(colours)||colours.length!==5||recoveryDesignColours.some((_,i)=>!validColour(colours[i],i)))
  client.designColours=recoveryDesignColours.map((_,i)=>validColour(colours?.[i],i)?colours![i]!:0);
}
// The client can replay buffered ticks before the server's closure response arrives, so a tick count
// cannot bound this wait. Only an observed closed modal passes. The budget or session end refuses.
export const RECOVERY_MODAL_BUDGET_MS=2000;
function observeModalClosed(s:Session,observe:()=>void,budgetMs:number){
 return new Promise<boolean>((resolve,reject)=>{
  let done=false,off=()=>{},timer:ReturnType<typeof setTimeout>|undefined;
  const finish=(closed:boolean,error?:unknown)=>{
   if(done)return;done=true;off();clearTimeout(timer);
   if(error===undefined)resolve(closed);else reject(error);
  };
  const check=()=>{
   if(done)return;
   try{observe();const st=s.sdk.getState();if(st&&!st.modalOpen)finish(true);}catch(error){finish(false,error);}
  };
  check();if(done)return;
  off=s.onTick(check);
  timer=setTimeout(()=>finish(false),budgetMs);
  void s.ended?.then(()=>finish(false),()=>finish(false));
 });
}
export async function recoveryCloseModal(s:Session,budgetMs=RECOVERY_MODAL_BUDGET_MS){
 // player_kit closes through its Accept button; CLOSE_MODAL leaves the design screen open.
 const state=s.sdk.getState();
 const action=state?.modalOpen&&state.modalInterface===3559
  ?{type:'acceptCharacterDesign'}:{type:'closeModal',reason:'session recovery'};
 const record=(phase:string,detail:object={})=>{
  try{console.log('RECOVERY_MODAL '+JSON.stringify({phase,action:action.type,at:Date.now(),...recoveryModalObservation(s),...detail}));}
  catch{/* Observation cannot change the cleanup result or session ownership. */}
 };
 let trace:ReturnType<typeof recoveryWireTrace>|undefined;
 try{trace=recoveryWireTrace(s);}catch{trace=undefined;}
 const wire=(detail:()=>object)=>{try{return trace?detail():{};}catch{return {};}};
 record('before-dispatch',wire(()=>({design:trace!.design()})));
 try{
  if(action.type==='acceptCharacterDesign'){
   prepareRecoveryDesign(s);
   record('design-prepared',wire(()=>({design:trace!.design()})));
  }
  try{
   const pending=s.direct(action);
   // The action writes its packets synchronously; read them before the session loop flushes.
   const sent=wire(()=>({outgoing:trace!.outgoing()}));
   const result=await pending as {success?:unknown}|null|undefined;
   record('dispatch-returned',{success:typeof result?.success==='boolean'?result.success:null,...sent});
  }catch(error){record('dispatch-threw');throw error;}
  // direct queues bytes without flushing; the session loop can still be awaiting packet pumping.
  // Send cleanup before waiting for its effect. LiteClient.flush preserves the client's receiver.
  const flushBefore=clientTransportState(s.client);
  (s.client as {flush?:()=>void}|undefined)?.flush?.();
  record('flushed',{transportBefore:flushBefore,transportAfter:clientTransportState(s.client)});
  try{
   const closed=await observeModalClosed(s,()=>record('observed'),budgetMs);
   record('finished',{closed,...wire(()=>({incoming:trace!.incoming()}))});return closed;
  }catch(error){record('observation-threw',wire(()=>({incoming:trace!.incoming()})));throw error;}
 }finally{try{trace?.restore();}catch{/* Restoration failure cannot replace the cleanup result. */}}
}
type RecoveryDeps={
 connect:()=>Promise<Session>;ready:(session:Session)=>Promise<boolean>;closeModal:(session:Session)=>Promise<boolean>;
 logout:(session:Session)=>Promise<string>;close:(session:Session)=>Promise<void>;root:string;
 guard:()=>void;log?:(line:string)=>void;now?:()=>number;
 // From consumeRecoveryConnection only. Required for any nonlocal server; spent once, before the connection.
 admission?:RecoveryConnectionAdmission;
};
// This component never repairs a failure or qualifies a gameplay script. The caller still owns the account.
// A direct caller without a controller admission stays local-only.
export async function recoverSession(request:RecoveryRequest,deps:RecoveryDeps){
 validateRecoveryRequest(request);
 if(deps.admission!==undefined)spendRecoveryConnection(deps.admission,request);
 else if(!isLocalServer(request.server))throw Error('live authenticated recovery is not qualified; no connection attempted');
 deps.guard();
 const now=deps.now??Date.now,startedAt=now();let session:Session|undefined,before:ReturnType<typeof recoverySnapshot>|undefined,after:typeof before;
 let logout='not-attempted',failure='',phase='connect';
 const log=deps.log??console.log;
 try{
  session=await deps.connect();phase='ready';
  if(!await deps.ready(session))throw Error('not ready');
  phase='snapshot';before=recoverySnapshot(session.sdk.getState());phase='identity';
  if(before.player.name.toLowerCase()!==request.account.toLowerCase()||session.name.toLowerCase()!==request.account.toLowerCase())throw Error('identity mismatch');
  if(!session.lifecycle||session.lifecycle.account.toLowerCase()!==request.account.toLowerCase()||session.lifecycle.server!==request.server)throw Error('producer identity mismatch');
  if(!session.lifecycle.record('ready','authenticated recovery observation'))throw Error('ready receipt not persisted');
  log('RECOVERY_SESSION '+JSON.stringify({account:request.account,server:request.server,attemptId:session.lifecycle.attemptId,runId:request.runId,pid:process.pid,source:request.source}));
  phase='cleanup';deps.guard();
  if(before.modalOpen&&!await deps.closeModal(session))throw Error('modal cleanup unresolved');
  after=recoverySnapshot(session.sdk.getState());
  if(!recoveryStatePreserved(before,after))throw Error('observed state changed');
 }catch{
  // Do not echo connection errors: they can contain credentials. The producer retains redacted diagnostics.
  failure=phase+' failed or unresolved';
 }finally{
  if(session){
   try{
    const outcome=await deps.logout(session);
    // Core logout errors can be returned as strings. Never echo or persist arbitrary diagnostic text.
    logout=['logged-out','timeout','disconnected'].includes(outcome)?outcome:'unconfirmed';
    log('RECOVERY_LOGOUT '+logout);
   }catch{failure||='logout failed';logout='error';}
   try{await deps.close(session);}catch{failure||='close failed';}
  }
 }
 const proof=readLogoutProof(request.account,request.server,{root:deps.root});
 const attempts=listAttempts(request.account,request.server,{root:deps.root}).filter(a=>a.receipt?.owner.coordinatorRunId===request.runId&&a.receipt.createdAt>=startedAt);
 const attempt=attempts.length===1?attempts[0]:undefined;
 const bound=attempt?.receipt&&attempt.receipt.owner.script===RECOVERY_SCRIPT&&attempt.receipt.owner.workerRelease===request.source
  &&attempt.receipt.owner.pid===process.pid&&attempt.receipt.account.toLowerCase()===request.account.toLowerCase()
  &&attempt.receipt.server===request.server&&session?.lifecycle?.attemptId===attempt.attemptId;
 const confirmed=!failure&&logout==='logged-out'&&bound&&proof.state==='confirmed'&&proof.attemptId===attempt.attemptId&&proof.receiptSha256===attempt.sha256;
 const receipt={schema:RECOVERY_SCHEMA,state:confirmed?'confirmed':'held',request,startedAt,endedAt:now(),attemptId:attempt?.attemptId??null,
  lifecycleSha256:attempt?.sha256??null,proof,before:before??null,after:after??null,logout,failure:failure||(!confirmed?'producer outcome not bound and confirmed':''),
  scope:{gameplay:false,production:0,repairsFailure:false,qualifiesScript:false,bankObservation:before?.bank==null?'unobserved':'client-only'},
  runnerSha256:sha(readFileSync(import.meta.path))};
 log('RECOVERY_RESULT '+JSON.stringify({state:receipt.state,account:request.account,attemptId:receipt.attemptId,gameplay:false,repairsFailure:false}));
 return receipt;
}
async function cli(){
 const requestPath=process.argv[2],out=process.argv[3];
 await recoveryBoundary('arguments',()=>{if(!requestPath||!out)throw Error('missing arguments');});
 const request=await recoveryBoundary('request-read',()=>JSON.parse(readFileSync(requestPath!,'utf8')));
 await recoveryBoundary('request-validation',()=>validateRecoveryRequest(request));
 const controlled='kind' in request&&request.kind==='session-recovery';
 // Only a controller-issued, native-qualified permit admits a nonlocal connection.
 await recoveryBoundary('remote-authority',()=>{if(!controlled&&!isLocalServer(request.server))throw Error('live authenticated recovery is not qualified; no connection attempted');});
 await recoveryBoundary('source',()=>{if(request.source!==workerSourceRevision())throw Error('recovery source changed');});
 process.env.BOT_GOAL=RECOVERY_SCRIPT;process.env.BOT_ROLE='recovery';process.env.COORDINATOR_RUN_ID=request.runId;process.env.WORKER_RELEASE=request.source;
 let guard=()=>assertRecoveryNotStopped(request.account,repo),admission:RecoveryConnectionAdmission|undefined;
 let lifecycleRoot=join(repo,'.practice/session-lifecycle');
 if(controlled){
  // A fixture may own an isolated state tree only on a local server. Remote setup always uses this repository.
  const override=process.argv.find(a=>a.startsWith('--permit-base='))?.slice('--permit-base='.length);
  await recoveryBoundary('fixture-root',()=>{if(override&&!isLocalServer(request.server))throw Error('nonlocal permit root override refused');});
  const base=override?resolve(override):repo,paths=recoveryPermitPaths(request,base);
  await recoveryBoundary('fixture-root',()=>{if(override)assertNativeFixtureRoot(base,request.server);});
  await recoveryBoundary('child-paths',()=>{if(resolve(requestPath!)!==resolve(paths.input)||resolve(out!)!==resolve(paths.output))throw Error('recovery child paths are not controller-owned');});
  await recoveryBoundary('child-binding',()=>waitForRecoveryChildBinding(request as ControlledRecoveryRequest,base,Bun.stdin.stream()));
  const permit=await recoveryBoundary('permit-read',()=>JSON.parse(readFileSync(paths.permit,'utf8')));
  await recoveryBoundary('fixture-root',()=>{if(permit.nativeFixture===true){assertNativeFixtureRoot(base,request.server);lifecycleRoot=join(base,'.practice/session-lifecycle');}});
  ({guard,admission}=await recoveryBoundary('permit-consumption',()=>consumeRecoveryConnection(request as ControlledRecoveryRequest,base,{source:()=>workerSourceRevision(),nativeFixture:permit.nativeFixture===true})));
 }
 await recoveryBoundary('stop',guard);
 const env=await recoveryBoundary('credentials-read',()=>readFileSync(join(repo,'vendor/rs-sdk/bots',request.account,'bot.env'),'utf8'));
 await recoveryBoundary('server-selection',()=>{if(serverFromEnv(env)!==request.server)throw Error('recovery account server mismatch');});
 const password=await recoveryBoundary('credential-selection',()=>{const value=env.match(/^PASSWORD=(.*)$/m)?.[1]?.trim();if(!value)throw Error('recovery credential unavailable');return value;});
 await recoveryBoundary('output-request',()=>{mkdirSync(out!,{recursive:true});writeFileSync(join(out!,'request.json'),JSON.stringify(request,null,2),{flag:'wx'});});
 try{console.log('RECOVERY_RUNTIME '+JSON.stringify({at:Date.now(),pid:process.pid,bun:Bun.version,runner:import.meta.path,...inProcessRuntimePaths()}));}catch{/* Observation only. */}
 const timer=setTimeout(()=>{console.error('RECOVERY_HELD '+JSON.stringify(recoveryHeldDiagnostic(new RecoveryBoundaryError('deadline','outer-deadline'))));process.exit(1);},120000);timer.unref();
 const receipt=await recoveryBoundary('session',()=>recoverSession(request,{root:lifecycleRoot,guard,...(admission?{admission}:{}),
  connect:async()=>{
   const s=await connectInProcess({name:request.account,password,server:request.server,beforeConnect:guard,...(lifecycleRoot!==join(repo,'.practice/session-lifecycle')?{lifecycleRoot}:{})});
   // Through cleanup and logout: client write times and lengths, never payloads.
   observeClientTransport(s.client,row=>console.log('RECOVERY_TRANSPORT '+JSON.stringify(row)),{tick:()=>s.tick()});
   return s;
  },
  ready:recoveryReady,closeModal:recoveryCloseModal,
  logout:logoutSession,close:async s=>{const r=await closeWithin([s],5000);if(r.timedOut)throw Error('close timed out');}}));
 clearTimeout(timer);await recoveryBoundary('output-receipt',()=>writeFileSync(join(out!,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx'}));process.exitCode=receipt.state==='confirmed'?0:1;
}
if(import.meta.main)cli().catch(error=>{console.error('RECOVERY_HELD '+JSON.stringify(recoveryHeldDiagnostic(error)));process.exitCode=1;});
