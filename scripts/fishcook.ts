// Fish and cook food for the gold farm (research/food-chain.md). Fly fishes trout and salmon at the Lumbridge river
// (3-tick: knife on logs + Make 1 + Lure in one tick, copied from scripts/generated/fishing30.ts), cooks them on the
// fireplace in the Lumbridge general store (3214,3249), and banks the cooked fish at Draynor (3092,3243).
// Content (rev 289): the Lumbridge castle range (cooksquestrange) needs Cook's Assistant complete
// (quest_cook.rs2:93-100); a fireplace is a cooking_fire loc (cooking_sources.loc) with no gate. Trout needs Cooking 15,
// salmon 25 (cooking_generic.dbrow). Below 15 the bot kills chickens (pen 3225-3235,3297-3300) for raw chicken
// (Cooking 1) and feathers (chicken.rs2: always 1 raw chicken; 15 feathers 1/4, 5 feathers 1/4).
// Fly fishing uses 1 feather per fish; with fewer than FEATHER_MIN feathers the bot tops up at the chickens.
// Env: TICKS (default 1500) game ticks; FEATHER_MIN (default 3); FEATHER_FILL (default 60) feathers a chicken trip
// stops at; CHICKEN_CAP (default 400) ticks per chicken trip; GIVE_TO=<account>: at each bank visit, when that
// player stands within 12 tiles, withdraw every cooked fish as notes and trade them over; HANDOFF_ONLY=1: walk to
// the bank, wait up to WAIT (default 900) ticks for GIVE_TO, hand off and stop.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, finish, countItems, randomEventsOf, serverFromEnv } from '../packages/core/src/bot';
import { sendHandoff } from './courier-handoff';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { depositObserved } from '../packages/core/src/deposit';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import { componentId } from '../packages/core/src/logout';
import type { Session } from '../packages/core/src/inprocess';

