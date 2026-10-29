import {readFileSync,writeFileSync,copyFileSync,existsSync,readdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {freemem} from 'node:os';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {startStack} from './stack';
import {rsSdkRoot,practiceDir} from './paths';
import {killTree} from './proc';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {workerSourceRevision} from '../../core/src/worker-release';

// Promoted from .practice/ammo-assembly/installed-native.ts. Exercise the actual
// parameterized workers, then inspect saved state in a separate consumer stage.
type Save=ReturnType<typeof readPracticeSave>;
type Run={code:number;log:string};
const qty=(s:Save,id:number,container=95)=>(s.inventories[container]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
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
        source:meta.source===workerSourceRevision(),fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000};
    const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,source:meta.source,scope:'Native150ms/25x: exact owned tips -> Fletching consumer -> banked arrows; no live or Ranged-route claim'};
    writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}

async function run(directory:string){
    if(freemem()/2**30<12)throw Error('practice needs 8GiB floor plus 4GiB startup reserve');
    const requests=join(practiceDir(),'withdraw');
    if(existsSync(requests)&&readdirSync(requests).some(p=>p.endsWith('.json')))throw Error('supply requests pending; preserve their owner');
    const lock=join(practiceDir(),'delivery-practice.lock'),fd=openSync(lock,'wx');
    writeFileSync(fd,JSON.stringify({pid:process.pid,task:'ammo-order',directory,at:Date.now()}));
    let stack:Awaited<ReturnType<typeof startStack>>|undefined;
    const command=async(args:string[],env:Record<string,string>,label:string):Promise<Run>=>{
        const out=join(directory,label+'.log'),err=join(directory,label+'.err');
        const child=Bun.spawn(['bun',...args],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',...env},stdout:Bun.file(out),stderr:Bun.file(err),windowsHide:true});
        let expired=false;const timer=setTimeout(()=>{expired=true;void killTree(child.pid);},180000);
        const code=await child.exited;clearTimeout(timer);
        return{code:expired?-1:code,log:readFileSync(out,'utf8')+readFileSync(err,'utf8')};
    };
    try{
        const source=workerSourceRevision(),names=[runBotName('itip',1),runBotName('iarr',1)],order='native-'+Date.now(),paths:string[]=[];
        stack=await startStack({tickMs:150,readyTimeoutMs:60000});
        for(const [i,name]of names.entries()){
            if(existsSync(join(rsSdkRoot(),'bots',name)))throw Error('practice name already exists');
            await createBot(name);
            if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(rsSdkRoot(),'bots',name,'bot.env'),'utf8')))throw Error('practice only');
            paths.push(await applyPreset(name,{position:{x:i?3253:3185,z:i?3421:3436,level:0},skills:{Fletching:i?42:1,Hitpoints:i?15:16},inventory:i?[{id:315,count:1},{id:2309,count:1},{id:1349,count:1},{id:1438,count:1}]:[{id:1265,count:1},{id:2347,count:1}],bank:i?[{id:53,count:390}]:[{id:40,count:90},{id:39,count:16}],equipment:i?[{id:1277,count:1,slot:3},{id:1171,count:1,slot:5}]:[]}));
            const auth=await command(['packages/practice/src/register-proof-account.ts',name],{},'auth-'+i);
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
        writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source,order,names,transferCode:transfer.code,craftCode:craft.code,repeatCode:repeat.code},null,2));
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
