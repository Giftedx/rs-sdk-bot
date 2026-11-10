// Trooper mode food staging (scripts/gather-combat.ts TROOPER_COOK=1). When the account owns fewer than `want` pieces
// of trooper food it makes its own, in two steps:
// 1. it cooks up to `packs` packs of banked raw beef at the range by the Ardougne north bank (an account leaves the
//    cows with one raw beef a kill; cooked meat heals 3; raw beef cooks from Cooking 1 and stops burning near 34);
// 2. still short, it steals a pack of food at the Ardougne baker's stalls (Thieving 5; cake, bread, chocolate slice).
// It banks what it made.
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {TROOPER_SITE} from './gather-combat';

type Item={id:number;count:number};
export const RAW_BEEF=2132,COOKED_MEAT=2142,BURNT_MEAT=2146;
// The nearest range the walker reaches (loc 2728 in the farmhouse north-east of the bank; the house south of the bank
// is behind a locked door) and the tile north of it: 40 ticks out and 31 back on practice, 3-4 ticks a cook.
// Below TROOPER_COOK_WANT owned pieces the stage cooks TROOPER_COOK_PACKS packs.
export const TROOPER_RANGE={x:2642,z:3355},TROOPER_COOK_TILE={x:2642,z:3356},TROOPER_COOK_WANT=20,TROOPER_COOK_PACKS=3;
const count=(items:readonly Item[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);

// Raw beef to cook now: none while the owned trooper food covers `want` pieces, else up to `packs` packs of 28.
export function trooperCookPlan(carried:readonly Item[],bank:readonly Item[],want=TROOPER_COOK_WANT,packs=TROOPER_COOK_PACKS):number{
    const food=TROOPER_SITE.foods.reduce((n,id)=>n+count(carried,id)+count(bank,id),0);
    return food>=want?0:Math.min(packs*28,count(bank,RAW_BEEF)+count(carried,RAW_BEEF));
}

// The Ardougne baker's stalls (stealing.rs2, stealing.dbrow; the rules scripts/goldfarm.ts stallTrip follows): Thieving
// 5; cake 13 in 20, bread 5, chocolate slice 2; a stall restocks in 8 ticks. An Ardougne guard within 5 tiles with
// line of sight attacks the thief, and the Baker within 5 tiles with line of sight refuses the steal. The thief stands
// on a side tile of a stall with no guard within GUARD_SAFE tiles, one more than 5 tiles from the Baker first.
type Tile={x:number;z:number};
export const STALL_SPOT:Tile={x:2655,z:3310},STALL_FILL=24,STALL_CAP=500,GUARD_SAFE=6,STALL_THIEVING=5;
type StallLoc={id:number;name:string;x:number;z:number;options?:readonly string[];optionsWithIndex?:readonly {text:string;opIndex:number}[]};
const cheb=(a:Tile,b:Tile)=>Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z)),key=(t:Tile)=>`${t.x},${t.z}`;
export function stallChoice(locs:readonly StallLoc[],npcs:readonly {name:string;x:number;z:number}[],here:Tile,bad:(t:Tile)=>boolean):{tile:Tile;loc:StallLoc}|undefined{
    const guards=npcs.filter(n=>/guard/i.test(n.name)),bakers=npcs.filter(n=>/^baker$/i.test(n.name));
    const blocked=new Set(locs.filter(l=>/stall/i.test(l.name)).flatMap(l=>[0,1].flatMap(dx=>[0,1].map(dz=>key({x:l.x+dx,z:l.z+dz})))));
    const options:{tile:Tile;loc:StallLoc;score:number}[]=[];
    for(const loc of locs){
        if(!/^baker'?s stall$/i.test(loc.name)||![...(loc.options??[]),...(loc.optionsWithIndex??[]).map(o=>o.text)].some(o=>/steal/i.test(o)))continue;
        const sides=[[-1,0],[-1,1],[2,0],[2,1],[0,-1],[1,-1],[0,2],[1,2]].map(([dx,dz])=>({x:loc.x+dx!,z:loc.z+dz!}));
        for(const tile of sides){
            if(blocked.has(key(tile))||bad(tile)||guards.some(g=>cheb(g,tile)<=GUARD_SAFE))continue;
            const baker=Math.min(99,...bakers.map(b=>cheb(b,tile)));
            options.push({tile,loc,score:(baker>5?0:100-baker*10)+cheb(tile,here)});
        }
    }
    return options.sort((a,b)=>a.score-b.score)[0];
}

// Steal food at the stalls until the pack holds `fill` food items, the pack is full or `cap` ticks pass.
export async function stealStallFood(s:Session,o:{walk:(x:number,z:number,tol:number)=>Promise<boolean>;stop?:()=>boolean;fill?:number;cap?:number}){
    const state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),food=()=>TROOPER_SITE.foods.reduce((n,id)=>n+count(inv(),id),0);
    const fill=o.fill??STALL_FILL,cap=o.cap??STALL_CAP,hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,floor=Math.ceil((s.sdk.getSkill('Hitpoints')?.baseLevel??0)/2);
    if(!await o.walk(STALL_SPOT.x,STALL_SPOT.z,2))throw new Error('trooper food: walk to the baker\'s stalls failed');
    const start=s.tick(),bad=new Map<string,number>();let stolen=0,refused=0;
    while(food()<fill&&inv().length<28&&s.tick()-start<cap&&hp()>floor){
        if(o.stop?.())throw new Error('trooper food: stop requested');
        if(state()?.dialog?.isOpen)await s.bot.dismissBlockingUI();
        const st=state(),me=st?.player;
        if(!st||!me){await waitTicks(s,1);continue;}
        const here={x:me.worldX,z:me.worldZ},choice=stallChoice(st.nearbyLocs as readonly StallLoc[],st.nearbyNpcs,here,t=>(bad.get(key(t))??0)>s.tick());
        if(!choice){await waitTicks(s,1);continue;}
        if(cheb(choice.tile,here)>0){
            await s.bot.walkTo(choice.tile.x,choice.tile.z,0,{timeout:8000});
            const p=state()?.player;
            if(!p||p.worldX!==choice.tile.x||p.worldZ!==choice.tile.z)bad.set(key(choice.tile),s.tick()+30);
            continue;   // Look at the guards again from the new tile.
        }
        const option=choice.loc.optionsWithIndex?.find(op=>/steal/i.test(op.text))?.opIndex??2,before=food();
        await s.direct({type:'interactLoc',x:choice.loc.x,z:choice.loc.z,locId:choice.loc.id,optionIndex:option,reason:'SDK'} as never);
        let got=false;
        for(let i=0;i<3&&!got;i++){await waitTicks(s,1);got=food()>before;}
        if(got)stolen++;else{refused++;bad.set(key(choice.tile),s.tick()+6);}
    }
    return{stolen,refused,ticks:s.tick()-start};
}

