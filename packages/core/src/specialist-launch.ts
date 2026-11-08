import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {processMatches} from '../../practice/src/proc';
import {jobAccounts, readMergedPlan} from './coordinator-jobs';
import {fresh, localFile, readBound, sha, validateRehearsals, validateSupplies, type Binding, type SupplyRequirement} from './launch-evidence';
import {missionSignature} from './session-admission';
import {listAttempts, readLogoutProof, type AttemptReceipt} from './session-lifecycle';

export const SPECIALIST_BOARDS: Readonly<Record<string, {name:string; category:number}>> = {
    shaftshooter: {name:'Ranged', category:5},
    polevaulter: {name:'Agility', category:17},
};
const HOUR = 3_600_000;
const LIVE_SERVER = 'rs-sdk-demo.fly.dev';
const FIRST_LOGIN_MS = 600_000;
export const MAX_SPECIALIST_RUN_MS = 86_400_000;
const SNAPSHOT = '.practice/specialist-launch/hiscores.json';
const evidencePath = (account:string) => `.practice/specialist-launch/${account.toLowerCase()}.json`;
export const specialistTokenPath = (account:string) => `.practice/specialist-launch/${account.toLowerCase()}.go.json`;
const positiveTicks = (n:unknown) => Number.isSafeInteger(n) && Number(n)>0;

export function specialistContext(account:string, source:string, mission:string, requirements:SupplyRequirement[]){
    return sha(JSON.stringify([account.toLowerCase(), source, mission, requirements]));
}

export function evaluateSpecialist(root:string, account:string, runId:string, source:string, mission:string, holders:string[], now=Date.now()){
    const name=account.toLowerCase(), board=SPECIALIST_BOARDS[name];
    const bindings:Binding[]=[];
    const read=(path:string)=>{
        const bytes=readFileSync(localFile(root,path));
        bindings.push({path,sha256:sha(bytes)});
        return JSON.parse(bytes.toString());
    };
    const bound=(ref:Binding,json=true)=>readBound(root,ref,bindings,json);
    const plan=read(evidencePath(name));
    if(!Object.hasOwn(SPECIALIST_BOARDS,name) || !board || plan?.version!==1 || plan.account!==name || plan.board!==board.name
        || !positiveTicks(plan.planTicks) || !Array.isArray(plan.requirements))throw Error('wrong account, board, route or supplies');
    const context=specialistContext(name,source,mission,plan.requirements);
    if(plan.context!==context)throw Error('route or supply requirements changed');
    const snapshot=read(SNAPSHOT), at=Date.parse(snapshot.takenAt);
    if(snapshot.base!=='https://rs-sdk-demo.fly.dev' || snapshot.tickMs!==400 || !fresh(at,now,HOUR))
        throw Error('need a live 400 ms hiscore snapshot under one hour old');
    const boards=snapshot.boards?.filter((b:any)=>b.board===board.name && b.category===board.category);
    const rows=boards?.[0]?.rows;
    const leader=rows?.[0];
    if(boards?.length!==1 || !Array.isArray(rows) || leader?.rank!==1 || !positiveTicks(leader.ticks) || !positiveTicks(leader.level)
        || leader.level>99 || typeof leader.name!=='string' || !leader.name)
        throw Error('missing or invalid specialist record');
    if(rows.some(row=>typeof row?.name==='string' && row.name.toLowerCase()===name))throw Error('specialist already appears on the board');
    const profiles=Array.isArray(snapshot.profiles)?snapshot.profiles.filter((profile:any)=>profile?.name===name):[];
    const profile=profiles[0];
    if(profiles.length!==1 || profile.status!==404 || !fresh(profile.at,now,HOUR))
        throw Error('need a recent 404 from the exact specialist profile');
    const rehearsal=bound(plan.rehearsal);
    const expiry=validateRehearsals([rehearsal],context,{[board.name]:plan.planTicks},now,bound,
        {count:1,excludedActor:name,externalSupplies:plan.requirements,requireArtifacts:true});
    const margin=Math.ceil(leader.ticks*.02);
    if(leader.level===99 && leader.ticks-Math.max(plan.planTicks,rehearsal.endPlaytime)<margin)
        throw Error(`need a ${margin}-tick margin against the record`);
    let expiresAt=Math.min(now+FIRST_LOGIN_MS,at+HOUR,profile.at+HOUR,expiry);
    if(plan.requirements.length){
        expiresAt=Math.min(expiresAt,validateSupplies(bound(plan.staging),context,plan.requirements,
            read('knowledge/items.json'),holders,now,bound,name));
    }else if(plan.staging!==undefined)throw Error('unexpected staging for a route with no supplies');
    return {version:2, account:name, runId, source, at:now, expiresAt, bindings};
}

