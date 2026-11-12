import { beforeAll, expect, test } from 'bun:test';
import { AIR, BODY, CAST_RANGE, EARTH, MIND, QUIET_STOP, SPLASH_SPELLS, SPLASH_TILE, WATER, castReaches, splashBatchDone, splashPlan, splashSpell } from './splash-train';
import { xpForLevel } from '../packages/planner/src/curve';
import { SPLASH_KIT, SPLASH_TO } from '../packages/planner/src/autopilot';
import { loadPathfinding } from '../packages/core/src/pathcache';
import { initPathfinding } from '../vendor/rs-sdk/sdk/pathfinding';
import * as rsmod from '../vendor/rs-sdk/server/vendor/rsmod-pathfinder';
import { CollisionType } from '../vendor/rs-sdk/server/vendor/rsmod-pathfinder';

// initPathfinding() alone takes about 14 s for each process (packages/core/src/pathcache.ts), which is more than the
// time limit of a test. The snapshot loader makes the same grid first, so the call in the test returns at once.
beforeAll(async () => { await loadPathfinding(); }, 120_000);

test('a level casts the best stat spell it has, and Wind Strike under Confuse', () => {
    expect(splashSpell(1).component).toBe('magic:wind_strike');
    expect(splashSpell(3).component).toBe('magic:confuse');
    expect(splashSpell(11).component).toBe('magic:weaken');
    expect(splashSpell(18).component).toBe('magic:weaken');
    expect(splashSpell(19).component).toBe('magic:curse');
    expect(splashSpell(99).component).toBe('magic:curse');
    // The table is best first, each spell at its level of this server's spell rows.
    expect(SPLASH_SPELLS.map(s => [s.level, s.xp])).toEqual([[19, 725], [11, 525], [3, 325], [1, 137]]);
});

test('the plan counts casts spell by spell up this server\'s level curve, and their runes', () => {
    // Magic 21 to the Magic Guild's level: curses only.
    expect(splashPlan(xpForLevel(21), 66)).toEqual({ casts: 135, runes: { [BODY]: 135, [WATER]: 270, [EARTH]: 405, [MIND]: 0, [AIR]: 0 } });
    // From Magic 1: two strikes to Confuse, then Confuse, Weaken and Curse.
    const fresh = splashPlan(0, 66);
    expect(fresh.casts).toBe(144);
    expect(fresh.runes).toEqual({ [BODY]: 142, [WATER]: 290, [EARTH]: 420, [MIND]: 2, [AIR]: 2 });
    // Experience already past a level's start counts: one curse short of the target needs one cast.
    expect(splashPlan(xpForLevel(66) - 725, 66).casts).toBe(1);
    expect(splashPlan(xpForLevel(66), 66)).toEqual({ casts: 0, runes: { [BODY]: 0, [WATER]: 0, [EARTH]: 0, [MIND]: 0, [AIR]: 0 } });
});

test('the planner\'s kit covers the plan from every level under the target', () => {
    for (let from = 1; from < SPLASH_TO; from++) for (const past of [0, 100, 300]) {
        const { runes } = splashPlan(xpForLevel(from) + past, SPLASH_TO);
        expect(runes[BODY]!).toBeLessThanOrEqual(SPLASH_KIT['body rune']);
        expect(runes[WATER]!).toBeLessThanOrEqual(SPLASH_KIT['water rune']);
        expect(runes[EARTH]!).toBeLessThanOrEqual(SPLASH_KIT['earth rune']);
        expect(runes[MIND]!).toBeLessThanOrEqual(2);
    }
});

test('no cow can stand beside the fence tile, and a cast from it reaches the field', () => {
    initPathfinding();
    // Every tile a cow (2 tiles wide) reaches from a spawn inside the field by the engine's step rule.
    const key = (x: number, z: number) => `${x},${z}`, seen = new Set([key(2660, 3344)]), queue: [number, number][] = [[2660, 3344]];
    while (queue.length) {
        const [x, z] = queue.shift()!;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
            const nx = x + dx, nz = z + dz;
            if (nx < 2640 || nx > 2690 || nz < 3325 || nz > 3370 || seen.has(key(nx, nz)) || !rsmod.canTravel(0, x, z, dx, dz, 2, 0, CollisionType.NORMAL)) continue;
            seen.add(key(nx, nz)); queue.push([nx, nz]);
        }
    }
    const cows = [...seen].map(k => k.split(',').map(Number) as [number, number]);
    expect(cows.length).toBeGreaterThan(300);
    // The nearest a cow's footprint comes to the tile is two tiles: the fence row lies between.
    const gap = (sw: [number, number]) => Math.max(sw[0] - SPLASH_TILE.x, SPLASH_TILE.x - (sw[0] + 1), sw[1] - SPLASH_TILE.z, SPLASH_TILE.z - (sw[1] + 1), 0);
    expect(Math.min(...cows.map(gap))).toBe(2);
    // Six of the ten cow spawns of the field are in reach and in sight from the tile.
    const spawns: [number, number][] = [[2657, 3341], [2658, 3351], [2660, 3344], [2664, 3341], [2664, 3348], [2664, 3352], [2666, 3344], [2670, 3348], [2671, 3342], [2672, 3354]];
    expect(spawns.filter(([x, z]) => castReaches(SPLASH_TILE, { x, z })).length).toBeGreaterThanOrEqual(6);
    expect(castReaches(SPLASH_TILE, { x: 2664, z: 3341 })).toBe(true);
    // Out of range.
    expect(castReaches(SPLASH_TILE, { x: 2664, z: SPLASH_TILE.z + CAST_RANGE + 1 })).toBe(false);
});

test('a run that gained a level and then ran out of runes, ticks or cows is a finished batch, not a failed band', () => {
    // Live: two runs gained 37 and 15 levels and ended `RESULT fail ... stop=no cast in 300 ticks`.
    for (const stop of ['supplies', 'cap', QUIET_STOP]) {
        expect(splashBatchDone(stop, 1)).toBe(true);
        expect(splashBatchDone(stop, 0)).toBe(false);
    }
    expect(QUIET_STOP).toBe('no cast in 300 ticks');
    // A lost hitpoint, a stop file or a dropped session is never a finished batch.
    for (const stop of ['lost hitpoints at the fence (98 of 99)', 'stopped', 'session ended', '']) expect(splashBatchDone(stop, 5)).toBe(false);
});

