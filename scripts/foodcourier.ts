// Food courier (research/food-chain.md): Ardougne south bank -> Draynor bank, takes the cooked-fish notes that
// scripts/fishcook.ts (GIVE_TO=<this bot>) hands over, and back to the Ardougne south bank; then gives each farmer in
// FARMERS its share (the farmer serves the trade: scripts/goldfarm.ts FOOD_FROM=<this bot>).
// Route and boats copied from scripts/generated/gecourier.ts: Barnaby (Ardougne) -> Brimhaven, walk to Musa Point,
// customs officer -> Port Sarim, walk to Draynor, and back the same way (fare 30 each, four fares per cycle).
// Env: FROM=<fish cook account> (required); WAIT (default 1500) ticks to wait at Draynor for the trade;
// FARMERS=<a,b,...> and PER=<n> (default: an even share) for the hand-out at Ardougne; CAP (default 3000) ticks.
// FEATHERS=<n>: buy n feathers at Gerrant (Port Sarim) on the way out and give them to the cook in the Draynor trade.
// START=draynor skips the outbound legs (the courier already stands at Draynor bank).
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';

type Pt = [number, number, number];
const ARDY_BANK = { x: 2654, z: 3283 };
const DRAYNOR = { x: 3092, z: 3243 };
const LUMBRIDGE = { x: 3222, z: 3218 };
const BRIM_DECK = { x: 2775, z: 3234 };
const SARIM_DECK = { x: 3032, z: 3217 };
const MUSA_DECK = { x: 2956, z: 3143 };
const ARDY_DECK = { x: 2683, z: 3268 };
const FROM = process.env.FROM?.trim() || '';
const WAIT = Number(process.env.WAIT ?? 1500);
const CAP = Number(process.env.CAP ?? 3000);
const FARMERS = (process.env.FARMERS ?? '').split(',').map(x => x.trim()).filter(Boolean);
const PER = process.env.PER ? Number(process.env.PER) : 0;
// HOME_ONLY=1: an account near Lumbridge or Draynor (a respawn) walks to Draynor bank, takes fares from its bank,
// and goes home to Ardougne on the same boats; no trade.
const HOME_ONLY = process.env.HOME_ONLY === '1';
const START_DRAYNOR = process.env.START === 'draynor' || HOME_ONLY;
const FEATHERS = Number(process.env.FEATHERS ?? 0);
const FISH = /^(trout|salmon)$/i;
// Port Sarim <-> Draynor bank: north round the water, then the x 3089-3092 lane (fishing30.ts BANK_TO_SARIM).
const SARIM_TO_DRAYNOR: Pt[] = [[3047, 3237, 3], [3060, 3265, 3], [3089, 3266, 2], [3092, 3250, 1], [DRAYNOR.x, DRAYNOR.z, 2]];
const DRAYNOR_TO_SARIM: Pt[] = [[3092, 3250, 1], [3089, 3266, 2], [3060, 3265, 3], [3047, 3237, 3], [3029, 3217, 3]];

