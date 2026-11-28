// The fare float at the start bank: a walk that starts beside a bank, through a box that holds a fare the pack cannot
// pay (a toll gate, a boat, a cart), first takes coins from that bank. A bank stop there costs about 10 ticks; the
// walk round the Al Kharid toll fence costs 180 more. goTo, walkTarget --ground and the quest sweep's ground walks
// call it; a bank on the way is planTrip's job (trip.ts), and both leave FARE_FLOAT in the pack (fareFloatTake).
import { FARE_FLOAT, fareFloatTake, type BankStock } from '../trip';
import type { FareCrossing, Travel } from '../travel';
import type { Tile } from '../world';
import type { Walker } from '../walk-leg';

// DETOUR_PAD: the box of goTo's WALK_DETOUR check. FLOAT_PAD: the tighter box of the float, so a fare well off the walk
// (a Shantay carpet south of Al Kharid on a walk from the Al Kharid bank to Varrock) takes no coins out.
export const FLOAT_BANK_TILES = 12, FLOAT_WALK_TILES = 30, DETOUR_PAD = 40, FLOAT_PAD = 25;
const cheb = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

// Paid edges (travel.ts: tolls, boats, carts) inside the box of a walk that this account cannot pay now.
export function unpaidFaresNear(from: Tile, to: Tile, coins: number, travel: readonly Travel[], pad = DETOUR_PAD): Travel[] {
    const minX = Math.min(from.x, to.x) - pad, maxX = Math.max(from.x, to.x) + pad;
    const minZ = Math.min(from.z, to.z) - pad, maxZ = Math.max(from.z, to.z) + pad;
    const inBox = (t: Tile | null) => !!t && t.x >= minX && t.x <= maxX && t.z >= minZ && t.z <= maxZ;
    return travel.filter(t => t.coins > coins && inBox(t.from) && inBox(t.to));
}

// What the start bank gives: null when the walk is short, starts away from a bank, has no unpaid fare in its box,
// or the pack has no slot for coins. `bankCoins` undefined: the bank was not seen; the float is asked for, and a
// shortfall that still leaves the fare is taken (topUpFareFloat).
export function fareFloatNeed(o: {
    from: Tile; to: Tile; held: number; bankCoins: number | undefined; coinSlot: boolean;
    travel: readonly Travel[]; crossings: readonly FareCrossing[]; banks: readonly Tile[];
    // The account: an edge it could not take with the coins (a quest, a skill, a pass) needs no float.
    allowed?: (t: Travel, coins: number) => boolean;
}): { bank: Tile; fare: number; take: number } | null {
    if (!o.coinSlot || o.from.level !== o.to.level || cheb(o.from, o.to) <= FLOAT_WALK_TILES) return null;
    const box = (t: Tile) => t.level === o.from.level && t.x >= Math.min(o.from.x, o.to.x) - FLOAT_PAD && t.x <= Math.max(o.from.x, o.to.x) + FLOAT_PAD
        && t.z >= Math.min(o.from.z, o.to.z) - FLOAT_PAD && t.z <= Math.max(o.from.z, o.to.z) + FLOAT_PAD;
    const edges = unpaidFaresNear(o.from, o.to, o.held, o.travel, FLOAT_PAD).filter(t => !o.allowed || o.allowed(t, t.coins));
    const fares = [...edges.map(t => t.coins), ...o.crossings.filter(c => c.coins > o.held && box(c)).map(c => c.coins)];
    if (!fares.length) return null;
    const bank = o.banks.filter(b => b.level === o.from.level && cheb(b, o.from) <= FLOAT_BANK_TILES).sort((a, b) => cheb(a, o.from) - cheb(b, o.from))[0];
    if (!bank) return null;
    const fare = Math.max(...fares);
    const take = o.bankCoins === undefined ? Math.max(0, FARE_FLOAT - o.held) : fareFloatTake(o.held, o.bankCoins, fare);
    return take > 0 && o.held + take >= fare ? { bank, fare, take } : null;
}

type FloatSession = Walker & { name?: string; bot: Walker['bot'] & { openBank?: unknown } };
// Sessions whose bank had no coins for the float: they are not asked again.
const dry = new WeakSet<object>();

export async function topUpFareFloat(s: FloatSession, to: Tile, opts: { stop?: () => boolean; stock?: BankStock; server?: string } = {}): Promise<boolean> {
    const p = s.sdk.getState()?.player;
    if (!p || !s.name || typeof s.bot.openBank !== 'function' || dry.has(s)) return false;
    const inv = (s.sdk.getState()?.inventory ?? []) as { id: number; count?: number }[];
    const held = inv.filter(i => i.id === 995).reduce((n, i) => n + (i.count ?? 0), 0);
    const [{ bankStock, knownBanks, takeItems }, { fareCrossings, loadTravel, travelAllowed }, { waitTicks }, { accountForSdk }] = await Promise.all([
        import('../trip'), import('../travel'), import('../ticks'), import('../door-policy')]);
    const from = { x: p.worldX, z: p.worldZ, level: p.level };
    const stock = opts.stock ?? bankStock(s.name, opts.server ? { server: opts.server } : {});
    const acct = accountForSdk(s.sdk);
    const need = fareFloatNeed({ from, to, held, bankCoins: stock?.coins, coinSlot: held > 0 || inv.length < 28, travel: loadTravel(), crossings: fareCrossings(), banks: knownBanks(),
        allowed: (t, coins) => travelAllowed(t, { ...acct, coins, counts: { ...acct.counts, coins } }) });
    if (!need) return false;
    const banker = s as unknown as Parameters<typeof takeItems>[0];
    const run = { stop: opts.stop, deadline: performance.now() + 30_000 };
    const canRetryPartial = need.take > need.fare;
    let took = await takeItems(banker, need.take, {}, n => waitTicks(s, n), canRetryPartial ? { ...run, keepOpen: true } : run), taken = took.ok ? need.take : 0;
    // A bank seen only now: take what it holds when that still pays the fare, reusing the open bank interface.
    const short = took.shortfalls?.[995];
    if (!took.ok && short !== undefined && need.take - short > 0 && held + need.take - short >= need.fare) {
        took = await takeItems(banker, need.take - short, {}, n => waitTicks(s, n), run);
        taken = took.ok ? need.take - short : 0;
    } else if (canRetryPartial && s.sdk.getState()?.bank?.isOpen) {
        try { await banker.bot.closeBank(); } catch { /* keep withdrawal result authoritative */ }
    }
    if (!took.ok && short !== undefined && !taken) dry.add(s);
    console.log(`WALK_FARE_FLOAT ${JSON.stringify({ at: from, to, bank: need.bank, fare: need.fare, held, took: taken, ok: took.ok, detail: took.detail })}`);
    return took.ok;
}
