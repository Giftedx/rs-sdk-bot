// Gold farm: pickpocket knights of Ardougne at Thieving 99, bank coins and refill food at the south bank.
// Food comes from owned bank stock and the courier. Bakery recovery caused repeated live deaths.
// Eating at 4 HP leaves room for one knight stun hit of 3 while reducing overheal.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBot, finish, randomEventsOf, serverFromEnv, sessionDied } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import type { Session } from '../packages/core/src/inprocess';
import { depositObserved } from '../packages/core/src/deposit';
import { receiveHandoff } from './courier-handoff';
import { ownedAccounts } from '../packages/core/src/tradeguard';
import { courierFoodReady, receiveFoodAtBank } from './goldfarm';
import {pendingCourierFunding,serviceCourierFunding} from './courier-funding';

export type Tile = { x: number; z: number };
export const KNIGHT_SPOT: Tile = { x: 2653, z: 3302 };
export const BANK_SPOT: Tile = { x: 2654, z: 3283 };

export const KNIGHT = /^knight of ardougne$/i;
export const COINS = /^coins$/i;

export const RANGE = 16;
type FarmNpc = { index: number; name: string; x: number; z: number; distance: number; reachable?: boolean; optionsWithIndex: readonly { text: string; opIndex: number }[] };
export function farmPickTarget<T extends FarmNpc>(npcs: readonly T[], p: { worldX: number; worldZ: number } | null | undefined, avoid?: ReadonlySet<number>, pattern = KNIGHT): { npc: T | undefined; recenter: boolean; tol: number } {
    const candidates = npcs.filter(n => pattern.test(n.name) && !avoid?.has(n.index)
        && Math.max(Math.abs(n.x-KNIGHT_SPOT.x),Math.abs(n.z-KNIGHT_SPOT.z)) <= RANGE
        && n.optionsWithIndex.some(o => /^pickpocket$/i.test(o.text))
        && (!p || Math.max(Math.abs(n.x - p.worldX), Math.abs(n.z - p.worldZ)) <= RANGE));
    const npc = candidates.filter(n => n.reachable !== false).sort((a, b) => a.distance - b.distance)[0];
    const away = p ? Math.max(Math.abs(KNIGHT_SPOT.x - p.worldX), Math.abs(KNIGHT_SPOT.z - p.worldZ)) : 0;
    // route-error-restart idled 300 ticks at 2651,3304, 2 tiles from the spot but inside a
    // shut room with every knight unreachable. Then walk onto the spot itself, through the room door.
    if (!npc && away > 0 && away <= 3 && candidates.length > 0) return { npc, recenter: true, tol: 0 };
    return { npc, recenter: !npc && away > 3, tol: 3 };
}
export const TICKS = Number(process.env.TICKS ?? 9000);
export const BANK_AT = Number(process.env.BANK_AT ?? 25000);
export const FOOD_FROM = process.env.FOOD_FROM?.trim() || '';
const FUND_COURIER=process.env.FUND_COURIER?.trim()||'';
export const KEEP_FREE = 2;
export const DMG = 3;

// The east bank room exit anchors a wall beside the path, not a path tile.
// Native and live recovery from 2669,3321 proved this exact observed exit.
export async function farmWalk(s:Session,t:Tile,tol:number,stop:()=>boolean=()=>false){
    if (stop()) throw Error('no farm route progress: stopped');
    const p=s.sdk.getState()?.player;
    if(p?.level===0&&p.worldX>=2662&&p.worldX<=2672&&p.worldZ>=3315&&p.worldZ<=3325){
        const exit=s.sdk.getState()?.nearbyLocs.find(l=>l.x===2669&&l.z===3316&&l.name==='Door'&&l.optionsWithIndex.some(o=>o.text==='Open'));
        if(exit){
            if(!(await s.bot.interactLoc(exit,'Open')).success)throw Error('no farm route progress: room exit refused');
            if(!await waitUntil(s,()=>!s.sdk.getState()?.nearbyLocs.some(l=>l.x===exit.x&&l.z===exit.z&&l.id===exit.id&&l.optionsWithIndex.some(o=>o.text==='Open')),{timeoutTicks:8}))
                throw Error('no farm route progress: room exit unconfirmed');
        }
    }
    const result=await walkPath(await sessionWalker(s),[{...t,tol}],{maxTicks:180,stop});
    if(!result.ok)throw Error(`no farm route progress: ${result.detail}`);
    return result;
}

