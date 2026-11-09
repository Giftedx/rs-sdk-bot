import {expect,test} from 'bun:test';
import {resolve} from 'node:path';

async function trace(reject:boolean,lateStop=false,direct=false,accountStop=false){
 const root=resolve(import.meta.dir,'../../..');
 const code=`import {mock} from 'bun:test';
 import{mkdtempSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
 const lifecycleRoot=mkdtempSync(join(tmpdir(),'auth-order-'));
 const events=[];let stopped=false;
 if(${accountStop}){
  const fs=await import('node:fs');
  const existsSync=fs.existsSync;
  mock.module('node:fs',()=>({...fs,existsSync:p=>String(p).endsWith('stop-authfixture')||existsSync(p)}));
 }
 if(${direct})delete process.env.SWARM_LEASE_HOLDER;
 if(${direct}){
  const claims=await import(${JSON.stringify(resolve(root,'packages/core/src/fleet-trade-claim.ts'))});
  mock.module(${JSON.stringify(resolve(root,'packages/core/src/fleet-trade-claim.ts'))},()=>({...claims,acquireFleetSwarmClaim:()=>{events.push('account-claim');throw Error('fixture trade holds the account');}}));
  const lifecycle=await import(${JSON.stringify(resolve(root,'packages/core/src/session-lifecycle.ts'))});
  mock.module(${JSON.stringify(resolve(root,'packages/core/src/session-lifecycle.ts'))},()=>({...lifecycle,beginSessionAttempt:()=>{events.push('intent');throw Error('fixture intent');}}));
 }
 mock.module(${JSON.stringify(resolve(root,'packages/core/src/pathcache.ts'))},()=>({loadPathfinding:async()=>{events.push('local-setup');stopped=${lateStop};return{};}}));
 mock.module(${JSON.stringify(resolve(root,'packages/core/src/tradeguard.ts'))},()=>({recordOwnedAccount:()=>events.push('record'),ownedAccounts:()=>new Set(),tradePartners:()=>new Set(),tradeRefusal:()=>null}));
 mock.module(${JSON.stringify(resolve(root,'vendor/rs-sdk/server/webclient/src/lite/session.ts'))},()=>({startSession:async opts=>{
  events.push('authenticating');if(${reject})throw Error('simulated credential rejection');
  events.push('authenticated');const client={ingame:true,collectBotState:()=>({}),executeBotAction:()=>({success:true}),setOnGameTickCallback:()=>{}};
  opts.onClient(client);events.push('return-session');return{client,stop(){},stopped:new Promise(()=>{})};
 }}));
 const {connectInProcess}=await import(${JSON.stringify(resolve(root,'packages/core/src/inprocess.ts'))});
 let error='';try{await connectInProcess({name:'authfixture',password:'fixture-only',...(${direct}?{server:'rs-sdk-demo.fly.dev'}:{lifecycleRoot}),beforeConnect:()=>{events.push('before-connect');if(stopped)throw Error('owner stopped during local setup');}});events.push('returned');}catch(e){error=String(e);}
 const {listAttempts}=await import(${JSON.stringify(resolve(root,'packages/core/src/session-lifecycle.ts'))});
 console.log('AUTH_TRACE '+JSON.stringify({events,error,attempts:listAttempts('authfixture','localhost:8888',{root:lifecycleRoot}).length}));`;
 const result=Bun.spawn(['bun','-e',code],{cwd:root,stdout:'pipe',stderr:'pipe',timeout:10000,windowsHide:true});
 const [exitCode,stdout,stderr]=await Promise.all([result.exited,new Response(result.stdout).text(),new Response(result.stderr).text()]);
 if(exitCode!==0)throw Error(stderr);
 expect(exitCode).toBe(0);
 const line=stdout.split(/\r?\n/).find(l=>l.startsWith('AUTH_TRACE '));
 expect(line).toBeDefined();return JSON.parse(line!.slice(11)) as {events:string[];error:string;attempts:number};
}
test('rejected authentication does not record an owned partner',async()=>{
 const r=await trace(true);expect(r.error).toContain('simulated credential rejection');expect(r.events).not.toContain('record');
});
test('ownership is recorded only after an authenticated session returns',async()=>{
 const r=await trace(false);expect(r.error).toBe('');expect(r.events.indexOf('record')).toBeGreaterThan(r.events.indexOf('return-session'));expect(r.events.at(-1)).toBe('returned');
});
test('a stop during asynchronous local setup refuses before producer intent and authentication',async()=>{
 const r=await trace(false,true);expect(r.events).toEqual(['local-setup','before-connect']);expect(r.error).toContain('owner stopped during local setup');expect(r.attempts).toBe(0);
});
test('a direct live login refuses a shared account claim before authentication',async()=>{
 const r=await trace(true,false,true);
 expect(r.events).toEqual(['local-setup','before-connect','account-claim']);
 expect(r.error).toContain('fixture trade holds the account');
});
test('a direct live login checks an account stop before claiming or authenticating',async()=>{
 const r=await trace(true,false,true,true);
 expect(r.events).toEqual(['local-setup']);
 expect(r.error).toContain('stop file');
});
