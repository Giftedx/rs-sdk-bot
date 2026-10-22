// Fresh account (Thieving 1, Hitpoints 10, no items, Lumbridge) to Thieving 60, without dying, under 2500 ticks.
// Preset floors_lumbridge. Plan: pickpocket Lumbridge men to 60 coins, sail to Ardougne (copy of boatardy.ts),
// then pickpocket the best target for the level: men below 40, guards from 40, knights from 55.
// Stun damage (skill_thieving pickpocket.dbrow): man 1, guard 2, knight 3. The bot only pickpockets a target
// when Hitpoints is above that damage, so one failed attempt cannot kill it.
// Food: bread from the Baker (2654,3311, shop 'bakery', 12 coins), eaten at 5 Hitpoints or less.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';

const LUMBRIDGE = { x: 3222, z: 3218 };
const MARKET = { x: 2654, z: 3304 };
const BAKER = { x: 2654, z: 3311 };
const MUSA_DECK = { x: 2956, z: 3143 };
const ARDY_DECK = { x: 2683, z: 3268 };
// TARGET and CAP (game ticks) come from the environment so the same script runs a short proof or a live run to 99.
const TARGET = Number(process.env.TARGET ?? 60);
const CAP = Number(process.env.CAP ?? 2500);
const EAT_AT = 5;
const BREAD = /^bread$/i;
const COINS = /^coins$/i;

type Target = { name: string; re: RegExp; dmg: number; spot: { x: number; z: number }; range: number };
const MEN: Target = { name: 'man', re: /^(man|woman)$/i, dmg: 1, spot: { x: 2621, z: 3293 }, range: 20 };
const GUARDS: Target = { name: 'guard', re: /^guard$/i, dmg: 2, spot: { x: 2658, z: 3309 }, range: 14 };
const KNIGHTS: Target = { name: 'knight', re: /^knight of ardougne$/i, dmg: 3, spot: { x: 2660, z: 3308 }, range: 16 };

