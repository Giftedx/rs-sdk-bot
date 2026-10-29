// Combat Monster Gatherer: fights Chaos Druids (herbs, runes) or Hill Giants (big bones, limpwurt) and banks drops.
// Usage: bun scripts/gather-combat.ts <bot> [CAP ticks, default 15000] [TARGET: druid | giant]
// Environment: DEMO_OK=1 for live server.
import { openBot, finish, countItems } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker, expandPath, type PathDeps, type PathPoint, type PathTile } from '../packages/core/src/walk';

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

// The cow loop owns stop/death cleanup on every bank profile. Without onStop,
// core finish closes the session while the bank retreat is still running.
export function cowStopControl(target:string,stopFile:()=>boolean){
    let reason:string|undefined;
    const options=target==='cow'?{onStop:async(_s:unknown,why:string)=>{if(reason===undefined){reason=why;console.log(`COW_STOP_OWNER ${why}`);}}}:{};
    return {options,stop:()=>reason!==undefined||stopFile(),reason:()=>reason};
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
export async function runCows(s:Session, o:{cap:number;maximum:number;trainSkill?:string;targetLevel?:number;bankProfile?:string;foodMode?:string;diagnostics?:boolean;noProgress?:number;stop?:()=>boolean;walk?:(x:number,z:number,tol:number)=>Promise<boolean>}) {
    const profile=cowProfile(o.bankProfile,o.foodMode,o.maximum);
    if(!Number.isSafeInteger(o.cap)||o.cap<1) throw new Error('cow needs positive CAP and MAX_KILLS1..5');
    const training=cowTraining(o.trainSkill,o.targetLevel);
    const ids=[1739,526,2132],inv=()=>s.sdk.getInventory(),state=()=>s.sdk.getState();
    const count=(items:readonly {id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const held=(id:number)=>count(inv(),id),xp=()=>s.sdk.getSkillXp('Attack')??0,hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    const selectedXp=()=>s.sdk.getSkillXp(training.skill)??0,level=()=>s.sdk.getSkill(training.skill)?.baseLevel??0;
    if(!await waitUntil(s,()=>hp()>0&&(profile.foodBanked||held(333)>=2)&&level()>0,{timeoutTicks:15})) throw new Error('cow prerequisite: stage2unnoted Trout and syncedHP/skill');
    const start=s.tick(),initialXp=xp(),initialSelectedXp=selectedXp(),startLevel=level(),p0=state()?.player;
    const goalReached=()=>training.targetLevel!==undefined&&level()>=training.targetLevel;
    if(!p0||p0.level!==0||Math.max(Math.abs(p0.worldX-profile.bank.x),Math.abs(p0.worldZ-profile.bank.z))>(profile.north?3:10)) throw new Error(profile.north?'cow prerequisite: stage at Ardougne north bank':'cow prerequisite: stage at Ardougne south bank');
    if(profile.foodBanked&&(hp()<60||(s.sdk.getSkill('Hitpoints')?.baseLevel??0)<60||(s.sdk.getSkill('Defence')?.level??0)<70))throw new Error('cow prerequisite: banked-food profile requires HPbase/current60 and Defence70');
    if(ids.some(id=>held(id)>0)) throw new Error('cow prerequisite: empty carried cow outputs');
    const allKit=()=>[...inv(),...(state()?.equipment??[])];
    for(const id of [1277,1171]) if(count(allKit(),id)<1) throw new Error(`cow prerequisite: missing kit${id}`);
    const kit=new Map<number,number>();for(const i of allKit())if(!ids.includes(i.id)&&i.id!==333)kit.set(i.id,(kit.get(i.id)??0)+i.count);
    let ended=false,died=false,healthCutoff=false,retreating=false,hpMin=hp(),creditedKills=0,damageXp=0,eaten=0,bankTrips=0,failure='',stop='cap',lastProgress=start;
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
    const eat=async()=>{
        const food=inv().find(i=>i.id===333);
        if(!food){stop='low-hp';throw new Error('no cow progress: low HP retreat, no working food');}
        const before=held(333),beforeHp=hp();await s.bot.eatFood(food);
        // SDK eat can finish on inventory debit before the HP packet arrives.
        const healed=await waitUntil(s,()=>held(333)<before&&hp()>beforeHp||over(),{timeoutTicks:6});
        eaten+=Math.max(0,before-held(333));
        if(!healed||held(333)>=before||hp()<=6||over()){stop='low-hp';throw new Error('no cow progress: food did not heal before retreat');}
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
    const ownedFood=()=>s.bankObservation?.()?held(333)+bankCount(333):undefined;
    const bank=async()=>{
        retreating=true;
        const p=state()?.player;if(p)bankDistances.push(Math.max(Math.abs(p.worldX-profile.bank.x),Math.abs(p.worldZ-profile.bank.z)));
        if(!await walk(profile.bank.x,profile.bank.z,profile.north?1:2))throw new Error('no cow progress: bank retreat failed');await open();
        for(const id of ids){const item=inv().find(i=>i.id===id);if(item){const before=bankCount(id),amount=held(id);
            if(!(await s.bot.depositItem(item,-1)).success||held(id)>0||!await waitUntil(s,()=>bankCount(id)===before+amount,{timeoutTicks:20}))throw new Error('no cow progress: deposit failed');}}
        const needed=profile.foodBanked?0:Math.max(0,2-held(333));if(needed){const item=state()?.bank.items.find(i=>i.id===333);if(!item||item.count<needed||!(await s.bot.withdrawItem(item,needed,{asNote:false})).success||held(333)<2)throw new Error('no cow progress: working food restock failed');}
    };
    try {
        await open();for(const id of ids)baseline[id]=bankCount(id);initialAssets=assetTotals();initialFood=ownedFood();await s.bot.closeBank();
        if(!goalReached()&&!over()){
        await equipCowKit(s,over);
        if(profile.foodBanked){
            await open();const food=inv().find(i=>i.id===333);if(food){const before=bankCount(333),amount=held(333);if(!(await s.bot.depositItem(food,-1)).success||!await waitUntil(s,()=>held(333)===0&&bankCount(333)===before+amount,{timeoutTicks:10}))throw new Error('no cow progress: working food secure bank failed');}
            await s.bot.closeBank();if(inv().length>0)throw new Error('cow prerequisite: banked-food fullpack requires empty inventory after worn kit prep');
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
            if(s.tick()-lastProgress>=(o.noProgress??200))throw new Error('no cow progress: target/loot timeout');
            const target=state()?.nearbyNpcs.find(n=>n.id===81&&n.x>=2655&&n.x<=2676&&n.z>=3338&&n.z<=3357&&!n.inCombat&&(n.hp==null||n.maxHp==null||n.hp>=n.maxHp));
            if(!target){await waitTicks(s,1);continue;}
            if((state()?.nearbyPlayers??[]).some(p=>Math.max(Math.abs(p.x-target.x),Math.abs(p.z-target.z))<=12)){await waitTicks(s,1);continue;}
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
            let gone=false;
            while(!over()){
                if(healthCutoff)throw new Error('no cow progress: banked-food HP40 cutoff; retreat');
                if(hp()<=6)await eat();
                const current=state()?.nearbyNpcs.find(n=>n.index===target.index);
                if(current){x=current.tileX??current.x;z=current.tileZ??current.z;}else gone=true;
                // Own selected-skill XP is productive combat progress. Animation,
                // dispatch success and other players' hits do not renew this wait.
                if(selectedXp()>observedXp){observedXp=selectedXp();lastProgress=s.tick();}
                capture('await-credit',x,z,gone);
                const drops=ids.map(id=>count((state()?.groundItems??[]).filter(i=>i.x===x&&i.z===z),id)-(groundBefore.get(`${id}:${x}:${z}`)??0));
                if(cowCredit(gone,selectedXp()-beforeXp,drops))break;
                if(s.tick()-lastProgress>=(o.noProgress??200))throw new Error('no cow progress: target/loot timeout');await waitTicks(s,1);
            }
            if(over())break;
            for(const id of ids){const item=state()?.groundItems.find(i=>i.id===id&&i.x===x&&i.z===z);const before=held(id);
                if(!item||!(await s.bot.pickupItem(item)).success||held(id)!==before+1)throw new Error('no cow progress: credited loot pickup mismatch');}
            creditedKills++;damageXp+=selectedXp()-beforeXp;lastProgress=s.tick();console.log(`MILESTONE cow credited=${creditedKills} trainSkill=${training.skill} selectedXp=${selectedXp()-initialSelectedXp} level=${level()} attackXp=${xp()-initialXp} HP=${hp()} heldHide=${held(1739)}`);
        }
        stop=goalReached()?'target-level':creditedKills===o.maximum?'max-kills':died?'died':o.stop?.()?'stop-file':'cap';
    } catch(e){failure=String(e);if(stop==='cap'&&o.stop?.())stop='stop-file';capture('failure');console.log(`COW_DIAGNOSTIC ${JSON.stringify(diagnostics)}`);}
    finally {if(!died&&!ended)try{await bank();}catch(e){failure=[failure,String(e)].filter(Boolean).join('; ');}off();offMetrics();}
    const banked={hide:bankCount(1739)-(baseline[1739]??bankCount(1739)),bones:bankCount(526)-(baseline[526]??bankCount(526)),beef:bankCount(2132)-(baseline[2132]??bankCount(2132))};
    const finalAssets=profile.foodBanked?assetTotals():undefined;
    const preserved=profile.foodBanked?!!initialAssets&&!!finalAssets&&[...new Set([...initialAssets.keys(),...finalAssets.keys()])].every(id=>ids.includes(id)||(finalAssets.get(id)??0)===(initialAssets!.get(id)??0)):[...kit].every(([id,n])=>count(allKit(),id)===n)&&held(333)>=2;
    // Owned Trout in pack and bank change only by observed eating.
    const finalFood=ownedFood(),foodAccounted=initialFood!==undefined&&finalFood===initialFood-eaten;
    const targetMet=(training.targetLevel!==undefined?goalReached():creditedKills===o.maximum)&&Object.values(banked).every(n=>n===creditedKills);
    const partial=training.targetLevel!==undefined&&!targetMet&&creditedKills>0&&['max-kills','cap'].includes(stop)
        &&Object.values(banked).every(n=>n===creditedKills)&&!failure&&!died&&!ended&&preserved&&foodAccounted;
    if(o.diagnostics&&!failure)console.log(`COW_DIAGNOSTIC ${JSON.stringify(diagnostics)}`);
    return {ok:!failure&&!died&&!ended&&(targetMet||partial)&&preserved&&foodAccounted,creditedKills,banked,trainSkill:training.skill,targetLevel:training.targetLevel??null,startLevel,finalLevel:level(),selectedXp:selectedXp()-initialSelectedXp,attackXp:xp()-initialXp,damageXp,eaten,initialFood:initialFood??null,finalFood:finalFood??null,foodAccounted,bankTrips,hpMin,died,lifeId:state()?.player?.lifeId,respawns:state()?.player?.respawnCount,ticks:s.tick()-start,preserved,targetMet,partial,stop,failure:failure||(!targetMet&&!partial?'no cow progress: bounded target unmet':'-'),diagnostics:failure||o.diagnostics?diagnostics:[],bankProfile:profile.north?'north':'south',foodMode:profile.foodBanked?'banked':'held',healthCutoff,walkTicks,walkedTiles,detourTiles,doorInteractions,houseInteractions,maxPackSlots,bankDistances,walkLegs};
}

if(import.meta.main){
const TARGET_KEY = (process.argv[4] ?? process.env.TARGET ?? 'druid').toLowerCase();
const CAP = Number(process.argv[3] ?? process.env.CAP ?? 15000);

const CONFIGS: Record<string, {
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
    giant: {
        npc: /^hill giant$/i,
        spot: { x: 3117, z: 9850 }, // Edgeville Dungeon Hill Giants
        bankSpot: { x: 3092, z: 3496 }, // Edgeville Bank
        drops: /(big bones|limpwurt root|iron arrow|nature rune)/i,
    },
};

if(TARGET_KEY!=='cow'&&!Object.prototype.hasOwnProperty.call(CONFIGS,TARGET_KEY))
    await finish([],false,`no combat progress: unsupported target ${TARGET_KEY}`);
const conf = CONFIGS[TARGET_KEY] ?? CONFIGS.druid!;
const botName = process.argv[2];

if (!botName) {
    console.error('Usage: bun scripts/gather-combat.ts <botName> [CAP] [TARGET: druid | giant]');
    process.exit(1);
}

const cowStop=cowStopControl(TARGET_KEY,()=>existsSync(resolve(import.meta.dir,'../.practice',`stop-${botName}`)));
const s = await openBot(botName,cowStop.options).catch(e => finish([], false, `login: ${String(e)}`));
if(TARGET_KEY==='cow'){
    try{const r=await runCows(s,{cap:CAP,maximum:Number(process.env.MAX_KILLS??5),trainSkill:process.env.TRAIN_SKILL,targetLevel:process.env.TARGET_LEVEL===undefined?undefined:Number(process.env.TARGET_LEVEL),bankProfile:process.env.COW_BANK_PROFILE,foodMode:process.env.COW_FOOD_MODE,diagnostics:process.env.COW_DIAGNOSTICS==='1',stop:cowStop.stop});console.log(`COW_RESULT ${JSON.stringify(r)}`);await finish([s],r.ok&&cowStop.reason()!=='died',`mode=cow ${Object.entries(r).map(([k,v])=>`${k}=${typeof v==='object'?JSON.stringify(v):v}`).join(' ')}`);}
    catch(e){await finish([s],false,String(e));}
}
try {
    const pos = () => s.sdk.getState()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => used() >= CAP;

    let kills = 0, itemsLooted = 0, bankTrips = 0, walkTicks = 0;

    const counters = () => `kills=${kills} looted=${itemsLooted} bankTrips=${bankTrips} walkTicks=${walkTicks} hp=${hp()}`;

    const walk = async (x: number, z: number, tol = 2): Promise<boolean> => {
        const a = s.tick();
        for (let i = 0; i < 3 && !over(); i++) {
            const p = pos();
            if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
            const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop: over });
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                await waitTicks(s, 1);
            }
        }
        walkTicks += s.tick() - a;
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };

    const bank = async () => {
        await walk(conf.bankSpot.x, conf.bankSpot.z, 2);
        const b = await s.bot.openBank();
        if (!b.success) {
            await waitTicks(s, 2);
            return;
        }

        // Deposit all looted items
        await s.bot.depositItem(conf.drops, -1);
        await waitTicks(s, 1);

        // Ensure we have food in inventory (e.g. 5 lobsters)
        if (countItems(s, /lobster|swordfish|trout/i) < 3) {
            await s.bot.withdrawItem(/lobster/i, 5);
        }

        bankTrips++;
        await s.bot.closeInterface();
        await waitTicks(s, 1);
    };

    console.log(`START combat gatherer ${botName} target=${TARGET_KEY} at=${pos()?.worldX},${pos()?.worldZ}`);

    while (!over()) {
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
            const r = await s.bot.pickupItem(conf.drops);
            if (r.success) {
                itemsLooted++;
                await waitTicks(s, 1);
                continue;
            }
        }

        // Find target monster
        const monster = s.sdk.findNearbyNpc(conf.npc);
        if (!monster) {
            await waitTicks(s, 2);
            continue;
        }

        const a = await s.bot.attack(monster);
        if (a.success) {
            // Wait until dead or out of combat
            const dead = await waitUntil(s, st => !(st?.nearbyNpcs ?? []).some((n: any) => n.index === monster.index), { timeoutTicks: 100 });
            if (dead) {
                kills++;
                // Wait 1 tick for loot to appear on ground
                await waitTicks(s, 1);
            }
        } else {
            await waitTicks(s, 2);
        }
    }

    const total = kills + itemsLooted;
    const perK = (total * 1000 / Math.max(1, used())).toFixed(2);
    await finish([s], total > 0, `ticks=${used()} ${counters()} actionsPer1kTicks=${perK}`);
} catch (e) {
    await finish([s], false, String(e));
}
}
