// Universal Ore Gatherer: mines ores (iron, coal, tin, copper) and banks locally.
// Usage: bun scripts/gather-ore.ts <bot> [CAP ticks, default 15000] [BANK_AT ores, default 27]
// Environment: DEMO_OK=1 for live server.
import { openBot, finish, countItems, getWorld, accountOf } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker, goTo } from '../packages/core/src/walk';
import { runSoftenClay } from './soften-clay';
import { bankCargo } from '../packages/core/src/cargo';

import type { Session } from '../packages/core/src/inprocess';
import type { NearbyLoc } from '../vendor/rs-sdk/sdk/types';

const ROCK_IDS = { copper: [2090, 2091], tin: [2094, 2095], iron: [2092, 2093] };
export function selectRock(rocks: readonly NearbyLoc[], level: number, attempt: number, floor: number, profile = 'mixed'): NearbyLoc | undefined {
    if (profile === 'clay') return rocks.filter(l => l.level === floor && l.reachable !== false && [2108, 2109].includes(l.id) && l.optionsWithIndex.some(o => /^mine$/i.test(o.text))).sort((a,b) => a.distance - b.distance)[0];
    const kinds = level >= 15 ? ['copper', 'tin', 'iron'] as const : ['copper', 'tin'] as const;
    // Prefer the next species, but use another live rock when that species is depleted.
    for (let n = 0; n < kinds.length; n++) {
        const ids: readonly number[] = ROCK_IDS[kinds[(attempt + n) % kinds.length]!];
        const rock = rocks.filter(l => l.level === floor && l.reachable !== false && ids.includes(l.id) && l.optionsWithIndex.some(o => /^mine$/i.test(o.text)))
            .sort((a, b) => a.distance - b.distance)[0];
        if (rock) return rock;
    }
}

