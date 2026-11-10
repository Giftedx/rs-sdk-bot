// Combat Monster Gatherer: fights Chaos Druids (herbs, runes) or Hill Giants (big bones, limpwurt) and banks drops.
// Usage: bun scripts/gather-combat.ts <bot> [CAP ticks, default 15000] [TARGET: druid | giant | trooper | cow]
// COW_STAGE=1 with cow first walks to the Ardougne north bank and takes the cow kit and food (scripts/cow-stage.ts).
// Environment: DEMO_OK=1 for live server. TARGET=giant with TRAIN_SKILL and TARGET_LEVEL trains one combat skill
// with the wielded weapon to a finite level (GIANT_FOOD sharks carried, default 5); without them giant keeps the
// legacy gatherer. GIANT_KILLS overrides the level goal with a finite credited kill count. TARGET=trooper trains the same
// way on the Khazard troopers of the Gnome battlefield from the Ardougne north bank (TROOPER_SITE). TRAIN_SKILL=Ranged
// wields the best owned bow and arrows for the Ranged level on rapid, with GIANT_AMMO arrows in the quiver (default 500).
// GIANT_BURY=1 buries the bones each trooper kill leaves, on the field. TROOPER_COOK=1 first cooks banked raw beef into
// cooked meat when the account owns little trooper food (scripts/trooper-food.ts). A trooper run out of food at low HP
// ends stop=food, ok after kills.
import { openBot, finish, countItems, getWorld, accountOf } from '../packages/core/src/bot';
import {startQuestSustain} from './quest-sustain';
import {ownedLoadout,fireWeaponSlot} from '../packages/planner/src/owned-loadout';
import{combatPotionPolicy,createCombatPotions,combatPotionSession,combatPotionRecovery,type CombatPotionPolicy}from'./microbot-combat-potions';
import{combatAlchPolicy}from'./microbot-combat-alch';
import {depositObserved} from '../packages/core/src/deposit';
import{createCombatLoot,telegrabPolicy}from'./microbot-telegrab';
import{createEdgevilleTravel}from'./microbot-edgeville-travel';
import type { Session } from '../packages/core/src/inprocess';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { goTo, walkPath, sessionWalker, expandPath, type PathDeps, type PathPoint, type PathTile } from '../packages/core/src/walk';
import { ferryWalk } from './walk-to';

// Local bear spawn clusters from rev289 maps / cow-path-probe.json. Expand by7:
// actual Bear105 wander4 + hunt1 + size2 footprint1 + one tile margin.
const COW_BEAR_BOXES=[[2632,3274,2633,3280],[2691,3341,2694,3344],[2692,3331,2698,3333],
    [2702,3344,2702,3344],[2706,3330,2708,3336],[2716,3330,2718,3336]] as const;
const cowBearTile=(p:PathTile)=>COW_BEAR_BOXES.some(([x1,z1,x2,z2])=>Math.max(Math.max(x1-p.x,0,p.x-x2),Math.max(z1-p.z,0,p.z-z2))<=7);
export function cowProfile(bankProfile='south',foodMode='held',maximum=5){
    if(!['south','north'].includes(bankProfile)||!['held','banked'].includes(foodMode)||foodMode==='banked'&&bankProfile!=='north')throw new Error('cow prerequisite: unsupported bank/food profile');
    const limit=bankProfile==='north'?(foodMode==='banked'?9:8):5;
    if(!Number.isSafeInteger(maximum)||maximum<1||maximum>limit)throw new Error(bankProfile==='south'?'cow needs positive CAP and MAX_KILLS1..5':`cow prerequisite: north profile MAX_KILLS1..${limit}`);
    return {north:bankProfile==='north',foodBanked:foodMode==='banked',limit,bank:{x:bankProfile==='north'?2619:2654,z:bankProfile==='north'?3332:3283}};
}
export function cowRoutePoints(from:PathTile,x:number,z:number,tol:number,north=false):PathPoint[]{
    const final={x,z,tol};
    if(north){
        const corridor=[{x:2635,z:3360,tol:0},{x:2647,z:3391,tol:0},{x:2676,z:3350,tol:0}];
        if(x===2619&&z===3332)return Math.max(Math.abs(from.x-x),Math.abs(from.z-z))<=3?[final]:[...corridor].reverse().concat(final);
        if(from.x>=2654&&from.x<=2676&&from.z>=3338&&from.z<=3357)return [final];
        return [...corridor,final];
    }
    const nw={x:2648,z:3358,tol:1},ne={x:2677,z:3358,tol:1};
    const bank=z<3300;
    if(bank)return from.z<3300||from.x<=2653?[final]:[ne,nw,final];
    return from.x>=2654&&from.x<=2674&&from.z>=3338&&from.z<=3357?[final]:[nw,ne,final];
}
export function guardCowWalker(base:PathDeps,safety:()=>string|null){
    let why:string|null=null;
    const check=()=>{why??=safety();return why;};
    const validate=(level:number,from:PathTile,to:PathTile,corners:PathTile[])=>{
        if(level!==0||cowBearTile(from)){why='cow route outside admitted floor/bear bounds';return false;}
        const end=corners.at(-1);
        if(!end&&from.x===to.x&&from.z===to.z)return true;
        if(!end||Math.max(Math.abs(end.x-to.x),Math.abs(end.z-to.z))>1){why='cow route incomplete: no empty/partial fallback';return false;}
        if(expandPath(from,corners).some(cowBearTile)){why='cow route intersects bear wander/hunt bounds';return false;}
        return true;
    };
    const refuse=()=>({success:false,phase:'dispatch',reason:'cow_route_guard',message:why??'cow route unknown'});
    const deps:PathDeps={...base,
        plan:(level,from,to)=>{const corners=base.plan(level,from,to);return validate(level,from,to,corners)?corners:[];},
        walk:(x,z)=>{if(check())return refuse();const p=base.pos();if(!p||!validate(p.level,p,{x,z},base.plan(p.level,p,{x,z})))return refuse();return base.walk(x,z);},
        interactLoc:(loc,op)=>check()?refuse():base.interactLoc(loc,op),
        ...(base.runOn?{runOn:()=>check()?refuse():base.runOn!()}:{}),
    };
    return {deps,reason:check};
}

