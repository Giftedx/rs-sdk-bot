// Continuous walking along a precomputed tile path, the way a player clicks ahead on the minimap.
// bot.walkTo sends one walk per path corner and waits to arrive before the next, which costs a tick at each
// corner. glide clicks `lookahead` tiles ahead of the bot and clicks again before it gets there, so the bot keeps
// running. Measured (scripts/measure/walk-bench.ts, Lumbridge to Port Sarim, 287 tiles): walkTo
// 159 ticks, glide 144 (running is 2 tiles per tick, so 144 is the floor).

export interface GlideDeps {
    pos(): { x: number; z: number } | null;
    sendWalk(x: number, z: number): Promise<unknown>;
    waitTicks(n: number): Promise<void>;
}

export async function glide(
    deps: GlideDeps,
    path: { x: number; z: number }[],
    opts: { lookahead?: number; tolerance?: number; maxClicks?: number } = {},
): Promise<{ ok: boolean; clicks: number }> {
    const look = opts.lookahead ?? 14;
    const tol = opts.tolerance ?? 2;
    const maxClicks = opts.maxClicks ?? Math.ceil(path.length / 2) + 20;
    const goal = path[path.length - 1];
    if (!goal) return { ok: true, clicks: 0 };
    const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
    let clicks = 0;
    let lastIdx = -1;
    let bestToGoal = Infinity, still = 0;
    while (clicks < maxClicks) {
        const p = deps.pos();
        if (!p) return { ok: false, clicks };
        if (dist(p, goal) <= tol) return { ok: true, clicks };
        // A blocked bot (a closed door, a partial path) must hand back to the caller quickly.
        if (dist(p, goal) < bestToGoal) { bestToGoal = dist(p, goal); still = 0; } else if (++still >= 3) return { ok: false, clicks };
        // Nearest path tile to the bot, searched forward from the last one so a path that loops back is safe.
        let best = Math.max(0, lastIdx), bd = Infinity;
        for (let i = Math.max(0, lastIdx); i < path.length; i++) {
            const d = dist(path[i]!, p);
            if (d < bd) { bd = d; best = i; }
        }
        lastIdx = best;
        const tgt = path[Math.min(path.length - 1, best + look)]!;
        await deps.sendWalk(tgt.x, tgt.z);
        clicks++;
        // Running covers 2 tiles per tick: re-click when about half the lookahead is used.
        await deps.waitTicks(Math.max(1, Math.floor(look / 4)));
    }
    return { ok: false, clicks };
}
