// Gold farm: pickpocket knights of Ardougne at Thieving 99, bank coins and refill food at the south bank.
// Self-sufficient food supply: withdraws bank food (trout, salmon, lobster, bread, cake), buys from the Baker's shop,
// or steals cakes from the Baker's stall when out of food.
// Smart deficit-matched eating: lets HP drop to 4 (max hit 3 from Knights) to preserve food with zero overheal while
// strictly guaranteeing the bot never dies.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openBot, finish, randomEventsOf } from '../packages/core/src/bot';
import { waitTicks } from '../packages/core/src/ticks';
import type { Session } from '../packages/core/src/inprocess';

export type Tile = { x: number; z: number };
export const KNIGHT_SPOT: Tile = { x: 2653, z: 3302 };
export const BANK_SPOT: Tile = { x: 2654, z: 3283 };
export const STALL_SPOT: Tile = { x: 2655, z: 3310 };

export const KNIGHT = /^knight of ardougne$/i;
export const GUARD = /^guard$/i;
export const BAKER = /^baker/i;
export const COINS = /^coins$/i;

export const RANGE = 16;
export const TICKS = Number(process.env.TICKS ?? 9000);
export const BANK_AT = Number(process.env.BANK_AT ?? 25000);
export const FOOD_FROM = process.env.FOOD_FROM?.trim() || '';
export const STALL_FILL = Number(process.env.STALL_FILL ?? 10);
export const KEEP_FREE = 2;
export const DMG = 3;

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
];

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