// Workers with owned bank recovery retain the stop callback until cleanup ends.
// Otherwise core finish can close the session during the bank retreat.
export function cowStopControl(target:string,stopFile:()=>boolean,ownedRecovery=false){
    let reason:string|undefined;
    const options=target==='cow'||ownedRecovery?{onStop:async(_s:unknown,why:string)=>{if(reason===undefined){reason=why;console.log(`${target==='cow'?'COW':'COMBAT'}_STOP_OWNER ${why}`);}}}:{};
    return {options,stop:()=>reason!==undefined||stopFile(),reason:()=>reason};
}
export async function bankCombatLoot(s:Session,drops:RegExp,extraIds:readonly number[]=[]){
    const generation=s.bankObservation?.()?.generation??-1;
    if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!s.sdk.getState()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:12}))throw Error('combat fresh bank unavailable');
    const matches=new RegExp(drops.source,drops.flags.replace(/[gy]/g,''));
    const ids=new Set([...s.sdk.getInventory().filter(i=>matches.test(i.name)).map(i=>i.id),...extraIds]);
    for(const id of ids){const row=s.sdk.getInventory().find(i=>i.id===id);if(row)await depositObserved(s,row);}
    if(s.sdk.getInventory().some(i=>matches.test(i.name)||extraIds.includes(i.id)))throw Error('combat outputs not banked');
}
export function genericCombatNpc<T extends {id:number;distance:number;reachable?:boolean;inCombat?:boolean;targetIndex?:number}>(target:string,npcs:readonly T[],selfSlot?:number):T|undefined{
    const id=target==='giant'?117:target==='druid'?181:undefined;
    const owned = (n:T) => selfSlot !== undefined && Number.isSafeInteger(selfSlot) && selfSlot >= 0 &&
        n.inCombat === true && n.targetIndex === 32768 + selfSlot;
    return npcs.filter(n => n.id === id && n.reachable === true &&
        (owned(n) || n.inCombat === false && n.targetIndex === -1) &&
        Number.isFinite(n.distance) && n.distance >= 0 && n.distance <= 15)
        .sort((a,b) => Number(owned(b)) - Number(owned(a)) || a.distance - b.distance)[0];
}
export const cowCredit=(gone:boolean,selectedXp:number,newDrops:readonly number[])=>gone&&selectedXp>0&&newDrops.length===3&&newDrops.every(n=>n>=1);
export function cowGroundCounts(items:readonly {id:number;x:number;z:number;count:number}[]){
    const counts=new Map<string,number>();for(const i of items){const key=`${i.id}:${i.x}:${i.z}`;counts.set(key,(counts.get(key)??0)+i.count);}return counts;
}
export function cowTraining(skill='Attack',targetLevel?:number){
    // Bronze sword is weapon_stab: combat.dbrow102–111, 0 accurate,
    // 1 aggressive, 3 defensive. Never use controlled XP as single-skill credit.
    const styles:Record<string,number>={Attack:0,Strength:1,Defence:3};
    if(!Object.hasOwn(styles,skill))throw new Error('TRAIN_SKILL must be Attack, Strength or Defence');
    if(targetLevel!==undefined&&(!Number.isSafeInteger(targetLevel)||targetLevel<1||targetLevel>99))throw new Error('TARGET_LEVEL must be1..99');
    return {skill,style:styles[skill]!,targetLevel};
}
export async function equipCowKit(s:Session, stop:()=>boolean=()=>false) {
    for(const id of [1277,1171]){
        // Swapping identical held/worn copies need not change either observed ID.
        const equipped=()=>s.sdk.getEquipment().some(item=>item.id===id);
        if(equipped())continue;
        const item=s.sdk.getInventory().find(i=>i.id===id);
        if(!item)throw new Error(`cow kit equip failed ${id}: no held item and not equipped`);
        const result=await s.bot.equipItem(item);
        if(!await waitUntil(s,()=>equipped()||stop(),{timeoutTicks:10})||!equipped())
            throw new Error(`cow kit equip failed ${id}: ${result.message??'no SDK message'}; equipped item not observed`);
    }
}
// Held cow food in bites: trout heals once; a cake is eaten in three bites (cake, 2/3 cake, slice), chocolate cake likewise.
// The knight farm steals cake at the Ardougne bakery, so a farmer arrives with cake pieces rather than trout.
export const COW_FOOD_BITES:Readonly<Record<number,number>>={333:1,1891:3,1893:2,1895:1,1897:3,1899:2,1901:1};
export const cowFoodBites=(items:readonly {id:number;count:number}[])=>items.reduce((n,i)=>n+(COW_FOOD_BITES[i.id]??0)*i.count,0);
// HP one bite heals: trout 7, a cake bite 4, a chocolate cake bite 5. The trout rule held two trout, 14 HP of food;
// held food must cover the same HP whatever it is made of.
const COW_BITE_HEAL:Readonly<Record<number,number>>={333:7,1891:4,1893:4,1895:4,1897:5,1899:5,1901:5};
export const COW_FOOD_HP=14;
// When cow mode gives a cow up and picks another. In a shared field another account can take the cow over after our
// first swing (live claude-cloud: 190 idle ticks until the no-progress throw): release after COW_RELEASE ticks with the
// cow in someone else's combat. A cow we stopped fighting is released after COW_IDLE_RELEASE ticks with no own XP and
// no combat; a slow fight keeps earning own XP or shows the cow as our target, so it is never released.
export const COW_RELEASE=12,COW_IDLE_RELEASE=40;
export const cowReleased=(ticksTakenOver:number,ticksIdle=0)=>ticksTakenOver>=COW_RELEASE||ticksIdle>=COW_IDLE_RELEASE;
export const cowFoodHeal=(items:readonly {id:number;count:number}[])=>items.reduce((n,i)=>n+(COW_FOOD_BITES[i.id]??0)*(COW_BITE_HEAL[i.id]??0)*i.count,0);
// The next piece to eat: the fewest bites first, so partial cakes go before whole ones and slots free up.
export const cowFoodPick=<T extends {id:number}>(items:readonly T[])=>items.filter(i=>COW_FOOD_BITES[i.id]).sort((a,b)=>COW_FOOD_BITES[a.id]!-COW_FOOD_BITES[b.id]!)[0];
export async function runCows(s:Session, o:{cap:number;maximum:number;trainSkill?:string;targetLevel?:number;bankProfile?:string;foodMode?:string;diagnostics?:boolean;noProgress?:number;potions?:CombatPotionPolicy;stop?:()=>boolean;walk?:(x:number,z:number,tol:number)=>Promise<boolean>}) {
    const potionScope=o.potions?combatPotionSession(s,()=>!!o.stop?.(),o.cap):undefined;if(potionScope)s=potionScope;
    const profile=cowProfile(o.bankProfile,o.foodMode,o.maximum);
    if(!Number.isSafeInteger(o.cap)||o.cap<1) throw new Error('cow needs positive CAP and MAX_KILLS1..5');
    const training=cowTraining(o.trainSkill,o.targetLevel);
    const ids=[1739,526,2132],inv=()=>s.sdk.getInventory(),state=()=>s.sdk.getState();
    const count=(items:readonly {id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const held=(id:number)=>count(inv(),id),bites=()=>cowFoodBites(inv()),heal=()=>cowFoodHeal(inv()),xp=()=>s.sdk.getSkillXp('Attack')??0,hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    const selectedXp=()=>s.sdk.getSkillXp(training.skill)??0,level=()=>s.sdk.getSkill(training.skill)?.baseLevel??0;
    if(!await waitUntil(s,()=>hp()>0&&(profile.foodBanked||heal()>=COW_FOOD_HP)&&level()>0,{timeoutTicks:15})) throw new Error('cow prerequisite: stage2unnoted Trout (or 14HP of cake) and syncedHP/skill');
    const start=s.tick(),initialXp=xp(),initialSelectedXp=selectedXp(),startLevel=level(),p0=state()?.player;
    const goalReached=()=>training.targetLevel!==undefined&&level()>=training.targetLevel;
    if(!p0||p0.level!==0||Math.max(Math.abs(p0.worldX-profile.bank.x),Math.abs(p0.worldZ-profile.bank.z))>(profile.north?3:10)) throw new Error(profile.north?'cow prerequisite: stage at Ardougne north bank':'cow prerequisite: stage at Ardougne south bank');
    if(profile.foodBanked&&(hp()<60||(s.sdk.getSkill('Hitpoints')?.baseLevel??0)<60||(s.sdk.getSkill('Defence')?.level??0)<70))throw new Error('cow prerequisite: banked-food profile requires HPbase/current60 and Defence70');
    if(ids.some(id=>held(id)>0)) throw new Error('cow prerequisite: empty carried cow outputs');
    const allKit=()=>[...inv(),...(state()?.equipment??[])];
    for(const id of [1277,1171]) if(count(allKit(),id)<1) throw new Error(`cow prerequisite: missing kit${id}`);
    const kit=new Map<number,number>();for(const i of allKit())if(!ids.includes(i.id)&&!COW_FOOD_BITES[i.id])kit.set(i.id,(kit.get(i.id)??0)+i.count);
    let ended=false,died=false,healthCutoff=false,retreating=false,hpMin=hp(),creditedKills=0,damageXp=0,eaten=0,bankTrips=0,failure='',stop='cap',lastProgress=start,crowded=false;
    const diagnostics:Record<string,unknown>[]=[];
    let diagnosticKey='',diagnosticTick=-Infinity,activeIndex:number|undefined,attackStarted:number|undefined;
    const capture=(phase:string,x?:number,z?:number,gone=false)=>{
        const st=state(),n=st?.nearbyNpcs.find(n=>n.index===activeIndex);
        const evidence={phase,index:activeIndex,gone,anchor:x===undefined?null:[x,z],selectedXp:selectedXp()-initialSelectedXp,
            npc:n?{id:n.id,x:n.x,z:n.z,tileX:n.tileX,tileZ:n.tileZ,hp:n.hp,maxHp:n.maxHp,anim:n.animId,inCombat:n.inCombat,target:n.targetIndex}:null,
            player:st?.player?{x:st.player.worldX,z:st.player.worldZ,hp:hp(),life:st.player.lifeId,combat:st.player.combat}:null,
            others:(st?.nearbyPlayers??[]).slice(0,8).map(p=>({index:p.index,x:p.x,z:p.z,inCombat:p.inCombat,targetType:p.combatTargetType,target:p.combatTargetIndex})),
            ground:(st?.groundItems??[]).filter(i=>ids.includes(i.id)).slice(0,24).map(i=>({id:i.id,count:i.count,x:i.x,z:i.z}))};
        const key=JSON.stringify(evidence);
        if(key===diagnosticKey&&s.tick()-diagnosticTick<20)return;
        diagnosticKey=key;diagnosticTick=s.tick();
        if(diagnostics.length>=16)diagnostics.splice(2,1);
        diagnostics.push({tick:s.tick(),elapsed:s.tick()-start,sinceProgress:s.tick()-lastProgress,sinceAttack:attackStarted===undefined?null:s.tick()-attackStarted,...evidence});
    };
    void s.ended.then(()=>{ended=true;});
    const observeLife=()=>{const p=state()?.player;hpMin=Math.min(hpMin,hp());if(profile.foodBanked&&hp()<=40)healthCutoff=true;if(hp()<=0||p?.isDead||(p?.respawnCount??0)>(p0.respawnCount??0)||p?.lifeId!==p0.lifeId)died=true;};
    const off=s.onTick(observeLife);
    let walkTicks=0,walkedTiles=0,doorInteractions=0,houseInteractions=0,maxPackSlots=inv().length,detourTiles=0;
    let previousPosition={x:p0.worldX,z:p0.worldZ};
    const offMetrics=s.onTick(()=>{const p=state()?.player;maxPackSlots=Math.max(maxPackSlots,inv().length);if(p){const distance=Math.max(Math.abs(p.worldX-previousPosition.x),Math.abs(p.worldZ-previousPosition.z));if(distance){walkTicks++;walkedTiles+=distance;}previousPosition={x:p.worldX,z:p.worldZ};}});
    const bankDistances:number[]=[],walkLegs:Record<string,unknown>[]=[];
    const over=()=>{observeLife();return ended||died||!!o.stop?.()||s.tick()-start>=o.cap;};
    const potions=o.potions?createCombatPotions(s,o.potions,[training.skill,'Hitpoints'],over):undefined;
    const eat=async()=>{
        const food=cowFoodPick(inv());
        if(!food){stop='low-hp';throw new Error('no cow progress: low HP retreat, no working food');}
        const before=bites(),beforeHp=hp();await s.bot.eatFood(food);
        // SDK eat can finish on inventory debit before the HP packet arrives.
        const healed=await waitUntil(s,()=>bites()<before&&hp()>beforeHp||over(),{timeoutTicks:6});
        eaten+=Math.max(0,before-bites());
        if(!healed||bites()>=before||hp()<=6||over()){stop='low-hp';throw new Error('no cow progress: food did not heal before retreat');}
    };
    const walk=o.walk??(async(x,z,tol)=>{
        const p=state()?.player;if(!p)return false;
        const threat=()=>{
            observeLife();if(ended||died)return 'cow route session ended/dead';
            if(healthCutoff&&!retreating)return 'cow route banked-food HP40 cutoff';
            // A stop request halts outbound travel. The bank retreat still runs.
            if(!retreating&&o.stop?.())return 'cow route stop requested';
            if(hp()<=6)return 'cow route low HP';
            const now=state()?.player;
            if(now&&(now.level!==0||cowBearTile({x:now.worldX,z:now.worldZ})))return 'cow route entered bear bounds or unexpected floor';
            if(now&&(state()?.nearbyNpcs??[]).some(n=>/bear/i.test(n.name)&&Math.max(Math.abs((n.tileX??n.x)-now.worldX),Math.abs((n.tileZ??n.z)-now.worldZ))<=6))return 'cow route observed bear within6';
            return null;
        };
        const base=await sessionWalker(s),beforeTiles=walkedTiles,beforeTicks=walkTicks,beforeDoors=doorInteractions;
        const measured={...base,interactLoc:(loc:any,op:number)=>{if(op===1){doorInteractions++;if([[2640,3362],[2643,3360],[2632,3381]].some(([hx,hz])=>loc.x===hx&&loc.z===hz))houseInteractions++;}return base.interactLoc(loc,op);}};
        const guarded=guardCowWalker(measured,threat);
        const points=cowRoutePoints({x:p.worldX,z:p.worldZ},x,z,tol,profile.north);
        const r=await walkPath(guarded.deps,points,{look:6,stop:()=>!!guarded.reason()});
        const end=state()?.player,straight=end?Math.max(Math.abs(end.worldX-p.worldX),Math.abs(end.worldZ-p.worldZ)):0;
        const observed=walkedTiles-beforeTiles;detourTiles+=Math.max(0,observed-straight);
        if(walkLegs.length<20)walkLegs.push({from:[p.worldX,p.worldZ],to:[x,z],points,observedTiles:observed,walkTicks:walkTicks-beforeTicks,doorInteractions:doorInteractions-beforeDoors,ok:r.ok});
        const reason=guarded.reason();
        if(reason){
            // Cancel a previous queued walk before recovery. A current-tile
            // cancellation is not a neighboring-tile route probe.
            const now=state()?.player;if(now&&!died&&!ended)await s.direct({type:'walkTo',x:now.worldX,z:now.worldZ,running:false,reason:'cow route halt'});
            if(hp()<=6&&!died&&!ended)await eat();
            throw new Error(`no cow progress: ${reason}; movement halted`);
        }
        return r.ok;
    });
    const open=async()=>{if(state()?.bank?.isOpen&&s.bankObservation?.())return;const gen=s.bankObservation?.()?.generation??0;
        if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>gen,{timeoutTicks:20}))throw new Error('no cow progress: bank readiness unknown');bankTrips++;};
    const bankCount=(id:number)=>count(s.bankObservation?.()?.items??[],id);
    const baseline:Record<number,number>={};
    const assetTotals=()=>{const m=new Map<number,number>();for(const i of [...(s.bankObservation?.()?.items??[]),...allKit()])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
    let initialAssets:Map<number,number>|undefined,initialFood:number|undefined;
    const ownedFood=()=>s.bankObservation?.()?bites()+cowFoodBites(s.bankObservation?.()?.items??[]):undefined;
    const bank=async()=>{
        retreating=true;
        const p=state()?.player;if(p)bankDistances.push(Math.max(Math.abs(p.worldX-profile.bank.x),Math.abs(p.worldZ-profile.bank.z)));
        if(!await walk(profile.bank.x,profile.bank.z,profile.north?1:2))throw new Error('no cow progress: bank retreat failed');await open();
        for(const id of [...ids,...potions?.depositIds??[]]){const item=inv().find(i=>i.id===id);if(item){const before=bankCount(id),amount=held(id);
            if(!(await s.bot.depositItem(item,-1)).success||held(id)>0||!await waitUntil(s,()=>bankCount(id)===before+amount,{timeoutTicks:20}))throw new Error('no cow progress: deposit failed');}}
        if(!profile.foodBanked)for(let tries=0;heal()<COW_FOOD_HP&&tries<6;tries++){
            // Trout first (one bite each); otherwise the smallest banked cake piece.
            const items=state()?.bank.items??[],trout=items.find(i=>i.id===333),item=trout??cowFoodPick(items),want=heal()+(trout?7:0);
            if(!item||!(await s.bot.withdrawItem(item,trout?Math.min(trout.count,Math.ceil((COW_FOOD_HP-heal())/7)):1,{asNote:false})).success)break;
            await waitUntil(s,()=>heal()>=Math.min(COW_FOOD_HP,want),{timeoutTicks:5});
        }
        if(!profile.foodBanked&&heal()<COW_FOOD_HP)throw new Error('no cow progress: working food restock failed');
    };
    try {
        await open();for(const id of ids)baseline[id]=bankCount(id);initialAssets=assetTotals();initialFood=ownedFood();await s.bot.closeBank();
        if(!goalReached()&&!over()){
        await equipCowKit(s,over);
        if(profile.foodBanked){
            await open();const food=inv().find(i=>i.id===333);if(food){const before=bankCount(333),amount=held(333);if(!(await s.bot.depositItem(food,-1)).success||!await waitUntil(s,()=>held(333)===0&&bankCount(333)===before+amount,{timeoutTicks:10}))throw new Error('no cow progress: working food secure bank failed');}
            await s.bot.closeBank();if(inv().some(i=>!potions?.depositIds.includes(i.id)))throw new Error('cow prerequisite: banked-food fullpack requires empty inventory after worn kit prep');
        }
        if(!(await s.sdk.sendSetCombatStyle(training.style)).success||!await waitUntil(s,()=>{
            const c=state()?.combatStyle;return !!c?.known&&c.currentStyle===training.style
                &&c.weaponName==='Bronze sword'&&c.styles.some(style=>style.index===training.style&&style.trainsSkills.length===1&&style.trainsSkills[0]===training.skill);
        },{timeoutTicks:10}))throw new Error('no cow progress: selected combat style unobserved');
        if(!await walk(2664,3344,4))throw new Error('no cow progress: pen route failed');
        }
        lastProgress=s.tick(); // Transit is bounded by CAP, not the target-wait window.
        while(creditedKills<o.maximum&&!goalReached()&&!over()){
            if(healthCutoff)throw new Error('no cow progress: banked-food HP40 cutoff; retreat');
            if(profile.north&&28-inv().length<3)throw new Error('no cow progress: insufficient slots for three cow drops');
            if(hp()<=6)await eat();
            if(potions)await potions.poll();
            // The nearest free cow with no other player within 2 tiles (one about to attack it). The planner puts
            // COW_FIELD_CAPACITY army accounts in this field (autopilot); a 12-tile gap left a second one 198 ticks idle.
            const players=state()?.nearbyPlayers??[];
            const pen=(state()?.nearbyNpcs??[]).filter(n=>n.id===81&&n.x>=2655&&n.x<=2676&&n.z>=3338&&n.z<=3357);
            const beside=(n:{x:number;z:number})=>players.some(p=>Math.max(Math.abs(p.x-n.x),Math.abs(p.z-n.z))<=2);
            const target=pen.filter(n=>!n.inCombat&&(n.hp==null||n.maxHp==null||n.hp>=n.maxHp)&&!beside(n)).sort((a,b)=>a.distance-b.distance)[0];
            // No attack started for the whole window. A run that has kills banks them and ends (the field is busy);
            // one with none fails and says what the pen held.
            if(s.tick()-lastProgress>=(o.noProgress??200)){
                if(creditedKills>0){crowded=true;break;}
                throw new Error(`no cow progress: target/loot timeout cows=${pen.length} inCombat=${pen.filter(n=>n.inCombat).length} besidePlayer=${pen.filter(n=>!n.inCombat&&beside(n)).length} players=${players.length}`);
            }
            if(!target){await waitTicks(s,1);continue;}
            const beforeXp=selectedXp(),groundBefore=cowGroundCounts(state()?.groundItems??[]);
            let x=target.tileX??target.x,z=target.tileZ??target.z;
            if(target.distance>2&&!await walk(x,z,2))throw new Error('no cow progress: guarded cow approach failed');
            // SDK attack consumes a passed object as-is and may otherwise walk
            // to stale render coordinates. Refresh the same index, then refuse
            // an out-of-reach approach instead of allowing that unguarded walk.
            const attackTarget=state()?.nearbyNpcs.find(n=>n.index===target.index&&n.id===81);
            if(!attackTarget||attackTarget.distance>2||attackTarget.inCombat){await waitTicks(s,1);continue;}
            activeIndex=target.index;attackStarted=s.tick();capture('before-attack',x,z);
            if(!(await s.bot.attack(attackTarget)).success){await waitTicks(s,1);continue;}
            let observedXp=beforeXp;lastProgress=s.tick();
            let gone=false,goneAt=0,released=false,lastEngaged=s.tick(),lastActive=s.tick();
            while(!over()){
                if(healthCutoff)throw new Error('no cow progress: banked-food HP40 cutoff; retreat');
                if(hp()<=6)await eat();
                if(potions&&state()?.player?.combat.targetType==='npc'&&state()?.player?.combat.targetIndex===target.index)await potions.poll(target);
                const current=gone?undefined:state()?.nearbyNpcs.find(n=>n.index===target.index);
                if(current){x=current.tileX??current.x;z=current.tileZ??current.z;}else if(!gone){gone=true;goneAt=s.tick();}
                // Own selected-skill XP is productive combat progress. Animation,
                // dispatch success and other players' hits do not renew this wait.
                if(selectedXp()>observedXp){observedXp=selectedXp();lastProgress=s.tick();lastActive=s.tick();}
                const combat=state()?.player?.combat,ours=combat?.targetType==='npc'&&combat.targetIndex===target.index;
                if(!current?.inCombat||ours)lastEngaged=s.tick();
                if(ours)lastActive=s.tick();
                capture('await-credit',x,z,gone);
                const drops=ids.map(id=>count((state()?.groundItems??[]).filter(i=>i.x===x&&i.z===z),id)-(groundBefore.get(`${id}:${x}:${z}`)??0));
                if(cowCredit(gone,selectedXp()-beforeXp,drops))break;
                if(!gone&&cowReleased(s.tick()-lastEngaged,s.tick()-lastActive)){released=true;break;}
                // A cow another account killed leaves this one no drops, and a new cow takes its index: the credit never
                // comes (practice, six at once: 2 of 18 runs waited out the window). Give it up at once with no own XP
                // on it, or 10 ticks after it went with XP but no drops.
                if(gone&&(selectedXp()===beforeXp||s.tick()-goneAt>=10)){released=true;break;}
                if(s.tick()-lastProgress>=(o.noProgress??200))throw new Error('no cow progress: target/loot timeout');await waitTicks(s,1);
            }
            if(over())break;
            if(released){capture('released',x,z);continue;}
            for(const id of ids){const item=state()?.groundItems.find(i=>i.id===id&&i.x===x&&i.z===z);const before=held(id);
                if(!item||!(await s.bot.pickupItem(item)).success||held(id)!==before+1)throw new Error('no cow progress: credited loot pickup mismatch');}
            creditedKills++;damageXp+=selectedXp()-beforeXp;lastProgress=s.tick();console.log(`MILESTONE cow credited=${creditedKills} trainSkill=${training.skill} selectedXp=${selectedXp()-initialSelectedXp} level=${level()} attackXp=${xp()-initialXp} HP=${hp()} heldHide=${held(1739)}`);
        }
        stop=goalReached()?'target-level':creditedKills===o.maximum?'max-kills':died?'died':o.stop?.()?'stop-file':crowded?'crowded':'cap';
    } catch(e){failure=String(e);if(stop==='cap'&&o.stop?.())stop='stop-file';capture('failure');console.log(`COW_DIAGNOSTIC ${JSON.stringify(diagnostics)}`);}
    finally {if(!died&&!ended)try{if(potionScope)await potionScope.withCombatPotionCleanup(bank);else await bank();}catch(e){failure=[failure,String(e)].filter(Boolean).join('; ');}off();offMetrics();}
    const banked={hide:bankCount(1739)-(baseline[1739]??bankCount(1739)),bones:bankCount(526)-(baseline[526]??bankCount(526)),beef:bankCount(2132)-(baseline[2132]??bankCount(2132))};
    const finalAssets=profile.foodBanked||potions?assetTotals():undefined;
    const preserved=potions?!!initialAssets&&!!finalAssets&&[...new Set([...initialAssets.keys(),...finalAssets.keys()])].every(id=>ids.includes(id)||(finalAssets.get(id)??0)===(initialAssets!.get(id)??0)+(potions.delta[id]??0)-(id===333?eaten:0)):profile.foodBanked?!!initialAssets&&!!finalAssets&&[...new Set([...initialAssets.keys(),...finalAssets.keys()])].every(id=>ids.includes(id)||(finalAssets.get(id)??0)===(initialAssets!.get(id)??0)):[...kit].every(([id,n])=>count(allKit(),id)===n)&&heal()>=COW_FOOD_HP;
    // Owned food (in bites) in pack and bank changes only by observed eating.
    const finalFood=ownedFood(),foodAccounted=initialFood!==undefined&&finalFood===initialFood-eaten;
    const targetMet=(training.targetLevel!==undefined?goalReached():creditedKills===o.maximum)&&Object.values(banked).every(n=>n===creditedKills);
    const partial=(training.targetLevel!==undefined&&['max-kills','cap'].includes(stop)||stop==='crowded')&&!targetMet&&creditedKills>0
        &&Object.values(banked).every(n=>n===creditedKills)&&!failure&&!died&&!ended&&preserved&&foodAccounted;
    if(o.diagnostics&&!failure)console.log(`COW_DIAGNOSTIC ${JSON.stringify(diagnostics)}`);
    return {...potions?{potions:{doses:potions.doses,delta:potions.delta,receipts:potions.receipts,blocked:potions.blocked,resumes:potions.resumes}}:{},ok:!failure&&!died&&!ended&&(targetMet||partial)&&preserved&&foodAccounted,creditedKills,banked,trainSkill:training.skill,targetLevel:training.targetLevel??null,startLevel,finalLevel:level(),selectedXp:selectedXp()-initialSelectedXp,attackXp:xp()-initialXp,damageXp,eaten,initialFood:initialFood??null,finalFood:finalFood??null,foodAccounted,bankTrips,hpMin,died,lifeId:state()?.player?.lifeId,respawns:state()?.player?.respawnCount,ticks:s.tick()-start,preserved,targetMet,partial,stop,failure:failure||(!targetMet&&!partial?'no cow progress: bounded target unmet':'-'),diagnostics:failure||o.diagnostics?diagnostics:[],bankProfile:profile.north?'north':'south',foodMode:profile.foodBanked?'banked':'held',healthCutoff,walkTicks,walkedTiles,detourTiles,doorInteractions,houseInteractions,maxPackSlots,bankDistances,walkLegs};
}

// Surface Giant117 camp and its reachable Ardougne south bank.
export const GIANT={npc:117,food:385,bigBones:532,limpwurt:225,bank:{x:2655,z:3283},spot:{x:2545,z:3144},room:[2537,3136,2556,3155]} as const;
export const GIANT_HERBS:readonly number[]=[199,201,203,205,207,209,211,213,215,217,219];
const GIANT_DROPS:readonly number[]=[GIANT.bigBones,GIANT.limpwurt,...GIANT_HERBS];
// A melee training site for runGiants: the NPCs, their room, the bank the trainer returns to, the one-bite foods it
// carries (first owned in order), the drops it banks, and the drop that credits a kill. A site with no credit drop
// counts a kill once the target is gone and own XP rose.
export type CombatSite={label:string;npcs:readonly number[];foods:readonly number[];bank:{x:number;z:number};spot:{x:number;z:number};room:readonly number[];drops:readonly number[];creditDrop?:number};
export const GIANT_SITE:CombatSite={label:'giant',npcs:[GIANT.npc],foods:[GIANT.food],bank:GIANT.bank,spot:GIANT.spot,room:GIANT.room,drops:GIANT_DROPS,creditDrop:GIANT.bigBones};
// Khazard troopers on the Gnome battlefield, multiway open ground, reached from the Ardougne north bank. They have HP 22
// and defence 12, and no huntmode, so they never attack first (quests/quest_tree/configs/gnome_battlefield.npc). They
// spawn at x 2502-2544, z 3232-3255 (maps/m39_50.jm2) and wander 9 tiles. Style XP there is 81 per tick at band 40 and
// 137 at band 70 in rune gear (research/combat-measure.md section 1), against 16 at the cows.
export const TROOPER_SITE:CombatSite={label:'trooper',npcs:[475,476],foods:[385,373,379,333,2142],bank:{x:2619,z:3332},spot:{x:2525,z:3242},room:[2493,3223,2553,3264],drops:[]};
// Reuse counted owned-loadout selection with level-gated metal blades.
// Preference follows tier then the shared scimitar/sword/longsword order.
// An observed wield still decides access for special swords.
export function selectGiantWeapon(stock:readonly {id:number;count:number}[],attack:number|null){
    const slot=fireWeaponSlot(attack);
    const known=attack!==null&&Number.isSafeInteger(attack)&&attack>=1&&attack<=99;
    const metals=[{level:40,ids:[1333,1289,1303]},{level:30,ids:[1331,1287,1301]},
        {level:20,ids:[1329,1285,1299]},{level:10,ids:[1327,1283,1297]},
        {level:5,ids:[1325,1281,1295]},{level:1,ids:[1323,1279,1293,1321,1277,1291]}];
    const options=metals.flatMap((tier,index)=>tier.ids.map((id,offset)=>({id,count:1,preference:index*10+offset,equippable:known?attack!>=tier.level:null})));
    slot.options=[...options,{id:35,count:1,preference:31,equippable:known?true:null},
        {id:2402,count:1,preference:43,equippable:known?true:null}];
    const choice=ownedLoadout([slot],stock);
    return choice.state==='ready'?choice.selected[0]!.id:0;
}
// Ranged (TRAIN_SKILL=Ranged): the best owned bow for the Ranged level, a shortbow before a longbow in a tier (a longbow's
// attackrate is 6, ranged/bows.obj), and the best owned arrows it fires: an arrow's levelrequire may not exceed the
// bow's (player_ranged.rs2 player_ranged_check_ammo).
export const GIANT_RANGED_RELEASE=40;
export const GIANT_BOWS=[{level:50,ids:[861,859]},{level:40,ids:[857,855]},{level:30,ids:[853,851]},{level:20,ids:[849,847]},{level:5,ids:[843,845]},{level:1,ids:[841,839]}] as const;
export const GIANT_ARROWS=[{level:40,id:892},{level:30,id:890},{level:20,id:888},{level:5,id:886},{level:1,id:884},{level:1,id:882}] as const;
const stockOf=(stock:readonly {id:number;count:number}[],id:number)=>stock.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function selectGiantBow(stock:readonly {id:number;count:number}[],ranged:number){
    for(const tier of GIANT_BOWS)if(tier.level<=ranged)for(const id of tier.ids)if(stockOf(stock,id)>0)return{id,level:tier.level};
    return undefined;
}
export function selectGiantArrows(stock:readonly {id:number;count:number}[],ranged:number,bowLevel:number){
    return GIANT_ARROWS.find(a=>a.level<=Math.min(ranged,bowLevel)&&stockOf(stock,a.id)>0)?.id;
}
const inBox=(b:readonly number[],x:number,z:number)=>x>=b[0]!&&x<=b[2]!&&z>=b[1]!&&z<=b[3]!;
export function giantTraining(skill?:string,targetLevel?:number){
    if(!skill||!['Attack','Strength','Defence','Hitpoints','Ranged'].includes(skill))throw new Error('giant TRAIN_SKILL must be Attack, Strength, Defence, Hitpoints or Ranged');
    if(targetLevel===undefined||!Number.isSafeInteger(targetLevel)||targetLevel<2||targetLevel>99)throw new Error('giant TARGET_LEVEL must be2..99');
    return {skill,targetLevel};
}
type StyleTab={known:boolean;weaponName:string;currentStyle:number;styles:readonly {index:number;name:string;trainsSkills:readonly string[]}[]};
// The wielded weapon's own tab decides the index: Strength is1 on a sword, scimitar or 2h; controlled never counts.
export function giantStyle(tab:StyleTab|undefined,skill:string){
    if(!tab?.known)throw new Error('giant prerequisite: wielded weapon combat styles unknown');
    const only=tab.styles.filter(s=>s.trainsSkills.length===1&&s.trainsSkills[0]===skill);
    // A bow's rapid style fires a tick sooner than accurate and trains only Ranged.
    const style=skill==='Hitpoints'?(tab.styles.find(s=>s.index===tab.currentStyle)??tab.styles[0]):only.find(s=>/rapid/i.test(s.name))??only[0];
    if(!style)throw new Error(`giant prerequisite: ${tab.weaponName} has no style that trains only ${skill}`);
    return {index:style.index,name:style.name,weapon:tab.weaponName};
}
export const giantCredit=(gone:boolean,selectedXp:number,newBigBones:number)=>gone&&selectedXp>0&&newBigBones>=1;
export function giantKillLimit(value?:string|number){
    if(value===undefined)return undefined;
    const maximum=Number(value);
    if(!Number.isSafeInteger(maximum)||maximum<1)throw new Error('giant GIANT_KILLS must be a positive safe integer');
    return maximum;
}
const COINS=995,BONES=526;
// The free target one account takes on open ground it shares. Accounts that stand together would all take the
// nearest free trooper and split every kill (practice, six at once: a median 45 XP per tick an account against 62
// alone). In company each account ranks the free targets by distance plus its own fixed offset of 0-7 tiles, so they
// pick different ones (57 a tick, research/combat-measure.md). `free` is nearest first.
export function roamTarget<T extends {index:number;distance:number}>(account:string,free:readonly T[],company:boolean):T|undefined{
    if(!company)return free[0];
    const offset=(index:number)=>{let h=2166136261;for(const c of `${account}:${index}`)h=Math.imul(h^c.charCodeAt(0),16777619);return (h>>>0)%8;};
    return [...free].sort((a,b)=>a.distance+offset(a.index)-(b.distance+offset(b.index)))[0];
}
// A target that fights another player: in combat and facing a player slot that is not this account's.
export const anothersFight=(npc:{inCombat?:boolean;targetIndex?:number}|undefined,selfSlot:number|undefined)=>
    !!npc?.inCombat&&selfSlot!==undefined&&(npc.targetIndex??-1)>=32768&&npc.targetIndex!==32768+selfSlot;
export async function runGiants(s:Session,o:{cap:number;trainSkill?:string;targetLevel?:number;maximum?:number;food?:number;ammo?:number;bury?:boolean;eatAt?:number;noProgress?:number;stop?:()=>boolean;walk?:(x:number,z:number,tol:number,signal?:AbortSignal)=>Promise<boolean>;site?:CombatSite}){
    const site=o.site??GIANT_SITE,label=site.label;
    const maximum=giantKillLimit(o.maximum);
    const training=giantTraining(o.trainSkill,o.targetLevel);
    if(!Number.isSafeInteger(o.cap)||o.cap<1)throw new Error('giant needs positive CAP');
    const carry=o.food??5;if(!Number.isSafeInteger(carry)||carry<1||carry>20)throw new Error('giant GIANT_FOOD must be1..20');
    const ranged=training.skill==='Ranged',ammoCarry=o.ammo??500;
    // A site credited by XP alone (the troopers) shares its targets with gnomes and other players: it lets go of a lost
    // target and walks back to the spot when none is in view. The giants' big-bone credit keeps the strict wait.
    const roam=site.creditDrop===undefined;
    // Burying stops at Prayer 99: from there it only costs kills.
    const bury=roam&&!!o.bury&&(s.sdk.getSkill('Prayer')?.baseLevel??1)<99,prayerXp=()=>s.sdk.getSkillXp('Prayer')??0,prayerStart=prayerXp();let buried=0;
    if(ranged&&(!Number.isSafeInteger(ammoCarry)||ammoCarry<1||ammoCarry>100000))throw new Error('giant GIANT_AMMO must be1..100000');
    const inv=()=>s.sdk.getInventory(),state=()=>s.sdk.getState();
    const count=(items:readonly {id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const held=(id:number)=>count(inv(),id),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    const heldFood=()=>site.foods.reduce((n,id)=>n+held(id),0);
    // Base level is the trained level: client and engine share the level/10 XP curve (Player.ts levelExperience).
    // The current level can be drained or boosted and restores without XP, so it never counts as training.
    const selectedXp=()=>s.sdk.getSkillXp(training.skill)??0,level=()=>s.sdk.getSkill(training.skill)?.baseLevel??0;
    if(!await waitUntil(s,()=>hp()>0&&level()>0&&!!state()?.player&&!!state()?.combatStyle?.known,{timeoutTicks:15}))throw new Error('giant prerequisite: synced HP, skill and combat styles');
    const eatAt=o.eatAt??Math.max(10,Math.ceil((s.sdk.getSkill('Hitpoints')?.baseLevel??0)/2));
    const start=s.tick(),p0=state()!.player!,initialSelectedXp=selectedXp(),startLevel=level();
    const goalReached=()=>maximum===undefined?level()>=training.targetLevel:creditedKills>=maximum;
    const near=(x:number,z:number,tol:number)=>{const p=state()?.player;return !!p&&p.level===0&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=tol;};
    let style:ReturnType<typeof giantStyle>|undefined;
    const allKit=()=>[...inv(),...(state()?.equipment??[])];
    // Ranged: the chosen arrows ride in the quiver (wearpos 13) and are spent, so the asset proof excludes them.
    let ammoId:number|undefined,ammoBank=0,ammoStart=0;
    const quiver=()=>count((state()?.equipment??[]).filter(i=>i.slot===13),ammoId??-1);
    let ended=false,died=false,hpMin=hp(),creditedKills=0,limpwurt=0,eaten=0,bankTrips=0,failure='',stop='cap',lastProgress=start,bankFood=0;
    void s.ended.then(()=>{ended=true;});
    const observeLife=()=>{const p=state()?.player;hpMin=Math.min(hpMin,hp());if(hp()<=0||p?.isDead||(p?.respawnCount??0)>(p0.respawnCount??0)||p?.lifeId!==p0.lifeId)died=true;};
    const off=s.onTick(observeLife);
    const over=()=>{observeLife();return ended||died||!!o.stop?.()||s.tick()-start>=o.cap;};
    const eat=async()=>{
        // The debit proves the bite. SDK eat can finish on inventory debit before the HP packet arrives, so it waits
        // for the rise; a hit that lands with the bite hides it (practice: cooked meat heals 3 and a run ended on
        // "did not heal" at the third bite), so no rise within 3 ticks is not a failure. The live server can drop an
        // action sent during another one, so an eat with no debit is sent again, three times in all, before the run
        // fails (live: Knightstick ended a run on "did not heal" with 80 cooked meat held). A stop or the cap during
        // the wait is not a failed bite.
        for(let attempt=0;attempt<3;attempt++){
            const food=inv().find(i=>site.foods.includes(i.id));if(!food)return false;
            const before=heldFood(),beforeHp=hp();await s.bot.eatFood(food);
            await waitUntil(s,()=>heldFood()<before||over(),{timeoutTicks:6});
            eaten+=Math.max(0,before-heldFood());
            if(heldFood()<before){await waitUntil(s,()=>hp()>beforeHp||over(),{timeoutTicks:3});return true;}
            if(over())return true;
        }
        throw new Error(`no ${label} progress: shark did not heal`);
    };
    // A stop or the cap cancels only the walk out to the camp: the retreat to the bank always runs.
    const walk=async(x:number,z:number,tol:number,outbound=false)=>{
        const sustain=startQuestSustain({...s,direct:async a=>await s.direct(a) as {success:boolean;message?:string}},
            {food:[...site.foods],eatAt,onConsumed:()=>eaten++});
        const cancel=new AbortController(),offTick=outbound?s.onTick(()=>{if(over())cancel.abort('stop requested');}):undefined;
        const signal=outbound?AbortSignal.any([sustain.aborted,cancel.signal]):sustain.aborted;
        try{
            const ok=o.walk?await o.walk(x,z,tol,signal):
                // From the Varrock side the planner has no route to Ardougne: ferryWalk takes the ferries then.
                (await ferryWalk(s,{x,z,level:0},async(tile,planBudgetMs)=>goTo(s,await getWorld(),tile,accountOf(s),{maxRetriesPerLeg:2,legTimeoutTicks:150,signal,planBudgetMs}))).ok;
            await sustain.settle();
            if(sustain.failure())throw new Error(sustain.failure()!);
            return ok&&near(x,z,tol);
        }finally{offTick?.();await sustain.settle();}
    };
    const enter=async()=>{
        const arrived=await walk(site.spot.x,site.spot.z,3,true);
        if(over())return;
        if(!arrived||!near(site.spot.x,site.spot.z,3))throw new Error(`no ${label} progress: surface camp arrival unobserved`);
    };
    // The retreat turns auto-retaliate off: a trooper still fighting holds a bow user in place to shoot back, and live
    // TheFullMonty's walk out failed ("bank retreat failed") and left it on the battlefield when the session dropped.
    // It tries the walk up to three times while each try ends closer, then restores auto-retaliate.
    const retaliate=async(on:boolean)=>{
        if(state()?.autoRetaliateEnabled===on||state()?.autoRetaliateEnabled===undefined)return false;
        await s.direct({type:'clickComponent',componentId:on?150:151,reason:`${label} retreat auto-retaliate ${on?'ON':'OFF'}`});
        return await waitUntil(s,()=>state()?.autoRetaliateEnabled===on,{timeoutTicks:5});
    };
    const leave=async()=>{
        const off=await retaliate(false);
        console.log(`RETREAT ${label} autoRetaliateOff=${off}`);
        try{
            let best=Infinity;
            for(let n=0;n<3;n++){
                if(await walk(site.bank.x,site.bank.z,3)&&near(site.bank.x,site.bank.z,3))return;
                const p=state()?.player,d=p?Math.max(Math.abs(p.worldX-site.bank.x),Math.abs(p.worldZ-site.bank.z)):Infinity;
                console.log(`WALK_RETRY ${label} retreat try=${n+1} distance=${d}`);
                if(d>=best)break;best=d;
            }
            throw new Error(`no ${label} progress: bank retreat failed`);
        }finally{if(off)console.log(`RETREAT ${label} autoRetaliateRestored=${await retaliate(true)}`);}
    };
    const open=async()=>{if(state()?.bank?.isOpen&&s.bankObservation?.())return;const gen=s.bankObservation?.()?.generation??0;
        if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>gen,{timeoutTicks:20}))throw new Error(`no ${label} progress: bank readiness unknown`);bankTrips++;};
    const bankCount=(id:number)=>count(s.bankObservation?.()?.items??[],id);
    // Coins never ride to the field: a death there loses the pack (live: TheFullMonty died on the Gnome battlefield).
    const deposit=async()=>{for(const id of [...site.drops,COINS,...bury?[BONES]:[]]){const item=inv().find(i=>i.id===id);if(!item)continue;const before=bankCount(id),amount=held(id);
        if(!(await s.bot.depositItem(item,-1)).success||!await waitUntil(s,()=>held(id)===0&&bankCount(id)===before+amount,{timeoutTicks:20}))throw new Error(`no ${label} progress: deposit failed`);}};
    const restock=async()=>{
        // Each owned kind in site order until the pack carries `carry` pieces.
        for(const id of site.foods){
            const take=Math.min(carry-heldFood(),bankCount(id),28-inv().length);
            if(take<1)continue;
            const row=state()?.bank?.items.find(i=>i.id===id),before=held(id);
            if(!row||!(await s.bot.withdrawItem(row,take,{asNote:false})).success||!await waitUntil(s,()=>held(id)===before+take,{timeoutTicks:20}))throw new Error(`no ${label} progress: shark withdraw failed`);
        }
        bankFood=site.foods.reduce((n,id)=>n+bankCount(id),0);
    };
    const ownedFood=()=>s.bankObservation?.()?heldFood()+site.foods.reduce((n,id)=>n+bankCount(id),0):undefined;
    const baseline:Record<number,number>={},picked:Record<number,number>={};let initialFood:number|undefined,initialAssets:Map<number,number>|undefined;
    const assetTotals=()=>{const m=new Map<number,number>();for(const i of [...(s.bankObservation?.()?.items??[]),...allKit()])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
    const withdrawAmmo=async()=>{
        if(ammoId===undefined)return;const id=ammoId,take=Math.min(ammoCarry-quiver()-held(id),bankCount(id));
        if(take>0){const row=state()?.bank?.items.find(i=>i.id===id),before=held(id);
            if(!row||!(await s.bot.withdrawItem(row,take,{asNote:false})).success||!await waitUntil(s,()=>held(id)===before+take,{timeoutTicks:20}))throw new Error(`no ${label} progress: arrow withdraw failed`);}
        ammoBank=bankCount(id);
    };
    const equipAmmo=async()=>{
        if(ammoId===undefined)return;const id=ammoId,item=inv().find(i=>i.id===id);if(!item)return;const before=quiver();
        if(!(await s.bot.equipItem(item)).success||!await waitUntil(s,()=>quiver()>before&&held(id)===0,{timeoutTicks:10}))throw new Error(`no ${label} progress: arrows not in the quiver`);
    };
    const rangedKit=()=>{
        const stock=[...(s.bankObservation?.()?.items??[]),...allKit()],level=s.sdk.getSkill('Ranged')?.baseLevel??1;
        const bow=selectGiantBow(stock,level);if(!bow)throw new Error('giant prerequisite: no owned bow for the Ranged level');
        ammoId=selectGiantArrows(stock,level,bow.level);if(ammoId===undefined)throw new Error('giant prerequisite: no owned arrows the bow fires');
        ammoStart=bankCount(ammoId)+count(allKit(),ammoId);
        return bow.id;
    };
    const trip=async()=>{await leave();await open();await deposit();await restock();if(ranged)await withdrawAmmo();await s.bot.closeBank();if(ranged)await equipAmmo();if(over())return;await enter();lastProgress=s.tick();};
    try{
        if(!near(site.bank.x,site.bank.z,6))await leave();
        await open();initialAssets=assetTotals();for(const id of site.drops){baseline[id]=bankCount(id)+held(id);picked[id]=0;}initialFood=ownedFood();if(initialFood!==undefined)initialFood+=eaten;
        await deposit();
        if(!goalReached()&&!over()){
            await restock();
            const weapon=ranged?rangedKit():selectGiantWeapon([...(s.bankObservation?.()?.items??[]),...allKit()],s.sdk.getSkill('Attack')?.baseLevel??null);
            if(!weapon)throw new Error('giant prerequisite: no owned equippable melee weapon');
            if(!allKit().some(i=>i.id===weapon)){
                const row=state()?.bank?.items.find(i=>i.id===weapon),before=bankCount(weapon);
                if(!row||!(await s.bot.withdrawItem(row,1,{asNote:false})).success||!await waitUntil(s,()=>held(weapon)===1&&bankCount(weapon)===before-1,{timeoutTicks:20}))throw new Error('giant prerequisite: weapon withdrawal unobserved');
            }
            if(ranged)await withdrawAmmo();
            await s.bot.closeBank();
            if(!state()?.equipment?.some(i=>i.slot===3&&i.id===weapon)){
                const item=inv().find(i=>i.id===weapon);
                if(!item||!(await s.bot.equipItem(item)).success||!await waitUntil(s,()=>!!state()?.equipment?.some(i=>i.slot===3&&i.id===weapon),{timeoutTicks:10}))throw new Error('giant prerequisite: melee weapon equip unobserved');
            }
            if(ranged){await equipAmmo();if(quiver()<1)throw new Error('giant prerequisite: no arrows in the quiver');}
            if(!await waitUntil(s,()=>!!state()?.combatStyle?.known&&state()?.combatStyle?.weaponName===state()?.equipment?.find(i=>i.slot===3)?.name,{timeoutTicks:10}))throw new Error('giant prerequisite: equipped combat styles unknown');
            const selectedStyle=giantStyle(state()?.combatStyle,training.skill);style=selectedStyle;
            if(heldFood()<1)throw new Error(`${label} prerequisite: no owned shark`);
            if(!(await s.sdk.sendSetCombatStyle(selectedStyle.index)).success||!await waitUntil(s,()=>{const c=state()?.combatStyle;return !!c?.known&&c.currentStyle===selectedStyle.index&&c.weaponName===selectedStyle.weapon;},{timeoutTicks:10}))
                throw new Error(`no ${label} progress: selected combat style unobserved`);
            if(hp()<=eatAt&&!await eat())throw new Error('giant prerequisite: no carried shark before transit');
            await enter();
        }
        lastProgress=s.tick(); // Transit is bounded by CAP, not the target-wait window.
        const retry=new Map<number,number>();
        const selfSlot=(s as {client?:{selfSlot?:number}}).client?.selfSlot;
        // Troopers leave bones on every kill (npc_combat.param death_drop). With GIANT_BURY the trainer takes the bones
        // its own kill left on the death tile and buries them. Each step is bounded and a miss skips the bone: the
        // fight never waits on it, and a bone left in the pack is banked on the next trip.
        const buryOwn=async(x:number,z:number,fresh:number)=>{
            const item=fresh>0?state()?.groundItems.find(i=>i.id===BONES&&i.x===x&&i.z===z):undefined;
            if(!item||inv().length>=28)return;
            const before=held(BONES);
            if(!(await s.bot.pickupItem(item)).success||!await waitUntil(s,()=>held(BONES)>before,{timeoutTicks:8}))return;
            const bone=inv().find(i=>i.id===BONES),option=bone?.optionsWithIndex?.find(op=>/^bury$/i.test(op.text));
            if(!bone||!option)return;
            const xp=prayerXp();
            if((await s.sdk.sendUseItem(bone.slot,option.opIndex)).success&&await waitUntil(s,()=>prayerXp()>xp,{timeoutTicks:6}))buried++;
            if(state()?.dialog?.isOpen)await s.bot.dismissBlockingUI();
        };
        while(!goalReached()&&!over()){
            // Out of food at low HP: a roam site (the troopers) ends the run there, ok after kills, as an empty quiver does.
            if(hp()<=eatAt&&!await eat()){if(bankFood<1){if(roam){stop='food';break;}stop='low-hp';throw new Error(`no ${label} progress: low HP and no owned shark`);}await trip();continue;}
            if(ranged&&quiver()<1){if(ammoBank<1){stop='ammo';break;}await trip();continue;}
            if(28-inv().length<2){await trip();continue;}
            if(s.tick()-lastProgress>=(o.noProgress??200))throw new Error(`no ${label} progress: target/loot timeout`);
            const free=(state()?.nearbyNpcs??[]).filter(n=>site.npcs.includes(n.id)&&inBox(site.room,n.tileX??n.x,n.tileZ??n.z)&&!n.inCombat&&n.reachable!==false
                &&(n.hp==null||n.maxHp==null||n.hp>=n.maxHp)&&(retry.get(n.index)??0)<=s.tick());
            const target=roamTarget(s.name,free,roam&&(state()?.nearbyPlayers??[]).some(p=>p.distance<=20));
            // With no trooper in view for 10 ticks it walks back to the spot (practice: two bow runs idled 307 ticks at
            // 2505,3242 and ended on the no-progress timeout).
            if(!target){if(roam&&s.tick()-lastProgress>=10&&!near(site.spot.x,site.spot.z,3))await walk(site.spot.x,site.spot.z,3,true);else await waitTicks(s,1);continue;}
            const beforeXp=selectedXp(),groundBefore=cowGroundCounts(state()?.groundItems??[]);
            if(!(await s.bot.attack(target)).success){retry.set(target.index,s.tick()+20);await waitTicks(s,1);continue;}
            let x=target.tileX??target.x,z=target.tileZ??target.z,observedXp=beforeXp,gone=false,dry=false,released=false,hungry=false,lastXp=s.tick();lastProgress=s.tick();
            const fresh=(id:number)=>count((state()?.groundItems??[]).filter(i=>i.x===x&&i.z===z),id)-(groundBefore.get(`${id}:${x}:${z}`)??0);
            while(!over()){
                // The pack's food is gone mid-fight: a roam site leaves the fight for the bank (or ends the run, above).
                if(hp()<=eatAt&&!await eat()){if(roam){hungry=true;break;}stop='low-hp';throw new Error(`no ${label} progress: low HP in combat and no carried shark`);}
                const current=state()?.nearbyNpcs.find(n=>n.index===target.index);
                if(current){x=current.tileX??current.x;z=current.tileZ??current.z;}else gone=true;
                // Own selected-skill XP is productive combat progress; dispatch success is not.
                if(selectedXp()>observedXp){observedXp=selectedXp();lastProgress=s.tick();lastXp=s.tick();}
                if(site.creditDrop===undefined?gone&&selectedXp()>beforeXp:giantCredit(gone,selectedXp()-beforeXp,fresh(site.creditDrop)))break;
                // An empty quiver stops the bow mid-fight: restock instead of waiting out the no-progress window.
                if(ranged&&quiver()<1){dry=true;break;}
                // Give up a target that 40 ticks of own attacks have not hit, as cow mode releases a cow. A bow needs line of
                // sight (practice: one stood 289 ticks at 2521,3247 and the run ended on the no-progress timeout).
                if(roam&&!gone&&s.tick()-lastXp>=GIANT_RANGED_RELEASE){retry.set(target.index,s.tick()+50);released=true;break;}
                // Another player's fight, and no own hit has landed: take a different trooper.
                if(roam&&selectedXp()===beforeXp&&anothersFight(current,selfSlot)){retry.set(target.index,s.tick()+20);released=true;break;}
                // A trooper another player or a gnome killed is gone with no own XP: the credit above never comes (practice: 290
                // idle ticks; live melee: TheFullMonty's first run ended on the no-progress timeout after 32 kills).
                if(roam&&gone){released=true;break;}
                // A level-up dialog holds the attack until dismissed (practice, Ranged 1 -> 29: 337 of 681 ticks under one).
                if(state()?.dialog?.isOpen){await s.bot.dismissBlockingUI();const again=state()?.nearbyNpcs.find(n=>n.index===target.index);if(again)await s.bot.attack(again);}
                if(s.tick()-lastProgress>=(o.noProgress??200))throw new Error(`no ${label} progress: target/loot timeout`);await waitTicks(s,1);
            }
            if(over())break;
            if(dry||released||hungry)continue;
            if(bury)await buryOwn(x,z,fresh(BONES));
            const roots=fresh(GIANT.limpwurt)>0;
            for(const id of site.drops.filter(id=>fresh(id)>0)){
                const amount=fresh(id),item=state()?.groundItems.find(i=>i.id===id&&i.x===x&&i.z===z),before=held(id);
                if(!item||!(await s.bot.pickupItem(item)).success||!await waitUntil(s,()=>held(id)===before+amount,{timeoutTicks:10}))throw new Error(`no ${label} progress: credited loot pickup mismatch`);
                picked[id]=(picked[id]??0)+amount;
            }
            creditedKills++;if(roots)limpwurt++;lastProgress=s.tick();
            console.log(`MILESTONE ${label} credited=${creditedKills} trainSkill=${training.skill} selectedXp=${selectedXp()-initialSelectedXp} level=${level()} HP=${hp()} sharks=${heldFood()} limpwurt=${limpwurt}`);
        }
        stop=goalReached()?(maximum===undefined?'target-level':'max-kills'):died?'died':o.stop?.()?'stop-file':stop==='ammo'||stop==='food'?stop:'cap';
    }catch(e){failure=String(e);if(stop==='cap'&&o.stop?.())stop='stop-file';}
    finally{if(!died&&!ended)try{if(!near(site.bank.x,site.bank.z,6))await leave();await open();await deposit();}catch(e){failure=[failure,String(e)].filter(Boolean).join('; ');}off();}
    const banked={bigBones:bankCount(GIANT.bigBones)-(baseline[GIANT.bigBones]??bankCount(GIANT.bigBones)),limpwurt:bankCount(GIANT.limpwurt)-(baseline[GIANT.limpwurt]??bankCount(GIANT.limpwurt))};
    const bankedHerbs=Object.fromEntries(GIANT_HERBS.map(id=>[id,bankCount(id)-(baseline[id]??bankCount(id))]));
    const bankedOf=(id:number)=>bankCount(id)-(baseline[id]??bankCount(id));
    const bankedAll=(site.creditDrop===undefined||bankedOf(site.creditDrop)===creditedKills)&&(site!==GIANT_SITE||banked.limpwurt===limpwurt)&&site.drops.every(id=>bankedOf(id)===(picked[id]??0));
    const finalAssets=assetTotals();
    const preserved=initialAssets!==undefined&&[...new Set([...initialAssets.keys(),...finalAssets.keys()])].every(id=>site.drops.includes(id)||site.foods.includes(id)||id===ammoId||bury&&id===BONES||(finalAssets.get(id)??0)===(initialAssets!.get(id)??0))&&site.drops.every(id=>held(id)===0);
    // Owned sharks in pack and bank change only by observed eating.
    const finalFood=ownedFood(),foodAccounted=initialFood!==undefined&&finalFood===initialFood-eaten;
    const targetMet=goalReached()&&bankedAll;
    const partial=!targetMet&&creditedKills>0&&(stop==='cap'||stop==='ammo'||stop==='food')&&bankedAll&&!failure&&!died&&!ended&&preserved&&foodAccounted;
    return {ok:!failure&&!died&&!ended&&(targetMet||partial)&&preserved&&foodAccounted,creditedKills,banked,bankedHerbs,limpwurt,trainSkill:training.skill,targetLevel:training.targetLevel,
        ...ammoId===undefined?{}:{ammoId,ammoUsed:ammoStart-bankCount(ammoId)-count(allKit(),ammoId)},
        ...bury?{buried,prayerXp:prayerXp()-prayerStart}:{},
        style,startLevel,finalLevel:level(),selectedXp:selectedXp()-initialSelectedXp,eatAt,eaten,initialFood:initialFood??null,finalFood:finalFood??null,foodAccounted,bankTrips,hpMin,died,
        lifeId:state()?.player?.lifeId,respawns:state()?.player?.respawnCount,ticks:s.tick()-start,preserved,targetMet,partial,stop,failure:failure||(!targetMet&&!partial?`no ${label} progress: bounded target unmet`:'-')};
}

export const CONFIGS: Record<string, {
    npc: RegExp;
    spot: { x: number; z: number };
    bankSpot: { x: number; z: number };
    drops: RegExp;
}> = {
    druid: {
        npc: /^chaos druid$/i,
        spot: { x: 3115, z: 9928 }, // Edgeville Dungeon Chaos Druids
        bankSpot: { x: 3092, z: 3496 }, // Edgeville Bank
        drops: /(herb|nature rune|law rune|vial of water)/i,
    },
    // Training only (TRAIN_SKILL): runGiants with TROOPER_SITE.
    trooper: {
        npc: /^khazard trooper$/i,
        spot: { x: 2525, z: 3242 },
        bankSpot: { x: 2619, z: 3332 },
        drops: /$^/,
    },
    giant: {
        npc: /^(?:hill )?giant$/i,
        spot: { x: 2545, z: 3144 }, // Surface Giant117 camp
        bankSpot: { x: 2655, z: 3283 }, // Ardougne south bank
        drops: /(big bones|limpwurt root|iron arrow|nature rune|herb)/i,
    },
};

if(import.meta.main){
const TARGET_KEY = (process.argv[4] ?? process.env.TARGET ?? 'druid').toLowerCase();
const CAP = Number(process.argv[3] ?? process.env.CAP ?? 15000);

if(TARGET_KEY!=='cow'&&!Object.prototype.hasOwnProperty.call(CONFIGS,TARGET_KEY))
    await finish([],false,`no combat progress: unsupported target ${TARGET_KEY}`);
if(!Number.isSafeInteger(CAP)||CAP<1)await finish([],false,'no combat progress: finite positive CAP required');
const maximum=TARGET_KEY!=='cow'&&process.env.MAX_KILLS!==undefined?Number(process.env.MAX_KILLS):undefined;
if(maximum!==undefined&&(!Number.isSafeInteger(maximum)||maximum<1))await finish([],false,'no combat progress: finite positive MAX_KILLS required');
const potionPolicy=combatPotionPolicy();if((potionPolicy||maximum!==undefined)&&CAP<=200)throw Error('finite combat job reserves200ticks for owned bank return');
const alch=combatAlchPolicy();if(alch&&TARGET_KEY==='cow')throw Error('owned alchemy hook requires generic combat loot path');
const botName = process.argv[2];
const telegrab=telegrabPolicy();if(telegrab&&TARGET_KEY==='cow')throw Error('Telegrab loot option applies to generic druid/giant or Ranged; cow ownership receipt remains unchanged');
// Generic Microbot combat options retain the Edgeville route used by their owned proofs.
const dungeonGiant=TARGET_KEY==='giant'&&(maximum!==undefined||!!potionPolicy||!!alch||!!telegrab);
const targetConf=CONFIGS[TARGET_KEY]??CONFIGS.druid!;
const baseConf=dungeonGiant?{...targetConf,spot:{x:3117,z:9850},bankSpot:{x:3092,z:3496},drops:/(big bones|limpwurt root|iron arrow|nature rune)/i}:targetConf;
const conf=alch?.route?{...baseConf,spot:alch.route.site,bankSpot:alch.route.bank}:baseConf;

if (!botName) {
    console.error('Usage: bun scripts/gather-combat.ts <botName> [CAP] [TARGET: druid | giant | trooper | cow]');
    process.exit(1);
}

// Finite giant training is opt-in; TARGET=giant alone keeps the legacy gatherer below.
const giantTrained=(TARGET_KEY==='giant'||TARGET_KEY==='trooper')&&(process.env.TRAIN_SKILL!==undefined||process.env.TARGET_LEVEL!==undefined||process.env.GIANT_KILLS!==undefined);
if(TARGET_KEY==='trooper'&&!giantTrained)await finish([],false,'no combat progress: TARGET=trooper trains only, with TRAIN_SKILL and TARGET_LEVEL');
let giantMaximum:number|undefined;
if(giantTrained){try{giantMaximum=giantKillLimit(process.env.GIANT_KILLS);}catch(e){await finish([],false,String(e));}}
const giantSkill=process.env.TRAIN_SKILL??(giantMaximum===undefined?undefined:'Hitpoints');
const giantLevel=process.env.TARGET_LEVEL===undefined?(giantMaximum===undefined?undefined:99):Number(process.env.TARGET_LEVEL);
if(giantTrained){try{giantTraining(giantSkill,giantLevel);}catch(e){await finish([],false,String(e));}}
if(giantTrained&&(potionPolicy||maximum!==undefined||alch||telegrab))
    await finish([],false,'surface giant training cannot use the generic combat loot options');
const cowStop=cowStopControl(TARGET_KEY,()=>existsSync(resolve(import.meta.dir,'../.practice',`stop-${botName}`)),giantTrained||!!potionPolicy||maximum!==undefined);
const ownedSession=await openBot(botName,cowStop.options).catch(e=>finish([],false,`login: ${String(e)}`));
if(giantTrained){
    // TROOPER_COOK=1: cook banked raw beef into trooper food first, when the account owns too little (scripts/trooper-food.ts).
    if(TARGET_KEY==='trooper'&&process.env.TROOPER_COOK==='1')try{const {stageTrooperFood}=await import('./trooper-food'),{walkTargetPersist}=await import('./walk-to');
        const r=await stageTrooperFood(ownedSession,{stop:cowStop.stop,walk:async(x,z)=>(await walkTargetPersist(ownedSession,{x,z,level:0})).ok});console.log(`TROOPER_FOOD ${JSON.stringify(r)}`);}
    catch(e){await finish([ownedSession],false,String(e));}
    try{const r=await runGiants(ownedSession,{cap:CAP,site:TARGET_KEY==='trooper'?TROOPER_SITE:undefined,trainSkill:giantSkill,targetLevel:giantLevel,maximum:giantMaximum,food:process.env.GIANT_FOOD===undefined?undefined:Number(process.env.GIANT_FOOD),ammo:process.env.GIANT_AMMO===undefined?undefined:Number(process.env.GIANT_AMMO),bury:process.env.GIANT_BURY==='1',stop:cowStop.stop});console.log(`GIANT_RESULT ${JSON.stringify(r)}`);await finish([ownedSession],r.ok&&cowStop.reason()!=='died',`mode=giant ${Object.entries(r).map(([k,v])=>`${k}=${typeof v==='object'?JSON.stringify(v):v}`).join(' ')}`);}
    catch(e){await finish([ownedSession],false,String(e));}
}
const dungeonTravel=(TARGET_KEY==='druid'||dungeonGiant)&&!alch?.route?createEdgevilleTravel(ownedSession):undefined;
const cleanupScope=(potionPolicy||maximum!==undefined)&&TARGET_KEY!=='cow'?combatPotionSession(ownedSession,cowStop.stop,CAP):undefined;
const s=cleanupScope??ownedSession;
if(TARGET_KEY==='cow'){
    if(process.env.COW_STAGE==='1')try{const {stageCows}=await import('./cow-stage'),{walkTargetPersist}=await import('./walk-to');
        const r=await stageCows(s,{stop:cowStop.stop,walk:async(x,z)=>(await walkTargetPersist(s,{x,z,level:0})).ok});console.log(`COW_STAGE ${JSON.stringify(r)}`);}
        catch(e){await finish([s],false,String(e));}
    try{const r=await runCows(s,{cap:CAP,maximum:Number(process.env.MAX_KILLS??5),trainSkill:process.env.TRAIN_SKILL,targetLevel:process.env.TARGET_LEVEL===undefined?undefined:Number(process.env.TARGET_LEVEL),bankProfile:process.env.COW_BANK_PROFILE,foodMode:process.env.COW_FOOD_MODE,potions:potionPolicy,diagnostics:process.env.COW_DIAGNOSTICS==='1',stop:cowStop.stop});console.log(`COW_RESULT ${JSON.stringify(r)}`);await finish([s],r.ok&&cowStop.reason()!=='died',`mode=cow ${Object.entries(r).map(([k,v])=>`${k}=${typeof v==='object'?JSON.stringify(v):v}`).join(' ')}`);}
    catch(e){await finish([s],false,String(e));}
}
let combatRecovery:(()=>Promise<void>)|undefined;
try {
    const pos = () => s.sdk.getState()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    let recoveringPotions=false;const over = () => used() >= (cleanupScope&&!recoveringPotions?CAP-200:CAP);
    const potions=potionPolicy?createCombatPotions(s,potionPolicy,['Attack','Strength','Defence','Hitpoints'],()=>over()||cowStop.stop()):undefined;
    const loot=createCombatLoot(s,telegrab?{...telegrab,stop:()=>over()||cowStop.stop()}:undefined,alch?{...alch,stop:()=>over()||cowStop.stop()}:undefined);

    let kills = 0, itemsLooted = 0, bankTrips = 0, walkTicks = 0;

    const counters = () => `kills=${kills} looted=${itemsLooted} bankTrips=${bankTrips} walkTicks=${walkTicks} hp=${hp()}`;

    const travelStop=()=>over()||!recoveringPotions&&cowStop.stop();
    const ground = async (x: number, z: number, tol = 2): Promise<boolean> => {
        const a = s.tick();
        for (let i = 0; i < 3 && !travelStop(); i++) {
            const p = pos();
            if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
            const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop: travelStop });
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                await waitTicks(s, 1);
            }
        }
        walkTicks += s.tick() - a;
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };

    const walk=async(x:number,z:number,tol=2)=>dungeonTravel?dungeonTravel.walk(s,TARGET_KEY as 'druid'|'giant',{x,z,level:0},ground,travelStop,tol):ground(x,z,tol);

    const bank = async () => {
        if(!await walk(conf.bankSpot.x,conf.bankSpot.z,2))throw Error('combat bank return unavailable');
        await bankCombatLoot(s,conf.drops,[...alch?[995]:[],...potions?.depositIds??[]]);

        // Ensure we have food in inventory (e.g. 5 lobsters)
        if (countItems(s, /lobster|swordfish|trout/i) < 3) {
            await s.bot.withdrawItem(/lobster/i, 5);
        }

        bankTrips++;
        await s.bot.closeInterface();
        await waitTicks(s, 1);
        if(recoveringPotions&&!await walk(conf.bankSpot.x,conf.bankSpot.z,2))throw Error('combat final bank position unavailable');
    };

    if(cleanupScope)combatRecovery=combatPotionRecovery(cleanupScope,()=>!!potions?.blocked||loot.blocked,bank,active=>{recoveringPotions=active;});

    console.log(`START combat gatherer ${botName} target=${TARGET_KEY} at=${pos()?.worldX},${pos()?.worldZ}`);

    while (!over()&&(!cleanupScope||!cowStop.stop())) {
        if(potions)await potions.poll();
        const invSpace = 28 - s.sdk.getInventory().length;
        if (invSpace <= 1) {
            await bank();
            continue;
        }

        // Check HP, eat food if below 50%
        if (hp() > 0 && hp() < 20 && countItems(s, /lobster|swordfish|trout/i) > 0) {
            await s.bot.eatFood(/lobster|swordfish|trout/i);
            await waitTicks(s, 1);
        }

        const p = pos();
        if (!p) { await waitTicks(s, 1); continue; }

        if (Math.max(Math.abs(p.worldX - conf.spot.x), Math.abs(p.worldZ - conf.spot.z)) > 15) {
            await walk(conf.spot.x, conf.spot.z, 4);
            continue;
        }

        // Check for ground loot
        if (invSpace > 0) {
            const candidate=telegrab||alch?s.sdk.getState()?.groundItems.filter(i=>conf.drops.test(i.name)).sort((a,b)=>a.distance-b.distance)[0]:undefined;
            const r = telegrab||alch?(candidate?await loot.pickup(candidate):{success:false}):await s.bot.pickupItem(conf.drops);
            if (r.success) {
                itemsLooted++;
                if(alch&&itemsLooted>=alch.maximum)break;
                await waitTicks(s, 1);
                continue;
            }
        }

        if(maximum!==undefined&&kills>=maximum)break;

        // Find target monster
        const selfSlot = (s.client as {selfSlot?:number}).selfSlot;
        const monster = genericCombatNpc(TARGET_KEY,s.sdk.getState()?.nearbyNpcs??[],selfSlot);
        if (!monster) {
            await waitTicks(s, 2);
            continue;
        }

        const a = await s.bot.attack(monster);
        if (a.success) {
            // Wait until dead or out of combat
            let dead:boolean;
            if(cleanupScope){const began=s.tick();while(!over()&&!cowStop.stop()&&s.tick()-began<100&&s.sdk.getState()?.nearbyNpcs.some(n=>n.index===monster.index)){if(potions&&s.sdk.getState()?.player?.combat.targetType==='npc'&&s.sdk.getState()?.player?.combat.targetIndex===monster.index)await potions.poll(monster);await waitTicks(s,1);}dead=!s.sdk.getState()?.nearbyNpcs.some(n=>n.index===monster.index);}else dead = await waitUntil(s, st => !(st?.nearbyNpcs ?? []).some((n: any) => n.index === monster.index), { timeoutTicks: 100 });
            if (dead) {
                kills++;
                // Wait 1 tick for loot to appear on ground
                await waitTicks(s, 1);
            }
        } else {
            await waitTicks(s, 2);
        }
    }

    if(combatRecovery)await combatRecovery();
    if(potions){console.log('COMBAT_POTIONS_RESULT '+JSON.stringify({doses:potions.doses,delta:potions.delta,receipts:potions.receipts,blocked:potions.blocked,resumes:potions.resumes}));}
    if(alch){if(!cleanupScope)await bank();if(s.sdk.getInventory().some(i=>i.id===995||conf.drops.test(i.name)))throw Error('owned alchemy bank return unconfirmed');console.log('COMBAT_ALCH_RESULT '+JSON.stringify({casts:loot.alch!.casts,coins:loot.alch!.coins,consumed:loot.alch!.consumed,runes:loot.alch!.runes,receipts:loot.alch!.receipts,blocked:loot.alch!.blocked,itemsLooted,bankTrips,scope:'exact owned pickup and native alchemy; generic loot does not assert kill attribution'}));}
    const total = kills + itemsLooted;
    const perK = (total * 1000 / Math.max(1, used())).toFixed(2);
    const targetMet=maximum===undefined||kills===maximum&&!cowStop.stop();
    await finish([ownedSession], total > 0&&targetMet, `ticks=${used()} ${counters()} actionsPer1kTicks=${perK} targetMet=${targetMet} maximum=${maximum??'-'}`);
} catch (e) {
    let detail=String(e);if(combatRecovery)try{await combatRecovery();}catch(recovery){detail+='; cleanup '+String(recovery);}
    await finish([ownedSession], false, detail);
}
}