// SDK eat success can mean HP regeneration alone. Count an observed item use,
// including a cake changing ID, before crediting consumption.
export async function farmEatReceipt(d:{itemId:number;count:()=>number;hp:()=>number;tick:()=>number;
    eat:()=>Promise<{success:boolean}>;wait:()=>Promise<unknown>;log:(line:string)=>void}):Promise<boolean> {
    const before=d.count(),hpBefore=d.hp(),tickBefore=d.tick();
    let sdkSuccess=false,error:string|undefined;
    try { sdkSuccess=(await d.eat()).success; } catch { error='dispatch-or-observation-failed'; }
    if(d.count()===before)try { await d.wait(); } catch { error??='observation-timeout'; }
    const after=d.count(),consumed=before-after;
    const confirmed=before>0&&consumed===1;
    d.log('EAT_RECEIPT '+JSON.stringify({itemId:d.itemId,before,after,consumed,confirmed,sdkSuccess,
        hpBefore,hpAfter:d.hp(),tickBefore,tickAfter:d.tick(),...(error?{error}:{})}));
    return confirmed;
}

export async function farmFinishCheckpoint(d:{ok:boolean;died:()=>boolean;coins:()=>number;bank:()=>Promise<void>}):Promise<void> {
    if(!d.ok||d.died())return;
    // A queued pickpocket can settle during logout. Moving to the bank ends
    // that interaction; capture final counters only after its coins are stored.
    await d.bank();
    if(d.died()||d.coins()!==0)throw Error(`no goldfarm progress: final coin deposit unobserved died=${d.died()}`);
}

// One owner emits the result and logs out. A thrown failure stays a failure
// even if this single, separately routed bank recovery stores its income.
export async function farmErrorCheckpoint(error: unknown, supported: () => boolean, bank: () => Promise<void>) {
    const reason = String(error);
    if (!supported()) return { reason, recovery: 'unsupported' };
    try { await bank(); return { reason, recovery: 'banked' }; }
    catch (recoveryError) { return { reason, recovery: `failed: ${String(recoveryError)}` }; }
}

type FarmSettlement = { tick: number; coins: number; xp: number; busy: boolean; inFlight: boolean; available: boolean };
// Same-tile lite walks emit no packet. Adapt the existing imp worker's observed
// adjacent-step cancellation, using this worker's farm boundary and shared planner.
export function farmPickCancellation(s: Pick<Session,'sdk'|'direct'>,
    planner: () => Promise<{plan:(level:number,from:Tile,to:Tile)=>Tile[]}>) {
    let target: Tile | undefined;
    let sent = false, confirmed = false;
    return async (): Promise<boolean> => {
        const p=s.sdk.getState()?.player;
        if(!p||p.level!==0)return false;
        if(confirmed)return true;
        if(sent&&target&&p.worldX===target.x&&p.worldZ===target.z){confirmed=true;return true;}
        if(!target){
            const from={x:p.worldX,z:p.worldZ},route=await planner();
            for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
                const to={x:from.x+dx!,z:from.z+dz!};
                if(Math.max(Math.abs(to.x-KNIGHT_SPOT.x),Math.abs(to.z-KNIGHT_SPOT.z))>ARDOUGNE_RADIUS)continue;
                const path=route.plan(p.level,from,to);
                if(path.length===1&&path[0]!.x===to.x&&path[0]!.z===to.z){target=to;break;}
            }
        }
        if(!target)return false;
        const reply=await s.direct({type:'walkTo',x:target.x,z:target.z,running:false,reason:'SDK'}) as {success?:boolean};
        sent ||= reply?.success===true;
        // Dispatch acceptance alone never proves that a delayed server cleared its target.
        return false;
    };
}
// Rev289 MoveClickHandler clears pending interaction unless the player is delayed.
// Retry that cancellation while draining the delayed pick/stun. Ten quiet ticks
// exceed the knight's eight-tick stun; fresh ticks and both counters must agree.
// A stopped stream, rejected cancellation or hard cap yields unknown accounting.
export async function farmSettlePicks(d: {
    read: () => FarmSettlement; cancel: () => Promise<boolean>; wait: () => Promise<boolean>;
}): Promise<FarmSettlement & { exact: boolean }> {
    let previous = d.read(), quiet = 0;
    const started = previous.tick;
    try {
        for (let elapsed = 0; elapsed < 32; elapsed++) {
            if (!previous.available) break;
            const cancelled = await d.cancel();
            if (!await d.wait()) break;
            const current = d.read();
            if (current.tick <= previous.tick || current.tick - started > 32 || !current.available) { previous = current; break; }
            quiet = current.tick === previous.tick + 1 && cancelled && !previous.busy && !previous.inFlight && !current.busy && !current.inFlight
                && Number.isSafeInteger(current.coins) && Number.isFinite(current.xp)
                && current.coins === previous.coins && current.xp === previous.xp ? quiet + 1 : 0;
            previous = current;
            if (quiet >= 10) return { ...current, exact: true };
        }
    } catch { /* The session owner still logs out, with accounting explicitly unknown. */ }
    return { ...previous, exact: false };
}

export interface FoodDef {
    pattern: RegExp;
    heal: number;
}

