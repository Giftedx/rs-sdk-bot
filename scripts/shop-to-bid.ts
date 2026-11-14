// Shop to bid: buys stackable items from an NPC shop and sells them at the Grand Exchange into open buy offers.
// Some players bid far above the shop price: fishing bait has a bid of 218 against a shop base of 3, and the Port Sarim
// fishing shop holds 1,500 and restocks 1 a tick. One stack fills one pack slot, so one walk to the exchange sells it.
// Usage: bun scripts/shop-to-bid.ts <bot> <profile> <itemId[,itemId...]>
//        bun scripts/shop-to-bid.ts --scan   (no login: each profile item with an open bid that clears MIN_NET)
//   profile: a shop of scripts/shop-buyer.ts PROFILES (sarim = Gerrant's fishing shop, betty = the Port Sarim runes).
// Env: UNITS (default 5000) the most units of each item one run buys; MIN_NET (default 50) the least coins a unit must
// clear after the 5% seller tax and the highest shop price; COIN_RESERVE (default 10000) coins the run never spends;
// MAX_SPEND (default 200000) the shop spend limit of the run; WAIT_TICKS (default 0) ticks to wait at the shop for
// restocked units. DEMO_OK=1 for the live server. The run reads each bid from the public market API before it buys and
// again before it sells, and sells only while the bid still clears MIN_NET. Unsold units stay in the pack.
import { mkdirSync, readFileSync } from 'node:fs';
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
// The shop price rises as its stock falls (shop.rs2 adjusted_item_cost_buying), up to about 6 times the base. The plan
// checks the margin at the base price, and the shop buys in chunks of CHUNK: an item stops when the real unit cost of
// its last chunk no longer clears MIN_NET.
export const CHUNK = 50;
export const chunkTooDear = (spent: number, bought: number, bid: number, minNet: number) => bought > 0 && spent / bought > netPerUnit(bid) - minNet;

export type Quote = { id: number; name: string; basePrice: number; bid: number | null; buyQuantity: number };

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

// The item ids of a comma list, or null when one is not a positive whole number.
export function parseItems(arg: string): number[] | null {
    const ids = arg.split(',').map(Number);
    return ids.length && ids.every(n => Number.isSafeInteger(n) && n > 0) ? [...new Set(ids)] : null;
}

// Each profile item that a market row names exactly, with an open bid that clears minNet at the worst shop price.
export function scanProfiles(profiles: Record<string, { items: { re: RegExp }[] }>, market: readonly Quote[], minNet: number) {
    const out: { profile: string; id: number; name: string; bid: number; want: number; margin: number }[] = [];
    for (const [profile, conf] of Object.entries(profiles))
        for (const { re } of conf.items)
            for (const q of market.filter(m => new RegExp(re.source.replace(/^\^?/, '^').replace(/\$?$/, '$'), re.flags).test(m.name))) {
                if (!bidPlan({ quote: q, unitCost: q.basePrice, coins: Number.MAX_SAFE_INTEGER, reserve: 0, maxUnits: Number.MAX_SAFE_INTEGER, minNet }).units) continue;
                out.push({ profile, id: q.id, name: q.name, bid: q.bid!, want: q.buyQuantity, margin: Math.floor(netPerUnit(q.bid!) - q.basePrice) });
            }
    return out.sort((a, b) => b.margin * b.want - a.margin * a.want);
}

type Get = (url: string) => Promise<any>;
const getJson: Get = async url => {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw Error(`market HTTP ${r.status}`);
    return r.json();
};
const toQuote = (j: any): Quote => ({ id: j.id, name: j.name, basePrice: j.basePrice, bid: Number.isSafeInteger(j.bid) && j.bid > 0 ? j.bid : null, buyQuantity: Number.isSafeInteger(j.buyQuantity) ? j.buyQuantity : 0 });

export async function fetchQuote(item: number, get: Get = getJson): Promise<Quote> {
    const j = await get(`${DEMO}/api/market/items/${item}`);
    if (j?.id !== item || typeof j.name !== 'string' || !Number.isSafeInteger(j.basePrice)) throw Error(`invalid market quote for ${item}`);
    return toQuote(j);
}

export async function fetchMarket(get: Get = getJson, pause = (ms: number) => Bun.sleep(ms)): Promise<Quote[]> {
    const all: Quote[] = [];
    for (let offset = 0, total = 1; offset < total; offset += 100) {
        const j = await get(`${DEMO}/api/market/items?limit=100&offset=${offset}`);
        if (!Number.isSafeInteger(j?.total) || !Array.isArray(j.items)) throw Error('invalid market page');
        total = Math.min(j.total, 5000);
        all.push(...j.items.filter((i: any) => Number.isSafeInteger(i?.id) && typeof i.name === 'string' && Number.isSafeInteger(i.basePrice)).map(toQuote));
        if (offset + 100 < total) await pause(500);
    }
    return all;
}

