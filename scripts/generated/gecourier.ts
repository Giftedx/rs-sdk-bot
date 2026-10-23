// Food courier: Ardougne market -> Grand Exchange -> Ardougne market, buys lobsters (379) as notes.
// Preset courier_ardougne (2655,3304,0, 20000 coins). Route by boat both ways (fare 30 each, four fares):
// Barnaby (Ardougne) -> Brimhaven, walk to Musa Point, customs officer -> Port Sarim, walk to the GE, and back.
// Decks from the rs2 set_sail coords: Brimhaven 1_43_50_23_34 = (2775,3234,1), Port Sarim 1_47_50_24_17 = (3032,3217,1).
// Env: LOBSTERS (default 120), PRICE (default 170), DRY=1 skips the buy (the practice server has no sellers).
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../../packages/core/src/walk';

const MARKET = { x: 2655, z: 3304 };
const LUMBRIDGE = { x: 3222, z: 3218 };
const BRIM_DECK = { x: 2775, z: 3234 };
const SARIM_DECK = { x: 3032, z: 3217 };
const MUSA_DECK = { x: 2956, z: 3143 };
const ARDY_DECK = { x: 2683, z: 3268 };
const CAP = 4000;
const LOBSTERS = Number(process.env.LOBSTERS ?? 120);
const PRICE = Number(process.env.PRICE ?? 170);
const DRY = process.env.DRY === '1';

