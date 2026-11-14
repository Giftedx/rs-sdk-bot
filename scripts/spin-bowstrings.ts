// Seers' Village Flax Spinner: withdraws flax from Seers' Bank (2727,3492),
// walks to spinning wheel house (2715,3470), climbs to 1st floor, spins flax into bow strings,
// climbs down, and banks at Seers' Bank.
// Usage: bun scripts/spin-bowstrings.ts <botName> [CAP ticks, default 15000]
// Environment: DEMO_OK=1 for live server.
// Adapts Microbot-Hub crafting/scripts/FlaxSpinScript banking/spinning to this finite Seers worker.
// Native recipe: skill_crafting/configs/spinning/spinning.struct; donor BSD notice: research/microbot-ports-LICENSE.txt.
import { openBot, finish, countItems, logoutSession } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import{depositObserved}from'../packages/core/src/deposit';
import { bankCargo } from '../packages/core/src/cargo';
import {productionStopRequested} from './microbot-c-lifetime';
import type {Session} from '../packages/core/src/inprocess';
import{actionSessionOwner,finishActionSession}from'./microbot-a-actions';
import {BotActions} from '../vendor/rs-sdk/sdk/actions';

const SEERS_BANK = { x: 2727, z: 3492, level: 0 };
const WHEEL_HOUSE = { x: 2715, z: 3471, level: 0 };

const botName = process.argv[2] ?? 'Ballspinner';
const MAX_MAKE=Number(process.env.MAX_MAKE??56), RAW_RESERVE=Number(process.env.RAW_RESERVE??50);
const CAP = Number(process.argv[3] ?? process.env.CAP ?? 15000);
const MAX_TRIPS=Number(process.env.MAX_TRIPS??MAX_MAKE+2);

