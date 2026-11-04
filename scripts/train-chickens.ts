// One-time qualification for the mixed ore mine. Rat6 ignores players above combat12 outside the Wilderness
// (engine/entity/Npc.ts checkNotTooStrong). Train on Lumbridge chickens, then return the owned kit to its bank.
import {existsSync} from 'node:fs';
import {openBot,finish,randomEventsOf} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {walkPath,sessionWalker,expandPath,type PathDeps,type PathTile} from '../packages/core/src/walk';

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
const ARDOUGNE_ROUTE=[{x:2654,z:3283,tol:2},{x:2664,z:3283,tol:0},{x:2678,z:3282,tol:0},{x:2691,z:3277,tol:0}];
export function chickenTrainingProfile(bank='varrock'){
    if(!['varrock','draynor','ardougne'].includes(bank))throw Error('unsupported training bank: '+bank);
    return{bank,route:bank==='ardougne'?ARDOUGNE_ROUTE:bank==='draynor'?DRAYNOR_ROUTE:ROUTE,
        pen:bank==='ardougne'?{x0:2686,x1:2700,z0:3268,z1:3283}:{x0:3223,x1:3236,z0:3293,z1:3303}};
}
// This rectangle keeps the short bank/farm journey away from the west-bank bear and northern guards.
export const ardougneTrainingTile=(p:PathTile)=>p.x>=2644&&p.x<=2703&&p.z>=3264&&p.z<=3290;
export function guardArdougneTrainingWalker(base:PathDeps){
    let reason:string|null=null;
    const validate=(level:number,from:PathTile,to:PathTile,corners:PathTile[])=>{
        const end=corners.at(-1);
        if(level!==0||!ardougneTrainingTile(from)||!ardougneTrainingTile(to)
            ||(!end&&(from.x!==to.x||from.z!==to.z))||end&&Math.max(Math.abs(end.x-to.x),Math.abs(end.z-to.z))>1
            ||expandPath(from,corners).some(p=>!ardougneTrainingTile(p))){reason='Ardougne training route outside admitted corridor or incomplete '+JSON.stringify({level,from,to,end,unsafe:expandPath(from,corners).find(p=>!ardougneTrainingTile(p))});return false;}
        return true;
    };
    const refuse=()=>({success:false,phase:'dispatch',reason:'training_route_guard',message:reason??'training route unknown'});
    const deps:PathDeps={...base,plan:(level,from,to)=>{const path=base.plan(level,from,to);return validate(level,from,to,path)?path:[];},
        walk:(x,z)=>{const p=base.pos();return !p||reason||!validate(p.level,p,{x,z},base.plan(p.level,p,{x,z}))?refuse():base.walk(x,z);},
        interactLoc:(loc,op)=>reason?refuse():base.interactLoc(loc,op)};
    return {deps,reason:()=>reason};
}
export function chickenTrainingHealth(bank:string,current:number,maximum:number){
    if(!Number.isSafeInteger(current)||!Number.isSafeInteger(maximum)||current>maximum
        ||(bank==='ardougne'?current<27:current!==maximum||current<10))
        throw Error(bank==='ardougne'?'Ardougne training requires at least27 current HP; damage budget is zero':'training requires full HP');
}
export function chickenStrengthGoal(bank:string,skill:string|undefined,level:number|undefined){
    if(skill===undefined&&level===undefined){if(bank==='ardougne')throw Error('Ardougne training needs explicit Strength target');return undefined;}
    if(skill!=='Strength'||!Number.isSafeInteger(level)||level!<1||level!>99)throw Error('training accepts an explicit Strength target1..99');
    return level;
}
export function chickenTrainingThreat(n:{name:string;distance:number},bank:string):boolean {
    // Draynor's wizards wander3 and hunt3; the bank is seven tiles from their spawn.
    // The same hunt3+one threshold already protected the native starter-kit staging route.
    if(bank==='draynor'&&/^dark wizard$/i.test(n.name))return n.distance<=4;
    if(bank==='ardougne'&&/^bear$/i.test(n.name))return n.distance<=4; // observed NPC: hunt1 + size2 + one margin
    if(bank==='ardougne'&&/^(giant bat|wolf|white wolf|scorpion)$/i.test(n.name))return n.distance<=8;
    return /^(giant rat|dark wizard|mugger|barbarian|highwayman|jail guard)$/i.test(n.name)&&n.distance<=8;
}

// The two qualifications serve the level6 mine rat and level14 island scorpion.
export function chickenTrainingTarget(target=13):number {
    if(target!==13&&target!==29)throw Error('training target must be13 or29');
    return target;
}

