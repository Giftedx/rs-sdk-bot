// Root-run read-only shop inspection on an EXISTING settled local actor; no reset, fixture or purchase.
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {openBot,finish,serverFromEnv} from '../../packages/core/src/bot';
import {waitTicks,waitUntil} from '../../packages/core/src/ticks';
import {sessionWalker,walkPath,expandPath} from '../../packages/core/src/walk';
import {SWORD_ROUTE,swordTileSafe} from '../buy-owned-sword';
import {readPracticeSave,waitPracticeSave} from './fleet-player-save';
const expected='D14FA74364D133BF409E662C139152B7C60EC94351DEB17E4924F27B02954576';
const actor=process.argv[2];
if(!actor||!/^fl[a-z0-9]+$/i.test(actor)||process.env.REUSE_STACK!=='1')throw new Error('requires existing local failed fleet actor and REUSE_STACK=1');
if(createHash('sha256').update(readFileSync('scripts/buy-owned-sword.ts')).digest('hex').toUpperCase()!==expected)throw new Error('inspection requires unchanged D14 worker');
const envText=readFileSync(resolve('vendor/rs-sdk/bots',actor,'bot.env'),'utf8');
if(!/^(localhost|127\.)/.test(serverFromEnv(envText)))throw new Error('inspection refuses non-local actor');

