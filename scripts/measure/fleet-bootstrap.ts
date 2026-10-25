// Operator-run LOCAL staged hand-ins only. Reuses the running stack; never starts/stops it.
// REUSE_STACK=1 bun scripts/measure/fleet-bootstrap.ts doric|sheep
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {freemem} from 'node:os';
import {createHash} from 'node:crypto';
import {xpForLevel,levelForXp} from '../../packages/planner/src/curve';
import {applyPreset,type SaveConfig} from '../../packages/practice/src/presets';
import {createBot} from '../../packages/practice/src/bots';
import {proveInProcess,realInProcessDeps} from '../../packages/practice/src/prove';
import {readPracticeSave,setPracticeSkills} from './fleet-player-save';

type Kind='doric'|'sheep';
const root=resolve(import.meta.dir,'../..'),dir=resolve(root,'.practice/fleet-proof');
const plans={
    doric:{position:{x:2951,z:3450,level:0},inputs:{434:6,436:4,440:2},skill:14,xp:32500,level:49,varp:31,done:100,coins:180},
    sheep:{position:{x:3190,z:3272,level:0},inputs:{1759:20},skill:12,xp:3750,level:22,varp:179,done:22,coins:60},
} as const;
const fresh=Array.from({length:21},(_,i)=>({level:i===3?10:1,xp:i===3?xpForLevel(10):0}));
const kit=[{id:946,count:1},{id:333,count:1},{id:333,count:1},{id:995,count:200}];
const totals=(items:readonly {id:number;count:number}[])=>Object.fromEntries([...new Set(items.map(i=>i.id))].map(id=>[id,items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0)]));
export function bootstrapFixture(kind:Kind):SaveConfig{
    const p=plans[kind];return {position:p.position,skills:{Hitpoints:10},varps:{[p.varp]:0,101:0},
        inventory:[...kit,...Object.entries(p.inputs).flatMap(([id,n])=>Array.from({length:n},()=>({id:Number(id),count:1})))],bank:[],equipment:[]};
}
export function bootstrapReady(kind:Kind,st:any,vars:any):boolean{
    const p=plans[kind],expected=totals(bootstrapFixture(kind).inventory!);
    return !!st?.inGame&&st.skills?.length===21&&fresh.every((e,i)=>st.skills[i]?.level===e.level&&st.skills[i]?.baseLevel===e.level&&st.skills[i]?.experience===e.xp)
        &&st.player?.worldX===p.position.x&&st.player?.worldZ===p.position.z&&st.player?.level===0
        &&JSON.stringify(Object.entries(totals(st.inventory??[])).sort())===JSON.stringify(Object.entries(expected).sort())
        &&!(st.equipment??[]).length&&(vars[p.varp]??0)===0&&(vars[101]??0)===0;
}
export function bootstrapFinal(kind:Kind,initial:any,final:ReturnType<typeof readPracticeSave>,stdout:string){
    const p=plans[kind],inventory=totals(final.inventories[93]??[]),expected=totals(kit);
    expected[995]!+=p.coins;
    const items=JSON.stringify(Object.entries(inventory).sort())===JSON.stringify(Object.entries(expected).sort())
        &&!(final.inventories[95]??[]).length&&!(final.inventories[94]??[]).length;
    const xp=final.skills[p.skill]?.xp===p.xp&&final.skills[p.skill]?.level===p.level&&levelForXp(p.xp)===p.level;
    const otherSkills=final.skills.every((s,i)=>i===p.skill||s.xp===fresh[i]!.xp&&s.level===fresh[i]!.level);
    const quest=(final.vars[p.varp]??0)===p.done&&(final.vars[101]??0)===1;
    const life=!!initial?.ready&&/PROOF_BOOTSTRAP_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(stdout)&&/LOGOUT logged-out/.test(stdout)
        &&final.position.level===0&&Math.max(Math.abs(final.position.x-p.position.x),Math.abs(final.position.z-p.position.z))<=3;
    return {ok:items&&xp&&otherSkills&&quest&&life&&/^RESULT ok\b/m.test(stdout),items,xp,otherSkills,quest,life,
        level:p.level,rewardXp:p.xp,rewardCoins:p.coins,inputs:p.inputs,inventory};
}
export async function waitBootstrapSave(kind:Kind,initial:any,stdout:string,read:()=>ReturnType<typeof readPracticeSave>,
    options:{timeoutMs?:number;now?:()=>number;pause?:(ms:number)=>Promise<unknown>}={}){
    const now=options.now??Date.now,pause=options.pause??Bun.sleep,deadline=now()+(options.timeoutMs??6000);
    let first:ReturnType<typeof readPracticeSave>|undefined,last:ReturnType<typeof readPracticeSave>|undefined,attempts=0,lastError='';
    while(true){
        attempts++;
        try{last=read();first??=last;const gate=bootstrapFinal(kind,initial,last,stdout);
            if(gate.ok||now()>=deadline||!initial?.ready||!/^RESULT ok\b/m.test(stdout))return {final:last,first,gate,attempts,lastError};
        }catch(e){lastError=String(e);if(now()>=deadline)throw new Error(`bootstrap save publication failed after${attempts} reads: ${lastError}`);}
        await pause(Math.min(250,Math.max(1,deadline-now())));
    }
}

