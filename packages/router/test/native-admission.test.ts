import{test,expect}from'bun:test';
import{deliveryTask,isSavedProofVerifier,withNativeStartup,nativeDeferralEvidence,nativeNeedGB,checkDeferral,benchEngines,NATIVE_STARTUP_GB,SOURCE_STARTUP_GB}from'../src/delivery-cli';
import{FREE_FLOOR_GB,PRACTICE_RESERVE_GB,HOST_DEFERRED_EXIT,benchStartGB}from'../../core/src/memory';
import{memoryProblems}from'../../../scripts/measure/bench-start-check';
import{qualificationExit}from'../src/bank-observer-qualification';
import{mkdtempSync,writeFileSync,readdirSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{withPracticeTurn}from'../../practice/src/proof-lock';

function fixture(){let now=0,free=NATIVE_STARTUP_GB-1,stopped=false,starts=0;const observations:any[]=[];
 const deps={now:()=>now,freeGB:()=>free,stopped:()=>stopped,sleep:async(ms:number)=>{now+=ms;},progress:(v:any):void=>{observations.push(v);}};
 return{deps,observations,start:async()=>++starts,starts:()=>starts,setFree:(v:number)=>{free=v;},stop:()=>{stopped=true;}};
}
test('source preparation needs less headroom than native startup, both above the floor',()=>{
 expect(SOURCE_STARTUP_GB).toBe(FREE_FLOOR_GB+2);expect(NATIVE_STARTUP_GB).toBe(FREE_FLOOR_GB+PRACTICE_RESERVE_GB);expect(SOURCE_STARTUP_GB).toBeLessThan(NATIVE_STARTUP_GB);
});
test('the actual delivery admission wrapper never calls its child starter below the native startup threshold',async()=>{
 const f=fixture();f.deps.sleep=async()=>{expect(f.starts()).toBe(0);f.setFree(NATIVE_STARTUP_GB);};
 expect(await withNativeStartup(f.start,f.deps,2000)).toBe(1);expect(f.starts()).toBe(1);
 expect(f.observations.map(v=>v.state)).toEqual(['waiting-native-headroom','native-ready']);
});
test('a stop while waiting refuses before child creation even when RAM becomes ready',async()=>{
 const f=fixture();f.deps.sleep=async()=>{f.stop();f.setFree(NATIVE_STARTUP_GB+1);};
 await expect(withNativeStartup(f.start,f.deps,2000)).rejects.toThrow('owner stopped');expect(f.starts()).toBe(0);
});
test('bounded headroom wait and invalid readings never create a native child',async()=>{
 const f=fixture();await expect(withNativeStartup(f.start,f.deps,2000)).rejects.toThrow('startup headroom');expect(f.starts()).toBe(0);
 for(const value of [NaN,Infinity,-1]){const x=fixture();x.setFree(value);await expect(withNativeStartup(x.start,x.deps,2000)).rejects.toThrow('memory observation');expect(x.starts()).toBe(0);}
});
test('a stop or RAM loss during admission recording is checked again before starting',async()=>{
 const stopped=fixture();stopped.setFree(NATIVE_STARTUP_GB);stopped.deps.progress=()=>stopped.stop();
 await expect(withNativeStartup(stopped.start,stopped.deps,2000)).rejects.toThrow('owner stopped');expect(stopped.starts()).toBe(0);
 const low=fixture();low.setFree(NATIVE_STARTUP_GB);low.deps.progress=()=>low.setFree(NATIVE_STARTUP_GB-1);
 await expect(withNativeStartup(low.start,low.deps,2000)).rejects.toThrow('startup headroom');expect(low.starts()).toBe(0);
});
test('the real admission timeout produces host-deferral report fields; other errors never do',async()=>{
 const f=fixture();let reason='';try{await withNativeStartup(f.start,f.deps,1000);}catch(error){reason=String(error);}
 expect(nativeDeferralEvidence(reason)).toEqual({hostDeferred:true});expect(f.starts()).toBe(0);
 for(const other of ['check failed','Error: native admission owner stopped; no child started','child stdout HOST_DEFERRED_NATIVE_HEADROOM: text'])expect(nativeDeferralEvidence(other)).toEqual({});
});

test('only audited saved-result commands can run without a practice turn',()=>{
 const checks=[
  ['cow-progress-order-saved','packages/practice/src/cow-progress-order-proof.ts'],
  ['cow-progress-order-saved','packages/practice/src/cow-progress-isolated-proof.ts'],
  ['quest-sweep-saved','packages/practice/src/quest-sweep-proof.ts'],
  ['session-recovery-only-verified','scripts/session-check.ts'],
 ];
 for(const [id,script] of checks){
  const check={id:id!,phase:'consumer' as const,command:['bun',script!,'--verify'],timeoutMs:30000};
  expect(isSavedProofVerifier(check)).toBe(true);
  expect(isSavedProofVerifier({...check,phase:'practice'})).toBe(false);
  expect(isSavedProofVerifier({...check,id:'other-consumer'})).toBe(false);
  expect(isSavedProofVerifier({...check,command:['bun',script!]})).toBe(false);
  expect(isSavedProofVerifier({...check,command:[...check.command,'--extra']})).toBe(false);
  expect(isSavedProofVerifier({...check,command:['bun','scripts/other.ts','--verify']})).toBe(false);
 }
});

test('the declared quest saved consumer accepts only audited bounded case selectors',()=>{
 const check=deliveryTask('quest-sweep').checks.find(c=>c.id==='quest-sweep-saved')!;
 expect(isSavedProofVerifier(check)).toBe(true);
 const base=['bun','packages/practice/src/quest-sweep-proof.ts','--verify'];
 const cases=['scorpion-barcrawl','scorpion-ranged-barcrawl','scorpion-complete-refusal','elena-heckel-dust'];
 for(const id of cases)expect(isSavedProofVerifier({...check,command:[...base,`--case=${id}`]})).toBe(true);
 expect(isSavedProofVerifier({...check,command:[...base,...cases.map(id=>`--case=${id}`)]})).toBe(true);
 for(const extra of [
  ['--case='],['--case=unknown'],['--case=ball-worn-kit'],['--case'],['scorpion-barcrawl'],
  ['--case','scorpion-barcrawl'],['--case=scorpion-barcrawl','--case=scorpion-barcrawl'],
  ['--case=elena-heckel-dust','--case=elena-heckel-dust'],['--case=elena-heckel-dust','--snapshot'],
  ['--case=scorpion-barcrawl','--snapshot'],['--case=scorpion-barcrawl','--verify'],
  [...cases.map(id=>`--case=${id}`),'--case=other'],
 ])expect(isSavedProofVerifier({...check,command:[...base,...extra]})).toBe(false);
 expect(isSavedProofVerifier({...check,phase:'practice'})).toBe(false);
 expect(isSavedProofVerifier({...check,id:'other-consumer'})).toBe(false);
 expect(isSavedProofVerifier({...check,command:['bun','scripts/other.ts','--verify','--case=scorpion-barcrawl']})).toBe(false);
 expect(isSavedProofVerifier({...check,command:['bun',base[1]!,'--case=scorpion-barcrawl','--verify']})).toBe(false);
 const other=deliveryTask('prayer-order').checks.find(c=>c.phase==='consumer')!;
 expect(isSavedProofVerifier({...other,command:[...other.command,'--case=scorpion-barcrawl']})).toBe(false);
});

test('an expired practice queue wait preserves the host-deferral path without running a check',async()=>{
 const f=fixture(),file=join(mkdtempSync(join(tmpdir(),'native-turn-defer-')),'turn.lock');
 writeFileSync(file,JSON.stringify({pid:999999,at:0}));
 let reason='';
 try{await withPracticeTurn(file,f.start,{alive:()=>true,waitMs:0});}catch(error){reason=String(error);}
 expect(nativeDeferralEvidence(reason)).toEqual({hostDeferred:true});
 expect(f.starts()).toBe(0);
 expect(readdirSync(file+'.queue')).toEqual([]);
 for(const other of ['Error: check timed out','Error: practice turn owner stopped; no child started','worker says practice turn wait expired']){
  expect(nativeDeferralEvidence(other)).toEqual({});
 }
});

test('declared saved consumers bypass only the practice turn',()=>{
 for(const id of ['ammo-order','blood-chest-order','druid-meats-order','ge-bulk-order','iron-progress-order','magic-order','prayer-order','quest-order','ranged-train','rune-bank-craft']){
  const task=deliveryTask(id);
  expect(task.checks.filter(c=>c.phase==='practice').some(isSavedProofVerifier)).toBe(false);
  for(const saved of task.checks.filter(c=>c.phase==='consumer')){
   expect(isSavedProofVerifier(saved)).toBe(true);
   expect(isSavedProofVerifier({...saved,command:saved.command.slice(0,2)})).toBe(false);
   expect(isSavedProofVerifier({...saved,command:[...saved.command,'--run']})).toBe(false);
  }
 }
 const unreviewed=deliveryTask('rune-carrier-stage').checks.find(c=>c.phase==='consumer')!;
 expect(isSavedProofVerifier(unreviewed)).toBe(false);
});

// The coordinator built session-recovery-only nine times with no code defect: the check that runs the owned bank
// observation passed its native admission at 6.6 GiB free, and the bench then refused to start because it needed 7.5.
const BENCH_CHECK={id:'bank-observation-native',command:['bun','run','bench','^extra:owned-bank-observation$','--profile','--budget','10']};
const BEHIND_FLEET={floorGB:FREE_FLOOR_GB,fleet:{bots:16,reserveGB:2}};
test('a check that runs the bench is admitted at the memory that the bench needs, from one rule',()=>{
 // 16 live bots with 2 GiB held for bot starts: the floor, the reserve and one engine of 1.5 GiB.
 expect(nativeNeedGB(BENCH_CHECK,BEHIND_FLEET)).toBe(7.5);
 expect(nativeNeedGB(BENCH_CHECK,BEHIND_FLEET)).toBeGreaterThan(NATIVE_STARTUP_GB);
 // The bench's own refusal and the admission agree at each value of the free memory.
 for(const engines of [1,2,4]){
  const check={...BENCH_CHECK,command:[...BENCH_CHECK.command,'--parallel',String(engines)]},need=nativeNeedGB(check,BEHIND_FLEET);
  expect(need).toBe(benchStartGB({floorGB:FREE_FLOOR_GB,reserveGB:2,engines,fleet:true}));
  const facts=(freeGB:number)=>({procs:null,selfPid:1,busyPorts:[],freeGB,floorGB:FREE_FLOOR_GB,engines,fleet:BEHIND_FLEET.fleet});
  expect(memoryProblems(facts(need))).toEqual([]);
  expect(memoryProblems(facts(need-0.05)).length).toBe(1);
 }
 // No swarm: the bench needs the tool floor and the engine, less than the practice startup rule, so that rule stays.
 expect(nativeNeedGB(BENCH_CHECK,{floorGB:1,fleet:null})).toBe(NATIVE_STARTUP_GB);
 // Any other command keeps the practice startup rule, beside a fleet too.
 expect(nativeNeedGB({command:['bun','packages/practice/src/quest-sweep-proof.ts']},BEHIND_FLEET)).toBe(NATIVE_STARTUP_GB);
 expect(nativeNeedGB({command:['bun','scripts/other.ts','bench']},BEHIND_FLEET)).toBe(NATIVE_STARTUP_GB);
 expect(benchEngines({command:['bun','scripts/measure/aio-practice-bench.ts','^x$']})).toBe(1);
 expect(benchEngines({command:['bun','run','bench','^x$','--parallel','3']})).toBe(3);
 expect(benchEngines({command:['bun','run','test']})).toBeNull();
});

test('the native admission of a bench check waits for the memory that the bench needs, and never starts it under that',async()=>{
 const f=fixture(),need=7.5;
 let free=6.6;f.deps.freeGB=()=>free;
 f.deps.sleep=async()=>{expect(f.starts()).toBe(0);free=need;};
 expect(await withNativeStartup(f.start,{...f.deps,requiredGB:()=>need},2000)).toBe(1);
 // The practice startup rule alone would have started at 6.6.
 expect(f.observations.map(v=>v.state)).toEqual(['waiting-native-headroom','native-ready']);
 expect(f.observations.every(v=>v.requiredGB===need)).toBe(true);
 const low=fixture();low.deps.freeGB=()=>6.6;
 await expect(withNativeStartup(low.start,{...low.deps,requiredGB:()=>need},2000)).rejects.toThrow('startup headroom');expect(low.starts()).toBe(0);
 // A requirement under the practice startup rule, or one that is not a number, starts nothing.
 for(const value of [NATIVE_STARTUP_GB-1,NaN]){const x=fixture();x.setFree(100);await expect(withNativeStartup(x.start,{...x.deps,requiredGB:()=>value},2000)).rejects.toThrow('memory requirement');expect(x.starts()).toBe(0);}
});

test('a bench that exits on its start refusal, or a script that passes on a deferral, is a host deferral and not a code failure',()=>{
 for(const exit of [2,4]){
  const reason=checkDeferral(BENCH_CHECK,exit);
  expect(reason).not.toBeNull();
  expect(nativeDeferralEvidence('Error: HOST_DEFERRED_NATIVE_HEADROOM: '+reason)).toEqual({hostDeferred:true});
 }
 expect(checkDeferral({id:'bank-observer',command:['bun','packages/router/src/bank-observer-qualification.ts']},HOST_DEFERRED_EXIT)).toContain('host deferral');
 expect(checkDeferral(BENCH_CHECK,HOST_DEFERRED_EXIT)).not.toBeNull();
 // A failed case (1), a pass (0) and any other command that exits with 2 or 4 are not deferrals.
 expect(checkDeferral(BENCH_CHECK,1)).toBeNull();
 expect(checkDeferral(BENCH_CHECK,0)).toBeNull();
 expect(checkDeferral({id:'other',command:['bun','scripts/other.ts']},2)).toBeNull();
 expect(checkDeferral({id:'other',command:['bun','scripts/other.ts']},4)).toBeNull();
});

test('the bank observer check exits with the host deferral code for a deferred inner delivery and throws for a failed one',()=>{
 expect(qualificationExit({ok:true,reason:'native capability and named consumer verified'})).toBeNull();
 const deferred=qualificationExit({ok:false,hostDeferred:true,reason:'Error: HOST_DEFERRED_NATIVE_HEADROOM: the bench ended with exit 2'});
 expect(deferred?.exit).toBe(HOST_DEFERRED_EXIT);
 expect(nativeDeferralEvidence(deferred!.message)).toEqual({hostDeferred:true});
 expect(qualificationExit({ok:false,reason:'check failed'})).toBeNull();
 expect(qualificationExit({ok:false,hostDeferred:false,reason:'check failed'})).toBeNull();
});
