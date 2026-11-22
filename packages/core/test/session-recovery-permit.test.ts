import {test,expect,spyOn} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,statSync} from 'node:fs';
import {join,dirname,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import * as childProcess from 'node:child_process';
import {hostname} from 'node:os';
import {acquireFleetSwarmClaim,readFleetAccountClaim} from '../src/fleet-trade-claim';
import {fleetCheckoutId,fleetGitWindow,commitFleetGitRecord,pushFleetGitRecord,acquireFleetLease,FLEET_LEASE_TTL_MS} from '../src/fleet-lease';
import {FLEET_HEARTBEAT_MAX_MS,RECOVERY_BINDING_MS,RECOVERY_SCRIPT,issueRecoveryPermit,bindRecoveryChild,consumeRecoveryPermit,consumeRecoveryConnection,spendRecoveryConnection,assertNoRecoveryLease,recoveryPermitPaths,finishRecoveryPermit,launchPermittedRecovery,launchObservations,recoveredSessionForRun,heldRecoveryOwners,cachedProcessStarts,releaseExpiredRecoveryLease,releaseExpiredRecoveryLeases,assertRecoveryNotStopped,verifyNativeRecoveryProof,NATIVE_RECOVERY_CHECKS} from '../src/session-recovery-permit';
import {beginSessionAttempt,readLogoutProof,listAttempts,accountDir,lifecycleOwner} from '../src/session-lifecycle';
import {applyEndRepair,type ScriptHold} from '../../../scripts/swarm';
import {recoveryHeldDiagnostic,recoveryBoundary,recoveryDiagnosticFromLog} from '../src/session-recovery';
import {missionSignature,liveLogoutRef} from '../src/session-admission';
import {budgetRefusal,MAX_WAITS,spentAttempts,waitedAttempts,retainedRecoveryTasks} from '../../../scripts/cloud-recover';
import * as recoveryProcesses from '../src/proc';
const source='a'.repeat(64),runner='b'.repeat(64),now=1793258000000;
import {useScratch} from './recovery-scratch';
const scratch=useScratch();
if(process.env.HOST_RECOVERY_FIXTURE==='1')test('qualified cross-host fixture body',async()=>{
 const f=fixture(),git=(...args:string[])=>execFileSync('git',args,{cwd:f.base,encoding:'utf8',stdio:'pipe',windowsHide:true}).trim();
 const started=performance.now();let fixtureGitCalls=0,fixtureGitMs=0;
 try{
  const remote=join(f.base,'private-origin.git');git('init','--bare',remote);git('init');git('remote','add','origin',remote);
  // The matrix performs independent Git operations; do not share a spent authority
  // deadline across the whole Windows fixture. Production admission budgets stay unchanged.
  const authority=(args:string[],input?:string)=>{const at=performance.now();fixtureGitCalls++;try{return fleetGitWindow(f.base)(args,input);}finally{fixtureGitMs+=performance.now()-at;}},tree=authority(['hash-object','-w','-t','tree','--stdin'],'');
  const append=(ref:string,body:unknown)=>{const prior=authority(['ls-remote','--refs','origin',ref]).split(/\s/)[0]||undefined;const head=commitFleetGitRecord(authority,prior,tree,(ref.includes('fleet-trade-claim/')?'Fixture claim\n\n':'')+JSON.stringify(body));pushFleetGitRecord(authority,ref,head);return head;};
  const nonce=randomUUID(),old=beginSessionAttempt({account:'Rod',server:'rs-sdk-demo.fly.dev',secret:'unit-fixture'}, {root:join(f.base,'.practice/session-lifecycle'),owner:{...lifecycleOwner(),pid:process.pid,sharedClaimNonce:nonce},now:Date.now});
  old.record('connect-failed','unit fixture; no network');
  const receipt=listAttempts('Rod','rs-sdk-demo.fly.dev',{root:join(f.base,'.practice/session-lifecycle')}).find(a=>a.attemptId===old.attemptId)!.receipt!,at=receipt.createdAt;
  let clock=at+2*FLEET_LEASE_TTL_MS;
  const claim={kind:'swarm',account:'rod',server:'rs-sdk-demo.fly.dev',side:'cloud',checkout:fleetCheckoutId(f.base),host:'previous-runtime',pid:process.pid,nonce,phase:'held',at:at-1};
  append('refs/heads/fleet-trade-claim/rod',claim);
  const oldLease={side:'cloud',host:claim.host,holder:claim.checkout,epoch:randomUUID(),pid:process.pid,at:at-1};append('refs/heads/fleet-lease/cloud',oldLease);
  const lease=acquireFleetLease(f.base,'cloud',()=>clock);expect(lease.allows()).toBe(true);
  f.request.server=claim.server;f.request.endedAt=receipt.updatedAt+5;
  const recoveryPath='.practice/live/fleet-runs/task-run/recovery.json';
  const rec=JSON.parse(readFileSync(join(f.base,recoveryPath),'utf8'));rec.spec.repairs[0].endedAt=f.request.endedAt;rec.spec.sessionRecovery.endedAt=f.request.endedAt;f.put(recoveryPath,rec);
  f.put('.practice/swarm-deaths.json',{Rod:{at:f.request.endedAt,reason:'blocked'}});f.put('.practice/swarm-state.json',{at:clock,controllerPid:process.pid,jobs:[{account:'Rod',state:'disabled'}]});
  const reportPath=join(f.base,'.practice/deliveries/fixture/report.json'),report=JSON.parse(readFileSync(reportPath,'utf8'));report.at=clock-1;writeFileSync(reportPath,JSON.stringify(report));f.request.qualification.delivery.sha256=createHash('sha256').update(readFileSync(reportPath)).digest('hex');
  const options={...f.options,now:()=>clock,pidAlive:()=>false};
  if(process.env.HOST_RECOVERY_MODE==='interrupted'){
   const target={account:'Rod',server:claim.server,side:'cloud'},ref='refs/heads/fleet-trade-claim/rod';
   const body=()=>authority(['show','-s','--format=%b',authority(['ls-remote','--refs','origin',ref]).split(/\s/)[0]!]);
   const original=body(),pointer=join(accountDir('Rod',claim.server,join(f.base,'.practice/session-lifecycle')),'latest.json'),latest=readFileSync(pointer);
   const input=join(f.base,'interrupted-input.json');
   const code=`import {readFileSync,existsSync} from 'node:fs';
    import {consumeRecoveryConnection,spendRecoveryConnection,recoveryPermitPaths} from ${JSON.stringify(resolve(import.meta.dir,'../src/session-recovery-permit.ts'))};
    import {acquireFleetSwarmClaim} from ${JSON.stringify(resolve(import.meta.dir,'../src/fleet-trade-claim.ts'))};
    const {request,base,clock,source}=JSON.parse(readFileSync(process.argv[1],'utf8'));
    const deadline=Date.now()+5000;
    while(!existsSync(recoveryPermitPaths(request,base).child)){if(Date.now()>deadline)throw Error('fixture child binding timed out');await Bun.sleep(10);}
    const options={now:()=>clock,pidAlive:()=>false,matches:()=>true,source:()=>source,capability:()=>source};
    const {admission}=consumeRecoveryConnection(request,base,options);spendRecoveryConnection(admission,request);
    acquireFleetSwarmClaim(base,{account:request.account,server:request.server,side:'cloud'},{recover:true,admission,now:()=>clock});
    process.exit(0);`;
   let interrupted:NonNullable<ReturnType<typeof readFleetAccountClaim>>|undefined,childPid=0;
   for(const nonce of ['one','two']){
    f.request.nonce=nonce;f.put('.practice/swarm-repair.json.lease',{pid:10,runId:'task-run',nonce});
    issueRecoveryPermit(f.request,f.base,options);writeFileSync(input,JSON.stringify({request:f.request,base:f.base,clock,source}));
    const child=Bun.spawn([process.execPath,'-e',code,input],{cwd:f.base,stdout:'pipe',stderr:'pipe',windowsHide:true});
    bindRecoveryChild(f.request,child.pid,f.base,options);
    const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect({exit,output:out+err}).toEqual({exit:0,output:''});
    const prior=interrupted;interrupted=readFleetAccountClaim(f.base,target)!;childPid=child.pid;
    expect(interrupted.host).toBe(hostname());expect(interrupted.pid).toBe(child.pid);expect(interrupted.nonce).not.toBe(prior?.nonce??claim.nonce);
    expect(readFileSync(pointer)).toEqual(latest);
    expect(()=>acquireFleetSwarmClaim(f.base,target,{recover:true,now:()=>clock,ownerAlive:()=>false})).toThrow();
    clock+=150001;f.put('.practice/swarm-state.json',{at:clock,controllerPid:process.pid,jobs:[{account:'Rod',state:'disabled'}]});
    expect(releaseExpiredRecoveryLease('Rod',f.base,{now:()=>clock,matches:()=>true}).basis).toBe('not-connected');
   }
   f.request.nonce='three';f.put('.practice/swarm-repair.json.lease',{pid:10,runId:'task-run',nonce:'three'});
   issueRecoveryPermit(f.request,f.base,options);bindRecoveryChild(f.request,process.pid,f.base,options);
   const {admission}=consumeRecoveryConnection(f.request,f.base,options);spendRecoveryConnection(admission,f.request);
   const markerPath=join(f.base,'.practice/fleet-account-pending',interrupted!.nonce+'.json'),markerRaw=readFileSync(markerPath),marker=JSON.parse(markerRaw.toString());
   const retry=()=>acquireFleetSwarmClaim(f.base,target,{recover:true,admission,now:()=>clock,ownerAlive:()=>{throw Error('remote PID is not local death proof');}});
   const unrelated=commitFleetGitRecord(authority,undefined,tree,'Unrelated witness\n\n'+JSON.stringify(claim));
   for(const changed of [{...marker,inherited:{...marker.inherited,nonce:randomUUID()}},{...marker,claim:'{}'},{...marker,inheritedHead:'0'.repeat(40)},{...marker,inheritedHead:unrelated}]){
    writeFileSync(markerPath,JSON.stringify(changed));const unchanged=body();expect(retry).toThrow();expect(body()).toBe(unchanged);writeFileSync(markerPath,markerRaw);
   }
   const intent=beginSessionAttempt({account:'Rod',server:claim.server,secret:'unit-fixture'},{root:join(f.base,'.practice/session-lifecycle'),owner:{...lifecycleOwner(),pid:childPid,sharedClaimNonce:interrupted!.nonce},now:()=>clock});
   writeFileSync(pointer,latest);expect(retry).toThrow();rmSync(join(dirname(pointer),'attempts',intent.attemptId+'.json'));expect(readFileSync(pointer)).toEqual(latest);
   const recovered=retry();
   recovered.abortBeforeNetwork();expect(body()).toBe(original);expect(readFileSync(pointer)).toEqual(latest);
   console.log('QUALIFIED_HOST_INTERRUPTED_PASS two real child exits after push, durable original Git witness, ordinary refusal, supported expired lease retirement, qualified retry, exact inherited hold restored');return;
  }
  issueRecoveryPermit(f.request,f.base,options);bindRecoveryChild(f.request,process.pid,f.base,options);
  const {admission}=consumeRecoveryConnection(f.request,f.base,options);spendRecoveryConnection(admission,f.request);
  const mode=process.env.HOST_RECOVERY_MODE??'';
  const recovery={recover:true,admission,now:()=>clock,ownerAlive:()=>{throw Error('must not inspect a remote PID on the new host');}};
  const target={account:'Rod',server:claim.server,side:'cloud'},claimRef='refs/heads/fleet-trade-claim/rod',leaseRef='refs/heads/fleet-lease/cloud';
  const body=(ref:string)=>authority(['show','-s',ref===claimRef?'--format=%b':'--format=%B',authority(['ls-remote','--refs','origin',ref]).split(/\s/)[0]!]);
  const pointer=join(accountDir('Rod',claim.server,join(f.base,'.practice/session-lifecycle')),'latest.json');
  const originalPointer=readFileSync(pointer);
  const deny=(action:()=>unknown)=>{const heldBody=body(claimRef),latest=readFileSync(pointer);expect(action).toThrow();expect(body(claimRef)).toBe(heldBody);expect(readFileSync(pointer)).toEqual(latest);};
  if(mode==='admission'){
  deny(()=>acquireFleetSwarmClaim(f.base,target,{recover:true,now:()=>clock,ownerAlive:()=>false}));
  deny(()=>acquireFleetSwarmClaim(f.base,target,{...recovery,admission:{nonce:admission.nonce}}));
  deny(()=>acquireFleetSwarmClaim(f.base,{...target,account:'Other'},recovery));
  deny(()=>acquireFleetSwarmClaim(f.base,{...target,server:'other.example'},recovery));
  deny(()=>acquireFleetSwarmClaim(f.base,{...target,side:'local'},recovery));
  deny(()=>acquireFleetSwarmClaim(remote,target,recovery));
  }
  if(mode==='identity')for(const change of [{checkout:randomUUID()},{side:'local'},{nonce:randomUUID()},{pid:claim.pid+1}]){
   append(claimRef,{...claim,...change});deny(()=>acquireFleetSwarmClaim(f.base,target,recovery));append(claimRef,claim);
  }
  if(mode==='provenance'){
  for(const change of [{host:'unknown-runtime'},{kind:undefined,orderId:'held-order',role:'from'}]){
   append(claimRef,{...claim,...change});deny(()=>acquireFleetSwarmClaim(f.base,target,recovery));append(claimRef,claim);
  }
  const newer=beginSessionAttempt({account:'Rod',server:claim.server,secret:'unit-fixture'},{root:join(f.base,'.practice/session-lifecycle'),now:()=>clock,owner:{...lifecycleOwner(),pid:claim.pid,sharedClaimNonce:claim.nonce}});
  deny(()=>acquireFleetSwarmClaim(f.base,target,recovery));writeFileSync(pointer,originalPointer);rmSync(join(dirname(pointer),'attempts',newer.attemptId+'.json'));
  const oldReceipt=join(dirname(pointer),'attempts',old.attemptId+'.json'),originalReceipt=readFileSync(oldReceipt),changed=JSON.parse(originalReceipt.toString());changed.owner.pid++;writeFileSync(oldReceipt,JSON.stringify(changed));
  deny(()=>acquireFleetSwarmClaim(f.base,target,recovery));writeFileSync(oldReceipt,originalReceipt);
  }
  if(mode==='lease'){
  const currentLease=JSON.parse(body(leaseRef)),fence=join(f.base,'.practice/fleet-controller-fence.json'),originalFence=readFileSync(fence);
  writeFileSync(fence,JSON.stringify({holder:'cloud:'+randomUUID(),until:clock+10000}));deny(()=>acquireFleetSwarmClaim(f.base,target,recovery));writeFileSync(fence,originalFence);
  append(leaseRef,{...currentLease,at:clock-FLEET_LEASE_TTL_MS-1});deny(()=>acquireFleetSwarmClaim(f.base,target,recovery));append(leaseRef,currentLease);
  append(leaseRef,{...currentLease,epoch:oldLease.epoch});writeFileSync(fence,JSON.stringify({...JSON.parse(originalFence.toString()),holder:'cloud:'+oldLease.epoch}));deny(()=>acquireFleetSwarmClaim(f.base,target,recovery));append(leaseRef,currentLease);writeFileSync(fence,originalFence);
  clock+=150001;f.put('.practice/swarm-state.json',{at:clock,controllerPid:process.pid,jobs:[{account:'Rod',state:'disabled'}]});deny(()=>acquireFleetSwarmClaim(f.base,target,recovery));clock-=150001;f.put('.practice/swarm-state.json',{at:clock,controllerPid:process.pid,jobs:[{account:'Rod',state:'disabled'}]});
  append(leaseRef,{...oldLease,at:clock-1});append(leaseRef,currentLease);deny(()=>acquireFleetSwarmClaim(f.base,target,recovery));
  }
  if(mode==='lifecycle'){
  const before=body(claimRef),held=acquireFleetSwarmClaim(f.base,target,recovery);
  expect(held.nonce).not.toBe(claim.nonce);expect(readFleetAccountClaim(f.base,target)?.host).toBe(hostname());
  held.abortBeforeNetwork();expect(body(claimRef)).toBe(before);
  const completed=acquireFleetSwarmClaim(f.base,target,recovery);expect(()=>completed.releaseAfterLogout(old.attemptId)).toThrow('exact logout');completed.armNetwork();
  const next=beginSessionAttempt({account:'Rod',server:claim.server,secret:'unit-fixture'},{root:join(f.base,'.practice/session-lifecycle'),now:()=>clock,owner:{...lifecycleOwner(),pid:process.pid,sharedClaimNonce:completed.nonce}});
  next.record('ready');next.record('ended','logged-out');completed.releaseAfterLogout(next.attemptId);expect(readFleetAccountClaim(f.base,target)?.phase).toBe('released');
  writeFileSync(pointer,originalPointer);rmSync(join(dirname(pointer),'attempts',next.attemptId+'.json'));append(claimRef,claim);
  const native=childProcess.execFileSync,competing={...claim,nonce:randomUUID()};let raced=false;
  const race=spyOn(childProcess,'execFileSync').mockImplementation(((file:any,args:any,options:any)=>{
   if(!raced&&file==='git'&&args?.includes('push')&&args.some((a:string)=>a.endsWith(':'+claimRef))){raced=true;append(claimRef,competing);}
   return native(file,args,options);
  }) as any);
  try{expect(()=>acquireFleetSwarmClaim(f.base,target,recovery)).toThrow();expect(raced).toBe(true);}finally{race.mockRestore();}
  expect(readFleetAccountClaim(f.base,target)?.nonce).toBe(competing.nonce);append(claimRef,claim);
  }
  expect(['admission','identity','provenance','lease','lifecycle']).toContain(mode);
  console.log('QUALIFIED_HOST_FIXTURE_PASS '+mode);
 }finally{if(process.env.HOST_RECOVERY_PROFILE==='1')console.log('HOST_RECOVERY_PROFILE '+JSON.stringify({mode:process.env.HOST_RECOVERY_MODE,fixtureGitCalls,fixtureGitMs,wallMs:performance.now()-started}));rmSync(f.base,{recursive:true,force:true});}
},30000);
else for(const mode of ['admission','identity','provenance','lease','lifecycle','interrupted'])test('qualified cross-host recovery '+mode,async()=>{
 const child=Bun.spawn([process.execPath,'test',import.meta.path,'--test-name-pattern','^qualified cross-host fixture body$'],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,HOST_RECOVERY_FIXTURE:'1',HOST_RECOVERY_MODE:mode,FLEET_SIDE:'cloud'},stdout:'pipe',stderr:'pipe',windowsHide:true});
 const timer=setTimeout(()=>child.kill(),30000);
 try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect({code,output:code?out+err:''}).toEqual({code:0,output:''});if(code===0)console.log(out.trim());}finally{clearTimeout(timer);}
},30000);
test('the controller launches the core recovery worker inside the gameplay ownership scope',()=>{
 expect(RECOVERY_SCRIPT).toBe('packages/core/src/session-recovery.ts');
});
test('private fixtures honour every repository and fixture stop flag',()=>{
 const base=scratch('recovery-stop-'),repo=resolve(import.meta.dir,'../../..');
 for(const root of [base,repo])for(const flag of ['stop-coordinator','stop-swarm','stop-Rod']){
  const stopped=join(root,'.practice',flag),observed:string[]=[];
  expect(()=>assertRecoveryNotStopped('Rod',base,path=>{observed.push(path);return path===stopped;})).toThrow('owner stopped');
  expect(observed).toContain(stopped);
 }
 expect(()=>assertRecoveryNotStopped('Rod',base,()=>false)).not.toThrow();
});
function fixture(){
 const base=scratch('recovery-permit-');
 const put=(path:string,value:any)=>{mkdirSync(dirname(join(base,path)),{recursive:true});writeFileSync(join(base,path),JSON.stringify(value));};
 const ref=(path:string)=>({path,sha256:createHash('sha256').update(readFileSync(join(base,path))).digest('hex')});
 put(RECOVERY_SCRIPT,'fixture runner');
 const runnerHash=createHash('sha256').update(readFileSync(join(base,RECOVERY_SCRIPT))).digest('hex');
 put('.practice/live/swarm-owner.json',{pid:process.pid,nonce:'controller',source});
 put('.practice/live/fleet-runs/task-run/recovery.json',{status:'running',runId:'task-run',pid:10,spec:{kind:'run',capability:'shark-supply-order',script:'scripts/new.ts',account:'Rod',sessionRecovery:{account:'Rod',endedAt:100},repairs:[{account:'Rod',endedAt:100}]}});
 put('.practice/live/fleet-runs/task-run/owner.json',{pid:10,runId:'task-run'});
 put('.practice/swarm-repair.json.lease',{pid:10,runId:'task-run',nonce:'one'});
 put('.practice/swarm-deaths.json',{Rod:{at:100,reason:'blocked',revision:JSON.stringify(['scripts/old.ts',false,['rod'],[]])}});
 put('swarm.json',{maxBots:17,minFreeGB:0,jobs:[{account:'Rod',script:'scripts/old.ts',enabled:false}]});
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
 const options={now:()=>now,matches:(_pid:number,_marker:string)=>true,source:()=>source,capability:(c:unknown)=>c==='shark-supply-order'?source:undefined};
 return {base,put,request,options,runnerHash};
}

