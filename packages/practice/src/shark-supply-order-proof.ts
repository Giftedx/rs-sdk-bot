// Harness only. Import/--verify never launch a worker or a service.
import {readFileSync,writeFileSync,copyFileSync,existsSync,mkdirSync,openSync,closeSync,unlinkSync,cpSync,readdirSync,statSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {accountDir,listAttempts,readLogoutProof} from '../../core/src/session-lifecycle';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {analyzeSharkDiagnostic} from './shark-fishing-diagnostic';
import {workerSourceRevision} from '../../core/src/worker-release';
import {readPracticeSave,waitPracticeSave,setPracticeSkills} from '../../../scripts/measure/fleet-player-save';

type Save=ReturnType<typeof readPracticeSave>;
const root=resolve(import.meta.dir,'../../..');
const files=['scripts/shark-supply.ts','scripts/shark-supply.test.ts','scripts/gather-fish.ts','scripts/cook-food.ts','scripts/goldfarm-stable.ts','scripts/goldfarm-stable.test.ts','scripts/goldfarm.ts','scripts/goldfarm.test.ts','scripts/foodcourier.ts','packages/core/src/bank-demand.ts','packages/core/test/bank-demand.test.ts','packages/practice/src/shark-supply-order-proof.ts','packages/practice/test/shark-supply-order-proof.test.ts',
 'packages/core/src/session-lifecycle.ts','packages/core/src/inprocess.ts','packages/core/src/bot.ts','packages/core/src/status.ts',
 'vendor/rs-sdk/server/content/scripts/skill_fishing/scripts/fishing_spots/memberfish.rs2','vendor/rs-sdk/server/content/scripts/skill_fishing/configs/fishing.npc','vendor/rs-sdk/server/content/scripts/skill_fishing/configs/fishing_movement.enum','vendor/rs-sdk/server/content/scripts/skill_cooking/configs/cooking_source/cooking_generic.dbrow','vendor/rs-sdk/server/content/scripts/player/configs/consumption/consume_normal.dbrow','vendor/rs-sdk/server/content/scripts/areas/area_catherby/configs/catherby.inv','vendor/rs-sdk/server/engine/src/engine/World.ts'];
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
export const sharkProofSources=()=>({runtime:workerSourceRevision(),files:Object.fromEntries([...files,
    'vendor/rs-sdk/server/engine/src/engine/entity/Player.ts','vendor/rs-sdk/server/engine/src/engine/entity/PlayerLoading.ts',
    'scripts/measure/fleet-player-save.ts'].map(p=>[p,hash(join(root,p))]))});
const sources=sharkProofSources;

// Proof-only v6 fixture / v9 persisted cross-check from pinned PlayerLoading.load / Player.save.
// Sequential DataView reads and bitwise CRC are independent of readPracticeSave and Bun.hash.
// Do not use this as a runtime save adapter or expand it to unrelated save versions.
export function decodeSharkSave(bytes:Uint8Array):{save:Save;recovery:{id:number;count:number}[];lastLogin:string} {
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),end=bytes.length-4;
    let offset=0;
    const take=(length:number)=>{if(offset+length>end)throw Error('truncated shark save');const at=offset;offset+=length;return at;};
    const u8=()=>view.getUint8(take(1)),u16=()=>view.getUint16(take(2)),i32=()=>view.getInt32(take(4));
    if(bytes.length<140)throw Error('truncated shark save');
    let crc=0xffffffff;
    for(const byte of bytes.subarray(0,end)){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    if(((crc^0xffffffff)>>>0)!==view.getUint32(end))throw Error('shark save CRC mismatch');
    if(u16()!==0x2004)throw Error('invalid shark save magic');
    const version=u16();if(version!==6&&version!==9)throw Error('requires shark fixture v6 or pinned v9 save');
    const position={x:u16(),z:u16(),level:u8()};
    take(7+5+1+2+4); // body, colours, gender, run energy, playtime
    const skills=Array.from({length:21},(_,index)=>{const rawExperience=i32(),level=u8();return {index,rawExperience,xp:Math.trunc(rawExperience/10),level};});
    const vars:Record<number,number>={},varCount=u16();
    for(let i=0;i<varCount;i++){
        if(version===6){vars[i]=i32();continue;}
        const id=u16();let value=0,byte=0,digits=0;
        do{byte=u8();value=value*128+(byte&127);if(++digits>5||value>0xffffffff)throw Error('invalid shark varint');}while(byte&128);
        if(Object.hasOwn(vars,id))throw Error('duplicate shark varp');vars[id]=value;
    }
    const inventories:Save['inventories']={},invCount=u8();
    for(let i=0;i<invCount;i++){
        const type=u16(),size=u16();if(size>2000||Object.hasOwn(inventories,type))throw Error('invalid shark inventory');
        const items:Save['inventories'][number]=[];
        for(let slot=0;slot<size;slot++){const encoded=u16();if(!encoded)continue;const short=u8(),count=short===255?i32():short;if(count<=0)throw Error('invalid shark item count');items.push({slot,id:encoded-1,count});}
        inventories[type]=items;
    }
    const afk=u8();take(afk*4+2+1); // AFK zones, last zone, chat modes
    const lastLogin=view.getBigInt64(take(8)).toString();
    const recovery=version===9?Array.from({length:u16()},()=>({id:u16(),count:i32()})):[];
    if(version===9)take(21*4); // per-skill playtime
    if(offset!==end)throw Error('unexpected shark save tail');
    return {save:{version,position,skills,vars,inventories},recovery,lastLogin};
}
const n=(s:Save,id:number,container?:number)=>(container===undefined?Object.values(s.inventories).flat():s.inventories[container]??[]).filter(i=>i.id===id).reduce((v,i)=>v+i.count,0);
export function sharkResult(log:string){try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('SHARK_ORDER_RESULT ')).at(-1)?.slice('SHARK_ORDER_RESULT '.length)??'null');}catch{return null;}}
export function sharkSaveChecks(before:Save,after:Save,r:any,target:number,success:boolean) {
    const cooked=n(after,385)-n(before,385),raw=n(after,383)-n(before,383),burnt=n(after,387)-n(before,387);
    const cash=n(before,995)-n(after,995),tools=n(after,311)-n(before,311),p=after.position;
    const ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
    const consumed=r?.consumed??{},ordinary=[...ids].filter(id=>![383,385,387,995,311,329,333,379].includes(id));
    const entryFood=[329,333,379].every(id=>Number.isSafeInteger(consumed[id]??0)&&(consumed[id]??0)>=0&&n(before,id)-n(after,id)===(consumed[id]??0));
    return {
        result:!!r&&r.ok===success&&r.target===target&&r.consumer==='high-HP endgame combat staging',
        output:success?cooked===target&&n(after,385,95)-n(before,385,95)===target&&r.banked===target:cooked>=0&&cooked<target,
        fish:Number.isSafeInteger(r?.caught)&&r.caught>=0&&r.caught===raw+cooked+burnt&&r.cooked===cooked&&r.burnt===burnt&&raw>=0&&burnt>=0,
        caught:!success||r.caught>=target&&after.skills[10]!.rawExperience>before.skills[10]!.rawExperience,
        cooking:!success||after.skills[7]!.rawExperience>before.skills[7]!.rawExperience,
        tool:tools===(r?.toolBought??-1)&&[0,1].includes(tools)&&n(after,311)>=1,
        paid:cash===r?.coinsSpent&&Number.isSafeInteger(cash)&&cash>=0&&cash<=200&&n(after,995)>=1000,
        food:entryFood,
        assets:ordinary.every(id=>n(before,id)===n(after,id)),
        equipment:JSON.stringify(before.inventories[94]??[])===JSON.stringify(after.inventories[94]??[]),
        skills:before.skills.every((s,i)=>[3,7,10].includes(i)||s.rawExperience===after.skills[i]?.rawExperience),
        health:after.skills[3]!.level>0&&after.skills[3]!.rawExperience===before.skills[3]!.rawExperience&&r?.died===false&&r.hpMin>0&&r.damage<=12,
        bank:p.level===0&&Math.max(Math.abs(p.x-2809),Math.abs(p.z-3441))<=3&&[383,385,387].every(id=>n(after,id,93)===0),
    };
}
export function sharkChildChecks(code:number,timedOut:boolean,log:string,success:boolean){return {
    exit:!timedOut&&(success?code===0:code!==0),
    logout:(log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*?(logout|session close)/m.test(log),
    result:success?/^RESULT ok /m.test(log):/^RESULT fail /m.test(log),
};}
const cases=['entry','budget','resume','no-stock'] as const;
export const PRACTICE_SERVER='localhost:8888';
// Every file of one retained lifecycle tree, relative path -> sha256.
export function treeHashes(dir:string):Record<string,string>{
    const out:Record<string,string>={};
    const walk=(d:string)=>{for(const n of readdirSync(d).sort()){const p=join(d,n);if(statSync(p).isDirectory())walk(p);else out[relative(dir,p).replace(/\\/g,'/')]=hash(p);}};
    if(existsSync(dir))walk(dir);return out;
}
// Independent lifecycle check for one installed CLI case: the producer's own receipts for this practice identity,
// copied after the child ended. Logout counts only from the exact latest attempt's server end, never the log text.
export function sharkLifecycleChecks(dir:string,name:string,c:any,expectedAttempts:number){
    const root=join(dir,'lifecycle'),proof=readLogoutProof(name,PRACTICE_SERVER,{root});
    let attempts:ReturnType<typeof listAttempts>=[];try{attempts=listAttempts(name,PRACTICE_SERVER,{root});}catch{}
    let status:any=null;try{status=JSON.parse(readFileSync(join(dir,'status.json'),'utf8'));}catch{}
    const latest=attempts.at(-1)?.receipt,events=latest?.events??[],count=(k:string,d?:string)=>events.filter(e=>e.kind===k&&(d===undefined||e.detail===d)).length;
    return {
        lifecycleIdentity:proof.state==='confirmed'&&proof.domain==='practice'&&proof.account===name&&proof.server===PRACTICE_SERVER&&latest?.attemptId===proof.attemptId,
        lifecycleLogout:proof.state==='confirmed'&&count('ended')===1&&count('ended','logged-out')===1&&count('logout')===1&&count('logout','logged-out')===1&&count('ready')===1&&count('connect-failed')===0,
        lifecycleOwner:latest?.owner?.script==='scripts/shark-supply.ts'&&!JSON.stringify(attempts).toLowerCase().includes('password'),
        lifecycleAttempts:attempts.length===expectedAttempts&&attempts.every(a=>!!a.receipt),
        lifecycleStatus:!!status&&status.name===name&&status.server===PRACTICE_SERVER&&!!latest&&status.sessionAttemptId===latest.attemptId,
        lifecycleHash:!!c?.lifecycle&&isDeepStrictEqual(c.lifecycle,treeHashes(root))&&c.status===(existsSync(join(dir,'status.json'))?hash(join(dir,'status.json')):null),
    };
}
export function recomputeSharks(directory:string){
    const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
    const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(sources()),fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,
        configuration:meta.tickMs===150&&meta.xpRate===25,cases:JSON.stringify(meta.cases?.map((c:any)=>c.id))===JSON.stringify(cases)};
    for(const id of cases){
        const dir=join(directory,id),c=meta.cases?.find((c:any)=>c.id===id);
        const before=readPracticeSave(join(dir,'before.sav')),after=readPracticeSave(join(dir,'after.sav')),log=readFileSync(join(dir,'worker.log'),'utf8'),r=sharkResult(log);
        const independentBefore=decodeSharkSave(readFileSync(join(dir,'before.sav'))),independentAfter=decodeSharkSave(readFileSync(join(dir,'after.sav')));
        checks[id+'.semanticDecode']=isDeepStrictEqual(before,independentBefore.save)&&isDeepStrictEqual(after,independentAfter.save);
        checks[id+'.recoveryAssets']=isDeepStrictEqual(independentBefore.recovery,independentAfter.recovery);
        const success=id==='entry'||id==='resume';
        // A stock refusal stays at the entry bank and never obtains a tool.
        const local=id==='no-stock'?{refused:r?.ok===false&&/missing owned travel food/.test(r.failure),assets:[...new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id))].every(i=>n(before,i)===n(after,i)),noCatch:n(after,383)===n(before,383)}
            :sharkSaveChecks(before,after,r,c.target,success);
        for(const [key,value] of Object.entries({...local,...sharkChildChecks(c.code,c.timedOut,log,success),savedLogout:c.persisted===true&&(after.vars[134]??0)>(before.vars[134]??0),beforeHash:c.before===hash(join(dir,'before.sav')),afterHash:c.after===hash(join(dir,'after.sav')),logHash:c.log===hash(join(dir,'worker.log'))}))checks[id+'.'+key]=value;
        if(id==='entry')checks.ordinaryEntry=before.position.x===2618&&before.position.z===3332&&before.position.level===0&&before.skills[3]?.level===43&&n(before,311)===0&&n(before,995)===5408&&n(before,329)===312&&n(before,333)===560&&n(before,383)===0;
        for(const [key,value] of Object.entries(sharkLifecycleChecks(dir,c?.name,c,id==='resume'?2:1)))checks[id+'.'+key]=value;
        if(id==='resume'){
            checks.resumed=hash(join(directory,'budget','after.sav'))===hash(join(dir,'before.sav'));
            // The resumed identity keeps the budget attempt unchanged and adds exactly one newer attempt.
            const prior=meta.cases?.find((x:any)=>x.id==='budget');
            checks.resumeLifecycle=c?.name===prior?.name&&Object.entries(prior?.lifecycle??{}).filter(([p])=>p.includes('/attempts/')).every(([p,h])=>c.lifecycle?.[p]===h);
        }
    }
    const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,binding:{native:hash(join(directory,'native.json'))},scope:'Native installed CLI at150ms/25x only. No live release, speed or unattended claim.',nextConsumer:'25-shark pilot then100-shark orders for high-HP endgame combat staging; cargo recovery remains separate.'};
    return report;
}
// Verification only reads evidence. Compare every stable claim and every predicate,
// including missing/extra keys. The publication time is validated, never refreshed.
export function verifySharks(directory:string){
    const report=recomputeSharks(directory),published=JSON.parse(readFileSync(join(directory,'consumer.json'),'utf8'));
    const {at,...stable}=report;
    const {at:publishedAt,...publishedStable}=published;
    const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
    const publication=Number.isFinite(publishedAt)&&publishedAt>=meta.at&&publishedAt<=at&&isDeepStrictEqual(stable,publishedStable);
    return {...report,ok:report.ok&&publication,publication};
}
async function child(directory:string,name:string,target:number,cap:number){
    const p=Bun.spawn(['bun','scripts/shark-supply.ts',name,String(target),String(cap)],{cwd:root,env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',SHARK_CONSUMER:'high-HP endgame combat staging'},stdout:Bun.file(join(directory,'worker.log')),stderr:Bun.file(join(directory,'worker.err')),windowsHide:true});
    let timedOut=false,termination:Promise<void>|undefined;
    const timer=setTimeout(()=>{timedOut=true;termination=killTree(p.pid);},360000);
    try{return {code:await p.exited,timedOut};}finally{clearTimeout(timer);if(p.exitCode===null)await killTree(p.pid);await termination;}
}
async function run(directory:string){
    if(freemem()/2**30<12)throw Error('insufficient practice startup reserve');
    mkdirSync(directory,{recursive:true});
    if(existsSync(join(directory,'native.json'))||cases.some(id=>existsSync(join(directory,id))))throw Error('shark proof directory already used');
    const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'shark-supply-order'}));
    let stack:Awaited<ReturnType<typeof startStack>>|undefined;
    try{
        const source=sources(),receipts:any[]=[];let resumeName='',resumePath='';
        stack=await startStack({tickMs:150,xpRate:25,readyTimeoutMs:60000});
        for(const [index,id] of cases.entries()){
            const dir=join(directory,id);mkdirSync(dir);let name:string,path:string;
            if(id==='resume'){name=resumeName;path=resumePath;}else{
                name=runBotName('flshark',index+1);const botDir=join(root,'vendor/rs-sdk/bots',name);
                if(existsSync(botDir))throw Error('practice identity already exists');
                if(existsSync(accountDir(name,PRACTICE_SERVER)))throw Error('practice identity already has lifecycle receipts');await createBot(name);
                if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
                const preset:SaveConfig={position:id==='budget'?{x:2809,z:3441,level:0}:{x:2618,z:3332,level:0},skills:{Attack:70,Strength:70,Defence:70,Hitpoints:75,Fishing:99,Cooking:99},
                    inventory:[{id:995,count:5408}],bank:[...(id==='no-stock'?[]:[{id:329,count:312},{id:333,count:560}]),...(id==='budget'?[{id:311,count:1}]:[]),{id:385,count:5},{id:436,count:17}],
                    equipment:[{id:1275,count:1,slot:3}],varps:{4:-1,9:-1,13:-1,16:-1,28:-1,64:-1,181:-1,209:-1,300:1000}};
                path=await applyPreset(name,preset);const saved=readPracticeSave(path);
                setPracticeSkills(path,saved.skills.map((s,i)=>({level:i===3?43:s.level,xp:s.xp})));
                if(id==='budget'){resumeName=name;resumePath=path;}
            }
            copyFileSync(path,join(dir,'before.sav'));const before=readPracticeSave(path),target=id==='entry'?25:3;
            const outcome=await child(dir,name,target,id==='budget'?1:9000);
            const persisted=await waitPracticeSave(path,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:15000});copyFileSync(path,join(dir,'after.sav'));
            // The child's own producer receipts and status, copied once the child has exited. Absent stays absent.
            const life=accountDir(name,PRACTICE_SERVER),statusFile=join(root,'.practice/status',`${name}.json`);
            if(existsSync(life))cpSync(life,accountDir(name,PRACTICE_SERVER,join(dir,'lifecycle')),{recursive:true});
            if(existsSync(statusFile))copyFileSync(statusFile,join(dir,'status.json'));
            receipts.push({id,name,target,...outcome,persisted:persisted.matched,before:hash(join(dir,'before.sav')),after:hash(join(dir,'after.sav')),log:hash(join(dir,'worker.log')),
                lifecycle:treeHashes(join(dir,'lifecycle')),status:existsSync(join(dir,'status.json'))?hash(join(dir,'status.json')):null});
            writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source,tickMs:150,xpRate:25,cases:receipts},null,2));
            if(outcome.timedOut||!persisted.matched)throw Error('shark child logout/save deadline; evidence retained');
        }
        const report=recomputeSharks(directory);
        writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));
        return report;
    }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
