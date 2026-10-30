import { expect, test } from 'bun:test';
import { labelAreas, separated } from '../src/components';

// Two rooms on one zone, split by a wall at x=4; a gap at z=7 joins them when open.
const grid = (gap: boolean) => labelAreas([[0, 0, 0]], () => true,
    (_l, x, z, dx) => !(dx !== 0 && Math.min(x, x + dx) === 3 && !(gap && z === 7)));

test('a wall makes two areas and the leg across it is refused', () => {
    const g = grid(false);
    expect(g.areas).toBe(2);
    expect(g.tiles).toBe(64);
    expect(separated(g, { level: 0, x: 1, z: 1 }, { level: 0, x: 6, z: 1 }, 0)).toBe(true);
    expect(separated(g, { level: 0, x: 1, z: 1 }, { level: 0, x: 2, z: 5 }, 0)).toBe(false);
});

test('a gap joins the areas', () => {
    expect(grid(true).areas).toBe(1);
    expect(separated(grid(true), { level: 0, x: 1, z: 1 }, { level: 0, x: 6, z: 1 }, 0)).toBe(false);
});

test('a target near the map edge or on another level is never refused', () => {
    const g = grid(false);
    expect(separated(g, { level: 0, x: 1, z: 1 }, { level: 0, x: 7, z: 1 }, 1)).toBe(false);
    expect(separated(g, { level: 0, x: 1, z: 1 }, { level: 1, x: 6, z: 1 }, 0)).toBe(false);
});
