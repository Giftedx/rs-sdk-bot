// Fresh account (Thieving 1, Hitpoints 10, no items, Lumbridge) to Thieving 60, without dying, under 2500 ticks.
// Preset floors_lumbridge. Plan: pickpocket Lumbridge men to 60 coins, sail to Ardougne (copy of boatardy.ts),
// then pickpocket the best target for the level: men below 40, guards from 40, knights from 55.
// Stun damage (skill_thieving pickpocket.dbrow): man 1, guard 2, knight 3. The bot only pickpockets a target
// when Hitpoints is above that damage, so one failed attempt cannot kill it.
// Food: bread from the Baker (2654,3311, shop 'bakery', 12 coins), eaten at 5 Hitpoints or less.
import { existsSync } from 'node:fs';
import { openBot, finish, countItems, closeWithin } from '../../packages/core/src/bot';
import { logout } from '../../packages/core/src/logout';
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
// Warrior women (level 25, 26 XP, stun 2) stand 22 tiles west of the market, next to the men. Model: men only
// 1-40 = 465 ticks, warriors from 25 = 355 (research/thieving-ladder.md).
const WARRIORS: Target = { name: 'warrior', re: /^warrior woman$/i, dmg: 2, spot: { x: 2631, z: 3297 }, range: 10 };
const GUARDS: Target = { name: 'guard', re: /^guard$/i, dmg: 2, spot: { x: 2658, z: 3309 }, range: 14 };
const KNIGHTS: Target = { name: 'knight', re: /^knight of ardougne$/i, dmg: 3, spot: { x: 2660, z: 3308 }, range: 16 };

