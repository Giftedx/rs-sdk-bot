// Fish and cook food for the gold farm (research/food-chain.md). Fly fishes trout and salmon at the Lumbridge river
// (3-tick: knife on logs + Make 1 + Lure in one tick, copied from scripts/generated/fishing30.ts), cooks them on the
// fireplace in the Lumbridge general store (3214,3249), and banks the cooked fish at Draynor (3092,3243).
// Content (rev 289): the Lumbridge castle range (cooksquestrange) needs Cook's Assistant complete
// (quest_cook.rs2:93-100); a fireplace is a cooking_fire loc (cooking_sources.loc) with no gate. Trout needs Cooking 15,
// salmon 25 (cooking_generic.dbrow). Below 15 the bot kills chickens (pen 3225-3235,3297-3300) for raw chicken
// (Cooking 1) and feathers (chicken.rs2: always 1 raw chicken; 15 feathers 1/4, 5 feathers 1/4).
// Fly fishing uses 1 feather per fish; with fewer than FEATHER_MIN feathers the bot tops up at the chickens.
// Env: TICKS (default 1500) game ticks; FEATHER_MIN (default 3); FEATHER_FILL (default 60) feathers a chicken trip
// stops at; CHICKEN_CAP (default 400) ticks per chicken trip; GIVE_TO=<account>: at each bank visit, when that
// player stands within 12 tiles, withdraw every cooked fish as notes and trade them over; HANDOFF_ONLY=1: walk to
// the bank, wait up to WAIT (default 900) ticks for GIVE_TO, hand off and stop.
import { existsSync } from 'node:fs';
import { openBot, finish, countItems, randomEventsOf } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import { componentId } from '../packages/core/src/logout';

type Tile = { x: number; z: number };
type Pt = [number, number, number];
const TICKS = Number(process.env.TICKS ?? 1500);
const FEATHER_MIN = Number(process.env.FEATHER_MIN ?? 3);
const FEATHER_FILL = Number(process.env.FEATHER_FILL ?? 60);
const CHICKEN_CAP = Number(process.env.CHICKEN_CAP ?? 400);
const GIVE_TO = process.env.GIVE_TO?.trim() || '';
const HANDOFF_ONLY = process.env.HANDOFF_ONLY === '1';
const WAIT = Number(process.env.WAIT ?? 900);

const FLY_SPOT: Tile = { x: 3239, z: 3251 };
const FIREPLACE: Tile = { x: 3214, z: 3249 };
const BANK: Tile = { x: 3092, z: 3243 };
const CHICKENS: Tile = { x: 3230, z: 3298 };
// Fly -> fireplace stays north of z 3248 (giant spiders at 3243,3236 and 3245,3232; scripts/generated/fishing30.ts).
const TO_FIRE: Pt[] = [[3226, 3250, 2], [FIREPLACE.x + 1, FIREPLACE.z, 1]];
// Fireplace -> Draynor bank: the fishing30 route north of the jail guards (3109,3237 and 3120,3238), then the
// x 3089-3092 lane south into the bank (6+ tiles from the dark wizards at 3084,3236 and 3085,3238).
const FIRE_TO_BANK: Pt[] = [[3180, 3258, 3], [3100, 3285, 3], [3089, 3266, 2], [3092, 3250, 1], [BANK.x, BANK.z, 2]];
const BANK_TO_FLY: Pt[] = [[3092, 3250, 1], [3089, 3266, 2], [3100, 3285, 3], [3180, 3258, 3], [3226, 3250, 2], [FLY_SPOT.x, FLY_SPOT.z, 1]];
const FIRE_TO_FLY: Pt[] = [[3226, 3250, 2], [FLY_SPOT.x, FLY_SPOT.z, 1]];
const FLY_TO_CHICKENS: Pt[] = [[3226, 3262, 2], [3232, 3285, 2], [CHICKENS.x, CHICKENS.z, 3]];
const CHICKENS_TO_FIRE: Pt[] = [[3232, 3285, 2], [3226, 3262, 2], [FIREPLACE.x + 1, FIREPLACE.z, 1]];

