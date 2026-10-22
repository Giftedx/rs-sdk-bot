import { test, expect } from 'bun:test';
import { xpForLevel, levelForXp } from '../src/curve';

// Second copy of the formula, written the way vendor/rs-sdk/sdk/test/utils/save-generator.ts:198-204 does it.
function saveGeneratorXp(level: number): number {
    let xp = 0;
    for (let i = 1; i < level; i++) xp += Math.floor(i + 300 * Math.pow(2, i / 10));
    return (Math.floor(xp / 4) * 10) / 10;
}

test('level 2 needs 80 XP on this server (engine formula, 2^(L/10))', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(80);
    expect(levelForXp(79.9)).toBe(1);
    expect(levelForXp(80)).toBe(2);
});

test('every level matches the save generator formula; 99 is 998,458 XP', () => {
    for (let l = 2; l <= 99; l++) expect(xpForLevel(l)).toBe(saveGeneratorXp(l));
    expect(xpForLevel(99)).toBe(998_458);
    expect(levelForXp(xpForLevel(99) + 1e9)).toBe(99);
});
