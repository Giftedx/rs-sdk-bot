// One-off owned bank relocation. No purchases, XP actions, player trades or repeat loop.
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {sessionWalker,walkPath,type PathDeps} from '../packages/core/src/walk';
import {guardCowWalker} from './gather-combat';

export function knightRelocationProfile(name:string){
    const key=name.toLowerCase();
    if(key==='pocketrocket')return {name:'Pocketrocket',start:{x:2727,z:3492,radius:6},points:[[2763,3472],[2800,3457],[2809,3441],[2677,3358],[2648,3358],[2654,3283]]};
    if(key==='mmtha0205')return {name:'mmtha0205',start:{x:2809,z:3441,radius:6},points:[[2809,3441],[2677,3358],[2648,3358],[2654,3283]]};
    if(key==='mightyrod')return {name:'Mightyrod',start:{x:2619,z:3332,radius:3},points:[[2644,3293],[2655,3283]]};
    throw new Error('no relocation progress: only Pocketrocket, mmtha0205 or Mightyrod are admitted');
}
export function relocationStart(p:{worldX:number;worldZ:number;level:number}|null|undefined,profile:ReturnType<typeof knightRelocationProfile>){
    return !!p&&p.level===0&&Math.max(Math.abs(p.worldX-profile.start.x),Math.abs(p.worldZ-profile.start.z))<=profile.start.radius;
}
export function relocationAssets(items:readonly{id:number;count:number}[]){const out=new Map<number,number>();for(const i of items)out.set(i.id,(out.get(i.id)??0)+i.count);return out;}
export function relocationPreserved(a:ReadonlyMap<number,number>,b:ReadonlyMap<number,number>){return [...new Set([...a.keys(),...b.keys()])].every(id=>(a.get(id)??0)===(b.get(id)??0));}

export async function relocateKnight(s:Session,name:string,options:{stop?:()=>boolean;walker?:PathDeps}={}){
    const profile=knightRelocationProfile(name),state=()=>s.sdk.getState(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    if(!await waitUntil(s,()=>hp()>0&&!!state()?.player,{timeoutTicks:15}))throw new Error('no relocation progress: HP/position unknown');
    const first=state()!.player!,hpStart=hp(),start=s.tick();
    if(!relocationStart(first,profile))throw new Error('no relocation progress: explicit profile requires its known ground-floor bank start');
    if(!Array.isArray(state()?.equipment))throw new Error('no relocation progress: worn equipment unknown');
    if(state()?.skills.length!==21||state()!.skills.some(v=>!Number.isFinite(v.experience)))throw new Error('no relocation progress: all21 XP observations required');
    const observe=s.bankObservation?.bind(s);if(!observe)throw new Error('no relocation progress: fresh bank observation unavailable');
    let ended=false,died=false,damaged=false,hpMin=hpStart,failure='';
    const safety=()=>{const st=state(),p=st?.player;hpMin=Math.min(hpMin,hp());damaged||=hp()<hpStart;
        died||=!!p?.isDead||(p?.respawnCount??0)>(first.respawnCount??0)||(first.lifeId!==undefined&&(p?.lifeId ?? first.lifeId) !== first.lifeId);
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
        const guard=guardCowWalker(options.walker??await sessionWalker(s),safety);
        const points=profile.points.map(([x,z])=>({x:x!,z:z!,tol:2}));
        const r=await walkPath(guard.deps,points,{look:6,maxTicks:750,stop:()=>!!guard.reason()});walkTicks=r.ticks;
        if(!r.ok||guard.reason())throw new Error(`no relocation progress: route ${guard.reason()??r.detail}`);
        const finalBank=await open(initialGeneration);finalGeneration=finalBank.generation;finalAssets=assets();
        const p=state()!.player!;atBank=p.level===0&&[3283,3286].some(z=>Math.max(Math.abs(p.worldX-2656),Math.abs(p.worldZ-z))<=1);
    }catch(e){failure=String(e);}finally{off();}
    safety();const preserved=!!initial&&!!finalAssets&&relocationPreserved(initial,finalAssets),xpPreserved=!!initialXp&&initialXp===xp();
    const ok=!failure&&preserved&&xpPreserved&&atBank&&!ended&&!died&&!damaged&&!options.stop?.()&&finalGeneration>initialGeneration;
    return {ok,profile:profile.name,ticks:s.tick()-start,walkTicks,hpStart,hpMin,died,damaged,preserved,xpPreserved,atBank,initialGeneration,finalGeneration,
        position:state()?.player?{x:state()!.player!.worldX,z:state()!.player!.worldZ,level:state()!.player!.level}:null,
        inventory:s.sdk.getInventory(),equipment:s.sdk.getEquipment(),bank:observe()?.items??null,failure:failure||(!ok?'no relocation progress: final observation gate failed':'-')};
}

if(import.meta.main){
    const name=process.argv[2];knightRelocationProfile(name??'');let stopped=false;
    const s=await openBot(name!,{onStop:async()=>{stopped=true;}}).catch(e=>finish([],false,`login: ${String(e)}`));
    try{const r=await relocateKnight(s,name!,{stop:()=>stopped});console.log('KNIGHT_RELOCATION '+JSON.stringify(r));await finish([s],r.ok,`relocation ok=${r.ok} profile=${r.profile} ticks=${r.ticks} hpMin=${r.hpMin} preserved=${r.preserved} xpPreserved=${r.xpPreserved} died=${r.died} failure=${r.failure}`);}catch(e){await finish([s],false,String(e));}
}
