import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {FLEET_HEARTBEAT_MAX_MS,RECOVERY_BINDING_MS,RECOVERY_SCRIPT,issueRecoveryPermit,bindRecoveryChild,consumeRecoveryPermit,consumeRecoveryConnection,spendRecoveryConnection,assertNoRecoveryLease,recoveryPermitPaths,finishRecoveryPermit,launchPermittedRecovery,recoveredSessionForRun,heldRecoveryOwners,assertRecoveryNotStopped,verifyNativeRecoveryProof,NATIVE_RECOVERY_CHECKS} from '../src/session-recovery-permit';
import {beginSessionAttempt,readLogoutProof} from '../src/session-lifecycle';
import {installJob} from '../../router/src/coordinator-live';
import {applyEndRepair,type ScriptHold} from '../../../scripts/swarm';
import {recoveryHeldDiagnostic,recoveryBoundary,recoveryDiagnosticFromLog} from '../src/session-recovery';
import {missionSignature} from '../src/session-admission';
const source='a'.repeat(64),runner='b'.repeat(64),now=1793258000000;
test('the controller launches the core recovery worker inside the gameplay ownership scope',()=>{
 expect(RECOVERY_SCRIPT).toBe('packages/core/src/session-recovery.ts');
});
test('private fixtures honour every repository and fixture stop flag',()=>{
 const base=mkdtempSync(join(tmpdir(),'recovery-stop-')),repo=resolve(import.meta.dir,'../../..');
 for(const root of [base,repo])for(const flag of ['stop-coordinator','stop-swarm','stop-Rod']){
  const stopped=join(root,'.practice',flag),observed:string[]=[];
  expect(()=>assertRecoveryNotStopped('Rod',base,path=>{observed.push(path);return path===stopped;})).toThrow('owner stopped');
  expect(observed).toContain(stopped);
 }
 expect(()=>assertRecoveryNotStopped('Rod',base,()=>false)).not.toThrow();
});
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'recovery-permit-'));
 const put=(path:string,value:any)=>{mkdirSync(dirname(join(base,path)),{recursive:true});writeFileSync(join(base,path),JSON.stringify(value));};
 const ref=(path:string)=>({path,sha256:createHash('sha256').update(readFileSync(join(base,path))).digest('hex')});
 put(RECOVERY_SCRIPT,'fixture runner');
 const runnerHash=createHash('sha256').update(readFileSync(join(base,RECOVERY_SCRIPT))).digest('hex');
 put('.practice/coordinator/swarm-owner.json',{pid:process.pid,nonce:'controller',source});
 put('.practice/coordinator/state.json',{tasks:[{status:'running',runId:'task-run',pid:10,spec:{kind:'run',capability:'shark-supply-order',account:'Rod',sessionRecovery:{account:'Rod',endedAt:100},repairs:[{account:'Rod',endedAt:100}]}}]});
 put('.practice/coordinator/runs/task-run/owner.json',{pid:10,runId:'task-run'});
 put('.practice/swarm-repair.json.lease',{pid:10,runId:'task-run',nonce:'one'});
 put('.practice/swarm-deaths.json',{Rod:{at:100,reason:'blocked',revision:JSON.stringify(['scripts/old.ts',false,['rod'],[]])}});
 put('swarm.json',{maxBots:17,minFreeGB:0,jobs:[{account:'Rod',script:'scripts/old.ts',enabled:false,coordinatorOwner:'coordinator'}]});
 put('.practice/swarm-state.json',{at:now,controllerPid:process.pid,jobs:[{account:'Rod',state:'disabled'}]});
 put('.practice/deliveries/fixture/cases/raw.log',{observed:'unit fixture bytes, not native evidence'});
 const raw={path:'cases/raw.log',sha256:createHash('sha256').update(readFileSync(join(base,'.practice/deliveries/fixture/cases/raw.log'))).digest('hex')};
 put('.practice/deliveries/fixture/recovery.json',{ok:true,level:'native-controller-recovery',runtimeRevision:source,runnerSha256:runnerHash,
  cases:[{id:'unit',ok:true,level:'native-unit-fixture',evidence:[raw]}],
  checks:Object.fromEntries(NATIVE_RECOVERY_CHECKS.map(k=>[k,{ok:true,level:'native-unit-fixture',cases:['unit'],evidence:[raw]}]))});
 put('.practice/deliveries/fixture/gate.out.log',{unused:true});
 writeFileSync(join(base,'.practice/deliveries/fixture/gate.out.log'),'RECOVERY_NATIVE_PROOF '+JSON.stringify(ref('.practice/deliveries/fixture/recovery.json'))+'\n');
 put('.practice/deliveries/fixture/report.json',{ok:true,stage:'delivered',id:'shark-supply-order',at:now-1,runtimeRevision:source,checks:[{id:'native-session-recovery',phase:'practice',exitCode:0,
  detail:JSON.stringify({stdout:join(base,'.practice/deliveries/fixture/gate.out.log')})}]});
 const request:any={schema:'session-recovery/1',kind:'session-recovery',account:'Rod',server:'localhost:8888',runId:'task-run',nonce:'one',endedAt:100,source,
  qualification:{delivery:ref('.practice/deliveries/fixture/report.json'),proof:ref('.practice/deliveries/fixture/recovery.json')}};
 const options={now:()=>now,matches:(_pid:number,_marker:string)=>true,source:()=>source};
 return {base,put,request,options,runnerHash};
}

