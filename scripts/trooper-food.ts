// Trooper mode food staging (scripts/gather-combat.ts TROOPER_COOK=1): an army account leaves the cows with its raw
// beef banked and no trooper food. When it owns fewer than `want` pieces of trooper food and has raw beef banked, it
// cooks up to `packs` packs of the beef at the range by the Ardougne north bank and banks the cooked meat
// (3 HP a piece). Raw beef cooks from Cooking 1 and stops burning near Cooking 34 (cooking_generic.dbrow).
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
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

export async function stageTrooperFood(s:Session,o:{walk:(x:number,z:number,tol:number)=>Promise<boolean>;stop?:()=>boolean;want?:number;packs?:number}){
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
    await toBank();await open();
    let left=trooperCookPlan(inv(),observe()?.items??[],o.want,o.packs),cooked=0,burnt=0,trips=0;
    if(left<1){await s.bot.closeBank();return{cooked,burnt,trips,ticks:s.tick()-start};}
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
    await depositAll();await s.bot.closeBank();
    return{cooked,burnt,trips,ticks:s.tick()-start};
}