export function spinLimits(maximum:number,reserve:number,cap:number,trips:number){
 if(![maximum,reserve,cap,trips].every(Number.isSafeInteger)||maximum<1||reserve<0||cap<1||trips<1)throw Error('invalid finite spinning limits');
 return{maximum,reserve,cap,trips};
}
export function spinAssets(items:readonly{id:number;count:number}[]){
 const result:Record<number,number>={};for(const row of items){const id=row.id===1780?1779:row.id===1778?1777:row.id;result[id]=(result[id]??0)+row.count;}return result;
}
export function spinConversion(before:{items:Record<number,number>;xp:number},after:{items:Record<number,number>;xp:number},remaining:number){
 const made=(before.items[1779]??0)-(after.items[1779]??0);
 const valid=Number.isSafeInteger(made)&&made>=0&&made<=remaining&&[before.xp,after.xp].every(Number.isFinite)&&
  (made?after.xp>before.xp:after.xp===before.xp)&&[...new Set([...Object.keys(before.items),...Object.keys(after.items)])].every(k=>{
   const id=+k;return(after.items[id]??0)===(before.items[id]??0)+(id===1779?-made:id===1777?made:0);
  });
 if(!valid)throw Error('spinning conversion asset/XP mismatch');return made;
}
export function spinOwnedSession(raw:Session,requested:()=>boolean=()=>false,cleanupWithinDeadline:()=>boolean=()=>true){
 const sdk=raw.sdk,client=raw.client as {selfSlot?:number;executeBotAction?:unknown},direct=raw.direct,close=raw.close,ended=raw.ended,name=raw.name,config=sdk.config,endpoint=JSON.stringify([config?.host,config?.port,config?.gatewayUrl]),slot=client?.selfSlot,p=sdk.getState()?.player,life=p?.lifeId,respawns=p?.respawnCount??0,hp=sdk.getSkill('Hitpoints')?.level??0;
 let lost=false,cleaning=false,endedNow=false,loggedOut=false,executor=client?.executeBotAction;void ended.then(e=>{endedNow=true;loggedOut=e.reason==='logged-out';});
 const owns=()=>{
  const player=sdk.getState()?.player;
  // The random event gate (packages/core/src/randomevents.ts) puts the session's own `direct` back when the run
  // settles, after cleanup began: that is not another owner.
  if(raw.sdk!==sdk||raw.client!==client||!cleaning&&raw.direct!==direct||raw.close!==close||raw.ended!==ended||raw.name!==name||sdk.config!==config||JSON.stringify([config?.host,config?.port,config?.gatewayUrl])!==endpoint||client?.selfSlot!==slot||client?.executeBotAction!==executor||(!loggedOut||player!=null)&&(player?.lifeId!==life||(player?.respawnCount??0)!==respawns))lost=true;
  return !lost&&typeof executor==='function'&&Number.isSafeInteger(slot)&&Number.isSafeInteger(life);
 };
 const stopped=()=>!owns()||endedNow||productionStopRequested(name,requested,undefined,process.env.STOP_FILE??'.practice/stop-spin-bowstrings')||!sdk.getState()?.player||sdk.getState()?.player?.isDead||hp<1||(sdk.getSkill('Hitpoints')?.level??0)<hp||!Number.isFinite(sdk.getStateAge())||sdk.getStateAge()<0||sdk.getStateAge()>5000;
 const cleanupUnsafe=()=>endedNow||!cleanupWithinDeadline()||!sdk.getState()?.player||!!sdk.getState()?.player?.isDead||(sdk.getSkill('Hitpoints')?.level??0)<7||!Number.isFinite(sdk.getStateAge())||sdk.getStateAge()<0||sdk.getStateAge()>5000;
 const guard=()=>{if(!owns()||!cleanupWithinDeadline()||(cleaning?cleanupUnsafe():stopped()))throw Error('spinning original session input unavailable');};
 const guarded=new Proxy(sdk,{get(t,k,r){const value=Reflect.get(t,k,r);return typeof value==='function'?function(...args:unknown[]){if(String(k).startsWith('send'))guard();return value.apply(r,args);}:value;}});
 const session=Object.create(raw) as Session;Object.defineProperties(session,{sdk:{value:guarded},bot:{value:new BotActions(guarded)},direct:{value:(a:Parameters<Session['direct']>[0])=>{guard();return direct.call(raw,a);}},close:{value:()=>{if(!owns())throw Error('spinning original close unavailable');return close.call(raw);}}});
 // The prayer guard and the eat guard replace the client's executor at login, before this owner reads it, and each
 // puts back the one it replaced when settlement stops it (packages/core/src/prayer-guard.ts and eat-guard.ts, stop).
 // `settled` makes the executor of the logout step the owner's. It has no effect before cleanup began, and an
 // executor that `owns` found different stays lost.
 return{session,owns,stopped,cleanup:()=>{cleaning=true;},settled:()=>{if(cleaning)executor=client?.executeBotAction;}};
}

