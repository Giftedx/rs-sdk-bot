import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workerSourceRoots,workerSourceRevision,assertWorkerRelease,assertCompatibleWorkers,assertLiveWorkerRelease} from '../src/worker-release';

test('release pin covers helper edits, additions and deletion; notes and receipts do not change it',()=>{
 const root=mkdtempSync(join(tmpdir(),'worker-release-'));
 try{
  for(const dir of [...workerSourceRoots,'.practice/status','research'])mkdirSync(join(root,dir),{recursive:true});
  for(const f of ['package.json','bun.lock','tsconfig.json','scripts/worker.ts','packages/shared.ts'])writeFileSync(join(root,f),'original');
  const pin=workerSourceRevision(root),env={WORKER_RELEASE:pin};
  expect(assertWorkerRelease(env,root)).toBe(pin);
  expect(()=>assertLiveWorkerRelease('rs-sdk-demo.fly.dev',env,root)).not.toThrow();
  mkdirSync(join(root,'.practice/coordinator'),{recursive:true});writeFileSync(join(root,'.practice/coordinator/build-lock.json'),'{}');
  expect(()=>assertLiveWorkerRelease('rs-sdk-demo.fly.dev',env,root)).toThrow('coordinator build in progress');
  expect(()=>assertLiveWorkerRelease('localhost:8888',{},root)).not.toThrow();
  rmSync(join(root,'.practice/coordinator/build-lock.json'));
  // A standing peer on another release does not hold a live start; a coordinator peer on another release does.
  writeFileSync(join(root,'.practice/status/legacy.json'),JSON.stringify({server:'rs-sdk-demo.fly.dev',at:Date.now(),result:''}));
  expect(()=>assertLiveWorkerRelease('rs-sdk-demo.fly.dev',env,root)).not.toThrow();
  writeFileSync(join(root,'.practice/status/legacy.json'),JSON.stringify({server:'rs-sdk-demo.fly.dev',at:Date.now(),result:'',coordinatorRunId:'task-legacy'}));
  expect(()=>assertLiveWorkerRelease('rs-sdk-demo.fly.dev',env,root)).toThrow('coordinated rollout');
  rmSync(join(root,'.practice/status/legacy.json'));
  expect(()=>assertWorkerRelease({},root)).toThrow('pin missing');
  writeFileSync(join(root,'research/notes.md'),'edit');writeFileSync(join(root,'.practice/status/bot.json'),'{}');
  expect(assertWorkerRelease(env,root)).toBe(pin);
  for(const f of ['scripts/worker.ts','packages/shared.ts','vendor/rs-sdk/sdk/helper.ts']){
   writeFileSync(join(root,f),'changed');expect(()=>assertWorkerRelease(env,root)).toThrow('source changed');
   if(f.endsWith('helper.ts'))rmSync(join(root,f));else writeFileSync(join(root,f),'original');
  }
  rmSync(join(root,'packages/shared.ts'));expect(()=>assertWorkerRelease(env,root)).toThrow('source changed');
  expect(()=>assertLiveWorkerRelease('localhost:8888',{},root)).not.toThrow();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('live cohort refuses a fresh coordinator peer on another release, but allows standing, matching or completed sessions',()=>{
 const pin='a'.repeat(64),base={server:'rs-sdk-demo.fly.dev',at:100,result:'',coordinatorRunId:'task-1'};
 for(const workRevision of [undefined,'b'.repeat(64)])expect(()=>assertCompatibleWorkers(pin,base.server,[{...base,workRevision}],101)).toThrow('coordinated rollout');
 // A standing worker carries the release it started on; it never holds a coordinator run back.
 for(const row of [{...base,workRevision:pin},{...base,result:'ok'},{...base,server:'localhost:8888'},{...base,coordinatorRunId:null,workRevision:'b'.repeat(64)},{...base,coordinatorRunId:undefined,workRevision:undefined}])
  expect(()=>assertCompatibleWorkers(pin,base.server,[row],101)).not.toThrow();
 // A stale heartbeat still refuses, standing or not.
 expect(()=>assertCompatibleWorkers(pin,base.server,[{...base,coordinatorRunId:null,workRevision:pin,at:60}],100001)).toThrow('peer state unknown');
});

test('missing, future or stale heartbeats cannot prove an unfinished peer has left',()=>{
 const pin='a'.repeat(64);
 for(const at of [undefined,NaN,0,31002,1001,1])expect(()=>assertCompatibleWorkers(pin,'live',[{server:'live',at,result:'',workRevision:pin}],31001)).toThrow('peer state unknown');
 expect(()=>assertCompatibleWorkers(pin,'live',[{server:'live',at:1,result:'ok',workRevision:pin}],31001)).not.toThrow();
});

test('dashboard and authoring edits do not invalidate a worker release',()=>{
 const root=mkdtempSync(join(tmpdir(),'worker-release-'));
 try{
  for(const dir of [...workerSourceRoots,'packages/dashboard','packages/router/src'])mkdirSync(join(root,dir),{recursive:true});
  for(const f of ['package.json','bun.lock','tsconfig.json','scripts/worker.ts'])writeFileSync(join(root,f),'original');
  const pin=workerSourceRevision(root);
  writeFileSync(join(root,'packages/dashboard/server.ts'),'dashboard edit');
  writeFileSync(join(root,'packages/router/src/author.ts'),'authoring edit');
  expect(workerSourceRevision(root)).toBe(pin);
  writeFileSync(join(root,'scripts/worker.ts'),"import '../packages/dashboard/server';");
  expect(()=>workerSourceRevision(root)).toThrow('runtime imports non-runtime');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('a standing owner job logs in on changed source; an ordinary live worker still needs the pin', async () => {
    const { assertLiveWorkerRelease } = await import('../src/worker-release');
    expect(() => assertLiveWorkerRelease('rs-sdk-demo.fly.dev', { STANDING: '1' })).not.toThrow();
    expect(() => assertLiveWorkerRelease('rs-sdk-demo.fly.dev', {})).toThrow('release pin missing');
});

test('an empty-result live row is closed only when its own producer lifecycle shows the account offline',async()=>{
 const {closedSessionRow,LOST_SESSION_DROP_MS}=await import('../src/worker-release');
 const {beginSessionAttempt}=await import('../src/session-lifecycle');
 const root=mkdtempSync(join(tmpdir(),'release-rows-')),server='rs-sdk-demo.fly.dev',pin='a'.repeat(64);
 const owner=(pid:number)=>({pid,coordinatorRunId:null,workerRelease:null,script:'test',role:null,participants:null});
 try{
  const start=(account:string,pid:number)=>{const a=beginSessionAttempt({account,server},{root,owner:owner(pid)});a.record('connected');a.record('ready');return a;};
  const done=start('Done',11);done.record('ended','logged-out');
  const later=start('Later',12);const newer=start('Later',13);newer.record('ended','logged-out');
  const dead=start('Dead',14),live=start('Live',15),fresh=start('Fresh',16),gone=start('Gone',17);start('Gone',18);
  const now=1_000_000_000_000,old=now-LOST_SESSION_DROP_MS,row=(a:{account:string;attemptId:string},at=old)=>({name:a.account,server,result:'',at,workRevision:pin,sessionAttemptId:a.attemptId});
  const alive=(pid:number)=>pid===15,closed=(r:any)=>closedSessionRow(r,server,{root},alive,now);
  expect(closed(row(done))).toBe(true);        // its own attempt confirmed logout
  expect(closed(row(later))).toBe(true);       // a newer attempt confirmed logout
  expect(closed(row(dead))).toBe(true);        // owner gone and past the server's lost-session drop
  expect(closed(row(live))).toBe(false);       // owner alive
  expect(closed(row(fresh,now-LOST_SESSION_DROP_MS+1))).toBe(false); // owner gone, inside the drop window
  expect(closed(row(gone))).toBe(false);       // a newer held attempt is not this row
  expect(closed({...row(dead),sessionAttemptId:undefined})).toBe(false);
  expect(closed({...row(done),name:'Nobody'})).toBe(false);
  expect(()=>assertCompatibleWorkers(pin,server,[row(done),row(dead)],now,closed)).not.toThrow();
  expect(()=>assertCompatibleWorkers(pin,server,[row(done),row(live)],now,closed)).toThrow('peer state unknown');
 }finally{rmSync(root,{recursive:true,force:true});}
});
