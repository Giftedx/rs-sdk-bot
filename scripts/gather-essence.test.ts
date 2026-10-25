import { test, expect } from 'bun:test';
import { isEssence, dist } from './gather-essence';

test('isEssence identifies Rune essence and Pure essence IDs', () => {
    expect(isEssence(1436)).toBe(true); // Rune essence
    expect(isEssence(7936)).toBe(true); // Pure essence
    expect(isEssence(995)).toBe(false);  // Coins
    expect(isEssence(1265)).toBe(false); // Bronze pickaxe
});

test('dist calculates Chebyshev tile distance accurately', () => {
    expect(dist({ x: 3253, z: 3420 }, { worldX: 3253, worldZ: 3402 })).toBe(18);
    expect(dist({ x: 2891, z: 4847 }, { x: 2885, z: 4850 })).toBe(6);
});
