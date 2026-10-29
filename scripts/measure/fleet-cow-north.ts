// Same native actor: exact owned South-bank fixture -> guarded North-bank entry -> nine-cow full pack.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {openBot,finish} from '../../packages/core/src/bot';
import {sessionWalker,walkPath} from '../../packages/core/src/walk';
import {waitUntil} from '../../packages/core/src/ticks';
import {guardCowWalker} from '../gather-combat';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {runBotName} from '../../packages/practice/src/prove';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from './fleet-player-save';
const script='scripts/gather-combat.ts',hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();
const sourceSha256=hash(script);
if(!process.env.COW_SOURCE_SHA256||sourceSha256!==process.env.COW_SOURCE_SHA256)throw new Error('operator must bind frozen COW_SOURCE_SHA256');
if(process.argv[2]==='--entry'){
    const source=JSON.parse(readFileSync(process.env.COW_NORTH_SOURCE!,'utf8'));
    const s=await openBot(process.argv[3]!);
    try{
        const hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,initialHp=hp(),p0=s.sdk.getState()!.player!;
        if(!s.sdk.getState()!.skills.every((v,i)=>v.baseLevel===source.skills[i].level&&v.experience===source.skills[i].xp)||initialHp!==source.hp.now)throw new Error('exact all21/currentHP entry fixture mismatch');
        const threat=()=>{const st=s.sdk.getState(),p=st?.player;if(!p||p.isDead||p.lifeId!==p0.lifeId||hp()<initialHp)return 'North entry HP/life changed';
            if(st.nearbyNpcs.some(n=>/bear/i.test(n.name)&&n.distance<=6))return 'North entry observed bear within6';return null;};
        const guard=guardCowWalker(await sessionWalker(s),threat);
        const r=await walkPath(guard.deps,[{x:2644,z:3293,tol:0},{x:2619,z:3332,tol:0}],{look:6,maxTicks:250,stop:()=>!!guard.reason()});
        const observeBank=s.bankObservation?.bind(s);if(!observeBank)throw new Error('North entry bank observation unavailable');
        const generation=observeBank()?.generation??0;
        if(!r.ok||guard.reason()||!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!observeBank()&&(observeBank()?.generation??0)>generation,{timeoutTicks:20}))throw new Error(`North entry failed ${r.detail} ${guard.reason()??''}`);
        console.log('COW_NORTH_ENTRY '+JSON.stringify({ok:true,ticks:r.ticks,position:s.sdk.getState()!.player,hp:hp(),bankObservedAt:observeBank()!.at}));
        await finish([s],true,'cow north guarded entry complete');
    }catch(e){await finish([s],false,String(e));}
}else{
    if(process.env.REUSE_STACK!=='1')throw new Error('operator-owned existing stack required');
    const sourceBytes=readFileSync(process.env.SOURCE_STATUS??'.practice/status/Mightyrod.json'),source=JSON.parse(sourceBytes.toString());
    const recent=(n:number)=>Number.isFinite(n)&&Date.now()-n>=0&&Date.now()-n<30*60_000;
    if(source.name!=='Mightyrod'||source.server!=='rs-sdk-demo.fly.dev'||!source.result?.startsWith('ok mode=cow ')||!recent(source.at)||!recent(source.bankAt)
        ||!Array.isArray(source.equipment)||source.hp.now!==source.hp.max||source.hp.now<60||source.skills[1].level<70||source.skills.length!==21
        ||source.pos.level!==0||Math.max(Math.abs(source.pos.x-2655),Math.abs(source.pos.z-3283))>2
        ||source.inventory.some((i:any)=>i.id!==333)||source.inventory.reduce((n:number,i:any)=>n+i.count,0)!==2)
        throw new Error('requires fresh completed Mighty South-bank/fullHP/known-worn/two-Trout-only snapshot');
    if(![1277,1171].every(id=>source.equipment.some((i:any)=>i.id===id)))throw new Error('known Mighty worn bronze kit required');
    const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB'],{windowsHide:true}).stdout.toString().trim());
    if(!Number.isFinite(free)||free<9)throw new Error(`one native actor needs9GiB; actual=${free}`);
    const actor=runBotName('flcow9',1),dir=resolve('.practice/fleet-proof'),prefix=`cow-north-${actor}`;mkdirSync(dir,{recursive:true});
    const sourcePath=resolve(dir,`${prefix}-source.json`);writeFileSync(sourcePath,sourceBytes);await createBot(actor);
    const path=await applyPreset(actor,{position:source.pos,skills:Object.fromEntries(source.skills.map((v:any)=>[v.name,v.level])),inventory:source.inventory,equipment:source.equipment,bank:source.bank});
    setPracticeSkills(path,source.skills);const initial=readPracticeSave(path);
    const count=(items:{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const totals=(s:typeof initial)=>{const m=new Map<number,number>();for(const items of Object.values(s.inventories))for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
    const before=totals(initial),sourceItems=[...source.inventory,...source.equipment,...source.bank];
    if([...new Set([...before.keys(),...sourceItems.map((i:any)=>i.id)])].some(id=>(before.get(id as number)??0)!==count(sourceItems,id as number))||initial.skills.some((v,i)=>v.xp!==source.skills[i].xp||v.level!==source.skills[i].level))throw new Error('exact owned fixture clone failed');
    writeFileSync(resolve(dir,`${prefix}-initial.json`),JSON.stringify(initial,null,2));
    async function child(entry:boolean){
        const label=entry?'entry':'nine-cows',p=Bun.spawn(['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),entry?import.meta.path:resolve(script),...(entry?['--entry',actor]:[actor])],{
            env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',COW_NORTH_SOURCE:sourcePath,PROOF_EXPECT_SKILLS:JSON.stringify(source.skills),PROOF_TRACE_PATH:'1',
                TARGET:'cow',TRAIN_SKILL:'Defence',MAX_KILLS:'9',COW_BANK_PROFILE:'north',COW_FOOD_MODE:'banked',CAP:'1500'},stdout:'pipe',stderr:'pipe',windowsHide:true});
        let output='',stopSent=false;const timer=setTimeout(()=>{stopSent=true;writeFileSync(resolve('.practice',`stop-${actor}`),'native North cow proof timed out');},650000),hard=setTimeout(()=>p.kill(),695000);
        const read=async(stream:ReadableStream<Uint8Array>)=>{for await(const bytes of stream){const text=new TextDecoder().decode(bytes);output+=text;writeFileSync(resolve(dir,`${prefix}-${label}.log`),output);process.stdout.write(text);
            if(!stopSent&&output.includes('PROOF_DAMAGE ')){stopSent=true;writeFileSync(resolve('.practice',`stop-${actor}`),'native North cow proof HP damage');}}};
        await Promise.all([read(p.stdout),read(p.stderr)]);const code=await p.exited;clearTimeout(timer);clearTimeout(hard);return{output,code,stopSent};
    }
    const atBank=(s:typeof initial)=>s.position.level===0&&[2615,2618,2619].some(x=>Math.max(Math.abs(s.position.x-x),Math.abs(s.position.z-3331))<=1);
    const entry=await child(true),middle=await waitPracticeSave(path,atBank);
    const midAssets=[...new Set([...before.keys(),...totals(middle.save).keys()])].every(id=>before.get(id)===totals(middle.save).get(id));
    const midSkills=middle.save.skills.every((v,i)=>v.rawExperience===initial.skills[i]!.rawExperience&&v.level===initial.skills[i]!.level);
    if(entry.code!==0||entry.stopSent||!middle.matched||!midAssets||!midSkills||!entry.output.includes('COW_NORTH_ENTRY {"ok":true')||!entry.output.includes('LOGOUT logged-out')){
        writeFileSync(resolve(dir,`${prefix}-failure.json`),JSON.stringify({ok:false,phase:'entry',actor,sourceSha256,entry,middle,midAssets},null,2));throw new Error('North entry exact-asset/noHP gate failed; no combat started');
    }
    const work=await child(false),line=work.output.match(/^RESULT ok mode=cow (.+)$/m)?.[1]??'';
    const field=(key:string)=>Number(line.match(new RegExp(`(?:^| )${key}=([0-9]+)(?: |$)`))?.[1]??NaN);
    const final=await waitPracticeSave(path,v=>atBank(v)&&[1739,526,2132].every(id=>count(v.inventories[95]??[],id)===(before.get(id)??0)+9));
    const after=totals(final.save),assets=[...new Set([...before.keys(),...after.keys()])].every(id=>(after.get(id)??0)===(before.get(id)??0)+([1739,526,2132].includes(id)?9:0));
    const equipment=JSON.stringify(initial.inventories[94])===JSON.stringify(final.save.inventories[94]);
    const xp=final.save.skills[1]!.rawExperience>initial.skills[1]!.rawExperience&&final.save.skills.every((v,i)=>i===1||i===3||v.rawExperience===initial.skills[i]!.rawExperience);
    const life=[entry.output,work.output].every(s=>new RegExp(`PROOF_SURVIVAL started=true died=false hpMin=${source.hp.now} finalHp=`).test(s)&&s.includes('LOGOUT logged-out'));
    const held=final.save.inventories[93]??[],foodBanked=count(final.save.inventories[95]??[],333)===(before.get(333)??0)&&held.length===0;
    const ok=work.code===0&&!work.stopSent&&final.matched&&assets&&equipment&&xp&&life&&foodBanked&&field('creditedKills')===9&&field('maxPackSlots')===27&&field('eaten')===0&&field('houseInteractions')===0&&/targetMet=true/.test(line)&&/preserved=true/.test(line);
    writeFileSync(resolve(dir,`${prefix}-snapshot.json`),JSON.stringify({ok,actor,sourceSha256,sourceStatusAt:source.at,sourceSnapshotSha256:hash(sourcePath),qualification:'Same exact owned South fixture; guarded 84-tile candidate entry then explicit North corridor/full9 native proof; no optimality or speedup claim',entryGate:{matched:middle.matched,midAssets,midSkills},assets,equipment,xp,life,foodBanked,resultLine:line,initial,middle:middle.save,final:final.save},null,2));
    console.log(`PROOF_GATE cow-north ok=${ok} credited=${field('creditedKills')} packSlots=${field('maxPackSlots')} assets=${assets} foodBanked=${foodBanked} life=${life}`);process.exitCode=ok?0:1;
}