export function assertSpecialistLogin(root:string, name:string, now:number, env:Record<string,string|undefined>,
    server=LIVE_SERVER, ownerMatches=processMatches){
    const account=name.toLowerCase();
    if(!Object.hasOwn(SPECIALIST_BOARDS,account))return;
    try{
        const bytes=readFileSync(join(root,specialistTokenPath(account))), ticket=sha(bytes);
        const token=JSON.parse(bytes.toString());
        if(server!==LIVE_SERVER || token?.version!==2 || token.account!==account
            || typeof token.runId!=='string' || !/^[a-z0-9-]{1,96}$/.test(token.runId) || token.runId!==env.COORDINATOR_RUN_ID
            || !/^[a-f0-9]{64}$/.test(token.source) || token.source!==env.WORKER_RELEASE
            || !/^[a-f0-9]{64}$/.test(token.mission) || token.mission!==env.SWARM_MISSION_HASH
            || !Number.isSafeInteger(token.at) || !fresh(token.at,now,MAX_SPECIALIST_RUN_MS) || !Number.isSafeInteger(token.expiresAt)
            || token.expiresAt<=token.at || token.expiresAt>token.at+FIRST_LOGIN_MS
            || !Number.isSafeInteger(token.runUntil) || token.runUntil<token.expiresAt
            || token.runUntil>token.at+MAX_SPECIALIST_RUN_MS || now>=token.runUntil || !Array.isArray(token.bindings)
            || ![evidencePath(account),SNAPSHOT].every(path=>token.bindings.some((b:Binding)=>b?.path===path)))
            throw Error('missing, expired or mismatched authorization');
        const jobs=readMergedPlan(root).jobs.filter((job:any)=>jobAccounts(job).some(n=>n.toLowerCase()===account));
        const job=jobs[0];
        if(jobs.length!==1 || job.enabled!==true || job.coordinatorOwner!=='coordinator'
            || jobAccounts(job).length!==1 || job.env?.COORDINATOR_RUN_ID!==token.runId || sha(missionSignature(job))!==token.mission)
            throw Error('specialist mission is no longer active');
        if(['stop-coordinator','stop-swarm','stop-'+name,'stop-'+account,'stop-'+jobAccounts(job)[0]].some(file=>existsSync(join(root,'.practice',file))))
            throw Error('specialist owner paused the run');
        const runDir=join(root,'.practice','coordinator','runs',token.runId);
        const owner=JSON.parse(readFileSync(join(runDir,'owner.json'),'utf8'));
        if(existsSync(join(runDir,'receipt.json')) || owner.runId!==token.runId
            || !Number.isSafeInteger(owner.pid) || owner.pid<=0 || !ownerMatches(owner.pid,token.runId))
            throw Error('specialist coordinator run is no longer active');
        const options={root:join(root,'.practice','session-lifecycle')}, proof=readLogoutProof(account,server,options);
        if(proof.state==='none'){
            if(now>=token.expiresAt)throw Error('first-login authorization expired');
            for(const ref of token.bindings)readBound(root,ref,[],false);
            return ticket;
        }
        if(proof.state!=='confirmed' || proof.ownerRun!==token.runId || proof.loggedOutAt>now)
            throw Error('specialist continuation needs the same run’s confirmed server logout');
        const attempts=listAttempts(account,server,options), first=attempts[0]?.receipt, latest=attempts.at(-1), receipt=latest?.receipt;
        const sameTicket=(r:AttemptReceipt)=>r.account.toLowerCase()===account && r.server===server
            && r.owner.coordinatorRunId===token.runId && r.owner.workerRelease===token.source
            && r.owner.specialistAuthorization?.ticket===ticket && r.owner.specialistAuthorization?.mission===token.mission;
        if(!first || !sameTicket(first) || first.createdAt<token.at || first.createdAt>=token.expiresAt)
            throw Error('specialist continuation has no attempt from the first-login window');
        const ended=receipt?.events.findIndex(e=>e.kind==='ended')??-1;
        if(!receipt || latest?.attemptId!==proof.attemptId || latest.sha256!==proof.receiptSha256
            || !sameTicket(receipt) || receipt.createdAt<first.createdAt || ended<1
            || !receipt.events.slice(0,ended).some(e=>e.kind==='ready' && e.at>=receipt.createdAt && e.at<=proof.loggedOutAt))
            throw Error('specialist continuation proof is for another attempt or mission');
        const statusFile=join(root,'.practice','status',jobAccounts(job)[0]+'.json');
        if(existsSync(statusFile)){
            const status=JSON.parse(readFileSync(statusFile,'utf8'));
            if(status?.server===server && status.coordinatorRunId===token.runId && status.result)
                throw Error('specialist run already published a terminal result');
        }
        return ticket;
    }catch(error){
        throw Error(`Specialist login refused for ${name}: ${String(error)}`);
    }
}
