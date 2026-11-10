// Magic for the PK army: alchemy on a cheap stackable item from the Ardougne north bank, the army's home bank.
// bun scripts/alch-train.ts <account> <TARGET_LEVEL> [CAP ticks=5000]. Env: ALCH_ITEM (debugname, default feather).
// Low Alchemy until Magic 55, then High Alchemy to the target. It walks to the bank from anywhere, banks the pack,
// takes the nature runes, the fire runes (none with a fire staff, which it wields) and the item, and casts in place.
// Prints ALCH_RESULT and a RESULT line with level=, gained= and xp=; ok when the target is met, or when the bank's
// supplies ran out after at least one level. A failure after real casts still reports their XP.
// Rates: High Alchemy 65 and Low Alchemy 31 base XP (skill_magic/configs/magic_spells.dbrow) at xpRate 25.
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {xpForLevel} from '../packages/planner/src/curve';
import {itemMagicRecipe,runItemMagic} from './microbot-magic-items';
import {COW_NORTH_BANK,atNorthBank} from './cow-stage';

type Item={id:number;count:number};
export const NATURE=561,FIRE=554,HIGH_LEVEL=55;
export const CAST_XP={'low-alch':775,'high-alch':1625} as const;
const FIRE_PER={'low-alch':3,'high-alch':5} as const;
// Staff of fire, fire battlestaff, mystic fire staff (skill_magic/configs/magic_staff.dbrow).
export const FIRE_STAVES=[1387,1393,1401];
const count=(items:readonly Item[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);

// Casts of each spell from this XP to the target level: Low Alchemy below 55, High Alchemy from 55.
export function alchCasts(xp:number,target:number){
    const goal=xpForLevel(target),gate=xpForLevel(HIGH_LEVEL);
    const low=xp<gate?Math.ceil((Math.min(goal,gate)-xp)/CAST_XP['low-alch']):0;
    const high=target>HIGH_LEVEL?Math.ceil((goal-Math.max(xp,Math.min(goal,gate)))/CAST_XP['high-alch']):0;
    return{low:Math.max(0,low),high:Math.max(0,high)};
}

// The withdrawals for those casts, capped by the bank. With a fire staff worn or taken, no fire runes.
export function alchStagePlan(casts:{low:number;high:number},carried:readonly Item[],bank:readonly Item[],item:number){
    const staff=FIRE_STAVES.find(id=>count(carried,id)>0)??FIRE_STAVES.find(id=>count(bank,id)>0);
    const want:Item[]=[{id:NATURE,count:casts.low+casts.high},{id:item,count:casts.low+casts.high}];
    if(staff===undefined)want.push({id:FIRE,count:casts.low*FIRE_PER['low-alch']+casts.high*FIRE_PER['high-alch']});
    const take:Item[]=[];
    if(staff!==undefined&&count(carried,staff)<1)take.push({id:staff,count:1});
    for(const w of want){const n=Math.min(Math.max(0,w.count-count(carried,w.id)),count(bank,w.id));if(n>0)take.push({id:w.id,count:n});}
    return{staff,take};
}

// How many casts of a spell the carried supplies pay for.
export function castsHeld(mode:'low-alch'|'high-alch',carried:readonly Item[],item:number,staff:boolean){
    return Math.min(count(carried,NATURE),count(carried,item),staff?Infinity:Math.floor(count(carried,FIRE)/FIRE_PER[mode]));
}

export async function stageAlch(s:Session,o:{target:number;item:number;walk:(x:number,z:number)=>Promise<boolean>;stop?:()=>boolean}){
    const state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),carried=()=>[...inv(),...(state()?.equipment??[])];
    if(!await waitUntil(s,()=>!!state()?.player&&s.sdk.getSkillXp('Magic')!==null,{timeoutTicks:15}))throw new Error('alch stage: position unknown');
    if(!atNorthBank(state()?.player)){
        if(o.stop?.())throw new Error('alch stage: stop requested');
        if(!await o.walk(COW_NORTH_BANK.x,COW_NORTH_BANK.z)||!atNorthBank(state()?.player))throw new Error('alch stage: walk to Ardougne north bank failed');
    }
    const observe=s.bankObservation?.bind(s),generation=observe?.()?.generation??0;
    if(!observe)throw new Error('alch stage: fresh bank observation unavailable');
    if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank?.isOpen&&(observe()?.generation??0)>generation,{timeoutTicks:20}))throw new Error('alch stage: bank did not open');
    const keep=new Set([NATURE,FIRE,o.item,...FIRE_STAVES]);
    for(const row of [...inv()].filter(i=>!keep.has(i.id))){
        if(o.stop?.())throw new Error('alch stage: stop requested');
        const id=row.id,before=count(inv(),id);
        if(before<1)continue;
        if(!(await s.bot.depositItem(row,before)).success||!await waitUntil(s,()=>count(inv(),id)===0,{timeoutTicks:10}))throw new Error(`alch stage: deposit ${id} failed`);
    }
    const plan=alchStagePlan(alchCasts(s.sdk.getSkillXp('Magic')??0,o.target),carried(),observe()?.items??[],o.item);
    for(const want of plan.take){
        if(o.stop?.())throw new Error('alch stage: stop requested');
        const row=(state()?.bank?.items??[]).find(i=>i.id===want.id),before=count(inv(),want.id);
        if(!row||!(await s.bot.withdrawItem(row,want.count,{asNote:false})).success||!await waitUntil(s,()=>count(inv(),want.id)>=before+want.count,{timeoutTicks:10}))
            throw new Error(`alch stage: withdraw ${want.count}x${want.id} failed`);
    }
    await s.bot.closeBank();
    // The spell needs the side tabs back; a cast sent while the bank's inventory panel shows is dropped.
    if(!await waitUntil(s,()=>!state()?.bank?.isOpen,{timeoutTicks:10}))throw new Error('alch stage: bank did not close');
    await waitTicks(s,2);
    const worn=()=>(state()?.equipment??[]).some(i=>FIRE_STAVES.includes(i.id));
    if(plan.staff!==undefined&&!worn()){
        const row=inv().find(i=>i.id===plan.staff);
        if(!row||!(await s.bot.equipItem(row)).success||!await waitUntil(s,worn,{timeoutTicks:5}))throw new Error('alch stage: fire staff not wielded');
    }
    return{took:plan.take,staff:worn()};
}

