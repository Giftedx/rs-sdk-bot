// Gold farm: pickpocket knights of Ardougne at Thieving 99, bank coins and refill lobsters at the south bank.
// Game data (skill_thieving/configs/pickpocking/pickpocket.dbrow:81-90): knight of Ardougne, success 50..240 of 256
// (94% at 99), 50 coins, stun 8 ticks, fail damage 3. Model: about 18.8 coins per tick at level 99.
// Knights spawn at (2652,3318) and (2653,3300) and wander. Bank spot (2654,3283), bankers at (2657,3280-3286).
// Env: TICKS (default 9000) game ticks; BANK_AT (default 25000) coins in the pack that start a bank trip;
// FOOD_FROM=<account>: with no bank food (trout, salmon, lobster) in the pack or the bank, serve one trade from that
// account (180 s) first. FOOD_ONLY_TRADE=1: never use the stall or the shop; when the pack and the bank run out of
// food, serve one more trade from FOOD_FROM at the bank, and end the run (log out) when none comes.
// CURIER_FOOD_WAKE=1: also meet that owned supplier's fresh food notes at the south bank,20s/120tick cooldown.
// Bank food: cooked trout (heals 7) and salmon (9) from scripts/fishcook.ts come before lobsters (12) on withdraw.
// Food fallback: with no lobsters in the pack or the bank, steal from the Ardougne baker's stall until the pack holds
// STALL_FILL (default 10) food items. Rules (skill_thieving stealing.rs2:98-121, thieving.rs2:53-73): an ardougne_guard
// within 5 tiles of the player with line of sight shouts and attacks; the Baker (baker_merchant) within 5 tiles with
// line of sight refuses the steal, without damage. After a steal, any talk or trade with the Baker in the next 1500
// ticks calls the guards (area_ardougne_east/scripts/baker.rs2), so this script never talks to him.
// Loot (stealing.dbrow): cake 13/20, bread 5/20, chocolate slice 2/20; respawn 8 ticks. A cake eats in 3 bites.
// Preset goldfarm_knights (goldfarm_nofood for the stall). Copies the 2-tick direct click and eating inside the stun from scripts/generated/thieving60.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openBot, finish, randomEventsOf, serverFromEnv } from '../packages/core/src/bot';
import { walkTargetPersist } from './walk-to';
import { depositPack } from '../packages/core/src/deposit';
import { waitTicks } from '../packages/core/src/ticks';
import type {Session} from '../packages/core/src/inprocess';
import {ownedAccounts} from '../packages/core/src/tradeguard';
import { receiveHandoff } from './courier-handoff';

const COOKED_IDS=new Set([329,333,379,330,334,380,385,386]),NOTED_COOKED_IDS=new Set([330,334,380,386]);
export function incomingCookedFood(before:readonly {id:number;count:number}[],after:readonly {id:number;count:number}[]){
    const count=(rows:typeof before,id:number)=>rows.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    return [...COOKED_IDS].reduce((n,id)=>n+Math.max(0,count(after,id)-count(before,id)),0);
}
export function courierFoodReady(status:any,from:string,server:string,owned:ReadonlySet<string>,now=Date.now(),tick=0,lastAttempt=-120){
    return /^[A-Za-z0-9_ -]{1,12}$/.test(from)&&owned.has(from.toLowerCase())&&typeof status?.name==='string'&&status.name.toLowerCase()===from.toLowerCase()
        &&status.server===server&&!status.result&&Number.isFinite(status.at)&&now-status.at>=0&&now-status.at<30000
        &&tick-lastAttempt>=120&&status.pos?.level===0&&Math.max(Math.abs(status.pos.x-2654),Math.abs(status.pos.z-3283))<=8
        &&Array.isArray(status.inventory)&&status.inventory.some((i:any)=>NOTED_COOKED_IDS.has(i.id)&&Number.isSafeInteger(i.count)&&i.count>0);
}
// Reused by normal empty-food service and the opt-in short proactive rendezvous.
export async function receiveFoodAtBank(s:Session,from:string,timeout:number,refill:()=>Promise<void>,available:()=>boolean,until?:()=>boolean,server?:string){
    if(!/^[A-Za-z0-9_ -]{1,12}$/.test(from))throw Error('invalid configured food supplier');
    // Earnings add a coin stack after the last refill. Bank it before the
    // two-species delivery so the reserved two inventory slots are available.
    await refill();
    const before=s.sdk.getInventory().map(i=>({...i})),start=s.tick();
    const serve=()=>s.bot.serveTrades({from:new RegExp(`^${from}$`,'i'),maxTrades:1,timeout,until});
    const result=server?await receiveHandoff(s,from,server,serve):await serve();
    const ticks=s.tick()-start,incoming=incomingCookedFood(before,s.sdk.getInventory());
    if(s.tick()===start)await waitTicks(s,1);
    await refill();return{incoming,available:available(),ticks,reason:result.reason,message:result.message};
}

