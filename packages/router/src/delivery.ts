// Delivery verifies a stated capability. It does not activate workers or clear holds.
export interface DeliveryCheck {
    id:string;
    phase:'regression'|'practice'|'consumer';
    command:string[];
    timeoutMs:number;
    // Checks that follow each other with one group name run at one time. Use it only for checks that share no
    // engine port, no lock file and no output file. The results keep the order of the task.
    group?:string;
}
export interface DeliveryTask {
    id:string;
    goal:string;
    entry:string;
    files:string[];
    consumer:string;
    checks:DeliveryCheck[];
}
export interface CheckResult {exitCode:number;timedOut?:boolean;detail:string}
export interface DeliveryDeps {
    fingerprint(task:DeliveryTask):string;
    run(check:DeliveryCheck):Promise<CheckResult>;
    // Wraps the checks of one group (one practice turn for the group, in delivery-cli.ts). Default: no wrapper.
    batch?<T>(checks:readonly DeliveryCheck[],work:()=>Promise<T>):Promise<T>;
}
// The checks of a task in run order: one list for each group of checks that run at one time.
export function checkBatches(checks:readonly DeliveryCheck[]):DeliveryCheck[][]{
    const batches:DeliveryCheck[][]=[];
    for(const check of checks){
        const last=batches.at(-1);
        if(check.group&&last&&last[0]!.group===check.group)last.push(check);else batches.push([check]);
    }
    return batches;
}
export interface DeliveryResult {
    ok:boolean;
    stage:'delivered'|'failed';
    evidence:'native';
    consumer:string;
    source?:string;
    failedCheck?:string;
    reason:string;
    checks:({id:string;phase:DeliveryCheck['phase']} & CheckResult)[];
    diagnostic?:{checkId:string;complete:boolean};
    hostDeferred?:boolean;
}

export function validateDelivery(t:DeliveryTask):void {
    const relative=(p:string)=>typeof p==='string'&&p.length>0&&!p.includes('\\')&&!p.startsWith('/')&&!p.includes(':')
        &&!p.split('/').some(v=>v==='..'||v===''||v==='node_modules'||v==='.git')&&!/(^|\/)bot\.env$/.test(p);
    if(!t||!/^[-a-z0-9]+$/.test(t.id)||!t.goal?.trim()||!t.consumer?.trim()||!relative(t.entry)
        ||!Array.isArray(t.files)||!t.files.length||!t.files.every(relative)||!t.files.includes(t.entry))throw Error('invalid delivery identity or file scope');
    if(!Array.isArray(t.checks)||!t.checks.length)throw Error('delivery needs regression, practice and consumer checks');
    const phases=['regression','practice','consumer'];let previous=-1;const seen=new Set<string>();
    for(const c of t.checks){
        const phase=phases.indexOf(c.phase);
        if(phase<previous||phase<0||!c.id?.trim()||seen.has(c.id)||!Array.isArray(c.command)||!c.command.length
            ||!c.command.every(s=>typeof s==='string'&&s.trim())||!Number.isSafeInteger(c.timeoutMs)||c.timeoutMs<1||c.timeoutMs>1800000)
            throw Error('invalid delivery check order, command or timeout');
        if(c.group!==undefined&&(typeof c.group!=='string'||!/^[a-z0-9-]+$/.test(c.group)))throw Error('invalid delivery check group');
        seen.add(c.id);previous=phase;
    }
    if(!phases.every(p=>t.checks.some(c=>c.phase===p)))throw Error('delivery needs regression, practice and consumer checks');
    // One group is one run of neighbours in one phase: a group name that comes back later is a second, split group.
    const batches=checkBatches(t.checks),names=batches.filter(b=>b[0]!.group).map(b=>b[0]!.group);
    if(new Set(names).size!==names.length||batches.some(b=>b.some(c=>c.phase!==b[0]!.phase)))throw Error('a delivery check group must be neighbours of one phase');
}

export async function deliver(task:DeliveryTask,deps:DeliveryDeps,diagnosticCheck?:string):Promise<DeliveryResult>{
    const result:DeliveryResult={ok:false,stage:'failed',evidence:'native',consumer:task?.consumer??'',reason:'',checks:[]};
    try{
        validateDelivery(task);
        if(diagnosticCheck!==undefined){
            if(!task.checks.some(c=>c.id===diagnosticCheck&&c.phase==='practice'))throw Error('diagnostic must name a declared practice check');
            result.diagnostic={checkId:diagnosticCheck,complete:false};
        }
        result.source=deps.fingerprint(task);
        // A diagnostic stops after one named check, so it runs the checks one by one.
        for(const batch of diagnosticCheck!==undefined?task.checks.map(c=>[c]):checkBatches(task.checks)){
            result.failedCheck=batch[0]!.id;
            const all=()=>Promise.allSettled(batch.map(check=>deps.run(check)));
            const settled=await(batch.length>1&&deps.batch?deps.batch(batch,all):all());
            // Every check of the batch has ended here. A check that threw fails the delivery with its error.
            const thrown=settled.find(s=>s.status==='rejected');
            if(thrown){result.failedCheck=batch[settled.indexOf(thrown)]!.id;throw (thrown as PromiseRejectedResult).reason;}
            for(const [i,check]of batch.entries())result.checks.push({id:check.id,phase:check.phase,...(settled[i] as PromiseFulfilledResult<CheckResult>).value});
            const failed=batch.find((_,i)=>{const r=(settled[i] as PromiseFulfilledResult<CheckResult>).value;return r.timedOut||r.exitCode!==0;});
            if(failed){const r=result.checks.find(c=>c.id===failed.id)!;result.failedCheck=failed.id;result.reason=r.timedOut?'check timed out':'check failed';return result;}
            if(deps.fingerprint(task)!==result.source){result.reason='source changed during delivery; rerun affected checks';return result;}
            if(batch[0]!.id===diagnosticCheck){result.diagnostic!.complete=true;result.reason='diagnostic complete; full acceptance not run';delete result.failedCheck;return result;}
        }
        result.ok=true;result.stage='delivered';result.reason='native capability and named consumer verified';delete result.failedCheck;
    }catch(error){result.reason=String(error);}
    return result;
}
