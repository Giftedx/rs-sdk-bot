// Native controller recovery proof (gate native-session-recovery). Practice only, never game production.
// A private SQLite/LoginServer/World with fresh test keys, private saves and immutable-content junctions. Every
// recovery goes through the SAME createRecoveryDispatch, swarm admitRecovery policy, launchPermittedRecovery,
// core session-recovery CLI, per-account producer and finishRecoveryPermit that the swarm uses. Raw records and
// proof.json go to DELIVERY_DIR. On success it prints exactly one RECOVERY_NATIVE_PROOF {path,sha256} line.
import {appendFileSync,closeSync,copyFileSync,cpSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {freemem} from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {EventEmitter} from 'node:events';
import {RECOVERY_SCRIPT,heldRecoveryOwners,launchPermittedRecovery,recoveryPermitPaths,recoveredSessionForRun,verifyNativeRecoveryProof,type ControlledRecoveryRequest} from '../../core/src/session-recovery-permit';
import {createRecoveryDispatch} from '../../core/src/session-recovery-dispatch';
import {recoveryDiagnosticFromLog} from '../../core/src/session-recovery';
import {accountDir,readLogoutProof,listAttempts} from '../../core/src/session-lifecycle';
import {launchRevision,cachedLaunchRevision} from '../../core/src/worker-release';
import {proveSwarmRecoveryContinuation} from './swarm-recovery-chain';
import {admitRecovery} from '../../../scripts/swarm';
import {missionSignature} from '../../core/src/session-admission';
import {readPracticeSave,waitPracticeSave} from './fleet-player-save';
import {canBind} from './ports';
import {killTree,safeKill,sleeperCommand} from '../../core/src/proc';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {TAKEOVER_WINDOW_MS,authReplies,loginAfterTakeoverWindow,noRecoveryLogin,orphanRecoveryReadyAt,orphanServerEnd,recoverySessionAuth,type AttributedAuthReply} from './session-recovery-proof/auth';
import {CONTROLLER_MARKER,claimStopArtifact,evidenceFiles,fleetHandoff,hash,observeRecoveryBoundary,publishControlFile,recoveryArtifactPresence,recoveryAuthorityInputs,recoveryCapability,recoveryMemoryGate,releaseStopArtifact,retainRequiredRecoveryCase,root,runner,serveAnyHost,sha,worldHost,type ControlWriteOps,type OwnedStop,type RecoveryBoundary} from './session-recovery-proof/boundary';
import {CHECK_CASES,afterStalledConnection,deriveChecks,observePartialOwner,reconcileSaves,type Save} from './session-recovery-proof/reconcile';
import {createFixtureOwner,runSessionCheckCase,startPrivateEnvironment} from './session-recovery-proof/servers';
import {runAuthAndSingleUseSuite,runCompletedSuite,runModalAndTimeoutSuite,runOwnershipAndCooldownSuite,runStockAndFinalizeGuards,type Fixture,type ProofCaseContext} from './session-recovery-proof/cases';

export {TAKEOVER_WINDOW_MS,authReplies,classifyCooldownWindow,latestOwnerLoginBefore,loginAfterTakeoverWindow,noRecoveryLogin,observeAuth,orphanRecoveryReadyAt,orphanServerEnd,ownerSessionEvidence,recoverySessionAuth,waitOwnerAuthLogout,waitRecoveryRuntime,type AttributedAuthReply} from './session-recovery-proof/auth';
export {RECOVERY_MEMORY_WAIT_MS,claimStopArtifact,evidenceFiles,fleetHandoff,observeRecoveryBoundary,publishControlFile,recoveryArtifactPresence,recoveryAuthorityInputs,recoveryCapability,recoveryConsumptionBytes,recoveryMemoryGate,releaseStopArtifact,requireRecoveryRegistration,retainRequiredRecoveryCase,serveAnyHost,verifyCompletedRecoveryDelivery,worldHost,type ControlWriteOps,type OwnedStop,type RecoveryBoundary} from './session-recovery-proof/boundary';
export {buttonTraceFor,installAuthObserver,installButtonObserver,installLocObserver} from './session-recovery-proof/observers';
export {CHECK_CASES,afterStalledConnection,deriveChecks,observePartialOwner,reconcileNegativeControls,reconcileSaves,stockOf} from './session-recovery-proof/reconcile';

const HOST=worldHost(8890),RELAY='localhost:8899',LOGIN_PORT=43650,PORTS=[8890,8896,8897,8899,43650,43651];

// Websocket relay to the private world. 'stall' accepts the socket and never answers: a real pre-START hang.
function startRelay(port:number,target:number){
 let mode:'forward'|'stall'='forward';const sockets=new Set<any>(),stalled=new EventEmitter();
 const server=serveAnyHost<{upstream:WebSocket|null;queue:any[];stalled:boolean}>({port,
  async fetch(req,srv){
   if(req.headers.get('upgrade')?.toLowerCase()==='websocket'){
    if(srv.upgrade(req,{data:{upstream:null,queue:[],stalled:mode==='stall'},headers:{'Sec-WebSocket-Protocol':'binary'}}))return undefined;
    return new Response('upgrade failed',{status:400});
   }
   const url=new URL(req.url);return fetch(`http://${worldHost(target)}${url.pathname}${url.search}`);
  },
  websocket:{
   open(ws){sockets.add(ws);if(ws.data.stalled){stalled.emit('stalled');return;}const up=new WebSocket(`ws://${worldHost(target)}`,'binary');up.binaryType='arraybuffer';ws.data.upstream=up;
    up.onopen=()=>{for(const m of ws.data.queue)up.send(m);ws.data.queue=[];};
    up.onmessage=e=>{try{ws.sendBinary(new Uint8Array(e.data as ArrayBuffer));}catch{}};up.onclose=()=>{try{ws.close();}catch{}};up.onerror=()=>{try{ws.close();}catch{}};},
   message(ws,m){if(ws.data.stalled)return;const up=ws.data.upstream;if(up?.readyState===WebSocket.OPEN)up.send(m);else ws.data.queue.push(m);},
   close(ws){sockets.delete(ws);try{ws.data.upstream?.close();}catch{}},
  }});
 return {stalled,set(m:'forward'|'stall'){mode=m;},stop(){for(const s of sockets)try{s.close();}catch{}server.stop(true);}};
}

async function run(directory:string){
 const taskPath=join(directory,'task.json'),deliveryTask=existsSync(taskPath)?JSON.parse(readFileSync(taskPath,'utf8')):null;
 const capability=recoveryCapability(process.env.DELIVERY_ID??deliveryTask?.id);
 if(deliveryTask&&deliveryTask.id!==capability)throw Error('recovery delivery identity mismatch');
 const startedAt=Date.now(),startFreeGiB=freemem()/2**30;
 if(startFreeGiB<PRACTICE_STARTUP_GB)throw Error(`native recovery needs${PRACTICE_STARTUP_GB}GiB startup reserve; observed `+startFreeGiB.toFixed(2));
 for(const port of PORTS)if(!canBind(port))throw Error('native recovery port owned: '+port);
 if(existsSync(join(directory,'proof.json'))||existsSync(join(directory,'control')))throw Error('native recovery directory already used');
 // Isolated proof owns only the practice mutex. Runtime revision and runner hash bind its source.
 mkdirSync(directory,{recursive:true});
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:capability,mode:'native-session-recovery'}));
 const source=launchRevision(),runnerSha256=hash(runner),base=join(directory,'control'),workspace=join(directory,'isolated-engine'),lifeRoot=join(base,'.practice/session-lifecycle');
 const children:ReturnType<typeof Bun.spawn>[]=[],recoveryChildren:{pid:number;nonce:string}[]=[],cases:any[]=[],tasks=new Map<string,any>(),ends:Record<string,any>={},jobs:any[]=[];
 const ownedStops:OwnedStop[]=[],junctions:string[]=[];
 const saved={rsan:process.env.LOGIN_RSAN,rsae:process.env.LOGIN_RSAE,release:process.env.WORKER_RELEASE,plan:process.env.SWARM_PLAN};
 let relay:ReturnType<typeof startRelay>|undefined,pulse:ReturnType<typeof setInterval>|undefined,stamp=String(Date.now()).slice(-6);
 const put=(path:string,value:unknown)=>publishControlFile(join(base,path),value);
 const progress=()=>writeFileSync(join(directory,'progress.json'),JSON.stringify({source,runnerSha256,cases},null,2));
 try{
  const envState=await startPrivateEnvironment({directory,workspace,loginPort:LOGIN_PORT,loginEnv:{WEB_MANAGEMENT_PORT:'8897',LOGIN_TAKEOVER_MIN_MS:String(TAKEOVER_WINDOW_MS)},children,junctions});
  const {jwk,worldConfig,observer,authTrace,sealRequest,sealAck,buttonTrace,login,world,loginLog}=envState;
  relay=startRelay(8899,8890);
  process.env.LOGIN_RSAN=BigInt('0x'+Buffer.from(jwk.n!,'base64url').toString('hex')).toString();process.env.LOGIN_RSAE='65537';process.env.WORKER_RELEASE=source;
  // Recheck refusal windows against the complete subsequent log, not just a reply-time slice.
  const absenceGuards:{id:string;f:Fixture;since:number;attempts:string[]}[]=[];

  // Private control tree: the controller is this process; each case has a real task owner process.
  put(RECOVERY_SCRIPT,null);copyFileSync(runner,join(base,RECOVERY_SCRIPT));
  put('.practice/swarm-script-holds.json',[]);
  put('.practice/live/swarm-owner.json',{pid:process.pid,nonce:CONTROLLER_MARKER,source});
  // A decoy root plan must never grant or block a handoff plan's recovery authority.
  put('swarm.json',{maxBots:1,minFreeGB:1000,jobs:[{account:'NotOurActor',enabled:true,script:'scripts/session-check.ts'}]});
  process.env.SWARM_PLAN=join(base,'handoff/swarm.json');
  const writeState=()=>{
   for(const t of tasks.values())put('.practice/live/fleet-runs/'+t.runId+'/recovery.json',t);
   put('.practice/swarm-deaths.json',ends);put('handoff/swarm.json',{maxBots:17,minFreeGB:FREE_FLOOR_GB,jobs});
  };
  const beat=()=>put('.practice/swarm-state.json',{at:Date.now(),controllerPid:process.pid,jobs:jobs.map(j=>({account:j.account,state:'disabled'}))});
  // A failed timer publish keeps the previous complete view; the strict reader refuses it as stale, never malformed.
  writeState();beat();pulse=setInterval(()=>{try{beat();}catch{}},1000);
  const boundaries:RecoveryBoundary[]=[];
  const observeBoundary=(event:RecoveryBoundary)=>{boundaries.push(event);appendFileSync(join(directory,'recovery-boundaries.jsonl'),JSON.stringify(event)+'\n');};
  const admission=(account:string)=>{
   const owners=heldRecoveryOwners(base);
   return {owners,input:{account,active:[],running:owners.length,external:0,pending:0,freeGB:freemem()/2**30,minFreeGB:FREE_FLOOR_GB,maxBots:17}};
  };
  const memoryGate=recoveryMemoryGate(),recoveryMemory=(account:string)=>memoryGate(()=>admission(account).input);
  const dispatcher=(server:string)=>createRecoveryDispatch({base,server,nativeFixture:true,
   admit:r=>{
    const {owners,input}=admission(r.account);
    return observeRecoveryBoundary('admitRecovery',{admission:input,heldOwners:owners,authority:recoveryAuthorityInputs(base,r)},()=>admitRecovery(input),observeBoundary);
   },
   // Exactly the dispatcher's native default: same base, source callback and actual launcher.
   launch:r=>{
    fleetHandoff(beat,join(base,'.practice/swarm-state.json'),r.account,process.pid);
    return observeRecoveryBoundary('launchPermittedRecovery',recoveryAuthorityInputs(base,r),
     ()=>launchPermittedRecovery(r,base,{nativeFixture:true,source:()=>cachedLaunchRevision()}),observeBoundary);
   }});
  let fixtureIndex=0;
  const fixture=async(server:string,preset:Parameters<typeof applyPreset>[1],completed=false)=>{
   let name=runBotName('flrcv',++fixtureIndex);
   for(let tries=0;tries<40&&existsSync(join(root,'vendor/rs-sdk/bots',name));tries++)name=runBotName('flrcv',++fixtureIndex);
   if(existsSync(join(root,'vendor/rs-sdk/bots',name)))throw Error('fixture identity exists');
   await createBot(name);const envPath=join(root,'vendor/rs-sdk/bots',name,'bot.env');
   writeFileSync(envPath,readFileSync(envPath,'utf8').replace(/^SERVER=.*$/m,'SERVER='+server));
   const original=await applyPreset(name,preset),save=join(workspace,'data/players/main',name.toLowerCase()+'.sav');copyFileSync(original,save);
   const endedAt=Date.now();ends[name]={at:endedAt,reason:completed?'done after 1 runs':'blocked after 1 runs',...(completed?{revision:missionSignature({account:name,script:'scripts/retired-fixture.ts'})}:{})};jobs.push({account:name,script:'scripts/retired-fixture.ts',enabled:false});writeState();
   return {name,envPath,save,server,endedAt,completed};
  };
  const task=async(f:Fixture,id:string)=>{
   const runId=`native-rcv-${id}-${stamp}`;
   const owner=Bun.spawn(sleeperCommand(runId),{cwd:root,stdout:'ignore',stderr:'ignore',windowsHide:true});children.push(owner);
   tasks.set(runId,{status:'running',runId,pid:owner.pid,spec:{kind:'run',capability,account:f.name,...(f.completed?{env:{TRAIN_SKILL:'Attack',TARGET_LEVEL:'20',CAP:'1500'}}:{}),repairs:[{account:f.name,endedAt:f.endedAt}],sessionRecovery:{account:f.name,endedAt:f.endedAt}}});
   put('.practice/live/fleet-runs/'+runId+'/owner.json',{pid:owner.pid,runId});writeState();
   return {runId,owner};
  };
  const requestFor=(f:Fixture,runId:string,nonce:string):ControlledRecoveryRequest=>({schema:'session-recovery/1',kind:'session-recovery',account:f.name,server:f.server,runId,nonce,endedAt:f.endedAt,source,
   qualification:{delivery:{path:'native-fixture-not-qualified',sha256:'0'.repeat(64)},proof:{path:'native-fixture-not-qualified',sha256:'0'.repeat(64)}}});
  const channel=join(base,'.practice/swarm-repair.json'),resultsFile=channel+'.results.jsonl';
  const resultRows=()=>existsSync(resultsFile)?readFileSync(resultsFile,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
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
  const selectedPlan=JSON.parse(readFileSync(process.env.SWARM_PLAN??join(base,'handoff/swarm.json'),'utf8'));
  record('selected-plan','native-actual-controller-selection',{
   handoffLimits:selectedPlan.maxBots===17&&selectedPlan.minFreeGB===FREE_FLOOR_GB,
   excludesRootJobs:!selectedPlan.jobs.some((j:any)=>j.account==='NotOurActor'),
   rootPlanRetained:JSON.parse(readFileSync(join(base,'swarm.json'),'utf8')).maxBots===1,
  });
  const owner=(f:Fixture,dir:string,mode:'hold'|'warm'|'orphan'|'partial',lifecycle:string)=>createFixtureOwner({publishControlModule:import.meta.path,f,dir,mode,lifecycle,source,children});
  const freshSave=async(f:{save:string},before:Save)=>(await waitPracticeSave(f.save,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:15000})).matched;
  const sessionCheckCli=(f:Fixture,dir:string,before:Save)=>runSessionCheckCase({f,dir,before,source,children,freshSave,loginLog});
  const preset={position:{x:2618,z:3332,level:0},skills:{Hitpoints:43,Fishing:99,Cooking:99},inventory:[{id:995,count:1200},{id:311,count:1},{id:329,count:4}],equipment:[{id:1275,count:1,slot:3}],bank:[{id:385,count:5},{id:436,count:17}],varps:{300:1000}};
  const d8890=dispatcher(HOST);
  const positive=async(id:string,f:Fixture,expectedPosition?:Save['position'],extra:(r:any)=>Record<string,boolean>=()=>({}),d=d8890,ownerNote?:unknown)=>{
   const dir=caseDir(id);copyFileSync(f.save,join(dir,'before.sav'));const before=readPracticeSave(join(dir,'before.sav')),ended=deathBytes(),since=Date.now();
   await recoveryMemory(f.name);
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
  const held=async(id:string,f:Fixture,d=d8890,beforeSubmit:(r:ControlledRecoveryRequest)=>Promise<void>=async()=>{})=>{
   const dir=caseDir(id);copyFileSync(f.save,join(dir,'before.sav'));const ended=deathBytes(),since=Date.now(),before=listAttempts(f.name,f.server,{root:lifeRoot}).length;
   const {runId,owner:taskOwner}=await task(f,id),r=requestFor(f,runId,'one-'+id);
   await recoveryMemory(f.name);await beforeSubmit(r);const submittedAt=Date.now(),sub=submit(d,r,taskOwner.pid);
   return {dir,r,sub,since,submittedAt,ended,attemptsBefore:before,runId,taskOwner,finish:async(from=sub.from)=>{
    const result=await awaitResult(sub.raw,from);copyFileSync(f.save,join(dir,'after.sav'));
    writeFileSync(join(dir,'handoff.json'),JSON.stringify({submittedAt,fleet:sub.fleet,child:sub.child,dispatch:result?.reason??null,boundaries:sub.boundaries,firstFailure:sub.firstFailure},null,2));
    const replies=authReplies(loginLog(),since,f.name);writeFileSync(join(dir,'auth-replies.json'),JSON.stringify(replies));fixtureFiles(f,dir,r);
    const paths=recoveryPermitPaths(r,base);for(const p of [join(dirname(paths.input),'worker.log'),join(dirname(paths.input),'worker.err')])if(existsSync(p))copyFileSync(p,join(dir,'recovery-'+p.split(/[\\/]/).at(-1)));
    return {result,paths,receipt:receiptOf(r),replies};
   }};
  };
  const ctx:ProofCaseContext={directory,base,workspace,lifeRoot,capability,source,HOST,RELAY,preset,d8890,dispatcher,tasks,ends,jobs,cases,ownedStops,absenceGuards,children,recoveryChildren,channel,buttonTrace,relay,put,writeState,progress,loginLog,deathBytes,caseDir,recoveryMemory,fixture,task,requestFor,handoff,submit,awaitResult,fixtureFiles,record,positive,held,owner,sessionCheckCli};

  // 1 offline: an ordinary logged-out account.
  const A=await fixture(HOST,preset);
  const offline=await positive('offline',A);offline.record('native-actual-cli');
  if(capability==='session-recovery-only'){
   const pointer=JSON.parse(readFileSync(join(directory,'bank-observer-qualification.json'),'utf8'));
   if(hash(pointer.path)!==pointer.sha256)throw Error('bank observer qualification pointer changed');
   const F=await fixture(HOST,{...preset,position:{x:3185,z:3436,level:0}}),out=await positive('bounded-swarm-new-mission',F);
   const checks=await proveSwarmRecoveryContinuation({sourceRoot:root,directory:out.dir,account:F.name,server:F.server,profile:F.envPath,save:F.save,observerDelivery:dirname(pointer.path)});
   out.record('native-actual-swarm-new-mission',checks);
  }
  await runCompletedSuite(ctx);
  await runAuthAndSingleUseSuite(ctx,A);
  // 4 stop: the fixture stop and the repository stop both refuse before a lease, child or producer intent.
  {
   const dir=caseDir('stop'),rows:any[]=[];
   for(const kind of ['fixture','repository'] as const){
    const S=await fixture(HOST,preset),since=Date.now(),path=join(kind==='fixture'?base:root,'.practice','stop-'+S.name);
    const stop=claimStopArtifact(path,`native recovery proof stop ${process.pid} ${randomUUID()}`);ownedStops.push(stop);
    await recoveryMemory(S.name);
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
  await runOwnershipAndCooldownSuite(ctx);
  // 7 orphan: the owner process dies while its producer attempt is unresolved; the controller recovers after the takeover window.
  {
   const D=await fixture(HOST,preset),dir=caseDir('orphan'),o=await owner(D,dir,'orphan',lifeRoot);
   const killedAt=Date.now();await killTree(o.p.pid);await o.p.exited;
   let end=orphanServerEnd(loginLog(),D.name,killedAt);const endBy=Date.now()+240000;
   while(!end.ok&&Date.now()<endBy){await Bun.sleep(100);end=orphanServerEnd(loginLog(),D.name,killedAt);}
   writeFileSync(join(dir,'orphan-server-end.json'),JSON.stringify({killedAt,...end}));
   if(!end.ok)throw Error('orphan server-side logout not observed');
   const wait=orphanRecoveryReadyAt(end.at!,TAKEOVER_WINDOW_MS)-Date.now();if(wait>0)await Bun.sleep(wait);
   const old=o.ready.attemptId,heldBefore=readLogoutProof(D.name,D.server,{root:lifeRoot}),since=Date.now();
   const pos=o.ready.state.player,c=await positive('orphan',D,{x:pos.x,z:pos.z,level:pos.level});
   const oldAttempt=listAttempts(D.name,D.server,{root:lifeRoot}).find(a=>a.attemptId===old),gap=loginAfterTakeoverWindow(loginLog(),D.name,since,TAKEOVER_WINDOW_MS);
   writeFileSync(join(c.dir,'takeover-window.json'),JSON.stringify({since,windowMs:TAKEOVER_WINDOW_MS,...gap}));
   c.record('native-actual-cli',{orphanHeldBefore:heldBefore.state==='held'&&heldBefore.attemptId===old,oldAttemptStillUnconfirmed:!!oldAttempt?.receipt&&!oldAttempt.receipt.events.some(e=>e.kind==='ended'&&e.detail==='logged-out'),afterTakeoverWindow:gap.ok,serverEndedBeforeRecovery:end.at!==null&&end.at<since});
  }
  await runModalAndTimeoutSuite(ctx,afterStalledConnection);
  // 10 partial: a producer intent before START. Its live owner refuses; after that owner dies the controller recovers.
  {
   const P=await fixture(RELAY,preset),dir=caseDir('partial-owner-alive'),d=dispatcher(RELAY);await recoveryMemory(P.name);relay.set('stall');
   const o=await afterStalledConnection(relay.stalled,()=>owner(P,dir,'partial',lifeRoot));
   const selected=observePartialOwner(P.name,P.server,lifeRoot,o.ready.pid);
   writeFileSync(join(dir,'partial-observations.json'),JSON.stringify({ownerReady:o.ready,observations:[selected],selectedIndex:0,timedOut:false},null,2));
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
  const bindings=await runStockAndFinalizeGuards(ctx,{world,login,sealRequest,sealAck,authTrace},offline);
  const checks=deriveChecks(cases);
  const proof={ok:cases.every(c=>c.ok)&&Object.values(checks).every((c:any)=>c.ok)&&source===launchRevision()&&runnerSha256===hash(runner),
   level:'native-controller-recovery',at:Date.now(),runtimeRevision:source,runnerSha256,bindings,
   server:{host:HOST,relay:RELAY,loginPort:LOGIN_PORT,tickMs:150,takeoverWindowMs:TAKEOVER_WINDOW_MS,world:sha(JSON.stringify(worldConfig)),observer:hash(observer)},
   starting:{at:startedAt,freeGiB:startFreeGiB,fenceSha256:null},controller:{pid:process.pid,marker:CONTROLLER_MARKER,argv:process.argv.slice(1)},
   scope:'Private native practice world only. Session cleanup is not game production, does not repair an account end and does not qualify any gameplay script. No live login.',
   capability,cases,checks};
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
  if(saved.plan===undefined)delete process.env.SWARM_PLAN;else process.env.SWARM_PLAN=saved.plan;
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