const starterCount=(s:Session,id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function starterCookingStock(s:Session){
    return {raw:starterCount(s,2138),cooked:starterCount(s,2140),burnt:starterCount(s,2144),xp:s.sdk.getSkillXp('Cooking')??0};
}

export class StarterCookingUnresolved extends Error {}

// One observed conversion. The session owner retains logout and recovery.
export async function cookStarterChicken(s:Session,stop:()=>boolean=()=>false){
    const before=starterCookingStock(s),start=s.tick();
    const fire=s.sdk.getState()?.nearbyLocs.find(l=>/^fireplace$/i.test(l.name)&&l.x===3214&&l.z===3249);
    const chicken=s.sdk.getInventory().find(i=>i.id===2138);
    let last='',dispatchReply:unknown,accepted=false,stopped=false;
    const isStopped=()=>stopped ||= stop();
    const record=(phase:string,action?:unknown)=>{
        const state=s.sdk.getState();
        const observation={phase,action,dispatchReply,loc:fire,position:state?.player,modalOpen:state?.modalOpen,modalInterface:state?.modalInterface,
            interface:state?.interface,dialog:s.sdk.getDialog(),messages:state?.gameMessages?.slice(-8),
            eventBusy:randomEventsOf(s)?.busy()??false,...starterCookingStock(s)};
        const value=JSON.stringify(observation);
        if(value!==last){last=value;console.log('STARTER_COOKING '+JSON.stringify({tick:s.tick(),...observation}));}
    };
    record('entry');
    if(isStopped())throw Error('bootstrap cooking stopped; '+last);
    if(!fire||!chicken)throw Error('bootstrap chicken/fireplace unobserved; '+last);
    const off=s.onTick(()=>record('observation'));
    // Observe the primitive reply within this owned session. The supported helper still sends the only action.
    const send=s.sdk.sendUseItemOnLoc;
    const traced:typeof send=async(...args)=>{
        // The helper can walk or dismiss UI before dispatch. Recheck at the actual send boundary.
        if(isStopped())return {success:false,message:'bootstrap cooking stopped before dispatch'};
        const reply=await send.apply(s.sdk,args);accepted ||= reply.success;dispatchReply=reply;record('dispatch',reply);return reply;
    };
    s.sdk.sendUseItemOnLoc=traced;
    try{
        // Pinned cooking.rs2: arrival delay -> refusal/event checks -> animation -> p_delay(1) -> conversion.
        // API.md and learnings/cooking.md use this supported action. Dispatch alone does not start the conversion deadline.
        let action:Awaited<ReturnType<Session['bot']['useItemOnLoc']>>|undefined,actionError:unknown;
        try{action=await s.bot.useItemOnLoc(chicken,fire);}catch(error){actionError=error;}
        record('action',action);
        isStopped();
        if(!accepted){
            if(stopped)throw Error('bootstrap cooking stopped; '+last);
            if(actionError)throw actionError;
            throw Error('bootstrap cooking action rejected: '+JSON.stringify(action)+'; '+last);
        }
        // A stop forbids further work, but cannot undo cooking.rs2's p_delay(1).
        // Keep the existing conversion bound and observe the one accepted use before returning to the owner.
        const unresolved=(why:string)=>new StarterCookingUnresolved(`bootstrap cooking settlement unresolved: ${why}; stopped=${isStopped()}; `+last);
        let observed:boolean;
        try{observed=await waitUntil(s,()=>{
            isStopped();
            const now=starterCookingStock(s),cooked=now.cooked-before.cooked,burnt=now.burnt-before.burnt;
            return now.raw<before.raw&&cooked+burnt>0&&(cooked===0||now.xp>before.xp);
        },{timeoutTicks:8});}catch(error){throw unresolved('observation failed: '+String(error));}
        record('conversion',action);
        const after=starterCookingStock(s),consumed=before.raw-after.raw,cooked=after.cooked-before.cooked,burnt=after.burnt-before.burnt,xp=after.xp-before.xp;
        if(!observed&&consumed===0)throw unresolved('conversion unobserved');
        if(consumed!==1||cooked<0||burnt<0||cooked+burnt!==consumed)throw unresolved('output mismatch');
        if(cooked>0?xp<=0:xp!==0)throw unresolved('Cooking XP unobserved or inconsistent');
        if(isStopped())throw Error('bootstrap cooking stopped after settled conversion; '+last);
        if(actionError)throw actionError;
        if(!action?.success)throw Error('bootstrap cooking action failed after settled conversion: '+JSON.stringify(action)+'; '+last);
        return {consumed,cooked,burnt,xp,ticks:s.tick()-start};
    }finally{off();if(s.sdk.sendUseItemOnLoc===traced)s.sdk.sendUseItemOnLoc=send;}
}

// Finite bootstrap only. The caller supplies raw chickens from its owned training kills.
export async function cookStarterChickens(s:Session,stop:()=>boolean=()=>false,options:{requiredFood?:number}={}){
    const initial=starterCookingStock(s),start=s.tick(),requiredFood=options.requiredFood??1;
    if(!Number.isSafeInteger(requiredFood)||requiredFood<0||requiredFood>28)throw Error('invalid starter food requirement');
    const result=()=>{const now=starterCookingStock(s);return {ok:true,raw:initial.raw,consumed:initial.raw-now.raw,
        cooked:now.cooked-initial.cooked,burnt:now.burnt-initial.burnt,xp:now.xp-initial.xp,remainingRaw:now.raw,ticks:s.tick()-start};};
    if(stop())throw Error('bootstrap cooking stopped');
    if(!initial.raw){
        if(initial.cooked>=requiredFood)return result();
        throw Error(`food acquisition: train chickens and collect raw chicken2138; cooked chicken2140 needs${requiredFood-initial.cooked}`);
    }
    const r=await walkPath(await sessionWalker(s),[{x:3092,z:3250,tol:1},{x:3089,z:3266,tol:1},{x:3100,z:3285,tol:2},
        {x:3180,z:3258,tol:2},{x:3215,z:3249,tol:1}],{maxTicks:500,stop});
    if(!r.ok)throw Error('bootstrap food route: '+r.detail);
    const boundedStop=()=>stop()||s.tick()-start>=650;
    while(starterCount(s,2138)>0&&!boundedStop()){
        if(randomEventsOf(s)?.busy()){
            if(!await waitUntil(s,()=>boundedStop()||!randomEventsOf(s)?.busy(),{timeoutTicks:12}))throw Error('bootstrap cooking event still busy; retain stock');
            if(boundedStop())break;
        }
        await cookStarterChicken(s,boundedStop);
    }
    const need=Math.max(0,requiredFood-starterCount(s,2140));
    const final={...result(),ok:!boundedStop()&&need===0};
    console.log('STARTER_COOKING_RESULT '+JSON.stringify(final));
    if(boundedStop())throw Error('bootstrap cooking stopped; '+JSON.stringify(final));
    if(need)throw Error(`food acquisition: cooked chicken2140 needs${need}; collect at least${need} raw chicken2138 (burns may require another finite batch); `+JSON.stringify(final));
    return final;
}

export function cookCourierReady(c: any, courier: string, cook: string, now: number, requireTarget = false): boolean {
    return typeof c?.name === 'string' && c.name.toLowerCase() === courier.toLowerCase() && c.server === 'rs-sdk-demo.fly.dev'
        && !c.result && Number.isFinite(c.at) && now-c.at >= 0 && now-c.at < 30000 && c.pos?.level === 0
        && Math.max(Math.abs(c.pos.x-3092),Math.abs(c.pos.z-3243)) <= 12
        && (!requireTarget || typeof c.phase === 'string' && c.phase.toLowerCase() === `collecting ${cook.toLowerCase()}`);
}

// Called while the bank is open. Fresh staged accounts hold their starter coins in the bank.
export async function fundFishingTool(s: Session, limit=25, allowSale=true): Promise<number> {
    const held = () => countItems(s, /^coins$/i);
    const before = held();
    if (before >= 5 || countItems(s, /^fly fishing rod$/i) > 0) return 0;
    const bank = s.sdk.findBankItem(/^coins$/i);
    if (bank && Number.isSafeInteger(bank.count) && bank.count > 0)
        await s.bot.withdrawItem(bank, Math.min(bank.count, limit - before));
    if (allowSale && held() < 5) for (const raw of [/^raw shrimps$/i, /^raw anchovies$/i]) {
        const fish = s.sdk.findBankItem(raw);
        if (fish && Number.isSafeInteger(fish.count) && fish.count > 0)
            await s.bot.withdrawItem(fish, fish.count, { asNote: true });
    }
    return Math.max(0, held() - before);
}
export async function buyFishingSupplies(s: Session, feathers: number): Promise<number> {
    if (countItems(s, /^fly fishing rod$/i) === 0) {
        if (countItems(s, /^coins$/i) < 5) for (const raw of [/^raw shrimps$/i, /^raw anchovies$/i])
            if (countItems(s, raw) > 0) await s.bot.sellToShop(raw, 'all');
        if (!(await s.bot.buyFromShop(/^fly fishing rod$/i, 1)).success) return 0;
    }
    const before = countItems(s, /^feather$/i);
    if (feathers > 0) await s.bot.buyFromShop(/^feather$/i, feathers);
    return Math.max(0, countItems(s, /^feather$/i) - before);
}

export type FiniteFoodProfile={target:number;netCap:number;flyCap:number;catchCap:number;noProgressTicks:number};
export function finiteFoodProfile(raw:string|undefined):FiniteFoodProfile|undefined{
 if(raw===undefined)return undefined;const target=Number(raw);
 if(!Number.isSafeInteger(target)||target<1||target>28)throw Error('FOOD_TARGET must be1..28 new banked trout/salmon');
 return {target,netCap:16,flyCap:target*2,catchCap:16+target*2,noProgressTicks:240};
}
export function finiteFoodEntryPosition(p:{worldX:number;worldZ:number;level:number}|undefined){
 return !!p&&p.level===0&&(Math.max(Math.abs(p.worldX-3092),Math.abs(p.worldZ-3243))<=4||p.worldX>=3217&&p.worldX<=3253&&p.worldZ>=3190&&p.worldZ<=3255);
}
export function finiteFoodWork(profile:FiniteFoodProfile,banked:number,packCooked:number,raw:number){
 const needed=Math.max(0,profile.target-banked-packCooked);
 return {needed,cook:needed>0&&raw>0,fish:raw<needed,done:banked===profile.target};
}
export function finiteFoodCanCatch(profile:FiniteFoodProfile,net:number,fly:number,phase:'net'|'fly'){
 // Reserve one accepted in-flight catch before movement cancels the interaction.
 return net+fly<profile.catchCap-1&&(phase==='net'?net<profile.netCap-1:fly<profile.flyCap-1);
}
type Tile = { x: number; z: number };
type Pt = [number, number, number];
const FINITE=finiteFoodProfile(process.env.FOOD_TARGET);
const TICKS = Number(process.env.TICKS ?? 1500);
if(FINITE&&(!Number.isSafeInteger(TICKS)||TICKS<1||TICKS>6000||process.env.GIVE_TO||process.env.HANDOFF_ONLY==='1'||process.env.EXTERNAL_REFILL==='1'))throw Error('finite food needs TICKS1..6000 and no handoff/external refill');
const MAX_CATCHES = Number(process.env.MAX_CATCHES ?? Number.MAX_SAFE_INTEGER);
if(!Number.isSafeInteger(MAX_CATCHES)||MAX_CATCHES<1)throw Error('MAX_CATCHES must be a positive safe integer');
const FEATHER_MIN = Number(process.env.FEATHER_MIN ?? 3);
const FEATHER_FILL = Number(process.env.FEATHER_FILL ?? 60);
const CHICKEN_CAP = Number(process.env.CHICKEN_CAP ?? 400);
const GIVE_TO = process.env.GIVE_TO?.trim() || '';
const TARGETED_COLLECTION = process.env.TARGETED_COLLECTION === '1';
const HANDOFF_ONLY = process.env.HANDOFF_ONLY === '1';
const WAIT = Number(process.env.WAIT ?? 900);
// TICK3=0: no knife-on-logs 3-tick step; the first bank visit banks the knife and logs (3 more fish per pack).
// Measured worse (practice 2026-10-23, 3 x 2,500 ticks: 36.6, 48.1, 24.0 food per 1,000 ticks against 34.2, 52.0, 39.5).
const TICK3 = !FINITE && process.env.TICK3 !== '0';
// A financed courier owns replenishment in this mode. Finish the useful batch
// instead of spending the producer's clock gathering replacement feathers.
const EXTERNAL_REFILL=process.env.EXTERNAL_REFILL==='1';

const FLY_SPOT: Tile = { x: 3239, z: 3251 };
const FIREPLACE: Tile = { x: 3214, z: 3249 };
const BANK: Tile = { x: 3092, z: 3243 };
const CHICKENS: Tile = { x: 3230, z: 3298 };
const NET_STAND: Tile = { x: 3088, z: 3227 };
const GERRANT: Tile = { x: 3014, z: 3224 };
const LOGS_AT: Tile = { x: 3089, z: 3266 };

// Fly -> fireplace stays north of z 3248 (giant spiders at 3243,3236 and 3245,3232; scripts/generated/fishing30.ts).
const TO_FIRE: Pt[] = [[3226, 3250, 2], [FIREPLACE.x + 1, FIREPLACE.z, 1]];
// Fireplace -> Draynor bank: the fishing30 route north of the jail guards (3109,3237 and 3120,3238), then the
// x 3089-3092 lane south into the bank (6+ tiles from the dark wizards at 3084,3236 and 3085,3238).
const FIRE_TO_BANK: Pt[] = [[3180, 3258, 3], [3100, 3285, 3], [3089, 3266, 2], [3092, 3250, 1], [BANK.x, BANK.z, 2]];
const FLY_TO_BANK: Pt[] = [[3226, 3250, 2], ...FIRE_TO_BANK];
const BANK_TO_FLY: Pt[] = [[3092, 3250, 1], [3089, 3266, 2], [3100, 3285, 3], [3180, 3258, 3], [3226, 3250, 2], [FLY_SPOT.x, FLY_SPOT.z, 1]];
const FIRE_TO_FLY: Pt[] = [[3226, 3250, 2], [FLY_SPOT.x, FLY_SPOT.z, 1]];
const FLY_TO_CHICKENS: Pt[] = [[3226, 3262, 2], [3232, 3285, 2], [CHICKENS.x, CHICKENS.z, 3]];
const CHICKENS_TO_FIRE: Pt[] = [[3232, 3285, 2], [3226, 3262, 2], [FIREPLACE.x + 1, FIREPLACE.z, 1]];

// Safe East lane round young dark wizards in Draynor
const EAST_LANE: Pt[] = [[3094, 3247, 1], [3095, 3236, 1], [3093, 3228, 1]];
const BANK_TO_NET: Pt[] = [[3092, 3247, 1], ...EAST_LANE, [NET_STAND.x, NET_STAND.z, 1]];
const NET_TO_BANK: Pt[] = [[3093, 3228, 1], [3095, 3236, 1], [3094, 3247, 1], [3092, 3247, 1], [BANK.x, BANK.z, 2]];
const BANK_TO_SARIM: Pt[] = [[3092, 3250, 1], [LOGS_AT.x, LOGS_AT.z, 1], [3060, 3265, 3], [3047, 3237, 3], [3029, 3217, 3], [GERRANT.x, GERRANT.z, 2]];
const SARIM_TO_BANK: Pt[] = [[3029, 3217, 3], [3047, 3237, 3], [3060, 3265, 3], [LOGS_AT.x, LOGS_AT.z, 1], [3092, 3250, 1], [BANK.x, BANK.z, 2]];

const ROD = /^fly fishing rod$/i;
const FEATHER = /^feather$/i;
const RAW_FISH = /^raw (trout|salmon)$/i;
const RAW_ANY = /^raw (trout|salmon|chicken)$/i;
const COOKED = /^(trout|salmon)$/i;
const BURNT = /^burnt (fish|chicken)$/i;
const CHICKEN = /^chicken$/i;
const LURE = /^lure$/i;
// Cooking level per raw item (cooking_generic.dbrow: trout 15, salmon 25, chicken 1).
const NEED: Record<string, number> = { 'raw trout': 15, 'raw salmon': 25, 'raw chicken': 1 };
const WHIRLPOOL = new Set([403, 404, 405, 406]);

if (import.meta.main) {
const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 3);
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const inv = () => (st()?.inventory ?? []) as any[];
    const invLen = () => inv().length;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const cook = () => s.sdk.getSkill('Cooking')?.baseLevel ?? 1;
    const fish = () => s.sdk.getSkill('Fishing')?.baseLevel ?? 1;
    const cookXp = () => s.sdk.getSkillXp('Cooking') ?? 0;
    const fishXp = () => s.sdk.getSkillXp('Fishing') ?? 0;
    const cheb = (a: Tile, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const edible = (i: any) => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text));
    const cookedInPack = () => inv().filter(i => COOKED.test(i.name) && edible(i)).reduce((n, i) => n + i.count, 0);
    const cookable = () => inv().filter(i => RAW_ANY.test(i.name) && cook() >= (NEED[i.name.toLowerCase()] ?? 99));
    const slotOf = (re: RegExp) => inv().find(i => re.test(i.name))?.slot as number | undefined;
    const t0 = s.tick();
    const now = () => s.tick() - t0;
    const stopFile = `.practice/stop-${process.argv[2]}`;
    const make1 = componentId('skill_multi3:make1_a');

    let died = false, hpMin = hp(), lastFail = '';
    const initialHp=hp(),initialLife=pos()?.lifeId,initialRespawns=pos()?.respawnCount;let finiteHurt=false,netCaught=0,flyCaught=0,lastRawNet=0,lastRawFly=0,lastCatchTick=s.tick();
    const rawIds=(ids:number[])=>inv().filter(i=>ids.includes(i.id)).reduce((n,i)=>n+i.count,0);
    lastRawNet=rawIds([317,321]);lastRawFly=rawIds([335,331]);
    let last = pos();
    const off = s.onTick(() => {
        const p = pos();
        hpMin = Math.min(hpMin, hp());
        if(FINITE){
         finiteHurt ||= hp()<initialHp||p?.isDead===true||p?.lifeId!==initialLife||p?.respawnCount!==initialRespawns;
         const net=rawIds([317,321]),fly=rawIds([335,331]);
         const a=Math.max(0,net-lastRawNet),b=Math.max(0,fly-lastRawFly);netCaught+=a;flyCaught+=b;
         if(a+b>0)lastCatchTick=s.tick();lastRawNet=net;lastRawFly=fly;
        }
        if ((s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0) > 0 && hp() <= 0) died = true;
        if (p && last && cheb({ x: last.worldX, z: last.worldZ }, p) > 20 && cheb({ x: 3222, z: 3218 }, p) <= 3) died = true;
        last = p;
    });

    let fishTicks = 0, cookTicks = 0, walkTicks = 0, bankTicks = 0, chickenTicks = 0, idleTicks = 0, giveTicks = 0;
    // noSpot: ticks in a row with no allowed fishing spot; spotWaits: times that wait was used to cook, bank or fetch feathers.
    let noSpot = 0, spotWaits = 0, reclicks = 0;
    let caught = 0, cooked = 0, burnt = 0, banked = 0, bankFish = 0, packs = 0, cycles = 0, kills = 0, feathersGot = 0, given = 0, events = 0, eats = 0;
    const cook0 = cook(), fishXp0 = fishXp();

    const end = async (ok: boolean, why: string): Promise<never> => {
        off();
        const ticks = now();
        const p = pos();
        const tries = cooked + burnt;
        const detail = (FINITE?`foodTarget=${FINITE.target} netCaught=${netCaught} flyCaught=${flyCaught} catchCap=${FINITE.catchCap} `:'')+`ticks=${ticks} caught=${caught} cooked=${cooked} burnt=${burnt} burnPct=${(100 * burnt / Math.max(1, tries)).toFixed(1)} banked=${banked} bankFish=${bankFish} given=${given} `
            + `foodPerKTicks=${(1000 * banked / Math.max(1, ticks)).toFixed(1)} cooking=${cook0}->${cook()} fishXp=${fishXp() - fishXp0} packs=${packs} cycles=${cycles} kills=${kills} feathersGot=${feathersGot} `
            + `fishTicks=${fishTicks} cookTicks=${cookTicks} walkTicks=${walkTicks} bankTicks=${bankTicks} chickenTicks=${chickenTicks} giveTicks=${giveTicks} idleTicks=${idleTicks} spotWaits=${spotWaits} reclicks=${reclicks} `
            + `events=${events} eats=${eats} feathers=${countItems(s, FEATHER)} packCooked=${cookedInPack()} hp=${hp()} hpMin=${hpMin} died=${died} at=${p?.worldX},${p?.worldZ},${p?.level}`;
        return finish([s], ok, ok ? detail : `${why} ${detail} last=${lastFail}`);
    };
    const over = () => died || !!FINITE&&finiteHurt || now() >= TICKS || existsSync(stopFile);

    const walk = async (points: Pt[]): Promise<boolean> => {
        const w0 = s.tick();
        try {
            const [gx, gz, gtol] = points[points.length - 1]!;
            let left = points.map(([x, z, tol]) => ({ x, z, tol }));
            for (let i = 0; i < 3 && !died && !(FINITE&&over()); i++) {
                const p = pos();
                if (p && cheb({ x: gx, z: gz }, p) <= gtol + 1) return true;
                const r = await walkPath(await sessionWalker(s), left, { stop: () => died||!!FINITE&&over(), ...(FINITE?{maxTicks:Math.max(1,Math.min(600,TICKS-now()))}:{}) });
                if (!r.ok) { lastFail = `walk ${r.detail}`; await waitTicks(s, 1); }
                left = left.slice(Math.min(r.next, left.length - 1));
            }
            const p = pos();
            return !died && !!p && cheb({ x: gx, z: gz }, p) <= gtol + 1;
        } finally { walkTicks += s.tick() - w0; }
    };
    const go = async (points: Pt[], where: string) => {
        // Banking may finish after the work budget. Keep the output at its handoff point.
        if (points === BANK_TO_FLY && (over()||FINITE&&banked>=FINITE.target)) return;
        if (!(await walk(points))) await end(false, `walk ${where}`);
        if(FINITE&&(points===BANK_TO_FLY||points===BANK_TO_NET))lastCatchTick=s.tick();
    };

    // Eats a cooked fish (or chicken) below HP 5. Always takes at least one tick.
    const eatIfLow = async (): Promise<boolean> => {
        if(FINITE)return false;
        if (hp() >= 5) return false;
        const f = inv().find(i => /^(trout|salmon|cooked chicken)$/i.test(i.name) && edible(i));
        if (!f) return false;
        const e0 = s.tick();
        const r = await s.bot.eatFood(f);
        if (r.success) eats++; else lastFail = `eat:${r.message}`;
        if (s.tick() === e0) await waitTicks(s, 1);
        return true;
    };

    // A river troll (fishing random event) attacks: walk 12+ tiles off until it loses its target.
    const troll = async (): Promise<boolean> => {
        const t = (st()?.nearbyNpcs ?? []).find((n: any) => /river troll/i.test(n.name) && n.distance <= 10);
        if (!t) return false;
        events++;
        await eatIfLow();
        await walk([[FLY_SPOT.x - 14, FLY_SPOT.z + 8, 2]]);
        await waitTicks(s, 3);
        return true;
    };

    // Cooks every raw item the level allows on the fireplace. One use per tick (cooking.rs2 p_delay(1); the raw item
    // is deleted after the delay), level-up pages closed in the same tick (research/supply-floors.md).
    const cookAll = async () => {
        if (cookable().length === 0) return;
        await go(TO_FIRE, 'to fireplace');
        const c0 = s.tick();
        try {
            // Observe depletion before the next use. Explicit fast mode remains a timing control.
            const waitMode = (process.env.COOK_MODE ?? 'wait') === 'wait';
            let stall = 0;
            const raw0 = countItems(s, RAW_ANY), burnt0 = countItems(s, BURNT);
            let rawPrev = raw0;
            while (cookable().length > 0 && stall < 12 && !died && !(FINITE&&over()) && (!FINITE||finiteFoodWork(FINITE,banked,cookedInPack(),countItems(s,RAW_FISH)).cook)) {
                if (randomEventsOf(s)?.busy()) { await waitTicks(s, 1); continue; }
                const fire = (st()?.nearbyLocs ?? []).find((l: any) => /^fireplace$/i.test(l.name) && l.x === FIREPLACE.x && l.z === FIREPLACE.z) as any;
                if (!fire) { lastFail = 'no fireplace'; stall++; await waitTicks(s, 1); continue; }
                // The best item the level allows first (salmon, trout, then chicken).
                const items = cookable().sort((a, b) => (NEED[b.name.toLowerCase()] ?? 0) - (NEED[a.name.toLowerCase()] ?? 0));
                const item = items[0]!;
                if (s.sdk.getDialog()?.isOpen || st()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                await s.direct({ type: 'useItemOnLoc', itemSlot: item.slot, x: fire.x, z: fire.z, locId: fire.id, reason: 'SDK' });
                if (waitMode) { for (let i = 0; i < 5 && countItems(s, RAW_ANY) >= rawPrev && !died; i++) await waitTicks(s, 1); }
                else await waitTicks(s, 1);
                const raw = countItems(s, RAW_ANY);
                if (raw < rawPrev) stall = 0; else stall++;
                rawPrev = raw;
            }
            if (stall >= 12) {if(FINITE)await end(false,'finite cooking no progress');console.log(`WARN cooking stalled: ${lastFail}`);}
            // Burnt items have their own names; every other raw item that went is a success.
            const b = countItems(s, BURNT) - burnt0;
            burnt += b;
            cooked += raw0 - countItems(s, RAW_ANY) - b;
        } finally { cookTicks += s.tick() - c0; }
        console.log(`COOK cooked=${cooked} burnt=${burnt} cooking=${cook()} t=${now()}`);
    };

    // Kills chickens until the pack holds `feathers` feathers and `raw` raw chickens, or CHICKEN_CAP ticks pass.
    const chickenTrip = async (feathers: number, raw: number) => {
        await go(FLY_TO_CHICKENS, 'to chickens');
        const k0 = s.tick();
        const f0 = countItems(s, FEATHER);
        try {
            while (!over() && s.tick() - k0 < CHICKEN_CAP && (countItems(s, FEATHER) < feathers || countItems(s, /^raw chicken$/i) < raw)) {
                if (randomEventsOf(s)?.busy()) { await waitTicks(s, 1); continue; }
                if (await eatIfLow()) continue;
                const wantRaw = countItems(s, /^raw chicken$/i) < raw && invLen() < 28;
                const loot = (st()?.groundItems ?? []).filter((g: any) => g.distance <= 8 && g.reachable !== false
                    && (FEATHER.test(g.name) || (wantRaw && /^raw chicken$/i.test(g.name))))
                    .sort((a: any, b: any) => a.distance - b.distance)[0] as any;
                if (loot && (FEATHER.test(loot.name) ? true : invLen() < 28)) {
                    const n0 = countItems(s, new RegExp(`^${loot.name}$`, 'i'));
                    await s.direct({ type: 'pickupItem', x: loot.x, z: loot.z, itemId: loot.id, reason: 'SDK' });
                    await waitUntil(s, () => countItems(s, new RegExp(`^${loot.name}$`, 'i')) > n0, { timeoutTicks: Math.min(12, loot.distance + 3) });
                    continue;
                }
                const me = pos();
                const c = (st()?.nearbyNpcs ?? []).filter((n: any) => CHICKEN.test(n.name) && n.reachable !== false && (n.hp ?? 1) > 0
                    && me && Math.max(Math.abs(n.x - CHICKENS.x), Math.abs(n.z - CHICKENS.z)) <= 10)
                    .sort((a: any, b: any) => a.distance - b.distance)[0] as any;
                if (!c) { idleTicks++; await waitTicks(s, 1); continue; }
                const op = c.optionsWithIndex?.find((o: any) => /^attack$/i.test(o.text))?.opIndex;
                if (op === undefined) { await waitTicks(s, 1); continue; }
                await s.direct({ type: 'interactNpc', npcIndex: c.index, optionIndex: op, reason: 'SDK' });
                // Fight until the chicken is gone (dead) or 20 ticks pass.
                const gone = await waitUntil(s, x => !(x?.nearbyNpcs ?? []).some((n: any) => n.index === c.index && (n.hp ?? 1) > 0), { timeoutTicks: 20 });
                if (gone) { kills++; await waitTicks(s, 1); }
            }
        } finally {
            chickenTicks += s.tick() - k0;
            feathersGot += Math.max(0, countItems(s, FEATHER) - f0);
            console.log(`CHICKENS kills=${kills} feathers=${countItems(s, FEATHER)} raw=${countItems(s, /^raw chicken$/i)} t=${now()}`);
        }
        // Raw chicken is cooked at once (it trains Cooking to 15 for trout).
        if (cookable().length) { await go(CHICKENS_TO_FIRE, 'chickens to fireplace'); await cookAll(); }
    };

    // Draynor bank: deposit cooked and burnt food and raw chicken; hand the cooked fish to GIVE_TO when it is here.
    const bankTrip = async () => {
        await go(FIRE_TO_BANK, 'to Draynor bank');
        const b0 = s.tick();
        try {
            const o = await s.bot.openBank();
            if (!o.success) {if(FINITE)await end(false,'finite bank open failed'); lastFail = `bank:${o.message}`; await waitTicks(s, 1); return; }
            // Raw fish the level cannot cook yet (salmon below 25) goes in too, or it would fill the pack for good.
            // One deposit-all per item name (a second call on a name already gone waits for its timeout: 614 bank
            // ticks in the first practice run).
            // Deposit every item that is not needed for fly fishing (raw/cooked fish, burnt fish, starter shrimps/bread, etc.)
            const finiteDeposit=FINITE?{food:cookedInPack(),banked}:null;
            const KEEP = TICK3 ? /^(fly fishing rod|feather|coins|knife|logs)$/i : /^(fly fishing rod|feather|coins)$/i;
            const toDeposit = [...new Set(inv().filter(i => !KEEP.test(i.name)).map(i => i.name as string))];
            for (const name of toDeposit) {
                const re = new RegExp(`^${name}$`, 'i');
                const before = countItems(s, re);
                if (before === 0) continue;
                if (COOKED.test(name)) {
                    const ids = [...new Set(inv().filter(i => re.test(i.name)).map(i => i.id))];
                    for (const id of ids) banked += await depositObserved(s, { id, name });
                } else {
                    const d = await s.bot.depositItem(re, -1);
                    if (!d.success) lastFail = `deposit ${name}:${d.message}`;
                }
            }
            if(finiteDeposit&&(cookedInPack()!==0||banked-finiteDeposit.banked!==finiteDeposit.food))await end(false,'finite cooked deposit unresolved');
            bankFish = ['Trout', 'Salmon'].reduce((n, name) => n + (s.sdk.findBankItem(new RegExp(`^${name}$`, 'i'))?.count ?? 0), 0);
            packs++;
            console.log(`BANK pack=${packs} banked=${banked} bankFish=${bankFish} t=${now()}`);

            // Top up feathers from bank if available
            const fInBank = s.sdk.findBankItem(FEATHER);
            if (!FINITE && fInBank && fInBank.count > 0 && countItems(s, FEATHER) < 100) {
                await s.bot.withdrawItem(fInBank, fInBank.count);
            }
            await s.bot.closeBank();
        } finally { bankTicks += s.tick() - b0; }
        if (GIVE_TO) await handOff(0);

        // If feathers are critically low after bank visit, top up from Gerrant shop!
        if (countItems(s, FEATHER) < 50) {
            await restockFeathersFromShop();
        }
    };

    // Restocks feathers in bulk (1,000 feathers for 2,000 gp) from Gerrant's shop at Port Sarim
    const restockFeathersFromShop = async () => {
        if (over()||EXTERNAL_REFILL||FINITE) return;
        console.log(`MILESTONE restocking feathers from Gerrant's shop (Port Sarim)...`);
        const p = pos();
        if (!p || cheb(BANK, p) > 4) {
            await go(FIRE_TO_BANK, 'to Draynor bank');
        }
        if (countItems(s, /^coins$/i) < 200) {
            const o = await s.bot.openBank();
            if (o.success) {
                const coinsBank = s.sdk.findBankItem(/^coins$/i);
                if (coinsBank && coinsBank.count > 0) {
                    await s.bot.withdrawItem(coinsBank, Math.min(2000, coinsBank.count));
                }
                await fundFishingTool(s,FINITE?5:25,!FINITE);
                await s.bot.closeBank();
            }
        }
        if (countItems(s, /^coins$/i) < 10 && countItems(s, /^raw (shrimps|anchovies)$/i) === 0) {
            console.log(`WARN no coins to buy feathers; falling back to chickens`);
            await chickenTrip(FEATHER_FILL, 0);
            // Like the shop branch, refill ends at the bank. The final bank
            // checkpoint has no later fishing leg to bring us home.
            await go(CHICKENS_TO_FIRE, 'from chicken refill to fireplace');
            await go(FIRE_TO_BANK, 'from chicken refill to Draynor bank');
            return;
        }
        await go(BANK_TO_SARIM, 'to Gerrant at Port Sarim');
        const sh = await s.bot.openShop(/^gerrant$/i);
        if (sh.success) {
            const f0 = countItems(s, FEATHER);
            await buyFishingSupplies(s, 1000);
            await s.bot.closeShop();
            const bought = countItems(s, FEATHER) - f0;
            feathersGot += bought;
            console.log(`MILESTONE bought ${bought} feathers from Gerrant! Total held: ${countItems(s, FEATHER)}`);
        } else {
            lastFail = `openShop: ${sh.message}`;
        }
        await go(SARIM_TO_BANK, 'back to Draynor bank');
    };

    // Trains Fishing from 1 to 20 with small fishing net at Draynor coast
    const trainNetFishing = async () => {
        console.log(`MILESTONE Training Fishing from ${fish()} to 20 with Small fishing net at Draynor coast...`);
        const p = pos();
        if (!p || cheb(BANK, p) > 4) {
            await go(FLY_TO_BANK, 'to Draynor bank');
        }
        let o = await s.bot.openBank();
        if(FINITE&&!o.success)await end(false,'finite net bank unavailable');
        if (o.success) {
            for (const it of inv().filter(i => /^(fly fishing rod|raw chicken|cooked chicken|burnt chicken|trout|salmon|burnt fish)$/i.test(i.name))) {
                await s.bot.depositItem(new RegExp(`^${it.name}$`, 'i'), -1);
            }
            if (countItems(s, /^small fishing net$/i) === 0) {
                const netInBank = s.sdk.findBankItem(/^small fishing net$/i);
                if (netInBank) {
                    await s.bot.withdrawItem(netInBank, 1);
                }
            }
            await s.bot.closeBank();
        }
        if(FINITE&&countItems(s,/^small fishing net$/i)===0)await end(false,'finite food requires owned small fishing net');
        if (countItems(s, /^small fishing net$/i) === 0) {
            console.log(`Buying small fishing net at Port Sarim...`);
            await go(BANK_TO_SARIM, 'to Gerrant');
            const sh = await s.bot.openShop(/^gerrant$/i);
            if(FINITE&&!sh.success)await end(false,'finite rod shop unavailable');
            if (sh.success) {
                await s.bot.buyFromShop(/^small fishing net$/i, 1);
                await s.bot.closeShop();
            }
            await go(SARIM_TO_BANK, 'back to Draynor');
        }
        if (countItems(s, /^small fishing net$/i) === 0) {
            await end(false, 'no small fishing net');
        }

        let stall = 0;
        while (!over() && fish() < 20 && (!FINITE||finiteFoodCanCatch(FINITE,netCaught,flyCaught,'net'))) {
            if(FINITE&&s.tick()-lastCatchTick>FINITE.noProgressTicks)await end(false,'finite net no progress');
            if (randomEventsOf(s)?.busy()) { await waitTicks(s, 1); continue; }
            if (await eatIfLow()) continue;
            if (s.sdk.getDialog()?.isOpen || st()?.interface?.isOpen) {
                await s.direct({ type: 'closeModal', reason: 'SDK' });
            }

            if (invLen() >= 28) {
                await go(NET_TO_BANK, 'to Draynor bank');
                const ob = await s.bot.openBank();
                if(FINITE&&!ob.success)await end(false,'finite net deposit bank unavailable');
                if (ob.success) {
                    for (const name of ['Raw shrimps', 'Raw anchovies']) {
                        const cnt = countItems(s, new RegExp(`^${name}$`, 'i'));
                        if (cnt > 0) await s.bot.depositItem(new RegExp(`^${name}$`, 'i'), -1);
                    }
                    await s.bot.closeBank();
                }
                if (fish() >= 20) break;
                await go(BANK_TO_NET, 'to Draynor net spot');
                continue;
            }

            const curPos = pos();
            if (!curPos || cheb(NET_STAND, curPos) > 4) {
                await go(BANK_TO_NET, 'to Draynor net spot');
            }

            const wiz = (st()?.nearbyNpcs ?? []).some((n: any) => /dark wizard/i.test(n.name) && n.distance <= 4);
            if (wiz) {
                lastFail = 'dark wizard near net spot';
                await walk([[3093, 3228, 1]]);
                await waitTicks(s, 3);
                continue;
            }

            const sp = (st()?.nearbyNpcs ?? []).filter((n: any) =>
                /fishing spot/i.test(n.name) &&
                !WHIRLPOOL.has(n.id) &&
                n.z <= 3228 &&
                n.optionsWithIndex?.some((o: any) => /^net$/i.test(o.text))
            ).sort((a: any, b: any) => a.distance - b.distance)[0] as any;

            if (!sp) {
                stall++;
                if (stall % 5 === 0) await walk([[NET_STAND.x, NET_STAND.z, 1]]);
                await waitTicks(s, 1);
                continue;
            }
            stall = 0;

            const netOp = sp.optionsWithIndex.find((o: any) => /^net$/i.test(o.text))?.opIndex ?? 1;
            const invBefore = invLen();
            await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: netOp, reason: 'SDK' });

            for (let t = 0; t < 12 && !over() && fish() < 20; t++) {
                await waitTicks(s, 1);
                if (s.sdk.getDialog()?.isOpen || st()?.interface?.isOpen) {
                    await s.direct({ type: 'closeModal', reason: 'SDK' });
                    break;
                }
                if (invLen() > invBefore || invLen() >= 28) break;
                if (!(st()?.nearbyNpcs ?? []).some((n: any) => n.index === sp.index)) break;
            }
        }

        if(FINITE&&fish()<20)await end(false,'finite net bootstrap budget/stop');
        console.log(`MILESTONE Fishing reached ${fish()}! Transitioning to fly fishing...`);
        await go(NET_TO_BANK, 'to Draynor bank');
        o = await s.bot.openBank();
        if(FINITE&&!o.success)await end(false,'finite bank unavailable');
        if (o.success) {
            await s.bot.depositItem(/^small fishing net$/i, 1);
            for (const name of ['Raw shrimps', 'Raw anchovies']) {
                if (countItems(s, new RegExp(`^${name}$`, 'i')) > 0) {
                    await s.bot.depositItem(new RegExp(`^${name}$`, 'i'), -1);
                }
            }
            const rodItem = s.sdk.findBankItem(ROD);
            if (rodItem) await s.bot.withdrawItem(rodItem, 1);
            const fItem = s.sdk.findBankItem(FEATHER);
            if (!FINITE&&fItem) await s.bot.withdrawItem(fItem, fItem.count);
            await fundFishingTool(s,FINITE?5:25,!FINITE);
            await s.bot.closeBank();
        }
        if (countItems(s, FEATHER) < 200) {
            await restockFeathersFromShop();
        }
    };

    // Withdraws every cooked fish as notes and trades them to GIVE_TO. waitTicks > 0 waits for the player to arrive.
    const readCourierStatus = () => {
        if (!/^[A-Za-z0-9_ -]{1,12}$/.test(GIVE_TO)) return undefined;
        try { return JSON.parse(readFileSync(join(resolve(import.meta.dir, '..'), '.practice', 'status', `${GIVE_TO}.json`), 'utf8')); }
        catch { return undefined; }
    };
    const handOff = async (waitFor: number) => {
        const who = new RegExp(`^${GIVE_TO.replace(/[^a-zA-Z0-9 _-]/g, '')}$`, 'i');
        const near = () => (!TARGETED_COLLECTION || cookCourierReady(readCourierStatus(), GIVE_TO, s.name, Date.now(), true))
            && (st()?.nearbyPlayers ?? []).some((p: any) => who.test(p.name) && p.distance <= 12);
        const g0 = s.tick();
        try {
            if (!near() && waitFor > 0) await waitUntil(s, () => near() || existsSync(stopFile), { timeoutTicks: waitFor });
            if (!near()) return;
            const o = await s.bot.openBank();
            if (!o.success) { lastFail = `bank:${o.message}`; return; }
            for (const name of ['Trout', 'Salmon']) {
                const b = s.sdk.findBankItem(new RegExp(`^${name}$`, 'i'));
                if (b && b.count > 0) {
                    const w = await s.bot.withdrawItem(b, b.count, { asNote: true });
                    if (!w.success) lastFail = `withdraw note ${name}:${w.message}`;
                }
            }
            await s.bot.closeBank();
            const notes = inv().filter(i => COOKED.test(i.name) && !edible(i));
            const n = notes.reduce((a, i) => a + i.count, 0);
            if (n === 0) { lastFail = 'no notes to give'; return; }
            const server = serverFromEnv(readFileSync(join(import.meta.dir,'../vendor/rs-sdk/bots',s.name,'bot.env'),'utf8'));
            const delivered = await sendHandoff(s,GIVE_TO,server,notes.map(i=>({id:i.id,count:i.count})),
                () => s.bot.trade(who, { give: notes.map(i => ({ item: new RegExp(`^${i.name}$`, 'i'), amount: i.count })), timeout: 60_000, retryOnBusy: false }));
            given += delivered;
            console.log(`MILESTONE gave ${delivered} verified food t=${now()}`);
        } finally { giveTicks += s.tick() - g0; }
    };

    console.log(`FISHCOOK ticks=${TICKS} cooking=${cook()} fishing=${s.sdk.getSkill('Fishing')?.baseLevel} feathers=${countItems(s, FEATHER)} rod=${slotOf(ROD) !== undefined} giveTo=${GIVE_TO || '-'} handoffOnly=${HANDOFF_ONLY}`);
    if (HANDOFF_ONLY) {
        if (!GIVE_TO) await end(false, 'HANDOFF_ONLY needs GIVE_TO');
        const p = pos();
        if (p && cheb(BANK, p) > 4) await go(FIRE_TO_BANK, 'to Draynor bank');
        await handOff(WAIT);
        await end(given > 0, 'no hand-off');
    }

    if(FINITE){
     const p=pos();if(!finiteFoodEntryPosition(p)||!p||!Number.isSafeInteger(p.combatLevel)||p.combatLevel<29||!Number.isSafeInteger(initialLife)||!Number.isSafeInteger(initialRespawns)||initialHp<27||hp()!==(s.sdk.getSkill('Hitpoints')?.baseLevel??0)||cook()<25)await end(false,'finite food needs audited Draynor/Lumbridge combat29 fullHP27 Cooking25 entry');
     if(inv().some(i=>[317,318,321,322,335,336,331,332,333,334,329,330,379,380].includes(i.id)))await end(false,'finite food requires clean raw/cooked entry pack');
     if(cheb(BANK,p)>4)await go(FLY_TO_BANK,'finite Lumbridge entry to Draynor bank');
     if(!(await s.bot.openBank()).success)await end(false,'finite food entry bank unavailable');
     const f=s.sdk.findBankItem(FEATHER),held=countItems(s,FEATHER);
     if(held+(f?.count??0)<FINITE.flyCap)await end(false,'finite food missing owned feather budget');
     if(held>FINITE.flyCap)await s.bot.depositItem(FEATHER,held-FINITE.flyCap);
     if(held<FINITE.flyCap)await s.bot.withdrawItem(FEATHER,FINITE.flyCap-held);
     if(countItems(s,FEATHER)!==FINITE.flyCap)await end(false,'finite feather withdrawal unobserved');
     if(!countItems(s,ROD)&&!s.sdk.findBankItem(ROD)&&countItems(s,/^coins$/i)+(s.sdk.findBankItem(/^coins$/i)?.count??0)<5)await end(false,'finite food missing5 coins for rod');
     if(fish()<20&&!countItems(s,/^small fishing net$/i)&&!s.sdk.findBankItem(/^small fishing net$/i))await end(false,'finite food requires owned small fishing net');
     await s.bot.closeBank();lastCatchTick=s.tick();
    }

    if(EXTERNAL_REFILL&&(fish()<20||cook()<25))await end(false,'external refill requires Fishing20 and Cooking25');

    if (fish() < 20) {
        await trainNetFishing();
    }

    if (slotOf(ROD) === undefined) {
        const o = await s.bot.openBank();
        if(FINITE&&!o.success)await end(false,'finite bank unavailable');
        if (o.success) {
            await s.bot.withdrawItem(ROD, 1);
            await fundFishingTool(s,FINITE?5:25,!FINITE);
            await s.bot.closeBank();
        }
        if (slotOf(ROD) === undefined && (countItems(s, /^coins$/i) >= 5 || countItems(s, /^raw (shrimps|anchovies)$/i) > 0)) {
            console.log('MILESTONE buying fly fishing rod at Port Sarim');
            await go(BANK_TO_SARIM, 'to Gerrant');
            const sh = await s.bot.openShop(/^gerrant$/i);
            if(FINITE&&!sh.success)await end(false,'finite rod shop unavailable');
            if (sh.success) {
                await buyFishingSupplies(s, FINITE?0:Math.max(0, 200 - countItems(s, FEATHER)));
                if(FINITE&&countItems(s,ROD)!==1)await end(false,'finite rod purchase unobserved');
                await s.bot.closeShop();
            }
            await go(SARIM_TO_BANK, 'back to Draynor');
        }
    }
    if (slotOf(ROD) === undefined) await end(false, 'no fly fishing rod');

    const KEEP_FLY = TICK3 ? /^(fly fishing rod|feather|coins|knife|logs)$/i : /^(fly fishing rod|feather|coins)$/i;
    if (inv().some(i => !KEEP_FLY.test(i.name) && !RAW_FISH.test(i.name))) {
        console.log('MILESTONE cleaning up unneeded starter/junk items at Draynor bank');
        const p = pos();
        if (p && cheb(BANK, p) > 4) await go(FIRE_TO_BANK, 'to Draynor bank for cleanup');
        const o = await s.bot.openBank();
        if(FINITE&&!o.success)await end(false,'finite bank unavailable');
        if (o.success) {
            for (const item of [...new Set(inv().filter(i => !KEEP_FLY.test(i.name)).map(i => i.name as string))]) {
                await s.bot.depositItem(new RegExp(`^${item}$`, 'i'), -1);
            }
            await s.bot.closeBank();
        }
        if(!FINITE)await go(BANK_TO_FLY, 'back to Lumbridge river');
    }

    if(FINITE)await go(BANK_TO_FLY,'finite initial safe river route');
    let chain: { index: number } | null = null;
    let stillAnim = 0;
    // The courier waits at Draynor bank (its fresh status file says so): hand over now, not at the next full pack
    // (2026-10-24 live: the courier waited there while the cook had 186 fish banked and three farmers waited for food).
    let lastCourierTrip = -1e9;
    const courierWaiting = () => {
        if (!GIVE_TO || s.tick() - lastCourierTrip < 600) return false;
        return cookCourierReady(readCourierStatus(), GIVE_TO, s.name, Date.now(), TARGETED_COLLECTION);
    };
    while (!over() && caught < MAX_CATCHES && (!FINITE||!finiteFoodWork(FINITE,banked,cookedInPack(),countItems(s,RAW_FISH)).done)) {
        if(FINITE){
         if(s.tick()-lastCatchTick>FINITE.noProgressTicks)await end(false,'finite fly no progress');
         const work=finiteFoodWork(FINITE,banked,cookedInPack(),countItems(s,RAW_FISH));
         if(!work.fish||!finiteFoodCanCatch(FINITE,netCaught,flyCaught,'fly')){
          await cookAll();await bankTrip();lastCatchTick=s.tick();
          if(banked===FINITE.target)break;
          if(!finiteFoodCanCatch(FINITE,netCaught,flyCaught,'fly'))break;
          await go(BANK_TO_FLY,'finite refill trip');chain=null;lastCatchTick=s.tick();continue;
         }
        }
        if (randomEventsOf(s)?.busy()) { idleTicks++; await waitTicks(s, 1); continue; }
        if (await eatIfLow()) continue;
        if (await troll()) continue;
        if (courierWaiting()) {
            lastCourierTrip = s.tick();
            console.log(`MILESTONE courier waiting at Draynor t=${now()}`);
            await cookAll(); await bankTrip(); await handOff(150);
            await go(BANK_TO_FLY, 'back to the river'); chain = null;
            continue;
        }
        const feathers = countItems(s, FEATHER);
        // Cooking below 15 with nothing cookable: raw chicken first (each success is 750 XP at 25x; 15 = 2,411 XP).
        if (cook() < 15 && cookable().length === 0 && invLen() <= 20) {
            await chickenTrip(Math.max(feathers, FEATHER_MIN), 8);
            await go(FIRE_TO_FLY, 'back to the river');
            continue;
        }
        if (feathers < (FINITE?1:FEATHER_MIN)) {
            if (countItems(s, RAW_FISH) > 0 || cookedInPack() > 0) { await cookAll(); await bankTrip(); await go(BANK_TO_FLY, 'back to the river'); continue; }
            if(EXTERNAL_REFILL||FINITE)break;
            await restockFeathersFromShop();
            await go(BANK_TO_FLY, 'back to the river');
            continue;
        }
        if (invLen() >= 28) {
            await cookAll();
            await bankTrip();
            await go(BANK_TO_FLY, 'back to the river');
            chain = null;
            continue;
        }
        // Fly fishing. Spots south of z 3248 sit on the spider bank (fishing30.ts).
        const f0 = s.tick();
        const raw0 = countItems(s, RAW_FISH);
        const sp = (st()?.nearbyNpcs ?? []).filter((n: any) => /fishing spot/i.test(n.name) && !WHIRLPOOL.has(n.id) && n.z >= 3248
            && n.optionsWithIndex?.some((o: any) => LURE.test(o.text))).sort((a: any, b: any) => a.distance - b.distance)[0] as any;
        if (!sp) {
            const p = pos();
            if (!p || cheb(FLY_SPOT, p) > 3) await walk([[FLY_SPOT.x, FLY_SPOT.z, 1]]);
            else if (++noSpot > 5 && countItems(s, RAW_FISH) > 0) {
                noSpot = 0; spotWaits++;
                await cookAll(); await bankTrip(); await go(BANK_TO_FLY, 'back to the river'); chain = null;
                continue;
            } else if (noSpot > 5 && invLen() <= 18) {
                noSpot = 0; spotWaits++;
                if (feathers < 50) {
                    await restockFeathersFromShop();
                } else {
                    idleTicks++; await waitTicks(s, 2);
                }
                chain = null;
                continue;
            } else { idleTicks++; await waitTicks(s, 1); }
            fishTicks += s.tick() - f0;
            continue;
        }
        noSpot = 0;
        const lure = sp.optionsWithIndex.find((o: any) => LURE.test(o.text)).opIndex;
        if (sp.distance > 1) {
            await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: lure, reason: 'SDK' });
            await waitUntil(s, () => ((st()?.nearbyNpcs ?? []).find((n: any) => n.index === sp.index)?.distance ?? 99) <= 1, { timeoutTicks: 10 });
            chain = { index: sp.index };
        } else {
            const knife = slotOf(/^knife$/i), log = slotOf(/^logs$/i);
            if (s.sdk.getDialog()?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
            if (TICK3 && knife !== undefined && log !== undefined) {
                await s.direct({ type: 'useItemOnItem', sourceSlot: knife, targetSlot: log, reason: 'SDK' });
                await s.direct({ type: 'clickComponent', componentId: make1, reason: 'SDK' });
                await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: lure, reason: 'SDK' });
                cycles++;
                await waitTicks(s, 3);
            } else {
                // No knife or logs: click the spot once, and again when the player stops fishing (2 ticks with no
                // animation). A level-up dialog stops fishing; before this check the bot stood 317 ticks next to a
                // spot that did not move (practice 2026-10-23; live Mightyrod 456 ticks at 3239,3254).
                stillAnim = (pos()?.animId ?? -1) === -1 ? stillAnim + 1 : 0;
                if (chain?.index !== sp.index || stillAnim >= 2) {
                    await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: lure, reason: 'SDK' });
                    chain = { index: sp.index }; stillAnim = 0; reclicks++;
                }
                await waitTicks(s, 1);
            }
        }
        caught += Math.max(0, countItems(s, RAW_FISH) - raw0);
        fishTicks += s.tick() - f0;
    }
    if(FINITE&&banked===FINITE.target)await end(!over()&&netCaught<=FINITE.netCap&&flyCaught<=FINITE.flyCap&&netCaught+flyCaught<=FINITE.catchCap&&!!pos()&&cheb(BANK,pos()!)<=4,'finite exact food output');
    if (died) await end(false, 'died');
    if(FINITE&&over())await end(false,finiteHurt?'finite damage/death guard':'finite tick/stop budget');
    if (existsSync(stopFile)) await end(false, 'stopped');
    // Moving ends the fishing interaction. Include a catch already queued at the work limit.
    if (cookable().length > 0 || chain !== null) {
        const rawAtLimit = countItems(s, RAW_FISH);
        await go(TO_FIRE, 'final cooking checkpoint');
        caught += Math.max(0, countItems(s, RAW_FISH) - rawAtLimit);
        await cookAll();
    }
    await bankTrip();
    if(FINITE)await end(banked===FINITE.target&&netCaught<=FINITE.netCap&&flyCaught<=FINITE.flyCap&&netCaught+flyCaught<=FINITE.catchCap,'finite food target/catch budget');
    await end(true, 'ticks');
} catch (e) { await finish([s], false, String(e)); }
}