// The same file can preload the existing quest script. Read native client varps
// and exact published skills/inventory before permitting its first game action.
if(process.env.BOOTSTRAP_OBSERVE){
    const kind=process.env.BOOTSTRAP_OBSERVE as Kind;if(!plans[kind])throw new Error('bad bootstrap kind');
    const vendor=(path:string)=>resolve(root,'vendor/rs-sdk',path);
    await import(vendor('server/webclient/src/lite/dom-shim.ts'));
    const {LiteClient}=await import(vendor('server/webclient/src/lite/LiteClient.ts'));
    const collect=LiteClient.prototype.collectBotState,execute=LiteClient.prototype.executeBotAction;
    let ready=false,life:number|undefined,respawns=0,died=false,hpMin=Infinity,finalHp=0;
    LiteClient.prototype.collectBotState=function(this:any,tick:number){
        const st=collect.call(this,tick),hp=st.skills?.[3]?.level??0;
        if(st.inGame&&hp>0&&st.inventory.length){
            if(!ready){
                if(!bootstrapReady(kind,st,this.var))throw new Error('bootstrap exact runtime fixture mismatch BEFORE input');
                ready=true;life=st.player.lifeId;respawns=st.player.respawnCount??0;
                const proof={ready,position:st.player,skills:st.skills,inventory:st.inventory,vars:{quest:this.var[plans[kind].varp],qp:this.var[101]}};
                writeFileSync(process.env.BOOTSTRAP_PREFIX+'-initial-runtime.json',JSON.stringify(proof,null,2));
                console.log('PROOF_BOOTSTRAP_READY '+JSON.stringify({ready,kind,position:plans[kind].position,skills:st.skills.map((s:any)=>[s.name,s.level,s.experience]),inventory:totals(st.inventory)}));
            }
            hpMin=Math.min(hpMin,hp);finalHp=hp;
            if(st.player.isDead||st.player.lifeId!==life||(st.player.respawnCount??0)>respawns)died=true;
        }
        return st;
    };
    LiteClient.prototype.executeBotAction=function(this:any,action:any){if(!ready)throw new Error('bootstrap state not ready BEFORE input');return execute.call(this,action);};
    process.on('exit',()=>console.log(`PROOF_BOOTSTRAP_SURVIVAL started=${ready} died=${died} hpMin=${hpMin} finalHp=${finalHp}`));
}

