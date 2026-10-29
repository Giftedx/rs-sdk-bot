// Operator-run local native gate only. Never starts an engine or touches the public actor.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {BotSDK} from '../../vendor/rs-sdk/sdk/index';
import {BotActions} from '../../vendor/rs-sdk/sdk/actions';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {runBotName} from '../../packages/practice/src/prove';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from './fleet-player-save';

type Item={id:number;count:number;slot?:number};
type Skill={name:string;level:number;xp:number};
type Source={name:string;server:string;at:number;bankAt:number;pos:{x:number;z:number;level:number};hp:{now:number;max:number};inventory:Item[];bank:Item[];equipment:(Item&{slot:number})[];skills:Skill[]};
const count=(items:readonly Item[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const canonical=(items:readonly Item[])=>JSON.stringify([...new Set(items.map(i=>i.id))].sort((a,b)=>a-b).map(id=>[id,count(items,id)]));
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex').toUpperCase();

if(process.env.WOOL_WEEK_OBSERVER==='1'){
    const source=JSON.parse(process.env.WOOL_WEEK_SOURCE??'null') as Source|null;
    if(!source)throw new Error('wool observer requires exact source snapshot');
    const get=BotSDK.prototype.getState,proto=BotSDK.prototype as any,send=proto.sendAction,buy=BotActions.prototype.buyFromShop;
    let ready=false,pickpockets=0,actionsBeforeReady=0;const purchases:any[]=[];
    BotSDK.prototype.getState=function(){
        const st=get.call(this),p=st?.player;
        if(!ready&&st?.inGame&&p&&st.skills.find(s=>s.name==='Hitpoints')?.level===10){
            ready=p.worldX===source.pos.x&&p.worldZ===source.pos.z&&p.level===source.pos.level
                &&canonical(st.inventory)===canonical(source.inventory)&&canonical(st.equipment??[])===canonical(source.equipment)
                &&source.skills.every((s,i)=>st.skills[i]?.experience===s.xp&&st.skills[i]?.baseLevel===s.level);
            if(ready)console.log('PROOF_WOOL_READY '+JSON.stringify({exact:true,pos:[p.worldX,p.worldZ,p.level],coins:count(st.inventory,995),foods:[count(st.inventory,315),count(st.inventory,2309)]}));
        }
        return st;
    };
    proto.sendAction=function(action:any){
        const st=this.getState();
        if(action.type!=='logout'&&!ready){actionsBeforeReady++;throw new Error('wool input refused: exact owned fixture not yet observed');}
        if(action.type==='interactNpc'){
            const npc=st?.nearbyNpcs?.find((n:any)=>n.index===action.npcIndex);
            const op=npc?.optionsWithIndex?.find((o:any)=>o.opIndex===action.optionIndex)?.text;
            if(/pickpocket/i.test(op??'')){pickpockets++;throw new Error('wool fixture already funded: pickpocket forbidden');}
        }
        return send.call(this,action);
    };
    BotActions.prototype.buyFromShop=async function(target,amount=1){
        const sdk=(this as any).sdk as BotSDK,before=sdk.getInventory().map(i=>({...i}));
        const result=await buy.call(this,target,amount),after=sdk.getInventory();
        const purchase={target:String(target),success:result.success,amount:result.amountBought??0,
            shears:count(after,1735)-count(before,1735),spent:count(before,995)-count(after,995)};
        purchases.push(purchase);console.log('PROOF_WOOL_BUY '+JSON.stringify(purchase));return result;
    };
    process.on('exit',()=>console.log('PROOF_WOOL_OBSERVER '+JSON.stringify({ready,pickpockets,actionsBeforeReady,purchases})));
}else{
    const script='scripts/collect-wool.ts',sourceSha256=sha(readFileSync(script));
    if(sourceSha256!=='E3FFAADF71F10148C630F53A646B86430D8C17FA9F86BA3C0FCAE9A97C06AC57'||process.env.REUSE_STACK!=='1')
        throw new Error('requires frozen E3FF northern tool-entry wool source and operator-owned existing local stack');
    const sourcePath=resolve(process.env.SOURCE_STATUS??'.practice/status/Masterbaiter.json'),sourceBytes=readFileSync(sourcePath),source=JSON.parse(sourceBytes.toString()) as Source;
    if(source.name!=='Masterbaiter'||source.server!=='rs-sdk-demo.fly.dev'||source.pos.level!==0
        ||Math.max(Math.abs(source.pos.x-3092),Math.abs(source.pos.z-3243))>1||source.hp.now!==10||source.hp.max!==10
        ||source.skills?.length!==21||!source.skills.every(s=>s.level===(s.name==='Hitpoints'?10:1))
        ||!Array.isArray(source.inventory)||!Array.isArray(source.bank)||!Array.isArray(source.equipment)
        ||count(source.inventory,315)!==1||count(source.inventory,2309)!==1||count(source.inventory,995)<5
        ||count([...source.inventory,...source.bank,...source.equipment],1735)!==0)
        throw new Error('requires actual Master Draybank HP10/all other skills1, held Shrimp/Bread/funded wallet, known equipment and no shears');
    const sourceItems=[...source.inventory,...source.bank,...source.equipment];
    if(sourceItems.some(i=>!Number.isSafeInteger(i.id)||i.id<0||!Number.isSafeInteger(i.count)||i.count<=0))throw new Error('invalid actual owned item data');
    const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB'],{windowsHide:true}).stdout.toString().trim());
    if(!Number.isFinite(free)||free<10)throw new Error(`operator actor start needs10GiB; actual=${free}`);
    const dir=resolve('.practice/fleet-proof');mkdirSync(dir,{recursive:true});
    const actor=runBotName('flwoolw',1),prefix=`wool-week-${actor}`;
    writeFileSync(resolve(dir,`${prefix}-source.json`),sourceBytes);
    await createBot(actor);
    const savePath=await applyPreset(actor,{position:source.pos,skills:Object.fromEntries(source.skills.map(s=>[s.name,s.level])),
        inventory:source.inventory.map(i=>({id:i.id,count:i.count})),equipment:source.equipment,bank:source.bank.map(i=>({id:i.id,count:i.count}))});
    setPracticeSkills(savePath,source.skills);const initial=readPracticeSave(savePath);
    const totals=(s:typeof initial)=>Object.values(s.inventories).flat();
    if(canonical(totals(initial))!==canonical(sourceItems)||initial.skills.some((s,i)=>s.xp!==source.skills[i]!.xp||s.level!==source.skills[i]!.level))
        throw new Error('exact saved Master fixture mismatch before input');
    writeFileSync(resolve(dir,`${prefix}-initial.json`),JSON.stringify(initial,null,2));
    console.log(`PROOF_START actor=${actor} source=${sourceSha256} sourceAt=${source.at} sourceBankAt=${source.bankAt} heldCoins=${count(source.inventory,995)} bankCoins=${count(source.bank,995)} unchangedFixture=true freeGiB=${free}`);
    const child=Bun.spawn(['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),'--preload',import.meta.path,resolve(script),actor],{
        env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',WOOL_WEEK_OBSERVER:'1',WOOL_WEEK_SOURCE:JSON.stringify(source),PROOF_EXPECT_SKILLS:JSON.stringify(source.skills),PROOF_TRACE_PATH:'1',CAP:'2200',MAX_TRIPS:'3'},stdout:'pipe',stderr:'pipe',windowsHide:true});
    let output='',timedOut=false,forcedKill=false,stoppedOnDamage=false;
    const stop=(why:string)=>writeFileSync(resolve('.practice',`stop-${actor}`),why);
    const timer=setTimeout(()=>{timedOut=true;stop('wool native bounded timeout');},950000),hard=setTimeout(()=>{forcedKill=true;child.kill();},995000);
    const read=async(stream:ReadableStream<Uint8Array>)=>{for await(const bytes of stream){const part=new TextDecoder().decode(bytes);output+=part;writeFileSync(resolve(dir,`${prefix}.log`),output);process.stdout.write(part);
        if(!stoppedOnDamage&&output.includes('PROOF_DAMAGE ')){stoppedOnDamage=true;stop('wool native HP loss; route not admitted');}}};
    await Promise.all([read(child.stdout),read(child.stderr)]);const code=await child.exited;clearTimeout(timer);clearTimeout(hard);
    const result=output.match(/^RESULT ok ticks=(\d+) gathered=(\d+) spun=(\d+) rawBanked=(\d+) trips=(\d+) died=false/m);
    const gathered=Number(result?.[2]??0),spun=Number(result?.[3]??0),raw=gathered-spun;
    const before=totals(initial);
    const final=await waitPracticeSave(savePath,s=>!!result&&count(s.inventories[95]??[],1737)-count(initial.inventories[95]??[],1737)===raw
        &&count(s.inventories[95]??[],1759)-count(initial.inventories[95]??[],1759)===spun&&count(s.inventories[93]??[],1737)===0&&count(s.inventories[93]??[],1759)===0);
    const observer=JSON.parse(output.match(/^PROOF_WOOL_OBSERVER (.+)$/m)?.[1]??'null'),purchases=observer?.purchases??[];
    const purchase=purchases.length===1&&purchases[0].success===true&&purchases[0].amount===1&&purchases[0].shears===1
        &&Number.isSafeInteger(purchases[0].spent)&&purchases[0].spent>0&&purchases[0].spent<=5;
    const cost=purchase?purchases[0].spent:NaN,after=totals(final.save),deltas=new Map([[995,-cost],[1735,1],[1737,raw],[1759,spun]]);
    const assets=[...new Set([...before,...after].map(i=>i.id))].every(id=>count(after,id)===count(before,id)+(deltas.get(id)??0));
    const equipment=canonical(final.save.inventories[94]??[])===canonical(initial.inventories[94]??[]);
    const skills=final.save.skills.every((s,i)=>i===12?s.rawExperience>initial.skills[i]!.rawExperience:s.rawExperience===initial.skills[i]!.rawExperience&&s.level===initial.skills[i]!.level);
    const life=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(output),p=final.save.position;
    const bankReturn=p.level===0&&Math.max(Math.abs(p.x-3092),Math.abs(p.z-3243))<=2;
    const path=[...output.matchAll(/^PROOF_PATH (.+)$/gm)].map(m=>JSON.parse(m[1]!));
    // The actual complete trace and zero damage qualify this route; do not invent static hazard clearance.
    const routeObserved=path.length>20&&path.some(f=>f.pos[0]>=3200&&f.pos[1]>=3260&&f.pos[2]===0)
        &&path.some(f=>f.pos[0]>=3200&&f.pos[1]<=3220&&f.pos[2]===1);
    const ready=observer?.ready===true&&observer.pickpockets===0&&observer.actionsBeforeReady===0;
    const ok=code===0&&!!result&&gathered>0&&spun>0&&raw>=25&&Number(result[5])===3&&final.matched&&purchase&&assets&&equipment&&skills
        &&life&&bankReturn&&routeObserved&&ready&&!timedOut&&!forcedKill&&!stoppedOnDamage&&output.includes('LOGOUT logged-out');
    writeFileSync(resolve(dir,`${prefix}-snapshot.json`),JSON.stringify({ok,actor,sourceSha256,sourcePath,sourceSnapshotSha256:sha(sourceBytes),qualification:'actual Master snapshot unchanged; funded held wallet skips pickpocket; bounded3trips only, not week throughput proof',
        code,gathered,spun,raw,cost,purchase,assets,equipment,skills,life,bankReturn,routeObserved,ready,observer,path,timedOut,forcedKill,stoppedOnDamage,initial,final:final.save},null,2));
    console.log(`PROOF_GATE wool-week ok=${ok} gathered=${gathered} spun=${spun} newRaw=${raw} shearsCost=${cost} assets=${assets} life=${life} bankReturn=${bankReturn}`);process.exitCode=ok?0:1;
}