export function spinInputFailure(made:number,maximum:number,rawBank:number,reserve:number):string {
    return made<maximum&&rawBank<=reserve?'no spinning progress: bank flax at reserve':'';
}
export async function main(io:{open?:typeof openBot;ready?:(s:Session)=>Promise<boolean>;finalize?:Parameters<typeof finishActionSession>[3]}={}) {
spinLimits(MAX_MAKE,RAW_RESERVE,CAP,MAX_TRIPS);
let requested=false;
const raw = await (io.open??openBot)(botName,{onStop:async()=>{requested=true;}}).catch(e => finish([], false, `login: ${String(e)}`));
const entryTick=raw.tick(),owner=actionSessionOwner(raw,()=>requested),owned=spinOwnedSession(raw,()=>requested,()=>raw.tick()-entryTick<CAP);
let unwatch:(()=>void)|undefined,recovery:(()=>Promise<void>)|undefined,cleaning=false;
const complete=async(ok:boolean,detail:string)=>{
 if(!owned.owns()){console.log('RESULT fail spinning original session replaced; cleanup refused');process.exitCode=1;return;}
 // packages/core/src/bot.ts settleOnce stops the guards and calls this logout step with no await, so only the guards
 // can change the executor between the owner check above and `settled`.
 owned.cleanup();await finishActionSession(owner,ok,detail,io.finalize??finish,async()=>{owned.settled();if(!owned.owns())throw Error('spinning cleanup owner unavailable');const result=await logoutSession(owner.cleanup);if(!owned.owns())throw Error('spinning cleanup owner changed');return result;});
};
try {
    // Wait for initial sync
    if(!await (io.ready?io.ready(raw):waitUntil(owned.session,st=>(st?.inGame??false)&&!!st?.player||!owned.owns(),{timeoutTicks:10}))||!owned.owns())throw Error('spinning initial state unavailable');
    if(owned.stopped())throw Error('spinning stopped before admission');
    const s=owned.session;

    const pos = () => s.sdk.getState()?.player;
    const flaxCount = () => s.sdk.getInventory().filter(i=>i.id===1779).reduce((n,i)=>n+i.count,0);
    const bowstringsCount = () => countItems(s, /^bow string$/i);
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    let ended=false;
    void s.ended.then(()=>{ended=true;});
    const over = () => used() >= CAP || ended || !owned.owns() || (cleaning?hpMin<7||!!pos()?.isDead:owned.stopped());
    const snapshot=()=>({items:Object.fromEntries(s.sdk.getInventory().reduce((m,i)=>m.set(i.id,(m.get(i.id)??0)+i.count),new Map<number,number>())),xp:s.sdk.getSkillXp('Crafting')??0});
    const bankSnapshot=()=>{
        const bank=s.bankObservation?.();if(!bank||!s.sdk.getState()?.bank.isOpen)throw Error('spinning bank stock unobserved');
        return{items:spinAssets([...bank.items,...s.sdk.getInventory(),...s.sdk.getEquipment()]),xp:s.sdk.getSkillXp('Crafting')??0};
    };
    let initialStock:ReturnType<typeof bankSnapshot>|undefined;
    const freshBank=async()=>{
        if(s.sdk.getState()?.bank.isOpen){await s.bot.closeBank();if(!await waitUntil(s,()=>!s.sdk.getState()?.bank.isOpen,{timeoutTicks:8}))throw Error('spinning bank closure unobserved');}
        const generation=s.bankObservation?.()?.generation??-1;
        if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!s.sdk.getState()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:10}))throw Error('spinning fresh bank unobserved');
    };

    const xp0=s.sdk.getSkillXp('Crafting')??0;
    const protectedKit=s.sdk.getInventory().filter(i=>!/^flax$|^bow string$/i.test(i.name)).map(i=>({id:i.id,count:i.count}));
    let hpMin=s.sdk.getSkill('Hitpoints')?.level??10; const life=pos()?.lifeId;let died=false;
    const off=s.onTick(()=>{hpMin=Math.min(hpMin,s.sdk.getSkill('Hitpoints')?.level??hpMin);if(pos()?.isDead||life!==undefined&&(pos()?.lifeId ?? life) !== life)died=true;});unwatch=off;
    let made=0;
    let spunTotal = 0;
    let bankTrips = 0;
    let walkTicks = 0;

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

    const climbLadder = async (direction: 'up' | 'down'): Promise<boolean> => {
        const targetLevel = direction === 'up' ? 1 : 0;
        const opName = direction === 'up' ? 'Climb-up' : 'Climb-down';
        for (let attempt = 0; attempt < 3 && !over(); attempt++) {
            if (pos()?.level === targetLevel) return true;
            const ladder = s.sdk.findNearbyLoc(/^ladder$/i);
            if (ladder) {
                await s.bot.interactLoc(ladder, opName);
                await waitTicks(s, 2);
                if (pos()?.level === targetLevel) return true;
            }
            await waitTicks(s, 1);
        }
        return pos()?.level === targetLevel;
    };

    const bank = async (withdraw=true) => {
        if (pos()?.level === 1) {
            if(!await climbLadder('down'))throw Error('spinning bank ladder descent unconfirmed');
        }
        if(!await walk(SEERS_BANK.x, SEERS_BANK.z, 2)||pos()?.level!==0||Math.max(Math.abs(pos()!.worldX-SEERS_BANK.x),Math.abs(pos()!.worldZ-SEERS_BANK.z))>2)throw Error('spinning bank arrival unconfirmed');
        await freshBank();initialStock??=bankSnapshot();

        // Bank certificates first: a noted stack is not a usable spinning ingredient.
        const note=s.sdk.getInventory().find(i=>i.id===1780);
        if(note){
            const before=s.sdk.getState()?.bank?.items.filter(i=>i.id===1779).reduce((n,i)=>n+i.count,0)??0;
            const amount=note.count;await s.bot.depositItem(note,-1);await waitTicks(s,1);
            const after=s.sdk.getState()?.bank?.items.filter(i=>i.id===1779).reduce((n,i)=>n+i.count,0)??0;
            if(s.sdk.getInventory().some(i=>i.id===1780)||after!==before+amount)throw new Error('noted flax did not become raw bank stock');
            console.log(`SPIN_NOTES deposited=${amount} rawBank=${after}`);
        }

        // Deposit bow strings and any junk
        if (bowstringsCount() > 0) {
            const before=bowstringsCount();
            await s.bot.depositItem(/^bow string$/i, -1);
            spunTotal += Math.max(0,before-bowstringsCount());
        }

        await waitTicks(s,1);
        if(!cleaning)await bankCargo(s,[/^bow string$/i]);
        if(!withdraw){const raw=s.sdk.getInventory().find(i=>i.id===1779);if(raw)await depositObserved(s,raw);}

        const stock=s.sdk.getState()?.bank?.items.find(i=>/^flax$/i.test(i.name))?.count??0;
        const held=s.sdk.getInventory().length,free=28-held;
        const take=withdraw?Math.min(free,MAX_MAKE-made,Math.max(0,stock-RAW_RESERVE)):0;
        if(take>0){const r=await s.bot.withdrawItem(/^flax$/i,take);if(!r.success)throw new Error(`withdraw flax: ${r.message}`);}
        await waitTicks(s, 1);
        await s.bot.closeInterface();
        bankTrips++;
        console.log(`MILESTONE bank t=${used()} spunTotal=${spunTotal} bankTrips=${bankTrips} flax=${flaxCount()}`);
    };

    recovery=async()=>{if(!owned.owns()||ended||hpMin<7||pos()?.isDead||used()>=CAP||s.sdk.getStateAge()>5000)return;cleaning=true;owned.cleanup();await bank(false);};

    const spin = async () => {
        // Must be on 1st floor
        if (pos()?.level === 0) {
            await walk(WHEEL_HOUSE.x, WHEEL_HOUSE.z, 1);
            await climbLadder('up');
        }

        const wheel = s.sdk.findNearbyLoc(/^spinning wheel$/i);
        if (!wheel) {
            console.log('WARN spinning wheel not found nearby');
            await waitTicks(s, 3);
            return;
        }

        if ((s.sdk.getSkill('Crafting')?.baseLevel ?? 1) < 10) throw new Error('flax requires Crafting 10');
        const clearLevelup=async()=>{
            let lastPage='';
            for(let i=0;i<12;i++){
                const d=s.sdk.getDialog();if(!d?.isOpen)return;
                const option=d.options.length===1&&/continue/i.test(d.options[0]!.text)?d.options[0]:null;
                if(!option)throw new Error('unexpected dialog during batch spinning');
                const key=d.pageId??JSON.stringify(d.options);
                if(key!==lastPage){console.log(`SPIN_CONTINUE page=${key}`);await s.sdk.sendClickDialog(option.index);lastPage=key;}
                await waitTicks(s,1);
            }
            throw new Error('level-up dialog did not clear');
        };
        let missed=0;
        while(flaxCount()>0 && made<MAX_MAKE && !over()) {
            if(s.sdk.getDialog()?.isOpen)await clearLevelup();
            await s.bot.interactLoc(wheel,'Spin');
            const menu=await waitUntil(s,()=>s.sdk.getDialog()?.options.some(o=>o.componentId===8875)??false,{timeoutTicks:8});
            const d=s.sdk.getDialog();console.log('SPIN_MENU '+JSON.stringify(d));
            const makeX=d?.options.find(o=>o.componentId===8875),flax=d?.options.find(o=>o.componentId===8878&&/flax/i.test(o.text));
            if(!menu||!makeX||!flax)throw new Error('fresh flax MakeX menu not observed');
            const amount=Math.min(flaxCount(),MAX_MAKE-made),before=flaxCount();
            let observed=snapshot(),lastProgress=s.tick();
            await s.sdk.sendClickDialog(makeX.index);await s.sdk.sendCountDialog(amount);
            while(!over()){
                const next=snapshot(),n=flaxCount(),gain=spinConversion(observed,next,MAX_MAKE-made);observed=next;
                if(gain){made+=gain;lastProgress=s.tick();missed=0;}
                if(n<=before-amount)break;
                const dialog=s.sdk.getDialog();
                if(dialog?.isOpen && dialog.options.length===1 && /continue/i.test(dialog.options[0]!.text)){await clearLevelup();break;}
                if(s.tick()-lastProgress>=8){if(++missed>=3)throw new Error('batch flax spinning made no progress');break;}
                await waitTicks(s,1);
            }
        }

    };

    console.log(`START spin-bowstrings ${botName} at=${pos()?.worldX},${pos()?.worldZ},${pos()?.level}`);

    await bank();
    while (!over() && made<MAX_MAKE && bankTrips<MAX_TRIPS) {
        if(flaxCount()===0){await bank();if(flaxCount()===0)break;}
        await spin();
    }
    if(over())throw Error('spinning stop/life/session/budget limit');
    await bank(false);
    if(flaxCount()>0)throw new Error('unprocessed flax remains after bound');
    await freshBank();
    const bankItems=s.sdk.getState()?.bank?.items??[];
    const rawBank=bankItems.filter(i=>/^flax$/i.test(i.name)).reduce((n,i)=>n+i.count,0);
    const stringsBank=bankItems.filter(i=>/^bow string$/i.test(i.name)).reduce((n,i)=>n+i.count,0);
    const finalStock=bankSnapshot();
    const reconciled=!!initialStock&&spinConversion(initialStock,finalStock,MAX_MAKE)===made;
    spunTotal=initialStock?stringsBank-(initialStock.items[1777]??0):0;
    const preserved=protectedKit.every(i=>s.sdk.getInventory().filter(j=>j.id===i.id).reduce((n,j)=>n+j.count,0)===i.count);
    const xpGain=(s.sdk.getSkillXp('Crafting')??0)-xp0;
    const ok=!over()&&reconciled&&made===MAX_MAKE&&spunTotal===made&&rawBank>=RAW_RESERVE&&preserved&&!died&&hpMin>=7&&xpGain>0;
    const inputFailure=spinInputFailure(made,MAX_MAKE,rawBank,RAW_RESERVE),stop=inputFailure?'input-wait':ok?'target':'incomplete';
    console.log('SPIN_BANK '+JSON.stringify({ok,made,spunTotal,rawBank,stringsBank,reconciled,preserved,xpGain,hpMin,died,targetMet:ok,stop,inventory:s.sdk.getInventory(),bank:bankItems}));
    await s.bot.closeBank();off();
    await complete(ok,`${inputFailure?inputFailure+' ':''}ticks=${used()} made=${made} spunTotal=${spunTotal} rawBank=${rawBank} xpGain=${xpGain} preserved=${preserved} hpMin=${hpMin} died=${died} targetMet=${ok?1:0} stop=${stop}`);
} catch(e){let detail=String(e);try{await recovery?.();}catch(recoveryError){detail+='; original bank cleanup '+String(recoveryError);}unwatch?.();await complete(false,detail);}
}
if(import.meta.main) await main();
