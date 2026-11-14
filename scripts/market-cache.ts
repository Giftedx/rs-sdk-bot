// The live market of every item, saved for the bots: .practice/market-all.json. The loot job and the value guard read
// it (packages/core/src/loot.ts) to value an item at its market price, not only its alchemy floor. The fleet agent
// starts this script when the file is older than MARKET_CACHE_MS (scripts/fleet-agent.ts).
// It reads the same pages as the dashboard (packages/dashboard/server.ts refreshPrices): 100 items a page, at most 2
// requests a second. The market is thin (one trade set Bread's lastPrice to 1,000,000), so an item's price is its
// 7-day VWAP when it traded at least MIN_TRADES times, else none.
// It also writes .practice/market-bids.json: the shop-to-bid lots (scripts/shop-to-bid.ts) that the open bids make
// worth a walk now, by shop, the largest first. A bid far above a shop price is filled by other players within hours,
// so this file is where a session looks first.
// Usage: bun scripts/market-cache.ts
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MARKET_FILE = '.practice/market-all.json';
export const MARKET_CACHE_MS = 30 * 60_000;
export const MIN_TRADES = 3;
const DEMO = 'https://rs-sdk-demo.fly.dev';

// `base`: the item's base (shop) price; `want`: the units the open bids want.
export type MarketItem = { name: string; price: number | null; bid: number | null; ask: number | null; trades: number; base?: number; want?: number };
// One page of the market API as cache rows.
export function marketRows(items: readonly any[]): Record<number, MarketItem> {
    const out: Record<number, MarketItem> = {};
    for (const i of items) {
        if (!Number.isSafeInteger(i?.id)) continue;
        const trades = Number.isFinite(i.trades) ? i.trades : 0;
        out[i.id] = { name: String(i.name ?? ''), price: i.vwap != null && trades >= MIN_TRADES ? Number(i.vwap) : null, bid: i.bid ?? null, ask: i.ask ?? null, trades,
            ...(Number.isSafeInteger(i.basePrice) ? { base: i.basePrice } : {}), ...(Number.isSafeInteger(i.buyQuantity) ? { want: i.buyQuantity } : {}) };
    }
    return out;
}

export const BIDS_FILE = '.practice/market-bids.json';
type LotItem = { id: number; name: string; bid: number; want: number; margin: number };
type Lot = { profile: string; value: number; items: LotItem[] };
type Quote = { id: number; name: string; basePrice: number; bid: number | null; buyQuantity: number };
type Profiles = Record<string, { items: { re: RegExp }[] }>;
// The shop-to-bid lots worth at least `floor` coins at the base price, by shop, the largest first.
export function shopLots(items: Record<number, MarketItem>, profiles: Profiles,
    scan: (profiles: Profiles, quotes: Quote[], minNet: number) => (LotItem & { profile: string })[],
    value: (items: readonly { re: RegExp }[], quotes: Quote[]) => number, floor = 20_000, minNet = 50): Lot[] {
    const quotes = Object.entries(items).filter(([, m]) => m.base !== undefined && m.want !== undefined)
        .map(([id, m]) => ({ id: Number(id), name: m.name, basePrice: m.base!, bid: m.bid && m.bid > 0 ? m.bid : null, buyQuantity: m.want! }));
    const rows = scan(profiles, quotes, minNet), lots: Lot[] = [];
    for (const profile of new Set(rows.map(r => r.profile))) {
        const mine = rows.filter(r => r.profile === profile);
        const v = value(profiles[profile]!.items, quotes.filter(q => mine.some(r => r.id === q.id)));
        if (v >= floor) lots.push({ profile, value: v, items: mine.map(({ id, name, bid, want, margin }) => ({ id, name, bid, want, margin })) });
    }
    return lots.sort((a, b) => b.value - a.value);
}

export async function fetchMarket(get: (url: string) => Promise<any> = async url => {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw Error(`market HTTP ${r.status}`);
    return r.json();
}, pause: (ms: number) => Promise<void> = ms => Bun.sleep(ms)): Promise<Record<number, MarketItem>> {
    const all: Record<number, MarketItem> = {};
    for (let offset = 0, total = 1; offset < total; offset += 100) {
        const j = await get(`${DEMO}/api/market/items?limit=100&offset=${offset}`);
        if (!Number.isSafeInteger(j?.total) || j.total < 0 || !Array.isArray(j.items)) throw Error('invalid market page');
        total = Math.min(j.total, 5000);
        Object.assign(all, marketRows(j.items));
        if (offset + 100 < total) await pause(500);
    }
    return all;
}

if (import.meta.main) {
    const root = resolve(import.meta.dir, '..'), file = join(root, MARKET_FILE);
    try {
        const items = await fetchMarket();
        mkdirSync(join(root, '.practice'), { recursive: true });
        writeFileSync(file + '.tmp', JSON.stringify({ at: Date.now(), items }));
        renameSync(file + '.tmp', file);
        const priced = Object.values(items).filter(i => i.price !== null).length;
        // The shop-to-bid lots: optional, so a failure here never loses the price cache.
        let best = 'none';
        try {
            const [{ PROFILES }, { scanProfiles, lotValue }] = await Promise.all([import('./shop-buyer'), import('./shop-to-bid')]);
            const lots = shopLots(items, PROFILES, scanProfiles, lotValue).slice(0, 10), bids = join(root, BIDS_FILE);
            writeFileSync(bids + '.tmp', JSON.stringify({ at: Date.now(), lots }, null, 1));
            renameSync(bids + '.tmp', bids);
            if (lots.length) best = `${lots[0]!.profile}:${lots[0]!.value}`;
        } catch (e) { best = `error ${String(e).slice(0, 80)}`; }
        console.log(`RESULT ok market-cache items=${Object.keys(items).length} priced=${priced} bestLot=${best}`);
    } catch (e) {
        console.log(`RESULT fail market-cache ${String(e).slice(0, 200)}`);
        process.exit(1);
    }
}