const ROD = /^fly fishing rod$/i;
const FEATHER = /^feather$/i;
const RAW_FISH = /^raw (trout|salmon)$/i;
const RAW_ANY = /^raw (trout|salmon|chicken)$/i;
const COOKED = /^(trout|salmon)$/i;
const BURNT = /^burnt (fish|chicken)$/i;
const CHICKEN = /^chicken$/i;
const LURE = /^lure$/i;
// Cooking level per raw item (cooking_generic.dbrow: trout 15, salmon 25, chicken 1).
const NEED: Record<string, number> = { 'raw trout': 15, 'raw salmon': 25, 'raw chicken': 1 };
const WHIRLPOOL = new Set([403, 404, 405, 406]);

const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 3);
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const inv = () => (st()?.inventory ?? []) as any[];
    const invLen = () => inv().length;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const cook = () => s.sdk.getSkill('Cooking')?.baseLevel ?? 1;
    const cookXp = () => s.sdk.getSkillXp('Cooking') ?? 0;
    const fishXp = () => s.sdk.getSkillXp('Fishing') ?? 0;
    const cheb = (a: Tile, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const edible = (i: any) => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text));
    const cookedInPack = () => inv().filter(i => COOKED.test(i.name) && edible(i)).reduce((n, i) => n + i.count, 0);
    const cookable = () => inv().filter(i => RAW_ANY.test(i.name) && cook() >= (NEED[i.name.toLowerCase()] ?? 99));
    const slotOf = (re: RegExp) => inv().find(i => re.test(i.name))?.slot as number | undefined;
    const t0 = s.tick();
    const now = () => s.tick() - t0;
    const stopFile = `.practice/stop-${process.argv[2]}`;
    const make1 = componentId('skill_multi3:make1_a');

    let died = false, hpMin = hp(), lastFail = '';
    let last = pos();
    const off = s.onTick(() => {
        const p = pos();
        hpMin = Math.min(hpMin, hp());
        if ((s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0) > 0 && hp() <= 0) died = true;
        if (p && last && cheb({ x: last.worldX, z: last.worldZ }, p) > 20 && cheb({ x: 3222, z: 3218 }, p) <= 3) died = true;
        last = p;
    });

    let fishTicks = 0, cookTicks = 0, walkTicks = 0, bankTicks = 0, chickenTicks = 0, idleTicks = 0, giveTicks = 0;
    let caught = 0, cooked = 0, burnt = 0, banked = 0, bankFish = 0, packs = 0, cycles = 0, kills = 0, feathersGot = 0, given = 0, events = 0, eats = 0;
    const cook0 = cook(), fishXp0 = fishXp();

    const end = async (ok: boolean, why: string): Promise<never> => {
        off();
        const ticks = now();
        const p = pos();
        const tries = cooked + burnt;
        const detail = `ticks=${ticks} caught=${caught} cooked=${cooked} burnt=${burnt} burnPct=${(100 * burnt / Math.max(1, tries)).toFixed(1)} banked=${banked} bankFish=${bankFish} given=${given} `
            + `foodPerKTicks=${(1000 * banked / Math.max(1, ticks)).toFixed(1)} cooking=${cook0}->${cook()} fishXp=${fishXp() - fishXp0} packs=${packs} cycles=${cycles} kills=${kills} feathersGot=${feathersGot} `
            + `fishTicks=${fishTicks} cookTicks=${cookTicks} walkTicks=${walkTicks} bankTicks=${bankTicks} chickenTicks=${chickenTicks} giveTicks=${giveTicks} idleTicks=${idleTicks} `
            + `events=${events} eats=${eats} feathers=${countItems(s, FEATHER)} packCooked=${cookedInPack()} hp=${hp()} hpMin=${hpMin} died=${died} at=${p?.worldX},${p?.worldZ},${p?.level}`;
        return finish([s], ok, ok ? detail : `${why} ${detail} last=${lastFail}`);
    };
    const over = () => died || now() >= TICKS || existsSync(stopFile);

    const walk = async (points: Pt[]): Promise<boolean> => {
        const w0 = s.tick();
        try {
            const [gx, gz, gtol] = points[points.length - 1]!;
            let left = points.map(([x, z, tol]) => ({ x, z, tol }));
            for (let i = 0; i < 3 && !died; i++) {
                const p = pos();
                if (p && cheb({ x: gx, z: gz }, p) <= gtol + 1) return true;
                const r = await walkPath(await sessionWalker(s), left, { stop: () => died });
                if (!r.ok) { lastFail = `walk ${r.detail}`; await waitTicks(s, 1); }
                left = left.slice(Math.min(r.next, left.length - 1));
            }
            const p = pos();
            return !died && !!p && cheb({ x: gx, z: gz }, p) <= gtol + 1;
        } finally { walkTicks += s.tick() - w0; }
    };
    const go = async (points: Pt[], where: string) => { if (!(await walk(points))) await end(false, `walk ${where}`); };

    // Eats a cooked fish (or chicken) below HP 5. Always takes at least one tick.
    const eatIfLow = async (): Promise<boolean> => {
        if (hp() >= 5) return false;
        const f = inv().find(i => /^(trout|salmon|cooked chicken)$/i.test(i.name) && edible(i));
        if (!f) return false;
        const e0 = s.tick();
        const r = await s.bot.eatFood(f);
        if (r.success) eats++; else lastFail = `eat:${r.message}`;
        if (s.tick() === e0) await waitTicks(s, 1);
        return true;
    };

    // A river troll (fishing random event) attacks: walk 12+ tiles off until it loses its target.
    const troll = async (): Promise<boolean> => {
        const t = (st()?.nearbyNpcs ?? []).find((n: any) => /river troll/i.test(n.name) && n.distance <= 10);
        if (!t) return false;
        events++;
        await eatIfLow();
        await walk([[FLY_SPOT.x - 14, FLY_SPOT.z + 8, 2]]);
        await waitTicks(s, 3);
        return true;
    };

    // Cooks every raw item the level allows on the fireplace. One use per tick (cooking.rs2 p_delay(1); the raw item
    // is deleted after the delay), level-up pages closed in the same tick (research/supply-floors.md).
    const cookAll = async () => {
        if (cookable().length === 0) return;
        await go(TO_FIRE, 'to fireplace');
        const c0 = s.tick();
        try {
            // MODE=wait (COOK_MODE) clicks again only after the raw item is gone; the default clicks every tick, so the
            // next use is already queued when the p_delay ends.
            const waitMode = process.env.COOK_MODE === 'wait';
            let stall = 0;
            const raw0 = countItems(s, RAW_ANY), burnt0 = countItems(s, BURNT);
            let rawPrev = raw0;
            while (cookable().length > 0 && stall < 12 && !died) {
                if (randomEventsOf(s)?.busy()) { await waitTicks(s, 1); continue; }
                const fire = (st()?.nearbyLocs ?? []).find((l: any) => /^fireplace$/i.test(l.name) && l.x === FIREPLACE.x && l.z === FIREPLACE.z) as any;
                if (!fire) { lastFail = 'no fireplace'; stall++; await waitTicks(s, 1); continue; }
                // The best item the level allows first (salmon, trout, then chicken).
                const items = cookable().sort((a, b) => (NEED[b.name.toLowerCase()] ?? 0) - (NEED[a.name.toLowerCase()] ?? 0));
                const item = items[0]!;
                if (s.sdk.getDialog()?.isOpen || st()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                await s.direct({ type: 'useItemOnLoc', itemSlot: item.slot, x: fire.x, z: fire.z, locId: fire.id, reason: 'SDK' });
                if (waitMode) { for (let i = 0; i < 5 && countItems(s, RAW_ANY) >= rawPrev && !died; i++) await waitTicks(s, 1); }
                else await waitTicks(s, 1);
                const raw = countItems(s, RAW_ANY);
                if (raw < rawPrev) stall = 0; else stall++;
                rawPrev = raw;
            }
            if (stall >= 12) console.log(`WARN cooking stalled: ${lastFail}`);
            // Burnt items have their own names; every other raw item that went is a success.
            const b = countItems(s, BURNT) - burnt0;
            burnt += b;
            cooked += raw0 - countItems(s, RAW_ANY) - b;
        } finally { cookTicks += s.tick() - c0; }
        console.log(`COOK cooked=${cooked} burnt=${burnt} cooking=${cook()} t=${now()}`);
    };

    // Kills chickens until the pack holds `feathers` feathers and `raw` raw chickens, or CHICKEN_CAP ticks pass.
    const chickenTrip = async (feathers: number, raw: number) => {
        await go(FLY_TO_CHICKENS, 'to chickens');
        const k0 = s.tick();
        const f0 = countItems(s, FEATHER);
        try {
            while (!over() && s.tick() - k0 < CHICKEN_CAP && (countItems(s, FEATHER) < feathers || countItems(s, /^raw chicken$/i) < raw)) {
                if (randomEventsOf(s)?.busy()) { await waitTicks(s, 1); continue; }
                if (await eatIfLow()) continue;
                const wantRaw = countItems(s, /^raw chicken$/i) < raw && invLen() < 28;
                const loot = (st()?.groundItems ?? []).filter((g: any) => g.distance <= 8 && g.reachable !== false
                    && (FEATHER.test(g.name) || (wantRaw && /^raw chicken$/i.test(g.name))))
                    .sort((a: any, b: any) => a.distance - b.distance)[0] as any;
                if (loot && (FEATHER.test(loot.name) ? true : invLen() < 28)) {
                    const n0 = countItems(s, new RegExp(`^${loot.name}$`, 'i'));
                    await s.direct({ type: 'pickupItem', x: loot.x, z: loot.z, itemId: loot.id, reason: 'SDK' });
                    await waitUntil(s, () => countItems(s, new RegExp(`^${loot.name}$`, 'i')) > n0, { timeoutTicks: Math.min(12, loot.distance + 3) });
                    continue;
                }
                const me = pos();
                const c = (st()?.nearbyNpcs ?? []).filter((n: any) => CHICKEN.test(n.name) && n.reachable !== false && (n.hp ?? 1) > 0
                    && me && Math.max(Math.abs(n.x - CHICKENS.x), Math.abs(n.z - CHICKENS.z)) <= 10)
                    .sort((a: any, b: any) => a.distance - b.distance)[0] as any;
                if (!c) { idleTicks++; await waitTicks(s, 1); continue; }
                const op = c.optionsWithIndex?.find((o: any) => /^attack$/i.test(o.text))?.opIndex;
                if (op === undefined) { await waitTicks(s, 1); continue; }
                await s.direct({ type: 'interactNpc', npcIndex: c.index, optionIndex: op, reason: 'SDK' });
                // Fight until the chicken is gone (dead) or 20 ticks pass.
                const gone = await waitUntil(s, x => !(x?.nearbyNpcs ?? []).some((n: any) => n.index === c.index && (n.hp ?? 1) > 0), { timeoutTicks: 20 });
                if (gone) { kills++; await waitTicks(s, 1); }
            }
        } finally {
            chickenTicks += s.tick() - k0;
            feathersGot += Math.max(0, countItems(s, FEATHER) - f0);
            console.log(`CHICKENS kills=${kills} feathers=${countItems(s, FEATHER)} raw=${countItems(s, /^raw chicken$/i)} t=${now()}`);
        }
        // Raw chicken is cooked at once (it trains Cooking to 15 for trout).
        if (cookable().length) { await go(CHICKENS_TO_FIRE, 'chickens to fireplace'); await cookAll(); }
    };

    // Draynor bank: deposit cooked and burnt food and raw chicken; hand the cooked fish to GIVE_TO when it is here.
    const bankTrip = async () => {
        await go(FIRE_TO_BANK, 'to Draynor bank');
        const b0 = s.tick();
        try {
            const o = await s.bot.openBank();
            if (!o.success) { lastFail = `bank:${o.message}`; await waitTicks(s, 1); return; }
            // Raw fish the level cannot cook yet (salmon below 25) goes in too, or it would fill the pack for good.
            // One deposit-all per item name (a second call on a name already gone waits for its timeout: 614 bank
            // ticks in the first practice run).
            const DEPOSIT = /^(trout|salmon|burnt fish|burnt chicken|raw chicken|cooked chicken|bones|raw trout|raw salmon)$/i;
            for (const name of [...new Set(inv().filter(i => DEPOSIT.test(i.name)).map(i => i.name as string))]) {
                const re = new RegExp(`^${name}$`, 'i');
                const before = countItems(s, re);
                if (before === 0) continue;
                const d = await s.bot.depositItem(re, -1);
                if (!d.success) lastFail = `deposit ${name}:${d.message}`;
                else if (COOKED.test(name)) banked += d.amountDeposited ?? (before - countItems(s, re));
            }
            bankFish = ['Trout', 'Salmon'].reduce((n, name) => n + (s.sdk.findBankItem(new RegExp(`^${name}$`, 'i'))?.count ?? 0), 0);
            packs++;
            console.log(`BANK pack=${packs} banked=${banked} bankFish=${bankFish} t=${now()}`);
            await s.bot.closeBank();
        } finally { bankTicks += s.tick() - b0; }
        if (GIVE_TO) await handOff(0);
    };

    // Withdraws every cooked fish as notes and trades them to GIVE_TO. waitTicks > 0 waits for the player to arrive.
    const handOff = async (waitFor: number) => {
        const who = new RegExp(`^${GIVE_TO.replace(/[^a-zA-Z0-9 _-]/g, '')}$`, 'i');
        const near = () => (st()?.nearbyPlayers ?? []).some((p: any) => who.test(p.name) && p.distance <= 12);
        const g0 = s.tick();
        try {
            if (!near() && waitFor > 0) await waitUntil(s, () => near() || existsSync(stopFile), { timeoutTicks: waitFor });
            if (!near()) return;
            const o = await s.bot.openBank();
            if (!o.success) { lastFail = `bank:${o.message}`; return; }
            for (const name of ['Trout', 'Salmon']) {
                const b = s.sdk.findBankItem(new RegExp(`^${name}$`, 'i'));
                if (b && b.count > 0) {
                    const w = await s.bot.withdrawItem(b, b.count, { asNote: true });
                    if (!w.success) lastFail = `withdraw note ${name}:${w.message}`;
                }
            }
            await s.bot.closeBank();
            const notes = inv().filter(i => COOKED.test(i.name) && !edible(i));
            const n = notes.reduce((a, i) => a + i.count, 0);
            if (n === 0) { lastFail = 'no notes to give'; return; }
            const r = await s.bot.trade(who, { give: notes.map(i => ({ item: new RegExp(`^${i.name}$`, 'i'), amount: i.count })), timeout: 60_000, retryOnBusy: true });
            if (r.success) { given += n; console.log(`MILESTONE gave ${r.gave.map(g => `${g.count} ${g.name}`).join(', ')} t=${now()}`); }
            else {
                lastFail = `trade:${r.reason} ${r.message}`;
                console.log(`WARN trade ${r.reason} ${r.message}`);
                // Notes back into the bank, so the next visit tries again.
                const o2 = await s.bot.openBank();
                if (o2.success) { for (const i of inv().filter(i => COOKED.test(i.name) && !edible(i))) await s.bot.depositItem(i, -1); await s.bot.closeBank(); }
            }
        } finally { giveTicks += s.tick() - g0; }
    };

    console.log(`FISHCOOK ticks=${TICKS} cooking=${cook()} fishing=${s.sdk.getSkill('Fishing')?.baseLevel} feathers=${countItems(s, FEATHER)} rod=${slotOf(ROD) !== undefined} giveTo=${GIVE_TO || '-'} handoffOnly=${HANDOFF_ONLY}`);
    if (HANDOFF_ONLY) {
        if (!GIVE_TO) await end(false, 'HANDOFF_ONLY needs GIVE_TO');
        const p = pos();
        if (p && cheb(BANK, p) > 4) await go(FIRE_TO_BANK.slice(FIRE_TO_BANK.length - 2), 'to Draynor bank');
        await handOff(WAIT);
        await end(given > 0, 'no hand-off');
    }
    if (slotOf(ROD) === undefined) await end(false, 'no fly fishing rod');

    let chain: { index: number } | null = null;
    while (!over()) {
        if (randomEventsOf(s)?.busy()) { idleTicks++; await waitTicks(s, 1); continue; }
        if (await eatIfLow()) continue;
        if (await troll()) continue;
        const feathers = countItems(s, FEATHER);
        // Cooking below 15 with nothing cookable: raw chicken first (each success is 750 XP at 25x; 15 = 2,411 XP).
        if (cook() < 15 && cookable().length === 0 && invLen() <= 20) {
            await chickenTrip(Math.max(feathers, FEATHER_MIN), 8);
            await go(FIRE_TO_FLY, 'back to the river');
            continue;
        }
        if (feathers < FEATHER_MIN) {
            if (countItems(s, RAW_FISH) > 0 || cookedInPack() > 0) { await cookAll(); await bankTrip(); await go(BANK_TO_FLY, 'back to the river'); continue; }
            await chickenTrip(FEATHER_FILL, 0);
            await go(FIRE_TO_FLY, 'back to the river');
            continue;
        }
        if (invLen() >= 28) {
            await cookAll();
            await bankTrip();
            await go(BANK_TO_FLY, 'back to the river');
            chain = null;
            continue;
        }
        // Fly fishing. Spots south of z 3248 sit on the spider bank (fishing30.ts).
        const f0 = s.tick();
        const raw0 = countItems(s, RAW_FISH);
        const sp = (st()?.nearbyNpcs ?? []).filter((n: any) => /fishing spot/i.test(n.name) && !WHIRLPOOL.has(n.id) && n.z >= 3248
            && n.optionsWithIndex?.some((o: any) => LURE.test(o.text))).sort((a: any, b: any) => a.distance - b.distance)[0] as any;
        if (!sp) {
            const p = pos();
            if (!p || cheb(FLY_SPOT, p) > 3) await walk([[FLY_SPOT.x, FLY_SPOT.z, 1]]);
            else { idleTicks++; await waitTicks(s, 1); }
            fishTicks += s.tick() - f0;
            continue;
        }
        const lure = sp.optionsWithIndex.find((o: any) => LURE.test(o.text)).opIndex;
        if (sp.distance > 1) {
            await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: lure, reason: 'SDK' });
            await waitUntil(s, () => ((st()?.nearbyNpcs ?? []).find((n: any) => n.index === sp.index)?.distance ?? 99) <= 1, { timeoutTicks: 10 });
            chain = { index: sp.index };
        } else {
            const knife = slotOf(/^knife$/i), log = slotOf(/^logs$/i);
            if (s.sdk.getDialog()?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
            if (knife !== undefined && log !== undefined) {
                await s.direct({ type: 'useItemOnItem', sourceSlot: knife, targetSlot: log, reason: 'SDK' });
                await s.direct({ type: 'clickComponent', componentId: make1, reason: 'SDK' });
                await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: lure, reason: 'SDK' });
                cycles++;
                await waitTicks(s, 3);
            } else {
                // No knife or logs: one click per spot, then wait while it fishes.
                if (chain?.index !== sp.index) { await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: lure, reason: 'SDK' }); chain = { index: sp.index }; }
                await waitTicks(s, 1);
            }
        }
        caught += Math.max(0, countItems(s, RAW_FISH) - raw0);
        fishTicks += s.tick() - f0;
    }
    if (died) await end(false, 'died');
    await end(true, 'ticks');
} catch (e) { await finish([s], false, String(e)); }
