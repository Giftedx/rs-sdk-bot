import { expect, test } from 'bun:test';
import { buildItemPrices, itemPrice, priceItemKey, projectItemPrices } from './item-prices';

test('exact values retain the VWAP threshold, variant identities and note base IDs', () => {
    const prices = buildItemPrices([
        { id: 1135, name: 'Dragonhide body', basePrice: 7800, vwap: 5000, trades: 2, ask: 6000, bid: 4000 },
        { id: 2503, name: 'Dragonhide body', basePrice: 13480, vwap: 15000, trades: 3, ask: 16000, bid: 14000 },
    ], [{ id: 1135, name: 'Dragonhide body' }, { id: 2503, name: 'Dragonhide body' }]);
    expect(itemPrice(prices, { id: 1135 })?.value).toBe(7800);
    expect(itemPrice(prices, { id: 2503 })).toEqual({ name: 'Dragonhide body', value: 15000, ask: 16000, bid: 14000 });
    expect(itemPrice(prices, { id: 1136, baseId: 1135 })?.value).toBe(7800);
    expect(itemPrice(prices, 'Dragonhide body')).toBeNull();
    expect(itemPrice(prices, { id: 999999, name: 'Dragonhide body' })).toBeNull();
    expect(priceItemKey({ id: 1136, baseId: 1135, name: 'Dragonhide body' })).toBe('id:1135');
});

test('safe aliases preserve agreeing values while differing quotes and unpriced catalogue variants stay unknown', () => {
    const prices = buildItemPrices([
        { id: 1, name: 'Ring', basePrice: 1000, ask: 100, bid: 90 },
        { id: 2, name: 'Ring', basePrice: 1000, ask: 500, bid: 90 },
        { id: 3, name: 'Copy', basePrice: 50, ask: 60 },
        { id: 5, name: 'Plain', basePrice: 0, ask: null },
    ], [{ id: 1, name: 'Ring' }, { id: 2, name: 'Ring' }, { id: 3, name: 'Copy' }, { id: 4, name: 'Copy' }, { id: 5, name: 'Plain' }]);
    expect(itemPrice(prices, 'Ring')).toEqual({ name: 'Ring', value: 1000, ask: null, bid: 90 });
    expect(itemPrice(prices, 'Copy')).toBeNull();
    expect(itemPrice(prices, { id: 999999, name: 'Ring' })).toBeNull();
    expect(itemPrice(prices, 'Plain')?.value).toBe(0);
    expect(itemPrice(prices, { id: 995, name: 'Other' })?.value).toBe(1);
    expect(itemPrice(prices, 'Coins')?.value).toBe(1);
    expect(itemPrice(prices, { id: 617, name: 'Coins' })).toBeNull();
    for (const invalid of [{ id: -1, name: 'Coins' }, { id: 1.5, name: 'Ring' }, { id: undefined, name: 'Ring' },
        { baseId: -1, id: 1, name: 'Ring' }, { baseId: undefined, id: 1, name: 'Ring' }]) {
        expect(itemPrice(prices, invalid)).toBeNull();
        expect(priceItemKey(invalid)).toStartWith('invalid:');
    }
});

test('consumer projection exposes only visible exact IDs and already-proved name aliases', () => {
    const prices = buildItemPrices([{ id: 1, name: 'Held', basePrice: 10 }, { id: 2, name: 'Bank only', basePrice: 20 }],
        [{ id: 1, name: 'Held' }, { id: 2, name: 'Bank only' }]);
    const projected = projectItemPrices(prices, [{ id: 1, name: 'Held' }]);
    expect(Object.keys(projected.byId)).toEqual(['1']);
    expect(Object.keys(projected.byName)).toEqual(['held']);
    expect(itemPrice(projected, { id: 2 })).toBeNull();
});
