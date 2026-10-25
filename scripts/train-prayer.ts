// Bank-side owned Bones526 -> Prayer43. No travel, notes, altar or indefinite maintenance.
// MAX_BURY<=175 (default175), BONE_RESERVE>=6 (default6), CAP<=1500.
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {xpForLevel} from '../packages/planner/src/curve';

const BONE=526,GOAL=43,PRAYER=14,XP=112.5,TARGET_XP=xpForLevel(GOAL);
export interface PrayerOptions{cap:number;maximum:number;reserve:number;stop?:()=>boolean}
export function planPrayer(bones:number,xp:number,maximum=175,reserve=6){return Math.max(0,Math.min(maximum,bones-reserve,Math.ceil((TARGET_XP-xp)/XP)));}
export async function runPrayer(s:Session,o:PrayerOptions){
    if(!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>1500||!Number.isSafeInteger(o.maximum)||o.maximum<1||o.maximum>175||!Number.isSafeInteger(o.reserve)||o.reserve<6)throw new Error('no prayer progress: invalid bounded limits');
    const state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory();
    const count=(items:readonly{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const held=()=>count(inv(),BONE),xp=()=>s.sdk.getSkillXp('Prayer')??0,level=()=>s.sdk.getSkill('Prayer')?.baseLevel??0,hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    if(!await waitUntil(s,()=>hp()>0&&level()>0,{timeoutTicks:15}))throw new Error('no prayer progress: unknown skills');
    const p0=state()?.player,start=s.tick(),initialXp=xp(),initialHp=hp();
    if(!p0||p0.level!==0||Math.max(Math.abs(p0.worldX-2655),Math.abs(p0.worldZ-3283))>3)throw new Error('no prayer progress: stage at Ardougne south bank');
    let ended=false,died=false,unsafe=false,stopRequested=false,hpMin=hp(),buried=0,attempts=0,failure='',stop='input-insufficient',firstBoneXp:number|undefined,phase=0;
    let toggledOn=false,toggledOff=false,prayerPointsOn=0,bankObservedAt:number|undefined;
    let snapshot:{id:number;count:number}[]|undefined,initial:Map<number,number>|undefined;
    const bankCount=()=>count(snapshot??[],BONE),goalReached=()=>level()>=GOAL||xp()>=TARGET_XP;
    const stopped=()=>stopRequested||=!!o.stop?.();
    const off=s.onTick(()=>{stopped();const p=state()?.player;hpMin=Math.min(hpMin,hp());if(hp()<=0||p?.isDead||p?.lifeId!==p0.lifeId||(p?.respawnCount??0)>(p0.respawnCount??0))died=true;if(hp()<initialHp||!p||p.level!==0||Math.max(Math.abs(p.worldX-p0.worldX),Math.abs(p.worldZ-p0.worldZ))>2)unsafe=true;});
    void s.ended.then(()=>{ended=true;});
    const over=()=>ended||died||unsafe||stopped()||s.tick()-start>=o.cap;
    const capture=()=>{const b=s.bankObservation?.();if(!b)throw new Error('no prayer progress: bank data unknown');snapshot=b.items.map(i=>({id:i.id,count:i.count}));bankObservedAt=b.at;};
    const blockingUi=()=>!!state()?.dialog?.isOpen||!!state()?.interface?.isOpen&&!state()?.bank?.isOpen;
    const open=async()=>{
        if(state()?.bank?.isOpen&&s.bankObservation?.()){capture();return;}
        const gen=s.bankObservation?.()?.generation??0;
        // SDK openBank can label any existing interface "Bank already open".
        // Clear observed level-up UI first; retry only when another observed
        // late UI publication interrupted the first bank request.
        for(let attempt=0;attempt<2;attempt++){
            await s.bot.dismissBlockingUI();
            if(ended||died)throw new Error('no prayer progress: session ended before bank cleanup');
            if(!(await s.bot.openBank()).success)throw new Error('no prayer progress: bank open failed');
            await waitUntil(s,()=>!!state()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>gen||blockingUi()||ended||died,{timeoutTicks:15});
            if(state()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>gen){capture();return;}
            if(!blockingUi())break;
        }
        throw new Error('no prayer progress: bank readiness unknown');
    };
    const deposit=async()=>{const item=inv().find(i=>i.id===BONE);if(item){const before=bankCount(),amount=held();if(!(await s.bot.depositItem(item,-1)).success||!await waitUntil(s,()=>held()===0&&count(s.bankObservation?.()?.items??[],BONE)===before+amount,{timeoutTicks:10}))throw new Error('no prayer progress: bone deposit mismatch');}capture();};
    const close=async()=>{if(!(await s.bot.closeBank()).success||!await waitUntil(s,()=>!state()?.bank?.isOpen,{timeoutTicks:5}))throw new Error('no prayer progress: bank close unobserved');};
    const totals=()=>{const m=new Map<number,number>();for(const i of [...(snapshot??[]),...inv(),...s.sdk.getEquipment()])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
    const prayerOn=()=>state()?.prayers?.activePrayers?.[PRAYER];
    try{
        await open();initial=totals();await deposit();
        const planned=planPrayer(bankCount(),initialXp,o.maximum,o.reserve);
        while(buried<planned&&!goalReached()&&!over()){
            const batch=Math.min(planned-buried,28-inv().length);
            if(batch<1)throw new Error('no prayer progress: protected kit leaves no slots');
            const item=state()?.bank.items.find(i=>i.id===BONE);
            if(!item||!(await s.bot.withdrawItem(item,batch,{asNote:false})).success||!await waitUntil(s,()=>held()===batch,{timeoutTicks:8}))throw new Error('no prayer progress: bone withdrawal mismatch');
            await close();
            while(held()>0&&buried<planned&&!goalReached()&&!over()){
                await s.bot.dismissBlockingUI();
                if(goalReached()||over())break;
                const bone=inv().find(i=>i.id===BONE),option=bone?.optionsWithIndex.find(op=>/^bury$/i.test(op.text));
                // bury_bone.rs2:1 dispatches OPHELD1; no name-only/notes fallback.
                if(!bone||option?.opIndex!==1)throw new Error('no prayer progress: observed Bury1 option missing');
                const before=held(),beforeXp=xp();
                const sent=await s.sdk.sendUseItem(bone.slot,option.opIndex);attempts++;
                // STOP/CAP prohibit the next input, but cannot undo this packet.
                // Settle its actual debit AND XP before any bank/UI cleanup.
                await waitUntil(s,()=>held()<before&&xp()>beforeXp||ended||died,{timeoutTicks:8});
                const debit=before-held(),gain=xp()-beforeXp;
                buried+=Math.max(0,debit);
                if(!sent.success||debit!==1||gain<=0)throw new Error('no prayer progress: Bury debit/XP unobserved');
                if(firstBoneXp===undefined){firstBoneXp=gain;if(gain!==112&&gain!==113||initialXp===0&&gain!==112)throw new Error(`no prayer progress: unexpected first bone XP ${gain}`);phase=gain===113?0.5:0;}
                // UpdateStatEncoder floors raw tenths. The two25x phases give
                // 112/113 alternating; never round each bone independently.
                if(xp()!==initialXp+Math.floor(XP*buried+phase))throw new Error('no prayer progress: unexpected bone XP rate');
            }
            await open();await deposit();
        }
        stop=stopped()?'stop-file':goalReached()?'target-level':over()?(unsafe?'unsafe':'cap'):buried===o.maximum?'max-bury':'input-insufficient';
        if(goalReached()&&!over()){
            if(!await waitUntil(s,()=>level()>=GOAL,{timeoutTicks:5}))throw new Error('no prayer progress: goal level unobserved');
            await close();await s.bot.dismissBlockingUI();
            if(prayerOn()===undefined)throw new Error('no prayer progress: protection state unknown');
            if(!prayerOn())await s.direct({type:'togglePrayer',prayerIndex:PRAYER,reason:'verify Protect from Melee'});
            if(!await waitUntil(s,()=>prayerOn()===true&&(state()?.prayers.prayerPoints??0)>0||over(),{timeoutTicks:8})||prayerOn()!==true||(state()?.prayers.prayerPoints??0)<=0)throw new Error('no prayer progress: Protect from Melee ON/points unobserved');
            toggledOn=true;prayerPointsOn=state()!.prayers.prayerPoints;
        }
    }catch(e){failure=String(e);}
    finally{
        if(!ended&&!died){
            try{if(prayerOn()===true){await s.direct({type:'togglePrayer',prayerIndex:PRAYER,reason:'finish prayer verification OFF'});if(!await waitUntil(s,()=>prayerOn()===false,{timeoutTicks:8}))throw new Error('Protect from Melee OFF unobserved');}toggledOff=prayerOn()===false;}catch(e){failure||=`no prayer progress: ${String(e)}`;}
            try{await open();await deposit();}catch(e){failure||=`cleanup ${String(e)}`;}
        }
        off();
    }
    if(stopped())stop='stop-file';
    const final=totals(),initialBones=initial?.get(BONE)??0;
    const preserved=!!initial&&[...new Set([...initial.keys(),...final.keys()])].every(id=>(final.get(id)??0)===(initial!.get(id)??0)-(id===BONE?buried:0));
    if(!preserved||held()>0||bankCount()<o.reserve)failure||='no prayer progress: final bank/reserve/asset proof failed';
    const targetMet=!failure&&!ended&&!died&&!unsafe&&!stopped()&&level()>=GOAL&&toggledOn&&toggledOff&&preserved;
    return{ok:targetMet,targetMet,buried,attempts,initialBones,boneBank:bankCount(),heldBones:held(),consumed:initialBones-(final.get(BONE)??0),xpGain:xp()-initialXp,initialXp,finalXp:xp(),finalLevel:level(),firstBoneXp:firstBoneXp??0,rateVerified:firstBoneXp!==undefined&&!failure,toggledOn,toggledOff,prayerPointsOn,prayerPointsFinal:state()?.prayers?.prayerPoints??0,bankObservedAt,preserved,hpMin,died,stop,ticks:s.tick()-start,failure:failure||(!targetMet?'no prayer progress: bounded goal unmet':'-')};
}
if(import.meta.main){
    const name=process.argv[2];if(!name)throw new Error('prayer account required');let stopped=false;
    const s=await openBot(name,{onStop:async()=>{stopped=true;}}).catch(e=>finish([],false,`login: ${String(e)}`));
    try{const r=await runPrayer(s,{cap:Number(process.env.CAP??1500),maximum:Number(process.env.MAX_BURY??175),reserve:Number(process.env.BONE_RESERVE??6),stop:()=>stopped});console.log(`PRAYER_BANK ${JSON.stringify(r)}`);await finish([s],r.ok,`mode=prayer ${Object.entries(r).map(([k,v])=>`${k}=${v}`).join(' ')}`);}catch(e){await finish([s],false,String(e));}
}
