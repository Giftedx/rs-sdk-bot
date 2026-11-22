import {closeSync,copyFileSync,existsSync,openSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import {freemem} from 'node:os';
import {join} from 'node:path';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../../core/src/memory';
import {killTree} from '../../../core/src/proc';
import {canBind} from '../ports';
import {startStack} from '../stack';
import {freshRuneChildTimeout,type FreshRuneStackDeps,PORT_STEP_MS,PORT_WAIT_MS,type ProofBudget,repoRoot,workMs} from './contracts';

// The stack of the proof before this one has stopped its engine, and its ports can stay bound a moment longer (two stacks
// follow each other in one check: the 150 ms group and the 400 ms pacing fixture). The next stack waits for 8888 and 7780
// for PORT_WAIT_MS, in steps of PORT_STEP_MS, and then refuses with the ports named. A recorded stack (pids.json) or a
// foreign lock still refuses at once: another owner is not a race.
export async function waitForProofPorts(portsFree:()=>boolean,sleep:(ms:number)=>Promise<void>=ms=>Bun.sleep(ms)):Promise<number>{
 let waited=0;
 while(!portsFree()){
  if(waited>=PORT_WAIT_MS)throw Error('practice stack ownership or occupied ports: 8888 or 7780 still bound after '+PORT_WAIT_MS+' ms; refuse adoption');
  await sleep(PORT_STEP_MS);waited+=PORT_STEP_MS;
 }
 return waited;
}

export async function withFreshRuneStack<T>(directory:string,work:(budget:ProofBudget)=>Promise<T>,deps:FreshRuneStackDeps={
 practice:join(repoRoot,'.practice'),free:freemem,portsFree:()=>canBind(8888)&&canBind(7780),start:startStack,
},tickMs:150|400=150):Promise<T>{
 const deadline=Date.now()+workMs;
 if(deps.free()<PRACTICE_STARTUP_GB*2**30)throw Error(`insufficient practice startup reserve: need${PRACTICE_STARTUP_GB}GiB`);
 const lock=join(deps.practice,'delivery-practice.lock'),pids=join(deps.practice,'pids.json');
 const owner=JSON.stringify({pid:process.pid,directory,task:'fresh-rune-supply-order'});
 const fd=openSync(lock,'wx');
 let stack:Awaited<ReturnType<typeof startStack>>|undefined,ownedPids:string|undefined;
 const ownsLock=()=>existsSync(lock)&&readFileSync(lock,'utf8')===owner;
 const budget={deadline,check:()=>{
  if(Date.now()>=deadline)throw Error('fresh rune proof work deadline; retain evidence');
  if(deps.free()<FREE_FLOOR_GB*2**30)throw Error(`practice memory floor: need${FREE_FLOOR_GB}GiB free`);
  if(!ownsLock())throw Error('practice lock ownership changed; retain evidence');
 }};
 try{
  writeFileSync(fd,owner);writeFileSync(join(directory,'practice-owner.json'),owner,{flag:'wx'});
  // Do not overwrite even stale owner evidence. Recovery belongs to the harness.
  if(existsSync(pids))throw Error('practice stack ownership or occupied ports; refuse adoption');
  await waitForProofPorts(deps.portsFree,deps.sleep);
  if(deps.free()<PRACTICE_STARTUP_GB*2**30)throw Error(`insufficient fresh practice startup reserve: need${PRACTICE_STARTUP_GB}GiB`);
  stack=await deps.start({tickMs,xpRate:25,readyTimeoutMs:60000});
  ownedPids=readFileSync(pids,'utf8');
  writeFileSync(join(directory,'stack-owner.json'),ownedPids,{flag:'wx'});
  budget.check();
  return await work(budget);
 }finally{
  try{
   if(stack){
    // Stack.stop uses pids.json. Never let it target a replacement owner's PIDs.
    if(!ownsLock()||ownedPids===undefined||!existsSync(pids)||readFileSync(pids,'utf8')!==ownedPids)
     throw Error('practice stack ownership changed; retained lock/PID evidence, no foreign stop');
    try{for(const [service,path] of Object.entries(stack.logs))if(existsSync(path))copyFileSync(path,join(directory,'stack-'+service+'.log'));}
    finally{await stack.stop();}
   }
  }finally{closeSync(fd);if(ownsLock())unlinkSync(lock);}
 }
}

// Both native paths use the same child admission, floor, deadline and cleanup owner.
export async function freshRuneCommand(directory:string,budget:ProofBudget,label:string,args:string[],save:string,env:Record<string,string>={}){
 budget.check();
 const timeoutMs=freshRuneChildTimeout(label,budget.deadline);
 const child=Bun.spawn(['bun',...args],{cwd:repoRoot,env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'1',RUNE_COOK_DIAGNOSTIC:'',RUNE_AIR_EXIT_DIAGNOSTIC:'',...env},
  stdout:Bun.file(join(directory,label+'.log')),stderr:Bun.file(join(directory,label+'.err')),windowsHide:true});
 let failure='',termination:Promise<void>|undefined;
 const terminate=(reason:string)=>{if(!termination){failure=reason;termination=killTree(child.pid);}};
 const timer=setTimeout(()=>terminate('child deadline'),timeoutMs);
 const floor=setInterval(()=>{try{budget.check();}catch(error){terminate(String(error));}},1000);
 try{
  const code=await child.exited;await termination;
  writeFileSync(join(directory,label+'-outcome.json'),JSON.stringify({code:failure?-1:code,failure,timeoutMs}),{flag:'wx'});
  if(failure)throw Error(`${label}: ${failure}; retain logs and save`);
  return code;
 }catch(error){
  if(existsSync(save))copyFileSync(save,join(directory,label+'-failed.sav'));
  throw error;
 }finally{clearTimeout(timer);clearInterval(floor);if(child.exitCode===null)await killTree(child.pid);await termination;}
}

export async function freshRuneRecoveryClock(tickMs=150){
 const response=await fetch('http://localhost:8898/tickstats',{signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw Error('air recovery server clock unavailable');
 const stats=await response.json() as {tick:number;tickRate:number};
 if(!Number.isSafeInteger(stats.tick)||stats.tick<1||stats.tickRate!==tickMs)throw Error('air recovery server clock/configuration differs');
 return stats.tick;
}
