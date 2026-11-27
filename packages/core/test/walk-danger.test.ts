import { expect, test } from 'bun:test';
import {
    cornerTiles, huntersNear, isMulti, npcReach, pack, planAroundHarm, routeDanger, routeHarmKeep, routeHarmSet, runTiles, walkExposure, walkProfile,
    walkThreats, walkVerdict, type WalkThreat,
} from '../src/danger';
import { installDoorPolicy } from '../src/world';
import { foodToTake, walkPath, type PathDeps } from '../src/walk';

const pf: any = await import('../../../vendor/rs-sdk/sdk/pathfinding');
const grid: any = await import('../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');

// Combat 50, 67 HP, Defence 1, no food (live: Spitroaster, attacked by a wolf, two ice warriors and the big wolf on the
// White Wolf Mountain pass).
const SPIT = { skills: { attack: 83, defence: 1, strength: 1, hitpoints: 67, ranged: 1, prayer: 47, magic: 31 }, counts: {} };
// Combat 126, 99 HP: above 2 x the wolves (vislevel 25), not above 2 x the big wolf (73).
const STRONG = { skills: { attack: 99, defence: 99, strength: 99, hitpoints: 99, ranged: 99, prayer: 99, magic: 99 }, counts: {} };
const CATHERBY = { x: 2809, z: 3436 }, TAVERLEY = { x: 2895, z: 3445 };

const threat = (o: Partial<WalkThreat>): WalkThreat => ({ id: 1, name: 'T', x: 100, z: 100, level: 0, r: 3, vislevel: 20, tooStrong: true, distant: false, maxHit: 4, attackRoll: 2000, attackRate: 4, ...o });
const line = (x0: number, x1: number, z: number) => Array.from({ length: x1 - x0 + 1 }, (_, i) => ({ x: x0 + i, z }));

test('a hunter with the too-strong rule skips a player above 2 x its vislevel outside the Wilderness only', () => {
    const p = (combat: number) => ({ combat, hp: 50, defence: 1, foodHeal: 0, runTiles: 0 });
    const t = threat({ vislevel: 25 });
    expect(walkExposure(p(50), 0, line(98, 102, 100), { list: [t] }).damage).toBeGreaterThan(0);
    expect(walkExposure(p(51), 0, line(98, 102, 100), { list: [t] }).damage).toBe(0);
    // In the Wilderness (engine Player.isInWilderness) the rule does not apply.
    const wild = threat({ vislevel: 25, x: 3100, z: 3600 });
    expect(walkExposure(p(90), 0, line(3098, 3102, 3600), { list: [wild] }).damage).toBeGreaterThan(0);
    // An aggressive_melee hunter (check_nottoostrong=off) hunts every combat level.
    expect(walkExposure(p(126), 0, line(98, 102, 100), { list: [threat({ tooStrong: false })] }).damage).toBeGreaterThan(0);
});

test('one hunter attacks at a time in a single-combat zone; all of them in a multi-combat zone', () => {
    // White Wolf Mountain zone 0_44_54_0_0 (content maps/multiway.csv) is 2816-2823, 3456-3463.
    expect(isMulti(0, 2820, 3460)).toBe(true);
    expect(isMulti(0, 3222, 3218)).toBe(false);
    const p = { combat: 3, hp: 10, defence: 1, foodHeal: 0, runTiles: 0 };
    const pair = (x: number, z: number) => [threat({ id: 1, x, z }), threat({ id: 2, x, z })];
    const single = walkExposure(p, 0, [{ x: 3222, z: 3218 }], { list: pair(3222, 3218) }).damage;
    const multi = walkExposure(p, 0, [{ x: 2820, z: 3460 }], { list: pair(2820, 3460) }).damage;
    expect(multi).toBeCloseTo(2 * single, 6);
});

test('run energy halves the time spent in a square while it lasts', () => {
    expect(runTiles(0)).toBe(0);
    expect(runTiles(100)).toBe(298); // 10000 / 67 running ticks, 2 tiles each
    const t = [threat({ x: 100, z: 100, r: 10 })], tiles = line(90, 110, 100);
    const walk = walkExposure({ combat: 3, hp: 10, defence: 1, foodHeal: 0, runTiles: 0 }, 0, tiles, { list: t }).damage;
    const run = walkExposure({ combat: 3, hp: 10, defence: 1, foodHeal: 0, runTiles: 100 }, 0, tiles, { list: t }).damage;
    expect(run).toBeCloseTo(walk / 2, 6);
});