export async function trainChickens(s:Session,cap=1800,bank='varrock',target=13,options:{rawChicken?:number;stop?:()=>boolean;trainSkill?:string;targetLevel?:number}={}) {
    chickenTrainingTarget(target);
    const profile=chickenTrainingProfile(bank),route=profile.route,home=route[0]!,strengthTarget=chickenStrengthGoal(bank,options.trainSkill,options.targetLevel);
    if(!Number.isSafeInteger(cap)||cap<1)throw Error('invalid training cap');
    const rawTarget=options.rawChicken??0;
    if(!Number.isSafeInteger(rawTarget)||rawTarget<0||rawTarget>12)throw Error('raw chicken target must be0..12');
    await waitTicks(s,3);
    const state=()=>s.sdk.getState(),pos=()=>state()?.player,hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    const combat=()=>pos()?.combatLevel??0,first=pos(),start=s.tick();
    if(!first||first.level!==0||Math.max(Math.abs(first.worldX-home.x),Math.abs(first.worldZ-home.z))>6)
        throw Error(`training requires ${bank} bank start`);
    chickenTrainingHealth(bank,hp(),s.sdk.getSkill('Hitpoints')?.baseLevel??0);
    if(strengthTarget!==undefined){const level=(name:string)=>s.sdk.getSkill(name)?.baseLevel??0;const projected=Math.floor(.25*(level('Defence')+level('Hitpoints')+Math.floor(level('Prayer')/2))+.325*(level('Attack')+strengthTarget));
        if(projected<target)throw Error('Strength target cannot establish the requested combat unlock');}
    const goal=()=>combat()>=target&&(strengthTarget===undefined||(s.sdk.getSkill('Strength')?.baseLevel??0)>=strengthTarget);
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
        const base=await sessionWalker(s),guarded=bank==='ardougne'?guardArdougneTrainingWalker(base):null;
        const r=await walkPath(guarded?.deps??base,points,{maxTicks:Math.max(1,Math.min(650,cap-(s.tick()-start))),stop:over});
        if(!r.ok)throw Error(`no training progress: route ${r.detail}; hurt=${hurt} threat=${threat()?.name??'-'}`);
    };
    try {
        if(goal()&&rawTarget===0)return{ok:true,combat:combat(),ticks:0,kills:0,hpMin,preserved:true};
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
        while((!goal()||raw()<rawTarget)&&!over()){
            if(xp()>lastXp){lastXp=xp();progress=s.tick();}
            if(s.tick()-progress>120)throw Error('no training progress: no melee XP for120ticks');
            if(randomEventsOf(s)?.busy()){await waitTicks(s,1);continue;}
            const style=strengthTarget===undefined?chickenTrainingStyle({Attack:s.sdk.getSkill('Attack')?.baseLevel??0,
                Strength:s.sdk.getSkill('Strength')?.baseLevel??0,Defence:s.sdk.getSkill('Defence')?.baseLevel??0}):1;
            if(state()?.combatStyle?.currentStyle!==style){
                if(!(await s.sdk.sendSetCombatStyle(style)).success||!await waitUntil(s,()=>state()?.combatStyle?.known===true&&state()?.combatStyle?.currentStyle===style,{timeoutTicks:6}))
                    throw Error('training style not confirmed');
            }
            const chicken=state()?.nearbyNpcs.filter(n=>/^chicken$/i.test(n.name)&&!n.inCombat&&(n.hp??1)>0&&n.reachable!==false
                &&n.x>=profile.pen.x0&&n.x<=profile.pen.x1&&n.z>=profile.pen.z0&&n.z<=profile.pen.z1).sort((a,b)=>a.distance-b.distance)[0];
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
        if(!goal()||raw()<rawTarget||over())throw Error(`training incomplete combat=${combat()} target=${target} raw=${raw()}/${rawTarget} hurt=${hurt} threat=${threat()?.name??'-'}`);
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
        return{ok:goal()&&atBank&&!hurt&&preserved,combat:combat(),strength:s.sdk.getSkill('Strength')?.baseLevel,ticks:s.tick()-start,kills,hpMin,preserved,atBank,position:p&&{x:p.worldX,z:p.worldZ,level:p.level}};
    } finally {off();}
}

if(import.meta.main){
    const bank=process.env.TRAIN_BANK??'varrock';chickenTrainingProfile(bank);
    const target=chickenTrainingTarget(Number(process.env.TRAIN_COMBAT??13));
    const trainSkill=process.env.TRAIN_SKILL,targetLevel=process.env.TARGET_LEVEL===undefined?undefined:Number(process.env.TARGET_LEVEL);chickenStrengthGoal(bank,trainSkill,targetLevel);
    const s=await openBot(process.argv[2]!);
    try{const r=await trainChickens(s,Number(process.env.CAP??1800),bank,target,{trainSkill,targetLevel});console.log('TRAINING '+JSON.stringify(r));await finish([s],r.ok,`${r.ok?'':'no training progress: '}chicken-qualification ${JSON.stringify(r)}`);}
    catch(e){await finish([s],false,'no training progress: '+String(e));}
}
