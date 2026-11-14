import { expect, test } from 'bun:test';
import { bidPlan, fetchQuote, netPerUnit, WORST_PRICE_FACTOR } from './shop-to-bid';

const bait = { name: 'Fishing bait', basePrice: 3, bid: 218, buyQuantity: 38_334 };

test('a unit clears the bid less the 5% seller tax', () => {
    expect(netPerUnit(218)).toBe(207.1);
    expect(netPerUnit(20)).toBe(19);
});

test('the plan buys what the bid wants, the coins pay for and UNITS allows', () => {
    const unitCost = bait.basePrice * WORST_PRICE_FACTOR;
    expect(bidPlan({ quote: bait, unitCost, coins: 1_000_000, reserve: 10_000, maxUnits: 5000, minNet: 50 })).toEqual({ units: 5000 });
    expect(bidPlan({ quote: { ...bait, buyQuantity: 120 }, unitCost, coins: 1_000_000, reserve: 10_000, maxUnits: 5000, minNet: 50 })).toEqual({ units: 120 });
    // 2,100 coins above the reserve pay for 100 units at 21 each.
    expect(bidPlan({ quote: bait, unitCost, coins: 12_100, reserve: 10_000, maxUnits: 5000, minNet: 50 })).toEqual({ units: 100 });
});

test('the plan refuses with no bid, a thin margin or no spare coins', () => {
    expect(bidPlan({ quote: { ...bait, bid: null }, unitCost: 21, coins: 1e6, reserve: 0, maxUnits: 10, minNet: 50 }).refusal).toBe('no open bid');
    expect(bidPlan({ quote: { ...bait, buyQuantity: 0 }, unitCost: 21, coins: 1e6, reserve: 0, maxUnits: 10, minNet: 50 }).refusal).toBe('no open bid');
    // Air runes: bid 17, base 4. 16.15 - 28 is a loss.
    expect(bidPlan({ quote: { name: 'Air rune', basePrice: 4, bid: 17, buyQuantity: 1e6 }, unitCost: 28, coins: 1e6, reserve: 0, maxUnits: 10, minNet: 1 }).refusal)
        .toBe('margin -12 is under MIN_NET 1');
    expect(bidPlan({ quote: bait, unitCost: 21, coins: 10_000, reserve: 10_000, maxUnits: 10, minNet: 50 }).refusal).toBe('no coins above the reserve');
});

test('fetchQuote reads the public market row and refuses a row for another item', async () => {
    const row = { id: 313, name: 'Fishing bait', basePrice: 3, bid: 218, buyQuantity: 38334, ask: 271 };
    let asked = '';
    expect(await fetchQuote(313, async url => { asked = url; return row; })).toEqual(bait);
    expect(asked).toBe('https://rs-sdk-demo.fly.dev/api/market/items/313');
    expect(await fetchQuote(313, async () => ({ ...row, bid: null }))).toEqual({ ...bait, bid: null });
    await expect(fetchQuote(313, async () => ({ ...row, id: 314 }))).rejects.toThrow('invalid market quote for 313');
});
