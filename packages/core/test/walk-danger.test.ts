import { expect, test } from 'bun:test';
import {
    cornerTiles, huntersNear, isMulti, npcReach, pack, planAroundHarm, routeDanger, routeHarmKeep, routeHarmSet, runTiles, walkExposure, walkProfile,
    foodHealOf, hunts, loadHunters, walkFloorLine, walkThreats, walkVerdict, type WalkThreat,
} from '../src/danger';
import { floorLine } from '../src/hp-floor';
import { npcHunters } from '../../knowledge/src/npc-hunters';
import { installDoorPolicy } from '../src/world';
import { eatBeforeWalk, foodToTake, routeHarm, walkPath, type PathDeps } from '../src/walk';

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
    expect(walkVerdict({ combat: 3, hp: 16, defence: 1, foodHeal: 0, runTiles: 0 }, e)).toEqual({ verdict: 'clear', need: 16, needHeal: 0, eatFirst: 0 });
    expect(walkVerdict({ combat: 3, hp: 10, defence: 1, foodHeal: 6, runTiles: 0 }, e)).toEqual({ verdict: 'eat', need: 16, needHeal: 0, eatFirst: 0 });
    expect(walkVerdict({ combat: 3, hp: 10, defence: 1, foodHeal: 2, runTiles: 0 }, e)).toEqual({ verdict: 'refuse', need: 16, needHeal: 4, eatFirst: 0 });
});

test('at or under the floor line the walk eats first, and a refusal asks for the food that the start line and the need take together', () => {
    const e = { tiles: 10, damage: 8, maxHit: 4, zones: [] }; // need 16, floor line 2 x 4 = 8
    // 8 HP (on the line) with 60 heal of food: eat 1 heal first to start above the line, then walk.
    expect(walkVerdict({ combat: 3, hp: 8, maxHp: 30, defence: 1, foodHeal: 60, runTiles: 0 }, e)).toEqual({ verdict: 'eat', need: 16, needHeal: 0, eatFirst: 1 });
    // 3 HP, no food: the walk needs 16 - 3 = 13 heal; staging that much makes the next verdict `eat`.
    const short = walkVerdict({ combat: 3, hp: 3, maxHp: 30, defence: 1, foodHeal: 0, runTiles: 0 }, e);
    expect(short).toEqual({ verdict: 'refuse', need: 16, needHeal: 13, eatFirst: 6 });
    expect(walkVerdict({ combat: 3, hp: 3, maxHp: 30, defence: 1, foodHeal: short.needHeal, runTiles: 0 }, e).verdict).toBe('eat');
    // Damage 0.9 needs ceil(1.125 + 6) = 8, which 8 HP holds, but 8 is on the floor line: eat first, not clear.
    const light = { tiles: 2, damage: 0.9, maxHit: 4, zones: [] };
    expect(walkVerdict({ combat: 3, hp: 8, maxHp: 30, defence: 1, foodHeal: 12, runTiles: 0 }, light)).toEqual({ verdict: 'eat', need: 8, needHeal: 0, eatFirst: 1 });
    expect(walkVerdict({ combat: 3, hp: 9, maxHp: 30, defence: 1, foodHeal: 0, runTiles: 0 }, light).verdict).toBe('clear');
    // Two 4-hits at once in a multi-combat zone: the line is 16, over 12 base Hitpoints. No food lets it start above.
    expect(walkVerdict({ combat: 3, hp: 10, maxHp: 12, defence: 1, foodHeal: 60, runTiles: 0 }, { ...e, burst: 8 })).toEqual({ verdict: 'refuse', need: 16, needHeal: 0, eatFirst: 0 });
});

