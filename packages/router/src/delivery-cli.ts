import {createHash} from 'node:crypto';
import {appendFileSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {existsSync} from 'node:fs';
import {freemem} from 'node:os';
import {workerSourceRevision} from '../../core/src/worker-release';
import {killTree} from '../../practice/src/proc';
import {recoverProofLock} from '../../practice/src/proof-lock';
import {deliver,validateDelivery,type DeliveryTask} from './delivery';

const root=resolve(import.meta.dir,'../../..');
// Source preparation uses an estimated3GiB reserve over the8GiB floor.
// Native launch still requires12GiB; this is checked at the actual child boundary.
export const SOURCE_STARTUP_GB=11,NATIVE_STARTUP_GB=12;
export function nativeDeferralEvidence(reason:string):{hostDeferred?:boolean}{
 return /^(?:Error: )?HOST_DEFERRED_NATIVE_HEADROOM:/.test(reason)?{hostDeferred:true}:{};
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
export function deliveryFingerprint(t:DeliveryTask,base=root){
 // Entry, scope and acceptance commands are part of the qualified contract.
 const hash=createHash('sha256').update(workerSourceRevision(base)).update(JSON.stringify(t));
 for(const file of [...new Set([...t.files,'packages/router/src/delivery.ts','packages/router/src/delivery-cli.ts'])].sort())
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
    const result=await deliver(task,{
        fingerprint:deliveryFingerprint,
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
            return withNativeStartup(start,{now:Date.now,freeGB:()=>freemem()/2**30,
                stopped:()=>existsSync(join(root,'.practice/stop-coordinator'))||existsSync(join(root,'.practice/stop-swarm')),
                sleep:ms=>Bun.sleep(ms),progress:admission=>{
                    writeFileSync(join(directory,'admission.json'),JSON.stringify({...admission,check:check.id},null,2));
                    appendFileSync(join(directory,'admission.jsonl'),JSON.stringify({...admission,check:check.id})+'\n');
                    console.log('DELIVERY_ADMISSION '+JSON.stringify({...admission,check:check.id}));
                }});
        },
    },diagnosticCheck);
    const report={...result,...nativeDeferralEvidence(result.reason),id:task.id,goal:task.goal,at:Date.now(),runtimeRevision:workerSourceRevision(root),directory,files:task.files.map(path=>{
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