// A login failure must still print one RESULT line, or the proof sees no output at all.
console.log(`ERR-TRACE opening ${process.argv[2]}`);
// `s` is replaced on a relog (RELOG=1): every helper reads it at call time.
let s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
// Ticks across sessions: each session's s.tick() starts again, so finished sessions add to `base`.
let base = 0;
const now = () => base + s.tick();
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
    const t0 = now();
    const left = () => CAP - 30 - (now() - t0);

    // Death: HP 0, or a jump of more than 20 tiles in one tick that is not a boat landing on a deck (level 1).
    let hpMin = hp();
    let died = false;
    const jumps: string[] = [];
    let last = pos();
    const watch = () => s.onTick(() => {
        const p = pos();
        hpMin = Math.min(hpMin, hp());
        // HP reads 0 until the stats arrive, so only trust it once max HP is known.
        if ((s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0) > 0 && hp() <= 0) died = true;
        if (p && last && cheb({ x: last.worldX, z: last.worldZ }, p) > 20) {
            jumps.push(`${now() - t0}:${last.worldX},${last.worldZ}->${p.worldX},${p.worldZ},${p.level}`);
            const boat = p.level === 1 && (cheb(MUSA_DECK, p) <= 8 || cheb(ARDY_DECK, p) <= 8);
            if (!boat) died = true;
        }
        last = p;
    });
    let off = watch();

    const marks = new Set<string>();
    const mark = (name: string) => {
        if (marks.has(name)) return;
        marks.add(name);
        console.log(`MILESTONE ${name} ${now() - t0}`);
    };
    const checkLevels = () => {
        if (lvl() >= 40) mark('level40');
        if (lvl() >= 55) mark('level55');
        for (let l = 60; l <= 99; l += 5) if (lvl() >= l) mark(`level${l}`);
        if (lvl() >= 99) mark('level99');
    };

    let tries = 0, stuns = 0, eaten = 0, bought = 0, waits = 0, walkTicks = 0, chases = 0, relogs = 0, relogTicks = 0, logoutTicks = 0, idleTicks = 0, pickTicks = 0, shopTicks = 0, eatTicks = 0, stunWait = 0;

    // RELOG=1: a stun is a temporary varp (%stunned, not saved: _unpack/225/all.varp:112), and the boards count only
    // logged-in ticks. A logout + login measured 1 playtime tick on the practice server (scripts/measure/relog-bench.ts),
    // against 8 ticks for the stun. A refused logout (combat window) gives up after 2 s and keeps the session.
    const RELOG = process.env.RELOG === '1';
    const relog = async (): Promise<boolean> => {
        const adapter = { sdk: { sendClickComponent: (id: number) => s.direct({ type: 'clickComponent', componentId: id, reason: 'SDK' } as any) }, ended: s.ended };
        const r0 = now();
        const out = await logout(adapter as any, 2000);
        logoutTicks += s.tick() + base - r0;
        if (out !== 'logged-out') return false;
        off();
        await closeWithin([s], 5000);
        base += s.tick() + 1;
        s = await openBot(process.argv[2]!);
        last = pos();
        off = watch();
        relogs++;
        relogTicks += now() - r0;
        return true;
    };
    let lastFail = '';
    const end = async (ok: boolean, why: string): Promise<never> => {
        off();
        const ticks = now() - t0;
        const gained = xp() - xp0;
        console.log(`RATE thieving ${gained} ${ticks}`);
        const p = pos();
        const detail = `thieving=${lvl()} xp=${gained} ticks=${ticks} at=${p?.worldX},${p?.worldZ},${p?.level} hp=${hp()} hpMin=${hpMin} `
            + `died=${died} relogs=${relogs} relogTicks=${relogTicks} logoutTicks=${logoutTicks} idleTicks=${idleTicks} pickTicks=${pickTicks} shopTicks=${shopTicks} eatTicks=${eatTicks} stunWait=${stunWait} tries=${tries} stuns=${stuns} eaten=${eaten} bought=${bought} waits=${waits} walkTicks=${walkTicks} chases=${chases} coins=${coins()} bread=${bread()} `
            + `milestones=${[...marks].join(',')} jumps=${jumps.join(';')}`;
        return finish([s], ok, ok ? detail : `${why} ${detail} last=${lastFail}`);
    };

    // One pickpocket step on a target near `spot`. Returns false when it did not try (no target in range).
    // Movement rules (2026-10-23, owner: "you move like a total moron"): take the closest target, never walk back
    // to a fixed spot, and only walk to the target area when no target is within `range` of where the bot stands.
    // Targets wander, so waiting a tick for one to come close beats chasing one across the market.
    // Set in step 3: what to do inside a stun (8 ticks when the bot cannot pickpocket but can walk, shop and eat).
    let onStun: (() => Promise<void>) | null = null;
    const steal = async (t: Target): Promise<boolean> => {
        const p = pos();
        const near = (s.sdk.getState()?.nearbyNpcs ?? [])
            .filter((n: any) => t.re.test(n.name) && (!p || Math.max(Math.abs(n.x - p.worldX), Math.abs(n.z - p.worldZ)) <= t.range))
            .sort((a: any, b: any) => a.distance - b.distance);
        const npc = near[0];
        if (!npc) {
            if (p && cheb(t.spot, p) > t.range) {
                const w0 = now();
                await s.bot.walkTo(t.spot.x, t.spot.z, 3);
                walkTicks += now() - w0;
            } else { idleTicks++; await waitTicks(s, 1); }
            return false;
        }
        if (npc.distance > 1) chases++;
        tries++;
        const k0 = now();
        // Leader rhythm (Jackalopett1, recorded 2026-10-23): one click every 2 ticks, sent straight to the client.
        // Measured +22% over bot.pickpocketNpc (scripts/measure/pick-cycle.ts DIRECT=1: 277.5/245.9 vs 254.7/175.6).
        // The server drops clicks inside a stun. An HP drop means a fail: the stun has started, so eat inside it.
        // SLOW_PICK=1 keeps the old SDK path.
        if (process.env.SLOW_PICK !== '1') {
            const op = (npc as any).optionsWithIndex.find((o: any) => /pickpocket/i.test(o.text))!.opIndex;
            const hp0 = hp();
            await s.direct({ type: 'interactNpc', npcIndex: (npc as any).index, optionIndex: op, reason: 'SDK' });
            await waitTicks(s, 2);
            pickTicks += now() - k0;
            if (hp() < hp0) { stuns++; if (onStun) await onStun(); }
            return true;
        }
        const r = await s.bot.pickpocketNpc(npc);
        pickTicks += now() - k0;
        if (!r.success) {
            lastFail = `${r.reason}:${r.message}`;
            if (r.reason === 'stunned') stuns++;
            if (r.reason === 'stunned' && onStun) await onStun();
            else await waitTicks(s, 1);
        }
        return true;
    };

    // Waits for Hitpoints to regenerate when no food and no coins: pickpocketing could kill the bot.
    const rest = async () => { waits++; await waitTicks(s, 10); };

    // A resumed live account is already in Ardougne (seen 2026-10-23: it started the walk to Port Sarim from there).
    const p1 = pos();
    const inArdougne = !!p1 && cheb(MARKET, p1) <= 80;
    if (inArdougne) mark('ardougne');
    // ---- Step 1: Lumbridge men until 60 coins (the two boat fares, 30 each).
    const LUMB_MEN: Target = { name: 'man', re: /^man$/i, dmg: 1, spot: LUMBRIDGE, range: 15 };
    for (let i = 0; i < 600 && !inArdougne && coins() < 60 && !died && left() > 0; i++) {
        if (hp() <= LUMB_MEN.dmg) { await rest(); continue; }
        await steal(LUMB_MEN);
    }
    if (died) await end(false, 'died in Lumbridge');
    if (!inArdougne && coins() < 60) await end(false, `only ${coins()} coins`);
    mark('coins60');
    checkLevels();

    // ---- Step 2: boat to Ardougne (copy of scripts/generated/boatardy.ts).
    // Long legs use bot.walkTo per point. glide (packages/core/src/glide.ts) was tried 2026-10-23: 144 vs 159 ticks on
    // the Lumbridge-Port Sarim bench, but the full boat trip got slower (Ardougne at tick 669-670 vs 499-604).
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
    if (!inArdougne) {
    if (!(await walk([[3225, 3240, 3], [3180, 3258, 3], [3100, 3285, 3], [3060, 3265, 3], [3047, 3237, 3], [3029, 3217, 3]]))) await end(false, 'walk to Port Sarim');
    if (!(await sail(/^(seaman|captain tobias)/i, [/^yes please/i], MUSA_DECK))) await end(false, 'sail to Karamja');
    if (!(await disembark())) await end(false, 'Musa Point gangplank');
    if (!(await walk([[2920, 3160, 5], [2850, 3175, 5], [2800, 3200, 5], [2774, 3228, 3]]))) await end(false, 'walk to Brimhaven');
    if (!(await sail(/^customs officer$/i, [/journey on this ship/i, /search away/i, /^ok\.?$/i], ARDY_DECK))) await end(false, 'sail to Ardougne');
    if (!(await disembark())) await end(false, 'Ardougne gangplank');
    if (!(await walk([[MARKET.x, MARKET.z, 3]]))) await end(false, 'walk to market');
    }
    mark('ardougne');

    // ---- Steps 3 and 4: Ardougne pickpocketing with food from the Baker.
    // One trip fills the pack with every food line in stock (bread, cake, chocolate slice); the next trip comes
    // only when all food is gone. A cake eats in 3 bites (cake -> 2/3 cake -> slice of cake).
    const FOOD = /^(bread|cake|2\/3 cake|slice of cake|chocolate slice)$/i;
    const SHOP_FOOD = /^(bread|cake|chocolate slice)$/i;
    const food = () => countItems(s, FOOD);
    let shopRetryAt = 0;
    const stockUp = async (): Promise<void> => {
        const q0 = now();
        try { await stockUpInner(); } finally { shopTicks += now() - q0; }
    };
    const stockUpInner = async (): Promise<void> => {
        const p = pos();
        if (p && cheb(BAKER, p) > 6) await s.bot.walkTo(BAKER.x, BAKER.z, 3);
        const o = await s.bot.openShop(/^baker$/i);
        if (!o.success) { lastFail = `shop:${o.message}`; shopRetryAt = now() + 30; return; }
        const before = food();
        for (const item of s.sdk.getState()?.shop?.shopItems ?? []) {
            if (!SHOP_FOOD.test(item.name) || item.count <= 0) continue;
            const free = 28 - (s.sdk.getState()?.inventory?.length ?? 28);
            const n = Math.min(item.count, free, Math.floor(coins() / 12));
            if (n <= 0) break;
            const b = await s.bot.buyFromShop(item.name, n);
            if (!b.success) lastFail = `buy:${b.reason}:${b.message}`;
        }
        await s.bot.closeShop();
        const got = food() - before;
        bought += Math.max(0, got);
        // An empty shelf restocks one bread per 100 ticks: do not walk back before some has returned.
        if (got === 0) shopRetryAt = now() + 100;
    };

    // Inside a stun: top up Hitpoints. The stun also blocks walking (player/scripts/movecheck.rs2 walktrigger), so
    // shopping inside it cannot work.
    const maxHp = () => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    onStun = async () => {
        if (RELOG && (await relog())) return;
        if (food() > 0 && hp() <= maxHp() - 4) { const e0 = now(); if ((await s.bot.eatFood(FOOD)).success) eaten++; eatTicks += now() - e0; return; }
        stunWait++;
        await waitTicks(s, 1);
    };
    if (food() === 0) await stockUp();
    // A file .practice/stop-<bot> asks for a clean in-game logout, so a run can be swapped without the 500-tick linger.
    const stopFile = `.practice/stop-${process.argv[2]}`;
    for (let i = 0; i < 100_000 && lvl() < TARGET && !died && left() > 0; i++) {
        if (existsSync(stopFile)) { await end(false, 'stop file'); }
        checkLevels();
        const t = lvl() >= 55 ? KNIGHTS : lvl() >= 40 ? GUARDS : lvl() >= 25 ? WARRIORS : MEN;
        if (hp() <= EAT_AT && food() > 0) {
            const e0 = now();
            const e = await s.bot.eatFood(FOOD);
            eatTicks += now() - e0;
            if (e.success) eaten++;
            else await waitTicks(s, 1);
            continue;
        }
        // Refill only when all food is gone.
        if (food() === 0 && now() >= shopRetryAt && coins() >= 12) {
            await stockUp();
            continue;
        }
        // Both warriors can be busy (other players); the men stand 10 tiles away, so use them instead of waiting.
        if (hp() > t.dmg) { if (!(await steal(t)) && t === WARRIORS && hp() > MEN.dmg) await steal(MEN); continue; }
        // Too low for this target and no food: men hit for 1, so use them for coins, else rest.
        if (hp() > MEN.dmg) await steal(MEN);
        else await rest();
    }
    checkLevels();

    const ok = lvl() >= TARGET && !died;
    await end(ok, died ? 'died' : `thieving ${lvl()} < ${TARGET}`);
} catch (e) { await finish([s], false, String(e)); }
