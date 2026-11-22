import {Database} from 'bun:sqlite';
import {copyFileSync,cpSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {RECOVERY_SCRIPT,heldRecoveryOwners,recoveryPermitPaths,recoveredSessionForRun,type ControlledRecoveryRequest} from '../../../core/src/session-recovery-permit';
import {accountDir,beginSessionAttempt,listAttempts,readLogoutProof} from '../../../core/src/session-lifecycle';
import {killTree,safeKill} from '../../../core/src/proc';
import {applyEndRepair,startable} from '../../../../scripts/swarm';
import {missionSignature} from '../../../core/src/session-admission';
import {readPracticeSave} from '../fleet-player-save';
import {TAKEOVER_WINDOW_MS,authReplies,classifyCooldownWindow,latestOwnerLoginBefore,noRecoveryLogin,observeAuth,ownerSessionEvidence,waitOwnerAuthLogout,waitRecoveryRuntime,type AttributedAuthReply} from './auth';
import {claimStopArtifact,evidenceFiles,hash,recoveryArtifactPresence,recoveryConsumptionBytes,retainRequiredRecoveryCase,requireRecoveryRegistration,root,runner,type OwnedStop} from './boundary';
import {buttonTraceFor} from './observers';
import {reconcileNegativeControls,type Save} from './reconcile';
import {type createFixtureOwner,type runSessionCheckCase} from './servers';

export type Fixture={name:string;envPath:string;save:string;server:string;endedAt:number;completed:boolean};
export type PositiveResult={dir:string;before:Save;after:Save;receipt:any;result:any;runId:string;record:(level:string,more?:Record<string,boolean>)=>any};
export type HeldResult={dir:string;r:ControlledRecoveryRequest;sub:any;since:number;submittedAt:number;ended:string;attemptsBefore:number;runId:string;taskOwner:any;finish:(from?:number)=>Promise<{result:any;paths:ReturnType<typeof recoveryPermitPaths>;receipt:any;replies:AttributedAuthReply[]}>};

export type ProofCaseContext={
 directory:string;base:string;workspace:string;lifeRoot:string;capability:string;source:string;HOST:string;RELAY:string;
 preset:any;d8890:any;dispatcher:(server:string)=>any;
 tasks:Map<string,any>;ends:Record<string,any>;jobs:any[];cases:any[];ownedStops:OwnedStop[];
 absenceGuards:{id:string;f:Fixture;since:number;attempts:string[]}[];
 children:ReturnType<typeof Bun.spawn>[];recoveryChildren:{pid:number;nonce:string}[];
 channel:string;buttonTrace:string;relay:any;
 put:(path:string,value:unknown)=>void;writeState:()=>void;progress:()=>void;loginLog:()=>string;
 deathBytes:()=>string;caseDir:(id:string)=>string;recoveryMemory:(account:string)=>Promise<void>;
 fixture:(server:string,preset:any,completed?:boolean)=>Promise<Fixture>;
 task:(f:Fixture,id:string)=>Promise<{runId:string;owner:any}>;
 requestFor:(f:Fixture,runId:string,nonce:string)=>ControlledRecoveryRequest;
 handoff:(d:any,raw:string,account:string,nonce:string)=>any;
 submit:(d:any,r:ControlledRecoveryRequest,taskPid:number)=>any;
 awaitResult:(raw:string,from:number,ms?:number)=>Promise<any>;
 fixtureFiles:(f:Fixture,dir:string,r?:ControlledRecoveryRequest)=>void;
 record:(id:string,level:string,checks:Record<string,boolean>,extra?:Record<string,unknown>)=>any;
 positive:(id:string,f:Fixture,expectedPosition?:Save['position'],extra?:(r:any)=>Record<string,boolean>,d?:any,ownerNote?:unknown)=>Promise<PositiveResult>;
 held:(id:string,f:Fixture,d?:any,beforeSubmit?:(r:ControlledRecoveryRequest)=>Promise<void>)=>Promise<HeldResult>;
 owner:(f:Fixture,dir:string,mode:'hold'|'warm'|'orphan'|'partial',lifecycle:string)=>ReturnType<typeof createFixtureOwner>;
 sessionCheckCli:(f:Fixture,dir:string,before:Save)=>ReturnType<typeof runSessionCheckCase>;
};

const CAPABILITY_ENTRIES:Record<string,string>={'cow-progress-order':'scripts/gather-combat.ts','shark-supply-order':'scripts/shark-supply.ts'};

export async function runCompletedSuite(ctx:ProofCaseContext){
 const {base,lifeRoot,capability,source,HOST,preset,d8890,tasks,ends,jobs,ownedStops,absenceGuards,children,put,writeState,loginLog,deathBytes,caseDir,fixture,fixtureFiles,record,positive,held,sessionCheckCli}=ctx;
 // Retired successful ordinary account with no producer history: actual controller -> installed core CLI.
 {
  const C=await fixture(HOST,preset,true),dir=caseDir('completed');
  const holds=readFileSync(join(base,'.practice/swarm-script-holds.json'),'utf8'),assignments=readFileSync(join(base,'handoff/swarm.json'),'utf8');
  const beforeProof=readLogoutProof(C.name,C.server,{root:lifeRoot});
  const out=await positive('completed',C),end=ends[C.name],entry=CAPABILITY_ENTRIES[capability]??'scripts/gather-combat.ts';
  const revision=missionSignature({account:C.name,script:entry,env:{TRAIN_SKILL:'Attack',TARGET_LEVEL:'20',CAP:'1500',COORDINATOR_RUN_ID:out.runId}});
  const retained=new Map(Object.entries(ends)),proof=readLogoutProof(C.name,C.server,{root:lifeRoot});
  const repair=applyEndRepair({account:C.name,endedAt:C.endedAt,server:C.server,proof:{kind:'producer',attemptId:out.receipt?.attemptId}},retained,[],{
   readProof:()=>proof,verifyLegacy:()=>({state:'refused',reason:'unused'})},[]);
  writeFileSync(join(dir,'controller-after.json'),JSON.stringify({ends:[...retained],repair,revision,beforeProof,proof},null,2));
  const check=await sessionCheckCli(C,dir,out.after);
  out.record('native-actual-controller-core-cli',{...check,
   noProducerBefore:beforeProof.state==='none',successfulEndRetained:retained.get(C.name)===end&&end.reason==='done after 1 runs',
   endRepairRefused:!repair.changed&&repair.reason==='completed work needs a new mission',
   oldMissionRefused:startable([C.name],false,retained,()=>Infinity,undefined,end.revision).start.length===0,
   newMissionReleased:startable([C.name],false,retained,()=>Infinity,undefined,revision).start.includes(C.name),
   holdsRetained:readFileSync(join(base,'.practice/swarm-script-holds.json'),'utf8')===holds,
   assignmentsRetained:readFileSync(join(base,'handoff/swarm.json'),'utf8')===assignments,
   noStopCreated:!existsSync(join(base,'.practice','stop-'+C.name)),
  });
 }
 // Saved retired producer setup, then the real controller -> CLI cleanup. No gameplay or interruption scenario.
 {
  const C=await fixture(HOST,preset,true),dir=caseDir('completed-held-producer');
  const retired=Bun.spawn([process.execPath,'-e','process.exit(0)'],{windowsHide:true,stdout:'ignore',stderr:'ignore'});children.push(retired);
  if(await retired.exited!==0)throw Error('retired producer fixture owner did not exit');
  const old=beginSessionAttempt({account:C.name,server:C.server},{root:lifeRoot,
   owner:{pid:retired.pid,coordinatorRunId:null,workerRelease:source,script:'scripts/retired-fixture.ts',role:'supply',participants:null}});
  old.record('connected');old.record('ready');old.record('ended','disconnected');old.record('logout','disconnected');old.record('closed');
  C.endedAt=Date.now();ends[C.name].at=C.endedAt;writeState();
  const retained=listAttempts(C.name,C.server,{root:lifeRoot}),beforeProof=readLogoutProof(C.name,C.server,{root:lifeRoot});
  writeFileSync(join(dir,'producer-before.json'),JSON.stringify({beforeProof,retained},null,2));
  const out=await positive('completed-held-producer',C),after=listAttempts(C.name,C.server,{root:lifeRoot});
  out.record('native-actual-controller-core-cli',{
   heldReadyProducerBefore:beforeProof.state==='held'&&beforeProof.attemptId===old.attemptId,
   priorProducerPreserved:isDeepStrictEqual(retained,after.slice(0,retained.length)),
   singleRecoveryChild:after.length===retained.length+1&&after.at(-1)?.receipt?.owner.script===RECOVERY_SCRIPT,
   successfulEndRetained:ends[C.name].reason==='done after 1 runs'&&ends[C.name].at===C.endedAt,
  });
 }
 {
  const dir=caseDir('completed-refusals'),rows:any[]=[];
  for(const fault of ['same-revision','open-hold','changed-end','stopped','reserved','active','orphan','partial-intent','competing-owner','wrong-identity','wrong-source'] as const){
   const C=await fixture(HOST,preset,true),id='completed-refusal-'+fault;
   const h=await held(id,C,d8890,async r=>{
    const spec=tasks.get(r.runId).spec;
    if(fault==='same-revision')ends[C.name].revision=missionSignature({account:C.name,script:CAPABILITY_ENTRIES[capability]??'scripts/gather-combat.ts',
     env:{...spec.env,COORDINATOR_RUN_ID:r.runId}});
    if(fault==='open-hold')put('.practice/swarm-script-holds.json',[{account:C.name,script:'scripts/retired-fixture.ts',at:C.endedAt,heldAt:C.endedAt,reason:'retained'}]);
    if(fault==='changed-end')ends[C.name].at++;
    if(fault==='stopped'){const s=claimStopArtifact(join(base,'.practice','stop-'+C.name),'native completed stop '+randomUUID());ownedStops.push(s);}
    if(fault==='reserved')jobs.find(j=>j.account===C.name).goal='fresh clock';
    if(fault==='active')jobs.find(j=>j.account===C.name).enabled=true;
    if(fault==='orphan'||fault==='partial-intent'){
     const a=beginSessionAttempt({account:C.name,server:C.server},{root:lifeRoot});if(fault==='orphan')a.record('connected');
    }
    if(fault==='competing-owner')put('.practice/live/fleet-runs/'+r.runId+'/owner.json',{pid:process.pid,runId:r.runId});
    if(fault==='wrong-identity')spec.sessionRecovery.account='Other';
    if(fault==='wrong-source')r.source='f'.repeat(64);
    writeState();
   });
   const endsBefore=deathBytes(),holdsBefore=readFileSync(join(base,'.practice/swarm-script-holds.json'),'utf8'),assignmentsBefore=readFileSync(join(base,'handoff/swarm.json'),'utf8'),attempts=listAttempts(C.name,C.server,{root:lifeRoot}).map(a=>a.attemptId);
   const out=await h.finish(),stopped=join(base,'.practice','stop-'+C.name);
   const row={fault,refused:!h.sub.child&&!existsSync(out.paths.lease)&&!existsSync(out.paths.permit)&&out.result?.sessionRecovered===false,
    noLogin:noRecoveryLogin(loginLog(),h.since,C.name),noNewIntent:isDeepStrictEqual(attempts,listAttempts(C.name,C.server,{root:lifeRoot}).map(a=>a.attemptId)),
    endsRetained:deathBytes()===endsBefore,holdsRetained:readFileSync(join(base,'.practice/swarm-script-holds.json'),'utf8')===holdsBefore,
    assignmentsRetained:readFileSync(join(base,'handoff/swarm.json'),'utf8')===assignmentsBefore,stopRetained:fault!=='stopped'||existsSync(stopped)};
   rows.push(row);writeFileSync(join(dir,fault+'.json'),JSON.stringify(row));cpSync(h.dir,join(dir,fault),{recursive:true});
   // Fault setup belongs only to this private fixture; stopped identities remain retired.
   put('.practice/swarm-script-holds.json',[]);jobs.find(j=>j.account===C.name).enabled=false;writeState();
   absenceGuards.push({id:'completed-refusals',f:C,since:h.since,attempts});
  }
  record('completed-refusals','native-actual-controller-refusal',Object.fromEntries(rows.map(r=>[r.fault,Object.entries(r).filter(([k])=>k!=='fault').every(([,v])=>v===true)])),{rows});
 }
}

export async function runAuthAndSingleUseSuite(ctx:ProofCaseContext,A:Fixture){
 const {base,workspace,lifeRoot,source,HOST,cases,children,channel,deathBytes,caseDir,recoveryMemory,dispatcher,requestFor,handoff,submit,awaitResult,fixtureFiles,record}=ctx;
 // 2 authFailure: the SAME account, now registered in the private DB by the real login above, with a wrong password.
 const dbr=new Database(join(workspace,'db.sqlite'),{readonly:true});const row=dbr.query('SELECT username FROM account WHERE username=?').get(A.name.toLowerCase());dbr.close();
 writeFileSync(join(caseDir('auth-failure'),'registered-precondition.json'),JSON.stringify({offlineConfirmed:cases.find(c=>c.id==='offline')?.ok===true,registered:!!row}));
 requireRecoveryRegistration(cases.find(c=>c.id==='offline')?.ok===true,!!row);
 const credentials=readFileSync(A.envPath,'utf8');writeFileSync(A.envPath,credentials.replace(/^PASSWORD=.*$/m,'PASSWORD=wronglocalpass'));
 let out:any,h:any;try{h=await ctx.held('auth-failure',A);out=await h.finish();}finally{writeFileSync(A.envPath,credentials);}
 const unchanged=hash(join(h.dir,'before.sav'))===hash(join(h.dir,'after.sav'));
 record('auth-failure','native-actual-cli',{registeredBefore:!!row,serverRejected:out.replies.filter((x:AttributedAuthReply)=>x.type==='player_login'&&x.account===A.name.toLowerCase()&&x.response===1).length===1,dispatcherHeld:out.result?.sessionRecovered===false&&out.result.changed===false,
  receiptHeld:out.receipt?.state==='held',leaseHeld:existsSync(out.paths.lease),nonceConsumed:recoveryArtifactPresence(out.paths).nonceConsumed,receiptPresent:recoveryArtifactPresence(out.paths).receiptPresent,notCompleted:!existsSync(out.paths.completed),failureRetained:deathBytes()===h.ended,saveBytesUnchanged:unchanged},
  {account:A.name,persistence:'no fresh save; unchanged bytes are compared, not claimed as persistence',
   firstBoundary:{fleet:h.sub.fleet,child:h.sub.child,dispatch:out.result?.reason??null,authReplies:out.replies.length}});
 // 3 singleUse: a restarted dispatcher, a newer intent and a direct CLI replay all refuse at the actual boundary.
 const dir=caseDir('single-use'),attempts=listAttempts(A.name,A.server,{root:lifeRoot}).length,used=recoveryConsumptionBytes(out.paths.used),restarted=dispatcher(HOST);
 if(used===null)record('single-use','native-actual-dispatcher-restart',{nonceConsumed:false},{account:A.name});
 const replay=h.sub.raw;writeFileSync(channel+'.processing',replay);let from=existsSync(channel+'.results.jsonl')?readFileSync(channel+'.results.jsonl','utf8').trim().split('\n').filter(Boolean).length:0;handoff(restarted,replay,A.name,'one-auth-failure-replay');const replayResult=await awaitResult(replay,from,5000);
 await recoveryMemory(A.name);const newer=requestFor(A,h.runId,'two-single-use');const sub=submit(restarted,newer,h.taskOwner.pid);const newerResult=await awaitResult(sub.raw,sub.from,5000);
 const cli=Bun.spawn([process.execPath,runner,out.paths.input,out.paths.output,'--permit-base='+base],{cwd:root,env:{...process.env,WORKER_RELEASE:source},stdout:Bun.file(join(dir,'replay.log')),stderr:Bun.file(join(dir,'replay.err')),windowsHide:true});
 children.push(cli);const t=setTimeout(()=>void killTree(cli.pid),60000);const cliCode=await cli.exited;clearTimeout(t);fixtureFiles(A,dir);
 record('single-use','native-actual-dispatcher-restart',{replayRefused:/already handled/.test(replayResult?.reason??''),newerIntentRefused:/existing recovery lease held/.test(newerResult?.reason??'')&&!sub.child,
  cliReplayRefused:cliCode===1,noNewProducerIntent:listAttempts(A.name,A.server,{root:lifeRoot}).length===attempts,consumptionUnchanged:used!==null&&recoveryConsumptionBytes(out.paths.used)===used,leaseStillHeld:existsSync(out.paths.lease)},{account:A.name,cliCode});
}

export async function runOwnershipAndCooldownSuite(ctx:ProofCaseContext){
 const {directory,base,lifeRoot,source,HOST,preset,d8890,absenceGuards,children,loginLog,deathBytes,caseDir,recoveryMemory,fixture,task,requestFor,submit,awaitResult,fixtureFiles,record,held,owner}=ctx;
 // 5 ownership: a live owner visible to the controller refuses before a lease. Direct API and unqualified remote CLI refuse before any intent.
 {
  const B=await fixture(HOST,preset),dir=caseDir('ownership'),o=await owner(B,dir,'hold',lifeRoot),since=Date.now();
  const ownerAttempts=listAttempts(B.name,B.server,{root:lifeRoot}).map(a=>a.attemptId).sort();
  await recoveryMemory(B.name);
  const {runId,owner:t}=await task(B,'ownership'),r=requestFor(B,runId,'one-ownership'),sub=submit(d8890,r,t.pid),result=await awaitResult(sub.raw,sub.from,5000);
  const remote='rs-sdk-demo.fly.dev',plain={schema:'session-recovery/1' as const,account:B.name,server:remote,runId,nonce:'direct-api',endedAt:B.endedAt,source};
  let connects=0,directError='';
  try{const {recoverSession}=await import('../../../core/src/session-recovery');await recoverSession(plain,{root:lifeRoot,guard:()=>{},connect:async()=>{connects++;throw Error('must not connect');},ready:async()=>false,closeModal:async()=>false,logout:async()=>'unconfirmed',close:async()=>{}});}catch(e){directError=String(e);}
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
 // Observe the recovery child's actual runtime before the owner opens the window. Auth records decide whether the recovery enters in time.
 {
  const C=await fixture(HOST,preset),dir=caseDir('cooldown'),external=join(directory,'external-lifecycle'),o=await owner(C,dir,'warm',external);
  const h=await held('cooldown',C,d8890),workerLog=join(dirname(recoveryPermitPaths(h.r,base).input),'worker.log');
  if(!h.sub.child)throw Error('cooldown recovery child not launched');
  const runtime=await waitRecoveryRuntime(()=>existsSync(workerLog)?readFileSync(workerLog,'utf8'):'',{pid:h.sub.child,runner,root,since:h.submittedAt});
  const warm=await o.takeover(),out=await h.finish();
  const window=classifyCooldownWindow(loginLog(),C.name,{signalAt:warm.signalAt,warmAt:warm.at,since:h.submittedAt,windowMs:TAKEOVER_WINDOW_MS});
  const ownerLoginReplyAt=(window as {takeoverReplyAt?:number}).takeoverReplyAt;
  const ownerAttempts=listAttempts(C.name,C.server,{root:external}).map(a=>a.attemptId).sort(),releaseAt=await o.release();
  const ownerAuth=await waitOwnerAuthLogout(loginLog,C.name,{releaseAt,ownerLoginReplyAt});
  const proof=readLogoutProof(C.name,C.server,{root:lifeRoot}),ownerProof=readLogoutProof(C.name,C.server,{root:external});
  const preserved=ownerSessionEvidence(ownerAuth,C.name,{since:warm.at,releaseAt,ownerLoginReplyAt,ownerAttempt:warm.attemptId,latestAttemptBeforeRelease:ownerAttempts.at(-1)});
  const replies=authReplies(ownerAuth,h.since,C.name);writeFileSync(join(dir,'auth-replies.json'),JSON.stringify(replies));
  writeFileSync(join(dir,'cooldown-window.json'),JSON.stringify({runtime,warm,submittedAt:h.submittedAt,releaseAt,window,preserved,ownerAttempts,ownerProof},null,2));
  record('cooldown','native-actual-cli',{takeoverWindowOpen:window.ok===true,serverCooldown:window.ok===true&&out.replies.filter((x:AttributedAuthReply)=>x.type==='player_login'&&x.account===C.name.toLowerCase()&&x.response===3).length===1,
   dispatcherHeld:out.result?.sessionRecovered===false,receiptHeld:out.receipt?.state==='held',
   leaseHeld:existsSync(out.paths.lease),producerHeld:proof.state==='held',notRecovered:!recoveredSessionForRun(C.name,C.server,h.runId,source,base),
   activeOwnerPreserved:preserved.ok,ownerLogoutConfirmed:ownerProof.state==='confirmed'&&ownerProof.attemptId===warm.attemptId,failureRetained:deathBytes()===h.ended},
   {account:C.name,owner:'external private lifecycle root; invisible to the controller by design',reason:window.reason,window});
 }
}

export async function runModalAndTimeoutSuite(ctx:ProofCaseContext,afterStalledConnection:any){
 const {directory,base,lifeRoot,source,HOST,RELAY,preset,cases,buttonTrace,relay,deathBytes,caseDir,progress,dispatcher,fixture,requestFor,handoff,submit,awaitResult,fixtureFiles,record,positive,held}=ctx;
 // 8 modal: a fresh character logs in to the server-opened design screen; the actual CLI closes it and confirms.
 {
  const M=await fixture(HOST,{...preset,position:{x:3094,z:3106,level:0},varps:{281:0,300:1000}});
  if(readPracticeSave(M.save).vars[281]!==0)throw Error('modal fixture tutorial varp not applied');
  const c=await positive('modal',M,undefined,r=>({modalObservedOpen:r?.before?.modalOpen===true,modalClosed:r?.after?.modalOpen===false}));
  // Server-side dispatch of the accept button, retained before the case verdict can stop the proof.
  const buttons=readFileSync(buttonTrace,'utf8');
  writeFileSync(join(c.dir,'button-dispatch.json'),JSON.stringify({attach:buttons.match(/^BUTTON_ATTACH (.*)$/m)?.[1]??null,...buttonTraceFor(buttons,M.name)},null,1));
  c.record('native-actual-cli',{});
  writeFileSync(join(c.dir,'server-side-effect.json'),JSON.stringify({varp281Before:c.before.vars[281],varp281After:c.after.vars[281],note:'player_kit close trigger advances tutorial progress; stock, skills and position are reconciled separately'}));
  cases.at(-1)!.evidence=evidenceFiles(directory,join('cases','modal'));progress();
 }
 // 9 timeout + restart/late callback: a recovery stalled before START is killed at its deadline and stays held.
 // While it runs, a restarted dispatcher observes the inherited child, refuses a newer intent and the old bytes.
 {
  const T=await fixture(RELAY,preset),d1=dispatcher(RELAY);relay.set('stall');
  // Relay acceptance follows producer publication. Do not replace the lease while the real child still loads.
  const h=await afterStalledConnection(relay.stalled,()=>held('timeout',T,d1),120000),dir=h.dir,childPid=h.sub.child;
  // held() waited for this case. The held lease refuses the newer request before admission, and a second wait could
  // outlast the stalled child that this case observes.
  const late=caseDir('restart-late-callback'),d2=dispatcher(RELAY),inherited=heldRecoveryOwners(base);
  const newer=requestFor(T,h.runId,'two-timeout'),nsub=submit(d2,newer,h.taskOwner.pid),newerResult=await awaitResult(nsub.raw,nsub.from,5000);
  const resultsFile=ctx.channel+'.results.jsonl';
  const resultRows=()=>existsSync(resultsFile)?readFileSync(resultsFile,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
  writeFileSync(ctx.channel+'.processing',h.sub.raw);const from=resultRows().length;handoff(d2,h.sub.raw,T.name,'one-timeout-replay');const replayResult=await awaitResult(h.sub.raw,from,5000);
  const rowsBeforeLate=resultRows().length;
  const out=await h.finish(rowsBeforeLate);relay.set('forward');
  const rowsAfter=resultRows(),lateRow=rowsAfter.slice(rowsBeforeLate).find((x:any)=>x.raw===h.sub.raw),proof=readLogoutProof(T.name,T.server,{root:lifeRoot});
  const childAttempt=listAttempts(T.name,T.server,{root:lifeRoot}).find(a=>a.receipt?.owner.pid===childPid);
  record('timeout','native-actual-cli-stalled-endpoint',{stalledBeforeStart:!!childAttempt?.receipt&&!childAttempt.receipt.events.some(e=>e.kind==='ready'),dispatcherHeld:out.result?.sessionRecovered===false,
   noConfirmedReceipt:out.receipt?.state!=='confirmed',leaseHeld:existsSync(out.paths.lease),notCompleted:!existsSync(out.paths.completed),producerHeld:proof.state==='held',
   childEnded:childPid!==null&&!(()=>{try{process.kill(childPid,0);return true;}catch{return false;}})(),failureRetained:deathBytes()===h.ended},{account:T.name,childPid,receipt:out.receipt?.state??'absent'});
  writeFileSync(join(late,'restart.json'),JSON.stringify({inherited,newerResult,replayResult,lateRow},null,2));fixtureFiles(T,late);
  record('restart-late-callback','native-actual-dispatcher-restart',{inheritedChildCounted:inherited.some(x=>x.account===T.name&&x.pid===childPid),newerIntentRefused:/existing recovery lease held/.test(newerResult?.reason??'')&&!nsub.child,
   oldBytesRefused:/already handled/.test(replayResult?.reason??''),lateCallbackHeld:lateRow?.result?.sessionRecovered===false,lateCallbackKeptLease:existsSync(out.paths.lease)&&!existsSync(out.paths.completed),
   newerNotLaunched:!existsSync(recoveryPermitPaths(newer,base).permit),notRecovered:!recoveredSessionForRun(T.name,T.server,h.runId,source,base)},{account:T.name});
 }
}

export async function runStockAndFinalizeGuards(ctx:ProofCaseContext,env:{
 world:ReturnType<typeof Bun.spawn>;login:ReturnType<typeof Bun.spawn>;sealRequest:string;sealAck:string;authTrace:string;
},offline:PositiveResult){
 const {directory,lifeRoot,cases,absenceGuards,recoveryChildren,caseDir,progress,fixtureFiles,loginLog}=ctx;
 // 11 stock negative controls on the real offline saves.
 {
  const dir=caseDir('stock-negative-controls');copyFileSync(join(offline.dir,'before.sav'),join(dir,'before.sav'));copyFileSync(join(offline.dir,'after.sav'),join(dir,'after.sav'));
  const controls=reconcileNegativeControls(readPracticeSave(join(dir,'before.sav')),readPracticeSave(join(dir,'after.sav')));
  writeFileSync(join(dir,'controls.json'),JSON.stringify(controls));ctx.record('stock-negative-controls','native-saved-reconciliation',controls);
 }
 // Quiesce the only world that can send requests, then seal the synchronous observer trace. Await
 // LoginServer exit too, so final absence covers the complete retained log, including teardown.
 for(const c of recoveryChildren)await safeKill(c.pid,c.nonce);
 if(env.world.exitCode===null)await killTree(env.world.pid);await env.world.exited;
 writeFileSync(env.sealRequest,'seal');
 const sealDeadline=Date.now()+5000;while(!existsSync(env.sealAck)&&Date.now()<sealDeadline){if(env.login.exitCode!==null)throw Error('auth observer exited before seal');await Bun.sleep(50);}
 if(!existsSync(env.sealAck))throw Error('auth observer seal timeout');
 if(env.login.exitCode===null)await killTree(env.login.pid);await env.login.exited;
 const completeAuth=observeAuth(loginLog(),true);
 writeFileSync(join(directory,'auth-complete.json'),JSON.stringify(completeAuth,null,2));
 for(const g of absenceGuards){
  const dir=caseDir(g.id),row=cases.find(c=>c.id===g.id)!;
  const auth=completeAuth,attempts=listAttempts(g.f.name,g.f.server,{root:lifeRoot}).map(a=>a.attemptId).sort();
  copyFileSync(env.authTrace,join(dir,'auth-observations.log')); // Bind the sealed raw trace through the existing evidence reader.
  const observedDir=g.id==='stop'||g.id==='completed-refusals'?join(dir,g.f.name):dir;mkdirSync(observedDir,{recursive:true});
  writeFileSync(join(observedDir,'subsequent-observation.json'),JSON.stringify({at:Date.now(),since:g.since,auth,attempts},null,2));fixtureFiles(g.f,observedDir);
  row.checks.noSubsequentLogin=row.checks.noSubsequentLogin!==false&&noRecoveryLogin(loginLog(),g.since,g.f.name);
  row.checks.noSubsequentProducerAttempt=row.checks.noSubsequentProducerAttempt!==false&&isDeepStrictEqual(g.attempts,attempts);
  row.ok=Object.values(row.checks).every(v=>v===true);
  const {evidence:previousEvidence,...details}=row;writeFileSync(join(dir,'checks.json'),JSON.stringify(details,null,2));row.evidence=evidenceFiles(directory,join('cases',g.id));
  retainRequiredRecoveryCase(row,()=>progress());
 }
 const bindings=Object.fromEntries([RECOVERY_SCRIPT,'packages/core/src/session-recovery-permit.ts','packages/core/src/session-recovery-dispatch.ts','packages/core/src/session-lifecycle.ts','packages/core/src/inprocess.ts','packages/core/src/route-plan.ts','packages/core/src/fleet-trade-claim.ts','packages/core/src/fleet-lease.ts','scripts/swarm.ts','packages/practice/src/session-recovery-proof.ts',
  'packages/core/src/bounded-recovery.ts','packages/core/src/bounded-owners.ts','scripts/cloud-side.ts','scripts/cloud-recovery.ts',
  'packages/practice/src/swarm-recovery-chain.ts','packages/fleet/src/session-recovery.ts','packages/fleet/src/swarm.ts','packages/fleet/src/cloud-side.ts','packages/fleet/src/fleet-agent.ts',
  'vendor/rs-sdk/server/webclient/tsconfig.json','vendor/rs-sdk/server/engine/src/server/login/LoginServer.ts','vendor/rs-sdk/server/engine/src/engine/World.ts','vendor/rs-sdk/server/content/scripts/tutorial/scripts/tutorial.rs2'].map(p=>[p,hash(join(root,p))]));
 return bindings;
}
