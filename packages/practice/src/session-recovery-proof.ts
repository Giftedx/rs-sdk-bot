// Native controller recovery proof (gate native-session-recovery). Practice only, never game production.
// A private SQLite/LoginServer/World with fresh test keys, private saves and immutable-content junctions. Every
// recovery goes through the SAME createRecoveryDispatch, swarm admitRecovery policy, launchPermittedRecovery,
// core session-recovery CLI, per-account producer and finishRecoveryPermit that the swarm uses. Raw records and
// proof.json go to DELIVERY_DIR. On success it prints exactly one RECOVERY_NATIVE_PROOF {path,sha256} line.
import {Database} from 'bun:sqlite';
import {appendFileSync,closeSync,copyFileSync,cpSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,rmdirSync,statSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {freemem} from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {EventEmitter} from 'node:events';
import {RECOVERY_SCRIPT,NATIVE_RECOVERY_CHECKS,assertFleetResolved,launchPermittedRecovery,recoveryPermitPaths,heldRecoveryOwners,recoveredSessionForRun,verifyNativeRecoveryProof,type ControlledRecoveryRequest} from '../../core/src/session-recovery-permit';
import {createRecoveryDispatch} from '../../core/src/session-recovery-dispatch';
import {recoverSession,recoveryDiagnosticFromLog} from '../../core/src/session-recovery';
import {accountDir,domainOf,readLogoutProof,listAttempts,beginSessionAttempt} from '../../core/src/session-lifecycle';
import {workerSourceRevision} from '../../core/src/worker-release';
import {admitRecovery,startable,applyEndRepair} from '../../../scripts/swarm';
import {missionSignature} from '../../core/src/session-admission';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {canBind} from './ports';
import {killTree,safeKill} from './proc';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import { FREE_FLOOR_GB,PRACTICE_STARTUP_GB } from '../../core/src/memory';

const root=resolve(import.meta.dir,'../../..'),engine=join(root,'vendor/rs-sdk/server/engine'),runner=join(root,RECOVERY_SCRIPT);
const HOST='localhost:8890',RELAY='localhost:8899',LOGIN_PORT=43650,PORTS=[8890,8896,8897,8899,43650,43651];
const CONTROLLER_MARKER='packages/practice/src/session-recovery-proof.ts';
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex'),hash=(p:string)=>sha(readFileSync(p));
type Save=ReturnType<typeof readPracticeSave>;

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
 const report=JSON.parse(readFileSync(join(base,'.practice/supervision-session-admission-20261029/result.json'),'utf8')).routerCompletedAccountIntegration;
 const paths=['packages/router/src/coordinator-live.ts','packages/router/test/coordinator-recovery.test.ts'];
 if(!report||!Array.isArray(report.files)||report.files.length!==paths.length)throw Error('completed router integration pins missing');
 for(const path of paths){const ref=report.files.find((f:any)=>f.path===path);if(!ref||hash(join(base,path))!==ref.sha256)throw Error('completed router integration drift: '+path);}
 return report.files as {path:string;sha256:string}[];
}
export function verifyCompletedRecoveryDelivery(directory:string){
 const proof=JSON.parse(readFileSync(join(directory,'proof.json'),'utf8'));
 if(proof.capability!=='cow-progress-order'||!isDeepStrictEqual(proof.routerPins,verifyCompletedRouterPins()))throw Error('completed recovery delivery integration changed');
 verifyNativeRecoveryProof(proof,directory,{runtimeRevision:workerSourceRevision(),runnerSha256:hash(runner)});
 return true;
}

// The stalled relay accepts only after beginSessionAttempt returns with both files published.
// Subscribe before starting the owner so a fast handshake cannot be missed.
export async function afterStalledConnection<T>(events:EventEmitter,start:()=>Promise<T>,budgetMs=30000):Promise<T>{
 let accept!:()=>void;
 const accepted=new Promise<void>(resolve=>{accept=resolve;});
 events.once('stalled',accept);
 let timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('stalled connection acceptance timeout')),budgetMs);});
 try{
  const [owner]=await Promise.race([Promise.all([Promise.resolve().then(start),accepted]),deadline]);
  return owner;
 }finally{clearTimeout(timer);events.off('stalled',accept);}
}

// Keep the FIRST reader result. Later file bytes cannot replace invalid evidence.
// The receipt-before-latest publication interval is invalid for admission, never logout.
export function observePartialOwner(account:string,server:string,lifecycleRoot:string,ownerPid:number){
 const order:{step:string;at:number}[]=[];
 const mark=(step:string)=>{order.push({step,at:Date.now()});};
 mark('listAttempts:start');
 const attempts=listAttempts(account,server,{root:lifecycleRoot});
 mark('listAttempts:end');
 // No extra file read between the original readiness query and its classification.
 mark('readLogoutProof:start');const proof=readLogoutProof(account,server,{root:lifecycleRoot});mark('readLogoutProof:end');
 const selected=attempts.filter(a=>a.receipt?.owner.pid===ownerPid);
 const dir=accountDir(account,server,lifecycleRoot);
 const inspect=(path:string)=>{
  let bytes:Buffer;
  try{bytes=readFileSync(path);}catch(e:any){return {state:e?.code==='ENOENT'?'missing':'unreadable',sha256:null,identity:null};}
  const sha256=sha(bytes);let v:any;
  try{v=JSON.parse(bytes.toString('utf8'));}catch{return {state:'malformed',sha256,identity:null};}
  // Allowlist fields. Never retain raw connection errors, owner labels or secret fields.
  const identity=v&&typeof v==='object'?Object.fromEntries(['schema','account','server','domain','attemptId','at'].filter(k=>typeof v[k]==='string'||typeof v[k]==='number').map(k=>[k,v[k]])):null;
  return {state:'read',sha256,identity};
 };
 mark('latestAfter:start');const latestAfter=inspect(join(dir,'latest.json'));mark('latestAfter:end');
 const receiptsAfter=selected.map(a=>{mark('receiptAfter:start');const value=inspect(join(dir,'attempts',a.attemptId+'.json'));mark('receiptAfter:end');return {attemptId:a.attemptId,...value};});
 mark('ownerAlive:start');let ownerAlive:boolean|null=null;
 try{process.kill(ownerPid,0);ownerAlive=true;}catch(e:any){if(e?.code==='ESRCH')ownerAlive=false;}
 mark('ownerAlive:end');
 const safeAttempts=attempts.map(a=>({attemptId:a.attemptId,sha256:a.sha256,receipt:a.receipt?{
  account:a.receipt.account,server:a.receipt.server,domain:a.receipt.domain,attemptId:a.receipt.attemptId,
  ownerPid:a.receipt.owner.pid,createdAt:a.receipt.createdAt,updatedAt:a.receipt.updatedAt,eventKinds:a.receipt.events.map(e=>e.kind),
 }:null}));
 const checks={ownerIntentVisible:selected.length===1,ownerAlive:ownerAlive===true,
  held:proof.state==='held',beforeStart:proof.state==='held'&&/before START/.test(proof.reason),
  matchingAttempt:proof.state==='held'&&selected.length===1&&proof.attemptId===selected[0]!.attemptId,
  matchingIdentity:selected.length===1&&selected[0]!.receipt!.account.toLowerCase()===account.toLowerCase()&&selected[0]!.receipt!.server===server&&selected[0]!.receipt!.domain===domainOf(server)};
 return {account,server,domain:domainOf(server),ownerPid,ownerAlive,order,attempts:safeAttempts,proof,latestAfter,receiptsAfter,checks,
  // This remains diagnostic: post-read files are explicitly not an atomic snapshot of the proof.
  ownerIntentVisible:selected.length>0};
}

