import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legCache, type LegCache } from '../src/leg-cache';
import { loadPathfinding } from '../src/pathcache';
import { createWorld, rsPathLength, type Account, type DoorBlock, type PathLength, type Tile, type World } from '../src/world';
import { boxKey, changeBuilder, hintLengths, legKey, withHint } from '../src/world/leg-key';

test('a box key names the changes in the chunks the box touches, in any order, over several tables', () => {
    const one = changeBuilder(), other = changeBuilder();
    one.add(0, 3200, 3200, 2); one.add(0, 3300, 3300, 0, 1, 0, 0); one.add(1, 3200, 3200, 2);
    other.add(1, 3200, 3200, 2); other.add(0, 3300, 3300, 0, 1, 0, 0); other.add(0, 3200, 3200, 2);
    const a = one.build(), b = other.build(), empty = changeBuilder().build();
    expect(boxKey([a], 0, 3190, 3190, 3210, 3210)).toBe(boxKey([b], 0, 3190, 3190, 3210, 3210));
    // The change at 3300,3300 is out of the box; the one at 3200,3200 is in it.
    expect(boxKey([a], 0, 3190, 3190, 3210, 3210)).not.toBe(boxKey([empty], 0, 3190, 3190, 3210, 3210));
    expect(boxKey([a], 0, 3100, 3100, 3150, 3150)).toBe(boxKey([empty], 0, 3100, 3100, 3150, 3150));
    // Another level, another kind or another identity is another change.
    expect(boxKey([a], 1, 3190, 3190, 3210, 3210)).not.toBe(boxKey([empty], 1, 3190, 3190, 3210, 3210));
    const angle = changeBuilder(); angle.add(0, 3300, 3300, 0, 2, 0, 0);
    expect(boxKey([angle.build()], 0, 3290, 3290, 3310, 3310)).not.toBe(boxKey([a], 0, 3290, 3290, 3310, 3310));
    // Two tables sum: doors in one and danger in the other give the key of one table that holds both.
    const doors = changeBuilder(), danger = changeBuilder(), both = changeBuilder();
    doors.add(0, 3300, 3300, 0, 1, 0, 0); danger.add(0, 3200, 3200, 2);
    both.add(0, 3300, 3300, 0, 1, 0, 0); both.add(0, 3200, 3200, 2);
    expect(boxKey([doors.build(), danger.build()], 0, 3000, 3000, 3400, 3400)).toBe(boxKey([both.build()], 0, 3000, 3000, 3400, 3400));
    // A leg key covers the tiles between the ends: a change beside the straight walk counts, one behind its start
    // (as far from the start, but the walk's length again from the goal) does not.
    const from = { x: 3200, z: 3200, level: 0 }, to = { x: 3300, z: 3200, level: 0 };
    const beside = changeBuilder(); beside.add(0, 3250, 3230, 2);
    const behind = changeBuilder(); behind.add(0, 3100, 3200, 2);
    expect(legKey([beside.build()], from, to, 100, 1)).not.toBe(legKey([empty], from, to, 100, 1));
    expect(legKey([behind.build()], from, to, 100, 1)).toBe(legKey([empty], from, to, 100, 1));
    // A longer walk (a detour of 100 tiles) reaches further aside. The test is per 32x32 chunk, so a change counts from
    // the nearest tile of its chunk: (3250,3300) is 200 by tiles, and its chunk 191.
    const aside = changeBuilder(); aside.add(0, 3250, 3300, 2);
    expect(legKey([aside.build()], from, to, 100, 1)).toBe(legKey([empty], from, to, 100, 1));
    expect(legKey([aside.build()], from, to, 200, 1)).not.toBe(legKey([empty], from, to, 200, 1));
    // The key sums the same chunks as a box key when the region covers the box.
    expect(legKey([a], { x: 3200, z: 3200, level: 0 }, { x: 3200, z: 3200, level: 0 }, 400, 1)).toBe(boxKey([a], 0, 2700, 2700, 3700, 3700));
});