type Tile = { x: number; z: number };
// KNIGHT_SPOT=x,z gives each farmer its own knights (spawns 2652,3318 2653,3300 2669,3298 2671,3313 2582,3297,
// npcs.json): three farmers on one spot made 10.5-12.1 coins a tick against the 18.8 model.
const KNIGHT_SPOT: Tile = (() => { const m = (process.env.KNIGHT_SPOT ?? '').match(/^(\d+),(\d+)$/); return m ? { x: Number(m[1]), z: Number(m[2]) } : { x: 2653, z: 3302 }; })();
const BANK_SPOT: Tile = { x: 2654, z: 3283 };
const KNIGHT = /^knight of ardougne$/i;
const RANGE = 16;
const LOBSTER = /^lobster$/i;
// Bank food in withdraw order: the food chain's cooked fish first (research/food-chain.md), then lobsters and sharks,
// then the stall food that an earlier run banked. The bank is out of food only when it holds none of these.
const BANK_FOOD = [/^trout$/i, /^salmon$/i, LOBSTER, /^shark$/i, /^cake$/i, /^2\/3 cake$/i, /^slice of cake$/i, /^bread$/i, /^chocolate slice$/i];
const BIG = /^(trout|salmon|lobster|shark)$/i;
const FOOD_ONLY_TRADE = process.env.FOOD_ONLY_TRADE === '1';
const COINS = /^coins$/i;
const TICKS = Number(process.env.TICKS ?? 9000);
const BANK_AT = Number(process.env.BANK_AT ?? 25000);
const FOOD_FROM = process.env.FOOD_FROM?.trim() || '';
const KEEP_FREE = 2;
const STALL_FILL = Number(process.env.STALL_FILL ?? 10);
const STALL_SPOT: Tile = { x: 2655, z: 3310 };
const STALL = /^baker'?s stall$/i;
const GUARD = /^guard$/i;
const BAKER = /^baker$/i;
const GUARD_SAFE = 6;
// Food types and HP per bite (cake pieces 4, chocolate slice 2, bread 5, trout 7, salmon 9, lobster 12).
export const FOOD_ORDER = [/^slice of cake$/i, /^2\/3 cake$/i, /^cake$/i, /^chocolate slice$/i, /^bread$/i, /^trout$/i, /^salmon$/i, LOBSTER, /^shark$/i];
const HEAL = [4, 4, 4, 2, 5, 7, 9, 12, 20];
const DMG = 3;
// A thief with fewer than FRAIL_HP Hitpoints cannot take a guard's attack or a run of failed picks. Each goldfarm death
// in the run logs is an account with 10 or 11 Hitpoints that had no food at a stall or shop trip. Such a thief
// restocks while it still holds FRAIL_RESERVE food items, leaves the stall when a guard hits it, and ends the run
// when it holds fewer than FRAIL_FLOOR and the bank has none: no stall trip and no pick with no food.
export const FRAIL_HP = 20, FRAIL_RESERVE = 6, FRAIL_FLOOR = 2;
// The food count under which a thief restocks.
export const foodReserve = (maxHp: number) => maxHp < FRAIL_HP ? FRAIL_RESERVE : FRAIL_FLOOR;
// Hitpoints fell in a pass with no pick of the thief's own: a guard hit it.
export const guardHit = (before: number, after: number, picked: boolean) => after < before && !picked;
// Ticks a frail thief stays away from the stall after a guard hit it.
const STALL_REST = 200;
// Click cadence in ticks. A click inside the pick's action delay is queued again by the server (p_opnpc(3),
// pickpocket.rs2:134-137), so a 1-tick cadence costs nothing and re-paths to a knight that stepped away a tick sooner.
const PICK_TICKS = Number(process.env.PICK_TICKS ?? 2);

