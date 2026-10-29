import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {beginSessionAttempt} from '../../core/src/session-lifecycle';
import {liveLogoutRef} from '../src/coordinator-session';
import {installJob} from '../src/coordinator-live';
const server='rs-sdk-demo.fly.dev';
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'router-session-')),root=join(base,'.practice/session-lifecycle');
 mkdirSync(join(base,'.practice/status'),{recursive:true});mkdirSync(join(base,'.practice/coordinator/runs/test'),{recursive:true});
 const status=(name:string,value:any)=>writeFileSync(join(base,'.practice/status',name+'.json'),JSON.stringify({name,server,...value}));
 const attempt=(name:string)=>beginSessionAttempt({account:name,server},{root});
 return{base,root,status,attempt};
}
test('a producer outcome is required despite a successful RESULT; absent status cannot hide a partial attempt',()=>{
 const f=fixture();f.status('Rod',{result:'ok old work'});
 expect(()=>liveLogoutRef('Rod',f.base)).toThrow('legacy');
 const old=f.attempt('Rod');old.record('ended','logged-out');expect(liveLogoutRef('Rod',f.base)).toEqual({kind:'producer',attemptId:old.attemptId});
 const next=f.attempt('Rod');expect(()=>liveLogoutRef('Rod',f.base)).toThrow('not confirmed');
 old.record('closed');expect(()=>liveLogoutRef('Rod',f.base)).toThrow('not confirmed');
 next.record('ended','disconnected');expect(()=>liveLogoutRef('Rod',f.base)).toThrow('disconnected');
 f.attempt('Partner');expect(()=>liveLogoutRef('Partner',f.base)).toThrow('not confirmed');
});
test('crossed status and practice evidence never authorize live admission',()=>{
 const f=fixture();beginSessionAttempt({account:'Rod',server:'localhost:8888'},{root:f.root}).record('ended','logged-out');
 f.status('Rod',{result:'ok',sessionAttemptId:'old'});expect(()=>liveLogoutRef('Rod',f.base)).toThrow('legacy');
 f.attempt('Rod').record('ended','logged-out');expect(()=>liveLogoutRef('Rod',f.base)).toThrow('not covered');
 f.status('Rod',{result:'ok',started:Date.now()+10000});expect(()=>liveLogoutRef('Rod',f.base)).toThrow('not covered');
});
test('fresh identities can enter but recovery always requires a proof',()=>{
 const f=fixture();expect(liveLogoutRef('Fresh',f.base)).toBeNull();expect(()=>liveLogoutRef('Fresh',f.base,true)).toThrow('legacy');
});
test('a newer failed readiness attempt with observed logout can cover an older status',()=>{
 const f=fixture(),first=f.attempt('Rod');first.record('ended','logged-out');
 f.status('Rod',{result:'ok old',sessionAttemptId:first.attemptId,started:1});
 const next=f.attempt('Rod');next.record('ready-failed');next.record('ended','logged-out');
 expect(liveLogoutRef('Rod',f.base)).toEqual({kind:'producer',attemptId:next.attemptId});
});
test('hash-bound anonymous legacy bootstrap refuses; a new producer attempt still supersedes it',()=>{
 const f=fixture(),statusPath=join(f.base,'.practice/status/Rod.json'),logPath=join(f.base,'historical.log');
 f.status('Rod',{result:'ok old',at:10});writeFileSync(logPath,'START 1 2 0\nLOGOUT logged-out\nRESULT ok old\n');
 const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
 const claim={kind:'legacy-logout' as const,account:'Rod',server,statusPath,statusSha256:hash(statusPath),statusAt:10,logPath,logSha256:hash(logPath)};
 const dir=join(f.base,'.practice/coordinator/session-proofs');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'rod.json'),JSON.stringify(claim));
 expect(()=>liveLogoutRef('Rod',f.base,true)).toThrow('anonymous legacy log');
 writeFileSync(logPath,'START 1 2 0\nLOGOUT timeout\nRESULT fail old\n');expect(()=>liveLogoutRef('Rod',f.base)).toThrow('hash changed');
 writeFileSync(logPath,'START 1 2 0\nLOGOUT logged-out\nRESULT ok old\n');
 f.attempt('Rod');expect(()=>liveLogoutRef('Rod',f.base)).toThrow('not confirmed');
});
test('installation checks every participant and the durable failed-script history without mutating the plan',()=>{
 const f=fixture(),plan={maxBots:17,minFreeGB:0,jobs:[]},path=join(f.base,'swarm.json');writeFileSync(path,JSON.stringify(plan));
 f.attempt('Rod').record('ended','logged-out');f.attempt('Partner');
 const task:any={id:'test',goal:'gear',participants:['Rod','Partner']};
 expect(()=>installJob(task,'Rod','new.ts','test','source',{}, {base:f.base})).toThrow('not confirmed');
 expect(readFileSync(path,'utf8')).toBe(JSON.stringify(plan));
 const partner=f.attempt('Partner');partner.record('ended','logged-out');
 writeFileSync(join(f.base,'.practice/swarm-script-holds.json'),JSON.stringify([{account:'Rod',script:'old.ts',at:1,reason:'blocked',heldAt:2}]));
 expect(()=>installJob(task,'Rod','old.ts','test','source',{}, {base:f.base})).toThrow('failed script');
 expect(()=>installJob(task,'Rod','new.ts','test','source',{}, {base:f.base,preflight:true})).not.toThrow();
 expect(readFileSync(path,'utf8')).toBe(JSON.stringify(plan));
});
