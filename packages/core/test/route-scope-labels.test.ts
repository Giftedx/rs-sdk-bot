import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legCache, type LegCache } from '../src/leg-cache';
import { loadPathfinding } from '../src/pathcache';
import { createWorld, ROUTE_BUDGET_MS, rsPathLength, type Account, type PathLength, type Tile, type World } from '../src/world';

// A 10 HP account: the danger rule closes White Wolf Mountain, so Burthorpe and Ardougne share one map area
// (components.ts) but no walk joins them.
const weak: Account = { skills: { attack: 1, strength: 1, defence: 1, hitpoints: 10, ranged: 1, magic: 1, prayer: 1 }, varps: {}, items: [] };
const BURTHORPE: Tile = { x: 2821, z: 3552, level: 0 }, ARDOUGNE: Tile = { x: 2619, z: 3332, level: 0 };
let dir: string, legs: LegCache, pl: PathLength, w: World, measured = 0;
beforeAll(async () => {
    await loadPathfinding();
    dir = mkdtempSync(join(tmpdir(), 'scope-labels-'));
    // An empty store: every leg is measured, so the nulls that label the scope happen in this run. Each measured leg
    // is stored once (and a length that ends on its goal names itself in the leg's `|h` row); a leg the labels refuse
    // is not measured and not stored.
    legs = legCache(join(dir, 'legs.sqlite'), 'scope-label-test');
    const counted: LegCache = { ...legs, set: (k, v) => { if (!k.endsWith('|h')) measured++; legs.set(k, v); } };
    pl = await rsPathLength({ legs: counted });
    w = createWorld({ pathLength: pl });
}, 120_000);
afterAll(() => { legs?.close(); rmSync(dir, { recursive: true, force: true }); });

test('after 64 measured nulls a scope is labelled, and legs between its areas are null without a flood', () => {
    const blocked = w.blockedDoors(weak);
    // Ardougne tiles in the map area of the start: each leg to one passes the map label check and is measured.
    const area = pl.areaOf!(BURTHORPE), ardougne: Tile[] = [];
    expect(area).toBeGreaterThanOrEqual(0); // the map labels, not labels a test attached (components.test.ts)
    for (let x = 2600; x < 2640 && ardougne.length < 96; x++) for (let z = 3318; z < 3340 && ardougne.length < 96; z += 2) {
        const t = { x, z, level: 0 };
        if (pl.walkable!(t) && pl.areaOf!(t) === area) ardougne.push(t);
    }
    expect(ardougne.length).toBe(96);
    pl.withDanger!(weak, BURTHORPE, ARDOUGNE, () => pl.withPolicy!(blocked, () => {
        const home = pl(BURTHORPE, { x: 2816, z: 3552, level: 0 }, blocked, 1);
        expect(home).not.toBeNull();
        // The first 64 legs each flood the grid before they measure null; the 64th labels the scope.
        for (const t of ardougne.slice(0, 64)) expect(pl(BURTHORPE, t, blocked, 1)).toBeNull();
        expect(measured).toBe(65);
        // The scope labels refuse the next 32 legs: none is measured (without the labels, each floods 5 to 8 ms).
        for (const t of ardougne.slice(64)) expect(pl(BURTHORPE, t, blocked, 1)).toBeNull();
        expect(measured).toBe(65);
        // A leg inside one area of the scope is still measured.
        expect(pl(BURTHORPE, { x: 2816, z: 3552, level: 0 }, blocked, 1)).toBe(home);
    }));
}, 120_000);

// With 3 coins the boats are shut too, so no route exists. The lazy search proves that only after it has measured every
// walk on the Lumbridge side: 48 s with this empty store, past the 45 s route budget (Abracadickra's shop walk logged
// WALK_NO_ROUTE after 45866 ms). The area check (search.ts goalReachable) ends it after its first second.
test('a 10 HP account with 3 coins has no route from Lumbridge to Catherby, and the search says so well inside its budget', () => {
    const poor: Account = { ...weak, coins: 3, counts: { coins: 3 }, items: ['coins'] };
    const t0 = performance.now();
    const r = w.route({ x: 3221, z: 3220, level: 0 }, { x: 2809, z: 3441, level: 0 }, poor, { deadline: performance.now() + ROUTE_BUDGET_MS });
    const ms = performance.now() - t0;
    console.log(`lumbridge->catherby, 10 HP, 3 coins: ${Math.round(ms)} ms`, r.ok ? `cost ${r.cost}` : r.reason);
    expect(r).toEqual({ ok: false, reason: 'no_route' });
    expect(ms).toBeLessThan(15_000);
}, 120_000);

// The danger rule closes the ground of the account's deadly hunters over the whole map (danger/guard.ts guardRoute), not
// over a box round the route, so a route between two points plans as one route whenever its halves are safe routes.
// The essence mine exit portal lands the account by Cromperty in East Ardougne, west of White Wolf Mountain.
test('a 10 HP account\'s route out of the essence mine plans as one route when its two halves are safe routes', () => {
    const mine: Tile = { x: 2924, z: 4848, level: 0 }, cromperty: Tile = { x: 2684, z: 3322, level: 0 }, catherby: Tile = { x: 2809, z: 3441, level: 0 };
    const deadline = () => ({ deadline: performance.now() + ROUTE_BUDGET_MS });
    const first = w.route(mine, cromperty, weak, deadline()), second = w.route(cromperty, catherby, weak, deadline());
    const whole = w.route(mine, catherby, weak, deadline());
    console.log('mine->cromperty', first.ok ? first.cost : first.reason, 'cromperty->catherby', second.ok ? second.cost : second.reason, 'mine->catherby', whole.ok ? whole.cost : whole.reason);
    expect(first.ok && second.ok).toBe(true);
    expect(whole.ok).toBe(true);
    if (first.ok && second.ok && whole.ok) expect(whole.cost).toBeLessThanOrEqual(first.cost + second.cost);
}, 180_000);
