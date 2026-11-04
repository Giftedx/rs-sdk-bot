import {readFileSync,writeFileSync,copyFileSync,existsSync,readdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {freemem} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {startStack,PROOF_TICK_MS,type StackOptions} from './stack';
import {canBind} from './ports';
import {rsSdkRoot,practiceDir} from './paths';
import {killTree} from './proc';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {workerSourceRevision} from '../../core/src/worker-release';
import { FREE_FLOOR_GB, PRACTICE_RESERVE_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';

// Promoted from .practice/ammo-assembly/installed-native.ts. Exercise the actual
// parameterized workers, then inspect saved state in a separate consumer stage.
type Save=ReturnType<typeof readPracticeSave>;
type Run={code:number;log:string};
const qty=(s:Save,id:number,container=95)=>(s.inventories[container]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function ammoProofEndpoints(ports:{engine:number;gateway:number;management:number;tcp:number},instance:string){
    const values=[ports?.engine,ports?.gateway,ports?.management,ports?.tcp];
    if(!values.every(p=>Number.isSafeInteger(p)&&p>=1024&&p<=65535&&![8888,7780,8898,43594].includes(p))
        ||new Set(values).size!==4||!/^ammo-[a-z0-9-]{1,25}$/.test(instance))throw Error('owned practice endpoints required');
    const server=`127.0.0.1:${ports.engine}`,gateway=`ws://127.0.0.1:${ports.gateway}`;
    return{ports:{...ports},instance,server,gateway,env:{AGENT_PORT:String(ports.gateway),GATEWAY_URL:`http://127.0.0.1:${ports.gateway}`,
        WEB_MANAGEMENT_PORT:String(ports.management),NODE_PORT:String(ports.tcp),GE_DATABASE:`data/market-${instance}.sqlite`}};
}
type ProofEndpoints=ReturnType<typeof ammoProofEndpoints>;
export function selectAmmoProofEndpoints(bind:typeof canBind=canBind,random:()=>number=Math.random){
    for(let i=0;i<100;i++){
        const engine=20000+Math.floor(random()*20000),ports={engine,gateway:engine+1,management:engine+2,tcp:engine+3};
        if(Object.values(ports).every(bind))return ammoProofEndpoints(ports,'ammo-'+randomUUID().replaceAll('-','').slice(0,20));
    }
    throw Error('owned practice ports unavailable');
}
export function ammoProofAccountEnv(text:string,p:ProofEndpoints){
    if(!/^SERVER=localhost:8888\r?$/m.test(text)||!/^GATEWAY_URL=ws:\/\/localhost:7780\r?$/m.test(text))throw Error('new practice account required');
    return text.replace(/^SERVER=.*$/gm,`SERVER=${p.server}`).replace(/^GATEWAY_URL=.*$/gm,`GATEWAY_URL=${p.gateway}`);
}
export async function startAmmoProofStack(p:ProofEndpoints,start:(opts:StackOptions)=>ReturnType<typeof startStack>=startStack){
    const previous=Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]));
    try{Object.assign(process.env,p.env);return await start({ports:p.ports,instance:p.instance,tickMs:PROOF_TICK_MS,xpRate:25,readyTimeoutMs:60000});}
    finally{for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
export function ammoChildConfiguration(args:string[],env:Record<string,string>,p:ProofEndpoints,inherited:NodeJS.ProcessEnv=process.env){
    return{cmd:['bun',...args],cwd:resolve(import.meta.dir,'../../..'),windowsHide:true,
        env:{...inherited,...env,...p.env,GATEWAY_URL:p.gateway,DEMO_OK:'',RANDOM_EVENTS:'0'}};
}
// The shared registration CLI admits only default ports. Keep its session owner
// and tick wait, with the exact generated profile bound to this proof's endpoints.
export function ammoRegistrationArgs(name:string,p:ProofEndpoints){
    if(!/^[a-z0-9]{1,12}$/i.test(name))throw Error('invalid practice name');
    return['--eval',`import {readFileSync} from 'node:fs';
import {openBot,finish} from './packages/core/src/bot';
import {waitTicks} from './packages/core/src/ticks';
const lines=readFileSync(${JSON.stringify(join(rsSdkRoot(),'bots',name,'bot.env'))},'utf8').split(/\\r?\\n/);
if(!lines.includes(${JSON.stringify('SERVER='+p.server)})||!lines.includes(${JSON.stringify('GATEWAY_URL='+p.gateway)}))throw Error('owned practice account required');
const session=await openBot(${JSON.stringify(name)});await waitTicks(session,3);await finish([session],true,'practice ownership registered');`];
}
export function headlessOrderChecks(before:Save,final:Save,refused:Save,production:Run,refusal:Run){
    const totals=(s:Save)=>{const m=new Map<number,number>();for(const c of [93,94,95])for(const i of s.inventories[c]??[])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
    const a=totals(before),b=totals(final),r=totals(refused),changes=new Map([[1511,-14],[52,75],[314,-135],[53,135]]);
    return {
        entry:qty(before,1511)===15&&qty(before,52)===35&&qty(before,314)===5705&&qty(before,53)===300&&qty(before,946)===1,
        headless:production.code===0&&production.log.includes('HANDOFF_RESULT {"ok":true')&&qty(final,53)===435&&qty(final,52)===110&&qty(final,314)===5570&&qty(final,1511)===1&&qty(final,946)===1,
        assets:[...new Set([...a.keys(),...b.keys()])].every(id=>(b.get(id)??0)===(a.get(id)??0)+(changes.get(id)??0)),
        headlessXp:final.skills[9]!.xp>before.skills[9]!.xp,
        refusal:refusal.code!==0&&refusal.log.includes('missing owned inputs')&&!refusal.log.includes('SHAFT_BANK ')&&[...new Set([...b.keys(),...r.keys()])].every(id=>b.get(id)===r.get(id))&&refused.skills[9]!.xp===final.skills[9]!.xp,
        headlessHealthy:final.skills[3]!.level===before.skills[3]!.level&&refused.skills[3]!.level===before.skills[3]!.level,
        headlessPosition:[before,final,refused].every(s=>s.position.level===0&&Math.max(Math.abs(s.position.x-3185),Math.abs(s.position.z-3436))<=8),
        headlessLogout:production.log.includes('LOGOUT logged-out')&&refusal.log.includes('LOGOUT logged-out'),
    };
}
export function ammoOrderChecks(p:{before:Save[];donor:Save;received:Save;final:Save;receipt:any;transfer:Run;craft:Run;repeat:Run}){
    const {before,donor,received,final,receipt,transfer,craft,repeat}=p;
    return{
        transfer:transfer.code===0&&transfer.log.includes('HANDOFF_RESULT {"ok":true'),
        receipt:receipt?.state==='settled'&&receipt.expected?.length===1&&receipt.expected[0].id===40&&receipt.expected[0].count===90,
        bank:qty(before[0]!,40)===90&&qty(donor,40)===0&&qty(received,40)===90&&qty(donor,39)===16,
        craft:craft.code===0&&qty(before[1]!,884)===0&&qty(final,884)===90&&qty(final,53)===300&&qty(final,40)===0,
        xp:final.skills[9]!.xp>before[1]!.skills[9]!.xp,
        restart:repeat.code!==0&&repeat.log.includes('already settled')&&!repeat.log.includes('START ')&&!repeat.log.includes('donor started'),
        // A validated binary save can omit an empty equipment container. The
        // loaded engine may later serialize it as []. Compare the same items/slots.
        pack:[93,94].every(c=>JSON.stringify(donor.inventories[c]??[])===JSON.stringify(before[0]!.inventories[c]??[])&&JSON.stringify(final.inventories[c]??[])===JSON.stringify(before[1]!.inventories[c]??[])),
        healthy:donor.skills[3]!.level===before[0]!.skills[3]!.level&&final.skills[3]!.level===before[1]!.skills[3]!.level,
        logout:(transfer.log.match(/LOGOUT logged-out/g)??[]).length>=2&&craft.log.includes('LOGOUT logged-out'),
    };
}

function verify(directory:string){
    const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
    const log=(label:string)=>readFileSync(join(directory,label+'.log'),'utf8')+readFileSync(join(directory,label+'.err'),'utf8');
    const checks={...ammoOrderChecks({before:[0,1].map(i=>readPracticeSave(join(directory,`before-${i}.sav`))),donor:readPracticeSave(join(directory,'donor.sav')),received:readPracticeSave(join(directory,'received.sav')),final:readPracticeSave(join(directory,'final.sav')),receipt:JSON.parse(readFileSync(join(directory,'receipt.json'),'utf8')),transfer:{code:meta.transferCode,log:log('transfer')},craft:{code:meta.craftCode,log:log('craft')},repeat:{code:meta.repeatCode,log:log('repeat')}}),
        ...headlessOrderChecks(readPracticeSave(join(directory,'headless-before.sav')),readPracticeSave(join(directory,'headless-final.sav')),readPracticeSave(join(directory,'headless-refused.sav')),{code:meta.headlessCode,log:log('headless')},{code:meta.refusalCode,log:log('headless-refusal')}),
        source:meta.source===workerSourceRevision(),fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000};
    const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,source:meta.source,scope:'Native150ms/25x: exact owned tips -> banked iron arrows; owned logs and feathers ->135 new banked headless arrows; no live or Ranged-route claim'};
    writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}

async function run(directory:string){
    if(!existsSync(join(practiceDir(),'delivery-native.lock')))throw Error('practice turn required: run through delivery');
    if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error(`practice needs ${FREE_FLOOR_GB}GiB floor plus ${PRACTICE_RESERVE_GB}GiB startup reserve`);
    const requests=join(practiceDir(),'withdraw');
    if(existsSync(requests)&&readdirSync(requests).some(p=>p.endsWith('.json')))throw Error('supply requests pending; preserve their owner');
    const endpoints=selectAmmoProofEndpoints();
    const lock=join(practiceDir(),'delivery-practice.lock'),fd=openSync(lock,'wx');
    writeFileSync(fd,JSON.stringify({pid:process.pid,task:'ammo-order',directory,at:Date.now()}));
    let stack:Awaited<ReturnType<typeof startStack>>|undefined;
    const command=async(args:string[],env:Record<string,string>,label:string):Promise<Run>=>{
        const out=join(directory,label+'.log'),err=join(directory,label+'.err');
        const child=Bun.spawn({...ammoChildConfiguration(args,env,endpoints),windowsHide:true,stdout:Bun.file(out),stderr:Bun.file(err)});
        let expired=false;const timer=setTimeout(()=>{expired=true;void killTree(child.pid);},180000);
        const code=await child.exited;clearTimeout(timer);
        return{code:expired?-1:code,log:readFileSync(out,'utf8')+readFileSync(err,'utf8')};
    };
    try{
        const source=workerSourceRevision(),names=[runBotName('itip',1),runBotName('iarr',1)],order='native-'+Date.now(),paths:string[]=[];
        stack=await startAmmoProofStack(endpoints);
        for(const [i,name]of names.entries()){
            if(existsSync(join(rsSdkRoot(),'bots',name)))throw Error('practice name already exists');
            const account=await createBot(name);
            writeFileSync(account.envPath,ammoProofAccountEnv(readFileSync(account.envPath,'utf8'),endpoints));
            paths.push(await applyPreset(name,{position:{x:i?3253:3185,z:i?3421:3436,level:0},skills:{Fletching:i?42:1,Hitpoints:i?15:16},inventory:i?[{id:315,count:1},{id:2309,count:1},{id:1349,count:1},{id:1438,count:1}]:[{id:1265,count:1},{id:2347,count:1}],bank:i?[{id:53,count:390}]:[{id:40,count:90},{id:39,count:16}],equipment:i?[{id:1277,count:1,slot:3},{id:1171,count:1,slot:5}]:[]}));
            const auth=await command(ammoRegistrationArgs(name,endpoints),{},'auth-'+i);
            if(auth.code!==0)throw Error('practice registration failed; see auth logs');
            const ready=await waitPracticeSave(paths[i]!,s=>s.position.x===(i?3253:3185)&&s.position.z===(i?3421:3436)&&s.skills[3]!.level===(i?15:16));
            if(!ready.matched)throw Error('seeded entry state not retained');
            copyFileSync(paths[i]!,join(directory,`before-${i}.sav`));
        }
        const args=['scripts/handoff-inputs.ts',...names,'90:Iron arrowtips','--bank-x=3253','--bank-z=3421','--keep=^(?!Iron arrowtips$).+$','--timeout-ms=150000'];
        const transfer=await command(args,{HANDOFF_ORDER:order,HANDOFF_ITEM_ID:'40'},'transfer');
        const donor=await waitPracticeSave(paths[0]!,s=>qty(s,40)===0),received=await waitPracticeSave(paths[1]!,s=>qty(s,40)===90);
        copyFileSync(paths[0]!,join(directory,'donor.sav'));copyFileSync(paths[1]!,join(directory,'received.sav'));
        const receiptPath=join(practiceDir(),'item-handoffs',order,`${names[0]}-${names[1]}.json`);
        writeFileSync(join(directory,'receipt.json'),existsSync(receiptPath)?readFileSync(receiptPath):'null');
        const craft=transfer.code===0&&donor.matched&&received.matched?await command(['scripts/fletch-arrows.ts',names[1]!,'400','iron'],{MAX_MAKE:'90',TIP_RESERVE:'0',HEADLESS_RESERVE:'200'},'craft'):{code:1,log:''};
        if(craft.log===''){writeFileSync(join(directory,'craft.log'),'');writeFileSync(join(directory,'craft.err'),'producer failed');}
        await waitPracticeSave(paths[1]!,s=>qty(s,884)===90);copyFileSync(paths[1]!,join(directory,'final.sav'));
        const repeat=await command(args,{HANDOFF_ORDER:order,HANDOFF_ITEM_ID:'40'},'repeat');
        const headlessName=runBotName('hord',1);
        if(existsSync(join(rsSdkRoot(),'bots',headlessName)))throw Error('practice name already exists');
        const account=await createBot(headlessName);
        writeFileSync(account.envPath,ammoProofAccountEnv(readFileSync(account.envPath,'utf8'),endpoints));
        const headlessPath=await applyPreset(headlessName,{position:{x:3185,z:3436,level:0},skills:{Fletching:42,Hitpoints:69},inventory:[{id:1277,count:1},{id:1985,count:3},{id:1171,count:1}],equipment:[{id:841,count:1,slot:3},{id:884,count:58,slot:13}],bank:[{id:1511,count:15},{id:52,count:35},{id:314,count:5705},{id:53,count:300},{id:946,count:1},{id:995,count:331135},{id:1521,count:8951},{id:2353,count:95}]});
        const auth=await command(ammoRegistrationArgs(headlessName,endpoints),{},'headless-auth');
        if(auth.code!==0)throw Error('headless registration failed');
        if(!(await waitPracticeSave(headlessPath,s=>qty(s,53)===300&&qty(s,1511)===15)).matched)throw Error('headless entry state not retained');
        copyFileSync(headlessPath,join(directory,'headless-before.sav'));
        const headlessArgs=['scripts/handoff-inputs.ts',headlessName,'--headless-order','135','14'];
        const headless=await command(headlessArgs,{CAP:'1600'},'headless');
        await waitPracticeSave(headlessPath,s=>qty(s,53)===435);copyFileSync(headlessPath,join(directory,'headless-final.sav'));
        const refusal=await command(headlessArgs,{CAP:'1600'},'headless-refusal');
        copyFileSync(headlessPath,join(directory,'headless-refused.sav'));
        writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source,order,names,server:endpoints.server,endpoints:{ports:endpoints.ports,instance:endpoints.instance},transferCode:transfer.code,craftCode:craft.code,repeatCode:repeat.code,headlessCode:headless.code,refusalCode:refusal.code},null,2));
        return verify(directory);
    }finally{
        try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}
    }
}

if(import.meta.main){
    try{
        if(!process.env.DELIVERY_DIR)throw Error('run through bun run deliver ammo-order');
        const directory=resolve(process.env.DELIVERY_DIR);
        process.exitCode=(process.argv[2]==='--verify'?verify(directory):await run(directory)).ok?0:1;
    }catch(error){console.error(String(error));process.exitCode=1;}
}
