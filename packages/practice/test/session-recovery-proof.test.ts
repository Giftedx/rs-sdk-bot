// Unit-only checks of the native recovery proof's pure parts. No world, login server or game child starts here.
import {test,expect,spyOn} from 'bun:test';
import * as fs from 'node:fs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,existsSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {accountDir,beginSessionAttempt} from '../../core/src/session-lifecycle';
import {observePartialOwner} from '../src/session-recovery-proof';
import {recoveryCapability,verifyCompletedRouterPins,fleetHandoff,observeRecoveryBoundary,recoveryAuthorityInputs,type RecoveryBoundary} from '../src/session-recovery-proof';
import {NATIVE_RECOVERY_CHECKS,verifyNativeRecoveryProof,launchPermittedRecovery,type ControlledRecoveryRequest} from '../../core/src/session-recovery-permit';
import {createRecoveryDispatch} from '../../core/src/session-recovery-dispatch';
import {admitRecovery} from '../../../scripts/swarm';
import {CHECK_CASES,deriveChecks,reconcileSaves,reconcileNegativeControls,stockOf,authReplies,observeAuth,noRecoveryLogin,installAuthObserver,evidenceFiles,retainRequiredRecoveryCase,requireRecoveryRegistration,recoveryArtifactPresence,recoveryConsumptionBytes,claimStopArtifact,releaseStopArtifact,classifyCooldownWindow,ownerSessionEvidence,loginAfterTakeoverWindow,latestOwnerLoginBefore,TAKEOVER_WINDOW_MS} from '../src/session-recovery-proof';

test('native pre-child observation separates actual memory, capacity, release and launcher authority refusals hidden by dispatch',()=>{
 for(const fault of ['memory','maxBots','release','authority'] as const){
  const base=mkdtempSync(join(tmpdir(),'recovery-boundary-')),events:RecoveryBoundary[]=[];
  const r:ControlledRecoveryRequest={schema:'session-recovery/1',kind:'session-recovery',account:'Rod',server:'localhost:8890',runId:'native-boundary',nonce:'one',endedAt:100,source:'a'.repeat(64),
   qualification:{delivery:{path:'unit-only',sha256:'0'.repeat(64)},proof:{path:'unit-only',sha256:'0'.repeat(64)}}};
  const coordinator=join(base,'.practice/coordinator'),channel=join(base,'.practice/swarm-repair.json'),pin=process.env.WORKER_RELEASE;
  mkdirSync(coordinator,{recursive:true});
  // The actual launcher must refuse this invalid controller before source/task checks or child issuance.
  writeFileSync(join(coordinator,'swarm-owner.json'),JSON.stringify({pid:0,nonce:'invalid-owner',source:r.source}));
  const input={account:r.account,active:[],running:fault==='maxBots'?17:0,external:0,pending:0,freeGB:fault==='memory'?8:32,minFreeGB:8,maxBots:17};
  let launches=0;
  try{
   if(fault==='release')delete process.env.WORKER_RELEASE;
   const d=createRecoveryDispatch({base,server:r.server,nativeFixture:true,
    admit:()=>observeRecoveryBoundary('admitRecovery',input,()=>fault==='release'?admitRecovery(input):admitRecovery(input,()=>{}),e=>events.push(e)),
    launch:request=>{launches++;return observeRecoveryBoundary('launchPermittedRecovery',recoveryAuthorityInputs(base,request),
     ()=>launchPermittedRecovery(request,base,{nativeFixture:true,source:()=>r.source}),e=>events.push(e));}});
   const raw=JSON.stringify(r);writeFileSync(channel+'.processing',raw);expect(d.handle(raw)).toBe(true);
   const first=events.find(e=>e.outcome==='threw');
   const reason={memory:'recovery admission waiting: memory',maxBots:'recovery admission waiting: maxBots',release:'no worker progress: release pin missing; live starts paused',authority:'recovery controller owner changed'}[fault];
   expect(first).toMatchObject({phase:fault==='authority'?'launchPermittedRecovery':'admitRecovery',reason,hostDeferred:fault==='memory'});
   expect(events.map(e=>e.outcome)).toEqual(fault==='authority'?['entered','returned','entered','threw']:['entered','threw']);
   expect(launches).toBe(fault==='authority'?1:0);expect(d.active).toBeUndefined();
   expect(existsSync(join(coordinator,'session-recovery/accounts/rod/lease.json'))).toBe(false);
   expect(JSON.parse(readFileSync(channel+'.results.jsonl','utf8')).result.reason).toBe('recovery setup refused; no lease issued; no retry');
   // Observation does not weaken the single-use dispatch boundary, even for a pre-permit refusal.
   writeFileSync(channel+'.processing',raw);d.handle(raw);expect(events.length).toBe(fault==='authority'?4:2);
  }finally{if(pin===undefined)delete process.env.WORKER_RELEASE;else process.env.WORKER_RELEASE=pin;rmSync(base,{recursive:true,force:true});}
 }
});

test('boundary wrapper preserves exact return and thrown objects, redacts unknown errors and tolerates a failed observer',()=>{
 const events:RecoveryBoundary[]=[],value={child:{pid:123},completion:Promise.resolve(null)},error=Error('secret PASSWORD=do-not-log');
 let calls=0;
 expect(observeRecoveryBoundary('launchPermittedRecovery',{},()=>{calls++;return value;},e=>events.push(e))).toBe(value);
 try{observeRecoveryBoundary('admitRecovery',{},()=>{calls++;throw error;},e=>events.push(e));throw Error('expected original exception');}catch(e){expect(e).toBe(error);}
 expect(calls).toBe(2);expect(events.at(-1)).toMatchObject({reason:'unclassified boundary error',hostDeferred:false});
 expect(JSON.stringify(events)).not.toContain('PASSWORD');
 expect(observeRecoveryBoundary('admitRecovery',{},()=>value,()=>{throw Error('disk full');})).toBe(value);
 try{observeRecoveryBoundary('admitRecovery',{},()=>{throw error;},()=>{throw Error('disk full');});}catch(e){expect(e).toBe(error);}
});

test('native authority samples retain owner inputs without copying environment secrets or mutating files',()=>{
 const base=mkdtempSync(join(tmpdir(),'recovery-authority-inputs-')),dir=join(base,'.practice/coordinator');
 mkdirSync(dir,{recursive:true});const path=join(dir,'state.json');
 const r={account:'Rod',server:'localhost:8890',runId:'native-boundary',nonce:'one',endedAt:100,source:'a'.repeat(64)} as ControlledRecoveryRequest;
 const raw=JSON.stringify({tasks:[{status:'running',pid:123,runId:r.runId,spec:{kind:'run',account:'Rod',sessionRecovery:{account:'Rod',endedAt:100},env:{PASSWORD:'secret'}}}]});
 writeFileSync(path,raw);
 try{
  const sample=recoveryAuthorityInputs(base,r);
  expect(sample.task).toMatchObject({pid:123,account:'Rod',sessionRecovery:{account:'Rod',endedAt:100}});
  expect(sample.controller).toBeNull();expect(sample.requestLease).toBeNull();
  expect(JSON.stringify(sample)).not.toContain('PASSWORD');expect(readFileSync(path,'utf8')).toBe(raw);
 }finally{rmSync(base,{recursive:true,force:true});}
});

