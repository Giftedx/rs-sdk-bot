import { expect, test } from 'bun:test';
import { nextMeal } from './eat-to-full';

test('the next meal is the cheapest that does not waste half its heal, else the cheapest held', () => {
    const pack = [{ id: 385 }, { id: 333 }];
    // 90 missing: a trout (7) wastes nothing and is cheapest.
    expect(nextMeal(pack, 90)).toBe(333);
    // Only sharks held: a shark, whatever is missing.
    expect(nextMeal([{ id: 385 }], 90)).toBe(385);
    expect(nextMeal([{ id: 385 }], 3)).toBe(385);
    expect(nextMeal([{ id: 1 }], 10)).toBeUndefined();
});

test('AT comes from an argument, else from the environment, and must be a level', async () => {
    const { parseAt } = await import('./eat-to-full');
    expect(parseAt(['AT=50'], undefined)).toBe(50);
    expect(parseAt([], '60')).toBe(60);
    expect(parseAt(['AT=50'], '60')).toBe(50);
    expect(parseAt([], undefined)).toBeUndefined();
    expect(() => parseAt([], '0')).toThrow('not a level');
});
