import { test, expect } from 'bun:test';
import { expandPath, walkPath, type PathDeps, type PathLoc } from '../src/walk';

// A straight east-west road at z=3200. The fake bot runs 2 tiles per tick toward its last click. A shut door at
// doorX blocks the road until a loc click opens it; the open takes effect `openDelay` ticks after the bot
// stands next to it.
function road(opts: { doorX?: number; openDelay?: number; stallAt?: number } = {}) {
    let x = 3000, clickX = 3000, tick = 0;
    let doorShut = opts.doorX !== undefined;
    let doorClickAt = -1, besideSince = -1;
    let stalled = false;
    const inputs: { tick: number; what: string }[] = [];
    const listeners = new Set<() => void>();
    const door: PathLoc = { x: opts.doorX ?? 0, z: 3200, id: 1597, optionsWithIndex: [{ text: 'Open', opIndex: 1 }] };
    const deps: PathDeps = {
        pos: () => ({ x, z: 3200, level: 0 }),
        onTick: cb => { listeners.add(cb); return () => listeners.delete(cb); },
        walk: tx => { clickX = tx; doorClickAt = -1; inputs.push({ tick, what: `walk ${tx}` }); },
        interactLoc: l => { clickX = l.x - 1; doorClickAt = tick; inputs.push({ tick, what: `open ${l.x}` }); },
        locs: () => (doorShut ? [door] : []),
        plan: (_l, _f, to) => [{ x: to.x, z: to.z }],
    };
    const step = () => {
        tick++;
        // A stall: the bot loses its route once (as when a click is dropped) and stands until the next click.
        if (opts.stallAt !== undefined && x >= opts.stallAt && !stalled) { stalled = true; clickX = x; }
        const limit = doorShut && opts.doorX !== undefined ? opts.doorX - 1 : Infinity;
        for (let k = 0; k < 2; k++) {
            const nx = x + Math.sign(clickX - x);
            if (nx === x || nx > limit) break;
            x = nx;
        }
        if (doorShut && doorClickAt >= 0 && x === opts.doorX! - 1) {
            if (besideSince < 0) besideSince = tick;
            if (tick - besideSince >= (opts.openDelay ?? 1)) doorShut = false;
        }
        for (const l of [...listeners]) l();
    };
    return { deps, step, inputs, at: () => x, tick: () => tick, doorShut: () => doorShut };
}

async function run(w: ReturnType<typeof road>, to: number, maxSteps = 200) {
    const p = walkPath(w.deps, [{ x: to, z: 3200, tol: 1 }]);
    for (let i = 0; i < maxSteps; i++) {
        const r = await Promise.race([p, Promise.resolve(null)]);
        if (r) return r;
        w.step();
    }
    return p;
}

test('expandPath turns straight and diagonal corners into single tiles', () => {
    expect(expandPath({ x: 0, z: 0 }, [{ x: 2, z: 2 }, { x: 4, z: 2 }])).toEqual([{ x: 1, z: 1 }, { x: 2, z: 2 }, { x: 3, z: 2 }, { x: 4, z: 2 }]);
});

test('walkPath clicks ahead before the route runs out, so the bot gains 2 tiles every tick', async () => {
    const w = road();
    const r = await run(w, 3100);
    expect(r.ok).toBe(true);
    expect(r.still).toBe(0);
    // 100 tiles at 2 per tick, goal tolerance 1.
    expect(r.ticks).toBeLessThanOrEqual(50);
    // About one click per 7 tiles of running, never one per tile.
    expect(r.clicks).toBeLessThan(20);
    // Never more than one input in one tick.
    const perTick = new Map<number, number>();
    for (const i of w.inputs) perTick.set(i.tick, (perTick.get(i.tick) ?? 0) + 1);
    expect(Math.max(...perTick.values())).toBe(1);
});

test('walkPath opens a shut door on the path and clicks past it on the tick it opens', async () => {
    const w = road({ doorX: 3030, openDelay: 1 });
    const r = await run(w, 3060);
    expect(r.ok).toBe(true);
    expect(r.doors).toBe(1);
    expect(w.doorShut()).toBe(false);
    const open = w.inputs.find(i => i.what === 'open 3030')!;
    const after = w.inputs.find(i => i.tick > open.tick && i.what.startsWith('walk'))!;
    expect(after).toBeDefined();
    // 60 tiles = 30 ticks; the door may cost 2 ticks, never a timer wait.
    expect(r.ticks).toBeLessThanOrEqual(33);
});

test('walkPath clicks again after one tick without a step', async () => {
    const w = road({ stallAt: 3020 });
    const r = await run(w, 3060);
    expect(r.ok).toBe(true);
    expect(r.still).toBeLessThanOrEqual(1);
});

test('walkPath gives up within its budget when the bot cannot move', async () => {
    const w = road();
    w.deps.walk = () => {};
    const r = await run(w, 3100, 400);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/budget/);
});

test('walkPath walks a straight line when the planner finds no path from a tile it calls blocked', async () => {
    const w = road();
    w.deps.plan = () => [];
    const r = await run(w, 3040);
    expect(r.ok).toBe(true);
    expect(r.ticks).toBeLessThanOrEqual(21);
});
