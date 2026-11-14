import { expect, test } from 'bun:test';
import { buildItemPrices, itemPrice, priceItemKey } from './item-prices';
import { createVaultItems } from './vault-items';

const prices = buildItemPrices([
    { id: 1135, name: 'Dragonhide body', basePrice: 7800 },
    { id: 2503, name: 'Dragonhide body', basePrice: 13480 },
], [{ id: 1135, name: 'Dragonhide body' }, { id: 2503, name: 'Dragonhide body' }]);

test('vault buckets retain exact variant and note-base identities before pricing', () => {
    const held = createVaultItems();
    held.add([{ id: 1136, baseId: 1135, name: 'Dragonhide body (noted)', count: 2 }, { id: 2503, name: 'Dragonhide body', count: 3 }]);
    held.add([{ id: 1135, name: 'Dragonhide body', count: 1 }], -1);
    expect(held.rows()).toEqual([
        { id: 1136, baseId: 1135, name: 'Dragonhide body (noted)', count: 1 },
        { id: 2503, name: 'Dragonhide body', count: 3 },
    ]);
    expect(held.rows().reduce((total, item) => total + itemPrice(prices, item)!.value * item.count, 0)).toBe(48240);
    expect(held.unconfirmed()).toBe(false);
});

test('a legacy outgoing transfer cannot leave all exact variant stock confirmed', () => {
    const held = createVaultItems();
    held.add([{ id: 1135, name: 'Dragonhide body', count: 2 }, { id: 2503, name: 'Dragonhide body', count: 3 }]);
    held.add([{ name: 'Dragonhide body', count: 4 }], -1);
    expect(held.rows()).toEqual([{ name: 'Dragonhide body', count: 1, unconfirmed: true }]);
    expect(held.unconfirmed()).toBe(true);
    expect(held.rows().filter(item => !item.unconfirmed).reduce((total, item) => total + item.count, 0)).toBe(0);
    expect(held.rows().filter(item => !item.unconfirmed).reduce((total, item) => total + (itemPrice(prices, item)?.value ?? 0) * item.count, 0)).toBe(0);
    // A later identified incoming item cannot identify which old variant remains.
    held.add([{ id: 2503, name: 'Dragonhide body', count: 2 }]);
    expect(held.rows()).toEqual([{ name: 'Dragonhide body', count: 3, unconfirmed: true }]);
});

test('unbound or overdrawn outgoing transfers retain signed uncertainty without inflating held counts', () => {
    const held = createVaultItems();
    held.add([{ name: 'Dragonhide body', count: 4 }], -1);
    held.add([{ id: 1135, name: 'Dragonhide body', count: 3 }]);
    expect(held.rows()).toEqual([{ name: 'Dragonhide body', count: -1, unconfirmed: true }]);
    expect(held.unconfirmed()).toBe(true);
    const overdrawn = createVaultItems();
    overdrawn.add([{ id: 1135, name: 'Dragonhide body', count: 2 }, { id: 2503, name: 'Dragonhide body', count: 3 }]);
    overdrawn.add([{ id: 1135, name: 'Dragonhide body', count: 4 }], -1);
    expect(overdrawn.rows()).toEqual([{ name: 'Dragonhide body', count: 1, unconfirmed: true }]);
});

test('ordinary legacy transfers keep their aggregate arithmetic and exhausted known rows disappear', () => {
    const held = createVaultItems();
    held.add([{ name: 'Lobster', count: 8 }, { id: 1135, name: 'Dragonhide body', count: 2 }]);
    held.add([{ name: 'Lobster', count: 3 }, { id: 1135, name: 'Dragonhide body', count: 2 }], -1);
    expect(held.rows()).toEqual([{ name: 'Lobster', count: 5 }]);
    expect(held.unconfirmed()).toBe(false);
});

test('only exact or genuinely legacy Coins receive the coin bucket', () => {
    const held = createVaultItems();
    held.add([{ name: 'Coins', count: 5 }, { id: 995, name: 'Other', count: 7 }, { id: 617, name: 'Coins', count: 11 }, { id: -1, name: 'Coins', count: 13 }, { id: 995, baseId: -1, name: 'Coins', count: 17 }]);
    expect(held.rows().find(item => priceItemKey(item) === 'id:995')).toEqual({ id: 995, name: 'Coins', count: 12 });
    expect(held.rows().find(item => priceItemKey(item) === 'id:617')?.count).toBe(11);
    expect(held.rows().filter(item => priceItemKey(item).startsWith('invalid:')).map(item => item.count)).toEqual([30]);
    expect(held.rows().filter(item => priceItemKey(item) !== 'id:995').every(item => itemPrice(prices, item) === null)).toBe(true);
});
