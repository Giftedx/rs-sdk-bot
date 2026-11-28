// The bot side of route-worker.ts: one worker per process, shared by every bot in it (host mode included).
// Requests queue in the worker, so two bots planning at once wait their turn without blocking either game loop.
import type { BankStock, TripPlan } from './trip';
import type { Account, Tile } from './world-types';
import type { SharedLabels } from './components';
import {
    discoverRouteService, markRouteServiceFailed, pendingRemoteRouteWork, queryRouteService, serviceWanted,
    trackRemoteRouteWork,
} from './route-query';
import type { ServiceInfo } from './route-service-client';
import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';

export { queryRouteService, serviceWanted };

// Bun workers have ref/unref: an idle worker does not keep the process alive.
type BunWorker = Worker & { ref(): void; unref(): void };
let worker: BunWorker | null = null, next = 0, idle: ReturnType<typeof setTimeout> | null = null, workerSentAreas = false;
// An idle worker holds a second pathfinder (about 800 MB per bot process); it closes this long after its last plan.
export const WORKER_IDLE_MS = 30_000;
const pending = new Map<number, { started: number; resolve(p: TripPlan | null): void; reject(e: unknown): void }>();
// The searches in flight that started under `youngerThanMs` ago. A lockstep bot holds its tick for these only: a
// search past the bound is hung and holds no tick, so one hung search costs a case one bound and not one bound for
// each later tick.
export const pendingRouteWork = (youngerThanMs = Infinity): number => {
    const remoteCount = pendingRemoteRouteWork(youngerThanMs);
    if (pending.size === 0 || youngerThanMs === Infinity) return pending.size + remoteCount;
    const now = performance.now();
    let count = remoteCount;
    for (const p of pending.values()) if (now - p.started < youngerThanMs) count++;
    return count;
};

function stopWorker(w: BunWorker) {
    if (worker !== w) return;
    worker = null;
    workerSentAreas = false;
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
    const failAll = (reason: string) => {
        if (worker !== w) return;
        for (const p of pending.values()) p.reject(Error(reason));
        pending.clear();
        stopWorker(w);
    };
    w.onerror = (e: ErrorEvent) => failAll(`route worker failed: ${e.message}`);
    w.onmessageerror = () => failAll('route worker message unreadable');
    w.addEventListener?.('close', () => failAll('route worker closed unexpectedly'));
    return worker = w;
}

// The plan from the service, or undefined when the service cannot answer (the caller plans with its own worker).
async function planByService(info: ServiceInfo, body: object, signal: AbortSignal | undefined): Promise<TripPlan | null | undefined> {
    let out: { plan?: TripPlan | null; error?: string };
    try {
        const res = await fetch(`http://127.0.0.1:${info.port}/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
        if (!res.ok) throw Error(`HTTP ${res.status}`);
        out = await res.json() as typeof out;
    } catch (error) {
        if (signal?.aborted) throw signal.reason;
        console.log(`ROUTE_SERVICE_SKIP ${JSON.stringify({ port: info.port, error: String((error as Error)?.message ?? error) })}`);
        markRouteServiceFailed(info);
        return undefined;
    }
    if (out.error) throw Error(`route worker: ${out.error}`);
    return out.plan ?? null;
}

export function planTripOffThread(from: Tile, to: Tile, acct: Account, stock?: BankStock, budgetMs?: number): Promise<TripPlan | null> {
    const signal = executionContext.getStore()?.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    // The search counts as pending route work from the service lookup on (a lookup can wait for a new service), until
    // the service answers or the plan goes to this process's own worker, which counts it from then.
    if (serviceWanted()) return (async () => {
        const plan = await trackRemoteRouteWork(async () => {
            const info = await discoverRouteService();
            if (signal?.aborted) throw signal.reason;
            return info ? await planByService(info, { from, to, acct, stock, budgetMs }, signal) : undefined;
        });
        return plan !== undefined ? plan : planLocally(from, to, acct, stock, budgetMs, signal);
    })();
    return planLocally(from, to, acct, stock, budgetMs, signal);
}

function planLocally(from: Tile, to: Tile, acct: Account, stock: BankStock | undefined, budgetMs: number | undefined, signal: AbortSignal | undefined): Promise<TripPlan | null> {
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
            started: performance.now(),
            resolve: plan => { cleanup(); resolve(plan); },
            reject: error => { cleanup(); reject(error); },
        });
        signal?.addEventListener('abort', abort, { once: true });
        const sharedAreas = workerSentAreas
            ? undefined
            : (globalThis as { __rsGetSharedLabels?: () => SharedLabels | null }).__rsGetSharedLabels?.() ?? undefined;
        try {
            w.postMessage({ id, from, to, acct: JSON.parse(JSON.stringify(acct)), stock, budgetMs, ...(sharedAreas ? { sharedAreas } : {}) });
            if (sharedAreas) workerSentAreas = true;
        }
        catch (error) { fail(error); }
    });
}
