// Cow mode staging (scripts/gather-combat.ts COW_STAGE=1): walk to the Ardougne north bank from anywhere, then take
// the bronze sword, the wooden shield and 14 HP of trout or cake from the bank. Cow mode starts only at that bank with
// that kit, and the army accounts bank their kit elsewhere (packages/planner/src/autopilot.ts COW_BANDS).
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {COW_FOOD_BITES,COW_FOOD_HP,cowFoodHeal} from './gather-combat';

type Item={id:number;count:number};
export const COW_NORTH_BANK={x:2619,z:3332},COW_KIT=[1277,1171] as const;
// Bank food in pick order: trout, whole cakes, 2/3 cakes, slices.
const FOOD=[333,1891,1897,1893,1899,1895,1901];
const count=(items:readonly Item[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export const atNorthBank=(p:{worldX:number;worldZ:number;level:number}|null|undefined)=>!!p&&p.level===0&&Math.max(Math.abs(p.worldX-COW_NORTH_BANK.x),Math.abs(p.worldZ-COW_NORTH_BANK.z))<=3;

// The withdrawals that complete the cow kit and food, or the missing part. Carried food counts first, then bank food
// in FOOD order until the held food heals COW_FOOD_HP.
export function cowStagePlan(carried:readonly Item[],bank:readonly Item[]):{take:Item[]}|{missing:string}{
    const take:Item[]=[];
    for(const id of COW_KIT)if(count(carried,id)<1){if(count(bank,id)<1)return{missing:`kit${id}`};take.push({id,count:1});}
    let need=COW_FOOD_HP-cowFoodHeal(carried);
    for(const id of FOOD){if(need<=0)break;const heal=cowFoodHeal([{id,count:1}]),n=Math.min(count(bank,id),Math.ceil(need/heal));if(n>0){take.push({id,count:n});need-=n*heal;}}
    return need>0?{missing:`food ${need} HP`}:{take};
}

// What to bank before the field: everything but one of each kit item and the fewest food pieces that heal COW_FOOD_HP,
// keeping the pieces that heal most per slot (a whole cake heals 12 in one slot). The north profile needs 3 free slots per
// kill; an army account arrives with its farm pack (claude-cloud TheFullMonty stopped at 6 of 8 kills on slots).
const slotHeal=(id:number)=>cowFoodHeal([{id,count:1}]);
export function cowStageDeposits(inv:readonly Item[]):Item[]{
    const out=new Map<number,number>(),add=(id:number,n:number)=>{if(n>0)out.set(id,(out.get(id)??0)+n);};
    for(const id of COW_KIT)add(id,count(inv,id)-1);
    for(const i of inv)if(!COW_KIT.includes(i.id as typeof COW_KIT[number])&&!COW_FOOD_BITES[i.id])add(i.id,i.count);
    let need=COW_FOOD_HP;
    const units=inv.filter(i=>COW_FOOD_BITES[i.id]).flatMap(i=>Array.from({length:i.count},()=>i.id)).sort((a,b)=>slotHeal(b)-slotHeal(a));
    for(const id of units){if(need>0)need-=slotHeal(id);else add(id,1);}
    return [...out].map(([id,n])=>({id,count:n}));
}

export async function stageCows(s:Session,o:{walk:(x:number,z:number)=>Promise<boolean>;stop?:()=>boolean}){
    const state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),carried=()=>[...inv(),...(state()?.equipment??[])];
    if(!await waitUntil(s,()=>!!state()?.player,{timeoutTicks:15}))throw new Error('cow stage: position unknown');
    const ready=cowStagePlan(carried(),[]);
    if(atNorthBank(state()?.player)&&'take' in ready&&ready.take.length===0&&!cowStageDeposits(inv()).length)return{walked:false,took:[] as Item[],deposited:[] as Item[]};
    let walked=false;
    if(!atNorthBank(state()?.player)){
        if(o.stop?.())throw new Error('cow stage: stop requested');
        if(!await o.walk(COW_NORTH_BANK.x,COW_NORTH_BANK.z)||!atNorthBank(state()?.player))throw new Error('cow stage: walk to Ardougne north bank failed');
        walked=true;
    }
    const observe=s.bankObservation?.bind(s),generation=observe?.()?.generation??0;
    if(!observe)throw new Error('cow stage: fresh bank observation unavailable');
    if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank?.isOpen&&(observe()?.generation??0)>generation,{timeoutTicks:20}))throw new Error('cow stage: bank did not open');
    const deposited=cowStageDeposits(inv());
    for(const d of deposited){
        if(o.stop?.())throw new Error('cow stage: stop requested');
        const row=inv().find(i=>i.id===d.id),before=count(inv(),d.id);
        if(!row||!(await s.bot.depositItem(row,d.count)).success||!await waitUntil(s,()=>count(inv(),d.id)<=before-d.count,{timeoutTicks:10}))
            throw new Error(`cow stage: deposit ${d.count}x${d.id} failed`);
    }
    const plan=cowStagePlan(carried(),observe()?.items??[]);
    if('missing' in plan){await s.bot.closeBank();throw new Error(`cow stage: bank lacks ${plan.missing}`);}
    for(const want of plan.take){
        if(o.stop?.())throw new Error('cow stage: stop requested');
        const row=(state()?.bank?.items??[]).find(i=>i.id===want.id),before=count(inv(),want.id);
        if(!row||!(await s.bot.withdrawItem(row,want.count,{asNote:false})).success||!await waitUntil(s,()=>count(inv(),want.id)>=before+want.count,{timeoutTicks:10}))
            throw new Error(`cow stage: withdraw ${want.count}x${want.id} failed`);
    }
    await s.bot.closeBank();
    if(cowFoodHeal(inv())<COW_FOOD_HP||COW_KIT.some(id=>count(carried(),id)<1))throw new Error('cow stage: kit or food not held after withdraw');
    return{walked,took:plan.take,deposited};
}
