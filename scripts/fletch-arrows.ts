import {readFileSync} from 'node:fs';
import {BotActions} from '../vendor/rs-sdk/sdk/actions';
import {productionStopRequested} from './microbot-c-lifetime';
// Fletching worker: bounded headless-arrow processing; other modes retain the legacy behavior.
// Operates with zero travel at bank or staged buffer.
// Usage: bun scripts/fletch-arrows.ts <bot> [CAP ticks, default 15000] [MODE: arrows | headless | steel | shafts | bows] [TIP_TYPE: rune | adamant | mithril | steel]
// Headless env: MAX_MAKE=390 (multiple15), SHAFT_RESERVE>=100 (default200), FEATHER_RESERVE>=100.
// Steel env: MAX_MAKE=15 (multiple15), HEADLESS_RESERVE=200, TIP_RESERVE=5, OUTPUT_RESERVE=0 (final bank floor).
// Shafts env: MAX_MAKE=25 logs (1..25), LOG_RESERVE=0; BANK_KNIFE=1 also restores the gathering kit.
// Root must stage owned inputs and clear recovery gates before live admission. DEMO_OK=1 permits live.
import { openBot, finish, countItems } from "../packages/core/src/bot";
import type { Session } from "../packages/core/src/inprocess";
import { waitTicks, waitUntil } from "../packages/core/src/ticks";
import { depositPack } from "../packages/core/src/deposit";
import { depositObserved } from "../packages/core/src/deposit";
import {runShafts} from "./fletch-shafts";

export interface HeadlessOptions { cap: number; maximum: number; shaftReserve: number; featherReserve: number; stop?: () => boolean }
const SHAFT = 52, HEADLESS = 53, FEATHER = 314;
const MATERIALS = new Set([SHAFT, HEADLESS, FEATHER]);
export function planHeadless(shafts: number, feathers: number, maximum = 390, shaftReserve = 200, featherReserve = 100): number {
    return Math.max(0, Math.floor(Math.min(maximum, shafts - shaftReserve, feathers - featherReserve) / 15) * 15);
}

