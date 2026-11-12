import {createHash} from 'node:crypto';
import {appendFileSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync,statSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import ts from 'typescript';
import {existsSync} from 'node:fs';
import {freemem} from 'node:os';
import {capabilityRevision} from '../../core/src/worker-release';
import {killTree} from '../../practice/src/proc';
import {PRACTICE_TURN_WAIT_EXPIRED,recoverProofLock,withPracticeTurn} from '../../practice/src/proof-lock';
import {deliver,validateDelivery,type DeliveryTask,type DeliveryCheck} from './delivery';

const root=resolve(import.meta.dir,'../../..');
// Source preparation needs SOURCE_STARTUP_GB free: the free-memory floor and a reserve (packages/core/src/memory.ts).
// Native launch requires PRACTICE_STARTUP_GB; this is checked at the actual child boundary.
import {SOURCE_STARTUP_GB,PRACTICE_STARTUP_GB as NATIVE_STARTUP_GB} from '../../core/src/memory';
export {SOURCE_STARTUP_GB,NATIVE_STARTUP_GB};
export function nativeDeferralEvidence(reason:string):{hostDeferred?:boolean}{
 const message=reason.replace(/^Error: /,'');
 return message.startsWith('HOST_DEFERRED_NATIVE_HEADROOM:')||message===PRACTICE_TURN_WAIT_EXPIRED?{hostDeferred:true}:{};
}
type SavedProofPolicy=Readonly<Record<string,readonly string[]>>;
function readSavedProofPolicy(base:string):SavedProofPolicy{
 const policy=JSON.parse(readFileSync(join(base,'packages/router/src/saved-proof-verifiers.json'),'utf8'));
 if(!policy||typeof policy!=='object'||Array.isArray(policy)
  ||Object.values(policy).some(v=>!Array.isArray(v)||v.some(p=>typeof p!=='string')))throw Error('invalid saved proof verifier policy');
 return policy;
}
// These exact consumer invocations only validate saved files in DELIVERY_DIR.
function savedProofVerifierAllowed(check:DeliveryCheck,policy:SavedProofPolicy):boolean{
 const [bun,script,flag]=check.command;
 return check.phase==='consumer'&&check.command.length===3&&bun==='bun'&&flag==='--verify'
  &&script!==undefined&&Object.hasOwn(policy,check.id)&&policy[check.id]!.includes(script);
}
export function isSavedProofVerifier(check:DeliveryCheck):boolean{
 return savedProofVerifierAllowed(check,readSavedProofPolicy(root));
}
type NativeAdmissionDeps={now:()=>number;freeGB:()=>number;stopped:()=>boolean;sleep:(ms:number)=>Promise<void>;progress:(value:{state:string;at:number;freeGB:number;requiredGB:number;deadline:number})=>void};
export async function withNativeStartup<T>(start:()=>Promise<T>,deps:NativeAdmissionDeps,waitMs=900000):Promise<T>{
 if(!Number.isSafeInteger(waitMs)||waitMs<1||waitMs>900000)throw Error('invalid native admission wait budget');
 const deadline=deps.now()+waitMs;let lastState='';
 const report=(state:string,at:number,freeGB:number)=>{if(state!==lastState){deps.progress({state,at,freeGB,requiredGB:NATIVE_STARTUP_GB,deadline});lastState=state;}};
 for(;;){
  if(deps.stopped())throw Error('native admission owner stopped; no child started');
  const at=deps.now();if(at>=deadline)throw Error('HOST_DEFERRED_NATIVE_HEADROOM: native startup headroom wait expired; no child started');
  const freeGB=deps.freeGB();
  if(!Number.isFinite(freeGB)||freeGB<0)throw Error('invalid native memory observation; no child started');
  if(freeGB>=NATIVE_STARTUP_GB){
   report('native-ready',at,freeGB);
   if(deps.stopped())throw Error('native admission owner stopped; no child started');
   const launchFree=deps.freeGB();if(!Number.isFinite(launchFree)||launchFree<0)throw Error('invalid native memory observation; no child started');
   if(launchFree>=NATIVE_STARTUP_GB&&deps.now()<deadline)return start();
   report('waiting-native-headroom',deps.now(),launchFree);
  }
  else report('waiting-native-headroom',at,freeGB);
  await deps.sleep(Math.min(1000,deadline-at));
 }
}
const importParses=new Map<string,{source:string;relative:string[]}>();
const IMPORT_PARSE_LIMIT=2048;
function relativeImports(path:string):readonly string[]{
 const content=readFileSync(path,'utf8'),source=createHash('sha256').update(content).digest('hex');
 const prior=importParses.get(path);if(prior?.source===source)return prior.relative;
 const relative=ts.preProcessFile(content,true,true).importedFiles.map(s=>s.fileName).filter(s=>s.startsWith('.'));
 if(!prior&&importParses.size>=IMPORT_PARSE_LIMIT)importParses.clear();
 importParses.set(path,{source,relative});
 return relative;
}
// Every repo file a capability can load: its entry, owned files and check scripts, then their relative imports.
// An edit outside this set does not change what the capability runs, so it keeps its qualification.
export function importClosure(starts:readonly string[],base=root):string[]{
 const seen=new Set<string>(),queue=[...starts];
 const resolved=new Map<string,string|undefined>();
 const resolveFile=(file:string,spec:string):string|undefined=>{
  const target=relative(resolve(base),resolve(base,dirname(file),spec)).replaceAll('\\','/');
  if(resolved.has(target))return resolved.get(target);
  const next=[target,target+'.ts',target+'.tsx',target+'/index.ts'].find(c=>existsSync(join(base,c))&&!statSync(join(base,c)).isDirectory());
  resolved.set(target,next);return next;
 };
 while(queue.length){
  const file=queue.pop()!;if(seen.has(file)||!existsSync(join(base,file)))continue;seen.add(file);
  if(!/\.(?:ts|tsx|js|mjs)$/.test(file))continue;
  for(const spec of relativeImports(join(base,file))){
   const next=resolveFile(file,spec);if(next&&!seen.has(next))queue.push(next);
  }
 }
 return [...seen].sort();
}
// The capability release of the entry (packages/core/src/worker-release.ts); null when the entry cannot be released.
function runtimeRevision(task:DeliveryTask):string|null{try{return capabilityRevision([task.entry],root);}catch{return null;}}
export function deliveryFingerprint(t:DeliveryTask,base=root){
 return fingerprintWithPolicy(t,base,readSavedProofPolicy(base));
}
function fingerprintWithPolicy(t:DeliveryTask,base:string,policy:SavedProofPolicy){
 // Entry, scope and acceptance commands are part of the qualified contract.
 const scripts=t.checks.flatMap(c=>c.command.filter(a=>/\.(?:ts|tsx)$/.test(a)));
 const hash=createHash('sha256').update(JSON.stringify(t));
 // Only admission choices for this task belong to its qualification source.
 hash.update('\0saved-proof-policy\0').update(JSON.stringify(t.checks.map(c=>savedProofVerifierAllowed(c,policy))));
 for(const file of importClosure([t.entry,...t.files,...scripts,'packages/router/src/delivery.ts','packages/router/src/delivery-cli.ts'],base))
  hash.update(file+'\0').update(readFileSync(join(base,file))).update('\0');
 return hash.digest('hex');
}
export function deliveryTask(value:string):DeliveryTask{
    const file=value.endsWith('.json')?resolve(root,value):join(root,'packages/router/tasks',value+'.json');
    const task=JSON.parse(readFileSync(file,'utf8'));validateDelivery(task);return task;
}
export async function runDiagnosticTask(task:DeliveryTask,checkId:string){return runTask(task,checkId);}
export async function runDeliveryTask(task:DeliveryTask){return runTask(task);}
async function runTask(task:DeliveryTask,diagnosticCheck?:string){
    validateDelivery(task);
    if(diagnosticCheck!==undefined&&!task.checks.some(c=>c.id===diagnosticCheck&&c.phase==='practice'))throw Error('diagnostic must name a declared practice check');
    const parent=join(root,'.practice/deliveries');mkdirSync(parent,{recursive:true});
    const directory=mkdtempSync(join(parent,`${task.id}-${Date.now()}-`));
    writeFileSync(join(directory,'task.json'),JSON.stringify(task,null,2));
    let initialPolicy:SavedProofPolicy;
    const result=await deliver(task,{
        fingerprint(task){
            const policy=readSavedProofPolicy(root);
            initialPolicy??=policy;
            return fingerprintWithPolicy(task,root,policy);
        },
        async run(check){
            const index=task.checks.indexOf(check),out=join(directory,`${index}.out.log`),err=join(directory,`${index}.err.log`);
            const start=async()=>{
            console.log(`DELIVERY ${check.phase} ${check.id}`);
            const child=Bun.spawn(check.command,{cwd:root,env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',DELIVERY_DIR:directory,BUILD_STARTUP:'false',BUILD_LIVE_RELOAD:'false'},stdout:Bun.file(out),stderr:Bun.file(err),windowsHide:true});
            let timedOut=false,termination:Promise<void>|undefined;
            const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid);},check.timeoutMs);
            const exitCode=await child.exited;clearTimeout(timer);
            await termination;
            recoverProofLock(join(root,'.practice/delivery-practice.lock'),directory,join(directory,'expired-practice-lock.json'));
            return{exitCode,timedOut,detail:JSON.stringify({stdout:out,stderr:err})};
            };
            if(check.phase==='regression')return start();
            const stopped=()=>existsSync(join(root,'.practice/stop-coordinator'))||existsSync(join(root,'.practice/stop-swarm'));
            if(savedProofVerifierAllowed(check,initialPolicy)){
                if(stopped())throw Error('owner stopped before saved proof verification');
                return start();
            }
            return withPracticeTurn(join(root,'.practice/delivery-native.lock'),()=>withNativeStartup(start,{now:Date.now,freeGB:()=>freemem()/2**30,
                stopped,
                sleep:ms=>Bun.sleep(ms),progress:admission=>{
                    writeFileSync(join(directory,'admission.json'),JSON.stringify({...admission,check:check.id},null,2));
                    appendFileSync(join(directory,'admission.jsonl'),JSON.stringify({...admission,check:check.id})+'\n');
                    console.log('DELIVERY_ADMISSION '+JSON.stringify({...admission,check:check.id}));
                }}),{stopped});
        },
    },diagnosticCheck);
    const report={...result,...nativeDeferralEvidence(result.reason),id:task.id,goal:task.goal,at:Date.now(),runtimeRevision:runtimeRevision(task),directory,files:task.files.map(path=>{
        try{return{path,sha256:createHash('sha256').update(readFileSync(join(root,path))).digest('hex')};}
        catch{return{path,sha256:null};}
    })};
    writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));return report;
}

if(import.meta.main){
    try{
        const arg=process.argv[2];
        if(!arg||arg==='--list')console.log(readdirSync(join(root,'packages/router/tasks')).filter(p=>p.endsWith('.json')).map(p=>p.slice(0,-5)).join('\n'));
        else process.exitCode=(await runDeliveryTask(deliveryTask(arg))).ok?0:1;
    }catch(error){console.error(String(error));process.exitCode=1;}
}
