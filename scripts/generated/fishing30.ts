// Fresh account (no items, Hitpoints 10, Lumbridge 3222,3218) to Fishing 30, without dying, under 3000 ticks.
// Preset floors_lumbridge. Plan: knife (ground spawn 3224,3202), 6 coins from Lumbridge men, logs (ground spawn
// 3089,3265-3266), small net at Gerrant (Port Sarim), net at Draynor (3086,3228) to Fishing 20 with the fish banked
// at Draynor, sell the fish (withdrawn as notes) at Gerrant, buy a fly fishing rod and feathers, then 3-tick fly fish
// at the Lumbridge river spot (3238,3252).
// Coins limit the feathers (code-read 2026-10-23, shop/scripts/shop.rs2 calc_shop_value, port_sarim.inv/.npc):
// a feather costs floor(2 * (1000 + 10 * bought) / 1000), so 2 gp for the first 50, then 3, 4, 5. Gerrant pays
// floor(cost * (700 - 10 * sold) / 1000): raw shrimps 3 gp falling to 0 after 50, raw anchovies 10 gp falling to 1.
// When the feathers run out before the target, the bot sells its trout and salmon at Gerrant and buys more.
// Resume (live Mightyrod 2026-10-23: Fishing 22, rod, 24 feathers, full pack of starter items, 0 coins, HP 2): the
// old script always went back to pickpocketing for 5 coins and only waited at HP 2. Now each step runs only when
// its item or level is missing, the bot eats when HP is low, sells spare pack items at the Lumbridge general store,
// and pickpockets only at HP 5 or more and only when coins are still short.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';
import { componentId } from '../../packages/core/src/logout';

