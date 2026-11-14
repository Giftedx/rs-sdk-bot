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

type SessionEnd = { reason: string };
type EndWatch = { callbacks: Set<(end: SessionEnd) => void>; end?: SessionEnd };
const endWatches = new WeakMap<Promise<SessionEnd>, EndWatch>();

// A session can outlive thousands of waits. Keep one promise handler and release each finished wait's closure.
export function onSessionEnd(s: Pick<TickSource, 'ended'>, callback: (end: SessionEnd) => void): () => void {
    if (!s.ended) return () => {};
    let watch = endWatches.get(s.ended);
    if (!watch) {
        watch = { callbacks: new Set() };
        endWatches.set(s.ended, watch);
        const current = watch;
        void s.ended.then(end => {
            current.end = end;
            for (const notify of current.callbacks) notify(end);
            current.callbacks.clear();
        });
    }
    let active = true;
    const notify = (end: SessionEnd) => { if (active) { active = false; callback(end); } };
    if (watch.end) {
        const end = watch.end;
        queueMicrotask(() => notify(end));
    } else watch.callbacks.add(notify);
    return () => { active = false; watch.callbacks.delete(notify); };
}

// A wait on an ended session resolves after one tick's length on a timer, never as a microtask: a script loop that
// only awaits waits would otherwise spin on resolved promises, starve every timer, and block its own settle and exit.
export const ENDED_WAIT_MS = 600;
const afterEnd = (s: TickSource, fn: () => void): (() => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onSessionEnd(s, () => { timer = setTimeout(fn, ENDED_WAIT_MS); });
    return () => { off(); clearTimeout(timer); };
};

export function waitTicks(s: TickSource, n: number, opts: { idleMs?: number } = {}): Promise<void> {
    if (executionContext.getStore()?.signal.aborted) return new Promise(() => {});
    if (n <= 0) return Promise.resolve();
    return executionWait<void>((resolve, reject) => {
        let left = n;
        let done = false;
        let off = () => {}, cancelEnd = () => {};
        const finish = () => { if (!done) { done = true; resolve(); } };
        off = watchTickStream(s, () => {
            if (!done && --left <= 0) finish();
        }, reject, opts.idleMs);
        cancelEnd = afterEnd(s, finish);
        return () => { done = true; off(); cancelEnd(); };
    });
}

export function waitUntil(s: TickSource, pred: (st: any) => boolean, opts: { timeoutTicks: number; signal?: AbortSignal; idleMs?: number }): Promise<boolean> {
    if (executionContext.getStore()?.signal.aborted) return new Promise(() => {});
    if (opts.signal?.aborted) return Promise.resolve(false);
    try {
        const now = s.sdk.getState();
        if (now && pred(now)) return Promise.resolve(true);
    } catch (error) { return Promise.reject(error); }
    return executionWait<boolean>((resolve, reject) => {
        let seen = 0;
        let done = false;
        let off = () => {}, cancelEnd = () => {};
        const cleanup = () => { done = true; off(); cancelEnd(); opts.signal?.removeEventListener('abort', onAbort); };
        const finish = (v: boolean) => { if (!done) { done = true; cleanup(); resolve(v); } };
        const onAbort = () => finish(false);
        off = watchTickStream(s, () => {
            if (done) return;
            seen++;
            try {
                const st = s.sdk.getState();
                if (st && pred(st)) finish(true);
                else if (seen >= opts.timeoutTicks) finish(false);
            } catch (error) {
                done = true;
                cleanup();
                reject(error);
            }
        }, reject, opts.idleMs);
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        cancelEnd = afterEnd(s, () => finish(false));
        return cleanup;
    });
}
