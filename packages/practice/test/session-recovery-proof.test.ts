// Unit-only checks of the native recovery proof's pure parts. No world, login server or game child starts here.
import {test,expect,spyOn} from 'bun:test';
import * as fs from 'node:fs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,existsSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {accountDir,beginSessionAttempt} from '../../core/src/session-lifecycle';
import {afterStalledConnection,observePartialOwner,waitOwnerAuthLogout} from '../src/session-recovery-proof';
import {recoveryCloseModal} from '../../core/src/session-recovery';
import type {Session} from '../../core/src/inprocess';
import {recoveryCapability,verifyCompletedRouterPins,fleetHandoff,publishControlFile,observeRecoveryBoundary,recoveryAuthorityInputs,type RecoveryBoundary} from '../src/session-recovery-proof';
import {NATIVE_RECOVERY_CHECKS,assertFleetResolved,verifyNativeRecoveryProof,launchPermittedRecovery,waitForRecoveryChildBinding,recoveryPermitPaths,type ControlledRecoveryRequest} from '../../core/src/session-recovery-permit';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {createRecoveryDispatch} from '../../core/src/session-recovery-dispatch';
import {admitRecovery} from '../../../scripts/swarm';
import {CHECK_CASES,deriveChecks,reconcileSaves,reconcileNegativeControls,stockOf,authReplies,observeAuth,noRecoveryLogin,installAuthObserver,evidenceFiles,retainRequiredRecoveryCase,requireRecoveryRegistration,recoveryArtifactPresence,recoveryConsumptionBytes,claimStopArtifact,releaseStopArtifact,classifyCooldownWindow,ownerSessionEvidence,loginAfterTakeoverWindow,orphanServerEnd,latestOwnerLoginBefore,recoverySessionAuth,TAKEOVER_WINDOW_MS,installButtonObserver,buttonTraceFor} from '../src/session-recovery-proof';

test('recovery accepts player_kit and requires an observed modal close within the observation budget',async()=>{
 for(const [modalInterface,closes] of [[3559,true],[3559,false],[12,true]] as const){
  const state={inGame:true,modalOpen:true,modalInterface};
  const actions:unknown[]=[];let ticks=0,listener:(()=>void)|undefined;
  const session={sdk:{getState:()=>state},tick:()=>ticks,
   onTick:(cb:()=>void)=>{listener=cb;return()=>{listener=undefined;};},
   direct:async(action:{type:string})=>{actions.push(action);return{success:true};},
  } as unknown as Session;
  const pending=recoveryCloseModal(session,20);
  await Promise.resolve();
  expect(actions).toEqual([modalInterface===3559?{type:'acceptCharacterDesign'}:{type:'closeModal',reason:'session recovery'}]);
  // Dispatch success leaves the observed screen open. Only a later game tick can prove closure.
  expect(listener).toBeDefined();
  for(let i=1;i<=10;i++){
   if(i===2&&closes)state.modalOpen=false;
   ticks++;listener?.();
  }
  expect(await pending).toBe(closes);
  expect(listener).toBeUndefined();
 }
});

test('ten rapid buffered ticks do not exhaust the budget before a delayed closure response, and session end refuses',async()=>{
 const log=spyOn(console,'log').mockImplementation(()=>{});
 const realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout,budgets=new Set<unknown>();
 globalThis.setTimeout=((fn:()=>void,ms?:number)=>{const h=realSet(fn,ms);if(ms===2000)budgets.add(h);return h;}) as typeof setTimeout;
 globalThis.clearTimeout=((h:Parameters<typeof clearTimeout>[0])=>{budgets.delete(h);realClear(h);}) as typeof clearTimeout;
 try{
  for(const mode of ['delayed','ended'] as const){
   const state={inGame:true,modalOpen:true,modalInterface:3559};
   let ticks=0,listener:(()=>void)|undefined,end:(v:{reason:string})=>void=()=>{};
   const ended=new Promise<{reason:string}>(r=>{end=r;});
   const session={client:{flush(){}},sdk:{getState:()=>state},tick:()=>ticks,ended,
    onTick:(cb:()=>void)=>{listener=cb;return()=>{listener=undefined;};},
    direct:async()=>({success:true}),
   } as unknown as Session;
   const pending=recoveryCloseModal(session);
   await Promise.resolve();await Promise.resolve();
   expect(listener).toBeDefined();
   // The client replays buffered ticks 2->12 within milliseconds, before the server's IF_CLOSE arrives.
   for(let i=0;i<10;i++){ticks++;listener?.();}
   let settled=false;void pending.then(()=>{settled=true;});
   await new Promise(r=>setTimeout(r,30));
   expect(settled).toBe(false);expect(listener).toBeDefined();expect(budgets.size).toBe(1);
   if(mode==='delayed'){state.modalOpen=false;ticks++;listener?.();}
   else end({reason:'disconnected'});
   expect(await pending).toBe(mode==='delayed');
   expect(listener).toBeUndefined();
   // The default 2000 ms budget timer is cleared on every exit.
   expect(budgets.size).toBe(0);
  }
 }finally{globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;log.mockRestore();}
});

