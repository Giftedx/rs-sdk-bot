import{test,expect}from'bun:test';
import{deliveryTask,isSavedProofVerifier,withNativeStartup,nativeDeferralEvidence,NATIVE_STARTUP_GB,SOURCE_STARTUP_GB}from'../src/delivery-cli';
import{FREE_FLOOR_GB,PRACTICE_RESERVE_GB}from'../../core/src/memory';
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
 for(const id of ['ammo-order','blood-chest-order','druid-meats-order','iron-progress-order','magic-order','prayer-order','quest-order','ranged-train']){
  const task=deliveryTask(id),saved=task.checks.find(c=>c.phase==='consumer')!;
  expect(isSavedProofVerifier(saved)).toBe(true);
  expect(task.checks.filter(c=>c.phase==='practice').some(isSavedProofVerifier)).toBe(false);
  expect(isSavedProofVerifier({...saved,command:saved.command.slice(0,2)})).toBe(false);
  expect(isSavedProofVerifier({...saved,command:[...saved.command,'--run']})).toBe(false);
 }
 const unreviewed=deliveryTask('rune-carrier-stage').checks.find(c=>c.phase==='consumer')!;
 expect(isSavedProofVerifier(unreviewed)).toBe(false);
});
