// Prints the state of this PC and the fleet on one screen. A session reads it first, so that it starts from the
// facts: free memory, the heavy jobs, stop files, the controllers, the swarm, the coordinator queue, alerts, the
// board, the fleet sides, the open pull requests, and this checkout and the main checkout against origin/master.
// It reads the local dashboard (http://127.0.0.1:<DASH_PORT>/api/state) for the fleet. It reads by itself what must
// be fresh or what the dashboard does not hold: the process list, the stop files, the git state and the SDK patch.
// It changes nothing.
// Usage: bun scripts/now.ts
// No worker imports this file, so an edit changes no worker release (packages/core/src/worker-release.ts).
import {existsSync,readFileSync,statSync} from 'node:fs';
import {uptime} from 'node:os';
import {join,resolve} from 'node:path';

type Task={id:string;kind:string;status:string;agent:string|null;account:string|null;startedAt:number|null;timeoutMs?:number|null};
type Bot={name:string;job?:{enabled?:boolean;state?:string}|null};
// The parts of the dashboard state that this file reads (packages/dashboard/server.ts builds the whole state).
// A projection with no source file comes as `{available:false}` with no other field.
export type DashState={
    now:number;
    capacity?:{freeGB:number|null;floorGB:number|null;pendingReserveGB:number|null;headroomGB:number|null}|null;
    swarm?:{at:number;running:number;maxBots:number;pendingStartup:number;jobs:number}|null;
    sys?:{cpu:number}|null;
    coordination?:{available:boolean;at:number|null;fresh?:boolean;paused?:boolean;counts:Record<string,number>;tasks:Task[]}|null;
    bots?:Bot[];
    alerts?:{name:string;kind:string;practice:boolean}[];
    scoreboard?:{available:boolean;at?:number|null;skills99?:number|null;remaining?:string[]}|null;
    fleetSides?:{sides:{side:string;at:number;late:boolean}[]}|null;
    prs?:{number:number;branch:string;draft:boolean;state:string}[];
};
// One bun or node process: the script files that its command line names, and how long it has run.
export type Proc={scripts:string[];up:number};
export type Checkout={path:string;branch:string;head:string;dirty:number;behind:number|null;ahead:number|null;fetchedAt:number|null;patch:'applied'|'not applied'|'no vendor/rs-sdk'};
// `procs` is null when the process scan failed. Then the heavy jobs and the controllers are not known.
export type Local={uptimeSec:number;procs:Proc[]|null;stops:{file:string;text:string}[];here:Checkout;main:Checkout|null};

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
export const CONTROLLERS=['swarm.ts','coordinator-cli.ts','autopilot.ts','fleet-agent.ts'] as const;
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
    add('stop',()=>'stop    '+(local.stops.length?local.stops.map(s=>`${s.file}: "${s.text}"`).join('; '):'no stop-coordinator, no stop-swarm')+(state?.coordination?.paused?'; the coordinator is paused':''));
    add('control',()=>procs===null?'control not known: the process scan failed'
        :'control '+CONTROLLERS.map(name=>{const p=procs.find(x=>x.scripts.includes(name));return p?`${name} up ${age(p.up)}`:`${name} DOWN`;}).join(', '));
    if(state){
        add('swarm',()=>{const sw=state.swarm;return sw?`swarm   ${sw.running} of ${sw.maxBots} bots, ${sw.pendingStartup} pending starts, ${sw.jobs} jobs; state ${age(now-sw.at)} old`:'swarm   no state';});
        add('jobs',()=>{
            const jobs=(state.bots??[]).filter(b=>b.job?.enabled).map(b=>({key:b.job!.state??'no state',name:b.name}));
            return jobs.length?'jobs    '+tally(jobs,['running']):null;
        });
        add('coord',()=>{
            const co=state.coordination;
            if(!co?.available||co.at==null)return 'coord   no state';
            const lines=[`coord   running ${co.counts.running??0}, pending ${co.counts.pending??0}; state ${age(now-co.at)} old${co.fresh===false?' (not fresh)':''}`];
            for(const t of co.tasks.filter(t=>t.status==='running'))
                lines.push(`  run   ${t.id} (${t.kind}, ${t.agent??'no agent'}${t.account?', '+t.account:''}) ${t.startedAt?age(now-t.startedAt):'?'}${t.timeoutMs?' of '+age(t.timeoutMs):''}`);
            const pending=co.tasks.filter(t=>t.status==='pending');
            if(pending.length)lines.push('  wait  '+pending.slice(0,5).map(t=>t.id).join(', ')+(pending.length>5?`, and ${pending.length-5} more`:''));
            return lines;
        });
        add('alerts',()=>{
            const alerts=(state.alerts??[]).filter(a=>!a.practice).map(a=>({key:a.kind,name:a.name}));
            return alerts.length?'alerts  '+tally(alerts):null;
        });
        add('board',()=>{
            const sb=state.scoreboard;
            if(!sb?.available)return 'board   no state';
            return `board   99s ${sb.skills99??'?'}; ${(sb.remaining??[]).join('; ')}; ${sb.at==null?'time not known':age(now-sb.at)+' old'}`;
        });
        add('sides',()=>{
            const sides=state.fleetSides?.sides??[];
            return sides.length?'sides   '+sides.map(s=>`${s.side} ${age(now-s.at)}${s.late?' LATE':''}`).join(', '):null;
        });
        add('prs',()=>{
            const prs=(state.prs??[]).filter(p=>p.state==='OPEN');
            return `prs     ${prs.length} open`+(prs.length?': '+prs.map(p=>`${p.number} ${p.branch}${p.draft?' (draft)':''}`).join(', '):'');
        });
    }else out.push('dashboard: no answer, so the fleet lines are missing. The other lines come from this PC.');
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
            if(pid&&created)out.push({pid:Number(pid),scripts:scriptsOf(cmd.join('|')),up:now-Date.parse(created)});
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

if(import.meta.main){
    const here=resolve(import.meta.dir,'..');
    const list=Bun.spawnSync(['git','-C',here,'worktree','list','--porcelain'],{stdout:'pipe',stderr:'ignore',windowsHide:true}).stdout.toString();
    // The first worktree of the list is the main checkout. Only the main checkout runs the fleet and holds the stop files.
    const main=resolve(/^worktree (.+)$/m.exec(list)?.[1]??here);
    const stops=['stop-coordinator','stop-swarm'].filter(f=>existsSync(join(main,'.practice',f)))
        .map(file=>({file,text:(readFileSync(join(main,'.practice',file),'utf8').split(/\r?\n/)[0]??'').trim().slice(0,120)}));
    const port=Number(process.env.DASH_PORT??3100);
    // 127.0.0.1: the dashboard listens on IPv4 (DASH_HOST default), and localhost can resolve to ::1 first.
    const state=await fetch(`http://127.0.0.1:${port}/api/state`,{signal:AbortSignal.timeout(8000)}).then(r=>r.ok?r.json() as Promise<DashState>:null).catch(()=>null);
    const same=main.toLowerCase()===here.toLowerCase(),now=Date.now();
    for(const line of nowLines(state,{uptimeSec:uptime(),procs:scanProcs(now),stops,here:readCheckout(here),main:same?null:readCheckout(main)},now))console.log(line);
}
