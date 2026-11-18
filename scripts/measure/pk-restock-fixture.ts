// Rows of the market cache (.practice/market-all.json) for the items of the PK restock, as the tests of restockPlan read them:
// the lowest ask and the units offered. The prayer potion, the glory and the super potions are dear, the superantipoison
// and the antipoison have no seller, and the nature rune asks more than twice the hand limit that the plan once used.
import type { RestockMarket } from '../pk-roam';

export const RESTOCK_MARKET: RestockMarket = {
    563: { ask: 700, sell: 105_042 },
    561: { ask: 634, sell: 252_104 },
    385: { ask: 885, sell: 2_002_442 },
    2434: { ask: 322_603, sell: 3 },
    1712: { ask: 4_250_000, sell: 100 },
    2440: { ask: 100_000, sell: 876 },
    2436: { ask: 100_000, sell: 864 },
    2448: { ask: null, sell: 0 },
    2446: { ask: null, sell: 0 },
    861: { ask: 95_000, sell: 62 },
    1113: { ask: 210_367, sell: 896 },
};
// The limit of each item above: the ask plus RESTOCK_MARGIN_PERCENT (10).
export const RESTOCK_LIMITS = { 563: 770, 561: 698, 385: 974, 2434: 354_864, 1712: 4_675_000, 2440: 110_000, 2436: 110_000, 861: 104_500, 1113: 231_404 } as const;
