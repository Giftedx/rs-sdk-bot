import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legCache, type LegCache } from '../src/leg-cache';
import { loadPathfinding } from '../src/pathcache';
import { rsPathLength, type PathLength, type Tile } from '../src/world';

// Two path measures with empty leg stores: one measures with its flood (pathfinding.ts floodLength), one with
// findLongPath only (ROUTE_FLOOD=0 while it measures).
let dir: string, stores: LegCache[] = [], flood: PathLength, plain: PathLength;
const LUMBRIDGE: Tile = { x: 3222, z: 3218, level: 0 };
beforeAll(async () => {
    await loadPathfinding();
    dir = mkdtempSync(join(tmpdir(), 'route-flood-'));
    stores = ['a', 'b'].map(n => legCache(join(dir, `${n}.sqlite`), `route-flood-test-${n}`));
    flood = await rsPathLength({ legs: stores[0] });
    plain = await rsPathLength({ legs: stores[1] });
}, 120_000);
afterAll(() => { for (const s of stores) s.close(); rmSync(dir, { recursive: true, force: true }); });

test('walks from one start read from its flood have the findLongPath lengths and cost less', () => {
    // Walkable tiles 60 to 300 tiles from Lumbridge, in the same map area: the route graph tiles of this test.
    const targets: Tile[] = [], area = flood.areaOf!(LUMBRIDGE);
    for (let x = LUMBRIDGE.x - 300; x <= LUMBRIDGE.x + 300 && targets.length < 120; x += 23) for (let z = LUMBRIDGE.z - 300; z <= LUMBRIDGE.z + 300 && targets.length < 120; z += 29) {
        const t = { x, z, level: 0 }, c = Math.max(Math.abs(x - LUMBRIDGE.x), Math.abs(z - LUMBRIDGE.z));
        if (c >= 60 && flood.walkable!(t) && flood.areaOf!(t) === area) targets.push(t);
    }
    expect(targets.length).toBeGreaterThan(60);
    flood.addTargets!([LUMBRIDGE, ...targets]);
    // findLongPath first: its walks load the collision zones of the box, which the flood then finds loaded.
    const saved = process.env.ROUTE_FLOOD;
    process.env.ROUTE_FLOOD = '0';
    let pathMs: number, withPath: (number | null)[];
    try { const t1 = performance.now(); withPath = targets.map(t => plain(LUMBRIDGE, t, [], 0)); pathMs = performance.now() - t1; }
    finally { if (saved === undefined) delete process.env.ROUTE_FLOOD; else process.env.ROUTE_FLOOD = saved; }
    const t0 = performance.now(), withFlood = targets.map(t => flood(LUMBRIDGE, t, [], 0));
    const floodMs = performance.now() - t0;
    console.log(`${targets.length} walks: flood ${Math.round(floodMs)} ms, findLongPath ${Math.round(pathMs)} ms, ${withPath.filter(v => v !== null).length} with a path`);
    expect(withFlood).toEqual(withPath);
    expect(floodMs).toBeLessThan(pathMs);
}, 120_000);

// A walk with a tolerance of 1: findLongPath walks to the goal itself when it reaches it (its moveNear picks a near
// tile only when the goal is out of reach), so the flood's distance to the goal is the findLongPath length. A goal the
// flood does not reach (a blocked tile beside open ground here) goes to findLongPath, which ends beside it.
test('tolerant walks, to open and to blocked goals, have the findLongPath lengths', () => {
    const goals: Tile[] = [];
    for (let x = LUMBRIDGE.x - 200; x <= LUMBRIDGE.x + 200 && goals.length < 80; x += 17) for (let z = LUMBRIDGE.z - 200; z <= LUMBRIDGE.z + 200 && goals.length < 80; z += 19) {
        const t = { x, z, level: 0 }, beside = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => flood.walkable!({ x: x + dx!, z: z + dz!, level: 0 }));
        if (flood.walkable!(t) || beside) goals.push(t);
    }
    expect(goals.filter(t => !flood.walkable!(t)).length).toBeGreaterThan(5);
    // A start with no flood yet, so its flood holds these goals.
    const START: Tile = { x: 3226, z: 3219, level: 0 }, floodsBefore = flood.floodCount!();
    flood.addTargets!(goals);
    const saved = process.env.ROUTE_FLOOD;
    process.env.ROUTE_FLOOD = '0';
    let withPath: (number | null)[];
    try { withPath = goals.map(t => plain(START, t, [], 1)); } finally { if (saved === undefined) delete process.env.ROUTE_FLOOD; else process.env.ROUTE_FLOOD = saved; }
    expect(goals.map(t => flood(START, t, [], 1))).toEqual(withPath);
    expect(flood.floodCount!()).toBeGreaterThan(floodsBefore);
}, 120_000);
