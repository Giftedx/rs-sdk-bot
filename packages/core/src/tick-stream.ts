// LiveDriver.nextTick from UberMouse's conductor distinguishes a frozen client
// from a tick-budget expiry. Keep the same monotonic, new-tick condition here.
export const DEFAULT_TICK_IDLE_MS = 15_000;
// How many tick streams are open in this process: every waitTicks, waitUntil, checked action and walk leg holds one
// while it waits. The lockstep acknowledgement (inprocess.ts) reads it: a script with no open stream is working off
// the tick clock.
export const tickWaits = { active: 0 };
export class TickStallError extends Error {
    constructor(ms: number) { super(`tick stream stalled: no new game tick for ${ms}ms`); this.name = 'TickStallError'; }
}

export function watchTickStream(source: { onTick(cb: () => void): () => void; tick?(): number | undefined }, next: () => void,
    failed: (error: TickStallError) => void, idleMs = DEFAULT_TICK_IDLE_MS): () => void {
    if (!Number.isFinite(idleMs) || idleMs <= 0 || idleMs > 2_147_483_647) throw Error('invalid tick stream idle deadline');
    let stopped = false, lastTick = source.tick?.() ?? -1, lastAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    tickWaits.active++;
    const close = () => { if (stopped) return; stopped = true; tickWaits.active--; unsubscribe(); clearTimeout(timer); };
    const check = () => {
        if (stopped) return;
        const remaining = idleMs - (performance.now() - lastAt);
        if (remaining <= 0) { close(); failed(new TickStallError(idleMs)); }
        else timer = setTimeout(check, Math.ceil(remaining));
    };
    unsubscribe = source.onTick(() => {
        if (stopped) return;
        const current = source.tick?.();
        if (current === undefined || current > lastTick) { lastTick = current ?? lastTick + 1; lastAt = performance.now(); }
        next();
    });
    if (stopped) unsubscribe(); else timer = setTimeout(check, idleMs);
    return close;
}
