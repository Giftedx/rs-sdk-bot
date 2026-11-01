import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workerSourceRoots,workerSourceRevision,runtimeTrees,releaseFiles,releaseEntries,workerEntries,capabilityRevision,launchRevision,cachedLaunchRevision,assertWorkerRelease,assertCompatibleWorkers,assertLiveWorkerRelease,standingPeer} from '../src/worker-release';

// A small repository: one worker with a helper and a knowledge read, an unrelated script and data file, the launch
// entries and both runtime trees.
function fixture():string{
 const root=mkdtempSync(join(tmpdir(),'worker-release-'));
 for(const dir of [...runtimeTrees,'.practice/status','research','knowledge','scripts','packages/core/src','packages/practice/src','packages/dashboard'])mkdirSync(join(root,dir),{recursive:true});
 const files:Record<string,string>={'package.json':'{}','bun.lock':'','tsconfig.json':'{}','vendor/rs-sdk/sdk/helper.ts':'export {};','vendor/rs-sdk/server/webclient/src/client.ts':'export {};',
  'scripts/worker.ts':"import {shared} from '../packages/core/src/shared';\nimport {join} from 'node:path';\nexport const npcs=join(import.meta.dir,'..','knowledge','npcs.json');\n",
  'packages/core/src/shared.ts':'export const shared=1;\n','scripts/other.ts':'export const other=1;\n','knowledge/npcs.json':'[]','knowledge/quests.json':'[]',
  'packages/dashboard/server.ts':'export {};','scripts/swarm.ts':'export {};','packages/core/src/session-recovery.ts':'export {};',
  'packages/practice/src/supervise.ts':'export {};','packages/practice/src/supervise-host.ts':"export const host='packages/core/src/host.ts';",'packages/core/src/host.ts':'export {};'};
 for(const [f,text] of Object.entries(files))writeFileSync(join(root,f),text);
 return root;
}