test('the walk verdict: clear above the retreat line, eat with pack food, refuse with the heal short', () => {
    const e = { tiles: 10, damage: 8, maxHit: 4, zones: [] };
    // need = ceil(8 x 1.25 + retreatLine(4) = 4 + 2) = 16
    expect(walkVerdict({ combat: 3, hp: 16, defence: 1, foodHeal: 0, runTiles: 0 }, e)).toEqual({ verdict: 'clear', need: 16, needHeal: 0 });
    expect(walkVerdict({ combat: 3, hp: 10, defence: 1, foodHeal: 6, runTiles: 0 }, e).verdict).toBe('eat');
    expect(walkVerdict({ combat: 3, hp: 10, defence: 1, foodHeal: 2, runTiles: 0 }, e)).toEqual({ verdict: 'refuse', need: 16, needHeal: 4 });
});

test('Catherby to Taverley: a combat-50, 67 HP account with no food must carry food over White Wolf Mountain; a strong one keeps the pass', () => {
    pf.initPathfinding();
    const reach = npcReach(grid, pf.getDoorAt);
    const open = pf.findLongPath(0, CATHERBY.x, CATHERBY.z, TAVERLEY.x, TAVERLEY.z, 500);
    const tiles = cornerTiles(CATHERBY, open);
    expect(tiles.at(-1)).toEqual(TAVERLEY);

    const spit = walkProfile(SPIT, { energy: 100 }), e = walkExposure(spit, 0, tiles, { reach });
    expect(e.zones.some(z => z.name === 'Big Wolf')).toBe(true);
    expect(e.zones.some(z => z.name === 'Wolf')).toBe(true);
    expect(walkVerdict(spit, e).verdict).toBe('refuse');
    // No way round on foot inside the bound: the walk keeps the pass, and no route search found a safe one.
    const planned = planAroundHarm(grid, spit, 0, CATHERBY, TAVERLEY, 32, () => pf.findLongPath(0, CATHERBY.x, CATHERBY.z, TAVERLEY.x, TAVERLEY.z, 500), { reach });
    expect(cornerTiles(CATHERBY, planned).length).toBe(tiles.length);
    const decision = routeDanger(spit, { cost: tiles.length, exposure: e }, null);
    expect(decision.action).toBe('refuse');
    // With the food the verdict asks for (lobsters heal 12), the same walk eats on the way.
    const fed = walkProfile({ ...SPIT, counts: { lobster: Math.ceil(decision.verdict.needHeal / 12) } }, { energy: 100 });
    expect(routeDanger(fed, { cost: tiles.length, exposure: walkExposure(fed, 0, tiles, { reach }) }, null).action).toBe('eat');
    // A safe route inside the bound is taken.
    const safe = { cost: tiles.length + 100, exposure: { tiles: 0, damage: 0, maxHit: 0, zones: [] } };
    expect(routeDanger(spit, { cost: tiles.length, exposure: e }, safe).action).toBe('detour');

    // Combat 126 is above 2 x the wolves' vislevel: only the big wolf hunts it, and the walk stays on the short pass.
    const strong = walkProfile(STRONG, { energy: 100 }), se = walkExposure(strong, 0, tiles, { reach });
    expect(se.zones.every(z => z.name === 'Big Wolf')).toBe(true);
    expect(walkVerdict(strong, se).verdict).toBe('clear');
    const kept = planAroundHarm(grid, strong, 0, CATHERBY, TAVERLEY, 32, () => pf.findLongPath(0, CATHERBY.x, CATHERBY.z, TAVERLEY.x, TAVERLEY.z, 500), { reach });
    expect(cornerTiles(CATHERBY, kept).length).toBe(tiles.length);
    expect(routeDanger(strong, { cost: tiles.length, exposure: se }, { cost: tiles.length + 104, exposure: { tiles: 0, damage: 0, maxHit: 0, zones: [] } }).action).toBe('clear');
}, 120_000);

