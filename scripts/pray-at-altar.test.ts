import { expect, test } from 'bun:test';
import { PRAYER_ALTARS, nearestAltar, parseAltar } from './pray-at-altar';

test('the nearest altar on the same floor wins, and ALTAR names one from the table', () => {
    // The Edgeville bank: the Wilderness chaos temple (145 tiles) is nearer than the Varrock east church (159).
    expect(nearestAltar({ x: 3094, z: 3491, level: 0 }).label).toBe('Wilderness chaos temple');
    expect(nearestAltar({ x: 3240, z: 3210, level: 0 }).label).toBe('Lumbridge church');
    expect(parseAltar('3253,3486')?.label).toBe('Varrock east church');
    expect(parseAltar(undefined)).toBeUndefined();
    expect(() => parseAltar('1,2')).toThrow('not in PRAYER_ALTARS');
    expect(new Set(PRAYER_ALTARS.map(a => a.id))).toEqual(new Set([61, 409, 410, 411]));
});