function completedFixture(){
 const f=fixture();
 const state=JSON.parse(readFileSync(join(f.base,'.practice/coordinator/state.json'),'utf8'));
 state.tasks[0].spec.env={TRAIN_SKILL:'Attack',TARGET_LEVEL:'20'};
 f.put('.practice/coordinator/state.json',state);
 f.put('packages/router/tasks/shark-supply-order.json',{id:'shark-supply-order',entry:'scripts/new.ts'});
 const revision=missionSignature({account:'Rod',script:'scripts/new.ts',env:{...state.tasks[0].spec.env,CAP:'1600',COORDINATOR_RUN_ID:f.request.runId}});
 f.put('.practice/swarm-deaths.json',{Rod:{at:100,reason:'done after 1 runs',revision:'retired-strength20'}});
 f.put('.practice/swarm-script-holds.json',[]);
 f.put('.practice/status/Rod.json',{name:'Rod',server:f.request.server,at:now-100000,result:'ok Strength20'});
 return {...f,revision};
}
test('successful retired cleanup requires a new actual mission, no hold, no producer history and exact authority',()=>{
 for(const fault of ['none','same','hold','qualified-hold','history','orphan','active','reserved','missing-assignment','composed','authorization','source','end','unknown']){
  const f=completedFixture(),root=join(f.base,'.practice/session-lifecycle');
  if(fault==='same')f.put('.practice/swarm-deaths.json',{Rod:{at:100,reason:'done after 1 runs',revision:f.revision}});
  if(fault==='hold'||fault==='qualified-hold')f.put('.practice/swarm-script-holds.json',[{account:'rod',script:'scripts/other.ts',qualified:fault==='qualified-hold'?{at:1}:undefined}]);
  if(fault==='history'||fault==='orphan'){const a=beginSessionAttempt({account:'Rod',server:f.request.server},{root});if(fault==='history')a.record('ended','logged-out');}
  if(fault==='active')f.put('swarm.json',{jobs:[{account:'Rod',script:'scripts/old.ts',enabled:true}]});
  if(fault==='reserved')f.put('swarm.json',{jobs:[{account:'Rod',script:'scripts/old.ts',enabled:false,goal:'fresh clock'}]});
  if(fault==='missing-assignment')f.put('swarm.json',{jobs:[]});
  if(fault==='composed')f.put('swarm.json',{jobs:[{accounts:['Rod'],script:'scripts/old.ts',enabled:false}]});
  if(fault==='authorization')f.put('.practice/coordinator/state.json',{tasks:[]});
  if(fault==='source')f.options.source=()=>runner;
  if(fault==='end')f.put('.practice/swarm-deaths.json',{Rod:{at:101,reason:'done',revision:'old'}});
  if(fault==='unknown')f.put('.practice/status/Rod.json',{server:f.request.server,at:now-100000});
  const ends=readFileSync(join(f.base,'.practice/swarm-deaths.json'),'utf8'),holds=readFileSync(join(f.base,'.practice/swarm-script-holds.json'),'utf8');
  if(fault==='none')expect(()=>issueRecoveryPermit(f.request,f.base,f.options)).not.toThrow();
  else{expect(()=>issueRecoveryPermit(f.request,f.base,f.options),fault).toThrow();expect(existsSync(recoveryPermitPaths(f.request,f.base).lease),fault).toBe(false);}
  expect(readFileSync(join(f.base,'.practice/swarm-deaths.json'),'utf8')).toBe(ends);expect(readFileSync(join(f.base,'.practice/swarm-script-holds.json'),'utf8')).toBe(holds);
 }
});
test('completed permit pins the exact successful end and actual mission through consumption',()=>{
 for(const fault of ['reason','revision','mission','hold','producer','stop']){
  const f=completedFixture();issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,process.pid,f.base,f.options);
  const paths=recoveryPermitPaths(f.request,f.base),lease=readFileSync(paths.lease,'utf8');
  if(fault==='reason'||fault==='revision')f.put('.practice/swarm-deaths.json',{Rod:{at:100,reason:fault==='reason'?'done':'done after 1 runs',revision:fault==='revision'?'changed':'retired-strength20'}});
  if(fault==='mission')f.put('packages/router/tasks/shark-supply-order.json',{id:'shark-supply-order',entry:'scripts/changed.ts'});
  if(fault==='hold')f.put('.practice/swarm-script-holds.json',[{account:'Rod'}]);
  if(fault==='producer')beginSessionAttempt({account:'Rod',server:f.request.server},{root:join(f.base,'.practice/session-lifecycle')}).record('ended','logged-out');
  if(fault==='stop')f.put('.practice/stop-Rod','stop');
  expect(()=>consumeRecoveryConnection(f.request,f.base,f.options),fault).toThrow();
  expect(readFileSync(paths.lease,'utf8')).toBe(lease);expect(existsSync(paths.used)).toBe(false);expect(existsSync(paths.completed)).toBe(false);
 }
});
test('completed cleanup accepts only its fresh consumed producer and releases only the cleanup lease',()=>{
 const f=completedFixture();issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,process.pid,f.base,f.options);const guard=consumeRecoveryPermit(f.request,f.base,f.options);
 const ends=readFileSync(join(f.base,'.practice/swarm-deaths.json'),'utf8'),holds=readFileSync(join(f.base,'.practice/swarm-script-holds.json'),'utf8');
 const root=join(f.base,'.practice/session-lifecycle'),attempt=beginSessionAttempt({account:'Rod',server:f.request.server},{root,now:()=>now+5,
  owner:{pid:process.pid,coordinatorRunId:f.request.runId,workerRelease:source,script:RECOVERY_SCRIPT,role:'recovery',participants:null}});
 expect(()=>guard()).not.toThrow();attempt.record('ended','logged-out');
 const proof=readLogoutProof('Rod',f.request.server,{root});if(proof.state!=='confirmed')throw Error('fixture');
 const before={player:{name:'Rod',x:1,z:2,level:0,hp:43},inventory:[{id:995,count:100}],equipment:[],skills:[],bank:null,modalOpen:false};
 const paths=recoveryPermitPaths(f.request,f.base);
 f.put('.practice/coordinator/session-recovery/accounts/rod/one/output/receipt.json',{state:'confirmed',request:f.request,logout:'logged-out',failure:'',startedAt:now+5,endedAt:now+10,runnerSha256:f.runnerHash,
  before,after:before,attemptId:attempt.attemptId,lifecycleSha256:proof.receiptSha256,scope:{gameplay:false,production:0,repairsFailure:false,qualifiesScript:false}});
 f.options.now=()=>now+20;expect(finishRecoveryPermit(f.request,0,f.base,f.options).proof.state).toBe('confirmed');
 expect(existsSync(paths.lease)).toBe(false);expect(recoveredSessionForRun('Rod',f.request.server,f.request.runId,source,f.base)).toBe(true);
 expect(readFileSync(join(f.base,'.practice/swarm-deaths.json'),'utf8')).toBe(ends);expect(readFileSync(join(f.base,'.practice/swarm-script-holds.json'),'utf8')).toBe(holds);
 const ended=new Map(Object.entries(JSON.parse(ends))) as Map<string,any>;
 expect(applyEndRepair({account:'Rod',endedAt:100,server:f.request.server,proof:{kind:'producer',attemptId:attempt.attemptId}},ended,[],{readProof:()=>proof,verifyLegacy:()=>({state:'refused',reason:'unused'})},[])).toEqual({changed:false,reason:'completed work needs a new mission'});
 expect(JSON.stringify(Object.fromEntries(ended))).toBe(ends);
});
test('a diagnostic file cannot replace missing consumption or a missing producer receipt; original lease stays held',()=>{
 for(const consumed of [false,true]){
  const f=fixture();issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,process.pid,f.base,f.options);
  if(consumed)consumeRecoveryConnection(f.request,f.base,f.options);
  const paths=recoveryPermitPaths(f.request,f.base),lease=readFileSync(paths.lease,'utf8');
  f.put('.practice/coordinator/session-recovery/accounts/rod/one/output/diagnostic.json',recoveryHeldDiagnostic(Error('private')));
  expect(()=>finishRecoveryPermit(f.request,1,f.base,f.options)).toThrow();
  expect(readFileSync(paths.lease,'utf8')).toBe(lease);expect(existsSync(paths.completed)).toBe(false);
  expect(recoveredSessionForRun('Rod',f.request.server,f.request.runId,source,f.base)).toBe(false);
  expect(existsSync(paths.used)).toBe(consumed);expect(existsSync(join(paths.output,'receipt.json'))).toBe(false);
 }
});
test('only the controller may issue one account lease; child consumes one nonce and ordinary launch stays held',()=>{
 const f=fixture(),permit=issueRecoveryPermit(f.request,f.base,f.options);
 expect(permit.runnerSha256).toBe(f.runnerHash);
 expect(()=>issueRecoveryPermit({...f.request,nonce:'two'},f.base,f.options)).toThrow('lease');
 expect(()=>assertNoRecoveryLease('rod',f.base)).toThrow('lease');
 expect(()=>consumeRecoveryPermit(f.request,f.base,f.options)).toThrow('child');
 bindRecoveryChild(f.request,process.pid,f.base,f.options);
 const guard=consumeRecoveryPermit(f.request,f.base,f.options);expect(()=>guard()).not.toThrow();
 expect(()=>consumeRecoveryPermit(f.request,f.base,f.options)).toThrow('consumed');
 expect(existsSync(recoveryPermitPaths(f.request,f.base).used)).toBe(true);
 f.put('.practice/stop-swarm',{stop:true});expect(()=>guard()).toThrow('stopped');
});
test('refusals happen before a lease is issued and keep exact failure bytes',()=>{
 for(const fault of ['controller','task','authorization','end','assignment','stop','qualification','source','protected']){
  const f=fixture(),before=readFileSync(join(f.base,'.practice/swarm-deaths.json'),'utf8');
  if(fault==='controller')f.put('.practice/coordinator/swarm-owner.json',{pid:999,nonce:'other',source});
  if(fault==='task')f.options.matches=(pid:number)=>pid===process.pid;
  if(fault==='authorization')f.put('.practice/coordinator/state.json',{tasks:[]});
  if(fault==='end')f.put('.practice/swarm-deaths.json',{Rod:{at:101,reason:'blocked'}});
  if(fault==='assignment')f.put('swarm.json',{jobs:[{account:'Rod',script:'scripts/live.ts',enabled:true}]});
  if(fault==='stop')f.put('.practice/stop-Rod',{stop:true});
  if(fault==='qualification')f.put('.practice/deliveries/fixture/recovery.json',{ok:true});
  if(fault==='source')f.options.source=()=>runner;
  if(fault==='protected')f.request.account='Haggis';
  const reasons:Record<string,string>={controller:'controller owner changed',task:'task owner changed',authorization:'task authorization missing',end:'exact failure changed',assignment:'assignment is active',stop:'owner stopped',qualification:'qualification changed',source:'source changed',protected:'protected'};
  const retained=readFileSync(join(f.base,'.practice/swarm-deaths.json'),'utf8');expect(()=>issueRecoveryPermit(f.request,f.base,f.options)).toThrow(reasons[fault]);
  expect(readFileSync(join(f.base,'.practice/swarm-deaths.json'),'utf8')).toBe(retained);
  expect(existsSync(recoveryPermitPaths({...f.request,account:'Rod'},f.base).lease)).toBe(false);
 }
});
test('the child guard rechecks task, source, exact end and runner after nonce consumption',()=>{
 for(const fault of ['task','source','end','runner','deadline']){
  const f=fixture();issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,process.pid,f.base,f.options);
  const guard=consumeRecoveryPermit(f.request,f.base,f.options);
  if(fault==='task')f.put('.practice/coordinator/state.json',{tasks:[]});
  if(fault==='source')f.options.source=()=>runner;
  if(fault==='end')f.put('.practice/swarm-deaths.json',{Rod:{at:101,reason:'blocked'}});
  if(fault==='runner')f.put(RECOVERY_SCRIPT,'changed');
  if(fault==='deadline'){f.options.now=()=>now+150001;f.put('.practice/swarm-state.json',{at:now+150001,controllerPid:process.pid,jobs:[]});}
  const reasons:Record<string,string>={task:'task authorization missing',source:'source changed',end:'exact failure changed',runner:'controller-native qualification',deadline:'permit expired or changed'};
  expect(()=>guard()).toThrow(reasons[fault]);
 }
});
test('only this consumed child may own its new partial session during the cleanup guard',()=>{
 const f=fixture();issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,process.pid,f.base,f.options);
 const guard=consumeRecoveryPermit(f.request,f.base,f.options),root=join(f.base,'.practice/session-lifecycle');
 const own={pid:process.pid,coordinatorRunId:f.request.runId,workerRelease:source,script:RECOVERY_SCRIPT,role:'recovery',participants:null};
 beginSessionAttempt({account:'Rod',server:f.request.server},{root,owner:own});expect(()=>guard()).not.toThrow();
 beginSessionAttempt({account:'Rod',server:f.request.server},{root,owner:{...own,coordinatorRunId:'other-run'}});expect(()=>guard()).toThrow('still alive');
});
test('completion indexes only the exact child/producer, releases its lease, and never clears the old failure',()=>{
 for(const fault of ['none','exit','state-loss','source','new-intent','hash']){
  const f=fixture();if(fault==='none')f.request.server='rs-sdk-demo.fly.dev';issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,process.pid,f.base,f.options);consumeRecoveryPermit(f.request,f.base,f.options);
  const root=join(f.base,'.practice/session-lifecycle'),owner={pid:process.pid,coordinatorRunId:f.request.runId,workerRelease:source,script:RECOVERY_SCRIPT,role:'recovery',participants:null};
  const attempt=beginSessionAttempt({account:'Rod',server:f.request.server},{root,owner,now:()=>now+5});attempt.record('ended','logged-out');
  const proof=readLogoutProof('Rod',f.request.server,{root});if(proof.state!=='confirmed')throw Error('fixture');
  const before={player:{name:'Rod',x:1,z:2,level:0,hp:43},inventory:[{id:995,count:100}],equipment:[],skills:[],bank:null,modalOpen:false};
  const receipt:any={state:'confirmed',request:f.request,logout:'logged-out',failure:'',startedAt:now+5,endedAt:now+10,runnerSha256:f.runnerHash,
   before,after:structuredClone(before),attemptId:attempt.attemptId,lifecycleSha256:proof.receiptSha256,scope:{gameplay:false,production:0,repairsFailure:false,qualifiesScript:false}};
  if(fault==='state-loss')receipt.after.inventory=[];
  if(fault==='source')receipt.request={...f.request,source:'c'.repeat(64)};
  if(fault==='new-intent')beginSessionAttempt({account:'Rod',server:f.request.server},{root,owner,now:()=>now+6}).record('ended','logged-out');
  if(fault==='hash')receipt.lifecycleSha256='c'.repeat(64);
  f.put('.practice/coordinator/session-recovery/accounts/rod/one/output/receipt.json',receipt);f.options.now=()=>now+20;
  if(fault==='none'){f.options.now=()=>now+125000;f.put('.practice/swarm-state.json',{at:now+125000,controllerPid:process.pid,jobs:[]});}
  const ends=readFileSync(join(f.base,'.practice/swarm-deaths.json'),'utf8');
  if(fault==='none'){expect(finishRecoveryPermit(f.request,0,f.base,f.options).proof.state).toBe('confirmed');expect(()=>assertNoRecoveryLease('Rod',f.base)).not.toThrow();expect(recoveredSessionForRun('Rod',f.request.server,f.request.runId,source,f.base)).toBe(true);}
  else{expect(()=>finishRecoveryPermit(f.request,fault==='exit'?1:0,f.base,f.options)).toThrow(['hash','new-intent'].includes(fault)?'producer result superseded or crossed':'child did not confirm');expect(()=>assertNoRecoveryLease('Rod',f.base)).toThrow('lease');}
  expect(readFileSync(join(f.base,'.practice/swarm-deaths.json'),'utf8')).toBe(ends);
  if(fault==='none'){
   // This is a filesystem/producer integration fixture, not a network or native qualification.
   // An old status without RESULT must be covered by the exact indexed recovery before the old end clears.
   f.put('.practice/status/Rod.json',{name:'Rod',server:f.request.server,started:1,at:1,result:''});
   const task:any={id:'pilot',goal:'gear',kind:'run',capability:'shark-supply-order',account:'Rod',sessionRecovery:{account:'Rod',endedAt:100},repairs:[{account:'Rod',endedAt:100}]};
   expect(()=>installJob(task,'Rod','scripts/new.ts',f.request.runId,source,{}, {base:f.base,preflight:true})).not.toThrow();
   const ended=new Map(Object.entries(JSON.parse(ends))) as Map<string,any>,holds:ScriptHold[]=[];
   const repaired=applyEndRepair({account:'Rod',endedAt:100,server:f.request.server,proof:{kind:'producer',attemptId:attempt.attemptId}},ended,[],{
    readProof:(a,s)=>readLogoutProof(a,s,{root}),verifyLegacy:()=>({state:'refused',reason:'not used'})},holds);
   expect(repaired.changed).toBe(true);expect(holds).toEqual([]);
   f.put('.practice/swarm-deaths.json',Object.fromEntries(ended));f.put('.practice/swarm-script-holds.json',holds);
   expect(()=>installJob(task,'Rod','scripts/new.ts',f.request.runId,source,{}, {base:f.base})).not.toThrow();
   expect(JSON.parse(readFileSync(join(f.base,'swarm.json'),'utf8')).jobs[0].enabled).toBe(true);
  }
 }
});
test('native qualification needs per-check observed cases and unchanged raw evidence, not true flags',()=>{
 const f=fixture(),dir=join(f.base,'.practice/deliveries/fixture'),proof=()=>JSON.parse(readFileSync(join(dir,'recovery.json'),'utf8'));
 const expected={runtimeRevision:source,runnerSha256:f.runnerHash};
 expect(verifyNativeRecoveryProof(proof(),dir,expected)).toBe(true);
 const flags=proof();flags.checks=Object.fromEntries(NATIVE_RECOVERY_CHECKS.map(k=>[k,true]));expect(()=>verifyNativeRecoveryProof(flags,dir,expected)).toThrow('offline');
 const unit=proof();unit.checks.stock.level='unit';expect(()=>verifyNativeRecoveryProof(unit,dir,expected)).toThrow('stock');
 const missing=proof();missing.checks.cooldown.cases=['absent'];expect(()=>verifyNativeRecoveryProof(missing,dir,expected)).toThrow('cooldown case');
 const failed=proof();failed.cases[0].ok=false;expect(()=>verifyNativeRecoveryProof(failed,dir,expected)).toThrow('case unit');
 const escape=proof();escape.checks.stop.evidence=[{path:'../report.json',sha256:'0'.repeat(64)}];expect(()=>verifyNativeRecoveryProof(escape,dir,expected)).toThrow('evidence reference');
 expect(()=>verifyNativeRecoveryProof(proof(),dir,{...expected,runnerSha256:runner})).toThrow('report');
 writeFileSync(join(dir,'cases/raw.log'),'changed');expect(()=>verifyNativeRecoveryProof(proof(),dir,expected)).toThrow('evidence changed');
});
test('one consumed permit yields one connection admission; forged, reused or crossed admissions refuse',()=>{
 const f=fixture();f.request.server='rs-sdk-demo.fly.dev';issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,process.pid,f.base,f.options);
 const {admission,guard}=consumeRecoveryConnection(f.request,f.base,f.options);
 expect(()=>spendRecoveryConnection({nonce:f.request.nonce},f.request)).toThrow('admission invalid');
 expect(()=>spendRecoveryConnection(admission,{...f.request,nonce:'two'})).toThrow('admission invalid');
 expect(()=>spendRecoveryConnection(admission,f.request)).not.toThrow();
 expect(()=>spendRecoveryConnection(admission,f.request)).toThrow('admission invalid');
 expect(()=>guard()).not.toThrow();expect(()=>consumeRecoveryConnection(f.request,f.base,f.options)).toThrow('consumed');
});
test('remote launcher refuses before publishing a permit or account lease',()=>{
 const f=fixture();f.request.server='rs-sdk-demo.fly.dev';
 expect(()=>launchPermittedRecovery(f.request,f.base,f.options)).toThrow('no lease issued');
 expect(()=>launchPermittedRecovery(f.request,f.base,{...f.options,nativeFixture:true})).toThrow('no lease issued');
 expect(existsSync(recoveryPermitPaths(f.request,f.base).lease)).toBe(false);expect(existsSync(recoveryPermitPaths(f.request,f.base).permit)).toBe(false);
});
test('connect admission expires at the binding window while an already consumed guard retains150second cleanup time',()=>{
 const f=fixture();issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,process.pid,f.base,f.options);
 const guard=consumeRecoveryPermit(f.request,f.base,f.options);f.options.now=()=>now+125000;f.put('.practice/swarm-state.json',{at:now+125000,controllerPid:process.pid,jobs:[]});
 expect(()=>guard()).not.toThrow();
 const late=fixture();issueRecoveryPermit(late.request,late.base,late.options);bindRecoveryChild(late.request,process.pid,late.base,late.options);late.options.now=()=>now+RECOVERY_BINDING_MS+1;
 late.put('.practice/swarm-state.json',{at:now+RECOVERY_BINDING_MS+1,controllerPid:process.pid,jobs:[]});expect(()=>consumeRecoveryPermit(late.request,late.base,late.options)).toThrow('admission expired');
});
test('a heartbeat published during the slow owner and source checks admits the valid child exactly once',()=>{
 // Observed native refusal (child43504): about1.2s of process and source checks ran between the clock read and the
 // fleet read while another process rewrote the fleet every second, so the fleet looked newer than the clock.
 const f=fixture();let clock=now;
 f.options.now=()=>clock;
 f.options.matches=()=>{clock+=600;f.put('.practice/swarm-state.json',{at:clock,controllerPid:process.pid,jobs:[{account:'Rod',state:'disabled'}]});return true;};
 issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,process.pid,f.base,f.options);
 const {guard}=consumeRecoveryConnection(f.request,f.base,f.options);expect(()=>guard()).not.toThrow();
 expect(()=>consumeRecoveryConnection(f.request,f.base,f.options)).toThrow('consumed');
 const paths=recoveryPermitPaths(f.request,f.base);expect(existsSync(paths.lease)).toBe(true);expect(existsSync(join(paths.output,'receipt.json'))).toBe(false);
});
const fleetFaults:Record<string,[string,(f:ReturnType<typeof fixture>)=>void]>={
 missing:['missing',f=>rmSync(join(f.base,'.practice/swarm-state.json'))],
 torn:['malformed',f=>writeFileSync(join(f.base,'.practice/swarm-state.json'),'{"at":17932')],
 empty:['malformed',f=>writeFileSync(join(f.base,'.practice/swarm-state.json'),'')],
 nullFleet:['malformed',f=>f.put('.practice/swarm-state.json',null)],
 noJobs:['malformed',f=>f.put('.practice/swarm-state.json',{at:now,controllerPid:process.pid})],
 badRow:['malformed',f=>f.put('.practice/swarm-state.json',{at:now,controllerPid:process.pid,jobs:[null]})],
 noTime:['malformed',f=>f.put('.practice/swarm-state.json',{at:'now',controllerPid:process.pid,jobs:[]})],
 crossed:['controller',f=>f.put('.practice/swarm-state.json',{at:now,controllerPid:process.pid+1,jobs:[]})],
 future:['future',f=>f.put('.practice/swarm-state.json',{at:now+1,controllerPid:process.pid,jobs:[]})],
 stale:['stale',f=>f.put('.practice/swarm-state.json',{at:now-FLEET_HEARTBEAT_MAX_MS-1,controllerPid:process.pid,jobs:[]})],
 running:['account-active',f=>f.put('.practice/swarm-state.json',{at:now,controllerPid:process.pid,jobs:[{account:'rod',state:'running'}]})],
 composed:['account-active',f=>f.put('.practice/swarm-state.json',{at:now,controllerPid:process.pid,jobs:[{account:'Ann+Rod',accounts:['Ann','Rod'],state:'starting'}]})],
};
test('missing, malformed, crossed, future, stale or active fleet state refuses issuance without a lease',()=>{
 for(const [name,[field,apply]] of Object.entries(fleetFaults)){
  const f=fixture();apply(f);
  expect(()=>issueRecoveryPermit(f.request,f.base,f.options),name).toThrow('recovery fleet ownership unresolved: '+field);
  expect(existsSync(recoveryPermitPaths(f.request,f.base).lease),name).toBe(false);expect(existsSync(recoveryPermitPaths(f.request,f.base).permit),name).toBe(false);
 }
 const edge=fixture();edge.put('.practice/swarm-state.json',{at:now-10000,controllerPid:process.pid,jobs:[{account:'Rod',state:'waiting: maxBots'}]});
 expect(()=>issueRecoveryPermit(edge.request,edge.base,edge.options)).not.toThrow();
});
test('fleet state replaced between issuance and consumption holds the lease with no nonce, receipt or connection',async()=>{
 for(const [name,[field,apply]] of Object.entries(fleetFaults)){
  const f=fixture();issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,process.pid,f.base,f.options);
  const paths=recoveryPermitPaths(f.request,f.base),lease=readFileSync(paths.lease,'utf8'),ends=readFileSync(join(f.base,'.practice/swarm-deaths.json'),'utf8');
  apply(f);
  let error:unknown;try{await recoveryBoundary('permit-consumption',()=>consumeRecoveryConnection(f.request,f.base,f.options));}catch(e){error=e;}
  const held=recoveryHeldDiagnostic(error);
  expect(held,name).toEqual({schema:'session-recovery-diagnostic/1',state:'held',phase:'permit-consumption',reason:'fleet-'+field,authorizesConnection:false,producerReceipt:false});
  expect(recoveryDiagnosticFromLog('RECOVERY_HELD '+JSON.stringify(held)),name).toEqual({phase:'permit-consumption',reason:'fleet-'+field});
  expect(existsSync(paths.used),name).toBe(false);expect(readFileSync(paths.lease,'utf8')).toBe(lease);
  expect(existsSync(join(paths.output,'receipt.json'))).toBe(false);expect(existsSync(paths.completed)).toBe(false);
  expect(readFileSync(join(f.base,'.practice/swarm-deaths.json'),'utf8')).toBe(ends);
  expect(()=>finishRecoveryPermit(f.request,1,f.base,f.options)).toThrow();expect(readFileSync(paths.lease,'utf8')).toBe(lease);
 }
});
test('an earlier retained fleet-unresolved diagnostic still parses',()=>{
 expect(recoveryDiagnosticFromLog('RECOVERY_HELD {"schema":"session-recovery-diagnostic/1","state":"held","phase":"permit-consumption","reason":"fleet-unresolved","authorizesConnection":false,"producerReceipt":false}'))
  .toEqual({phase:'permit-consumption',reason:'fleet-unresolved'});
});
test('restart counts inherited children without replay, ignores dead children, and retains every lease',()=>{
 const f=fixture();issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,1234,f.base,f.options);
 expect(heldRecoveryOwners(f.base,[],pid=>pid===1234,now)).toEqual([{account:'Rod',pid:1234,started:now,source}]);
 expect(heldRecoveryOwners(f.base,['rod'],()=>true,now)).toEqual([]);
 expect(heldRecoveryOwners(f.base,[],()=>false,now)).toEqual([]);
 expect(()=>assertNoRecoveryLease('Rod',f.base)).toThrow('lease');expect(existsSync(recoveryPermitPaths(f.request,f.base).used)).toBe(false);
});

test('authenticated cleanup admits a stopped end and still honours owner stops and exact end identity',()=>{
 for(const fault of ['none','stop','changed-end','active-assignment']){
  const f=fixture();
  f.put('.practice/swarm-deaths.json',{Rod:{at:fault==='changed-end'?101:100,reason:'stopped after 1 runs',revision:'retired-mission'}});
  if(fault==='stop')f.put('.practice/stop-Rod','owner pause');
  if(fault==='active-assignment')f.put('swarm.json',{jobs:[{account:'Rod',script:'scripts/old.ts',enabled:true}]});
  const before=readFileSync(join(f.base,'.practice/swarm-deaths.json'),'utf8');
  if(fault==='none')expect(()=>issueRecoveryPermit(f.request,f.base,f.options)).not.toThrow();
  else expect(()=>issueRecoveryPermit(f.request,f.base,f.options)).toThrow(fault==='stop'?'owner stopped':fault==='changed-end'?'exact failure changed':'assignment is active');
  expect(readFileSync(join(f.base,'.practice/swarm-deaths.json'),'utf8')).toBe(before);
 }
});
