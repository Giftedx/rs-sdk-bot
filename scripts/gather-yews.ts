// Seers' Village Yew Tree Logger: chops Yew trees near the Seers' church (2710,3460) and banks at Seers' Bank (2725,3492).
// Usage: bun scripts/gather-yews.ts <bot, e.g. Bigchopper> [CAP ticks, default 15000] [BANK_AT logs, default 27]
// Environment: DEMO_OK=1 for live server.
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker, expandPath } from '../packages/core/src/walk';
import { bankCargo } from '../packages/core/src/cargo';
import type {Session} from '../packages/core/src/inprocess';
import {BotActions} from '../vendor/rs-sdk/sdk/actions';
import type {NearbyLoc} from '../vendor/rs-sdk/sdk/types';
import {productionStopRequested} from './microbot-c-lifetime';

// Native m42_54 willow and m42_53 magic placements, within the published loc radius.
export function seersProcessingGrove(tree:string){
 if(tree==='willow')return{x:2708,z:3509};if(tree==='magic')return{x:2692,z:3425};if(tree==='maple'||tree==='yew')return{x:2712,z:3462};throw Error('unsupported Seers processing grove');
}
export function processingTreeEdges(tree:{x:number;z:number},width:number,length:number){
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(length)||width<1||width>4||length!==width)throw Error('native square tree footprint unknown');
 return[...Array.from({length:width},(_,i)=>({x:tree.x+i,z:tree.z-1})),...Array.from({length:width},(_,i)=>({x:tree.x+i,z:tree.z+length})),...Array.from({length},(_,i)=>({x:tree.x-1,z:tree.z+i})),...Array.from({length},(_,i)=>({x:tree.x+width,z:tree.z+i}))];
}
// Native loc AP requires a cardinal edge of the loaded footprint, not its diagonal corner.
export async function chopProcessingTree(original:Session,tree:NearbyLoc,stop:()=>boolean,walk?:(x:number,z:number)=>Promise<boolean>){
 const client=original.client,executor=(client as any)?.executeBotAction,first=original.sdk.getState()?.player,life=first?.lifeId,respawns=first?.respawnCount??0,plane=first?.level,hp=original.sdk.getSkill('Hitpoints')?.level??0;let lost=false;
 const safe=()=>{const p=original.sdk.getState()?.player;if(original.client!==client||(client as any)?.executeBotAction!==executor)lost=true;return !lost&&typeof executor==='function'&&life!==undefined&&!!p&&!p.isDead&&p.lifeId===life&&(p.respawnCount??0)===respawns&&p.level===plane&&(original.sdk.getSkill('Hitpoints')?.level??0)===hp&&!stop()&&!productionStopRequested(original.name);};
 if(!safe())throw Error('native tree original life/owner/HP/stop unavailable');
 const type=(client as {locTypeOf(id:number):{width:number;length:number}}).locTypeOf(tree.id),width=type.width,length=type.length,edges=processingTreeEdges(tree,width,length),began=original.tick();
 const received=()=>{const c=client as any,local=c.localPlayer;return{x:c.mapBuildBaseX+local?.routeX?.[0],z:c.mapBuildBaseZ+local?.routeZ?.[0],level:c.minusedlevel,routeLength:local?.routeLength};};
 const head=received();if(!Number.isSafeInteger(head.x)||!Number.isSafeInteger(head.z)||head.level!==plane)throw Error('native tree received approach origin unavailable');let goal:typeof edges[number]|undefined;
 {
  const goals=edges.flatMap(goal=>{if(goal.x===head.x&&goal.z===head.z)return[];const plan=original.sdk.findPath(goal.x,goal.z);if(!plan.success||plan.reachedDestination!==true||!plan.waypoints.length||plan.waypoints.at(-1)!.x!==goal.x||plan.waypoints.at(-1)!.z!==goal.z)return[];let cost=0,at={x:head.x,z:head.z};for(const point of plan.waypoints){cost+=Math.max(Math.abs(at.x-point.x),Math.abs(at.z-point.z));at=point;}return[{...goal,cost}];}).sort((a,b)=>a.cost-b.cost);
  goal=goals[0];if(!goal)throw Error('native tree no complete cardinal approach path');
 }
 let settlement:{frames:number;after:number|undefined;at:number|undefined}|undefined;const stand=goal,coherent=()=>{const at=original.sdk.getState()?.player,h=received();return !!at&&at.level===plane&&at.worldX===stand.x&&at.worldZ===stand.z&&h.x===stand.x&&h.z===stand.z&&h.level===plane;};
 {
  if(!safe())throw Error('native tree stopped before approach');
  const movementSdk=new Proxy(original.sdk,{get(target,key,receiver){const v=Reflect.get(target,key,receiver);return typeof v==='function'?function(...args:unknown[]){if(typeof key==='string'&&key.startsWith('send')){if(!safe())throw Error('native tree movement owner changed');const action=args[0]as any;if(key==='sendWalk'||key==='send'&&action?.type==='walkTo'){const now=received();if(now.x===stand.x&&now.z===stand.z)throw Error('native tree approach became a same-tile no-op');}}return v.apply(receiver,args);}:v;}}),movement={...original,sdk:movementSdk,bot:new BotActions(movementSdk),direct:async(action:Parameters<Session['direct']>[0])=>{if(!safe())throw Error('native tree movement owner changed');return original.direct(action);}}as Session;
  // A received edge can be a transient tile on an older server route.
  // Lite emits no packet for a same-tile walk; use a different legal edge once.
  const moved=walk?await walk(stand.x,stand.z):(await movement.sdk.sendWalk(stand.x,stand.z)).success;
  const remaining=40-(original.tick()-began),sentTick=original.sdk.getState()?.tick;let last=sentTick,stable=0;const settled=()=>{const tick=original.sdk.getState()?.tick;if(!coherent()){stable=0;last=tick;return false;}if(Number.isSafeInteger(tick)&&Number.isSafeInteger(last)&&tick!>last!){stable++;last=tick;}return stable>=2;};
  if(!moved||remaining<=0||!await waitUntil(original,()=>!safe()||settled(),{timeoutTicks:remaining})||!safe()||!coherent())throw Error('native tree cardinal arrival unobserved');settlement={frames:stable,after:sentTick,at:last};
 }
 const fresh=()=>original.sdk.getState()?.nearbyLocs.some(l=>l.id===tree.id&&l.x===tree.x&&l.z===tree.z&&l.level===plane&&l.optionsWithIndex.some(o=>/^chop down$/i.test(o.text)));
 if(!fresh())throw Error('native tree changed before chop');
 const initialMessages=original.sdk.getState()?.gameMessages??[],revision=Math.max(0,...initialMessages.map(m=>m.observationId??0)),tick=original.tick();let refusal='';
 const sdk=new Proxy(original.sdk,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);if(key==='waitForCondition')return function(predicate:(state:any)=>boolean,timeout:number){return value.call(receiver,(state:any)=>{if(!safe())throw Error('native tree original context ended');const message=state.gameMessages?.find((m:any)=>m.type===0&&((m.observationId??0)>revision||m.tick>tick)&&/I can't reach that!/i.test(m.text));if(message){refusal=message.text;throw Error(refusal);}return predicate(state);},timeout);};return typeof value==='function'?function(...args:unknown[]){if(typeof key==='string'&&key.startsWith('send')&&(!safe()||key==='sendInteractLoc'&&(!coherent()||!fresh())))throw Error('native tree pre-dispatch context changed');if(key==='sendInteractLoc')console.log('WOOD_TREE_APPROACH '+JSON.stringify({tree:{id:tree.id,x:tree.x,z:tree.z,width,length},stand,settlement,received:received(),public:{x:original.sdk.getState()?.player?.worldX,z:original.sdk.getState()?.player?.worldZ,level:original.sdk.getState()?.player?.level},tick:original.tick()}));return value.apply(receiver,args);}:value;}});
 const result=await new BotActions(sdk).chopTree(tree);if(refusal)throw Error('native processing tree refusal: '+refusal);if(!safe())throw Error('native tree context changed during chop');return result;
}
export const treeAfterBank=(explicit:string|undefined,normalLogs:number)=>explicit??(normalLogs<100?'normal':'oak');
const NORTH_NORMAL_TREES=new Set(['3078,3307','3081,3308','3082,3304','3083,3306','3084,3298','3086,3296','3087,3307','3089,3301','3089,3310','3090,3305','3093,3301','3096,3310']);
export function normalGrove(name='south'){
    if(name!=='south'&&name!=='north')throw Error('unsupported NORMAL_GROVE: '+name);
    return {name,spot:name==='north'?{x:3088,z:3303}:{x:3088,z:3285},
        contains:(x:number,z:number)=>name==='north'?NORTH_NORMAL_TREES.has(`${x},${z}`):x>=3080&&x<=3092&&z>=3272&&z<=3295};
}
type WoodTree={x:number;z:number;distance:number;reachable?:boolean;optionsWithIndex:readonly {text:string}[]};
export function woodTreeOrder<T extends WoodTree>(trees:readonly T[],players:readonly {x:number;z:number}[]){
    const adjacent=(t:T)=>players.filter(p=>Math.max(Math.abs(p.x-t.x),Math.abs(p.z-t.z))<=1).length;
    return trees.filter(t=>t.reachable!==false&&t.optionsWithIndex.some(o=>/^chop down$/i.test(o.text)))
        .sort((a,b)=>adjacent(a)-adjacent(b)||a.distance-b.distance);
}
const OAK_TILES=new Set(['3081,3291','3082,3295']); // rev289 m48_51 oaktree1281, both inside old Draynor safe rectangle.
export function oakGrove(name='north'){
    if(name!=='north'&&name!=='west')throw new Error('unsupported OAK_GROVE: '+name);
    return{name,trees:name==='west'?new Set(['3070,3253']):OAK_TILES,
        approach:name==='west'?{x:3070,z:3253,tol:3}:{x:3088,z:3285,tol:3}};
}
export function westOakPathAllowed(from:{x:number;z:number},corners:readonly {x:number;z:number}[],to=corners.at(-1)){
    const near=(a:{x:number;z:number}|undefined,x:number,z:number)=>!!a&&Math.max(Math.abs(a.x-x),Math.abs(a.z-z))<=1;
    // The existing bank/north waypoint leg bends around fences via3103,3271.
    // Permit that known access corridor only for this leg (or its reverse), not for tree selection.
    const access=near(from,3092,3250)&&near(to,3089,3266)||near(from,3089,3266)&&near(to,3092,3250);
    return corners.length>0&&[from,...expandPath(from,[...corners])].every(p=>
        (p.x<=3094||access&&p.x<=3103&&p.z>=3250&&p.z<=3271)&&!(p.x<3090&&p.z<3250));
}
export async function runDraynorOak(s:Session,o:{cap:number;maximum:number;prepare:boolean;grove?:string;noProgress?:number;walk?:(x:number,z:number,tol:number)=>Promise<boolean>}){
    const grove=oakGrove(o.grove);
    if(!Number.isSafeInteger(o.cap)||o.cap<1||!Number.isSafeInteger(o.maximum)||o.maximum<1||o.maximum>25)throw new Error('oak needs CAP>0 and MAX_MAKE1..25');
    const st=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,xp=()=>s.sdk.getSkillXp('Woodcutting')??0;
    const count=(items:readonly {id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),held=(id:number)=>count(inv(),id);
    if(!await waitUntil(s,()=>hp()>0&&(s.sdk.getSkill('Woodcutting')?.baseLevel??0)>=15,{timeoutTicks:15}))throw new Error('oak skill readiness failed');
    const p0=st()?.player,start=s.tick(),initialXp=xp(),initialHp=hp();
    if(!p0||p0.level!==0||Math.max(Math.abs(p0.worldX-3092),Math.abs(p0.worldZ-3243))>5)throw new Error('oak PREPARE requires known Draynor bank start');
    let ended=false,died=false,damaged=false,hpMin=initialHp,bankTrips=0,banked=0,failure='',baselineOak=0,lastProgress=s.tick();
    let walkTicks=0,plannedPathTiles=0,observedTileDistance=0,packStarted:number|undefined,packFillTicks=0;
    let previous={x:p0.worldX,z:p0.worldZ,level:p0.level};
    const pathLegs:{from:{x:number;z:number};to:{x:number;z:number};tiles:number}[]=[];
    void s.ended.then(()=>{ended=true;});
    const observe=()=>{const p=st()?.player;if(p){if(previous.level===p.level)observedTileDistance+=Math.max(Math.abs(p.worldX-previous.x),Math.abs(p.worldZ-previous.z));previous={x:p.worldX,z:p.worldZ,level:p.level};}hpMin=Math.min(hpMin,hp());damaged||=hp()<initialHp;died||=hp()<=0||!!p?.isDead||p?.lifeId!==p0.lifeId||(p?.respawnCount??0)>(p0.respawnCount??0);};
    const off=s.onTick(observe),over=()=>{observe();return ended||died||damaged||s.tick()-start>=o.cap;};
    const foodIds=[315,2309,333,329],foods=()=>foodIds.reduce((n,id)=>n+held(id),0);
    const walk=async(x:number,z:number,tol:number)=>{const tick=s.tick();try{
        if(o.walk)return await o.walk(x,z,tol);
        const deps=await sessionWalker(s),plan=deps.plan;
        deps.plan=(level,from,to)=>{const corners=plan(level,from,to),tiles=expandPath(from,corners);
            if(grove.name==='west'&&!westOakPathAllowed(from,corners,to)){
                console.log('OAK_ROUTE_REFUSED '+JSON.stringify({from,to,corners,tiles:tiles.length}));
                throw new Error(`west oak path refused: unsafe or unknown plan ${from.x},${from.z}->${to.x},${to.z}`);
            }
            plannedPathTiles+=tiles.length;pathLegs.push({from,to,tiles:tiles.length});return corners;};
        return(await walkPath(deps,[{x,z,tol}],{stop:()=>ended||died,maxTicks:180})).ok;
    }finally{walkTicks+=s.tick()-tick;}};
    const open=async()=>{if(st()?.bank.isOpen&&s.bankObservation?.())return;const generation=s.bankObservation?.()?.generation??0;
        if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!st()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:20}))throw new Error('no wood progress: bank readiness unknown');bankTrips++;};
    let bankSnapshot:{id:number;count:number}[]=[];
    const bankItems=()=>{const observed=s.bankObservation?.();if(observed)bankSnapshot=observed.items.map(i=>({id:i.id,count:i.count}));return bankSnapshot;};
    const bankCount=(id:number)=>count(bankItems(),id);
    const assets=()=>{const m=new Map<number,number>();for(const i of [...inv(),...(st()?.equipment??[]),...bankItems()])if(i.id!==1521)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
    let original=new Map<number,number>();
    const deposit=async()=>{await open();const item=inv().find(i=>i.id===1521);if(item){const before=bankCount(1521),n=held(1521);if(!(await s.bot.depositItem(item,-1)).success||!await waitUntil(s,()=>held(1521)===0&&bankCount(1521)===before+n,{timeoutTicks:20}))throw new Error('no wood progress: oak deposit unobserved');}banked=bankCount(1521)-baselineOak;};
    try{
        await open();baselineOak=bankCount(1521);original=assets();
        if(held(1521))throw new Error('oak needs empty carried output for NEW-log accounting');
        if(o.prepare){
            const missingAxe=held(1349)<1&&!count(st()?.equipment??[],1349);
            const foodNeed=Math.max(0,2-foods());
            if(missingAxe&&bankCount(1349)<1||foodIds.reduce((n,id)=>n+bankCount(id),0)<foodNeed)throw new Error('oak owned axe/food unavailable');
            if(missingAxe){const item=st()!.bank.items.find(i=>i.id===1349)!;if(!(await s.bot.withdrawItem(item,1,{asNote:false})).success||held(1349)!==1)throw new Error('oak owned iron axe withdrawal failed');}
            for(const id of foodIds){const n=Math.min(Math.max(0,2-foods()),bankCount(id));if(n){const item=st()!.bank.items.find(i=>i.id===id)!;if(!(await s.bot.withdrawItem(item,n,{asNote:false})).success)throw new Error('oak owned food withdrawal failed');}}
        }
        if(held(1349)+count(st()?.equipment??[],1349)<1||foods()<2)throw new Error('oak needs owned iron axe and2working foods');
        if(inv().length>3)throw new Error('oak bounded25 needs only axe and2foods held; no unrelated cargo');
        await s.bot.closeBank();
        for(const [x,z,tol] of [[3092,3250,1],[3089,3266,1],[grove.approach.x,grove.approach.z,grove.approach.tol]])if(!await walk(x!,z!,tol!))throw new Error('no wood progress: guarded northern entry failed');
        packStarted=lastProgress=s.tick();
        while(held(1521)<o.maximum&&!over()){
            if(s.tick()-lastProgress>=(o.noProgress??180))throw new Error('no wood progress: bounded oak output wait');
            const tree=st()?.nearbyLocs.filter(l=>l.id===1281&&grove.trees.has(`${l.x},${l.z}`)&&l.optionsWithIndex.some(op=>/^chop down$/i.test(op.text))).sort((a,b)=>a.distance-b.distance)[0];
            if(!tree){await waitTicks(s,1);continue;}
            const before=held(1521),beforeXp=xp(),op=tree.optionsWithIndex.find(op=>/^chop down$/i.test(op.text))!;
            if(st()?.dialog?.isOpen||st()?.modalOpen)await s.direct({type:'closeModal',reason:'SDK'});
            await s.sdk.sendInteractLoc(tree.x,tree.z,tree.id,op.opIndex);
            await waitUntil(s,()=>over()||held(1521)>before&&xp()>beforeXp||!st()?.nearbyLocs.some(l=>l.id===tree.id&&l.x===tree.x&&l.z===tree.z),{timeoutTicks:8});
            if(held(1521)>before&&xp()>beforeXp)lastProgress=s.tick();else await waitTicks(s,1);
        }
    }catch(e){failure=`no wood progress: ${String(e)}`;}
    finally{
        if(packStarted!==undefined)packFillTicks=s.tick()-packStarted;
        if(!ended&&!died)try{for(const [x,z,tol]of[[3089,3266,1],[3092,3250,1],[3092,3243,2]])if(!await walk(x!,z!,tol!))throw new Error('oak final bank route failed');await deposit();await s.bot.closeBank();}catch(e){failure=[failure,String(e)].filter(Boolean).join('; ');}
        off();
    }
    const final=assets(),preserved=original.size>0&&original.size===final.size&&[...original].every(([id,n])=>final.get(id)===n);
    const targetMet=banked===o.maximum&&held(1521)===0;
    console.log('OAK_ROUTE '+JSON.stringify({grove:grove.name,plannedPathTiles:o.walk?null:plannedPathTiles,pathLegs,observedTileDistance,walkTicks,packFillTicks,banked}));
    return{ok:!failure&&!ended&&!died&&!damaged&&targetMet&&preserved,tree:'oak',grove:grove.name,banked,newLogs:banked+held(1521),xpGain:xp()-initialXp,bankTrips,walkTicks,packFillTicks,plannedPathTiles:o.walk?null:plannedPathTiles,observedTileDistance,hpMin,died,damaged,preserved,targetMet,ticks:s.tick()-start,failure:failure||(damaged?'no wood progress: route HP loss':!preserved?'no wood progress: kit conservation mismatch':!targetMet?'no wood progress: oak target unmet':'-')};
}

if(import.meta.main){

const local = process.env.REGION === 'lumbridge';
const draynor = process.env.REGION === 'draynor';
const grove=draynor?normalGrove(process.env.NORMAL_GROVE):undefined;
let YEW_SPOT = local ? { x: 3226, z: 3237 } : draynor ? grove!.spot : { x: 2712, z: 3462 };
const SEERS_BANK = local || draynor ? { x: 3092, z: 3243 } : { x: 2727, z: 3492 };
let TREE = process.env.TREE ?? (draynor ? 'normal' : 'yew');
if(process.env.WOOD_GROVE!==undefined){if(process.env.WOOD_GROVE!=='native-processing'||local||draynor)throw Error('invalid WOOD_GROVE');YEW_SPOT=seersProcessingGrove(TREE);}
if(process.env.NORMAL_GROVE&&(!draynor||TREE!=='normal'))throw Error('NORMAL_GROVE requires Draynor normal trees');
const logRe = draynor&&!process.env.TREE ? /^(logs|oak logs)$/i : TREE === 'normal' ? /^logs$/i : new RegExp(`^${TREE} logs$`, 'i');
let treeRe = TREE === 'normal' ? /^tree$/i : new RegExp(`^${TREE}`, 'i');
const CAP = Number(process.argv[3] ?? process.env.CAP ?? 15000);
const BANK_AT = Number(process.argv[4] ?? process.env.BANK_AT ?? 27);

const botName = process.argv[2] ?? 'Bigchopper';
if(draynor&&TREE==='oak')oakGrove(process.env.OAK_GROVE); // Reject unknown profiles before login.

const s = await openBot(botName).catch(e => finish([], false, `login: ${String(e)}`));
if(grove?.name==='north'&&(s.sdk.getState()?.player?.combatLevel??0)<13)await finish([s],false,'no wood progress: northern grove requires combat13');
if(draynor&&TREE==='oak'&&(process.env.PREPARE==='1'||process.env.MAX_MAKE)){
    try{const r=await runDraynorOak(s,{cap:CAP,maximum:Number(process.env.MAX_MAKE??25),prepare:process.env.PREPARE==='1',grove:process.env.OAK_GROVE});await finish([s],r.ok,`mode=draynor-oak ${Object.entries(r).map(([k,v])=>`${k}=${v}`).join(' ')}`);}catch(e){await finish([s],false,String(e));}
}
try {
    const pos = () => s.sdk.getState()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const yewLogs = () => countItems(s, logRe);
    const freeSpace = () => 28 - (s.sdk.getState()?.inventory?.length ?? 0);
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    let ended = false, died = false;
    const life = pos()?.lifeId, respawns = pos()?.respawnCount ?? 0;
    void s.ended.then(() => { ended = true; });
    const over = () => used() >= CAP || ended || died;

    let hp0 = hp();
    let hpMin = hp0;
    const off = s.onTick(() => {
        if (hp0 > 0) hpMin = Math.min(hpMin, hp());
        const p = pos();
        if (p?.isDead || (p?.respawnCount ?? 0) > respawns || (life !== undefined && p?.lifeId !== life)) died = true;
    });

    const retryAfter=new Map<string,number>();
    let progressTick=s.tick();
    let chops = 0, banked = 0, bankTrips = 0, walkTicks = 0;

    const counters = () => `chops=${chops} banked=${banked} held=${yewLogs()} bankTrips=${bankTrips} walkTicks=${walkTicks} hpMin=${hpMin}`;

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
        progressTick=s.tick();
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };

    const bank = async () => {
        const n = yewLogs();
        if (n === 0 && freeSpace() > 0) return;
        if ((local || draynor) && (pos()?.worldX ?? 0) > 3150) for (const [x, z] of [[3226,3256],[3180,3258],[3140,3270],[3100,3270],[3089,3266],[3092,3250]]) await walk(x!, z!, 2);
        if (draynor) await walk(3092,3250,1);
        await walk(SEERS_BANK.x, SEERS_BANK.z, 2);
        const b = await s.bot.openBank();
        if (!b.success) {
            console.log(`WARN openBank failed: ${b.message}`);
            await waitTicks(s, 2);
            return;
        }
        if (s.sdk.getInventory().filter(i=>/^(bread|shrimps|trout|salmon|cooked chicken)$/i.test(i.name)).length<3) {
            for (const food of [/^salmon$/i,/^trout$/i,/^cooked chicken$/i]) {
                if (s.sdk.getState()?.bank?.items.some(i=>food.test(i.name)&&i.count>0)) { await s.bot.withdrawItem(food,5); break; }
            }
        }
        await s.bot.depositItem(logRe, -1);
        // Also deposit any random tree bird nests / gems
        for (const item of s.sdk.getInventory()) {
            if (!/axe$|^(shrimps|bread|trout|salmon|lobster|cooked chicken)$/i.test(item.name)) {
                await s.bot.depositItem(item.name, -1);
            }
        }
        await waitTicks(s, 1);
        const after = yewLogs();
        banked += n - after;
        bankTrips++;
        await bankCargo(s, [logRe]);
        if (draynor) {
            const logs = s.sdk.getState()?.bank?.items.find(i => /^logs$/i.test(i.name))?.count ?? 0;
            TREE = treeAfterBank(process.env.TREE,logs);
            treeRe = TREE === 'normal' ? /^tree$/i : new RegExp(`^${TREE}`,'i');
            YEW_SPOT = grove!.spot;
        }
        await s.bot.closeInterface();
        await waitTicks(s, 1);
        console.log(`MILESTONE bank t=${used()} banked=${banked} totalChops=${chops}`);
    };

    console.log(`START yew logger ${botName} at=${pos()?.worldX},${pos()?.worldZ}`);
    // The inherited account was left beside aggressive giant spiders. Leave before choosing a tree.
    if ((local || draynor) && (pos()?.worldX ?? 0) > 3150) {
        await s.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' });
        await s.direct({ type: 'walkTo', x: 3220, z: 3256, running: true, reason: 'SDK' });
        await walk(3220, 3256, 2);
        for(const [x,z] of [[3180,3258],[3140,3270],[3100,3270],[3089,3266],[3092,3250]]) await walk(x!,z!,2);
        await bank();
    }

    while (!over() && bankTrips < Number(process.env.MAX_TRIPS ?? Infinity)) {
        const actual=banked+yewLogs();
        if(actual>chops) progressTick=s.tick();
        chops=actual;
        if(s.tick()-progressTick>220) throw new Error('no wood progress for 220 ticks');
        if (yewLogs() >= BANK_AT || freeSpace() === 0) {
            await bank();
            continue;
        }

        const p = pos();
        if (!p) { await waitTicks(s, 1); continue; }
        if (hp() < 7) {
            const food = s.sdk.getInventory().find(i => /^(shrimps|bread|trout|salmon|lobster|cooked chicken)$/i.test(i.name));
            if (food) await s.bot.eatFood(food.name);
            else if (hp() < 4) {
                await s.direct({ type:'walkTo',x:3088,z:3285,running:true,reason:'SDK' });
                await walk(3088,3285,2);
                throw new Error('low HP: no food; escaped to northern trees');
            }
        }

        if (Math.max(Math.abs(p.worldX - YEW_SPOT.x), Math.abs(p.worldZ - YEW_SPOT.z)) > 12) {
            if (local) for (const [x,z] of [[3092,3250],[3089,3266],[3100,3270],[3140,3270],[3180,3258],[3226,3256]]) await walk(x!,z!,2);
            if (draynor) await walk(3092,3250,1);
            await walk(YEW_SPOT.x, YEW_SPOT.z, 4);
            continue;
        }

        const before = yewLogs();
        const trees = s.sdk.getState()?.nearbyLocs.filter(l => treeRe.test(l.name)
            && (!local || (l.x >= 3214 && l.x <= 3239 && l.z >= 3226 && l.z <= 3250))
            && (!draynor || (grove!.contains(l.x,l.z)
                && (retryAfter.get(`${l.x},${l.z}`)??0)<=s.tick()))).sort((a,b) => a.distance-b.distance) ?? [];
        const tree=(draynor?woodTreeOrder(trees,s.sdk.getState()?.nearbyPlayers??[]):trees)[0];
        if(!tree) { await waitTicks(s,2); continue; }
        if(draynor) {
            const xp=s.sdk.getSkillXp('woodcutting')??0;
            const a=s.tick();
            if(s.sdk.getState()?.dialog?.isOpen || s.sdk.getState()?.modalOpen)
                await s.direct({type:'closeModal',reason:'SDK'});
            const option=tree.optionsWithIndex.find(o=>/^chop down$/i.test(o.text));
            if(!option) { retryAfter.set(`${tree.x},${tree.z}`,s.tick()+20); await waitTicks(s,1); continue; }
            const sent=await s.sdk.sendInteractLoc(tree.x,tree.z,tree.id,option.opIndex);
            if(sent.success) await waitUntil(s,()=>over() ||
                (yewLogs()>before && (s.sdk.getSkillXp('woodcutting')??0)>xp) ||
                !s.sdk.getState()?.nearbyLocs.some(l=>l.id===tree.id && l.x===tree.x && l.z===tree.z),{timeoutTicks:20});
            // Inventory and loc updates can land in adjacent client publications.
            await waitTicks(s,1);
            if(yewLogs()>before && (s.sdk.getSkillXp('woodcutting')??0)>xp) {
                chops=banked+yewLogs(); progressTick=s.tick();
            } else {
                retryAfter.set(`${tree.x},${tree.z}`,s.tick()+20);
                console.log(`WARN wood tree=${tree.id}@${tree.x},${tree.z} ticks=${s.tick()-a} no log and XP gain`);
            }
        } else {
            const r=process.env.WOOD_GROVE==='native-processing'?await chopProcessingTree(s,tree,over):await s.bot.chopTree(tree);
            if(r.success) {
                chops=banked+yewLogs();
                if(yewLogs()>before) progressTick=s.tick();
            } else await waitTicks(s,6);
        }
    }

    if (!ended && !died) await bank();
    off();
    chops = banked + yewLogs();
    const perK = (chops * 1000 / Math.max(1, used())).toFixed(2);
    await finish([s], chops > 0 && !died && !ended, `ticks=${used()} died=${died} tree=${TREE} ${counters()} logsPer1kTicks=${perK}`);
} catch (e) {
    await finish([s], false, String(e));
}
}
