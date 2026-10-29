// One owned NPC purchase, then bank offline. No GE, player trade or repeat loop.
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {depositObserved} from '../packages/core/src/deposit';
import {sessionWalker,walkPath,expandPath} from '../packages/core/src/walk';
import type {ShopItem,ShopConfig} from '../vendor/rs-sdk/sdk/types';
export const SWORD=1287;
// Exact local swordshop stock profiles. Other weapons need separate qualification.
const SWORD_PROFILES:Record<number,{cost:number;stock:number;limit:number}>={1287:{cost:2080,stock:2,limit:2500},1301:{cost:3200,stock:1,limit:4000}};
function swordBudget(o:{itemId?:number;cap:number;maximumSpend:number}){
 const id=o.itemId??SWORD,profile=SWORD_PROFILES[id];
 if(!profile||!Number.isSafeInteger(o.cap)||o.cap<1||!Number.isSafeInteger(o.maximumSpend)||o.maximumSpend<1||o.maximumSpend>profile.limit)throw Error('requires positive CAP and item-specific MAX_SPEND limit');
 return id;
}
const BANK={x:3185,z:3436};
export const SWORD_ROUTE=[[3185,3420],[3195,3418],[3204,3400],[3204,3398]] as const;
export const swordTileSafe=(p:{x:number;z:number;level?:number})=>(p.level??0)===0&&(
    p.x>=3182&&p.x<=3208&&p.z>=3394&&p.z<=3440&&(p.z>=3410||p.x>=3195)
    // Actual SDK route enters the shop from the east around its wall, in both directions.
    // Reviewed full plans: owned-sword-exact-sdk-route-audit.json; no global x-limit expansion.
    ||p.x>=3209&&p.x<=3210&&p.z>=3399&&p.z<=3406);
