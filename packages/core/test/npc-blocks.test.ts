import { expect, test } from 'bun:test';
import { blockwalkNpcIds, installDoorPolicy, npcBlockTiles } from '../src/world';

const CRATE = 767; // kittens_mew, blockwalk=all (quest_fluffs.npc)
const YARD_CRATES = [{ x: 3305, z: 3500 }, { x: 3310, z: 3499 }, { x: 3307, z: 3507 }, { x: 3303, z: 3506 }, { x: 3298, z: 3514 }, { x: 3311, z: 3511 }];

test('blockwalk=all npcs block their footprint, but not the walker tile or the destination', () => {
    const ids = blockwalkNpcIds();
    expect(ids.has(CRATE)).toBe(true);
    expect(ids.has(0)).toBe(false); // Hans
    const from = { x: 3307, z: 3508, level: 0 }, to = { x: 3305, z: 3494, level: 0 };
    const tiles = npcBlockTiles([
        { id: CRATE, x: 3307, z: 3507 },
        { id: 0, x: 3306, z: 3507 },
        { id: CRATE, x: 3305, z: 3494 },
        { id: 1460, x: 2803, z: 2785, tileX: 2803, tileZ: 2785, size: 2 },
    ], from, to);
    expect(tiles).toEqual([
        { x: 3307, z: 3507, level: 0 },
        { x: 2803, z: 2785, level: 0 }, { x: 2803, z: 2786, level: 0 }, { x: 2804, z: 2785, level: 0 }, { x: 2804, z: 2786, level: 0 },
    ]);
});

// Every tile a waypoint list steps on, one step at a time toward each turn point.
function steps(from: { x: number; z: number }, wps: readonly { x: number; z: number }[]): string[] {
    const out: string[] = [];
    let { x, z } = from;
    for (const w of wps) while (x !== w.x || z !== w.z) {
        x += Math.sign(w.x - x); z += Math.sign(w.z - z);
        out.push(`${x},${z}`);
    }
    return out;
}

test('a walk out of the lumber yard from 3307,3508 goes round the crate at 3307,3507 to the fence tile', async () => {
    const pf = await import('../../../vendor/rs-sdk/sdk/pathfinding');
    pf.initPathfinding();
    const from = { x: 3307, z: 3508 }, to = { x: 3305, z: 3494 };
    const state = {
        player: { worldX: from.x, worldZ: from.z, level: 0 },
        skills: [{ name: 'Hitpoints', level: 99, baseLevel: 99 }], inventory: [], equipment: [], nearbyLocs: [],
        nearbyNpcs: YARD_CRATES.map((c, i) => ({ kind: 'npc', id: CRATE, index: i, name: 'Crate', x: c.x, z: c.z, tileX: c.x, tileZ: c.z, size: 1 })),
    };
    const raw: any = { getState: () => state, findPath: (x: number, z: number) => pf.findLongPath(0, from.x, from.z, x, z, 500) };
    // The static map leaves the crate tile open: this is the path that stood still in the live run.
    expect(steps(from, raw.findPath(to.x, to.z))).toContain('3307,3507');
    await installDoorPolicy(raw);
    const path = raw.findPath(to.x, to.z) as { x: number; z: number }[];
    const walked = steps(from, path);
    expect(walked.at(-1)).toBe(`${to.x},${to.z}`);
    for (const c of YARD_CRATES) expect(walked).not.toContain(`${c.x},${c.z}`);
    // The block lasts only for the query.
    expect(pf.isTileWalkable(0, 3307, 3507)).toBe(true);
}, 60_000);
