import { expect, test } from 'bun:test';
import { bidPlan, chunkTooDear, fetchMarket, floatNeed, lotValue, parseProfiles, tickPackets, trickleOnly, fetchQuote, netPerUnit, parseItems, scanProfiles } from './shop-to-bid';

const bait = { id: 313, name: 'Fishing bait', basePrice: 3, bid: 218, buyQuantity: 38_334 };

test('a unit clears the bid less the 5% seller tax', () => {
    expect(netPerUnit(218)).toBe(207.1);
    expect(netPerUnit(20)).toBe(19);
});

test('the plan buys what the bid wants, the coins pay for and UNITS allows', () => {
    const unitCost = 21;
    expect(bidPlan({ quote: bait, unitCost, coins: 1_000_000, reserve: 10_000, maxUnits: 5000, minNet: 50 })).toEqual({ units: 5000 });
    expect(bidPlan({ quote: { ...bait, buyQuantity: 120 }, unitCost, coins: 1_000_000, reserve: 10_000, maxUnits: 5000, minNet: 50 })).toEqual({ units: 120 });
    // 2,100 coins above the reserve pay for 100 units at 21 each.
    expect(bidPlan({ quote: bait, unitCost, coins: 12_100, reserve: 10_000, maxUnits: 5000, minNet: 50 })).toEqual({ units: 100 });
});

test('the plan refuses with no bid, a thin margin or no spare coins', () => {
    expect(bidPlan({ quote: { ...bait, bid: null }, unitCost: 21, coins: 1e6, reserve: 0, maxUnits: 10, minNet: 50 }).refusal).toBe('no open bid');
    expect(bidPlan({ quote: { ...bait, buyQuantity: 0 }, unitCost: 21, coins: 1e6, reserve: 0, maxUnits: 10, minNet: 50 }).refusal).toBe('no open bid');
    // Air runes: bid 17, base 4. 16.15 - 28 is a loss.
    expect(bidPlan({ quote: { id: 556, name: 'Air rune', basePrice: 4, bid: 17, buyQuantity: 1e6 }, unitCost: 28, coins: 1e6, reserve: 0, maxUnits: 10, minNet: 1 }).refusal)
        .toBe('margin -12 is under MIN_NET 1');
    expect(bidPlan({ quote: bait, unitCost: 21, coins: 10_000, reserve: 10_000, maxUnits: 10, minNet: 50 }).refusal).toBe('no coins above the reserve');
});

test('the float tops the pack up to the reserve plus the spend limit', () => {
    expect(floatNeed(0, 10_000, 200_000)).toBe(210_000);
    expect(floatNeed(50_000, 10_000, 200_000)).toBe(160_000);
    expect(floatNeed(300_000, 10_000, 200_000)).toBe(0);
});

test('parseItems reads a comma list of positive item ids', () => {
    expect(parseItems('313')).toEqual([313]);
    expect(parseItems('560,559,560')).toEqual([560, 559]);
    expect(parseItems('313,x')).toBeNull();
    expect(parseItems('0')).toBeNull();
    expect(parseItems('')).toBeNull();
});

test('the scan lists exact profile items whose bid clears MIN_NET, the most coins first', () => {
    const profiles = { sarim: { items: [{ re: /^fishing bait$/i }, { re: /^feather$/i }] }, betty: { items: [{ re: /death rune/i }, { re: /air rune/i }] } };
    const market = [bait,
        { id: 314, name: 'Feather', basePrice: 2, bid: null, buyQuantity: 0 },
        { id: 560, name: 'Death rune', basePrice: 30, bid: 250, buyQuantity: 100_000 },
        { id: 556, name: 'Air rune', basePrice: 4, bid: 17, buyQuantity: 1_333_958 },
        // The unanchored pattern must not match a longer name.
        { id: 9999, name: 'Death rune pack', basePrice: 1, bid: 9000, buyQuantity: 5 }];
    expect(scanProfiles(profiles, market, 50)).toEqual([
        { profile: 'betty', id: 560, name: 'Death rune', bid: 250, want: 100_000, margin: 207 },
        { profile: 'sarim', id: 313, name: 'Fishing bait', bid: 218, want: 38_334, margin: 204 },
    ]);
});

