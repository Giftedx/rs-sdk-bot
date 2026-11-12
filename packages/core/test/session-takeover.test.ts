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

import {savedProcessAlive} from '../src/session-takeover';
import {PID_START_SLACK_MS} from '../../practice/src/proc';
test('a live process id is the saved process only when its process started before the record',()=>{
 const savedAt=1_000_000,alive=()=>true,gone=()=>false,starts=(at:number|null)=>()=>at===null?null:new Map([[77,at]]);
 // The process started before the record was written: it is the saved process.
 expect(savedProcessAlive(77,savedAt,starts(savedAt-60_000),alive)).toBe(true);
 expect(savedProcessAlive(77,savedAt,starts(savedAt+PID_START_SLACK_MS),alive)).toBe(true);
 // A later process holds the id: the saved process is gone.
 expect(savedProcessAlive(77,savedAt,starts(savedAt+PID_START_SLACK_MS+1),alive)).toBe(false);
 // A start-time read that failed, or that does not list the id, proves nothing.
 expect(savedProcessAlive(77,savedAt,starts(null),alive)).toBe(true);
 expect(savedProcessAlive(77,savedAt,()=>new Map(),alive)).toBe(true);
 // No process has the id: no start-time read is needed.
 let reads=0;
 expect(savedProcessAlive(77,savedAt,()=>{reads++;return new Map();},gone)).toBe(false);
 expect(reads).toBe(0);
});