function partialFixture(run:(f:{root:string;dir:string;latest:string;publish:()=>ReturnType<typeof beginSessionAttempt>;observe:(pid?:number)=>ReturnType<typeof observePartialOwner>})=>void){
 const root=mkdtempSync(join(tmpdir(),'partial-observation-')),account='Rod',server='localhost:8899',dir=accountDir(account,server,root);
 const publish=()=>beginSessionAttempt({account,server},{root,owner:{pid:process.pid,coordinatorRunId:null,workerRelease:null,script:'fixture.ts',role:null,participants:null}});
 try{run({root,dir,latest:join(dir,'latest.json'),publish,observe:(pid=process.pid)=>observePartialOwner(account,server,root,pid)});}finally{rmSync(root,{recursive:true,force:true});}
}
test('partial readiness before intent retains none and missing pointer without inventing an attempt',()=>partialFixture(f=>{
 const o=f.observe();expect(o.ownerIntentVisible).toBe(false);expect(o.attempts).toEqual([]);expect(o.proof.state).toBe('none');expect(o.latestAfter.state).toBe('missing');
 expect(o.checks.held).toBe(false);expect(o.checks.matchingAttempt).toBe(false);
}));
test('receipt visibility before latest publication retains the invalid FIRST read even when publication later finishes',()=>partialFixture(f=>{
 const a=f.publish(),bytes=readFileSync(f.latest);rmSync(f.latest);
 const o=f.observe();expect(o.ownerIntentVisible).toBe(true);expect(o.proof).toMatchObject({state:'invalid',reason:'attempts without a latest pointer'});
 expect(o.checks.beforeStart).toBe(false);expect(o.latestAfter.state).toBe('missing');expect(o.receiptsAfter[0]!.attemptId).toBe(a.attemptId);
 writeFileSync(f.latest,bytes);expect(f.observe().proof.state).toBe('held');expect(o.proof.state).toBe('invalid');
}));
test('valid connecting-only latest retains exact proof, owner, ordered observations and byte hashes read-only',()=>partialFixture(f=>{
 const a=f.publish(),receipt=join(f.dir,'attempts',a.attemptId+'.json'),raw=readFileSync(receipt),latest=readFileSync(f.latest),o=f.observe();
 expect(o.proof).toMatchObject({state:'held',attemptId:a.attemptId,reason:'connection attempt before START, outcome unknown'});
 expect(Object.values(o.checks).every(Boolean)).toBe(true);expect(o.ownerPid).toBe(process.pid);
 expect(o.attempts[0]!.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
 expect(o.receiptsAfter[0]!.sha256).toBe(o.attempts[0]!.sha256);expect(o.latestAfter.sha256).toBe(createHash('sha256').update(latest).digest('hex'));
 expect(o.order.map(r=>r.step)).toEqual(['listAttempts:start','listAttempts:end','readLogoutProof:start','readLogoutProof:end','latestAfter:start','latestAfter:end','receiptAfter:start','receiptAfter:end','ownerAlive:start','ownerAlive:end']);
 expect(readFileSync(receipt)).toEqual(raw);expect(readFileSync(f.latest)).toEqual(latest);
}));
test('malformed latest stays explicitly invalid; diagnostic snapshots never copy arbitrary secret fields',()=>partialFixture(f=>{
 f.publish();writeFileSync(f.latest,'{"password":"SECRET",');const o=f.observe();
 expect(o.proof).toMatchObject({state:'invalid',reason:'malformed latest pointer'});expect(o.latestAfter.state).toBe('malformed');expect(o.latestAfter.sha256).toHaveLength(64);
 expect(JSON.stringify(o)).not.toContain('SECRET');expect(o.checks.beforeStart).toBe(false);
}));
for(const [field,value] of [['account','Other'],['server','localhost:8890'],['domain','live']]){
 test('crossed latest '+field+' cannot look like matching partial evidence',()=>partialFixture(f=>{
  f.publish();const pointer=JSON.parse(readFileSync(f.latest,'utf8'));pointer[field!]=value;pointer.password='SECRET';writeFileSync(f.latest,JSON.stringify(pointer));
  const o=f.observe();expect(o.proof).toMatchObject({state:'invalid',reason:'latest pointer identity mismatch'});expect(o.checks.matchingAttempt).toBe(false);expect(o.latestAfter.identity?.[field!]).toBe(value);expect(JSON.stringify(o)).not.toContain('SECRET');
 }));
}
test('wrong owner PID is distinct from a valid connecting-only attempt',()=>partialFixture(f=>{
 f.publish();const o=f.observe(2147483647);expect(o.ownerIntentVisible).toBe(false);expect(o.proof.state).toBe('held');expect(o.checks.matchingAttempt).toBe(false);expect(o.attempts[0]!.receipt!.ownerPid).toBe(process.pid);
}));
test('a newer unpointed intent is held for its actual reason, never retried into before-START success',()=>partialFixture(f=>{
 const a=f.publish(),pointer=readFileSync(f.latest),b=f.publish();writeFileSync(f.latest,pointer);
 const o=f.observe();expect(o.proof).toMatchObject({state:'held',attemptId:a.attemptId,reason:`newer attempt ${b.attemptId} is not the latest pointer`});expect(o.checks.beforeStart).toBe(false);expect(o.checks.matchingAttempt).toBe(false);
}));
test('a dead owner stays separate from its unresolved partial attempt',()=>partialFixture(f=>{
 const a=f.publish(),p=join(f.dir,'attempts',a.attemptId+'.json'),receipt=JSON.parse(readFileSync(p,'utf8'));receipt.owner.pid=2147483647;writeFileSync(p,JSON.stringify(receipt));
 const o=f.observe(2147483647);expect(o.ownerIntentVisible).toBe(true);expect(o.proof.state).toBe('held');expect(o.checks.ownerAlive).toBe(false);expect(o.checks.beforeStart).toBe(true);
}));
test('native diagnostic keeps finite original first-intent selection and explicit missing-observation timeout',()=>{
 const text=readFileSync(join(import.meta.dir,'../src/session-recovery-proof.ts'),'utf8');
 expect(text).toContain('observations.length<301');expect(text).toContain('if(observation.ownerIntentVisible)selected=observation;');
 expect(text).toContain("if(!selected)throw Error('partial owner intent observation missing before deadline; see partial-observations.json')");
 expect(text).toContain('const partial=selected.proof');expect(text).toContain("join(dir,'partial-refusal.json')");
});

test('offline setup failure is retained before throwing and prevents dependent dispatch on its held account',()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-first-failure-')),lease=join(dir,'lease.json');writeFileSync(lease,'held original lease');
 const paths={used:join(dir,'used.json'),output:join(dir,'output'),completed:join(dir,'completed.json')};
 const rows:any[]=[],original={id:'offline',ok:false,checks:{...recoveryArtifactPresence(paths),producerConfirmed:false},firstRefusal:{phase:'permit-consumption',reason:'unresolved'}};
 let dispatched=0;
 expect(()=>{
  retainRequiredRecoveryCase(original,row=>{rows.push(row);writeFileSync(join(dir,'checks.json'),JSON.stringify(row));});
  requireRecoveryRegistration(true,true);dispatched++;
 }).toThrow('required case failed: offline:nonceConsumed/receiptPresent/completedIndexed/producerConfirmed');
 expect(dispatched).toBe(0);expect(rows).toEqual([original]);
 expect(JSON.parse(readFileSync(join(dir,'checks.json'),'utf8')).firstRefusal).toEqual(original.firstRefusal);
 expect(readFileSync(lease,'utf8')).toBe('held original lease');
 expect(recoveryArtifactPresence(paths)).toEqual({nonceConsumed:false,receiptPresent:false,completedIndexed:false});
 expect(recoveryConsumptionBytes(paths.used)).toBeNull();
 writeFileSync(paths.used,'exact consumption bytes');expect(recoveryConsumptionBytes(paths.used)).toBe('exact consumption bytes');
});
test('authentication adverse case requires both prior confirmed recovery and independent DB registration',()=>{
 for(const [confirmed,registered] of [[false,false],[false,true],[true,false]])expect(()=>requireRecoveryRegistration(confirmed,registered)).toThrow('precondition');
 expect(()=>requireRecoveryRegistration(true,true)).not.toThrow();
 const rows:any[]=[];expect(retainRequiredRecoveryCase({id:'offline',ok:true,checks:{producerConfirmed:true}},r=>rows.push(r)).ok).toBe(true);expect(rows).toHaveLength(1);
});