// Retained-state fishing diagnostic. Practice-only observation, never delivery: it runs the actual worker CLI
// on a byte-identical copy of the recorded ordinary entry save under a fresh practice identity, with the engine
// observer preloaded. The original save is read only. Exit 0 means fully observed and cleaned up, not fixed.
export const DIAGNOSTIC_INPUT_SHA='4f5bf892e585165d46213367f0c583c248a553c19681fb1194efa82ecf56510e';
const observer=join(root,'packages/practice/src/shark-fishing-diagnostic.ts');
const diagnosticFiles=[...files,'packages/practice/src/stack.ts','packages/practice/src/shark-fishing-diagnostic.ts','vendor/rs-sdk/server/content/scripts/skill_fishing/scripts/fishing.rs2',
 'vendor/rs-sdk/server/content/scripts/skill_fishing/configs/fishing.struct',
 ...['engine/script/handlers/PlayerOps.ts','engine/script/ScriptRunner.ts','engine/entity/Player.ts','engine/entity/PathingEntity.ts','network/game/client/handler/OpNpcHandler.ts'].map(p=>'vendor/rs-sdk/server/engine/src/'+p)];
const diagnosticSources=()=>Object.fromEntries(diagnosticFiles.map(p=>[p,hash(join(root,p))]));
export function ordinaryEntry(s:Save){return s.position.x===2618&&s.position.z===3332&&s.position.level===0&&s.skills[3]?.level===43&&s.skills[10]?.level===99&&s.skills[7]?.level===99
    &&n(s,311)===0&&n(s,995)===5408&&n(s,329)===312&&n(s,333)===560&&n(s,383)===0&&n(s,385)===5;}
