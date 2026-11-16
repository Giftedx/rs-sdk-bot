// Fleet control helper: constrain recovery and bank inspection to explicitly selected owned accounts.
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {hostname} from 'node:os';
import {readLogoutProof} from '../packages/core/src/session-lifecycle';
import {readFleetAccountClaim} from '../packages/core/src/fleet-trade-claim';
import {validateBoundedRecovery,assertBoundedRecoveryQueue,type RecoveryTarget} from '../packages/core/src/bounded-recovery';
import {readCoordinatorJobs,jobAccounts} from '../packages/core/src/coordinator-jobs';
import {loadEnded,persistentEnd} from './swarm';
import {successfulEnd} from '../packages/core/src/session-admission';
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
            if(job.script!=='scripts/fleet-inspect.ts'||job.maxRestarts!==0||job.standingRetry!==false||job.env?.LOOT_WATCH!=='0'||job.env?.RANDOM_EVENTS!=='0')throw Error('bounded recovery inspector changed');
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
    if(readCoordinatorJobs(base).jobs.length)throw Error('bounded recovery preserves existing coordinator assignments; settle them first');
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
export function prepareBoundedInspection(base:string,plan:any,targets:RecoveryTarget[],owned:readonly string[],side:string) {
    const staged=boundedRecoveryPlan(plan,targets,owned),accounts=targets.map(t=>t.account);
    if(readCoordinatorJobs(base).jobs.length)throw Error('bounded inspection coordinator assignments still held');
    const ends=loadEnded(join(base,'.practice/swarm-deaths.json'));
    for(const account of accounts){
        const proof=readLogoutProof(account,LIVE_SERVER,{root:join(base,'.practice/session-lifecycle')});
        const claim=readFleetAccountClaim(base,{account,server:LIVE_SERVER});
        if(proof.state!=='confirmed'||!claim||claim.side!==side||claim.phase!=='released')throw Error('bounded inspection needs current confirmed logout and released claim');
        const end=ends.get(account);
        if(end&&(persistentEnd(end.reason)||successfulEnd(end.reason)))throw Error('bounded inspection end still requires controller repair');
    }
    return {...staged,jobs:staged.jobs.map((j:any)=>accounts.includes(j.account)?{...j,env:{...j.env,REQUIRE_BANK:'1'}}:j),coordination:{boundedInspection:accounts}};
}
