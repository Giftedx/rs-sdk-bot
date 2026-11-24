// Prints the state of this PC and the fleet on one screen. A session reads it first, so that it starts from the
// facts: free memory, the heavy jobs, stop files, the controllers, the swarm, Fleet Brain, alerts, the
// board, the fleet sides, the open pull requests, the fast-fail loops of the main checkout's results
// (tools/fail-loops.ts), and this checkout and the main checkout against origin/master.
// It reads the local dashboard (http://127.0.0.1:<DASH_PORT>/api/state) for the fleet. It reads by itself what must
// be fresh or what the dashboard does not hold: the process list, the stop files, the git state and the SDK patch.
// It changes nothing.
// Usage: bun tools/now.ts
// No worker imports this file, so an edit changes no worker release (packages/core/src/worker-release.ts).
import {existsSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {uptime} from 'node:os';
import {join,resolve} from 'node:path';
import {failLoops,loopLines,readRecentResults,LOOP_WINDOW_MS,type FailLoop} from './fail-loops';
import {LEASE_MAX_AGE_MS,SIDE_NAME} from '../packages/core/src/fleet';
import {findStopFile,resolveFleetDataDir} from '../packages/core/src/practice-paths';

type BrainChain = { account: string; goal?: string; step?: string };
type Bot={name:string;job?:{enabled?:boolean;state?:string}|null};
// The parts of the dashboard state that this file reads (packages/dashboard/server.ts builds the whole state).
// A projection with no source file comes as `{available:false}` with no other field.
export type DashState={
    now:number;
    capacity?:{freeGB:number|null;floorGB:number|null;pendingReserveGB:number|null;headroomGB:number|null}|null;
    swarm?:{at:number;running:number;maxBots:number;pendingStartup:number;jobs:number}|null;
    sys?:{cpu:number}|null;
    brain?:{available:boolean;at:number|null;fresh?:boolean;paused?:boolean;activeChains?:number;goals?:number;defects?:number;infraOpen?:boolean;chains?:BrainChain[]}|null;
    bots?:Bot[];
    alerts?:{name:string;kind:string;practice:boolean}[];
    scoreboard?:{available:boolean;at?:number|null;skills99?:number|null;remaining?:string[];goals?:{version:number;main:{rank:number|null;gapTicks:number|null};specialists:{rank1s:unknown[]};quests:{complete:number;total:number};collection:{scopeKnown:boolean};army:{maxed:number;roster:string[]}}|null}|null;
    fleetSides?:{sides:{side:string;at:number|null;late:boolean}[]}|null;
    prs?:{number:number;branch:string;draft:boolean;state:string}[];
};
// One bun or node process: the script files that its command line names, and how long it has run.
export type Proc={scripts:string[];up:number};
export type Checkout={path:string;branch:string;head:string;dirty:number;behind:number|null;ahead:number|null;fetchedAt:number|null;patch:'applied'|'not applied'|'no vendor/rs-sdk'};
// `procs` is null when the process scan failed. Then the heavy jobs and the controllers are not known.
// `loops`: the fast-fail loops of the main checkout's results (tools/fail-loops.ts); null when they were not read.
export type SyncedLease={side:string;pid:number|null;at:number|null};
export type Local={uptimeSec:number;procs:Proc[]|null;stops:{file:string;text:string}[];here:Checkout;main:Checkout|null;loops?:FailLoop[]|null;syncedLeases?:SyncedLease[]|null};

// Fleet-data mirrors are a saved observation, not a remote process or network health check.
export function readSyncedLeases(dir:string):SyncedLease[]|null{
    if(!existsSync(dir))return [];
    try{return readdirSync(dir).filter(f=>f.endsWith('.json')&&SIDE_NAME.test(f.slice(0,-5))).map(file=>{
        const side=file.slice(0,-5);
        try{const row=JSON.parse(readFileSync(join(dir,file),'utf8'));
            if(row.side!==side)return{side,pid:null,at:null};
            return{side,pid:Number.isSafeInteger(row.pid)&&row.pid>0?row.pid:null,at:Number.isSafeInteger(row.at)&&row.at>0?row.at:null};
        }catch{return{side,pid:null,at:null};}
    });}catch{return null;}
}

export function age(ms:number):string{
    const s=Math.max(0,ms)/1000;
    if(s<90)return `${Math.round(s)} s`;
    if(s<5400)return `${Math.round(s/60)} min`;
    if(s<172800)return `${(s/3600).toFixed(1)} h`;
    return `${(s/86400).toFixed(1)} d`;
}
const gb=(n:number|null|undefined)=>n==null?'?':n.toFixed(1);
// Counts the values and names the owners of each value that is not `quiet`: "running 24, exit orphaned 2 (A, B)".
function tally(rows:{key:string;name:string}[],quiet:string[]=[]):string{
    const groups=new Map<string,string[]>();
    for(const r of rows)groups.set(r.key,[...(groups.get(r.key)??[]),r.name]);
    return [...groups.entries()].sort((a,b)=>b[1].length-a[1].length)
        .map(([key,names])=>`${key} ${names.length}`+(quiet.includes(key)?'':` (${names.slice(0,6).join(', ')}${names.length>6?', ...':''})`)).join(', ');
}
// The controllers that the main checkout runs.
export const CONTROLLERS=['swarm.ts','fleet-agent.ts'] as const;
// The name that `scriptsOf` gives a test run: `bun test`, with or without file names (`bun test ./scripts ./packages`).
export const BUN_TEST='bun test';
// The jobs that must not run two at a time on one PC (AGENTS.md, "Keep the loop fast").
export const HEAVY=['ci-gate.ts','test-shards.ts','aio-practice-bench.ts','typecheck-narrow.ts','tsc',BUN_TEST] as const;

// The script files that a command line names, and two programs that name no script file: the TypeScript compiler
// (its bin path has no suffix) and the test runner.
export function scriptsOf(commandLine:string):string[]{
    const out=(commandLine.match(/[\w.-]+\.(?:ts|js)\b/g)??[]).map(s=>s==='tsc.js'?'tsc':s);
    if(/typescript[\\/]bin[\\/]tsc\b/.test(commandLine)&&!out.includes('tsc'))out.push('tsc');
    if(/(?:^|[\\/\s"])bun(?:\.exe)?"?\s+test(?:\s|$)/.test(commandLine))out.push(BUN_TEST);
    return out;
}

function checkoutLine(label:string,c:Checkout,now:number):string{
    const against=c.behind==null?'origin/master not known':`${c.behind} behind, ${c.ahead} ahead of origin/master`;
    const fetched=c.fetchedAt==null?'never fetched':`fetched ${age(now-c.fetchedAt)} ago`;
    return `${label} ${c.branch} @ ${c.head}, ${c.dirty} changed files, ${against} (${fetched}), SDK patch ${c.patch}`;
}

export function nowLines(state:DashState|null,local:Local,now:number):string[]{
    const out:string[]=[];
    // One part of the state with a shape that this file does not expect must not hide the other lines.
    const add=(label:string,build:()=>string|string[]|null)=>{
        try{const lines=build();if(lines)out.push(...[lines].flat());}
        catch(e){out.push(`${label.padEnd(7)} not readable: ${e instanceof Error?e.message:String(e)}`);}
    };
    add('host',()=>{
        const c=state?.capacity,up=`up ${age(local.uptimeSec*1000)}`;
        return c?`host    free ${gb(c.freeGB)} GiB = floor ${gb(c.floorGB)} + pending starts ${gb(c.pendingReserveGB)} + headroom ${gb(c.headroomGB)}; cpu ${Math.round(state?.sys?.cpu??0)}%; ${up}`:`host    ${up}`;
    });
    const procs=local.procs;
    add('heavy',()=>procs===null?'heavy   not known: the process scan failed. Do not start a heavy job on this line.'
        :'heavy   '+HEAVY.map(h=>`${h} ${procs.filter(p=>p.scripts.includes(h)).length}`).join(', '));
    add('stop',()=>'stop    '+(local.stops.length?local.stops.map(s=>`${s.file}: "${s.text}"`).join('; '):'no stop-swarm')+(state?.brain?.paused?'; side paused':''));
    add('control',()=>procs===null?'control not known: the process scan failed'
        :'control '+CONTROLLERS.map(name=>{const p=procs.find(x=>x.scripts.includes(name));return p?`${name} up ${age(p.up)}`:`${name} DOWN`;}).join(', '));
    add('leases',()=>{
        if(local.syncedLeases===undefined)return null;
        if(local.syncedLeases===null)return 'leases  not known: synced controller records could not be read';
        if(!local.syncedLeases.length)return 'leases  no synced controller records; current remote process identity and health not checked';
        const rows=[...local.syncedLeases].sort((a,b)=>a.side==='local'?-1:b.side==='local'?1:a.side.localeCompare(b.side));
        return 'leases  synced controller records: '+rows.map(s=>{
            const known=typeof s.at==='number'&&s.at>0&&s.at<=now;
            return `${s.side} pid=${s.pid??'unknown'} renewal=${known?age(now-s.at!)+(now-s.at!>=LEASE_MAX_AGE_MS?' STALE':''):'unknown'}`;
        }).join(', ')+'; current remote process identity and health not checked';
    });
    if(state){
        add('swarm',()=>{const sw=state.swarm;return sw?`swarm   ${sw.running} of ${sw.maxBots} bots, ${sw.pendingStartup} pending starts, ${sw.jobs} jobs; state ${age(now-sw.at)} old`:'swarm   no state';});
        add('jobs',()=>{
            const jobs=(state.bots??[]).filter(b=>b.job?.enabled).map(b=>({key:b.job!.state??'no state',name:b.name}));
            return jobs.length?'jobs    '+tally(jobs,['running']):null;
        });
        add('brain',()=>{
            const b=state.brain;
            if(!b?.available||b.at==null)return 'brain   no state';
            const lines=[`brain   chains ${b.activeChains??0}, goals ${b.goals??0}, defects ${b.defects??0}${b.infraOpen?', infra OPEN':''}; state ${age(now-b.at)} old${b.fresh===false?' (not fresh)':''}`];
            const chains=Array.isArray(b.chains)?b.chains:[];
            for(const c of chains.slice(0,5)) lines.push(`  chain ${c.account} (${c.goal??'unknown'}${c.step?', '+c.step:''})`);
            if(chains.length>5) lines.push(`  wait  ${chains.length-5} more active chains`);
            return lines;
        });
        add('alerts',()=>{
            const alerts=(state.alerts??[]).filter(a=>!a.practice).map(a=>({key:a.kind,name:a.name}));
            return alerts.length?'alerts  '+tally(alerts):null;
        });
        add('board',()=>{
            const sb=state.scoreboard;
            if(!sb?.available)return 'board   no state';
            const g=sb.goals;
            if(g?.version===1)return `board   Overall rank ${g.main.rank??'unknown'}; launch gap ${g.main.gapTicks??'unknown'} ticks; specialist wins ${g.specialists.rank1s.length}; quests ${g.quests.complete}/${g.quests.total}; army ${g.army.maxed}/${g.army.roster.length} maxed; collection ${g.collection.scopeKnown?'scoped':'scope unknown'}; ${sb.at==null?'time not known':age(now-sb.at)+' old'}`;
            return `board   99s ${sb.skills99??'?'}; ${(sb.remaining??[]).join('; ')}; ${sb.at==null?'time not known':age(now-sb.at)+' old'}`;
        });
        add('sides',()=>{
            const sides=state.fleetSides?.sides??[];
            return sides.length?'sides   snapshots: '+sides.map(s=>`${s.side} ${typeof s.at==='number'&&s.at>0&&s.at<=now?age(now-s.at)+(s.late?' LATE':''):'unknown'}`).join(', '):null;
        });
        add('prs',()=>{
            const prs=(state.prs??[]).filter(p=>p.state==='OPEN');
            return `prs     ${prs.length} open`+(prs.length?': '+prs.map(p=>`${p.number} ${p.branch}${p.draft?' (draft)':''}`).join(', '):'');
        });
    }else out.push('dashboard: no answer, so the fleet lines are missing. The other lines come from this PC.');
    add('loops',()=>{
        const loops=local.loops;
        if(loops==null)return null;
        const window=age(LOOP_WINDOW_MS);
        return loops.length?[`loops   ${loops.length} fast-fail loops in ${window} (bun tools/fail-loops.ts):`,...loopLines(loops).map(l=>`  loop  ${l}`)]:`loops   none in ${window}`;
    });
    add('here',()=>checkoutLine('here   ',local.here,now));
    add('main',()=>local.main?checkoutLine('main   ',local.main,now):null);
    return out;
}

// A scan of the bun and node processes at this moment. The dashboard also holds a process list, but it scans only
// while a page is open, and /api/state answers from the last scan, of any age: that list can not prove that no
// heavy job runs.
// Returns null when the scan did not run or did not see the processes: the caller must not read that as "none".
function scanProcs(now:number):Proc[]|null{
    const windows=process.platform==='win32';
    // Windows: pid|start time|command line. Other systems: pid, seconds of run time, command line (`ps`).
    const cmd=windows
        ?['powershell','-NoProfile','-Command',"Get-CimInstance Win32_Process -Filter \"Name='bun.exe' OR Name='node.exe'\" | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.CreationDate.ToString('o'), $_.CommandLine }"]
        :['ps','-eo','pid=,etimes=,args='];
    let text:string;
    try{
        // A program that is not installed makes spawnSync throw.
        const r=Bun.spawnSync(cmd,{stdout:'pipe',stderr:'ignore',windowsHide:true,timeout:20_000});
        if(r.exitCode!==0)return null;
        text=r.stdout.toString();
    }catch{return null;}
    const rows=procRows(text,windows,now);
    // This process is a bun process. A list without it means that the scan did not see the processes.
    return rows.some(r=>r.pid===process.pid)?rows.filter(r=>r.pid!==process.pid).map(({scripts,up})=>({scripts,up})):null;
}
// The bun and node processes of one scan output, in the format of `scanProcs` for that system.
export function procRows(text:string,windows:boolean,now:number):(Proc&{pid:number})[]{
    const out:(Proc&{pid:number})[]=[];
    for(const line of text.split(/\r?\n/)){
        if(windows){
            const [pid,created,...cmd]=line.trim().split('|');
            const pidNum=Number(pid),startedMs=Date.parse(created??'');
            if(pid&&created&&Number.isSafeInteger(pidNum)&&pidNum>0&&Number.isFinite(startedMs)){
                out.push({pid:pidNum,scripts:scriptsOf(cmd.join('|')),up:now-startedMs});
            }
        }else{
            const m=/^\s*(\d+)\s+(\d+)\s+(\S+)(.*)$/.exec(line);
            if(m&&/(?:^|\/)(?:bun|node)$/.test(m[3]!))out.push({pid:Number(m[1]),scripts:scriptsOf(m[3]!+m[4]!),up:Number(m[2])*1000});
        }
    }
    return out;
}

function readCheckout(path:string):Checkout{
    const git=(...args:string[])=>{const r=Bun.spawnSync(['git','-C',path,...args],{stdout:'pipe',stderr:'ignore',windowsHide:true});return r.exitCode===0?r.stdout.toString().trim():null;};
    const counts=git('rev-list','--left-right','--count','HEAD...origin/master')?.split(/\s+/).map(Number);
    // A fetch writes FETCH_HEAD in the git folder of the worktree that ran it. Any of them moves origin/master.
    const common=git('rev-parse','--path-format=absolute','--git-common-dir');
    const fetched=[git('rev-parse','--path-format=absolute','--git-path','FETCH_HEAD'),common&&join(common,'FETCH_HEAD')]
        .filter((f):f is string=>!!f&&existsSync(f)).map(f=>statSync(f).mtimeMs);
    const vendor=join(path,'vendor','rs-sdk');
    const patch=!existsSync(join(vendor,'package.json'))?'no vendor/rs-sdk'
        :Bun.spawnSync(['git','-C',vendor,'apply','--check','-R',join(path,'patches','rs-sdk-working.patch')],{stdout:'ignore',stderr:'ignore',windowsHide:true}).exitCode===0?'applied':'not applied';
    return {path,branch:git('rev-parse','--abbrev-ref','HEAD')??'?',head:git('rev-parse','--short','HEAD')??'?',
        dirty:(git('status','--porcelain')??'').split('\n').filter(Boolean).length,
        ahead:counts?.[0]??null,behind:counts?.[1]??null,
        fetchedAt:fetched.length?Math.max(...fetched):null,patch};
}

export function readSwarmStops(main:string):{file:string;text:string}[]{
    const stopFile=findStopFile('swarm',main);
    if(!stopFile)return [];
    return [{file:'stop-swarm',text:(readFileSync(stopFile,'utf8').split(/\r?\n/)[0]??'').trim().slice(0,120)}];
}

export function resolveSyncedLeasesDir(main:string):string{
    const syncedFleet=join(resolveFleetDataDir(main),'fleet');
    return join(existsSync(syncedFleet)?syncedFleet:join(main,'fleet'),'leases');
}

if(import.meta.main){
    const here=resolve(import.meta.dir,'..');
    const list=Bun.spawnSync(['git','-C',here,'worktree','list','--porcelain'],{stdout:'pipe',stderr:'ignore',windowsHide:true}).stdout.toString();
    // The first worktree of the list is the main checkout. Only the main checkout runs the fleet and holds the stop files.
    const main=resolve(/^worktree (.+)$/m.exec(list)?.[1]??here);
    const stops=readSwarmStops(main);
    const port=Number(process.env.DASH_PORT??3100);
    // 127.0.0.1: the dashboard listens on IPv4 (DASH_HOST default), and localhost can resolve to ::1 first.
    const state=await fetch(`http://127.0.0.1:${port}/api/state`,{signal:AbortSignal.timeout(8000)}).then(r=>r.ok?r.json() as Promise<DashState>:null).catch(()=>null);
    const same=main.toLowerCase()===here.toLowerCase(),now=Date.now();
    let loops:FailLoop[]|null=null;
    try{loops=failLoops(readRecentResults(join(main,'.practice','results.jsonl')),now);}catch{/* an unreadable results file hides only this line */}
    const syncedLeases=readSyncedLeases(resolveSyncedLeasesDir(main));
    for(const line of nowLines(state,{uptimeSec:uptime(),procs:scanProcs(now),stops,here:readCheckout(here),main:same?null:readCheckout(main),loops,syncedLeases},now))console.log(line);
}
