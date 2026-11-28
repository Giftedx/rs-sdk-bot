import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LEAN_BUN_ENV} from '../src/lean-bun-env';
import {daemonSpawnArgs,liveUpdateFile,readLiveUpdate,reloadDue,respawnDaemon,writeLiveUpdate} from '../src/live-reload';

test('a later unrelated update cannot clear an earlier dashboard reload request',()=>{
 const root=mkdtempSync(join(tmpdir(),'daemon-reload-'));
 try{
  mkdirSync(join(root,'.practice'));
  writeFileSync(liveUpdateFile(root),JSON.stringify({at:100,from:'a',to:'b',files:1,reload:['dashboard','dashboard-publish']}));
  expect(reloadDue(root,'dashboard',50)).toBe(true);
  writeFileSync(liveUpdateFile(root),JSON.stringify({at:200,from:'b',to:'c',files:1,reload:['fleet-agent'],reloadAt:{dashboard:100,'dashboard-publish':100,'fleet-agent':200}}));
  expect(reloadDue(root,'dashboard',50)).toBe(true);
  expect(reloadDue(root,'dashboard-publish',50)).toBe(true);
  expect(reloadDue(root,'dashboard',150)).toBe(false);
  expect(reloadDue(root,'fleet-agent',150)).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('the writer preserves legacy reload times without aging them into a new request',()=>{
 const root=mkdtempSync(join(tmpdir(),'daemon-reload-writer-'));
 try{
  mkdirSync(join(root,'.practice'));
  writeFileSync(liveUpdateFile(root),JSON.stringify({at:100,from:'a',to:'b',files:1,reload:['dashboard','dashboard-publish','swarm']}));
  writeLiveUpdate(root,{at:200,from:'b',to:'c',files:1,reload:['fleet-agent']});
  expect(readLiveUpdate(root)?.reloadAt).toEqual({dashboard:100,'dashboard-publish':100,swarm:100,'fleet-agent':200});
  expect(reloadDue(root,'dashboard-publish',50)).toBe(true);
  expect(reloadDue(root,'dashboard-publish',150)).toBe(false);
  writeLiveUpdate(root,{at:300,from:'c',to:'d',files:1,reload:[]});
  expect(readLiveUpdate(root)?.reload).toEqual([]);
  expect(reloadDue(root,'dashboard',50)).toBe(true);
  expect(reloadDue(root,'fleet-agent',150)).toBe(true);
  expect(reloadDue(root,'swarm',150)).toBe(false);
  writeLiveUpdate(root,{at:400,from:'d',to:'e',files:1,reload:['dashboard-publish']});
  expect(reloadDue(root,'dashboard-publish',350)).toBe(true);
  expect(reloadDue(root,'dashboard-publish',400)).toBe(false);
  expect(reloadDue(root,'watchdog',0)).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('daemonSpawnArgs prepends --smol once and respawnDaemon passes LEAN_BUN_ENV to the child',async()=>{
 expect(daemonSpawnArgs(['scripts/swarm.ts'])).toEqual(['--smol','scripts/swarm.ts']);
 expect(daemonSpawnArgs(['--smol','scripts/swarm.ts'])).toEqual(['--smol','scripts/swarm.ts']);
 const root=mkdtempSync(join(tmpdir(),'daemon-respawn-'));
 try{
  const log=join(root,'out.log');
  const script=join(root,'probe.ts');
  writeFileSync(script,'console.log(JSON.stringify({dfg:process.env.BUN_JSC_useDFGJIT,ftl:process.env.BUN_JSC_useFTLJIT,wasm:process.env.BUN_JSC_numberOfWasmCompilerThreads,gc:process.env.BUN_JSC_numberOfGCMarkers}));');
  const pid=respawnDaemon(root,[script],log);
  expect(pid).toBeGreaterThan(0);
  const deadline=Date.now()+5000;
  let text='';
  while(Date.now()<deadline){
   text=readFileSync(log,'utf8').trim();
   if(text.startsWith('{')&&text.endsWith('}'))break;
   await Bun.sleep(25);
  }
  const got=JSON.parse(text);
  expect(got.dfg).toBe(process.env.BUN_JSC_useDFGJIT||LEAN_BUN_ENV.BUN_JSC_useDFGJIT);
  expect(got.ftl).toBe(process.env.BUN_JSC_useFTLJIT||LEAN_BUN_ENV.BUN_JSC_useFTLJIT);
  expect(got.wasm).toBe(process.env.BUN_JSC_numberOfWasmCompilerThreads||LEAN_BUN_ENV.BUN_JSC_numberOfWasmCompilerThreads);
  expect(got.gc).toBe(process.env.BUN_JSC_numberOfGCMarkers||LEAN_BUN_ENV.BUN_JSC_numberOfGCMarkers);
 }finally{rmSync(root,{recursive:true,force:true});}
});
