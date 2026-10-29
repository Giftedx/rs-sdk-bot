import {appendFileSync,existsSync,readFileSync,renameSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
import {launchPermittedRecovery,recoveryPermitPaths,validateRecoveryRequest,assertNativeFixtureRoot,assertRecoveryNotStopped,type ControlledRecoveryRequest} from './session-recovery-permit';
import {workerSourceRevision} from './worker-release';

type ActiveRecovery={account:string;started:number;pid:number};
type Launch={child:{pid:number};completion:Promise<unknown>};
type DispatchOptions={base:string;server:string;nativeFixture?:boolean;admit?:(request:ControlledRecoveryRequest)=>void;
 launch?:(request:ControlledRecoveryRequest)=>Launch;now?:()=>number;log?:(line:string)=>void};
// The existing swarm's asynchronous repair branch. Native proof invokes this SAME handler with an isolated
// local state tree; it does not start a second production controller or copy the dispatch logic.
export function createRecoveryDispatch(options:DispatchOptions){
 const {base,server}=options,now=options.now??Date.now;
 const log=(line:string)=>{try{(options.log??console.log)(line);}catch{/* logging cannot release ownership or retry a child */}};
 if(options.nativeFixture)assertNativeFixtureRoot(base,server);else if(server!=='rs-sdk-demo.fly.dev')throw Error('recovery dispatch fixture/server boundary invalid');
 const file=join(base,'.practice/swarm-repair.json'),claimed=file+'.processing';
 let active:ActiveRecovery|undefined,pendingReceipt:{raw:string;result:unknown;archive?:string;logged:boolean}|undefined;
 const seen=new Set<string>();
 const owns=(raw:string)=>existsSync(claimed)&&readFileSync(claimed,'utf8')===raw;
 const receipt=(raw:string,result:unknown)=>appendFileSync(file+'.results.jsonl',JSON.stringify({at:now(),raw,result})+'\n');
 const remove=(raw:string)=>{if(owns(raw))rmSync(claimed);};
 const flush=()=>{
  const pending=pendingReceipt;if(!pending)return;
  if(!pending.logged){receipt(pending.raw,pending.result);pending.logged=true;}
  if(pending.archive){if(owns(pending.raw))renameSync(claimed,pending.archive);}else remove(pending.raw);
  pendingReceipt=undefined;
 };
 const emit=(raw:string,result:unknown,archive?:string)=>{pendingReceipt={raw,result,archive,logged:false};flush();};
 const launch=options.launch??((r:ControlledRecoveryRequest)=>launchPermittedRecovery(r,base,options.nativeFixture?{nativeFixture:true,source:()=>workerSourceRevision()}:{}));
 return{
  get active():Readonly<ActiveRecovery>|undefined{return active?{...active}:undefined;},
  handle(raw:string,admit=options.admit):boolean{
   const wasPending=pendingReceipt?.raw===raw;if(pendingReceipt){flush();if(wasPending)return true;}
   let request:any;try{request=JSON.parse(raw);}catch{return false;}
   if(request?.kind!=='session-recovery')return false;
   if(!owns(raw))throw Error('recovery processing ownership changed');
   if(active)return true;
   if(seen.has(raw)){emit(raw,{changed:false,sessionRecovered:false,reason:'recovery request already handled; no retry'});return true;}
   if(options.nativeFixture)assertNativeFixtureRoot(base,server);
   // Claim the exact bytes before any admission decision. An ambiguous crash or lost result
   // then needs an explicit replacement request, including when no account permit was issued.
   const digest=createHash('sha256').update(raw).digest('hex'),handled=join(base,'.practice/coordinator/session-recovery/dispatch',digest+'.json');
   mkdirSync(dirname(handled),{recursive:true});
   try{writeFileSync(handled,JSON.stringify({schema:'session-recovery-dispatch/1',at:now(),pid:process.pid,requestSha256:digest}),{flag:'wx'});seen.add(raw);}
   catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;seen.add(raw);emit(raw,{changed:false,sessionRecovered:false,reason:'recovery request already handled or interrupted; inspect retained account lease and child output; no retry'});return true;}
   try{validateRecoveryRequest(request);if(request.server!==server)throw Error('recovery dispatch server mismatch');}
   catch{seen.add(raw);emit(raw,{changed:false,sessionRecovered:false,reason:'invalid controlled recovery request; no lease issued'});return true;}
   // The real launcher independently verifies the qualification files; the dispatch schema above
   // establishes the base identity and kind without treating caller JSON as native evidence.
   const controlled=request as ControlledRecoveryRequest;
   const paths=recoveryPermitPaths(request,base);
   if(existsSync(paths.lease)){
    seen.add(raw);
    emit(raw,{changed:false,sessionRecovered:false,reason:'existing recovery lease held; inspect original child; no retry'},join(dirname(paths.lease),'processing-held-'+request.nonce+'-'+now()+'.json'));
    log('SWARM recovery held: existing account lease; request preserved; no retry');return true;
   }
   try{
    if(existsSync(join(base,'.practice/coordinator/build-lock.json')))throw Error('recovery waits for runtime source owner');
    assertRecoveryNotStopped(request.account,base);
    if(!admit)throw Error('recovery admission unavailable');admit(controlled);
    const started=now(),launched=launch(controlled);seen.add(raw);active={account:request.account,started,pid:launched.child.pid};
    const finished=(result:unknown)=>{
     try{emit(raw,result);}
     catch{log('SWARM recovery result persistence failed; retained for review');}
     finally{active=undefined;}
    };
    void launched.completion.then(completed=>finished({changed:false,sessionRecovered:true,completed,reason:'confirmed session cleanup; old failure retained'}),
     ()=>finished({changed:false,sessionRecovered:false,reason:'recovery child held; inspect fixed child output and retained account lease; no retry'}));
   }catch{
    seen.add(raw);
    const leased=existsSync(paths.lease);
    emit(raw,{changed:false,sessionRecovered:false,reason:leased?'recovery setup failed after issuance; account lease held; no retry':'recovery setup refused; no lease issued; no retry'});
   }
   return true;
  },
 };
}
