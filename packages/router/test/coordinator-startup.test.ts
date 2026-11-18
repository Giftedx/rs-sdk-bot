import {afterEach,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {existsSync,linkSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withPlanWrite} from '../../core/src/plan-lock';
import {addTasks,initialState} from '../src/coordinator';
import {claimCoordinatorState} from '../src/coordinator-cli';
import * as coordinatorCli from '../src/coordinator-cli';
import {saveState} from '../src/coordinator-store';

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
