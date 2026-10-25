// Bounded Ardy imp708 bead pilot. No quest hand-in, remote route, or all-four-bead promise.
// MAX_KILLS1..3 (default1), CAP<=1500, NO_PROGRESS<=120. Route admission is fixed below.
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {walkPath,sessionWalker,expandPath,type PathDeps,type PathPoint,type PathTile} from '../packages/core/src/walk';
import {equipCowKit} from './gather-combat';

const IMP=708,ASH=592,FOOD=333;
export const IMP_LOOT=[ASH,1470,1472,1474,1476] as const;
const BANK={x:2655,z:3283},ENTRY={x:2644,z:3250},TURN={x:2649,z:3267},HUNT={x:2633,z:3243};
type ImpTile=PathTile&{level?:number};
// Offline practice admission: imp-safe-vias.json, VIA2649,3267 four EXACT full legs.
// This flag is not live admission; native exact-Sword/hero-loot proof remains required.
export const IMP_ROUTE_READY=true;
// Rev289 spawn bbox + wander/hunt/footprint margins, verified by the route owner.
const THREATS=[
    [2632,3274,2633,3280,7],[2602,3267,2607,3270,16],[2601,3269,2601,3269,6],
    [2604,3268,2606,3272,6],[2622,3272,2622,3272,7],[2622,3277,2622,3277,7],
    [2616,3283,2620,3283,10],[2610,3275,2616,3276,7],[2610,3193,2610,3193,5],
    [2607,3183,2614,3193,5],[2671,3240,2671,3240,13],
] as const;
const hazard=(p:PathTile)=>THREATS.some(([x1,z1,x2,z2,r])=>Math.max(Math.max(x1-p.x,0,p.x-x2),Math.max(z1-p.z,0,p.z-z2))<=r);
export const impInsideFence=(p:ImpTile)=> (p.level??0)===0&&p.x>=2627&&p.x<=2645&&p.z>=3222&&p.z<=3253;
const interior=(p:PathTile,margin:number)=>impInsideFence(p)&&Math.min(p.x-2627,2645-p.x,p.z-3222,3253-p.z)>=margin;
const allowed=(p:ImpTile)=>!hazard(p)&&(impInsideFence(p)||((p.level??0)===0&&p.x>=2637&&p.x<=2658&&p.z>=3248&&p.z<=3287));
export function impGroundCounts(items:readonly {id:number;x:number;z:number;count:number}[]){
    const counts=new Map<string,number>();for(const i of items){const k=`${i.id}:${i.x}:${i.z}`;counts.set(k,(counts.get(k)??0)+i.count);}return counts;
}
// Private ashes are emitted only after npc_death + npc_findhero in imp.rs2.
// A teleport can change visibility/index position; it cannot emit these new ashes.
export const impCredit=(observedDeath:boolean,ownXp:number,newAshes:number)=>observedDeath&&ownXp>0&&Number.isSafeInteger(newAshes)&&newAshes>=1&&newAshes<=2;
export function guardImpWalker(base:PathDeps,threat:()=>string|null,hunt=false){
    let why:string|null=null;
    const check=()=>why??=threat();
    const valid=(level:number,from:PathTile,to:PathTile,path:PathTile[])=>{
        const inside=hunt?impInsideFence:allowed;
        if(level!==0||!inside(from)||!inside(to)){why='imp route outside fixed bounds';return false;}
        if(from.x===to.x&&from.z===to.z&&path.length===0)return true;
        const end=path.at(-1);
        if(!end||end.x!==to.x||end.z!==to.z||expandPath(from,path).some(p=>!inside(p))){why='imp route incomplete or outside fixed bounds';return false;}
        return true;
    };
    const refused=()=>({success:false,phase:'dispatch',reason:'imp_route_guard',message:why??'imp route unknown'});
    const deps:PathDeps={...base,plan:(level,from,to)=>{const path=base.plan(level,from,to);return valid(level,from,to,path)?path:[];},
        walk:(x,z)=>{if(check())return refused();const p=base.pos();if(!p||!valid(p.level,p,{x,z},base.plan(p.level,p,{x,z})))return refused();return base.walk(x,z);},
        interactLoc:(loc,op)=>check()?refused():base.interactLoc(loc,op),...(base.runOn?{runOn:()=>check()?refused():base.runOn!()}:{}),};
    return {deps,reason:check};
}
export function chooseImpCancelStep(planner:Pick<PathDeps,'plan'>,from:PathTile):PathTile|null{
    if(!interior(from,2)||hazard(from))return null;
    const candidates:PathTile[]=[];
    for(const dx of [-1,0,1])for(const dz of [-1,0,1])if(dx||dz)candidates.push({x:from.x+dx,z:from.z+dz});
    // Select from collision plans, never by sending trial clicks. Prefer farther
    // from the fence edge; every accepted route must be exactly one legal step.
    const margin=(p:PathTile)=>Math.min(p.x-2627,2645-p.x,p.z-3222,3253-p.z);
    candidates.sort((a,b)=>margin(b)-margin(a)||a.x-b.x||a.z-b.z);
    for(const to of candidates){
        if(!interior(to,2)||hazard(to))continue;
        const path=planner.plan(0,from,to),end=path.at(-1),tiles=expandPath(from,path);
        if(end?.x===to.x&&end.z===to.z&&tiles.length===1&&tiles[0].x===to.x&&tiles[0].z===to.z)return to;
    }
    return null;
}
export async function cancelImpTarget(s:Session,planner:Pick<PathDeps,'plan'>,stop:()=>boolean=()=>false){
    const from=s.sdk.getState()?.player;
    if(stop()||!from||from.level!==0||(s.sdk.getSkill('Hitpoints')?.level??0)<=6||s.sdk.getState()?.autoRetaliateEnabled!==false)throw new Error('no imp progress: unsafe cancellation state');
    const step=chooseImpCancelStep(planner,{x:from.worldX,z:from.worldZ});
    if(!step)throw new Error('no imp progress: no verified adjacent cancel step');
    if(stop())throw new Error('no imp progress: cancellation stopped before dispatch');
    const tick=s.tick(),reply=await s.direct({type:'walkTo',x:step.x,z:step.z,running:false,reason:'imp cancel step'}) as {success?:boolean;message?:string};
    if(reply?.success!==true)throw new Error(`no imp progress: adjacent cancel dispatch failed ${reply?.message??'unknown'}`);
    // A current-tile walk can return success WITHOUT emitting MOVE_GAMECLICK.
    // Require displacement to the exact guarded adjacent tile and fresh server
    // target clearing. inCombat may remain true due to recent-hit combatCycle.
    const arrived=await waitUntil(s,()=>{
        const p=s.sdk.getState()?.player;
        return s.tick()>tick&&!!p&&p.level===0&&p.worldX===step.x&&p.worldZ===step.z&&p.combat?.targetType==='none'&&p.combat.targetIndex===-1&&s.sdk.getState()?.autoRetaliateEnabled===false||stop();
    },{timeoutTicks:6});
    const now=s.sdk.getState()?.player;
    if(!arrived||stop()||!now||now.worldX!==step.x||now.worldZ!==step.z||now.combat?.targetType!=='none'||now.combat.targetIndex!==-1||(s.sdk.getSkill('Hitpoints')?.level??0)<=6)throw new Error('no imp progress: adjacent cancellation unobserved');
    return {from:[from.worldX,from.worldZ],to:[step.x,step.z],dispatchTick:tick,observedTick:s.tick(),dispatchAccepted:true,movementObserved:true,targetNoneObserved:true,recentHitInCombat:now.combat.inCombat};
}
export interface ImpOptions {cap:number;maximum:number;noProgress?:number;deferredNpcIndices?:readonly number[];stop?:()=>boolean;walk?:(points:PathPoint[],cleanup:boolean)=>Promise<boolean>;cancelPlanner?:Pick<PathDeps,'plan'>}
export async function runImps(s:Session,o:ImpOptions){
    const noProgress=o.noProgress??120;
    if(!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>1500||!Number.isSafeInteger(o.maximum)||o.maximum<1||o.maximum>3||!Number.isSafeInteger(noProgress)||noProgress<1||noProgress>120)throw new Error('no imp progress: invalid bounded limits');
    const initialDeferredNpcIndices=[...(o.deferredNpcIndices??[])];
    if(initialDeferredNpcIndices.length>8||initialDeferredNpcIndices.some(n=>!Number.isSafeInteger(n)||n<0||n>65535))throw new Error('no imp progress: invalid initial deferred NPC indices');
    if(!IMP_ROUTE_READY&&!o.walk)throw new Error('no imp progress: offline route not admitted');
    const state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory();
    const count=(items:readonly {id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const held=(id:number)=>count(inv(),id),xp=()=>s.sdk.getSkillXp('Attack')??0,hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    if(!await waitUntil(s,()=>hp()>0&&(s.sdk.getSkill('Attack')?.baseLevel??0)>0,{timeoutTicks:15}))throw new Error('no imp progress: skills unknown');
    const initialPlayer=state()?.player,start=s.tick(),initialXp=xp(),foodHeldInitial=held(FOOD);
    if(!initialPlayer||initialPlayer.level!==0||Math.max(Math.abs(initialPlayer.worldX-BANK.x),Math.abs(initialPlayer.worldZ-BANK.z))>3||held(FOOD)<2)throw new Error('no imp progress: stage Ardy bank with2working Trout');
    for(const id of [1277,1171])if(count([...inv(),...s.sdk.getEquipment()],id)<1)throw new Error(`no imp progress: missing kit ${id}`);
    let ended=false,died=false,hpMin=hp(),eaten=0,creditedKills=0,attacks=0,reengagements=0,failure='',stop='cap',activeIndex:number|undefined,activeX=0,activeZ=0;
    const loot:Record<number,number>={},banked:Record<number,number>={},diagnostics:Record<string,unknown>[]=[],credits:Record<string,unknown>[]=[],abandoned:Record<string,unknown>[]=[];
    const deferred=new Set<number>(initialDeferredNpcIndices);let activeBeforeXp:number|undefined;
    let corpse:{x:number;z:number;hp0:boolean;deathAnim:boolean}|undefined,activeBaseline:Map<string,number>|undefined,combatHalt='',combatHaltKind:'actor'|'target'='actor';
    const liveAnchors=new Set<string>(),cancellations:Awaited<ReturnType<typeof cancelImpTarget>>[]=[];
    let movement:PathDeps|undefined,cancelPending:Promise<Awaited<ReturnType<typeof cancelImpTarget>>>|undefined;
    let snapshot:{id:number;count:number}[]|undefined,initial:Map<number,number>|undefined;
    const bankCount=(id:number)=>count(snapshot??[],id);
    const totals=()=>{const m=new Map<number,number>();for(const i of [...(snapshot??[]),...inv(),...s.sdk.getEquipment()])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
    const capture=(phase:string)=>{const n=state()?.nearbyNpcs.find(n=>n.index===activeIndex);if(diagnostics.length>=24)diagnostics.splice(2,1);diagnostics.push({tick:s.tick()-start,phase,index:activeIndex,anchor:[activeX,activeZ],corpse,xp:xp()-initialXp,hp:hp(),npc:n?{id:n.id,x:n.tileX??n.x,z:n.tileZ??n.z,hp:n.hp,anim:n.animId,inCombat:n.inCombat}:null,ground:(state()?.groundItems??[]).filter(i=>IMP_LOOT.includes(i.id as any)).map(i=>({id:i.id,x:i.x,z:i.z,count:i.count})),players:(state()?.nearbyPlayers??[]).map(p=>({index:p.index,x:p.x,z:p.z}))});};
    const observe=()=>{const p=state()?.player;hpMin=Math.min(hpMin,hp());if(hp()<=0||p?.isDead||p?.lifeId!==initialPlayer.lifeId||(p?.respawnCount??0)>(initialPlayer.respawnCount??0))died=true;
        const n=state()?.nearbyNpcs.find(n=>n.index===activeIndex&&n.id===IMP);
        const targetJump=!!n&&Math.max(Math.abs((n.tileX??n.x)-activeX),Math.abs((n.tileZ??n.z)-activeZ))>2;
        if(activeBaseline&&!corpse&&p&&!combatHalt&&((n&&!interior({x:n.tileX??n.x,z:n.tileZ??n.z},3))||targetJump||!interior({x:p.worldX,z:p.worldZ},2))){
            combatHaltKind=interior({x:p.worldX,z:p.worldZ},2)?'target':'actor';
            combatHalt=targetJump&&combatHaltKind==='target'?'target jumped beyond observed approach; no chase':`${combatHaltKind==='target'?'target':'player'} reached interior margin; no chase`;
            if(!ended&&!died)void cancel().catch(()=>{});
            capture('combat-halt');
        }
        if(n&&activeBaseline&&!corpse){const x=n.tileX??n.x,z=n.tileZ??n.z;
            if(n.hp===0||n.animId===172){corpse={x,z,hp0:n.hp===0,deathAnim:n.animId===172};capture('death-observed');}
            else{liveAnchors.add(`${x}:${z}`);const ground=impGroundCounts(state()?.groundItems??[]);for(const id of IMP_LOOT){const key=`${id}:${x}:${z}`;activeBaseline.set(key,ground.get(key)??0);}}
        }
    };
    void s.ended.then(()=>{ended=true;});const off=s.onTick(observe);
    const over=()=>{observe();return ended||died||!!o.stop?.()||s.tick()-start>=o.cap;};
    const cancel=()=>cancelPending??=(async()=>{
        const proof=await cancelImpTarget(s,o.cancelPlanner??movement??await sessionWalker(s),()=>ended||died||!!o.stop?.()||!!threat());
        cancellations.push(proof);return proof;
    })();
    const threat=()=>{const p=state()?.player;
        if(ended||died)return 'imp session ended/dead';if(!p||!allowed({x:p.worldX,z:p.worldZ,level:p.level}))return 'imp player outside route bounds';
        // Actual SW bounds: hunt + footprint + margin. Combat level alone is
        // not aggression; the nearby unicorn/city NPCs must not cause false stops.
        const radii:Record<number,number>={105:4,107:4,109:2,113:4,116:4,95:4,128:2};
        if((state()?.nearbyNpcs??[]).some(n=>radii[n.id]!==undefined&&Math.max(Math.abs((n.tileX??n.x)-p.worldX),Math.abs((n.tileZ??n.z)-p.worldZ))<=radii[n.id]!))return 'imp nearby known threat';return null;};
    const recordAbandoned=(reason:string,cancellationObserved:boolean)=>{
        if(activeBeforeXp===undefined)return;
        abandoned.push({npcIndex:activeIndex,anchor:[activeX,activeZ],partialDamageXp:Math.max(0,xp()-activeBeforeXp),reason,cancellationObserved});
        if(activeIndex!==undefined)deferred.add(activeIndex);
        activeBeforeXp=undefined;activeBaseline=undefined;capture('abandoned');
    };
    const cancelObserved=async()=>{
        const p=state()?.player;
        if(threat()||!p||!interior({x:p.worldX,z:p.worldZ},2)||hp()<=6)throw new Error('no imp progress: player/threat unsafe during target abandonment');
        await cancel();
        if(threat()||over())throw new Error('no imp progress: target cancellation unobserved or player unsafe');
    };
    const abandonTarget=async(reason:string)=>{
        await cancelObserved();
        recordAbandoned(reason,true);combatHalt='';corpse=undefined;liveAnchors.clear();
        if(abandoned.length>=3){stop='abandon-limit';throw new Error('no imp progress: three target abandons');}
    };
    const eat=async()=>{if(hp()>8)return;const food=inv().find(i=>i.id===FOOD),before=held(FOOD),beforeHp=hp();
        if(!food||before<=2)throw new Error('no imp progress: working food reserve reached');
        await s.bot.eatFood(food);await waitUntil(s,()=>held(FOOD)<before&&hp()>beforeHp||ended||died,{timeoutTicks:6});
        eaten+=Math.max(0,before-held(FOOD));if(held(FOOD)!==before-1||hp()<=beforeHp||hp()<=6)throw new Error('no imp progress: food debit/heal not observed');};
    const walk=async(points:PathPoint[],cleanup=false)=>{
        // Cache only concurrent cancellation callers at one stationary epoch.
        // A failed cancel must not prevent guarded bank recovery, and no proof
        // may be reused after any later movement (including re-approach).
        const settleCancellation=async()=>{const prior=cancelPending;cancelPending=undefined;if(prior)await prior.catch(()=>{});};
        await settleCancellation();
        try{
        if(o.walk){if(!await o.walk(points,cleanup))throw new Error('no imp progress: test route failed');return;}
        const p=state()?.player,hunt=!!p&&impInsideFence({x:p.worldX,z:p.worldZ,level:p.level})&&points.every(impInsideFence);
        movement??=await sessionWalker(s);
        const g=guardImpWalker(movement,()=>threat()??(hp()<=6?'imp low HP':null),hunt);
        const r=await walkPath(g.deps,points,{look:4,maxTicks:220,stop:()=>!!g.reason()||(!cleanup&&over())});
        if(!r.ok||g.reason()){await cancel();throw new Error(`no imp progress: route ${g.reason()??r.detail}`);}
        }finally{await settleCancellation();}
    };
    const open=async()=>{const before=s.bankObservation?.()?.generation??0;
        if(!state()?.bank?.isOpen){if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>before,{timeoutTicks:15}))throw new Error('no imp progress: bank readiness unknown');}
        const b=s.bankObservation?.();if(!b)throw new Error('no imp progress: bank data unknown');snapshot=b.items.map(i=>({id:i.id,count:i.count}));};
    const deposit=async()=>{for(const id of IMP_LOOT){const item=inv().find(i=>i.id===id);if(!item)continue;const before=bankCount(id),amount=held(id);
        if(!(await s.bot.depositItem(item,-1)).success||!await waitUntil(s,()=>held(id)===0&&count(s.bankObservation?.()?.items??[],id)===before+amount,{timeoutTicks:15}))throw new Error('no imp progress: loot bank delta mismatch');await open();}};
    const returnBank=async()=>{activeBaseline=undefined;const p=state()?.player;
        if(p&&Math.max(Math.abs(p.worldX-BANK.x),Math.abs(p.worldZ-BANK.z))>3){await eat();await walk([{...ENTRY,tol:0},{...TURN,tol:0},{...BANK,tol:2}],true);}await open();await deposit();};
    try{
        await open();initial=totals();await deposit();
        if(!(await s.bot.closeBank()).success)throw new Error('no imp progress: bank close failed');
        await equipCowKit(s,over);
        if(state()?.autoRetaliateEnabled===true)await s.direct({type:'clickComponent',componentId:151,reason:'imp auto-retaliate off'});
        if(!await waitUntil(s,()=>state()?.autoRetaliateEnabled===false,{timeoutTicks:10}))throw new Error('no imp progress: auto-retaliate OFF unobserved');
        if(!(await s.sdk.sendSetCombatStyle(0)).success||!await waitUntil(s,()=>{const c=state()?.combatStyle;return !!c?.known&&c.weaponName==='Bronze sword'&&c.currentStyle===0&&c.styles.some(v=>v.index===0&&v.trainsSkills.length===1&&v.trainsSkills[0]==='Attack');},{timeoutTicks:10}))throw new Error('no imp progress: Attack style unobserved');
        await eat();await walk([{...TURN,tol:0},{...ENTRY,tol:0},{...HUNT,tol:0}]);
        let progress=s.tick(),dispatchFailures=0;
        while(creditedKills<o.maximum&&!over()){
            if(abandoned.length>=3){stop='abandon-limit';throw new Error('no imp progress: three target abandons');}
            await eat();const danger=threat();if(danger)throw new Error(`no imp progress: ${danger}`);
            // Imp respawnrate is100 in rev289; the configured <=120 window
            // permits that observed content cycle without an unbounded wait.
            if(s.tick()-progress>=noProgress)throw new Error('no imp progress: no eligible target');
            const target=state()?.nearbyNpcs.find(n=>n.id===IMP&&!deferred.has(n.index)&&interior({x:n.tileX??n.x,z:n.tileZ??n.z},3)&&n.reachable!==false&&!n.inCombat&&(n.hp===null||n.maxHp===null||n.hp>=n.maxHp));
            if(!target){await waitTicks(s,1);continue;}
            activeIndex=target.index;activeX=target.tileX??target.x;activeZ=target.tileZ??target.z;
            if((state()?.nearbyPlayers??[]).some(p=>Math.max(Math.abs(p.x-activeX),Math.abs(p.z-activeZ))<=12))throw new Error('no imp progress: another player near target');
            await walk([{x:activeX,z:activeZ,tol:1}]);
            const current=state()?.nearbyNpcs.find(n=>n.index===target.index&&n.id===IMP),p=state()?.player;
            if(!current||!p||!interior({x:current.tileX??current.x,z:current.tileZ??current.z},3)||!interior({x:p.worldX,z:p.worldZ},2)||Math.max(Math.abs((current.tileX??current.x)-p.worldX),Math.abs((current.tileZ??current.z)-p.worldZ))>1){await waitTicks(s,1);continue;}
            const option=current.optionsWithIndex.find(op=>/^attack$/i.test(op.text));if(!option)throw new Error('no imp progress: attack option unknown');
            const baseline=impGroundCounts(state()?.groundItems??[]),beforeXp=xp();activeBeforeXp=beforeXp;activeBaseline=baseline;corpse=undefined;combatHalt='';cancelPending=undefined;liveAnchors.clear();activeX=current.tileX??current.x;activeZ=current.tileZ??current.z;liveAnchors.add(`${activeX}:${activeZ}`);capture('attack');
            const result=await s.sdk.sendInteractNpc(current.index,option.opIndex);attacks++;
            if(!result.success){recordAbandoned('attack dispatch refused',false);if(++dispatchFailures>=3)throw new Error(`no imp progress: three attack dispatch refusals ${result.message}`);await waitTicks(s,1);continue;}
            dispatchFailures=0;let observedXp=beforeXp,lastDamage=s.tick(),credited=false,lost=false,retarget=false,lostAt:number|undefined,disengagedAt:number|undefined,reattempts=0;
            while(!over()){
                if(combatHalt){
                    if(combatHaltKind==='actor')throw new Error(`no imp progress: ${combatHalt}`);
                    await abandonTarget(combatHalt);retarget=true;progress=s.tick();break;
                }
                await eat();const danger=threat();if(danger)throw new Error(`no imp progress: ${danger}`);
                const n=state()?.nearbyNpcs.find(n=>n.index===activeIndex&&n.id===IMP);
                // The tick observer can publish this while an awaited action runs.
                const death=corpse as {x:number;z:number;hp0:boolean;deathAnim:boolean}|undefined;
                if(death){activeX=death.x;activeZ=death.z;}
                else if(n){
                    lost=false;lostAt=undefined;
                    const nx=n.tileX??n.x,nz=n.tileZ??n.z;
                    if(nx!==activeX||nz!==activeZ){activeX=nx;activeZ=nz;capture('target-moved');}
                    // A newly visible old/public pile at a new live target tile must
                    // not become death evidence. Refresh that tile's baseline while alive.
                    if(n.hp!==0&&n.animId!==172){const current=impGroundCounts(state()?.groundItems??[]);for(const id of IMP_LOOT){const key=`${id}:${activeX}:${activeZ}`;baseline.set(key,current.get(key)??0);}}
                }else if(!lost){lost=true;lostAt=s.tick();capture('lost-target-await-ashes');}
                if(!impInsideFence({x:activeX,z:activeZ}))throw new Error('no imp progress: target left fence; no chase');
                if((state()?.nearbyPlayers??[]).some(p=>Math.max(Math.abs(p.x-activeX),Math.abs(p.z-activeZ))<=12))throw new Error('no imp progress: player entered target area');
                if(xp()>observedXp){observedXp=xp();lastDamage=s.tick();capture('damage');}
                const counts=impGroundCounts(state()?.groundItems??[]),newAsh=(counts.get(`${ASH}:${activeX}:${activeZ}`)??0)-(baseline.get(`${ASH}:${activeX}:${activeZ}`)??0);
                if(impCredit(!!corpse&&liveAnchors.has(`${activeX}:${activeZ}`),xp()-beforeXp,newAsh)){
                    const beads=IMP_LOOT.filter(id=>id!==ASH).map(id=>(counts.get(`${id}:${activeX}:${activeZ}`)??0)-(baseline.get(`${id}:${activeX}:${activeZ}`)??0));
                    if(beads.some(n=>n<0||n>1)||beads.reduce((a,b)=>a+b,0)>1)throw new Error('no imp progress: corpse bead attribution unknown');
                    capture('hero-ashes');await cancel();
                    await walk([{x:activeX,z:activeZ,tol:0}]);
                    for(const id of IMP_LOOT){
                        const amount=(counts.get(`${id}:${activeX}:${activeZ}`)??0)-(baseline.get(`${id}:${activeX}:${activeZ}`)??0);if(amount<=0)continue;
                        let picked=0;
                        while(picked<amount){const pile=state()?.groundItems.find(i=>i.id===id&&i.x===activeX&&i.z===activeZ),before=held(id);
                            if(!pile||inv().length>=28)throw new Error('no imp progress: credited loot missing or inventory full');
                            await s.sdk.sendPickup(activeX,activeZ,id);
                            if(!await waitUntil(s,()=>held(id)>before||ended||died,{timeoutTicks:6}))throw new Error('no imp progress: loot pickup unobserved');
                            const gain=held(id)-before;if(gain<1||gain>amount-picked)throw new Error('no imp progress: loot pickup amount mismatch');
                            picked+=gain;loot[id]=(loot[id]??0)+gain;
                        }
                    }
                    credits.push({npcIndex:activeIndex,anchor:[activeX,activeZ],ownAttackXp:xp()-beforeXp,observedHp0:corpse!.hp0,deathAnim:corpse!.deathAnim,freshAshCount:newAsh,guaranteedAshes:1,extraAshes:newAsh-1,beadCounts:Object.fromEntries(IMP_LOOT.filter(id=>id!==ASH).map(id=>[id,(counts.get(`${id}:${activeX}:${activeZ}`)??0)-(baseline.get(`${id}:${activeX}:${activeZ}`)??0)]))});
                    creditedKills++;activeBeforeXp=undefined;activeBaseline=undefined;progress=s.tick();credited=true;break;
                }
                if(!n&&!death&&lostAt!==undefined&&s.tick()-lostAt>=6){await abandonTarget('target lost without witnessed death');retarget=true;progress=s.tick();break;}
                const combat=state()?.player?.combat;
                const disengaged=!!n&&!death&&xp()>beforeXp&&combat?.targetType==='none'&&combat.targetIndex===-1&&!n.inCombat;
                if(disengaged){
                    disengagedAt??=s.tick();
                    if(s.tick()-disengagedAt>=6){
                        if(reattempts>=4){await abandonTarget('four guarded re-engagements exhausted');retarget=true;progress=s.tick();break;}
                        await cancelObserved();
                        const eligible=()=>{
                            const target=state()?.nearbyNpcs.find(v=>v.id===IMP&&v.index===activeIndex);
                            if(!target||target.hp===0||target.animId===172||target.inCombat||target.reachable===false||!interior({x:target.tileX??target.x,z:target.tileZ??target.z},3))return null;
                            if((state()?.nearbyPlayers??[]).some(p=>Math.max(Math.abs(p.x-(target.tileX??target.x)),Math.abs(p.z-(target.tileZ??target.z)))<=12))return null;
                            return target;
                        };
                        let target=eligible();
                        if(!target){await abandonTarget('visible target no longer eligible');retarget=true;progress=s.tick();break;}
                        await walk([{x:target.tileX??target.x,z:target.tileZ??target.z,tol:1}]);
                        target=eligible();const actor=state()?.player;
                        if(!target||!actor||!interior({x:actor.worldX,z:actor.worldZ},2)||Math.max(Math.abs((target.tileX??target.x)-actor.worldX),Math.abs((target.tileZ??target.z)-actor.worldZ))>1){await abandonTarget('guarded re-engagement unavailable');retarget=true;progress=s.tick();break;}
                        const option=target.optionsWithIndex.find(op=>/^attack$/i.test(op.text));
                        if(!option)throw new Error('no imp progress: re-engagement attack option unknown');
                        capture('re-engage');cancelPending=undefined;
                        const sent=await s.sdk.sendInteractNpc(target.index,option.opIndex);attacks++;reattempts++;reengagements++;
                        if(!sent.success){await abandonTarget(`re-engagement refused ${sent.message}`);retarget=true;progress=s.tick();break;}
                        // Preserve beforeXp/baseline/live anchors and lastDamage:
                        // a repeated click is not productive damage or a new life.
                        disengagedAt=undefined;
                    }
                }else disengagedAt=undefined;
                if(s.tick()-lastDamage>=noProgress)throw new Error('no imp progress: target damage/hero-loot timeout');
                await waitTicks(s,1);
            }
            if(retarget)continue;
            if(!credited)break;
        }
        stop=creditedKills===o.maximum?'max-kills':o.stop?.()?'stop-file':died?'died':'cap';
    }catch(e){failure=String(e);capture('failure');}
    finally{
        if(activeBeforeXp!==undefined)recordAbandoned('job ended without completed kill proof',false);
        if(!ended&&!died)try{await returnBank();}catch(e){failure=[failure,String(e)].filter(Boolean).join('; ');}
        off();
    }
    // On failure report actual bank delta too; never label collected-but-unbanked output fulfilled.
    for(const id of IMP_LOOT)banked[id]=initial?bankCount(id)-(initial.get(id)??0):0;
    const final=totals();
    const preserved=!!initial&&[...new Set([...initial.keys(),...final.keys(),...IMP_LOOT])].every(id=>(final.get(id)??0)===(initial!.get(id)??0)+(loot[id]??0)-(id===FOOD?eaten:0));
    if(!preserved)failure||='no imp progress: asset conservation failed';
    if(IMP_LOOT.some(id=>held(id)>0||banked[id]!== (loot[id]??0)))failure||='no imp progress: final bank proof failed';
    const attributedAshes=credits.reduce((n,c)=>n+Number(c.freshAshCount),0),bonusAshes=credits.reduce((n,c)=>n+Number(c.extraAshes),0);
    const creditedAttackXp=credits.reduce((n,c)=>n+Number(c.ownAttackXp),0),abandonedAttackXp=abandoned.reduce((n,c)=>n+Number(c.partialDamageXp),0);
    if(creditedAttackXp+abandonedAttackXp!==xp()-initialXp)failure||='no imp progress: Attack XP attribution mismatch';
    const targetMet=creditedKills===o.maximum&&!failure&&!ended&&!died&&preserved;
    console.log(`IMP_DIAGNOSTIC ${JSON.stringify(diagnostics)}`);
    return {ok:targetMet,creditedKills,attacks,reengagements,loot,banked,credits,abandoned,cancellations,initialDeferredNpcIndices,creditedAttackXp,abandonedAttackXp,mandatoryAshes:creditedKills,bonusAshes,unexplainedAshes:(banked[ASH]??0)-attributedAshes,attackXp:xp()-initialXp,eaten,foodHeldInitial,foodHeldFinal:held(FOOD),hpMin,died,preserved,targetMet,stop,ticks:s.tick()-start,failure:failure||(!targetMet?'no imp progress: bounded target unmet':'-'),diagnostics};
}
if(import.meta.main){
    const name=process.argv[2];
    if(!name)throw new Error('imp account required');
    if(!IMP_ROUTE_READY)await finish([],false,'no imp progress: offline route not admitted');
    let stopped=false;
    const s=await openBot(name,{onStop:async()=>{stopped=true;}}).catch(e=>finish([],false,`login: ${String(e)}`));
    try{const r=await runImps(s,{cap:Number(process.env.CAP??900),maximum:Number(process.env.MAX_KILLS??1),noProgress:Number(process.env.NO_PROGRESS??120),stop:()=>stopped});await finish([s],r.ok,`mode=imp ${Object.entries(r).map(([k,v])=>`${k}=${typeof v==='object'?JSON.stringify(v):v}`).join(' ')}`);}catch(e){await finish([s],false,String(e));}
}