export async function runHeadless(s: Session, options: HeadlessOptions) {
    for (const [name, value] of Object.entries({ cap: options.cap, maximum: options.maximum, shaftReserve: options.shaftReserve, featherReserve: options.featherReserve }))
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid headless ${name}`);
    if (options.cap <= 0 || options.maximum <= 0 || options.maximum % 15 || options.shaftReserve < 100 || options.featherReserve < 100)
        throw new Error('headless needs positive CAP, MAX_MAKE multiple15, SHAFT_RESERVE>=100 and FEATHER_RESERVE>=100');
    const synced = await waitUntil(s, () => (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0 && (s.sdk.getSkill('Fletching')?.baseLevel ?? 0) > 0, { timeoutTicks: 15 });
    if (!synced) throw new Error('headless skill sync failed');
    const inv = () => s.sdk.getInventory();
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const xp = () => s.sdk.getSkillXp('Fletching') ?? 0;
    const initialXp = xp(), start = s.tick(), player = s.sdk.getState()?.player;
    let ended = false, died = false, hpMin = s.sdk.getSkill('Hitpoints')!.level;
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        hpMin = Math.min(hpMin, s.sdk.getSkill('Hitpoints')?.level ?? hpMin);
        if (p?.isDead || hpMin <= 0 || (p?.respawnCount ?? 0) > (player?.respawnCount ?? 0) || (player?.lifeId !== undefined && p?.lifeId !== player.lifeId)) died = true;
    });
    const over = () => ended || died || options.stop?.() || s.tick() - start >= options.cap;
    const protectedItems = new Map<number, number>();
    for (const item of inv()) if (!MATERIALS.has(item.id)) protectedItems.set(item.id, (protectedItems.get(item.id) ?? 0) + item.count);
    let made = 0, banked = 0, actions = 0, bankTrips = 0, planned = 0, originalOutput: number | undefined;
    let stop = 'input-insufficient', failure = '';
    let bankSnapshot: { id: number; count: number }[] | undefined;
    const open = async () => {
        if (!s.sdk.getState()?.bank?.isOpen) {
            const result = await s.bot.openBank();
            if (!result.success) throw new Error(`headless bank: ${result.message}`);
            bankTrips++;
            await waitTicks(s, 1);
        }
        if (!s.sdk.getState()?.bank?.isOpen) throw new Error('headless bank state not observed');
    };
    const deposit = async () => {
        // Refresh each slot after every deposit. One deposit per actual item ID, even for many slots.
        for (const id of new Set(inv().filter(i => MATERIALS.has(i.id)).map(i => i.id))) {
            const item = inv().find(i => i.id === id)!;
            await s.bot.depositItem(item, -1);
            if (held(id) > 0) throw new Error(`headless deposit incomplete: ${item.name}`);
        }
        await waitTicks(s, 1);
        bankSnapshot = (s.sdk.getState()?.bank?.items ?? []).map(i => ({ id: i.id, count: i.count }));
    };
    const bankCount = (id: number) => bankSnapshot?.filter(i => i.id === id).reduce((n, i) => n + i.count, 0) ?? 0;
    try {
        await open();
        await deposit();
        originalOutput = bankCount(HEADLESS);
        planned = planHeadless(bankCount(SHAFT), bankCount(FEATHER), options.maximum, options.shaftReserve, options.featherReserve);
        if (planned > 0 && !over()) {
            if (28 - inv().length < 3) throw new Error('headless needs three free slots; protected kit stays held');
            for (const id of [SHAFT, FEATHER]) {
                const item = s.sdk.getState()!.bank.items.find(i => i.id === id)!;
                await s.bot.withdrawItem(item, planned, { asNote: false });
                if (held(id) !== planned) throw new Error(`no progress: headless withdrawal incomplete for ${item.name}`);
            }
            await s.bot.closeBank();
            let misses = 0;
            while (made < planned && !over()) {
                const shafts = inv().find(i => i.id === SHAFT), feathers = inv().find(i => i.id === FEATHER);
                if (!shafts || !feathers || held(SHAFT) < 15 || held(FEATHER) < 15) throw new Error('headless input accounting shortfall');
                const beforeOutput = held(HEADLESS), beforeShaft = held(SHAFT), beforeFeather = held(FEATHER);
                if (s.sdk.getDialog()?.isOpen || s.sdk.getState()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                await s.sdk.sendUseItemOnItem(shafts.slot, feathers.slot);
                actions++;
                await waitUntil(s, () => held(HEADLESS) > beforeOutput || over(), { timeoutTicks: 5 });
                const gained = held(HEADLESS) - beforeOutput;
                if (gained > 0) {
                    if (gained !== 15 || beforeShaft - held(SHAFT) !== gained || beforeFeather - held(FEATHER) !== gained) throw new Error('headless input/output accounting mismatch');
                    made += gained; misses = 0;
                } else if (++misses >= 3) { stop = 'no-progress'; throw new Error('no progress: headless item-on-item failed three times'); }
            }
            stop = made === options.maximum ? 'max-make' : over() ? (options.stop?.() ? 'stopped' : 'cap') : 'input-insufficient';
        }
    } catch (e) { failure = String(e); }
    finally {
        if (!ended && !died) {
            try {
                await open(); await deposit();
                banked = originalOutput === undefined ? 0 : Math.max(0, bankCount(HEADLESS) - originalOutput);
            } catch (e) { failure ||= `cleanup ${String(e)}`; }
        }
        off();
    }
    const preserved = [...protectedItems].every(([id, count]) => held(id) >= count);
    const reserveMet = !!bankSnapshot && bankCount(SHAFT) >= options.shaftReserve && bankCount(FEATHER) >= options.featherReserve;
    const xpGain = xp() - initialXp;
    if (!preserved) failure ||= 'headless protected asset shortfall';
    if (made > 0 && (!reserveMet || banked !== made || xpGain <= 0)) failure ||= 'headless final bank/reserve/XP proof failed';
    if (held(HEADLESS) > 0) failure ||= 'headless output remains unbanked';
    const targetMet = made === options.maximum && banked === made && reserveMet;
    return { ok: !failure && !died && !ended && stop !== 'stopped', ticks: s.tick() - start, made, banked, planned, actions, bankTrips,
        xpGain, shaftBank: bankCount(SHAFT), featherBank: bankCount(FEATHER), headlessBank: bankCount(HEADLESS), heldHeadless: held(HEADLESS),
        reserveMet, preserved, targetMet, stop, hpMin, died, failure: failure || '-' };
}

// Revision289 arrows.dbrow: steel_arrowheads41 + headless_arrow53 -> steel_arrow886,15; level30; experience50 (tenths).
export const ARROW_METALS=['bronze','iron','steel','mithril','adamant','rune']as const;
export type ArrowMetal=typeof ARROW_METALS[number];
type ArrowProfile={metal:ArrowMetal;tip:number;product:number;units:number;level:number;rawXpPerArrow:number;tipName:string};
const arrowProfiles=new Map<ArrowMetal,ArrowProfile>();
export function nativeArrowProfile(metal:ArrowMetal):ArrowProfile{
 if(!ARROW_METALS.includes(metal))throw Error('unsupported arrow metal');const cached=arrowProfiles.get(metal);if(cached)return cached;
 const base='vendor/rs-sdk/server/content/',text=readFileSync(base+'scripts/skill_fletching/configs/arrows/arrows.dbrow','utf8'),body=text.split('[fletching_'+metal+'_arrow]')[1]?.split('\n[')[0];if(!body)throw Error('native arrow recipe absent');
 const field=(key:string)=>body.match(new RegExp('^data='+key+',(.+)$','m'))?.[1]?.trim(),item=field('item')!,[product,units]=field('product')!.split(','),ids=new Map(readFileSync(base+'pack/obj.pack','utf8').split(/\r?\n/).map(l=>{const i=l.indexOf('=');return[l.slice(i+1),Number(l.slice(0,i))];})),obj=readFileSync(base+'scripts/skill_fletching/configs/arrows/arrows.obj','utf8').split('['+item+']')[1]?.split('\n[')[0],tipName=obj?.match(/^name=(.+)$/m)?.[1]?.trim();
 const r={metal,tip:ids.get(item)!,product:ids.get(product!)!,units:Number(units),level:Number(field('level')),rawXpPerArrow:Number(field('experience')),tipName:tipName!};if(![r.tip,r.product,r.level,r.rawXpPerArrow].every(n=>Number.isSafeInteger(n)&&n>0)||r.units!==15||!tipName)throw Error('native arrow mapping invalid');arrowProfiles.set(metal,Object.freeze(r));return r;
}
export interface SteelOptions { cap: number; maximum: number; headlessReserve: number; tipReserve: number; outputReserve: number; stop?: () => boolean; exact?:{xpRate:number; enterCleanup?:()=>void} }
const STEEL_TIP = 41, STEEL_ARROW = 886;
const STEEL_MATERIALS = new Set([HEADLESS, STEEL_TIP, STEEL_ARROW]);
export function planSteel(headless: number, tips: number, maximum = 15, headlessReserve = 200, tipReserve = 5): number {
    return Math.max(0, Math.floor(Math.min(maximum, headless - headlessReserve, tips - tipReserve) / 15) * 15);
}

export async function runSteel(s: Session, options: SteelOptions, metal: ArrowMetal = 'steel') {
    const profile=nativeArrowProfile(metal);if(options.exact&&(!Number.isSafeInteger(options.exact.xpRate)||options.exact.xpRate<1||options.exact.xpRate>1000))throw Error('invalid arrow XP rate');const STEEL_TIP=profile.tip,STEEL_ARROW=profile.product;
    const STEEL_MATERIALS = new Set([HEADLESS, STEEL_TIP, STEEL_ARROW]);
    const requiredLevel = profile.level;
    for (const [name, value] of Object.entries({ cap: options.cap, maximum: options.maximum, headlessReserve: options.headlessReserve, tipReserve: options.tipReserve, outputReserve: options.outputReserve }))
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid steel ${name}`);
    if (options.cap <= 0 || options.maximum <= 0 || options.maximum % 15 || options.headlessReserve < 0 || options.tipReserve < 0)
        throw new Error('steel needs positive CAP, MAX_MAKE multiple15, nonnegative HEADLESS_RESERVE, TIP_RESERVE and OUTPUT_RESERVE');
    const synced = await waitUntil(s, () => (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0 && (s.sdk.getSkill('Fletching')?.baseLevel ?? 0) > 0, { timeoutTicks: 15 });
    if (!synced) throw new Error('steel skill sync failed');
    // Revision289 make_arrows checks the current stat, including drains.
    const qualified = () => (s.sdk.getSkill('Fletching')?.level ?? 0) >= requiredLevel;
    const inv = () => s.sdk.getInventory();
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const xp = () => s.sdk.getSkillXp('Fletching') ?? 0;
    const initialXp = xp(), start = s.tick(), player = s.sdk.getState()?.player;
    let ended = false, died = false, hpMin = s.sdk.getSkill('Hitpoints')!.level;
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        hpMin = Math.min(hpMin, s.sdk.getSkill('Hitpoints')?.level ?? hpMin);
        if (p?.isDead || hpMin <= 0 || (p?.respawnCount ?? 0) > (player?.respawnCount ?? 0) || (player?.lifeId !== undefined && p?.lifeId !== player.lifeId)) died = true;
    });
    const over = () => ended || died || options.stop?.() || s.tick() - start >= options.cap;
    const protectedItems = new Map<number, number>();
    for (const item of inv()) if (!STEEL_MATERIALS.has(item.id)) protectedItems.set(item.id, (protectedItems.get(item.id) ?? 0) + item.count);
    let headlessUsed = 0, tipsUsed = 0;
    let made = 0, banked = 0, actions = 0, bankTrips = 0, planned = 0, originalOutput: number | undefined;
    let stop = 'input-insufficient', failure = '', uncertain=false;
    let initialAssets:Map<number,number>|undefined;
    const assets=()=>{const rows=[...(bankSnapshot??[]),...inv()],out=new Map<number,number>();for(const i of rows)out.set(i.id,(out.get(i.id)??0)+i.count);return out;};
    let bankSnapshot: { id: number; count: number }[] | undefined;
    const capture = () => {
        const observation = s.bankObservation?.();
        if (!observation) throw Error('arrow bank observation unknown');
        bankSnapshot = observation.items.map(i => ({id:i.id,count:i.count}));
    };
    const open = async () => {
        const generation = s.bankObservation?.()?.generation ?? 0;
        if (!s.sdk.getState()?.bank?.isOpen) {
            const result = await s.bot.openBank();
            if (!result.success) throw new Error(`steel bank: ${result.message}`);
            bankTrips++;
            await waitTicks(s, 1);
        }
        if (!s.sdk.getState()?.bank?.isOpen) throw new Error('steel bank state not observed');
    };
    const deposit = async () => {
        // Refresh each slot after every deposit. One deposit per actual item ID, even for many slots.
        for (const id of new Set(inv().filter(i => STEEL_MATERIALS.has(i.id) && i.count > 0).map(i => i.id))) {
            const item = inv().find(i => i.id === id)!;
            await depositObserved(s, item);
            if (held(id) > 0) throw new Error(`steel deposit incomplete: ${item.name}`);
        }
        await waitTicks(s, 1);
        capture();
    };
    const bankCount = (id: number) => bankSnapshot?.filter(i => i.id === id).reduce((n, i) => n + i.count, 0) ?? 0;
    try {
        await open();
        await deposit();
        originalOutput = bankCount(STEEL_ARROW);
        if(options.exact)initialAssets=assets();
        planned = qualified() ? planSteel(bankCount(HEADLESS), bankCount(STEEL_TIP), options.maximum, options.headlessReserve, options.tipReserve) : 0;
        if (!qualified()) stop = 'skill-required';
        if (planned > 0 && !over()) {
            if (28 - inv().length < 3) throw new Error('steel needs three free slots; protected kit stays held');
            for (const id of [HEADLESS, STEEL_TIP]) {
                const item = s.sdk.getState()!.bank.items.find(i => i.id === id)!;
                await s.bot.withdrawItem(item, planned, { asNote: false });
                if (held(id) !== planned) throw new Error(`no progress: steel withdrawal incomplete for ${item.name}`);
            }
            await s.bot.closeBank();
            let misses = 0;
            while (made < planned && !over()) {
                if (!qualified()) { stop = 'skill-required'; break; }
                const headless = inv().find(i => i.id === HEADLESS), tips = inv().find(i => i.id === STEEL_TIP);
                if (!headless || !tips || held(HEADLESS) < 15 || held(STEEL_TIP) < 15) throw new Error('steel input accounting shortfall');
                const beforePack=options.exact?new Map(inv().map(i=>[i.id,held(i.id)])):undefined;
                const beforeOutput = held(STEEL_ARROW), beforeHeadless = held(HEADLESS), beforeTip = held(STEEL_TIP);
                if (s.sdk.getDialog()?.isOpen || s.sdk.getState()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                uncertain=!!options.exact;
                await s.sdk.sendUseItemOnItem(headless.slot, tips.slot);
                actions++;
                await waitUntil(s, () => held(STEEL_ARROW) > beforeOutput || over(), { timeoutTicks: 5 });
                const gained = held(STEEL_ARROW) - beforeOutput;
                const usedHeadless = beforeHeadless - held(HEADLESS), usedTips = beforeTip - held(STEEL_TIP);
                headlessUsed += usedHeadless; tipsUsed += usedTips;
                if (gained > 0) {
                    if (gained !== 15 || usedHeadless !== gained || usedTips !== gained) throw new Error('steel input/output accounting mismatch');
                    if(beforePack){const ids=new Set([...beforePack.keys(),...inv().map(i=>i.id)]);if([...ids].some(id=>held(id)-(beforePack.get(id)??0)!==(id===STEEL_ARROW?15:id===HEADLESS||id===STEEL_TIP?-15:0)))throw Error('native arrows whole-pack effect differs');}
                    if(options.exact){const raw=(made+gained)*profile.rawXpPerArrow*options.exact.xpRate,gain=xp()-initialXp;if(gain<Math.floor(raw/10)||gain>Math.ceil(raw/10))throw Error('native arrows exact XP differs');}
                    uncertain=false; made += gained; misses = 0;
                } else if (usedHeadless !== 0 || usedTips !== 0) throw new Error('steel inputs debited without output');
                else if (options.exact || ++misses >= 3) { stop = 'no-progress'; throw new Error('no progress: steel item-on-item failed three times'); }
            }
            stop = stop === 'skill-required' ? stop : made === options.maximum ? 'max-make' : over() ? (options.stop?.() ? 'stopped' : 'cap') : 'input-insufficient';
        }
    } catch (e) { failure = String(e); }
    finally {
        if (!ended && !died && !uncertain) {
            options.exact?.enterCleanup?.();
            try {
                await open(); await deposit();
                banked = originalOutput === undefined ? 0 : Math.max(0, bankCount(STEEL_ARROW) - originalOutput);
            } catch (e) { failure ||= `cleanup ${String(e)}`; }
        }
        off();
    }
    if(initialAssets&&!uncertain){const finalAssets=assets(),ids=new Set([...initialAssets.keys(),...finalAssets.keys()]);if([...ids].some(id=>(finalAssets.get(id)??0)-(initialAssets!.get(id)??0)!==(id===STEEL_ARROW?made:id===HEADLESS||id===STEEL_TIP?-made:0)))failure ||= 'native arrows whole-bank assets differ';}
    const preserved = [...protectedItems].every(([id, count]) => held(id) >= count);
    const reserveMet = !!bankSnapshot && bankCount(HEADLESS) >= options.headlessReserve && bankCount(STEEL_TIP) >= options.tipReserve;
    const xpGain = xp() - initialXp;
    if(options.exact){const raw=made*profile.rawXpPerArrow*options.exact.xpRate;if(xpGain<Math.floor(raw/10)||xpGain>Math.ceil(raw/10))failure ||= 'native arrows exact XP differs';}
    if (!preserved) failure ||= 'steel protected asset shortfall';
    if (made > 0 && (!reserveMet || banked !== made || xpGain <= 0)) failure ||= 'steel final bank/reserve/XP proof failed';
    if (held(STEEL_ARROW) > 0) failure ||= 'steel output remains unbanked';
    // All preexisting output is retained. OUTPUT_RESERVE is a final bank floor, never a withdrawal allowance.
    const outputReserveMet = !!bankSnapshot && bankCount(STEEL_ARROW) >= options.outputReserve;
    const targetMet = made === options.maximum && banked === made && reserveMet && outputReserveMet;
    return { ok: !failure && !died && !ended && stop !== 'stopped', ticks: s.tick() - start, made, banked, planned, actions, bankTrips,
        xpGain, headlessUsed, tipsUsed, outputReserveMet, headlessBank: bankCount(HEADLESS), tipBank: bankCount(STEEL_TIP), arrowBank: bankCount(STEEL_ARROW), heldArrows: held(STEEL_ARROW),
        reserveMet, preserved, targetMet, stop, hpMin, died, ...(options.exact?{uncertain}:{}), failure: failure || '-' };
}

