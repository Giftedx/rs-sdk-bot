import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {NAMES,pickName,type Role} from '../../core/src/names';
import {accountPassword,createAccount} from '../../../scripts/fleet';
import type {ProvisionCrew} from '../../../scripts/provision-readiness';
import {reserveFleetOwner} from '../../../scripts/fleet-owner-claim';
import {mySide} from '../../core/src/fleet';
import {killTree} from '../../practice/src/proc';

export interface AccountProvisionRequest {
    role:Role;
    /** The missing role, measured bottleneck, or fresh-clock record this account serves. */
    purpose:string;
    server:string;
    /** Include all protected main/specialist identities and pending job reservations. */
    reservedNames:readonly string[];
}
export interface RegistrationResult {exitCode:number|null;stdout:string;timedOut?:boolean;}
export interface AccountProvisionDeps {
    listLocalAccountNames():readonly string[]|Promise<readonly string[]>;
    /** Return false only when another claimant holds the name. An uncertain write stops provisioning. */
    reserveLiveAccount(name:string,server:string):Promise<boolean>;
    createLocalAccount(name:string,server:string):unknown|Promise<unknown>;
    /** Run one bounded claim-account command and retain its raw result outside this adapter. */
    registerAccount(name:string,server:string,crew?:ProvisionCrew):Promise<RegistrationResult>;
}
export interface AccountProvisionResult {
    account?:string;
    server:string;
    registered:boolean;
    reason:string;
}

const allowedServer=(server:string)=>server==='rs-sdk-demo.fly.dev'||/^localhost(?::[0-9]+)?$/.test(server);

/** One login attempt. The consumer must persist the selected identity on failure or unknown availability. */
export async function provisionAccount(request:AccountProvisionRequest,deps:AccountProvisionDeps):Promise<AccountProvisionResult> {
    const failed=(reason:string,account?:string):AccountProvisionResult=>({account,server:request.server,registered:false,reason});
    if(!request.purpose?.trim())return failed('account purpose required');
    if(!Object.hasOwn(NAMES,request.role))return failed('unsupported account role');
    if(!allowedServer(request.server))return failed('unsupported server');
    if(!Array.isArray(request.reservedNames)||request.reservedNames.some(n=>typeof n!=='string'))return failed('reserved identities required');
    let names:readonly string[];
    try {names=await deps.listLocalAccountNames();}catch{return failed('local identity inventory unavailable');}
    const used=[...names,...request.reservedNames];
    let account:string;
    for(;;){
        try {account=pickName(request.role,used);}
        catch {return failed('no unused names available for role');}
        if(!/^[A-Za-z0-9]{1,12}$/.test(account))return failed('selected role name is not permitted',account);
        if(request.server!=='rs-sdk-demo.fly.dev')break;
        try {if(await deps.reserveLiveAccount(account,request.server))break;}
        catch {return failed('shared identity reservation unconfirmed; retain identity for review',account);}
        used.push(account);
    }
    try {await deps.createLocalAccount(account,request.server);}
    catch {return failed('local credential creation failed; retain identity for review',account);}
    let result:RegistrationResult;
    try {result=await deps.registerAccount(account,request.server);}
    catch {return failed('registration availability unknown; retain identity for review',account);}
    if(result.timedOut)return failed('registration timed out; availability unknown',account);
    if(result.exitCode!==0)return failed('registration failed; availability unknown',account);
    const claims=result.stdout.split(/\r?\n/).filter(line=>line.startsWith('CLAIM '));
    if(claims.length!==1||!/^CLAIM ticks=\d+ in_game=(?:true|false) logout=logged-out$/.test(claims[0]!))
        return failed('registration claim or logout unconfirmed',account);
    return {account,server:request.server,registered:true,reason:'server claim and logout confirmed'};
}

/** No calls run until the returned dependency methods are invoked. Serialize provisioning per job. */
// workerRelease is the capability release of REGISTRATION_SCRIPT (packages/core/src/worker-release.ts).
export const REGISTRATION_SCRIPT='scripts/claim-account.ts';
export function registrationEnvironment(server:string,workerRelease:string|undefined){
 if(server==='rs-sdk-demo.fly.dev'&&(!workerRelease||! /^[a-f0-9]{64}$/.test(workerRelease)))throw Error('live registration needs its qualified runtime release');
 return {...process.env,DEMO_OK:server==='rs-sdk-demo.fly.dev'?'1':'',...(workerRelease?{WORKER_RELEASE:workerRelease,WORKER_ENTRY:REGISTRATION_SCRIPT}:{})};
}
export function createAccountProvisionDeps(options:{timeoutMs?:number;workerRelease?:string;reservation?:string}={}):AccountProvisionDeps {
    const root=resolve(import.meta.dir,'../../..'),timeoutMs=options.timeoutMs??60_000;
    if(!Number.isInteger(timeoutMs)||timeoutMs<=0||timeoutMs>120_000)throw Error('registration timeout must be 1..120000ms');
    const checkPause=(name:string)=>{
        if(['stop-coordinator','stop-swarm','stop-'+name].some(file=>existsSync(join(root,'.practice',file))))
            throw Error('live provisioning is paused by the owner');
    };
    return {
        listLocalAccountNames:()=>readdirSync(join(root,'vendor/rs-sdk/bots'),{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name),
        async reserveLiveAccount(name,server) {
            const side=mySide();
            checkPause(name);
            if(side!=='local'&&!process.env.FLEET_SEED?.trim())throw Error('cloud provisioning requires FLEET_SEED');
            if(!options.reservation)throw Error('live provisioning requires a coordinator run identity');
            return reserveFleetOwner(root,{account:name,side,server,reservation:options.reservation});
        },
        createLocalAccount(name,server) {
            const dir=createAccount(name,server);
            if(server==='rs-sdk-demo.fly.dev'&&mySide()!=='local'){
                const seed=process.env.FLEET_SEED;
                const expected=seed?.trim()&&`SERVER=${server}\nPASSWORD=${accountPassword(name,server,seed)}\n`;
                if(!expected||readFileSync(join(dir,'bot.env'),'utf8').replaceAll('\r\n','\n')!==expected)
                    throw Error('cloud credential file does not match the fleet seed');
            }
        },
        async registerAccount(name,server,crew) {
            if(!/^[A-Za-z0-9]{1,12}$/.test(name)||!allowedServer(server))throw Error('invalid registration target');
            if(server==='rs-sdk-demo.fly.dev')checkPause(name);
            const child=Bun.spawn([process.execPath,REGISTRATION_SCRIPT,name],{
                cwd:root,env:{...registrationEnvironment(server,options.workerRelease??process.env.WORKER_RELEASE),FLEET_PROVISION_CREW:crew?JSON.stringify(crew):''},stdout:'pipe',stderr:'ignore',
            windowsHide:true});
            let timedOut=false,termination:Promise<void>|undefined;
            const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid);},timeoutMs);
            try {
                const [exitCode,stdout]=await Promise.all([child.exited,new Response(child.stdout).text()]);
                await termination;
                return {exitCode,stdout,timedOut};
            }finally {clearTimeout(timer);}
        },
    };
}
