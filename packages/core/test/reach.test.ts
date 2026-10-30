import { expect, test } from 'bun:test';
import { canReachLocal, canStepLocal, clientReach } from '../src/reach';

// A 10x10 open scene with a wall on the east side of column x=4 (blocks moves between x=4 and x=5).
const W_E = 0x8, W_W = 0x80, SOLID = 0x200000;
function scene(gapZ: number | null, solid: [number, number][] = []) {
    const f = new Int32Array(104 * 104);
    for (let z = 0; z < 10; z++) if (z !== gapZ) { f[4 * 104 + z]! |= W_E; f[5 * 104 + z]! |= W_W; }
    for (const [x, z] of solid) f[x * 104 + z]! |= SOLID;
    return (lx: number, lz: number) => lx >= 0 && lz >= 0 && lx < 10 && lz < 10 ? f[lx * 104 + lz]! : null;
}

test('a wall stops the search; a gap lets it through', () => {
    expect(canStepLocal(scene(null), 4, 2, 1, 0)).toBe(false);
    expect(canReachLocal(scene(null), { lx: 1, lz: 1 }, { lx: 8, lz: 1 })).toBe(false);
    expect(canReachLocal(scene(7), { lx: 1, lz: 1 }, { lx: 8, lz: 1 })).toBe(true);
});

test('a solid target is reached from a neighbour only with adjacentOk', () => {
    const s = scene(7, [[2, 2]]);
    expect(canReachLocal(s, { lx: 0, lz: 0 }, { lx: 2, lz: 2 })).toBe(false);
    expect(canReachLocal(s, { lx: 0, lz: 0 }, { lx: 2, lz: 2 }, { adjacentOk: true })).toBe(true);
});

test('the client probe reads the scene at the build base and refuses tiles outside it', () => {
    const flags = new Int32Array(104 * 104);
    for (let z = 0; z < 104; z++) { flags[4 * 104 + z] = W_E; flags[5 * 104 + z] = W_W; }
    const client = { collision: [{ flags }], minusedlevel: 0, mapBuildBaseX: 3000, mapBuildBaseZ: 3000, ensureCollision() {} };
    const reach = clientReach(client, () => ({ x: 3001, z: 3001, level: 0 }))!;
    expect(reach({ x: 3003, z: 3050, level: 0 })).toBe(true);
    expect(reach({ x: 3008, z: 3001, level: 0 })).toBe(false);
    expect(reach({ x: 3200, z: 3001, level: 0 })).toBeNull();
    expect(reach({ x: 3003, z: 3001, level: 1 })).toBeNull();
    expect(clientReach({}, () => null)).toBeNull();
});
