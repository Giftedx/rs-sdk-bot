import {createHash} from 'node:crypto';
import {appendFileSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync,statSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import ts from 'typescript';
import {existsSync} from 'node:fs';
import {freemem} from 'node:os';
import {capabilityRevision} from '../../core/src/worker-release';
import {releaseFileDigest,runtimeImports} from '../../core/src/release-digest';
import {killTree} from '../../core/src/proc';
import {PRACTICE_TURN_WAIT_EXPIRED,recoverProofLock,withPracticeTurn} from '../../practice/src/proof-lock';
import {deliver,validateDelivery,type DeliveryTask,type DeliveryCheck} from './delivery';

const root=resolve(import.meta.dir,'../../..');
// The time between the start of one check of a group and the memory read of the next.
export const GROUP_START_GAP_MS=5000;
// Source preparation needs SOURCE_STARTUP_GB free: the free-memory floor and a reserve (packages/core/src/memory.ts).
// Native launch requires PRACTICE_STARTUP_GB; this is checked at the actual child boundary.
import {SOURCE_STARTUP_GB,PRACTICE_STARTUP_GB as NATIVE_STARTUP_GB,BENCH_FLEET_STOP_EXIT,BENCH_START_REFUSED_EXIT,HOST_DEFERRED_EXIT,benchStartGB} from '../../core/src/memory';
import {fleet,floorGB,type Fleet} from '../../../scripts/heavy-admission';
export {SOURCE_STARTUP_GB,NATIVE_STARTUP_GB};
// A check that runs the AIO bench (`bun run bench ...` or the bench script) and the engines that it starts at one time.
export function benchEngines(check:Pick<DeliveryCheck,'command'>):number|null{
 const c=check.command,runs=c[0]==='bun'&&(c[1]==='run'&&c[2]==='bench'||/(^|[\\/])aio-practice-bench\.ts$/.test(c[1]??''));
 if(!runs)return null;
 const parallel=c.findIndex(a=>a==='--parallel'),value=parallel>=0?Number(c[parallel+1]):1;
 return Number.isSafeInteger(value)&&value>=1?value:1;
}
// The free memory that the native start of a check needs. A check that runs the bench needs what the bench needs
// (benchStartGB), so the admission does not pass a start that the bench then refuses. Any other check needs the
// practice startup rule.
export function nativeNeedGB(check:Pick<DeliveryCheck,'command'>,facts:{floorGB:number;fleet:Fleet|null}):number{
 const engines=benchEngines(check);
 return engines===null?NATIVE_STARTUP_GB:Math.max(NATIVE_STARTUP_GB,benchStartGB({floorGB:facts.floorGB,reserveGB:facts.fleet?.reserveGB,engines,fleet:!!facts.fleet}));
}
// The deferral of a check that ended because the host had no room: its exit code, or null. The report then carries
// hostDeferred (nativeDeferralEvidence) and the coordinator resumes the prepared source in place of a new build.
export function checkDeferral(check:Pick<DeliveryCheck,'id'|'command'>,exitCode:number):string|null{
 if(exitCode===HOST_DEFERRED_EXIT)return `check ${check.id} ended with the host deferral exit ${exitCode}`;
 if(benchEngines(check)!==null&&(exitCode===BENCH_START_REFUSED_EXIT||exitCode===BENCH_FLEET_STOP_EXIT))return `check ${check.id}: the bench ended with exit ${exitCode} (refused to start or stopped for the fleet's memory)`;
 return null;
}
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
// These audited quest selectors only read retained evidence under --verify. Other selections keep the native gate.
const savedQuestSweepCases=new Set(['scorpion-barcrawl','scorpion-ranged-barcrawl','scorpion-complete-refusal','elena-heckel-dust']);
// These exact consumer invocations only validate saved files in DELIVERY_DIR.
function savedProofVerifierAllowed(check:DeliveryCheck,policy:SavedProofPolicy):boolean{
 const [bun,script,flag,...selectors]=check.command;
 if(check.phase!=='consumer'||bun!=='bun'||flag!=='--verify'
  ||script===undefined||!Object.hasOwn(policy,check.id)||!policy[check.id]!.includes(script))return false;
 if(!selectors.length)return true;
 return check.id==='quest-sweep-saved'&&script==='packages/practice/src/quest-sweep-proof.ts'
  &&selectors.length<=savedQuestSweepCases.size&&new Set(selectors).size===selectors.length
  &&selectors.every(a=>a.startsWith('--case=')&&savedQuestSweepCases.has(a.slice('--case='.length)));
}
export function isSavedProofVerifier(check:DeliveryCheck):boolean{
 return savedProofVerifierAllowed(check,readSavedProofPolicy(root));
}
// `requiredGB`: the free memory that this start needs, read again at each step (default NATIVE_STARTUP_GB).
// The longest wait of a native admission, in ms. A task whose check runs another delivery sets a shorter budget in
// this variable, so that the inner wait ends (as a host deferral) before the timeout of the outer check.
export const ADMISSION_WAIT_ENV='DELIVERY_ADMISSION_WAIT_MS';
export const ADMISSION_WAIT_MAX_MS=900000;
export function admissionWaitMs(env:Record<string,string|undefined>=process.env):number{
 const text=env[ADMISSION_WAIT_ENV];if(text===undefined||text==='')return ADMISSION_WAIT_MAX_MS;
 const value=Number(text);
 if(!Number.isSafeInteger(value)||value<1||value>ADMISSION_WAIT_MAX_MS)throw Error('invalid native admission wait budget: '+ADMISSION_WAIT_ENV);
 return value;
}
type NativeAdmissionDeps={now:()=>number;freeGB:()=>number;stopped:()=>boolean;sleep:(ms:number)=>Promise<void>;requiredGB?:()=>number;progress:(value:{state:string;at:number;freeGB:number;requiredGB:number;deadline:number})=>void};
export async function withNativeStartup<T>(start:()=>Promise<T>,deps:NativeAdmissionDeps,waitMs=ADMISSION_WAIT_MAX_MS):Promise<T>{
 if(!Number.isSafeInteger(waitMs)||waitMs<1||waitMs>ADMISSION_WAIT_MAX_MS)throw Error('invalid native admission wait budget');
 const deadline=deps.now()+waitMs;let lastState='';
 const required=()=>{const v=deps.requiredGB?.()??NATIVE_STARTUP_GB;if(!Number.isFinite(v)||v<NATIVE_STARTUP_GB)throw Error('invalid native memory requirement; no child started');return v;};
 const report=(state:string,at:number,freeGB:number)=>{if(state!==lastState){deps.progress({state,at,freeGB,requiredGB:required(),deadline});lastState=state;}};
 for(;;){
  if(deps.stopped())throw Error('native admission owner stopped; no child started');
  const at=deps.now();if(at>=deadline)throw Error('HOST_DEFERRED_NATIVE_HEADROOM: native startup headroom wait expired; no child started');
  const freeGB=deps.freeGB();
  if(!Number.isFinite(freeGB)||freeGB<0)throw Error('invalid native memory observation; no child started');
  if(freeGB>=required()){
   report('native-ready',at,freeGB);
   if(deps.stopped())throw Error('native admission owner stopped; no child started');
   const launchFree=deps.freeGB();if(!Number.isFinite(launchFree)||launchFree<0)throw Error('invalid native memory observation; no child started');
   if(launchFree>=required()&&deps.now()<deadline)return start();
   report('waiting-native-headroom',deps.now(),launchFree);
  }
  else report('waiting-native-headroom',at,freeGB);
  await deps.sleep(Math.min(1000,deadline-at));
 }
}
const importParses=new Map<string,{source:string;relative:string[]}>();
const IMPORT_PARSE_LIMIT=2048;
function relativeImports(path:string,bytes:Buffer):readonly string[]{
 const content=bytes.toString('utf8'),source=createHash('sha256').update(content).digest('hex');
 const prior=importParses.get(path);if(prior?.source===source)return prior.relative;
 // An import that the runtime erases (import type) loads no file, so it adds none to the closure (release-digest.ts).
 const loaded=runtimeImports(path,content);
 const relative=ts.preProcessFile(content,true,true).importedFiles.map(s=>s.fileName).filter(s=>s.startsWith('.')&&(!loaded||loaded.includes(s)));
 if(!prior&&importParses.size>=IMPORT_PARSE_LIMIT)importParses.clear();
 importParses.set(path,{source,relative});
 return relative;
}
// Every repo file a capability can load: its entry, owned files and check scripts, then their relative imports.
// An edit outside this set does not change what the capability runs, so it keeps its qualification.
export function importClosure(starts:readonly string[],base=root):string[]{
 return scanImportClosure(starts,base);
}
function scanImportClosure(starts:readonly string[],base:string,contents?:Map<string,Buffer>):string[]{
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
  const bytes=readFileSync(join(base,file));contents?.set(file,bytes);
  for(const spec of relativeImports(join(base,file),bytes)){
   const next=resolveFile(file,spec);if(next&&!seen.has(next))queue.push(next);
  }
 }
 return [...seen].sort();
}
// Import discovery and hashing share bytes only within this call. Every later scan reads fresh source.
// Each file enters as the digest of its program (release-digest.ts): a comment, layout or line-ending edit keeps a
// qualification, and a Windows and a Linux checkout of one commit give one source.
// The digest of a file is kept in the process under the hash of its bytes: a delivery asks for the fingerprint after
// each check, and a file that did not change is not parsed again.
const programDigests=new Map<string,string>();
function programDigest(file:string,bytes:Buffer):string{
 const key=createHash('sha256').update(bytes).digest('hex')+file.slice(file.lastIndexOf('.'));
 let digest=programDigests.get(key);
 if(!digest){if(programDigests.size>=8192)programDigests.clear();programDigests.set(key,digest=releaseFileDigest(file,bytes,ts));}
 return digest;
}
export function hashImportClosure(starts:readonly string[],base=root,hash=createHash('sha256')):string{
 const contents=new Map<string,Buffer>();
 for(const file of scanImportClosure(starts,base,contents))
  hash.update(file+'\0').update(programDigest(file,contents.get(file)??readFileSync(join(base,file)))).update('\0');
 return hash.digest('hex');
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
 return hashImportClosure([t.entry,...t.files,...scripts,'packages/router/src/delivery.ts','packages/router/src/delivery-cli.ts'],base,hash);
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
    const stopped=()=>existsSync(join(root,'.practice/stop-coordinator'))||existsSync(join(root,'.practice/stop-swarm'));
    // The native checks of the group that runs now, and the gate that orders their memory reads.
    const grouped=new Set<DeliveryCheck>();let groupGate:Promise<void>=Promise.resolve();
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
            // A command that had no room to start is a host deferral, not a failure of the code under test.
            const deferral=timedOut?null:checkDeferral(check,exitCode);
            if(deferral)throw Error('HOST_DEFERRED_NATIVE_HEADROOM: '+deferral);
            return{exitCode,timedOut,detail:JSON.stringify({stdout:out,stderr:err})};
            };
            if(check.phase==='regression')return start();
            if(savedProofVerifierAllowed(check,initialPolicy)){
                if(stopped())throw Error('owner stopped before saved proof verification');
                return start();
            }
            const admit=(begin:()=>Promise<Awaited<ReturnType<typeof start>>>)=>withNativeStartup(begin,{now:Date.now,freeGB:()=>freemem()/2**30,
                stopped,requiredGB:()=>nativeNeedGB(check,{floorGB:floorGB(root),fleet:fleet(root)}),
                sleep:ms=>Bun.sleep(ms),progress:admission=>{
                    writeFileSync(join(directory,'admission.json'),JSON.stringify({...admission,check:check.id},null,2));
                    appendFileSync(join(directory,'admission.jsonl'),JSON.stringify({...admission,check:check.id})+'\n');
                    console.log('DELIVERY_ADMISSION '+JSON.stringify({...admission,check:check.id}));
                }},admissionWaitMs());
            if(!grouped.has(check))return withPracticeTurn(join(root,'.practice/delivery-native.lock'),()=>admit(start),{stopped});
            // A check of a group: the group holds the practice turn (batch, below). The checks read the free memory one
            // after the other, each GROUP_START_GAP_MS after the child before it started, so two checks do not both
            // count the same free memory.
            const prior=groupGate;let open!:()=>void;groupGate=new Promise<void>(r=>{open=r;});
            await prior;
            try{return await admit(()=>{const done=start();setTimeout(open,GROUP_START_GAP_MS);return done;});}finally{open();}
        },
        async batch(checks,work){
            const native=checks.filter(c=>c.phase!=='regression'&&!savedProofVerifierAllowed(c,initialPolicy));
            if(native.length<2)return work();
            for(const c of native)grouped.add(c);
            try{return await withPracticeTurn(join(root,'.practice/delivery-native.lock'),work,{stopped});}
            finally{for(const c of native)grouped.delete(c);}
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
