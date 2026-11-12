// Parameterized Thieving trainer: fresh Lumbridge or resumed Draynor/Ardougne.
// TARGET=55 CAP=2500 CLEAN_FOOD=1 trains a receiver, discards earned bakery leftovers,
// and ends at Ardougne bank with earned coins deposited. Native proof is required.
// Preset floors_lumbridge. Plan: pickpocket Lumbridge men to 60 coins, sail to Ardougne (copy of boatardy.ts),
// then pickpocket the best target for the level: men below 40, guards from 40, knights from 55.
// Stun damage (skill_thieving pickpocket.dbrow): man 1, guard 2, knight 3. The bot only pickpockets a target
// when Hitpoints is above that damage plus HP_RESERVE (default 2), so a failed attempt leaves at least
// HP_RESERVE + 1: room for a stray hit (a watchman event, a Lumbridge spider) and for the walk to the boat.
// Food: bread from the Baker (2654,3311, shop 'bakery', 12 coins), eaten at 5 Hitpoints or less.
import { existsSync } from 'node:fs';
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { depositObserved } from '../../packages/core/src/deposit';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../../packages/core/src/walk';
import { approach } from '../walk-to';

const LUMBRIDGE = { x: 3222, z: 3218 };
const MARKET = { x: 2654, z: 3304 };
const BAKER = { x: 2654, z: 3311 };
const MUSA_DECK = { x: 2956, z: 3143 };
const ARDY_DECK = { x: 2683, z: 3268 };
// TARGET and CAP (game ticks) come from the environment so the same script runs a short proof or a live run to 99.
const TARGET = Number(process.env.TARGET ?? 60);
const CAP = Number(process.env.CAP ?? 2500);
const EAT_AT = 5;
// Hitpoints kept above the worst single stun. 0 is the old rule (a failed attempt could leave 1 Hitpoint).
const HP_RESERVE = Number(process.env.HP_RESERVE ?? 2);
const EXIT_BANK = { x: 2654, z: 3283 };
const BANK_ITEMS = /^(coins|bread|cake|2\/3 cake|slice of cake|chocolate slice)$/i;
if (!Number.isInteger(TARGET) || TARGET < 1 || TARGET > 99 || !Number.isInteger(CAP) || CAP < 240) await finish([], false, 'TARGET must be1..99 and CAP at least240ticks');
if (!Number.isInteger(HP_RESERVE) || HP_RESERVE < 0 || HP_RESERVE > 6) await finish([], false, 'HP_RESERVE must be 0..6');
if (process.env.RELOG === '1') await finish([], false, 'RELOG is unsupported: train through ordinary stuns');
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
const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
const now = () => s.tick();
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
    // A pickpocket on t may start only while a failed attempt still leaves HP_RESERVE + 1 Hitpoints.
    const canSteal = (t: Target) => hp() > t.dmg + HP_RESERVE;
    const cheb = (a: { x: number; z: number }, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const xp0 = xp();
    const t0 = now();
    const left = () => CAP - 180 - (now() - t0);

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
    const off = watch();

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

    let lastFail = '';
    const end = async (ok: boolean, why: string): Promise<never> => {
        if (ok && !died) {
            // Reuse the paired pack-debit / fresh bank-credit validator. Purchased
            // bakery food and training coins must not pollute the next supply lot.
            try {
                const walked = await walkPath(await sessionWalker(s), [{ ...EXIT_BANK, tol: 2 }], {
                    maxTicks: Math.max(1, Math.min(120, CAP - (now() - t0))), stop: () => died || now() - t0 >= CAP,
                });
                if (!walked.ok) throw Error(`bank exit walk: ${walked.detail}`);
                if (process.env.CLEAN_FOOD === '1') {
                    // Qualification may discard earned bakery leftovers so the next
                    // receiver job can consume only the delivered fish lot.
                    const leftovers = s.sdk.getInventory().filter(i => BANK_ITEMS.test(i.name) && !COINS.test(i.name));
                    for (const original of leftovers) {
                        if (now() - t0 >= CAP) throw Error('food cleanup tick budget exhausted');
                        const item = s.sdk.getInventory().find(i => i.slot === original.slot && i.id === original.id);
                        if (!item) throw Error('food cleanup item changed');
                        const before = s.sdk.getInventory().filter(i=>i.id===item.id).reduce((n,i)=>n+i.count,0);
                        const dropped = await s.bot.dropItem(item, 1);
                        if (!await waitUntil(s, () => !s.sdk.getInventory().some(i => i.slot === item.slot && i.id === item.id), {timeoutTicks:8})) throw Error('food cleanup pack debit unobserved');
                        console.log('TRAINING_FOOD_DISCARDED '+JSON.stringify({itemId:item.id,slot:item.slot,amount:item.count,packBefore:before,packAfter:s.sdk.getInventory().filter(i=>i.id===item.id).reduce((n,i)=>n+i.count,0),sdkSuccess:dropped.success,tick:now()-t0}));
                    }
                }
                if (!(await s.bot.openBank()).success) throw Error('bank exit open failed');
                for (const id of new Set(s.sdk.getInventory().filter(i => BANK_ITEMS.test(i.name)).map(i => i.id))) {
                    if (now() - t0 >= CAP) throw Error('bank exit tick budget exhausted');
                    const item = s.sdk.getInventory().find(i => i.id === id);
                    if (!item) throw Error('bank exit inventory changed');
                    await depositObserved(s, item);
                }
                if (s.sdk.getInventory().some(i => BANK_ITEMS.test(i.name))) throw Error('training food or coins remain in pack');
                await s.bot.closeBank();
                const final = pos();
                if (!final || final.level !== 0 || cheb(EXIT_BANK, final) > 3 || died || now() - t0 > CAP) throw Error('bank exit position, survival or tick budget failed');
                console.log(`TRAINING_BANK_EXIT ${JSON.stringify({ position: final, target: TARGET, level: lvl(), inventory: s.sdk.getInventory(), ticks: now()-t0 })}`);
            } catch (error) { ok = false; why = `bank exit: ${String(error)}`; }
        }
        off();
        const ticks = now() - t0;
        const gained = xp() - xp0;
        console.log(`RATE thieving ${gained} ${ticks}`);
        const p = pos();
        const detail = `thieving=${lvl()} xp=${gained} ticks=${ticks} at=${p?.worldX},${p?.worldZ},${p?.level} hp=${hp()} hpMin=${hpMin} `
            + `died=${died} relogs=${relogs} relogTicks=${relogTicks} logoutTicks=${logoutTicks} idleTicks=${idleTicks} pickTicks=${pickTicks} shopTicks=${shopTicks} eatTicks=${eatTicks} stunWait=${stunWait} stunMsgs=${stunMsgs} tries=${tries} stuns=${stuns} eaten=${eaten} bought=${bought} waits=${waits} walkTicks=${walkTicks} chases=${chases} coins=${coins()} bread=${bread()} `
            + `milestones=${[...marks].join(',')} jumps=${jumps.join(';')}`;
        return finish([s], ok, ok ? detail : `${why} ${detail} last=${lastFail}`);
    };

    // One pickpocket step on a target near `spot`. Returns false when it did not try (no target in range).
    // Movement rules (owner: "you move like a total moron"): take the closest target, never walk back
    // to a fixed spot, and only walk to the target area when no target is within `range` of where the bot stands.
    // Targets wander, so waiting a tick for one to come close beats chasing one across the market.
    // Set in step 3: what to do inside a stun (8 ticks when the bot cannot pickpocket but can walk, shop and eat).
    let onStun: (() => Promise<void>) | null = null;
    // A fail sets %action_delay to the stun end (thieving.rs2:49); a success does not touch it. An eat adds 3 to that value
    // (consume.rs2:129-130), and a pick waits on it (pickpocket.rs2:134). Inside the stun the eat delays the next pick by 3
    // ticks; once the value is 3 ticks old the eat costs nothing, so the bot eats on the spare tick between clicks.
    // EAT_IN_STUN=1 keeps the old timing for comparison.
    const EAT_IN_STUN = process.env.EAT_IN_STUN === '1';
    let delayEnd = -100, stunMsgs = 0, lastStunTick = -1;
    // The game message counts every stun; an eat on the same tick can hide the HP drop.
    s.onTick(() => {
        const m = (s.sdk.getState()?.gameMessages ?? []).some((x: any) => x.tick === s.tick() && /been stunned/i.test(x.text));
        if (m && lastStunTick !== s.tick()) { lastStunTick = s.tick(); stunMsgs++; delayEnd = s.tick() + 8; }
    });
    let eatFree = async (): Promise<void> => {};
    const steal = async (t: Target): Promise<boolean> => {
        const p = pos();
        const near = (s.sdk.getState()?.nearbyNpcs ?? [])
            .filter((n: any) => t.re.test(n.name) && n.reachable !== false && (!p || Math.max(Math.abs(n.x - p.worldX), Math.abs(n.z - p.worldZ)) <= t.range))
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
        // Leader rhythm (Jackalopett1, recorded): one click every 2 ticks, sent straight to the client.
        // Measured +22% over bot.pickpocketNpc (scripts/measure/pick-cycle.ts DIRECT=1: 277.5/245.9 vs 254.7/175.6).
        // The server drops clicks inside a stun. An HP drop means a fail: the stun has started, so eat inside it.
        // SLOW_PICK=1 keeps the old SDK path.
        if (process.env.SLOW_PICK !== '1') {
            const op = (npc as any).optionsWithIndex.find((o: any) => /pickpocket/i.test(o.text))!.opIndex;
            const hp0 = hp();
            await s.direct({ type: 'interactNpc', npcIndex: (npc as any).index, optionIndex: op, reason: 'SDK' });
            await waitTicks(s, 1);
            await eatFree();
            await waitTicks(s, 1);
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

    // A resumed live account is already in Ardougne (seen: it started the walk to Port Sarim from there).
    const p1 = pos();
    const inArdougne = !!p1 && cheb(MARKET, p1) <= 80;
    if (inArdougne) mark('ardougne');
    // The walks of steps 3 and 4 stay on the ground floor. A start in Ardougne on another floor (level 1 of a house at
    // 2575,3269) goes to the market with the shared walker first, by the stairs.
    if (inArdougne && p1.level !== 0) {
        const down = await approach(s, { ...MARKET, level: 0 }, () => died || left() <= 0);
        console.log(`MILESTONE approach ${now() - t0} at=${pos()?.worldX},${pos()?.worldZ},${pos()?.level}`);
        if (!down.ok) await end(false, `walk to the market from level ${p1.level}: ${down.reason} ${down.detail}`);
    }
    // ---- Step 1: Lumbridge men until 60 coins (the two boat fares, 30 each).
    const LUMB_MEN: Target = { name: 'man', re: /^man$/i, dmg: 1, spot: LUMBRIDGE, range: 15 };
    for (let i = 0; i < 600 && !inArdougne && coins() < 60 && !died && left() > 0; i++) {
        if (!canSteal(LUMB_MEN)) { await rest(); continue; }
        await steal(LUMB_MEN);
    }
    if (died) await end(false, 'died in Lumbridge');
    if (!inArdougne && coins() < 60) await end(false, `only ${coins()} coins`);
    mark('coins60');
    checkLevels();

    // ---- Step 2: boat to Ardougne (copy of scripts/generated/boatardy.ts).
    // Long legs use walkPath (packages/core/src/walk.ts): it clicks ahead every few tiles, opens a gate with one
    // click, and never waits at a corner (research/walking.md). glide (packages/core/src/glide.ts) was slower on the
    // full boat trip (Ardougne at tick 669-670 vs 499-604). A failed walk gets 2 more tries from where the bot stands.
    const walk = async (points: [number, number, number][]): Promise<boolean> => {
        const [gx, gz, gtol] = points[points.length - 1]!;
        let remainingPath = points.map(([x, z, tol]) => ({ x, z, tol }));
        for (let i = 0; i < 3 && !died && left() > 0; i++) {
            const p = pos();
            if (p && p.level === 0 && cheb({ x: gx, z: gz }, p) <= gtol + 1) break;
            const r = await walkPath(await sessionWalker(s), remainingPath, { maxTicks:Math.max(1,left()), stop: () => died || left() <= 0 });
            if (!r.ok) console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
            remainingPath = remainingPath.slice(Math.min(r.next, remainingPath.length - 1));
        }
        const p = pos();
        return !died && !!p && cheb({ x: gx, z: gz }, p) <= gtol + 1;
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
    // Same ordinary Draynor corridor already used by foodcourier; a receiver
    // resumed at its bank must not travel back east to Lumbridge first.
    const draynorStart = pos();
    const sarimRoute: [number,number,number][] = draynorStart && cheb({x:3092,z:3242},draynorStart)<=20
        ? [[3092,3250,1],[3089,3266,2],[3060,3265,3],[3047,3237,3],[3029,3217,3]]
        : [[3225,3240,3],[3180,3258,3],[3100,3285,3],[3060,3265,3],[3047,3237,3],[3029,3217,3]];
    if (!(await walk(sarimRoute))) await end(false, 'walk to Port Sarim');
    if (!(await sail(/^(seaman|captain tobias)/i, [/^yes please/i], MUSA_DECK))) await end(false, 'sail to Karamja');
    if (!(await disembark())) await end(false, 'Musa Point gangplank');
    if (!(await walk([[2920, 3160, 5], [2850, 3175, 5], [2800, 3200, 5], [2774, 3228, 3]]))) await end(false, 'walk to Brimhaven');
    if (!(await sail(/^customs officer$/i, [/journey on this ship/i, /search away/i, /^ok\.?$/i], ARDY_DECK))) await end(false, 'sail to Ardougne');
    if (!(await disembark())) await end(false, 'Ardougne gangplank');
    if (!(await walk([[MARKET.x, MARKET.z, 3]]))) await end(false, 'walk to market');
    }
    mark('ardougne');
    // ARRIVE_ONLY=1: stop at the market (the banker account uses steps 1-2 to reach Ardougne).
    if (process.env.ARRIVE_ONLY === '1') await end(true, 'arrived in Ardougne');

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
        // Direct buy clicks: the tick ledger showed bot.buyFromShop spending about 31 ticks on one trip (it waits
        // after every item). Send buy-10/5/1 clicks straight to the client, at most 5 per tick (server limit).
        let free = 28 - (s.sdk.getState()?.inventory?.length ?? 28);
        let money = coins();
        let sent = 0;
        for (const item of s.sdk.getState()?.shop?.shopItems ?? []) {
            if (!SHOP_FOOD.test(item.name) || item.count <= 0) continue;
            let n = Math.min(item.count, free, Math.floor(money / Math.max(1, item.buyPrice || 12)));
            free -= n; money -= n * (item.buyPrice || 12);
            for (const chunk of [10, 5, 1]) {
                while (n >= chunk) {
                    await s.direct({ type: 'shopBuy', slot: item.slot, amount: chunk, reason: 'SDK' });
                    n -= chunk;
                    if (++sent % 5 === 0) await waitTicks(s, 1);
                }
            }
            if (free <= 0) break;
        }
        await waitTicks(s, 1);
        await s.direct({ type: 'closeShop', reason: 'SDK' });
        const got = food() - before;
        bought += Math.max(0, got);
        // An empty shelf restocks one bread per 100 ticks: do not walk back before some has returned.
        if (got === 0) shopRetryAt = now() + 100;
    };

    // Inside a stun: top up Hitpoints. The stun also blocks walking (player/scripts/movecheck.rs2 walktrigger), so
    // shopping inside it cannot work.
    const maxHp = () => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    onStun = async () => {
        if (EAT_IN_STUN && food() > 0 && hp() <= maxHp() - 4) { const e0 = now(); if ((await s.bot.eatFood(FOOD)).success) eaten++; eatTicks += now() - e0; return; }
        stunWait++;
        await waitTicks(s, 1);
    };
    if (!EAT_IN_STUN) eatFree = async () => {
        if (hp() > maxHp() - 4 || delayEnd + 3 > now()) return;
        const item = s.sdk.getInventory().find(i => FOOD.test(i.name));
        if (!item) return;
        const op = item.optionsWithIndex.find(o => /eat/i.test(o.text))?.opIndex ?? 1;
        const r: any = await s.direct({ type: 'useInventoryItem', slot: item.slot, optionIndex: op, reason: 'SDK' });
        if (r?.success !== false) { eaten++; delayEnd += 3; }
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
        if (canSteal(t)) { if (!(await steal(t)) && t === WARRIORS && canSteal(MEN)) await steal(MEN); continue; }
        // Too low for this target and no food: men hit for 1, so use them for coins, else rest.
        if (canSteal(MEN)) await steal(MEN);
        else await rest();
    }
    checkLevels();

    const ok = lvl() >= TARGET && !died;
    await end(ok, died ? 'died' : `thieving ${lvl()} < ${TARGET}`);
} catch (e) { await finish([s], false, String(e)); }