export function swordQuote(item:ShopItem,config:ShopConfig|undefined){
    const profile=SWORD_PROFILES[item.id];
    if(!profile||!Number.isSafeInteger(item.count)||item.count<1||item.baseCost!==profile.cost
        ||item.buyPrice!==profile.cost||!config||config.sellMultiplier!==1000||config.haggle!==10)
        throw new Error('unknown sword shop price/config/stock');
    // StateCollector reports buyPrice at stockDiff0. Actual shop.rs2 uses current count minus the exact item default.
    const price=Math.max(1,Math.floor(profile.cost*Math.max(100,1000-Math.min(1000,Math.max(-5000,(item.count-profile.stock)*config.haggle)))/1000));
    return{reportedBuyPrice:item.buyPrice,price};
}
export async function runOwnedSword(s:Session,o:{itemId?:number;cap:number;maximumSpend:number;stop?:()=>boolean;walk?:(x:number,z:number,tol:number)=>Promise<boolean>}){
    const SWORD=swordBudget(o);
    const state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    const count=(items:readonly {id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),held=(id:number)=>count(inv(),id);
    const start=s.tick(),initial=state()?.player,initialHp=hp();
    if(!initial||initial.level!==0||Math.max(Math.abs(initial.worldX-BANK.x),Math.abs(initial.worldZ-BANK.z))>2||initialHp<=6||held(995)!==0||held(SWORD)!==0||inv().length>26)
        throw new Error('requires known Varrock West bank, empty wallet/output and2free pack slots');
    let ended=false,died=false,damaged=false,stopped=false,hpMin=initialHp,failure='',spent=0,bought=0,banked=0,price=0,reportedBuyPrice=0,bankObservedAt=0,cleanupDeadline=0,routeReached=0;
    let snapshot:{id:number;count:number}[]=[],original=new Map<number,number>();
    void s.ended.then(()=>{ended=true;});
    const terminal=()=>ended||died||(stopped||=!!o.stop?.()),over=()=>terminal()||damaged||s.tick()-start>=o.cap;
    const off=s.onTick(()=>{const p=state()?.player;hpMin=Math.min(hpMin,hp());damaged||=hp()<initialHp;stopped||=!!o.stop?.();died||=hp()<=0||!!p?.isDead||p?.lifeId!==initial.lifeId||(p?.respawnCount??0)>(initial.respawnCount??0);});
    const capture=()=>{const b=s.bankObservation?.();if(!b||!state()?.bank.isOpen)throw new Error('sword bank data unknown');snapshot=b.items.map(i=>({id:i.id,count:i.count}));bankObservedAt=b.at;};
    const bankCount=(id:number)=>count(snapshot,id),assets=()=>{const m=new Map<number,number>();for(const i of [...snapshot,...inv(),...(state()?.equipment??[])])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
    const open=async()=>{if(state()?.bank.isOpen&&s.bankObservation?.()){capture();return;}await s.bot.dismissBlockingUI();const gen=s.bankObservation?.()?.generation??0;
        if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>gen||terminal(),{timeoutTicks:15})||terminal())throw new Error('sword bank readiness unobserved');capture();};
    const walk=async(x:number,z:number,tol:number,cleanup=false)=>{
        const stop=()=>terminal()||s.tick()>=(cleanup?cleanupDeadline:start+o.cap)||!cleanup&&damaged;
        if(stop())throw new Error('sword route stopped');
        const current=state()?.player;if(current?.level===0&&Math.max(Math.abs(current.worldX-x),Math.abs(current.worldZ-z))<=tol)return;
        if(o.walk){if(!await o.walk(x,z,tol))throw new Error('sword route refused');return;}
        const deps=await sessionWalker(s),plan=deps.plan;
        deps.plan=(level,from,to)=>{const corners=plan(level,from,to),tiles=expandPath(from,corners);
            const offending=[from,...tiles].filter(p=>!swordTileSafe({...p,level}));
            if(level!==0||!corners.length||offending.length){console.log('SWORD_ROUTE_REFUSED '+JSON.stringify({level,from,to,corners,offending}));throw new Error('sword route unsafe/unknown full path');}return corners;};
        if(!(await walkPath(deps,[{x,z,tol}],{stop,maxTicks:Math.min(180,Math.max(1,(cleanup?cleanupDeadline:start+o.cap)-s.tick()))})).ok)throw new Error('sword route failed');
    };
    try{
        await open();original=assets();if(bankCount(995)<o.maximumSpend||bankCount(SWORD)!==0)throw new Error('owned budget missing or sword already owned');
        const coins=state()!.bank.items.find(i=>i.id===995)!;
        // withdrawItem(number) addresses a SLOT. Pass the actual observed BankItem object.
        if(!(await s.bot.withdrawItem(coins,o.maximumSpend,{asNote:false})).success
            ||!await waitUntil(s,()=>held(995)===o.maximumSpend||terminal(),{timeoutTicks:10})||terminal())throw new Error('owned coin withdrawal unobserved');
        capture();if(bankCount(995)!==(original.get(995)??0)-o.maximumSpend)throw new Error('owned coin bank debit mismatch');
        await s.bot.closeBank();for(const [x,z] of SWORD_ROUTE){await walk(x,z,1);routeReached++;}
        if(over())throw new Error('sword production cap/stop');
        const npc=state()?.nearbyNpcs.find(n=>[551,552].includes(n.id)&&n.distance<=8&&n.optionsWithIndex.some(p=>/^trade$/i.test(p.text)));
        if(!npc||!swordTileSafe({x:npc.tileX??npc.x,z:npc.tileZ??npc.z,level:0}))throw new Error('exact swordshop NPC not observed in range');
        await walk(npc.tileX??npc.x,npc.tileZ??npc.z,1);
        if(!(await s.bot.openShop(npc)).success)throw new Error('sword shop did not open');
        const shop=state()?.shop,item=shop?.shopItems.find(i=>i.id===SWORD);
        if(!shop?.isOpen||!item)throw new Error('sword not observed on shelf');
        console.log('ACTUAL_SHOP '+JSON.stringify({item,config:shop.shopConfig}));
        ({price,reportedBuyPrice}=swordQuote(item,shop.shopConfig));
        if(price>o.maximumSpend||price>held(995)||over())throw new Error('sword price exceeds owned spending cap');
        console.log('SWORD_QUOTE '+JSON.stringify({npc:npc.id,item:SWORD,stock:item.count,reportedBuyPrice,price,maximumSpend:o.maximumSpend}));
        const before=held(995),r=await s.bot.buyFromShop(item,1);
        await waitUntil(s,()=>held(SWORD)===1&&held(995)<before||ended||died,{timeoutTicks:10});
        spent=before-held(995);bought=held(SWORD);
        if(!r.success||r.amountBought!==1||bought!==1||spent!==price||spent>o.maximumSpend)throw new Error('one sword/actual price debit mismatch');
    }catch(e){failure=String(e);}
    finally{
        cleanupDeadline=s.tick()+240;
        if(!terminal())try{
            if(state()?.shop?.isOpen)await s.bot.closeShop();
            for(const [x,z] of SWORD_ROUTE.slice(0,routeReached).reverse())await walk(x,z,1,true);await walk(BANK.x,BANK.z,2,true);await open();
            for(const id of [SWORD,995]){const item=inv().find(i=>i.id===id);if(!item)continue;const n=held(id),before=bankCount(id),gen=s.bankObservation?.()?.generation??0;
                if(!(await s.bot.depositItem(item,-1)).success||!await waitUntil(s,()=>held(id)===0&&(s.bankObservation?.()?.generation??0)>gen||terminal(),{timeoutTicks:10})||terminal())throw new Error('sword/cash final deposit unobserved');
                capture();if(bankCount(id)!==before+n)throw new Error('sword/cash bank delta mismatch');}
            capture();banked=bankCount(SWORD)-(original.get(SWORD)??0);await s.bot.closeBank();
        }catch(e){failure=[failure,String(e)].filter(Boolean).join('; ');}off();
    }
    const final=assets(),preserved=original.size>0&&[...new Set([...original.keys(),...final.keys()])].every(id=>(final.get(id)??0)===(original.get(id)??0)+(id===SWORD?bought:0)-(id===995?spent:0));
    const targetMet=bought===1&&banked===1&&held(SWORD)===0&&held(995)===0;
    return{itemId:SWORD,ok:!failure&&!terminal()&&!damaged&&preserved&&targetMet,targetMet,bought,banked,spent,price,reportedBuyPrice,maximumSpend:o.maximumSpend,coinsRemaining:final.get(995)??0,hpMin,died,damaged,stopped,preserved,bankObservedAt,ticks:s.tick()-start,failure:failure||(!targetMet?'one sword goal unmet':!preserved?'asset conservation failed':'-')};
}