export const FOOD_DEFS: FoodDef[] = [
    { pattern: /^chocolate slice$/i, heal: 2 },
    { pattern: /^cooked (meat|chicken)$/i, heal: 3 },
    { pattern: /^(slice of cake|2\/3 cake|cake)$/i, heal: 4 },
    { pattern: /^bread$/i, heal: 5 },
    { pattern: /^trout$/i, heal: 7 },
    { pattern: /^salmon$/i, heal: 9 },
    { pattern: /^lobster$/i, heal: 12 },
    // consume_normal.dbrow: consumable,shark -> stat_heal,hitpoints,20.
    { pattern: /^shark$/i, heal: 20 },
];

// Owned low-tier fish first; premium sharks only after cheaper stock is gone.
export const WITHDRAW_FOOD = [/^trout$/i, /^salmon$/i, /^lobster$/i, /^bread$/i, /^(slice of cake|2\/3 cake|cake)$/i, /^shark$/i];

export const isFoodItem = (i: any) =>
    FOOD_DEFS.some(d => d.pattern.test(i.name)) &&
    (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text));

export const healOf = (item: any): number => {
    const def = FOOD_DEFS.find(d => d.pattern.test(item.name));
    return def?.heal ?? 3;
};

// Select the food item that best matches the current HP deficit (loss) to avoid overheal waste
export function selectFoodToEat(items: readonly any[], loss: number): any | undefined {
    const foodList = items.filter(isFoodItem);
    if (foodList.length === 0) return undefined;

    // Sort food by heal ascending
    foodList.sort((a, b) => healOf(a) - healOf(b));

    // Best: largest food item whose heal does not exceed deficit (zero waste)
    const exactOrUnder = [...foodList].reverse().find(i => healOf(i) <= loss);
    if (exactOrUnder) return exactOrUnder;

    // If all foods heal more than deficit, pick the smallest to minimize waste
    return foodList[0];
}

// Calculate the safe eat threshold:
// For 10 HP thieves, 4 HP allows failing a pick (taking 3 damage to 1 HP) without dying,
// and gives 6 HP deficit so 4 HP cakes or 5 HP bread heal with ZERO waste.
export const calcEatAt = (maxHp: number): number =>
    maxHp <= 10 ? 4 : Math.max(4, Math.min(maxHp - 6, Math.floor(maxHp * 0.4)));

// The farm runs only where it stands: Ardougne market, ground level. A thief that starts elsewhere (a respawn in
// Lumbridge, a Draynor bank) must not walk here on its own: a 10 HP thief with no food walked from
// Draynor through Taverley toward the bank and died on the way. Cover both storage and roaming knights.
export const ARDOUGNE_RADIUS = 40;
export function farmStartProblem(p: { worldX: number; worldZ: number; level: number } | null | undefined, thieving: number): string | null {
    if (!p) return 'no goldfarm progress: position unknown';
    if (p.level !== 0 || [BANK_SPOT, KNIGHT_SPOT].every(spot =>
        Math.max(Math.abs(p.worldX - spot.x), Math.abs(p.worldZ - spot.z)) > ARDOUGNE_RADIUS))
        return `no goldfarm progress: start in Ardougne market, not ${p.worldX},${p.worldZ},${p.level}`;
    // The knights need Thieving 55. Below it the farm looks for men and women, and none stand at the market: a
    // Thieving 1 account idled all 2400 ticks and still reported ok.
    if (thieving < 55) return `no goldfarm progress: Thieving ${thieving} is below 55 for the knights`;
    return null;
}

// Recovery has no shop or stall operation. With one food, mmtha0205 died at the bakery before a steal.
export async function replenishFarmFood(refill: () => Promise<void>, food: () => number, receive: () => Promise<void>): Promise<void> {
    await refill();
    if (food() < 2) await receive();
}

// Bound waits without useful work. Food recovery is work too; walking and empty bank checks are not.
export const IDLE_LIMIT = 300;

export function foodWaitLimit(courier: string, status: any, now: number, service?: any): number {
    // No courier configured: nothing can arrive, so an exhausted supply exits at once instead of idling.
    if (!courier) return 0;
    const active = courier && typeof status?.name === 'string' && status.name.toLowerCase() === courier.toLowerCase()
        && status.server === 'rs-sdk-demo.fly.dev' && status.role === 'courier' && !status.result
        && Number.isFinite(status.at) && now - status.at >= 0 && now - status.at < 30_000;
    const scheduled = courier && Number.isFinite(service?.at) && now - service.at >= 0 && now - service.at < 30_000
        && Array.isArray(service.jobs) && service.jobs.some((j: any) => typeof j?.account === 'string'
            && j.account.toLowerCase() === courier.toLowerCase() && j.script === 'scripts/foodcourier.ts'
            && j.enabled === true && typeof j.state === 'string' && /^(running|starting|waiting[: ])/.test(j.state));
    return active || scheduled ? 1500 : IDLE_LIMIT;
}

