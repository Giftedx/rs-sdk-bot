// Magic for the PK army: alchemy on a cheap stackable item from the Ardougne north bank, the army's home bank.
// bun scripts/alch-train.ts <account> <TARGET_LEVEL> [CAP ticks=5000]. Env: ALCH_ITEM (debugname, default feather).
// Low Alchemy until Magic 55, then High Alchemy to the target. It walks to the bank from anywhere, banks the pack,
// takes the nature runes, the fire runes (none with a fire staff, which it wields) and the item, and casts in place.
// Prints ALCH_RESULT and a RESULT line with level=, gained= and xp=; ok when the target is met, or when the bank's
// supplies ran out after at least one level. A failure after real casts still reports their XP.
// Rates: High Alchemy 65 and Low Alchemy 31 base XP (skill_magic/configs/magic_spells.dbrow) at xpRate 25.
// Below Magic 21 (Low Alchemy) it first casts Wind Strike (1 mind and 1 air rune, 137 XP a cast) on the Guard dog
// behind the mansion fence, from the tile 2621,3327 north of the bank: the dog cannot reach that tile.
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {xpForLevel} from '../packages/planner/src/curve';
import {itemMagicRecipe,runItemMagic} from './microbot-magic-items';
import {COW_NORTH_BANK,atNorthBank} from './cow-stage';
import {walkPath,sessionWalker} from '../packages/core/src/walk';
import {componentId} from '../packages/core/src/logout';

