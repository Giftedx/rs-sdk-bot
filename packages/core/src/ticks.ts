// Waits counted in game ticks, never in wall-clock sleeps.
export interface TickSource {
    sdk: { getState(): any };
    tick(): number;
    onTick(cb: () => void): () => void;
}

export function waitTicks(s: TickSource, n: number): Promise<void> {
    if (n <= 0) return Promise.resolve();
    return new Promise(resolve => {
        let left = n;
        const off = s.onTick(() => {
            if (--left <= 0) { off(); resolve(); }
        });
    });
}

export function waitUntil(s: TickSource, pred: (st: any) => boolean, opts: { timeoutTicks: number }): Promise<boolean> {
    const now = s.sdk.getState();
    if (now && pred(now)) return Promise.resolve(true);
    return new Promise(resolve => {
        let seen = 0;
        const off = s.onTick(() => {
            seen++;
            const st = s.sdk.getState();
            if (st && pred(st)) { off(); resolve(true); }
            else if (seen >= opts.timeoutTicks) { off(); resolve(false); }
        });
    });
}