type FarmProgress = { picks: number; fails: number; food: number };
export function farmProgressTick(last: number, tick: number, before: FarmProgress, after: FarmProgress): number {
    // picks includes failed attempts. Damage is activity, not useful output.
    const successes = (p: FarmProgress) => p.picks - p.fails;
    return successes(after) > successes(before) || after.food > before.food ? tick : last;
}

// The courier is in view and the last answer is old enough. Exact name match: a stranger never opens a trade.
export const COURIER_COOLDOWN = 60;
// Only a thief that is short of food waits for the courier at the knights: a courier that idles in view (between runs)
// would otherwise cost every fed thief a 45 s wait each minute.
export const COURIER_WANT_BELOW = 8;
export function courierCheckDue(tick: number, lastCheck: number, courier: string, players: readonly { name?: string }[]): boolean {
    if (!courier || tick - lastCheck < COURIER_COOLDOWN) return false;
    return players.some(p => typeof p?.name === 'string' && p.name.toLowerCase() === courier.toLowerCase());
}

if (import.meta.main) {
    console.log(`ERR-TRACE opening ${process.argv[2]}`);
    let errorEnd: ((error: unknown) => Promise<never>) | undefined;
    const s = await openBot(process.argv[2]!, {
        onStop: (session, detail) => errorEnd ? errorEnd(detail) : finish([session], false, detail),
        onSessionEnd: (session, detail) => errorEnd ? errorEnd(detail) : finish([session], false, detail),
    }).catch(e => finish([], false, `login: ${String(e)}`));
    try {
        const farmServer = serverFromEnv(readFileSync(join(import.meta.dir, '..', 'vendor', 'rs-sdk', 'bots', s.name, 'bot.env'), 'utf8'));
        if (!await waitUntil(s, () => !!s.sdk.getState()?.player && (s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0) > 0,
            { timeoutTicks: 40 })) throw Error('no goldfarm progress: entry state deadline');
        const st = () => s.sdk.getState();
        const pos = () => st()?.player;
        const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
        const maxHp = () => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
        const inv = () => st()?.inventory ?? [];

        const foodItems = () => inv().filter(isFoodItem);
        const foodCount = () => foodItems().reduce((n, i) => n + i.count, 0);
        const notes = () => inv().filter(i => FOOD_DEFS.some(d => d.pattern.test(i.name)) && !isFoodItem(i));
        const coins = () => inv().filter(i => COINS.test(i.name)).reduce((n, i) => n + i.count, 0);

        const cheb = (a: Tile, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
        const eatAt = () => calcEatAt(maxHp());

        const t0 = s.tick();
        const now = () => s.tick() - t0;
        const coins0 = coins();
        const stopFile = `.practice/stop-${process.argv[2]}`;

        const eatenById: Record<number, number> = {};
        let picks = 0, unsettledChecks = 0, fails = 0, eaten = 0, bankTrips = 0, bankTicks = 0, walkTicks = 0, idleTicks = 0, eatTicks = 0, banked = 0;
        let bankFails = 0, stallTrips = 0, stallTicks = 0, stolen = 0, refused = 0;
        let knownBankFood: number | undefined, lastProactiveTrade = -120;
        let shopTrips = 0, shopTicks = 0, bought = 0;
        let hpMin = hp(), died = false, bankEmpty = false, lastFail = '', lastPickTick = s.tick(), lastCourierCheck = -100_000;
        let progress = { picks, fails, food: foodCount() };
        // A death is the server's (sessionDied). A disconnect blanks the state for a moment, so an HP of 0 or a far
        // position read then is no death.
        const life0 = (({ isDead, respawnCount, lifeId }: any = {}) => ({ isDead, respawnCount, lifeId }))(s.sdk.getState()?.player);

        const off = s.onTick(() => {
            const next = { picks, fails, food: foodCount() };
            lastPickTick = farmProgressTick(lastPickTick, s.tick(), progress, next);
            progress = next;
            hpMin = Math.min(hpMin, hp());
            if (sessionDied(life0, s.sdk.getState()?.player)) died = true;
        });

        let ending: Promise<never> | undefined;
        let stoppingPicks = false, pickInFlight = false;
        const tail: unknown[] = [];
        const trace = (event: string) => {
            const p = pos();
            const row = {event,tick:s.tick(),coins:coins(),xp:s.sdk.getSkill('Thieving')?.experience,
                hp:hp(),anim:p?.animId,spotanim:p?.spotanimId,x:p?.worldX,z:p?.worldZ,pickInFlight};
            tail.push(row);if(tail.length>24)tail.shift();
            return row;
        };
        const finalize = async (ok: boolean, why: string, thrown = false): Promise<never> => {
            stoppingPicks = true;
            trace('end');
            let recovery = 'not-needed';
            try { await farmFinishCheckpoint({ok,died:()=>died,coins,bank:()=>refill()}); }
            catch (error) { ok = false; why = String(error); thrown = true; }
            if (thrown) {
                ok = false;
                const outcome = await farmErrorCheckpoint(why,
                    () => !died && hp() > 0 && !existsSync(stopFile)
                        && farmStartProblem(pos(), s.sdk.getSkill('Thieving')?.baseLevel ?? 0) === null,
                    async () => {
                        // Recenter through the market rather than retrying the failed bank leg.
                        const p = pos();
                        if (p && cheb(BANK_SPOT, p) > 4) await walk(KNIGHT_SPOT, 0);
                        await refill(true);
                        if (coins() !== 0) throw Error('recovery coin deposit unobserved');
                    });
                recovery = outcome.recovery;
            }
            // Keep the proved entry/bank recovery before the local cancellation
            // step, so moving one tile cannot hide the recorded house exit.
            trace('recovery-complete');
            console.log('GOLDFARM_TAIL '+JSON.stringify(tail));
            const cancelPick=farmPickCancellation(s,()=>sessionWalker(s));
            const settlement = await farmSettlePicks({
                read: () => {
                    const p = pos(), xp = s.sdk.getSkill('Thieving')?.experience;
                    return {tick:s.tick(),coins:coins(),xp:xp ?? NaN,inFlight:pickInFlight,
                        busy:!p || p.animId !== -1 || p.spotanimId !== -1,
                        available:st()?.inGame === true && !!p && !died && hp()>0};
                },
                cancel: cancelPick,
                wait: async () => {
                    const before=s.tick();
                    const fresh=await waitUntil(s,()=>s.tick()>before,{timeoutTicks:1});
                    console.log('GOLDFARM_SETTLE '+JSON.stringify(trace('settle')));
                    return fresh;
                },
            });
            if (!settlement.exact && ok) {ok=false;why='pick settlement unconfirmed';}
            if (ok && coins() !== 0) {ok=false;why='final coin deposit unobserved after settlement';}
            // The client cache freezes at logout. Capture only after cancelling
            // and observing the pick drain, before the session owner logs out.
            const packCoins = coins(), gained = banked + packCoins - coins0;
            return finish([s], ok, finalOk => {
            off();
            const ticks = now();
            const p = pos();
            const detail = `ticks=${ticks} picks=${picks} fails=${fails} unsettledChecks=${unsettledChecks} coinsGained=${settlement.exact?gained:'unknown'} coinsPerTick=${settlement.exact?(gained / Math.max(1, ticks)).toFixed(2):'unknown'} `
                + `eaten=${eaten} bankTrips=${bankTrips} bankTicks=${bankTicks} walkTicks=${walkTicks} idleTicks=${idleTicks} eatTicks=${eatTicks} `
                + `stallTrips=${stallTrips} stallTicks=${stallTicks} stolen=${stolen} refused=${refused} shopTrips=${shopTrips} shopTicks=${shopTicks} bought=${bought} `
                + `hpMin=${hpMin} died=${died} banked=${banked} packCoins=${packCoins} coinsExact=${settlement.exact} food=${foodCount()} hp=${hp()} at=${p?.worldX},${p?.worldZ},${p?.level} recovery=${recovery}`;
            console.log('GOLDFARM_RESULT ' + JSON.stringify({ ok:finalOk, reason: ok && !finalOk ? 'logout or session close failed' : ok ? '' : why, ticks, picks, fails, coinsGained: settlement.exact ? gained : null, banked,
                packCoins, coinsExact:settlement.exact, coinsGainedObserved:gained, coins0, newBankedCoins: Math.max(0, banked - coins0), recovery, unbankedCoins: packCoins, eaten, eatenById, food: foodCount(), idleTicks, bankTrips, hpMin, hp: hp(), died,
                randomEvents: process.env.RANDOM_EVENTS !== '0', at: p ? { x: p.worldX, z: p.worldZ, level: p.level } : null }));
            return ok ? detail : `${why} ${detail} last=${lastFail}`;
            });
        };
        const end = (ok: boolean, why: string, thrown = false): Promise<never> =>
            ending ??= finalize(ok, why, thrown);
        errorEnd = error => end(false, String(error), true);

        const eat = async (): Promise<boolean> => {
            const e0 = s.tick();
            const loss = maxHp() - hp();
            const pick = selectFoodToEat(inv(), loss);
            if (!pick) {
                lastFail = 'eat: no food in inventory';
                await waitTicks(s, 1);
                return false;
            }
            const count=()=>inv().filter(i=>i.id===pick.id).reduce((sum,i)=>sum+i.count,0);
            const before=count();
            const consumed=await farmEatReceipt({itemId:pick.id,count,hp,tick:()=>s.tick(),
                eat:()=>s.bot.eatFood(pick),
                wait:()=>s.sdk.waitForCondition(st=>st.inventory.filter(i=>i.id===pick.id).reduce((sum,i)=>sum+i.count,0)<before,2000),
                log:line=>console.log(line)});
            eatTicks += s.tick() - e0;
            if (consumed) {
                eaten++;
                eatenById[pick.id] = (eatenById[pick.id] ?? 0) + 1;
            } else {
                lastFail = 'eat: consumption unconfirmed';
                if (s.tick() === e0) await waitTicks(s, 1);
            }
            return consumed;
        };

        const walk = async (t: Tile, tol: number) => {
            trace(`walk:${t.x},${t.z}`);
            const w0 = s.tick();
            try { await farmWalk(s,t,tol,()=>died); }
            finally { walkTicks += s.tick() - w0; }
        };

        const refill = async (bankOnly = false) => {
            bankTrips++;
            await walk(BANK_SPOT, 2);
            const b0 = s.tick();
            try {
                const o = await s.bot.openBank();
                if (!o.success) {
                    lastFail = `bank:${o.message}`;
                    if (bankOnly) throw Error(`no recovery bank progress: ${o.message}`);
                    if (++bankFails >= 3) bankEmpty = true;
                    return;
                }
                bankFails = 0;
                const c = coins();
                if (c > 0) {
                    const item = inv().find(i => COINS.test(i.name));
                    if (!item) throw Error('no deposit progress: coins missing');
                    banked += await depositObserved(s, item);
                }
                if (bankOnly) { await s.bot.closeBank(); return; }
                for (const n of notes()) {
                    await depositObserved(s, n);
                }

                // Deposit all unneeded items: anything that is NOT edible food and NOT coins (vials, ropes, tools, arrows, logs)
                const junk = inv().filter(i => !COINS.test(i.name) && !isFoodItem(i) && !notes().some(n => n.slot === i.slot));
                for (const item of [...new Set(junk.map(i => i.name as string))]) {
                    const d = await s.bot.depositItem(new RegExp(`^${item}$`, 'i'), -1);
                    if (d.success) console.log(`BANKED unneeded item: ${item}`);
                }

                for (const re of WITHDRAW_FOOD) {
                    const inBank = s.sdk.findBankItem(re);
                    const room = 28 - inv().length - KEEP_FREE;
                    if (!inBank || inBank.count <= 0 || room <= 0) continue;
                    const w = await s.bot.withdrawItem(inBank, Math.min(room, inBank.count));
                    if (!w.success) lastFail = `withdraw:${w.message}`;
                }

                const totalBankFood = WITHDRAW_FOOD.reduce((n, re) => n + (s.sdk.findBankItem(re)?.count ?? 0), 0);
                knownBankFood = totalBankFood;
                bankEmpty = totalBankFood === 0;

                console.log(`BANK trip=${bankTrips} banked=${banked} food=${foodCount()} bankFood=${totalBankFood} coins=${coins()} t=${now()}`);
                await s.bot.closeBank();
            } finally {
                bankTicks += s.tick() - b0;
            }
        };

        // Quick non-blocking courier trade check if courier is standing nearby at bank
        const quickCourierCheck = async () => {
            if (!FOOD_FROM) return;
            const courierNpc = (st()?.nearbyPlayers ?? []).find((p: any) =>
                new RegExp(`^${FOOD_FROM}$`, 'i').test(p.name)
            );
            if (!courierNpc) return;
            console.log(`COURIER trade check from ${FOOD_FROM} t=${now()}`);
            const re = new RegExp(`^${FOOD_FROM}$`, 'i');
            // Serve while the courier stays in view (up to 45 s): it hands out to each farmer in turn, so a 5 s window
            // ended before its request came (every hand-out failed). Leave as soon as it walks off.
            const inView = () => (st()?.nearbyPlayers ?? []).some((p: any) => re.test(p.name));
            await refill();
            const r = await receiveHandoff(s, FOOD_FROM, farmServer, () => s.bot.serveTrades({ from: re, maxTrades: 1, timeout: 45_000, until: () => !inView() || existsSync(stopFile) }));
            // Share the completed attempt across quick and proactive entry paths.
            lastProactiveTrade = s.tick();
            lastCourierCheck = s.tick();
            const got = r.trades.some(t => t.success);
            console.log(`COURIER ${got ? 'received' : 'no trade'} food=${foodCount()} notes=${notes().length} t=${now()}`);
            // Bank only what arrived (notes -> food); a no-trade wait has nothing to bank.
            if (got) await refill();
        };

        // Banked food and the authenticated owned courier are the food supply.
        // Do not return a food-poor thief to the bakery: mmtha0205 died there with one food.
        const replenishFood = () => replenishFarmFood(refill, foodCount, quickCourierCheck);

        // Inside the 8-tick stun after a fail, eat immediately if HP is at or below safe threshold
        const onStun = async () => {
            if (foodCount() > 0 && hp() <= eatAt()) {
                await eat();
                return;
            }
            await waitTicks(s, 1);
        };

        // One pickpocket attempt
        const steal = async () => {
            if(stoppingPicks)return;
            // NEVER pickpocket if HP <= 3 (1 hit away from death)
            if (hp() <= DMG) {
                if (foodCount() > 0) {
                    await eat();
                    return;
                } else {
                    await replenishFood();
                    if (foodCount() === 0) await walk(BANK_SPOT, 2);
                    return;
                }
            }

            const p = pos();
            const avoid = randomEventsOf(s)?.avoid().npcs;
            const thiev = s.sdk.getSkill('Thieving')?.level ?? 1;
            const targetPattern = thiev >= 55 ? KNIGHT : /^(man|woman)$/i;

            const { npc, recenter, tol } = farmPickTarget(st()?.nearbyNpcs ?? [], p, avoid, targetPattern);

            if (!npc) {
                if (recenter) await walk(KNIGHT_SPOT, tol);
                else { idleTicks++; await waitTicks(s, 1); }
                return;
            }

            const op = npc.optionsWithIndex.find((o: any) => /pickpocket/i.test(o.text))?.opIndex;
            if (op === undefined) { idleTicks++; await waitTicks(s, 1); return; }

            const hp0 = hp(), c0 = coins();
            if(stoppingPicks)return;
            pickInFlight=true;
            trace('pick-dispatch');
            try {
            await s.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: op, reason: 'SDK' } as any);
            await waitTicks(s, 2);

            if (hp() < hp0) {
                picks++;
                fails++;
                await onStun();
            } else if (coins() > c0) {
                picks++;
                lastPickTick = s.tick();
            } else {
                unsettledChecks++;
            }
            } finally {pickInFlight=false;trace(hp()<hp0?'pick-stun':'pick-observed');}
        };

        console.log(`GOLDFARM ticks=${TICKS} eatAt=${eatAt()} maxHp=${maxHp()} food=${foodCount()} notes=${notes().length} coins=${coins0}`);

        // Refuse before any walk: a start outside Ardougne, or an account too weak for the knights.
        const startProblem = farmStartProblem(pos(), s.sdk.getSkill('Thieving')?.baseLevel ?? 0);
        if (startProblem) await end(false, startProblem);
        lastPickTick = s.tick();

        const hasJunk = () => inv().some(i => !COINS.test(i.name) && !isFoodItem(i) && !notes().some(n => n.slot === i.slot));

        // Startup: if holding unneeded items, low on food, or holding notes, deposit and replenish immediately
        if (hasJunk() || foodCount() < 2 || notes().length > 0) {
            await refill();
            if (foodCount() < 2) {
                await replenishFood();
            }
        }

        let nextMark = 1000;
        let foodWaitingSince: number | undefined;
        while (now() < TICKS && !died && !stoppingPicks) {
            if (existsSync(stopFile)) await end(false, 'stop file');
            if (now() >= nextMark) {
                console.log(`MILESTONE t=${now()} banked=${banked} packCoins=${coins()} food=${foodCount()} picks=${picks} fails=${fails} eaten=${eaten}`);
                nextMark += 1000;
            }
            if (randomEventsOf(s)?.busy()) { idleTicks++; await waitTicks(s, 1); continue; }
            if(FUND_COURIER&&pendingCourierFunding(s.name,FUND_COURIER,farmServer)){
                await walk(BANK_SPOT,2);
                const funded=await serviceCourierFunding(s,FUND_COURIER,farmServer);
                if(funded?.state==='unknown')throw Error('no courier progress: funding settlement uncertain');
                await refill();
                // The food rendezvous below runs before returning to work, so a hungry funder stays visible.
            }
            // Meet real owned cargo before the pack empties. The courier and controller use an 80-fish buffer.
            if (FOOD_FROM && (knownBankFood === undefined || knownBankFood + foodCount() < 80)) {
                let courier: any;
                if (/^[A-Za-z0-9_ -]{1,12}$/.test(FOOD_FROM)) {
                    try { courier = JSON.parse(readFileSync(join(import.meta.dir, '..', '.practice', 'status', `${FOOD_FROM}.json`), 'utf8')); } catch { /* no cargo observation */ }
                }
                if (courierFoodReady(courier, FOOD_FROM, farmServer, ownedAccounts(farmServer), Date.now(), s.tick(), lastProactiveTrade)) {
                    await walk(BANK_SPOT, 2);
                    const fundingPending=()=>!!FUND_COURIER&&pendingCourierFunding(s.name,FUND_COURIER,farmServer);
                    const receipt = await receiveFoodAtBank(s, FOOD_FROM, 45_000, refill, () => foodCount() >= 2, fundingPending, farmServer);
                    // Funding and food use the same partner. Finish the cash request before accepting food.
                    if(fundingPending())continue;
                    lastProactiveTrade = s.tick();
                    lastCourierCheck = s.tick();
                    console.log(`COURIER proactive incoming=${receipt.incoming} food=${foodCount()} t=${now()}`);
                    if (receipt.available) await walk(KNIGHT_SPOT, 3);
                }
            }
            // The courier walks to the knights when the thief is not at the bank (scripts/foodcourier.ts): answer it
            // while it stands in view, at most once per COURIER_COOLDOWN ticks, so a departing courier costs little.
            if (foodCount() < COURIER_WANT_BELOW && courierCheckDue(s.tick(), lastCourierCheck, FOOD_FROM, st()?.nearbyPlayers ?? [])) {
                await quickCourierCheck();
                lastCourierCheck = s.tick();
            }
            // Food-poor thieves wait at storage. A live courier gets one bounded delivery window.
            // Empty bank checks, walking and unsuccessful trade attempts never renew this window.
            if (foodCount() < 2 && bankEmpty) {
                if (foodWaitingSince === undefined) {
                    foodWaitingSince = s.tick();
                    console.log(`MILESTONE waiting-for-food food=${foodCount()} t=${now()}`);
                }
                if (hp() <= eatAt() && foodCount() > 0) await eat();
                await walk(BANK_SPOT, 2);
                let courierStatus: any, courierService: any;
                if (/^[A-Za-z0-9_ -]{1,12}$/.test(FOOD_FROM)) {
                    try { courierStatus = JSON.parse(readFileSync(join(import.meta.dir, '..', '.practice', 'status', `${FOOD_FROM}.json`), 'utf8')); } catch { /* unavailable courier gets only the short wait */ }
                    try { courierService = JSON.parse(readFileSync(join(import.meta.dir, '..', '.practice', 'swarm-state.json'), 'utf8')); } catch { /* unavailable controller does not extend the wait */ }
                }
                const limit = foodWaitLimit(FOOD_FROM, courierStatus, Date.now(), courierService);
                if (s.tick() - foodWaitingSince >= limit) {
                    // Pack coins from the last picks are income: store them before the supply exit.
                    if (coins() > 0) await refill();
                    await end(false, `no food supply: waited ${limit} ticks at bank`);
                }
                await waitTicks(s, 2);
                continue;
            }
            foodWaitingSince = undefined;
            // A farm that stands still logs out instead of burning playtime (a waiting-for-food bank stay counts too).
            // No food at all reads as "no food" (supervisors: stopped, resumable); anything else is a stuck farm (blocked).
            if (s.tick() - lastPickTick >= IDLE_LIMIT) await end(false, foodCount() === 0
                ? `no food: waited ${IDLE_LIMIT} ticks with no useful work and no food`
                : `no goldfarm progress: idle ${IDLE_LIMIT} ticks with no pickpocket or food gained`);

            const f = foodCount();

            // Eat when HP <= eatAt (4 HP for 10 HP thieves)
            if (hp() <= eatAt() && f > 0) {
                if (!(await eat())) await waitTicks(s, 1);
                continue;
            }

            // Critical safety guard: NEVER pickpocket if HP <= 3 (1 hit from death)
            if (hp() <= DMG) {
                if (f > 0) {
                    await eat();
                    continue;
                } else {
                    await replenishFood();
                    await walk(KNIGHT_SPOT, 3);
                    continue;
                }
            }

            // Normal bank trip: unneeded items in pack, food low but bank has food, or coins reached threshold
            if (hasJunk() || (f < 2 && !bankEmpty) || coins() >= BANK_AT || notes().length > 0) {
                await refill();
                if (foodCount() === 0 && hp() <= 6) {
                    // No food after the bank trip: stay at the bank (safe) and wait for the courier.
                    await walk(BANK_SPOT, 2);
                    await waitTicks(s, 2);
                    continue;
                }
                await walk(KNIGHT_SPOT, 3);
                continue;
            }

            // Self-sufficient food replenish when pack and bank are out of food
            if (f < 2 && bankEmpty) {
                await replenishFood();
                if (foodCount() === 0) {
                    // No food anywhere: wait at the bank (safe) for the courier instead of returning to the knights.
                    await walk(BANK_SPOT, 2);
                    await waitTicks(s, 2);
                    continue;
                }
                await walk(KNIGHT_SPOT, 3);
                continue;
            }

            await steal();
        }

        await end(!died, died ? 'died' : 'ticks');
    } catch (e) {
        if (errorEnd) await errorEnd(e);
        await finish([s], false, String(e));
    }
}
