// One private native actor. Exact owned snapshot, actual production relocation function, no engine startup.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {openBot,finish} from '../../packages/core/src/bot';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {runBotName} from '../../packages/practice/src/prove';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from './fleet-player-save';
import {knightRelocationProfile,relocationStart,relocateKnight,relocationAssets,relocationPreserved} from '../relocate-knight';
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();
const productionSha256=hash('scripts/relocate-knight.ts');
if(productionSha256!=='807C5E49787BDFECA4F8DA2FD03A6744E385E6ADEB75405A90378D5C2A902CD1')throw new Error('relocation source freeze changed');
const profile=knightRelocationProfile(process.env.RELOCATION_PROFILE??'Pocketrocket');
if(process.argv[2]==='--child'){
    const s=await openBot(process.argv[3]!);try{const r=await relocateKnight(s,profile.name);console.log('KNIGHT_RELOCATION '+JSON.stringify(r));await finish([s],r.ok,`relocation ok=${r.ok} preserved=${r.preserved} xpPreserved=${r.xpPreserved} hpMin=${r.hpMin} died=${r.died}`);}catch(e){await finish([s],false,String(e));}
}else{
    if(process.env.REUSE_STACK!=='1')throw new Error('operator must supply existing local stack');
    const bytes=readFileSync(process.env.SOURCE_STATUS??`.practice/status/${profile.name}.json`),source=JSON.parse(bytes.toString());
    const p=source.pos,recent=(n:number)=>Number.isFinite(n)&&Date.now()-n>=0&&Date.now()-n<30*60_000;
    if(source.name!==profile.name||source.server!=='rs-sdk-demo.fly.dev'||!source.result?.startsWith('ok ')||!recent(source.at)||!recent(source.bankAt)
        ||!Array.isArray(source.equipment)||source.skills?.length!==21||source.hp.now!==source.hp.max||!relocationStart(p?{worldX:p.x,worldZ:p.z,level:p.level}:null,profile))throw new Error('requires fresh completed actual profile bank snapshot, full HP and known equipment');
    const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB']).stdout.toString().trim());if(!Number.isFinite(free)||free<9)throw new Error(`one native actor requires9GiB; actual${free}`);
    const actor=runBotName('flknig',1),dir=resolve('.practice/fleet-proof'),prefix=`relocate-knight-${actor}`;mkdirSync(dir,{recursive:true});writeFileSync(resolve(dir,`${prefix}-source.json`),bytes);
    await createBot(actor);const path=await applyPreset(actor,{position:p,skills:Object.fromEntries(source.skills.map((v:any)=>[v.name,v.level])),inventory:source.inventory,equipment:source.equipment,bank:source.bank});setPracticeSkills(path,source.skills);
    const initial=readPracticeSave(path),totals=(v:typeof initial)=>relocationAssets(Object.values(v.inventories).flat());
    const sourceAssets=relocationAssets([...source.inventory,...source.equipment,...source.bank]);
    if(!relocationPreserved(sourceAssets,totals(initial))||initial.skills.some((v,i)=>v.xp!==source.skills[i].xp||v.level!==source.skills[i].level))throw new Error('exact owned fixture clone mismatch');
    const child=Bun.spawn(['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),import.meta.path,'--child',actor],{env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',PROOF_EXPECT_SKILLS:JSON.stringify(source.skills),PROOF_TRACE_PATH:'1'},stdout:'pipe',stderr:'pipe'});
    let output='',stopSent=false;const timer=setTimeout(()=>{stopSent=true;writeFileSync(resolve('.practice',`stop-${actor}`),'native relocation timeout');},380000),hard=setTimeout(()=>child.kill(),425000);
    const read=async(stream:ReadableStream<Uint8Array>)=>{for await(const b of stream){const text=new TextDecoder().decode(b);output+=text;writeFileSync(resolve(dir,`${prefix}.log`),output);process.stdout.write(text);if(!stopSent&&output.includes('PROOF_DAMAGE ')){stopSent=true;writeFileSync(resolve('.practice',`stop-${actor}`),'native relocation HP damage');}}};
    await Promise.all([read(child.stdout),read(child.stderr)]);const code=await child.exited;clearTimeout(timer);clearTimeout(hard);
    const result=JSON.parse(output.match(/^KNIGHT_RELOCATION (.+)$/m)?.[1]??'null');
    const atBank=(v:typeof initial)=>v.position.level===0&&[3283,3286].some(z=>Math.max(Math.abs(v.position.x-2656),Math.abs(v.position.z-z))<=1);
    const final=await waitPracticeSave(path,v=>atBank(v)&&relocationPreserved(totals(initial),totals(v)));
    const assets=relocationPreserved(totals(initial),totals(final.save)),xp=final.save.skills.every((v,i)=>v.rawExperience===initial.skills[i]!.rawExperience&&v.level===initial.skills[i]!.level);
    const equipment=JSON.stringify(initial.inventories[94])===JSON.stringify(final.save.inventories[94]),life=new RegExp(`PROOF_SURVIVAL started=true died=false hpMin=${source.hp.now} finalHp=${source.hp.now}`).test(output);
    const ok=code===0&&!stopSent&&final.matched&&result?.ok&&result.preserved&&result.xpPreserved&&result.finalGeneration>result.initialGeneration&&assets&&xp&&equipment&&life&&atBank(final.save)&&output.includes('LOGOUT logged-out');
    writeFileSync(resolve(dir,`${prefix}-snapshot.json`),JSON.stringify({ok,actor,profile:profile.name,productionSha256,sourceStatusAt:source.at,result,assets,xp,equipment,life,stopSent,initial,final:final.save},null,2));
    console.log(`PROOF_GATE relocate-knight ok=${ok} profile=${profile.name} assets=${assets} allXp=${xp} life=${life}`);process.exitCode=ok?0:1;
}