// Source-bound Eastbank preparation: settled waypoints, matched cash deposit,
// no new movement after a refused plan. Purchase logic remains shared below.
const EAST_BUYER_ROUTE = [{"x":3252,"z":3420},{"x":3253,"z":3420},{"x":3212,"z":3424},{"x":3185,"z":3436}];
const EAST_BUYER_PATHS = [{"from":{"x":3252,"z":3420},"corners":[{"x":3253,"z":3420}]},{"from":{"x":3253,"z":3420},"corners":[{"x":3253,"z":3428},{"x":3218,"z":3428},{"x":3216,"z":3426},{"x":3215,"z":3426},{"x":3214,"z":3425},{"x":3213,"z":3425},{"x":3212,"z":3424}]},{"from":{"x":3212,"z":3424},"corners":[{"x":3209,"z":3424},{"x":3205,"z":3428},{"x":3189,"z":3428},{"x":3188,"z":3429},{"x":3185,"z":3429},{"x":3182,"z":3432},{"x":3182,"z":3435},{"x":3183,"z":3436},{"x":3185,"z":3436}]}];
export async function runOwnedSwordFromEast(s:Session,o:{itemId?:number;cap:number;maximumSpend:number;stop?:()=>boolean}){
    const SWORD=swordBudget(o);
    const start=s.tick(),p=s.sdk.getState()?.player,hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    if(o.stop?.()||!p||p.level!==0||p.worldX!==3252||p.worldZ!==3420||hp()<=6)throw Error('Eastbank preparation requires checked start and healthy active account');
    let damaged=false,ended=false,previous=hp(),refused=false;
    void s.ended.then(()=>{ended=true;});const off=s.onTick(()=>{if(hp()<previous)damaged=true;previous=hp();});
    const terminal=()=>!!o.stop?.()||ended;
    const over=()=>terminal()||damaged||s.tick()-start>=o.cap;
    try{
        if(!(await s.bot.openBank()).success)throw Error('Eastbank preparation bank failed');
        const coins=s.sdk.getInventory().find(i=>i.id===995);let deposited=0;
        if(coins)deposited=await depositObserved(s,coins);
        if(over())throw Error('Eastbank preparation ended after deposit');
        await s.bot.closeBank();
        const deps=await sessionWalker(s),plan=deps.plan,allowed=new Set(EAST_BUYER_PATHS.flatMap(l=>[l.from,...expandPath(l.from,l.corners)].map(p=>p.x+','+p.z)));
        deps.plan=(level,from,to)=>{const path=from.x===to.x&&from.z===to.z?[to]:plan(level,from,to),tiles=[from,...expandPath(from,path)],bad=tiles.filter(p=>!allowed.has(p.x+','+p.z));
            if(level!==0||!path.length||bad.length){refused=true;console.log('SWORD_TRANSIT_REFUSED '+JSON.stringify({level,from,to,path,bad}));return[];}return path;};
        const sendWalk=deps.walk,sendLoc=deps.interactLoc;
        deps.walk=(x,z)=>refused||over()?{success:false}:sendWalk(x,z);
        deps.interactLoc=(l,op)=>refused||over()?{success:false}:sendLoc(l,op);
        for(const point of EAST_BUYER_ROUTE.slice(1)){
            const r=await walkPath(deps,[{...point,tol:0}],{maxTicks:180,stop:()=>refused||over()||s.tick()-start>=250});
            if(!r.ok||refused||over())throw Error('Eastbank preparation route incomplete');
        }
        const transitTicks=s.tick()-start,remaining=o.cap-transitTicks;if(remaining<1)throw Error('Eastbank preparation exhausted purchase budget');
        const result=await runOwnedSword(s,{itemId:SWORD,cap:remaining,maximumSpend:o.maximumSpend,stop:terminal});
        return{...result,ticks:s.tick()-start,preparation:{deposited,transitTicks}};
    }finally{off();}
}

if(import.meta.main){
    const name=process.argv[2];if(!name)throw new Error('owned sword buyer account required');let stopped=false;
    const s=await openBot(name,{onStop:async()=>{stopped=true;}}).catch(e=>finish([],false,String(e)));
    try{const run=process.env.PREPARE_EAST==='1'?runOwnedSwordFromEast:runOwnedSword;const r=await run(s,{itemId:Number(process.env.SWORD_ITEM??SWORD),cap:Number(process.env.CAP??900),maximumSpend:Number(process.env.MAX_SPEND??2500),stop:()=>stopped});console.log('OWNED_SWORD_BANK '+JSON.stringify(r));await finish([s],r.ok,Object.entries(r).map(([k,v])=>`${k}=${v}`).join(' '));}catch(e){await finish([s],false,String(e));}
}
