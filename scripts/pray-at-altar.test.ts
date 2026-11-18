import { expect, test } from 'bun:test';
import { PRAYER_ALTARS, SAFE_ALTARS, altarText, inWilderness, nearestAltar, parseAltar } from './pray-at-altar';

test('ALTAR is read from the argument, as the usage line says, else from the environment', () => {
    expect(altarText(['ALTAR=3253,3486'], undefined)).toBe('3253,3486');
    expect(altarText([], '3253,3486')).toBe('3253,3486');
    expect(altarText(['ALTAR=2932,3513'], '3253,3486')).toBe('2932,3513');
    expect(altarText([], undefined)).toBeUndefined();
    expect(altarText([], '')).toBeUndefined();
    expect(parseAltar(altarText(['ALTAR=3253,3486'], undefined))?.label).toBe('Varrock east church');
});

test('the nearest altar on the same floor wins, never one in the Wilderness, and ALTAR names one from the table', () => {
    // The Edgeville bank: the Wilderness chaos temple (145 tiles) is nearer than the Varrock east church (159), and is not taken.
    expect(nearestAltar({ x: 3094, z: 3491, level: 0 }).label).toBe('Varrock east church');
    expect(nearestAltar({ x: 3240, z: 3210, level: 0 }).label).toBe('Lumbridge church');
    // From a tile beside the Wilderness chaos temple itself the default still leaves the Wilderness.
    expect(nearestAltar({ x: 3239, z: 3609, level: 0 }).label).toBe('Varrock east church');
    expect(SAFE_ALTARS.some(inWilderness)).toBe(false);
    expect(PRAYER_ALTARS.filter(inWilderness).map(a => a.label)).toEqual(['Wilderness chaos temple']);
    // An explicit ALTAR may still name the Wilderness altar.
    expect(parseAltar('3239,3608')?.label).toBe('Wilderness chaos temple');
    expect(parseAltar('3253,3486')?.label).toBe('Varrock east church');
    expect(parseAltar(undefined)).toBeUndefined();
    expect(() => parseAltar('1,2')).toThrow('not in PRAYER_ALTARS');
    expect(new Set(PRAYER_ALTARS.map(a => a.id))).toEqual(new Set([61, 409, 410, 411]));
});
