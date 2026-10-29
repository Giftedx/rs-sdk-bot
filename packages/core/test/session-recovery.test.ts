import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {workerSourceRevision} from '../src/worker-release';
import {beginSessionAttempt,listAttempts} from '../src/session-lifecycle';
import {RECOVERY_SCHEMA,RECOVERY_SCRIPT,recoverSession,validateRecoveryRequest,recoveryBoundary,recoveryHeldDiagnostic,recoveryDiagnosticFromLog,RECOVERY_SETUP_PHASES,type RecoveryRequest} from '../src/session-recovery';
const source='a'.repeat(64),server='localhost:8888';
test('CLI boundary diagnostics identify every setup phase without copying secrets or publishing authority',async()=>{
 for(const phase of RECOVERY_SETUP_PHASES){
  let observed:unknown;
  try{await recoveryBoundary(phase,()=>{throw Error('PASSWORD=secret-value ws://user:secret-value@host');});}catch(e){observed=e;}
  const diagnostic=recoveryHeldDiagnostic(observed);
  expect(diagnostic).toMatchObject({phase,reason:'unresolved',state:'held',authorizesConnection:false,producerReceipt:false});
  expect(JSON.stringify(diagnostic)).not.toContain('secret-value');
  expect(recoveryDiagnosticFromLog('RECOVERY_HELD '+JSON.stringify(diagnostic))).toEqual({phase,reason:'unresolved'});
 }
});
test('retained first refusal is a closed code, never legacy or arbitrary exception text',()=>{
 const d={schema:'session-recovery-diagnostic/1',state:'held',phase:'permit-consumption',reason:'child-changed',authorizesConnection:false,producerReceipt:false};
 expect(recoveryDiagnosticFromLog('RECOVERY_HELD '+JSON.stringify(d))).toEqual({phase:'permit-consumption',reason:'child-changed'});
 expect(recoveryDiagnosticFromLog('RECOVERY_HELD setup or persistence failed; no retry')).toBeNull();
 for(const over of [{reason:'PASSWORD=secret-value'},{phase:'PASSWORD=secret-value'},{authorizesConnection:true},{producerReceipt:true}])expect(recoveryDiagnosticFromLog('RECOVERY_HELD '+JSON.stringify({...d,...over}))).toBeNull();
});
test('setup distinguishes known authority, source, child, stops, credentials and IO refusals',async()=>{
 for(const [message,reason] of [['recovery source changed','source-changed'],['recovery child identity changed','child-changed'],['native fixture boundary invalid','fixture-boundary'],['recovery request lease changed','request-lease-changed'],['recovery owner stopped','owner-stopped'],['recovery account server mismatch','server-mismatch'],['recovery credential unavailable','credential-unavailable'],['recovery nonce already consumed','nonce-consumed']]){
  try{await recoveryBoundary('permit-consumption',()=>{throw Error(message);});throw Error('must refuse');}
  catch(e){expect(recoveryHeldDiagnostic(e)).toMatchObject({phase:'permit-consumption',reason});}
 }
 try{await recoveryBoundary('credentials-read',()=>{throw Object.assign(Error('secret-value'),{code:'ENOENT',path:'secret-value'});});}
 catch(e){expect(recoveryHeldDiagnostic(e)).toMatchObject({phase:'credentials-read',reason:'io-enoent'});expect(JSON.stringify(recoveryHeldDiagnostic(e))).not.toContain('secret-value');}
});
test('diagnostic publication cannot create a connection admission or a producer receipt',async()=>{
 const f=fixture(),diagnostic=recoveryHeldDiagnostic(Error('private'));
 await expect(recoverSession(f.request,{...f.deps,admission:diagnostic as any})).rejects.toThrow('admission invalid');
 expect(f.counts().connected).toBe(0);expect(listAttempts(f.request.account,server,{root:f.root})).toHaveLength(0);
});
test('actual CLI reports safe setup refusals before credentials, producer intent or output publication',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-cli-refusal-')),repo=resolve(import.meta.dir,'../../..'),source=workerSourceRevision();
 const body={schema:RECOVERY_SCHEMA,account:'Recoverme',server:'localhost:8888',runId:'offline-cli-test',nonce:'one',endedAt:1,source};
 const cases=[
  {input:null,phase:'request-read',reason:'io-enoent'},
  {input:'PASSWORD=secret-value',phase:'request-read',reason:'unresolved'},
  {input:JSON.stringify({...body,account:'Haggis'}),phase:'request-validation',reason:'request-invalid'},
  {input:JSON.stringify({...body,server:'rs-sdk-demo.fly.dev'}),phase:'remote-authority',reason:'remote-unqualified'},
  {input:JSON.stringify({...body,source:'0'.repeat(64)}),phase:'source',reason:'source-changed'},
  {input:JSON.stringify({...body,kind:'session-recovery'}),phase:'fixture-root',reason:'fixture-boundary',args:['--permit-base='+repo]},
 ];
 for(const [i,c] of cases.entries()){
  const path=join(dir,i+'.json'),out=join(dir,i+'-output');if(c.input!==null)writeFileSync(path,c.input);
  const p=Bun.spawn([process.execPath,join(repo,RECOVERY_SCRIPT),path,out,...(c.args??[])],{cwd:repo,stdout:'pipe',stderr:'pipe',windowsHide:true});
  const timer=setTimeout(()=>p.kill(),8000);
  const [code,stdout,stderr]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);clearTimeout(timer);
  expect(code).toBe(1);expect(stdout).toBe('');expect(stderr).not.toContain('secret-value');
  const lines=stderr.trim().split(/\r?\n/);expect(lines).toHaveLength(1);expect(lines[0]).toStartWith('RECOVERY_HELD ');
  expect(JSON.parse(lines[0]!.slice('RECOVERY_HELD '.length))).toMatchObject({phase:c.phase,reason:c.reason,authorizesConnection:false,producerReceipt:false});
  expect(existsSync(out)).toBe(false);
 }
},30000);
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'session-recovery-')),request:RecoveryRequest={schema:RECOVERY_SCHEMA,account:'Recoverme',server,runId:'native-recovery',nonce:'one-attempt',endedAt:1,source};
 let state:any={inGame:true,player:{name:request.account,worldX:2618,worldZ:3332,level:0,hp:43},inventory:[{id:995,count:1200}],equipment:[{id:311,count:1}],skills:[{name:'Fishing',experience:1000,level:99}],bank:{isOpen:false,items:[]},modalOpen:false,modalInterface:-1};
 let connected=0,loggedOut=0,closed=0;const lines:string[]=[];
 let lifecycle:ReturnType<typeof beginSessionAttempt>;
 const session:any={name:request.account,sdk:{getState:()=>state},get lifecycle(){return lifecycle;},set lifecycle(value){lifecycle=value;}};
 const deps={root,guard:()=>{},log:(s:string)=>lines.push(s),connect:async()=>{connected++;lifecycle=beginSessionAttempt({account:request.account,server},{root,owner:{pid:process.pid,coordinatorRunId:request.runId,workerRelease:source,script:RECOVERY_SCRIPT,role:'recovery',participants:null}});lifecycle.record('connected');return session;},ready:async()=>true,
  closeModal:async()=>{state.modalOpen=false;return true;},logout:async()=>{loggedOut++;lifecycle.record('ended','logged-out');lifecycle.record('logout','logged-out');return'logged-out';},close:async()=>{closed++;lifecycle.record('closed');}};
 return{root,request,deps,session,lines,state,counts:()=>({connected,loggedOut,closed})};
}
test('recovery confirms one exact producer attempt and makes no gameplay or failure-clear claim',async()=>{
 const f=fixture(),r=await recoverSession(f.request,f.deps);
 expect(r.state).toBe('confirmed');expect(r.attemptId).toBe(f.session.lifecycle.attemptId);expect(r.lifecycleSha256).toHaveLength(64);
 expect(f.counts()).toEqual({connected:1,loggedOut:1,closed:1});expect(r.scope).toMatchObject({gameplay:false,production:0,repairsFailure:false,qualifiesScript:false,bankObservation:'unobserved'});
 expect(r.before).toEqual(r.after);expect(listAttempts(f.request.account,server,{root:f.root})).toHaveLength(1);
});
test('actual SDK skills-array Proxy is copied into an independent snapshot',async()=>{
 const f=fixture();f.state.skills=new Proxy(f.state.skills,{get:(target,key)=>key==='Fishing'?target[0]:Reflect.get(target,key)});
 const r=await recoverSession(f.request,f.deps);expect(r.state).toBe('confirmed');expect(r.before!.skills).toEqual([{name:'Fishing',experience:1000,level:99}]);
 f.state.skills[0].level=1;expect((r.before!.skills[0] as any).level).toBe(99);
});
test('protected identities and owner/stop refusals happen before any connection intent',async()=>{
 for(const account of ['Haggis','shaftshooter','POLEVAULTER'])expect(()=>validateRecoveryRequest({...fixture().request,account})).toThrow('protected');
 const f=fixture();f.deps.guard=()=>{throw Error('another owner or stop');};
 await expect(recoverSession(f.request,f.deps)).rejects.toThrow('owner');expect(f.counts().connected).toBe(0);expect(listAttempts(f.request.account,server,{root:f.root})).toHaveLength(0);
 const live=fixture();await expect(recoverSession({...live.request,server:'rs-sdk-demo.fly.dev'},live.deps)).rejects.toThrow('not qualified');expect(live.counts().connected).toBe(0);
});
test('a caller-made admission or ok flag cannot authorize any connection',async()=>{
 for(const server of ['rs-sdk-demo.fly.dev','localhost:8888'])for(const admission of [{nonce:'one-attempt'},Object.freeze({nonce:'one-attempt',ok:true}),true as any]){
  const f=fixture();await expect(recoverSession({...f.request,server},{...f.deps,admission})).rejects.toThrow('admission invalid');
  expect(f.counts().connected).toBe(0);expect(listAttempts(f.request.account,server,{root:f.root})).toHaveLength(0);
 }
});
test('auth/connection failure is held without leaking the original error or retrying',async()=>{
 const f=fixture();let calls=0;f.deps.connect=async()=>{calls++;throw Error('PASSWORD=secret-value');};
 const r=await recoverSession(f.request,f.deps);expect(r.state).toBe('held');expect(calls).toBe(1);expect(f.counts().loggedOut).toBe(0);expect(JSON.stringify(r)+f.lines.join('')).not.toContain('secret-value');
});
test('returned logout errors and thrown logout errors cannot leak diagnostic secrets',async()=>{
 for(const kind of ['returned','thrown']){
  const f=fixture(),logout=f.deps.logout;
  f.deps.logout=async()=>{await logout();if(kind==='thrown')throw Error('PASSWORD=secret-value');return'error PASSWORD=secret-value';};
  const r=await recoverSession(f.request,f.deps);expect(r.state).toBe('held');expect(JSON.stringify(r)+f.lines.join('')).not.toContain('secret-value');
  expect(r.logout).toBe(kind==='returned'?'unconfirmed':'error');expect(f.counts()).toEqual({connected:1,loggedOut:1,closed:1});
 }
});
test('failed readiness, wrong identity, state loss and unresolved modal cleanup stay held after one cleanup',async()=>{
 for(const reason of ['ready','identity','loss','modal']){
  const f=fixture();if(reason==='ready')f.deps.ready=async()=>false;
  if(reason==='identity')f.state.player.name='Other';
  if(reason==='loss'){f.state.modalOpen=true;f.deps.closeModal=async()=>{f.state.inventory=[];f.state.modalOpen=false;return true;};}
  if(reason==='modal'){f.state.modalOpen=true;f.deps.closeModal=async()=>false;}
  const r=await recoverSession(f.request,f.deps);expect(r.state).toBe('held');expect(f.counts()).toEqual({connected:1,loggedOut:1,closed:1});
 }
});
test('timeout/disconnect and a newer intent cannot borrow a confirmed cleanup from the old attempt',async()=>{
 for(const reason of ['timeout','disconnected','new-intent']){
  const f=fixture();if(reason==='new-intent'){const close=f.deps.close;f.deps.close=async()=>{await close();beginSessionAttempt({account:f.request.account,server},{root:f.root});};}
  else f.deps.logout=async()=>{f.session.lifecycle.record('ended',reason==='timeout'?'unknown':'disconnected');return reason;};
  const r=await recoverSession(f.request,f.deps);expect(r.state).toBe('held');expect(f.counts().connected).toBe(1);
 }
});
test('caller success cannot replace actual producer source or script provenance',async()=>{
 for(const key of ['script','workerRelease']){
  const f=fixture(),connect=f.deps.connect;
  f.deps.connect=async()=>{await connect();const a=f.session.lifecycle;const path=join(f.root,'practice','localhost_8888',f.request.account.toLowerCase(),'attempts',a.attemptId+'.json');
   // Mutating the test receipt simulates crossed producer provenance; the reader must not trust caller source.
   const r=JSON.parse(readFileSync(path,'utf8'));r.owner[key]=key==='script'?'scripts/combat.ts':'b'.repeat(64);
   const {writeFileSync}=await import('node:fs');writeFileSync(path,JSON.stringify(r));
   // Prevent the real test producer's next callback from replacing our adversarial persisted receipt.
   f.session.lifecycle={...a,record:()=>true};const logout=f.deps.logout;f.deps.logout=async()=>{await logout();r.events.push({at:Date.now(),kind:'ended',detail:'logged-out'});writeFileSync(path,JSON.stringify(r));return'logged-out';};return f.session;};
  const result=await recoverSession(f.request,f.deps);
  expect(result.state).toBe('held');expect(result.failure).toBe('producer outcome not bound and confirmed');expect(result.logout).toBe('logged-out');expect(result.proof.state).toBe('confirmed');
  expect(f.counts()).toEqual({connected:1,loggedOut:1,closed:1});
 }
});
