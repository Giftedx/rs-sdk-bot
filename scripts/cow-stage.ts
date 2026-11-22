// Cow mode staging (scripts/gather-combat.ts COW_STAGE=1): walk to the Ardougne north bank from anywhere, then take
// the best owned melee weapon, the shield that goes with it (if the account owns one) and 14 HP of trout or cake from
// the bank. The kit is the engine's choice (packages/planner/src/gear-progression.ts selectProgressiveLoadout), so any
// weapon the account can wield serves; a stage with no wearable melee weapon, held or banked, ends missing=weapon.
// Cow mode wears the rest of the loadout from the bank itself. The army accounts bank their kit elsewhere
// (packages/planner/src/autopilot.ts COW_BANDS).
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {questFlags} from '../packages/core/src/quest-status';
import {selectProgressiveLoadout,readSkillLevels,type GearSkillLevels,type QuestInput} from '../packages/planner/src/gear-progression';
import {COW_FOOD_BITES,COW_FOOD_HP,cowFoodHeal} from '../packages/workers/src/combat';

type Item={id:number;count:number};
export const COW_NORTH_BANK={x:2619,z:3332},COW_KIT:readonly number[]=[1277,1171];
// Bank food in pick order: trout, whole cakes, 2/3 cakes, slices.
const FOOD=[333,1891,1897,1893,1899,1895,1901];
const count=(items:readonly Item[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export const atNorthBank=(p:{worldX:number;worldZ:number;level:number}|null|undefined)=>!!p&&p.level===0&&Math.max(Math.abs(p.worldX-COW_NORTH_BANK.x),Math.abs(p.worldZ-COW_NORTH_BANK.z))<=3;

// The cow kit: the best owned melee weapon, then the shield that goes with it when one is owned (carried, worn or
// banked). Empty when no wearable melee weapon is owned. Levels default to 1, so a bronze sword and a wooden shield
// remain the kit of a fresh account.
export function cowStageKit(owned:readonly Item[],o:{levels?:GearSkillLevels;quests?:QuestInput}={}):number[]{
    const loadout=selectProgressiveLoadout('melee',owned,o.levels,o.quests,{trainSkill:'all-melee'});
    if(!loadout.worn.weapon)return [];
    return [loadout.worn.weapon.id,loadout.worn.shield?.id].filter((id):id is number=>id!==undefined);
}

// The withdrawals that complete the cow kit and food, or the missing part. Carried food counts first, then bank food
// in FOOD order until the held food heals COW_FOOD_HP.
export function cowStagePlan(carried:readonly Item[],bank:readonly Item[],o:{levels?:GearSkillLevels;quests?:QuestInput}={}):{take:Item[]}|{missing:string}{
    const take:Item[]=[];
    const kit=cowStageKit([...carried,...bank],o);
    if(!kit.length)return{missing:'weapon'};
    for(const id of kit)if(count(carried,id)<1)take.push({id,count:1});
    let need=COW_FOOD_HP-cowFoodHeal(carried);
    for(const id of FOOD){if(need<=0)break;const heal=cowFoodHeal([{id,count:1}]),n=Math.min(count(bank,id),Math.ceil(need/heal));if(n>0){take.push({id,count:n});need-=n*heal;}}
    return need>0?{missing:`food ${need} HP`}:{take};
}

// What to bank before the field: everything but one of each kit item and the fewest food pieces that heal COW_FOOD_HP,
// keeping the pieces that heal most per slot (a whole cake heals 12 in one slot). The north profile needs 3 free slots per
// kill; an army account arrives with its farm pack (claude-cloud TheFullMonty stopped at 6 of 8 kills on slots).
const slotHeal=(id:number)=>cowFoodHeal([{id,count:1}]);
export function cowStageDeposits(inv:readonly Item[],kit:readonly number[]=COW_KIT):Item[]{
    const out=new Map<number,number>(),add=(id:number,n:number)=>{if(n>0)out.set(id,(out.get(id)??0)+n);};
    for(const id of kit)add(id,count(inv,id)-1);
    for(const i of inv)if(!kit.includes(i.id)&&!COW_FOOD_BITES[i.id])add(i.id,i.count);
    let need=COW_FOOD_HP;
    const units=inv.filter(i=>COW_FOOD_BITES[i.id]).flatMap(i=>Array.from({length:i.count},()=>i.id)).sort((a,b)=>slotHeal(b)-slotHeal(a));
    for(const id of units){if(need>0)need-=slotHeal(id);else add(id,1);}
    return [...out].map(([id,n])=>({id,count:n}));
}

export async function stageCows(s:Session,o:{walk:(x:number,z:number)=>Promise<boolean>;stop?:()=>boolean}){
    const state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),carried=()=>[...inv(),...(state()?.equipment??[])];
    if(!await waitUntil(s,()=>!!state()?.player,{timeoutTicks:15}))throw new Error('cow stage: position unknown');
    const gear=()=>({levels:readSkillLevels(n=>s.sdk.getSkill(n)),quests:s.client?questFlags(s.client):null});
    const ready=cowStagePlan(carried(),[],gear());
    if(atNorthBank(state()?.player)&&'take' in ready&&ready.take.length===0&&!cowStageDeposits(inv(),cowStageKit(carried(),gear())).length)return{walked:false,took:[] as Item[],deposited:[] as Item[]};
    let walked=false;
    if(!atNorthBank(state()?.player)){
        if(o.stop?.())throw new Error('cow stage: stop requested');
        if(!await o.walk(COW_NORTH_BANK.x,COW_NORTH_BANK.z)||!atNorthBank(state()?.player))throw new Error('cow stage: walk to Ardougne north bank failed');
        walked=true;
    }
    const observe=s.bankObservation?.bind(s),generation=observe?.()?.generation??0;
    if(!observe)throw new Error('cow stage: fresh bank observation unavailable');
    if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank?.isOpen&&(observe()?.generation??0)>generation,{timeoutTicks:20}))throw new Error('cow stage: bank did not open');
    const kit=cowStageKit([...carried(),...(observe()?.items??[])],gear());
    const deposited=cowStageDeposits(inv(),kit);
    for(const d of deposited){
        if(o.stop?.())throw new Error('cow stage: stop requested');
        const row=inv().find(i=>i.id===d.id),before=count(inv(),d.id);
        if(!row||!(await s.bot.depositItem(row,d.count)).success||!await waitUntil(s,()=>count(inv(),d.id)<=before-d.count,{timeoutTicks:10}))
            throw new Error(`cow stage: deposit ${d.count}x${d.id} failed`);
    }
    const plan=cowStagePlan(carried(),observe()?.items??[],gear());
    if('missing' in plan){await s.bot.closeBank();throw new Error(`cow stage: bank lacks ${plan.missing}`);}
    for(const want of plan.take){
        if(o.stop?.())throw new Error('cow stage: stop requested');
        const row=(state()?.bank?.items??[]).find(i=>i.id===want.id),before=count(inv(),want.id);
        if(!row||!(await s.bot.withdrawItem(row,want.count,{asNote:false})).success||!await waitUntil(s,()=>count(inv(),want.id)>=before+want.count,{timeoutTicks:10}))
            throw new Error(`cow stage: withdraw ${want.count}x${want.id} failed`);
    }
    await s.bot.closeBank();
    if(cowFoodHeal(inv())<COW_FOOD_HP||kit.some(id=>count(carried(),id)<1))throw new Error('cow stage: kit or food not held after withdraw');
    return{walked,took:plan.take,deposited};
}
