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
  writeFileSync(join(root,'.practice/status/legacy.json'),JSON.stringify({server:'rs-sdk-demo.fly.dev',at:Date.now(),result:''}));
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

test('live cohort refuses a fresh legacy or different worker, but allows matching or completed sessions',()=>{
 const pin='a'.repeat(64),base={server:'rs-sdk-demo.fly.dev',at:100,result:''};
 for(const workRevision of [undefined,'b'.repeat(64)])expect(()=>assertCompatibleWorkers(pin,base.server,[{...base,workRevision}],101)).toThrow('coordinated rollout');
 for(const row of [{...base,workRevision:pin},{...base,result:'ok'},{...base,server:'localhost:8888'}])
  expect(()=>assertCompatibleWorkers(pin,base.server,[row],101)).not.toThrow();
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
