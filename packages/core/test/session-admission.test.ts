import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beginSessionAttempt} from '../src/session-lifecycle';
import {liveLogoutRef,withSessionAdmission} from '../src/session-admission';
const server='rs-sdk-demo.fly.dev';
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'launch-session-')),root=join(base,'.practice/session-lifecycle');
 mkdirSync(join(base,'.practice/status'),{recursive:true});
 return {base,attempt:(account:string)=>beginSessionAttempt({account,server},{root}),
  status:(account:string,value:any)=>writeFileSync(join(base,'.practice/status',account+'.json'),JSON.stringify({name:account,server,...value}))};
}
test('launch rereads the latest producer after earlier admission and never invokes spawn on a partial connection',()=>{
 const f=fixture();let launches=0;
 const old=f.attempt('Rod');old.record('ended','logged-out');
 expect(withSessionAdmission(['Rod'],f.base,()=>++launches)).toBe(1);
 const partial=f.attempt('Rod');old.record('closed');
 expect(()=>withSessionAdmission(['Rod'],f.base,()=>++launches)).toThrow('not confirmed');
 expect(launches).toBe(1);
 partial.record('ended','logged-out');
 expect(withSessionAdmission(['Rod'],f.base,()=>++launches)).toBe(2);
});
test('one unresolved hosted or composed participant keeps the whole spawn offline',()=>{
 const f=fixture();let launches=0;f.attempt('Rod').record('ended','logged-out');f.attempt('Partner');
 for(const accounts of [['Rod','Partner'],['Partner','Rod']])expect(()=>withSessionAdmission(accounts,f.base,()=>++launches)).toThrow('not confirmed');
 expect(launches).toBe(0);
});
test('historical live status and newer crossed status refuse; a fresh identity can launch',()=>{
 const f=fixture();let launches=0;
 expect(withSessionAdmission(['Fresh'],f.base,()=>++launches)).toBe(1);
 f.status('Old',{result:'ok'});expect(()=>withSessionAdmission(['Old'],f.base,()=>++launches)).toThrow('legacy');
 f.attempt('Rod').record('ended','logged-out');f.status('Rod',{started:Date.now()+10000,sessionAttemptId:'other'});
 expect(()=>withSessionAdmission(['Rod'],f.base,()=>++launches)).toThrow('not covered');expect(launches).toBe(1);
 f.status('Rod',{at:Date.now()+10000,result:''});expect(()=>withSessionAdmission(['Rod'],f.base,()=>++launches)).toThrow('not covered');expect(launches).toBe(1);
});

test('dead pre-connect failures after confirmed logout admit on the prior logout proof',()=>{
 const f=fixture();
 const confirmed=f.attempt('DeadFail');
 confirmed.record('connected');
 confirmed.record('ready');
 confirmed.record('ended','logged-out');
 const fail1=f.attempt('DeadFail');
 fail1.record('connect-failed','TimeoutError');
 const fail2=f.attempt('DeadFail');
 fail2.record('connect-failed','ECONNREFUSED');
 // While the owner pid appears alive, launch stays blocked.
 expect(()=>liveLogoutRef('DeadFail',f.base,true,Date.now(),false,()=>true)).toThrow('not confirmed');
 // Once owner pids are dead and status has not advanced, both normal and required admission use the prior confirmed logout.
 expect(liveLogoutRef('DeadFail',f.base,true,Date.now(),false,()=>false)).toEqual({kind:'producer',attemptId:confirmed.attemptId});
 // A newer uncovered status after the confirmed logout still refuses.
 f.status('DeadFail',{at:Date.now()+10000,result:''});
 expect(()=>liveLogoutRef('DeadFail',f.base,true,Date.now(),false,()=>false)).toThrow('not covered');
});

test('dead pre-connect failures after a disconnected session remain unconfirmed for required repairs',()=>{
 const f=fixture();
 const disc=f.attempt('DiscPrev');
 disc.record('connected');
 disc.record('ended','disconnected');
 const fail=f.attempt('DiscPrev');
 fail.record('connect-failed','TimeoutError');
 expect(()=>liveLogoutRef('DiscPrev',f.base,true,Date.now(),false,()=>false)).toThrow('not confirmed');
});
