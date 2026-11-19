import { expect, test } from 'bun:test';
import { inElementalBasement, inElementalStairwell, inElementalWorkshop, leaveElementalWorkshop, ELEMENTAL_STAIRS_UP, ELEMENTAL_ODD_WALL } from './elemental-exit';

test('Elemental Workshop bounds detect basement and ground stairwell accurately', () => {
    // Exact tile reported by OreElse and the basement bounds.
    expect(inElementalBasement({ worldX: 2718, worldZ: 9887, level: 0 })).toBe(true);
    expect(inElementalWorkshop({ worldX: 2718, worldZ: 9887, level: 0 })).toBe(true);
    expect(inElementalStairwell({ worldX: 2718, worldZ: 9887, level: 0 })).toBe(false);
    // Landing tile upstairs from spiral stairs 3416.
    expect(inElementalStairwell({ worldX: 2709, worldZ: 3497, level: 0 })).toBe(true);
    expect(inElementalWorkshop({ worldX: 2709, worldZ: 3497, level: 0 })).toBe(true);
    expect(inElementalBasement({ worldX: 2709, worldZ: 3497, level: 0 })).toBe(false);
    // Just south of odd wall (3495) and Seers bank (3492) are outside.
    expect(inElementalWorkshop({ worldX: 2709, worldZ: 3495, level: 0 })).toBe(false);
    expect(inElementalWorkshop({ worldX: 2725, worldZ: 3492, level: 0 })).toBe(false);
    expect(inElementalWorkshop({ worldX: 2718, worldZ: 9887, level: 1 })).toBe(false);
    expect(inElementalWorkshop(null)).toBe(false);
});

test('leaveElementalWorkshop returns null outside workshop', async () => {
    const s = { sdk: { getState: () => ({ player: { worldX: 2725, worldZ: 3492, level: 0 } }) } } as any;
    expect(await leaveElementalWorkshop(s)).toBeNull();
});

test('leaveElementalWorkshop climbs basement stairs then pushes exit wall', async () => {
    let tick = 10;
    const player = { worldX: 2718, worldZ: 9887, level: 0 };
    const nearbyLocs = () => player.worldZ >= 9860
        ? [{ id: ELEMENTAL_STAIRS_UP.id, name: 'Staircase', x: ELEMENTAL_STAIRS_UP.x, z: ELEMENTAL_STAIRS_UP.z, distance: 2 }]
        : [{ id: ELEMENTAL_ODD_WALL.id, name: 'Odd looking wall', x: ELEMENTAL_ODD_WALL.x, z: ELEMENTAL_ODD_WALL.z, distance: 2 }];
    const s = { tick: () => tick, sdk: { getState: () => ({ player, nearbyLocs: nearbyLocs() }) } } as any;
    const actions: number[] = [];
    let walked = 0;
    const out = await leaveElementalWorkshop(s, () => false, {
        walkToStairs: async () => { walked++; },
        interact: async (_sess, loc) => {
            actions.push(loc.id);
            tick += 2;
            if (loc.id === ELEMENTAL_STAIRS_UP.id) { player.worldX = 2709; player.worldZ = 3497; }
            if (loc.id === ELEMENTAL_ODD_WALL.id) { player.worldX = 2709; player.worldZ = 3495; }
        },
        wait: async (_sess, pred) => pred(),
    });
    expect(walked).toBe(0);
    expect(actions).toEqual([ELEMENTAL_STAIRS_UP.id, ELEMENTAL_ODD_WALL.id]);
    expect(out).toEqual({ ok: true, ticks: 4 });
});

test('leaveElementalWorkshop walks to stairs when distant and aborts on stop', async () => {
    let tick = 0, stopped = false;
    const player = { worldX: 2734, worldZ: 9882, level: 0 };
    const stairs = { id: ELEMENTAL_STAIRS_UP.id, name: 'Staircase', x: ELEMENTAL_STAIRS_UP.x, z: ELEMENTAL_STAIRS_UP.z, distance: 1 };
    const s = { tick: () => tick, sdk: { getState: () => ({ player, nearbyLocs: player.worldX === 2717 ? [stairs] : [] }) } } as any;
    let walked = 0;
    const out = await leaveElementalWorkshop(s, () => stopped, {
        walkToStairs: async () => { walked++; tick += 5; player.worldX = 2717; player.worldZ = 9888; stopped = true; },
        interact: async () => { throw Error('must not interact after stop'); },
        wait: async () => false,
    });
    expect(walked).toBe(1);
    expect(out).toEqual({ ok: false, reason: 'aborted', detail: 'stopped walking to Elemental Workshop stairs', ticks: 5 });
});
