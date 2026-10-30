import { test, expect } from 'bun:test';
import { idsFor, supplyBill } from '../src/supply-bill';

const items = [{ id: 536, name: 'Dragon bones' }, { id: 99, name: 'Unfinished potion', debugname: 'ranarrvial' }, { id: 109, name: 'Unfinished potion', debugname: 'dwarfweedvial' }, { id: 2970, name: 'Mort myre fungi' }];

test('bill lines map to pinned item ids, including unfinished potions and plural names', () => {
    expect(idsFor('dragon bones', items)).toEqual([536]);
    expect(idsFor('ranarr potion (unf)', items)).toEqual([99]);
    expect(idsFor('dwarf weed potion (unf)', items)).toEqual([109]);
    expect(idsFor('mort myre fungus', items)).toEqual([2970]);
});

test('the shortfall subtracts stock across helpers and lists the holders', () => {
    const bill = supplyBill([{ item: 'dragon bones', count: 560 }, { item: 'rune armour set', count: 1 }], items,
        [{ name: 'A', bank: [{ id: 536, count: 300 }] }, { name: 'B', inventory: [{ id: 536, count: 100 }] }]);
    expect(bill[0]).toMatchObject({ need: 560, owned: 400, short: 160, holders: [{ account: 'A', count: 300 }, { account: 'B', count: 100 }] });
    expect(bill[1]).toMatchObject({ short: 1, ids: [] });
});