test('walkPath eats its pack food before a walk that must start above the floor line, and names no food short without an eater', async () => {
    let hp = 8, eats = 0, clicks = 0;
    const listeners = new Set<() => void>();
    const deps: PathDeps = {
        pos: () => ({ x: 3000, z: 3200, level: 0 }),
        onTick: cb => { listeners.add(cb); return () => listeners.delete(cb); },
        walk: () => { clicks++; },
        interactLoc: () => {},
        locs: () => [],
        plan: (_l, _f, to) => [{ x: to.x, z: to.z }],
        danger: () => hp <= 8
            ? { verdict: 'eat', start: false, summary: { zone: 'Wolf 1,1', damage: 0.9, need: 8, needHeal: 0, eatFirst: 9 - hp, floorLine: 8 } }
            : { verdict: 'clear', start: false, summary: { zone: 'Wolf 1,1', damage: 0.9, need: 8, needHeal: 0, eatFirst: 0, floorLine: 8 } },
        eat: async () => { eats++; hp += 3; return { success: true }; },
    };
    const timer = setInterval(() => { for (const l of [...listeners]) l(); }, 1);
    const r = await walkPath(deps, [{ x: 3030, z: 3200, tol: 1 }], { maxTicks: 2 });
    clearInterval(timer);
    expect(eats).toBe(1);
    expect(r.detail ?? '').not.toContain('walk danger');
    // Without an eater the walk is refused, and the text names no food short.
    hp = 8; clicks = 0;
    const { eat: _eat, ...noEater } = deps;
    const refused = await walkPath(noEater, [{ x: 3030, z: 3200, tol: 1 }]);
    expect(refused.detail).toContain('must eat above 8 Hitpoints before the walk');
    expect(refused.detail).not.toMatch(/needs \d+ heal/);
    expect(clicks).toBe(0);
});

test('eatBeforeWalk eats until the Hitpoints are above the line, and fails when the food runs out', async () => {
    const fake = (hp: number, pieces: number) => {
        let tick = 0;
        const listeners = new Set<() => void>();
        const s: any = {
            tick: () => tick,
            onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
            sdk: { getState: () => ({ tick, player: { hp } }), onStateUpdate: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); } },
            bot: { walkTo: async () => ({}), interactLoc: async () => ({}), eatFood: async () => pieces-- > 0 ? (hp += 4, { success: true }) : { success: false } },
        };
        const timer = setInterval(() => { tick++; for (const l of [...listeners]) l(); }, 1);
        return { s, stop: () => clearInterval(timer), hp: () => hp };
    };
    const a = fake(3, 5);
    expect(await eatBeforeWalk(a.s, 8)).toBe(true);
    expect(a.hp()).toBe(11);
    a.stop();
    const b = fake(3, 1);
    expect(await eatBeforeWalk(b.s, 8)).toBe(false);
    b.stop();
});

test('the hard-closure catalog reads the npc-hunters table: kinds outside the three old hunt modes are in it', () => {
    const names = new Set(loadHunters().map(h => h.name));
    for (const n of ['Jungle spider', 'King black dragon', 'Monkey Zombie', 'Rocks']) expect([n, names.has(n)]).toEqual([n, true]);
    const ids = new Set(loadHunters().map(h => h.id));
    for (const id of npcHunters().keys()) if (walkThreats().some(t => t.id === id)) expect(ids.has(id)).toBe(true);
    // The too-strong flag of the table decides the 2 x vislevel rule.
    const kbd = loadHunters().find(h => h.name === 'King black dragon')!;
    expect(kbd.tooStrong).toBe(npcHunters().get(kbd.id!)!.tooStrong);
    const jail = loadHunters().find(h => h.name === 'Jail guard')!;
    expect(jail.tooStrong).toBe(false);
    expect(hunts(jail, 126)).toBe(true);
});

