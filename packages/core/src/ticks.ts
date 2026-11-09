// Waits counted in game ticks, never in wall-clock sleeps.
import { executionContext, executionWait } from '../../../vendor/rs-sdk/sdk/execution-context';
import { watchTickStream } from './tick-stream';
export interface TickSource {
    sdk: { getState(): any };
    tick(): number;
    onTick(cb: () => void): () => void;
    // Resolves when the session ends. No ticks come after that, so every wait must also end then.
    ended?: Promise<{ reason: string }>;
}
// A wait on an ended session resolves after one tick's length on a timer, never as a microtask: a script loop that
// only awaits waits would otherwise spin on resolved promises, starve every timer, and block its own settle and exit.
export const ENDED_WAIT_MS = 600;
const afterEnd = (s: TickSource, fn: () => void): void => { void s.ended?.then(() => { setTimeout(fn, ENDED_WAIT_MS); }); };

export function waitTicks(s: TickSource, n: number, opts: { idleMs?: number } = {}): Promise<void> {
    if (executionContext.getStore()?.signal.aborted) return new Promise(() => {});
    if (n <= 0) return Promise.resolve();
    return executionWait<void>((resolve, reject) => {
        let left = n;
        let done = false;
        const finish = () => { if (!done) { done = true; off(); resolve(); } };
        const off = watchTickStream(s, () => {
            if (!done && --left <= 0) finish();
        }, reject, opts.idleMs);
        afterEnd(s, finish);
        return () => { done = true; off(); };
    });
}

export function waitUntil(s: TickSource, pred: (st: any) => boolean, opts: { timeoutTicks: number; signal?: AbortSignal; idleMs?: number }): Promise<boolean> {
    if (executionContext.getStore()?.signal.aborted) return new Promise(() => {});
    if (opts.signal?.aborted) return Promise.resolve(false);
    const now = s.sdk.getState();
    try {
        if (now && pred(now)) return Promise.resolve(true);
    } catch (error) { return Promise.reject(error); }
    return executionWait<boolean>((resolve, reject) => {
        let seen = 0;
        let done = false;
        const cleanup = () => { done = true; off(); opts.signal?.removeEventListener('abort', onAbort); };
        const finish = (v: boolean) => { if (!done) { done = true; cleanup(); resolve(v); } };
        const onAbort = () => finish(false);
        const off = watchTickStream(s, () => {
            if (done) return;
            seen++;
            const st = s.sdk.getState();
            try {
                if (st && pred(st)) finish(true);
                else if (seen >= opts.timeoutTicks) finish(false);
            } catch (error) {
                done = true;
                cleanup();
                reject(error);
            }
        }, reject, opts.idleMs);
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        afterEnd(s, () => finish(false));
        return cleanup;
    });
}