const save=(over:any={})=>({version:1,position:{x:2618,z:3332,level:0},skills:[{level:43,xp:100}],vars:{134:1},inventories:{93:[{slot:0,id:995,count:1200}],94:[],95:[{slot:0,id:385,count:5}]},...over}) as any;
test('every reader check names at least one observed case',()=>{
 expect(Object.keys(CHECK_CASES).sort()).toEqual([...NATIVE_RECOVERY_CHECKS].sort());
 for(const ids of Object.values(CHECK_CASES))expect(ids.length).toBeGreaterThan(0);
});
test('saved reconciliation treats an absent and an empty container alike but sees any slot, skill or tile change',()=>{
 const before=save(),after=save({inventories:{93:[{slot:0,id:995,count:1200}],95:[{slot:0,id:385,count:5}]}});
 expect(stockOf(before)).toEqual(stockOf(after));expect(reconcileSaves(before,after)).toEqual({inventories:true,skills:true,position:true});
 expect(reconcileNegativeControls(before,after)).toEqual({lostItem:true,gainedItem:true,skillChange:true,moved:true});
 expect(reconcileSaves(before,save({position:{x:2619,z:3332,level:0}})).position).toBe(false);
 expect(reconcileSaves(before,after,{x:1,z:2,level:0}).position).toBe(false);
});
test('a check passes only when all of its cases were observed, passed and kept evidence',()=>{
 const ev=[{path:'cases/x/a.json',sha256:'a'.repeat(64)}];
 const all=[...new Set(Object.values(CHECK_CASES).flat())].map(id=>({id,ok:true,level:'native-actual-cli',evidence:ev}));
 const checks=deriveChecks(all) as any;for(const k of NATIVE_RECOVERY_CHECKS)expect(checks[k].ok).toBe(true);
 const without=deriveChecks(all.filter(c=>c.id!=='restart-late-callback')) as any;expect(without.lateCallback.ok).toBe(false);expect(without.singleUse.ok).toBe(false);expect(without.offline.ok).toBe(true);
 const failed=deriveChecks(all.map(c=>c.id==='modal'?{...c,ok:false}:c)) as any;expect(failed.modal.ok).toBe(false);expect(failed.stock.ok).toBe(false);
 const unit=deriveChecks(all.map(c=>c.id==='cooldown'?{...c,level:'unit'}:c)) as any;expect(unit.cooldown.ok).toBe(false);
 const empty=deriveChecks(all.map(c=>c.id==='stop'?{...c,evidence:[]}:c)) as any;expect(empty.stop.ok).toBe(false);
});
test('a derived proof with real saved files satisfies the controller reader; a changed raw file does not',()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-proof-'));const ids=[...new Set(Object.values(CHECK_CASES).flat())];
 const cases=ids.map(id=>{mkdirSync(join(dir,'cases',id),{recursive:true});writeFileSync(join(dir,'cases',id,'checks.json'),JSON.stringify({id}));return {id,ok:true,level:'native-actual-cli',evidence:evidenceFiles(dir,join('cases',id))};});
 const proof={ok:true,level:'native-controller-recovery',runtimeRevision:'a'.repeat(64),runnerSha256:'b'.repeat(64),cases,checks:deriveChecks(cases)};
 expect(verifyNativeRecoveryProof(proof,dir,{runtimeRevision:'a'.repeat(64),runnerSha256:'b'.repeat(64)})).toBe(true);
 writeFileSync(join(dir,'cases','timeout','checks.json'),'changed');
 expect(()=>verifyNativeRecoveryProof(proof,dir,{runtimeRevision:'a'.repeat(64),runnerSha256:'b'.repeat(64)})).toThrow('evidence changed');
});
test('evidence listing hashes plain files and never follows a link',()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-evidence-'));mkdirSync(join(dir,'cases/a'),{recursive:true});writeFileSync(join(dir,'cases/a/raw.log'),'raw');
 symlinkSync(tmpdir(),join(dir,'cases/a/link'),process.platform==='win32'?'junction':'dir');
 expect(evidenceFiles(dir,'cases/a')).toEqual([{path:'cases/a/raw.log',sha256:createHash('sha256').update('raw').digest('hex')}]);
});
test('retained ownership failure is reproducible but its legacy reply cannot identify a login',()=>{
 // Credential-free excerpt verified against the immutable retained uZIWUW ownership case, flrcvx3oo23.
 // Keep this regression runnable without a historical .practice folder. Original raw evidence stays untouched.
 const log='AUTH_REPLY {"at":1793272966134,"response":0,"replyTo":"id_b5665905-1424-4eb0-a252-d0b2c97c1dca"}';
 const ready={at:1793272963590},after={at:1793272966031},producerEnd={at:1793272966154,kind:'ended',detail:'logged-out'};
 const replies=log.split(/\r?\n/).filter(l=>l.startsWith('AUTH_REPLY ')).map(l=>JSON.parse(l.slice(11))).filter(r=>r.at>=ready.at);
 expect(replies).toEqual([{at:1793272966134,response:0,replyTo:'id_b5665905-1424-4eb0-a252-d0b2c97c1dca'}]);
 expect(replies.length===0).toBe(false);expect(after.at).toBe(1793272966031);
 const refused={result:{sessionRecovered:false,reason:'recovery setup refused; no lease issued; no retry'}};
 expect(refused.result.sessionRecovered).toBe(false);expect(refused.result.reason).toContain('no lease issued');
 expect(producerEnd.at).toBeGreaterThan(replies[0].at);expect(replies[0].at).toBeGreaterThan(after.at);
 expect(()=>authReplies(log,ready.at)).toThrow('attribution');
});

