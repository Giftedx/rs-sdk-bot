// Cow mode staging (scripts/gather-combat.ts COW_STAGE=1): walk to the Ardougne north bank from anywhere, then take
// the bronze sword, the wooden shield and 14 HP of trout or cake from the bank. Cow mode starts only at that bank with
// that kit, and the army accounts bank their kit elsewhere (packages/planner/src/autopilot.ts COW_BANDS).
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {COW_FOOD_HP,cowFoodHeal} from './gather-combat';

type Item={id:number;count:number};
export const COW_NORTH_BANK={x:2619,z:3332},COW_KIT=[1277,1171] as const;
// Bank food in pick order: trout, whole cakes, 2/3 cakes, slices.
const FOOD=[333,1891,1897,1893,1899,1895,1901];
const count=(items:readonly Item[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export const atNorthBank=(p:{worldX:number;worldZ:number;level:number}|undefined)=>!!p&&p.level===0&&Math.max(Math.abs(p.worldX-COW_NORTH_BANK.x),Math.abs(p.worldZ-COW_NORTH_BANK.z))<=3;

// The withdrawals that complete the cow kit and food, or the missing part. Carried food counts first, then bank food
// in FOOD order until the held food heals COW_FOOD_HP.
export function cowStagePlan(carried:readonly Item[],bank:readonly Item[]):{take:Item[]}|{missing:string}{
    const take:Item[]=[];
    for(const id of COW_KIT)if(count(carried,id)<1){if(count(bank,id)<1)return{missing:`kit${id}`};take.push({id,count:1});}
    let need=COW_FOOD_HP-cowFoodHeal(carried);
    for(const id of FOOD){if(need<=0)break;const heal=cowFoodHeal([{id,count:1}]),n=Math.min(count(bank,id),Math.ceil(need/heal));if(n>0){take.push({id,count:n});need-=n*heal;}}
    return need>0?{missing:`food ${need} HP`}:{take};
}

export async function stageCows(s:Session,o:{walk:(x:number,z:number)=>Promise<boolean>;stop?:()=>boolean}){
    const state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),carried=()=>[...inv(),...(state()?.equipment??[])];
    if(!await waitUntil(s,()=>!!state()?.player,{timeoutTicks:15}))throw new Error('cow stage: position unknown');
    const ready=cowStagePlan(carried(),[]);
    if(atNorthBank(state()?.player)&&'take' in ready&&ready.take.length===0)return{walked:false,took:[] as Item[]};
    let walked=false;
    if(!atNorthBank(state()?.player)){
        if(o.stop?.())throw new Error('cow stage: stop requested');
        if(!await o.walk(COW_NORTH_BANK.x,COW_NORTH_BANK.z)||!atNorthBank(state()?.player))throw new Error('cow stage: walk to Ardougne north bank failed');
        walked=true;
    }
    const observe=s.bankObservation?.bind(s),generation=observe?.()?.generation??0;
    if(!observe)throw new Error('cow stage: fresh bank observation unavailable');
    if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank?.isOpen&&(observe()?.generation??0)>generation,{timeoutTicks:20}))throw new Error('cow stage: bank did not open');
    const plan=cowStagePlan(carried(),observe()?.items??[]);
    if('missing' in plan){await s.bot.closeBank();throw new Error(`cow stage: bank lacks ${plan.missing}`);}
    for(const want of plan.take){
        if(o.stop?.())throw new Error('cow stage: stop requested');
        const row=(observe()?.items??[]).find(i=>i.id===want.id),before=count(inv(),want.id);
        if(!row||!(await s.bot.withdrawItem(row,want.count,{asNote:false})).success||!await waitUntil(s,()=>count(inv(),want.id)>=before+want.count,{timeoutTicks:10}))
            throw new Error(`cow stage: withdraw ${want.count}x${want.id} failed`);
    }
    await s.bot.closeBank();
    if(cowFoodHeal(inv())<COW_FOOD_HP||COW_KIT.some(id=>count(carried(),id)<1))throw new Error('cow stage: kit or food not held after withdraw');
    return{walked,took:plan.take};
}
