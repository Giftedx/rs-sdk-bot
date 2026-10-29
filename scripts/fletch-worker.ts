// Collect one owned 25-log load, then cut and bank375 shafts. Each child closes its client before the next opens.
import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
type Run={exit:number;output:string};
export async function runFletchingCycle(d:{run:(script:string,env:Record<string,string>)=>Promise<Run>;stopped:()=>boolean;minimumHP:number}){
    const failure=(stage:string,detail:string)=>({ok:false,stage:/^RESULT fail (?:session ended:|login(?::| ))/.test(detail)?'disconnected':stage,logsBanked:0,shaftsBanked:0,detail});
    if(!Number.isSafeInteger(d.minimumHP)||d.minimumHP<10)return failure('prerequisite','known HP maximum required');
    if(d.stopped())return failure('stopped','stop file');
    const last=(r:Run)=>r.output.split(/\r?\n/).filter(l=>l.startsWith('RESULT ')).pop()??'no RESULT';
    const collect=await d.run('scripts/gather-yews.ts',{REGION:'draynor',TREE:'normal',MAX_TRIPS:'1',BANK_AT:'25',CAP:'1800',MAX_MAKE:'25'});
    const summary=last(collect),banked=Number(summary.match(/\bbanked=(\d+)/)?.[1]),hp=Number(summary.match(/\bhpMin=(\d+)/)?.[1]);
    if(collect.exit!==0||!/^RESULT ok\b/.test(summary)||!summary.includes('died=false')||banked!==25||!(hp>=d.minimumHP))
        return failure('gather',summary);
    if(d.stopped())return{...failure('stopped','stop file'),logsBanked:25};
    const craft=await d.run('scripts/fletch-arrows.ts',{MODE:'shafts',MAX_MAKE:'25',LOG_RESERVE:'0',BANK_KNIFE:'1',CAP:'600'});
    let report:any;try{report=JSON.parse(craft.output.match(/^SHAFT_BANK (.+)$/m)?.[1]??'null');}catch{}
    if(craft.exit!==0||!/^RESULT ok\b/.test(last(craft))||report?.ok!==true||report.logsUsed!==25||report.made!==375||report.banked!==375||report.preserved!==true||report.died!==false||report.damaged!==false||report.targetMet!==true||report.knifeStored!==true||!(report.hpMin>=d.minimumHP))
        return{...failure('shafts',last(craft)),logsBanked:25};
    return{ok:true,stage:'done',logsBanked:25,shaftsBanked:375,detail:'died=false'};
}

if(import.meta.main){
    const actor=process.argv[2]!;
    if(!/^[A-Za-z0-9_ -]{1,12}$/.test(actor??''))throw Error('invalid fletching account');
    const root=resolve(import.meta.dir,'..'),stopped=()=>existsSync(join(root,`.practice/stop-${actor}`));
    try{
        const status=JSON.parse(readFileSync(join(root,`.practice/status/${actor}.json`),'utf8'));
        const result=await runFletchingCycle({minimumHP:status.hp?.max,stopped,run:async(script,env)=>{
            const p=Bun.spawn(['bun',script,actor],{cwd:root,env:{...process.env,...env},stdout:'pipe',stderr:'pipe',windowsHide:true});
            let output='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;p.kill();},script.includes('gather')?800000:280000);
            const pump=async(stream:ReadableStream<Uint8Array>,error=false)=>{for await(const b of stream){const text=new TextDecoder().decode(b);if(!error)output+=text;(error?process.stderr:process.stdout).write(text);}};
            await Promise.all([pump(p.stdout),pump(p.stderr,true)]);const exit=await p.exited;clearTimeout(timer);
            return{exit:timedOut?1:exit,output:output+(timedOut?'\nRESULT fail no fletching progress: child deadline':'')};
        }});
        console.log(`RESULT ${result.ok?'ok':result.stage==='stopped'?'fail stop file':result.stage==='disconnected'?'fail session ended:':'fail no fletching progress:'} cycle ${JSON.stringify(result)}`);
        process.exitCode=result.ok?0:1;
    }catch(e){console.log('RESULT fail no fletching progress: cycle '+String(e));process.exitCode=1;}
}
