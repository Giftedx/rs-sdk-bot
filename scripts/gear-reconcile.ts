// Wears the best owned loadout for a combat style: from the pack, and with the bank open from the bank.
// One path for every combat worker. The choice is the planner engine (packages/planner/src/gear-progression.ts
// selectProgressiveLoadout) over knowledge/gear.json; this file does the bank and equip actions and their checks.
//
// Hook points for a worker: the job start and each bank trip (bankOpen: true), and each crossing of an unlock level
// (gearLevelWatch): wear from the pack at once, and go to the bank at the next safe point when `bankBetter` is true.
//
// When the best item that has a source is not owned, one line is printed for each such item:
//   GEAR_WANT {"account","style","slot","wearpos","id","name","current","source"}
// source is {"kind":"shop","shop","cost"} for the cheapest shop the account can use, or {"kind":"trade"}.
import type {Session} from '../packages/core/src/inprocess';
import {questFlags} from '../packages/core/src/quest-status';
import {waitUntil} from '../packages/core/src/ticks';
import {
    selectProgressiveLoadout,
    bestElementalStaffForRunes,
    crossedTierBoundary,
    readSkillLevels,
    gearById,
    WEARPOS_BY_SLOT,
    type CombatFocus,
    type GearSkillLevels,
    type GearUnlockKind,
    type ProgressiveLoadout,
    type ProgressiveLoadoutOptions,
    type QuestInput,
    type RangedLoadoutSlotName,
} from '../packages/planner/src/gear-progression';

type Count={id:number;count:number};
export type GearTarget={slot:RangedLoadoutSlotName;wearpos:number;id:number;stack:boolean};
export type GearWant={account:string;style:CombatFocus;slot:RangedLoadoutSlotName;wearpos:number;id:number;name:string;current:number|null;
    source:{kind:'shop';shop:string;cost:number}|{kind:'trade'}};
export interface ReconcileOptions{
    style:CombatFocus;
    trainSkill?:string;
    /** The bank is open: missing loadout items are withdrawn and replaced items are deposited. The bank is closed on return unless leaveBankOpen. */
    bankOpen?:boolean;
    stop?:()=>boolean;
    /** Ammunition to carry (quiver arrows or the thrown stack). 0 or undefined: the worker handles its own ammunition amount. */
    ammo?:number;
    /** A run's worth of ammunition for the choice (engine default RANGED_RUN_AMMO). */
    ammoMin?:number;
    /** False keeps thrown weapons out of the Ranged choice. */
    thrown?:boolean;
    /** A weapon or ammunition id the caller's plan has fixed. The other slots are still chosen. */
    pin?:{weapon?:number;ammo?:number};
    /** Magic: the runes the spell uses. The staff that supplies the most of them is the weapon. */
    runeIds?:readonly number[];
    levels?:GearSkillLevels;
    quests?:QuestInput;
    questPoints?:number;
    loadout?:Pick<ProgressiveLoadoutOptions,'requireWeapon'|'requireShield'|'minWeaponStrength'|'minShieldDefence'|'reserved'|'godAlign'>;
    /** Throw when a withdrawal, an equip or a deposit has no observed effect. Without it the item is skipped. */
    strict?:boolean;
    /** Error text prefix, e.g. 'cow kit'. */
    label?:string;
    leaveBankOpen?:boolean;
    openBank?:()=>Promise<void>;
    closeBank?:()=>Promise<unknown>;
    /** The last known bank contents, for a call with the bank closed: sets bankBetter and permits GEAR_WANT. */
    bankItems?:readonly Count[];
}
export interface ReconcileResult{
    loadout:ProgressiveLoadout;
    targets:GearTarget[];
    /** Item ids equipped by this call. */
    worn:number[];
    /** Replaced item ids that are still in the pack. */
    displaced:number[];
    deposited:number[];
    /** Target ids that are not worn after the call. */
    pending:number[];
    weaponChanged:boolean;
    /** The ammunition and where it is worn: 13 the quiver, 3 a thrown stack. */
    ammo:{id:number;wearpos:number}|null;
    /** The known bank holds a loadout item that the pack and the worn gear do not. */
    bankBetter:boolean;
    want:GearWant[];
}