test('a chunk is too dear when its real unit cost leaves less than MIN_NET', () => {
    // Death runes at a bid of 250 clear 237.5 a unit after tax.
    expect(chunkTooDear(50 * 188, 50, 250, 50)).toBe(true);
    expect(chunkTooDear(50 * 187.5, 50, 250, 50)).toBe(false);
    expect(chunkTooDear(50 * 180, 50, 250, 50)).toBe(false);
    expect(chunkTooDear(0, 0, 250, 50)).toBe(false);
});

test('fetchQuote reads the public market row and refuses a row for another item', async () => {
    const row = { id: 313, name: 'Fishing bait', basePrice: 3, bid: 218, buyQuantity: 38334, ask: 271 };
    let asked = '';
    expect(await fetchQuote(313, async url => { asked = url; return row; })).toEqual(bait);
    expect(asked).toBe('https://rs-sdk-demo.fly.dev/api/market/items/313');
    expect(await fetchQuote(313, async () => ({ ...row, bid: null }))).toEqual({ ...bait, bid: null });
    await expect(fetchQuote(313, async () => ({ ...row, id: 314 }))).rejects.toThrow('invalid market quote for 313');
});

test('fetchMarket reads every page', async () => {
    const asked: string[] = [];
    const rows = await fetchMarket(async url => {
        asked.push(url);
        return url.includes('offset=0') ? { total: 101, items: [{ id: 313, name: 'Fishing bait', basePrice: 3, bid: 218, buyQuantity: 1 }, { id: 'bad' }] } : { total: 101, items: [{ id: 560, name: 'Death rune', basePrice: 30, bid: 0, buyQuantity: 0 }] };
    }, async () => {});
    expect(asked.length).toBe(2);
    expect(rows.map(r => [r.id, r.bid])).toEqual([[313, 218], [560, null]]);
});

test('one tick of shop packets holds at most 5 buys of 10, 5 or 1', () => {
    expect(tickPackets(300)).toEqual([10, 10, 10, 10, 10]);
    expect(tickPackets(23)).toEqual([10, 10, 1, 1, 1]);
    expect(tickPackets(7)).toEqual([5, 1, 1]);
    expect(tickPackets(2)).toEqual([1, 1]);
    expect(tickPackets(0)).toEqual([]);
    expect(tickPackets(-3)).toEqual([]);
});

test('parseProfiles reads a comma list of known profiles in order', () => {
    const known = ['sarim', 'harry_bait', 'betty'];
    expect(parseProfiles('sarim', known)).toEqual(['sarim']);
    expect(parseProfiles('Sarim,HARRY_BAIT', known)).toEqual(['sarim', 'harry_bait']);
    expect(parseProfiles('sarim,nowhere', known)).toBeNull();
    expect(parseProfiles('', known)).toBeNull();
});

test('a tick of a few units after the first means only the restock trickle is left', () => {
    expect(trickleOnly(3, false, 0)).toBe(true);
    expect(trickleOnly(9, false, 0)).toBe(true);
    expect(trickleOnly(10, false, 0)).toBe(false);
    expect(trickleOnly(50, false, 0)).toBe(false);
    // The 2-unit probe, a tick with nothing, and a run told to wait for restock never count as a trickle.
    expect(trickleOnly(2, true, 0)).toBe(false);
    expect(trickleOnly(0, false, 0)).toBe(false);
    expect(trickleOnly(3, false, 20)).toBe(false);
});

test('lotValue counts only the quoted items the shop sells, at the base price, up to a shelf of units', () => {
    const sarim = [{ re: /^fishing bait$/i }, { re: /^feather$/i }];
    const quotes = [
        { id: 313, name: 'Fishing bait', basePrice: 3, bid: 218, buyQuantity: 38_334 },
        { id: 560, name: 'Death rune', basePrice: 30, bid: 250, buyQuantity: 100_000 },
    ];
    // Bait: (207.1 - 3) x 1,500. The death rune is not sold here.
    expect(lotValue(sarim, quotes)).toBe(306_150);
    expect(lotValue(sarim, quotes.slice(1))).toBe(0);
    expect(lotValue(sarim, [{ ...quotes[0]!, buyQuantity: 10 }])).toBe(2041);
    expect(lotValue(sarim, [{ ...quotes[0]!, bid: null }])).toBe(0);
});
