import { expect, test } from 'bun:test';
import { freshRangedStart } from './ranged-starter';

test('accepts only a fresh ground-floor tutorial actor', () => {
    const tutorial = { worldX: 3094, worldZ: 3106, level: 0 };
    expect(freshRangedStart(tutorial, 1, 0)).toBe(true);
    expect(freshRangedStart({ worldX: 3222, worldZ: 3222, level: 0 }, 1, 0)).toBe(false);
    expect(freshRangedStart({ ...tutorial, level: 1 }, 1, 0)).toBe(false);
    expect(freshRangedStart(tutorial, 1, 1)).toBe(false);
    expect(freshRangedStart(tutorial, 2, 83)).toBe(false);
    expect(freshRangedStart(undefined, 1, 0)).toBe(false);
});
