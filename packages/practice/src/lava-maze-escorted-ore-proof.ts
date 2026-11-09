// Harness only. --verify reads retained files and never starts a service or account.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { freemem } from 'node:os';
import { createBot } from './bots';
import { applyPreset } from './presets';
import { runBotName } from './prove';
import { startStack } from './stack';
import { ironProofAccountEnv, selectIronProofEndpoints, startIronProofStack } from './iron-progress-order-proof';
import { killTree } from './proc';
import { FREE_FLOOR_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';
import { releaseRevision } from '../../core/src/worker-release';
import { readLogoutProof } from '../../core/src/session-lifecycle';
import { readPracticeSave, waitPracticeSave } from '../../../scripts/measure/fleet-player-save';
import { BANK, STAGE, type RosterPlayer } from '../../../scripts/lava-maze-escorted-ore';

const root=resolve(import.meta.dir,'../../..'),entry='scripts/lava-maze-escorted-ore.ts';
const files=[entry,'scripts/lava-maze-escorted-ore.test.ts','scripts/lava-maze-escort-route.json','packages/practice/src/lava-maze-escorted-ore-proof.ts'];
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const source=()=>({runtime:releaseRevision([entry,'packages/practice/src/lava-maze-escorted-ore-proof.ts'],root),files:Object.fromEntries(files.map(p=>[p,hash(join(root,p))]))});
const holds=()=>JSON.stringify(['all','swarm','coordinator'].map(n=>{const p=join(root,'.practice/stop-'+n);return existsSync(p)?readFileSync(p,'utf8'):null;}));
type Save=ReturnType<typeof readPracticeSave>;
const count=(s:Save,id:number,container?:number)=>Object.entries(s.inventories).filter(([k])=>container===undefined||Number(k)===container).flatMap(([,v])=>v).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const atBank=(s:Save)=>s.position.level===0&&s.position.x===BANK[0]&&s.position.z===BANK[1];
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export const filterFixtureRoster=(roster:RosterPlayer[],names:readonly string[])=>{
    const own=new Set(names.map(n=>n.toLowerCase()));
    return roster.filter(p=>own.has(p[1].toLowerCase()));
};
export const hasEscortLogouts=(log:string)=>(log.match(/^LOGOUT .*$/gm)??[]).length===1&&/^LOGOUT logged-out logged-out\r?$/m.test(log);
function assets(b:Save,a:Save,food:number,ore:number) {
    const ids=new Set([...Object.values(b.inventories).flat(),...Object.values(a.inventories).flat()].map(i=>i.id));
    return same(b.inventories[94]??[],a.inventories[94]??[])&&[...ids].every(id=>ore===1&&[1617,1619,1621,1623].includes(id)?
        count(a,id)>=count(b,id):count(a,id)-count(b,id)===(id===385?-food:id===451?ore:0));
}
export function verifyEscortProof(directory:string) {
    const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
    const checks:Record<string,boolean>={source:same(meta.source,source()),loopback:/^127\.0\.0\.1:\d+$/.test(meta.server),
        inputs:meta.seed===289&&meta.preloadHash===hash(join(directory,'native-inputs.ts')),
        cases:same(meta.cases.map((c:any)=>c.id),['success','threat']),holds:meta.holds===holds()};
    for(const c of meta.cases){
        const log=readFileSync(join(directory,c.id+'.log'),'utf8');
        const r=JSON.parse(log.match(/^LAVA_ESCORT_RESULT (.*)$/m)?.[1]??'null');
        const before=c.names.map((_:string,i:number)=>readPracticeSave(join(directory,`${c.id}-before-${i}.sav`)));
        const after=c.names.map((_:string,i:number)=>readPracticeSave(join(directory,`${c.id}-after-${i}.sav`)));
        const success=c.id==='success';
        const frameRows=JSON.parse(readFileSync(join(directory,c.id+'-roster.json'),'utf8')) as {k:number;p:RosterPlayer[]}[];
        const staged=frameRows.filter(f=>f.k<=r?.stage?.tick&&f.p.some(p=>p[1].toLowerCase()===c.names[0].toLowerCase()&&p[2]===STAGE[0]&&p[3]===STAGE[1]&&p[4]===0)&&
            f.p.some(p=>p[1].toLowerCase()===c.names[1].toLowerCase()&&p[2]===BANK[0]&&p[3]===BANK[1]&&p[4]===0)).slice(-3);
        const local={exit:c.code===(success?0:1)&&!c.timedOut&&!c.lowMemory,
            result:success?r?.ok===true&&r.mined===1&&r.banked===1&&r.released===true:
                r?.ok===false&&r.mined===0&&r.banked===0&&r.released===false&&/Full corridor threat/.test(r.failure??''),
            entry:before.every((s:Save)=>s.position.level===0&&Math.max(Math.abs(s.position.x-BANK[0]),Math.abs(s.position.z-BANK[1]))<=3)&&before[0].skills[3].level===69&&before[1].skills[3].level===33&&before.every((s:Save)=>count(s,385,93)>=4)&&count(before[1],1275,93)===1&&count(before[1],451,93)===0&&count(before[1],451,95)===57,
            bank:after.every(atBank)&&count(after[1],451,95)===57+(success?1:0)&&count(after[1],451,93)===0&&count(after[0],451)===count(before[0],451),
            assets:before.every((b:Save,i:number)=>Number.isSafeInteger(r?.actors?.[i]?.foodUsed)&&r.actors[i].foodUsed>=0&&assets(b,after[i],r.actors[i].foodUsed,i===1&&success?1:0)),
            xp:after[1].skills[14].rawExperience-before[1].skills[14].rawExperience===(success?1250*25:0)&&before[0].skills.every((s:any,i:number)=>s.rawExperience===after[0].skills[i].rawExperience)&&before[1].skills.every((s:any,i:number)=>i===14||s.rawExperience===after[1].skills[i].rawExperience),
            alive:after.every((s:Save)=>s.skills[3]!.level>0)&&r?.actors?.every((a:any)=>a.hpMin>0&&a.hpEnd>0&&a.wallMs>0&&a.ticks>0),
            protected:!success||r?.stage?.prayer>=10&&r?.actors?.[0]?.prayerEnd>=10&&r?.stage?.frames===3,
            stageFrames:!success||staged.length===3&&staged[0]!.k+10===staged[1]!.k&&staged[1]!.k+10===staged[2]!.k&&staged[2]!.k===r.stage.tick,
            rocks:!success||r?.rocks?.length>=1&&r.rocks.every((l:any)=>[2106,2107].includes(l.id)&&((l.x===3059&&l.z===3885)||(l.x===3060&&l.z===3884))),
            refusal:success||frameRows.some(f=>f.p.some(p=>p[1]==='FixtureEnemy'&&p[5]===100))&&after.every((s:Save,i:number)=>same(s.position,before[i].position)),
            logout:r?.logout===true&&hasEscortLogouts(log)&&c.logouts.length===2&&c.logouts.every((p:any,i:number)=>p.state==='confirmed'&&p.account===c.names[i]&&p.server===meta.server)&&!/^WARN .*logout/m.test(log),
            saved:c.publications.length===2&&c.publications.every((p:any,i:number)=>p.matched&&readFileSync(join(directory,`${c.id}-after-${i}.sav`)).readInt32BE(24)===p.expectedTicks&&(after[i].vars[134]??0)>(before[i].vars[134]??0)),
            bytes:c.hashes.every((f:any)=>hash(join(directory,f.file))===f.sha256)};
        for(const [key,value] of Object.entries(local))checks[c.id+':'+key]=Boolean(value);
    }
    const report={ok:Object.values(checks).every(Boolean),checks,scope:'Same CLI on two ordinary loopback fixtures. One counted ore banked, threat refusal and saved logouts. No live ranking claim.'};
    writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));return report;
}