test('queued recovery cleanup flushes before observing the modal effect',async()=>{
 for(const modalInterface of [3559,12]){
  const state={inGame:true,modalOpen:true,modalInterface};
  const events:string[]=[];let tick=0,queued=false,delivered=false,listener:(()=>void)|undefined;
  const client={flush(){
   expect(this).toBe(client);expect(queued).toBe(true);
   events.push('flush');queued=false;delivered=true;
  }};
  const session={client,sdk:{getState:()=>state},tick:()=>tick,
   onTick:(cb:()=>void)=>{events.push('observe');listener=cb;return()=>{listener=undefined;};},
   direct:async(action:{type:string})=>{events.push(action.type);queued=true;return{success:true};},
  } as unknown as Session;
  const pending=recoveryCloseModal(session);
  await Promise.resolve();
  // The server can apply only delivered bytes, on a later tick. Dispatch alone cannot close the modal.
  expect(state.modalOpen).toBe(true);
  for(tick=1;tick<=10&&listener;tick++){
   if(delivered)state.modalOpen=false;
   listener();
  }
  expect(await pending).toBe(true);
  expect(events).toEqual([modalInterface===3559?'acceptCharacterDesign':'closeModal','flush','observe']);
  expect(queued).toBe(false);expect(listener).toBeUndefined();
 }
});

test('modal diagnostics separate dispatch refusal, fallback selection and absent observed closure without changing cleanup',async()=>{
 const rows:any[]=[];
 const log=spyOn(console,'log').mockImplementation((line:unknown)=>{
  if(typeof line==='string'&&line.startsWith('RECOVERY_MODAL '))rows.push(JSON.parse(line.slice('RECOVERY_MODAL '.length)));
 });
 try{
  for(const mode of ['refused','fallback','unclosed','closed','threw'] as const){
   rows.length=0;
   const state={inGame:true,modalOpen:true,modalInterface:3559};
   let ticks=0,listener:(()=>void)|undefined,calls=0;
   const original=Error('PASSWORD=secret');
   const client={mainModalId:3559,interfaces:{list:[{clientCode:326,layerId:100},{clientCode:326,layerId:mode==='fallback'?200:3559}]},password:'secret'};
   const session={client,sdk:{getState:()=>state},tick:()=>ticks,
    onTick:(cb:()=>void)=>{listener=cb;return()=>{listener=undefined;};},
    direct:async(action:unknown)=>{calls++;expect(action).toEqual({type:'acceptCharacterDesign'});
     if(mode==='threw')throw original;
     return {success:mode!=='refused',message:'PASSWORD=secret',extra:client};},
   } as unknown as Session;
   const pending=recoveryCloseModal(session,20);
   if(mode==='threw'){
    await expect(pending).rejects.toBe(original);
    expect(rows.at(-1).phase).toBe('dispatch-threw');expect(listener).toBeUndefined();
   }else{
    await Promise.resolve();expect(listener).toBeDefined();
    // A true action result and a modal-matched button still do not prove closure.
    expect(rows.find(r=>r.phase==='dispatch-returned')).toMatchObject({success:mode!=='refused',modalOpen:true});
    for(let i=1;i<=10;i++){
     if(mode==='closed'&&i===2){state.modalOpen=false;client.mainModalId=-1;}
     ticks++;listener?.();
    }
    expect(await pending).toBe(mode==='closed');
    expect(rows.at(-1)).toMatchObject({phase:'finished',closed:mode==='closed'});
    expect(listener).toBeUndefined();
   }
   expect(calls).toBe(1);
   expect(rows[0]).toMatchObject({phase:'before-dispatch',modalInterface:3559,clientModal:3559,
    candidates:[{id:0,layerId:100},{id:1,layerId:mode==='fallback'?200:3559}],
    predictedAccept:mode==='fallback'?0:1,selection:mode==='fallback'?'fallback':'modal'});
   expect(JSON.stringify(rows)).not.toContain('secret');
  }
 }finally{log.mockRestore();}
});

