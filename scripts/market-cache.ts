// The live market of every item, saved for the bots: .practice/market-all.json. The loot job and the value guard read
// it (packages/core/src/loot.ts) to value an item at its market price, not only its alchemy floor. The fleet agent
// starts this script when the file is older than MARKET_CACHE_MS (scripts/fleet-agent.ts).
// It reads the same pages as the dashboard (packages/dashboard/server.ts refreshPrices): 100 items a page, at most 2
// requests a second. The market is thin (one trade set Bread's lastPrice to 1,000,000), so an item's price is its
// 7-day VWAP when it traded at least MIN_TRADES times, else none.
// It also writes .practice/market-bids.json: the shop-to-bid lots (scripts/shop-to-bid.ts) that the open bids make
// worth a walk now, by shop, the largest first. A bid far above a shop price is filled by other players within hours,
// so this file is where a session looks first.
// Fetches the live market pages and writes .practice/market-all.json and .practice/market-bids.json.
// Usage: bun scripts/market-cache.ts
import { renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BIDS_FILE, fetchMarket, shopLots, writeMarketCache } from '../packages/core/src/market-cache';

export * from '../packages/core/src/market-cache';

if (import.meta.main) {
    const root = resolve(import.meta.dir, '..');
    try {
        const items = await fetchMarket();
        writeMarketCache(root, items);
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
