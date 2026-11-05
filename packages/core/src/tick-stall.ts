// A session whose game ticks have stopped arriving, without a disconnect, holds its account and its process until
// something ends it: a quest script that waits on the next tick waits for ever, and only the status row's clock shows
// it. The watch ends such a session after TICK_STALL_MS without a tick, on the clock, so the account is freed.
export const TICK_STALL_MS = Math.max(1_000, Number(process.env.TICK_STALL_MS ?? 120_000));
export function startTickStallWatch(s: { onTick(cb: () => void): () => void }, onStall: (detail: string) => void,
    opts: { ms?: number; every?: number; now?: () => number; setInterval?: typeof globalThis.setInterval; clearInterval?: typeof globalThis.clearInterval } = {}): { stop(): void } {
    const ms = opts.ms ?? TICK_STALL_MS, now = opts.now ?? Date.now, every = opts.every ?? Math.min(10_000, Math.max(100, Math.floor(ms / 4)));
    let lastTick = now(), fired = false;
    const off = s.onTick(() => { lastTick = now(); });
    const timer = (opts.setInterval ?? setInterval)(() => {
        const idle = now() - lastTick;
        if (!fired && idle >= ms) { fired = true; onStall(`tick stream stalled: ${Math.round(idle / 1000)} s without a game tick`); }
    }, every);
    return { stop: () => { (opts.clearInterval ?? clearInterval)(timer); off(); } };
}
