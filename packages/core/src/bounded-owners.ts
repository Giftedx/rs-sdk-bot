import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {commandLine} from './proc';

export type BoundedOwnerBinding={watchId:string;plan:string;side:string};
export function boundedOwnerBinding(base:string,env:NodeJS.ProcessEnv=process.env):BoundedOwnerBinding|undefined{
    if(!env.CLOUD_WATCH_ID)return;
    if(!/^[a-f0-9-]{36}$/.test(env.CLOUD_WATCH_ID)||!env.SWARM_PLAN||!env.FLEET_SIDE)throw Error('bounded owner binding invalid');
    return {watchId:env.CLOUD_WATCH_ID,plan:resolve(base,env.SWARM_PLAN),side:env.FLEET_SIDE};
}
export function boundedProcessAlive(pid:number){
    try{
        process.kill(pid,0);
        if(process.platform==='linux'&&/\)\s+Z\b/.test(readFileSync(`/proc/${pid}/stat`,'utf8')))return false;
        return true;
    }catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH'&&(error as NodeJS.ErrnoException).code!=='ENOENT';}
}
type Identity={pid:number;nonce:string};
export function boundedGroupMembers(roots:readonly number[]):number[]|null{
    if(process.platform!=='linux')return null;
    try{const wanted=new Set(roots),members:number[]=[];
        for(const id of readdirSync('/proc').filter(s=>/^\d+$/.test(s))){
            try{const text=readFileSync(`/proc/${id}/stat`,'utf8'),fields=text.slice(text.lastIndexOf(')')+2).split(' ');
                if(fields[0]!=='Z'&&wanted.has(Number(fields[2])))members.push(Number(id));}catch{/* A process exited during the snapshot. */}
        }return members;
    }catch{return null;}
}
export function observeBoundedOwners(base:string,binding:BoundedOwnerBinding,launched:Identity[],deps:{alive?:(pid:number)=>boolean;command?:(pid:number)=>string|null;groups?:(roots:readonly number[])=>number[]|null}={}){
    const alive=deps.alive??boundedProcessAlive,command=deps.command??commandLine,active=new Set<number>(),groups=new Set<number>();
    const observed=new Map<string,string>(),read=(file:string)=>{const raw=readFileSync(file,'utf8');observed.set(file,raw);return JSON.parse(raw);};
    const match=(owner:any,role:'coordinator'|'swarm'|'worker')=>{
        if(!Number.isSafeInteger(owner?.pid)||owner.pid<1||typeof owner.nonce!=='string'||!owner.nonce)throw Error('bounded owner identity unreadable');
        groups.add(owner.pid);
        if(!alive(owner.pid))return;
        const line=command(owner.pid),script=role==='swarm'?join(base,'scripts/swarm.ts'):join(base,'packages/router/src/coordinator-cli.ts');
        if(!line?.includes(script)||!line.includes(owner.nonce)||!line.includes(role==='worker'?'--worker':role==='coordinator'?'--run':'--coordinator='))throw Error('bounded live owner command unknown');
        active.add(owner.pid);
    };
    try{
        for(const owner of launched)match(owner,'coordinator');
        const dir=join(base,'.practice/coordinator'),path=join(dir,'owner.json');
        if(!existsSync(path))throw Error('bounded coordinator owner unavailable');
        const owner=read(path);
        if(owner.watchId!==binding.watchId||owner.plan!==binding.plan||owner.side!==binding.side)throw Error('bounded coordinator owner crossed');
        match(owner,'coordinator');
        if(owner.successor)match(owner.successor,'coordinator');
        const swarmPath=join(dir,'swarm-owner.json');
        let retiredSwarm=false;
        if(existsSync(swarmPath)){
            const swarm=read(swarmPath);
            if(swarm.watchId!==binding.watchId||swarm.plan!==binding.plan||swarm.side!==binding.side){
                if(!Number.isSafeInteger(swarm.pid)||swarm.pid<1||typeof swarm.nonce!=='string'||!swarm.nonce)throw Error('bounded swarm owner unknown');
                const members=(deps.groups??boundedGroupMembers)([swarm.pid]);
                if(alive(swarm.pid)||members===null||members.length)throw Error('bounded swarm owner crossed');
                retiredSwarm=true;
            }else match(swarm,'swarm');
        }
        const state=read(join(dir,'state.json'));
        if(state.planner)throw Error('bounded planner owner unexpected');
        for(const task of state.tasks.filter((t:any)=>t.status==='running')){
            const child=read(join(dir,'runs',task.runId,'owner.json'));
            if(task.pid&&child.pid!==task.pid||child.runId!==task.runId)throw Error('bounded child owner crossed');
            match({pid:child.pid,nonce:task.runId},'worker');
        }
        const runsPath=join(base,'.practice/swarm-runs.json');
        if(existsSync(runsPath))for(const run of read(runsPath)){
            if(!Number.isSafeInteger(run.pid)||run.pid<1)throw Error('bounded supervisor identity unreadable');
            if(retiredSwarm){const members=(deps.groups??boundedGroupMembers)([run.pid]);if(alive(run.pid)||members===null||members.length)throw Error('prior swarm supervisor ownership unresolved');}
            groups.add(run.pid);if(alive(run.pid))active.add(run.pid);
        }
        const members=(deps.groups??boundedGroupMembers)([...groups]);
        if(members===null)throw Error('bounded child group observation unavailable');
        for(const pid of members)active.add(pid);
        if(!active.size&&['build-lock.json','../swarm-repair.json.lease'].some(file=>existsSync(join(dir,file))))throw Error('bounded authority fence remains unresolved');
        for(const [file,raw] of observed)if(readFileSync(file,'utf8')!==raw)throw Error('bounded owners changed during observation');
        return {known:true,settled:active.size===0,active:[...active],coordinator:owner.pid,reason:null};
    }catch(error){return {known:false,settled:false,active:[...active],coordinator:null,reason:String(error)};}
}