export async function runNativeArrows(original:Session,options:SteelOptions & {xpRate?:number},metal:ArrowMetal){
 const profile=nativeArrowProfile(metal),client=original.client as any,owner=client.executeBotAction,p=original.sdk.getState()?.player,life=p?.lifeId,respawns=p?.respawnCount??0,plane=p?.level,hp=original.sdk.getSkill('Hitpoints')?.level??0,start=original.tick();let ended=false,cleanup=false;void original.ended.then(()=>{ended=true;});
 const gear=JSON.stringify(original.sdk.getEquipment()),otherXP=()=>JSON.stringify(original.sdk.getState()?.skills.filter(k=>k.name!=='Fletching').map(k=>[k.name,k.experience])),initialXP=otherXP();
 const guard=()=>{const now=original.sdk.getState()?.player;if(ended||original.client!==client||client.executeBotAction!==owner||typeof owner!=='function'||!Number.isSafeInteger(life)||!now||now.isDead||now.lifeId!==life||(now.respawnCount??0)!==respawns||now.level!==plane||hp<1||original.sdk.getSkill('Hitpoints')?.level!==hp||original.sdk.getStateAge()>5000||JSON.stringify(original.sdk.getEquipment())!==gear||otherXP()!==initialXP||(!cleanup&&productionStopRequested(original.name,options.stop))||original.tick()-start>=options.cap)throw Error('native arrows original owner/life/HP/XP/stop/cap');};guard();
 const sdk=new Proxy(original.sdk,{get(t,k,r){const v=Reflect.get(t,k,r);return typeof v==='function'?function(...a:unknown[]){if(typeof k==='string'&&k.startsWith('send'))guard();return v.apply(r,a);}:v;}}),s={...original,sdk,bot:new BotActions(sdk),direct:async(a:Parameters<Session['direct']>[0])=>{guard();return original.direct(a);}}as Session;
 const result=await runSteel(s,{...options,exact:{xpRate:options.xpRate??25,enterCleanup:()=>{cleanup=true;}},stop:()=>{try{guard();return false;}catch{return true;}}},metal);guard();return{...result,ok:result.ok&&result.targetMet,metal,profile};
}