// Primary NPC551/552 default wander5 + indoors: union of spawn±5 rectangles.
// Nearest threat bounds: Thief3184..85/3385..90 (wander8/no automatic hunt),
// dark wizards3223..32/3363..74 (wander3/hunt3/range5), Mugger3249,3391 (wander12/hunt5).
const roomSafe=(p:{x:number;z:number;level?:number})=>(p.level??0)===0&&p.x>=3198&&p.x<=3210&&p.z>=3392&&p.z<=3404;
const inspectSafe=(p:{x:number;z:number;level?:number})=>swordTileSafe(p)||roomSafe(p);
if(process.env.SWORD_INSPECT_CHILD==='1'){
    let stopped=false,ended=false,died=false,damaged=false,attemptedBuy=0,reached=0,opened=false,failure='';
    const s=await openBot(actor,{onStop:async()=>{stopped=true;}}),start=s.tick(),first=s.sdk.getState()?.player;
    if(!first)throw new Error('inspection player unavailable');void s.ended.then(()=>{ended=true;});
    const terminal=()=>stopped||ended||died;
    const off=s.onTick(()=>{const p=s.sdk.getState()?.player,hp=s.sdk.getSkill('Hitpoints')?.level??0;damaged||=hp<10;died||=hp<=0||!!p?.isDead||p?.lifeId!==first.lifeId;});
    let bankItems:{id:number;count:number}[]=[];
    const totals=()=>{const m=new Map<number,number>();for(const i of [...s.sdk.getInventory(),...(s.sdk.getState()?.equipment??[]),...bankItems])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
    const openBank=async()=>{await s.bot.dismissBlockingUI();const gen=s.bankObservation?.()?.generation??0;
        if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!s.sdk.getState()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>gen||terminal(),{timeoutTicks:15})||terminal())throw Error('inspection fresh bank unknown');const observed=s.bankObservation?.();if(!observed)throw Error('inspection bank observation missing');bankItems=observed.items.map(i=>({id:i.id,count:i.count}));};
    let before=new Map<number,number>();
    const walk=async(x:number,z:number,tol:number,cleanup=false)=>{const deps=await sessionWalker(s),plan=deps.plan;
        deps.plan=(level,from,to)=>{const corners=plan(level,from,to),tiles=expandPath(from,corners),bad=[from,...tiles].filter(p=>!inspectSafe({...p,level}));
            console.log('SWORD_INSPECT_PLAN '+JSON.stringify({from,to,corners,tiles:tiles.length,bad}));
            if(level!==0||!corners.length||bad.length)throw Error('inspection unsafe/unknown path');return corners;};
        if(!(await walkPath(deps,[{x,z,tol}],{stop:()=>terminal()||(!cleanup&&damaged)||s.tick()-start>1100,maxTicks:180})).ok)throw Error('inspection route failed');};
    const capture=(phase:string)=>{const st=s.sdk.getState(),raw=(s.client as {var?:ArrayLike<number>}|undefined)?.var;
        console.log('SWORD_SHOP_INSPECT '+JSON.stringify({phase,tick:s.tick(),pos:st?.player?{x:st.player.worldX,z:st.player.worldZ,level:st.player.level}:null,
            shop:st?.shop,npcs:st?.nearbyNpcs.filter(n=>[551,552].includes(n.id)),rawVarps:{127:raw?.[127]??null,128:raw?.[128]??null,129:raw?.[129]??null},
            held:s.sdk.getInventory().map(i=>({id:i.id,count:i.count,slot:i.slot})),messages:st?.gameMessages.slice(-6)}));};
    s.bot.buyFromShop=async()=>{attemptedBuy++;throw Error('READONLY sword inspection forbids buyFromShop');};
    s.sdk.sendShopBuy=async()=>{attemptedBuy++;throw Error('READONLY sword inspection forbids buy packet');};
    try{
        await openBank();before=totals();await s.bot.closeBank();
        for(const[x,z]of SWORD_ROUTE){await walk(x,z,1);reached++;}
        // Log every observed NPC BEFORE any selection/range/room rejection.
        const seen=s.sdk.getState()?.nearbyNpcs.filter(n=>[551,552].includes(n.id))??[];
        console.log('SWORD_INSPECT_ALL_NPCS '+JSON.stringify({tick:s.tick(),player:s.sdk.getState()?.player,npcs:seen}));
        const rejected:number[]=[];
        for(const candidate of [...seen].sort((a,b)=>a.distance-b.distance)){
            if(terminal()||damaged)break;
            let npc=s.sdk.getState()?.nearbyNpcs.find(n=>n.index===candidate.index&&n.id===candidate.id);
            const p=s.sdk.getState()?.player;
            if(!npc||!p)continue;
            const target={x:npc.tileX??npc.x,z:npc.tileZ??npc.z};
            if(!roomSafe(target)||!npc.optionsWithIndex.some(o=>/^trade$/i.test(o.text))){rejected.push(npc.index);console.log('SWORD_INSPECT_NPC_REJECT '+JSON.stringify({reason:'room/Trade unavailable',npc}));continue;}
            try{if(npc.distance>2)await walk(target.x,target.z,1);}catch(e){rejected.push(npc.index);console.log('SWORD_INSPECT_NPC_REJECT '+JSON.stringify({reason:String(e),npc}));continue;}
            npc=s.sdk.getState()?.nearbyNpcs.find(n=>n.index===candidate.index&&n.id===candidate.id);
            if(!npc||npc.distance>2||!roomSafe({x:npc.tileX??npc.x,z:npc.tileZ??npc.z})){rejected.push(candidate.index);console.log('SWORD_INSPECT_NPC_REJECT '+JSON.stringify({reason:'fresh range/room changed',npc}));continue;}
            const result=await s.bot.openShop(npc);console.log('SWORD_SHOP_OPEN '+JSON.stringify({npc,result}));
            if(!result.success||!s.sdk.getState()?.shop?.isOpen){rejected.push(npc.index);continue;}
            opened=true;capture('open-return');await waitTicks(s,1);capture('one-tick');await waitTicks(s,2);capture('three-ticks');break;
        }
        if(!opened)failure='no eligible observed shop NPC; inspect ALL_NPCS and rejection logs';
        console.log('SWORD_INSPECT_SELECTION '+JSON.stringify({observed:seen.length,rejected,opened}));
    }catch(e){failure=String(e);}
    finally{
        if(!terminal())try{if(s.sdk.getState()?.shop?.isOpen)await s.bot.closeShop();for(const[x,z]of SWORD_ROUTE.slice(0,reached).reverse())await walk(x,z,1,true);await walk(3185,3436,2,true);await openBank();await s.bot.closeBank();}catch(e){failure+='; '+String(e);}off();
    }
    // Last bank snapshot must be captured before close; bankObservation invalidates when closed.
    const finalStatus=s.sdk.getState(),held=s.sdk.getInventory(),after=totals();
    const preserved=before.size>0&&[...new Set([...before.keys(),...after.keys()])].every(id=>before.get(id)===after.get(id));
    console.log('SWORD_INSPECT_RETURN '+JSON.stringify({result:{bought:0,spent:0,preserved},attemptedBuy,opened,failure,held,finalStatus:finalStatus?.player}));
    await finish([s],false,'read-only inspection; purchase goal remains unmet');
}else{
    const failedPath=resolve('.practice/fleet-proof',`owned-sword-${actor}-snapshot.json`),failed=JSON.parse(readFileSync(failedPath,'utf8'));
    if(failed.actor!==actor||failed.sourceSha256!==expected||failed.ok!==false||failed.assets!==true||failed.life!==true)throw new Error('requires retained safe D14 failed actor snapshot');
    const savePath=resolve('vendor/rs-sdk/server/engine/data/players/main',actor+'.sav'),initial=readPracticeSave(savePath),initialSaveMtime=statSync(savePath).mtimeMs;
    const all=(s:typeof initial)=>Object.values(s.inventories).flat(),count=(items:readonly {id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const before=all(initial);
    if(initial.position.level!==0||Math.max(Math.abs(initial.position.x-3185),Math.abs(initial.position.z-3436))>2||count(initial.inventories[93]??[],333)!==2
        ||count(initial.inventories[93]??[],995)!==0||count(initial.inventories[95]??[],995)!==2600||count(before,1287)!==0)
        throw new Error('existing failed actor not settled at bank with original cash/2Trout/noSword');
    const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB']).stdout.toString().trim());
    if(!Number.isFinite(free)||free<9)throw new Error(`inspection actor needs9GiB; actual=${free}`);
    const source=JSON.parse(readFileSync(resolve('.practice/fleet-proof',`owned-sword-${actor}-source.json`),'utf8'));
    const dir=resolve('.practice/fleet-proof'),prefix=`sword-inspect-${actor}`;
    writeFileSync(resolve(dir,prefix+'-initial.json'),JSON.stringify(initial,null,2));
    const p=Bun.spawn(['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),import.meta.path,actor],{env:{...process.env,SWORD_INSPECT_CHILD:'1',DEMO_OK:'',RANDOM_EVENTS:'0',PROOF_TRACE_PATH:'1',PROOF_EXPECT_SKILLS:JSON.stringify(source.skills)},stdout:'pipe',stderr:'pipe'});
    let output='',timedOut=false,forcedKill=false,damaged=false;
    const stop=(reason:string)=>writeFileSync(resolve('.practice',`stop-${actor}`),reason);
    const timer=setTimeout(()=>{timedOut=true;stop('read-only sword inspection timeout');},600000),hard=setTimeout(()=>{forcedKill=true;p.kill();},645000);
    const read=async(stream:ReadableStream<Uint8Array>)=>{for await(const chunk of stream){const part=new TextDecoder().decode(chunk);output+=part;writeFileSync(resolve(dir,prefix+'.log'),output);process.stdout.write(part);
        if(!damaged&&output.includes('PROOF_DAMAGE ')){damaged=true;stop('read-only sword inspection damage');}}};
    await Promise.all([read(p.stdout),read(p.stderr)]);const code=await p.exited;clearTimeout(timer);clearTimeout(hard);
    const samples=[...output.matchAll(/^SWORD_SHOP_INSPECT (.+)$/gm)].map(m=>JSON.parse(m[1]!)),returned=JSON.parse(output.match(/^SWORD_INSPECT_RETURN (.+)$/m)?.[1]??'null');
    const final=await waitPracticeSave(savePath,s=>statSync(savePath).mtimeMs>initialSaveMtime&&count(s.inventories[95]??[],995)===2600&&count(s.inventories[93]??[],995)===0&&s.position.level===0&&Math.max(Math.abs(s.position.x-3185),Math.abs(s.position.z-3436))<=2);
    const after=all(final.save),assets=[...new Set([...before,...after].map(i=>i.id))].every(id=>count(before,id)===count(after,id));
    const skills=final.save.skills.every((s,i)=>s.rawExperience===initial.skills[i]!.rawExperience&&s.level===initial.skills[i]!.level);
    const equipment=JSON.stringify(initial.inventories[94]??[])===JSON.stringify(final.save.inventories[94]??[]),life=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(output);
    const trace=[...output.matchAll(/^PROOF_PATH (.+)$/gm)].map(m=>JSON.parse(m[1]!)),route=trace.length>5&&trace.every(t=>inspectSafe({x:t.pos[0],z:t.pos[1],level:t.pos[2]}));
    const inspected=samples.length===3&&samples.every(s=>s.shop?.isOpen===true&&s.npcs?.some((n:{id:number})=>[551,552].includes(n.id)));
    const ok=code===1&&inspected&&returned?.attemptedBuy===0&&returned.result?.bought===0&&returned.result?.spent===0&&returned.result?.preserved===true
        &&final.matched&&assets&&skills&&equipment&&life&&route&&!damaged&&!timedOut&&!forcedKill&&output.includes('LOGOUT logged-out');
    writeFileSync(resolve(dir,prefix+'-snapshot.json'),JSON.stringify({ok,actor,sourceSha256:expected,qualification:'READ-ONLY local shop inspection on unchanged failed actor; purchase goal remains unmet; no stock/RNG/reset/fixture changes',code,samples,returned,assets,skills,equipment,life,route,trace,damaged,timedOut,forcedKill,initial,final:final.save},null,2));
    console.log(`PROOF_GATE sword-inspect ok=${ok} samples=${samples.length} attemptedBuy=${returned?.attemptedBuy} assets=${assets} life=${life}`);process.exitCode=ok?0:1;
}
