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

// A release covers the files one process can run, not the whole tree (docs/script-contract.md, Release scope):
// its entries and every file they reach through relative imports or through string literals that name a file or
// folder under releaseDataRoots, plus the runtime trees and root files every worker runs on.
export const runtimeTrees=['vendor/rs-sdk/sdk','vendor/rs-sdk/server/webclient/src'];
const releaseRootFiles=['package.json','bun.lock','tsconfig.json'];
const releaseDataRoots=['knowledge','scripts','packages'];
// The processes that start a swarm worker; supervise-host.ts names packages/core/src/host.ts.
export const workerLaunchers=['packages/practice/src/supervise.ts','packages/practice/src/supervise-host.ts'];
// The controller and the recovery runner it starts (RECOVERY_SCRIPT in session-recovery-permit.ts).
export const launchEntries=['scripts/swarm.ts',...workerLaunchers,'packages/core/src/session-recovery.ts'];
const codeFile=/\.(?:ts|tsx|js|mjs|cjs)$/,releaseFile=/\.(?:ts|tsx|js|mjs|cjs|json|wasm)$/;
const skipped=new Set(['node_modules','.git','.practice']);
// These modules name files only to hash them and refuse changed bytes themselves, so their literals add nothing:
// this file names release inputs; launch-evidence.ts binds the main launch to its own source fingerprint.
const hashOnly=new Set(['packages/core/src/worker-release.ts','packages/core/src/launch-evidence.ts']);
// One call's file reads and parses; a check of several peers shares it. Never kept between calls.
export type ReleaseMemo=Map<string,unknown>;