if (import.meta.main) {
    console.log(`ERR-TRACE opening ${process.argv[2]}`);
    const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));

    try {
        await waitTicks(s, 5);
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
        const stealFile = join(import.meta.dir, '..', '.practice', 'goldfarm', `steal-${process.argv[2]}.json`);

        let lastStealTick = -100_000;
        let lastStealEpoch = 0;
        try {
            lastStealEpoch = JSON.parse(readFileSync(stealFile, 'utf8')).at ?? 0;
        } catch { /* none */ }

        const saveSteal = () => {
            lastStealEpoch = Date.now();
            try {
                mkdirSync(dirname(stealFile), { recursive: true });
                writeFileSync(stealFile, JSON.stringify({ at: lastStealEpoch }));
            } catch { /* best effort */ }
        };

        let picks = 0, noops = 0, fails = 0, eaten = 0, bankTrips = 0, bankTicks = 0, walkTicks = 0, idleTicks = 0, eatTicks = 0, banked = 0;
        let bankFails = 0, stallTrips = 0, stallTicks = 0, stolen = 0, refused = 0;
        let shopTrips = 0, shopTicks = 0, bought = 0;
        let hpMin = hp(), died = false, bankEmpty = false, lastFail = '';
        let last = pos();

        const off = s.onTick(() => {
            const p = pos();
            hpMin = Math.min(hpMin, hp());
            if ((s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0) > 0 && hp() <= 0) died = true;
            if (p && last && cheb({ x: last.worldX, z: last.worldZ }, p) > 20) died = true;
            last = p;
        });

        const end = async (ok: boolean, why: string): Promise<never> => {
            off();
            const ticks = now();
            const gained = banked + coins() - coins0;
            const p = pos();
            const detail = `ticks=${ticks} picks=${picks} fails=${fails} noops=${noops} coinsGained=${gained} coinsPerTick=${(gained / Math.max(1, ticks)).toFixed(2)} `
                + `eaten=${eaten} bankTrips=${bankTrips} bankTicks=${bankTicks} walkTicks=${walkTicks} idleTicks=${idleTicks} eatTicks=${eatTicks} `
                + `stallTrips=${stallTrips} stallTicks=${stallTicks} stolen=${stolen} refused=${refused} shopTrips=${shopTrips} shopTicks=${shopTicks} bought=${bought} `
                + `hpMin=${hpMin} died=${died} banked=${banked} packCoins=${coins()} food=${foodCount()} hp=${hp()} at=${p?.worldX},${p?.worldZ},${p?.level}`;
            return finish([s], ok, ok ? detail : `${why} ${detail} last=${lastFail}`);
        };

        const eat = async (): Promise<boolean> => {
            const e0 = s.tick();
            const loss = maxHp() - hp();
            const pick = selectFoodToEat(inv(), loss);
            if (!pick) {
                lastFail = 'eat: no food in inventory';
                await waitTicks(s, 1);
                return false;
            }
            const r = await s.bot.eatFood(pick);
            eatTicks += s.tick() - e0;
            if (r.success) {
                eaten++;
            } else {
                lastFail = `eat:${r.message}`;
                if (s.tick() === e0) await waitTicks(s, 1);
            }
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

        const refill = async () => {
            bankTrips++;
            await walk(BANK_SPOT, 2);
            const b0 = s.tick();
            try {
                const o = await s.bot.openBank();
                if (!o.success) {
                    lastFail = `bank:${o.message}`;
                    if (++bankFails >= 3) bankEmpty = true;
                    return;
                }
                bankFails = 0;
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

                // Deposit all unneeded items: anything that is NOT edible food and NOT coins (vials, ropes, tools, arrows, logs)
                const junk = inv().filter(i => !COINS.test(i.name) && !isFoodItem(i) && !notes().some(n => n.slot === i.slot));
                for (const item of [...new Set(junk.map(i => i.name as string))]) {
                    const d = await s.bot.depositItem(new RegExp(`^${item}$`, 'i'), -1);
                    if (d.success) console.log(`BANKED unneeded item: ${item}`);
                }

                // Withdraw food: fish first, then bread, then cake
                const WITHDRAW_FOOD = [/^trout$/i, /^salmon$/i, /^lobster$/i, /^bread$/i, /^cake$/i];
                for (const re of WITHDRAW_FOOD) {
                    const inBank = s.sdk.findBankItem(re);
                    const room = 28 - inv().length - KEEP_FREE;
                    if (!inBank || inBank.count <= 0 || room <= 0) continue;
                    const w = await s.bot.withdrawItem(inBank, Math.min(room, inBank.count));
                    if (!w.success) lastFail = `withdraw:${w.message}`;
                }

                const totalBankFood = WITHDRAW_FOOD.reduce((n, re) => n + (s.sdk.findBankItem(re)?.count ?? 0), 0);
                bankEmpty = totalBankFood === 0;

                // If bank has no food, withdraw 100-300 coins to buy bread/cake at the bakery shop
                const bankCoins = s.sdk.findBankItem(COINS);
                if (bankEmpty && coins() < 100 && bankCoins && bankCoins.count > 0) {
                    const n = Math.min(300 - coins(), bankCoins.count);
                    const w = await s.bot.withdrawItem(bankCoins, n);
                    if (w.success) banked -= w.amountWithdrawn ?? n;
                }

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
            await s.bot.serveTrades({ from: re, maxTrades: 1, timeout: 5000 });
            await refill();
        };

        // Buy bread and cakes from Baker's shop in Ardougne market
        const shopTrip = async () => {
            shopTrips++;
            const before = foodCount();
            await walk(STALL_SPOT, 2);
            const q0 = s.tick();
            try {
                const o = await s.bot.openShop(BAKER);
                if (!o.success) {
                    lastFail = `shop:${o.message}`;
                    return;
                }
                let free = 28 - inv().length - KEEP_FREE;
                let money = coins();
                const shopItems = (st()?.shop?.shopItems ?? []) as any[];
                for (const item of shopItems) {
                    if (!/^(bread|cake|chocolate slice)$/i.test(item.name) || item.count <= 0) continue;
                    const price = Math.max(1, item.buyPrice || 12);
                    let n = Math.min(item.count, free, Math.floor(money / price));
                    if (n <= 0) continue;
                    free -= n;
                    money -= n * price;
                    for (const chunk of [10, 5, 1]) {
                        while (n >= chunk) {
                            await s.direct({ type: 'shopBuy', slot: item.slot, amount: chunk, reason: 'SDK' } as any);
                            n -= chunk;
                        }
                    }
                    if (free <= 0) break;
                }
                await waitTicks(s, 1);
                await s.direct({ type: 'closeShop', reason: 'SDK' } as any);
                const got = foodCount() - before;
                bought += Math.max(0, got);
                console.log(`SHOP trip=${shopTrips} food=${foodCount()} bought=${bought} t=${now()}`);
            } finally {
                shopTicks += s.tick() - q0;
            }
        };

        // Steal bread and cakes from Baker's stall from safe side tiles
        const stallTrip = async () => {
            stallTrips++;
            await walk(STALL_SPOT, 2);
            const s0 = s.tick();
            const badUntil = new Map<string, number>();
            const key = (t: Tile) => `${t.x},${t.z}`;
            const d = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

            try {
                while (foodCount() < STALL_FILL && 28 - inv().length > KEEP_FREE && s.tick() - s0 < 200 && !died && now() < TICKS) {
                    if (existsSync(stopFile)) return;
                    if (randomEventsOf(s)?.busy()) { await waitTicks(s, 1); continue; }
                    if (hp() <= eatAt() && foodCount() > 0) { await eat(); continue; }
                    if (hp() <= DMG && foodCount() === 0) break; // retreat to bank if dangerously low

                    const npcs = (st()?.nearbyNpcs ?? []) as any[];
                    const guards = npcs.filter(n => GUARD.test(n.name)).map(n => ({ x: n.x, z: n.z }));
                    const bakers = npcs.filter(n => BAKER.test(n.name)).map(n => ({ x: n.x, z: n.z }));
                    const locs = (st()?.nearbyLocs ?? []) as any[];

                    const me = pos();
                    if (!me) { await waitTicks(s, 1); continue; }
                    const here = { x: me.worldX, z: me.worldZ };

                    const stallLoc = locs.find(l => /^baker'?s stall$/i.test(l.name) || (l.id === 2561 && cheb(STALL_SPOT, l) <= 6));
                    if (!stallLoc) {
                        await waitTicks(s, 2);
                        continue;
                    }

                    const sides: Tile[] = [
                        { x: stallLoc.x - 1, z: stallLoc.z },
                        { x: stallLoc.x + 1, z: stallLoc.z },
                        { x: stallLoc.x, z: stallLoc.z - 1 },
                        { x: stallLoc.x, z: stallLoc.z + 1 },
                        { x: stallLoc.x, z: stallLoc.z + 2 },
                        { x: stallLoc.x - 1, z: stallLoc.z + 1 },
                    ];

                    // Safe tile: no guards within 5 tiles with line of sight (guards hunt at radius 5)
                    const safeTiles = sides.filter(t => {
                        if ((badUntil.get(key(t)) ?? 0) > s.tick()) return false;
                        if (guards.some(g => d(g, t) <= 5)) return false;
                        const bakerD = Math.min(99, ...bakers.map(b => d(b, t)));
                        return bakerD > 5 || t.z > stallLoc.z; // North side of stall obstructs Baker view
                    });

                    if (safeTiles.length === 0) {
                        await waitTicks(s, 1);
                        continue;
                    }

                    safeTiles.sort((a, b) => d(a, here) - d(b, here));
                    const best = safeTiles[0]!;

                    if (d(best, here) > 0) {
                        await s.bot.walkTo(best.x, best.z, 0, { timeout: 4000 });
                        const p = pos();
                        if (!p || p.worldX !== best.x || p.worldZ !== best.z) {
                            badUntil.set(key(best), s.tick() + 15);
                        }
                        continue;
                    }

                    const op = stallLoc.optionsWithIndex.find((o: any) => /steal/i.test(o.text))?.opIndex ?? 2;
                    const before = foodCount();
                    await s.direct({ type: 'interactLoc', x: stallLoc.x, z: stallLoc.z, locId: stallLoc.id, optionIndex: op, reason: 'SDK' } as any);
                    let got = false;
                    for (let i = 0; i < 3 && !got; i++) {
                        await waitTicks(s, 1);
                        got = foodCount() > before;
                    }
                    if (got) {
                        stolen++;
                        lastStealTick = s.tick();
                        lastStealEpoch = Date.now();
                        saveSteal();
                    } else {
                        refused++;
                        badUntil.set(key(best), s.tick() + 6);
                    }
                }
            } finally {
                stallTicks += s.tick() - s0;
                console.log(`STALL trip=${stallTrips} food=${foodCount()} stolen=${stolen} refused=${refused} t=${now()}`);
            }
        };

        // Self-sufficient food replenish pipeline: Bank -> Courier -> Shop -> Stall
        const replenishFood = async () => {
            await refill();
            if (foodCount() >= 2) return;

            await quickCourierCheck();
            if (foodCount() >= 2) return;

            const shopSafe = (s.tick() - lastStealTick > 1520) && (Date.now() - lastStealEpoch > 1520 * 400);
            if (shopSafe && (coins() >= 12 || !bankEmpty)) {
                await shopTrip();
                if (foodCount() >= 2) return;
            }

            // At critical HP with no food, do not walk to the open stall where guards can finish the account.
            if (hp() <= 6 && foodCount() === 0) return;
            await stallTrip();
        };

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

            const npc = (st()?.nearbyNpcs ?? [])
                .filter((n: any) => targetPattern.test(n.name) && !avoid?.has(n.index) && (!p || Math.max(Math.abs(n.x - p.worldX), Math.abs(n.z - p.worldZ)) <= RANGE))
                .sort((a: any, b: any) => a.distance - b.distance)[0] as any;

            if (!npc) {
                if (p && cheb(KNIGHT_SPOT, p) > RANGE) await walk(KNIGHT_SPOT, 3);
                else { idleTicks++; await waitTicks(s, 1); }
                return;
            }

            const op = npc.optionsWithIndex.find((o: any) => /pickpocket/i.test(o.text))?.opIndex;
            if (op === undefined) { idleTicks++; await waitTicks(s, 1); return; }

            const hp0 = hp(), c0 = coins();
            await s.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: op, reason: 'SDK' } as any);
            await waitTicks(s, 2);

            if (hp() < hp0) {
                picks++;
                fails++;
                await onStun();
            } else if (coins() > c0) {
                picks++;
            } else {
                noops++;
            }
        };

        console.log(`GOLDFARM ticks=${TICKS} eatAt=${eatAt()} maxHp=${maxHp()} food=${foodCount()} notes=${notes().length} coins=${coins0}`);

        const hasJunk = () => inv().some(i => !COINS.test(i.name) && !isFoodItem(i) && !notes().some(n => n.slot === i.slot));

        // Startup: if holding unneeded items, low on food, or holding notes, deposit and replenish immediately
        if (hasJunk() || foodCount() < 2 || notes().length > 0) {
            await refill();
            if (foodCount() < 2) {
                await replenishFood();
            }
        }

        let nextMark = 1000;
        while (now() < TICKS && !died) {
            if (existsSync(stopFile)) await end(false, 'stop file');
            if (now() >= nextMark) {
                console.log(`MILESTONE t=${now()} banked=${banked} packCoins=${coins()} food=${foodCount()} picks=${picks} fails=${fails} eaten=${eaten}`);
                nextMark += 1000;
            }
            if (randomEventsOf(s)?.busy()) { idleTicks++; await waitTicks(s, 1); continue; }

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
        await finish([s], false, String(e));
    }
}