test('modal wire trace records queued design and accept payloads and later server opcodes, then restores dispatch',async()=>{
 const rows:any[]=[];
 const log=spyOn(console,'log').mockImplementation((line:unknown)=>{
  if(typeof line==='string'&&line.startsWith('RECOVERY_MODAL '))rows.push(JSON.parse(line.slice('RECOVERY_MODAL '.length)));
 });
 try{
  for(const closes of [false,true]){
   rows.length=0;
   const state={inGame:true,modalOpen:true,modalInterface:3559};
   let ticks=0,listener:(()=>void)|undefined,activations=0;
   const out={data:new Uint8Array(64),pos:3};
   class Lite{activate(){activations++;}}
   const client=Object.assign(new Lite(),{mainModalId:3559,interfaces:{list:[]},out,packetsReceived:10,ptype0:0,
    designGender:true,designKits:[0,0,0,0,0,0,0],designColours:[0,0,0,0,0]});
   const session={client,sdk:{getState:()=>state},tick:()=>ticks,
    onTick:(cb:()=>void)=>{listener=cb;return()=>{listener=undefined;};},
    direct:async()=>{
     // Encoded opcode, gender, seven kits, five colours, encoded opcode, button id 3651.
     out.data.set([200,client.designGender?0:1,...client.designKits,...client.designColours,201,3651>>8,3651&255],out.pos);out.pos+=17;
     return {success:true};},
   } as unknown as Session;
   const pending=recoveryCloseModal(session,20);
   await Promise.resolve();
   for(let i=1;i<=10;i++){
    ticks++;
    if(i===2){client.packetsReceived++;client.ptype0=closes?23:119;client.activate();client.activate();}
    if(i===2&&closes)state.modalOpen=false;
    listener?.();
   }
   expect(await pending).toBe(closes);
   expect(rows[0].design).toEqual({gender:true,kits:[0,0,0,0,0,0,0],colours:[0,0,0,0,0]});
   expect(rows.find(r=>r.phase==='design-prepared').design).toEqual({gender:true,kits:[0,10,18,26,33,36,42],colours:[0,0,0,0,0]});
   expect(rows.find(r=>r.phase==='dispatch-returned').outgoing).toEqual({length:17,gender:0,kits:[0,10,18,26,33,36,42],colours:[0,0,0,0,0],button:3651});
   // One received packet is recorded once, even when the client activates again for an action.
   expect(rows.at(-1).incoming).toEqual([{tick:2,opcode:closes?23:119,ifClose:closes,ifOpenMain:!closes}]);
   expect(activations).toBe(2);
   expect(Object.prototype.hasOwnProperty.call(client,'activate')).toBe(false);
  }
 }finally{log.mockRestore();}
});

test('tutorial recovery repairs the zero-kit initialization using enabled pinned body parts and colour bounds, preserving valid designs',async()=>{
 const content=join(import.meta.dir,'../../../vendor/rs-sdk/server');
 const ids=new Map(readFileSync(join(content,'content/pack/idk.pack'),'utf8').trim().split(/\r?\n/).map(row=>{
  const [id,name]=row.split('=');return [name,Number(id)] as const;
 }));
 const parts=['hair','jaw','torso','arms','hands','legs','feet'];
 const allowed=(gender:boolean)=>{
  const sex=gender?'man':'woman',groups=parts.map(()=>[] as number[]);
  const raw=readFileSync(join(content,`content/scripts/player/configs/${sex}.idk`),'utf8');
  for(const block of raw.split('[').slice(1)){
   const name=block.slice(0,block.indexOf(']')),type=block.match(/^type=(.+)\r?$/m)?.[1]?.trim();
   const part=parts.findIndex(p=>type===`${sex}_${p}`);
   if(part>=0&&!/^disable=yes\r?$/m.test(block))groups[part]!.push(ids.get(name)!);
  }
  if(!gender)groups[1]!.push(-1);
  return groups;
 };
 const palette=readFileSync(join(content,'engine/src/engine/entity/Player.ts'),'utf8')
  .match(/DESIGN_BODY_COLORS: number\[\]\[\] = \[([\s\S]*?)\n    \];/)![1]!;
 const bounds=[...palette.matchAll(/\[([^\]]+)\]/g)].map(m=>m[1]!.split(',').length);
 expect(bounds).toEqual([12,16,16,6,8]);
 const log=spyOn(console,'log').mockImplementation(()=>{});
 try{
  for(const gender of [true,false])for(const mode of ['initial','valid','invalid-colours','disabled'] as const){
   const groups=allowed(gender),valid=groups.map(g=>g.at(-1)!);
   const kits=mode==='initial'?Array(7).fill(0):mode==='disabled'?[9,10,18,32,35,41,44]:valid;
   const colours=mode==='initial'?[0,0,0,0,0]:mode==='invalid-colours'?[12,16,-1,6,8]:bounds.map(n=>n-1);
   const client={designGender:gender,designKits:[...kits],designColours:[...colours]};
   const originalKits=client.designKits,originalColours=client.designColours;
   const state={inGame:true,modalOpen:true,modalInterface:3559};
   let tick=0,listener:(()=>void)|undefined;
   const session={client,sdk:{getState:()=>state},tick:()=>tick,
    onTick:(cb:()=>void)=>{listener=cb;return()=>{listener=undefined;};},
    direct:async(action:unknown)=>{
     expect(action).toEqual({type:'acceptCharacterDesign'});
     expect(client.designGender).toBe(gender);
     expect(client.designKits.every((id,i)=>groups[i]!.includes(id))).toBe(true);
     expect(client.designColours.every((n,i)=>Number.isInteger(n)&&n>=0&&n<bounds[i]!)).toBe(true);
     for(let i=0;i<7;i++)if(groups[i]!.includes(kits[i]!))expect(client.designKits[i]).toBe(kits[i]);
     if(mode==='valid'){expect(client.designKits).toBe(originalKits);expect(client.designColours).toBe(originalColours);}
     if(mode==='invalid-colours')expect(client.designColours).toEqual([0,0,0,0,0]);
     return {success:true};},
   } as unknown as Session;
   const pending=recoveryCloseModal(session);await Promise.resolve();
   // A valid packet alone is not modal closure.
   expect(listener).toBeDefined();tick=1;state.modalOpen=false;listener?.();
   expect(await pending).toBe(true);
  }
 }finally{log.mockRestore();}
});

