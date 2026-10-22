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

test('a climb that needs 40 ticks (interactLoc walks around a 2x2 stair first) succeeds with the default budget', async () => {
    const g = fakeGame({ x: 3205, z: 3206, level: 0, nearbyLocs: [{ id: 1738, name: 'Staircase', x: 3204, z: 3207, level: 0, optionsWithIndex: [] }] });
    g.quirks.climbTo = { x: 3205, z: 3209, level: 1 };
    g.quirks.climbDelayTicks = 40;
    const r = await walkRoute(g as any, [{ kind: 'transport', loc: 'spiralstairs', option: 'op1', at: { x: 3204, z: 3207, level: 0 }, to: { x: 3205, z: 3209, level: 1 }, exact: true }], { maxRetriesPerLeg: 1 });
    g.stop();
    expect(r.ok).toBe(true);
});

test('a climb refused with can\'t reach opens the closed door nearest the stairs, then climbs', async () => {
    const g = fakeGame({ x: 3205, z: 3206, level: 0, nearbyLocs: [
        { id: 1738, name: 'Staircase', x: 3204, z: 3207, level: 0, options: ['Climb-up'], optionsWithIndex: [] },
        { id: 1530, name: 'Door', x: 3208, z: 3211, level: 0, options: ['Open'], optionsWithIndex: [] },
        { id: 1530, name: 'Door', x: 3230, z: 3230, level: 0, options: ['Open'], optionsWithIndex: [] },
    ] });
    g.quirks.climbTo = { x: 3205, z: 3209, level: 1 };
    g.quirks.doorShut = true;
    const r = await walkRoute(g as any, [{ kind: 'transport', loc: 'spiralstairs', option: 'op1', at: { x: 3204, z: 3207, level: 0 }, to: { x: 3205, z: 3209, level: 1 }, exact: true }], { maxRetriesPerLeg: 3 });
    g.stop();
    expect(r.ok).toBe(true);
    expect(g.calls).toContain('open 3208,3211');
    expect(g.calls).not.toContain('open 3230,3230');
});

test('after a can\'t-reach climb the walker also walks up to the stair tile before retrying', async () => {
    const g = fakeGame({ x: 3205, z: 3206, level: 0, nearbyLocs: [{ id: 1738, name: 'Staircase', x: 3204, z: 3207, level: 0, options: ['Climb-up'], optionsWithIndex: [] }] });
    g.quirks.climbTo = { x: 3205, z: 3209, level: 1 };
    g.quirks.doorShut = true; // no door in range to open, so only the walk can help
    const origWalk = g.bot.walkTo;
    g.bot.walkTo = async (x: number, z: number) => { const r = await origWalk(x, z); if (x === 3204 && z === 3207) g.quirks.doorShut = false; return r; };
    const r = await walkRoute(g as any, [{ kind: 'transport', loc: 'spiralstairs', option: 'op1', at: { x: 3204, z: 3207, level: 0 }, to: { x: 3205, z: 3209, level: 1 }, exact: true }], { maxRetriesPerLeg: 3 });
    g.stop();
    expect(g.calls).toContain('walk 3204,3207');
    expect(r.ok).toBe(true);
});

test('aborting the walk (reflex) cancels the in-flight bot.walkTo through the SDK execution context', async () => {
    const { executionContext } = await import('../../../vendor/rs-sdk/sdk/execution-context');
    const g = fakeGame({ x: 0, z: 0, level: 0 });
    let cancelled = false;
    g.bot.walkTo = async () => new Promise(resolve => {
        const sig = executionContext.getStore()?.signal;
        sig?.addEventListener('abort', () => { cancelled = true; resolve({ success: false }); });
    });
    const ac = new AbortController();
    const p = walkRoute(g as any, [{ kind: 'walk', to: { x: 50, z: 50, level: 0 } }], { signal: ac.signal, maxRetriesPerLeg: 1 });
    await Bun.sleep(10);
    ac.abort('reflex');
    const r = await p;
    g.stop();
    expect(r).toMatchObject({ ok: false, reason: 'aborted' });
    expect(cancelled).toBe(true);
});

test('goTo blocks, in the SDK pathfinder, the doors this account cannot pass near the route', async () => {
    const { goTo } = await import('../src/walk');
    const g = fakeGame({ x: 0, z: 0, level: 0 });
    const blocked: string[] = [];
    (g.sdk as any).blockDoorTemporarily = (level: number, x: number, z: number) => { blocked.push(`${x},${z},${level}`); return true; };
    const world: any = {
        route: () => ({ ok: true, cost: 10, legs: [{ kind: 'walk', to: { x: 10, z: 10, level: 0 } }] }),
        blockedDoors: () => [{ x: 5, z: 5, level: 0 }, { x: 900, z: 900, level: 0 }],
    };
    const r = await goTo(g as any, world, { x: 10, z: 10, level: 0 }, { skills: {}, varps: {}, items: [] });
    g.stop();
    expect(r.ok).toBe(true);
    expect(blocked).toEqual(['5,5,0']); // the far door is outside the route's area and is skipped
});

test('a walk refused right after a climb (arrival delay) waits before retrying, then succeeds', async () => {
    const g = fakeGame({ x: 3205, z: 3209, level: 0 });
    const startTick = g.tick();
    const origWalk = g.bot.walkTo;
    // The server refuses movement for the first 6 ticks, signalled as a silent op rejection.
    g.bot.walkTo = async (x: number, z: number) => {
        if (g.tick() - startTick < 6) { g.state.opFeedback.opRejectedCount++; return { success: true }; }
        return origWalk(x, z);
    };
    const r = await walkRoute(g as any, [{ kind: 'walk', to: { x: 3222, z: 3218, level: 0 } }], { maxRetriesPerLeg: 3 });
    g.stop();
    expect(r.ok).toBe(true);
});