const held = (s: Session, id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const coins = (s: Session) => held(s, 995);

async function main() {
    const num = (key: string, d: number) => { const v = Number(process.env[key] ?? d); if (!Number.isSafeInteger(v) || v < 0) throw Error(`${key} must be a whole number`); return v; };
    const maxUnits = num('UNITS', 5000), minNet = num('MIN_NET', 50), reserve = num('COIN_RESERVE', 10_000), maxSpend = num('MAX_SPEND', 200_000), wait = num('WAIT_TICKS', 0);
    if (process.argv[2] === '--scan') {
        const rows = scanProfiles(PROFILES, await fetchMarket(), minNet);
        for (const r of rows) console.log(`${r.profile.padEnd(14)} ${String(r.id).padStart(5)} ${r.name.padEnd(20)} bid ${r.bid} want ${r.want} margin ${r.margin}`);
        console.log(`RESULT ok shop-to-bid scan: ${rows.length} items clear MIN_NET ${minNet}`);
        return;
    }
    const [bot, profileKey = '', itemArg = ''] = process.argv.slice(2);
    const conf = PROFILES[profileKey.toLowerCase()], items = parseItems(itemArg);
    if (!bot || !conf || !items) {
        console.error(`Usage: bun scripts/shop-to-bid.ts <bot> <${Object.keys(PROFILES).join(' | ')}> <itemId[,itemId...]> | --scan`);
        process.exit(2);
    }
    const quotes: Quote[] = [];
    for (const id of items) {
        const q = await fetchQuote(id), pre = bidPlan({ quote: q, unitCost: q.basePrice, coins: Number.MAX_SAFE_INTEGER, reserve: 0, maxUnits, minNet });
        console.log(`QUOTE ${id} ${q.name} bid=${q.bid} want=${q.buyQuantity} base=${q.basePrice}${pre.units ? '' : ` skip: ${pre.refusal}`}`);
        if (pre.units) quotes.push(q);
    }
    if (!quotes.length) { console.log('RESULT fail shop-to-bid refused before login: no item clears MIN_NET'); process.exit(1); }
    const server = serverFromEnv(readFileSync(resolve(import.meta.dir, '../vendor/rs-sdk/bots', bot, 'bot.env'), 'utf8'));
    const s = await openBot(bot);
    const startCoins = coins(s), stop = () => saleStopRequested(bot);
    const lots: { q: Quote; startHeld: number; bought: number; spent: number }[] = [];
    try {
        if (!(await walkTargetPersist(s, { x: conf.npcSpot.x, z: conf.npcSpot.z, level: conf.npcSpot.level ?? 0 })).ok) await finish([s], false, 'shop-to-bid: shop walk failed');
        const open = await s.bot.openShop(conf.npc);
        if (!open.success) await finish([s], false, `shop-to-bid: openShop failed: ${open.message}`);
        let spent = 0;
        for (const q of quotes) {
            const plan = bidPlan({ quote: q, unitCost: q.basePrice, coins: coins(s), reserve, maxUnits, minNet });
            const lot = { q, startHeld: held(s, q.id), bought: 0, spent: 0 };
            lots.push(lot);
            // The first buy is 2 units: 2 slots mean the item does not stack, and the sale needs at most 26 used slots.
            let cap = plan.units, probe = true;
            for (let idle = 0; lot.bought < cap && !stop();) {
                const b = await buyWithBudget(s.bot, s.sdk, q.name, Math.min(probe ? 2 : CHUNK, cap - lot.bought), reserve, maxSpend - spent);
                lot.bought += b.bought; lot.spent += b.spent; spent += b.spent;
                if (probe && b.bought > 0) {
                    probe = false;
                    if (s.sdk.getInventory().filter(i => i.id === q.id).length > 1) cap = Math.min(cap, lot.bought + Math.max(0, 26 - s.sdk.getInventory().length));
                }
                if (chunkTooDear(b.spent, b.bought, q.bid!, minNet)) { console.log(`DEAR ${q.name} at ${(b.spent / b.bought).toFixed(1)} a unit`); break; }
                if (b.bought === 0) { if (++idle > wait) break; await waitTicks(s, 1); } else idle = 0;
            }
            console.log(`BOUGHT ${lot.bought} ${q.name} spent=${lot.spent}${plan.units ? '' : ` (${plan.refusal})`}`);
        }
        if (!lots.some(l => held(s, l.q.id) > l.startHeld)) await finish([s], false, 'shop-to-bid: the shop sold no units');
        if (!(await walkTargetPersist(s, GE_SPOT)).ok) await finish([s], false, 'shop-to-bid: exchange walk failed');
        let ok = true;
        const errors: string[] = [];
        for (const lot of lots) {
            const units = held(s, lot.q.id) - lot.startHeld;
            if (units <= 0 || stop()) continue;
            const q = await fetchQuote(lot.q.id);
            const sell = bidPlan({ quote: q, unitCost: lot.spent / Math.max(1, lot.bought), coins: Number.MAX_SAFE_INTEGER, reserve: 0, maxUnits: units, minNet });
            if (!sell.units) { console.log(`KEPT ${units} ${q.name}: ${sell.refusal}`); continue; }
            const goal = `bid-${q.id}-${Date.now()}`, paths = orderPaths(server, bot, 'sell-' + goal);
            mkdirSync(paths.base, { recursive: true }); // runOwnedSale writes its journal there and creates no folder
            const sale = await runOwnedSale(s, { actor: bot, server, goal, item: q.id, quantity: sell.units, price: q.bid!, floor: q.bid!, reserveItems: 0, deadline: Date.now() + 120_000 }, paths.journal, stop);
            console.log(`SHOP_TO_BID ${JSON.stringify({ item: q.id, name: q.name, bought: lot.bought, spent: lot.spent, sold: sale.journal?.progress?.filled ?? 0, bid: q.bid, ok: sale.ok, error: sale.ok ? undefined : sale.error })}`);
            if (!sale.ok) { ok = false; errors.push(`${q.name}: ${sale.error}`); }
        }
        const gain = coins(s) - startCoins;
        await finish([s], ok, ok ? `shop-to-bid coins ${gain >= 0 ? '+' : ''}${gain}` : `shop-to-bid sale failed: ${errors.join('; ')}; coins ${gain}`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}
if (import.meta.main) await main();