const authLine=(kind:string,row:object)=>kind+' '+JSON.stringify(row);
const authHead=()=>[authLine('AUTH_READY',{at:1,schema:1}),authLine('AUTH_CONNECTION',{at:2,connection:1})];
const request=(at:number,replyTo:string,account='rod',type='player_login',connection=1)=>authLine('AUTH_REQUEST',{at,connection,replyTo,type,account});
const reply=(at:number,replyTo:string,response=0,connection=1)=>authLine('AUTH_REPLY',{at,connection,replyTo,response});
test('owner login before readiness and legitimate logout after refusal are distinct despite identical success codes',()=>{
 const log=[...authHead(),request(3,'initial'),reply(4,'initial'),request(12,'cleanup','rod','player_logout'),reply(20,'cleanup')].join('\n');
 expect(noRecoveryLogin(log,10,'Rod')).toBe(true);
 expect(authReplies(log,10,'Rod','player_login')).toEqual([]);
 expect(authReplies(log,10,'Rod','player_logout')).toEqual([{at:20,requestAt:12,connection:1,replyTo:'cleanup',response:0,type:'player_logout',account:'rod'}]);
 // Delaying the earlier login's reply does not turn that authorized request into a recovery login.
 const delayed=[...authHead(),request(3,'initial'),request(12,'cleanup','rod','player_logout'),reply(20,'cleanup'),reply(30,'initial')].join('\n');
 expect(noRecoveryLogin(delayed,10,'rod')).toBe(true);
 expect(authReplies(delayed,10,'rod','player_login')).toEqual([]);
});
test('an unexpected login request fails absence before its reply and after any delayed reply',()=>{
 const log=[...authHead(),request(10,'unexpected')].join('\n');
 expect(noRecoveryLogin(log,10,'rod')).toBe(false);expect(()=>authReplies(log,10)).toThrow('attribution');
 expect(noRecoveryLogin(log+'\n'+reply(100,'unexpected'),10,'rod')).toBe(false);
 // The final subsequent-log audit must catch requests that arrive after cleanup was already captured.
 const refusal=authHead().join('\n');expect(noRecoveryLogin(refusal,10,'rod')).toBe(true);
 expect(noRecoveryLogin(refusal+'\n'+request(100,'late')+'\n'+reply(200,'late'),10,'rod')).toBe(false);
});
test('interleaved request IDs keep account, request type and connection identity',()=>{
 const log=[...authHead(),authLine('AUTH_CONNECTION',{at:2,connection:2}),request(3,'a'),request(4,'b','other'),request(5,'a','third','player_login',2),request(6,'c','rod','player_logout'),reply(7,'b',1),reply(8,'c'),reply(9,'a',3,2),reply(10,'a')].join('\n');
 expect(authReplies(log,3,'rod','player_login').map(x=>x.response)).toEqual([0]);
 expect(authReplies(log,3,'other','player_login').map(x=>x.response)).toEqual([1]);
 expect(authReplies(log,3,'third','player_login').map(x=>x.response)).toEqual([3]);
 expect(authReplies(log,3,'rod','player_logout').map(x=>x.response)).toEqual([0]);
 expect(authReplies(log,3,'rod','player_login').some(x=>x.response===1||x.response===3)).toBe(false);
});
test('missing duplicate crossed and malformed attribution refuses, even outside the filtered interval',()=>{
 const head=authHead();
 const bad=[
  [],[reply(3,'missing')],[request(3,'a')],[request(3,'a'),request(4,'a'),reply(5,'a')],
  [request(3,'a'),request(4,'a','other'),reply(5,'a')],
  [request(3,'a'),reply(4,'a'),reply(5,'a')],
  [request(3,'a'),authLine('AUTH_CONNECTION',{at:4,connection:2}),reply(5,'a',0,2)],
  [request(3,'a'),reply(4,'other')],['AUTH_REPLY {'],['AUTH_OBSERVER_UNAVAILABLE'],
  [authLine('AUTH_REQUEST',{at:3,connection:1,type:'player_login',account:'rod'})],
  [request(3,'a',''),reply(4,'a')],[request(3,'a','rod','unknown'),reply(4,'a')],
  [authLine('AUTH_REPLY',{at:3,connection:1,replyTo:'a',response:0,account:'other'})],
  [request(3,'a'),reply(2,'a')],['AUTH_ERROR {"at":3,"code":"record-limit"}'],
 ];
 for(const tail of bad){const log=(tail.length?[...head,...tail]:[]).join('\n');expect(()=>authReplies(log,1000,'rod','player_login')).toThrow('attribution');expect(noRecoveryLogin(log,1000,'rod')).toBe(false);}
});
test('practice observer preserves original receivers, arguments, return values and exceptions without retaining secrets',()=>{
 class Server extends EventEmitter{}
 class Socket extends EventEmitter{
  sent:any[][]=[];
  send(...args:any[]){this.sent.push(args);if(args[1]==='throw')throw failure;return 42;}
 }
 const failure=new Error('original failure'),lines:string[]=[];let time=0;
 installAuthObserver(Server,line=>lines.push(line),()=>++time);
 const server=new Server(),socket=new Socket();let receiver:any,received:any[]=[];
 server.on('connection',function(this:Server,...args){receiver=this;received=args;});
 expect(server.emit('connection',socket,'kept')).toBe(true);expect(receiver).toBe(server);expect(received).toEqual([socket,'kept']);
 let seen:any[]=[];socket.on('message',function(this:Socket,...args){expect(this).toBe(socket);seen=args;});
 const raw=Buffer.from(JSON.stringify({type:'player_login',replyTo:'id_a',username:'Rod',password:'SECRET_PASSWORD',save:'SECRET_SAVE',privateKey:'SECRET_KEY'}));
 expect(socket.emit('message',raw,true)).toBe(true);expect(seen).toEqual([raw,true]);
 const callback=()=>{};const response=JSON.stringify({replyTo:'id_a',response:0,save:'SECRET_SAVE'});
 expect(socket.send(response,{binary:false},callback)).toBe(42);expect(socket.sent[0]).toEqual([response,{binary:false},callback]);
 expect(authReplies(lines.join('\n'),0,'rod','player_login')).toHaveLength(1);
 expect(lines.join('\n')).not.toContain('SECRET');expect(lines.join('\n')).not.toContain('password');
 socket.on('message',()=>{throw failure;});expect(()=>socket.emit('message',raw,false)).toThrow(failure);
 expect(()=>socket.send(response,'throw')).toThrow(failure);
 // Malformed protocol still reaches the receiver/send; the observation marks its own failure.
 expect(()=>socket.emit('message','bad',false)).toThrow(failure);expect(socket.send('bad')).toBe(42);
 expect(()=>observeAuth(lines.join('\n'))).toThrow('attribution');
});
test('observer faults and record bounds do not change send/emitter behavior',()=>{
 class Server extends EventEmitter{};class Socket extends EventEmitter{send(...args:any[]){return args.length;}}
 const lines:string[]=[];installAuthObserver(Server,line=>lines.push(line),()=>1);
 const server=new Server(),socket=new Socket();server.emit('connection',socket);socket.on('message',()=>{});
 for(let i=0;i<8300;i++)socket.emit('message',JSON.stringify({type:'player_login',username:'rod',replyTo:'id_'+i,password:'secret'}));
 expect(lines).toHaveLength(8193);expect(lines.at(-1)).toContain('record-limit');expect(()=>observeAuth(lines.join('\n'))).toThrow('attribution');
 class BrokenServer extends EventEmitter{};installAuthObserver(BrokenServer,()=>{throw Error('sink failed');});
 const broken=new BrokenServer(),s=new Socket();broken.on('connection',()=>{});expect(broken.emit('connection',s)).toBe(true);expect(s.send('bad',2)).toBe(2);
});

