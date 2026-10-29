// One-time qualification for the mixed ore mine. Rat6 ignores players above combat12 outside the Wilderness
// (engine/entity/Npc.ts checkNotTooStrong). Train on Lumbridge chickens, then return the owned kit to its bank.
import {existsSync} from 'node:fs';
import {openBot,finish,randomEventsOf} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {walkPath,sessionWalker} from '../packages/core/src/walk';

// Both weapon tables train Attack/Strength/Defence at indices0/1/3. A bronze pickaxe has the same
// stab accuracy and strength bonus as the sword; qualify its slower attack rate in practice before live use.
export function chickenTrainingKit(items:readonly {id:number}[]):number[] {
    const has=(id:number)=>items.some(i=>i.id===id);
    const weapon=has(1277)?1277:has(1265)?1265:undefined;
    if(!weapon)throw Error('missing owned training weapon');
    return [weapon,...(has(1171)?[1171]:[])];
}

export function chickenTrainingStyle(levels:{Attack:number;Strength:number;Defence:number}):number {
    if(Object.values(levels).some(n=>!Number.isSafeInteger(n)||n<1))throw Error('training skills unavailable');
    const choices=[['Strength',1],['Attack',0],['Defence',3]] as const;
    return [...choices].sort((a,b)=>levels[a[0]]-levels[b[0]])[0]![1];
}
// Both directions checked against hunt ranges with a nine-tile wander/footprint margin before the live pilot.
const ROUTE=[{x:3253,z:3420,tol:2},{x:3207,z:3429,tol:0},{x:3171,z:3427,tol:0},
    {x:3200,z:3384,tol:0},{x:3198,z:3370,tol:0},{x:3200,z:3348,tol:0},
    {x:3200,z:3310,tol:0},{x:3230,z:3298,tol:0}];
const DRAYNOR_ROUTE=[{x:3092,z:3243,tol:2},...[[3092,3250],[3089,3266],[3088,3285],[3088,3320],[3180,3320],[3200,3310],[3230,3298]].map(([x,z])=>({x:x!,z:z!,tol:0}))];
export function chickenTrainingProfile(bank='varrock'){
    if(bank!=='varrock'&&bank!=='draynor')throw Error('unsupported training bank: '+bank);
    return{bank,route:bank==='draynor'?DRAYNOR_ROUTE:ROUTE};
}
export function chickenTrainingThreat(n:{name:string;distance:number},bank:string):boolean {
    // Draynor's wizards wander3 and hunt3; the bank is seven tiles from their spawn.
    // The same hunt3+one threshold already protected the native starter-kit staging route.
    if(bank==='draynor'&&/^dark wizard$/i.test(n.name))return n.distance<=4;
    return /^(giant rat|dark wizard|mugger|barbarian|highwayman|jail guard)$/i.test(n.name)&&n.distance<=8;
}

// The two qualifications serve the level6 mine rat and level14 island scorpion.
export function chickenTrainingTarget(target=13):number {
    if(target!==13&&target!==29)throw Error('training target must be13 or29');
    return target;
}