function completedFixture(){
 const f=fixture();
 const rec=JSON.parse(readFileSync(join(f.base,'.practice/live/fleet-runs/task-run/recovery.json'),'utf8'));
 rec.spec.env={TRAIN_SKILL:'Attack',TARGET_LEVEL:'20'};
 f.put('.practice/live/fleet-runs/task-run/recovery.json',rec);
 const revision=missionSignature({account:'Rod',script:'scripts/new.ts',env:{...rec.spec.env,CAP:'1600',FLEET_RUN_ID:f.request.runId}});
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
  if(fault==='authorization')f.put('.practice/live/fleet-runs/task-run/recovery.json',{tasks:[]});
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
  if(fault==='mission'){const rPath='.practice/live/fleet-runs/task-run/recovery.json';const rec=JSON.parse(readFileSync(join(f.base,rPath),'utf8'));rec.spec.script='scripts/changed.ts';f.put(rPath,rec);}
  if(fault==='hold')f.put('.practice/swarm-script-holds.json',[{account:'Rod'}]);
  if(fault==='producer')beginSessionAttempt({account:'Rod',server:f.request.server},{root:join(f.base,'.practice/session-lifecycle')}).record('ended','logged-out');
  if(fault==='stop')f.put('.practice/stop-Rod','stop');
  expect(()=>consumeRecoveryConnection(f.request,f.base,f.options),fault).toThrow();
  expect(readFileSync(paths.lease,'utf8')).toBe(lease);expect(existsSync(paths.used)).toBe(false);expect(existsSync(paths.completed)).toBe(false);
 }
});
test('completed cleanup retains a ready disconnected live producer and binds only its fresh recovery child',()=>{
 for(const history of [false,true]){
 const f=completedFixture();f.request.server='rs-sdk-demo.fly.dev';
 const root=join(f.base,'.practice/session-lifecycle'),dir=accountDir('Rod',f.request.server,root),id='0000000000010-2147483647-0000000001';
 if(history){
  f.put(relative(f.base,join(dir,'attempts',id+'.json')),{schema:'session-lifecycle/1',attemptId:id,account:'Rod',server:f.request.server,domain:'live',
   owner:{pid:2147483647,coordinatorRunId:null,workerRelease:runner,script:'scripts/goldfarm.ts',role:'supply',participants:null},config:{members:null},createdAt:10,updatedAt:95,
   events:[{at:10,kind:'connecting'},{at:15,kind:'connected'},{at:20,kind:'ready'},{at:90,kind:'ended',detail:'disconnected'},{at:93,kind:'logout',detail:'disconnected'},{at:95,kind:'closed'}]});
  f.put(relative(f.base,join(dir,'latest.json')),{schema:'session-lifecycle/1',account:'Rod',server:f.request.server,domain:'live',attemptId:id,at:10});
  expect(readLogoutProof('Rod',f.request.server,{root}).state).toBe('held');
 }
 const retained=listAttempts('Rod',f.request.server,{root});
 issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,process.pid,f.base,f.options);const guard=consumeRecoveryPermit(f.request,f.base,f.options);
 const ends=readFileSync(join(f.base,'.practice/swarm-deaths.json'),'utf8'),holds=readFileSync(join(f.base,'.practice/swarm-script-holds.json'),'utf8');
 const attempt=beginSessionAttempt({account:'Rod',server:f.request.server},{root,now:()=>now+5,
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
 expect(listAttempts('Rod',f.request.server,{root}).slice(0,retained.length)).toEqual(retained);
 if(history){
  const old=readFileSync(join(dir,'attempts',id+'.json'),'utf8');
  writeFileSync(join(dir,'attempts',id+'.json'),old+' ');
  // Retained records remain pinned even after the new producer has confirmed logout.
  expect(()=>guard()).toThrow('producer ownership changed');writeFileSync(join(dir,'attempts',id+'.json'),old);
 }
 }
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
  if(fault==='controller')f.put('.practice/live/swarm-owner.json',{pid:999,nonce:'other',source});
  if(fault==='task')f.options.matches=(pid:number)=>pid===process.pid;
  if(fault==='authorization')f.put('.practice/live/fleet-runs/task-run/recovery.json',{tasks:[]});
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
  if(fault==='task')f.put('.practice/live/fleet-runs/task-run/recovery.json',{tasks:[]});
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
 // A process that started after that attempt holds the owner's id: it is not the owner, so nothing is alive.
 (f.options as {processStarts?:(pids:readonly number[])=>Map<number,number>}).processStarts=()=>new Map([[process.pid,Date.now()+60_000]]);
 expect(()=>guard()).not.toThrow();
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
   const ended=new Map(Object.entries(JSON.parse(ends))) as Map<string,any>,holds:ScriptHold[]=[];
   const repaired=applyEndRepair({account:'Rod',endedAt:100,server:f.request.server,proof:{kind:'producer',attemptId:attempt.attemptId}},ended,[],{
    readProof:(a,s)=>readLogoutProof(a,s,{root}),verifyLegacy:()=>({state:'refused',reason:'not used'})},holds);
   expect(repaired.changed).toBe(true);expect(holds).toEqual([]);
   f.put('.practice/swarm-deaths.json',Object.fromEntries(ended));f.put('.practice/swarm-script-holds.json',holds);
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
test('launcher permits delayed setup to finish at140seconds but retains the lease at the absolute150second expiry',async()=>{
 for(const elapsed of [140000,150000,150001]){
  const f=fixture();let clock=now,exit!:(code:number)=>void;
  const exited=new Promise<number>(resolve=>{exit=resolve;});
  type Timer={at:number;run:()=>void;unref:()=>Timer};const timers=new Set<Timer>();
  const advance=(at:number)=>{clock=at;for(const timer of [...timers])if(timer.at<=at){timers.delete(timer);timer.run();}};
  const set=spyOn(globalThis,'setTimeout').mockImplementation(((run:()=>void,ms=0)=>{const timer:Timer={at:clock+ms,run,unref:()=>timer};timers.add(timer);return timer;}) as any);
  const clear=spyOn(globalThis,'clearTimeout').mockImplementation(((timer:Timer)=>{timers.delete(timer);}) as any);
  const kill=spyOn(recoveryProcesses,'safeKill').mockResolvedValue(true);
  const spawn=spyOn(Bun,'spawn').mockImplementation((()=>{clock=now+5000;return{pid:process.pid,exited,stdin:{write:async()=>{},end:async()=>{}}};}) as any);
  try{
   f.options.now=()=>clock;
   const runnerBytes=readFileSync(resolve(import.meta.dir,'../../..',RECOVERY_SCRIPT));writeFileSync(join(f.base,RECOVERY_SCRIPT),runnerBytes);
   const launched=launchPermittedRecovery(f.request,f.base,{...f.options,nativeFixture:true});
   advance(now+20000);f.put('.practice/swarm-state.json',{at:clock,controllerPid:process.pid,jobs:[]});
   consumeRecoveryPermit(f.request,f.base,{...f.options,nativeFixture:true});
   advance(now+100000);
   const root=join(f.base,'.practice/session-lifecycle'),owner={pid:process.pid,coordinatorRunId:f.request.runId,workerRelease:source,script:RECOVERY_SCRIPT,role:'recovery',participants:null};
   const attempt=beginSessionAttempt({account:'Rod',server:f.request.server},{root,owner,now:()=>clock});attempt.record('ended','logged-out');
   const proof=readLogoutProof('Rod',f.request.server,{root});if(proof.state!=='confirmed')throw Error('fixture');
   const before={player:{name:'Rod',x:1,z:2,level:0,hp:43},inventory:[{id:995,count:100}],equipment:[],skills:[],bank:null,modalOpen:false};
   f.put('.practice/coordinator/session-recovery/accounts/rod/one/output/receipt.json',{state:'confirmed',request:f.request,logout:'logged-out',failure:'',startedAt:now+27000,endedAt:now+elapsed,
    runnerSha256:createHash('sha256').update(runnerBytes).digest('hex'),before,after:structuredClone(before),attemptId:attempt.attemptId,lifecycleSha256:proof.receiptSha256,
    scope:{gameplay:false,production:0,repairsFailure:false,qualifiesScript:false}});
   advance(now+elapsed);f.put('.practice/swarm-state.json',{at:clock,controllerPid:process.pid,jobs:[]});exit(0);
   if(elapsed===140000){const outcome=await launched.completion.then(value=>({value}),error=>({error:String(error)}));expect(outcome).toMatchObject({value:{proof:{state:'confirmed'}}});expect(existsSync(launched.paths.lease)).toBe(false);}
   else{await expect(launched.completion).rejects.toThrow();expect(existsSync(launched.paths.lease)).toBe(true);expect(existsSync(launched.paths.completed)).toBe(false);}
  }finally{spawn.mockRestore();kill.mockRestore();clear.mockRestore();set.mockRestore();rmSync(f.base,{recursive:true,force:true});}
 }
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
test('a completed launch binds its child although each process lookup ages the blocked controller heartbeat',()=>{
 // Issue and binding run synchronously in the controller, so its heartbeat cannot advance between them. Repeated
 // process lookups at binding must not age that heartbeat past FLEET_HEARTBEAT_MAX_MS.
 for(const shared of [false,true]){
  const f=completedFixture();let clock=now;
  f.options.now=()=>clock;
  f.options.matches=()=>{clock+=3000;return true;};
  const checks=shared?launchObservations(f.options):f.options;
  issueRecoveryPermit(f.request,f.base,checks);
  const paths=recoveryPermitPaths(f.request,f.base);
  if(shared){bindRecoveryChild(f.request,process.pid,f.base,checks);expect(existsSync(paths.child)).toBe(true);}
  else{expect(()=>bindRecoveryChild(f.request,process.pid,f.base,checks)).toThrow('recovery fleet ownership unresolved: stale');expect(existsSync(paths.child)).toBe(false);}
  expect(existsSync(paths.lease)).toBe(true);expect(existsSync(paths.used)).toBe(false);
 }
 // The shared observations never outlive the launch: a fresh launch looks the processes up again.
 const f=completedFixture();let calls=0;f.options.matches=()=>{calls++;return true;};
 const first=launchObservations(f.options);first.matches!(1,'a');first.matches!(1,'a');launchObservations(f.options).matches!(1,'a');
 expect(calls).toBe(2);
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
test('the controller releases only an exact expired held lease with a dead bound child and its matching confirmed logout',()=>{
 for(const fault of ['none','interrupted','crossed-marker','torn-marker','live-child','changed-lease','not-expired','mismatched-proof','newer-attempt','unbound','stopped','controller']){
  const f=fixture();issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,process.pid,f.base,f.options);consumeRecoveryPermit(f.request,f.base,f.options);
  const root=join(f.base,'.practice/session-lifecycle'),owner={pid:process.pid,coordinatorRunId:f.request.runId,workerRelease:source,script:RECOVERY_SCRIPT,role:'recovery',participants:null};
  const attempt=beginSessionAttempt({account:'Rod',server:f.request.server},{root,owner,now:()=>now+5});attempt.record('ended','logged-out');
  const proof=readLogoutProof('Rod',f.request.server,{root});if(proof.state!=='confirmed')throw Error('fixture');
  const before={player:{name:'Rod',x:1,z:2,level:0,hp:43},inventory:[{id:995,count:100}],equipment:[],skills:[],bank:null,modalOpen:false};
  const receipt:any={state:'held',request:f.request,logout:'logged-out',failure:'cleanup failed or unresolved',startedAt:now+5,endedAt:now+10,runnerSha256:f.runnerHash,
   before,after:null,attemptId:attempt.attemptId,lifecycleSha256:proof.receiptSha256,proof,scope:{gameplay:false,production:0,repairsFailure:false,qualifiesScript:false}};
  if(fault==='mismatched-proof')receipt.attemptId='other';
  f.put('.practice/coordinator/session-recovery/accounts/rod/one/output/receipt.json',receipt);
  const paths=recoveryPermitPaths(f.request,f.base),dir=dirname(paths.permit);
  expect(()=>finishRecoveryPermit(f.request,0,f.base,{...f.options,now:()=>now+20})).toThrow('child did not confirm');
  if(fault==='changed-lease'){const lease=readFileSync(paths.lease,'utf8');rmSync(paths.lease);writeFileSync(paths.lease,lease+' ');}
  if(fault==='newer-attempt')beginSessionAttempt({account:'Rod',server:f.request.server},{root,owner:{...owner,pid:4321},now:()=>now+30}).record('ended','logged-out');
  if(fault==='unbound')rmSync(paths.used);
  if(fault==='stopped')f.put('.practice/stop-Rod',{});
  if(fault==='controller')f.put('.practice/live/swarm-owner.json',{pid:999,nonce:'other',source});
  const checks={now:()=>fault==='not-expired'?now+149999:now+150000,matches:()=>true,childAlive:()=>fault==='live-child'};
  const kept=Object.fromEntries([paths.permit,paths.child,paths.used,join(paths.output,'receipt.json'),join(f.base,'.practice/swarm-deaths.json'),join(f.base,'swarm.json')]
   .filter(p=>existsSync(p)).map(p=>[p,readFileSync(p,'utf8')]));
  const reasons:Record<string,string>={'live-child':'child still alive','changed-lease':'lease changed','not-expired':'not expired','mismatched-proof':'producer proof mismatched',
   'newer-attempt':'producer proof mismatched',unbound:'child not bound',stopped:'owner stopped',controller:'needs the controller',
   'crossed-marker':'release marker mismatched','torn-marker':'release marker mismatched'};
  // A release that stopped after the marker and before the removal: the marker of a full release, and the lease back in place.
  const marker=join(dir,'released.json'),interrupted=['interrupted','crossed-marker','torn-marker'].includes(fault);
  let first:any=null;
  if(interrupted){
   const lease=readFileSync(paths.lease,'utf8');first=releaseExpiredRecoveryLease('Rod',f.base,checks);writeFileSync(paths.lease,lease);
   if(fault==='crossed-marker')writeFileSync(marker,JSON.stringify({...first,attemptId:'other'}));
   if(fault==='torn-marker')writeFileSync(marker,'{"schema":');
  }
  const markerRaw=existsSync(marker)?readFileSync(marker,'utf8'):null;
  if(fault==='interrupted'){
   // A restarted controller has a new nonce and a later clock. It removes the lease and returns the first marker.
   f.put('.practice/live/swarm-owner.json',{pid:process.pid,nonce:'restarted',source});
   expect(releaseExpiredRecoveryLease('Rod',f.base,{...checks,now:()=>now+200000})).toEqual(first);
   expect(existsSync(paths.lease)).toBe(false);expect(()=>assertNoRecoveryLease('Rod',f.base)).not.toThrow();
   expect(readFileSync(marker,'utf8')).toBe(markerRaw!);expect(existsSync(paths.completed)).toBe(false);
  }else if(fault==='none'){
   const released=releaseExpiredRecoveryLease('Rod',f.base,checks);
   expect(released).toMatchObject({account:'Rod',nonce:'one',childPid:process.pid,attemptId:attempt.attemptId,lifecycleSha256:proof.receiptSha256});
   expect(existsSync(paths.lease)).toBe(false);expect(()=>assertNoRecoveryLease('Rod',f.base)).not.toThrow();
   expect(JSON.parse(readFileSync(join(dir,'released.json'),'utf8'))).toEqual(released);
   expect(existsSync(paths.completed)).toBe(false);expect(recoveredSessionForRun('Rod',f.request.server,f.request.runId,source,f.base)).toBe(false);
   expect(()=>releaseExpiredRecoveryLease('Rod',f.base,checks)).toThrow('lease absent');
  }else{
   expect(()=>releaseExpiredRecoveryLease('Rod',f.base,checks),fault).toThrow(reasons[fault]);
   expect(existsSync(paths.lease),fault).toBe(true);expect(existsSync(marker)?readFileSync(marker,'utf8'):null,fault).toBe(markerRaw);
   expect(releaseExpiredRecoveryLeases(f.base,[],checks),fault).toEqual([{account:'rod',released:false,reason:expect.stringContaining(reasons[fault]!)}]);
   expect(releaseExpiredRecoveryLeases(f.base,['Rod'],checks)).toEqual([]);
  }
  for(const [p,raw] of Object.entries(kept))expect(readFileSync(p,'utf8'),fault+' '+p).toBe(raw);
 }
});
test('the controller also releases a held lease that a later session of a different run superseded, or whose child did not connect',async()=>{
 // 'not-connected-open': the old session is still held and the child began none. The lease then refuses each new
 // recovery of that session, so it is released. 'not-connected-open-logout': a receipt that names a logout keeps it.
 const reasons:Record<string,string>={'superseded-open':'producer logout not confirmed','superseded-same-run':'producer proof mismatched','not-connected-open-logout':'producer logout not confirmed',
  'not-connected-receipt-logout':'producer proof mismatched','no-attempt':'producer logout not confirmed'};
 // A synthetic fixed PID may belong to an unrelated host process; this owner has an observed process exit.
 const previousOwner=Bun.spawn([process.execPath,'-e',''],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true});
 expect(await previousOwner.exited).toBe(0);
 const other={pid:previousOwner.pid,coordinatorRunId:null,workerRelease:source,script:'scripts/other.ts',role:null,participants:null};
 for(const fault of ['superseded','superseded-open','superseded-same-run','not-connected','not-connected-no-receipt','not-connected-open','not-connected-open-logout','not-connected-receipt-logout','no-attempt']){
  const f=fixture(),root=join(f.base,'.practice/session-lifecycle'),connected=fault.startsWith('superseded'),identity={account:'Rod',server:f.request.server};
  const owner={pid:process.pid,coordinatorRunId:f.request.runId,workerRelease:source,script:RECOVERY_SCRIPT,role:'recovery',participants:null};
  // An attempt takes the later of its own clock and the last attempt of this process, so the permit time follows the old attempt.
  let issued=now;
  if(!connected&&fault!=='no-attempt'){
   const old=beginSessionAttempt(identity,{root,owner:other,now:()=>now-50});
   if(!fault.startsWith('not-connected-open'))old.record('ended','logged-out');
   issued=listAttempts('Rod',f.request.server,{root})[0]!.receipt!.createdAt+1000;
   f.put('.practice/swarm-state.json',{at:issued,controllerPid:process.pid,jobs:[{account:'Rod',state:'disabled'}]});
   f.options.now=()=>issued;
  }
  issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,process.pid,f.base,f.options);consumeRecoveryPermit(f.request,f.base,f.options);
  const paths=recoveryPermitPaths(f.request,f.base),marker=join(dirname(paths.permit),'released.json'),receiptFile=join(paths.output,'receipt.json');
  const receipt:any={state:'held',request:f.request,failure:'cleanup failed or unresolved',startedAt:issued+5,endedAt:issued+10,runnerSha256:f.runnerHash,before:null,after:null,
   scope:{gameplay:false,production:0,repairsFailure:false,qualifiesScript:false}};
  if(connected){
   // The child logged in and out. Then a session of a different run, or of the same run, began.
   const own=beginSessionAttempt(identity,{root,owner,now:()=>issued+5});own.record('ended','logged-out');
   const proof=readLogoutProof('Rod',f.request.server,{root});if(proof.state!=='confirmed')throw Error('fixture');
   f.put(relative(f.base,receiptFile),{...receipt,logout:'logged-out',attemptId:own.attemptId,lifecycleSha256:proof.receiptSha256,proof});
   const later=beginSessionAttempt(identity,{root,owner:fault==='superseded-same-run'?{...owner,pid:other.pid}:other,now:()=>issued+30});
   if(fault!=='superseded-open')later.record('ended','logged-out');
  }else if(fault!=='not-connected-no-receipt')f.put(relative(f.base,receiptFile),{...receipt,logout:fault==='not-connected-receipt-logout'||fault==='not-connected-open-logout'?'logged-out':'not-attempted',attemptId:null,lifecycleSha256:null});
  const checks={now:()=>issued+150000,matches:()=>true,childAlive:()=>false};
  const kept=Object.fromEntries([paths.permit,paths.child,paths.used,receiptFile,join(f.base,'.practice/swarm-deaths.json'),join(f.base,'swarm.json')].filter(p=>existsSync(p)).map(p=>[p,readFileSync(p,'utf8')]));
  if(reasons[fault]){
   expect(()=>releaseExpiredRecoveryLease('Rod',f.base,checks),fault).toThrow(reasons[fault]);
   expect(existsSync(paths.lease),fault).toBe(true);expect(existsSync(marker),fault).toBe(false);
   expect(releaseExpiredRecoveryLeases(f.base,[],checks),fault).toEqual([{account:'rod',released:false,reason:expect.stringContaining(reasons[fault]!)}]);
  }else{
   const proof=readLogoutProof('Rod',f.request.server,{root});if(proof.state!==(fault==='not-connected-open'?'held':'confirmed'))throw Error('fixture');
   const lifecycleSha256=proof.state==='confirmed'?proof.receiptSha256:listAttempts('Rod',f.request.server,{root}).find(a=>a.attemptId===(proof as {attemptId:string}).attemptId)!.sha256;
   const released=releaseExpiredRecoveryLease('Rod',f.base,checks);
   expect(released,fault).toMatchObject({account:'Rod',nonce:'one',childPid:process.pid,attemptId:(proof as {attemptId:string}).attemptId,lifecycleSha256,basis:connected?'superseded':'not-connected'});
   expect(released.receiptSha256===null,fault).toBe(fault==='not-connected-no-receipt');
   expect(existsSync(paths.lease),fault).toBe(false);expect(()=>assertNoRecoveryLease('Rod',f.base)).not.toThrow();
   expect(JSON.parse(readFileSync(marker,'utf8'))).toEqual(released);
   expect(existsSync(paths.completed)).toBe(false);expect(recoveredSessionForRun('Rod',f.request.server,f.request.runId,source,f.base)).toBe(false);
   expect(()=>releaseExpiredRecoveryLease('Rod',f.base,checks)).toThrow('lease absent');
  }
  for(const [p,raw] of Object.entries(kept))expect(readFileSync(p,'utf8'),fault+' '+p).toBe(raw);
 }
});
test('an exact pre-request lease refusal waits while the controller archives only its dead connect-failed child and retains lineage outcomes',()=>{
 for(const fault of ['none','live-child','not-expired','stopped','unbound','request','source','hash','ready','logout','proof','newer','scope','times'] as const){
  const f=fixture(),issued=Date.now(),root=join(f.base,'.practice/session-lifecycle');
  f.request.server='rs-sdk-demo.fly.dev';f.options.now=()=>issued;
  f.put('.practice/swarm-state.json',{at:issued,controllerPid:process.pid,jobs:[{account:'Rod',state:'disabled'}]});
  issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,process.pid,f.base,f.options);consumeRecoveryPermit(f.request,f.base,f.options);
  const owner={pid:process.pid,coordinatorRunId:f.request.runId,workerRelease:source,script:RECOVERY_SCRIPT,role:'recovery',participants:null};
  const attempt=beginSessionAttempt({account:'Rod',server:f.request.server},{root,owner,now:()=>issued+5});
  if(fault==='ready')attempt.record('ready');
  attempt.record('connect-failed','fixture connection failed');
  if(fault==='logout')attempt.record('logout','timeout');
  const producer=listAttempts('Rod',f.request.server,{root}).find(a=>a.attemptId===attempt.attemptId)!;
  const proof=readLogoutProof('Rod',f.request.server,{root});
  const paths=recoveryPermitPaths(f.request,f.base),receipt:any={schema:'session-recovery/1',state:'held',request:structuredClone(f.request),
   startedAt:issued,endedAt:producer.receipt!.updatedAt+5,attemptId:attempt.attemptId,lifecycleSha256:producer.sha256,proof,before:null,after:null,
   logout:'not-attempted',failure:'connect failed or unresolved',runnerSha256:f.runnerHash,
   scope:{gameplay:false,production:0,repairsFailure:false,qualifiesScript:false,bankObservation:'unobserved'}};
  if(fault==='request')receipt.request.nonce='crossed';
  if(fault==='source')receipt.runnerSha256='f'.repeat(64);
  if(fault==='hash')receipt.lifecycleSha256='f'.repeat(64);
  if(fault==='proof')receipt.proof={...proof,attemptId:'crossed'};
  if(fault==='scope')receipt.scope.production=1;
  if(fault==='times')receipt.endedAt=issued+4;
  f.put(relative(f.base,join(paths.output,'receipt.json')),receipt);
  if(fault==='unbound')rmSync(paths.used);
  if(fault==='stopped')f.put('.practice/stop-Rod','owner pause');
  if(fault==='newer')beginSessionAttempt({account:'Rod',server:f.request.server},{root,owner:{...owner,pid:4321},now:()=>issued+20});
  const end={at:issued+1000,reason:`exit orphaned: attempt ${attempt.attemptId} owner ${process.pid} gone`,revision:'unchanged-consumer'};
  f.put('.practice/swarm-deaths.json',{Rod:end});
  const kept=Object.fromEntries([paths.permit,paths.child,paths.used,join(paths.output,'receipt.json'),join(f.base,'.practice/swarm-deaths.json'),join(f.base,'swarm.json'),
   join(accountDir('Rod',f.request.server,root),'attempts',attempt.attemptId+'.json')].filter(p=>existsSync(p)).map(p=>[p,readFileSync(p,'utf8')]));
  const checks={now:()=>issued+(fault==='not-expired'?149999:150000),matches:()=>true,childAlive:()=>fault==='live-child'};
  if(fault!=='none'){
   expect(()=>releaseExpiredRecoveryLease('Rod',f.base,checks),fault).toThrow();expect(existsSync(paths.lease),fault).toBe(true);
  }else{
   const failed={status:'failed',runId:f.request.runId,receipt:{ok:false,error:'Error: controller held authenticated recovery: recovery child held; inspect fixed child output and retained account lease; no retry'},
    spec:{id:'child',kind:'run',capability:'session-recovery-only',account:'Rod',sessionRecovery:{account:'Rod',endedAt:100},repairs:[{account:'Rod',endedAt:100}]}};
   const refused={status:'failed',runId:'preflight-run',receipt:{ok:false,output:null,error:'Error: account has an unresolved recovery lease: Rod'},
    spec:{id:'preflight',kind:'run',capability:'session-recovery-only',account:'Rod',sessionRecovery:{account:'Rod',endedAt:end.at},repairs:[{account:'Rod',endedAt:end.at}]}};
   expect(spentAttempts([refused],{account:'Rod',endedAt:end.at})).toBe(0);
   expect(waitedAttempts([refused],{account:'Rod',endedAt:end.at})).toBe(1);
   for(const error of ['Error: account has an unresolved recovery lease: Other','Error: recovery lease child still alive','Error: account has an unresolved recovery lease: Rod extra'])
    expect(spentAttempts([{...refused,receipt:{...refused.receipt,error}}],{account:'Rod',endedAt:end.at})).toBe(1);
   expect(releaseExpiredRecoveryLeases(f.base,['Rod'],checks)).toEqual([]);
   expect(releaseExpiredRecoveryLeases(f.base,[],checks)).toEqual([{account:'rod',released:true,reason:'released'}]);
   const marker=JSON.parse(readFileSync(join(dirname(paths.permit),'released.json'),'utf8'));
   expect(marker).toMatchObject({basis:'connect-failed',attemptId:attempt.attemptId,lifecycleSha256:producer.sha256,receiptSha256:createHash('sha256').update(kept[join(paths.output,'receipt.json')]!).digest('hex')});
   expect(existsSync(paths.completed)).toBe(false);expect(recoveredSessionForRun('Rod',f.request.server,f.request.runId,source,f.base)).toBe(false);
   expect(readLogoutProof('Rod',f.request.server,{root})).toEqual(proof);
   expect(()=>liveLogoutRef('Rod',f.base,true,issued+150000,false,()=>false)).toThrow('account logout is not confirmed');
   const archive='.practice/coordinator/archive/tasks.jsonl';
   f.put(archive,{});writeFileSync(join(f.base,archive),[failed,refused,failed,refused].map(t=>JSON.stringify(t)).join('\n')+'\n');
   expect(retainedRecoveryTasks(f.base,[failed,refused])).toHaveLength(2);
   expect(budgetRefusal(f.base,'Rod',end,[])).toBeUndefined();
   for(const changed of [{...refused,receipt:{...refused.receipt,output:{}}},{...refused,receipt:{...refused.receipt,ok:true}},
    ...[{account:'Other'},{capability:'other'},{repairs:[]}].map(fields=>({...refused,spec:{...refused.spec,...fields}}))])
    expect(budgetRefusal(f.base,'Rod',end,[failed,changed])).toMatch(/unknown .*archive conflict/);
   const waits=Array.from({length:MAX_WAITS},(_,i)=>({...refused,runId:'wait-'+i,spec:{...refused.spec,id:'wait-'+i}}));
   writeFileSync(join(f.base,archive),[failed,...waits,...waits].map(t=>JSON.stringify(t)).join('\n')+'\n');
   expect(budgetRefusal(f.base,'Rod',end,[waits[0]])).toMatch(/^6 recoveries .* waited /);
   const second={...failed,runId:'second',spec:{...failed.spec,id:'second',sessionRecovery:{account:'Rod',endedAt:end.at}}};
   writeFileSync(join(f.base,archive),[failed,second,refused,failed,second].map(t=>JSON.stringify(t)).join('\n')+'\n');
   expect(budgetRefusal(f.base,'Rod',end,[second])).toMatch(/^2 recoveries .* failed/);
  }
  for(const [p,raw] of Object.entries(kept))expect(readFileSync(p,'utf8'),fault+' '+p).toBe(raw);
 }
});
test('restart counts inherited children without replay, ignores dead children, and retains every lease',()=>{
 const f=fixture();issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,1234,f.base,f.options);
 const noTable=()=>new Map<number,number>();
 expect(heldRecoveryOwners(f.base,[],pid=>pid===1234,now,noTable)).toEqual([{account:'Rod',pid:1234,started:now,source}]);
 expect(heldRecoveryOwners(f.base,['rod'],()=>true,now,noTable)).toEqual([]);
 expect(heldRecoveryOwners(f.base,[],()=>false,now,noTable)).toEqual([]);
 expect(()=>assertNoRecoveryLease('Rod',f.base)).toThrow('lease');expect(existsSync(recoveryPermitPaths(f.request,f.base).used)).toBe(false);
});
test('a later process that holds the id of a dead recovery child is not the child',()=>{
 const f=fixture();issueRecoveryPermit(f.request,f.base,f.options);bindRecoveryChild(f.request,1234,f.base,f.options);
 const written=statSync(recoveryPermitPaths(f.request,f.base).child).mtimeMs;
 expect(heldRecoveryOwners(f.base,[],()=>true,now,()=>new Map([[1234,written+60_000]]))).toEqual([]);
 expect(heldRecoveryOwners(f.base,[],()=>true,now,()=>new Map([[1234,written-60_000]]))).toHaveLength(1);
 expect(heldRecoveryOwners(f.base,[],()=>true,now,()=>null)).toHaveLength(1);
});
test('cachedProcessStarts reads each id once a minute and keeps a failed read',()=>{
 let reads=0;const read=(ids:readonly number[])=>{reads++;return new Map(ids.map(i=>[i,i*10]));};
 expect(cachedProcessStarts([90001],read,1_000)?.get(90001)).toBe(900010);
 expect(cachedProcessStarts([90001],read,30_000)?.get(90001)).toBe(900010);expect(reads).toBe(1);
 cachedProcessStarts([90001],read,61_000);expect(reads).toBe(2);
 expect(cachedProcessStarts([90002],()=>null,1_000)).toBeNull();
 expect(cachedProcessStarts([90002],read,2_000)).toBeNull();
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
test('the delivery binds to its capability release while the request binds to the launch release',()=>{
 const f=fixture(),capability='c'.repeat(64);
 try{
  const report=JSON.parse(readFileSync(join(f.base,'.practice/deliveries/fixture/report.json'),'utf8'));
  f.put('.practice/deliveries/fixture/report.json',{...report,runtimeRevision:capability});
  f.request.qualification.delivery={path:'.practice/deliveries/fixture/report.json',sha256:createHash('sha256').update(readFileSync(join(f.base,'.practice/deliveries/fixture/report.json'))).digest('hex')};
  const options={...f.options,capability:()=>capability};
  expect(()=>issueRecoveryPermit(f.request,f.base,{...options,capability:()=>source})).toThrow('controller-native qualification');
  expect(()=>issueRecoveryPermit(f.request,f.base,{...options,capability:()=>undefined})).toThrow('controller-native qualification');
  expect(()=>issueRecoveryPermit(f.request,f.base,options)).not.toThrow();
 }finally{rmSync(f.base,{recursive:true,force:true});}
});
test('a held retired producer gets a permit only from a delivery at its capability release',()=>{
 const f=completedFixture(),capability='c'.repeat(64);f.request.server='rs-sdk-demo.fly.dev';
 try{
  const root=join(f.base,'.practice/session-lifecycle'),dir=accountDir('Rod',f.request.server,root),id='0000000000010-2147483647-0000000001';
  f.put(relative(f.base,join(dir,'attempts',id+'.json')),{schema:'session-lifecycle/1',attemptId:id,account:'Rod',server:f.request.server,domain:'live',
   owner:{pid:2147483647,coordinatorRunId:null,workerRelease:runner,script:'scripts/goldfarm.ts',role:'supply',participants:null},config:{members:null},createdAt:10,updatedAt:95,
   events:[{at:10,kind:'connecting'},{at:15,kind:'connected'},{at:20,kind:'ready'},{at:90,kind:'ended',detail:'disconnected'},{at:93,kind:'logout',detail:'disconnected'},{at:95,kind:'closed'}]});
  f.put(relative(f.base,join(dir,'latest.json')),{schema:'session-lifecycle/1',account:'Rod',server:f.request.server,domain:'live',attemptId:id,at:10});
  const report=JSON.parse(readFileSync(join(f.base,'.practice/deliveries/fixture/report.json'),'utf8'));
  f.put('.practice/deliveries/fixture/report.json',{...report,runtimeRevision:capability});
  f.request.qualification.delivery={path:'.practice/deliveries/fixture/report.json',sha256:createHash('sha256').update(readFileSync(join(f.base,'.practice/deliveries/fixture/report.json'))).digest('hex')};
  // The delivery records the capability release; the launch release (source) must not stand in for it.
  expect(()=>issueRecoveryPermit(f.request,f.base,{...f.options,capability:()=>source})).toThrow('controller-native qualification');
  expect(existsSync(recoveryPermitPaths(f.request,f.base).lease)).toBe(false);
  const permit=issueRecoveryPermit(f.request,f.base,{...f.options,capability:()=>capability});
  expect(permit.producerHistory).toEqual(listAttempts('Rod',f.request.server,{root}).map(({attemptId,sha256})=>({attemptId,sha256})));
  expect(permit.producerHistory?.map(p=>p.attemptId)).toEqual([id]);
 }finally{rmSync(f.base,{recursive:true,force:true});}
});

test('brain fleet-state heartbeat authorizes idle accounts and rejects stale or active ones',()=>{
 const f=fixture();
 try{
  const liveFile='.practice/live/fleet-state.json';
  const baseState={schemaVersion:1,emittedAt:now,side:'local',server:f.request.server,maxBots:17,accounts:{rod:{account:'Rod',status:'idle',lifecycle:'held_logout',activeJob:null}},activeChains:{},idleReasons:{},goals:[],campaigns:[],missions:[],pendingTransfers:[],quarantinedDefects:[]};
  f.put(liveFile,baseState);
  expect(()=>issueRecoveryPermit(f.request,f.base,f.options)).not.toThrow();
  rmSync(recoveryPermitPaths(f.request,f.base).lease);
  rmSync(recoveryPermitPaths(f.request,f.base).permit);
  f.put(liveFile,{...baseState,emittedAt:now-FLEET_HEARTBEAT_MAX_MS-1});
  expect(()=>issueRecoveryPermit(f.request,f.base,f.options)).toThrow('recovery fleet ownership unresolved: stale');
  f.put(liveFile,{...baseState,accounts:{rod:{account:'Rod',status:'running',lifecycle:'running',activeJob:{script:'scripts/x.ts'}}}});
  expect(()=>issueRecoveryPermit(f.request,f.base,f.options)).toThrow('recovery assignment is active or reserved');
 }finally{rmSync(f.base,{recursive:true,force:true});}
});