// An absent empty container and a present empty container hold the same stock. Every nonempty slot counts.
export const stockOf=(s:Pick<Save,'inventories'>)=>Object.fromEntries(Object.entries(s.inventories).filter(([,items])=>items.length));
export function reconcileSaves(before:Save,after:Save,position=before.position){
 return {inventories:isDeepStrictEqual(stockOf(before),stockOf(after)),skills:isDeepStrictEqual(before.skills,after.skills),position:isDeepStrictEqual(position,after.position)};
}
// Negative controls: a reconciler that cannot see one lost coin, one gained coin, a skill change or a moved tile is broken.
export function reconcileNegativeControls(before:Save,after:Save){
 const lost=structuredClone(after),gained=structuredClone(after),skill=structuredClone(after),moved=structuredClone(after);
 const slot=Object.values(lost.inventories).find(items=>items.length)?.[0];if(slot)slot.count--;
 gained.inventories[94]=[...(gained.inventories[94]??[]),{slot:99,id:995,count:1}];
 if(skill.skills[0])(skill.skills[0] as any).level=((skill.skills[0] as any).level??0)+1;
 moved.position={...moved.position,x:moved.position.x+1};
 const fails=(v:Save)=>Object.values(reconcileSaves(before,v)).some(ok=>!ok);
 return {lostItem:!!slot&&fails(lost),gainedItem:fails(gained),skillChange:fails(skill),moved:fails(moved)};
}
export const CHECK_CASES:Record<(typeof NATIVE_RECOVERY_CHECKS)[number],string[]>={
 offline:['offline'],orphan:['orphan'],modal:['modal'],authFailure:['auth-failure'],cooldown:['cooldown'],partial:['partial'],timeout:['timeout'],
 lateCallback:['restart-late-callback'],ownership:['ownership','partial-owner-alive'],stop:['stop'],singleUse:['single-use','restart-late-callback'],
 stock:['offline','orphan','modal','partial','stock-negative-controls'],
 completed:['completed','completed-refusals'],
};
// Each check is derived from observed cases. A check passes only when every named case was observed and passed.
export function deriveChecks(cases:{id:string;ok:boolean;level:string;evidence:{path:string;sha256:string}[]}[]){
 const byId=new Map(cases.map(c=>[c.id,c]));
 return Object.fromEntries(NATIVE_RECOVERY_CHECKS.map(key=>{
  const rows=CHECK_CASES[key].map(id=>byId.get(id));
  const ok=rows.every(r=>r?.ok===true&&/^native-/.test(r.level)&&r.evidence.length>0);
  return [key,{ok,level:ok?[...new Set(rows.map(r=>r!.level))].join('+'):'missing',cases:CHECK_CASES[key],evidence:rows.flatMap(r=>r?.evidence.slice(0,1)??[])}];
 }));
}
// Source decision: retained uZIWUW ownership failure + vendor/rs-sdk/server/engine/src/server/login/
// {LoginServer,LoginClient}.ts and src/3rdparty/ws-sync/ws-sync.js -> installed core recovery CLI proof:
// adapt request attribution, not admission. Acceptance: retained-sequence regressions and all five native gates.
// LoginServer sends response 0 for BOTH login and logout on a persistent world/login connection.
// Record only protocol identity, never messages or save/secret fields.
// Keep this function self-contained: its JS is used as the practice LoginServer preload.
export function installAuthObserver(Server:any,write:(line:string)=>void=(line)=>console.log(line),now:()=>number=Date.now){
 const original=Server.prototype.emit,seen=new WeakSet<object>();let connections=0,count=0,overflow=false,healthy=true,sealed=false;
 const log=(kind:string,row:object)=>{
  if(sealed){healthy=false;kind='AUTH_ERROR';row={code:'after-seal'};}
  try{if(count++<8192||kind==='AUTH_SEALED')write(kind+' '+JSON.stringify({at:now(),...row}));else if(!overflow){overflow=true;healthy=false;write('AUTH_ERROR '+JSON.stringify({at:now(),code:'record-limit'}));}}catch{healthy=false;/* original protocol still runs; final seal refuses */}
 };
 const id=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(v)||typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
 Server.prototype.emit=function(event:unknown,...args:any[]){
  if(event==='connection'&&args[0]&&!seen.has(args[0])){
   const socket=args[0];seen.add(socket);const connection=++connections;
   log('AUTH_CONNECTION',{connection});
   try{
    const emit=socket.emit,send=socket.send;
    if(typeof emit!=='function'||typeof send!=='function')throw Error();
    socket.emit=function(event:unknown,...values:any[]){
     if(event==='message')try{
      const m=JSON.parse(String(values[0]));
      if(!m||typeof m!=='object')throw Error();
      if(m.type==='player_login'||m.type==='player_logout'||m.replyTo!==undefined){
       if(!id(m.replyTo)||!['player_login','player_logout'].includes(m.type)||typeof m.username!=='string'||!(/^[a-zA-Z0-9]{1,12}$/).test(m.username))throw Error();
       log('AUTH_REQUEST',{connection,replyTo:m.replyTo,type:m.type,account:m.username.toLowerCase()});
      }
     }catch{log('AUTH_ERROR',{connection,code:'request-shape'});}
     return Reflect.apply(emit,this,[event,...values]);
    };
    socket.send=function(...values:any[]){
     try{const r=JSON.parse(String(values[0]));if(!r||!id(r.replyTo)||!Number.isInteger(r.response))throw Error();
      log('AUTH_REPLY',{connection,replyTo:r.replyTo,response:r.response});
     }catch{log('AUTH_ERROR',{connection,code:'reply-shape'});}
     return Reflect.apply(send,this,values);
    };
   }catch{log('AUTH_ERROR',{connection,code:'install'});}
  }
  return Reflect.apply(original,this,[event,...args]);
 };
 log('AUTH_READY',{schema:1});
 return {seal(){log('AUTH_SEALED',{records:count,healthy});sealed=true;}};
}
// Read-only world dispatch observer for the modal case. Source: pinned NetworkPlayer.ts decodeIn/read (decoded
// opcodes per tick), IfButtonHandler.ts (component checks, protected executeScript) and Player.ts runScript
// (-1 = no protected access). It records component and player state, never message payloads or save fields.
// Keep this function self-contained: its JS is used as the practice world preload.
// While a player's main modal is open it also records, with wall-clock times: each websocket message the world
// buffers for that player (pinned web/websocket.ts message -> ClientSocket.buffer; length only) and each tick's
// decode read (available bytes). This separates a missing client write, a transport delay and a world scheduling delay.
export function installButtonObserver(m:{NetworkPlayer:any;IfButtonHandler:any;IdkSaveDesignHandler:any;Component:any;Repository:any;World:any;WSClientSocket?:any},write:(line:string)=>void=(line)=>console.log(line),now:()=>number=Date.now){
 // IDK_SAVEDESIGN, IF_BUTTON, CLOSE_MODAL
 const watch=[27,86,93],live=new Set<string>();let count=0,wireCount=0,decoding:{packets:number[]}|null=null,button:{runs:object[]}|null=null;
 const int=(v:unknown)=>Number.isSafeInteger(v)?v as number:null,who=(p:any)=>typeof p?.username==='string'?p.username.toLowerCase():null;
 const read=(f:()=>unknown)=>{try{return f();}catch{return null;}};
 const row=(kind:string,value:object)=>kind+' '+JSON.stringify({tick:read(()=>int(m.World.currentTick)),at:read(()=>int(now())),...value});
 const log=(kind:string,value:object)=>{try{if(count++<4096)write(row(kind,value));}catch{/* observation cannot change dispatch */}};
 // A separate budget, so per-tick modal rows can never displace dispatch records.
 const wire=(kind:string,value:object)=>{try{if(wireCount++<8192)write(row(kind,value));}catch{/* observation cannot change transport */}};
 const S=m.WSClientSocket?.prototype,buffer=S?.buffer;
 if(S&&typeof buffer==='function')S.buffer=function(this:any,...args:any[]){
  const player=read(()=>this.player) as any,open=!!player&&int(player.modalMain)!==null&&int(player.modalMain)!==-1;
  const before=open?read(()=>int(this.available)):null;
  try{return Reflect.apply(buffer,this,args);}
  finally{if(open)wire('BUTTON_WIRE',{account:who(player),length:read(()=>int(args[0]?.length)),before,after:read(()=>int(this.available)),state:read(()=>int(this.state))});}
 };
 const P=m.NetworkPlayer.prototype,decodeIn=P.decodeIn,runScript=P.runScript,getDecoder=m.Repository.getDecoder;
 const ifHandle=m.IfButtonHandler.prototype.handle,idkHandle=m.IdkSaveDesignHandler.prototype.handle;
 P.decodeIn=function(this:any,...args:any[]){
  const before=read(()=>int(this.client?.available)),prev=decoding,own={packets:[] as number[]};decoding=own;
  try{return Reflect.apply(decodeIn,this,args);}
  finally{
   decoding=prev;
   const account=who(this);
   if(account&&!live.has(account)){live.add(account);log('BUTTON_LIVE',{account});}
   if(own.packets.some(o=>watch.includes(o))||int(this.modalMain)!==-1&&!!before)log('BUTTON_DECODE',{account,before,after:read(()=>int(this.client?.available)),packets:own.packets.slice(0,32),
    modalMain:int(this.modalMain),limits:[int(this.userLimit),int(this.clientLimit),int(this.restrictedLimit)]});
   else if(account&&int(this.modalMain)!==null&&int(this.modalMain)!==-1)wire('BUTTON_POLL',{account,before,modalMain:int(this.modalMain)});
  }
 };
 m.Repository.getDecoder=function(this:any,...args:any[]){
  if(decoding)read(()=>decoding!.packets.push(int(args[0]?.id)??-1));
  return Reflect.apply(getDecoder,this,args);
 };
 P.runScript=function(this:any,...args:any[]){
  const pre=button?{protect:this.protect===true,delayed:this.delayed===true}:null,state=Reflect.apply(runScript,this,args);
  if(button&&button.runs.length<4)button.runs.push({script:read(()=>typeof args[0]?.script?.name==='string'?args[0].script.name:null),protectRequested:args[1]===true,force:args[2]===true,...pre,state:int(state)});
  return state;
 };
 m.IfButtonHandler.prototype.handle=function(this:any,message:any,player:any,...rest:any[]){
  const com:any=read(()=>m.Component.get(message?.com)),root:any=com?read(()=>m.Component.get(com.rootLayer)):null;
  const row={account:who(player),com:int(message?.com),defined:!!com,buttonType:int(com?.buttonType),rootLayer:int(com?.rootLayer),rootOverlay:typeof root?.overlay==='boolean'?root.overlay:null,
   visible:com?read(()=>player.isComponentVisible(com)===true):null,modalMain:int(player?.modalMain),modalState:int(player?.modalState),protect:player?.protect===true,delayed:player?.delayed===true,
   busy:read(()=>player.busy()===true),resumeButton:read(()=>player.resumeButtons.includes(message.com)),activeScript:!!player?.activeScript,allowDesign:player?.allowDesign===true};
  const prev=button,own={runs:[] as object[]};button=own;let result:unknown='threw';
  try{result=Reflect.apply(ifHandle,this,[message,player,...rest]);return result;}
  finally{button=prev;log('BUTTON_HANDLE',{...row,result:typeof result==='boolean'?result:'threw',runs:own.runs,modalMainAfter:int(player?.modalMain),modalStateAfter:int(player?.modalState)});}
 };
 m.IdkSaveDesignHandler.prototype.handle=function(this:any,message:any,player:any,...rest:any[]){
  const allowDesign=player?.allowDesign===true;let result:unknown='threw';
  try{result=Reflect.apply(idkHandle,this,[message,player,...rest]);return result;}
  finally{log('BUTTON_DESIGN',{account:who(player),allowDesign,gender:int(message?.gender),result:typeof result==='boolean'?result:'threw',modalMain:int(player?.modalMain)});}
 };
 log('BUTTON_READY',{schema:1,wire:typeof buffer==='function',cwd:read(()=>process.cwd()),execPath:read(()=>process.execPath)});
}
// The records for one account, kept with the case evidence. Malformed lines are kept as a count, never copied.
export function buttonTraceFor(log:string,account:string){
 const a=account.toLowerCase(),rows:object[]=[];let malformed=0,ready=false,runtime:object|null=null;
 for(const line of log.split(/\r?\n/)){
  if(!line.startsWith('BUTTON_'))continue;
  const space=line.indexOf(' '),kind=line.slice(0,space);
  try{const r=JSON.parse(line.slice(space+1));if(kind==='BUTTON_READY'){ready=true;runtime={wire:r?.wire===true,cwd:typeof r?.cwd==='string'?r.cwd:null,execPath:typeof r?.execPath==='string'?r.execPath:null};}
   else if(r?.account===a)rows.push({kind,...r});}catch{malformed++;}
 }
 return {ready,malformed,runtime,rows};
}
export type AttributedAuthReply={at:number;requestAt:number;connection:number;replyTo:string|number;type:'player_login'|'player_logout';account:string;response:number};
export function observeAuth(log:string,requireSealed=false){
 const requests=new Map<string,any>(),replied=new Set<string>(),connections=new Set<number>(),replies:AttributedAuthReply[]=[];
 let ready=false,sealed=false,last=-Infinity,count=0;
 const fail=():never=>{throw Error('auth attribution missing, malformed, duplicate or ambiguous');};
 const id=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(v)||typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
 for(const line of log.split(/\r?\n/)){
  if(!line.startsWith('AUTH_'))continue;
  if(++count>8193||line.length>1024)fail();
  if(sealed)fail();
  const space=line.indexOf(' '),kind=line.slice(0,space);let r:any;
  try{r=JSON.parse(line.slice(space+1));}catch{fail();}
  if(!r||typeof r!=='object'||Array.isArray(r)||!Number.isSafeInteger(r.at)||r.at<0||r.at<last)fail();last=r.at;
  const keys=kind==='AUTH_READY'?['at','schema']:kind==='AUTH_CONNECTION'?['at','connection']:kind==='AUTH_REQUEST'?['at','connection','replyTo','type','account']:kind==='AUTH_REPLY'?['at','connection','replyTo','response']:kind==='AUTH_SEALED'?['at','records','healthy']:[];
  if(Object.keys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k)))fail();
  if(kind==='AUTH_READY'){if(ready||r.schema!==1)fail();ready=true;continue;}
  if(kind==='AUTH_SEALED'){if(!ready||r.healthy!==true||r.records!==count-1)fail();sealed=true;continue;}
  if(!ready||!Number.isSafeInteger(r.connection)||r.connection<1)fail();
  if(kind==='AUTH_CONNECTION'){if(connections.has(r.connection))fail();connections.add(r.connection);continue;}
  if(!connections.has(r.connection)||!id(r.replyTo))fail();
  const key=JSON.stringify([r.connection,r.replyTo]);
  if(kind==='AUTH_REQUEST'){
   if(requests.has(key)||!['player_login','player_logout'].includes(r.type)||typeof r.account!=='string'||!(/^[a-z0-9]{1,12}$/).test(r.account))fail();
   requests.set(key,r);
  }else if(kind==='AUTH_REPLY'){
   const request=requests.get(key);if(!request||replied.has(key)||!Number.isInteger(r.response))fail();
   replied.add(key);replies.push({...r,requestAt:request.at,type:request.type,account:request.account});
  }else fail();
 }
 if(!ready||requireSealed&&!sealed||replied.size!==requests.size)fail();
 return {requests:[...requests.values()] as {at:number;connection:number;replyTo:string|number;type:string;account:string}[],replies};
}
export function authReplies(log:string,since:number,account?:string,type?:AttributedAuthReply['type']){
 if(!Number.isSafeInteger(since))throw Error('auth attribution invalid interval');
 return observeAuth(log).replies.filter(r=>r.requestAt>=since&&(!account||r.account===account.toLowerCase())&&(!type||r.type===type));
}
export function noRecoveryLogin(log:string,since:number,account:string){
 // Inspect requests, including attempts with delayed/missing replies. Unknown evidence refuses.
 try{return !observeAuth(log).requests.some(r=>r.at>=since&&r.account===account.toLowerCase()&&r.type==='player_login');}catch{return false;}
}
// Pinned LoginServer.ts:300/:578 refuses a takeover with response 3 while Date.now()-lastTakeover < LOGIN_TAKEOVER_MIN_MS.
// The proof binds that value for its private login server only. Gateway and worker environments are unchanged.
export const TAKEOVER_WINDOW_MS=60000;
// lastTakeover is set before the takeover reply, and the recovery is handled after its request is observed, so the
// observed request-minus-reply gap never exceeds the server's elapsed time. A gap at or above the window is expired.
export function classifyCooldownWindow(log:string,account:string,w:{signalAt:number;warmAt:number;since:number;windowMs:number}){
 const a=account.toLowerCase(),fail=(reason:string,more:Record<string,unknown>={})=>({ok:false,reason,windowMs:w.windowMs,...more});
 if(!Number.isSafeInteger(w.windowMs)||w.windowMs<=0)return fail('takeover window unbound');
 let auth:ReturnType<typeof observeAuth>;try{auth=observeAuth(log);}catch{return fail('auth attribution unknown');}
 const mine=auth.replies.filter(r=>r.account===a);
 const warm=mine.filter(r=>r.type==='player_login'&&r.response===0&&r.requestAt>=w.signalAt&&r.at<=w.warmAt);
 if(warm.length!==1)return fail('warm takeover reply missing or ambiguous');
 const takeover=warm[0]!,prior=mine.filter(r=>r.response===0&&r.at<takeover.requestAt).at(-1);
 if(prior?.type!=='player_login')return fail('warm login did not take over a live session',{takeoverReplyAt:takeover.at});
 const requests=auth.requests.filter(r=>r.account===a&&r.type==='player_login'&&r.at>=w.since);
 if(requests.length!==1)return fail('recovery login request missing or ambiguous',{takeoverReplyAt:takeover.at});
 const req=requests[0]!,timing={takeoverReplyAt:takeover.at,recoveryRequestAt:req.at,gapMs:req.at-takeover.at};
 if(timing.gapMs<0)return fail('recovery login preceded the warm takeover',timing);
 if(timing.gapMs>=w.windowMs)return fail('window expired before recovery',timing);
 const answers=auth.replies.filter(r=>r.connection===req.connection&&r.replyTo===req.replyTo);
 if(answers.length!==1||answers[0]!.response!==3)return fail('recovery login inside the window was not refused with response 3',{...timing,response:answers[0]?.response??null});
 return {ok:true,reason:'recovery login refused with response 3 inside the open takeover window',windowMs:w.windowMs,...timing,response:3};
}
// The owner process can exit before the world receives its LoginServer logout acknowledgement.
// Observe that reply without changing the session owner's cleanup or its deadline.
export async function waitOwnerAuthLogout(readLog:()=>string,account:string,o:{releaseAt:number;ownerLoginReplyAt:number|undefined},
 observation:{timeoutMs:number;now?:()=>number;pause?:(ms:number)=>Promise<unknown>}={timeoutMs:5000}){
 if(!Number.isSafeInteger(observation.timeoutMs)||observation.timeoutMs<=0)throw Error('owner auth observation deadline invalid');
 const now=observation.now??Date.now,pause=observation.pause??(ms=>Bun.sleep(ms)),until=now()+observation.timeoutMs;
 for(;;){
  const log=readLog();let auth:ReturnType<typeof observeAuth>|undefined;
  // A request without its reply is incomplete evidence, including while a reply is in flight.
  try{auth=observeAuth(log);}catch{}
  if(auth&&o.ownerLoginReplyAt!==undefined){
   const logouts=auth.replies.filter(r=>r.account===account.toLowerCase()&&r.type==='player_logout'&&r.requestAt>=o.ownerLoginReplyAt!);
   if(logouts.some(r=>r.response!==0))throw Error('owner auth logout acknowledgement failed');
   if(logouts.some(r=>r.requestAt>=o.releaseAt))return log;
  }
  const left=until-now();
  if(left<=0)throw Error('owner auth logout acknowledgement timeout: matching successful reply not observed');
  await pause(Math.min(50,left));
 }
}
// Owner preservation from server-side records only. A client getState() view can outlive a server takeover.
export function ownerSessionEvidence(log:string,account:string,o:{since:number;releaseAt:number;ownerLoginReplyAt:number|undefined;ownerAttempt:string|undefined;latestAttemptBeforeRelease:string|undefined}){
 const a=account.toLowerCase();let mine:AttributedAuthReply[];
 try{mine=observeAuth(log).replies.filter(r=>r.account===a&&r.response===0);}
 catch{return {ok:false,noRecoveryLoginSuccess:false,ownerLoginLatest:false,ownerAttemptLatest:false,ownerLogoutAfterRelease:false};}
 const noRecoveryLoginSuccess=!mine.some(r=>r.type==='player_login'&&r.requestAt>=o.since);
 const lastLogin=mine.filter(r=>r.type==='player_login'&&r.at<o.releaseAt).at(-1);
 const ownerLoginLatest=o.ownerLoginReplyAt!==undefined&&lastLogin?.at===o.ownerLoginReplyAt;
 const ownerAttemptLatest=!!o.ownerAttempt&&o.latestAttemptBeforeRelease===o.ownerAttempt;
 // Exactly one logout ends the owner's session, and only after release. An earlier logout means it ended before release.
 const logouts=o.ownerLoginReplyAt===undefined?[]:mine.filter(r=>r.type==='player_logout'&&r.requestAt>=o.ownerLoginReplyAt!);
 const ownerLogoutAfterRelease=logouts.length===1&&logouts[0]!.requestAt>=o.releaseAt;
 return {ok:noRecoveryLoginSuccess&&ownerLoginLatest&&ownerAttemptLatest&&ownerLogoutAfterRelease,noRecoveryLoginSuccess,ownerLoginLatest,ownerAttemptLatest,ownerLogoutAfterRelease};
}
// The recovery session is its single acknowledged login; its final logout is the single logout requested on that
// login's connection after the login reply, and it must succeed. A cleanup logout before that login (an orphan's
// server-side end) belongs to an earlier session and never satisfies the final logout.
export function recoverySessionAuth(replies:AttributedAuthReply[],account:string){
 const a=account.toLowerCase(),mine=replies.filter(r=>r.account===a);
 const logins=mine.filter(r=>r.type==='player_login'&&r.response===0),login=logins.length===1?logins[0]!:undefined;
 const later=login?mine.filter(r=>r.requestAt>=login.at):[];
 const logouts=later.filter(r=>r.type==='player_logout');
 const logoutAcknowledged=!!login&&logouts.length===1&&logouts[0]!.response===0&&logouts[0]!.connection===login.connection&&!later.some(r=>r.type==='player_login');
 return {loginAcknowledged:!!login,logoutAcknowledged};
}
// The latest login success before `since` and the single recovery login after it, measured against the bound window.
export function loginAfterTakeoverWindow(log:string,account:string,since:number,windowMs:number){
 try{
  const logins=observeAuth(log).replies.filter(r=>r.account===account.toLowerCase()&&r.type==='player_login'&&r.response===0);
  const prior=logins.filter(r=>r.at<since).at(-1),next=logins.filter(r=>r.requestAt>=since);
  if(!prior||next.length!==1)return {ok:false,gapMs:null};
  const gapMs=next[0]!.requestAt-prior.at;return {ok:gapMs>=windowMs,gapMs};
 }catch{return {ok:false,gapMs:null};}
}
// Pinned World.ts:2635 answers a login with 5 ('Account already logged in') while the killed owner's player sits in
// logoutRequests, from its idle removal until the login server acknowledges that logout. The orphan's server-side end
// is the single acknowledged logout requested after the kill.
export function orphanServerEnd(log:string,account:string,killedAt:number){
 try{
  const ends=observeAuth(log).replies.filter(r=>r.account===account.toLowerCase()&&r.requestAt>=killedAt);
  const logouts=ends.filter(r=>r.type==='player_logout');
  if(logouts.length!==1||logouts[0]!.response!==0||ends.some(r=>r.type==='player_login'))return {ok:false,at:null};
  return {ok:true,at:logouts[0]!.at};
 }catch{return {ok:false,at:null};}
}
export function latestOwnerLoginBefore(log:string,account:string,before:number){
 try{return observeAuth(log).replies.filter(r=>r.account===account.toLowerCase()&&r.type==='player_login'&&r.response===0&&r.at<before).at(-1)?.at;}catch{return undefined;}
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

// Websocket relay to the private world. 'stall' accepts the socket and never answers: a real pre-START hang.
function startRelay(port:number,target:number){
 let mode:'forward'|'stall'='forward';const sockets=new Set<any>(),stalled=new EventEmitter();
 const server=Bun.serve<{upstream:WebSocket|null;queue:any[];stalled:boolean}>({port,hostname:'::',
  async fetch(req,srv){
   if(req.headers.get('upgrade')?.toLowerCase()==='websocket'){
    if(srv.upgrade(req,{data:{upstream:null,queue:[],stalled:mode==='stall'},headers:{'Sec-WebSocket-Protocol':'binary'}}))return undefined;
    return new Response('upgrade failed',{status:400});
   }
   const url=new URL(req.url);return fetch(`http://localhost:${target}${url.pathname}${url.search}`);
  },
  websocket:{
   open(ws){sockets.add(ws);if(ws.data.stalled){stalled.emit('stalled');return;}const up=new WebSocket(`ws://localhost:${target}`,'binary');up.binaryType='arraybuffer';ws.data.upstream=up;
    up.onopen=()=>{for(const m of ws.data.queue)up.send(m);ws.data.queue=[];};
    up.onmessage=e=>{try{ws.sendBinary(new Uint8Array(e.data as ArrayBuffer));}catch{}};up.onclose=()=>{try{ws.close();}catch{}};up.onerror=()=>{try{ws.close();}catch{}};},
   message(ws,m){if(ws.data.stalled)return;const up=ws.data.upstream;if(up?.readyState===WebSocket.OPEN)up.send(m);else ws.data.queue.push(m);},
   close(ws){sockets.delete(ws);try{ws.data.upstream?.close();}catch{}},
  }});
 return {stalled,set(m:'forward'|'stall'){mode=m;},stop(){for(const s of sockets)try{s.close();}catch{}server.stop(true);}};
}

async function run(directory:string){
 const taskPath=join(directory,'task.json'),deliveryTask=existsSync(taskPath)?JSON.parse(readFileSync(taskPath,'utf8')):null;
 const capability=recoveryCapability(process.env.DELIVERY_ID??deliveryTask?.id),routerPins=capability==='cow-progress-order'?verifyCompletedRouterPins():null;
 if(deliveryTask&&deliveryTask.id!==capability)throw Error('recovery delivery identity mismatch');
 const startedAt=Date.now(),startFreeGiB=freemem()/2**30;
 if(startFreeGiB<PRACTICE_STARTUP_GB)throw Error(`native recovery needs${PRACTICE_STARTUP_GB}GiB startup reserve; observed `+startFreeGiB.toFixed(2));
 for(const port of PORTS)if(!canBind(port))throw Error('native recovery port owned: '+port);
 if(existsSync(join(directory,'proof.json'))||existsSync(join(directory,'control')))throw Error('native recovery directory already used');
 // Isolated proof owns only the practice mutex. Runtime revision and runner hash bind its source.
 mkdirSync(directory,{recursive:true});
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:capability,mode:'native-session-recovery'}));
 const source=workerSourceRevision(),runnerSha256=hash(runner),base=join(directory,'control'),workspace=join(directory,'isolated-engine'),lifeRoot=join(base,'.practice/session-lifecycle');
 const children:ReturnType<typeof Bun.spawn>[]=[],recoveryChildren:{pid:number;nonce:string}[]=[],cases:any[]=[],tasks=new Map<string,any>(),ends:Record<string,any>={},jobs:any[]=[];
 const ownedStops:OwnedStop[]=[],junctions:string[]=[];
 const saved={rsan:process.env.LOGIN_RSAN,rsae:process.env.LOGIN_RSAE,release:process.env.WORKER_RELEASE};
 let relay:ReturnType<typeof startRelay>|undefined,pulse:ReturnType<typeof setInterval>|undefined,stamp=String(Date.now()).slice(-6);
 const put=(path:string,value:unknown)=>publishControlFile(join(base,path),value);
 const progress=()=>writeFileSync(join(directory,'progress.json'),JSON.stringify({source,runnerSha256,cases},null,2));
 try{
  // Private world: fresh keys, private DB and saves. Only immutable packed content is linked.
  for(const folder of ['data/config','data/players/main'])mkdirSync(join(workspace,folder),{recursive:true});
  const keys=generateKeyPairSync('rsa',{modulusLength:1024,publicExponent:65537});
  writeFileSync(join(workspace,'data/config/public.pem'),keys.publicKey.export({type:'spki',format:'pem'}));
  writeFileSync(join(workspace,'data/config/private.pem'),keys.privateKey.export({type:'pkcs1',format:'pem'}));
  const jwk=keys.publicKey.export({format:'jwk'});
  for(const p of ['data/pack','data/raw','view']){symlinkSync(join(engine,p),join(workspace,p),'junction');junctions.push(join(workspace,p));}
  const worldConfig={easyStartup:false,website:{registration:false},web:{port:8890,managementPort:8896},node:{id:77,port:43651,members:true,autoSubscribeMembers:true,profile:'main',hopTime:45000},login:{enabled:true,host:'localhost',port:LOGIN_PORT},friend:{enabled:false},logger:{enabled:false},db:{backend:'sqlite'}};
  writeFileSync(join(workspace,'data/config/world.json'),JSON.stringify(worldConfig,null,2));
  const db=new Database(join(workspace,'db.sqlite'));const migrations=join(engine,'prisma/singleworld/migrations');
  for(const name of readdirSync(migrations).sort()){const p=join(migrations,name,'migration.sql');if(existsSync(p))db.exec(readFileSync(p,'utf8'));}db.close();
  const observer=join(directory,'observe-auth.ts'),authTrace=join(directory,'auth-observations.log'),sealRequest=join(directory,'auth-seal-request'),sealAck=join(directory,'auth-sealed');
  writeFileSync(authTrace,'',{flag:'wx'});
  writeFileSync(observer,`import{createRequire}from'node:module';import{appendFileSync,existsSync,writeFileSync}from'node:fs';const req=createRequire(${JSON.stringify(join(engine,'package.json'))});const {WebSocketServer}=req('ws');const observer=(${installAuthObserver.toString()})(WebSocketServer,line=>{appendFileSync(${JSON.stringify(authTrace)},line+'\\n');console.log(line);});const timer=setInterval(()=>{if(existsSync(${JSON.stringify(sealRequest)})){observer.seal();writeFileSync(${JSON.stringify(sealAck)},'sealed');clearInterval(timer);}},50);timer.unref();`);
  const env={...process.env,DB_BACKEND:'sqlite',LOGIN_SERVER:'true',LOGIN_HOST:'localhost',LOGIN_PORT:String(LOGIN_PORT),EASY_STARTUP:'false',NODE_ID:'77',NODE_PORT:'43651',NODE_MEMBERS:'true',NODE_TICKRATE:'150',WEB_PORT:'8890',WEB_MANAGEMENT_PORT:'8896',WEBSITE_REGISTRATION:'false',FRIEND_SERVER:'false',LOGGER_SERVER:'false'};
  const spawnServer=(args:string[],log:string,extra:Record<string,string>={})=>{const p=Bun.spawn(args,{cwd:workspace,env:{...env,...extra},stdout:Bun.file(join(directory,log+'.out.log')),stderr:Bun.file(join(directory,log+'.err.log')),windowsHide:true});children.push(p);return p;};
  const waitLog=async(p:ReturnType<typeof Bun.spawn>,file:string,pattern:RegExp)=>{const until=Date.now()+60000;while(Date.now()<until){if(p.exitCode!==null)throw Error('native server exited: '+file);if(existsSync(join(directory,file))&&pattern.test(readFileSync(join(directory,file),'utf8')))return;await Bun.sleep(200);}throw Error('native server readiness timeout: '+file);};
  const login=spawnServer([process.execPath,'--preload',observer,join(engine,'src/login.ts')],'login',{WEB_MANAGEMENT_PORT:'8897',LOGIN_TAKEOVER_MIN_MS:String(TAKEOVER_WINDOW_MS)});await waitLog(login,'login.out.log',/Login server listening/);
  // The world observer attaches after app.ts has loaded its modules, so the preload never changes import order.
  // A missing or failed attach is recorded and the proof continues; the modal case keeps whatever was observed.
  const worldObserver=join(directory,'observe-world.ts'),buttonTrace=join(directory,'button-observations.log'),attachRequest=join(directory,'button-attach-request'),attachAck=join(directory,'button-attached');
  writeFileSync(buttonTrace,'',{flag:'wx'});
  const engineModule=(p:string)=>JSON.stringify(join(engine,'src',p));
  writeFileSync(worldObserver,`import{appendFileSync,existsSync,writeFileSync}from'node:fs';const trace=${JSON.stringify(buttonTrace)};const timer=setInterval(async()=>{if(!existsSync(${JSON.stringify(attachRequest)}))return;clearInterval(timer);try{const[n,b,d,c,r,w,s]=await Promise.all([${['engine/entity/NetworkPlayer.ts','network/game/client/handler/IfButtonHandler.ts','network/game/client/handler/IdkSaveDesignHandler.ts','cache/config/Component.ts','network/game/client/ClientGameProtRepository.ts','engine/World.ts','server/ws/WSClientSocket.ts'].map(p=>'import('+engineModule(p)+')').join(',')}]);(${installButtonObserver.toString()})({NetworkPlayer:n.NetworkPlayer,IfButtonHandler:b.default,IdkSaveDesignHandler:d.default,Component:c.default,Repository:r.default,World:w.default,WSClientSocket:s.default},line=>appendFileSync(trace,line+'\\n'));writeFileSync(${JSON.stringify(attachAck)},'attached');}catch{writeFileSync(${JSON.stringify(attachAck)},'failed');}},50);timer.unref();`);
  const world=spawnServer([process.execPath,'--preload',worldObserver,join(engine,'src/app.ts')],'world');await waitLog(world,'world.out.log',/World ready|World is ready|World started|world is ready/i);
  writeFileSync(attachRequest,'attach');
  for(const until=Date.now()+10000;!existsSync(attachAck)&&Date.now()<until;)await Bun.sleep(50);
  appendFileSync(buttonTrace,'BUTTON_ATTACH '+JSON.stringify({state:existsSync(attachAck)?readFileSync(attachAck,'utf8'):'timeout'})+'\n');
  relay=startRelay(8899,8890);
  process.env.LOGIN_RSAN=BigInt('0x'+Buffer.from(jwk.n!,'base64url').toString('hex')).toString();process.env.LOGIN_RSAE='65537';process.env.WORKER_RELEASE=source;
  const loginLog=()=>readFileSync(authTrace,'utf8');
  // Recheck refusal windows against the complete subsequent log, not just a reply-time slice.
  const absenceGuards:{id:string;f:Fixture;since:number;attempts:string[]}[]=[];

  // Private control tree: the controller is this process; each case has a real task owner process.
  put(RECOVERY_SCRIPT,null);copyFileSync(runner,join(base,RECOVERY_SCRIPT));
  put('packages/router/tasks/'+capability+'.json',JSON.parse(readFileSync(join(root,'packages/router/tasks',capability+'.json'),'utf8')));
  put('.practice/swarm-script-holds.json',[]);
  put('.practice/coordinator/swarm-owner.json',{pid:process.pid,nonce:CONTROLLER_MARKER,source});
  const writeState=()=>{put('.practice/coordinator/state.json',{tasks:[...tasks.values()]});put('.practice/swarm-deaths.json',ends);put('swarm.json',{maxBots:17,minFreeGB:FREE_FLOOR_GB,jobs});};
  const beat=()=>put('.practice/swarm-state.json',{at:Date.now(),controllerPid:process.pid,jobs:jobs.map(j=>({account:j.account,state:'disabled'}))});
  // A failed timer publish keeps the previous complete view; the strict reader refuses it as stale, never malformed.
  writeState();beat();pulse=setInterval(()=>{try{beat();}catch{}},1000);
  const boundaries:RecoveryBoundary[]=[];
  const observeBoundary=(event:RecoveryBoundary)=>{boundaries.push(event);appendFileSync(join(directory,'recovery-boundaries.jsonl'),JSON.stringify(event)+'\n');};
  const dispatcher=(server:string)=>createRecoveryDispatch({base,server,nativeFixture:true,
   admit:r=>{
    const owners=heldRecoveryOwners(base),input={account:r.account,active:[],running:owners.length,external:0,pending:0,freeGB:freemem()/2**30,minFreeGB:FREE_FLOOR_GB,maxBots:17};
    return observeRecoveryBoundary('admitRecovery',{admission:input,heldOwners:owners,authority:recoveryAuthorityInputs(base,r)},()=>admitRecovery(input),observeBoundary);
   },
   // Exactly the dispatcher's native default: same base, source callback and actual launcher.
   launch:r=>observeRecoveryBoundary('launchPermittedRecovery',recoveryAuthorityInputs(base,r),
    ()=>launchPermittedRecovery(r,base,{nativeFixture:true,source:()=>workerSourceRevision()}),observeBoundary)});
  let fixtureIndex=0;
  const fixture=async(server:string,preset:Parameters<typeof applyPreset>[1],completed=false)=>{
   // The name token cycles every 28 minutes (prove.ts runBotName), and fixture folders from earlier proofs stay in
   // vendor/rs-sdk/bots, so a taken name is skipped: the next index gives a new one.
   let name=runBotName('flrcv',++fixtureIndex);
   for(let tries=0;tries<40&&existsSync(join(root,'vendor/rs-sdk/bots',name));tries++)name=runBotName('flrcv',++fixtureIndex);
   if(existsSync(join(root,'vendor/rs-sdk/bots',name)))throw Error('fixture identity exists');
   await createBot(name);const envPath=join(root,'vendor/rs-sdk/bots',name,'bot.env');
   writeFileSync(envPath,readFileSync(envPath,'utf8').replace(/^SERVER=.*$/m,'SERVER='+server));
   const original=await applyPreset(name,preset),save=join(workspace,'data/players/main',name.toLowerCase()+'.sav');copyFileSync(original,save);
   const endedAt=Date.now();ends[name]={at:endedAt,reason:completed?'done after 1 runs':'blocked after 1 runs',...(completed?{revision:missionSignature({account:name,script:'scripts/retired-fixture.ts'})}:{})};jobs.push({account:name,script:'scripts/retired-fixture.ts',enabled:false});writeState();
   return {name,envPath,save,server,endedAt,completed};
  };
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  const task=async(f:Fixture,id:string)=>{
   const runId=`native-rcv-${id}-${stamp}`;
   const owner=Bun.spawn([process.execPath,'-e','await Bun.sleep(900000)',runId],{cwd:root,stdout:'ignore',stderr:'ignore',windowsHide:true});children.push(owner);
   tasks.set(runId,{status:'running',runId,pid:owner.pid,spec:{kind:'run',capability,account:f.name,...(f.completed?{env:{TRAIN_SKILL:'Attack',TARGET_LEVEL:'20',CAP:'1500'}}:{}),repairs:[{account:f.name,endedAt:f.endedAt}],sessionRecovery:{account:f.name,endedAt:f.endedAt}}});
   put('.practice/coordinator/runs/'+runId+'/owner.json',{pid:owner.pid,runId});writeState();
   return {runId,owner};
  };
  const requestFor=(f:Fixture,runId:string,nonce:string):ControlledRecoveryRequest=>({schema:'session-recovery/1',kind:'session-recovery',account:f.name,server:f.server,runId,nonce,endedAt:f.endedAt,source,
   qualification:{delivery:{path:'native-fixture-not-qualified',sha256:'0'.repeat(64)},proof:{path:'native-fixture-not-qualified',sha256:'0'.repeat(64)}}});
  const channel=join(base,'.practice/swarm-repair.json'),resultsFile=channel+'.results.jsonl';
  const resultRows=()=>existsSync(resultsFile)?readFileSync(resultsFile,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
  // Submit one raw request exactly as the swarm receives it, then wait for that request's own receipt row.
  // Every handoff retains the fleet view the dispatcher is about to read, so a pre-child refusal keeps its first boundary.
  const handoff=(d:ReturnType<typeof dispatcher>,raw:string,account:string,nonce:string)=>{
   const fleet=fleetHandoff(beat,join(base,'.practice/swarm-state.json'),account,process.pid);
   const from=boundaries.length,claimed=d.handle(raw),calls=boundaries.slice(from),firstFailure=calls.find(c=>c.outcome==='threw')??null;
   appendFileSync(join(directory,'handoffs.jsonl'),JSON.stringify({account,nonce,fleet,claimed,child:d.active?.account===account?d.active.pid:null,boundaries:calls,firstFailure})+'\n');
   return {claimed,fleet,boundaries:calls,firstFailure};
  };
  const submit=(d:ReturnType<typeof dispatcher>,r:ControlledRecoveryRequest,taskPid:number)=>{
   put('.practice/swarm-repair.json.lease',{pid:taskPid,runId:r.runId,nonce:r.nonce});
   const raw=JSON.stringify(r),from=resultRows().length;writeFileSync(channel+'.processing',raw);
   const {claimed,fleet,boundaries,firstFailure}=handoff(d,raw,r.account,r.nonce);if(!claimed)throw Error('actual recovery dispatcher did not claim its request');
   const child=d.active?.account===r.account?d.active.pid:null;if(child)recoveryChildren.push({pid:child,nonce:r.nonce});
   return {raw,from,child,fleet,boundaries,firstFailure};
  };
  const awaitResult=async(raw:string,from:number,ms=170000)=>{
   const until=Date.now()+ms;while(Date.now()<until){const row=resultRows().slice(from).find(x=>x.raw===raw);if(row)return row.result;await Bun.sleep(50);}
   throw Error('native dispatcher result timeout');
  };
  const fixtureFiles=(f:Fixture,dir:string,r?:ControlledRecoveryRequest)=>{
   const life=accountDir(f.name,f.server,lifeRoot);if(existsSync(life))cpSync(life,join(dir,'lifecycle'),{recursive:true});
   const acct=join(base,'.practice/coordinator/session-recovery/accounts',f.name.toLowerCase());if(existsSync(acct))cpSync(acct,join(dir,'control-account'),{recursive:true});
   writeFileSync(join(dir,'dispatch-results.json'),JSON.stringify(resultRows().filter(x=>JSON.parse(x.raw).account===f.name),null,2));
   if(r)writeFileSync(join(dir,'request.json'),JSON.stringify(r,null,2));
  };
  const receiptOf=(r:ControlledRecoveryRequest)=>{const p=join(recoveryPermitPaths(r,base).output,'receipt.json');return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):null;};
  const record=(id:string,level:string,checks:Record<string,boolean>,extra:Record<string,unknown>={})=>{
   const dir=join(directory,'cases',id);mkdirSync(dir,{recursive:true});
   writeFileSync(join(dir,'checks.json'),JSON.stringify({id,level,checks,...extra},null,2));
   const row={id,level,ok:Object.values(checks).every(v=>v===true),checks,...extra,evidence:evidenceFiles(directory,join('cases',id))};
   return retainRequiredRecoveryCase(row,value=>{cases.push(value);progress();});
  };
  const caseDir=(id:string)=>{const d=join(directory,'cases',id);mkdirSync(d,{recursive:true});return d;};
  const deathBytes=()=>readFileSync(join(base,'.practice/swarm-deaths.json'),'utf8');
  // An owner process using the real per-account producer. The root chooses whether the controller can see it.
  const owner=async(f:Fixture,dir:string,mode:'hold'|'warm'|'orphan'|'partial',lifecycle:string)=>{
   const script=join(dir,'owner.ts'),ready=join(dir,'owner-ready.json'),release=join(dir,'owner-release'),takeover=join(dir,'owner-takeover'),warmFile=join(dir,'owner-warm.json');
   const core=(p:string)=>JSON.stringify(join(root,'packages/core/src',p));
   writeFileSync(script,`import{readFileSync,writeFileSync,existsSync}from'node:fs';import{connectInProcess}from${core('inprocess.ts')};import{logoutSession}from${core('bot.ts')};import{waitUntil}from${core('ticks.ts')};
const password=readFileSync(${JSON.stringify(f.envPath)},'utf8').match(/^PASSWORD=(.*)$/m)?.[1]?.trim()!,mode=${JSON.stringify(mode)};
const open=()=>connectInProcess({name:${JSON.stringify(f.name)},password,server:${JSON.stringify(f.server)},lifecycleRoot:${JSON.stringify(lifecycle)}});
const view=(s:any)=>{const x=s.sdk.getState();return{inGame:x?.inGame,player:x?.player&&{x:x.player.worldX,z:x.player.worldZ,level:x.player.level,hp:x.player.hp},inventory:x?.inventory?.map((i:any)=>({id:i.id,count:i.count})),equipment:x?.equipment?.map((i:any)=>({id:i.id,count:i.count}))};};
if(mode==='partial'){writeFileSync(${JSON.stringify(ready)},JSON.stringify({at:Date.now(),pid:process.pid}));await open();throw Error('partial owner unexpectedly connected');}
let s=await open();if(!await waitUntil(s,x=>x?.inGame&&x.player?.hp>0,{timeoutTicks:100,idleMs:10000}))throw Error('owner not ready');
const loggedInAt=Date.now(),first=s.lifecycle?.attemptId;
writeFileSync(${JSON.stringify(ready)},JSON.stringify({at:Date.now(),loggedInAt,pid:process.pid,first,attemptId:s.lifecycle?.attemptId,state:view(s)}));
if(mode==='warm'){const signal=Date.now()+300000;while(!existsSync(${JSON.stringify(takeover)})&&Date.now()<signal)await Bun.sleep(20);if(!existsSync(${JSON.stringify(takeover)}))throw Error('warm takeover signal timeout');
 const signalSeenAt=Date.now(),b=await open();if(!await waitUntil(b,x=>x?.inGame&&x.player?.hp>0,{timeoutTicks:100,idleMs:10000}))throw Error('warm takeover not ready');await s.close();s=b;
 writeFileSync(${JSON.stringify(warmFile)},JSON.stringify({at:Date.now(),signalSeenAt,attemptId:s.lifecycle?.attemptId}));}
const until=Date.now()+300000;while(!existsSync(${JSON.stringify(release)})&&Date.now()<until)await Bun.sleep(50);
writeFileSync(${JSON.stringify(join(dir,'owner-after.json'))},JSON.stringify({at:Date.now(),state:view(s)}));console.log('OWNER_LOGOUT '+await logoutSession(s));await s.close();`);
   const p=Bun.spawn([process.execPath,script],{cwd:root,env:{...process.env,BOT_GOAL:'native-recovery-owner-fixture',COORDINATOR_RUN_ID:'native-owner-'+f.name,WORKER_RELEASE:source},stdout:Bun.file(join(dir,'owner.log')),stderr:Bun.file(join(dir,'owner.err')),windowsHide:true});children.push(p);
   const until=Date.now()+90000;while(!existsSync(ready)&&Date.now()<until){if(p.exitCode!==null)throw Error('owner fixture exited before ready: '+mode);await Bun.sleep(100);}
   if(!existsSync(ready))throw Error('owner fixture readiness timeout: '+mode);
   return {p,ready:JSON.parse(readFileSync(ready,'utf8')),
    // Warm only: the owner takes over its own live session now, so the window opens at a known point.
    takeover:async()=>{const signalAt=Date.now();writeFileSync(takeover,'takeover');const end=Date.now()+60000;
     while(!existsSync(warmFile)&&Date.now()<end){if(p.exitCode!==null)throw Error('owner fixture exited before warm takeover');await Bun.sleep(20);}
     if(!existsSync(warmFile))throw Error('owner warm takeover timeout');return {signalAt,...JSON.parse(readFileSync(warmFile,'utf8'))} as {signalAt:number;at:number;signalSeenAt:number;attemptId:string};},
    release:async()=>{const at=Date.now();writeFileSync(release,'release');const t=setTimeout(()=>void killTree(p.pid),60000);await p.exited;clearTimeout(t);return at;}};
  };
  const freshSave=async(f:Fixture,before:Save)=>(await waitPracticeSave(f.save,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:15000})).matched;
  const preset={position:{x:2618,z:3332,level:0},skills:{Hitpoints:43,Fishing:99,Cooking:99},inventory:[{id:995,count:1200},{id:311,count:1},{id:329,count:4}],equipment:[{id:1275,count:1,slot:3}],bank:[{id:385,count:5},{id:436,count:17}],varps:{300:1000}};
  const d8890=dispatcher(HOST);
  // Positive confirmed cleanup through the actual dispatcher, launcher and CLI, reconciled from fresh saves.
  const positive=async(id:string,f:Fixture,expectedPosition?:Save['position'],extra:(r:any)=>Record<string,boolean>=()=>({}),d=d8890,ownerNote?:unknown)=>{
   const dir=caseDir(id);copyFileSync(f.save,join(dir,'before.sav'));const before=readPracticeSave(join(dir,'before.sav')),ended=deathBytes(),since=Date.now();
   const {runId,owner:taskOwner}=await task(f,id),r=requestFor(f,runId,'one-'+id),sub=submit(d,r,taskOwner.pid);
   const result=await awaitResult(sub.raw,sub.from),persisted=await freshSave(f,before);copyFileSync(f.save,join(dir,'after.sav'));
   const after=readPracticeSave(join(dir,'after.sav')),receipt=receiptOf(r),paths=recoveryPermitPaths(r,base),proof=readLogoutProof(f.name,f.server,{root:lifeRoot});
   const replies=authReplies(loginLog(),since,f.name),session=recoverySessionAuth(replies,f.name);writeFileSync(join(dir,'auth-replies.json'),JSON.stringify(replies));fixtureFiles(f,dir,r);
   for(const p of [join(dirname(paths.input),'worker.log'),join(dirname(paths.input),'worker.err')])if(existsSync(p))copyFileSync(p,join(dir,'recovery-'+p.split(/[\\/]/).at(-1)));
   const rec=reconcileSaves(before,after,expectedPosition??before.position);
   return {dir,before,after,receipt,result,runId,record:(level:string,more:Record<string,boolean>={})=>record(id,level,{
    childLaunched:!!sub.child,dispatcherConfirmed:result?.sessionRecovered===true&&result.changed===false,receiptConfirmed:receipt?.state==='confirmed'&&receipt.logout==='logged-out',
    loginAcknowledged:session.loginAcknowledged,logoutAcknowledged:session.logoutAcknowledged,
    ...recoveryArtifactPresence(paths),leaseReleased:!existsSync(paths.lease),producerConfirmed:proof.state==='confirmed'&&proof.attemptId===receipt?.attemptId,
    recoveredForRun:recoveredSessionForRun(f.name,f.server,runId,source,base),failureRetained:deathBytes()===ended,freshSave:persisted,
    savedInventories:rec.inventories,savedSkills:rec.skills,savedPosition:rec.position,noGameplayClaim:receipt?.scope?.gameplay===false&&receipt.scope.repairsFailure===false&&receipt.scope.qualifiesScript===false,
    ...extra(receipt),...more},{account:f.name,server:f.server,runId,childPid:sub.child,taskPid:taskOwner.pid,persistence:persisted?'fresh native save after confirmed producer logout':'missing',owner:ownerNote,
    firstRefusal:recoveryDiagnosticFromLog(existsSync(join(dir,'recovery-worker.err'))?readFileSync(join(dir,'recovery-worker.err'),'utf8'):'')})};
  };
  // beforeSubmit runs after the task, permit inputs and request exist, immediately before the raw submit.
  const held=async(id:string,f:Fixture,d=d8890,beforeSubmit:(r:ControlledRecoveryRequest)=>Promise<void>=async()=>{})=>{
   const dir=caseDir(id);copyFileSync(f.save,join(dir,'before.sav'));const ended=deathBytes(),since=Date.now(),before=listAttempts(f.name,f.server,{root:lifeRoot}).length;
   const {runId,owner:taskOwner}=await task(f,id),r=requestFor(f,runId,'one-'+id);
   await beforeSubmit(r);const submittedAt=Date.now(),sub=submit(d,r,taskOwner.pid);
   return {dir,r,sub,since,submittedAt,ended,attemptsBefore:before,runId,taskOwner,finish:async(from=sub.from)=>{
    const result=await awaitResult(sub.raw,from);copyFileSync(f.save,join(dir,'after.sav'));
    writeFileSync(join(dir,'handoff.json'),JSON.stringify({submittedAt,fleet:sub.fleet,child:sub.child,dispatch:result?.reason??null,boundaries:sub.boundaries,firstFailure:sub.firstFailure},null,2));
    const replies=authReplies(loginLog(),since,f.name);writeFileSync(join(dir,'auth-replies.json'),JSON.stringify(replies));fixtureFiles(f,dir,r);
    const paths=recoveryPermitPaths(r,base);for(const p of [join(dirname(paths.input),'worker.log'),join(dirname(paths.input),'worker.err')])if(existsSync(p))copyFileSync(p,join(dir,'recovery-'+p.split(/[\\/]/).at(-1)));
    return {result,paths,receipt:receiptOf(r),replies};
   }};
  };

  // 1 offline: an ordinary logged-out account.
  const A=await fixture(HOST,preset);
  const offline=await positive('offline',A);offline.record('native-actual-cli');
  // Retired successful ordinary account with no producer history: actual controller -> installed core CLI.
  {
   const C=await fixture(HOST,preset,true),dir=caseDir('completed');
   const holds=readFileSync(join(base,'.practice/swarm-script-holds.json'),'utf8'),assignments=readFileSync(join(base,'swarm.json'),'utf8');
   const beforeProof=readLogoutProof(C.name,C.server,{root:lifeRoot});
   const out=await positive('completed',C),end=ends[C.name],entry=JSON.parse(readFileSync(join(base,'packages/router/tasks',capability+'.json'),'utf8')).entry;
   const revision=missionSignature({account:C.name,script:entry,env:{TRAIN_SKILL:'Attack',TARGET_LEVEL:'20',CAP:'1500',COORDINATOR_RUN_ID:out.runId}});
   const retained=new Map(Object.entries(ends)),proof=readLogoutProof(C.name,C.server,{root:lifeRoot});
   const repair=applyEndRepair({account:C.name,endedAt:C.endedAt,server:C.server,proof:{kind:'producer',attemptId:out.receipt?.attemptId}},retained,[],{
    readProof:()=>proof,verifyLegacy:()=>({state:'refused',reason:'unused'})},[]);
   writeFileSync(join(dir,'controller-after.json'),JSON.stringify({ends:[...retained],repair,revision,beforeProof,proof},null,2));
   out.record('native-actual-controller-core-cli',{
    noProducerBefore:beforeProof.state==='none',successfulEndRetained:retained.get(C.name)===end&&end.reason==='done after 1 runs',
    endRepairRefused:!repair.changed&&repair.reason==='completed work needs a new mission',
    oldMissionRefused:startable([C.name],false,retained,()=>Infinity,undefined,end.revision).start.length===0,
    newMissionReleased:startable([C.name],false,retained,()=>Infinity,undefined,revision).start.includes(C.name),
    holdsRetained:readFileSync(join(base,'.practice/swarm-script-holds.json'),'utf8')===holds,
    assignmentsRetained:readFileSync(join(base,'swarm.json'),'utf8')===assignments,
    noStopCreated:!existsSync(join(base,'.practice','stop-'+C.name)),
   });
  }
  {
   const dir=caseDir('completed-refusals'),rows:any[]=[];
   for(const fault of ['same-revision','open-hold','changed-end','stopped','reserved','active','orphan','partial-intent','competing-owner','wrong-identity','wrong-source'] as const){
    const C=await fixture(HOST,preset,true),id='completed-refusal-'+fault;
    const h=await held(id,C,d8890,async r=>{
     const spec=tasks.get(r.runId).spec;
     if(fault==='same-revision')ends[C.name].revision=missionSignature({account:C.name,script:JSON.parse(readFileSync(join(base,'packages/router/tasks',capability+'.json'),'utf8')).entry,
      env:{...spec.env,COORDINATOR_RUN_ID:r.runId}});
     if(fault==='open-hold')put('.practice/swarm-script-holds.json',[{account:C.name,script:'scripts/retired-fixture.ts',at:C.endedAt,heldAt:C.endedAt,reason:'retained'}]);
     if(fault==='changed-end')ends[C.name].at++;
     if(fault==='stopped'){const s=claimStopArtifact(join(base,'.practice','stop-'+C.name),'native completed stop '+randomUUID());ownedStops.push(s);}
     if(fault==='reserved')jobs.find(j=>j.account===C.name).goal='fresh clock';
     if(fault==='active')jobs.find(j=>j.account===C.name).enabled=true;
     if(fault==='orphan'||fault==='partial-intent'){
      const a=beginSessionAttempt({account:C.name,server:C.server},{root:lifeRoot});if(fault==='orphan')a.record('connected');
     }
     if(fault==='competing-owner')put('.practice/coordinator/runs/'+r.runId+'/owner.json',{pid:process.pid,runId:r.runId});
     if(fault==='wrong-identity')spec.sessionRecovery.account='Other';
     if(fault==='wrong-source')r.source='f'.repeat(64);
     writeState();
    });
    const endsBefore=deathBytes(),holdsBefore=readFileSync(join(base,'.practice/swarm-script-holds.json'),'utf8'),assignmentsBefore=readFileSync(join(base,'swarm.json'),'utf8'),attempts=listAttempts(C.name,C.server,{root:lifeRoot}).map(a=>a.attemptId);
    const out=await h.finish(),stopped=join(base,'.practice','stop-'+C.name);
    const row={fault,refused:!h.sub.child&&!existsSync(out.paths.lease)&&!existsSync(out.paths.permit)&&out.result?.sessionRecovered===false,
     noLogin:noRecoveryLogin(loginLog(),h.since,C.name),noNewIntent:isDeepStrictEqual(attempts,listAttempts(C.name,C.server,{root:lifeRoot}).map(a=>a.attemptId)),
     endsRetained:deathBytes()===endsBefore,holdsRetained:readFileSync(join(base,'.practice/swarm-script-holds.json'),'utf8')===holdsBefore,
     assignmentsRetained:readFileSync(join(base,'swarm.json'),'utf8')===assignmentsBefore,stopRetained:fault!=='stopped'||existsSync(stopped)};
    rows.push(row);writeFileSync(join(dir,fault+'.json'),JSON.stringify(row));cpSync(h.dir,join(dir,fault),{recursive:true});
    // Fault setup belongs only to this private fixture; stopped identities remain retired.
    put('.practice/swarm-script-holds.json',[]);jobs.find(j=>j.account===C.name).enabled=false;writeState();
    absenceGuards.push({id:'completed-refusals',f:C,since:h.since,attempts});
   }
   record('completed-refusals','native-actual-controller-refusal',Object.fromEntries(rows.map(r=>[r.fault,Object.entries(r).filter(([k])=>k!=='fault').every(([,v])=>v===true)])),{rows});
  }
  // 2 authFailure: the SAME account, now registered in the private DB by the real login above, with a wrong password.
  {
   const dbr=new Database(join(workspace,'db.sqlite'),{readonly:true});const row=dbr.query('SELECT username FROM account WHERE username=?').get(A.name.toLowerCase());dbr.close();
   writeFileSync(join(caseDir('auth-failure'),'registered-precondition.json'),JSON.stringify({offlineConfirmed:cases.find(c=>c.id==='offline')?.ok===true,registered:!!row}));
   requireRecoveryRegistration(cases.find(c=>c.id==='offline')?.ok===true,!!row);
   const credentials=readFileSync(A.envPath,'utf8');writeFileSync(A.envPath,credentials.replace(/^PASSWORD=.*$/m,'PASSWORD=wronglocalpass'));
   let out:any,h:any;try{h=await held('auth-failure',A);out=await h.finish();}finally{writeFileSync(A.envPath,credentials);}
   const unchanged=hash(join(h.dir,'before.sav'))===hash(join(h.dir,'after.sav'));
   record('auth-failure','native-actual-cli',{registeredBefore:!!row,serverRejected:out.replies.filter((x:AttributedAuthReply)=>x.type==='player_login'&&x.account===A.name.toLowerCase()&&x.response===1).length===1,dispatcherHeld:out.result?.sessionRecovered===false&&out.result.changed===false,
    receiptHeld:out.receipt?.state==='held',leaseHeld:existsSync(out.paths.lease),nonceConsumed:recoveryArtifactPresence(out.paths).nonceConsumed,receiptPresent:recoveryArtifactPresence(out.paths).receiptPresent,notCompleted:!existsSync(out.paths.completed),failureRetained:deathBytes()===h.ended,saveBytesUnchanged:unchanged},
    {account:A.name,persistence:'no fresh save; unchanged bytes are compared, not claimed as persistence',
     firstBoundary:{fleet:h.sub.fleet,child:h.sub.child,dispatch:out.result?.reason??null,authReplies:out.replies.length}});
   // 3 singleUse: a restarted dispatcher, a newer intent and a direct CLI replay all refuse at the actual boundary.
   const dir=caseDir('single-use'),attempts=listAttempts(A.name,A.server,{root:lifeRoot}).length,used=recoveryConsumptionBytes(out.paths.used),restarted=dispatcher(HOST);
   if(used===null)record('single-use','native-actual-dispatcher-restart',{nonceConsumed:false},{account:A.name});
   const replay=h.sub.raw;writeFileSync(channel+'.processing',replay);let from=resultRows().length;handoff(restarted,replay,A.name,'one-auth-failure-replay');const replayResult=await awaitResult(replay,from,5000);
   const newer=requestFor(A,h.runId,'two-single-use');const sub=submit(restarted,newer,h.taskOwner.pid);const newerResult=await awaitResult(sub.raw,sub.from,5000);
   const cli=Bun.spawn([process.execPath,runner,out.paths.input,out.paths.output,'--permit-base='+base],{cwd:root,env:{...process.env,WORKER_RELEASE:source},stdout:Bun.file(join(dir,'replay.log')),stderr:Bun.file(join(dir,'replay.err')),windowsHide:true});
   children.push(cli);const t=setTimeout(()=>void killTree(cli.pid),60000);const cliCode=await cli.exited;clearTimeout(t);fixtureFiles(A,dir);
   record('single-use','native-actual-dispatcher-restart',{replayRefused:/already handled/.test(replayResult?.reason??''),newerIntentRefused:/existing recovery lease held/.test(newerResult?.reason??'')&&!sub.child,
    cliReplayRefused:cliCode===1,noNewProducerIntent:listAttempts(A.name,A.server,{root:lifeRoot}).length===attempts,consumptionUnchanged:used!==null&&recoveryConsumptionBytes(out.paths.used)===used,leaseStillHeld:existsSync(out.paths.lease)},{account:A.name,cliCode});
  }
  // 4 stop: the fixture stop and the repository stop both refuse before a lease, child or producer intent.
  {
   const dir=caseDir('stop'),rows:any[]=[];
   for(const kind of ['fixture','repository'] as const){
    // Each stop permanently retires its own identity. No later case may need this account.
    const S=await fixture(HOST,preset),since=Date.now(),path=join(kind==='fixture'?base:root,'.practice','stop-'+S.name);
    const stop=claimStopArtifact(path,`native recovery proof stop ${process.pid} ${randomUUID()}`);ownedStops.push(stop);
    const {runId,owner:o}=await task(S,'stop-'+kind),r=requestFor(S,runId,'one-stop-'+kind),sub=submit(d8890,r,o.pid),result=await awaitResult(sub.raw,sub.from,5000);
    rows.push({kind,account:S.name,path,result,child:sub.child,lease:existsSync(recoveryPermitPaths(r,base).lease),
     noProducerIntent:!existsSync(accountDir(S.name,S.server,lifeRoot)),noLogin:noRecoveryLogin(loginLog(),since,S.name),retention:releaseStopArtifact(stop)});
    writeFileSync(join(dir,kind+'-auth-replies.json'),JSON.stringify(authReplies(loginLog(),since,S.name)));
    const fixtureDir=join(dir,kind);mkdirSync(fixtureDir,{recursive:true});fixtureFiles(S,fixtureDir);
    absenceGuards.push({id:'stop',f:S,since,attempts:[]});
   }
   writeFileSync(join(dir,'stop-results.json'),JSON.stringify(rows,null,2));
   record('stop','native-actual-dispatcher',{fixtureStopRefused:/no lease issued/.test(rows[0]?.result?.reason??'')&&!rows[0].child&&!rows[0].lease,repositoryStopRefused:/no lease issued/.test(rows[1]?.result?.reason??'')&&!rows[1].child&&!rows[1].lease,
    distinctIdentities:rows[0].account!==rows[1].account,stopsRetained:rows.every(r=>existsSync(r.path)&&r.retention==='retained'),
    noProducerIntent:rows.every(r=>r.noProducerIntent),noLogin:rows.every(r=>r.noLogin)},{accounts:rows.map(r=>r.account)});
  }
  // 5 ownership: a live owner visible to the controller refuses before a lease. Direct API and unqualified remote CLI refuse before any intent.
  {
   const B=await fixture(HOST,preset),dir=caseDir('ownership'),o=await owner(B,dir,'hold',lifeRoot),since=Date.now();
   const ownerAttempts=listAttempts(B.name,B.server,{root:lifeRoot}).map(a=>a.attemptId).sort();
   const {runId,owner:t}=await task(B,'ownership'),r=requestFor(B,runId,'one-ownership'),sub=submit(d8890,r,t.pid),result=await awaitResult(sub.raw,sub.from,5000);
   const remote='rs-sdk-demo.fly.dev',plain={schema:'session-recovery/1' as const,account:B.name,server:remote,runId,nonce:'direct-api',endedAt:B.endedAt,source};
   let connects=0,directError='';
   try{await recoverSession(plain,{root:lifeRoot,guard:()=>{},connect:async()=>{connects++;throw Error('must not connect');},ready:async()=>false,closeModal:async()=>false,logout:async()=>'unconfirmed',close:async()=>{}});}catch(e){directError=String(e);}
   const cliCodes:number[]=[];
   for(const [i,body] of [{...plain,nonce:'plain-cli'},{...requestFor({...B,server:remote},runId,'remote-cli')}].entries()){
    const input=join(dir,`remote-${i}.json`);writeFileSync(input,JSON.stringify(body));
    const p=Bun.spawn([process.execPath,runner,input,join(dir,`remote-${i}-out`)],{cwd:root,env:{...process.env,WORKER_RELEASE:source},stdout:Bun.file(join(dir,`remote-${i}.log`)),stderr:Bun.file(join(dir,`remote-${i}.err`)),windowsHide:true});
    children.push(p);const tm=setTimeout(()=>void killTree(p.pid),60000);cliCodes.push(await p.exited);clearTimeout(tm);
   }
   // Capture refusal BEFORE asking the legitimate owner to log out. Keep cleanup and later evidence too.
   const refusal={at:Date.now(),since,auth:observeAuth(loginLog()),attempts:listAttempts(B.name,B.server,{root:lifeRoot}).map(a=>a.attemptId).sort(),result,child:sub.child,lease:existsSync(recoveryPermitPaths(r,base).lease)};
   writeFileSync(join(dir,'refusal-interval.json'),JSON.stringify(refusal,null,2));
   const ownerLoginReplyAt=latestOwnerLoginBefore(loginLog(),B.name,since),releaseAt=await o.release();
   const ownerAuth=await waitOwnerAuthLogout(loginLog,B.name,{releaseAt,ownerLoginReplyAt});
   const replies=authReplies(ownerAuth,since,B.name),cleanup=readLogoutProof(B.name,B.server,{root:lifeRoot});
   const preserved=ownerSessionEvidence(ownerAuth,B.name,{since,releaseAt,ownerLoginReplyAt,ownerAttempt:o.ready.attemptId,latestAttemptBeforeRelease:refusal.attempts.at(-1)});
   writeFileSync(join(dir,'owner-evidence.json'),JSON.stringify({releaseAt,preserved},null,2));
   writeFileSync(join(dir,'refusals.json'),JSON.stringify({result,directError,connects,cliCodes},null,2));writeFileSync(join(dir,'auth-replies.json'),JSON.stringify(replies));fixtureFiles(B,dir,r);
   absenceGuards.push({id:'ownership',f:B,since,attempts:ownerAttempts});
   record('ownership','native-actual-dispatcher',{liveOwnerRefused:/no lease issued/.test(result?.reason??'')&&!sub.child&&!existsSync(recoveryPermitPaths(r,base).lease),
    ownerUndisturbed:preserved.ok,
    directApiRefused:/not qualified/.test(directError)&&connects===0,remoteCliRefused:cliCodes.every(c=>c===1),
    noRemoteIntent:!existsSync(accountDir(B.name,remote))&&!existsSync(accountDir(B.name,remote,lifeRoot)),
    initialOwnerLogin:authReplies(loginLog(),0,B.name,'player_login').filter(x=>x.response===0&&x.requestAt<since).length===1,
    ownerCleanupConfirmed:cleanup.state==='confirmed'&&cleanup.attemptId===o.ready.attemptId&&replies.filter(x=>x.type==='player_logout'&&x.response===0).length===1,
    noNewProducerAttempt:isDeepStrictEqual(ownerAttempts,refusal.attempts)&&isDeepStrictEqual(ownerAttempts,listAttempts(B.name,B.server,{root:lifeRoot}).map(a=>a.attemptId).sort()),
    noRecoveryLogin:noRecoveryLogin(loginLog(),since,B.name)},{account:B.name,ownerPid:o.ready.pid});
  }
  // 6 cooldown: an owner the controller cannot see holds a fresh takeover; the real server refuses and the outcome stays held.
  // Task, permit inputs and request exist first. The owner then takes over its own session and the request is submitted at once.
  {
   const C=await fixture(HOST,preset),dir=caseDir('cooldown'),external=join(directory,'external-lifecycle'),o=await owner(C,dir,'warm',external);
   let warm=undefined as Awaited<ReturnType<typeof o.takeover>>|undefined;
   const h=await held('cooldown',C,d8890,async()=>{warm=await o.takeover();}),out=await h.finish();
   const window=classifyCooldownWindow(loginLog(),C.name,{signalAt:warm!.signalAt,warmAt:warm!.at,since:h.submittedAt,windowMs:TAKEOVER_WINDOW_MS});
   const ownerLoginReplyAt=(window as {takeoverReplyAt?:number}).takeoverReplyAt;
   const ownerAttempts=listAttempts(C.name,C.server,{root:external}).map(a=>a.attemptId).sort(),releaseAt=await o.release();
   const ownerAuth=await waitOwnerAuthLogout(loginLog,C.name,{releaseAt,ownerLoginReplyAt});
   const proof=readLogoutProof(C.name,C.server,{root:lifeRoot}),ownerProof=readLogoutProof(C.name,C.server,{root:external});
   const preserved=ownerSessionEvidence(ownerAuth,C.name,{since:h.submittedAt,releaseAt,ownerLoginReplyAt,ownerAttempt:warm!.attemptId,latestAttemptBeforeRelease:ownerAttempts.at(-1)});
   const replies=authReplies(ownerAuth,h.since,C.name);writeFileSync(join(dir,'auth-replies.json'),JSON.stringify(replies));
   writeFileSync(join(dir,'cooldown-window.json'),JSON.stringify({warm,submittedAt:h.submittedAt,releaseAt,window,preserved,ownerAttempts,ownerProof},null,2));
   record('cooldown','native-actual-cli',{takeoverWindowOpen:window.ok===true,serverCooldown:window.ok===true&&out.replies.filter((x:AttributedAuthReply)=>x.type==='player_login'&&x.account===C.name.toLowerCase()&&x.response===3).length===1,
    dispatcherHeld:out.result?.sessionRecovered===false,receiptHeld:out.receipt?.state==='held',
    leaseHeld:existsSync(out.paths.lease),producerHeld:proof.state==='held',notRecovered:!recoveredSessionForRun(C.name,C.server,h.runId,source,base),
    activeOwnerPreserved:preserved.ok,ownerLogoutConfirmed:ownerProof.state==='confirmed'&&ownerProof.attemptId===warm!.attemptId,failureRetained:deathBytes()===h.ended},
    {account:C.name,owner:'external private lifecycle root; invisible to the controller by design',reason:window.reason,window});
  }
  // 7 orphan: the owner process dies while its producer attempt is unresolved; the controller recovers after the takeover window.
  {
   const D=await fixture(HOST,preset),dir=caseDir('orphan'),o=await owner(D,dir,'orphan',lifeRoot);
   const killedAt=Date.now();await killTree(o.p.pid);await o.p.exited;
   // The world removes the dead player only after its no-connection timeout; recovery enters after that observed end.
   let end=orphanServerEnd(loginLog(),D.name,killedAt);const endBy=Date.now()+240000;
   while(!end.ok&&Date.now()<endBy){await Bun.sleep(100);end=orphanServerEnd(loginLog(),D.name,killedAt);}
   writeFileSync(join(dir,'orphan-server-end.json'),JSON.stringify({killedAt,...end}));
   if(!end.ok)throw Error('orphan server-side logout not observed');
   const wait=o.ready.loggedInAt+TAKEOVER_WINDOW_MS+1000-Date.now();if(wait>0)await Bun.sleep(wait);
   const old=o.ready.attemptId,heldBefore=readLogoutProof(D.name,D.server,{root:lifeRoot}),since=Date.now();
   const pos=o.ready.state.player,c=await positive('orphan',D,{x:pos.x,z:pos.z,level:pos.level});
   const oldAttempt=listAttempts(D.name,D.server,{root:lifeRoot}).find(a=>a.attemptId===old),gap=loginAfterTakeoverWindow(loginLog(),D.name,since,TAKEOVER_WINDOW_MS);
   writeFileSync(join(c.dir,'takeover-window.json'),JSON.stringify({since,windowMs:TAKEOVER_WINDOW_MS,...gap}));
   c.record('native-actual-cli',{orphanHeldBefore:heldBefore.state==='held'&&heldBefore.attemptId===old,oldAttemptStillUnconfirmed:!!oldAttempt?.receipt&&!oldAttempt.receipt.events.some(e=>e.kind==='ended'&&e.detail==='logged-out'),afterTakeoverWindow:gap.ok,serverEndedBeforeRecovery:end.at!==null&&end.at<since});
  }
  // 8 modal: a fresh character logs in to the server-opened design screen; the actual CLI closes it and confirms.
  {
   const M=await fixture(HOST,{...preset,position:{x:3094,z:3106,level:0},varps:{281:0,300:1000}});
   if(readPracticeSave(M.save).vars[281]!==0)throw Error('modal fixture tutorial varp not applied');
   const c=await positive('modal',M,undefined,r=>({modalObservedOpen:r?.before?.modalOpen===true,modalClosed:r?.after?.modalOpen===false}));
   // Server-side dispatch of the accept button, retained before the case verdict can stop the proof.
   const buttons=readFileSync(buttonTrace,'utf8');
   writeFileSync(join(c.dir,'button-dispatch.json'),JSON.stringify({attach:buttons.match(/^BUTTON_ATTACH (.*)$/m)?.[1]??null,...buttonTraceFor(buttons,M.name)},null,1));
   c.record('native-actual-cli',{},);
   writeFileSync(join(c.dir,'server-side-effect.json'),JSON.stringify({varp281Before:c.before.vars[281],varp281After:c.after.vars[281],note:'player_kit close trigger advances tutorial progress; stock, skills and position are reconciled separately'}));
   cases.at(-1)!.evidence=evidenceFiles(directory,join('cases','modal'));progress();
  }
  // 9 timeout + restart/late callback: a recovery stalled before START is killed at its deadline and stays held.
  // While it runs, a restarted dispatcher observes the inherited child, refuses a newer intent and the old bytes.
  {
   const T=await fixture(RELAY,preset),d1=dispatcher(RELAY);relay.set('stall');
   const h=await held('timeout',T,d1),dir=h.dir,childPid=h.sub.child;
   const until=Date.now()+30000;while(Date.now()<until&&!listAttempts(T.name,T.server,{root:lifeRoot}).some(a=>a.receipt?.owner.pid===childPid))await Bun.sleep(100);
   const late=caseDir('restart-late-callback'),d2=dispatcher(RELAY),inherited=heldRecoveryOwners(base);
   const newer=requestFor(T,h.runId,'two-timeout'),nsub=submit(d2,newer,h.taskOwner.pid),newerResult=await awaitResult(nsub.raw,nsub.from,5000);
   writeFileSync(channel+'.processing',h.sub.raw);const from=resultRows().length;handoff(d2,h.sub.raw,T.name,'one-timeout-replay');const replayResult=await awaitResult(h.sub.raw,from,5000);
   const rowsBeforeLate=resultRows().length;
   const out=await h.finish(rowsBeforeLate);relay.set('forward');
   const rowsAfter=resultRows(),lateRow=rowsAfter.slice(rowsBeforeLate).find(x=>x.raw===h.sub.raw),proof=readLogoutProof(T.name,T.server,{root:lifeRoot});
   const childAttempt=listAttempts(T.name,T.server,{root:lifeRoot}).find(a=>a.receipt?.owner.pid===childPid);
   record('timeout','native-actual-cli-stalled-endpoint',{stalledBeforeStart:!!childAttempt?.receipt&&!childAttempt.receipt.events.some(e=>e.kind==='ready'),dispatcherHeld:out.result?.sessionRecovered===false,
    noConfirmedReceipt:out.receipt?.state!=='confirmed',leaseHeld:existsSync(out.paths.lease),notCompleted:!existsSync(out.paths.completed),producerHeld:proof.state==='held',
    childEnded:childPid!==null&&!(()=>{try{process.kill(childPid,0);return true;}catch{return false;}})(),failureRetained:deathBytes()===h.ended},{account:T.name,childPid,receipt:out.receipt?.state??'absent'});
   writeFileSync(join(late,'restart.json'),JSON.stringify({inherited,newerResult,replayResult,lateRow},null,2));fixtureFiles(T,late);
   record('restart-late-callback','native-actual-dispatcher-restart',{inheritedChildCounted:inherited.some(x=>x.account===T.name&&x.pid===childPid),newerIntentRefused:/existing recovery lease held/.test(newerResult?.reason??'')&&!nsub.child,
    oldBytesRefused:/already handled/.test(replayResult?.reason??''),lateCallbackHeld:lateRow?.result?.sessionRecovered===false,lateCallbackKeptLease:existsSync(out.paths.lease)&&!existsSync(out.paths.completed),
    newerNotLaunched:!existsSync(recoveryPermitPaths(newer,base).permit),notRecovered:!recoveredSessionForRun(T.name,T.server,h.runId,source,base)},{account:T.name});
  }
  // 10 partial: a producer intent before START. Its live owner refuses; after that owner dies the controller recovers.
  {
   const P=await fixture(RELAY,preset),dir=caseDir('partial-owner-alive'),d=dispatcher(RELAY);relay.set('stall');
   const o=await afterStalledConnection(relay.stalled,()=>owner(P,dir,'partial',lifeRoot));
   const selected=observePartialOwner(P.name,P.server,lifeRoot,o.ready.pid);
   writeFileSync(join(dir,'partial-observations.json'),JSON.stringify({ownerReady:o.ready,observations:[selected],selectedIndex:0,timedOut:false},null,2));
   // One read after actual stalled acceptance, even when invalid. Do not poll away a failed conjunct.
   const partial=selected.proof,since=Date.now(),ownerAttempts=selected.attempts.map(a=>a.attemptId).sort();
   const {runId,owner:t}=await task(P,'partial-alive'),r=requestFor(P,runId,'one-partial-alive'),sub=submit(d,r,t.pid),result=await awaitResult(sub.raw,sub.from,5000);
   const paths=recoveryPermitPaths(r,base),refusal={at:Date.now(),since,result,child:sub.child,lease:existsSync(paths.lease),permit:existsSync(paths.permit),
    noRecoveryLogin:noRecoveryLogin(loginLog(),since,P.name),attempts:listAttempts(P.name,P.server,{root:lifeRoot}).map(a=>a.attemptId).sort()};
   writeFileSync(join(dir,'partial-refusal.json'),JSON.stringify(refusal,null,2));
   await killTree(o.p.pid);await o.p.exited;fixtureFiles(P,dir,r);
   record('partial-owner-alive','native-actual-dispatcher',{partialIntentHeld:partial.state==='held'&&/before START/.test(partial.reason),liveOwnerRefused:/no lease issued/.test(result?.reason??'')&&!sub.child,
    observedLiveOwner:selected.checks.ownerAlive,noLeaseIssued:!refusal.lease,noPermitIssued:!refusal.permit,noRecoveryLogin:refusal.noRecoveryLogin,
    noNewProducerAttempt:isDeepStrictEqual(ownerAttempts,refusal.attempts)}, {account:P.name,ownerPid:o.ready.pid,observationChecks:selected.checks});
   relay.set('forward');
   const c=await positive('partial',P,undefined,()=>({}),d);
   const old=listAttempts(P.name,P.server,{root:lifeRoot}).find(a=>a.receipt?.owner.pid===o.ready.pid);
   c.record('native-actual-cli',{oldPartialUnconfirmed:!!old?.receipt&&!old.receipt.events.some(e=>e.kind==='ended')});
  }
  // 11 stock negative controls on the real offline saves.
  {
   const dir=caseDir('stock-negative-controls');copyFileSync(join(offline.dir,'before.sav'),join(dir,'before.sav'));copyFileSync(join(offline.dir,'after.sav'),join(dir,'after.sav'));
   const controls=reconcileNegativeControls(readPracticeSave(join(dir,'before.sav')),readPracticeSave(join(dir,'after.sav')));
   writeFileSync(join(dir,'controls.json'),JSON.stringify(controls));record('stock-negative-controls','native-saved-reconciliation',controls);
  }
  // Quiesce the only world that can send requests, then seal the synchronous observer trace. Await
  // LoginServer exit too, so final absence covers the complete retained log, including teardown.
  for(const c of recoveryChildren)await safeKill(c.pid,c.nonce);
  if(world.exitCode===null)await killTree(world.pid);await world.exited;
  writeFileSync(sealRequest,'seal');
  const sealDeadline=Date.now()+5000;while(!existsSync(sealAck)&&Date.now()<sealDeadline){if(login.exitCode!==null)throw Error('auth observer exited before seal');await Bun.sleep(50);}
  if(!existsSync(sealAck))throw Error('auth observer seal timeout');
  if(login.exitCode===null)await killTree(login.pid);await login.exited;
  const completeAuth=observeAuth(loginLog(),true);
  writeFileSync(join(directory,'auth-complete.json'),JSON.stringify(completeAuth,null,2));
  for(const g of absenceGuards){
   const dir=caseDir(g.id),row=cases.find(c=>c.id===g.id)!;
   const auth=completeAuth,attempts=listAttempts(g.f.name,g.f.server,{root:lifeRoot}).map(a=>a.attemptId).sort();
   copyFileSync(authTrace,join(dir,'auth-observations.log')); // Bind the sealed raw trace through the existing evidence reader.
   const observedDir=g.id==='stop'||g.id==='completed-refusals'?join(dir,g.f.name):dir;mkdirSync(observedDir,{recursive:true});
   writeFileSync(join(observedDir,'subsequent-observation.json'),JSON.stringify({at:Date.now(),since:g.since,auth,attempts},null,2));fixtureFiles(g.f,observedDir);
   row.checks.noSubsequentLogin=row.checks.noSubsequentLogin!==false&&noRecoveryLogin(loginLog(),g.since,g.f.name);
   row.checks.noSubsequentProducerAttempt=row.checks.noSubsequentProducerAttempt!==false&&isDeepStrictEqual(g.attempts,attempts);
   row.ok=Object.values(row.checks).every(v=>v===true);
   const {evidence:previousEvidence,...details}=row;writeFileSync(join(dir,'checks.json'),JSON.stringify(details,null,2));row.evidence=evidenceFiles(directory,join('cases',g.id));
   retainRequiredRecoveryCase(row,()=>progress());
  }
  const checks=deriveChecks(cases);
  const bindings=Object.fromEntries([RECOVERY_SCRIPT,'packages/core/src/session-recovery-permit.ts','packages/core/src/session-recovery-dispatch.ts','packages/core/src/session-lifecycle.ts','packages/core/src/inprocess.ts','scripts/swarm.ts','packages/practice/src/session-recovery-proof.ts',
   'vendor/rs-sdk/server/engine/src/server/login/LoginServer.ts','vendor/rs-sdk/server/engine/src/engine/World.ts','vendor/rs-sdk/server/content/scripts/tutorial/scripts/tutorial.rs2'].map(p=>[p,hash(join(root,p))]));
  if(routerPins&&!isDeepStrictEqual(routerPins,verifyCompletedRouterPins()))throw Error('completed router integration changed during proof');
  const proof={ok:cases.every(c=>c.ok)&&Object.values(checks).every((c:any)=>c.ok)&&source===workerSourceRevision()&&runnerSha256===hash(runner),
   level:'native-controller-recovery',at:Date.now(),runtimeRevision:source,runnerSha256,bindings,
   server:{host:HOST,relay:RELAY,loginPort:LOGIN_PORT,tickMs:150,takeoverWindowMs:TAKEOVER_WINDOW_MS,world:sha(JSON.stringify(worldConfig)),observer:hash(observer)},
   starting:{at:startedAt,freeGiB:startFreeGiB,fenceSha256:null},controller:{pid:process.pid,marker:CONTROLLER_MARKER,argv:process.argv.slice(1)},
   scope:'Private native practice world only. Session cleanup is not game production, does not repair an account end and does not qualify any gameplay script. No live login.',
   capability,routerPins,cases,checks};
  const proofPath=join(directory,'proof.json');writeFileSync(proofPath,JSON.stringify(proof,null,2));
  if(!proof.ok)throw Error('native recovery cases failed: '+cases.filter(c=>!c.ok).map(c=>c.id+':'+Object.entries(c.checks).filter(([,v])=>v!==true).map(([k])=>k).join('/')).join(', '));
  verifyNativeRecoveryProof(proof,directory,{runtimeRevision:source,runnerSha256});
  return {path:proofPath,sha256:hash(proofPath)};
 }catch(error){writeFileSync(join(directory,'failure.json'),JSON.stringify({at:Date.now(),reason:String(error),source,cases},null,2));throw error;}
 finally{
  if(pulse)clearInterval(pulse);relay?.stop();
  for(const stop of ownedStops)try{releaseStopArtifact(stop);}catch{/* retained for inspection */}
  for(const c of recoveryChildren)await safeKill(c.pid,c.nonce);
  for(const c of children.reverse())if(c.exitCode===null)await killTree(c.pid);
  if(saved.rsan===undefined)delete process.env.LOGIN_RSAN;else process.env.LOGIN_RSAN=saved.rsan;
  if(saved.rsae===undefined)delete process.env.LOGIN_RSAE;else process.env.LOGIN_RSAE=saved.rsae;
  if(saved.release===undefined)delete process.env.WORKER_RELEASE;else process.env.WORKER_RELEASE=saved.release;
  // Remove only the junction entries, never their shared targets.
  for(const j of junctions)try{if(lstatSync(j).isSymbolicLink())rmdirSync(j);}catch{}
  closeSync(fd);unlinkSync(lock);
 }
}
if(import.meta.main){
 try{
  if(!process.env.DELIVERY_DIR)throw Error('run through the '+recoveryCapability()+' delivery harness');
  const emitted=await run(resolve(process.env.DELIVERY_DIR));
  console.log('RECOVERY_NATIVE_PROOF '+JSON.stringify(emitted));process.exit(0);
 }catch(e){console.error(String(e));process.exit(1);}
}
