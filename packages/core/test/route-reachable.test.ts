import { expect, test } from 'bun:test';
import { goalReachable } from '../src/world/search';
import type { ScopeAreas, Tile, Transport } from '../src/world';
import type { Travel } from '../src/travel';

// Level 0: area 0 west of x 1000, area 1 from x 1000 to 1999, nothing walkable past it. (500, 0) is a blocked tile whose
// first step reaches area 0 only.
const scope: ScopeAreas = {
    area: (l, x, z) => l !== 0 || z < 0 || z > 50 ? -1 : x === 500 && z === 0 ? -1 : x < 1000 ? 0 : x < 2000 ? 1 : -1,
    reach: () => [0],
    step: () => [0],
};
const t = (x: number, z = 0): Tile => ({ x, z, level: 0 });
const ladder = (from: Tile, to: Tile) => ({ from, to } as unknown as Transport);
const boat = (from: Tile | null, to: Tile) => ({ id: 'b', from, to } as unknown as Travel);
const none: Transport[] = [], noTravel: Travel[] = [];
const reach = (from: Tile, to: Tile, transports = none, allowed = new Uint8Array(transports.length).fill(1), travel = noTravel, ok = () => true) =>
    goalReachable(scope, from, to, 1, transports, allowed, travel, ok);

test('two areas with no transport between them have no route', () => {
    expect(reach(t(10), t(1100))).toBe(false);
});

test('an allowed transport or travel joins two areas; a refused one does not', () => {
    const across = [ladder(t(900), t(1010))];
    expect(reach(t(800), t(1100), across)).toBe(true);
    expect(reach(t(800), t(1100), across, new Uint8Array([0]))).toBe(false);
    expect(reach(t(800), t(1100), none, undefined, [boat(t(900), t(1010))])).toBe(true);
    expect(reach(t(800), t(1100), none, undefined, [boat(t(900), t(1010))], () => false)).toBe(false);
});

test('a teleport leaves from the start, wherever it stands', () => {
    expect(reach(t(10), t(1100), none, undefined, [boat(null, t(1050))])).toBe(true);
});

test('a walk joins two ends of one area at most MAX_LEG apart: a far transport needs ends between', () => {
    // From x 10 the transport at x 900 is 890 tiles away, past MAX_LEG (300) with no end between.
    const far = [ladder(t(900), t(1010))];
    expect(reach(t(10), t(1100), far)).toBe(false);
    // Transports that land in place at x 300 and x 600 are ends a walk can chain through.
    const chain = [...far, ladder(t(300), t(300, 1)), ladder(t(600), t(600, 1))];
    expect(reach(t(10), t(1100), chain)).toBe(true);
});

test('a landing on a blocked tile leaves it by its first step', () => {
    // The ladder lands on the blocked tile (500, 0); its first step reaches area 0, where the goal is.
    expect(reach(t(1100), t(600), [ladder(t(1200), t(500))])).toBe(true);
    const shut: ScopeAreas = { ...scope, step: () => [] };
    expect(goalReachable(shut, t(1100), t(600), 1, [ladder(t(1200), t(500))], new Uint8Array([1]), [], () => true)).toBe(false);
});
