import { test, expect } from 'bun:test';
import { glide } from '../src/glide';

// A straight east-west line of 60 tiles. The fake bot runs 2 tiles per tick toward its last click.
function world() {
    const path = Array.from({ length: 60 }, (_, i) => ({ x: 3000 + i + 1, z: 3200 }));
    let x = 3000, clickX = 3000, idle = 0, clicks: number[] = [];
    const deps = {
        pos: () => ({ x, z: 3200 }),
        sendWalk: async (tx: number) => { clickX = tx; clicks.push(tx); },
        waitTicks: async (n: number) => {
            for (let i = 0; i < n; i++) {
                const step = Math.min(2, Math.abs(clickX - x));
                if (step === 0) idle++;
                x += Math.sign(clickX - x) * step;
            }
        },
    };
    return { path, deps, idle: () => idle, clicks, at: () => x };
}

test('glide clicks ahead along the path and never stands still before the goal', async () => {
    const w = world();
    const r = await glide(w.deps, w.path, { lookahead: 14, tolerance: 1 });
    expect(r.ok).toBe(true);
    expect(w.at()).toBeGreaterThanOrEqual(3059);
    expect(w.idle()).toBe(0);
    // 60 tiles at 2 per tick: 30 ticks of moving, so about 30 / (14 / 4) clicks, never one per tile.
    expect(w.clicks.length).toBeLessThan(15);
    // Nearest path tile to 3000 is 3001 (index 0); 14 tiles past it is 3015.
    expect(w.clicks[0]).toBe(3015);
});

// Seen 2026-10-23 on Karamja: a partial path left the bot clicking toward a tile it could not reach, and the
// leg took about 600 ticks instead of about 150. Three clicks with no progress must end the glide.
test('glide stops after 3 clicks without getting closer to the goal', async () => {
    const w = world();
    let x = 3000;
    const blocked = { ...w.deps, pos: () => ({ x, z: 3200 }), waitTicks: async () => { x = Math.min(x + 2, 3010); } };
    const r = await glide(blocked, w.path, { lookahead: 14, tolerance: 1 });
    expect(r.ok).toBe(false);
    expect(r.clicks).toBeLessThanOrEqual(8);
});

test('glide gives up after its tick budget when the bot does not move', async () => {
    const w = world();
    const stuck = { ...w.deps, waitTicks: async () => {} };
    const r = await glide(stuck, w.path, { lookahead: 14, tolerance: 1, maxClicks: 5 });
    expect(r.ok).toBe(false);
});