export async function stageTrooperFood(s:Session,o:{walk:(x:number,z:number,tol:number)=>Promise<boolean>;stop?:()=>boolean;want?:number;packs?:number;fill?:number}){
    const state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),held=(id:number)=>count(inv(),id);
    const bank=TROOPER_SITE.bank,near=(x:number,z:number,tol:number)=>{const p=state()?.player;return !!p&&p.level===0&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=tol;};
    if(!await waitUntil(s,()=>!!state()?.player,{timeoutTicks:15}))throw new Error('trooper food: position unknown');
    const observe=s.bankObservation?.bind(s);
    if(!observe)throw new Error('trooper food: fresh bank observation unavailable');
    const start=s.tick(),stopped=()=>{if(o.stop?.())throw new Error('trooper food: stop requested');};
    const toBank=async()=>{stopped();if(!near(bank.x,bank.z,3)&&(!await o.walk(bank.x,bank.z,3)||!near(bank.x,bank.z,3)))throw new Error('trooper food: walk to Ardougne north bank failed');};
    const open=async()=>{const generation=observe()?.generation??0;
        if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank?.isOpen&&(observe()?.generation??0)>generation,{timeoutTicks:20}))throw new Error('trooper food: bank did not open');};
    const bankCount=(id:number)=>count(observe()?.items??[],id);
    const depositAll=async()=>{
        for(const id of [...new Set(inv().map(i=>i.id))]){
            const row=inv().find(i=>i.id===id),before=bankCount(id),amount=held(id);
            if(!row||!(await s.bot.depositItem(row,-1)).success||!await waitUntil(s,()=>held(id)===0&&bankCount(id)===before+amount,{timeoutTicks:20}))throw new Error(`trooper food: deposit ${id} failed`);
        }
    };
    const owned=()=>TROOPER_SITE.foods.reduce((n,id)=>n+held(id)+bankCount(id),0),want=o.want??TROOPER_COOK_WANT;
    await toBank();await open();
    let left=trooperCookPlan(inv(),observe()?.items??[],o.want,o.packs),cooked=0,burnt=0,trips=0,stolen=0,refused=0;
    while(left>0){
        stopped();
        await depositAll();
        const take=Math.min(28,left,bankCount(RAW_BEEF));if(take<1)break;
        const row=(state()?.bank?.items??[]).find(i=>i.id===RAW_BEEF);
        if(!row||!(await s.bot.withdrawItem(row,take,{asNote:false})).success||!await waitUntil(s,()=>held(RAW_BEEF)===take,{timeoutTicks:20}))throw new Error('trooper food: raw beef withdraw failed');
        await s.bot.closeBank();left-=take;trips++;
        if(!await o.walk(TROOPER_COOK_TILE.x,TROOPER_COOK_TILE.z,1)||!near(TROOPER_COOK_TILE.x,TROOPER_COOK_TILE.z,1))throw new Error('trooper food: walk to the range failed');
        let progress=s.tick(),last=held(RAW_BEEF);const meat=held(COOKED_MEAT),waste=held(BURNT_MEAT);
        while(held(RAW_BEEF)>0){
            stopped();
            if(s.tick()-progress>=40)throw new Error('trooper food: cooking no progress');
            if(state()?.dialog?.isOpen)await s.bot.dismissBlockingUI();
            const range=state()?.nearbyLocs.find(l=>/^range$/i.test(l.name)&&l.x===TROOPER_RANGE.x&&l.z===TROOPER_RANGE.z);
            if(!range)throw new Error('trooper food: range unobserved');
            const raw=inv().find(i=>i.id===RAW_BEEF)!;
            await s.sdk.sendUseItemOnLoc(raw.slot,range.x,range.z,range.id);
            await waitUntil(s,()=>!!o.stop?.()||held(RAW_BEEF)<last,{timeoutTicks:10});
            if(held(RAW_BEEF)<last){last=held(RAW_BEEF);progress=s.tick();}
        }
        cooked+=held(COOKED_MEAT)-meat;burnt+=held(BURNT_MEAT)-waste;
        await toBank();await open();
    }
    // The bank is open here. Still short after the beef: a pack from the baker's stalls.
    if(owned()<want&&(s.sdk.getSkill('Thieving')?.baseLevel??1)>=STALL_THIEVING){
        await depositAll();await s.bot.closeBank();
        const stall=await stealStallFood(s,{walk:o.walk,stop:o.stop,fill:o.fill});stolen=stall.stolen;refused=stall.refused;
        await toBank();await open();
    }
    if(trips>0||stolen>0)await depositAll();
    await s.bot.closeBank();
    return{cooked,burnt,trips,stolen,refused,ticks:s.tick()-start};
}
