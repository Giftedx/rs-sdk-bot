import {afterEach,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withPlanWrite} from '../../core/src/plan-lock';
import {addTasks,initialState} from '../src/coordinator';
import {claimCoordinatorState,ownerHolds,OWNER_START_SLACK_MS} from '../src/coordinator-cli';
import * as coordinatorCli from '../src/coordinator-cli';
import {atomicJson,saveState} from '../src/coordinator-store';

const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
const fixture=()=>{const directory=mkdtempSync(join(tmpdir(),'coordinator-startup-'));directories.push(directory);return directory;};
const lockFile=(directory:string)=>join(directory,'plan-write-lock.json');
function deadWriter(directory:string){
 const owner={pid:2147483646,nonce:randomUUID(),at:1};
 const intent=join(directory,`plan-write-${owner.nonce}.intent.json`),bytes=JSON.stringify(owner);
 writeFileSync(intent,bytes);linkSync(intent,lockFile(directory));
 return{owner,intent,bytes};
}
function queuedState(){
 const state=initialState();
 addTasks(state,[{id:'saved-order',goal:'skills',kind:'qualify',capability:'wine-order',dependsOn:[],priority:2,estimatedMs:1,why:'qualify a finite order'}]);
 return state;
}

test('the planner respects configured agents and retains the Codex-first default',()=>{
 expect(coordinatorCli.plannerAgent(['claude'],[])).toBe('claude');
 expect(coordinatorCli.plannerAgent(['codex'],[{status:'running',agent:'codex',spec:{kind:'build'}}])).toBe('codex');
 expect(coordinatorCli.plannerAgent(undefined,[])).toBe('codex');
 expect(coordinatorCli.plannerAgent([],[])).toBeNull();
});

test('the planner prefers a configured agent without a current model build',()=>{
 expect(coordinatorCli.plannerAgent(['codex','claude'],[{status:'running',agent:'codex',spec:{kind:'build'}}])).toBe('claude');
 expect(coordinatorCli.plannerAgent(['claude','codex'],[{status:'running',agent:'claude',spec:{kind:'build'}}])).toBe('codex');
 expect(coordinatorCli.plannerAgent(['codex','claude'],[{status:'succeeded',agent:'codex',spec:{kind:'build'}}])).toBe('codex');
 expect(coordinatorCli.plannerAgent(['codex','claude'],[{status:'running',agent:'codex',spec:{kind:'qualify'}}])).toBe('codex');
});

test('coordinator ownership recovers a dead plan writer before loading the saved queue',async()=>{
 const directory=fixture(),state=queuedState();saveState(state,directory);
 const dead=deadWriter(directory);
 expect(await claimCoordinatorState('start-recovered',directory)).toEqual(state);
 expect(JSON.parse(readFileSync(join(directory,'owner.json'),'utf8'))).toMatchObject({pid:process.pid,nonce:'start-recovered'});
 expect(existsSync(lockFile(directory))).toBe(false);
 expect(existsSync(dead.intent)).toBe(false);
 const archive=join(directory,'plan-lock-recovery'),files=readdirSync(archive);
 expect(files).toHaveLength(1);
 expect(readFileSync(join(archive,files[0]!),'utf8')).toBe(dead.bytes);
});

test('concurrent coordinator starts recover one abandoned writer and retain exactly one owner',async()=>{
 const directory=fixture();deadWriter(directory);
 const nonces=['start-first','start-second'];
 const results=await Promise.allSettled(nonces.map(nonce=>claimCoordinatorState(nonce,directory,()=>true)));
 const winner=results.findIndex(result=>result.status==='fulfilled');
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
 const failure=results.find(result=>result.status==='rejected');
 expect(failure?.status==='rejected'&&String(failure.reason)).toContain('coordinator already owned');
 expect(JSON.parse(readFileSync(join(directory,'owner.json'),'utf8')).nonce).toBe(nonces[winner]);
 expect(readdirSync(join(directory,'plan-lock-recovery'))).toHaveLength(1);
 expect(readdirSync(directory).filter(name=>name.endsWith('.intent.json'))).toEqual([]);
});