if(import.meta.main){
    const kind=process.argv[2] as Kind;if(!plans[kind]||process.env.REUSE_STACK!=='1')throw new Error('operator must reuse existing LOCAL stack: REUSE_STACK=1 ... doric|sheep');
    mkdirSync(dir,{recursive:true});const script=resolve(root,`scripts/generated/quest-${kind}.ts`);
    const hashes=Object.fromEntries([script,resolve(root,'scripts/generated/quest-lib.ts'),import.meta.path].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    const savePaths=new Map<string,string>();
    const report=await proveInProcess({bot:'flboot'+kind,script,runs:1,timeoutMs:60000,pass:t=>/PROOF_BOOTSTRAP_GATE.*"ok":true/.test(t)},{
        ...realInProcessDeps,
        async prepare(bot){
            const freeGB=freemem()/2**30;let active=0;
            for(const f of readdirSync(resolve(root,'.practice/status')))try{const s=JSON.parse(readFileSync(resolve(root,'.practice/status',f),'utf8'));if(/^localhost/.test(s.server)&&!s.result&&Date.now()-s.at>=0&&Date.now()-s.at<30000)active++;}catch{}
            if(freeGB<10||active>=2)throw new Error(`bootstrap admission freeGB=${freeGB} practiceActive=${active}; needs>=10GiB and<2`);
            console.log(`PROOF_RESOURCE bootstrap=${kind} freeGB=${freeGB.toFixed(2)} practiceActive=${active}`);
            await createBot(bot);const path=await applyPreset(bot,bootstrapFixture(kind));setPracticeSkills(path,fresh);savePaths.set(bot,path);
            const checked=readPracticeSave(path);if(!checked.skills.every((s,i)=>s.level===fresh[i]!.level&&s.xp===fresh[i]!.xp)||(checked.vars[plans[kind].varp]??0)!==0||(checked.vars[101]??0)!==0)throw new Error('bootstrap initial save mismatch');
            writeFileSync(resolve(dir,`bootstrap-${kind}-${bot}-initial-save.json`),JSON.stringify(checked,null,2));
        },
        async run(script,bot,timeout){
            const prefix=resolve(dir,`bootstrap-${kind}-${bot}`);
            const proc=Bun.spawn(['bun','--preload',import.meta.path,script,bot],{cwd:root,stdout:'pipe',stderr:'pipe',env:{...process.env,DEMO_OK:'',BOOTSTRAP_OBSERVE:kind,BOOTSTRAP_PREFIX:prefix}});
            const timer=setTimeout(()=>proc.kill(),timeout);
            const [out,err]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text()]);const exitCode=await proc.exited;clearTimeout(timer);
            let stdout=out+err;writeFileSync(prefix+'.log',stdout);
            try{const initial=JSON.parse(readFileSync(prefix+'-initial-runtime.json','utf8'));
                const publication=await waitBootstrapSave(kind,initial,stdout,()=>readPracticeSave(savePaths.get(bot)!));
                const {gate,final}=publication;
                writeFileSync(prefix+'-first-final-save.json',JSON.stringify(publication.first,null,2));
                writeFileSync(prefix+'-snapshot.json',JSON.stringify({gate,initial,final,saveReads:publication.attempts,lastReadError:publication.lastError,hashes},null,2));
                stdout+='\nPROOF_BOOTSTRAP_GATE '+JSON.stringify(gate)+'\n';console.log(`PROOF_BOOTSTRAP ${bot} `+JSON.stringify(gate));
            }catch(e){stdout+='\nPROOF_BOOTSTRAP_GATE '+JSON.stringify({ok:false,error:String(e)});}
            writeFileSync(prefix+'.log',stdout);return {stdout,exitCode};
        },
    });
    writeFileSync(resolve(dir,`bootstrap-${kind}-report.json`),JSON.stringify({...report,hashes,qualification:'fresh staged NPC hand-in; entry and owned live supply excluded'},null,2));
    console.log(JSON.stringify(report));process.exitCode=report.passes===1?0:1;
}
