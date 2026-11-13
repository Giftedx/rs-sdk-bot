import { expect, test } from 'bun:test';
import { highAlch, itemAlch } from './gen-item-alch';

test('the alchemy table keeps the cost of each tradeable item by name, the higher of two with one name', () => {
    expect(itemAlch([
        { name: 'Rune platebody', cost: 65000, tradeable: true },
        { name: 'Dwarf remains', cost: 1, tradeable: false },
        { name: 'Ring', cost: 50, tradeable: true },
        { name: 'Ring', cost: 75, tradeable: true },
        { name: 'Free item', cost: 0, tradeable: true },
    ])).toEqual({ 'Ring': 75, 'Rune platebody': 65000 });
    // alchemy.rs2: max(scale(6, 10, cost), 1).
    expect(highAlch(65000)).toBe(39000);
    expect(highAlch(1)).toBe(1);
    expect(highAlch(12)).toBe(7);
});
