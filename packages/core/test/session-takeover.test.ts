import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beginSessionAttempt,readLogoutProof} from '../src/session-lifecycle';
import {liveLogoutRef} from '../src/session-admission';
import {TAKEOVER_SERVERS,serverTakesOver,takeoverRef} from '../src/session-takeover';
const server='rs-sdk-demo.fly.dev';
const owner=(pid:number)=>({pid,coordinatorRunId:null,workerRelease:null,script:'test',role:null,participants:null});
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'takeover-')),root=join(base,'.practice/session-lifecycle');
 mkdirSync(join(base,'.practice/status'),{recursive:true});
 const attempt=(name:string,pid:number)=>beginSessionAttempt({account:name,server},{root,owner:owner(pid)});
 const status=(name:string,value:any)=>writeFileSync(join(base,'.practice/status',name+'.json'),JSON.stringify({name,server,...value}));
 return{base,root,attempt,status};
}
const dead=()=>false,alive=()=>true;

test('the live server is not a proven takeover server',()=>{
 expect(TAKEOVER_SERVERS.has(server)).toBe(false);
 expect(serverTakesOver(server)).toBe(false);
});

test('without the gate a died client stays held, as before',()=>{
 const f=fixture();f.attempt('Rod',101).record('ended','disconnected');
 expect(()=>liveLogoutRef('Rod',f.base,false,Date.now(),false,dead)).toThrow('disconnected');
 expect(()=>liveLogoutRef('Rod',f.base)).toThrow('disconnected');
});

test('on a takeover server a died client with a gone owner starts by re-login',()=>{
 const f=fixture();f.attempt('Rod',101).record('ended','logged-out');
 const died=f.attempt('Rod',202);died.record('ready');died.record('ended','disconnected');
 expect(liveLogoutRef('Rod',f.base,false,Date.now(),true,dead)).toEqual({kind:'takeover',attemptId:died.attemptId,ownerPid:202});
 // An owner killed before any end event is the same case.
 const g=fixture();const killed=g.attempt('Rod',303);killed.record('ready');
 expect(liveLogoutRef('Rod',g.base,false,Date.now(),true,dead)).toEqual({kind:'takeover',attemptId:killed.attemptId,ownerPid:303});
});

test('a live owner process, even of an older unconfirmed attempt, keeps the session held',()=>{
 const f=fixture();f.attempt('Rod',101).record('ended','disconnected');
 expect(()=>liveLogoutRef('Rod',f.base,false,Date.now(),true,alive)).toThrow('not confirmed');
 const older=f.attempt('Rod',202);older.record('ready');f.attempt('Rod',303).record('ended','disconnected');
 const proof=readLogoutProof('Rod',server,{root:f.root});
 expect(takeoverRef(proof,f.root,pid=>pid===202)).toBeNull();
 expect(takeoverRef(proof,f.root,dead)).not.toBeNull();
});

test('a repair still needs producer proof; it never takes the takeover path',()=>{
 const f=fixture();f.attempt('Rod',101).record('ended','disconnected');
 expect(()=>liveLogoutRef('Rod',f.base,true,Date.now(),true,dead)).toThrow('not confirmed');
});

test('an unrecorded newer attempt or a newer status attempt refuses the takeover',()=>{
 const f=fixture();const a=f.attempt('Rod',101);a.record('ended','disconnected');
 const latest=join(f.root,'live',server,'rod','latest.json');const pointer=readFileSync(latest,'utf8');
 f.attempt('Rod',202);writeFileSync(latest,pointer);
 expect(()=>liveLogoutRef('Rod',f.base,false,Date.now(),true,dead)).toThrow('newer attempt');
 const g=fixture();const b=g.attempt('Rod',101);b.record('ended','disconnected');
 g.status('Rod',{at:Date.now(),sessionAttemptId:b.attemptId.replace(/^\d{13}/,s=>String(Number(s)+1))});
 expect(()=>liveLogoutRef('Rod',g.base,false,Date.now(),true,dead)).toThrow('not confirmed');
});

test('a confirmed logout still returns producer proof on a takeover server',()=>{
 const f=fixture();const a=f.attempt('Rod',101);a.record('ended','logged-out');
 expect(liveLogoutRef('Rod',f.base,false,Date.now(),true,dead)).toEqual({kind:'producer',attemptId:a.attemptId});
});