test('the hint of a leg keeps its newest two exact lengths', () => {
    let h = withHint(undefined, 12);
    expect(hintLengths(h)).toEqual([12]);
    expect(withHint(h, 12)).toBe(h);
    h = withHint(h, 30);
    expect(hintLengths(h)).toEqual([30, 12]);
    h = withHint(h, 7);
    expect(hintLengths(h)).toEqual([7, 30]);
    expect(hintLengths(withHint(undefined, 0))).toEqual([0]);
});

// Real map: two door policies share a leg far from the doors they differ in, and measure again a leg next to one.
const weak: Account = { skills: { attack: 1, strength: 1, defence: 1, hitpoints: 10, ranged: 1, magic: 1, prayer: 1 }, varps: {}, items: [] };
let dir: string, legs: LegCache, pl: PathLength, w: World, measured = 0;
beforeAll(async () => {
    await loadPathfinding();
    dir = mkdtempSync(join(tmpdir(), 'leg-key-'));
    legs = legCache(join(dir, 'legs.sqlite'), 'leg-key-test');
    const counted: LegCache = { ...legs, set: (k, v) => { if (!k.endsWith('|h')) measured++; legs.set(k, v); } };
    pl = await rsPathLength({ legs: counted });
    w = createWorld({ pathLength: pl });
}, 120_000);
afterAll(() => { legs?.close(); rmSync(dir, { recursive: true, force: true }); });

test('two door policies share the length of a leg far from their doors, and measure a leg next to a door again', async () => {
    const shut = w.blockedDoors(weak).filter(d => d.level === 0), open: DoorBlock[] = [];
    expect(shut.length).toBeGreaterThan(0);
    // A walk on open ground: the policy with every door of a weak account shut has no door within 60 tiles of it.
    const from: Tile = { x: 3200, z: 3260, level: 0 }, to: Tile = { x: 3210, z: 3266, level: 0 };
    expect(shut.every(d => Math.max(Math.abs(d.x - from.x), Math.abs(d.z - from.z)) > 60)).toBe(true);
    const len = pl.withPolicy!(open, () => pl(from, to, open, 0));
    expect(len).not.toBeNull();
    expect(len!).toBeLessThan(20);
    const after = measured;
    expect(pl.withPolicy!(shut, () => pl(from, to, shut, 0))).toBe(len);
    expect(measured).toBe(after);
    // A leg that starts two tiles from a shut door: the door is in its box, so the other policy measures it.
    const door = shut[0]!;
    let a: Tile | undefined, b: Tile | undefined;
    for (let dx = -4; dx <= 4 && !b; dx++) for (let dz = -4; dz <= 4 && !b; dz++) {
        const t = { x: door.x + dx, z: door.z + dz, level: 0 };
        // Both ends in one map area, so the map labels do not refuse the leg before it is measured.
        if (Math.max(Math.abs(dx), Math.abs(dz)) < 2 || !pl.walkable!(t) || pl.areaOf!(t) < 0) continue;
        if (!a) a = t; else if (pl.areaOf!(t) === pl.areaOf!(a)) b = t;
    }
    expect(b).toBeDefined();
    const openLen = pl.withPolicy!(open, () => pl(a!, b!, open, 0));
    const before = measured;
    const shutLen = pl.withPolicy!(shut, () => pl(a!, b!, shut, 0));
    expect(measured).toBe(before + 1);
    // Each result equals the result of a store that holds nothing.
    const fresh = legCache(join(dir, 'fresh.sqlite'), 'leg-key-fresh'), cold = await rsPathLength({ legs: fresh });
    try {
        expect(cold.withPolicy!(open, () => cold(a!, b!, open, 0))).toBe(openLen);
        expect(cold.withPolicy!(shut, () => cold(a!, b!, shut, 0))).toBe(shutLen);
        expect(cold.withPolicy!(shut, () => cold(from, to, shut, 0))).toBe(len);
    } finally { fresh.close(); }
}, 120_000);