// A mined rock changes to next_loc_stage_mining until its player-scaled respawn.
// Wait for our own ore+XP, or leave immediately when somebody else takes this exact rock.
export async function mineRock(s: Session, rock: NearbyLoc, over: () => boolean, timeoutTicks = 60, product = /ore$/i) {
    const ores = () => s.sdk.getInventory().filter(i => product.test(i.name)).reduce((n, i) => n + i.count, 0);
    const before = ores(), xp0 = s.sdk.getSkillXp('mining') ?? 0, start = s.tick();
    const cursor = Math.max(-1, ...(s.sdk.getState()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
    const refusal = () => s.sdk.getState()?.gameMessages.find(m => (m.observationId ?? m.tick) > cursor &&
        /need a mining level|need a pickaxe|do not have a pickaxe|can't reach|cannot reach|no ore currently/i.test(m.text))?.text;
    const active = () => s.sdk.getState()?.nearbyLocs.some(l => l.x === rock.x && l.z === rock.z && l.level === rock.level && l.id === rock.id && l.optionsWithIndex.some(o => /^mine$/i.test(o.text)));
    const progress = () => ores() > before && (s.sdk.getSkillXp('mining') ?? 0) > xp0;
    if (over() || !active()) return { ore: 0, xp: 0, ticks: 0, reason: 'rock-gone' };
    const option = rock.optionsWithIndex.find(o => /^mine$/i.test(o.text))!;
    const sent = await s.sdk.sendInteractLoc(rock.x, rock.z, rock.id, option.opIndex);
    if (sent.success) await waitUntil(s, () => over() || progress() || !!refusal() || !active(), { timeoutTicks });
    // Product and XP can arrive in separate publications. Give a depletion observation one tick to settle.
    if (sent.success && !progress() && !over() && !active()) await waitTicks(s, 1);
    const ore = ores() - before, xp = (s.sdk.getSkillXp('mining') ?? 0) - xp0;
    return { ore, xp, ticks: s.tick() - start, reason: progress() ? 'mined' : !sent.success ? `rejected:${sent.reason ?? sent.message}` : refusal() ?? (!active() ? 'rock-gone' : over() ? 'stopped' : 'timeout') };
}

export function oreStalled(waitTicks: number, limit: number): boolean { return waitTicks >= limit; }

export function oreDamageEvidence(st:any,before:number,after:number,tick:number) {
    if(before<=0||after<=0||after>=before)return;
    const p=st?.player;
    return {tick,hpBefore:before,hpAfter:after,pos:p?[p.worldX,p.worldZ,p.level]:null,attacker:'unknown',
        eventAttribution:'SDK source indices are facing-entity heuristics, not attacker proof',combat:p?.combat??null,
        npcs:(st?.nearbyNpcs??[]).filter((n:any)=>n.distance<=12).slice(0,16).map((n:any)=>({id:n.id,index:n.index,name:n.name,x:n.tileX??n.x,z:n.tileZ??n.z,distance:n.distance,targetIndex:n.targetIndex,inCombat:n.inCombat})),
        players:(st?.nearbyPlayers??[]).filter((n:any)=>n.distance<=12).slice(0,16).map((n:any)=>({index:n.index,name:n.name,x:n.x,z:n.z,distance:n.distance,targetType:n.combatTargetType??null,targetIndex:n.combatTargetIndex??null,inCombat:n.inCombat??null})),
        events:(st?.combatEvents??[]).filter((e:any)=>e.type==='damage_taken'&&e.tick>=tick-2).map((e:any)=>({tick:e.tick,observationId:e.observationId,damage:e.damage,sourceType:e.sourceType,sourceIndex:e.sourceIndex}))};
}
export function watchOreDamage(s:Session,onDamage:(e:NonNullable<ReturnType<typeof oreDamageEvidence>>)=>void) {
    let previous=s.sdk.getSkill('Hitpoints')?.level??0,seen=false;
    return s.onTick(()=>{const hp=s.sdk.getSkill('Hitpoints')?.level??0,e=oreDamageEvidence(s.sdk.getState(),previous,hp,s.tick());
        if(hp>0)previous=hp;if(e&&!seen){seen=true;onDamage(e);}});
}

// Safety cleanup has its own deadline: the damage/stop latch cancels mining,
// but must not cancel the walk out. No purchases, tools, trades or softening.
export async function retreatOre(s:Session,bank:{x:number;z:number},product:RegExp,aborted:()=>boolean,
    walk?: (stop:()=>boolean)=>Promise<boolean>) {
    const start=s.tick(),expired=()=>aborted()||s.tick()-start>=200;
    const hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,inv=()=>s.sdk.getInventory();
    const first=s.sdk.getState()?.player;
    const dead=()=>{const p=s.sdk.getState()?.player;return hp()<=0||!!p&&(p.isDead||(p.respawnCount??0)>(first?.respawnCount??0)||(first?.lifeId!==undefined&&p.lifeId!==first.lifeId));};
    const failure=(why:string)=>new Error(`${dead()?'died=true ':''}no ore progress: ${why}`);
    const count=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const foods:{id:number;count:number;hpBefore:number;hpAfter:number}[]=[];
    if(expired()||dead())throw failure('safety cleanup unavailable after death/session end');
    if(s.sdk.getState()?.dialog?.isOpen||s.sdk.getState()?.modalOpen)await s.direct({type:'closeModal',reason:'SDK'});
    for(let attempt=0;attempt<2&&!expired()&&hp()<(s.sdk.getSkill('Hitpoints')?.baseLevel??hp());attempt++) {
        const food=inv().find(i=>[315,2309,333,329].includes(i.id)&&i.optionsWithIndex?.some(o=>/^eat$/i.test(o.text)));
        if(!food)break;
        const before=count(food.id),hpBefore=hp(),option=food.optionsWithIndex.find(o=>/^eat$/i.test(o.text))!;
        await s.direct({type:'useInventoryItem',slot:food.slot,optionIndex:option.opIndex,reason:'SDK'});
        await waitUntil(s,()=>count(food.id)<before||expired(),{timeoutTicks:3});
        const used=before-count(food.id);
        if(used>0){foods.push({id:food.id,count:used,hpBefore,hpAfter:hp()});break;}
    }
    if(expired()||dead())throw failure('safety cleanup ended before retreat');
    const arrived=walk?await walk(expired):(await walkPath(await sessionWalker(s),[{...bank,tol:2}],{maxTicks:180,stop:expired})).ok;
    if(!arrived||expired()||dead())throw failure('bounded safety retreat failed');
    if(!(await s.bot.openBank()).success)throw failure('safety bank unavailable');
    try {
        await waitTicks(s,1);
        const held=()=>inv().filter(i=>product.test(i.name)).reduce((n,i)=>n+i.count,0);
        const banked=()=>s.sdk.getState()?.bank?.items.filter(i=>product.test(i.name)).reduce((n,i)=>n+i.count,0)??0;
        const before=held(),stock=banked();
        for(const id of new Set(inv().filter(i=>product.test(i.name)).map(i=>i.id))) {
            if(expired()||dead())throw failure('safety bank deadline');
            await s.bot.depositItem(inv().find(i=>i.id===id)!,-1);
        }
        await waitTicks(s,1);
        if(held()!==0||banked()-stock!==before||dead())throw failure('safety deposit not conserved');
        const p=s.sdk.getState()?.player;
        return {ok:true,banked:before,held:held(),foods,hp:hp(),ticks:s.tick()-start,pos:p?[p.worldX,p.worldZ,p.level]:null};
    } finally {await s.bot.closeBank();}
}

async function main() {
const PROFILE = process.env.ORE_PROFILE ?? 'mixed';
if (!['mixed','clay'].includes(PROFILE)) throw new Error('invalid ORE_PROFILE');
const ORE = PROFILE === 'clay' ? /^clay$/i : /ore$/i;
const MINE_SPOT = PROFILE === 'clay' ? { x: 3180, z: 3372 } : { x: 3286, z: 3368 }; // SE Varrock Iron Mine
const BANK_SPOT = PROFILE === 'clay' ? { x: 3185, z: 3436 } : { x: 3253, z: 3420 }; // Varrock East Bank

const CAP = Number(process.argv[3] ?? process.env.CAP ?? 15000);
const BANK_AT = Number(process.argv[4] ?? process.env.BANK_AT ?? 27);
const NO_ORE_TICKS = Number(process.env.NO_ORE_TICKS ?? 120);
if (!Number.isSafeInteger(NO_ORE_TICKS) || NO_ORE_TICKS < 1) throw new Error('invalid NO_ORE_TICKS');

const botName = process.argv[2];
if (!botName) {
    console.error('Usage: bun scripts/gather-ore.ts <botName>');
    process.exit(1);
}

let requestedStop='';
const s = await openBot(botName,{onStop:async(_session,reason)=>{requestedStop=reason;}}).catch(e => finish([], false, `login: ${String(e)}`));
let damage:ReturnType<typeof oreDamageEvidence>;
const offDamage=watchOreDamage(s,e=>{damage=e;console.log('ORE_DAMAGE '+JSON.stringify(e));});
let safetyStarted=false,cleanup:((reason:string)=>Promise<never>)|undefined;
try {
    const initial = s.sdk.getState()?.player;
    if (initial && initial.worldX < 3160 && initial.worldZ < 3130) {
        await waitUntil(s, st => (st?.nearbyNpcs?.length ?? 0) > 0, { timeoutTicks: 30 });
        const tut = await s.bot.skipTutorial();
        if (!tut.success) throw new Error(`tutorial: ${tut.message}`);
    }
    await waitTicks(s, 3);
    const pos = () => s.sdk.getState()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const oreCount = () => countItems(s, ORE);
    const freeSpace = () => 28 - (s.sdk.getInventory().length);
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    let ended = false, died = false;
    const life = pos()?.lifeId, respawns = pos()?.respawnCount ?? 0;
    void s.ended.then(() => { ended = true; });
    const over = () => used() >= CAP || ended || died || !!damage || !!requestedStop;

    let hp0 = hp();
    let hpMin = hp0;
    const off = s.onTick(() => {
        if (hp0 > 0) hpMin = Math.min(hpMin, hp());
        const p = pos();
        if (p?.isDead || (p?.respawnCount ?? 0) > respawns || (life !== undefined && p?.lifeId !== life)) died = true;
    });

    let oreWaitTicks = 0, stop = 'cap';
    const initialOre = oreCount();
    const xp0 = s.sdk.getSkillXp('mining') ?? 0;
    let mined = 0, banked = 0, bankTrips = 0, walkTicks = 0, tries = 0;

    const counters = () => `mined=${mined} banked=${banked} held=${oreCount()} bankTrips=${bankTrips} walkTicks=${walkTicks} hpMin=${hpMin}`;

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
        const n = oreCount();
        if (n === 0) return;
        await walk(BANK_SPOT.x, BANK_SPOT.z, 2);
        if(damage||requestedStop||ended||died)return;
        const b = await s.bot.openBank();
        if (!b.success) {
            console.log(`WARN openBank failed: ${b.message}`);
            await waitTicks(s, 2);
            return;
        }
        for (const id of new Set(s.sdk.getInventory().filter(i => ORE.test(i.name)).map(i => i.id))) {
            const item = s.sdk.getInventory().find(i => i.id === id);
            if(item) await s.bot.depositItem(item, -1);
        }
        await waitTicks(s, 1);
        const after = oreCount();
        banked += n - after;
        bankTrips++;
        if(!damage&&!requestedStop)await bankCargo(s, [ORE]);
        await s.bot.closeInterface();
        await waitTicks(s, 1);
        console.log(`MILESTONE bank t=${used()} banked=${banked} totalMined=${mined}`);
    };

    const safetyExit=async(reason:string):Promise<never>=>{
        safetyStarted=true;
        offDamage();
        if(died||requestedStop==='died'){off();return finish([s],false,`died=true ${counters()} stop=safety`);}
        const recovered=await retreatOre(s,BANK_SPOT,ORE,()=>ended||died);
        banked+=recovered.banked;
        console.log('ORE_RECOVERY '+JSON.stringify({...recovered,reason,damage:damage??null,initialOre,mined,hpMin}));
        off();
        return finish([s],false,`no ore progress: ${reason}; mining blocked after safety cleanup ${counters()} recovered=${recovered.banked} stop=safety`);
    };
    cleanup=safetyExit;

    console.log(`START ore gatherer ${botName} at=${pos()?.worldX},${pos()?.worldZ}`);
    if(damage||requestedStop||hp()<(s.sdk.getSkill('Hitpoints')?.baseLevel??hp())||Number(process.env.MAX_TRIPS)===0)
        await safetyExit(damage?'damage':requestedStop||'owned-load recovery');
    if ((pos()?.worldZ ?? 0) < 3330 && !s.sdk.getInventory().some(i=>/pickaxe$/i.test(i.name))) {
        // Bob sells the bronze pickaxe for one coin. Bootstrap here before heading north.
        await walk(3222,3218,3);
        for(let i=0;i<8 && countItems(s,/^coins$/i)<2;i++) {
            if(hp()<5) throw new Error('low HP during pickaxe bootstrap');
            await s.bot.pickpocketNpc(/^man$/i);
        }
        await walk(3231,3203,2);
        const shop=await s.bot.openShop(/^bob$/i);
        if(!shop.success) throw new Error(`Bob bootstrap: ${shop.message}`);
        const buy=await s.bot.buyFromShop(/^bronze pickaxe$/i,1);
        await s.bot.closeShop();
        if(!buy.success) throw new Error(`bronze pickaxe bootstrap: ${buy.message}`);
        console.log(`MILESTONE pickaxe bootstrap t=${used()} hp=${hp()}`);
    }
    if ((pos()?.worldZ ?? 0) < 3330) {
        for (const [x,z] of [[3242,3248],[3255,3295],[3255,3330],[3285,3348]]) {
            if (!(await walk(x!,z!,3))) throw new Error(`cannot reach safe mine approach ${x},${z}`);
        }
    }
    // Keep a ready miner at the mine. Only visit storage for junk or a missing tool.
    if (s.sdk.getInventory().some(i=>!/pickaxe$|^(shrimps|bread|trout|salmon)$/i.test(i.name)) ||
        !s.sdk.getInventory().some(i=>/pickaxe$/i.test(i.name))) {
    await walk(BANK_SPOT.x, BANK_SPOT.z, 2);
    const opened = await s.bot.openBank();
    if (!opened.success) throw new Error(`initial bank: ${opened.message}`);
    // Deposit-all clears every slot of that ID. Repeating stale slot entries waits on absent items.
    const junkIds=new Set(s.sdk.getInventory().filter(i=>!/pickaxe$|^(shrimps|bread|trout|salmon)$/i.test(i.name)).map(i=>i.id));
    const oreBeforeInitialBank = oreCount();
    for(const id of junkIds) {
        const item=s.sdk.getInventory().find(i=>i.id===id);
        if(item) await s.bot.depositItem(item,-1);
    }
    banked += oreBeforeInitialBank - oreCount();
    if (!s.sdk.getInventory().some(i=>/pickaxe$/i.test(i.name))) {
        await s.bot.withdrawItem(/pickaxe$/i, 1);
        if (!s.sdk.getInventory().some(i=>/pickaxe$/i.test(i.name))) await s.bot.withdrawItem(/^coins$/i, 25);
    }
    await s.bot.closeBank();
    }
    if (!s.sdk.getInventory().some(i=>/pickaxe$/i.test(i.name))) {
        console.log('MILESTONE recover pickaxe from Bob');
        const world = await getWorld();
        const there = await goTo(s, world, { x:3231,z:3203,level:0 }, accountOf(s));
        if (!there.ok) throw new Error(`Bob route: ${there.detail}`);
        const shop = await s.bot.openShop(/^bob$/i);
        if (!shop.success) throw new Error(`Bob shop: ${shop.message}`);
        const buy = await s.bot.buyFromShop(/^bronze pickaxe$/i,1);
        await s.bot.closeShop();
        if (!buy.success) throw new Error(`bronze pickaxe: ${buy.message}`);
        const back = await goTo(s,world,{x:BANK_SPOT.x,z:BANK_SPOT.z,level:0},accountOf(s));
        if (!back.ok) throw new Error(`return from Bob: ${back.detail}`);
    }

    if(damage||requestedStop)await safetyExit(damage?'damage':requestedStop);
    while (!over() && bankTrips < Number(process.env.MAX_TRIPS ?? Infinity)) {
        if (oreStalled(oreWaitTicks, NO_ORE_TICKS)) { stop = 'no-progress'; break; }
        if (oreCount() >= BANK_AT || (oreCount() > 0 && freeSpace() === 0)) {
            await bank();
            continue;
        }

        const p = pos();
        if (!p) { await waitTicks(s, 1); continue; }
        if (hp() < 7) {
            const food = s.sdk.getInventory().find(i=>/^(shrimps|bread|trout|salmon)$/i.test(i.name));
            if (food) await s.bot.eatFood(food.name);
            else if (hp() < 4) throw new Error('low HP: no food');
        }

        // Walk to mine if far away
        if (Math.max(Math.abs(p.worldX - MINE_SPOT.x), Math.abs(p.worldZ - MINE_SPOT.z)) > 15) {
            await walk(MINE_SPOT.x, MINE_SPOT.z, 3);
            continue;
        }

        const attempt = tries++;
        const rock = selectRock(s.sdk.getState()?.nearbyLocs ?? [], s.sdk.getSkill('Mining')?.level ?? 1, attempt, p.level, PROFILE);
        if (!rock) {
            const a = s.tick(); await waitTicks(s, 2); oreWaitTicks += s.tick() - a;
            continue;
        }
        if (s.sdk.getState()?.dialog?.isOpen || s.sdk.getState()?.modalOpen)
            await s.direct({ type: 'closeModal', reason: 'SDK' });
        const r = await mineRock(s, rock, over, Math.min(60, NO_ORE_TICKS - oreWaitTicks), ORE);
        if (r.reason === 'mined') { mined += r.ore; oreWaitTicks = 0; }
        else {
            console.log(`WARN mine attempt=${attempt} rock=${rock.id}@${rock.x},${rock.z} players=${s.sdk.getState()?.nearbyPlayers.length ?? 0} reason=${r.reason} ticks=${r.ticks} observedOre=${r.ore} observedXp=${r.xp}`);
            oreWaitTicks += r.ticks;
            // Avoid a zero-tick rejected-action loop while still noticing newly respawned rocks promptly.
            const a = s.tick(); await waitTicks(s, 1); oreWaitTicks += s.tick() - a;
        }
    }

    if(damage||requestedStop)await safetyExit(damage?'damage':requestedStop);
    if (!ended && !died) await bank();
    if(damage||requestedStop)await safetyExit(damage?'damage':requestedStop);
    if (bankTrips >= Number(process.env.MAX_TRIPS ?? Infinity) && stop !== 'no-progress') stop = 'max-trips';
    off();
    offDamage();
    let softClay: Awaited<ReturnType<typeof runSoftenClay>> | undefined;
    if (PROFILE === 'clay' && process.env.SOFTEN_CLAY === '1' && !ended && !died && stop !== 'no-progress') softClay = await runSoftenClay(s, { cap: Math.max(1, CAP - used()), maximum: Number(process.env.MAX_MAKE ?? 20), reserve: Number(process.env.RAW_RESERVE ?? 0) });
    const total = banked + oreCount();
    const perK = (mined * 1000 / Math.max(1, used())).toFixed(2);
    await finish([s], total > 0 && oreCount() === 0 && !died && !ended && !requestedStop && !damage && stop !== 'no-progress' && (softClay?.ok ?? true), `ticks=${used()} died=${died} ${counters()} profile=${PROFILE} softMade=${softClay?.made ?? 0} softBanked=${softClay?.banked ?? 0} softPreserved=${softClay?.preserved ?? true} initialOre=${initialOre} recovered=${total} xpGain=${(s.sdk.getSkillXp('mining') ?? 0) - xp0} stop=${stop} ${requestedStop} oreWaitTicks=${oreWaitTicks} ${stop === 'no-progress' ? 'no ore progress: bounded mining wait exhausted' : ''} ${softClay && !softClay.ok ? `no soft clay progress: ${softClay.failure}` : ''} orePer1kTicks=${perK}`);
} catch (e) {
    offDamage();
    if(cleanup&&!safetyStarted&&(damage||requestedStop))await cleanup(damage?'damage':requestedStop);
    await finish([s], false, String(e));
}

}
if (import.meta.main) await main();
