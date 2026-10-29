import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,rmdirSync,symlinkSync,unlinkSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createRecoveryDispatch} from '../src/session-recovery-dispatch';
const server='rs-sdk-demo.fly.dev';
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'recovery-dispatch-')),file=join(base,'.practice/swarm-repair.json.processing');mkdirSync(dirname(file),{recursive:true});
 mkdirSync(join(base,'.practice/coordinator'),{recursive:true});
 const request={schema:'session-recovery/1',kind:'session-recovery',account:'Rod',server,runId:'task-run',nonce:'one',endedAt:100,source:'a'.repeat(64),
  qualification:{delivery:{path:'unit-fixture-not-qualified',sha256:'0'.repeat(64)},proof:{path:'unit-fixture-not-qualified',sha256:'0'.repeat(64)}}};
 const raw=JSON.stringify(request),ends=join(base,'.practice/swarm-deaths.json');writeFileSync(ends,JSON.stringify({Rod:{at:100,reason:'blocked'}}));
 let calls=0,admitted=0,resolve!:(x:unknown)=>void,reject!:(x:unknown)=>void;
 const completion=new Promise((yes,no)=>{resolve=yes;reject=no;});
 const options={base,server,admit:()=>{admitted++;},log:()=>{},
  launch:()=>{calls++;return{child:{pid:1234},completion};}};
 const controller=createRecoveryDispatch(options);
 const claim=(r=raw)=>writeFileSync(file,r);
 const results=()=>existsSync(join(base,'.practice/swarm-repair.json.results.jsonl'))?readFileSync(join(base,'.practice/swarm-repair.json.results.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l)):[];
 return{base,file,raw,request,ends,controller,options,claim,results,resolve,reject,calls:()=>calls,admitted:()=>admitted};
}
test('malformed recovery is acknowledged and removed without launch or damage to the failure',()=>{
 const f=fixture(),raw=JSON.stringify({...f.request,account:'../bad'}),before=readFileSync(f.ends,'utf8');f.claim(raw);
 expect(f.controller.handle(raw)).toBe(true);expect(f.results()[0].result.reason).toContain('invalid controlled');
 expect(f.calls()).toBe(0);expect(f.admitted()).toBe(0);expect(existsSync(f.file)).toBe(false);expect(readFileSync(f.ends,'utf8')).toBe(before);
});
test('existing lease archives the owned request and never reaps or relaunches its child',()=>{
 const f=fixture(),lease=join(f.base,'.practice/coordinator/session-recovery/accounts/rod/lease.json');mkdirSync(dirname(lease),{recursive:true});writeFileSync(lease,'existing owner');f.claim();
 expect(f.controller.handle(f.raw)).toBe(true);expect(f.calls()).toBe(0);expect(existsSync(f.file)).toBe(false);
 expect(readFileSync(lease,'utf8')).toBe('existing owner');expect(readdirSync(dirname(lease)).some(n=>n.startsWith('processing-held-one-'))).toBe(true);
 expect(f.results()[0].result.sessionRecovered).toBe(false);
});
test('busy child stays owned and its completion cannot remove a newer processing request',async()=>{
 const f=fixture();f.claim();f.controller.handle(f.raw);expect(f.calls()).toBe(1);expect(f.controller.active).toMatchObject({account:'Rod',pid:1234});
 f.controller.handle(f.raw);expect(f.calls()).toBe(1);expect(f.results()).toEqual([]);
 const other=JSON.stringify({...f.request,nonce:'two'});f.claim(other);f.controller.handle(other);expect(f.calls()).toBe(1);
 f.resolve({proof:'test-only completion'});await Promise.resolve();await Promise.resolve();
 expect(f.controller.active).toBeUndefined();expect(f.results()[0]).toMatchObject({raw:f.raw,result:{sessionRecovered:true,changed:false}});expect(readFileSync(f.file,'utf8')).toBe(other);
});
test('source/stop/admission refusals occur before launch; post-issuance failure reports the retained lease',()=>{
 for(const fault of ['build','stop','admission','issued']){
  const f=fixture();if(fault==='build')writeFileSync(join(f.base,'.practice/coordinator/build-lock.json'),'source owner');
  if(fault==='stop')writeFileSync(join(f.base,'.practice/stop-swarm'),'owner stop');
  if(fault==='admission')f.options.admit=()=>{throw Error('maxBots');};
  if(fault==='issued')f.options.launch=()=>{const p=join(f.base,'.practice/coordinator/session-recovery/accounts/rod/lease.json');mkdirSync(dirname(p),{recursive:true});writeFileSync(p,'issued');throw Error('spawn failed');};
  const controller=createRecoveryDispatch(f.options);f.claim();controller.handle(f.raw);
  expect(f.calls()).toBe(0);expect(existsSync(f.file)).toBe(false);expect(f.results()[0].result.reason).toContain(fault==='issued'?'account lease held':'no lease issued');
 }
});
test('failed child keeps the old failure; malformed or ordinary JSON is not consumed as a recovery',async()=>{
 const f=fixture(),before=readFileSync(f.ends,'utf8');f.claim();f.controller.handle(f.raw);f.reject(Error('timeout'));await Promise.resolve();await Promise.resolve();
 expect(f.results()[0].result.sessionRecovered).toBe(false);expect(readFileSync(f.ends,'utf8')).toBe(before);expect(f.controller.active).toBeUndefined();
 for(const raw of ['{',JSON.stringify({kind:'script-qualified'})]){f.claim(raw);expect(f.controller.handle(raw)).toBe(false);expect(readFileSync(f.file,'utf8')).toBe(raw);}
});
test('result persistence failure retains the input and suppresses any duplicate launch',async()=>{
 const f=fixture();f.options.log=()=>{throw Error('closed log');};const controller=createRecoveryDispatch(f.options);
 f.claim();controller.handle(f.raw);mkdirSync(join(f.base,'.practice/swarm-repair.json.results.jsonl'));
 f.resolve({proof:'test-only completion'});await Promise.resolve();await Promise.resolve();
 expect(controller.active).toBeUndefined();expect(readFileSync(f.file,'utf8')).toBe(f.raw);
 rmdirSync(join(f.base,'.practice/swarm-repair.json.results.jsonl'));
 expect(controller.handle(f.raw)).toBe(true);expect(f.calls()).toBe(1);expect(existsSync(f.file)).toBe(false);
 expect(f.results()[0].result.sessionRecovered).toBe(true);
});
test('a refusal receipt failure cannot become a later admitted launch',()=>{
 const f=fixture();f.options.admit=()=>{throw Error('maxBots');};const controller=createRecoveryDispatch(f.options),results=join(f.base,'.practice/swarm-repair.json.results.jsonl');
 f.claim();mkdirSync(results);expect(()=>controller.handle(f.raw)).toThrow();expect(f.calls()).toBe(0);
 f.options.admit=()=>{};rmdirSync(results);expect(controller.handle(f.raw)).toBe(true);expect(f.calls()).toBe(0);expect(existsSync(f.file)).toBe(false);
 f.claim();controller.handle(f.raw);expect(f.calls()).toBe(0);expect(f.results().at(-1).result.reason).toContain('already handled');
});

test('a refused processing request cannot launch after a dispatcher restart',()=>{
 const f=fixture(),results=join(f.base,'.practice/swarm-repair.json.results.jsonl');
 f.options.admit=()=>{throw Error('owner stopped');};f.claim();mkdirSync(results);
 expect(()=>createRecoveryDispatch(f.options).handle(f.raw)).toThrow();expect(f.calls()).toBe(0);
 rmdirSync(results);f.options.admit=()=>{};
 createRecoveryDispatch(f.options).handle(f.raw);expect(f.calls()).toBe(0);
 expect(f.results()[0].result.reason).toContain('already handled');
});

test('marker persistence failure makes no admission decision and does not claim a handled request',()=>{
 const f=fixture(),blocker=join(f.base,'.practice/coordinator/session-recovery');f.claim();writeFileSync(blocker,'blocked directory');
 expect(()=>f.controller.handle(f.raw)).toThrow();expect(f.calls()).toBe(0);expect(f.admitted()).toBe(0);expect(f.results()).toEqual([]);
 unlinkSync(blocker);f.controller.handle(f.raw);expect(f.calls()).toBe(1);expect(f.admitted()).toBe(1);
});

test('a restarted dispatcher leaves the inherited lease and original active child untouched',()=>{
 const f=fixture();f.claim();f.controller.handle(f.raw);
 const lease=join(f.base,'.practice/coordinator/session-recovery/accounts/rod/lease.json');mkdirSync(dirname(lease),{recursive:true});writeFileSync(lease,'original child lease');
 createRecoveryDispatch(f.options).handle(f.raw);expect(f.calls()).toBe(1);
 expect(readFileSync(lease,'utf8')).toBe('original child lease');expect(f.controller.active?.pid).toBe(1234);
});

test('a fixture link introduced deep in control state after construction is refused',()=>{
 const f=fixture(),controller=createRecoveryDispatch({base:f.base,server:'localhost:8888',nativeFixture:true}),link=join(f.base,'.practice/coordinator/deep/nested/link');
 mkdirSync(dirname(link),{recursive:true});symlinkSync(resolve(import.meta.dir,'../../..'),link,process.platform==='win32'?'junction':'dir');f.claim();
 try{expect(()=>controller.handle(f.raw)).toThrow('boundary');expect(f.calls()).toBe(0);}
 finally{if(!lstatSync(link).isSymbolicLink())throw Error('not removing an unknown directory');if(process.platform==='win32')rmdirSync(link);else unlinkSync(link);}
});

test('nested fixture links and linked swarm assignments are refused before dispatch',()=>{
 const repo=resolve(import.meta.dir,'../../..');
 for(const relative of ['.practice/coordinator/session-recovery','.practice/session-lifecycle','.practice/status','.practice/deliveries','swarm.json']){
  const f=fixture(),link=join(f.base,relative);mkdirSync(dirname(link),{recursive:true});
  symlinkSync(repo,link,process.platform==='win32'?'junction':'dir');
  try{expect(()=>createRecoveryDispatch({base:f.base,server:'localhost:8888',nativeFixture:true})).toThrow('boundary');}
  finally{if(!lstatSync(link).isSymbolicLink())throw Error('not removing an unknown directory');if(process.platform==='win32')rmdirSync(link);else unlinkSync(link);}
 }
});
test('native fixture mode cannot use production state or a remote endpoint',()=>{
 const f=fixture();
 expect(()=>createRecoveryDispatch({base:resolve(import.meta.dir,'../../..'),server:'localhost:8888',nativeFixture:true})).toThrow('boundary');
 expect(()=>createRecoveryDispatch({base:f.base,server,nativeFixture:true})).toThrow('boundary');
 expect(()=>createRecoveryDispatch({base:f.base,server:'localhost:8888'})).toThrow('boundary');
 expect(createRecoveryDispatch({base:f.base,server:'localhost:8888',nativeFixture:true}).active).toBeUndefined();
});
test('case aliases, junctions and control-directory links cannot turn a local fixture into production state',()=>{
 const repo=resolve(import.meta.dir,'../../..');
 expect(()=>createRecoveryDispatch({base:repo.toUpperCase(),server:'localhost:8888',nativeFixture:true})).toThrow('boundary');
 for(const target of ['repo','control']){
  const base=mkdtempSync(join(tmpdir(),'recovery-root-alias-'));mkdirSync(join(base,'.practice'));
  const link=target==='repo'?join(base,'alias'):join(base,'.practice/coordinator');
  symlinkSync(target==='repo'?repo:join(repo,'.practice/coordinator'),link,process.platform==='win32'?'junction':'dir');
  try{expect(()=>createRecoveryDispatch({base:target==='repo'?link:base,server:'localhost:8888',nativeFixture:true})).toThrow('boundary');}
  finally{if(!lstatSync(link).isSymbolicLink())throw Error('not removing an unknown directory');if(process.platform==='win32')rmdirSync(link);else unlinkSync(link);}
 }
});
test('the actual default remote launcher still refuses without a lease or child',()=>{
 const f=fixture(),controller=createRecoveryDispatch({base:f.base,server,admit:()=>{}});f.claim();
 expect(controller.handle(f.raw)).toBe(true);expect(controller.active).toBeUndefined();
 expect(f.results()[0].result).toMatchObject({changed:false,sessionRecovered:false});expect(f.results()[0].result.reason).toContain('no lease issued');
 expect(existsSync(join(f.base,'.practice/coordinator/session-recovery/accounts/rod/lease.json'))).toBe(false);
});