if (!FROM && !HOME_ONLY) { console.log('RESULT fail FROM=<fish cook account> is required'); process.exit(1); }
const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const pos = () => s.sdk.getState()?.player;
    const cheb = (a: { x: number; z: number }, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const inv = () => (s.sdk.getState()?.inventory ?? []) as any[];
    const notes = () => inv().filter(i => FISH.test(i.name) && !(i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text)));
    const fishNotes = () => notes().reduce((n, i) => n + i.count, 0);
    const coins = () => countItems(s, /^coins$/i);
    await waitTicks(s, 3);
    let hpMin = hp(), died = false;
    const jumps: string[] = [];
    let last = pos();
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
    let walkTicks = 0, boatTicks = 0, waitTicksAt = 0, giveTicks = 0, received = 0, handed = 0;
    const legs: string[] = [];
    const leg = (name: string) => { legs.push(`${name}@${used()}`); console.log(`MILESTONE ${name} ${used()}`); };
    const timed = async <T>(add: (n: number) => void, f: () => Promise<T>): Promise<T> => {
        const a = s.tick();
        try { return await f(); } finally { add(s.tick() - a); }
    };
    const detail = () => `ticks=${used()} received=${received} handed=${handed} fishNotes=${fishNotes()} coins=${coins()} walkTicks=${walkTicks} boatTicks=${boatTicks} waitTicks=${waitTicksAt} giveTicks=${giveTicks} featherTicks=${featherTicks} feathersBought=${feathersBought} feathersLeft=${countItems(s, /^feather$/i)} legs=${legs.join(',')} hpMin=${hpMin} died=${died} jumps=${jumps.join(';')}`;
    const fail = async (why: string): Promise<never> => {
        off();
        const p = pos();
        return finish([s], false, `${why} at=${p?.worldX},${p?.worldZ},${p?.level} ${detail()}`);
    };

    const walk = (points: Pt[]): Promise<boolean> => timed(n => walkTicks += n, async () => {
        const [gx, gz, gtol] = points[points.length - 1]!;
        let left = points.map(([x, z, tol]) => ({ x, z, tol }));
        for (let i = 0; i < 3 && !died && !over(); i++) {
            const p = pos();
            if (p && p.level === 0 && cheb({ x: gx, z: gz }, p) <= gtol + 1) break;
            const r = await walkPath(await sessionWalker(s), left, { stop: () => died || over() });
            if (!r.ok) { console.log(`WALK fail ${r.detail} ticks=${r.ticks}`); await waitTicks(s, 1); }
            left = left.slice(Math.min(r.next, left.length - 1));
        }
        const p = pos();
        return !died && !!p && cheb({ x: gx, z: gz }, p) <= gtol + 1;
    });
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

    // Feathers for the cook's fly fishing (1 per fish) from Gerrant, Port Sarim (port_sarim.inv fishingshop: stock
    // 1000, base price 2). The price rises as the stock falls (about +1 gp per 50 bought; scripts/generated/
    // fishing30.ts), so buy in chunks of 50 and keep 60 coins for the two fares home.
    const FEATHER = /^feather$/i;
    let featherTicks = 0, feathersBought = 0;
    const buyFeathers = () => timed(n => featherTicks += n, async () => {
        if (!(await walk([[3014, 3224, 2]]))) { console.log('WARN walk to Gerrant failed'); return; }
        const o = await s.bot.openShop(/^gerrant$/i);
        if (!o.success) { console.log(`WARN openShop ${o.message}`); await waitTicks(s, 1); return; }
        const f0 = countItems(s, FEATHER);
        for (let i = 0; i < 20 && countItems(s, FEATHER) - f0 < FEATHERS; i++) {
            const price = 2 + Math.floor((countItems(s, FEATHER) - f0) / 50) + 1;
            const n = Math.min(50, FEATHERS - (countItems(s, FEATHER) - f0), Math.floor((coins() - 60) / price));
            if (n <= 0) break;
            const before = countItems(s, FEATHER);
            const b = await s.bot.buyFromShop(FEATHER, n);
            if (!b.success || countItems(s, FEATHER) === before) { console.log(`WARN buy feathers ${b.message}`); break; }
        }
        feathersBought = countItems(s, FEATHER) - f0;
        await s.bot.closeShop();
        console.log(`MILESTONE feathers ${feathersBought} coins=${coins()} t=${used()}`);
    });

    const p0 = pos();
    console.log(`FOODCOURIER from=${FROM} farmers=${FARMERS.join(',') || '-'} coins=${coins()} fishNotes=${fishNotes()} at=${p0?.worldX},${p0?.worldZ}`);
    if (!START_DRAYNOR) {
        // Fares come from the bank when the pack is short (2026-10-23: a live trip spent the pack on feathers, and
        // scripts/banker.ts banks the coins a donor gives).
        if (coins() < 120 && p0 && cheb(ARDY_BANK, p0) <= 10) {
            const o = await s.bot.openBank();
            if (o.success) { await s.bot.withdrawItem(/^coins$/i, 500); await s.bot.closeBank(); }
            console.log(`MILESTONE fares from bank coins=${coins()} t=${used()}`);
        }
        if (coins() < 120) await fail('needs 120 coins for four boat fares');
        if (!(await walk([[2679, 3275, 3]]))) await fail('walk to Barnaby');
        if (!(await sail(/^captain barnaby$/i, SAILOR, BRIM_DECK))) await fail('sail to Brimhaven');
        if (!(await disembark())) await fail('Brimhaven gangplank');
        if (!(await walk([[2774, 3228, 3], [2800, 3200, 5], [2850, 3175, 5], [2920, 3160, 5], [2956, 3146, 3]]))) await fail('walk to Musa Point');
        if (!(await sail(/^customs officer$/i, CUSTOMS, SARIM_DECK))) await fail('sail to Port Sarim');
        if (!(await disembark())) await fail('Port Sarim gangplank');
        leg('sarim');
        if (FEATHERS > 0) await buyFeathers();
        if (!(await walk(SARIM_TO_DRAYNOR))) await fail('walk to Draynor bank');
        leg('draynor');
    }

    if (HOME_ONLY) {
        if (!(await walk([[DRAYNOR.x, DRAYNOR.z, 2]]))) await fail('walk to Draynor bank');
        if (coins() < 60) {
            const o = await s.bot.openBank();
            if (o.success) { await s.bot.withdrawItem(/^coins$/i, 200); await s.bot.closeBank(); }
        }
        leg(`draynor coins=${coins()}`);
        if (coins() < 60) await fail('needs 60 coins for the two fares home');
    }
    // Take the notes: the cook starts the trade when it sees this bot (fishcook.ts handOff).
    const before = fishNotes();
    const who = new RegExp(`^${FROM.replace(/[^a-zA-Z0-9 _-]/g, '')}$`, 'i');
    await timed(n => waitTicksAt += n, async () => {
        const deadline = s.tick() + (HOME_ONLY ? 0 : WAIT);
        while (fishNotes() <= before && s.tick() < deadline && !died) {
            const give = countItems(s, FEATHER) > 0 ? [{ item: FEATHER, amount: -1 }] : [];
            const r = await s.bot.serveTrades({ from: who, maxTrades: 1, give, timeout:Math.max(1000, (deadline - s.tick()) * 400) });
            if (fishNotes() <= before) { console.log(`TRADE ${r.reason} ${r.message}`); await waitTicks(s, 1); }
        }
    });
    received = fishNotes() - before;
    leg(`received${received}`);
    if (received <= 0 && !HOME_ONLY) await fail('no fish notes from the cook');
    if (coins() < 60 && !START_DRAYNOR) await fail('needs 60 coins for the two fares home');

    if (!(await walk(DRAYNOR_TO_SARIM))) await fail('walk to Port Sarim');
    if (!(await sail(/^(seaman|captain tobias)/i, SAILOR, MUSA_DECK))) await fail('sail to Karamja');
    if (!(await disembark())) await fail('Musa Point gangplank');
    if (!(await walk([[2920, 3160, 5], [2850, 3175, 5], [2800, 3200, 5], [2774, 3228, 3]]))) await fail('walk to Brimhaven');
    if (!(await sail(/^customs officer$/i, CUSTOMS, ARDY_DECK))) await fail('sail to Ardougne');
    if (!(await disembark())) await fail('Ardougne gangplank');
    if (!(await walk([[ARDY_BANK.x, ARDY_BANK.z, 2]]))) await fail('walk to Ardougne bank');
    leg('ardougne');

    // Hand-out: an even share of each fish type to each farmer, unless PER is set.
    await timed(n => giveTicks += n, async () => {
        for (const [k, f] of FARMERS.entries()) {
            const give = notes().map(i => ({ item: new RegExp(`^${i.name}$`, 'i'), amount: PER > 0 ? Math.min(PER, i.count) : Math.floor(i.count / (FARMERS.length - k)) })).filter(g => g.amount > 0);
            if (give.length === 0) break;
            const n0 = fishNotes();
            for (let tryN = 0; tryN < 3 && fishNotes() === n0 && !died; tryN++) {
                const r = await s.bot.trade(new RegExp(`^${f}$`, 'i'), { give, timeout: 60_000, requestTimeout: 30_000, retryOnBusy: true });
                if (!r.success) { console.log(`WARN trade ${f} ${r.reason} ${r.message}`); await waitTicks(s, 5); }
            }
            handed += n0 - fishNotes();
            console.log(`MILESTONE gave ${f} ${n0 - fishNotes()} t=${used()}`);
        }
    });
    off();
    const p = pos();
    const ok = !died && (received > 0 || HOME_ONLY) && !!p && cheb(ARDY_BANK, p) <= 6 && (FARMERS.length === 0 || handed > 0);
    await finish([s], ok, `${detail()} at=${p?.worldX},${p?.worldZ},${p?.level}`);
} catch (e) { await finish([s], false, String(e)); }