const count=(items:readonly Count[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const STYLE_SKILLS:Readonly<Record<GearUnlockKind,readonly string[]>>={
    melee:['attack','strength','defence'],ranged:['ranged','defence'],magic:['magic','attack','defence'],
    'woodcutting-axe':['attack','woodcutting'],'mining-pickaxe':['attack','mining'],
};

/** Each completed quest gives at least one quest point, so the count of completed quests is a lower bound. */
export function questPointsFloor(quests:QuestInput):number{
    if(!quests)return 0;
    if(quests instanceof Set)return quests.size;
    if(Array.isArray(quests))return quests.filter(q=>typeof q==='string'||q&&typeof q==='object'&&'state' in q&&q.state==='complete').length;
    return Object.values(quests).filter(done=>done===true).length;
}

/** The items the loadout wears, the weapon first. A pin replaces the weapon or the ammunition the engine chose. */
export function loadoutTargets(loadout:ProgressiveLoadout,pin:ReconcileOptions['pin']={}):GearTarget[]{
    const out:GearTarget[]=loadout.items.map(({slot,wearpos,item})=>({slot,wearpos,id:item.id,stack:slot==='ammo'||slot==='weapon'&&loadout.thrown}));
    const set=(slot:RangedLoadoutSlotName,id:number,stack:boolean)=>{
        const at=out.findIndex(t=>t.slot===slot),target={slot,wearpos:WEARPOS_BY_SLOT[slot],id,stack};
        if(at>=0)out[at]=target;else out.push(target);
    };
    if(pin.weapon!==undefined){
        set('weapon',pin.weapon,false);
        // A pinned two-handed weapon takes the shield's place.
        if(gearById(pin.weapon)?.covers.includes('lefthand')){const shield=out.findIndex(t=>t.slot==='shield');if(shield>=0)out.splice(shield,1);}
    }
    if(pin.ammo!==undefined)set('ammo',pin.ammo,true);
    return out.sort((a,b)=>Number(b.slot==='weapon')-Number(a.slot==='weapon'));
}

/** The GEAR_WANT rows of a loadout: for each slot, the best unowned item that has a source. */
export function gearWants(account:string,loadout:ProgressiveLoadout):GearWant[]{
    const out:GearWant[]=[];
    for(const [slot,upgrade] of Object.entries(loadout.upgrades)){
        const wanted=upgrade?.acquirableUpgrade;if(!wanted)continue;
        const shop=[...wanted.shops].sort((a,b)=>a.cost-b.cost)[0];
        out.push({account,style:loadout.style,slot:slot as RangedLoadoutSlotName,wearpos:upgrade.wearpos,id:wanted.item.id,name:wanted.item.name,
            current:upgrade.current?.id??null,source:shop?{kind:'shop',shop:shop.shop,cost:shop.cost}:{kind:'trade'}});
    }
    return out;
}

const printed=new Set<string>();
function printWants(wants:readonly GearWant[]){
    for(const want of wants){
        const key=`${want.account}:${want.style}:${want.slot}:${want.id}`;
        if(printed.has(key))continue;
        printed.add(key);console.log('GEAR_WANT '+JSON.stringify(want));
    }
}

/** True once for each observation in which a skill of the kind passed an unlock level (gearUnlockLevels). */
export function gearLevelWatch(s:Pick<Session,'sdk'>,kind:GearUnlockKind,skills:readonly string[]=STYLE_SKILLS[kind]){
    const read=()=>readSkillLevels(n=>s.sdk.getSkill(n));
    let previous=read();
    return{crossed(){const now=read(),hit=crossedTierBoundary(previous,now,skills,kind);previous=now;return hit;}};
}

export async function reconcileLoadout(s:Session,o:ReconcileOptions):Promise<ReconcileResult>{
    const label=o.label??'gear',stop=()=>!!o.stop?.();
    const state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),eq=()=>s.sdk.getEquipment();
    const held=(id:number)=>count(inv(),id);
    const kit=():Count[]=>[...inv(),...eq()].map(i=>({id:i.id,count:i.count}));
    const bankNow=():Count[]|undefined=>{
        const open=state()?.bank?.isOpen?(s.bankObservation?.()?.items??state()?.bank?.items):undefined;
        return open?.map(i=>({id:i.id,count:i.count}));
    };
    const fail=(text:string)=>{if(o.strict)throw new Error(text);return false;};
    const levels=()=>o.levels??readSkillLevels(n=>s.sdk.getSkill(n));
    const quests=()=>o.quests??(s.client?questFlags(s.client):null);
    const choose=(stock:readonly Count[])=>{
        const done=quests();
        const loadout=selectProgressiveLoadout(o.style,stock,levels(),done,{...o.loadout,trainSkill:o.trainSkill,thrown:o.thrown,
            questPoints:o.questPoints??questPointsFloor(done),...o.ammoMin===undefined?{}:{arrowMinCount:o.ammoMin}});
        const pin={...o.pin};
        if(o.style==='magic'&&o.runeIds?.length&&pin.weapon===undefined){
            const staff=bestElementalStaffForRunes(stock,levels(),done,{runeIds:o.runeIds}).current;
            if(staff)pin.weapon=staff.item.id;
        }
        return{loadout,targets:loadoutTargets(loadout,pin)};
    };
    // An item id has one wear position, so a worn row with the id is the item in its slot.
    const wornCount=(t:GearTarget)=>count(eq(),t.id);
    const owns=(t:GearTarget)=>wornCount(t)>0||held(t.id)>0;
    const worn:number[]=[],deposited:number[]=[];
    const equip=async(t:GearTarget)=>{
        const item=inv().find(i=>i.id===t.id);
        if(!item)return wornCount(t)>0||fail(`${label} equip failed ${t.id}: no held item and not equipped`);
        const before=wornCount(t);
        const result=await s.bot.equipItem(item);
        const seen=await waitUntil(s,()=>wornCount(t)>before||stop(),{timeoutTicks:10});
        if(!seen||wornCount(t)<=before)return fail(`${label} equip failed ${t.id}: ${result.message??'no SDK message'}; equipped item not observed`);
        worn.push(t.id);return true;
    };
    const wear=async(targets:readonly GearTarget[])=>{
        for(const t of targets){
            if(stop())return;
            // A stack is topped up from the pack; any other item is done once it is worn.
            if(t.stack?held(t.id)<1:wornCount(t)>0)continue;
            await equip(t);
        }
    };
    const openBank=o.openBank??(async()=>{
        if(state()?.bank?.isOpen&&s.bankObservation?.())return;
        const generation=s.bankObservation?.()?.generation??0;
        if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:20}))
            throw new Error(`${label}: bank readiness unknown`);
    });
    const closeBank=o.closeBank??(()=>s.bot.closeBank());
    const bankCount=(id:number)=>count(bankNow()??[],id);
    const withdraw=async(id:number,amount:number)=>{
        const row=state()?.bank?.items.find(i=>i.id===id),before=held(id);
        if(!row||!(await s.bot.withdrawItem(row,amount,{asNote:false})).success
            ||!await waitUntil(s,()=>held(id)>=before+amount||stop(),{timeoutTicks:10})||held(id)<before+amount)
            return fail(`${label} withdraw failed ${id}`);
        return true;
    };
    const weaponBefore=eq().find(i=>i.slot===3)?.id;
    const wornBefore=eq().map(i=>({id:i.id,count:i.count,slot:i.slot}));
    let chosen=choose(o.bankOpen?[...(bankNow()??[]),...kit()]:kit());
    if(o.bankOpen){
        // A full pack leaves items for another pass: wear what came out, deposit what it replaced, withdraw the rest.
        for(let pass=0;pass<3&&!stop();pass++){
            if(!state()?.bank?.isOpen)await openBank();
            chosen=choose([...(bankNow()??[]),...kit()]);
            let more=false;
            for(const t of chosen.targets){
                if(stop())break;
                if(t.stack){
                    // Ammunition: up to the carried amount, counting what is worn and held.
                    const take=Math.min((o.ammo??0)-wornCount(t)-held(t.id),bankCount(t.id));
                    if(take>0&&(inv().length<28||held(t.id)>0))await withdraw(t.id,take);
                    continue;
                }
                if(owns(t))continue;
                if(inv().length>=28){more=true;continue;}
                await withdraw(t.id,1);
            }
            const before=eq().map(i=>i.id);
            const needWear=chosen.targets.some(t=>t.stack?held(t.id)>0:wornCount(t)<1&&held(t.id)>0);
            if(!needWear&&!more)break;
            await closeBank();
            if(stop())break;
            await wear(chosen.targets);
            const replaced=[...new Set(before)].filter(id=>!eq().some(i=>i.id===id)&&held(id)>0);
            if(!replaced.length&&!more)break;
            await openBank();
            for(const id of replaced){
                const item=inv().find(i=>i.id===id);if(!item)continue;
                const stored=bankCount(id),stack=wornBefore.some(i=>i.id===id&&(i.slot===13||i.count>1)),amount=stack?held(id):1;
                if(!(await s.bot.depositItem(item,stack?-1:1)).success||!await waitUntil(s,()=>bankCount(id)>=stored+amount||stop(),{timeoutTicks:10})){
                    fail(`${label}: replaced gear deposit failed (${id})`);continue;
                }
                deposited.push(id);
            }
            if(!more)break;
        }
        if(state()?.bank?.isOpen&&!o.leaveBankOpen)await closeBank();
        else if(!state()?.bank?.isOpen&&o.leaveBankOpen&&!stop())await openBank();
    }else{
        await wear(chosen.targets);
    }
    const known=o.bankOpen?undefined:o.bankItems;
    const full=known?choose([...known,...kit()]):chosen;
    const bankBetter=!!known&&full.targets.some(t=>!t.stack&&!owns(t)&&count(known,t.id)>0);
    const want=o.bankOpen||known?gearWants(s.name,full.loadout):[];
    printWants(want);
    const ammoTarget=chosen.targets.find(t=>t.stack);
    return{
        loadout:chosen.loadout,targets:chosen.targets,worn,deposited,
        displaced:[...new Set(wornBefore.map(i=>i.id))].filter(id=>!eq().some(i=>i.id===id)&&held(id)>0),
        pending:chosen.targets.filter(t=>wornCount(t)<1).map(t=>t.id),
        weaponChanged:eq().find(i=>i.slot===3)?.id!==weaponBefore,
        ammo:ammoTarget?{id:ammoTarget.id,wearpos:ammoTarget.wearpos}:null,
        bankBetter,want,
    };
}
