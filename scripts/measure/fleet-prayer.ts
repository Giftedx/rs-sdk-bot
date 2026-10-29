// Native proof only. The operator owns the existing local engine and one actor slot.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {BotSDK} from '../../vendor/rs-sdk/sdk/index';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {runBotName} from '../../packages/practice/src/prove';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from './fleet-player-save';

// Preloaded in the worker child: observe actual publications without issuing actions.
if (process.env.PRAYER_PROOF_OBSERVER==='1') {
    const original=BotSDK.prototype.getState;
    const origin=JSON.parse(process.env.PRAYER_PROOF_ORIGIN??'null') as {x:number;z:number;level:number}|null;
    if (!origin) throw new Error('prayer proof origin required');
    let activeSeen=false,offAfterOn=false,outsideBank=false,lastFlag:boolean|undefined;
    let finalPrayer:any=null;
    BotSDK.prototype.getState=function(){
        const st=original.call(this),p=st?.player;
        if(st?.inGame&&p){
            const adjacentService=[3283,3286].some(z=>Math.max(Math.abs(p.worldX-2656),Math.abs(p.worldZ-z))<=2);
            if(p.level!==0||Math.max(Math.abs(p.worldX-origin.x),Math.abs(p.worldZ-origin.z))>2||!adjacentService)outsideBank=true;
            const prayer=st.prayers;
            if(prayer&&typeof prayer.activePrayers?.[14]==='boolean'){
                const active=prayer.activePrayers[14];
                if(active)activeSeen=true;
                if(activeSeen&&!active)offAfterOn=true;
                if(active!==lastFlag){
                    console.log('PROOF_PRAYER_TOGGLE '+JSON.stringify({tick:st.tick,active,points:prayer.prayerPoints,base:prayer.prayerLevel,pos:[p.worldX,p.worldZ,p.level]}));
                    lastFlag=active;
                }
                finalPrayer={active,points:prayer.prayerPoints,base:prayer.prayerLevel};
            }
        }
        return st;
    };
    process.on('exit',()=>console.log('PROOF_PRAYER_OBSERVER '+JSON.stringify({activeSeen,offAfterOn,outsideBank,finalPrayer})));
} else {
    const script='scripts/train-prayer.ts';
    const expected=process.env.PRAYER_SOURCE_SHA256;
    const sourceSha256=createHash('sha256').update(readFileSync(script)).digest('hex').toUpperCase();
    if(!expected||!/^[A-F0-9]{64}$/.test(expected)||sourceSha256!==expected||process.env.REUSE_STACK!=='1')
        throw new Error('operator must supply frozen PRAYER_SOURCE_SHA256 and existing local stack');
    type Item={id:number;count:number;slot?:number};
    type Skill={name:string;level:number;xp:number};
    type Source={name:string;server:string;at:number;bankAt:number;result:string;pos:{x:number;z:number;level:number};hp:{now:number;max:number};
        inventory:Item[];bank:Item[];equipment:(Item&{slot:number})[]|null;skills:Skill[]};
    const sourcePath=resolve(process.env.SOURCE_STATUS??'.practice/status/Mightyrod.json');
    const sourceBytes=readFileSync(sourcePath),source=JSON.parse(sourceBytes.toString()) as Source;
    const recent=(at:number)=>Number.isFinite(at)&&Date.now()-at>=-5000&&Date.now()-at<=30*60*1000;
    const count=(items:Item[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    if(source.name!=='Mightyrod'||source.server!=='rs-sdk-demo.fly.dev'||!recent(source.at)||!recent(source.bankAt)
        ||!source.result?.startsWith('ok ')||!Array.isArray(source.equipment)||!Array.isArray(source.inventory)||!Array.isArray(source.bank)
        ||source.hp.now!==70||source.hp.max!==70||source.skills?.length!==21||source.skills[5]?.name!=='Prayer'
        ||source.skills[5].xp!==0||source.skills[5].level!==1||source.skills[1]?.level!==74
        ||source.pos.level!==0||Math.max(Math.abs(source.pos.x-2655),Math.abs(source.pos.z-3283))>1
        ||count(source.bank,526)!==222||count(source.inventory,526)!==0)
        throw new Error('requires fresh completed Mighty HP70/Def74/Prayer1XP0 bank222bones and known worn kit at Ardy');
    const worn=source.equipment;
    if(!worn.some(i=>i.slot===3&&i.id===1277&&i.count===1)||!worn.some(i=>i.slot===5&&i.id===1171&&i.count===1))
        throw new Error('actual Mighty worn sword/shield missing');
    const sourceTotal=[...source.inventory,...source.bank,...worn];
    if(sourceTotal.some(i=>!Number.isSafeInteger(i.id)||i.id<0||!Number.isSafeInteger(i.count)||i.count<=0))throw new Error('invalid owned assets');
    const world=JSON.parse(readFileSync('knowledge/ubermouse/world.json','utf8'));
    const booths=world.features.filter((f:any)=>f.source==='loc'&&f.id===2213&&f.tile?.level===0&&f.tile.x===2656&&[3283,3286].includes(f.tile.z));
    if(booths.length!==2)throw new Error('actual Ardy bank service facts changed');
    const atBank=(p:{x:number;z:number;level:number})=>p.level===0&&booths.some((b:any)=>Math.max(Math.abs(p.x-b.tile.x),Math.abs(p.z-b.tile.z))<=2)
        &&Math.max(Math.abs(p.x-source.pos.x),Math.abs(p.z-source.pos.z))<=2;
    const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB'],{windowsHide:true}).stdout.toString().trim());
    if(!Number.isFinite(free)||free<9)throw new Error(`one actor needs9GiB; actual=${free}`);
    const dir=resolve('.practice/fleet-proof');mkdirSync(dir,{recursive:true});
    const actor=runBotName('flpray',1),prefix=`prayer-${actor}`;
    writeFileSync(resolve(dir,`${prefix}-source.json`),sourceBytes);
    await createBot(actor);
    const path=await applyPreset(actor,{position:source.pos,skills:Object.fromEntries(source.skills.map(s=>[s.name,s.level])),
        inventory:source.inventory.map(i=>({id:i.id,count:i.count})),equipment:worn,bank:source.bank.map(i=>({id:i.id,count:i.count}))});
    setPracticeSkills(path,source.skills);
    const initial=readPracticeSave(path);
    const totals=(s:typeof initial)=>{const m=new Map<number,number>();for(const a of Object.values(s.inventories))for(const i of a)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
    const before=totals(initial);
    for(const id of new Set([...before.keys(),...sourceTotal.map(i=>i.id)]))if((before.get(id)??0)!==count(sourceTotal,id))throw new Error('exact owned fixture assets mismatch');
    if(initial.skills.some((s,i)=>s.xp!==source.skills[i]!.xp||s.level!==source.skills[i]!.level))throw new Error('exact all21 skill fixture mismatch');
    writeFileSync(resolve(dir,`${prefix}-initial.json`),JSON.stringify(initial,null,2));
    console.log(`PROOF_START actor=${actor} source=${sourceSha256} sourceStatusAt=${source.at} bones222=true exactSkills=true freeGiB=${free}`);
    const p=Bun.spawn(['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),'--preload',import.meta.path,resolve(script),actor],{
        env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',PRAYER_PROOF_OBSERVER:'1',PRAYER_PROOF_ORIGIN:JSON.stringify(source.pos),
            PROOF_EXPECT_SKILLS:JSON.stringify(source.skills),PROOF_TRACE_PATH:'1',MAX_BURY:'175',BONE_RESERVE:'6',CAP:'1000'},stdout:'pipe',stderr:'pipe',windowsHide:true});
    let output='',stoppedOnDamage=false,timedOut=false,forcedKill=false;
    const stop=(why:string)=>writeFileSync(resolve('.practice',`stop-${actor}`),why);
    const timer=setTimeout(()=>{timedOut=true;stop('local prayer proof bounded timeout');},500000);
    const hardTimer=setTimeout(()=>{forcedKill=true;p.kill();},545000);
    const read=async(stream:ReadableStream<Uint8Array>)=>{for await(const bytes of stream){const part=new TextDecoder().decode(bytes);output+=part;
        writeFileSync(resolve(dir,`${prefix}.log`),output);process.stdout.write(part);
        if(!stoppedOnDamage&&output.includes('PROOF_DAMAGE ')){stoppedOnDamage=true;stop('local prayer proof HP damage');}}};
    await Promise.all([read(p.stdout),read(p.stderr)]);const code=await p.exited;clearTimeout(timer);clearTimeout(hardTimer);
    const final=await waitPracticeSave(path,s=>s.skills[5]!.rawExperience===196875&&count(s.inventories[95]??[],526)===47&&atBank(s.position));
    const after=totals(final.save),debit=(before.get(526)??0)-(after.get(526)??0);
    const assets=[...new Set([...before.keys(),...after.keys()])].every(id=>(after.get(id)??0)===(before.get(id)??0)-(id===526?175:0));
    const equipment=JSON.stringify(final.save.inventories[94]??[])===JSON.stringify(initial.inventories[94]??[]);
    const skills=final.save.skills.every((s,i)=>i===5?s.rawExperience===196875&&s.xp===19687&&s.level===43:s.rawExperience===initial.skills[i]!.rawExperience&&s.level===initial.skills[i]!.level);
    const observer=JSON.parse(output.match(/^PROOF_PRAYER_OBSERVER (.+)$/m)?.[1]??'null');
    const toggles=[...output.matchAll(/^PROOF_PRAYER_TOGGLE (.+)$/gm)].map(m=>JSON.parse(m[1]!));
    const on=toggles.findIndex(t=>t.active===true&&t.base===43&&t.points>0);
    const off=on>=0&&toggles.slice(on+1).some(t=>t.active===false&&t.base===43&&t.points>0);
    const protection=!!observer?.activeSeen&&!!observer?.offAfterOn&&!observer?.outsideBank&&observer?.finalPrayer?.active===false&&on>=0&&off;
    const life=/PROOF_SURVIVAL started=true died=false hpMin=70 finalHp=70/.test(output);
    const banked=count(final.save.inventories[95]??[],526)===47&&count(final.save.inventories[93]??[],526)===0;
    const result=JSON.parse(output.match(/^PRAYER_BANK (.+)$/m)?.[1]??'null');
    const worker=!!result?.ok&&result.targetMet===true&&result.buried===175&&result.consumed===175&&result.boneBank===47
        &&result.toggledOn===true&&result.toggledOff===true;
    const ok=code===0&&final.matched&&/^RESULT ok /m.test(output)&&worker&&assets&&equipment&&skills&&protection&&life&&banked&&debit===175&&atBank(final.save.position)
        &&!stoppedOnDamage&&!timedOut&&!forcedKill&&output.includes('LOGOUT logged-out');
    writeFileSync(resolve(dir,`${prefix}-snapshot.json`),JSON.stringify({ok,actor,sourceSha256,sourcePath,sourceStatusAt:source.at,
        sourceSnapshotSha256:createHash('sha256').update(sourceBytes).digest('hex'),qualification:'exact completed owned Mighty bank222/PrayerXP0/HP70/worn kit; no injected inputs',
        booths,code,result,worker,debit,assets,equipment,skills,protection,life,banked,observer,toggles,stoppedOnDamage,timedOut,forcedKill,initial,final:final.save},null,2));
    console.log(`PROOF_GATE prayer ok=${ok} buriedDebit=${debit} bankBones=${count(final.save.inventories[95]??[],526)} rawPrayerXP=${final.save.skills[5]!.rawExperience} protection=${protection} assets=${assets} life=${life}`);
    process.exitCode=ok?0:1;
}