test('the walk floor line is the HP floor line of the burst, and only food the HP floor eats counts', () => {
    const e = { tiles: 1, damage: 1, maxHit: 3, burst: 9, zones: [] };
    expect(walkFloorLine(e)).toBe(floorLine(9));
    expect(walkFloorLine({ ...e, burst: undefined })).toBe(floorLine(3));
    expect(foodHealOf('lobster')).toBe(12);
    expect(foodHealOf('cake')).toBe(12); // three bites of 4
    expect(foodHealOf('logs')).toBeUndefined();
    expect(walkProfile({ skills: { hitpoints: 10 }, counts: { lobster: 2, logs: 5 } }).foodHeal).toBe(24);
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
    // With a pack of lobsters (heal 12) that covers the need, and 67 HP above the HP floor's line of the pass's
    // multi-combat burst, the walk eats on the way: the floor eats at that line with no script attack.
    const fed = walkProfile({ ...SPIT, counts: { lobster: 20 } }, { energy: 100 }), fe = walkExposure(fed, 0, tiles, { reach });
    expect(walkFloorLine(fe)).toBeLessThan(67);
    expect(routeDanger(fed, { cost: tiles.length, exposure: fe }, null).action).toBe('eat');
    // At 60 HP the same burst can land under the line before the floor eats: refused with the same food.
    expect(routeDanger({ ...fed, hp: 60 }, { cost: tiles.length, exposure: fe }, null).action).toBe('refuse');
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

test('Karamja: a 10 HP walker past the scorpions is refused with no food and eats with shrimps', () => {
    pf.initPathfinding();
    const reach = npcReach(grid, pf.getDoorAt), from = { x: 2954, z: 3147 }, to = { x: 2855, z: 3168 };
    const tiles = cornerTiles(from, pf.findLongPath(0, from.x, from.z, to.x, to.z, 500));
    const bare = walkProfile({ skills: { hitpoints: 10 }, counts: {} }), e = walkExposure(bare, 0, tiles, { reach });
    expect(e.zones.some(z => z.name === 'Scorpion')).toBe(true);
    expect(walkVerdict(bare, e).verdict).toBe('refuse');
    const fed = walkProfile({ skills: { hitpoints: 10 }, counts: { shrimp: 5 } });
    expect(walkFloorLine(e)).toBeLessThan(10);
    expect(walkVerdict(fed, walkExposure(fed, 0, tiles, { reach })).verdict).toBe('eat');
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
    expect(r.detail).toContain('walk danger from 3000,3200,0: route danger to 3030,3200,0: Big Wolf 2840,3497 needs 20 heal');
    expect(clicks).toBe(0);
    const ac = new AbortController();
    const p = walkPath(deps(true), [{ x: 3030, z: 3200, tol: 1 }], { signal: ac.signal, maxTicks: 1 });
    ac.abort();
    const going = await p;
    expect(going.detail ?? '').not.toContain('walk danger');
});

test('Ardougne north bank to market: routeHarm prices the planAroundHarm detour around the Guard dogs instead of refusing with needs 0 heal', async () => {
    pf.initPathfinding();
    const reach = npcReach(grid, pf.getDoorAt);
    const from = { x: 2618, z: 3332, level: 0 }, to = { x: 2655, z: 3283, level: 0 };
    const acct = { skills: { attack: 1, strength: 1, defence: 1, hitpoints: 10 }, varps: {}, items: ['trout'], counts: { trout: 2 }, coins: 0 };
    const p = walkProfile(acct, { energy: 100 });
    // The bare open path walks past the Guard dogs (max hit 5, floor line 10 >= 10 HP -> refuse with needHeal 0).
    const open = pf.findLongPath(0, from.x, from.z, to.x, to.z, 500);
    const bareExp = walkExposure(p, 0, cornerTiles(from, open), { reach });
    expect(bareExp.zones.some(z => z.name === 'Guard dog')).toBe(true);
    expect(walkVerdict(p, bareExp)).toMatchObject({ verdict: 'refuse', needHeal: 0 });
    // routeHarm measures the detoured walk path (planAroundHarm), which avoids the Guard dogs with 0 damage.
    const prevService = process.env.ROUTE_SERVICE;
    process.env.ROUTE_SERVICE = '0';
    try {
        const plan = { cost: 101, legs: [{ kind: 'walk' as const, to }] };
        const fakeWalker: any = { sdk: { getState: () => ({ player: { runEnergy: 100, runWeight: 0, maxHp: 10 } }) } };
        const res = await routeHarm(fakeWalker, from, to, acct, plan, async () => plan);
        expect(res.action).toBe('clear');
    } finally {
        if (prevService === undefined) delete process.env.ROUTE_SERVICE;
        else process.env.ROUTE_SERVICE = prevService;
    }
}, 120_000);

test('food staging takes the highest heal first within the free slots and 20 pieces', () => {
    const heal = (n: string) => ({ lobster: 12, trout: 7, shrimps: 3 } as Record<string, number>)[n];
    expect(foodToTake({ coins: 0, items: { trout: 50, lobster: 3, logs: 9 } }, 40, 28, heal)).toEqual({ lobster: 3, trout: 1 });
    expect(foodToTake({ coins: 0, items: { shrimps: 100 } }, 60, 28, heal)).toEqual({ shrimps: 20 });
    expect(foodToTake({ coins: 0, items: { shrimps: 100 } }, 61, 28, heal)).toBeNull();
    expect(foodToTake({ coins: 0, items: { lobster: 10 } }, 60, 2, heal)).toBeNull();
    expect(walkThreats().length).toBeGreaterThan(0);
});
