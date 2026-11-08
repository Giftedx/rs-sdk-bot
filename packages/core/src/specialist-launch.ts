import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fresh, localFile, readBound, sha, validateRehearsals, validateSupplies, type Binding, type SupplyRequirement} from './launch-evidence';

export const SPECIALIST_BOARDS: Readonly<Record<string, {name:string; category:number}>> = {
    shaftshooter: {name:'Ranged', category:5},
    polevaulter: {name:'Agility', category:17},
};
const HOUR = 3_600_000;
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
    const expiry=validateRehearsals([rehearsal],context,{[board.name]:plan.planTicks},now,bound,{count:1,excludedActor:name,externalSupplies:plan.requirements});
    const margin=Math.ceil(leader.ticks*.02);
    if(leader.level===99 && leader.ticks-Math.max(plan.planTicks,rehearsal.endPlaytime)<margin)
        throw Error(`need a ${margin}-tick margin against the record`);
    let expiresAt=Math.min(now+600_000,at+HOUR,profile.at+HOUR,expiry);
    if(plan.requirements.length){
        expiresAt=Math.min(expiresAt,validateSupplies(bound(plan.staging),context,plan.requirements,
            read('knowledge/items.json'),holders,now,bound,name));
    }else if(plan.staging!==undefined)throw Error('unexpected staging for a route with no supplies');
    return {version:1, account:name, runId, source, at:now, expiresAt, bindings};
}

export function assertSpecialistLogin(root:string, name:string, now:number, env:Record<string,string|undefined>){
    const account=name.toLowerCase();
    if(!Object.hasOwn(SPECIALIST_BOARDS,account))return;
    try{
        const token=JSON.parse(readFileSync(join(root,specialistTokenPath(account)),'utf8'));
        if(token?.version!==1 || token.account!==account || !token.runId || token.runId!==env.COORDINATOR_RUN_ID
            || !/^[a-f0-9]{64}$/.test(token.source) || token.source!==env.WORKER_RELEASE
            || !/^[a-f0-9]{64}$/.test(token.mission) || token.mission!==env.SWARM_MISSION_HASH
            || !fresh(token.at,now,600_000) || !Number.isFinite(token.expiresAt) || token.expiresAt<=now
            || token.expiresAt>token.at+600_000 || !Array.isArray(token.bindings)
            || ![evidencePath(account),SNAPSHOT].every(path=>token.bindings.some((b:Binding)=>b?.path===path)))
            throw Error('missing, expired or mismatched authorization');
        for(const ref of token.bindings)readBound(root,ref,[],false);
    }catch(error){
        throw Error(`Specialist login refused for ${name}: ${String(error)}`);
    }
}
