// Shop to bid: buys stackable items from an NPC shop and sells them at the Grand Exchange into open buy offers.
// Some players bid far above the shop price: fishing bait has a bid of 218 against a shop base of 3, and the Port Sarim
// fishing shop holds 1,500 and restocks 1 a tick. One stack fills one pack slot, so one walk to the exchange sells it.
// Usage: bun scripts/shop-to-bid.ts <bot> <profile[,profile...]> <itemId[,itemId...]>
//        bun scripts/shop-to-bid.ts --scan   (no login: each profile item with an open bid that clears MIN_NET)
//   profile: a shop of scripts/shop-buyer.ts PROFILES (sarim = Gerrant's fishing shop, harry_bait = Harry's Catherby
//   fishing shop, betty = the Port Sarim runes). With LOTS=n the run makes n lots, one shop after the next in the list,
//   so each shop restocks while the bot serves the others. It ends early when no item clears MIN_NET or when a full
//   turn of the shops sold nothing.
// Env: UNITS (default 5000) the most units of each item one lot buys; MIN_NET (default 50) the least coins a unit must
// clear after the 5% seller tax and the highest shop price; COIN_RESERVE (default 10000) coins the run never spends;
// MAX_SPEND (default 200000) the shop spend limit of one lot; WAIT_TICKS (default 0) ticks to wait at the shop for
// restocked units. DEMO_OK=1 for the live server. The run reads each bid from the public market API before it buys and
// again before it sells, and sells only while the bid still clears MIN_NET. Unsold units stay in the pack.
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openBot, finish, serverFromEnv } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkTargetPersist } from './walk-to';
import { PROFILES, maximumUnitCost } from './shop-buyer';
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

// The coins to take from the bank so the pack holds the reserve and the whole spend limit.
export const floatNeed = (packCoins: number, reserve: number, maxSpend: number) => Math.max(0, reserve + maxSpend - packCoins);

