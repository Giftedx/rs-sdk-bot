// Shop to bid: buys a stackable item from an NPC shop and sells it at the Grand Exchange into an open buy offer.
// Some players bid far above the shop price: fishing bait has a bid of 218 against a shop base of 3, and the Port Sarim
// fishing shop holds 1,500 and restocks 1 a tick. One stack fills one pack slot, so one walk to the exchange sells it.
// Usage: bun scripts/shop-to-bid.ts <bot> <profile> <itemId>
//   profile: a shop of scripts/shop-buyer.ts PROFILES (sarim = Gerrant's fishing shop, betty = the Port Sarim runes).
// Env: UNITS (default 5000) the most units one run buys; MIN_NET (default 50) the least coins a unit must clear after
// the 5% seller tax and the highest shop price; COIN_RESERVE (default 10000) coins the run never spends; MAX_SPEND
// (default 200000) the shop spend limit; WAIT_TICKS (default 0) ticks to wait at the shop for restocked units.
// DEMO_OK=1 for the live server. The run reads the bid from the public market API before it buys and again before it
// sells, and sells only while the bid still clears MIN_NET. Unsold units stay in the pack.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openBot, finish, serverFromEnv } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitTicks } from '../packages/core/src/ticks';
import { walkTargetPersist } from './walk-to';
import { PROFILES, buyWithBudget } from './shop-buyer';
import { runOwnedSale, saleStopRequested } from './sell-owned-ge-item';
import { orderPaths } from './buy-owned-ge-item';

const DEMO = 'https://rs-sdk-demo.fly.dev';
// A tile inside marketTileSafe (scripts/buy-owned-ge-item.ts): the sale starts only from Varrock West.
export const GE_SPOT = { x: 3184, z: 3440, level: 0 };
// shop.rs2 caps the stock adjustment at 5000 over a sell multiplier near 1000, so a unit costs at most about 6 times
// its base. The plan before the shop opens uses 7 times, the shop's own price once it is open.
export const WORST_PRICE_FACTOR = 7;

export type Quote = { name: string; basePrice: number; bid: number | null; buyQuantity: number };

// The coins one unit brings at `bid` after the seller tax, which is floor(gross / 20) over the whole fill.
export const netPerUnit = (bid: number) => bid - bid / 20;

// How many units to buy, or why none: the bid must clear `minNet` over the unit cost, the open bid must want them,
// and the coins above the reserve must pay for them.
export function bidPlan(o: { quote: Quote; unitCost: number; coins: number; reserve: number; maxUnits: number; minNet: number }): { units: number; refusal?: string } {
    const q = o.quote;
    if (!q.bid || q.buyQuantity <= 0) return { units: 0, refusal: 'no open bid' };
    const margin = netPerUnit(q.bid) - o.unitCost;
    if (margin < o.minNet) return { units: 0, refusal: `margin ${Math.floor(margin)} is under MIN_NET ${o.minNet}` };
    const afford = Math.floor(Math.max(0, o.coins - o.reserve) / Math.max(1, o.unitCost));
    const units = Math.min(o.maxUnits, q.buyQuantity, afford);
    return units > 0 ? { units } : { units: 0, refusal: 'no coins above the reserve' };
}

export async function fetchQuote(item: number, get: (url: string) => Promise<any> = async url => {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw Error(`market HTTP ${r.status}`);
    return r.json();
}): Promise<Quote> {
    const j = await get(`${DEMO}/api/market/items/${item}`);
    if (j?.id !== item || typeof j.name !== 'string' || !Number.isSafeInteger(j.basePrice)) throw Error(`invalid market quote for ${item}`);
    return { name: j.name, basePrice: j.basePrice, bid: Number.isSafeInteger(j.bid) && j.bid > 0 ? j.bid : null, buyQuantity: Number.isSafeInteger(j.buyQuantity) ? j.buyQuantity : 0 };
}