test('release pin covers its closure; notes, receipts and edits elsewhere do not change it',()=>{
 const root=fixture();
 try{
  const pin=capabilityRevision(['scripts/worker.ts'],root),env={WORKER_RELEASE:pin,WORKER_ENTRY:'scripts/worker.ts'};
  expect(assertWorkerRelease(env,root)).toBe(pin);
  expect(()=>assertLiveWorkerRelease('rs-sdk-demo.fly.dev',env,root)).not.toThrow();
  mkdirSync(join(root,'.practice/coordinator'),{recursive:true});writeFileSync(join(root,'.practice/coordinator/build-lock.json'),'{}');
  expect(()=>assertLiveWorkerRelease('rs-sdk-demo.fly.dev',env,root)).toThrow('coordinator build in progress');
  expect(()=>assertLiveWorkerRelease('localhost:8888',{},root)).not.toThrow();
  rmSync(join(root,'.practice/coordinator/build-lock.json'));
  // A standing peer on another release does not hold a live start; a coordinator peer on another release does.
  writeFileSync(join(root,'swarm.json'),JSON.stringify({jobs:[{account:'Fish',script:'scripts/x.ts',standing:true,enabled:true}]}));
  writeFileSync(join(root,'.practice/status/legacy.json'),JSON.stringify({name:'Fish',server:'rs-sdk-demo.fly.dev',at:Date.now(),result:'',workRevision:'b'.repeat(64)}));
  expect(()=>assertLiveWorkerRelease('rs-sdk-demo.fly.dev',env,root)).not.toThrow();
  writeFileSync(join(root,'.practice/status/legacy.json'),JSON.stringify({name:'Manual',server:'rs-sdk-demo.fly.dev',at:Date.now(),result:'',workRevision:'b'.repeat(64)}));
  expect(()=>assertLiveWorkerRelease('rs-sdk-demo.fly.dev',env,root)).toThrow('coordinated rollout');
  writeFileSync(join(root,'.practice/status/legacy.json'),JSON.stringify({name:'Fish',server:'rs-sdk-demo.fly.dev',at:Date.now(),result:'',coordinatorRunId:'task-legacy'}));
  expect(()=>assertLiveWorkerRelease('rs-sdk-demo.fly.dev',env,root)).toThrow('coordinated rollout');
  rmSync(join(root,'.practice/status/legacy.json'));
  expect(()=>assertWorkerRelease({},root)).toThrow('pin missing');
  // Edits outside the closure: another script, unread data, the dashboard, notes, receipts.
  for(const f of ['research/notes.md','scripts/other.ts','knowledge/quests.json','packages/dashboard/server.ts','scripts/new.ts'])writeFileSync(join(root,f),'edit');
  writeFileSync(join(root,'.practice/status/bot.json'),'{}');
  expect(capabilityRevision(['scripts/worker.ts'],root)).toBe(pin);
  expect(()=>assertLiveWorkerRelease('rs-sdk-demo.fly.dev',env,root)).not.toThrow();
  // Edits inside: the entry, its helper, the data file it reads, a launcher and what it names, a runtime tree.
  for(const f of ['scripts/worker.ts','packages/core/src/shared.ts','knowledge/npcs.json','packages/practice/src/supervise.ts','packages/core/src/host.ts','vendor/rs-sdk/sdk/helper.ts']){
   const before=readFileSync(join(root,f),'utf8');
   writeFileSync(join(root,f),before+'\n// changed');expect(()=>assertWorkerRelease(env,root)).toThrow('source changed');
   writeFileSync(join(root,f),before);expect(assertWorkerRelease(env,root)).toBe(pin);
  }
  writeFileSync(join(root,'vendor/rs-sdk/sdk/added.ts'),'export {};');expect(()=>assertWorkerRelease(env,root)).toThrow('source changed');
  rmSync(join(root,'vendor/rs-sdk/sdk/added.ts'));
  rmSync(join(root,'packages/core/src/shared.ts'));expect(()=>assertWorkerRelease(env,root)).toThrow('release import unresolved');
  expect(()=>assertLiveWorkerRelease('localhost:8888',{},root)).not.toThrow();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('an import added to the closure changes the release, and then the imported file does too',()=>{
 const root=fixture();
 try{
  const pin=capabilityRevision(['scripts/worker.ts'],root);
  writeFileSync(join(root,'scripts/other.ts'),'export const other=2;\n');
  expect(capabilityRevision(['scripts/worker.ts'],root)).toBe(pin);
  writeFileSync(join(root,'scripts/worker.ts'),readFileSync(join(root,'scripts/worker.ts'),'utf8')+"export * from './other.js';\n");
  const added=capabilityRevision(['scripts/worker.ts'],root);
  expect(added).not.toBe(pin);
  expect(releaseFiles(['scripts/worker.ts'],root)).toContain('scripts/other.ts');
  writeFileSync(join(root,'scripts/other.ts'),'export const other=3;\n');
  expect(capabilityRevision(['scripts/worker.ts'],root)).not.toBe(added);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('data reads count by literal path, by joined literals and by folder; unresolved or workspace imports stop the release',()=>{
 const root=fixture();
 try{
  mkdirSync(join(root,'scripts/generated'),{recursive:true});writeFileSync(join(root,'scripts/generated/quest-a.ts'),"import '../../packages/core/src/shared';");
  writeFileSync(join(root,'scripts/reader.ts'),["const a=new URL('../knowledge/quests.json',import.meta.url);","const dir=resolve(import.meta.dir,'generated');",
   "const one='.';const word='no-such-thing';"].join('\n'));
  const files=releaseFiles(['scripts/reader.ts'],root);
  for(const f of ['knowledge/quests.json','scripts/generated/quest-a.ts','packages/core/src/shared.ts'])expect(files).toContain(f);
  expect(files).not.toContain('knowledge/npcs.json');
  expect(files).not.toContain('scripts/other.ts');
  // join(root,'knowledge','npcs.json') names one file, not the whole folder.
  expect(releaseFiles(['scripts/worker.ts'],root)).not.toContain('knowledge/quests.json');
  writeFileSync(join(root,'scripts/reader.ts'),"import {join} from 'node:path';export const read=(name:string)=>join(import.meta.dir,'..','knowledge',name);");
  expect(releaseFiles(['scripts/reader.ts'],root)).toEqual(expect.arrayContaining(['knowledge/npcs.json','knowledge/quests.json']));
  writeFileSync(join(root,'scripts/reader.ts'),"import './missing';");
  expect(()=>releaseFiles(['scripts/reader.ts'],root)).toThrow('release import unresolved: scripts/reader.ts -> ./missing');
  writeFileSync(join(root,'scripts/reader.ts'),"import '@rsbot/core';");
  expect(()=>releaseFiles(['scripts/reader.ts'],root)).toThrow('workspace import unsupported');
  expect(()=>capabilityRevision(['scripts/absent.ts'],root)).toThrow('release entry missing');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('a chain job covers its step scripts; a process with no entry checks the launch release',()=>{
 const root=fixture();
 try{
  expect(workerEntries('scripts/worker.ts',['scripts/other.ts 300 lobster','KEY=1','scripts/absent.ts'],root)).toEqual(['scripts/worker.ts','scripts/other.ts']);
  const chain=capabilityRevision(workerEntries('scripts/worker.ts',['scripts/other.ts 300'],root),root);
  const launch=launchRevision(root),env={WORKER_RELEASE:launch};
  expect(assertWorkerRelease(env,root)).toBe(launch);
  writeFileSync(join(root,'scripts/worker.ts'),'export const changed=1;');
  expect(assertWorkerRelease(env,root)).toBe(launch);
  writeFileSync(join(root,'scripts/other.ts'),'export const other=9;');
  expect(capabilityRevision(['scripts/worker.ts','scripts/other.ts'],root)).not.toBe(chain);
  writeFileSync(join(root,'scripts/swarm.ts'),'export const swarm=1;');
  expect(()=>assertWorkerRelease(env,root)).toThrow('source changed');
  expect(releaseEntries('scripts/a.ts,scripts/b.ts')).toEqual(['scripts/a.ts','scripts/b.ts']);expect(releaseEntries('')).toEqual([]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('a peer on a stale release of its own entries holds a live start; a peer current for its entries does not',()=>{
 const root=fixture();
 try{
  const pin=capabilityRevision(['scripts/worker.ts'],root),env={WORKER_RELEASE:pin,WORKER_ENTRY:'scripts/worker.ts'};
  const peer=(workRevision:string,workEntry='scripts/other.ts')=>writeFileSync(join(root,'.practice/status/peer.json'),
   JSON.stringify({name:'Peer',server:'rs-sdk-demo.fly.dev',at:Date.now(),result:'',coordinatorRunId:'task-peer',workRevision,workEntry}));
  peer(capabilityRevision(['scripts/other.ts'],root));
  expect(()=>assertLiveWorkerRelease('rs-sdk-demo.fly.dev',env,root)).not.toThrow();
  writeFileSync(join(root,'scripts/other.ts'),'export const other=2;\n');
  expect(()=>assertLiveWorkerRelease('rs-sdk-demo.fly.dev',env,root)).toThrow('coordinated rollout');
  peer(capabilityRevision(['scripts/other.ts'],root));
  expect(()=>assertLiveWorkerRelease('rs-sdk-demo.fly.dev',env,root)).not.toThrow();
  peer(capabilityRevision(['scripts/other.ts'],root),'scripts/gone.ts');
  expect(()=>assertLiveWorkerRelease('rs-sdk-demo.fly.dev',env,root)).toThrow('coordinated rollout');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('live cohort refuses a fresh peer on another release unless a standing job names it; matching or completed sessions pass',()=>{
 const pin='a'.repeat(64),other='b'.repeat(64),base={name:'Fish',server:'rs-sdk-demo.fly.dev',at:100,result:'',coordinatorRunId:'task-1'};
 const standing=(row:any)=>standingPeer(row,new Set(['fish']));
 for(const workRevision of [undefined,other])expect(()=>assertCompatibleWorkers(pin,base.server,[{...base,workRevision}],101,()=>false,standing)).toThrow('coordinated rollout');
 // A named standing worker carries the release it started on; it never holds a coordinator run back.
 for(const row of [{...base,workRevision:pin},{...base,result:'ok'},{...base,server:'localhost:8888'},{...base,coordinatorRunId:null,workRevision:other}])
  expect(()=>assertCompatibleWorkers(pin,base.server,[row],101,()=>false,standing)).not.toThrow();
 // An unnamed peer, a peer without a revision, or a coordinator peer on another release still refuses.
 for(const row of [{...base,name:'Manual',coordinatorRunId:null,workRevision:other},{...base,coordinatorRunId:null,workRevision:undefined},{...base,coordinatorRunId:'task-2',workRevision:other}])
  expect(()=>assertCompatibleWorkers(pin,base.server,[row],101,()=>false,standing)).toThrow('coordinated rollout');
 // A stale heartbeat still refuses, standing or not.
 expect(()=>assertCompatibleWorkers(pin,base.server,[{...base,coordinatorRunId:null,workRevision:pin,at:60}],100001,()=>false,standing)).toThrow('peer state unknown');
 // A peer is compared with its own current release when one is given.
 expect(()=>assertCompatibleWorkers(pin,base.server,[{...base,workRevision:other}],101,()=>false,standing,()=>other)).not.toThrow();
});

test('missing, future or stale heartbeats cannot prove an unfinished peer has left',()=>{
 const pin='a'.repeat(64);
 for(const at of [undefined,NaN,0,31002,1001,1])expect(()=>assertCompatibleWorkers(pin,'live',[{server:'live',at,result:'',workRevision:pin}],31001)).toThrow('peer state unknown');
 expect(()=>assertCompatibleWorkers(pin,'live',[{server:'live',at:1,result:'ok',workRevision:pin}],31001)).not.toThrow();
});

test('dashboard and authoring edits do not change the whole-tree proof revision',()=>{
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

test('the cached launch release rehashes only when a release file or folder changes',()=>{
 const root=fixture();
 try{
  const pin=launchRevision(root);
  expect(cachedLaunchRevision(root)).toBe(pin);expect(cachedLaunchRevision(root)).toBe(pin);
  writeFileSync(join(root,'research/notes.md'),'edit');writeFileSync(join(root,'scripts/worker.ts'),'export const changed=1;');
  expect(cachedLaunchRevision(root)).toBe(pin);
  writeFileSync(join(root,'scripts/swarm.ts'),'export const swarm=22;');
  const next=launchRevision(root);expect(next).not.toBe(pin);expect(cachedLaunchRevision(root)).toBe(next);
  writeFileSync(join(root,'vendor/rs-sdk/sdk/added.ts'),'export {};');
  expect(cachedLaunchRevision(root)).toBe(launchRevision(root));expect(launchRevision(root)).not.toBe(next);
 }finally{rmSync(root,{recursive:true,force:true});}
});
