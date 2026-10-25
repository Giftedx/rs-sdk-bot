// One source-bound local native procurement gate. Existing stack and actor admission belong to root.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {runBotName} from '../../packages/practice/src/prove';
import {openBot,finish} from '../../packages/core/src/bot';
import {runOwnedSword,swordTileSafe} from '../buy-owned-sword';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from './fleet-player-save';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
type Item={id:number;count:number;slot?:number};type Skill={name:string;level:number;xp:number};
const count=(items:readonly Item[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);

if(process.env.OWNED_SWORD_CHILD==='1'){
    let stopped=false;const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}});
    try{const result=await runOwnedSword(s,{cap:900,maximumSpend:2500,stop:()=>stopped});console.log('OWNED_SWORD_BANK '+JSON.stringify(result));await finish([s],result.ok,Object.entries(result).map(([k,v])=>`${k}=${v}`).join(' '));}
    catch(e){await finish([s],false,String(e));}
}else{
    const script='scripts/buy-owned-sword.ts',sourceSha256=hash(readFileSync(script)),expected=process.env.SWORD_SOURCE_SHA256;
    if(process.env.REUSE_STACK!=='1'||!expected||sourceSha256!==expected.toUpperCase()||!/^[a-f0-9]{64}$/i.test(expected))throw new Error('operator must bind frozen SWORD_SOURCE_SHA256 and existing local stack');
    const sourcePath=resolve(process.env.SOURCE_STATUS??'.practice/status/Bigpackage.json'),bytes=readFileSync(sourcePath),source=JSON.parse(bytes.toString()) as {
        name:string;server:string;at:number;bankAt:number;pos:{x:number;z:number;level:number};hp:{now:number;max:number};inventory:Item[];bank:Item[];equipment:(Item&{slot:number})[];skills:Skill[]};
    if(source.name!=='Bigpackage'||source.server!=='rs-sdk-demo.fly.dev'||source.hp.now!==10||source.hp.max!==10||source.pos.level!==0
        ||Math.max(Math.abs(source.pos.x-3185),Math.abs(source.pos.z-3436))>1||source.skills?.length!==21||!Array.isArray(source.equipment)
        ||count(source.inventory,995)!==0||count(source.bank,995)!==2600||count(source.inventory,333)!==2||count(source.bank,329)!==30
        ||count([...source.inventory,...source.bank,...source.equipment],1287)!==0)throw new Error('actual Bigpackage Westbank2600GP/2heldTrout/30bankSalmon/noAdamantsword fixture required');
    const sourceItems=[...source.inventory,...source.bank,...source.equipment];
    if(sourceItems.some(i=>!Number.isSafeInteger(i.id)||i.id<0||!Number.isSafeInteger(i.count)||i.count<=0))throw new Error('invalid owned assets');
    const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB']).stdout.toString().trim());
    if(!Number.isFinite(free)||free<9)throw new Error(`one native actor needs9GiB free; actual=${free}`);
    const dir=resolve('.practice/fleet-proof');mkdirSync(dir,{recursive:true});const actor=runBotName('flswordb',1),prefix=`owned-sword-${actor}`;
    writeFileSync(resolve(dir,`${prefix}-source.json`),bytes);await createBot(actor);
    const path=await applyPreset(actor,{position:source.pos,skills:Object.fromEntries(source.skills.map(s=>[s.name,s.level])),inventory:source.inventory.map(i=>({id:i.id,count:i.count})),equipment:source.equipment,bank:source.bank.map(i=>({id:i.id,count:i.count}))});
    setPracticeSkills(path,source.skills);const initial=readPracticeSave(path),all=(s:typeof initial)=>Object.values(s.inventories).flat(),before=all(initial);
    if([...new Set([...sourceItems,...before].map(i=>i.id))].some(id=>count(before,id)!==count(sourceItems,id))||initial.skills.some((s,i)=>s.xp!==source.skills[i]!.xp||s.level!==source.skills[i]!.level))throw new Error('exact owned native fixture mismatch');
    writeFileSync(resolve(dir,`${prefix}-initial.json`),JSON.stringify(initial,null,2));
    console.log(`PROOF_START actor=${actor} source=${sourceSha256} sourceAt=${source.at} bankAt=${source.bankAt} exactSkills=true unchangedAssets=true freeGiB=${free}`);
    const p=Bun.spawn(['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),import.meta.path,actor],{env:{...process.env,OWNED_SWORD_CHILD:'1',DEMO_OK:'',RANDOM_EVENTS:'0',PROOF_EXPECT_SKILLS:JSON.stringify(source.skills),PROOF_TRACE_PATH:'1'},stdout:'pipe',stderr:'pipe'});
    let output='',timedOut=false,forcedKill=false,stoppedOnDamage=false;
    const stop=(reason:string)=>writeFileSync(resolve('.practice',`stop-${actor}`),reason);
    const timer=setTimeout(()=>{timedOut=true;stop('owned sword native timeout');},600000),hard=setTimeout(()=>{forcedKill=true;p.kill();},645000);
    const read=async(stream:ReadableStream<Uint8Array>)=>{for await(const chunk of stream){const part=new TextDecoder().decode(chunk);output+=part;writeFileSync(resolve(dir,`${prefix}.log`),output);process.stdout.write(part);
        if(!stoppedOnDamage&&output.includes('PROOF_DAMAGE ')){stoppedOnDamage=true;stop('owned sword route HP loss');}}};
    await Promise.all([read(p.stdout),read(p.stderr)]);const code=await p.exited;clearTimeout(timer);clearTimeout(hard);
    const result=JSON.parse(output.match(/^OWNED_SWORD_BANK (.+)$/m)?.[1]??'null');
    const final=await waitPracticeSave(path,s=>count(s.inventories[95]??[],1287)===1&&count(s.inventories[93]??[],1287)===0&&count(s.inventories[93]??[],995)===0);
    const after=all(final.save),spent=count(before,995)-count(after,995),assets=[...new Set([...before,...after].map(i=>i.id))].every(id=>count(after,id)===count(before,id)+(id===1287?1:0)-(id===995?spent:0));
    const equipment=JSON.stringify(final.save.inventories[94]??[])===JSON.stringify(initial.inventories[94]??[]),skills=final.save.skills.every((s,i)=>s.rawExperience===initial.skills[i]!.rawExperience&&s.level===initial.skills[i]!.level);
    const trace=[...output.matchAll(/^PROOF_PATH (.+)$/gm)].map(m=>JSON.parse(m[1]!)),route=trace.length>5&&trace.every(t=>swordTileSafe({x:t.pos[0],z:t.pos[1],level:t.pos[2]}));
    const pos=final.save.position,bankReturn=pos.level===0&&Math.max(Math.abs(pos.x-3185),Math.abs(pos.z-3436))<=2;
    const life=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(output),quote=JSON.parse(output.match(/^SWORD_QUOTE (.+)$/m)?.[1]??'null');
    const paid=!!quote&&[551,552].includes(quote.npc)&&quote.item===1287&&quote.price===spent&&spent>0&&spent<=2500&&count(after,995)>=100;
    const worker=!!result?.ok&&result.targetMet===true&&result.bought===1&&result.banked===1&&result.spent===spent&&result.preserved===true;
    const ok=code===0&&worker&&final.matched&&paid&&assets&&equipment&&skills&&route&&bankReturn&&life&&!timedOut&&!forcedKill&&!stoppedOnDamage&&output.includes('LOGOUT logged-out');
    writeFileSync(resolve(dir,`${prefix}-snapshot.json`),JSON.stringify({ok,actor,sourceSha256,sourcePath,sourceSnapshotSha256:hash(bytes),qualification:'one owned NPC sword purchase from exact Bigpackage2600GP/2Trout/30Salmon; no GE/player transfer; public stock and subsequent gear delivery remain separate',
        code,result,quote,spent,paid,assets,equipment,skills,route,bankReturn,life,trace,timedOut,forcedKill,stoppedOnDamage,initial,final:final.save},null,2));
    console.log(`PROOF_GATE owned-sword ok=${ok} spent=${spent} bankSword=${count(final.save.inventories[95]??[],1287)} cashLeft=${count(after,995)} assets=${assets} life=${life}`);process.exitCode=ok?0:1;
}