export async function trainChickens(s:Session,cap=1800,bank='varrock',target=13,options:{rawChicken?:number;stop?:()=>boolean}={}) {
    chickenTrainingTarget(target);
    const profile=chickenTrainingProfile(bank),route=profile.route,home=route[0]!;
    if(!Number.isSafeInteger(cap)||cap<1)throw Error('invalid training cap');
    const rawTarget=options.rawChicken??0;
    if(!Number.isSafeInteger(rawTarget)||rawTarget<0||rawTarget>12)throw Error('raw chicken target must be0..12');
    await waitTicks(s,3);
    const state=()=>s.sdk.getState(),pos=()=>state()?.player,hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    const combat=()=>pos()?.combatLevel??0,first=pos(),start=s.tick();
    if(!first||first.level!==0||Math.max(Math.abs(first.worldX-home.x),Math.abs(first.worldZ-home.z))>6)
        throw Error(`training requires ${bank} bank start`);
    if(hp()!==s.sdk.getSkill('Hitpoints')?.baseLevel||hp()<10)throw Error('training requires full HP');
    let hpMin=hp(),previousHP=hp(),hurt=false,ended=false,kills=0;
    s.ended.then(()=>{ended=true;});
    const off=s.onTick(()=>{const n=hp();hpMin=Math.min(hpMin,n);if(n<previousHP)hurt=true;previousHP=n;});
    const threat=()=>state()?.nearbyNpcs.find(n=>chickenTrainingThreat(n,bank));
    const over=()=>ended||hurt||!!options.stop?.()||!!threat()||s.tick()-start>=cap||existsSync(`.practice/stop-${s.name}`);
    const raw=()=>s.sdk.getInventory().filter(i=>i.id===2138).reduce((n,i)=>n+i.count,0);
    const assets=()=>{
        const totals=new Map<number,number>();
        for(const i of [...s.sdk.getInventory(),...s.sdk.getEquipment(),...(state()?.bank.items??[])])totals.set(i.id,(totals.get(i.id)??0)+i.count);
        return totals;
    };
    const xp=()=>['Attack','Strength','Defence'].reduce((n,name)=>n+(s.sdk.getSkillXp(name)??0),0);
    const walk=async(points:typeof ROUTE)=>{
        const r=await walkPath(await sessionWalker(s),points,{maxTicks:650,stop:over});
        if(!r.ok)throw Error(`no training progress: route ${r.detail}; hurt=${hurt} threat=${threat()?.name??'-'}`);
    };
    try {
        if(combat()>=target&&rawTarget===0)return{ok:true,combat:combat(),ticks:0,kills:0,hpMin,preserved:true};
        if(!(await s.bot.openBank()).success)throw Error('training bank unavailable');
        await waitTicks(s,2);const before=assets();
        const kit=chickenTrainingKit([...s.sdk.getInventory(),...s.sdk.getEquipment(),...(state()?.bank.items??[])]);
        for(const id of kit){
            if([...s.sdk.getInventory(),...s.sdk.getEquipment()].some(i=>i.id===id))continue;
            const item=state()?.bank.items.find(i=>i.id===id);
            if(!item||!(await s.bot.withdrawItem(item,1)).success)throw Error(`missing owned training kit ${id}`);
        }
        const pick=s.sdk.getInventory().find(i=>i.id===1265);
        if(pick&&!kit.includes(1265)&&!(await s.bot.depositItem(pick,-1)).success)throw Error('cannot secure owned pickaxe');
        await s.bot.closeBank();
        for(const id of kit)if(!s.sdk.getEquipment().some(i=>i.id===id)){
            const item=s.sdk.getInventory().find(i=>i.id===id);
            if(!item||!(await s.bot.equipItem(item)).success||!await waitUntil(s,()=>s.sdk.getEquipment().some(i=>i.id===id),{timeoutTicks:6}))
                throw Error('training kit not worn');
        }
        console.log(`MILESTONE training-outbound combat=${combat()} kit=${kit.join(',')}`);
        await walk(route.slice(1));
        let progress=s.tick(),lastXp=xp();
        while((combat()<target||raw()<rawTarget)&&!over()){
            if(xp()>lastXp){lastXp=xp();progress=s.tick();}
            if(s.tick()-progress>120)throw Error('no training progress: no melee XP for120ticks');
            if(randomEventsOf(s)?.busy()){await waitTicks(s,1);continue;}
            const style=chickenTrainingStyle({Attack:s.sdk.getSkill('Attack')?.baseLevel??0,
                Strength:s.sdk.getSkill('Strength')?.baseLevel??0,Defence:s.sdk.getSkill('Defence')?.baseLevel??0});
            if(state()?.combatStyle?.currentStyle!==style){
                if(!(await s.sdk.sendSetCombatStyle(style)).success||!await waitUntil(s,()=>state()?.combatStyle?.known===true&&state()?.combatStyle?.currentStyle===style,{timeoutTicks:6}))
                    throw Error('training style not confirmed');
            }
            const chicken=state()?.nearbyNpcs.filter(n=>/^chicken$/i.test(n.name)&&!n.inCombat&&(n.hp??1)>0&&n.reachable!==false
                &&n.x>=3223&&n.x<=3236&&n.z>=3293&&n.z<=3303).sort((a,b)=>a.distance-b.distance)[0];
            if(!chicken){await waitTicks(s,1);continue;}
            const op=chicken.optionsWithIndex.find(o=>/^attack$/i.test(o.text))?.opIndex;
            if(op===undefined){await waitTicks(s,1);continue;}
            const beforeXp=xp();
            await s.sdk.sendInteractNpc(chicken.index,op);
            await waitUntil(s,()=>over()||!state()?.nearbyNpcs.some(n=>n.index===chicken.index&&(n.hp??1)>0),{timeoutTicks:30});
            if(xp()>beforeXp&&!state()?.nearbyNpcs.some(n=>n.index===chicken.index&&(n.hp??1)>0)){
                kills++;
                if(raw()<rawTarget&&s.sdk.getInventory().length<28){
                    const loot=()=>state()?.groundItems.find(i=>i.id===2138&&Math.max(Math.abs(i.x-chicken.x),Math.abs(i.z-chicken.z))<=1);
                    await waitUntil(s,()=>over()||!!loot(),{timeoutTicks:6});
                    const item=loot(),before=raw();
                    if(item){await s.bot.pickupItem(item);if(!await waitUntil(s,()=>over()||raw()>before,{timeoutTicks:10}))throw Error('raw chicken pickup unobserved');}
                }
            }
            console.log(`MILESTONE training combat=${combat()} kills=${kills} xp=${xp()} hp=${hp()}`);
        }
        if(combat()<target||raw()<rawTarget||over())throw Error(`training incomplete combat=${combat()} target=${target} raw=${raw()}/${rawTarget} hurt=${hurt} threat=${threat()?.name??'-'}`);
        console.log(`MILESTONE training-return combat=${combat()}`);
        await walk([...route.slice(0,-1)].reverse());
        const wornPick=s.sdk.getEquipment().find(i=>i.id===1265);
        if(wornPick&&(!(await s.bot.unequipItem(wornPick)).success||!await waitUntil(s,()=>s.sdk.getInventory().some(i=>i.id===1265),{timeoutTicks:6})))
            throw Error('training pickaxe not returned to inventory');
        if(!(await s.bot.openBank()).success)throw Error('training return bank unavailable');
        await waitTicks(s,2);
        const tool=state()?.bank.items.find(i=>i.id===1265);
        if(tool&&!s.sdk.getInventory().some(i=>i.id===1265))await s.bot.withdrawItem(tool,1);
        await waitTicks(s,2);
        const after=assets(),preserved=[...before].every(([id,n])=>(after.get(id)??0)>=n);
        await s.bot.closeBank();
        const p=pos(),atBank=!!p&&p.level===0&&Math.max(Math.abs(p.worldX-home.x),Math.abs(p.worldZ-home.z))<=3;
        return{ok:combat()>=target&&atBank&&!hurt&&preserved,combat:combat(),ticks:s.tick()-start,kills,hpMin,preserved};
    } finally {off();}
}

if(import.meta.main){
    const bank=process.env.TRAIN_BANK??'varrock';chickenTrainingProfile(bank);
    const target=chickenTrainingTarget(Number(process.env.TRAIN_COMBAT??13));
    const s=await openBot(process.argv[2]!);
    try{const r=await trainChickens(s,Number(process.env.CAP??1800),bank,target);console.log('TRAINING '+JSON.stringify(r));await finish([s],r.ok,`${r.ok?'':'no training progress: '}chicken-qualification ${JSON.stringify(r)}`);}
    catch(e){await finish([s],false,'no training progress: '+String(e));}
}
