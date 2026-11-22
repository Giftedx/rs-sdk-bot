// Every supported source of every item a ladder rung consumes or requires, with a cost per source.
// Usage: bun packages/knowledge/src/item-sources.ts [--market <file>] [--practice <dir>] [--out <file>]
//   writes knowledge/item-sources.json and knowledge/item-sources-gaps.md.
//   --market: GE snapshot, either .practice/coordinator/market-prices.json ({debugname: {at, ask, bid, sell}}) or a
//     research/market-*.json (scripts/market-snapshot.ts). Default: newest quote per item from coordinator and research
//     snapshots. For live fleet owned stock and .practice/market-all.json quotes, run bun scripts/item-sources.ts.
// Item set: rung inputs and requires (knowledge/ladders.json), the tools, bait and access items of the skill-tools
// records that apply to a rung (knowledge/skill-tools.json), healing food from the cooking outputs, and then the inputs
// and tools of every rung that makes or gathers an item already in the set, until the set stops growing.
// Every source cites a content-relative path and 1-based line under vendor/rs-sdk/server/content, or the snapshot file.
// Each cost keeps three numbers apart (helper ticks, coins, risk) and adds a wall-clock number; each says what it rests on.
import { runItemSourcesCli } from './item-sources/cli';

export {
    shopUnitPrice,
    sourceTiles,
    type ActionSource,
    type Basis,
    type Cost,
    type DropSource,
    type GatherSource,
    type GeSource,
    type ItemSources,
    type MakeSource,
    type Market,
    type MarketQuoteInput,
    type Options,
    type OwnedAccountStock,
    type OwnedSource,
    type OwnedStatusRow,
    type OwnedStock,
    type PickupSource,
    type Place,
    type SharedMarketParser,
    type ShopSource,
    type Source,
    type Substitute,
    type Tile,
} from './item-sources/model';

export {
    defaultMarket,
    ownedStockFromRows,
    readMarket,
} from './item-sources/stock-adapter';

export { buildItemSources } from './item-sources/build';

export {
    counts,
    gapsMarkdown,
    serializeItemSources,
} from './item-sources/report';

if (import.meta.main) {
    runItemSourcesCli(process.argv.slice(2));
}