const posix=(p:string)=>p.replaceAll('\\','/');
function repoPath(base:string,abs:string):string|undefined{
    const p=posix(relative(resolve(base),abs));
    return !p||p==='..'||p.startsWith('../')||/^[a-zA-Z]:/.test(p)||p.split('/').some(s=>skipped.has(s))?undefined:p;
}
function kind(base:string,p:string):'file'|'dir'|undefined{
    try{const s=statSync(join(base,p));return s.isFile()?'file':s.isDirectory()?'dir':undefined;}catch{return undefined;}
}
function treeFiles(base:string,dir:string,memo:ReleaseMemo):string[]{
    const key='t:'+dir;if(memo.has(key))return memo.get(key) as string[];
    const out:string[]=[];
    const walk=(d:string)=>{for(const e of readdirSync(join(base,d),{withFileTypes:true})){
        if(skipped.has(e.name))continue;const p=d+'/'+e.name;
        if(e.isSymbolicLink())throw Error('no worker progress: linked release source unsupported: '+p);
        if(e.isDirectory())walk(p);else if(releaseFile.test(e.name)&&!e.name.endsWith('.test.ts'))out.push(p);
    }};
    walk(dir);memo.set(key,out);return out;
}
// Bun's relative resolution for the forms this repository uses, with the package.json a folder import reads.
function resolveImport(base:string,file:string,spec:string):string[]{
    const target=repoPath(base,resolve(base,dirname(file),spec));
    if(!target)throw Error('no worker progress: release import outside the repository: '+file+' -> '+spec);
    const candidates=(t:string)=>{const stem=t.replace(/\.(?:js|mjs|cjs|jsx)$/,'');
        return [t,...(stem!==t?[stem+'.ts',stem+'.tsx']:[]),...['.ts','.tsx','.d.ts','.js','.mjs','.cjs','.json'].map(x=>t+x)];};
    const found=candidates(target).find(c=>kind(base,c)==='file');
    if(found)return [found];
    if(kind(base,target)==='dir'){
        const manifest=target+'/package.json';let main='index';
        if(kind(base,manifest)==='file'){const m=JSON.parse(readFileSync(join(base,manifest),'utf8'))?.main;if(typeof m==='string'&&m)main=m;}
        const entry=repoPath(base,resolve(base,target,main)),inside=entry&&candidates(entry).concat(entry+'/index.ts',entry+'/index.js').find(c=>kind(base,c)==='file');
        if(inside)return kind(base,manifest)==='file'?[inside,manifest]:[inside];
    }
    throw Error('no worker progress: release import unresolved: '+file+' -> '+spec);
}
// Consecutive literal arguments of one call are one path: join(root,'knowledge','npcs.json') names the file, and
// join(root,'knowledge',name) names the folder.
function stringLiterals(file:string,text:string):string[]{
    const out:string[]=[],joined=new Set<ts.Node>();
    const visit=(n:ts.Node):void=>{
        if(ts.isCallExpression(n)){
            let run:ts.StringLiteralLike[]=[];
            const flush=()=>{if(run.length>1){out.push(run.map(r=>r.text).join('/'));run.forEach(r=>joined.add(r));}run=[];};
            for(const a of n.arguments){if(ts.isStringLiteralLike(a))run.push(a);else flush();}
            flush();
        }
        if(ts.isStringLiteralLike(n)){if(!joined.has(n))out.push(n.text);}
        else if(ts.isTemplateExpression(n)){out.push(n.head.text);for(const s of n.templateSpans)out.push(s.literal.text);}
        ts.forEachChild(n,visit);
    };
    const scriptKind=/\.tsx$/.test(file)?ts.ScriptKind.TSX:/\.(?:js|mjs|cjs)$/.test(file)?ts.ScriptKind.JS:ts.ScriptKind.TS;
    visit(ts.createSourceFile(file,text,ts.ScriptTarget.Latest,false,scriptKind));
    return out;
}
// A literal names a release path when, read from the file's folder or from the repository root, it is an existing
// file under releaseDataRoots or vendor (a wasm a vendored module loads), or a folder under releaseDataRoots.
// Folders count from knowledge, scripts/<dir> and packages/<pkg>/<dir>.
function literalPaths(base:string,file:string,literal:string):{path:string;dir:boolean}[]{
    if(literal.length>300||!/^[\w@.\/\\-]+$/.test(literal)||/^[./\\]*$/.test(literal))return [];
    const s=posix(literal);let fromRoot=s;
    for(let next=fromRoot.replace(/^(?:\.\.?\/|\/)/,'');next!==fromRoot;next=fromRoot.replace(/^(?:\.\.?\/|\/)/,''))fromRoot=next;
    const out:{path:string;dir:boolean}[]=[];
    for(const p of new Set([repoPath(base,resolve(base,dirname(file),s)),repoPath(base,resolve(base,fromRoot))])){
        if(!p)continue;const parts=p.split('/'),top=parts[0]!;
        if(!releaseDataRoots.includes(top)&&top!=='vendor')continue;
        const k=kind(base,p);
        if(k==='file'&&releaseFile.test(p)&&!p.endsWith('.test.ts'))out.push({path:p,dir:false});
        else if(k==='dir'&&releaseDataRoots.includes(top)&&(top==='knowledge'||top==='scripts'&&parts.length>=2||top==='packages'&&parts.length>=3))out.push({path:p,dir:true});
    }
    return out;
}
function fileLinks(base:string,file:string,memo:ReleaseMemo):{files:string[];dirs:string[]}{
    const key='l:'+file;if(memo.has(key))return memo.get(key) as {files:string[];dirs:string[]};
    const text=readFileSync(join(base,file),'utf8'),files:string[]=[],dirs:string[]=[];
    for(const {fileName:spec} of ts.preProcessFile(text,true,true).importedFiles){
        if(spec.startsWith('.'))files.push(...resolveImport(base,file,spec));
        else if(spec.startsWith('@rsbot/'))throw Error('no worker progress: release workspace import unsupported: '+file+' -> '+spec);
    }
    if(!hashOnly.has(file))for(const literal of stringLiterals(file,text))for(const p of literalPaths(base,file,literal))(p.dir?dirs:files).push(p.path);
    const links={files,dirs};memo.set(key,links);return links;
}
const inRuntimeTree=(p:string)=>runtimeTrees.some(t=>p===t||p.startsWith(t+'/'));
export function releaseFiles(entries:readonly string[],base=root,memo:ReleaseMemo=new Map()):string[]{
    const files=new Set<string>(releaseRootFiles),queue:string[]=[];
    const add=(p:string)=>{if(!files.has(p)){files.add(p);queue.push(p);}};
    for(const t of runtimeTrees)for(const p of treeFiles(base,t,memo))files.add(p);
    for(const entry of entries){
        const p=repoPath(base,resolve(base,entry));
        if(!p||kind(base,p)!=='file')throw Error('no worker progress: release entry missing: '+entry);
        add(p);
    }
    while(queue.length){
        const file=queue.pop()!;
        if(!codeFile.test(file)||inRuntimeTree(file))continue;
        const links=fileLinks(base,file,memo);
        links.files.forEach(add);
        for(const dir of links.dirs)treeFiles(base,dir,memo).forEach(add);
    }
    return [...files].sort();
}
function revisionOf(base:string,files:readonly string[],memo:ReleaseMemo):string{
    const hash=createHash('sha256');
    for(const p of files){
        const key='d:'+p;let digest=memo.get(key) as string|undefined;
        if(!digest){digest=createHash('sha256').update(readFileSync(join(base,p))).digest('hex');memo.set(key,digest);}
        hash.update(p+'\0'+digest+'\0');
    }
    return hash.digest('hex');
}
export function releaseRevision(entries:readonly string[],base=root,memo:ReleaseMemo=new Map()):string{
    return revisionOf(base,releaseFiles(entries,base,memo),memo);
}
// The job script and every job argument that names a repository code file (a chain job's step scripts).
export function workerEntries(script:string,args:readonly unknown[]=[],base=root):string[]{
    const named=args.flatMap(a=>String(a).split(/\s+/)).filter(t=>codeFile.test(t)&&!t.includes(',')&&kind(base,posix(t))==='file');
    return [...new Set([script,...named].map(posix))];
}
export function capabilityRevision(entries:readonly string[],base=root,memo:ReleaseMemo=new Map()):string{
    if(!entries.length)throw Error('no worker progress: capability release needs an entry');
    return releaseRevision([...entries,...workerLaunchers],base,memo);
}
export function launchRevision(base=root,memo:ReleaseMemo=new Map()):string{return releaseRevision(launchEntries,base,memo);}
// WORKER_ENTRY holds a worker's entries, comma-separated; none means the launch release.
export function releaseEntries(value:unknown):string[]{return typeof value==='string'?value.split(',').filter(Boolean):[];}
export function releaseFor(entries:readonly string[],base=root,memo:ReleaseMemo=new Map()):string{
    return entries.length?capabilityRevision(entries,base,memo):launchRevision(base,memo);
}
// Each release file's size and modification time and each of their folders' modification time (an added file
// changes it), with no file read: a coordinator loop checks this and hashes the files only when it changes.
function releaseStamp(base:string,files:readonly string[]):string{
    const hash=createHash('sha256');
    for(const p of [...files,...new Set(files.map(f=>dirname(f)))]){const s=statSync(join(base,p));hash.update(p+'\0'+s.size+'\0'+s.mtimeMs+'\0');}
    return hash.digest('hex');
}
const launchByBase=new Map<string,{files:string[];stamp:string;value:string}>();
// launchRevision for a base whose release files and folders kept their stamps since this process last hashed it.
export function cachedLaunchRevision(base=root):string{
    const hit=launchByBase.get(base);
    if(hit)try{if(releaseStamp(base,hit.files)===hit.stamp)return hit.value;}catch{/* a missing file recomputes */}
    const memo:ReleaseMemo=new Map(),files=releaseFiles(launchEntries,base,memo),stamp=releaseStamp(base,files);
    const value=revisionOf(base,files,memo);launchByBase.set(base,{files,stamp,value});return value;
}