test('startup waits for a live plan writer and reads the queue that writer finishes',async()=>{
 const directory=fixture(),state=queuedState();
 let release!:()=>void;
 const writer=withPlanWrite(async()=>{
  await new Promise<void>(resolve=>{release=resolve;});
  saveState(state,directory);
 },directory);
 const bytes=readFileSync(lockFile(directory),'utf8');
 const startup=claimCoordinatorState('start-after-writer',directory);
 try{
  await Bun.sleep(50);
  expect(readFileSync(lockFile(directory),'utf8')).toBe(bytes);
  expect(existsSync(join(directory,'owner.json'))).toBe(false);
  expect(existsSync(join(directory,'plan-lock-recovery'))).toBe(false);
 }finally{release();}
 await writer;
 expect(await startup).toEqual(state);
 expect(existsSync(lockFile(directory))).toBe(false);
 expect(existsSync(join(directory,'plan-lock-recovery'))).toBe(false);
});

test('ownerHolds: the nonce in the command line holds, a pid that started after the claim does not',()=>{
 const owner={pid:7,nonce:'resume-abc',at:1_000_000},up=()=>true,down=()=>false,started=(t:number|undefined)=>()=>new Map(t===undefined?[]:[[7,t]]);
 // The command line holds the nonce.
 expect(ownerHolds(owner,()=>'bun coordinator-cli.ts --run resume-abc',down,started(undefined))).toBe(true);
 // No process runs under the pid.
 expect(ownerHolds(owner,()=>null,down,started(undefined))).toBe(false);
 // A coordinator that started without a token: its command line lacks the nonce, and it started before its claim.
 expect(ownerHolds(owner,()=>'bun coordinator-cli.ts --run',up,started(owner.at-30_000))).toBe(true);
 expect(ownerHolds(owner,()=>'bun coordinator-cli.ts --run',up,started(owner.at+OWNER_START_SLACK_MS))).toBe(true);
 // Another program reused the pid: it started after the claim.
 expect(ownerHolds(owner,()=>'claude.exe --output-format stream-json',up,started(owner.at+OWNER_START_SLACK_MS+1))).toBe(false);
 // The process table has no row for the pid.
 expect(ownerHolds(owner,()=>'claude.exe',up,started(undefined))).toBe(false);
 // Nothing proves a reuse: no command line, no process table, no claim time.
 expect(ownerHolds(owner,()=>null,up,started(owner.at+1_000_000))).toBe(true);
 expect(ownerHolds(owner,()=>'claude.exe',up,()=>null)).toBe(true);
 expect(ownerHolds({pid:7,nonce:'resume-abc'},()=>'claude.exe',up,started(owner.at+1_000_000))).toBe(true);
});

// A running program that is not a coordinator, under the saved pid, with a claim older than its start.
const processTest=process.platform==='win32'?test:test.skip;
processTest('a claim over an owner file whose pid another running program reused succeeds, and a younger claim is refused',async()=>{
 const directory=fixture(),child=Bun.spawn([process.execPath,'-e','setTimeout(()=>{},30000)'],{stdout:'ignore',stderr:'ignore'});
 try{
  saveState(queuedState(),directory);
  await Bun.sleep(500);
  atomicJson(join(directory,'owner.json'),{pid:child.pid,nonce:'old-token-not-in-command-line',at:Date.now()-120_000});
  await claimCoordinatorState('start-over-reused-pid',directory);
  expect(JSON.parse(readFileSync(join(directory,'owner.json'),'utf8')).nonce).toBe('start-over-reused-pid');
  atomicJson(join(directory,'owner.json'),{pid:child.pid,nonce:'old-token-not-in-command-line',at:Date.now()+120_000});
  await expect(claimCoordinatorState('start-over-live-owner',directory)).rejects.toThrow('coordinator already owned');
 }finally{child.kill();}
});

test('plannerPaused reflects .practice/stop-planner presence',()=>{
 const directory=fixture();
 expect(coordinatorCli.plannerPaused(directory)).toBe(false);
 mkdirSync(join(directory,'.practice'),{recursive:true});
 const stopFile=join(directory,'.practice','stop-planner');
 writeFileSync(stopFile,'quota hold');
 expect(coordinatorCli.plannerPaused(directory)).toBe(true);
 unlinkSync(stopFile);
 expect(coordinatorCli.plannerPaused(directory)).toBe(false);
});