// The profile keys of a comma list (lower case), or null when one is not a known profile.
export function parseProfiles(arg: string, known: readonly string[]): string[] | null {
    const keys = arg.toLowerCase().split(',').filter(Boolean);
    return keys.length && keys.every(k => known.includes(k)) ? keys : null;
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

// The server decodes 5 user packets a tick (lostcity ClientGameProtCategory USER_EVENT) and a shop buy is one, with
// an amount of 10, 5 or 1. bot.buyFromShop sends one packet and waits for the pack before the next, about 3 units a
// tick. One tick of packets buys up to 50.
export const PACKETS_PER_TICK = 5;
export function tickPackets(want: number, perTick = PACKETS_PER_TICK): number[] {
    const out: number[] = [];
    for (let left = Math.floor(want); left > 0 && out.length < perTick;) { const n = left >= 10 ? 10 : left >= 5 ? 5 : 1; out.push(n); left -= n; }
    return out;
}

// One tick of shop buys for up to `want` units, bounded by the shelf, the coins above the reserve and the spend left
// at the shop's highest unit price. The result counts the pack and the coins, never the requests.
async function tickBuy(s: Session, q: Quote, want: number, reserve: number, spendLeft: number): Promise<{ bought: number; spent: number }> {
    const shop = s.sdk.getState()?.shop, item = shop?.shopItems.find(i => i.name.toLowerCase() === q.name.toLowerCase());
    if (!shop?.isOpen || !item || item.count <= 0) return { bought: 0, spent: 0 };
    const unit = maximumUnitCost(item, shop.shopConfig), wallet = coins(s), before = held(s, q.id);
    const packets = tickPackets(Math.min(want, item.count, Math.floor(Math.min(wallet - reserve, spendLeft) / unit)));
    if (!packets.length) return { bought: 0, spent: 0 };
    for (const amount of packets) await s.direct({ type: 'shopBuy', slot: item.slot, amount, reason: 'SDK' });
    await waitUntil(s, () => held(s, q.id) > before, { timeoutTicks: 3 });
    await waitTicks(s, 1); // the last packets of the tick publish with the next state
    const spent = Math.max(0, wallet - coins(s));
    if (coins(s) < reserve || spent > spendLeft) throw Error('shop budget violated: observed server cost exceeded reserved maximum');
    return { bought: Math.max(0, held(s, q.id) - before), spent };
}

async function main() {
    const num = (key: string, d: number) => { const v = Number(process.env[key] ?? d); if (!Number.isSafeInteger(v) || v < 0) throw Error(`${key} must be a whole number`); return v; };
    const maxUnits = num('UNITS', 5000), minNet = num('MIN_NET', 50), reserve = num('COIN_RESERVE', 10_000), maxSpend = num('MAX_SPEND', 200_000), wait = num('WAIT_TICKS', 0);
    if (process.argv[2] === '--scan') {
        const rows = scanProfiles(PROFILES, await fetchMarket(), minNet);
        for (const r of rows) console.log(`${r.profile.padEnd(14)} ${String(r.id).padStart(5)} ${r.name.padEnd(20)} bid ${r.bid} want ${r.want} margin ${r.margin}`);
        console.log(`RESULT ok shop-to-bid scan: ${rows.length} items clear MIN_NET ${minNet}`);
        return;
    }
    const [bot, profileArg = '', itemArg = ''] = process.argv.slice(2);
    const profiles = parseProfiles(profileArg, Object.keys(PROFILES)), items = parseItems(itemArg), lotsWanted = Math.max(1, num('LOTS', 1));
    if (!bot || !profiles || !items) {
        console.error(`Usage: bun scripts/shop-to-bid.ts <bot> <profile[,profile...]> <itemId[,itemId...]> | --scan   (profiles: ${Object.keys(PROFILES).join(' | ')})`);
        process.exit(2);
    }
    // The items that clear MIN_NET now, from fresh quotes; a profile's lot buys the ones its shop sells.
    const quotesNow = async (log: boolean) => {
        const out: Quote[] = [];
        for (const id of items) {
            const q = await fetchQuote(id), pre = bidPlan({ quote: q, unitCost: q.basePrice, coins: Number.MAX_SAFE_INTEGER, reserve: 0, maxUnits, minNet });
            if (log) console.log(`QUOTE ${id} ${q.name} bid=${q.bid} want=${q.buyQuantity} base=${q.basePrice}${pre.units ? '' : ` skip: ${pre.refusal}`}`);
            if (pre.units) out.push(q);
        }
        return out;
    };
    if (!(await quotesNow(true)).length) { console.log('RESULT fail shop-to-bid refused before login: no item clears MIN_NET'); process.exit(1); }
    const server = serverFromEnv(readFileSync(resolve(import.meta.dir, '../vendor/rs-sdk/bots', bot, 'bot.env'), 'utf8'));
    const s = await openBot(bot);
    const stop = () => saleStopRequested(bot);

    // One lot: float, shop, exchange. Returns the coin change of the lot and the sale errors.
    const runLot = async (key: string, quotes: Quote[]): Promise<{ gain: number; sold: number; errors: string[] }> => {
        const conf = PROFILES[key]!;
        const need = floatNeed(coins(s), reserve, maxSpend);
        if (need > 0) {
            // Accounts keep their coins in the bank. A bank in view (the exchange stands at Varrock West bank, where each
            // lot ends) needs no walk; else the profile's bank.
            const near = !!(s.sdk.findNearbyNpc(/^banker$/i) || s.sdk.findNearbyLoc(/^bank booth$/i));
            if (!near && !(await walkTargetPersist(s, { x: conf.bankSpot.x, z: conf.bankSpot.z, level: 0 })).ok) throw Error('shop-to-bid: bank walk failed');
            const b = await s.bot.openBank();
            if (!b.success) throw Error(`shop-to-bid: openBank failed: ${b.message}`);
            await s.bot.withdrawItem(/^coins$/i, need);
            await s.bot.closeInterface();
            console.log(`FLOAT took ${need} asked, pack coins ${coins(s)}`);
        }
        const startCoins = coins(s), lots: { q: Quote; startHeld: number; bought: number; spent: number }[] = [];
        if (!(await walkTargetPersist(s, { x: conf.npcSpot.x, z: conf.npcSpot.z, level: conf.npcSpot.level ?? 0 })).ok) throw Error('shop-to-bid: shop walk failed');
        const open = await s.bot.openShop(conf.npc);
        if (!open.success) throw Error(`shop-to-bid: openShop failed: ${open.message}`);
        let spent = 0;
        const sells = new Set(s.sdk.getState()?.shop?.shopItems.map(i => i.name.toLowerCase()) ?? []);
        for (const q of quotes.filter(q => sells.has(q.name.toLowerCase()))) {
            const plan = bidPlan({ quote: q, unitCost: q.basePrice, coins: coins(s), reserve, maxUnits, minNet });
            const lot = { q, startHeld: held(s, q.id), bought: 0, spent: 0 };
            lots.push(lot);
            // The first buy is 2 units: 2 slots mean the item does not stack, and the sale needs at most 26 used slots.
            let cap = plan.units, probe = true;
            for (let idle = 0; lot.bought < cap && !stop();) {
                const b = await tickBuy(s, q, Math.min(probe ? 2 : CHUNK, cap - lot.bought), reserve, maxSpend - spent);
                lot.bought += b.bought; lot.spent += b.spent; spent += b.spent;
                if (probe && b.bought > 0) {
                    probe = false;
                    if (s.sdk.getInventory().filter(i => i.id === q.id).length > 1) cap = Math.min(cap, lot.bought + Math.max(0, 26 - s.sdk.getInventory().length));
                }
                if (chunkTooDear(b.spent, b.bought, q.bid!, minNet)) { console.log(`DEAR ${q.name} at ${(b.spent / b.bought).toFixed(1)} a unit`); break; }
                if (b.bought === 0) { if (++idle > wait) break; await waitTicks(s, 1); } else idle = 0;
            }
            console.log(`BOUGHT ${lot.bought} ${q.name} spent=${lot.spent} at ${key}${plan.units ? '' : ` (${plan.refusal})`}`);
        }
        await s.bot.closeInterface();
        if (!lots.some(l => held(s, l.q.id) > l.startHeld)) return { gain: coins(s) - startCoins, sold: 0, errors: [] };
        if (!(await walkTargetPersist(s, GE_SPOT)).ok) throw Error('shop-to-bid: exchange walk failed');
        const errors: string[] = [];
        let sold = 0;
        for (const lot of lots) {
            const units = held(s, lot.q.id) - lot.startHeld;
            if (units <= 0 || stop()) continue;
            const q = await fetchQuote(lot.q.id);
            const sell = bidPlan({ quote: q, unitCost: lot.spent / Math.max(1, lot.bought), coins: Number.MAX_SAFE_INTEGER, reserve: 0, maxUnits: units, minNet });
            if (!sell.units) { console.log(`KEPT ${units} ${q.name}: ${sell.refusal}`); continue; }
            const goal = `bid-${q.id}-${Date.now()}`, paths = orderPaths(server, bot, 'sell-' + goal);
            mkdirSync(paths.base, { recursive: true }); // runOwnedSale writes its journal there and creates no folder
            const sale = await runOwnedSale(s, { actor: bot, server, goal, item: q.id, quantity: sell.units, price: q.bid!, floor: q.bid!, reserveItems: 0, deadline: Date.now() + 120_000 }, paths.journal, stop);
            const filled = sale.journal?.progress?.filled ?? 0;
            sold += filled;
            console.log(`SHOP_TO_BID ${JSON.stringify({ item: q.id, name: q.name, profile: key, bought: lot.bought, spent: lot.spent, sold: filled, bid: q.bid, ok: sale.ok, error: sale.ok ? undefined : sale.error })}`);
            if (!sale.ok) errors.push(`${q.name}: ${sale.error}`);
        }
        return { gain: coins(s) - startCoins, sold, errors };
    };

    try {
        let total = 0, done = 0, empty = 0;
        for (let n = 0; n < lotsWanted && !stop(); n++) {
            const key = profiles[n % profiles.length]!, quotes = n === 0 ? await quotesNow(false) : await quotesNow(true);
            if (!quotes.length) { console.log('LOT_STOP no item clears MIN_NET'); break; }
            const t0 = s.tick(), r = await runLot(key, quotes);
            total += r.gain; done++;
            console.log(`LOT ${n + 1} ${key} coins ${r.gain >= 0 ? '+' : ''}${r.gain} sold ${r.sold} ticks ${s.tick() - t0}`);
            if (r.errors.length) await finish([s], false, `shop-to-bid sale failed: ${r.errors.join('; ')}; coins ${total} over ${done} lots`);
            // A full rotation of shops that sold nothing ends the run.
            empty = r.sold ? 0 : empty + 1;
            if (empty >= profiles.length) { console.log('LOT_STOP every shop sold nothing'); break; }
        }
        await finish([s], done > 0 && empty < profiles.length, `shop-to-bid coins ${total >= 0 ? '+' : ''}${total} over ${done} lots`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}
if (import.meta.main) await main();