const held = (s: Session, id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const coins = (s: Session) => held(s, 995);

async function main() {
    const [bot, profileKey = '', itemArg = ''] = process.argv.slice(2);
    const conf = PROFILES[profileKey.toLowerCase()], item = Number(itemArg);
    if (!bot || !conf || !Number.isSafeInteger(item) || item <= 0) {
        console.error(`Usage: bun scripts/shop-to-bid.ts <bot> <${Object.keys(PROFILES).join(' | ')}> <itemId>`);
        process.exit(2);
    }
    const num = (key: string, d: number) => { const v = Number(process.env[key] ?? d); if (!Number.isSafeInteger(v) || v < 0) throw Error(`${key} must be a whole number`); return v; };
    const maxUnits = num('UNITS', 5000), minNet = num('MIN_NET', 50), reserve = num('COIN_RESERVE', 10_000), maxSpend = num('MAX_SPEND', 200_000), wait = num('WAIT_TICKS', 0);
    const first = await fetchQuote(item);
    const pre = bidPlan({ quote: first, unitCost: first.basePrice * WORST_PRICE_FACTOR, coins: Number.MAX_SAFE_INTEGER, reserve: 0, maxUnits, minNet });
    console.log(`QUOTE ${item} ${first.name} bid=${first.bid} want=${first.buyQuantity} base=${first.basePrice}`);
    if (!pre.units) { console.log(`RESULT fail shop-to-bid refused before login: ${pre.refusal}`); process.exit(1); }
    const server = serverFromEnv(readFileSync(resolve(import.meta.dir, '../vendor/rs-sdk/bots', bot, 'bot.env'), 'utf8'));
    const s = await openBot(bot);
    const startCoins = coins(s), startHeld = held(s, item);
    let spent = 0, bought = 0;
    try {
        const stop = () => saleStopRequested(bot);
        const plan = bidPlan({ quote: first, unitCost: first.basePrice * WORST_PRICE_FACTOR, coins: startCoins, reserve, maxUnits, minNet });
        if (!plan.units) await finish([s], false, `shop-to-bid refused: ${plan.refusal}`);
        if (!(await walkTargetPersist(s, { x: conf.npcSpot.x, z: conf.npcSpot.z, level: conf.npcSpot.level ?? 0 })).ok) await finish([s], false, 'shop-to-bid: shop walk failed');
        const open = await s.bot.openShop(conf.npc);
        if (!open.success) await finish([s], false, `shop-to-bid: openShop failed: ${open.message}`);
        for (let idle = 0; bought < plan.units && !stop();) {
            const b = await buyWithBudget(s.bot, s.sdk, first.name, plan.units - bought, reserve, maxSpend - spent);
            bought += b.bought; spent += b.spent;
            if (b.bought === 0) { if (++idle > wait) break; await waitTicks(s, 1); } else idle = 0;
            if (s.sdk.getInventory().filter(i => i.id === item).length > 1) break; // not stackable: one slot each
        }
        console.log(`BOUGHT ${bought} ${first.name} spent=${spent}`);
        const units = held(s, item) - startHeld;
        if (units <= 0) await finish([s], false, 'shop-to-bid: the shop sold no units');
        if (!(await walkTargetPersist(s, GE_SPOT)).ok) await finish([s], false, 'shop-to-bid: exchange walk failed');
        const q = await fetchQuote(item);
        const sell = bidPlan({ quote: q, unitCost: spent / Math.max(1, bought), coins: Number.MAX_SAFE_INTEGER, reserve: 0, maxUnits: units, minNet });
        if (!sell.units) await finish([s], false, `shop-to-bid: kept ${units} units, the bid moved: ${sell.refusal}`);
        const goal = `bid-${item}-${Date.now()}`, paths = orderPaths(server, bot, 'sell-' + goal);
        const sale = await runOwnedSale(s, { actor: bot, server, goal, item, quantity: sell.units, price: q.bid!, floor: q.bid!, reserveItems: 0, deadline: Date.now() + 120_000 }, paths.journal, stop);
        const gain = coins(s) - startCoins;
        console.log(`SHOP_TO_BID ${JSON.stringify({ item, name: first.name, bought, spent, sold: sale.journal?.progress?.filled ?? 0, bid: q.bid, gain, ok: sale.ok, error: sale.ok ? undefined : sale.error })}`);
        await finish([s], sale.ok, sale.ok ? `shop-to-bid sold at ${q.bid}, coins ${gain >= 0 ? '+' : ''}${gain}` : `shop-to-bid sale failed: ${sale.error}`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}
if (import.meta.main) await main();
