// The bot side of route-worker.ts: one worker per process, shared by every bot in it (host mode included).
// Requests queue in the worker, so two bots planning at once wait their turn without blocking either game loop.
import type { BankStock, TripPlan } from './trip';
import type { Account, Tile } from './world';
import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';

// Bun workers have ref/unref: an idle worker does not keep the process alive.
type BunWorker = Worker & { ref(): void; unref(): void };
let worker: BunWorker | null = null, next = 0, idle: ReturnType<typeof setTimeout> | null = null;
// An idle worker holds a second pathfinder (about 800 MB per bot process); it closes this long after its last plan.
export const WORKER_IDLE_MS = 30_000;
const pending = new Map<number, { resolve(p: TripPlan | null): void; reject(e: unknown): void }>();

function stopWorker(w: BunWorker) {
    if (worker !== w) return;
    worker = null;
    if (idle) clearTimeout(idle);
    idle = null;
    w.unref();
    void w.terminate();
}

function start(): BunWorker {
    if (worker) return worker;
    // bunfig.toml preloads do not reach a Worker: it gets collision-lazy.ts itself (about 300 MB less heap).
    const w = new Worker(new URL('./route-worker.ts', import.meta.url).href, { preload: [new URL('./collision-lazy.ts', import.meta.url).href] } as WorkerOptions) as BunWorker;
    w.onmessage = (e: MessageEvent<{ id: number; plan?: TripPlan | null; error?: string }>) => {
        if (worker !== w) return;
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.error) p.reject(Error(`route worker: ${e.data.error}`)); else p.resolve(e.data.plan ?? null);
        if (!pending.size) { w.unref(); idle = setTimeout(() => { if (!pending.size) stopWorker(w); }, WORKER_IDLE_MS); (idle as { unref?(): void }).unref?.(); }
    };
    w.onerror = (e: ErrorEvent) => {
        if (worker !== w) return;
        for (const p of pending.values()) p.reject(Error(`route worker failed: ${e.message}`));
        pending.clear();
        stopWorker(w);
    };
    return worker = w;
}

export function planTripOffThread(from: Tile, to: Tile, acct: Account, stock?: BankStock, budgetMs?: number): Promise<TripPlan | null> {
    const signal = executionContext.getStore()?.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (idle) { clearTimeout(idle); idle = null; }
    const w = start(), id = ++next;
    w.ref();
    return new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', abort);
        const fail = (error: unknown) => {
            if (!pending.delete(id)) return;
            cleanup();
            reject(error);
            if (!pending.size) stopWorker(w);
        };
        const abort = () => fail(signal?.reason);
        pending.set(id, {
            resolve: plan => { cleanup(); resolve(plan); },
            reject: error => { cleanup(); reject(error); },
        });
        signal?.addEventListener('abort', abort, { once: true });
        try { w.postMessage({ id, from, to, acct: JSON.parse(JSON.stringify(acct)), stock, budgetMs }); }
        catch (error) { fail(error); }
    });
}