// Native roster timing and positions come from the isolated engine. Only foreign roster inputs are deterministic.
function fixtureRoster(server:string,names:string[],threat:boolean,frames:unknown[]) {
    const peers=new Set<any>();
    const upstream=new WebSocket(`ws://${server}/worldfeed`);
    let last:string|undefined;
    const proxy=Bun.serve({hostname:'127.0.0.1',port:0,
        fetch(req,s){if(new URL(req.url).pathname==='/worldfeed'&&s.upgrade(req))return;return new Response('Not found',{status:404});},
        websocket:{open(ws){peers.add(ws);if(last)ws.send(last);},message(){},close(ws){peers.delete(ws);}}});
    upstream.addEventListener('open',()=>upstream.send(JSON.stringify({t:'roster',on:true})));
    upstream.addEventListener('message',({data})=>{
        const f=JSON.parse(String(data));if(f.t!=='roster')return;
        f.p=filterFixtureRoster(f.p,names);
        if(threat)f.p.push([2046,'FixtureEnemy',3060,3883,0,100]);
        frames.push(f);last=JSON.stringify(f);for(const peer of peers)peer.send(last);
    });
    upstream.addEventListener('close',()=>{for(const peer of peers)peer.close();});
    const heartbeat=setInterval(()=>{if(upstream.readyState===WebSocket.OPEN)upstream.send(JSON.stringify({t:'ping'}));},30000);
    return {url:`ws://127.0.0.1:${proxy.port}/worldfeed`,close:()=>{clearInterval(heartbeat);upstream.close();for(const p of peers)p.close();proxy.stop(true);}};
}
async function runProof(directory:string) {
    if(!existsSync(join(root,'.practice/delivery-native.lock')))throw Error('Harness practice turn required');
    if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('HOST_DEFERRED_NATIVE_HEADROOM');
    mkdirSync(directory,{recursive:false});
    const endpoint=selectIronProofEndpoints(),baseline=holds();
    // A seeded native engine keeps rock rolls repeatable. The real mining scripts award the ore and XP.
    const preload=join(directory,'native-inputs.ts');
    writeFileSync(preload,"let seed = 289; Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };\n"+
        `await import(${JSON.stringify(pathToFileURL(join(root,'packages/practice/src/save-endpoint.ts')).href)});\n`);
    const meta={source:source(),server:endpoint.server,holds:baseline,seed:289,preloadHash:hash(preload),cases:[] as any[]};
    const stack=await startIronProofStack(endpoint,opts=>startStack({...opts,enginePreload:{
        module:preload,env:{WORLD_FEED:'true',WORLD_FEED_TOKEN:''}}}));
    try {
        for(const [index,id] of ['success','threat'].entries()){
            if(holds()!==baseline)throw Error('Owner holds changed');
            const names=[runBotName('lva',index*2),runBotName('lva',index*2+1)],saves:string[]=[];
            for(const [i,name] of names.entries()){
                const bot=await createBot(name);writeFileSync(bot.envPath,ironProofAccountEnv(readFileSync(bot.envPath,'utf8'),endpoint));
                const inventory=[...Array.from({length:4},()=>({id:385,count:1})),{id:590,count:1},...(i===1?[{id:1275,count:1}]:[])];
                const save=await applyPreset(name,{position:{x:BANK[0],z:BANK[1]-(id==='success'&&i===1?1:0),level:0},
                    skills:i===0?{Attack:65,Defence:10,Strength:11,Hitpoints:69,Ranged:99,Prayer:65,Magic:50}:
                        {Attack:47,Hitpoints:33,Prayer:43,Mining:99},inventory,
                    equipment:i===0?[{id:861,count:1,slot:3},{id:1131,count:1,slot:4}]:[{id:544,count:1,slot:4},{id:542,count:1,slot:7}],
                    bank:[{id:995,count:12345},{id:451,count:i===1?57:2},{id:385,count:3}]});
                saves.push(save);copyFileSync(save,join(directory,`${id}-before-${i}.sav`));
            }
            const ticks=saves.map(p=>readFileSync(p).readInt32BE(24)),frames:unknown[]=[];
            const proxy=fixtureRoster(endpoint.server,names,id==='threat',frames);
            const c={id,names,code:null as number|null,timedOut:false,lowMemory:false,publications:[] as any[],logouts:[] as any[],hashes:[] as any[]};meta.cases.push(c);
            const log=join(directory,id+'.log');
            try {
                const child=Bun.spawn([process.execPath,entry,...names],{cwd:root,windowsHide:true,stdout:Bun.file(log),stderr:Bun.file(log+'.err'),
                    env:{...process.env,...endpoint.env,GATEWAY_URL:endpoint.gateway,DEMO_OK:'',MAX_ORE:'1',CAP:'1800',EXPECTED_BANK_ORE:'57',RANDOM_EVENTS:'0',STALL_TICKS:'0',
                        LAVA_ESCORT_HOLDS:baseline,LAVA_ESCORT_ROSTER_URL:proxy.url}});
                let termination:Promise<void>|undefined;
                const timer=setTimeout(()=>{c.timedOut=true;termination??=killTree(child.pid);},id==='success'?600000:90000);
                const floor=setInterval(()=>{if(freemem()/2**30<FREE_FLOOR_GB){c.lowMemory=true;termination??=killTree(child.pid);}},1000);
                try{c.code=await child.exited;}finally{clearTimeout(timer);clearInterval(floor);await termination;}
                for(const [i,name] of names.entries()){
                    const status=JSON.parse(readFileSync(join(root,'.practice/status',name+'.json'),'utf8'));
                    const expectedTicks=ticks[i]!+status.tick;
                    const publication=await waitPracticeSave(saves[i]!,s=>readFileSync(saves[i]!).readInt32BE(24)===expectedTicks&&(s.vars[134]??0)>0,{timeoutMs:6000});
                    c.publications.push({expectedTicks,matched:publication.matched});
                    copyFileSync(saves[i]!,join(directory,`${id}-after-${i}.sav`));
                    c.logouts.push(readLogoutProof(name,endpoint.server));
                }
            } finally {
                proxy.close();writeFileSync(join(directory,id+'-roster.json'),JSON.stringify(frames));
                for(const file of [`${id}.log`,`${id}-roster.json`,...names.flatMap((_,i)=>[`${id}-before-${i}.sav`,`${id}-after-${i}.sav`])])
                    if(existsSync(join(directory,file)))c.hashes.push({file,sha256:hash(join(directory,file))});
                writeFileSync(join(directory,'native.json'),JSON.stringify(meta,null,2));
            }
            if(c.code!==(id==='success'?0:1)||c.timedOut||c.lowMemory)break;
        }
    } finally {await stack.stop();}
    return verifyEscortProof(directory);
}
if(import.meta.main){
    const pointer=join(root,'.practice/lava-maze-escorted-ore-latest.json');
    if(process.argv[2]==='--verify'){
        const directory=JSON.parse(readFileSync(pointer,'utf8')).directory;
        process.exitCode=verifyEscortProof(directory).ok?0:1;
    }else{
        const directory=join(root,'.practice','lava-maze-escorted-ore-'+Date.now());
        writeFileSync(pointer,JSON.stringify({directory}));
        process.exitCode=(await runProof(directory)).ok?0:1;
    }
}
