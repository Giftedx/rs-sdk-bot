import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve,dirname,relative} from 'node:path';
import ts from 'typescript';
import {isLocalServer} from './localserver';

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

function importedPath(base:string,file:string,spec:string):string{
    return relative(resolve(base),resolve(base,dirname(file),spec)).replaceAll('\\','/');
}

export function assertWorkerRelease(env:Record<string,string|undefined>=process.env,base=root):string {
    const pin=env.WORKER_RELEASE;
    if(!pin||! /^[a-f0-9]{64}$/.test(pin))throw Error('no worker progress: release pin missing; live starts paused');
    if(workerSourceRevision(base)!==pin)throw Error('no worker progress: release source changed; live starts paused');
    return pin;
}

export function assertCompatibleWorkers(pin:string,server:string,statuses:readonly any[],now=Date.now()):void {
    const unfinished=statuses.filter(s=>s?.server===server&&!s.result);
    if(unfinished.some(s=>!Number.isFinite(s.at)||s.at<=0||s.at>now||now-s.at>=30_000))
        throw Error('no worker progress: release peer state unknown; verify offline before rollout');
    if(unfinished.some(s=>s.workRevision!==pin))
        throw Error('no worker progress: active legacy/different release; wait offline for coordinated rollout');
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
    assertCompatibleWorkers(pin,server,statuses);
}

// Read-only candidate ID. Printing it does not approve or activate a release.
if(import.meta.main)console.log(workerSourceRevision());
