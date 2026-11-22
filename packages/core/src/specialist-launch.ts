import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ownerPlanPath} from './plan-lock';
import {fleetStateFile, hasStopFile, lifecycleRootForRead, liveRoot, statusReadDirs} from './practice-paths';
import {processMatches} from './proc';
import {fresh, localFile, MAX_LOGOUT_DRAIN_TICKS, readBound, sha, validateRehearsals, validateSupplies, type Binding, type SupplyRequirement} from './launch-evidence';
import {missionSignature} from './session-admission';
import {listAttempts, readLogoutProof, type AttemptReceipt} from './session-lifecycle';

const jobAccounts = (job: any): string[] => (job?.accounts ?? [job?.account]).filter((n: unknown): n is string => typeof n === 'string');

import {SPECIALIST_BOARDS} from './specialist-boards';
export {SPECIALIST_BOARDS};
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
        {count:1,excludedActor:name,externalSupplies:plan.requirements,requireArtifacts:true,maxLogoutTailTicks:MAX_LOGOUT_DRAIN_TICKS});
    const margin=Math.ceil(leader.ticks*.02);
    const boardTicks=rehearsal.boardTicks[board.name];
    if(leader.level===99 && leader.ticks-Math.max(plan.planTicks,boardTicks)<margin)
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
        const envRunId=env.FLEET_RUN_ID||env.COORDINATOR_RUN_ID;
        if(server!==LIVE_SERVER || token?.version!==2 || token.account!==account
            || typeof token.runId!=='string' || !/^[a-z0-9-]{1,96}$/.test(token.runId) || token.runId!==envRunId
            || !/^[a-f0-9]{64}$/.test(token.source) || token.source!==env.WORKER_RELEASE
            || !/^[a-f0-9]{64}$/.test(token.mission) || token.mission!==env.SWARM_MISSION_HASH
            || !Number.isSafeInteger(token.at) || !fresh(token.at,now,MAX_SPECIALIST_RUN_MS) || !Number.isSafeInteger(token.expiresAt)
            || token.expiresAt<=token.at || token.expiresAt>token.at+FIRST_LOGIN_MS
            || !Number.isSafeInteger(token.runUntil) || token.runUntil<token.expiresAt
            || token.runUntil>token.at+MAX_SPECIALIST_RUN_MS || now>=token.runUntil || !Array.isArray(token.bindings)
            || ![evidencePath(account),SNAPSHOT].every(path=>token.bindings.some((b:Binding)=>b?.path===path)))
            throw Error('missing, expired or mismatched authorization');
        const planPath=ownerPlanPath(root);
        const plan=existsSync(planPath)?JSON.parse(readFileSync(planPath,'utf8')):{jobs:[]};
        const jobs=(Array.isArray(plan?.jobs)?plan.jobs:[]).filter((job:any)=>jobAccounts(job).some(n=>n.toLowerCase()===account));
        const job=jobs[0];
        const planJobActive=jobs.length===1 && job.enabled===true && jobAccounts(job).length===1
            && (job.env?.FLEET_RUN_ID||job.env?.COORDINATOR_RUN_ID)===token.runId
            && sha(missionSignature(job))===token.mission;
        const fleetFile=fleetStateFile(root);
        let brainActive=false;
        const runDir=join(liveRoot(root),'fleet-runs',token.runId);
        const owner=JSON.parse(readFileSync(join(runDir,'owner.json'),'utf8'));
        if(!planJobActive && jobs.length===0 && existsSync(fleetFile)){
            const fleet=JSON.parse(readFileSync(fleetFile,'utf8'));
            const campaignRunning=Array.isArray(fleet?.campaigns)&&fleet.campaigns.some((c:any)=>c?.account?.toLowerCase()===account&&c.state==='running');
            const chainEntry=fleet?.activeChains&&typeof fleet.activeChains==='object'
                ?Object.entries(fleet.activeChains as Record<string,any>).find(([k,v])=>k.toLowerCase()===account||v?.account?.toLowerCase()===account)?.[1]
                :null;
            brainActive=campaignRunning && !!chainEntry && owner.mission===token.mission && owner.source===token.source;
        }
        if(!planJobActive && !brainActive)
            throw Error('specialist mission is no longer active');
        const jobAccount=job?jobAccounts(job)[0]:account;
        if(['coordinator','swarm',name,account,jobAccount].some(flag=>hasStopFile(flag,root)||existsSync(join(root,'.practice','stop-'+flag))))
            throw Error('specialist owner paused the run');
        if(existsSync(join(runDir,'receipt.json')) || owner.runId!==token.runId
            || !Number.isSafeInteger(owner.pid) || owner.pid<=0 || !ownerMatches(owner.pid,token.runId))
            throw Error('specialist controller run is no longer active');
        const options={root:lifecycleRootForRead(server,root)}, proof=readLogoutProof(account,server,options);
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
        const statusName=`${jobAccount}.json`;
        for(const dir of statusReadDirs(root)){
            const statusFile=join(dir,statusName);
            if(!existsSync(statusFile))continue;
            const status=JSON.parse(readFileSync(statusFile,'utf8'));
            if(status?.server===server && status.coordinatorRunId===token.runId && status.result)
                throw Error('specialist run already published a terminal result');
        }
        return ticket;
    }catch(error){
        throw Error(`Specialist login refused for ${name}: ${String(error)}`);
    }
}