const CAP = Number(process.env.CAP ?? 3000);
// Target level from the environment, so the same script proves to 30 and runs live to 99.
const TARGET = Number(process.env.TARGET ?? 30);
const XP30 = 13363;
// Total XP for a level (the standard table: level 30 = 13363).
const xpFor = (level: number) => { let p = 0; for (let l = 1; l < level; l++) p += Math.floor(l + 300 * 2 ** (l / 7)); return Math.floor(p / 4); };
const XPT = xpFor(TARGET);
const GENERAL_STORE = { x: 3212, z: 3246 };
const NET = /^small fishing net$/i;
const ROD = /^fly fishing rod$/i;
// Items the fishing plan uses; the rest of the pack is sold at the general store (food is kept for HP).
const KEEP = /^(knife|small fishing net|fly fishing rod|feather|logs|coins|raw (shrimps|anchovies|trout|salmon))$/i;
const LUMBRIDGE = { x: 3222, z: 3218 };
const KNIFE_AT = { x: 3224, z: 3202 };
const LOGS_AT = { x: 3089, z: 3266 };
const DRAYNOR_BANK = { x: 3092, z: 3243 };
const GERRANT = { x: 3014, z: 3224 };
const FLY_SPOT = { x: 3239, z: 3251 };
const FISH = /^raw (shrimps|anchovies|trout|salmon)$/i;
const COINS = /^coins$/i;
const FEATHER = /^feather$/i;
type Pt = [number, number, number];
// Safe route from scripts/generated/thieving60.ts (clear of the jail guards at 3109,3237 and 3120,3238), with a
// stop at the log spawns.
const TO_SARIM: Pt[] = [[3225, 3240, 3], [3180, 3258, 3], [3100, 3285, 3], [LOGS_AT.x, LOGS_AT.z, 1], [3060, 3265, 3], [3047, 3237, 3], [3029, 3217, 3], [GERRANT.x, GERRANT.z, 2]];
// Water fills the land between Port Sarim and the net spot: the only path goes north round it, then into Draynor.
// The young dark wizards (map m48_50: 3084,3236 and 3085,3238, wander 3, hunt 3, aggressive) stand on the direct
// bank-to-spot path, so every Draynor leg uses the east lane x 3093-3095 (6+ tiles from the wizard spawns, 11+
// from the jail guards). Each leg checked with the offline path finder (vendor/rs-sdk/sdk/pathfinding.ts).
// The two net spots (saltfish, map m48_50) are at 3086,3227 and 3085,3230. The north one is fished from 3086,3230,
// 3 tiles from where a wizard can wander (z 3233): runs died there. The bot only nets spots at z <= 3228 and stands
// at 3087-3088,3227 (6 tiles from the wizard area, past its hunt range 3); it waits when only the north spot is up.
const NET_STAND = { x: 3088, z: 3227 };
const NET_MAX_Z = 3228;
const EAST_LANE: Pt[] = [[3094, 3247, 1], [3095, 3236, 1], [3093, 3228, 1]];
const SARIM_TO_NET: Pt[] = [[3029, 3217, 3], [3047, 3237, 3], [3060, 3265, 3], [LOGS_AT.x, LOGS_AT.z, 1], ...EAST_LANE, [NET_STAND.x, NET_STAND.z, 1]];
const NET_TO_BANK: Pt[] = [...[...EAST_LANE].reverse(), [3092, 3247, 1], [DRAYNOR_BANK.x, DRAYNOR_BANK.z, 2]];
const BANK_TO_NET: Pt[] = [[3092, 3247, 1], ...EAST_LANE, [NET_STAND.x, NET_STAND.z, 1]];
const NET_TO_SARIM: Pt[] = [...[...EAST_LANE].reverse(), [LOGS_AT.x, LOGS_AT.z, 1], [3060, 3265, 3], [3047, 3237, 3], [3029, 3217, 3], [GERRANT.x, GERRANT.z, 2]];
// Resume routes from Lumbridge (net owned, or rod and feathers owned).
const LUMB_TO_NET: Pt[] = [[3225, 3240, 3], [3180, 3258, 3], [3100, 3285, 3], [LOGS_AT.x, LOGS_AT.z, 1], ...EAST_LANE, [NET_STAND.x, NET_STAND.z, 1]];
const LUMB_TO_FLY: Pt[] = [[3225, 3240, 3], [FLY_SPOT.x, FLY_SPOT.z, 1]];
const BANK_TO_SARIM: Pt[] = [[3092, 3247, 1], [LOGS_AT.x, LOGS_AT.z, 1], [3060, 3265, 3], [3047, 3237, 3], [3029, 3217, 3], [GERRANT.x, GERRANT.z, 2]];
const SARIM_TO_FLY: Pt[] = [[3029, 3217, 3], [3047, 3237, 3], [3060, 3265, 3], [LOGS_AT.x, LOGS_AT.z, 1], [3100, 3285, 3], [3180, 3258, 3], [3225, 3240, 3], [FLY_SPOT.x, FLY_SPOT.z, 1]];
const FLY_TO_SARIM: Pt[] = [[3225, 3240, 3], [3180, 3258, 3], [3100, 3285, 3], [LOGS_AT.x, LOGS_AT.z, 1], [3060, 3265, 3], [3047, 3237, 3], [3029, 3217, 3], [GERRANT.x, GERRANT.z, 2]];

