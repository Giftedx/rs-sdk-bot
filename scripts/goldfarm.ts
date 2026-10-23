// Gold farm: pickpocket knights of Ardougne at Thieving 99, bank coins and refill lobsters at the south bank.
// Game data (skill_thieving/configs/pickpocking/pickpocket.dbrow:81-90): knight of Ardougne, success 50..240 of 256
// (94% at 99), 50 coins, stun 8 ticks, fail damage 3. Model: about 18.8 coins per tick at level 99.
// Knights spawn at (2652,3318) and (2653,3300) and wander. Bank spot (2654,3283), bankers at (2657,3280-3286).
// Env: TICKS (default 9000) game ticks; BANK_AT (default 25000) coins in the pack that start a bank trip;
// FOOD_FROM=<account>: with no lobsters in the pack or the bank, serve one trade from that account (180 s) first.
// Food fallback: with no lobsters in the pack or the bank, steal from the Ardougne baker's stall until the pack holds
// STALL_FILL (default 10) food items. Rules (skill_thieving stealing.rs2:98-121, thieving.rs2:53-73): an ardougne_guard
// within 5 tiles of the player with line of sight shouts and attacks; the Baker (baker_merchant) within 5 tiles with
// line of sight refuses the steal, without damage. After a steal, any talk or trade with the Baker in the next 1500
// ticks calls the guards (area_ardougne_east/scripts/baker.rs2), so this script never talks to him.
// Loot (stealing.dbrow): cake 13/20, bread 5/20, chocolate slice 2/20; respawn 8 ticks. A cake eats in 3 bites.
// Preset goldfarm_knights (goldfarm_nofood for the stall). Copies the 2-tick direct click and eating inside the stun from scripts/generated/thieving60.ts.
import { existsSync } from 'node:fs';
import { openBot, finish, randomEventsOf } from '../packages/core/src/bot';
import { waitTicks } from '../packages/core/src/ticks';

type Tile = { x: number; z: number };
const KNIGHT_SPOT: Tile = { x: 2653, z: 3302 };
const BANK_SPOT: Tile = { x: 2654, z: 3283 };
const KNIGHT = /^knight of ardougne$/i;
const RANGE = 16;
const LOBSTER = /^lobster$/i;
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
// Eat order when the HP loss is small: lowest heal first (cake pieces 4, chocolate slice, bread 5), lobster (12) last.
const FOOD_ORDER = [/^slice of cake$/i, /^2\/3 cake$/i, /^cake$/i, /^chocolate slice$/i, /^bread$/i, LOBSTER];
const DMG = 3;
// Click cadence in ticks. A click inside the pick's action delay is queued again by the server (p_opnpc(3),
// pickpocket.rs2:134-137), so a 1-tick cadence costs nothing and re-paths to a knight that stepped away a tick sooner.
const PICK_TICKS = Number(process.env.PICK_TICKS ?? 2);

