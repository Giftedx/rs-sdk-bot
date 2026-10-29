// Existing measured Draynor/East route plus qualified East/West approach.
import {openBot,finish} from '../packages/core/src/bot';import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';import {sessionWalker,walkPath,type PathDeps} from '../packages/core/src/walk';
import {guardCowWalker} from './gather-combat';import {relocationAssets,relocationPreserved,relocationStart} from './relocate-knight';
export function bankRelocationProfile(){return{name:'draynor-west',start:{x:3092,z:3243,radius:4},points:[[3092,3250],[3089,3266],[3100,3270],[3140,3270],[3180,3258],[3218,3256],[3242,3248],[3255,3295],[3255,3330],[3265,3350],[3265,3370],[3295,3370],[3290,3404],[3253,3420],[3212,3424],[3185,3436]]};}
export function completeBankPlan(plan:PathDeps['plan']):PathDeps['plan']{return(level,from,goal)=>{const corners=plan(level,from,goal),end=corners.at(-1);if(!end||end.x!==goal.x||end.z!==goal.z)throw Error('no relocation progress: incomplete waypoint plan');return corners;};}
export async function relocateBank(s:Session,options:{stop?:()=>boolean;walker?:PathDeps}={}){
    const profile=bankRelocationProfile(),state=()=>s.sdk.getState(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    if(!await waitUntil(s,()=>hp()>0&&!!state()?.player,{timeoutTicks:15}))throw new Error('no relocation progress: HP/position unknown');
    const first=state()!.player!,hpStart=hp(),start=s.tick();
    if(!relocationStart(first,profile))throw new Error('no relocation progress: explicit profile requires its known ground-floor bank start');
    if(!Array.isArray(state()?.equipment))throw new Error('no relocation progress: worn equipment unknown');
    if(state()?.skills.length!==21||state()!.skills.some(v=>!Number.isFinite(v.experience)))throw new Error('no relocation progress: all21 XP observations required');
    const observe=s.bankObservation?.bind(s);if(!observe)throw new Error('no relocation progress: fresh bank observation unavailable');
    let ended=false,died=false,damaged=false,hpMin=hpStart,failure='';
    const safety=()=>{const st=state(),p=st?.player;hpMin=Math.min(hpMin,hp());damaged||=hp()<hpStart;
        died||=!!p?.isDead||hp()<=0||(p?.respawnCount??0)>(first.respawnCount??0)||(first.lifeId!==undefined&&p?.lifeId!==first.lifeId);
        if(ended||died)return 'relocation ended/dead';if(damaged)return 'relocation first HP drop';if(options.stop?.())return 'relocation stop requested';
        if(!p||p.level!==0)return 'relocation unexpected floor';
        if(st?.nearbyNpcs.some(n=>/bear/i.test(n.name)&&n.distance<=6))return 'relocation observed bear within6';return null;};
    void s.ended.then(()=>{ended=true;});const off=s.onTick(safety);
    const open=async(generation:number)=>{if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!observe()&&(observe()?.generation??0)>generation,{timeoutTicks:20}))throw new Error('no relocation progress: fresh bank inventory unobserved');return observe()!;};
    const assets=()=>relocationAssets([...s.sdk.getInventory(),...s.sdk.getEquipment(),...(observe()?.items??[])]);
    const xp=()=>JSON.stringify((state()?.skills??[]).map(v=>[v.name,v.experience]));
    let initial:Map<number,number>|undefined,initialXp='',initialGeneration=0,finalGeneration=0,atBank=false,walkTicks=0,finalAssets:Map<number,number>|undefined;
    try{
        const initialBank=await open(observe()?.generation??0);initialGeneration=initialBank.generation;initial=assets();initialXp=xp();
        if(safety())throw new Error(`no relocation progress: ${safety()}`);
        const cash=s.sdk.getInventory().find(i=>i.id===995);
        if(cash){const amount=s.sdk.getInventory().filter(i=>i.id===995).reduce((n,i)=>n+i.count,0),before=initialBank.items.filter(i=>i.id===995).reduce((n,i)=>n+i.count,0);
            if(!(await s.bot.depositItem(cash,-1)).success||!await waitUntil(s,()=>!s.sdk.getInventory().some(i=>i.id===995)&&(observe()?.items.filter(i=>i.id===995).reduce((n,i)=>n+i.count,0)??-1)===before+amount,{timeoutTicks:10}))throw new Error('no relocation progress: held coins not fully secured');}
        if(!relocationPreserved(initial,assets()))throw new Error('no relocation progress: initial asset mismatch');
        await s.bot.closeBank();
        const walker=options.walker??await sessionWalker(s);walker.plan=completeBankPlan(walker.plan);const guard=guardCowWalker(walker,safety);
        const points=profile.points.map(([x,z])=>({x:x!,z:z!,tol:2}));
        const r=await walkPath(guard.deps,points,{look:6,maxTicks:900,stop:()=>!!guard.reason()});walkTicks=r.ticks;
        if(!r.ok||guard.reason())throw new Error(`no relocation progress: route ${guard.reason()??r.detail}`);
        const finalBank=await open(initialGeneration);finalGeneration=finalBank.generation;finalAssets=assets();
        const p=state()!.player!;atBank=p.level===0&&Math.max(Math.abs(p.worldX-3185),Math.abs(p.worldZ-3436))<=3;
    }catch(e){failure=String(e);}finally{off();}
    safety();const preserved=!!initial&&!!finalAssets&&relocationPreserved(initial,finalAssets),xpPreserved=!!initialXp&&initialXp===xp();
    const ok=!failure&&preserved&&xpPreserved&&atBank&&!ended&&!died&&!damaged&&!options.stop?.()&&finalGeneration>initialGeneration;
    return {ok,profile:profile.name,ticks:s.tick()-start,walkTicks,hpStart,hpMin,died,damaged,preserved,xpPreserved,atBank,initialGeneration,finalGeneration,
        position:state()?.player?{x:state()!.player!.worldX,z:state()!.player!.worldZ,level:state()!.player!.level}:null,
        inventory:s.sdk.getInventory(),equipment:s.sdk.getEquipment(),bank:observe()?.items??null,failure:failure||(!ok?'no relocation progress: final observation gate failed':'-')};
}

if(import.meta.main){let stopped=false;const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}}).catch(e=>finish([],false,String(e)));try{const r=await relocateBank(s,{stop:()=>stopped});console.log('BANK_RELOCATION '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));}catch(e){await finish([s],false,String(e));}}