type Item={id:number;count:number};
export const NATURE=561,FIRE=554,HIGH_LEVEL=55;
export const CAST_XP={'low-alch':775,'high-alch':1625} as const;
const FIRE_PER={'low-alch':3,'high-alch':5} as const;
// Staff of fire, fire battlestaff, mystic fire staff (skill_magic/configs/magic_staff.dbrow).
export const FIRE_STAVES=[1387,1393,1401];
// Wind Strike start. Practice: from 2621,3327 a Magic 1, Hitpoints 10 account cast 30 times in 180 ticks to Magic 23 and
// took no damage; inside the yard (2629,3329 and 2624,3322) the dogs took it from 10 HP to 4 in two casts.
export const STRIKE={level:21,xp:137,mind:558,air:556,npc:99,spot:{x:2621,z:3327},spare:8,wait:200} as const;
export const strikeCasts=(xp:number,target:number)=>xp>=xpForLevel(Math.min(STRIKE.level,target))?0:Math.ceil((xpForLevel(Math.min(STRIKE.level,target))-xp)/STRIKE.xp);
const count=(items:readonly Item[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);

// Casts of each spell from this XP to the target level: Low Alchemy below 55, High Alchemy from 55.
export function alchCasts(xp:number,target:number){
    const goal=xpForLevel(target),gate=xpForLevel(HIGH_LEVEL);
    if(target<=STRIKE.level)return{low:0,high:0};
    const low=xp<gate?Math.ceil((Math.min(goal,gate)-xp)/CAST_XP['low-alch']):0;
    const high=target>HIGH_LEVEL?Math.ceil((goal-Math.max(xp,Math.min(goal,gate)))/CAST_XP['high-alch']):0;
    return{low:Math.max(0,low),high:Math.max(0,high)};
}

// The withdrawals for those casts, capped by the bank. With a fire staff worn or taken, no fire runes.
export function alchStagePlan(casts:{low:number;high:number;strike?:number},carried:readonly Item[],bank:readonly Item[],item:number){
    const staff=FIRE_STAVES.find(id=>count(carried,id)>0)??FIRE_STAVES.find(id=>count(bank,id)>0);
    const strikes=casts.strike?casts.strike+STRIKE.spare:0;
    const want:Item[]=[{id:STRIKE.mind,count:strikes},{id:STRIKE.air,count:strikes},{id:NATURE,count:casts.low+casts.high},{id:item,count:casts.low+casts.high}];
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
    const keep=new Set<number>([NATURE,FIRE,o.item,STRIKE.mind,STRIKE.air,...FIRE_STAVES]);
    for(const row of [...inv()].filter(i=>!keep.has(i.id))){
        if(o.stop?.())throw new Error('alch stage: stop requested');
        const id=row.id,before=count(inv(),id);
        if(before<1)continue;
        if(!(await s.bot.depositItem(row,before)).success||!await waitUntil(s,()=>count(inv(),id)===0,{timeoutTicks:10}))throw new Error(`alch stage: deposit ${id} failed`);
    }
    const magicXp=s.sdk.getSkillXp('Magic')??0;
    const plan=alchStagePlan({...alchCasts(magicXp,o.target),strike:strikeCasts(magicXp,o.target)},carried(),observe()?.items??[],o.item);
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

// Wind Strike on the fenced Guard dog until `target`. It stands on STRIKE.spot only, casts only at a dog it cannot
// reach, and walks back to the bank on any lost Hitpoint. Returns stop='' when the target is met.
export async function strikeStart(s:Session,o:{target:number;cap:number;stop?:()=>boolean}){
    const state=()=>s.sdk.getState(),level=()=>s.sdk.getSkill('Magic')?.baseLevel??0,xp=()=>s.sdk.getSkillXp('Magic')??0,hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    const held=(id:number)=>count(s.sdk.getInventory(),id),at=(x:number,z:number)=>{const p=state()?.player;return !!p&&p.level===0&&p.worldX===x&&p.worldZ===z;};
    const start=s.tick(),hp0=hp(),component=componentId('magic:wind_strike');let casts=0,landed=s.tick(),stop='';
    const walker=await sessionWalker(s),toSpot=async()=>at(STRIKE.spot.x,STRIKE.spot.z)||((await walkPath(walker,[{...STRIKE.spot,tol:0}],{maxTicks:60})).ok&&at(STRIKE.spot.x,STRIKE.spot.z));
    if(held(STRIKE.mind)<1||held(STRIKE.air)<1)return{casts,stop:'supplies'};
    if(!await toSpot())throw new Error('alch: strike tile 2621,3327 not reached');
    try{
        while(level()<o.target){
            if(s.tick()-start>=o.cap){stop='cap';break;}
            if(o.stop?.()){stop='stopped';break;}
            if(hp()<hp0)throw new Error(`alch: lost Hitpoints at the strike tile (${hp()} of ${hp0})`);
            if(held(STRIKE.mind)<1||held(STRIKE.air)<1){stop='supplies';break;}
            // One dog serves the tile and one player at a time can fight it: of three accounts at once, one landed no cast
            // (practice, three sets). The planner gives the tile to one account (autopilot STRIKE_TILE).
            if(s.tick()-landed>=STRIKE.wait)throw new Error(`no alch progress: no Wind Strike landed in ${STRIKE.wait} ticks (one player at a time can fight the dog)`);
            if(!await toSpot())throw new Error('alch: strike tile 2621,3327 lost');
            await s.bot.dismissBlockingUI();
            const dog=(state()?.nearbyNpcs??[]).filter(n=>n.id===STRIKE.npc&&n.reachable===false&&n.distance<=8).sort((a,b)=>a.distance-b.distance)[0];
            if(!dog){
                if((s.tick()-landed)%30<3)console.log(`STRIKE_WAIT ${JSON.stringify((state()?.nearbyNpcs??[]).filter(n=>n.id===STRIKE.npc).map(n=>({at:[n.tileX??n.x,n.tileZ??n.z],distance:n.distance,reachable:n.reachable,hp:n.hp})))}`);
                await waitTicks(s,3);continue;
            }
            const before=xp();
            await s.direct({type:'spellOnNpc',npcIndex:dog.index,spellComponent:component,reason:'alch strike start'});
            if(await waitUntil(s,()=>xp()>before,{timeoutTicks:8})){casts++;landed=s.tick();}
            await waitTicks(s,3);
        }
    }finally{
        await walkPath(walker,[{x:COW_NORTH_BANK.x,z:COW_NORTH_BANK.z,tol:2}],{maxTicks:80});
        for(let n=0;n<5&&state()?.dialog?.isOpen;n++){await s.bot.dismissBlockingUI();await waitTicks(s,2);}
    }
    if(!atNorthBank(state()?.player))throw new Error('alch: walk back to the bank from the strike tile failed');
    // Alchemy refuses a moving player: wait for two ticks on one tile.
    for(let n=0,last='';n<10;n++){const p=state()?.player,here=`${p?.worldX},${p?.worldZ}`;await waitTicks(s,2);const q=state()?.player;if(here===`${q?.worldX},${q?.worldZ}`&&here===last)break;last=here;}
    return{casts,stop};
}

export async function runAlch(s:Session,o:{target:number;cap:number;item:string;stop?:()=>boolean;walk:(x:number,z:number)=>Promise<boolean>}){
    if(!Number.isSafeInteger(o.target)||o.target<2||o.target>99||!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>100000)throw new Error('alch: invalid target or cap');
    const item=itemMagicRecipe('high-alch',o.item).target,start=s.tick(),level=()=>s.sdk.getSkill('Magic')?.baseLevel??0,xp=()=>s.sdk.getSkillXp('Magic')??0;
    const casts={'low-alch':0,'high-alch':0,strike:0};let stop='target',failure='',startLevel:number|undefined,startXp:number|undefined;
    try{
        const staged=await stageAlch(s,{target:o.target,item,walk:o.walk,stop:o.stop});
        console.log(`ALCH_STAGE ${JSON.stringify(staged)}`);
        startLevel=level();startXp=xp();
        if(level()<Math.min(STRIKE.level,o.target)){
            const r=await strikeStart(s,{target:Math.min(STRIKE.level,o.target),cap:o.cap-(s.tick()-start),stop:o.stop});
            casts.strike=r.casts;
            if(r.stop)stop=r.stop;
        }
        while(stop==='target'&&level()<o.target){
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
    if(!failure&&stop==='supplies'&&casts['low-alch']+casts['high-alch']+casts.strike===0)failure='no alch progress: the bank holds no supplies for one cast';
    const gained=startLevel===undefined?0:level()-startLevel,met=level()>=o.target;
    return{ok:met||(!failure&&stop==='supplies'&&gained>0),stop:met?'target':stop,failure,level:level(),gained,magicXp:startXp===undefined?0:xp()-startXp,casts,ticks:s.tick()-start};
}

// The planner reads progress from the RESULT line's key=value fields (packages/planner/src/autopilot.ts `progressed`).
export const alchResultLine=(r:Awaited<ReturnType<typeof runAlch>>)=>
    `alch level=${r.level} gained=${r.gained} xp=${r.magicXp} strike=${r.casts.strike} low=${r.casts['low-alch']} high=${r.casts['high-alch']} stop=${r.stop} ticks=${r.ticks}${r.failure?` failure=${r.failure}`:''}`;

if(import.meta.main){let s:Session|undefined,stopped=false;try{
    const [account,target,cap]=process.argv.slice(2);if(!account||!target)throw new Error('usage: alch-train.ts <account> <TARGET_LEVEL> [CAP]');
    s=await openBot(account,{onStop:async()=>{stopped=true;}});
    const {walkTargetPersist}=await import('./walk-to'),session=s;
    const r=await runAlch(s,{target:Number(target),cap:Number(cap??5000),item:process.env.ALCH_ITEM??'feather',stop:()=>stopped,
        walk:async(x,z)=>(await walkTargetPersist(session,{x,z,level:0})).ok});
    console.log(`ALCH_RESULT ${JSON.stringify(r)}`);await finish([s],r.ok,alchResultLine(r));
}catch(e){await finish(s?[s]:[],false,String(e));}}
