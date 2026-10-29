// Finite cooked-shark order. Usage: bun scripts/shark-supply.ts <account> [count=25] [ticks=9000]
// SHARK_CONSUMER names the endgame staging/combat demand. No repeating surplus order.
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {openBot,finish,sessionDied,getWorld,accountOf} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {goTo,sessionWalker,walkPath,type PathDeps,type PathPoint,type PathTile} from '../packages/core/src/walk';
import {depositObserved} from '../packages/core/src/deposit';
import {catchSharks} from './gather-fish';
import {cookSharks} from './cook-food';

type Row={id:number;count:number};
export function sharkOrderConfig(args:readonly string[],env:Record<string,string|undefined>) {
    return {target:Number(args[0]??env.MAX_COOKED??env.SHARK_COUNT??25),maxTicks:Number(args[1]??env.CAP??9000),
        consumer:env.SHARK_CONSUMER??'high-HP endgame combat staging'};
}
export function sharkSummary(r:{banked:number;caught:number;cooked:number;burnt:number;coinsSpent:number;ticks:number}) {
    // coordinator acceptStatus consumes flat RESULT counters, not diagnostic JSON.
    return `newBankedSharks=${r.banked} caught=${r.caught} cooked=${r.cooked} burnt=${r.burnt} coinsSpent=${r.coinsSpent} ticks=${r.ticks} detail=${JSON.stringify(r)}`;
}
// Finite order identity. With ORDER_KEY set, one durable journal entry per account and key is claimed before login.
// Any existing entry refuses: a completed order is a duplicate, and a started or failed one has uncertain output.
// An unchanged retry therefore cannot count old or uncertain output again; a new order needs a new key.
export const SHARK_ORDER_DIR=resolve(import.meta.dir,'../.practice/shark-orders');
export function claimSharkOrder(dir:string,account:string,key:string,order:{target:number;maxTicks:number;consumer:string},now=Date.now()) {
    if(!/^[A-Za-z0-9_-]{1,12}$/.test(account)||!/^[A-Za-z0-9_-]{1,64}$/.test(key))throw Error('invalid shark order identity');
    const path=join(dir,account.toLowerCase(),key+'.json');mkdirSync(join(dir,account.toLowerCase()),{recursive:true});
    try{writeFileSync(path,JSON.stringify({state:'started',at:now,pid:process.pid,account,key,order}),{flag:'wx'});}
    catch(e){
        if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
        let state='unreadable';try{state=JSON.parse(readFileSync(path,'utf8')).state;}catch{/* an unreadable entry is uncertain */}
        throw Error(state==='completed'?`shark order ${key} already completed; duplicate refused`:`shark order ${key} has uncertain output (${state}); no retry`);
    }
    return path;
}
export function settleSharkOrder(path:string,r:{ok:boolean;banked:number;caught:number;cooked:number;burnt:number;failure:string},now=Date.now()) {
    const entry=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
    if(entry?.state!=='started'||entry.pid!==process.pid)throw Error('shark order journal ownership changed');
    writeFileSync(path,JSON.stringify({...entry,state:r.ok?'completed':'failed',settledAt:now,result:{banked:r.banked,caught:r.caught,cooked:r.cooked,burnt:r.burnt,failure:r.failure}}));
}
export const SHARK_BANK={x:2809,z:3441}, WEST_BANK={x:2619,z:3332};
const d8=(a:PathTile,b:PathTile)=>Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z));
// Ardougne west bank to Catherby, west of White Wolf Mountain. Pinned findLongPath legs stay inside (2026-10-29).
export const sharkCorridor=(p:PathTile)=>p.x>=2600&&p.x<=2865&&p.z>=3320&&p.z<=3460;
// walkPath takes an empty plan (rs-sdk can call the actor's own tile blocked) and stops within the point tol.
// Refuse a plan that ends outside that tol or leaves the corridor.
export function sharkRoutePlan(level:number,from:PathTile,to:PathPoint,path:PathTile[]) {
    const end=path.at(-1)??from;
    if(level!==0||!sharkCorridor(from)||!path.every(sharkCorridor)||d8(end,to)>(to.tol??2))throw Error('unsafe/incomplete shark route');
    return path;
}
export function guardSharkRoute(deps:PathDeps,stop:()=>boolean):PathDeps {
    const send=deps.walk.bind(deps), plan=deps.plan.bind(deps);
    deps.plan=(level,from,to)=>sharkRoutePlan(level,from,to,plan(level,from,to));
    deps.walk=(x,z)=>{if(stop()||!sharkCorridor({x,z}))throw Error('shark route stopped');return send(x,z);};
    return deps;
}
export function sharkEntry(p:{worldX:number;worldZ:number;level:number}|null|undefined) {
    if(!p||p.level!==0)return null;
    if(Math.max(Math.abs(p.worldX-WEST_BANK.x),Math.abs(p.worldZ-WEST_BANK.z))<=8)return 'west-bank';
    if(p.worldX>=2800&&p.worldX<=2865&&p.worldZ>=3420&&p.worldZ<=3450)return 'catherby';
    return null;
}
export function sharkAssets(rows:readonly Row[]) {
    const out:Record<number,number>={};for(const i of rows)out[i.id]=(out[i.id]??0)+i.count;return out;
}
export function sharkAssetCheck(before:Record<number,number>,after:Record<number,number>,r:{caught:number;cooked:number;burnt:number;coinsSpent:number;toolBought:number;consumed:Record<number,number>}) {
    const delta:Record<number,number>={383:r.caught-r.cooked-r.burnt,385:r.cooked,387:r.burnt,995:-r.coinsSpent,311:r.toolBought};
    for(const [id,n] of Object.entries(r.consumed))delta[Number(id)]=(delta[Number(id)]??0)-n;
    return [...new Set([...Object.keys(before),...Object.keys(after),...Object.keys(delta)])].every(k=>{
        const id=Number(k);return (after[id]??0)-(before[id]??0)===(delta[id]??0);
    });
}
export function harpoonPurchase(price:number,stock:number,cash:number,maxCost=200,reserve=1000) {
    return Number.isSafeInteger(price)&&price>0&&price<=maxCost&&Number.isSafeInteger(stock)&&stock>0&&cash-price>=reserve;
}
export type SharkOptions={target:number;maxTicks:number;consumer:string;stop?:()=>boolean;recoveryTicks?:number;walker?:(s:Session)=>Promise<PathDeps>};
export async function supplySharks(s:Session,o:SharkOptions) {
    if(!Number.isSafeInteger(o.target)||o.target<1||o.target>100||!Number.isSafeInteger(o.maxTicks)||o.maxTicks<1||!o.consumer.trim())throw Error('invalid finite shark order/consumer');
    const start=s.tick(), state=()=>s.sdk.getState(), inv=()=>s.sdk.getInventory(), hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    const held=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const r={ok:false,target:o.target,consumer:o.consumer,caught:0,cooked:0,burnt:0,banked:0,coinsSpent:0,toolBought:0,
        consumed:{} as Record<number,number>,hpStart:hp(),hpMin:hp(),died:false,damage:0,ticks:0,atBank:false,assets:false,recovery:'not-needed',failure:'',unbanked:{} as Record<number,number>};
    let initial:Record<number,number>|undefined, first:any, ended=false, damageBase=hp(), lastHp=hp(), ready=false;
    let deadline=start+o.maxTicks;
    const safety=()=>{const p=state()?.player; const h=hp();r.hpMin=Math.min(r.hpMin,h);r.damage+=Math.max(0,lastHp-h);lastHp=h;
        r.died ||= !!first&&sessionDied(first,p)||h<=0;
        return ended||r.died||!p||p.level!==0||h<Math.max(20,damageBase-12)||r.damage>12;};
    const stop=()=>safety()||s.tick()>=deadline||!!o.stop?.();
    void s.ended.then(()=>{ended=true;});
    const off=s.onTick(()=>{if(ready)safety();});
    const observe=()=>s.bankObservation?.();
    const open=async()=>{
        const generation=observe()?.generation??-1;
        if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!observe()&&observe()!.generation>generation,{timeoutTicks:15}))throw Error('fresh shark bank unavailable');
        return observe()!;
    };
    const assets=()=>sharkAssets([...inv(),...s.sdk.getEquipment(),...(observe()?.items??[])]);
    const walk=async(points:{x:number;z:number;tol?:number}[])=>{
        if(stop())throw Error('shark route budget/health stop');
        const deps=guardSharkRoute(await (o.walker??sessionWalker)(s),stop);
        const result=await walkPath(deps,points,{maxTicks:Math.max(1,Math.min(700,deadline-s.tick())),stop});
        const p=state()?.player,end=points.at(-1)!;
        if(!result.ok||stop()||!p||Math.max(Math.abs(p.worldX-end.x),Math.abs(p.worldZ-end.z))>(end.tol??2))throw Error(`shark route failed ${result.detail}`);
    };
    const withdraw=async(id:number,name:RegExp,amount:number)=>{
        const b=observe();if(!b)throw Error('withdraw bank unknown');
        const bankBefore=b.items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),packBefore=held(id),gen=b.generation;
        if(bankBefore<amount)throw Error(`missing owned stock ${id}`);
        await s.bot.withdrawItem(name,amount);
        if(!await waitUntil(s,()=>held(id)===packBefore+amount&&(observe()?.generation??0)>gen&&observe()!.items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0)===bankBefore-amount,{timeoutTicks:12}))throw Error(`withdraw mismatch ${id}`);
    };
    // The entry deposit holds old stock. Every later cooked shark in the pack is new.
    const store=async(all=false,count=!all)=>{
        for(const item of [...new Map(inv().map(i=>[i.id,i])).values()])if(all||[383,385,387].includes(item.id)) {
            const n=await depositObserved(s,item);if(count&&item.id===385)r.banked+=n;
        }
    };
    const returnBank=async()=>{await s.bot.closeInterface();await walk([{...SHARK_BANK,tol:2}]);await open();await store();r.atBank=true;};
    try {
        if(!await waitUntil(s,st=>!!st?.inGame&&!!st.player&&hp()>0&&Array.isArray(st.equipment),{timeoutTicks:20}))throw Error('shark entry state deadline');
        first={...state()!.player!};r.hpStart=hp();r.hpMin=hp();lastHp=hp();damageBase=hp();ready=true;
        // From anywhere else, the shared world walker takes the account to the Catherby bank first.
        if(!sharkEntry(first)){
            const there=await goTo(s,await getWorld(),{x:SHARK_BANK.x,z:SHARK_BANK.z,level:0},accountOf(s),{legTimeoutTicks:100});
            if(!there.ok)throw Error(`shark travel to Catherby failed: ${there.detail}`);
            first={...state()!.player!};
        }
        const entry=sharkEntry(first);
        if(!entry)throw Error('shark entry requires west bank or Catherby ground floor');
        if((s.sdk.getSkill('Fishing')?.level??0)<76||(s.sdk.getSkill('Cooking')?.level??0)<80)throw Error('shark order requires Fishing76 Cooking80');
        // Read the bank before any asset mutation. The ordinary west-bank entry is in bank reach.
        await open();initial=assets();await store(true);
        const maxHp=s.sdk.getSkill('Hitpoints')!.baseLevel;
        if(maxHp<40)throw Error('shark entry needs at least40 base HP');
        // Owned cheap food pays for entry healing. Preserve all other stock and kit.
        for(let n=0;hp()<maxHp-3&&n<12;n++) {
            if(stop())throw Error('shark entry budget/health stop');
            const food=observe()?.items.find(i=>[333,329,379].includes(i.id)&&i.count>0);
            if(!food)throw Error('missing owned travel food');
            await withdraw(food.id,new RegExp(`^${food.name}$`,'i'),1);await s.bot.closeInterface();
            const item=inv().find(i=>i.id===food.id)!,before=held(food.id),h=hp();
            await s.bot.eatFood(item);
            if(!await waitUntil(s,()=>held(food.id)===before-1&&hp()>h,{timeoutTicks:8}))throw Error('travel food debit/heal unobserved');
            r.consumed[food.id]=(r.consumed[food.id]??0)+1;await open();
        }
        if(hp()<maxHp-3)throw Error('entry heal budget exhausted');
        damageBase=hp();lastHp=hp();
        if((observe()?.items.find(i=>i.id===311)?.count??0)>0)await withdraw(311,/^harpoon$/i,1);
        // Carry two owned cheap travel meals; unused food is kept, never discarded.
        const travel=observe()?.items.find(i=>[333,329,379].includes(i.id)&&i.count>=2);
        if(!travel)throw Error('missing return food reserve');
        await withdraw(travel.id,new RegExp(`^${travel.name}$`,'i'),2);
        if(!held(311)) {
            const cash=observe()?.items.find(i=>i.id===995)?.count??0;
            if(cash<1200)throw Error('harpoon requires200 budget and1000 reserve');
            await withdraw(995,/^coins$/i,1200);
        }
        await s.bot.closeInterface();
        if(entry==='west-bank')await walk([{x:2618,z:3355,tol:2},{x:2645,z:3385,tol:2},{x:2680,z:3405,tol:2},{x:2725,z:3425,tol:2},{x:2770,z:3445,tol:2},{...SHARK_BANK,tol:2}]);
        if(!held(311)) {
            await walk([{x:2834,z:3445,tol:2}]);
            if(!(await s.bot.openShop(/^Harry$/i)).success)throw Error('Harry shop unavailable');
            const tool=state()?.shop.shopItems.find(i=>i.id===311);
            if(!tool||!harpoonPurchase(tool.buyPrice,tool.count,held(995)))throw Error('harpoon stock/price/reserve refused');
            const cash=held(995),price=tool.buyPrice;await s.bot.buyFromShop(tool,1);
            if(!await waitUntil(s,()=>held(311)===1&&held(995)<cash,{timeoutTicks:10}))throw Error('harpoon purchase unobserved');
            r.coinsSpent=cash-held(995);r.toolBought=1;
            if(r.coinsSpent!==price||r.coinsSpent>200||held(995)<1000)throw Error('harpoon purchase cost mismatch');
            await s.bot.closeShop();
        }
        await returnBank();
        const cash=inv().find(i=>i.id===995);if(cash)await depositObserved(s,cash);
        await s.bot.closeInterface();
        while(r.banked<o.target) {
            if(stop())throw Error('shark order budget/health stop');
            r.atBank=false;
            const amount=Math.min(o.target-r.banked,28-inv().length);
            if(amount<1)throw Error('shark full pack');
            await walk([{x:2845,z:3431,tol:2}]);
            const rawBefore=held(383);
            try{await catchSharks(s,amount,stop);await walk([{x:2816,z:3443,tol:1}]);}
            finally{r.caught+=held(383)-rawBefore;}
            const cookedBefore=held(385),burntBefore=held(387);
            try{await cookSharks(s,stop);}
            finally{r.cooked+=held(385)-cookedBefore;r.burnt+=held(387)-burntBefore;}
            await returnBank();await s.bot.closeInterface();
            console.log('SHARK_PROGRESS '+JSON.stringify(r));
        }
        await open();r.assets=sharkAssetCheck(initial,assets(),r);
        r.ok=r.banked===o.target&&r.caught===r.cooked+r.burnt&&r.assets&&!stop();
        if(!r.ok)throw Error('shark final asset/life/target mismatch');
    }catch(error){
        r.failure=String(error);r.ok=false;r.atBank=false;
        // One bounded return to the nearer supported bank, after the entry bank read. A failed order remains failed.
        const p=state()?.player, here=p&&{x:p.worldX,z:p.worldZ};
        if(initial&&!ended&&!r.died&&p?.level===0&&here&&sharkCorridor(here)&&!o.stop?.()) {
            deadline=s.tick()+(o.recoveryTicks??120);
            const bank=d8(here,WEST_BANK)<d8(here,SHARK_BANK)?{...WEST_BANK,tol:8}:{...SHARK_BANK,tol:2};
            try{await s.bot.closeInterface();await walk([bank]);await open();await store(true,true);r.atBank=true;r.recovery='banked';r.assets=sharkAssetCheck(initial,assets(),r);}
            catch(e){r.recovery=String(e);}
        }else r.recovery='unsupported';
        r.unbanked=sharkAssets(inv());
    }finally{off();r.ticks=s.tick()-start;}
    return r;
}

if(import.meta.main){
    let stopped=false,journal:string|undefined;
    const config=sharkOrderConfig(process.argv.slice(3),process.env);
    try{if(process.env.ORDER_KEY)journal=claimSharkOrder(SHARK_ORDER_DIR,process.argv[2]??'',process.env.ORDER_KEY,config);}catch(e){await finish([],false,String(e));}
    const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}}).catch(e=>finish([],false,String(e)));
    try{const r=await supplySharks(s,{...config,stop:()=>stopped});
        console.log('SHARK_ORDER_RESULT '+JSON.stringify(r));if(journal)settleSharkOrder(journal,r);await finish([s],r.ok,sharkSummary(r));
    }catch(e){await finish([s],false,String(e));}
}