test('a route search that avoids harm closes the White Wolf Mountain squares and keeps the start square open', () => {
    const closed = new Set(routeHarmSet(50));
    expect(closed.has(pack(0, 2840, 3497))).toBe(true); // the big wolf's spawn
    expect(new Set(routeHarmSet(126)).has(pack(0, 2836, 3495))).toBe(true); // the big wolf's square holds this wolf spawn
    const keep = routeHarmKeep(50, [{ x: 2840, z: 3497, level: 0 }, { x: 2895, z: 3445, level: 0 }]);
    expect(keep.tiles.some(t => t.x === 2840 && t.z === 3497)).toBe(true);
    expect(keep.key).toContain('2840,3497');
    expect(huntersNear(126, 0, { minX: 3200, maxX: 3240, minZ: 3200, maxZ: 3240 })).toBe(false); // Lumbridge
});

test('a walk past the Falador-Port Sarim highwaymen goes round them through the SDK findPath', async () => {
    pf.initPathfinding();
    const from = { x: 2965, z: 3380 }, to = { x: 3012, z: 3210 };
    const state = {
        player: { worldX: from.x, worldZ: from.z, level: 0, runEnergy: 100, runWeight: 0 },
        skills: [{ name: 'Hitpoints', level: 10, baseLevel: 10 }, { name: 'Attack', level: 1 }, { name: 'Strength', level: 1 }, { name: 'Defence', level: 1 }],
        inventory: [], equipment: [], nearbyLocs: [], nearbyNpcs: [],
    };
    const raw: any = { getState: () => state, findPath: (x: number, z: number) => pf.findLongPath(0, from.x, from.z, x, z, 500) };
    const plain = cornerTiles(from, raw.findPath(to.x, to.z));
    const reach = npcReach(grid, pf.getDoorAt), p = walkProfile({ skills: { hitpoints: 10 }, counts: {} }, { energy: 100 });
    expect(walkExposure(p, 0, plain, { reach }).zones.some(z => z.name === 'Highwayman')).toBe(true);
    await installDoorPolicy(raw);
    const round = cornerTiles(from, raw.findPath(to.x, to.z));
    expect(round.at(-1)).toEqual(to);
    expect(walkExposure(p, 0, round, { reach }).damage).toBeLessThan(walkExposure(p, 0, plain, { reach }).damage);
    expect(round.length).toBeLessThanOrEqual(plain.length + 20);
}, 120_000);

test('walkPath does not start a walk that the harm check refuses, and starts one that begins in reach', async () => {
    let clicks = 0;
    const deps = (start: boolean): PathDeps => ({
        pos: () => ({ x: 3000, z: 3200, level: 0 }),
        onTick: () => () => {},
        walk: () => { clicks++; },
        interactLoc: () => {},
        locs: () => [],
        plan: (_l, _f, to) => [{ x: to.x, z: to.z }],
        danger: () => ({ verdict: 'refuse', start, summary: { zone: 'Big Wolf 2840,3497', damage: 40, need: 60, needHeal: 20 } }),
    });
    const r = await walkPath(deps(false), [{ x: 3030, z: 3200, tol: 1 }]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('walk danger: Big Wolf 2840,3497 needs 20 heal');
    expect(clicks).toBe(0);
    const ac = new AbortController();
    const p = walkPath(deps(true), [{ x: 3030, z: 3200, tol: 1 }], { signal: ac.signal, maxTicks: 1 });
    ac.abort();
    const going = await p;
    expect(going.detail ?? '').not.toContain('walk danger');
});

test('food staging takes the highest heal first within the free slots and 20 pieces', () => {
    const heal = (n: string) => ({ lobster: 12, trout: 7, shrimps: 3 } as Record<string, number>)[n];
    expect(foodToTake({ coins: 0, items: { trout: 50, lobster: 3, logs: 9 } }, 40, 28, heal)).toEqual({ lobster: 3, trout: 1 });
    expect(foodToTake({ coins: 0, items: { shrimps: 100 } }, 60, 28, heal)).toEqual({ shrimps: 20 });
    expect(foodToTake({ coins: 0, items: { shrimps: 100 } }, 61, 28, heal)).toBeNull();
    expect(foodToTake({ coins: 0, items: { lobster: 10 } }, 60, 2, heal)).toBeNull();
    expect(walkThreats().length).toBeGreaterThan(0);
});