const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const pos = () => s.sdk.getState()?.player;
    const cheb = (a: { x: number; z: number }, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const lobsters = () => countItems(s, /^lobster$/i);
    const coins = () => countItems(s, /^coins$/i);
    await waitTicks(s, 5);
    let hpMin = hp();
    let died = false;
    const jumps: string[] = [];
    let last = pos();
    // A boat trip also jumps more than 20 tiles, so only a jump that lands near the Lumbridge spawn (or HP 0) is a death.
    const off = s.onTick(() => {
        const p = pos();
        hpMin = Math.min(hpMin, hp());
        if (hp() <= 0) died = true;
        if (p && last && cheb({ x: last.worldX, z: last.worldZ }, p) > 20) {
            jumps.push(`${s.tick()}:${last.worldX},${last.worldZ}->${p.worldX},${p.worldZ},${p.level}`);
            if (cheb(LUMBRIDGE, p) <= 15) died = true;
        }
        last = p;
    });
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => used() >= CAP;
    let walkTicks = 0;
    let boatTicks = 0;
    let geTicks = 0;
    const timed = async <T>(add: (n: number) => void, f: () => Promise<T>): Promise<T> => {
        const a = s.tick();
        try { return await f(); } finally { add(s.tick() - a); }
    };
    const counters = () => `walkTicks=${walkTicks} boatTicks=${boatTicks} geTicks=${geTicks}`;
    const fail = async (why: string): Promise<never> => {
        off();
        const p = pos();
        return finish([s], false, `${why} at=${p?.worldX},${p?.worldZ},${p?.level} lobsterNotes=${lobsters()} coins=${coins()} ticks=${used()} ${counters()} hpMin=${hpMin} died=${died} jumps=${jumps.join(';')}`);
    };
    const milestone = (name: string) => console.log(`MILESTONE ${name} ${used()}`);

    // Walks through waypoints with walkPath (packages/core/src/walk.ts): it clicks ahead every few tiles and never
    // waits at a corner (research/walking.md: 106-110 ticks vs 125-129 Musa Point to Brimhaven on practice).
    // A failed walk gets 2 more tries from wherever the bot stands.
    const walk = (points: [number, number, number][]): Promise<boolean> => timed(n => walkTicks += n, async () => {
        const [gx, gz, gtol] = points[points.length - 1]!;
        let left = points.map(([x, z, tol]) => ({ x, z, tol }));
        for (let i = 0; i < 3 && !died && !over(); i++) {
            const p = pos();
            if (p && p.level === 0 && cheb({ x: gx, z: gz }, p) <= gtol + 1) break;
            const r = await walkPath(await sessionWalker(s), left, { stop: () => died || over() });
            if (!r.ok) console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
            left = left.slice(Math.min(r.next, left.length - 1));
        }
        const p = pos();
        return !died && !!p && cheb({ x: gx, z: gz }, p) <= gtol + 1;
    });

    // Answers a dialog: clicks the first option that matches a pattern, else "continue". Stops when done() holds.
    const converse = async (pats: RegExp[], done: () => boolean, maxTicks: number): Promise<boolean> => {
        for (let i = 0; i < maxTicks && !died && !over(); i++) {
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

    // Crosses the deck gangplank to level 0 after a landing.
    const disembark = (): Promise<boolean> => timed(n => boatTicks += n, async () => {
        for (let i = 0; i < 4 && !died && !over(); i++) {
            if (pos()?.level === 0) return true;
            const d = s.sdk.getDialog();
            if (d?.isOpen) { await s.sdk.sendClickDialog(0); await waitTicks(s, 1); continue; }
            const plank = s.sdk.findNearbyLoc(/^gangplank$/i);
            if (!plank) { await waitTicks(s, 2); continue; }
            await s.bot.interactLoc(plank, 'Cross');
            await waitUntil(s, st => st?.player?.level === 0, { timeoutTicks: 10 });
        }
        return pos()?.level === 0;
    });

    // Takes a ship: talks to the NPC, answers the dialog, waits for the landing on the deck near `deck`.
    const sail = (npc: RegExp, pats: RegExp[], deck: { x: number; z: number }): Promise<boolean> => timed(n => boatTicks += n, async () => {
        const landed = () => { const p = pos(); return !!p && p.level === 1 && cheb(deck, p) <= 8; };
        for (let tryN = 0; tryN < 3 && !died && !over() && !landed(); tryN++) {
            const t = await s.bot.talkTo(npc);
            if (!t.success) { console.log(`TALK fail ${t.message}`); await waitTicks(s, 2); continue; }
            await converse(pats, landed, 60);
        }
        return landed();
    });
    const CUSTOMS = [/journey on this ship/i, /search away/i, /^ok\.?$/i];
    const SAILOR = [/^yes please/i];

    // Leg 1: Ardougne market -> Captain Barnaby (2679,3275) -> Brimhaven.
    if (!(await walk([[2679, 3275, 3]]))) await fail('walk to Barnaby');
    if (!(await sail(/^captain barnaby$/i, SAILOR, BRIM_DECK))) await fail('sail to Brimhaven');
    if (!(await disembark())) await fail('Brimhaven gangplank');

    // Leg 2: Brimhaven -> Musa Point customs officer -> Port Sarim.
    if (!(await walk([[2774, 3228, 3], [2800, 3200, 5], [2850, 3175, 5], [2920, 3160, 5], [2956, 3146, 3]]))) await fail('walk to Musa Point');
    if (!(await sail(/^customs officer$/i, CUSTOMS, SARIM_DECK))) await fail('sail to Port Sarim');
    if (!(await disembark())) await fail('Port Sarim gangplank');
    milestone('sarim');

    // Leg 3: Port Sarim -> Grand Exchange.
    if (!(await walk([[3047, 3237, 3], [3060, 3265, 3], [3100, 3285, 3], [3180, 3258, 3], [3225, 3240, 3], [3235, 3300, 3], [3210, 3380, 3], [3181, 3440, 3]]))) await fail('walk to GE');
    const opened = await timed(n => geTicks += n, () => s.bot.openGE());
    if (!opened.success) await fail(`openGE: ${opened.message}`);
    milestone('ge');

    let geNote = '';
    if (DRY) {
        // No sellers here: show the buy screen for lobsters, then leave without an offer.
        const r = await timed(n => geTicks += n, () => s.bot.searchGE('lobster', 'buy'));
        geNote = `search=${r.success} screen=${s.sdk.getGEState()?.screen ?? 'none'}`;
        milestone('dry');
    } else {
        await timed(n => geTicks += n, async () => {
            const placed = await s.bot.placeGEOffer({ item: 379, side: 'buy', quantity: LOBSTERS, price: PRICE });
            if (!placed.success || !placed.offer) { geNote = `place=${placed.message}`; return; }
            const id = placed.offer.id;
            const offer = () => s.sdk.getGEState()?.offers.find(o => o.id === id);
            // Sellers fill at once or not at all on a live market; give the fill 50 ticks.
            await waitUntil(s, () => (offer()?.remaining ?? 0) === 0, { timeoutTicks: 50 });
            const o = offer();
            if (o && o.remaining > 0) {
                // Cancel the rest, so the coins come back instead of staying locked in an open offer.
                const c = await s.bot.cancelGEOffer(id);
                geNote = `cancelled=${c.success} remaining=${o.remaining}`;
            }
            const col = await s.bot.collectGE();
            geNote += ` collect=${col.success} items=${col.items ?? 0}`;
        });
        milestone('bought');
    }
    await s.bot.closeInterface();
    await waitTicks(s, 1);

    // Leg 4: Grand Exchange -> Port Sarim seamen -> Musa Point.
    if (!(await walk([[3210, 3380, 3], [3235, 3300, 3], [3225, 3240, 3], [3180, 3258, 3], [3100, 3285, 3], [3060, 3265, 3], [3047, 3237, 3], [3029, 3217, 3]]))) await fail('walk to Port Sarim');
    if (!(await sail(/^(seaman|captain tobias)/i, SAILOR, MUSA_DECK))) await fail('sail to Karamja');
    if (!(await disembark())) await fail('Musa Point gangplank');

    // Leg 5: Musa Point -> Brimhaven customs officer (2772,3225-3231) -> Ardougne -> market.
    if (!(await walk([[2920, 3160, 5], [2850, 3175, 5], [2800, 3200, 5], [2774, 3228, 3]]))) await fail('walk to Brimhaven');
    if (!(await sail(/^customs officer$/i, CUSTOMS, ARDY_DECK))) await fail('sail to Ardougne');
    if (!(await disembark())) await fail('Ardougne gangplank');
    if (!(await walk([[MARKET.x, MARKET.z, 2]]))) await fail('walk to market');
    milestone('back');

    off();
    const p = pos();
    const dist = p ? cheb(MARKET, p) : 999;
    const n = lobsters();
    const ok = !!p && p.level === 0 && dist <= 6 && !died && !over() && (DRY || n >= 1);
    await finish([s], ok, `lobsterNotes=${n} coins=${coins()} ticks=${used()} ${counters()} dry=${DRY} ${geNote.trim()} at=${p?.worldX},${p?.worldZ},${p?.level} dist=${dist} hpMin=${hpMin} died=${died} jumps=${jumps.join(';')}`);
} catch (e) { await finish([s], false, String(e)); }