console.log(`ERR-TRACE opening ${process.argv[2]}`);
const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 5);
    // Farm only where the knights are. After a death the game respawns the bot in Lumbridge; walking from there to
    // Ardougne killed mmtha0205 twice on 2026-10-23 (near 2906,3375). Getting back is a travel job, not this script's.
    const p0 = s.sdk.getState()?.player;
    if (!p0 || Math.max(Math.abs(p0.worldX - 2655), Math.abs(p0.worldZ - 3300)) > 60) {
        await finish([s], false, `not in Ardougne (${p0?.worldX},${p0?.worldZ}); refusing to walk there`);
    }
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const maxHp = () => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    const inv = () => st()?.inventory ?? [];
    const edible = (i: any) => LOBSTER.test(i.name) && (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text));
    const lobsters = () => inv().filter(edible).reduce((n, i) => n + i.count, 0);
    const isFood = (i: any) => FOOD_ORDER.some(re => re.test(i.name)) && (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text));
    const food = () => inv().filter(isFood).reduce((n, i) => n + i.count, 0);
    const notes = () => inv().filter(i => LOBSTER.test(i.name) && !edible(i));
    const coins = () => inv().filter(i => COINS.test(i.name)).reduce((n, i) => n + i.count, 0);
    const cheb = (a: Tile, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const eatAt = () => Math.max(DMG, maxHp() - 12);
    const t0 = s.tick();
    const now = () => s.tick() - t0;
    const coins0 = coins();
    const stopFile = `.practice/stop-${process.argv[2]}`;

    let picks = 0, noops = 0, fails = 0, eaten = 0, bankTrips = 0, bankTicks = 0, walkTicks = 0, idleTicks = 0, eatTicks = 0, banked = 0;
    let bankFails = 0, stallTrips = 0, stallTicks = 0, stolen = 0, refused = 0, stallEmptyTrips = 0, stallPickTicks = 0;
    const banned = new Map<number, number>();
    let noopRun = 0, noopTarget = -1, bans = 0, stunUntil = 0;
    let shopTrips = 0, shopTicks = 0, bought = 0, shopRetryAt = 0, lastSteal = -1_000_000;
    let hpMin = hp(), died = false, bankEmpty = false, warned = false, lastFail = '';
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
            + `hpMin=${hpMin} died=${died} banked=${banked} packCoins=${coins()} lobsters=${lobsters()} food=${food()} hp=${hp()} at=${p?.worldX},${p?.worldZ},${p?.level}`;
        return finish([s], ok, ok ? detail : `${why} ${detail} last=${lastFail}`);
    };

    const eat = async (): Promise<boolean> => {
        const e0 = s.tick();
        // A lobster when the loss uses most of its 12 HP, else the smallest food first.
        const items = inv().filter(isFood);
        const rank = (i: any) => FOOD_ORDER.findIndex(re => re.test(i.name));
        items.sort((a, b) => rank(a) - rank(b));
        const big = items.find(i => LOBSTER.test(i.name));
        const pick = maxHp() - hp() >= 12 && big ? big : items[0];
        if (!pick) return false;
        const r = await s.bot.eatFood(pick);
        eatTicks += s.tick() - e0;
        if (r.success) eaten++;
        else lastFail = `eat:${r.message}`;
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
    // Sets bankEmpty when the bank holds no lobsters.
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
            const inBank = s.sdk.findBankItem(LOBSTER);
            const room = 28 - inv().length - KEEP_FREE;
            if (inBank && inBank.count > 0 && room > 0) {
                const w = await s.bot.withdrawItem(inBank, Math.min(room, inBank.count));
                if (!w.success) lastFail = `withdraw:${w.message}`;
            }
            const left = (s.sdk.findBankItem(LOBSTER)?.count ?? 0);
            bankEmpty = left === 0;
            // No lobsters left: take 300 coins back for the Baker's shop (bread 12 coins).
            const bankCoins = s.sdk.findBankItem(COINS);
            if (bankEmpty && coins() < 300 && bankCoins && bankCoins.count > 0) {
                const n = Math.min(300 - coins(), bankCoins.count);
                const w = await s.bot.withdrawItem(bankCoins, n);
                if (w.success) banked -= w.amountWithdrawn ?? n;
            }
            console.log(`BANK trip=${bankTrips} banked=${banked} lobsters=${lobsters()} bankLobsters=${left} t=${now()}`);
            await s.bot.closeBank();
        } finally { bankTicks += s.tick() - b0; }
    };

    // FOOD_FROM: no lobsters anywhere at startup, so take notes by trade at the bank spot, then bank them.
    const foodByTrade = async () => {
        console.log(`MILESTONE waiting for food trade from ${FOOD_FROM}`);
        await walk(BANK_SPOT, 2);
        const re = new RegExp(`^${FOOD_FROM.replace(/[^a-zA-Z0-9 _-]/g, '')}$`, 'i');
        const r = await s.bot.serveTrades({ from: re, maxTrades: 1, timeout: 180_000 });
        console.log(`TRADE ${r.reason} ${r.message} notes=${notes().reduce((n, i) => n + i.count, 0)} lobsters=${lobsters()}`);
        await refill();
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
        try {
            while (food() < STALL_FILL && 28 - inv().length > 0 && s.tick() - s0 < 400 && !died && now() < TICKS) {
                if (existsSync(stopFile)) return;
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
                    // (live 2026-10-23 09:05, after the shop and the stall both gave 0). The main loop's floor is 6 too.
                    if (k && hp() > 2 * DMG) { const k0 = s.tick(); await steal(6); stallPickTicks += s.tick() - k0; }
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
                if (got) { stolen++; lastSteal = s.tick(); }
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
    const shopOk = () => s.tick() - lastSteal > 1500 + 20 && s.tick() >= shopRetryAt && coins() >= 12;
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
            // happens"): seen 2026-10-24 as 93-tick runs of noops at (2650,3300). Skip it, and rest a knight 15 ticks
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

    console.log(`GOLDFARM ticks=${TICKS} pickTicks=${PICK_TICKS} eatAt=${eatAt()} maxHp=${maxHp()} lobsters=${lobsters()} notes=${notes().length} coins=${coins0} foodFrom=${FOOD_FROM || '-'}`);
    // Start: notes in the pack, or no food, means a bank visit first.
    if (lobsters() < 2 || notes().length > 0) {
        await refill();
        if (lobsters() === 0 && bankEmpty && FOOD_FROM) await foodByTrade();
    }

    let nextMark = 1000;
    while (now() < TICKS && !died) {
        if (existsSync(stopFile)) await end(false, 'stop file');
        if (now() >= nextMark) { console.log(`MILESTONE t=${now()} banked=${banked} packCoins=${coins()} lobsters=${lobsters()} food=${food()} picks=${picks} fails=${fails} eaten=${eaten}`); nextMark += 1000; }
        if (randomEventsOf(s)?.busy()) { idleTicks++; await waitTicks(s, 1); continue; }
        const l = food();
        if (hp() <= eatAt() && l > 0) { if (!(await eat())) await waitTicks(s, 1); continue; }
        if ((lobsters() < 2 && l < 2 && !bankEmpty) || coins() >= BANK_AT || notes().length > 0) {
            await refill();
            await walk(KNIGHT_SPOT, 3);
            continue;
        }
        // Bank out of lobsters: the Baker's shop when allowed, else the stall unless 3 trips in a row brought nothing.
        if (l < 2 && bankEmpty && (shopOk() || stallEmptyTrips < 3)) {
            if (shopOk()) await shopTrip();
            if (food() < 2 && stallEmptyTrips < 3) await stallTrip();
            await walk(KNIGHT_SPOT, 3);
            continue;
        }
        if (l === 0) {
            if (!warned) { console.log(`WARN no food in the pack, the bank or the stall; picking on while HP > 6`); warned = true; }
            if (hp() <= 6) await end(false, 'no food');
        }
        if (hp() <= DMG) { idleTicks++; await waitTicks(s, 1); continue; }
        await steal();
    }
    await end(!died, died ? 'died' : 'ticks');
} catch (e) { await finish([s], false, String(e)); }
