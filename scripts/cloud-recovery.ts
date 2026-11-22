// Fleet control helper: constrain recovery and bank inspection to explicitly selected owned accounts.
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {hostname} from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {readLogoutProof,listAttempts} from '../packages/core/src/session-lifecycle';
import {readFleetAccountClaim} from '../packages/core/src/fleet-trade-claim';
import {validateBoundedRecovery,assertBoundedRecoveryQueue,type RecoveryTarget} from '../packages/core/src/bounded-recovery';
import {readCoordinatorJobs,jobAccounts} from '../packages/core/src/coordinator-jobs';
import {loadEnded,persistentEnd,failedScript,startable} from './swarm';
import {successfulEnd,missionSignature} from '../packages/core/src/session-admission';
import {capabilityRevision} from '../packages/core/src/worker-release';
import {eligibility,recoveryProposal,LIVE_SERVER,clearSwarmStops} from './cloud-recover';

export function boundedRecoveryPlan(plan:any,targets:RecoveryTarget[],owned:readonly string[],now=Date.now()) {
    const proposal=recoveryProposal('cloud',targets,now),scope=validateBoundedRecovery({targets,taskIds:proposal.tasks.map(t=>t.id)});
    const names=new Set(owned.map(n=>n.toLowerCase())),selected=new Set(targets.map(t=>t.account.toLowerCase()));
    if(targets.some(t=>!names.has(t.account.toLowerCase())) || plan.maxBots!==4 || plan.minFreeGB!==4
        || !Array.isArray(plan.jobs) || plan.jobs.length!==owned.length)throw Error('bounded recovery owner plan or limits changed');
    const seen=new Set<string>();
    for(const job of plan.jobs){
        const accounts=jobAccounts(job),key=accounts[0]?.toLowerCase();
        if(accounts.length!==1||!names.has(key)||seen.has(key)||job.autopilot||job.standing||job.host||job.orchestrate||job.repeat!==false)throw Error('bounded recovery assignment changed');
        seen.add(key);
        if(selected.has(key)){
            if(job.script!=='scripts/aio-logistics.ts'||job.args?.[0]!=='inspect'||job.maxRestarts!==0||job.standingRetry!==false||job.env?.LOOT_WATCH!=='0'||job.env?.RANDOM_EVENTS!=='0')throw Error('bounded recovery inspector changed');
        }else if(job.enabled!==false||job.script||job.role!=='reserved')throw Error('bounded recovery reservation changed');
    }
    return {...plan,jobs:plan.jobs.map((j:any)=>selected.has(j.account.toLowerCase())?{...j,enabled:false}:j),coordination:{enabled:true,maxActive:1,maxLive:plan.maxBots,preferLive:true,autoExpand:false,boundedRecovery:scope,bootstrap:proposal.tasks}};
}

