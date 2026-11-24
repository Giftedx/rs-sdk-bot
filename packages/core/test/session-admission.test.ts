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

// Receipt details as inprocess.ts connectFailedDetail writes them.
const SOCKET_NEVER_OPENED='[object WebSocket] http=[{"url":"https://rs-sdk-demo.fly.dev/api/version","status":200,"ms":80}]';
const CACHE_REQUEST_REFUSED='Error: lite: GET https://rs-sdk-demo.fly.dev/crc failed with 502 http=[{"url":"https://rs-sdk-demo.fly.dev/crc","status":502,"ms":40}]';
const dead=()=>false,alive=()=>true,AGED=201_000;
function afterLogout(account:string,...details:string[]){
 const f=fixture(),confirmed=f.attempt(account);
 confirmed.record('connected');confirmed.record('ready');confirmed.record('ended','logged-out');
 for(const detail of details)f.attempt(account).record('connect-failed',detail);
 return{f,confirmed};
}
test('dead attempts that ended before the game socket opened admit on the prior logout proof',()=>{
 const {f,confirmed}=afterLogout('DeadFail',SOCKET_NEVER_OPENED,CACHE_REQUEST_REFUSED);
 // While the owner pid appears alive, launch stays blocked.
 expect(()=>liveLogoutRef('DeadFail',f.base,false,Date.now()+AGED,false,alive)).toThrow('not confirmed');
 // A failure younger than the server's 200 s session drop stays blocked.
 expect(()=>liveLogoutRef('DeadFail',f.base,false,Date.now()+60_000,false,dead)).toThrow('not confirmed');
 expect(liveLogoutRef('DeadFail',f.base,false,Date.now()+AGED,false,dead)).toEqual({kind:'producer',attemptId:confirmed.attemptId});
 // A newer uncovered status after the confirmed logout still refuses.
 f.status('DeadFail',{at:Date.now()+10000,result:''});
 expect(()=>liveLogoutRef('DeadFail',f.base,false,Date.now()+AGED,false,dead)).toThrow('not covered');
});

test('a dead attempt that failed after its login block was sent keeps the account held',()=>{
 for(const detail of ['LoginError: Account already logged in http=[{"url":"https://rs-sdk-demo.fly.dev/crc","status":200,"ms":40}]',
  'TimeoutError: The operation timed out','LoginError: Login rejected (-1)','LoginError: Login server offline http=[]','no packet observer','ECONNREFUSED']){
  const {f}=afterLogout('SentLogin',detail);
  expect(()=>liveLogoutRef('SentLogin',f.base,false,Date.now()+AGED,false,dead)).toThrow('not confirmed');
 }
 // One unproved attempt among proved ones holds the account.
 const {f}=afterLogout('SentLogin',SOCKET_NEVER_OPENED,'LoginError: Account already logged in',SOCKET_NEVER_OPENED);
 expect(()=>liveLogoutRef('SentLogin',f.base,false,Date.now()+AGED,false,dead)).toThrow('not confirmed');
});

test('a repair never takes the older logout: the controller refuses a proof that a newer attempt supersedes',()=>{
 const {f}=afterLogout('Repair',SOCKET_NEVER_OPENED);
 expect(()=>liveLogoutRef('Repair',f.base,true,Date.now()+AGED,false,dead)).toThrow('not confirmed');
});

test('dead pre-connect failures after a disconnected session remain unconfirmed',()=>{
 const f=fixture();
 const disc=f.attempt('DiscPrev');
 disc.record('connected');
 disc.record('ended','disconnected');
 const fail=f.attempt('DiscPrev');
 fail.record('connect-failed',SOCKET_NEVER_OPENED);
 for(const required of [true,false])expect(()=>liveLogoutRef('DiscPrev',f.base,required,Date.now()+AGED,false,dead)).toThrow('not confirmed');
});

test('live admission reads producer proofs and status rows from .practice/live without legacy directories',()=>{
 const base=mkdtempSync(join(tmpdir(),'launch-session-live-'));
 const liveLifecycle=join(base,'.practice','live','session-lifecycle');
 const liveStatusDir=join(base,'.practice','live','status');
 mkdirSync(liveStatusDir,{recursive:true});
 const attempt=beginSessionAttempt({account:'LiveRod',server},{root:liveLifecycle});
 attempt.record('connected');
 attempt.record('ended','logged-out');
 expect(liveLogoutRef('LiveRod',base)).toEqual({kind:'producer',attemptId:attempt.attemptId});
 writeFileSync(join(liveStatusDir,'LiveRod.json'),JSON.stringify({name:'LiveRod',server,at:Date.now()+10_000,result:''}));
 expect(()=>liveLogoutRef('LiveRod',base)).toThrow('not covered');
});