test('child readiness waits for delayed publication, but absent, crossed and late bindings refuse without consumption',async()=>{
 const base=mkdtempSync(join(tmpdir(),'recovery-handshake-'));
 const r={schema:'session-recovery/1',kind:'session-recovery',account:'Rod',server:'localhost:8890',runId:'handshake',nonce:'one',endedAt:1,source:'a'.repeat(64)} as ControlledRecoveryRequest;
 const paths=recoveryPermitPaths(r,base),bound={pid:process.pid,nonce:r.nonce,runId:r.runId};
 const signal={...bound,source:r.source};
 const stream=(value:unknown)=>new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(JSON.stringify(value)));c.close();}});
 const permit=(remaining=10000)=>writeFileSync(paths.permit,JSON.stringify({issuedAt:Date.now()-10000+remaining}));
 mkdirSync(join(paths.child,'..'),{recursive:true});
 try{
  permit();let published=false;
  const delayed=new ReadableStream<Uint8Array>({start(c){setTimeout(()=>{
   writeFileSync(paths.child,JSON.stringify(bound));published=true;
   c.enqueue(new TextEncoder().encode(JSON.stringify(signal)));c.close();
  },1100);}});
  await waitForRecoveryChildBinding(r,base,delayed);expect(published).toBe(true);
  expect(existsSync(paths.used)).toBe(false);
  for(const field of ['pid','nonce','runId','source'] as const){
   permit();await expect(waitForRecoveryChildBinding(r,base,stream({...signal,[field]:field==='pid'?process.pid+1:'other'}))).rejects.toThrow('identity changed');
  }
  for(const field of ['pid','nonce','runId'] as const){
   permit();writeFileSync(paths.child,JSON.stringify({...bound,[field]:field==='pid'?process.pid+1:'other'}));
   await expect(waitForRecoveryChildBinding(r,base,stream(signal))).rejects.toThrow('identity changed');
  }
  fs.unlinkSync(paths.child);permit();
  await expect(waitForRecoveryChildBinding(r,base,stream(signal))).rejects.toThrow('not bound');
  permit(30);let cancelled=false;
  const silent=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
  await expect(waitForRecoveryChildBinding(r,base,silent)).rejects.toThrow('not bound');expect(cancelled).toBe(true);
  permit();await expect(waitForRecoveryChildBinding(r,base,new ReadableStream({start(c){c.close();}}))).rejects.toThrow('not bound');
  permit(0);await expect(waitForRecoveryChildBinding(r,base,stream(signal))).rejects.toThrow('admission expired');
  expect(existsSync(paths.used)).toBe(false);expect(existsSync(paths.output)).toBe(false);
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('native pre-child observation separates actual memory, capacity, release and launcher authority refusals hidden by dispatch',()=>{
 for(const fault of ['memory','maxBots','release','authority'] as const){
  const base=mkdtempSync(join(tmpdir(),'recovery-boundary-')),events:RecoveryBoundary[]=[];
  const r:ControlledRecoveryRequest={schema:'session-recovery/1',kind:'session-recovery',account:'Rod',server:'localhost:8890',runId:'native-boundary',nonce:'one',endedAt:100,source:'a'.repeat(64),
   qualification:{delivery:{path:'unit-only',sha256:'0'.repeat(64)},proof:{path:'unit-only',sha256:'0'.repeat(64)}}};
  const coordinator=join(base,'.practice/coordinator'),channel=join(base,'.practice/swarm-repair.json'),pin=process.env.WORKER_RELEASE;
  mkdirSync(coordinator,{recursive:true});
  // The actual launcher must refuse this invalid controller before source/task checks or child issuance.
  writeFileSync(join(coordinator,'swarm-owner.json'),JSON.stringify({pid:0,nonce:'invalid-owner',source:r.source}));
  const input={account:r.account,active:[],running:fault==='maxBots'?17:0,external:0,pending:0,freeGB:fault==='memory'?FREE_FLOOR_GB:PRACTICE_STARTUP_GB+32,minFreeGB:FREE_FLOOR_GB,maxBots:17};
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
test('partial owner waits past receipt publication for the stalled handshake and retains its first read, with bounded listener cleanup',async()=>{
 const root=mkdtempSync(join(tmpdir(),'partial-handshake-')),account='Rod',server='localhost:8899',events=new EventEmitter();
 const latest=join(accountDir(account,server,root),'latest.json');
 try{
  const attempt=beginSessionAttempt({account,server},{root}),pointer=readFileSync(latest);rmSync(latest);
  const interval=observePartialOwner(account,server,root,process.pid);
  expect(interval.proof).toMatchObject({state:'invalid',reason:'attempts without a latest pointer'});
  let reads=0;
  const pending=afterStalledConnection(events,async()=>({pid:process.pid})).then(owner=>{
   reads++;return observePartialOwner(account,server,root,owner.pid);
  });
  await Promise.resolve();
  expect(reads).toBe(0);expect(events.listenerCount('stalled')).toBe(1);
  writeFileSync(latest,pointer);await Promise.resolve();expect(reads).toBe(0);
  events.emit('stalled');const selected=await pending;
  expect(reads).toBe(1);expect(selected.proof).toMatchObject({state:'held',attemptId:attempt.attemptId});
  expect(Object.values(selected.checks).every(Boolean)).toBe(true);expect(events.listenerCount('stalled')).toBe(0);
  expect(interval.proof.state).toBe('invalid');
  // A handshake is a boundary, not permission to retry invalid evidence into a pass.
  const invalid=afterStalledConnection(events,async()=>process.pid).then(pid=>observePartialOwner(account,server,root,pid));
  rmSync(latest);events.emit('stalled');const first=await invalid;
  writeFileSync(latest,pointer);events.emit('stalled');expect(first.proof.state).toBe('invalid');
  await expect(afterStalledConnection(events,async()=>process.pid,10)).rejects.toThrow('stalled connection acceptance timeout');
  expect(events.listenerCount('stalled')).toBe(0);
  const failure=Error('owner failed');
  await expect(afterStalledConnection(events,async()=>{throw failure;})).rejects.toBe(failure);
  expect(events.listenerCount('stalled')).toBe(0);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('native partial observation follows the relay acceptance and keeps the first result',()=>{
 const text=readFileSync(join(import.meta.dir,'../src/session-recovery-proof.ts'),'utf8');
 expect(text).toContain("if(ws.data.stalled){stalled.emit('stalled');return;}");
 expect(text).toContain("afterStalledConnection(relay.stalled,()=>owner(P,dir,'partial',lifeRoot))");
 expect(text).toContain('observations:[selected],selectedIndex:0');
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
test('the world button observer is self-contained, keeps dispatch results and records protected refusal and decoded opcodes',()=>{
 const world={currentTick:7},protIf={id:86},protIdk={id:27};
 class Component{static rows:Record<number,any>={3651:{buttonType:1,rootLayer:3559},3559:{overlay:false}};static get(id:number){return Component.rows[id];}}
 const repository={getDecoder(prot:any){return {prot};}};
 class NetworkPlayer{
  username='Flrcv1';modalMain=3559;modalState=1;protect=true;delayed=false;allowDesign=true;resumeButtons:number[]=[];activeScript=null;client={available:17};userLimit=0;clientLimit=0;restrictedLimit=0;
  isComponentVisible(com:any){return com.rootLayer===this.modalMain;}busy(){return true;}
  runScript(_s:any,protect=false,force=false){return !force&&protect&&(this.protect||this.delayed)?-1:0;}
  decodeIn(){repository.getDecoder(protIdk);repository.getDecoder(protIf);this.client.available=0;return true;}
 }
 class IfButtonHandler{handle(message:any,player:any){player.runScript({script:{name:'[if_button,player_kit:accept]'}},true);return message.com===3651;}}
 class IdkSaveDesignHandler{handle(_m:any,player:any){if(!player.allowDesign)throw Error('kept');return true;}}
 const lines:string[]=[];
 new Function('m','write','('+installButtonObserver.toString()+')(m,write);')({NetworkPlayer,IfButtonHandler,IdkSaveDesignHandler,Component,Repository:repository,World:world},(line:string)=>lines.push(line));
 const player=new NetworkPlayer();
 expect(player.decodeIn()).toBe(true);expect(repository.getDecoder(protIf)).toEqual({prot:protIf});
 expect(new IdkSaveDesignHandler().handle({gender:0,idkit:[9,9]},player)).toBe(true);
 expect(new IfButtonHandler().handle({com:3651},player)).toBe(true);
 player.allowDesign=false;expect(()=>new IdkSaveDesignHandler().handle({gender:0},player)).toThrow('kept');
 const trace=buttonTraceFor(lines.join('\n')+'\nBUTTON_HANDLE {bad',player.username);
 expect(trace.ready).toBe(true);expect(trace.malformed).toBe(1);
 expect(trace.rows.map((r:any)=>r.kind)).toEqual(['BUTTON_LIVE','BUTTON_DECODE','BUTTON_DESIGN','BUTTON_HANDLE','BUTTON_DESIGN']);
 expect(trace.rows[1]).toMatchObject({tick:7,before:17,after:0,packets:[27,86],modalMain:3559});
 expect(trace.rows[3]).toMatchObject({com:3651,buttonType:1,rootLayer:3559,rootOverlay:false,visible:true,protect:true,busy:true,result:true,
  runs:[{script:'[if_button,player_kit:accept]',protectRequested:true,force:false,protect:true,delayed:false,state:-1}],modalMainAfter:3559});
 expect(trace.rows[4]).toMatchObject({allowDesign:false,result:'threw'});
 expect(lines.join('\n')).not.toContain('idkit');
});

test('the world observer times buffered messages and empty decode reads only while the modal is open',()=>{
 const world={currentTick:20};let clock=1000;
 class ClientSocket{player:any=null;state=1;available=0;buffer(data:Uint8Array){this.available+=data.length;}}
 class WSClientSocket extends ClientSocket{}
 class NetworkPlayer{username='Flrcv1';modalMain=3559;client=new WSClientSocket();decodeIn(){this.client.available=0;return true;}}
 const lines:string[]=[];
 new Function('m','write','now','('+installButtonObserver.toString()+')(m,write,now);')({NetworkPlayer,IfButtonHandler:class{handle(){return true;}},
  IdkSaveDesignHandler:class{handle(){return true;}},Component:{get:()=>null},Repository:{getDecoder:()=>null},World:world,WSClientSocket},(line:string)=>lines.push(line),()=>clock);
 const player=new NetworkPlayer();player.client.player=player;
 const loose=new WSClientSocket();loose.buffer(new Uint8Array(5));
 player.decodeIn();
 clock=1150;world.currentTick=21;player.client.buffer(new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17]));
 expect(player.client.available).toBe(17);
 player.modalMain=-1;clock=1300;player.client.buffer(new Uint8Array(3));player.decodeIn();
 const trace=buttonTraceFor(lines.join('\n'),player.username);
 expect(trace.runtime).toMatchObject({wire:true});
 expect(trace.rows.map((r:any)=>r.kind)).toEqual(['BUTTON_LIVE','BUTTON_POLL','BUTTON_WIRE']);
 expect(trace.rows[1]).toMatchObject({tick:20,at:1000,before:0,modalMain:3559});
 expect(trace.rows[2]).toMatchObject({tick:21,at:1150,length:17,before:0,after:17,state:1});
 expect(lines.join('\n')).not.toMatch(/"data"|\[1,2,3/);
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
test('owner logout observation waits for a delayed auth reply but refuses an absent or failed acknowledgement',async()=>{
 const o={since:40,releaseAt:600,ownerLoginReplyAt:21,ownerAttempt:'a2',latestAttemptBeforeRelease:'a2'};
 const before=warmLog(500,3,[]),pending=before+'\n'+request(610,'cleanup','rod','player_logout');
 const complete=pending+'\n'+reply(611,'cleanup');
 const run=(logs:string[])=>{
  let elapsed=0,reads=0;
  const result=waitOwnerAuthLogout(()=>logs[Math.min(reads++,logs.length-1)]!,'rod',o,
   {timeoutMs:100,now:()=>elapsed,pause:async ms=>{elapsed+=ms;}});
  return {result,reads:()=>reads,elapsed:()=>elapsed};
 };
 const delayed=run([before,pending,complete]);
 expect(ownerSessionEvidence(await delayed.result,'rod',o).ok).toBe(true);
 expect(delayed.reads()).toBe(3);
 const absent=run([pending]);
 await expect(absent.result).rejects.toThrow('owner auth logout acknowledgement timeout');
 expect(absent.elapsed()).toBe(100);
 await expect(run([before]).result).rejects.toThrow('owner auth logout acknowledgement timeout');
 await expect(run([pending+'\n'+reply(611,'cleanup',1)]).result).rejects.toThrow('owner auth logout acknowledgement failed');
 const duplicate=complete+'\n'+request(612,'extra','rod','player_logout')+'\n'+reply(613,'extra');
 expect(ownerSessionEvidence(await run([duplicate]).result,'rod',o).ok).toBe(false);
 expect(ownerSessionEvidence(await run([complete]).result,'rod',{...o,latestAttemptBeforeRelease:'other'}).ok).toBe(false);
 expect(ownerSessionEvidence(await run([complete]).result,'rod',{...o,ownerLoginReplyAt:4}).ok).toBe(false);
 const takeover=complete+'\n'+request(614,'late-recovery')+'\n'+reply(615,'late-recovery');
 expect(ownerSessionEvidence(await run([takeover]).result,'rod',o).ok).toBe(false);
});

test('orphan recovery is measured after the bound window from the latest prior login',()=>{
 const log=(at:number)=>[...authHead(),request(3,'owner'),reply(4,'owner'),request(at,'recovery'),reply(at+1,'recovery')].join('\n');
 expect(loginAfterTakeoverWindow(log(1004),'rod',100,1000)).toEqual({ok:true,gapMs:1000});
 expect(loginAfterTakeoverWindow(log(1003),'rod',100,1000)).toEqual({ok:false,gapMs:999});
 expect(loginAfterTakeoverWindow([...authHead(),request(1004,'recovery'),reply(1005,'recovery')].join('\n'),'rod',100,1000)).toEqual({ok:false,gapMs:null});
 expect(loginAfterTakeoverWindow('AUTH_REPLY {','rod',100,1000)).toEqual({ok:false,gapMs:null});
});
test('orphan recovery enters only after the server acknowledges the killed owner logout, not after the takeover window alone',()=>{
 // Retained failure: .practice/deliveries/magic-order-1793350899339-Ejxpem/cases/orphan. The recovery connected at
 // 1793351104965, the world flushed the dead owner at 1793351105987, and the login was refused 'Account already logged in'.
 const killedAt=1793351044000,a='flrcvxctch18';
 const owner=[request(1793351040000,'owner',a),reply(1793351040100,'owner')];
 const end=[request(1793351105987,'id_59682722-758b-4e65-9c3a-dfdd0608a4fe',a,'player_logout'),reply(1793351105990,'id_59682722-758b-4e65-9c3a-dfdd0608a4fe')];
 // The takeover window from the owner login is already open, but no server-side end exists yet.
 expect(loginAfterTakeoverWindow([...authHead(),...owner,request(1793351104965,'r',a),reply(1793351104966,'r')].join('\n'),a,1793351104000,TAKEOVER_WINDOW_MS).ok).toBe(true);
 expect(orphanServerEnd([...authHead(),...owner].join('\n'),a,killedAt)).toEqual({ok:false,at:null});
 expect(orphanServerEnd([...authHead(),...owner,...end].join('\n'),a,killedAt)).toEqual({ok:true,at:1793351105990});
 // A logout before the kill, a refused logout, a second logout or a login after the kill is not the orphan end.
 expect(orphanServerEnd([...authHead(),...owner,...end].join('\n'),a,1793351106000).ok).toBe(false);
 expect(orphanServerEnd([...authHead(),...owner,end[0]!,reply(1793351105990,'id_59682722-758b-4e65-9c3a-dfdd0608a4fe',1)].join('\n'),a,killedAt).ok).toBe(false);
 expect(orphanServerEnd([...authHead(),...owner,...end,request(1793351106000,'again',a,'player_logout'),reply(1793351106001,'again')].join('\n'),a,killedAt).ok).toBe(false);
 expect(orphanServerEnd([...authHead(),...owner,request(1793351105000,'early',a),reply(1793351105001,'early',3),...end].join('\n'),a,killedAt).ok).toBe(false);
 expect(orphanServerEnd([...authHead(),...owner,request(1793351105987,'x','other','player_logout'),reply(1793351105990,'x')].join('\n'),a,killedAt).ok).toBe(false);
 expect(orphanServerEnd('AUTH_REPLY {',a,killedAt)).toEqual({ok:false,at:null});
 const text=readFileSync(join(import.meta.dir,'../src/session-recovery-proof.ts'),'utf8');
 expect(text).toMatch(/const killedAt=Date\.now\(\);await killTree\(o\.p\.pid\);[\s\S]{0,500}if\(!end\.ok\)throw Error\('orphan server-side logout not observed'\);[\s\S]{0,600}c=await positive\('orphan'/);
});
test('orphan recovery final logout is the recovery session logout, never the preceding cleanup logout',()=>{
 // Retained trace: .practice/deliveries/magic-order-1793338323363-1c1xyl/cases/orphan/auth-replies.json
 const a='flrcvxvo2h18',r=(at:number,requestAt:number,replyTo:string,type:'player_login'|'player_logout',response=0,connection=1)=>({at,requestAt,connection,replyTo,type,account:a,response});
 const cleanup=r(1793338533120,1793338533117,'id_b5db4e33-51d6-4d0e-af83-2780344e198d','player_logout');
 const login=r(1793338534020,1793338534018,'id_55a04879-1756-46db-a5c5-b78c1e055e8c','player_login');
 const final=r(1793338536423,1793338536420,'id_8817d5f3-cbcd-4b99-8853-9be6c2313b4f','player_logout');
 expect(recoverySessionAuth([cleanup,login,final],'FlrcvxVo2h18')).toEqual({loginAcknowledged:true,logoutAcknowledged:true});
 expect(recoverySessionAuth([cleanup,login],a)).toEqual({loginAcknowledged:true,logoutAcknowledged:false});
 expect(recoverySessionAuth([login,cleanup],a).logoutAcknowledged).toBe(false);
 expect(recoverySessionAuth([cleanup,login,{...final,response:1}],a).logoutAcknowledged).toBe(false);
 expect(recoverySessionAuth([cleanup,login,{...final,connection:2}],a).logoutAcknowledged).toBe(false);
 expect(recoverySessionAuth([cleanup,login,{...final,account:'other'}],a).logoutAcknowledged).toBe(false);
 expect(recoverySessionAuth([cleanup,login,final,{...final,replyTo:'again',at:final.at+5,requestAt:final.at+2}],a).logoutAcknowledged).toBe(false);
 expect(recoverySessionAuth([cleanup,login,{...login,replyTo:'second',at:login.at+9,requestAt:login.at+5},final],a)).toEqual({loginAcknowledged:false,logoutAcknowledged:false});
 expect(recoverySessionAuth([cleanup],a)).toEqual({loginAcknowledged:false,logoutAcknowledged:false});
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

test('isolated recovery proof needs no publish lock and still rejects runtime or runner drift',()=>{
 const text=readFileSync(join(import.meta.dir,'../src/session-recovery-proof.ts'),'utf8');
 expect(text).not.toContain('build-lock.json');
 const predicate=text.match(/const proof=\{ok:([^\r\n]+),/)!;
 expect(predicate).not.toBeNull();
 const expression=predicate[1]!.replaceAll('(c:any)','(c)');
 const evaluate=new Function('cases','checks','source','workerSourceRevision','runnerSha256','hash','runner',`return (${expression});`);
 const valid=(revision:string,runnerHash:string)=>evaluate([{ok:true}],{offline:{ok:true}},'runtime',()=>revision,'runner',()=>runnerHash,'runner.ts');
 expect(valid('runtime','runner')).toBe(true);
 expect(valid('changed','runner')).toBe(false);
 expect(valid('runtime','changed')).toBe(false);
 expect(text).toContain("openSync(lock,'wx')");
 expect(text).toContain('closeSync(fd);unlinkSync(lock)');
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
test('the orphan child reading mid-heartbeat sees a complete fleet view, never fleet-malformed',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-publish-')),path=join(dir,'.practice','swarm-state.json'),account='flrcvxxhah18';
 const view=(at:number)=>({at,controllerPid:process.pid,jobs:[{account,state:'disabled'}]});
 const childRead=(at:number)=>{try{assertFleetResolved(path,account,process.pid,()=>at);return 'resolved';}catch(e){return String((e as Error).message).replace(/^recovery fleet ownership unresolved: /,'');}};
 try{
  publishControlFile(path,view(1793340900899));
  // Retained failure: a direct overwrite truncates first; the child read in that gap and held with fleet-malformed.
  writeFileSync(path,'');expect(childRead(1793340900900)).toBe('malformed');
  publishControlFile(path,view(1793340900899));
  const seen:string[]=[];let busy=2;
  publishControlFile(path,view(1793340901899),{
   write:(p,d)=>{expect(p).not.toBe(path);writeFileSync(p,d,{flag:'wx'});seen.push(childRead(1793340901900));},
   rename:(from,to)=>{seen.push(childRead(1793340901900));if(busy-->0)throw Object.assign(Error('busy'),{code:'EPERM'});fs.renameSync(from,to);},
   pause:()=>{}});
  expect(seen).toEqual(['resolved','resolved','resolved','resolved']);
  expect(JSON.parse(readFileSync(path,'utf8')).at).toBe(1793340901899);
  // A persistent refusal keeps the old complete view and removes its private temporary file.
  expect(()=>publishControlFile(path,view(1793340902899),{write:(p,d)=>writeFileSync(p,d,{flag:'wx'}),rename:()=>{throw Object.assign(Error('denied'),{code:'EACCES'});},pause:()=>{}})).toThrow('denied');
  expect(JSON.parse(readFileSync(path,'utf8')).at).toBe(1793340901899);
  expect(fs.readdirSync(join(dir,'.practice'))).toEqual(['swarm-state.json']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