test('the emitted native preload uses the same self-contained observer implementation',()=>{
 class Server extends EventEmitter{};class Socket extends EventEmitter{send(_value:string){return true;}}
 const lines:string[]=[];
 new Function('Server','write','now','('+installAuthObserver.toString()+')(Server,write,now);')(Server,(line:string)=>lines.push(line),()=>1);
 const server=new Server(),socket=new Socket();server.emit('connection',socket);
 socket.emit('message',JSON.stringify({type:'player_logout',username:'rod',replyTo:'id_a',save:'secret'}));
 expect(socket.send(JSON.stringify({response:0,replyTo:'id_a'}))).toBe(true);
 expect(authReplies(lines.join('\n'),0,'rod','player_logout')).toHaveLength(1);
 expect(lines.join('\n')).not.toContain('secret');
});

test('a final seal proves the observation is complete; lost paired records, clock faults and post-seal traffic refuse',()=>{
 const fixture=(drop:(line:string)=>boolean=()=>false,clock:()=>number=()=>1)=>{
  class Server extends EventEmitter{};class Socket extends EventEmitter{send(_value:string){return 42;}}
  const lines:string[]=[];
  const observer=installAuthObserver(Server,line=>{if(drop(line))throw Error('sink failed');lines.push(line);},clock);
  const server=new Server(),socket=new Socket();server.emit('connection',socket);
  const login=()=>{socket.emit('message',JSON.stringify({type:'player_login',replyTo:'id_a',username:'rod',password:'secret'}));return socket.send(JSON.stringify({replyTo:'id_a',response:0}));};
  return {lines,observer,login};
 };
 const good=fixture();expect(()=>observeAuth(good.lines.join('\n'),true)).toThrow('attribution');
 good.observer.seal();expect(observeAuth(good.lines.join('\n'),true).requests).toEqual([]);
 const truncated=good.lines.slice(0,-1).join('\n');expect(()=>observeAuth(truncated,true)).toThrow('attribution');
 good.login();expect(()=>observeAuth(good.lines.join('\n'),true)).toThrow('attribution');
 // A lost request AND its matching reply used to leave an apparently valid empty interval.
 const paired=fixture(line=>line.startsWith('AUTH_REQUEST ')||line.startsWith('AUTH_REPLY '));
 expect(paired.login()).toBe(42);expect(noRecoveryLogin(paired.lines.join('\n'),0,'rod')).toBe(true); // provisional only
 paired.observer.seal();expect(()=>observeAuth(paired.lines.join('\n'),true)).toThrow('attribution');expect(noRecoveryLogin(paired.lines.join('\n'),0,'rod')).toBe(false);
 let ticks=0;const badClock=fixture(()=>false,()=>{if(++ticks===3||ticks===4)throw Error('clock failed');return 1;});
 expect(badClock.login()).toBe(42);badClock.observer.seal();expect(()=>observeAuth(badClock.lines.join('\n'),true)).toThrow('attribution');
 const valid=fixture();valid.login();valid.observer.seal();const missingPair=valid.lines.filter(line=>!line.startsWith('AUTH_REQUEST ')&&!line.startsWith('AUTH_REPLY ')).join('\n');
 expect(()=>observeAuth(missingPair,true)).toThrow('attribution');
 const delayed=fixture();delayed.login();delayed.observer.seal();expect(observeAuth(delayed.lines.join('\n'),true).requests).toHaveLength(1);expect(noRecoveryLogin(delayed.lines.join('\n'),0,'rod')).toBe(false);
});
test('proof stop files are created exclusively and retained through normal and final cleanup',()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-stops-'));
 try{
  const own=claimStopArtifact(join(dir,'stop-Rod'),'proof marker 1');
  expect(releaseStopArtifact(own)).toBe('retained');expect(readFileSync(own.path,'utf8')).toBe(own.marker);
  // A preexisting foreign stop refuses the claim and keeps its bytes.
  writeFileSync(join(dir,'stop-Pre'),'operator stop');
  expect(()=>claimStopArtifact(join(dir,'stop-Pre'),'proof marker 2')).toThrow('stop path already exists');
  expect(readFileSync(join(dir,'stop-Pre'),'utf8')).toBe('operator stop');
  // Same path, replaced by another owner after the claim: different file, then same bytes on a new file, then changed bytes in place.
  const replaced=claimStopArtifact(join(dir,'stop-Swap'),'proof marker 3');rmSync(replaced.path);writeFileSync(replaced.path,'operator stop');
  expect(releaseStopArtifact(replaced)).toBe('retained');expect(readFileSync(replaced.path,'utf8')).toBe('operator stop');
  const copied=claimStopArtifact(join(dir,'stop-Copy'),'proof marker 4');rmSync(copied.path);writeFileSync(copied.path,'proof marker 4');
  expect(statSync(copied.path,{bigint:true}).ino).not.toBe(copied.ino);
  expect(releaseStopArtifact(copied)).toBe('retained');expect(existsSync(copied.path)).toBe(true);
  const edited=claimStopArtifact(join(dir,'stop-Edit'),'proof marker 5');writeFileSync(edited.path,'operator stop');
  expect(releaseStopArtifact(edited)).toBe('retained');expect(readFileSync(edited.path,'utf8')).toBe('operator stop');
  // The same helper is invoked by finally, including on failure. It touches none of these files.
  try{throw Error('proof failed');}catch{}finally{
   for(const stop of [own,replaced,copied,edited,{...own,path:join(dir,'stop-Pre')}])expect(releaseStopArtifact(stop)).toBe('retained');
  }
  for(const stop of [replaced,edited])expect(readFileSync(stop.path,'utf8')).toBe('operator stop');
  expect(readFileSync(join(dir,'stop-Pre'),'utf8')).toBe('operator stop');
  expect(readFileSync(own.path,'utf8')).toBe(own.marker);expect(readFileSync(copied.path,'utf8')).toBe(copied.marker);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test.each(['stat','read'] as const)('cleanup never observes or mutates stops, with a replacement armed after %s',boundary=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-stop-race-')),path=join(dir,'stop-Race');
 const stop=claimStopArtifact(path,'proof marker'),realStat=fs.statSync,realRead=fs.readFileSync,realUnlink=fs.unlinkSync,realWrite=fs.writeFileSync;
 let swapped=false;
 const replace=()=>{realUnlink(path);realWrite(path,'new operator stop');swapped=true;};
 const spies:ReturnType<typeof spyOn>[]=[];
 try{
  // Return the OLD observation, replacing the path AFTER the syscall and BEFORE its caller continues.
  // The old read/compare/unlink implementation loses the new stop at exactly this boundary.
  const stat=spyOn(fs,'statSync').mockImplementation(((...args:any[])=>{const value=(realStat as any)(...args);if(args[0]===path&&boundary==='stat'&&!swapped)replace();return value;}) as any);
  const read=spyOn(fs,'readFileSync').mockImplementation(((...args:any[])=>{const value=(realRead as any)(...args);if(args[0]===path&&boundary==='read'&&!swapped)replace();return value;}) as any);
  spies.push(stat,read);
  // Negative control proves this hook reaches the actual final-read race, rather than a before-call swap.
  if(boundary==='read'){
   const info=fs.statSync(path,{bigint:true});
   if(info.ino===stop.ino&&info.dev===stop.dev&&fs.readFileSync(path,'utf8')===stop.marker)fs.unlinkSync(path);
   expect(swapped).toBe(true);expect(fs.existsSync(path)).toBe(false);
   realWrite(path,stop.marker);swapped=false;stat.mockClear();read.mockClear();
  }
  for(const method of ['unlinkSync','renameSync','rmSync','truncateSync','ftruncateSync','writeFileSync','openSync'] as const){
   spies.push(spyOn(fs,method).mockImplementation((()=>{throw Error('cleanup filesystem mutation: '+method);}) as any));
  }
  try{expect(releaseStopArtifact(stop)).toBe('retained');throw Error('native proof failure');}
  catch(error){expect(String(error)).toContain('native proof failure');}
  finally{expect(releaseStopArtifact(stop)).toBe('retained');}
  // No observation means there is no check-to-delete interval for a replacement to exploit.
  for(const spy of spies)expect(spy).not.toHaveBeenCalled();
  expect(swapped).toBe(false);expect(realRead(path,'utf8')).toBe(stop.marker);
 }finally{for(const spy of spies.reverse())spy.mockRestore();rmSync(dir,{recursive:true,force:true});}
});
test('the native proof retains separate fixture and repository stop identities through finally',()=>{
 const text=readFileSync(join(import.meta.dir,'../src/session-recovery-proof.ts'),'utf8');
 expect(text).toContain("for(const kind of ['fixture','repository'] as const)");
 expect(text).toContain("const S=await fixture(HOST,preset),since=Date.now(),path=join(kind==='fixture'?base:root,'.practice','stop-'+S.name)");
 expect(text).toContain("distinctIdentities:rows[0].account!==rows[1].account");
 expect(text).toContain('claimStopArtifact(path,');expect(text).toContain('releaseStopArtifact(stop)');
 expect(text).not.toMatch(/unlinkSync\(path\)|globalStops/);
 expect(text).toContain('for(const stop of ownedStops)try{releaseStopArtifact(stop);}');
 expect(text).not.toContain('ownedStops.splice');
});
// Verbatim copy of the retained cYhUeI auth-observations.log (20 lines). It holds no credentials.
const RETAINED_COOLDOWN_LOG=[
 'AUTH_READY {"at":1793273964562,"schema":1}',
 'AUTH_CONNECTION {"at":1793273968972,"connection":1}',
 'AUTH_REQUEST {"at":1793273978460,"connection":1,"replyTo":"id_252e276a-b0df-41c6-a5c9-dd4e1615a090","type":"player_login","account":"flrcvxoly01"}',
 'AUTH_REPLY {"at":1793273978863,"connection":1,"replyTo":"id_252e276a-b0df-41c6-a5c9-dd4e1615a090","response":0}',
 'AUTH_REQUEST {"at":1793273980472,"connection":1,"replyTo":"id_df55031d-789b-46b4-968b-4b5ce9f9b9cf","type":"player_logout","account":"flrcvxoly01"}',
 'AUTH_REPLY {"at":1793273980478,"connection":1,"replyTo":"id_df55031d-789b-46b4-968b-4b5ce9f9b9cf","response":0}',
 'AUTH_REQUEST {"at":1793273997529,"connection":1,"replyTo":"id_f8f4471a-2cfa-4a30-bb0f-ca88dd8feb3a","type":"player_login","account":"flrcvxoly01"}',
 'AUTH_REPLY {"at":1793273997922,"connection":1,"replyTo":"id_f8f4471a-2cfa-4a30-bb0f-ca88dd8feb3a","response":1}',
 'AUTH_REQUEST {"at":1793274004084,"connection":1,"replyTo":"id_d91f602f-ced2-4471-b616-ab2b39a791a1","type":"player_login","account":"flrcvxf6b23"}',
 'AUTH_REPLY {"at":1793274004198,"connection":1,"replyTo":"id_d91f602f-ced2-4471-b616-ab2b39a791a1","response":0}',
 'AUTH_REQUEST {"at":1793274007315,"connection":1,"replyTo":"id_bf939c49-66f7-42af-9440-7df0cd1ff57f","type":"player_logout","account":"flrcvxf6b23"}',
 'AUTH_REPLY {"at":1793274007317,"connection":1,"replyTo":"id_bf939c49-66f7-42af-9440-7df0cd1ff57f","response":0}',
 'AUTH_REQUEST {"at":1793274010039,"connection":1,"replyTo":"id_47c64add-1d5c-433c-bc86-9f9be3f40809","type":"player_login","account":"flrcvxjy734"}',
 'AUTH_REPLY {"at":1793274010150,"connection":1,"replyTo":"id_47c64add-1d5c-433c-bc86-9f9be3f40809","response":0}',
 'AUTH_REQUEST {"at":1793274010919,"connection":1,"replyTo":"id_f0c7cfcb-6607-4030-ba5d-f6e0b6422e55","type":"player_login","account":"flrcvxjy734"}',
 'AUTH_REPLY {"at":1793274010921,"connection":1,"replyTo":"id_f0c7cfcb-6607-4030-ba5d-f6e0b6422e55","response":0}',
 'AUTH_REQUEST {"at":1793274022060,"connection":1,"replyTo":"id_67f97aee-4b11-45d0-8168-8c83a4a6dde8","type":"player_login","account":"flrcvxjy734"}',
 'AUTH_REPLY {"at":1793274022062,"connection":1,"replyTo":"id_67f97aee-4b11-45d0-8168-8c83a4a6dde8","response":0}',
 'AUTH_REQUEST {"at":1793274023971,"connection":1,"replyTo":"id_7962ffed-3640-4851-b991-bb6ed7417008","type":"player_logout","account":"flrcvxjy734"}',
 'AUTH_REPLY {"at":1793274023973,"connection":1,"replyTo":"id_7962ffed-3640-4851-b991-bb6ed7417008","response":0}',
].join('\n')+'\n';
test('the retained cooldown timeline fails as an expired window, and its stale owner view is not owner evidence',()=>{
 expect(createHash('sha256').update(RETAINED_COOLDOWN_LOG).digest('hex')).toBe('68ccff4a8cbfc9660e7925982cbe049a5bd43c81e24c2d051c94ff25940fc01e');
 // Retained owner-ready: loggedInAt 1793274010797 (the old flow took over at once), at 1793274011677. Server window was the 10 s default.
 const w=classifyCooldownWindow(RETAINED_COOLDOWN_LOG,'flrcvxjy734',{signalAt:1793274010797,warmAt:1793274011677,since:1793274011677,windowMs:10000});
 expect(w).toEqual({ok:false,reason:'window expired before recovery',windowMs:10000,takeoverReplyAt:1793274010921,recoveryRequestAt:1793274022060,gapMs:11139});
 // The retained owner-after view still said inGame with the same stock. The server log shows a recovery login success first.
 const staleView={inGame:true,inventory:[{id:995,count:1200}]};expect(staleView.inGame).toBe(true);
 const owner=ownerSessionEvidence(RETAINED_COOLDOWN_LOG,'flrcvxjy734',{since:1793274011677,releaseAt:1793274030639,ownerLoginReplyAt:1793274010921,ownerAttempt:'1793274010798-0000015224-0000000005',latestAttemptBeforeRelease:'1793274010798-0000015224-0000000005'});
 expect(owner).toEqual({ok:false,noRecoveryLoginSuccess:false,ownerLoginLatest:false,ownerAttemptLatest:true,ownerLogoutAfterRelease:false});
 const row={id:'cooldown',ok:false,checks:{takeoverWindowOpen:false,activeOwnerPreserved:false},reason:w.reason};
 expect(()=>retainRequiredRecoveryCase(row,()=>{})).toThrow('required case failed: cooldown:takeoverWindowOpen/activeOwnerPreserved (window expired before recovery)');
});
// A warm owner: first login at 3/4, its own takeover at 20/21, then the recovery request.
const warmLog=(recoveryAt:number,response:number,extra:string[]=[])=>[...authHead(),request(3,'first'),reply(4,'first'),request(20,'warm'),reply(21,'warm'),...extra,request(recoveryAt,'recovery'),reply(recoveryAt+1,'recovery',response)].join('\n');
const W={signalAt:10,warmAt:30,since:40,windowMs:1000};
test('a recovery login inside the open takeover window must be refused with response 3',()=>{
 expect(classifyCooldownWindow(warmLog(500,3),'Rod',W)).toEqual({ok:true,reason:'recovery login refused with response 3 inside the open takeover window',windowMs:1000,takeoverReplyAt:21,recoveryRequestAt:500,gapMs:479,response:3});
 const accepted=classifyCooldownWindow(warmLog(500,0),'rod',W);expect(accepted.ok).toBe(false);expect(accepted.reason).toBe('recovery login inside the window was not refused with response 3');
});
test('a gap exactly at the bound is expired; one millisecond less is open',()=>{
 expect(classifyCooldownWindow(warmLog(1021,3),'rod',W)).toMatchObject({ok:false,reason:'window expired before recovery',gapMs:1000});
 expect(classifyCooldownWindow(warmLog(1020,3),'rod',W)).toMatchObject({ok:true,gapMs:999});
 // A refused login after the window still fails as expired; it is never relabelled as success.
 expect(classifyCooldownWindow(warmLog(5000,3),'rod',W)).toMatchObject({ok:false,reason:'window expired before recovery'});
 expect(classifyCooldownWindow(warmLog(500,3),'rod',{...W,windowMs:0}).reason).toBe('takeover window unbound');
});
test('a response 3 for another account or another request is not the recovery refusal',()=>{
 const other=[request(35,'other','bob'),reply(36,'other',3)];
 expect(classifyCooldownWindow(warmLog(500,0,other),'rod',W).reason).toBe('recovery login inside the window was not refused with response 3');
 expect(classifyCooldownWindow(warmLog(500,3,other),'bob',W).reason).toBe('warm takeover reply missing or ambiguous');
 // A refused rod request before submit does not count, and a second rod request after submit is ambiguous.
 expect(classifyCooldownWindow(warmLog(500,0,[request(25,'early'),reply(26,'early',3)]),'rod',W).reason).toBe('recovery login inside the window was not refused with response 3');
 expect(classifyCooldownWindow(warmLog(500,3,[request(45,'second'),reply(46,'second',3)]),'rod',W).reason).toBe('recovery login request missing or ambiguous');
 const crossed=[...authHead(),authLine('AUTH_CONNECTION',{at:2,connection:2}),request(3,'first'),reply(4,'first'),request(20,'warm'),reply(21,'warm'),request(500,'recovery'),request(501,'recovery','bob','player_login',2),reply(502,'recovery',3,2),reply(503,'recovery',0)].join('\n');
 expect(classifyCooldownWindow(crossed,'rod',W).reason).toBe('recovery login inside the window was not refused with response 3');
});
test('a missing warm-takeover reply, or a warm login that took over nothing, fails',()=>{
 const missing=[...authHead(),request(3,'first'),reply(4,'first'),request(500,'recovery'),reply(501,'recovery',3)].join('\n');
 expect(classifyCooldownWindow(missing,'rod',W).reason).toBe('warm takeover reply missing or ambiguous');
 const late=[...authHead(),request(3,'first'),reply(4,'first'),request(20,'warm'),reply(31,'warm'),request(500,'recovery'),reply(501,'recovery',3)].join('\n');
 expect(classifyCooldownWindow(late,'rod',W).reason).toBe('warm takeover reply missing or ambiguous');
 const notTakeover=[...authHead(),request(3,'first'),reply(4,'first'),request(5,'out','rod','player_logout'),reply(6,'out'),request(20,'warm'),reply(21,'warm'),request(500,'recovery'),reply(501,'recovery',3)].join('\n');
 expect(classifyCooldownWindow(notTakeover,'rod',W).reason).toBe('warm login did not take over a live session');
 expect(classifyCooldownWindow('AUTH_REPLY {',"rod",W).reason).toBe('auth attribution unknown');
});
test('owner preservation needs server-side evidence; a stale client view after a real takeover is not enough',()=>{
 const o={since:40,releaseAt:600,ownerLoginReplyAt:21,ownerAttempt:'a2',latestAttemptBeforeRelease:'a2'};
 const kept=warmLog(500,3,[])+'\n'+request(610,'cleanup','rod','player_logout')+'\n'+reply(611,'cleanup');
 expect(ownerSessionEvidence(kept,'rod',o)).toEqual({ok:true,noRecoveryLoginSuccess:true,ownerLoginLatest:true,ownerAttemptLatest:true,ownerLogoutAfterRelease:true});
 // Takeover by recovery, then the recovery's own logout before release. The owner's client view still reads inGame.
 const taken=warmLog(500,0,[])+'\n'+request(520,'recovery-out','rod','player_logout')+'\n'+reply(521,'recovery-out');
 expect(ownerSessionEvidence(taken,'rod',o)).toMatchObject({ok:false,noRecoveryLoginSuccess:false,ownerLoginLatest:false,ownerLogoutAfterRelease:false});
 // No owner logout reply after release (the retained 'OWNER_LOGOUT logged-out' line had none).
 expect(ownerSessionEvidence(warmLog(500,3,[]),'rod',o).ownerLogoutAfterRelease).toBe(false);
 expect(ownerSessionEvidence(kept,'rod',{...o,latestAttemptBeforeRelease:'a3'}).ownerAttemptLatest).toBe(false);
 expect(ownerSessionEvidence(kept,'rod',{...o,ownerLoginReplyAt:undefined}).ok).toBe(false);
 expect(ownerSessionEvidence('AUTH_REPLY {','rod',o).ok).toBe(false);
 expect(latestOwnerLoginBefore(kept,'rod',40)).toBe(21);expect(latestOwnerLoginBefore('AUTH_REPLY {','rod',40)).toBeUndefined();
});
test('orphan recovery is measured after the bound window from the latest prior login',()=>{
 const log=(at:number)=>[...authHead(),request(3,'owner'),reply(4,'owner'),request(at,'recovery'),reply(at+1,'recovery')].join('\n');
 expect(loginAfterTakeoverWindow(log(1004),'rod',100,1000)).toEqual({ok:true,gapMs:1000});
 expect(loginAfterTakeoverWindow(log(1003),'rod',100,1000)).toEqual({ok:false,gapMs:999});
 expect(loginAfterTakeoverWindow([...authHead(),request(1004,'recovery'),reply(1005,'recovery')].join('\n'),'rod',100,1000)).toEqual({ok:false,gapMs:null});
 expect(loginAfterTakeoverWindow('AUTH_REPLY {','rod',100,1000)).toEqual({ok:false,gapMs:null});
});
test('the native proof binds the private takeover window and opens it just before the recovery submit',()=>{
 const text=readFileSync(join(import.meta.dir,'../src/session-recovery-proof.ts'),'utf8');
 expect(TAKEOVER_WINDOW_MS).toBeGreaterThan(30000);
 expect(text).toContain("LOGIN_TAKEOVER_MIN_MS:String(TAKEOVER_WINDOW_MS)");expect(text).toContain('takeoverWindowMs:TAKEOVER_WINDOW_MS');
 expect(text).toContain("held('cooldown',C,d8890,async()=>{warm=await o.takeover();})");
 expect(text).toContain('await beforeSubmit(r);const submittedAt=Date.now(),sub=submit(d,r,taskOwner.pid);');
 // The client getState() view never decides a session outcome.
 expect(text).not.toMatch(/after\.inGame|stillOwned/);
});
test('the module main does not run on import',()=>{
 expect(readFileSync(join(import.meta.dir,'../src/session-recovery-proof.ts'),'utf8')).toContain('if(import.meta.main)');
});
test('native recovery uses the current delivery identity with the shark default',()=>{
 expect(recoveryCapability('cow-progress-order')).toBe('cow-progress-order');expect(recoveryCapability('shark-supply-order')).toBe('shark-supply-order');
 expect(()=>recoveryCapability('../cow')).toThrow();expect(()=>recoveryCapability('')).toThrow();
 const text=readFileSync(join(import.meta.dir,'../src/session-recovery-proof.ts'),'utf8');expect(text).toContain('process.env.DELIVERY_ID??deliveryTask?.id');
 expect(CHECK_CASES.completed).toEqual(['completed','completed-refusals']);
});
test('completed router pins fail closed if either actual integration file drifts',()=>{
 const base=mkdtempSync(join(tmpdir(),'completed-router-pins-'));
 const files=['packages/router/src/coordinator-live.ts','packages/router/test/coordinator-recovery.test.ts'];
 try{
  for(const path of files){mkdirSync(join(base,path,'..'),{recursive:true});writeFileSync(join(base,path),'pinned '+path);}
  mkdirSync(join(base,'.practice/supervision-session-admission-20261029'),{recursive:true});
  const pins=files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(join(base,path))).digest('hex')}));
  writeFileSync(join(base,'.practice/supervision-session-admission-20261029/result.json'),JSON.stringify({routerCompletedAccountIntegration:{files:pins}}));
  expect(verifyCompletedRouterPins(base)).toEqual(pins);
  for(const path of files){const before=readFileSync(join(base,path));writeFileSync(join(base,path),'changed');expect(()=>verifyCompletedRouterPins(base)).toThrow('integration drift');writeFileSync(join(base,path),before);}
 }finally{rmSync(base,{recursive:true,force:true});}
});
test('a timer-only fleet snapshot stays stale at a late handoff; a fresh owned handoff resolves without hiding real ownership',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-handoff-')),path=join(dir,'swarm-state.json'),account='flrcvxgwj01';
 const write=(at:number,state='disabled',pid=process.pid)=>writeFileSync(path,JSON.stringify({at,controllerPid:pid,jobs:[{account,state}]}));
 try{
  // Retained failure: the timer wrote at 1793290278501 and the auth-failure dispatch read it at 1793290298944.
  expect(fleetHandoff(()=>write(1793290278501),path,account,process.pid,()=>1793290298944)).toEqual({at:1793290278501,observedAt:1793290298944,ageMs:20443,verdict:'stale'});
  const now=1793290298944;
  expect(fleetHandoff(()=>write(now),path,account,process.pid,()=>now+3)).toEqual({at:now,observedAt:now+3,ageMs:3,verdict:'resolved'});
  // The refresh republishes the owner's own view; it cannot turn a busy, foreign or future view into readiness.
  for(const state of ['running','starting','stopping'])expect(fleetHandoff(()=>write(now,state),path,account,process.pid,()=>now).verdict).toBe('account-active');
  expect(fleetHandoff(()=>write(now,'disabled',process.pid+1),path,account,process.pid,()=>now).verdict).toBe('controller');
  expect(fleetHandoff(()=>write(now+1),path,account,process.pid,()=>now).verdict).toBe('future');
  expect(fleetHandoff(()=>write(now-10001),path,account,process.pid,()=>now).verdict).toBe('stale');
  expect(fleetHandoff(()=>write(now-10000),path,account,process.pid,()=>now).verdict).toBe('resolved');
  expect(fleetHandoff(()=>writeFileSync(path,'{'),path,account,process.pid,()=>now)).toEqual({at:null,observedAt:now,ageMs:null,verdict:'malformed'});
  expect(fleetHandoff(()=>rmSync(path),path,account,process.pid,()=>now).verdict).toBe('missing');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