// rev289 cut_logs.dbrow + stringing/bows.dbrow: each step level25,250 tenths XP.
export interface OakBowOptions { cap: number; maximum: number; logReserve: number; stringReserve: number; stop?: () => boolean }
const OAK_LOG = 1521, BOW_STRING = 1777, OAK_UNSTRUNG = 56, OAK_BOW = 845, KNIFE = 946;
const OAK_MATERIALS = new Set([OAK_LOG, BOW_STRING, OAK_UNSTRUNG, OAK_BOW]);
const OAK_NOTES = new Map([[1522, OAK_LOG], [1778, BOW_STRING]]); // obj.pack cert_oak_logs / cert_bow_string
export function planOakBows(logs: number, strings: number, maximum: number, logReserve: number, stringReserve: number) {
    return Math.max(0, Math.min(450, maximum, logs - logReserve, strings - stringReserve));
}
export async function runOakBows(s: Session, options: OakBowOptions) {
    for (const value of [options.cap, options.maximum, options.logReserve, options.stringReserve])
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid oak-bows limit');
    if (!options.cap || options.maximum < 1 || options.maximum > 450) throw new Error('oak-bows requires MAX_MAKE1..450 and positive CAP');
    if (!await waitUntil(s, () => (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0 && (s.sdk.getSkill('Fletching')?.baseLevel ?? 0) > 0, { timeoutTicks: 15 })) throw new Error('oak-bows skill sync failed');
    const inv = () => s.sdk.getInventory();
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const xp = () => s.sdk.getSkillXp('Fletching') ?? 0;
    const qualified = () => (s.sdk.getSkill('Fletching')?.level ?? 0) >= 25;
    const start = s.tick(), initialXp = xp(), player = s.sdk.getState()?.player;
    let hpMin = s.sdk.getSkill('Hitpoints')!.level, died = false, ended = false;
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        hpMin = Math.min(hpMin, s.sdk.getSkill('Hitpoints')?.level ?? hpMin);
        if (p?.isDead || hpMin <= 0 || (p?.respawnCount ?? 0) > (player?.respawnCount ?? 0) || (player?.lifeId !== undefined && p?.lifeId !== player.lifeId)) died = true;
    });
    const over = () => ended || died || !!options.stop?.() || s.tick() - start >= options.cap;
    let snapshot: { id: number; count: number }[] | undefined;
    const bankCount = (id: number) => snapshot?.filter(i => i.id === id).reduce((n, i) => n + i.count, 0) ?? 0;
    const capture = () => { const b = s.bankObservation?.(); snapshot = b?.items.map(i => ({ id: i.id, count: i.count })); if (!snapshot) throw new Error('oak-bows bank unknown'); };
    const open = async () => {
        const generation = s.bankObservation?.()?.generation ?? 0;
        if (!s.sdk.getState()?.bank?.isOpen) {
            if (!(await s.bot.openBank()).success) throw new Error('oak-bows bank open failed');
            if (!await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 10 })) throw new Error('oak-bows bank data not ready');
        }
        capture();
    };
    const deposit = async () => {
        for (const id of new Set(inv().filter(i => OAK_MATERIALS.has(i.id)).map(i => i.id))) {
            await s.bot.depositItem(inv().find(i => i.id === id)!, -1);
            if (!await waitUntil(s, () => held(id) === 0, { timeoutTicks: 5 })) throw new Error(`oak-bows deposit failed ${id}`);
        }
        await waitTicks(s, 1); capture();
    };
    const totals = () => {
        const counts = new Map<number, number>();
        for (const i of [...(snapshot ?? []), ...inv()]) counts.set(i.id, (counts.get(i.id) ?? 0) + i.count);
        return counts;
    };
    let initial: Map<number, number> | undefined, shaped = 0, made = 0, banked = 0, planned = 0, actions = 0;
    let shapeXp = 0, stringXp = 0, logsUsed = 0, stringsUsed = 0, notesConverted = 0, failure = '', stop = 'input-insufficient';
    try {
        // SDK fletchLogs selects the first log. Reject unrelated held logs rather than silently cutting them.
        if (inv().some(i => /logs/i.test(i.name) && i.id !== OAK_LOG && !OAK_NOTES.has(i.id))) throw new Error('oak-bows unrelated held logs');
        await open();
        // Incoming owned trades carry certificates. Prove each exact-ID conversion before
        // establishing the raw-material baseline; never infer certificates from display names.
        for (const [noteId, rawId] of OAK_NOTES) {
            const note = inv().find(i => i.id === noteId);
            if (!note) continue;
            const amount = held(noteId), before = totals(), rawBank = bankCount(rawId);
            if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('oak-bows invalid note conversion amount');
            const result = await s.bot.depositItem(note, -1);
            const ready = await waitUntil(s, () => {
                const observation = s.bankObservation?.();
                return held(noteId) === 0 && !!observation && observation.items.filter(i => i.id === rawId).reduce((n, i) => n + i.count, 0) === rawBank + amount;
            }, { timeoutTicks: 10 });
            if (!result.success || !ready) throw new Error(`oak-bows note conversion failed ${noteId}`);
            capture();
            const after = totals();
            if (![...new Set([...before.keys(), ...after.keys(), noteId, rawId])].every(id =>
                (after.get(id) ?? 0) === (before.get(id) ?? 0) + (id === rawId ? amount : id === noteId ? -amount : 0)))
                throw new Error(`oak-bows note conversion conservation failed ${noteId}`);
            notesConverted += amount;
        }
        initial = totals(); await deposit();
        if (!qualified()) stop = 'skill-required';
        else {
            if (!held(KNIFE)) {
                const knife = s.sdk.getState()!.bank.items.find(i => i.id === KNIFE);
                if (!knife) throw new Error('oak-bows owned knife required');
                await s.bot.withdrawItem(knife, 1, { asNote: false });
                if (!await waitUntil(s, () => held(KNIFE) === 1, { timeoutTicks: 5 })) throw new Error('oak-bows knife withdrawal failed');
            }
            planned = planOakBows(bankCount(OAK_LOG), bankCount(BOW_STRING), options.maximum, options.logReserve, options.stringReserve);
            while (made < planned && !over() && qualified()) {
                const batch = Math.min(planned - made, Math.floor((28 - inv().length) / 2));
                if (batch < 1) throw new Error('oak-bows kit leaves no input slots');
                for (const id of [OAK_LOG, BOW_STRING]) {
                    const item = s.sdk.getState()!.bank.items.find(i => i.id === id);
                    if (!item) throw new Error('oak-bows input missing');
                    await s.bot.withdrawItem(item, batch, { asNote: false });
                    if (!await waitUntil(s, () => held(id) === batch, { timeoutTicks: 5 })) throw new Error(`oak-bows withdrawal incomplete ${id}`);
                }
                await s.bot.closeBank();
                for (let n = 0; n < batch && !over() && qualified(); n++) {
                    let misses = 0;
                    while (!over()) {
                        const before = held(OAK_UNSTRUNG), logs = held(OAK_LOG), beforeXp = xp();
                        // Actual skill_multi2 label is "Oak Long Bow", not the legacy string regex.
                        await s.bot.fletchLogs('Long Bow'); actions++;
                        await waitUntil(s, () => held(OAK_UNSTRUNG) !== before || held(OAK_LOG) !== logs || over(), { timeoutTicks: 6 });
                        const gain = held(OAK_UNSTRUNG) - before, debit = logs - held(OAK_LOG);
                        if (gain || debit) {
                            logsUsed += debit; shapeXp += xp() - beforeXp;
                            if (gain !== 1 || debit !== 1 || xp() <= beforeXp) throw new Error('oak-bows shaping accounting/XP mismatch');
                            shaped++; break;
                        }
                        if (++misses >= 3) { stop = 'no-progress'; throw new Error('no progress: oak-bows shaping failed three times'); }
                    }
                    if (over()) break;
                    misses = 0;
                    while (!over()) {
                        const bow = inv().find(i => i.id === OAK_UNSTRUNG), string = inv().find(i => i.id === BOW_STRING);
                        if (!bow || !string) throw new Error('oak-bows stringing inputs missing');
                        const before = held(OAK_BOW), beforeU = held(OAK_UNSTRUNG), strings = held(BOW_STRING), beforeXp = xp();
                        if (s.sdk.getDialog()?.isOpen || s.sdk.getState()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                        await s.sdk.sendUseItemOnItem(bow.slot, string.slot); actions++;
                        await waitUntil(s, () => held(OAK_BOW) !== before || held(BOW_STRING) !== strings || over(), { timeoutTicks: 6 });
                        const gain = held(OAK_BOW) - before, debit = strings - held(BOW_STRING);
                        if (gain || debit || held(OAK_UNSTRUNG) !== beforeU) {
                            stringsUsed += debit; stringXp += xp() - beforeXp;
                            if (gain !== 1 || debit !== 1 || beforeU - held(OAK_UNSTRUNG) !== 1 || xp() <= beforeXp) throw new Error('oak-bows stringing accounting/XP mismatch');
                            made++; break;
                        }
                        if (++misses >= 3) { stop = 'no-progress'; throw new Error('no progress: oak-bows stringing failed three times'); }
                    }
                }
                await open(); await deposit();
            }
            stop = made === options.maximum ? 'max-make' : !qualified() ? 'skill-required' : over() ? (options.stop?.() ? 'stopped' : 'cap') : 'input-insufficient';
        }
    } catch (e) { failure = String(e); }
    finally {
        if (!ended && !died) try { await open(); await deposit(); } catch (e) { failure ||= `cleanup ${String(e)}`; }
        off();
    }
    const final = totals();
    banked = initial ? Math.max(0, bankCount(OAK_BOW) - (initial.get(OAK_BOW) ?? 0)) : 0;
    const changes = new Map([[OAK_LOG, -logsUsed], [BOW_STRING, -stringsUsed], [OAK_UNSTRUNG, shaped - made], [OAK_BOW, made]]);
    const preserved = !!initial && [...new Set([...initial.keys(), ...final.keys(), ...changes.keys()])].every(id => (final.get(id) ?? 0) === (initial!.get(id) ?? 0) + (changes.get(id) ?? 0));
    const reserveMet = !!snapshot && bankCount(OAK_LOG) >= options.logReserve && bankCount(BOW_STRING) >= options.stringReserve;
    if (!preserved) failure ||= 'oak-bows asset conservation failed';
    if (made && (banked !== made || !reserveMet || shapeXp <= 0 || stringXp <= 0)) failure ||= 'oak-bows final output/reserve/XP proof failed';
    const targetMet = made === options.maximum && banked === made && reserveMet && preserved && !failure;
    return { ok: !failure && !died && !ended && stop !== 'stopped', ticks: s.tick() - start, made, shaped, banked, planned, actions,
        xpGain: xp() - initialXp, shapeXp, stringXp, logsUsed, stringsUsed, notesConverted, logBank: bankCount(OAK_LOG), stringBank: bankCount(BOW_STRING),
        bowBank: bankCount(OAK_BOW), unstrungBank: bankCount(OAK_UNSTRUNG), reserveMet, preserved, targetMet, hpMin, died, stop, failure: failure || '-' };
}