const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 5);
    // A new live account starts on Tutorial Island (seen: START 3094 3106 0 on the demo server). Skip it first.
    const p0 = s.sdk.getState()?.player;
    if (p0 && p0.worldX < 3160 && p0.worldZ < 3130) {
        const t = await s.bot.skipTutorial();
        console.log(`MILESTONE tutorial ${t.success ? 'ok' : 'fail'}`);
        if (!t.success) await finish([s], false, `tutorial skip failed: ${t.message}`);
    }
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const xp = () => s.sdk.getSkillXp('Fishing') ?? 0;
    const lvl = () => s.sdk.getSkill('Fishing')?.baseLevel ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const coins = () => countItems(s, COINS);
    const invLen = () => st()?.inventory?.length ?? 0;
    const slotOf = (re: RegExp) => (s.sdk.getInventory() ?? []).find((i: any) => re.test(i.name))?.slot;
    const cheb = (a: { x: number; z: number }, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const xp0 = xp();
    const t0 = s.tick();
    const now = () => s.tick() - t0;
    const left = () => CAP - 20 - now();

    // Death: HP 0 once the stats are known, or a jump of more than 20 tiles in one tick (a respawn).
    let hpMin = hp();
    let died = false;
    let last = pos();
    const off = s.onTick(() => {
        const p = pos();
        hpMin = Math.min(hpMin, hp());
        if ((s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0) > 0 && hp() <= 0) died = true;
        if (p && last && cheb({ x: last.worldX, z: last.worldZ }, p) > 20) { died = true; console.log(`WARN jump ${last.worldX},${last.worldZ},${last.level} -> ${p.worldX},${p.worldZ},${p.level} hp=${hp()}`); }
        last = p;
    });

    const marks: string[] = [];
    const mark = (name: string) => {
        if (marks.some(m => m.startsWith(`${name}@`))) return;
        marks.push(`${name}@${now()}`);
        console.log(`MILESTONE ${name} ${now()}`);
    };

    let walkTicks = 0, shopTicks = 0, fishTicks = 0, netTicks = 0, flyTicks = 0, bankTicks = 0, thiefTicks = 0, pickTicks = 0, tripTicks = 0;
    let clicks = 0, cycles = 0, dialogs = 0, banks = 0, drops = 0, trips = 0, feathersBought = 0, sold = 0, steals = 0;
    let lastFail = '';
    const end = async (ok: boolean, why: string): Promise<never> => {
        off();
        const ticks = now();
        const gained = xp() - xp0;
        console.log(`RATE fishing ${gained} ${ticks}`);
        const p = pos();
        const detail = `fishing=${lvl()} xp=${gained} ticks=${ticks} at=${p?.worldX},${p?.worldZ},${p?.level} hp=${hp()} hpMin=${hpMin} died=${died} `
            + `walkTicks=${walkTicks} shopTicks=${shopTicks} fishTicks=${fishTicks} netTicks=${netTicks} flyTicks=${flyTicks} bankTicks=${bankTicks} thiefTicks=${thiefTicks} pickTicks=${pickTicks} tripTicks=${tripTicks} `
            + `clicks=${clicks} cycles=${cycles} dialogs=${dialogs} banks=${banks} drops=${drops} trips=${trips} steals=${steals} eats=${eats} events=${events} sold=${sold}gp feathersBought=${feathersBought} `
            + `coins=${coins()} feathers=${countItems(s, FEATHER)} logs=${countItems(s, /^logs$/i)} milestones=${marks.join(',')}`;
        return finish([s], ok, ok ? detail : `${why} ${detail} last=${lastFail}`);
    };
    const check = async (where: string) => {
        if (died) await end(false, `died ${where}`);
        if (left() <= 0) await end(false, `tick cap ${where}`);
    };

    const walk = async (points: Pt[]): Promise<boolean> => {
        const w0 = now();
        try {
            for (const [x, z, tol] of points) {
                for (let i = 0; i < 3 && !died; i++) {
                    const p = pos();
                    if (p && p.level === 0 && cheb({ x, z }, p) <= tol + 1) break;
                    const r = await s.bot.walkTo(x, z, tol);
                    if (!r.success) lastFail = `walk ${x},${z}: ${r.message}`;
                }
                const p = pos();
                if (died || !p || cheb({ x, z }, p) > tol + 1) return false;
                // The log spawns stand on the route: take them on the way (spare logs for the 3-tick fletch).
                if (x === LOGS_AT.x && z === LOGS_AT.z) await takeAll(/^logs$/i, 4);
            }
            return true;
        } finally { walkTicks += now() - w0; }
    };
    const go = async (points: Pt[], where: string) => { if (!(await walk(points))) await end(false, `walk ${where}`); };

    // Takes every matching ground item within 4 tiles (bounded tries).
    const takeAll = async (re: RegExp, tries: number) => {
        const k0 = now();
        for (let i = 0; i < tries && !died; i++) {
            const g = s.sdk.findGroundItem(re);
            // A full pack cannot take it: each try then waited for a pickup timeout (276 idle ticks at the log spawn).
            if (!g || g.distance > 4 || invLen() >= 28) break;
            const r = await s.bot.pickupItem(g);
            if (!r.success) { lastFail = `pickup ${g.name}: ${r.message}`; break; }
        }
        pickTicks += now() - k0;
    };

    const closeDialog = async (): Promise<boolean> => {
        if (!s.sdk.getDialog()?.isOpen) return false;
        await s.sdk.sendClickDialog(0);
        dialogs++;
        await waitTicks(s, 1);
        return true;
    };

    // Fishing random events (macro events/scripts/fishing): a whirlpool is a spot of npc type 403-406, still named
    // "Fishing spot" with the same options, and 5 clicks on it delete the rod or net; a big fish ("Big fish") throws
    // the rod or net onto the ground; a river troll attacks. Never click a whirlpool; pause clicks during an event.
    const WHIRLPOOL = new Set([403, 404, 405, 406]);
    const spot = (opt: RegExp, maxZ = 99999) => (st()?.nearbyNpcs ?? [])
        .filter((n: any) => /fishing spot/i.test(n.name) && !WHIRLPOOL.has(n.id) && n.z <= maxZ && n.optionsWithIndex?.some((o: any) => opt.test(o.text)))
        .sort((a: any, b: any) => a.distance - b.distance)[0] as any;
    // True when a fishing random event is active: the caller sends no fishing click this tick.
    let events = 0;
    const eventPause = async (anchor: { x: number; z: number }, gear: RegExp): Promise<boolean> => {
        const npcs = st()?.nearbyNpcs ?? [];
        const troll = npcs.find((n: any) => /river troll/i.test(n.name) && n.distance <= 10);
        if (troll) {
            // Walk 12+ tiles off; the troll is deleted once it loses its target (macro_event_lost_hostile).
            events++; chain = null;
            await eat(6);
            const p = pos();
            const away = p && p.worldX > 3230 ? { x: anchor.x - 14, z: anchor.z - 10 } : { x: anchor.x + 12, z: anchor.z - 10 };
            await walk([[away.x, away.z, 2]]);
            await waitTicks(s, 2);
            return true;
        }
        if (npcs.some((n: any) => /^big fish$/i.test(n.name) && n.distance <= 3)) { events++; chain = null; await waitTicks(s, 1); return true; }
        if (!has(gear)) {
            // A big fish dropped the rod or net within 7 tiles: pick it up.
            const g = s.sdk.findGroundItem(gear);
            if (g && g.distance <= 9) { events++; chain = null; const r = await s.bot.pickupItem(g); if (!r.success) lastFail = `pickup ${g.name}: ${r.message}`; return true; }
        }
        return false;
    };
    const opOf = (sp: any, opt: RegExp): number => sp.optionsWithIndex.find((o: any) => opt.test(o.text)).opIndex;

    // Price of the next feather (or any item) bought at stock `stock` with stock base `base` (shop.rs2 calc_shop_value).
    const buyPrice = (cost: number, stock: number, base: number) => {
        const int5 = Math.min(1000, Math.max(-5000, (stock - base) * 10));
        return Math.max(1, Math.floor(cost * Math.max(100, 1000 - int5) / 1000));
    };

    // One Gerrant visit: sell every raw fish, buy what is asked, buy as many feathers as the coins allow (up to `want`).
    const shop = async (opts: { net?: boolean; rod?: boolean; want: number }): Promise<void> => {
        const q0 = now();
        try {
            await closeDialog();
            const o = await s.bot.openShop(/^gerrant$/i);
            if (!o.success) { lastFail = `openShop: ${o.message}`; return; }
            const c0 = coins();
            for (const re of [/^raw shrimps$/i, /^raw anchovies$/i, /^raw trout$/i, /^raw salmon$/i]) {
                if (countItems(s, re) === 0) continue;
                const r = await s.bot.sellToShop(re, 'all');
                if (!r.success) lastFail = `sell ${re.source}: ${r.message}`;
            }
            sold += coins() - c0;
            if (opts.net && countItems(s, /^small fishing net$/i) === 0) {
                const b = await s.bot.buyFromShop(/^small fishing net$/i, 1);
                if (!b.success) lastFail = `buy net: ${b.message}`;
            }
            if (opts.rod && countItems(s, /^fly fishing rod$/i) === 0) {
                const b = await s.bot.buyFromShop(/^fly fishing rod$/i, 1);
                if (!b.success) lastFail = `buy rod: ${b.message}`;
            }
            const f = st()?.shop?.shopItems?.find((i: any) => FEATHER.test(i.name));
            if (opts.want > 0 && f && f.count > 0) {
                let n = 0, spent = 0;
                while (n < opts.want && n < f.count) {
                    const p = buyPrice(2, f.count - n, 1000);
                    if (spent + p > coins()) break;
                    spent += p;
                    n++;
                }
                if (n > 0) {
                    const f0 = countItems(s, FEATHER);
                    const b = await s.bot.buyFromShop(FEATHER, n);
                    if (!b.success) lastFail = `buy feathers ${n}: ${b.message}`;
                    feathersBought += countItems(s, FEATHER) - f0;
                }
            }
            await s.bot.closeShop();
        } finally { shopTicks += now() - q0; }
    };
    const feathersWanted = () => Math.min(200, Math.ceil((XPT - xp()) / 50) + 5);
    const has = (re: RegExp) => countItems(s, re) > 0;
    const isFood = (i: any) => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text));
    // Eats until HP reaches `atLeast` or the food runs out.
    let eats = 0;
    const eat = async (atLeast: number) => {
        for (let i = 0; i < 6 && hp() < atLeast && !died; i++) {
            if (!(s.sdk.getInventory() ?? []).some(isFood)) return;
            const r = await s.bot.eatFood();
            if (!r.success) { lastFail = `eat: ${r.message}`; return; }
            eats++;
        }
    };
    const junk = () => [...new Set((s.sdk.getInventory() ?? []).filter((i: any) => !KEEP.test(i.name) && !isFood(i)).map((i: any) => i.name as string))];
    // Sells every spare pack item at the Lumbridge general store: coins, and free slots for the fish.
    const sellJunk = async () => {
        const q0 = now();
        try {
            await closeDialog();
            await walk([[GENERAL_STORE.x, GENERAL_STORE.z, 2]]);
            const o = await s.bot.openShop();
            if (!o.success) { lastFail = `openShop general: ${o.message}`; return; }
            const c0 = coins();
            // Direct sell packets, up to 5 item kinds a tick. bot.sellToShop waits 5 s on each refusal (a store with no
            // free stock slot refuses new kinds): local runs spent 177 idle ticks there. An item that does not sell in
            // 3 tries stays in the pack and is dropped later only if the pack fills.
            // The shop and pack state trail the packets by a tick: stop only after two ticks with nothing left to sell.
            const tries = new Map<string, number>();
            for (let t = 0, empty = 0; t < 40 && !died && empty < 2; t++) {
                const items = (st()?.shop?.playerItems ?? []) as any[];
                const todo = junk().filter(n => (tries.get(n) ?? 0) < 3 && items.some(i => i.name === n));
                if (todo.length === 0) { empty++; await waitTicks(s, 1); continue; }
                empty = 0;
                const before = new Map(todo.map(n => [n, countItems(s, new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'))]));
                for (const n of todo.slice(0, 5)) {
                    const it = items.find(i => i.name === n)!;
                    await s.sdk.sendShopSell(it.slot, Math.min(10, it.count >= 10 ? 10 : it.count >= 5 ? 5 : 1));
                }
                await waitTicks(s, 1);
                for (const n of todo.slice(0, 5)) {
                    const left = countItems(s, new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
                    if (left >= before.get(n)!) tries.set(n, (tries.get(n) ?? 0) + 1); else tries.delete(n);
                }
            }
            if (junk().length > 0) lastFail = `unsold: ${junk().join(',')}`;
            sold += coins() - c0;
            console.log(`MILESTONE junk-sold ${now()} gp=${coins() - c0} pack=${invLen()}`);
            await s.bot.closeShop();
        } finally { shopTicks += now() - q0; }
    };
    // Coins the missing items cost: the net (5) below Fishing 20; the rod (5) and 10 feathers (20) from Fishing 20.
    const coinsNeeded = () => (lvl() < 20 ? (has(NET) ? 0 : 5) : (has(ROD) ? 0 : 5) + (has(FEATHER) ? 0 : 20));

    // ---- Step 0: food, knife (Lumbridge ground spawn), spare items sold, then coins from Lumbridge men only while
    // the missing items cost more than the bot holds (two successes, 3 gp each, buy the net).
    await eat(6);
    function slotOfKnife() { return slotOf(/^knife$/i) !== undefined; }
    if (!slotOfKnife()) {
        await go([[KNIFE_AT.x, KNIFE_AT.z, 1]], 'to knife');
        for (let i = 0; i < 10 && !slotOfKnife() && !died; i++) {
            await takeAll(/^knife$/i, 2);
            if (!slotOfKnife()) await waitTicks(s, 1);
        }
    }
    if (junk().length > 0) await sellJunk();
    const th0 = now();
    const misses = new Map<number, number>();
    for (let i = 0; i < 300 && coins() < coinsNeeded() && !died && left() > 0; i++) {
        if (await closeDialog()) continue;
        // A failed steal hits for 1: never steal below HP 5. Eat first; with no food, rest (HP comes back 1 a minute).
        if (hp() < 5) { await eat(8); if (hp() < 5) await waitTicks(s, 10); continue; }
        // Coins cannot land in a full pack (live Mightyrod: 154 steals at 28/28, 0 coins).
        if (invLen() >= 28 && !has(COINS)) {
            if (has(FISH)) await s.bot.dropItem(FISH, 'all');
            else if (has(/^logs$/i)) await s.bot.dropItem(/^logs$/i, 1);
            else { await end(false, 'pack full of kept items, no room for coins'); }
            drops++;
            continue;
        }
        // Skip unreachable men (live: one man failed cant_reach 16 times) and any man that ignored 3 clicks.
        const man = (st()?.nearbyNpcs ?? [])
            .filter((n: any) => /^(man|woman)$/i.test(n.name) && n.reachable !== false && (misses.get(n.index) ?? 0) < 3)
            .sort((a: any, b: any) => a.distance - b.distance)[0];
        if (!man) { await walk([[LUMBRIDGE.x, LUMBRIDGE.z, 3]]); await waitTicks(s, 1); continue; }
        steals++;
        // The 2-tick direct click from thieving60.ts (+22% over bot.pickpocketNpc). A fail shows as an HP drop.
        const op = (man as any).optionsWithIndex.find((o: any) => /pickpocket/i.test(o.text))?.opIndex;
        if (op === undefined) { misses.set(man.index, 3); continue; }
        const hp0 = hp(), tx0 = s.sdk.getSkillXp('Thieving') ?? 0, d0 = man.distance;
        await s.direct({ type: 'interactNpc', npcIndex: man.index, optionIndex: op, reason: 'SDK' });
        await waitTicks(s, 2);
        const gotXp = (s.sdk.getSkillXp('Thieving') ?? 0) > tx0;
        if (gotXp || hp() < hp0) misses.delete(man.index);
        else if (d0 <= 1 || ((st()?.nearbyNpcs ?? []).find((n: any) => n.index === man.index)?.distance ?? 99) >= d0) {
            misses.set(man.index, (misses.get(man.index) ?? 0) + 1);
            lastFail = `steal: no result on npc ${man.index}`;
        }
    }
    thiefTicks += now() - th0;
    await check('in Lumbridge');
    if (coins() < coinsNeeded()) await end(false, `only ${coins()} coins, need ${coinsNeeded()}`);

    let useBank = true;
    const bankFish = async (final: boolean) => {
        const b0 = now();
        try {
            await closeDialog();
            if (!(await walk(NET_TO_BANK))) return false;
            const o = await s.bot.openBank();
            if (!o.success) { lastFail = `openBank: ${o.message}`; return false; }
            if ((st()?.inventory ?? []).some((i: any) => FISH.test(i.name))) await s.bot.depositItem(FISH, -1);
            if (final) {
                for (const it of ((st() as any)?.bank?.items ?? []) as { name: string; count: number }[]) {
                    if (!FISH.test(it.name) || it.count <= 0) continue;
                    const w = await s.bot.withdrawItem(new RegExp(`^${it.name}$`, 'i'), Math.min(it.count, 1000), { asNote: true });
                    if (!w.success) lastFail = `withdraw ${it.name}: ${w.message}`;
                }
            }
            await s.bot.closeBank();
            banks++;
            if (!final && !(await walk(BANK_TO_NET))) return false;
            return true;
        } finally { bankTicks += now() - b0; }
    };

    let chain: { index: number; x: number; z: number } | null = null;
    let lastXp = xp(), lastGain = now();
    // One step of a click-once chain (net, or fly fishing without a knife or logs).
    const chainStep = async (opt: RegExp, anchor: { x: number; z: number }, idle: number, maxZ = 99999) => {
        const x = xp();
        if (x > lastXp) { lastXp = x; lastGain = now(); }
        if (await closeDialog()) { chain = null; return; }
        const c = chain;
        const alive = !!c && (st()?.nearbyNpcs ?? []).some((n: any) => n.index === c.index && n.x === c.x && n.z === c.z && !WHIRLPOOL.has(n.id) && /fishing spot/i.test(n.name));
        if (!alive || now() - lastGain > idle) {
            const sp = spot(opt, maxZ);
            if (!sp) {
                chain = null;
                const p = pos();
                if (!p || cheb(anchor, p) > 2) await walk([[anchor.x, anchor.z, 1]]);
                await waitTicks(s, 1);
                return;
            }
            await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: opOf(sp, opt), reason: 'SDK' });
            clicks++;
            chain = { index: sp.index, x: sp.x, z: sp.z };
            lastGain = now();
        }
        await waitTicks(s, 1);
    };

    if (lvl() < 20) {
    // ---- Step 1: walk to Port Sarim (logs on the way), buy the small net. With a net, go straight to Draynor.
    if (!has(NET)) {
        await go(TO_SARIM, 'to Port Sarim');
        await shop({ net: true, want: 0 });
        if (!has(NET)) await end(false, 'no small fishing net');
        await check('at Gerrant');
        await go(SARIM_TO_NET, 'to Draynor net spot');
    } else {
        await go(LUMB_TO_NET, 'to Draynor net spot (net owned)');
    }
    mark('net');

    // ---- Step 2: net at Draynor to Fishing 20. One Net click starts a chain the server keeps going; the bot only
    // clicks again after a level-up dialog, a moved spot, or 30 ticks with no catch. A full pack goes to the bank.
    const n0 = now();
    for (let i = 0; i < 5000 && lvl() < 20 && !died && left() > 0; i++) {
        if (hp() < 5) await eat(8);
        if (await eventPause(NET_STAND, NET)) continue;
        if (!has(NET)) await end(false, 'small fishing net lost (random event)');
        // The jail guards (combat 26) stand 17 tiles from the bank: after any damage, stop banking and drop instead.
        if (hp() <= 7 && useBank) { useBank = false; console.log(`WARN hp ${hp()}: dropping fish, no more banking`); }
        // Away from the spot (a failed bank visit, a long chase): come back by the east lane, never past the wizards.
        const here = pos();
        if (here && cheb(NET_STAND, here) > 6) { chain = null; await go(BANK_TO_NET, 'back to Draynor net spot'); continue; }
        if (invLen() >= 28) {
            chain = null;
            if (!(useBank && (await bankFish(false)))) { await s.bot.dropItem(/^raw shrimps$/i, 'all'); drops++; }
            if (invLen() >= 28) { await s.bot.dropItem(FISH, 'all'); drops++; }
            continue;
        }
        // A wizard that wandered or chased close: step south-east, out of its hunt range, and click again later.
        const wiz = (st()?.nearbyNpcs ?? []).some((n: any) => /dark wizard/i.test(n.name) && n.distance <= 4);
        if (wiz) { chain = null; lastFail = 'dark wizard near the net spot'; await walk([[3093, 3224, 1]]); await waitTicks(s, 2); continue; }
        await chainStep(/^net$/i, NET_STAND, 30, NET_MAX_Z);
    }
    netTicks += now() - n0;
    fishTicks += now() - n0;
    await check('netting');
    if (lvl() < 20) await end(false, `fishing ${lvl()} < 20 after netting`);
    mark('fishing20');
    await closeDialog();

    // ---- Step 3: take every banked fish as notes, sell at Gerrant, buy the rod and feathers.
    const banked = useBank && (await bankFish(true));
    const atBank = cheb(DRAYNOR_BANK, pos() ?? { worldX: 0, worldZ: 0 }) <= 6;
    await go(banked || atBank ? BANK_TO_SARIM : NET_TO_SARIM, 'to Port Sarim (rod)');
    await shop({ rod: true, want: feathersWanted() });
    if (countItems(s, /^fly fishing rod$/i) === 0) await end(false, 'no fly fishing rod');
    if (countItems(s, FEATHER) === 0) await end(false, 'no feathers');
    mark('rod');
    trips++;
    await go(SARIM_TO_FLY, 'to Lumbridge river');
    } else if (!has(ROD) || !has(FEATHER)) {
        // Resume at Fishing 20+ without a rod or feathers: Gerrant sells them for the coins and any raw fish.
        await go(TO_SARIM, 'to Port Sarim (rod, resume)');
        await shop({ rod: true, want: feathersWanted() });
        if (!has(ROD)) await end(false, 'no fly fishing rod');
        if (!has(FEATHER)) await end(false, 'no feathers');
        mark('rod');
        trips++;
        await go(SARIM_TO_FLY, 'to Lumbridge river');
    } else {
        await go(LUMB_TO_FLY, 'to Lumbridge river (rod owned)');
    }

    // ---- Step 4: fly fish at the Lumbridge river. 3-tick: every 3 ticks, in one tick, knife on logs, "Make 1",
    // Lure the spot (scripts/measure/fish-3tick.ts). Without a knife or logs, a click-once chain.
    const make1 = componentId('skill_multi3:make1_a');
    const LURE = /^lure$/i;
    chain = null;
    lastXp = xp(); lastGain = now();
    const f0 = now();
    for (let i = 0; i < 200_000 && lvl() < TARGET && !died && left() > 0; i++) {
        const feathers = countItems(s, FEATHER);
        const fish = countItems(s, /^raw (trout|salmon)$/i);
        const need = XPT - xp();
        if (hp() < 5) await eat(8);
        // A trip to Gerrant and back is about 350 ticks; go only when the feathers cannot finish, time remains, and
        // there is something to pay with (fish to sell, or coins for 5 or more feathers).
        const refill = feathers * 50 < need && (fish > 0 || coins() >= 10) && left() > 450;
        if (feathers === 0 || invLen() >= 28) {
            if (refill) {
                const r0 = now();
                await go(FLY_TO_SARIM, 'to Port Sarim (feathers)');
                await shop({ want: feathersWanted() });
                trips++;
                await go(SARIM_TO_FLY, 'back to Lumbridge river');
                tripTicks += now() - r0;
                chain = null;
                continue;
            }
            if (feathers === 0) break;
            // A full pack with no fish (live: drops=200000 in a no-wait spin): drop the items the store would not buy,
            // then spare logs past 3; stop if nothing can go.
            if (fish === 0) {
                const j = junk()[0];
                if (j) await s.bot.dropItem(new RegExp(`^${j.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), 'all');
                else if (countItems(s, /^logs$/i) > 3) await s.bot.dropItem(/^logs$/i, 1);
                else await end(false, `pack full with no fish to drop (pack=${invLen()})`);
                drops++;
                await waitTicks(s, 1);
                continue;
            }
            await s.bot.dropItem(/^raw (trout|salmon)$/i, 'all');
            drops++;
            continue;
        }
        if (await eventPause(FLY_SPOT, ROD)) continue;
        if (!has(ROD)) {
            // Lost to a whirlpool or a big fish: Gerrant sells another (5 gp) for the coins or the fish.
            if (coins() < 5 && fish === 0) await end(false, 'fly fishing rod lost, no coins or fish');
            await go(FLY_TO_SARIM, 'to Port Sarim (new rod)');
            await shop({ rod: true, want: feathersWanted() });
            if (!has(ROD)) await end(false, 'fly fishing rod lost, could not buy one');
            trips++;
            await go(SARIM_TO_FLY, 'back to Lumbridge river');
            chain = null;
            continue;
        }
        const knife = slotOf(/^knife$/i), log = slotOf(/^logs$/i);
        if (knife === undefined || log === undefined) { await chainStep(LURE, FLY_SPOT, 20); flyTicks++; continue; }
        const sp = spot(LURE);
        if (!sp) { await walk([[FLY_SPOT.x, FLY_SPOT.z, 1]]); await waitTicks(s, 1); continue; }
        const lure = opOf(sp, LURE);
        if (sp.distance > 1) {
            // The server walks to the spot on a direct click; bot.walkTo onto water can freeze the process.
            await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: lure, reason: 'SDK' });
            clicks++;
            await waitUntil(s, () => (spot(LURE)?.distance ?? 99) <= 1, { timeoutTicks: 10 });
            continue;
        }
        const c0 = now();
        await s.direct({ type: 'useItemOnItem', sourceSlot: knife, targetSlot: log, reason: 'SDK' });
        await s.direct({ type: 'clickComponent', componentId: make1, reason: 'SDK' });
        await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: lure, reason: 'SDK' });
        cycles++;
        await waitTicks(s, 3);
        flyTicks += now() - c0;
    }
    fishTicks += now() - f0 - tripTicks;
    await closeDialog();
    if (lvl() >= 30) mark("fishing30");
    if (lvl() >= TARGET) mark(`fishing${TARGET}`);
    const ok = lvl() >= TARGET && !died;
    await end(ok, died ? 'died' : `fishing ${lvl()} < ${TARGET}`);
} catch (e) { await finish([s], false, String(e)); }
