import { expect, test } from 'bun:test';
import { parseFanin, held } from './item-fanin';

test('the receiver comes first, the item name last, each account once', () => {
    expect(parseFanin(['BowBeforeMe', 'Wandwaver', 'Bigchopper', 'Feather'])).toEqual({ receiver: 'BowBeforeMe', donors: ['Wandwaver', 'Bigchopper'], item: 'Feather' });
    expect(() => parseFanin(['BowBeforeMe', 'Feather'])).toThrow();
    expect(() => parseFanin(['BowBeforeMe', 'bowbeforeme', 'Feather'])).toThrow();
    expect(() => parseFanin(['BowBeforeMe', 'Wandwaver', '500'])).toThrow();
});

test('held counts every stack of the item', () => {
    expect(held([{ id: 314, count: 120 }, { id: 52, count: 5 }, { id: 314, count: 3 }], 314)).toBe(123);
});