async function main() {
const botName = process.argv[2];
const CAP = Number(process.argv[3] ?? process.env.CAP ?? 15000);
const MODE = (process.argv[4] ?? process.env.MODE ?? 'arrows').toLowerCase();
const TIP_TYPE = (process.argv[5] ?? process.env.TIP_TYPE ?? 'rune').toLowerCase();

if (!botName) {
    console.error('Usage: bun scripts/fletch-arrows.ts <botName> [CAP] [MODE] [TIP_TYPE]');
    process.exit(1);
}

if(MODE==='native-arrows')nativeArrowProfile(TIP_TYPE as ArrowMetal);
let stopped = false;
const s = await openBot(botName, (MODE === 'native-arrows' || MODE === 'headless' || MODE === 'iron' || MODE === 'steel' || MODE === 'oak-bows' || MODE === 'shafts') ? { onStop: async () => { stopped = true; } } : {}).catch(e => finish([], false, `login: ${String(e)}`));
if(MODE==='native-arrows'){
 try{const r=await runNativeArrows(s,{cap:CAP,maximum:Number(process.env.MAX_MAKE??30),headlessReserve:Number(process.env.HEADLESS_RESERVE??200),tipReserve:Number(process.env.TIP_RESERVE??5),outputReserve:Number(process.env.OUTPUT_RESERVE??0),xpRate:Number(process.env.FLETCHING_XP_RATE??25),stop:()=>stopped},TIP_TYPE as ArrowMetal);console.log('NATIVE_ARROW_BANK '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));}catch(e){await finish([s],false,String(e));}
}
if (MODE === 'shafts') {
    try {
        const r=await runShafts(s,{cap:CAP,maximum:Number(process.env.MAX_MAKE??25),reserve:Number(process.env.LOG_RESERVE??0),bankKnife:process.env.BANK_KNIFE==='1',stop:()=>stopped});
        console.log('SHAFT_BANK '+JSON.stringify(r));
        await finish([s],r.ok,`${r.ok||r.stop==='stopped'?'':'no fletching progress: '}mode=shafts ${Object.entries(r).map(([k,v])=>`${k}=${v}`).join(' ')}`);
    }catch(e){await finish([s],false,`no fletching progress: ${String(e)}`);}
}
if (MODE === 'oak-bows') {
    try {
        const r = await runOakBows(s, { cap: CAP, maximum: Number(process.env.MAX_MAKE ?? 25), logReserve: Number(process.env.LOG_RESERVE ?? 0), stringReserve: Number(process.env.STRING_RESERVE ?? 0), stop: () => stopped });
        console.log(`OAK_BOW_BANK ${JSON.stringify(r)}`);
        await finish([s], r.ok, `mode=oak-bows ${Object.entries(r).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    } catch (e) { await finish([s], false, String(e)); }
}
if (MODE === 'iron') {
    try {
        const r = await runSteel(s, { cap: CAP, maximum: Number(process.env.MAX_MAKE ?? 90), headlessReserve: Number(process.env.HEADLESS_RESERVE ?? 200), tipReserve: Number(process.env.TIP_RESERVE ?? 0), outputReserve: Number(process.env.OUTPUT_RESERVE ?? 0), stop: () => stopped }, 'iron');
        console.log('IRON_BANK ' + JSON.stringify(r));
        const accepted = r.ok && r.targetMet;
        await finish([s], accepted, (accepted ? '' : 'arrow prerequisite: exact order incomplete; ') + 'mode=iron ' + Object.entries(r).map(([k,v]) => k+'='+v).join(' '));
    } catch(e) { await finish([s], false, 'arrow prerequisite: '+String(e)); }
}
if (MODE === 'steel') {
    try {
        const r = await runSteel(s, { cap: CAP, maximum: Number(process.env.MAX_MAKE ?? 15), headlessReserve: Number(process.env.HEADLESS_RESERVE ?? 200), tipReserve: Number(process.env.TIP_RESERVE ?? 5), outputReserve: Number(process.env.OUTPUT_RESERVE ?? 0), stop: () => stopped });
        console.log(`STEEL_BANK ${JSON.stringify(r)}`);
        await finish([s], r.ok, `mode=steel ${Object.entries(r).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    } catch (e) { await finish([s], false, String(e)); }
}
if (MODE === 'headless') {
    try {
        // BANK_PACK=1: bank the whole pack first. A pack left full by other jobs (quest leftovers) is not
        // protected kit, and headless needs three free slots.
        if (process.env.BANK_PACK === '1') {
            if (!(await s.bot.openBank()).success) throw new Error('headless BANK_PACK: bank did not open');
            await waitTicks(s, 1);
            await depositPack(s);
            await s.bot.closeBank();
        }
        const r = await runHeadless(s, { cap: CAP, maximum: Number(process.env.MAX_MAKE ?? 390), shaftReserve: Number(process.env.SHAFT_RESERVE ?? 200), featherReserve: Number(process.env.FEATHER_RESERVE ?? 100), stop: () => stopped });
        console.log(`HEADLESS_BANK ${JSON.stringify(r)}`);
        await finish([s], r.ok, `mode=headless ${Object.entries(r).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    } catch (e) { await finish([s], false, String(e)); }
}
try {
    const inv = () => s.sdk.getInventory();
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => used() >= CAP;

    let fletched = 0, bankTrips = 0;

    const findItem = (re: RegExp) => inv().find(i => re.test(i.name));
    const countRe = (re: RegExp) => countItems(s, re);

    const bank = async () => {
        const b = await s.bot.openBank();
        if (!b.success) {
            await waitTicks(s, 2);
            return;
        }

        if (MODE === 'arrows') {
            // Finished arrows: deposit made arrows if any
            await s.bot.depositItem(/arrow$/i, -1);
            await waitTicks(s, 1);
            // Withdraw headless arrows and tips
            const tipRe = new RegExp(`${TIP_TYPE} arrowtip`, 'i');
            await s.bot.withdrawItem(/headless arrow/i, 1000);
            await s.bot.withdrawItem(tipRe, 1000);
        } else if (MODE === 'bows') {
            await s.bot.depositItem(/longbow$/i, -1);
            await waitTicks(s, 1);
            await s.bot.withdrawItem(/bowstring/i, 14);
            await s.bot.withdrawItem(/longbow \(u\)/i, 14);
        }

        bankTrips++;
        await s.bot.closeInterface();
        await waitTicks(s, 1);
    };

    console.log(`START fletch assembler ${botName} mode=${MODE} tip=${TIP_TYPE}`);

    while (!over()) {
        if (MODE === 'arrows') {
            const headless = findItem(/headless arrow/i);
            const tips = findItem(new RegExp(`${TIP_TYPE} arrowtip`, 'i'));
            if (!headless || !tips) {
                await bank();
                if (!findItem(/headless arrow/i) || !findItem(new RegExp(`${TIP_TYPE} arrowtip`, 'i'))) {
                    await waitTicks(s, 5);
                    continue;
                }
            }

            const finishedRe = new RegExp(`^${TIP_TYPE} arrow$`, 'i');
            const h = findItem(/headless arrow/i)!;
            const t = findItem(new RegExp(`${TIP_TYPE} arrowtip`, 'i'))!;
            const before = countRe(finishedRe);
            await s.sdk.sendUseItemOnItem(h.slot, t.slot);
            await waitTicks(s, 2);

            const gained = countRe(finishedRe) - before;
            if (gained > 0) fletched += gained;
        } else if (MODE === 'bows') {
            const strings = findItem(/bowstring/i);
            const unstrung = findItem(/longbow \(u\)/i);
            if (!strings || !unstrung) {
                await bank();
                if (!findItem(/bowstring/i) || !findItem(/longbow \(u\)/i)) {
                    await waitTicks(s, 5);
                    continue;
                }
            }

            const st = findItem(/bowstring/i)!;
            const un = findItem(/longbow \(u\)/i)!;
            const before = countRe(/longbow$/i);
            await s.sdk.sendUseItemOnItem(st.slot, un.slot);
            await waitTicks(s, 2);

            const gained = countRe(/longbow$/i) - before;
            if (gained > 0) fletched += gained;
        }
    }

    const perK = (fletched * 1000 / Math.max(1, used())).toFixed(2);
    await finish([s], fletched > 0, `ticks=${used()} fletched=${fletched} mode=${MODE} bankTrips=${bankTrips} fletchPer1kTicks=${perK}`);
} catch (e) {
    await finish([s], false, String(e));
}

}
if (import.meta.main) await main();
