// Gold farm: pickpocket knights of Ardougne at Thieving 99, bank coins and refill lobsters at the south bank.
// Game data (skill_thieving/configs/pickpocking/pickpocket.dbrow:81-90): knight of Ardougne, success 50..240 of 256
// (94% at 99), 50 coins, stun 8 ticks, fail damage 3. Model: about 18.8 coins per tick at level 99.
// Knights spawn at (2652,3318) and (2653,3300) and wander. Bank spot (2654,3283), bankers at (2657,3280-3286).
// Env: TICKS (default 9000) game ticks; BANK_AT (default 25000) coins in the pack that start a bank trip;
// FOOD_FROM=<account>: with no lobsters in the pack or the bank, serve one trade from that account (180 s) first.
// Preset goldfarm_knights. Copies the 2-tick direct click and eating inside the stun from scripts/generated/thieving60.ts.
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
const DMG = 3;

console.log(`ERR-TRACE opening ${process.argv[2]}`);
const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 5);
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const maxHp = () => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    const inv = () => st()?.inventory ?? [];
    const edible = (i: any) => LOBSTER.test(i.name) && (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text));
    const lobsters = () => inv().filter(edible).reduce((n, i) => n + i.count, 0);
    const notes = () => inv().filter(i => LOBSTER.test(i.name) && !edible(i));
    const coins = () => inv().filter(i => COINS.test(i.name)).reduce((n, i) => n + i.count, 0);
    const cheb = (a: Tile, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const eatAt = () => Math.max(DMG, maxHp() - 12);
    const t0 = s.tick();
    const now = () => s.tick() - t0;
    const coins0 = coins();
    const stopFile = `.practice/stop-${process.argv[2]}`;

    let picks = 0, noops = 0, fails = 0, eaten = 0, bankTrips = 0, bankTicks = 0, walkTicks = 0, idleTicks = 0, eatTicks = 0, banked = 0;
    let bankFails = 0;
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
        const detail = `ticks=${ticks} picks=${picks} fails=${fails} noops=${noops} coinsGained=${gained} coinsPerTick=${(gained / Math.max(1, ticks)).toFixed(2)} `
            + `eaten=${eaten} bankTrips=${bankTrips} bankTicks=${bankTicks} walkTicks=${walkTicks} idleTicks=${idleTicks} eatTicks=${eatTicks} `
            + `hpMin=${hpMin} died=${died} banked=${banked} packCoins=${coins()} lobsters=${lobsters()} hp=${hp()} at=${p?.worldX},${p?.worldZ},${p?.level}`;
        return finish([s], ok, ok ? detail : `${why} ${detail} last=${lastFail}`);
    };

    const eat = async (): Promise<boolean> => {
        const e0 = s.tick();
        const r = await s.bot.eatFood(LOBSTER);
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

    // Inside the 8-tick stun the bot cannot pickpocket or walk, but it can eat for free.
    const onStun = async () => {
        if (lobsters() > 0 && hp() <= eatAt()) { await eat(); return; }
        await waitTicks(s, 1);
    };

    // One pickpocket attempt on the closest knight near the player, or a walk or wait when none is in range.
    const steal = async () => {
        const p = pos();
        const avoid = randomEventsOf(s)?.avoid().npcs;
        const npc = (st()?.nearbyNpcs ?? [])
            .filter((n: any) => KNIGHT.test(n.name) && !avoid?.has(n.index) && (!p || Math.max(Math.abs(n.x - p.worldX), Math.abs(n.z - p.worldZ)) <= RANGE))
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
        // picks = attempts the server ran (coins or a hit); a click it dropped (inside a stun, or still walking) is a noop.
        if (hp() < hp0) { picks++; fails++; await onStun(); }
        else if (coins() > c0) picks++;
        else noops++;
    };

    console.log(`GOLDFARM ticks=${TICKS} eatAt=${eatAt()} maxHp=${maxHp()} lobsters=${lobsters()} notes=${notes().length} coins=${coins0} foodFrom=${FOOD_FROM || '-'}`);
    // Start: notes in the pack, or no food, means a bank visit first.
    if (lobsters() < 2 || notes().length > 0) {
        await refill();
        if (lobsters() === 0 && bankEmpty && FOOD_FROM) await foodByTrade();
    }

    let nextMark = 1000;
    while (now() < TICKS && !died) {
        if (existsSync(stopFile)) await end(false, 'stop file');
        if (now() >= nextMark) { console.log(`MILESTONE t=${now()} banked=${banked} packCoins=${coins()} lobsters=${lobsters()} picks=${picks} fails=${fails} eaten=${eaten}`); nextMark += 1000; }
        if (randomEventsOf(s)?.busy()) { idleTicks++; await waitTicks(s, 1); continue; }
        const l = lobsters();
        if (hp() <= eatAt() && l > 0) { if (!(await eat())) await waitTicks(s, 1); continue; }
        if ((l < 2 && !bankEmpty) || coins() >= BANK_AT || notes().length > 0) {
            await refill();
            await walk(KNIGHT_SPOT, 3);
            continue;
        }
        if (l === 0) {
            if (!warned) { console.log(`WARN no lobsters in the pack or the bank; picking on while HP > 6`); warned = true; }
            if (hp() <= 6) await end(false, 'no food');
        }
        if (hp() <= DMG) { idleTicks++; await waitTicks(s, 1); continue; }
        await steal();
    }
    await end(!died, died ? 'died' : 'ticks');
} catch (e) { await finish([s], false, String(e)); }
