// bun scripts/train-prayer.ts <account> [target, default43]
// Owned Bones526 by default; BONE_ID=532 buries owned big bones and BONE_ID=536 dragon bones. MAX_BURY=175,
// BONE_RESERVE=6, CAP=1500 ticks by default.
import {openBot,finish,getWorld,accountOf} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {xpForLevel} from '../packages/planner/src/curve';
import {walkPath,sessionWalker,goTo,type PathPoint} from '../packages/core/src/walk';
import {ferryWalk} from './walk-to';

const BONE=526,PRAYER=14;
// Server XP per bury at 25x: bones 4.5, big bones 15, dragon bones 72 (bones.obj bone_exp, in tenths).
export const BONE_XP:Record<number,number>={526:112.5,532:375,536:1800};
// held (BURY_HELD=1): bury the bones the account holds above the reserve, up to the target; ok when they run out
// after at least one bury. Each bury's XP is checked, so a batch too small for a level is still proved work: from 96
// a level is about 60,000 XP, more than 100 bones give. The PK army's Prayer bands run this with a static target of 99.
export interface PrayerOptions{target?:number;cap:number;maximum:number;reserve:number;bone?:number;held?:boolean;stop?:()=>boolean}
export function prayerOptions(argv:string[]=process.argv,env:Record<string,string|undefined>=process.env):PrayerOptions{
    const bone=Number(env.BONE_ID??BONE),held=env.BURY_HELD==='1';
    return{target:Number(argv[3]??env.TARGET_LEVEL??43),cap:Number(env.CAP??1500),maximum:Number(env.MAX_BURY??(held?1000000:175)),reserve:Number(env.BONE_RESERVE??6),...bone===BONE?{}:{bone},...held?{held}:{}};
}
export function planPrayer(bones:number,xp:number,maximum=175,reserve=6,target=43,each=BONE_XP[BONE]!){return Math.max(0,Math.min(maximum,bones-reserve,Math.ceil((xpForLevel(target)-xp)/each)));}
// The ordinary Lumbridge road uses the shared collision, door and danger-aware walker.
// Bank service tiles: banking.md / walking.md; the old Ardougne callers stay bank-side.
export function prayerBank(p:{worldX:number;worldZ:number;level:number}){
    const near=(x:number,z:number,n:number)=>p.level===0&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=n;
    if(near(2655,3283,3))return{x:2655,z:3283};
    // Ardougne north, the PK army's home bank (scripts/cow-stage.ts). It walks there from the market knights, the cow
    // field and the Gnome battlefield, where a trooper run that lost its session stops (2525,3242 is 94 tiles away).
    if(near(2619,3332,150))return{x:2619,z:3332};
    if(near(3185,3436,3))return{x:3185,z:3436}; // Varrock West, where GE purchases settle
    if(near(3092,3243,220))return{x:3092,z:3243};
    throw Error('no prayer progress: unsupported ordinary bank entry');
}
type Approach=(s:Session,points:PathPoint[],cap:number,stop:()=>boolean)=>Promise<boolean>;
// A single-point approach from more than 60 tiles plans with the world walker first, as shop-buyer does.
const approach:Approach=async(s,points,cap,stop)=>{
    const last=points.at(-1)!,p=s.sdk.getState()?.player;
    if(points.length===1&&p&&Math.max(Math.abs(p.worldX-last.x),Math.abs(p.worldZ-last.z))>60
        &&!(await ferryWalk(s,{x:last.x,z:last.z,level:0},async(tile,planBudgetMs)=>goTo(s,await getWorld(),tile,accountOf(s),{legTimeoutTicks:100,planBudgetMs}))).ok)return false;
    return (await walkPath(await sessionWalker(s),points,{maxTicks:cap,stop})).ok;
};
export async function runPrayer(s:Session,o:PrayerOptions,walk:Approach=approach){
    const goal=o.target??43,targetXp=xpForLevel(goal),BONE=o.bone??526,XP=BONE_XP[BONE];
    if(XP===undefined)throw new Error('no prayer progress: unsupported bone id');
    if(!Number.isSafeInteger(goal)||goal<43||goal>99||!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>1000000||!Number.isSafeInteger(o.maximum)||o.maximum<1||o.maximum>1000000||!Number.isSafeInteger(o.reserve)||o.reserve<6)throw new Error('no prayer progress: invalid bounded limits');
    const state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory();
    const count=(items:readonly{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const held=()=>count(inv(),BONE),xp=()=>s.sdk.getSkillXp('Prayer')??0,level=()=>s.sdk.getSkill('Prayer')?.baseLevel??0,hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    if(!await waitUntil(s,()=>!!state()?.player&&hp()>0&&level()>0&&s.sdk.getSkillXp('Prayer')!==null,{timeoutTicks:15}))throw new Error('no prayer progress: unknown skills');
    const p0=state()?.player,start=s.tick(),initialXp=xp(),initialHp=hp(),initialLevel=level();
    if(!p0)throw new Error('no prayer progress: unknown entry');
    const bank=prayerBank(p0),nearBank=()=>{const p=state()?.player;return !!p&&p.level===0&&Math.max(Math.abs(p.worldX-bank.x),Math.abs(p.worldZ-bank.z))<=2;};
    const carried=()=>[...inv(),...s.sdk.getEquipment()].map(i=>({id:i.id,count:i.count,slot:i.slot}));
    const worn=()=>s.sdk.getEquipment().map(i=>({id:i.id,count:i.count,slot:i.slot}));
    const entryCarried=JSON.stringify(carried()),entryEquipment=JSON.stringify(worn());
    console.log('PRAYER_ENTRY '+JSON.stringify({position:{x:p0.worldX,z:p0.worldZ,level:p0.level},xp:initialXp,hp:initialHp,target:goal,cap:o.cap,maximum:o.maximum,reserve:o.reserve}));
    let travelling=!nearBank();
    let ended=false,died=false,unsafe=false,stopRequested=false,hpMin=hp(),buried=0,attempts=0,failure='',stop='input-insufficient',firstBoneXp:number|undefined,phase=0;
    let toggledOn=false,toggledOff=false,prayerPointsOn=0,bankObservedAt:number|undefined;
    let snapshot:{id:number;count:number}[]|undefined,initial:Map<number,number>|undefined;
    const bankCount=()=>count(snapshot??[],BONE),goalReached=()=>level()>=goal||xp()>=targetXp;
    const stopped=()=>stopRequested||=!!o.stop?.();
    const off=s.onTick(()=>{stopped();const p=state()?.player;hpMin=Math.min(hpMin,hp());if(hp()<=0||p?.isDead||p?.lifeId!==p0.lifeId||(p?.respawnCount??0)>(p0.respawnCount??0))died=true;if(hp()<initialHp||!p||p.level!==0||!travelling&&!nearBank())unsafe=true;});
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
        if(travelling){
            if(over())throw Error('no prayer progress: stopped before bank travel');
            await s.bot.dismissBlockingUI();
            const points:PathPoint[]=p0.worldX>=3180?[{x:3180,z:3270,tol:2},{x:3140,z:3270,tol:2},{x:3100,z:3270,tol:2},{x:3089,z:3266,tol:2},{x:3092,z:3250,tol:1},{...bank,tol:1}]:[{...bank,tol:1}];
            if(!await walk(s,points,Math.min(400,o.cap-(s.tick()-start)),over)||!nearBank()||over())throw Error('no prayer progress: ordinary bank travel failed');
            travelling=false;
        }
        if(over())throw Error('no prayer progress: stopped before bank work');
        if(JSON.stringify(carried())!==entryCarried)throw Error('no prayer progress: entry assets changed during travel');
        await open();initial=totals();await deposit();
        const demand=Math.max(0,Math.ceil((targetXp-initialXp)/XP));
        if(!o.held&&bankCount()-o.reserve<demand)throw Error(`no prayer progress: insufficient owned bones: need ${demand}, available ${Math.max(0,bankCount()-o.reserve)}`);
        if(!o.held&&o.maximum<demand)throw Error(`no prayer progress: MAX_BURY ${o.maximum} below demand ${demand}`);
        const planned=planPrayer(bankCount(),initialXp,o.maximum,o.reserve,goal,XP);
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
                if(firstBoneXp===undefined){firstBoneXp=gain;const low=Math.floor(XP),high=Math.ceil(XP);if(gain!==low&&gain!==high||initialXp===0&&gain!==low)throw new Error(`no prayer progress: unexpected first bone XP ${gain}`);phase=gain===high&&high!==low?XP-low:0;}
                // UpdateStatEncoder floors raw tenths. The two25x phases give
                // 112/113 alternating; never round each bone independently.
                if(xp()!==initialXp+Math.floor(XP*buried+phase))throw new Error('no prayer progress: unexpected bone XP rate');
            }
            await open();await deposit();
        }
        stop=stopped()?'stop-file':goalReached()?'target-level':over()?(unsafe?'unsafe':'cap'):buried===o.maximum?'max-bury':'input-insufficient';
        if(goalReached()&&!over()){
            if(!await waitUntil(s,()=>level()>=goal,{timeoutTicks:5}))throw new Error('no prayer progress: goal level unobserved');
            await close();await s.bot.dismissBlockingUI();
            if(prayerOn()===undefined)throw new Error('no prayer progress: protection state unknown');
            if(!prayerOn())await s.direct({type:'togglePrayer',prayerIndex:PRAYER,reason:'verify Protect from Melee'});
            if(!await waitUntil(s,()=>prayerOn()===true&&(state()?.prayers.prayerPoints??0)>0||over(),{timeoutTicks:8})||prayerOn()!==true||(state()?.prayers.prayerPoints??0)<=0)throw new Error('no prayer progress: Protect from Melee ON/points unobserved');
            toggledOn=true;prayerPointsOn=state()!.prayers.prayerPoints;
        }
    }catch(e){failure=e instanceof Error?e.message:String(e);}
    finally{
        if(!ended&&!died){
            try{if(prayerOn()===true){await s.direct({type:'togglePrayer',prayerIndex:PRAYER,reason:'finish prayer verification OFF'});if(!await waitUntil(s,()=>prayerOn()===false,{timeoutTicks:8}))throw new Error('Protect from Melee OFF unobserved');}toggledOff=prayerOn()===false;}catch(e){failure||=`no prayer progress: ${String(e)}`;}
            try{if(initial&&nearBank()){await open();await deposit();}}catch(e){failure||=`cleanup ${String(e)}`;}
        }
        off();
    }
    if(stopped())stop='stop-file';
    const final=totals(),initialBones=initial?.get(BONE)??0;
    const preserved=!!initial&&[...new Set([...initial.keys(),...final.keys()])].every(id=>(final.get(id)??0)===(initial!.get(id)??0)-(id===BONE?buried:0));
    const equipmentPreserved=JSON.stringify(worn())===entryEquipment;
    if(!preserved||!equipmentPreserved||held()>0||bankCount()<o.reserve)failure||='no prayer progress: final bank/reserve/asset proof failed';
    const targetMet=!failure&&!ended&&!died&&!unsafe&&!stopped()&&level()>=goal&&xp()>=targetXp&&nearBank()&&toggledOn&&toggledOff&&preserved;
    // Held mode: the bones ran out after at least one bury, with the same safety and asset proof as a met target.
    const gained=level()-initialLevel,bonesOut=!!o.held&&stop==='input-insufficient'&&buried>0&&held()===0;
    const heldOk=bonesOut&&!failure&&!ended&&!died&&!unsafe&&!stopped()&&nearBank()&&preserved;
    return{ok:targetMet||heldOk,gained,targetMet,target:goal,buried,attempts,initialBones,boneBank:bankCount(),heldBones:held(),consumed:initialBones-(final.get(BONE)??0),xpGain:xp()-initialXp,initialXp,finalXp:xp(),finalLevel:level(),firstBoneXp:firstBoneXp??0,rateVerified:firstBoneXp!==undefined&&!failure,toggledOn,toggledOff,prayerPointsOn,prayerPointsFinal:state()?.prayers?.prayerPoints??0,bankObservedAt,preserved,equipmentPreserved,hpMin,died,stop,ticks:s.tick()-start,failure:failure||(!targetMet&&!heldOk?'no prayer progress: bounded goal unmet':'-')};
}
if(import.meta.main){
    const name=process.argv[2];if(!name)throw new Error('prayer account required');let stopped=false;
    const s=await openBot(name,{onStop:async()=>{stopped=true;}}).catch(e=>finish([],false,`login: ${String(e)}`));
    try{const r=await runPrayer(s,{...prayerOptions(),stop:()=>stopped});console.log(`PRAYER_BANK ${JSON.stringify(r)}`);await finish([s],r.ok,`mode=prayer ${Object.entries(r).map(([k,v])=>`${k}=${v}`).join(' ')}`);}catch(e){await finish([s],false,String(e));}
}