if(import.meta.main){
console.log(`ERR-TRACE opening ${process.argv[2]}`);
console.log(`KNIGHT_SPOT ${KNIGHT_SPOT.x},${KNIGHT_SPOT.z}`);
const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
const foodWake=process.env.CURIER_FOOD_WAKE==='1';
const farmServer=FOOD_FROM?serverFromEnv(readFileSync(join(import.meta.dir,'../vendor/rs-sdk/bots',s.name,'bot.env'),'utf8')):'';
try {
    await waitTicks(s, 5);
    // Farm only where the knights are. From elsewhere the world walker, which avoids deadly hunters (danger.ts),
    // takes the bot to the south bank first; a hand-made Lumbridge-Ardougne walk killed mmtha0205 near 2906,3375.
    // From Varrock it has no westbound land route (live: "no route to 2654,3283,0"), so the walk takes the ferry fallback.
    const p0 = s.sdk.getState()?.player;
    if (!p0 || Math.max(Math.abs(p0.worldX - 2655), Math.abs(p0.worldZ - 3300)) > 60) {
        const there = await walkTargetPersist(s, { x: 2654, z: 3283, level: 0 }) as { ok: boolean; reason?: string; detail?: string };
        if (!there.ok) await finish([s], false, `travel to Ardougne from ${p0?.worldX},${p0?.worldZ} failed: ${there.reason} ${there.detail}`);
    }
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const maxHp = () => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    const inv = () => st()?.inventory ?? [];
    const edible = (i: any) => BIG.test(i.name) && (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text));
    const bigFood = () => inv().filter(edible).reduce((n, i) => n + i.count, 0);
    const isFood = (i: any) => FOOD_ORDER.some(re => re.test(i.name)) && (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text));
    const food = () => inv().filter(isFood).reduce((n, i) => n + i.count, 0);
    const notes = () => inv().filter(i => BIG.test(i.name) && !edible(i));
    const coins = () => inv().filter(i => COINS.test(i.name)).reduce((n, i) => n + i.count, 0);
    const cheb = (a: Tile, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    // Eat with two failed picks of margin (a 10 HP thief at HP 3 has none); the bigger loss is a death, not a bite.
    const eatAt = () => Math.max(2 * DMG, maxHp() - 12);
    const frail = () => maxHp() < FRAIL_HP, reserve = () => foodReserve(maxHp());
    let stallRestUntil = 0, stallFled = false;
    const t0 = s.tick();
    const now = () => s.tick() - t0;
    const coins0 = coins();
    const stopFile = `.practice/stop-${process.argv[2]}`;

    let picks = 0, noops = 0, fails = 0, eaten = 0, bankTrips = 0, bankTicks = 0, walkTicks = 0, idleTicks = 0, eatTicks = 0, banked = 0;
    let bankFails = 0, emptyTrips = 0, stallTrips = 0, stallTicks = 0, stolen = 0, refused = 0, stallEmptyTrips = 0, stallPickTicks = 0;
    const banned = new Map<number, number>();
    let noopRun = 0, noopTarget = -1, bans = 0, stunUntil = 0;
    let shopTrips = 0, shopTicks = 0, bought = 0, shopRetryAt = 0, lastSteal = -1_000_000;
    const stealFile = join(import.meta.dir, '..', '.practice', 'goldfarm', `steal-${process.argv[2]}.json`);
    let lastStealAt = 0;
    try { lastStealAt = JSON.parse(readFileSync(stealFile, 'utf8')).at ?? 0; } catch { /* no theft recorded */ }
    const saveSteal = () => { lastStealAt = Date.now(); try { mkdirSync(dirname(stealFile), { recursive: true }); writeFileSync(stealFile, JSON.stringify({ at: lastStealAt })); } catch { /* best effort */ } };
    let hpMin = hp(), died = false, bankEmpty = false, warned = false, lastFail = '';
    // A dropped session freezes s.tick(), so now() never reaches TICKS: without this the loop spins on the dead
    // session at full CPU, finish() never prints RESULT, and the stale status row blocks every login on the side.
    let ended = '';
    void s.ended.then(e => { ended = e.reason || 'ended'; });
    let last = pos();
    const off = s.onTick(() => {
        const p = pos();
        hpMin = Math.min(hpMin, hp());
        if ((s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0) > 0 && hp() <= 0) died = true;
        // A respawn moves the player far in one tick.
        if (p && last && cheb({ x: last.worldX, z: last.worldZ }, p) > 20) died = true;
        last = p;
    });

    const end = async (ok: boolean, why: string): Promise<never> => {
        off();
        const ticks = now();
        const gained = banked + coins() - coins0;
        const p = pos();
        const detail = `ticks=${ticks} picks=${picks} fails=${fails} noops=${noops} bans=${bans} coinsGained=${gained} coinsPerTick=${(gained / Math.max(1, ticks)).toFixed(2)} `
            + `eaten=${eaten} bankTrips=${bankTrips} bankTicks=${bankTicks} walkTicks=${walkTicks} idleTicks=${idleTicks} eatTicks=${eatTicks} stallTrips=${stallTrips} stallTicks=${stallTicks} stallPickTicks=${stallPickTicks} stolen=${stolen} refused=${refused} shopTrips=${shopTrips} shopTicks=${shopTicks} bought=${bought} `
            + `foodTicksPct=${(100 * (bankTicks + stallTicks + shopTicks + eatTicks) / Math.max(1, ticks)).toFixed(1)} `
            + `hpMin=${hpMin} died=${died} banked=${banked} packCoins=${coins()} bigFood=${bigFood()} food=${food()} tradesIn=${tradesIn} tradeTicks=${tradeTicks} hp=${hp()} at=${p?.worldX},${p?.worldZ},${p?.level}`;
        return finish([s], ok, ok ? detail : `${why} ${detail} last=${lastFail}`);
    };

    const eat = async (): Promise<boolean> => {
        const e0 = s.tick();
        // The biggest food that the HP loss uses in full (no heal wasted), else the smallest food.
        const items = inv().filter(isFood);
        const rank = (i: any) => FOOD_ORDER.findIndex(re => re.test(i.name));
        items.sort((a, b) => rank(a) - rank(b));
        const loss = maxHp() - hp();
        const pick = [...items].reverse().find(i => (HEAL[rank(i)] ?? 99) <= loss) ?? items[0];
        // Every failure waits a tick: callers loop on "HP low and food() > 0", and an instant false return spun the
        // event loop forever (practice proof hung at t=1003 and grew to 2.6 GB).
        if (!pick) { lastFail = 'eat: no edible item'; await waitTicks(s, 1); return false; }
        const r = await s.bot.eatFood(pick);
        eatTicks += s.tick() - e0;
        if (r.success) eaten++;
        else { lastFail = `eat:${r.message}`; if (s.tick() === e0) await waitTicks(s, 1); }
        return r.success;
    };

    const walk = async (t: Tile, tol: number) => {
        const w0 = s.tick();
        for (let i = 0; i < 3 && !died; i++) {
            const p = pos();
            if (p && cheb(t, p) <= tol + 1) break;
            const r = await s.bot.walkTo(t.x, t.z, tol);
            if (!r.success) lastFail = `walk:${r.message}`;
        }
        walkTicks += s.tick() - w0;
    };

    // Bank trip: deposit every coin and every lobster note, withdraw unnoted lobsters to fill the pack less KEEP_FREE.
    // Sets bankEmpty when the bank holds no food of BANK_FOOD.
    const refill = async () => {
        bankTrips++;
        await walk(BANK_SPOT, 2);
        const b0 = s.tick();
        try {
            const o = await s.bot.openBank();
            if (!o.success) { lastFail = `bank:${o.message}`; if (++bankFails >= 3) bankEmpty = true; return; }
            const c = coins();
            if (c > 0) {
                const d = await s.bot.depositItem(COINS, -1);
                if (d.success) banked += d.amountDeposited ?? c;
                else lastFail = `deposit coins:${d.message}`;
            }
            for (const n of notes()) {
                const d = await s.bot.depositItem(n, -1);
                if (!d.success) lastFail = `deposit notes:${d.message}`;
            }
            // A pack filled by an earlier job (quest leftovers) leaves no room for food: bank all but coins and food.
            if (28 - inv().length - KEEP_FREE <= 0) await depositPack(s, i => /^coins$/i.test(i.name) || FOOD_ORDER.some(re => re.test(i.name)));
            const food0 = inv().length;
            // Cooked fish first, then lobsters, until the pack is full less KEEP_FREE.
            for (const re of BANK_FOOD) {
                const inBank = s.sdk.findBankItem(re);
                const room = 28 - inv().length - KEEP_FREE;
                if (!inBank || inBank.count <= 0 || room <= 0) continue;
                const w = await s.bot.withdrawItem(inBank, Math.min(room, inBank.count));
                if (!w.success) lastFail = `withdraw:${w.message}`;
            }
            const left = BANK_FOOD.reduce((n, re) => n + (s.sdk.findBankItem(re)?.count ?? 0), 0);
            bankEmpty = left === 0;
            // No bank food left: take 300 coins back for the Baker's shop (bread 12 coins); not with FOOD_ONLY_TRADE.
            const bankCoins = s.sdk.findBankItem(COINS);
            if (bankEmpty && !FOOD_ONLY_TRADE && coins() < 300 && bankCoins && bankCoins.count > 0) {
                const n = Math.min(300 - coins(), bankCoins.count);
                const w = await s.bot.withdrawItem(bankCoins, n);
                if (w.success) banked -= w.amountWithdrawn ?? n;
            }
            console.log(`BANK trip=${bankTrips} banked=${banked} bigFood=${bigFood()} bankFood=${left} t=${now()}`);
            // Three trips that bank no coins and take no food are a loop, not farming: stop and say so.
            emptyTrips = c > 0 || inv().length > food0 ? 0 : emptyTrips + 1;
            if (emptyTrips >= 3) await finish([s], banked > 0, `goldfarm no progress: ${emptyTrips} bank trips gained no coins or food; pack=${inv().length} bankFood=${left} ${lastFail}`);
            await s.bot.closeBank();
        } finally { bankTicks += s.tick() - b0; }
    };

    // FOOD_FROM: no bank food anywhere, so take notes by trade at the bank spot, then bank them. True when the pack
    // or the bank holds food afterwards.
    let lastTradeOk = true, tradeTicks = 0, tradesIn = 0,lastCourierAttempt=-120;
    const foodByTrade = async (timeout=180_000): Promise<boolean> => {
        console.log(`MILESTONE waiting for food trade from ${FOOD_FROM} t=${now()}`);
        await walk(BANK_SPOT, 2);
        const r=await receiveFoodAtBank(s,FOOD_FROM,timeout,refill,()=>food()>=2||!bankEmpty,undefined,farmServer);
        tradeTicks+=r.ticks;
        console.log(`TRADE ${r.reason} ${r.message} incomingFood=${r.incoming} notes=${notes().reduce((n, i) => n + i.count, 0)} bigFood=${bigFood()} t=${now()}`);
        if(r.incoming>0)tradesIn++;
        lastTradeOk=r.available;
        return lastTradeOk;
    };

    // Stall trip: steal from a baker's stall from a side tile with no guard within GUARD_SAFE tiles (line of sight
    // ignored, one tile of margin). Tiles more than 5 tiles from the Baker go first; a refused tile rests for 6 ticks.
    const stallTrip = async () => {
        stallTrips++;
        const f0 = food();
        await walk(STALL_SPOT, 2);
        const s0 = s.tick();
        const badUntil = new Map<string, number>();
        const pick0 = stallPickTicks;
        const key = (t: Tile) => `${t.x},${t.z}`;
        const d = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
        let seen = hp(), picked = false;
        try {
            while (food() < STALL_FILL && 28 - inv().length > 0 && s.tick() - s0 < 400 && !died && now() < TICKS) {
                if (existsSync(stopFile)) return;
                // A guard that sees a steal attacks, and this loop does not fight or run. A frail thief takes one bite
                // when it is low, leaves at once and stays away for STALL_REST ticks; the main loop walks it to the bank.
                const hurt = guardHit(seen, hp(), picked); seen = hp(); picked = false;
                if (frail() && hurt) {
                    console.log(`STALL left: a guard hit, hp=${hp()} food=${food()} t=${now()}`);
                    if (hp() <= eatAt() && food() > 0) await eat();
                    stallRestUntil = s.tick() + STALL_REST; stallFled = true;
                    break;
                }
                if (randomEventsOf(s)?.busy()) { await waitTicks(s, 1); continue; }
                if (hp() <= eatAt() && food() > 0) { await eat(); continue; }
                const npcs = (st()?.nearbyNpcs ?? []) as any[];
                const guards = npcs.filter(n => GUARD.test(n.name)).map(n => ({ x: n.x, z: n.z }));
                const bakers = npcs.filter(n => BAKER.test(n.name)).map(n => ({ x: n.x, z: n.z }));
                const locs = (st()?.nearbyLocs ?? []) as any[];
                const blocked = new Set<string>();
                for (const l of locs) if (/stall/i.test(l.name)) for (const dx of [0, 1]) for (const dz of [0, 1]) blocked.add(key({ x: l.x + dx, z: l.z + dz }));
                const me = pos();
                if (!me) { await waitTicks(s, 1); continue; }
                const here = { x: me.worldX, z: me.worldZ };
                const opts: { tile: Tile; loc: any; score: number }[] = [];
                for (const l of locs) {
                    if (!STALL.test(l.name) || !(l.options ?? []).some((o: string) => /steal/i.test(o))) continue;
                    const o = { x: l.x, z: l.z };
                    const sides = [{ x: o.x - 1, z: o.z }, { x: o.x - 1, z: o.z + 1 }, { x: o.x + 2, z: o.z }, { x: o.x + 2, z: o.z + 1 },
                        { x: o.x, z: o.z - 1 }, { x: o.x + 1, z: o.z - 1 }, { x: o.x, z: o.z + 2 }, { x: o.x + 1, z: o.z + 2 }];
                    for (const t of sides) {
                        if (blocked.has(key(t)) || (badUntil.get(key(t)) ?? 0) > s.tick()) continue;
                        if (guards.some(g => d(g, t) <= GUARD_SAFE)) continue;
                        const bakerD = Math.min(99, ...bakers.map(b => d(b, t)));
                        opts.push({ tile: t, loc: l, score: (bakerD > 5 ? 0 : 100 - bakerD * 10) + d(t, here) });
                    }
                }
                // No safe tile (guards wander the market): pickpocket a knight close by instead of waiting.
                if (opts.length === 0) {
                    const k = npcs.some(n => KNIGHT.test(n.name) && d({ x: n.x, z: n.z }, here) <= 6);
                    // Keep two failed picks of margin: with no food, a pick at HP 4 left mmtha0205 at 1 and it died
                    // (live 09:05, after the shop and the stall both gave 0). The main loop's floor is 6 too.
                    // A frail thief does not pick with its food under the floor: a failed pick then has no bite to answer it.
                    if (k && hp() > 2 * DMG && !(frail() && food() < FRAIL_FLOOR)) { const k0 = s.tick(); picked = true; await steal(6); stallPickTicks += s.tick() - k0; }
                    else { idleTicks++; await waitTicks(s, 1); }
                    continue;
                }
                opts.sort((a, b) => a.score - b.score);
                const best = opts[0]!;
                if (d(best.tile, here) > 0) {
                    await s.bot.walkTo(best.tile.x, best.tile.z, 0, { timeout: 8000 });
                    const p = pos();
                    if (!p || p.worldX !== best.tile.x || p.worldZ !== best.tile.z) badUntil.set(key(best.tile), s.tick() + 30);
                    continue; // Check the guards again from the new tile.
                }
                const op = best.loc.optionsWithIndex.find((o: any) => /steal/i.test(o.text))?.opIndex ?? 2;
                const before = food();
                await s.direct({ type: 'interactLoc', x: best.loc.x, z: best.loc.z, locId: best.loc.id, optionIndex: op, reason: 'SDK' } as any);
                let got = false;
                for (let i = 0; i < 3 && !got; i++) { await waitTicks(s, 1); got = food() > before; }
                if (got) { stolen++; lastSteal = s.tick(); saveSteal(); }
                else { refused++; badUntil.set(key(best.tile), s.tick() + 6); }
            }
        } finally {
            stallTicks += s.tick() - s0 - (stallPickTicks - pick0);
            if (food() <= f0) stallEmptyTrips++; else stallEmptyTrips = 0;
            console.log(`STALL trip=${stallTrips} food=${food()} stolen=${stolen} refused=${refused} t=${now()}`);
        }
    };

    // Shop trip: buy bread, cake and chocolate slices from the Baker (shop 'bakery': bread 10, restock 1 per 100 ticks;
    // cake 3, 1 per 800; chocolate slice 8, 1 per 200; knowledge/shops.json). Never within 1500 ticks of a stall steal:
    // the Baker then calls the guards (area_ardougne_east/scripts/baker.rs2). Buy clicks go straight to the client,
    // at most 5 per tick (copied from scripts/generated/thieving60.ts).
    const SHOP_FOOD = /^(bread|cake|chocolate slice)$/i;
    // The Baker calls the guards for 1,500 ticks after a stall theft (baker.rs2). The last theft is kept in a file, so a
    // restart remembers it: three farmers died walking into the shop right after a restart. The live
    // shop was empty on every trip that day (bought=0), so live runs skip it unless SHOP=1.
    const shopOk = () => (process.env.SHOP === '1' || process.env.DEMO_OK !== '1')
        && Date.now() - lastStealAt > (1500 + 20) * 400 && s.tick() - lastSteal > 1500 + 20 && s.tick() >= shopRetryAt && coins() >= 12;
    const shopTrip = async () => {
        shopTrips++;
        const before = food();
        await walk(STALL_SPOT, 3);
        const q0 = s.tick();
        try {
            const o = await s.bot.openShop(BAKER);
            if (!o.success) { lastFail = `shop:${o.message}`; shopRetryAt = s.tick() + 100; return; }
            let free = 28 - inv().length - 1;
            let money = coins();
            let sent = 0;
            for (const item of st()?.shop?.shopItems ?? []) {
                if (!SHOP_FOOD.test(item.name) || item.count <= 0) continue;
                const price = Math.max(1, item.buyPrice || 12);
                let n = Math.min(item.count, free, Math.floor(money / price));
                free -= n; money -= n * price;
                for (const chunk of [10, 5, 1]) {
                    while (n >= chunk) {
                        await s.direct({ type: 'shopBuy', slot: item.slot, amount: chunk, reason: 'SDK' } as any);
                        n -= chunk;
                        if (++sent % 5 === 0) await waitTicks(s, 1);
                    }
                }
                if (free <= 0) break;
            }
            await waitTicks(s, 1);
            await s.direct({ type: 'closeShop', reason: 'SDK' } as any);
            const got = food() - before;
            bought += Math.max(0, got);
            // An empty shelf restocks 1 bread per 100 ticks: do not come back before some has returned.
            if (got < 2) shopRetryAt = s.tick() + 100;
        } finally {
            shopTicks += s.tick() - q0;
            console.log(`SHOP trip=${shopTrips} food=${food()} bought=${bought} t=${now()}`);
        }
    };

    // Inside the 8-tick stun the bot cannot pickpocket or walk, but it can eat for free.
    const onStun = async () => {
        if (food() > 0 && hp() <= eatAt()) { await eat(); return; }
        await waitTicks(s, 1);
    };

    // One pickpocket attempt on the closest knight near the player, or a walk or wait when none is in range.
    const steal = async (range = RANGE) => {
        const p = pos();
        const avoid = randomEventsOf(s)?.avoid().npcs;
        const npc = (st()?.nearbyNpcs ?? [])
            // An unreachable target gets no packet at all (vendor/rs-sdk/CLAUDE.md "Everything succeeds and nothing
            // happens"): seen as 93-tick runs of noops at (2650,3300). Skip it, and rest a knight 15 ticks
            // after 3 noops in a row on it.
            .filter((n: any) => KNIGHT.test(n.name) && n.reachable !== false && (banned.get(n.index) ?? 0) <= s.tick()
                && !avoid?.has(n.index) && (!p || Math.max(Math.abs(n.x - p.worldX), Math.abs(n.z - p.worldZ)) <= range))
            .sort((a: any, b: any) => a.distance - b.distance)[0] as any;
        if (!npc) {
            if (range === RANGE && p && cheb(KNIGHT_SPOT, p) > RANGE) await walk(KNIGHT_SPOT, 3);
            else { idleTicks++; await waitTicks(s, 1); }
            return;
        }
        const op = npc.optionsWithIndex.find((o: any) => /pickpocket/i.test(o.text))?.opIndex;
        if (op === undefined) { idleTicks++; await waitTicks(s, 1); return; }
        const hp0 = hp(), c0 = coins();
        await s.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: op, reason: 'SDK' } as any);
        await waitTicks(s, PICK_TICKS);
        // picks = attempts the server ran (coins or a hit); a click it dropped (inside a stun, or still walking) is a noop.
        if (hp() < hp0) { picks++; fails++; noopRun = 0; stunUntil = s.tick() + 8; await onStun(); }
        else if (coins() > c0) { picks++; noopRun = 0; }
        else if (s.tick() <= stunUntil) noops++;
        else {
            noops++;
            noopRun = noopTarget === npc.index ? noopRun + 1 : 1;
            noopTarget = npc.index;
            if (noopRun >= 3) { banned.set(npc.index, s.tick() + 15); noopRun = 0; bans++; }
        }
    };

    console.log(`GOLDFARM ticks=${TICKS} pickTicks=${PICK_TICKS} eatAt=${eatAt()} maxHp=${maxHp()} bigFood=${bigFood()} notes=${notes().length} coins=${coins0} foodFrom=${FOOD_FROM || '-'}`);
    // Start: notes in the pack, or no food, means a bank visit first.
    if (bigFood() < 2 || notes().length > 0) {
        await refill();
        if (bigFood() === 0 && bankEmpty && FOOD_FROM) await foodByTrade();
    }

    let nextMark = 1000;
    while (now() < TICKS && !died && !ended) {
        if (existsSync(stopFile)) await end(false, 'stop file');
        if (now() >= nextMark) { console.log(`MILESTONE t=${now()} banked=${banked} packCoins=${coins()} bigFood=${bigFood()} food=${food()} picks=${picks} fails=${fails} eaten=${eaten}`); nextMark += 1000; }
        if (randomEventsOf(s)?.busy()) { idleTicks++; await waitTicks(s, 1); continue; }
        const l = food(), low = l < reserve();
        if (hp() <= eatAt() && l > 0) { if (!(await eat())) await waitTicks(s, 1); continue; }
        if(foodWake&&/^[A-Za-z0-9_ -]{1,12}$/.test(FOOD_FROM)&&(l>=2||!bankEmpty)){
            let courier:any;try{courier=JSON.parse(readFileSync(join(import.meta.dir,'../.practice/status',`${FOOD_FROM}.json`),'utf8'));}catch{/* no current courier observation */}
            if(courierFoodReady(courier,FOOD_FROM,farmServer,ownedAccounts(farmServer),Date.now(),s.tick(),lastCourierAttempt)){
                lastCourierAttempt=s.tick();await foodByTrade(20_000);await walk(KNIGHT_SPOT,3);continue;
            }
        }
        if ((bigFood() < 2 && low && !bankEmpty) || coins() >= BANK_AT || notes().length > 0) {
            await refill();
            await walk(KNIGHT_SPOT, 3);
            continue;
        }
        // FOOD_ONLY_TRADE: no stall, no shop (both killed farmers live). Out of food, serve one more trade
        // from FOOD_FROM when the last one brought food; else log out with HP to spare. A frail thief does the same
        // with its food under the floor, whatever the setting.
        if (l < FRAIL_FLOOR && bankEmpty && (FOOD_ONLY_TRADE || frail())) {
            if (FOOD_FROM && lastTradeOk && (await foodByTrade())) { await walk(KNIGHT_SPOT, 3); continue; }
            await end(false, FOOD_ONLY_TRADE ? 'no food (FOOD_ONLY_TRADE)' : `no food (frail: ${maxHp()} Hitpoints)`);
        }
        // Bank out of food: the Baker's shop when allowed, else the stall unless 3 trips in a row brought nothing. A
        // frail thief goes while it still holds food (its reserve), and not while it rests after a guard hit.
        if (low && bankEmpty && s.tick() >= stallRestUntil && (shopOk() || stallEmptyTrips < 3)) {
            if (shopOk()) await shopTrip();
            if (food() < reserve() && stallEmptyTrips < 3) await stallTrip();
            await walk(stallFled ? BANK_SPOT : KNIGHT_SPOT, 3);
            stallFled = false;
            continue;
        }
        if (l === 0) {
            if (!warned) { console.log(`WARN no food in the pack, the bank or the stall; picking on while HP > 6`); warned = true; }
            if (hp() <= 6) await end(false, 'no food');
        }
        if (hp() <= DMG) { idleTicks++; await waitTicks(s, 1); continue; }
        await steal();
    }
    await end(!died && !ended, died ? 'died' : ended ? `session ended: ${ended}` : 'ticks');
} catch (e) { await finish([s], false, String(e)); }
}
