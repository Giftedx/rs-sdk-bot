import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,existsSync,statSync} from 'node:fs';
import {join,resolve,dirname,relative} from 'node:path';
import ts from 'typescript';
import {isLocalServer} from './localserver';
import {readLogoutProof,listAttempts,type LogoutProof} from './session-lifecycle';

const root=resolve(import.meta.dir,'../../..');
// One fleet revision includes helpers and both host/single launch paths, not
// just the entry script. Credentials, mutable receipts and notes are excluded.
export const workerSourceRoots=['scripts','packages','vendor/rs-sdk/sdk','vendor/rs-sdk/server/webclient/src'];
// These packages do not execute workers. A runtime import into either must be
// included deliberately instead of silently escaping the release fingerprint.
const toolingRoots=['packages/dashboard','packages/router'];
export function workerSourceRevision(base=root):string {
    const hash=createHash('sha256');
    const walk=(relative:string)=>{
        for(const e of readdirSync(join(base,relative),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
            if(['node_modules','.git','.practice'].includes(e.name))continue;
            const p=`${relative}/${e.name}`;
            if(toolingRoots.includes(p))continue;
            if(e.isSymbolicLink())throw Error('no worker progress: linked release source unsupported');
            if(e.isDirectory())walk(p);
            else if(/\.(?:ts|tsx|js|mjs|cjs|json|wasm)$/.test(e.name)&&!e.name.endsWith('.test.ts')){
                const bytes=readFileSync(join(base,p));
                if(/\.(?:ts|tsx|js|mjs|cjs)$/.test(p))for(const spec of ts.preProcessFile(bytes.toString(),true,true).importedFiles){
                    if(!spec.fileName.startsWith('.'))continue;
                    const target=importedPath(base,p,spec.fileName);
                    if(toolingRoots.some(root=>target===root||target.startsWith(root+'/')))
                        throw Error('no worker progress: runtime imports non-runtime package: '+p);
                }
                hash.update(p+'\0').update(bytes).update('\0');
            }
        }
    };
    workerSourceRoots.forEach(walk);
    for(const p of ['package.json','bun.lock','tsconfig.json'])hash.update(p+'\0').update(readFileSync(join(base,p))).update('\0');
    return hash.digest('hex');
}

// The same files' paths, sizes and modification times, with no file read: a coordinator loop checks this
// (about 75 ms) and hashes the files (about 400 ms) only when it changes.
export function workerSourceStamp(base=root):string {
    const hash=createHash('sha256');
    const walk=(relative:string)=>{
        for(const e of readdirSync(join(base,relative),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
            if(['node_modules','.git','.practice'].includes(e.name))continue;
            const p=`${relative}/${e.name}`;
            if(toolingRoots.includes(p))continue;
            if(e.isDirectory())walk(p);
            else if(/\.(?:ts|tsx|js|mjs|cjs|json|wasm)$/.test(e.name)&&!e.name.endsWith('.test.ts')){
                const s=statSync(join(base,p));hash.update(p+'\0'+s.size+'\0'+s.mtimeMs+'\0');
            }
        }
    };
    workerSourceRoots.forEach(walk);
    for(const p of ['package.json','bun.lock','tsconfig.json']){const s=statSync(join(base,p));hash.update(p+'\0'+s.size+'\0'+s.mtimeMs+'\0');}
    return hash.digest('hex');
}
const revisionByStamp=new Map<string,{stamp:string;value:string}>();
// workerSourceRevision for a base whose stamp has not changed since this process last hashed it.
export function cachedWorkerSourceRevision(base=root):string {
    const stamp=workerSourceStamp(base),cached=revisionByStamp.get(base);
    if(cached&&cached.stamp===stamp)return cached.value;
    const value=workerSourceRevision(base);revisionByStamp.set(base,{stamp,value});return value;
}

function importedPath(base:string,file:string,spec:string):string{
    return relative(resolve(base),resolve(base,dirname(file),spec)).replaceAll('\\','/');
}

export function assertWorkerRelease(env:Record<string,string|undefined>=process.env,base=root):string {
    const pin=env.WORKER_RELEASE;
    if(!pin||! /^[a-f0-9]{64}$/.test(pin))throw Error('no worker progress: release pin missing; live starts paused');
    if(workerSourceRevision(base)!==pin)throw Error('no worker progress: release source changed; live starts paused');
    return pin;
}

// A standing peer runs the source its swarm pinned at start and is exempt from release equality, like its own start
// (assertLiveWorkerRelease). It must be an account a standing job in swarm.json names, carry a revision, and no
// coordinator run. Any other unfinished peer on another release (a manual session, a coordinator run) is incompatible.
export function standingPeer(row:any,standingAccounts:ReadonlySet<string>):boolean {
    return typeof row?.name==='string'&&standingAccounts.has(row.name.toLowerCase())&&row.coordinatorRunId==null
        &&typeof row.workRevision==='string'&&/^[a-f0-9]{64}$/.test(row.workRevision);
}
export function assertCompatibleWorkers(pin:string,server:string,statuses:readonly any[],now=Date.now(),closed:(row:any)=>boolean=()=>false,standing:(row:any)=>boolean=()=>false):void {
    const unfinished=statuses.filter(s=>s?.server===server&&!s.result&&!closed(s));
    if(unfinished.some(s=>!Number.isFinite(s.at)||s.at<=0||s.at>now||now-s.at>=30_000))
        throw Error('no worker progress: release peer state unknown; verify offline before rollout');
    if(unfinished.some(s=>s.workRevision!==pin&&!standing(s)))
        throw Error('no worker progress: active legacy/different release; wait offline for coordinated rollout');
}
// Every standing job counts, on or off: a job just turned off still owns its open session. Unreadable means none.
export function standingAccounts(base=root):Set<string> {
    try{
        const jobs=JSON.parse(readFileSync(join(base,'swarm.json'),'utf8')).jobs;
        return new Set((Array.isArray(jobs)?jobs:[]).filter((j:any)=>j?.standing===true)
            .flatMap((j:any)=>j.accounts??(j.account?[j.account]:[])).filter((a:unknown)=>typeof a==='string').map((a:string)=>a.toLowerCase()));
    }catch{return new Set();}
}

export function isWorkerReleaseHold(result:string):boolean {
    return /^RESULT fail (?:Error: )?no worker progress: (?:release (?:pin missing|source changed|peer state unknown|coordinator build in progress)|active legacy\/different release)/.test(result);
}

// Recheck before the network boundary, including workers launched by an old
// in-memory supervisor. Existing connected sessions are never polled or killed.
export function assertLiveWorkerRelease(server:string,env:Record<string,string|undefined>=process.env,base=root):void {
    if(isLocalServer(server))return;
    // A standing owner job (swarm STANDING=1) has no coordinator acceptance and runs the current source, so neither
    // a publish lock nor the release pin holds it.
    if(env.STANDING==='1')return;
    if(existsSync(join(base,'.practice/coordinator/build-lock.json')))throw Error('no worker progress: release coordinator build in progress; live starts paused');
    const pin=assertWorkerRelease(env,base),statuses:any[]=[];
    try{for(const entry of readdirSync(join(base,'.practice/status'))){
        if(!entry.endsWith('.json'))continue;
        statuses.push(JSON.parse(readFileSync(join(base,'.practice/status',entry),'utf8')));
    }}catch{throw Error('no worker progress: release peer state unknown; unreadable status evidence');}
    const owners=standingAccounts(base);
    assertCompatibleWorkers(pin,server,statuses,Date.now(),row=>closedSessionRow(row,server,{root:join(base,'.practice/session-lifecycle')}),row=>standingPeer(row,owners));
}

// The server drops a session whose client is gone after 200 s.
export const LOST_SESSION_DROP_MS=200_000;
// A live status row without a result is a closed session only when the account's own producer lifecycle says so:
// its newest attempt (the row's attempt or a later one) confirmed logout, or the row's own attempt is still the newest,
// its owner process is gone and the row is older than the server's lost-session drop.
export function closedSessionRow(row:any,server:string,opts:{root?:string}={},alive:(pid:number)=>boolean=pidAlive,now=Date.now()):boolean {
    if(typeof row?.name!=='string'||typeof row.sessionAttemptId!=='string'||!row.sessionAttemptId)return false;
    let latest:LogoutProof;try{latest=readLogoutProof(row.name,server,opts);}catch{return false;}
    if(latest.state==='confirmed')return latest.attemptId>=row.sessionAttemptId;
    if(latest.state!=='held'||latest.attemptId!==row.sessionAttemptId||!Number.isFinite(row.at)||now-row.at<LOST_SESSION_DROP_MS)return false;
    let pid:unknown;try{pid=listAttempts(row.name,server,opts).find(a=>a.attemptId===latest.attemptId)?.receipt?.owner.pid;}catch{return false;}
    return Number.isSafeInteger(pid)&&(pid as number)>0&&!alive(pid as number);
}
function pidAlive(pid:number):boolean{try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=='ESRCH';}}

// Read-only candidate ID. Printing it does not approve or activate a release.
if(import.meta.main)console.log(workerSourceRevision());
