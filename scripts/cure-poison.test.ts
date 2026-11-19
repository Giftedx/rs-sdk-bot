import { expect, test } from 'bun:test';
import { chooseAntipoison, dosesOf, nearestBank } from './cure-poison';
import { ITEMS } from './pk';

// Antipoison(3) 175, (2) 177, (1) 179; the four-dose potion 2446; the super antipoison families start at 2448 and 181.
test('the doses of an antipoison follow its family order', () => {
    expect([ITEMS.antipoison.map(dosesOf)]).toEqual([[4, 3, 2, 1, 4, 3, 2, 1]]);
});

test('the pack comes before the bank, and the potion with the fewest doses goes first', () => {
    expect(chooseAntipoison([{ id: 175, count: 1 }], [{ id: 179, count: 1 }])).toEqual({ where: 'pack', id: 175 });
    expect(chooseAntipoison([{ id: 175, count: 1 }, { id: 177, count: 1 }, { id: 2446, count: 1 }], [])).toEqual({ where: 'pack', id: 177 });
    expect(chooseAntipoison([], [{ id: 2446, count: 2 }, { id: 177, count: 1 }])).toEqual({ where: 'bank', id: 177 });
    expect(chooseAntipoison([{ id: 385, count: 20 }], [{ id: 175, count: 0 }])).toBeNull();
    expect(chooseAntipoison([], [])).toBeNull();
});

test('the nearest bank of the account is taken', () => {
    expect(nearestBank({ x: 3197, z: 3436 }).bank).toBe('varrock-west');
    expect(nearestBank({ x: 3092, z: 3497 }).bank).toBe('edgeville');
    expect(nearestBank({ x: 2620, z: 3330 }).bank).toBe('ardougne-north');
});
