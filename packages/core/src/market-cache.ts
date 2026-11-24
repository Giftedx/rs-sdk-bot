// The live market of every item, saved for the bots: .practice/market-all.json. The loot job and the value guard read
// it (packages/core/src/loot.ts) to value an item at its market price, not only its alchemy floor. The fleet agent
// starts scripts/market-cache.ts when the file is older than MARKET_CACHE_MS (scripts/fleet-agent.ts).
// It reads the same pages as the dashboard (packages/dashboard/server.ts refreshPrices): 100 items a page, at most 2
// requests a second. The market is thin (one trade set Bread's lastPrice to 1,000,000), so an item's price is its
// 7-day VWAP when it traded at least MIN_TRADES times, else none.
// It also writes .practice/market-bids.json: the shop-to-bid lots (scripts/shop-to-bid.ts) that the open bids make
// worth a walk now, by shop, the largest first. A bid far above a shop price is filled by other players within hours,
// so this file is where a session looks first.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gameDialAddress } from './websocket-proxy';
import { renameRetry } from './status';

export const MARKET_FILE = '.practice/market-all.json';
export const MARKET_CACHE_MS = 30 * 60_000;
export const MIN_TRADES = 3;
const DEMO = 'https://rs-sdk-demo.fly.dev';

// `base`: the item's base (shop) price; `want`: the units the open bids want; `sell`: the units offered for sale.
export type MarketItem = { name: string; price: number | null; bid: number | null; ask: number | null; trades: number; base?: number; want?: number; sell?: number };
export type MarketQuote = { at: number; ask: number | null; bid: number | null; sell: number; trades?: number };
// A dashboard and a fleet refresh can finish together. Each publishes a complete file through its own temporary path.
export function writeMarketCache(base: string, items: Readonly<Record<number, MarketItem>>, at = Date.now()): void {
    if (!Number.isSafeInteger(at) || at <= 0) throw Error('invalid market observation time');
    const file = join(base, MARKET_FILE), tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(join(base, '.practice'), { recursive: true });
    try {
        writeFileSync(tmp, JSON.stringify({ at, items }), { flag: 'wx' });
        renameRetry(tmp, file);
    } finally { rmSync(tmp, { force: true }); }
}
// Acquisition needs an observed seller count as well as the ask. Older caches that omit it remain unknown.
export function marketQuotes(raw: unknown, now = Date.now()): Record<number, MarketQuote> {
    const cache = raw as any, out: Record<number, MarketQuote> = {};
    if (!Number.isSafeInteger(cache?.at) || cache.at <= 0 || now < cache.at || now - cache.at >= MARKET_CACHE_MS
        || !cache.items || typeof cache.items !== 'object' || Array.isArray(cache.items)) return out;
    const price = (value: unknown) => value === null || (Number.isSafeInteger(value) && (value as number) > 0);
    const items = cache.items as Record<string, any>;
    for (const key in items) {
        if (!Object.hasOwn(items, key)) continue;
        const row = items[key];
        const id = Number(key);
        if (!/^\d+$/.test(key) || !Number.isSafeInteger(id) || !row || !price(row.ask) || !price(row.bid)
            || !Number.isSafeInteger(row.sell) || row.sell < 0) continue;
        out[id] = { at: cache.at, ask: row.ask, bid: row.bid, sell: row.sell, ...(Number.isSafeInteger(row.trades) && row.trades >= 0 ? { trades: row.trades } : {}) };
    }
    return out;
}
// One page of the market API as cache rows.
export function marketRows(items: readonly any[]): Record<number, MarketItem> {
    const out: Record<number, MarketItem> = {};
    for (const i of items) {
        if (!Number.isSafeInteger(i?.id)) continue;
        const trades = Number.isFinite(i.trades) ? i.trades : 0;
        out[i.id] = { name: String(i.name ?? ''), price: i.vwap != null && trades >= MIN_TRADES ? Number(i.vwap) : null, bid: i.bid ?? null, ask: i.ask ?? null, trades,
            ...(Number.isSafeInteger(i.basePrice) ? { base: i.basePrice } : {}), ...(Number.isSafeInteger(i.buyQuantity) ? { want: i.buyQuantity } : {}),
            ...(Number.isSafeInteger(i.sellQuantity) && i.sellQuantity >= 0 ? { sell: i.sellQuantity } : {}) };
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
    const quotes: Quote[] = [], quoteById = new Map<number, Quote>();
    for (const idStr in items) {
        if (!Object.hasOwn(items, idStr)) continue;
        const m = items[idStr as any]!;
        if (m.base === undefined || m.want === undefined) continue;
        const id = Number(idStr);
        const q: Quote = { id, name: m.name, basePrice: m.base, bid: m.bid && m.bid > 0 ? m.bid : null, buyQuantity: m.want };
        quotes.push(q);
        quoteById.set(id, q);
    }
    const rows = scan(profiles, quotes, minNet), byProfile = new Map<string, LotItem[]>(), lots: Lot[] = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        let list = byProfile.get(r.profile);
        if (!list) { list = []; byProfile.set(r.profile, list); }
        list.push({ id: r.id, name: r.name, bid: r.bid, want: r.want, margin: r.margin });
    }
    for (const [profile, mine] of byProfile) {
        const matchedQuotes: Quote[] = [];
        for (let i = 0; i < mine.length; i++) {
            const q = quoteById.get(mine[i]!.id);
            if (q) matchedQuotes.push(q);
        }
        const v = value(profiles[profile]!.items, matchedQuotes);
        if (v >= floor) lots.push({ profile, value: v, items: mine });
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
        const j = await get(gameDialAddress(`${DEMO}/api/market/items?limit=100&offset=${offset}`));
        if (!Number.isSafeInteger(j?.total) || j.total < 0 || !Array.isArray(j.items)) throw Error('invalid market page');
        total = Math.min(j.total, 5000);
        Object.assign(all, marketRows(j.items));
        if (offset + 100 < total) await pause(500);
    }
    return all;
}