function importedPath(base:string,file:string,spec:string):string{
    return relative(resolve(base),resolve(base,dirname(file),spec)).replaceAll('\\','/');
}

// The pin must equal the current release of the process's WORKER_ENTRY, or the launch release when it has none.
export function assertWorkerRelease(env:Record<string,string|undefined>=process.env,base=root,memo:ReleaseMemo=new Map()):string {
    const pin=env.WORKER_RELEASE;
    if(!pin||! /^[a-f0-9]{64}$/.test(pin))throw Error('no worker progress: release pin missing; live starts paused');
    if(releaseFor(releaseEntries(env.WORKER_ENTRY),base,memo)!==pin)throw Error('no worker progress: release source changed; live starts paused');
    return pin;
}

// A standing peer runs the source its swarm pinned at start and is exempt from release equality, like its own start
// (assertLiveWorkerRelease). It must be an account a standing job in swarm.json names, carry a revision, and no
// coordinator run. Any other unfinished peer on another release (a manual session, a coordinator run) is incompatible.
export function standingPeer(row:any,standingAccounts:ReadonlySet<string>):boolean {
    return typeof row?.name==='string'&&standingAccounts.has(row.name.toLowerCase())&&row.coordinatorRunId==null
        &&typeof row.workRevision==='string'&&/^[a-f0-9]{64}$/.test(row.workRevision);
}
// current gives a peer's current release; assertLiveWorkerRelease uses the release of the peer's own workEntry.
export function assertCompatibleWorkers(pin:string,server:string,statuses:readonly any[],now=Date.now(),closed:(row:any)=>boolean=()=>false,standing:(row:any)=>boolean=()=>false,current:(row:any)=>string=()=>pin):void {
    const unfinished=statuses.filter(s=>s?.server===server&&!s.result&&!closed(s));
    if(unfinished.some(s=>!Number.isFinite(s.at)||s.at<=0||s.at>now||now-s.at>=30_000))
        throw Error('no worker progress: release peer state unknown; verify offline before rollout');
    if(unfinished.some(s=>!standing(s)&&s.workRevision!==current(s)))
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
    const memo:ReleaseMemo=new Map(),pin=assertWorkerRelease(env,base,memo),statuses:any[]=[];
    try{for(const entry of readdirSync(join(base,'.practice/status'))){
        if(!entry.endsWith('.json'))continue;
        statuses.push(JSON.parse(readFileSync(join(base,'.practice/status',entry),'utf8')));
    }}catch{throw Error('no worker progress: release peer state unknown; unreadable status evidence');}
    const owners=standingAccounts(base);
    // A peer whose entries are gone or do not resolve has no current release, so it counts as stale.
    const releases=new Map<string,string>(),current=(row:any)=>{
        const key=typeof row?.workEntry==='string'?row.workEntry:'';
        if(!releases.has(key)){let value='';try{value=releaseFor(releaseEntries(key),base,memo);}catch{/* stale */}releases.set(key,value);}
        return releases.get(key)!;
    };
    assertCompatibleWorkers(pin,server,statuses,Date.now(),row=>closedSessionRow(row,server,{root:join(base,'.practice/session-lifecycle')}),row=>standingPeer(row,owners),current);
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

// Read-only candidate IDs. Printing them does not approve or activate a release.
// bun packages/core/src/worker-release.ts [entry ...] prints the entries' capability release, else the launch release.
if(import.meta.main){const entries=process.argv.slice(2);console.log(entries.length?capabilityRevision(entries):launchRevision());}
