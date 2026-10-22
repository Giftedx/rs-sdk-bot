import { test, expect } from 'bun:test';
import { walkRoute } from '../src/walk';
import { fakeGame } from './fakegame';

test('a walk leg that lands 3 tiles off is retried, then succeeds', async () => {
    const g = fakeGame({ x: 0, z: 0, level: 0 });
    g.quirks.walkOffBy = 3;
    const r = await walkRoute(g as any, [{ kind: 'walk', to: { x: 10, z: 10, level: 0 } }]);
    g.stop();
    expect(r.ok).toBe(true);
    expect(g.calls.filter(c => c.startsWith('walk')).length).toBe(2);
});

test('a transport leg climbs using the loc found at its tile and the op number', async () => {
    const g = fakeGame({ x: 3259, z: 3445, level: 0, nearbyLocs: [{ id: 1, name: 'Staircase', x: 3259, z: 3446, level: 0, optionsWithIndex: [{ text: 'Climb-up', opIndex: 1 }] }] });
    g.quirks.climbTo = { x: 3259, z: 3449, level: 1 };
    const r = await walkRoute(g as any, [{ kind: 'transport', loc: 'stairs', option: 'op1', at: { x: 3259, z: 3446, level: 0 }, to: { x: 3259, z: 3449, level: 1 }, exact: true }]);
    g.stop();
    expect(r.ok).toBe(true);
    expect(g.calls).toContain('interact 3259,3446 op1');
});

test('a climb that never changes level fails after its retries, as timeout', async () => {
    const g = fakeGame({ x: 3259, z: 3445, level: 0, nearbyLocs: [{ id: 1, name: 'Staircase', x: 3259, z: 3446, level: 0, optionsWithIndex: [] }] });
    g.quirks.climbFails = 99;
    const r = await walkRoute(g as any, [{ kind: 'transport', loc: 'stairs', option: 'op1', at: { x: 3259, z: 3446, level: 0 }, to: { x: 3259, z: 3449, level: 1 }, exact: true }], { maxRetriesPerLeg: 2, legTimeoutTicks: 5 });
    g.stop();
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(g.calls.filter(c => c.startsWith('interact')).length).toBe(2);
});

test('a missing stair loc at the tile is reported, not clicked blindly', async () => {
    const g = fakeGame({ x: 0, z: 0, level: 0 });
    const r = await walkRoute(g as any, [{ kind: 'transport', loc: 'stairs', option: 'op1', at: { x: 5, z: 5, level: 0 }, to: { x: 5, z: 7, level: 1 }, exact: true }], { maxRetriesPerLeg: 1, legTimeoutTicks: 3 });
    g.stop();
    expect(r).toMatchObject({ ok: false, reason: 'precondition' });
});