export function prepareBoundedRecovery(base:string,plan:any,targets:RecoveryTarget[],owned:readonly string[],side:string,now=Date.now()) {
    const next=boundedRecoveryPlan(plan,targets,owned,now);
    // Use the actual side in task ids; the proposal contract and recovery proof remain unchanged.
    const proposal=recoveryProposal(side,targets,now);
    next.coordination.bootstrap=proposal.tasks;
    next.coordination.boundedRecovery.taskIds=proposal.tasks.map(t=>t.id);
    // A failed pre-install recovery keeps disabled copies of its owner jobs. Preserve
    // those exact selected copies for prepareLiveRecovery; they cannot be released
    // while the original producer is held. Every other assignment stays fenced.
    const parked=readCoordinatorJobs(base),selected=new Set(targets.map(t=>t.account.toLowerCase())),seen=new Set<string>();
    if(parked.jobs.length&&(Object.keys(parked.coordination).length||parked.expansion||parked.paused?.length))throw Error('bounded recovery preserves existing coordinator settings');
    for(const job of parked.jobs){
        const key=typeof job?.account==='string'?job.account.toLowerCase():'';
        const owner=next.jobs.find((j:any)=>j.account.toLowerCase()===key);
        if(!selected.has(key)||seen.has(key)||!owner||!isDeepStrictEqual(job,owner))throw Error('bounded recovery preserves changed or unrelated coordinator assignments');
        seen.add(key);
    }
    const statePath=join(base,'.practice/coordinator/state.json');
    if(existsSync(statePath))assertBoundedRecoveryQueue(next.coordination.boundedRecovery,JSON.parse(readFileSync(statePath,'utf8')));
    const ended=loadEnded(join(base,'.practice/swarm-deaths.json'));
    for(const target of targets){
        const proof=readLogoutProof(target.account,LIVE_SERVER,{root:join(base,'.practice/session-lifecycle')});
        if(proof.state!=='held'||proof.attemptId!==target.attemptId)throw Error('bounded recovery exact producer changed');
        const end=ended.get(target.account);
        if(!end||end.at!==target.endedAt)throw Error('bounded recovery exact failure changed');
        const file=join(base,'.practice','stop-'+target.account),stopText=existsSync(file)?readFileSync(file,'utf8'):undefined;
        const claim=readFleetAccountClaim(base,{account:target.account,server:LIVE_SERVER});
        if(!claim||claim.side!==side)throw Error('bounded recovery claim ownership changed');
        const e=eligibility({proof,claim,end,stopText,host:hostname(),pidAlive:pid=>{try{process.kill(pid,0);return true;}catch{return false;}}});
        if(!e.eligible)throw Error('bounded recovery ineligible: '+e.reason);
    }
    return next;
}
export {clearSwarmStops};
export function assertCompletedInspectionMission(v:{account:string;proof:any;producer:any;end:any;prior:any;bound:any;target:RecoveryTarget;job:any;source:string}){
    const {account,proof,producer,end,prior,bound,target,job,source}=v,receipt=producer?.receipt,status=prior?.receipt?.output?.status;
    if(proof.state!=='confirmed'||producer?.sha256!==proof.receiptSha256||!receipt||!prior||prior.status!=='succeeded'||prior.receipt?.ok!==true
        ||prior.spec.account!==account||prior.spec.sessionRecovery?.endedAt!==target.endedAt||prior.runId!==proof.ownerRun
        ||status?.sessionAttemptId!==proof.attemptId||status.workRevision!==source||status.coordinatorRunId!==proof.ownerRun
        ||receipt.owner.script!=='scripts/session-check.ts'||receipt.owner.workerRelease!==source||!successfulEnd(end.reason)
        ||!bound?.taskIds?.includes(prior.spec.id)||!bound.targets?.some((t:RecoveryTarget)=>t.account===account&&t.attemptId===target.attemptId&&t.endedAt===target.endedAt)
        ||failedScript(end)!=='scripts/session-check.ts'||receipt.updatedAt>end.at||job.script!=='scripts/aio-logistics.ts'||job.args?.[0]!=='inspect')throw Error('bounded inspection completed recovery identity changed');
    const revision=missionSignature({...job,env:{...job.env,REQUIRE_BANK:'1'}});
    if(!startable([account],false,new Map([[account,end]]),()=>Infinity,undefined,revision).start.includes(account))throw Error('bounded inspection needs a different completed mission');
}
export function prepareBoundedInspection(base:string,plan:any,targets:RecoveryTarget[],owned:readonly string[],side:string,checkOverlay=true) {
    const staged=boundedRecoveryPlan(plan,targets,owned),accounts=targets.map(t=>t.account);
    if(checkOverlay&&readCoordinatorJobs(base).jobs.length)throw Error('bounded inspection coordinator assignments still held');
    const ends=loadEnded(join(base,'.practice/swarm-deaths.json'));
    for(const account of accounts){
        const proof=readLogoutProof(account,LIVE_SERVER,{root:join(base,'.practice/session-lifecycle')});
        const claim=readFleetAccountClaim(base,{account,server:LIVE_SERVER});
        if(proof.state!=='confirmed'||!claim||claim.side!==side||claim.phase!=='released')throw Error('bounded inspection needs current confirmed logout and released claim');
        const end=ends.get(account);
        if(!end||persistentEnd(end.reason)||!successfulEnd(end.reason))throw Error('bounded inspection end still requires controller repair or completed recovery');
        {
            const producer=listAttempts(account,LIVE_SERVER,{root:join(base,'.practice/session-lifecycle')}).find(a=>a.attemptId===proof.attemptId);
            const state=JSON.parse(readFileSync(join(base,'.practice/coordinator/state.json'),'utf8'));
            const prior=state.tasks.find((r:any)=>r.runId===proof.ownerRun&&r.status==='succeeded'&&r.spec.account===account&&r.spec.sessionRecovery?.endedAt===targets.find(t=>t.account===account)!.endedAt);
            const bound=JSON.parse(readFileSync(join(base,'.practice/cloud-side',side,'recovery-plan.json'),'utf8')).coordination?.boundedRecovery;
            const target=targets.find(t=>t.account===account)!;
            assertCompletedInspectionMission({account,proof,producer,end,prior,bound,target,job:staged.jobs.find((j:any)=>j.account===account),source:capabilityRevision(['scripts/session-check.ts'],base)});
        }
    }
    return {...staged,jobs:staged.jobs.map((j:any)=>accounts.includes(j.account)?{...j,env:{...j.env,REQUIRE_BANK:'1'}}:j),coordination:{boundedInspection:accounts}};
}
export async function releaseForBoundedInspection(base:string,plan:any,targets:RecoveryTarget[],owned:readonly string[],side:string,release:()=>boolean|Promise<boolean>) {
    // Both structural ownership and current session authority are read before the supported overlay mutation.
    prepareBoundedInspection(base,plan,targets,owned,side,false);
    if(!await release())throw Error('bounded inspection assignments still held');
    return prepareBoundedInspection(base,plan,targets,owned,side);
}
