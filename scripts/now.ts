// Prints the state of this PC and the fleet on one screen. A session reads it first, so that it starts from the
// facts: free memory, stop files, the controllers, the swarm, the coordinator queue, alerts, the board, the fleet
// sides, the open pull requests, and this checkout and the main checkout against origin/master.
// It reads the local dashboard (http://localhost:<DASH_PORT>/api/state) and the facts that the dashboard does not
// hold: the stop files, the git state and the SDK patch. It changes nothing.
// Usage: bun scripts/now.ts
// No worker imports this file, so an edit changes no worker release (packages/core/src/worker-release.ts).
import {existsSync,readFileSync,statSync} from 'node:fs';
import {uptime} from 'node:os';
import {join,resolve} from 'node:path';

type Task={id:string;kind:string;status:string;agent:string|null;account:string|null;startedAt:number|null;timeoutMs?:number};
type Bot={name:string;job?:{enabled?:boolean;state?:string}|null};
// The parts of the dashboard state that this file reads (packages/dashboard/server.ts builds the whole state).
export type DashState={
    now:number;
    capacity?:{freeGB:number|null;floorGB:number|null;pendingReserveGB:number|null;headroomGB:number|null};
    swarm?:{at:number;running:number;maxBots:number;pendingStartup:number;jobs:number};
    sys?:{cpu:number;procs:{script:string;up:number}[]};
    coordination?:{at:number;fresh?:boolean;paused:boolean;counts:Record<string,number>;tasks:Task[]};
    bots?:Bot[];
    alerts?:{name:string;kind:string;practice:boolean}[];
    scoreboard?:{at:number;skills99:number;remaining:string[]};
    fleetSides?:{sides:{side:string;at:number;late:boolean}[]};
    prs?:{number:number;branch:string;draft:boolean;state:string}[];
};
export type Checkout={path:string;branch:string;head:string;dirty:number;behind:number|null;ahead:number|null;fetchedAt:number|null;patch:'applied'|'not applied'|'no vendor/rs-sdk'};
export type Local={uptimeSec:number;stops:{file:string;text:string}[];here:Checkout;main:Checkout|null};

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
// The controllers that the main checkout runs, by the script name that the dashboard gives each process.
export const CONTROLLERS=['swarm.ts','coordinator-cli.ts','autopilot.ts','fleet-agent.ts'] as const;
// The jobs that must not run two at a time on one PC (AGENTS.md, "Keep the loop fast"). The dashboard lists the
// bun processes only, and scans them at most each 30 s: a `tsc` under node is not in the count, and a job that
// started in the last minute can be missing.
export const HEAVY=['ci-gate.ts','test-shards.ts','aio-practice-bench.ts','typecheck-narrow.ts'] as const;

function checkoutLine(label:string,c:Checkout,now:number):string{
    const against=c.behind==null?'origin/master not known':`${c.behind} behind, ${c.ahead} ahead of origin/master`;
    const fetched=c.fetchedAt==null?'never fetched':`fetched ${age(now-c.fetchedAt)} ago`;
    return `${label} ${c.branch} @ ${c.head}, ${c.dirty} changed files, ${against} (${fetched}), SDK patch ${c.patch}`;
}

export function nowLines(state:DashState|null,local:Local,now:number):string[]{
    const out:string[]=[];
    if(state){
        const c=state.capacity,procs=state.sys?.procs??[];
        const heavy=[...HEAVY.map(h=>`${h} ${procs.filter(p=>p.script===h).length}`),`test files ${procs.filter(p=>p.script.endsWith('.test.ts')).length}`].join(', ');
        out.push(`host    free ${gb(c?.freeGB)} GiB = floor ${gb(c?.floorGB)} + pending starts ${gb(c?.pendingReserveGB)} + headroom ${gb(c?.headroomGB)}; cpu ${Math.round(state.sys?.cpu??0)}%; up ${age(local.uptimeSec*1000)}`);
        out.push(`heavy   ${heavy} (bun processes, up to 60 s old)`);
    }else out.push(`host    up ${age(local.uptimeSec*1000)}`);
    out.push('stop    '+(local.stops.length?local.stops.map(s=>`${s.file}: "${s.text}"`).join('; '):'no stop-coordinator, no stop-swarm')+(state?.coordination?.paused?'; the coordinator is paused':''));
    if(state){
        const procs=state.sys?.procs??[];
        out.push('control '+CONTROLLERS.map(name=>{const p=procs.find(x=>x.script===name);return p?`${name} up ${age(p.up)}`:`${name} DOWN`;}).join(', '));
        const sw=state.swarm;
        if(sw)out.push(`swarm   ${sw.running} of ${sw.maxBots} bots, ${sw.pendingStartup} pending starts, ${sw.jobs} jobs; state ${age(now-sw.at)} old`);
        const jobs=(state.bots??[]).filter(b=>b.job?.enabled).map(b=>({key:b.job!.state??'no state',name:b.name}));
        if(jobs.length)out.push('jobs    '+tally(jobs,['running']));
        const co=state.coordination;
        if(co){
            out.push(`coord   running ${co.counts.running??0}, pending ${co.counts.pending??0}; state ${age(now-co.at)} old${co.fresh===false?' (not fresh)':''}`);
            for(const t of co.tasks.filter(t=>t.status==='running'))
                out.push(`  run   ${t.id} (${t.kind}, ${t.agent??'no agent'}${t.account?', '+t.account:''}) ${t.startedAt?age(now-t.startedAt):'?'}${t.timeoutMs?' of '+age(t.timeoutMs):''}`);
            const pending=co.tasks.filter(t=>t.status==='pending');
            if(pending.length)out.push('  wait  '+pending.slice(0,5).map(t=>t.id).join(', ')+(pending.length>5?`, and ${pending.length-5} more`:''));
        }
        const alerts=(state.alerts??[]).filter(a=>!a.practice).map(a=>({key:a.kind,name:a.name}));
        if(alerts.length)out.push('alerts  '+tally(alerts));
        const sb=state.scoreboard;
        if(sb)out.push(`board   99s ${sb.skills99}; ${sb.remaining.join('; ')}; ${age(now-sb.at)} old`);
        const sides=state.fleetSides?.sides??[];
        if(sides.length)out.push('sides   '+sides.map(s=>`${s.side} ${age(now-s.at)}${s.late?' LATE':''}`).join(', '));
        const prs=(state.prs??[]).filter(p=>p.state==='OPEN');
        out.push(`prs     ${prs.length} open`+(prs.length?': '+prs.map(p=>`${p.number} ${p.branch}${p.draft?' (draft)':''}`).join(', '):''));
    }else out.push('dashboard: no answer, so the fleet lines are missing. The lines below come from this PC only.');
    out.push(checkoutLine('here   ',local.here,now));
    if(local.main)out.push(checkoutLine('main   ',local.main,now));
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
    const state=await fetch(`http://localhost:${port}/api/state`,{signal:AbortSignal.timeout(8000)}).then(r=>r.ok?r.json() as Promise<DashState>:null).catch(()=>null);
    const same=main.toLowerCase()===here.toLowerCase();
    for(const line of nowLines(state,{uptimeSec:uptime(),stops,here:readCheckout(here),main:same?null:readCheckout(main)},Date.now()))console.log(line);
}
