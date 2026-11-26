import { expect, test } from 'bun:test';
import { engineLocLevel, mapTiles, tileKey } from '../src/jm2';
import { approachTiles, collisionFrom, forceApproachFlags, reaches, smallRegion } from '../src/loc-reach';

const FLOOR = 0x200000, LOC = 0x100, WALL_EAST = 0x8;
// Every zone from 3192 to 3224 on levels 0 and 1 is allocated; a tile with no row there is open.
const zones: [number, number, number][] = [];
for (const level of [0, 1]) for (let x = 3192; x <= 3224; x += 8) for (let z = 3192; z <= 3224; z += 8) zones.push([level, x, z]);
const world = (tiles: [number, number, number, number][], floors?: Set<number>) => collisionFrom({ tiles, zones }, floors);

// The Karamja river log in small: log ends at x 3201 and 3203 on blocked water, an open tile 3202 between them, water
// north and south, banks at x 3200 and 3204.
const river = () => {
    const tiles: [number, number, number, number][] = [];
    for (let x = 3201; x <= 3203; x++) for (const z of [3199, 3201]) tiles.push([0, x, z, FLOOR]);
    tiles.push([0, 3201, 3200, FLOOR], [0, 3203, 3200, FLOOR]);
    return world(tiles);
};

test('a ground decor log end is operated from the open bank tile beside it, not the open tile between the ends', () => {
    const c = river();
    const end = { x: 3201, z: 3200, level: 0, shape: 22, angle: 1, width: 1, length: 1, forceapproach: 0 };
    expect(approachTiles(c, end)).toEqual([{ x: 3200, z: 3200, level: 0 }, { x: 3202, z: 3200, level: 0 }]);
    expect(smallRegion(c, { x: 3202, z: 3200, level: 0 })).toEqual([tileKey(3202, 3200, 0)]);
    expect(smallRegion(c, { x: 3200, z: 3200, level: 0 })).toBeNull();
});

test('a rectangle loc honours forceapproach and a wall between the player and the loc', () => {
    const c = world([[0, 3205, 3205, LOC], [0, 3204, 3205, WALL_EAST]]);
    const loc = { x: 3205, z: 3205, level: 0, shape: 10, angle: 0, width: 1, length: 1, forceapproach: 0 };
    expect(reaches(c, 3204, 3205, loc)).toBe(false);
    expect(approachTiles(c, loc)).toEqual([{ x: 3205, z: 3204, level: 0 }, { x: 3206, z: 3205, level: 0 }, { x: 3205, z: 3206, level: 0 }]);
    expect(approachTiles(c, { ...loc, forceapproach: forceApproachFlags('north') })).toEqual([{ x: 3205, z: 3206, level: 0 }]);
});

test('a straight wall is operated from its own tile and the tile across its face', () => {
    const c = world([]);
    // Angle 1: the wall is on the north edge of the tile.
    const wall = { x: 3210, z: 3210, level: 0, shape: 0, angle: 1, width: 1, length: 1, forceapproach: 0 };
    expect(approachTiles(c, wall)).toEqual([{ x: 3209, z: 3210, level: 0 }, { x: 3210, z: 3210, level: 0 }, { x: 3211, z: 3210, level: 0 }, { x: 3210, z: 3211, level: 0 }]);
    expect(reaches(c, 3210, 3209, wall)).toBe(false);
});

test('an upper-level tile without a map floor is open air, not a start', () => {
    const floors = new Set([tileKey(3216, 3216, 1), tileKey(3217, 3216, 1)]);
    const c = world([], floors);
    const plank = { x: 3216, z: 3216, level: 1, shape: 10, angle: 0, width: 1, length: 1, forceapproach: 0 };
    expect(approachTiles(c, plank)).toEqual([{ x: 3216, z: 3216, level: 1 }, { x: 3217, z: 3216, level: 1 }]);
});

test('mapTiles reads the bridge flag of level 1 and the floors above level 0 on their engine level', () => {
    const text = ['==== MAP ====', '0 1 1: h20 u50', '1 1 1: h6 o42 f2', '1 2 1: h6', '1 3 1: o5', '2 1 1: o7', '==== LOC ====', '1 1 1: 2332 22 1', ''].join('\n');
    const { bridges, floors } = mapTiles('m50_50.jm2', text);
    expect([...bridges]).toEqual([tileKey(3201, 3201, 1)]);
    expect([...floors].sort()).toEqual([tileKey(3201, 3201, 1), tileKey(3203, 3201, 1)].sort());
    expect(engineLocLevel({ x: 3201, z: 3201, level: 1 }, bridges)).toBe(0);
    expect(engineLocLevel({ x: 3201, z: 3201, level: 0 }, bridges)).toBe(-1);
    expect(engineLocLevel({ x: 3203, z: 3201, level: 1 }, bridges)).toBe(1);
});