export async function runAlch(s:Session,o:{target:number;cap:number;item:string;stop?:()=>boolean;walk:(x:number,z:number)=>Promise<boolean>}){
    if(!Number.isSafeInteger(o.target)||o.target<22||o.target>99||!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>100000)throw new Error('alch: invalid target or cap');
    const item=itemMagicRecipe('high-alch',o.item).target,start=s.tick(),level=()=>s.sdk.getSkill('Magic')?.baseLevel??0,xp=()=>s.sdk.getSkillXp('Magic')??0;
    const casts={'low-alch':0,'high-alch':0};let stop='target',failure='',startLevel:number|undefined,startXp:number|undefined;
    try{
        const staged=await stageAlch(s,{target:o.target,item,walk:o.walk,stop:o.stop});
        console.log(`ALCH_STAGE ${JSON.stringify(staged)}`);
        startLevel=level();startXp=xp();
        while(level()<o.target){
            const mode=level()<HIGH_LEVEL?'low-alch':'high-alch',left=o.cap-(s.tick()-start);
            if(left<1){stop='cap';break;}
            if(o.stop?.()){stop='stopped';break;}
            const carried=[...s.sdk.getInventory(),...(s.sdk.getState()?.equipment??[])];
            const need=alchCasts(xp(),o.target),n=Math.min(mode==='low-alch'?need.low:need.high,castsHeld(mode,carried,item,staged.staff));
            if(n<1){stop='supplies';break;}
            const r=await runItemMagic(s,itemMagicRecipe(mode,o.item),{count:n,cap:left,stop:o.stop});
            casts[mode]+=r.casts;
            if(!r.ok){stop=r.stop;break;}
            // The last cast's level-up dialog stays open: a dismiss sent inside the spell's delay is dropped, and the next
            // spell under the open dialog does nothing (practice: the switch to High Alchemy at 55).
            await waitTicks(s,4);
            for(let n=0;n<5&&s.sdk.getState()?.dialog?.isOpen;n++){await s.bot.dismissBlockingUI();await waitTicks(s,2);}
            if(s.sdk.getState()?.dialog?.isOpen)throw new Error('alch: level-up dialog stayed open');
        }
    }catch(e){failure=e instanceof Error?e.message:String(e);stop='failure';}
    // No cast at all: the supervisor reads "no ... progress" as blocked and stops, where a plain fail is retried at once
    // (live: UnderMyKilt ran 42 four-tick fails with no fire runes until the planner moved it).
    if(!failure&&stop==='supplies'&&casts['low-alch']+casts['high-alch']===0)failure='no alch progress: the bank holds no supplies for one cast';
    const gained=startLevel===undefined?0:level()-startLevel,met=level()>=o.target;
    return{ok:met||(!failure&&stop==='supplies'&&gained>0),stop:met?'target':stop,failure,level:level(),gained,magicXp:startXp===undefined?0:xp()-startXp,casts,ticks:s.tick()-start};
}

// The planner reads progress from the RESULT line's key=value fields (packages/planner/src/autopilot.ts `progressed`).
export const alchResultLine=(r:Awaited<ReturnType<typeof runAlch>>)=>
    `alch level=${r.level} gained=${r.gained} xp=${r.magicXp} low=${r.casts['low-alch']} high=${r.casts['high-alch']} stop=${r.stop} ticks=${r.ticks}${r.failure?` failure=${r.failure}`:''}`;

if(import.meta.main){let s:Session|undefined,stopped=false;try{
    const [account,target,cap]=process.argv.slice(2);if(!account||!target)throw new Error('usage: alch-train.ts <account> <TARGET_LEVEL> [CAP]');
    s=await openBot(account,{onStop:async()=>{stopped=true;}});
    const {walkTargetPersist}=await import('./walk-to'),session=s;
    const r=await runAlch(s,{target:Number(target),cap:Number(cap??5000),item:process.env.ALCH_ITEM??'feather',stop:()=>stopped,
        walk:async(x,z)=>(await walkTargetPersist(session,{x,z,level:0})).ok});
    console.log(`ALCH_RESULT ${JSON.stringify(r)}`);await finish([s],r.ok,alchResultLine(r));
}catch(e){await finish(s?[s]:[],false,String(e));}}
