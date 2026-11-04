// Delivery verifies a stated capability. It does not activate workers or clear holds.
export interface DeliveryCheck {
    id:string;
    phase:'regression'|'practice'|'consumer';
    command:string[];
    timeoutMs:number;
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
        seen.add(c.id);previous=phase;
    }
    if(!phases.every(p=>t.checks.some(c=>c.phase===p)))throw Error('delivery needs regression, practice and consumer checks');
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
        for(const check of task.checks){
            result.failedCheck=check.id;
            const checked=await deps.run(check);result.checks.push({id:check.id,phase:check.phase,...checked});
            if(checked.timedOut||checked.exitCode!==0){result.reason=checked.timedOut?'check timed out':'check failed';return result;}
            if(deps.fingerprint(task)!==result.source){result.reason='source changed during delivery; rerun affected checks';return result;}
            if(check.id===diagnosticCheck){result.diagnostic!.complete=true;result.reason='diagnostic complete; full acceptance not run';delete result.failedCheck;return result;}
        }
        result.ok=true;result.stage='delivered';result.reason='native capability and named consumer verified';delete result.failedCheck;
    }catch(error){result.reason=String(error);}
    return result;
}