// Cleanup and recovery a diagnostic must still prove. Full product reconciliation is reported, not required.
export function diagnosticRecovery(before:Save,after:Save,r:any,outcome:{code:number;timedOut:boolean},log:string,persisted:boolean){
    const save=sharkSaveChecks(before,after,r,25,outcome.code===0),child=sharkChildChecks(outcome.code,outcome.timedOut,log,outcome.code===0);
    const required={result:!!r&&typeof r.ok==='boolean'&&r.target===25,exit:child.exit,logout:child.logout,persisted,equipment:save.equipment,assets:save.assets,skills:save.skills,health:save.health,food:save.food,
        // No raw, cooked or burnt shark left in the pack: the worker banked or reported what it caught.
        pack:[383,385,387].every(id=>n(after,id,93)===0)};
    return {ok:Object.values(required).every(Boolean),required,product:save};
}
async function diagnose(input:string,directory:string){
    const dir=join(directory,'fishing-diagnostic');
    if(existsSync(dir))throw Error('fishing diagnostic directory already used');
    const bytes=readFileSync(input),inputSha=createHash('sha256').update(bytes).digest('hex');
    if(inputSha!==DIAGNOSTIC_INPUT_SHA)throw Error('fishing diagnostic input is not the recorded SJ9QEg entry save');
    const entry=readPracticeSave(input);if(!ordinaryEntry(entry))throw Error('fishing diagnostic input is not the ordinary entry state');
    if(freemem()/2**30<12)throw Error('insufficient practice startup reserve');
    mkdirSync(dir,{recursive:true});
    const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'shark-supply-order',mode:'fishing-diagnostic'}));
    const before={sources:sources(),diagnostic:diagnosticSources()},trace=join(dir,'server-trace.jsonl');
    let stack:Awaited<ReturnType<typeof startStack>>|undefined,name='',path='',outcome={code:-1,timedOut:false},persisted=false;
    try{
        name=runBotName('flsharkdg',1);const botDir=join(root,'vendor/rs-sdk/bots',name);
        if(existsSync(botDir))throw Error('practice identity already exists');await createBot(name);
        if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
        // The generator names the identity's save file; the recorded bytes then replace it unchanged.
        path=await applyPreset(name,{position:{x:2618,z:3332,level:0}});writeFileSync(path,bytes);
        if(hash(path)!==inputSha)throw Error('identity adaptation changed the save bytes');
        copyFileSync(path,join(dir,'before.sav'));
        stack=await startStack({tickMs:150,xpRate:25,readyTimeoutMs:60000,enginePreload:{module:observer,env:{SHARK_FISHING_DIAGNOSTIC_OUT:trace,SHARK_FISHING_DIAGNOSTIC_PLAYER:name}}});
        outcome=await child(dir,name,25,9000);
        persisted=(await waitPracticeSave(path,s=>(s.vars[134]??0)>(entry.vars[134]??0),{timeoutMs:15000})).matched;copyFileSync(path,join(dir,'after.sav'));
    }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
    const log=readFileSync(join(dir,'worker.log'),'utf8'),events=existsSync(trace)?readFileSync(trace,'utf8').split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l)):[];
    const after=readPracticeSave(join(dir,'after.sav')),analysis=analyzeSharkDiagnostic(events,log);
    const recovery=diagnosticRecovery(entry,after,sharkResult(log),outcome,log,persisted);
    const unchanged=JSON.stringify(before)===JSON.stringify({sources:sources(),diagnostic:diagnosticSources()});
    const binding={input:{path:input,sha256:inputSha,crc:'valid',unchanged:hash(input)===inputSha},identity:{name,save:path,copySha256:hash(join(dir,'before.sav'))},
        configuration:{tickMs:150,xpRate:25,target:25,cap:9000,observer:hash(observer)},sources:before,unchanged,
        output:{after:hash(join(dir,'after.sav')),log:hash(join(dir,'worker.log')),trace:existsSync(trace)?hash(trace):null}};
    const report={ok:analysis.complete&&recovery.ok&&unchanged&&binding.input.unchanged&&binding.identity.copySha256===inputSha,at:Date.now(),kind:'fishing-diagnostic',
        scope:'Practice-only retained-state observation at150ms/25x. Not delivery, not native acceptance and not a repair.',binding,outcome,recovery,analysis};
    writeFileSync(join(dir,'diagnostic.json'),JSON.stringify(report,null,2));
    console.log('SHARK_FISHING_DIAGNOSTIC '+JSON.stringify({ok:report.ok,complete:analysis.complete,observed:analysis.observed,effectErrors:analysis.effects.rows.filter(r=>!r.ok),recovery:recovery.required,unchanged,outcome,rolls:analysis.rolls,op3:analysis.op3.outcomes,segments:analysis.segments.slice(-3),report:join(dir,'diagnostic.json')}));
    return report;
}
if(import.meta.main){try{if(!process.env.DELIVERY_DIR)throw Error('run through shark-supply-order harness');const dir=resolve(process.env.DELIVERY_DIR),arg=process.argv[2]??'';
    const report=arg==='--verify'?verifySharks(dir):arg.startsWith('--fishing-diagnostic=')?await diagnose(resolve(arg.slice('--fishing-diagnostic='.length)),dir):await run(dir);
    console.log(JSON.stringify(report));process.exitCode=report.ok?0:1;}catch(e){console.error(String(e));process.exitCode=1;}}
