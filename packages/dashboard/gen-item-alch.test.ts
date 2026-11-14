import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { highAlch, itemAlch } from './gen-item-alch';

test('alchemy costs preserve exact item IDs and only keep name aliases whose costs agree', () => {
    expect(itemAlch([
        { id: 1127, name: 'Rune platebody', cost: 65000, tradeable: true },
        { id: 1, name: 'Dwarf remains', cost: 1, tradeable: false },
        { id: 2, name: 'Ring', cost: 50, tradeable: true },
        { id: 3, name: 'Ring', cost: 75, tradeable: true },
        { id: 4, name: 'Free item', cost: 0, tradeable: true },
        { id: 5, name: 'Same ring', cost: 25, tradeable: true },
        { id: 6, name: 'Same ring', cost: 25, tradeable: true },
    ])).toEqual({ 1127: 65000, 2: 50, 3: 75, 5: 25, 6: 25, 'Same ring': 25, 'Rune platebody': 65000 });
    // alchemy.rs2: max(scale(6, 10, cost), 1).
    expect(highAlch(65000)).toBe(39000);
    expect(highAlch(1)).toBe(1);
    expect(highAlch(12)).toBe(7);
});

test('the catalogue and shipped alchemy asset keep green and black dragonhide bodies distinct', () => {
    const items = JSON.parse(readFileSync(new URL('../../knowledge/items.json', import.meta.url), 'utf8'));
    const built = itemAlch(items), shipped = JSON.parse(readFileSync(new URL('./client-assets/item-alch.json', import.meta.url), 'utf8'));
    for (const costs of [built, shipped]) {
        expect(costs[1135]).toBe(7800);expect(highAlch(costs[1135])).toBe(4680);
        expect(costs[2503]).toBe(13480);expect(highAlch(costs[2503])).toBe(8088);
        expect(costs['Dragonhide body']).toBeUndefined();
        expect(costs[1745]).toBe(50);expect(costs[2509]).toBe(110);expect(costs['Dragon leather']).toBeUndefined();
    }
});