// A login failure must still print one RESULT line, or the proof sees no output at all.
console.log(`ERR-TRACE opening ${process.argv[2]}`);
const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    // A new live account starts on Tutorial Island (seen: START 3094 3106 0 on the demo server). Skip it first.
    await waitTicks(s, 5);
    const p0 = s.sdk.getState()?.player;
    if (p0 && p0.worldX < 3160 && p0.worldZ < 3130) {
        const t = await s.bot.skipTutorial();
        console.log(`MILESTONE tutorial ${t.success ? 'ok' : 'fail'}`);
        if (!t.success) await finish([s], false, `tutorial skip failed: ${t.message}`);
    }
    const xp = () => s.sdk.getSkillXp('Thieving') ?? 0;
    const lvl = () => s.sdk.getSkill('Thieving')?.baseLevel ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const pos = () => s.sdk.getState()?.player;
    const coins = () => countItems(s, COINS);
    const bread = () => countItems(s, BREAD);
    const cheb = (a: { x: number; z: number }, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const xp0 = xp();
    const t0 = s.tick();
    const left = () => CAP - 30 - (s.tick() - t0);

    // Death: HP 0, or a jump of more than 20 tiles in one tick that is not a boat landing on a deck (level 1).
    let hpMin = hp();
    let died = false;
    const jumps: string[] = [];
    let last = pos();
    const off = s.onTick(() => {
        const p = pos();
        hpMin = Math.min(hpMin, hp());
        if (hp() <= 0) died = true;
        if (p && last && cheb({ x: last.worldX, z: last.worldZ }, p) > 20) {
            jumps.push(`${s.tick() - t0}:${last.worldX},${last.worldZ}->${p.worldX},${p.worldZ},${p.level}`);
            const boat = p.level === 1 && (cheb(MUSA_DECK, p) <= 8 || cheb(ARDY_DECK, p) <= 8);
            if (!boat) died = true;
        }
        last = p;
    });

    const marks = new Set<string>();
    const mark = (name: string) => {
        if (marks.has(name)) return;
        marks.add(name);
        console.log(`MILESTONE ${name} ${s.tick() - t0}`);
    };
    const checkLevels = () => {
        if (lvl() >= 40) mark('level40');
        if (lvl() >= 55) mark('level55');
        for (let l = 60; l <= 99; l += 5) if (lvl() >= l) mark(`level${l}`);
        if (lvl() >= 99) mark('level99');
    };

    let tries = 0, stuns = 0, eaten = 0, bought = 0, waits = 0;
    let lastFail = '';
    const end = async (ok: boolean, why: string): Promise<never> => {
        off();
        const ticks = s.tick() - t0;
        const gained = xp() - xp0;
        console.log(`RATE thieving ${gained} ${ticks}`);
        const p = pos();
        const detail = `thieving=${lvl()} xp=${gained} ticks=${ticks} at=${p?.worldX},${p?.worldZ},${p?.level} hp=${hp()} hpMin=${hpMin} `
            + `died=${died} tries=${tries} stuns=${stuns} eaten=${eaten} bought=${bought} waits=${waits} coins=${coins()} bread=${bread()} `
            + `milestones=${[...marks].join(',')} jumps=${jumps.join(';')}`;
        return finish([s], ok, ok ? detail : `${why} ${detail} last=${lastFail}`);
    };

    // One pickpocket step on a target near `spot`. Returns false when it did not try (no target in range).
    const steal = async (t: Target): Promise<boolean> => {
        const npc = s.sdk.findNearbyNpc(t.re, { reachable: true });
        const p = pos();
        const far = npc && Math.max(Math.abs(npc.x - t.spot.x), Math.abs(npc.z - t.spot.z)) > t.range;
        if (!npc || far) {
            if (p && cheb(t.spot, p) > 5) await s.bot.walkTo(t.spot.x, t.spot.z, 3);
            else await waitTicks(s, 2);
            return false;
        }
        tries++;
        const r = await s.bot.pickpocketNpc(npc);
        if (!r.success) {
            lastFail = `${r.reason}:${r.message}`;
            if (r.reason === 'stunned') stuns++;
            await waitTicks(s, 1);
        }
        return true;
    };

    // Waits for Hitpoints to regenerate when no food and no coins: pickpocketing could kill the bot.
    const rest = async () => { waits++; await waitTicks(s, 10); };

    // ---- Step 1: Lumbridge men until 60 coins (the two boat fares, 30 each).
    const LUMB_MEN: Target = { name: 'man', re: /^man$/i, dmg: 1, spot: LUMBRIDGE, range: 15 };
    for (let i = 0; i < 600 && coins() < 60 && !died && left() > 0; i++) {
        if (hp() <= LUMB_MEN.dmg) { await rest(); continue; }
        await steal(LUMB_MEN);
    }
    if (died) await end(false, 'died in Lumbridge');
    if (coins() < 60) await end(false, `only ${coins()} coins`);
    mark('coins60');
    checkLevels();

    // ---- Step 2: boat to Ardougne (copy of scripts/generated/boatardy.ts).
    const walk = async (points: [number, number, number][]): Promise<boolean> => {
        for (const [x, z, tol] of points) {
            for (let i = 0; i < 3 && !died; i++) {
                const p = pos();
                if (p && p.level === 0 && cheb({ x, z }, p) <= tol + 1) break;
                await s.bot.walkTo(x, z, tol);
            }
            const p = pos();
            if (died || !p || cheb({ x, z }, p) > tol + 1) return false;
        }
        return true;
    };
    const converse = async (pats: RegExp[], done: () => boolean, maxTicks: number): Promise<boolean> => {
        for (let i = 0; i < maxTicks && !died; i++) {
            if (done()) return true;
            const d = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opt = d.options.find(o => pats.some(re => re.test(o.text)));
                await s.sdk.sendClickDialog(opt ? opt.index : 0);
            }
            await waitTicks(s, 1);
        }
        return done();
    };
    const disembark = async (): Promise<boolean> => {
        for (let i = 0; i < 4 && !died; i++) {
            if (pos()?.level === 0) return true;
            const d = s.sdk.getDialog();
            if (d?.isOpen) { await s.sdk.sendClickDialog(0); await waitTicks(s, 1); continue; }
            const plank = s.sdk.findNearbyLoc(/^gangplank$/i);
            if (!plank) { await waitTicks(s, 2); continue; }
            await s.bot.interactLoc(plank, 'Cross');
            await waitUntil(s, st => st?.player?.level === 0, { timeoutTicks: 10 });
        }
        return pos()?.level === 0;
    };
    const sail = async (npc: RegExp, pats: RegExp[], deck: { x: number; z: number }): Promise<boolean> => {
        const landed = () => { const p = pos(); return !!p && p.level === 1 && cheb(deck, p) <= 8; };
        for (let tryN = 0; tryN < 3 && !died && !landed(); tryN++) {
            const t = await s.bot.talkTo(npc);
            if (!t.success) { console.log(`TALK fail ${t.message}`); await waitTicks(s, 2); continue; }
            await converse(pats, landed, 60);
        }
        return landed();
    };

    // Route from research/route-danger.ts: 357 tiles, clear of the jail guards (26), brown bear (21) and dark wizards;
    // the old route (3105,3250) passed 2 tiles from a jail guard, and two fresh runs died there.
    if (!(await walk([[3225, 3240, 3], [3180, 3258, 3], [3100, 3285, 3], [3060, 3265, 3], [3047, 3237, 3], [3029, 3217, 3]]))) await end(false, 'walk to Port Sarim');
    if (!(await sail(/^(seaman|captain tobias)/i, [/^yes please/i], MUSA_DECK))) await end(false, 'sail to Karamja');
    if (!(await disembark())) await end(false, 'Musa Point gangplank');
    if (!(await walk([[2920, 3160, 5], [2850, 3175, 5], [2800, 3200, 5], [2774, 3228, 3]]))) await end(false, 'walk to Brimhaven');
    if (!(await sail(/^customs officer$/i, [/journey on this ship/i, /search away/i, /^ok\.?$/i], ARDY_DECK))) await end(false, 'sail to Ardougne');
    if (!(await disembark())) await end(false, 'Ardougne gangplank');
    if (!(await walk([[MARKET.x, MARKET.z, 3]]))) await end(false, 'walk to market');
    mark('ardougne');

    // ---- Steps 3 and 4: Ardougne pickpocketing with bread from the Baker.
    // Buys bread up to 5. After an empty or failed visit, waits `shopRetry` ticks before the next visit.
    let shopRetryAt = 0;
    const buyBread = async (): Promise<void> => {
        const want = Math.min(5 - bread(), Math.floor(coins() / 12));
        if (want <= 0) return;
        const p = pos();
        if (p && cheb(BAKER, p) > 6) await s.bot.walkTo(BAKER.x, BAKER.z, 3);
        const o = await s.bot.openShop(/^baker$/i);
        if (!o.success) { lastFail = `shop:${o.message}`; shopRetryAt = s.tick() + 30; return; }
        const before = bread();
        const b = await s.bot.buyFromShop(BREAD, want);
        await s.bot.closeShop();
        const got = bread() - before;
        bought += Math.max(0, got);
        if (!b.success) lastFail = `buy:${b.reason}:${b.message}`;
        if (got < want) shopRetryAt = s.tick() + 50;
    };

    for (let i = 0; i < 100_000 && lvl() < TARGET && !died && left() > 0; i++) {
        checkLevels();
        const t = lvl() >= 55 ? KNIGHTS : lvl() >= 40 ? GUARDS : MEN;
        if (hp() <= EAT_AT && bread() > 0) {
            const e = await s.bot.eatFood(BREAD);
            if (e.success) eaten++;
            else await waitTicks(s, 1);
            continue;
        }
        const canShop = s.tick() >= shopRetryAt && coins() >= 12;
        // Refill when the pack is low, or at once when food is gone and Hitpoints is low.
        if (canShop && ((bread() < 3 && coins() >= 12 * (5 - bread())) || (bread() === 0 && hp() <= EAT_AT))) {
            await buyBread();
            continue;
        }
        if (hp() > t.dmg) { await steal(t); continue; }
        // Too low for this target and no food: men hit for 1, so use them for coins, else rest.
        if (hp() > MEN.dmg) await steal(MEN);
        else await rest();
    }
    checkLevels();

    const ok = lvl() >= TARGET && !died;
    await end(ok, died ? 'died' : `thieving ${lvl()} < ${TARGET}`);
} catch (e) { await finish([s], false, String(e)); }
