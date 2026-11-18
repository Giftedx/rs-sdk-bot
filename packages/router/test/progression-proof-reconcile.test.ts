import {expect,test} from 'bun:test';
import {initialState,addTasks,startTask,finishTask} from '../src/coordinator';
import {createProgressionProofReconciler,type ProgressionProofReconcileDeps} from '../src/progression-proof-reconcile';
import type {DiscoveredProgressionDelivery} from '../src/progression-proof-discovery';
import type {DeliveryTask} from '../src/delivery';
const task:DeliveryTask={id:'ranged-train',goal:'Finite useful Ranged',entry:'scripts/ranged-train.ts',files:['scripts/ranged-train.ts'],consumer:'Finite Ranged85',checks:[{id:'unit',phase:'regression',command:['bun','check.ts'],timeoutMs:1000},{id:'native',phase:'practice',command:['bun','native.ts'],timeoutMs:1000},{id:'saved',phase:'consumer',command:['bun','saved.ts'],timeoutMs:1000}]};
const report={id:'ranged-train' as const,goal:task.goal,ok:true as const,stage:'delivered' as const,evidence:'native' as const,consumer:task.consumer,reason:'native capability and named consumer verified',checks:[],source:'a'.repeat(64),runtimeRevision:'b'.repeat(64),directory:'/native',at:2,files:[]};
const discovered:DiscoveredProgressionDelivery={directory:report.directory,report,reportSha256:'c'.repeat(64)},proof={path:'/immutable/proof.json',sha256:'d'.repeat(64)};
function fixture(){let registered=0,indexed=false;const deps:ProgressionProofReconcileDeps={discover:()=>[discovered],task:()=>task,binding:()=>({fingerprint:report.source,runtime:report.runtimeRevision}),register:async()=>{registered++;indexed=true;return{registered:1,index:'/index',proof};},indexed:()=>indexed};return{deps,calls:()=>registered,setIndexed:(value:boolean)=>{indexed=value;}};}
test('retained current native delivery registers through the existing sole registrar and caches an intact index',async()=>{
 const f=fixture(),reconcile=createProgressionProofReconciler('/root',f.deps);
 expect((await reconcile(initialState()))[0]).toMatchObject({status:'registered',proof});expect((await reconcile(initialState()))[0]).toMatchObject({status:'unchanged'});expect(f.calls()).toBe(1);
 f.setIndexed(false);expect((await reconcile(initialState()))[0]?.status).toBe('registered');expect(f.calls()).toBe(2);
});
test('stale native runtime or contract cannot reach the registrar',async()=>{
 for(const binding of [{fingerprint:'e'.repeat(64),runtime:report.runtimeRevision},{fingerprint:report.source,runtime:'e'.repeat(64)}]){const f=fixture();f.deps.binding=()=>binding;expect((await createProgressionProofReconciler('/root',f.deps)(initialState()))[0]?.status).toBe('held');expect(f.calls()).toBe(0);}
});
test('registration failure retries without mutating accepted qualification or losing its native evidence',async()=>{
 const state=initialState();addTasks(state,[{id:'q',kind:'qualify',goal:'skills',capability:'ranged-train',dependsOn:[],priority:1,estimatedMs:1,why:'finite consumer'}]);startTask(state,'q',1,'q-run');finishTask(state,{taskId:'q',runId:'q-run',ok:true,at:3,output:{ok:true,delivery:report}});
 const before=JSON.stringify(state),f=fixture();let attempts=0;f.deps.register=async()=>{if(++attempts===1)throw Error('index temporarily held');return{registered:1,index:'/index',proof};};
 const reconcile=createProgressionProofReconciler('/root',f.deps);expect((await reconcile(state))[0]).toMatchObject({status:'retry',taskId:'q',runId:'q-run'});expect((await reconcile(state))[0]?.status).toBe('registered');expect(attempts).toBe(2);expect(JSON.stringify(state)).toBe(before);
});
test('accepted receipt and discovery of the same directory cause one registration with actual task attribution',async()=>{
 const state=initialState();addTasks(state,[{id:'q',kind:'qualify',goal:'skills',capability:'ranged-train',dependsOn:[],priority:1,estimatedMs:1,why:'finite consumer'}]);startTask(state,'q',1,'q-run');finishTask(state,{taskId:'q',runId:'q-run',ok:true,at:3,output:{ok:true,delivery:report}});
 const f=fixture(),out=await createProgressionProofReconciler('/root',f.deps)(state);expect(f.calls()).toBe(1);expect(out).toHaveLength(1);expect(out[0]).toMatchObject({taskId:'q',runId:'q-run'});
});
test('failed and live receipts do not become native qualification inputs',async()=>{
 for(const kind of ['qualify','run']as const){const state=initialState();addTasks(state,[{id:'q',kind,goal:'skills',capability:'ranged-train',account:kind==='run'?'Unit':undefined,accept:kind==='run'?{skills:{Ranged:85}}:undefined,dependsOn:[],priority:1,estimatedMs:1,why:'finite consumer'}]);startTask(state,'q',1,'q-run');finishTask(state,{taskId:'q',runId:'q-run',ok:kind==='run',at:3,output:{ok:true,delivery:report}});const f=fixture();f.deps.discover=()=>[];expect(await createProgressionProofReconciler('/root',f.deps)(state)).toEqual([]);expect(f.calls()).toBe(0);}
});
test('discovery errors remain retryable and do not discard the scheduling state',async()=>{
 const state=initialState(),before=JSON.stringify(state),f=fixture();f.deps.discover=()=>{throw Error('directory busy');};expect((await createProgressionProofReconciler('/root',f.deps)(state))[0]?.status).toBe('retry');expect(JSON.stringify(state)).toBe(before);
});
test('a large retained backlog leaves bounded work for later passes',async()=>{
 const f=fixture();f.deps.discover=()=>Array.from({length:64},(_,i)=>({...discovered,directory:'/native/'+i,report:{...report,directory:'/native/'+i},reportSha256:String(i).padStart(64,'0')}));
 const out=await createProgressionProofReconciler('/root',f.deps)(initialState());expect(f.calls()).toBeLessThanOrEqual(4);expect(f.calls()).toBeGreaterThan(0);expect(out.filter(r=>r.status==='retry').length).toBeGreaterThanOrEqual(60);
});
test('reports that fail registration on each pass do not keep the import budget from a later valid report',async()=>{
 const f=fixture(),rows=Array.from({length:5},(_,i)=>({...discovered,directory:'/native/'+i,report:{...report,directory:'/native/'+i},reportSha256:String(i).padStart(64,'0')}));
 const attempts:string[]=[];f.deps.discover=()=>rows;
 f.deps.register=async(_task,delivery)=>{attempts.push(delivery.directory!);if(delivery.directory!=='/native/4')throw Error('retained raw artifact missing');return{registered:1,index:'/index',proof};};
 const reconcile=createProgressionProofReconciler('/root',f.deps);
 const first=await reconcile(initialState());
 expect(attempts).toEqual(['/native/0','/native/1','/native/2','/native/3']);expect(first.every(r=>r.status==='retry')).toBe(true);
 const second=await reconcile(initialState());
 expect(attempts[4]).toBe('/native/4');expect(second.find(r=>r.directory==='/native/4')).toMatchObject({status:'registered',proof});
 expect(attempts).toHaveLength(8);
});
