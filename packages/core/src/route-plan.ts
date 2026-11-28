// The bot side of route-worker.ts: one worker per process, shared by every bot in it (host mode included).
// Requests queue in the worker, so two bots planning at once wait their turn without blocking either game loop.
import type { BankStock, TripPlan } from './trip';
import type { Account, Tile } from './world-types';
import type { SharedLabels } from './components';
import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';

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
    if (pending.size + remote.size === 0 || youngerThanMs === Infinity) return pending.size + remote.size;
    const now = performance.now();
    let count = 0;
    for (const p of pending.values()) if (now - p.started < youngerThanMs) count++;
    for (const started of remote.values()) if (now - started < youngerThanMs) count++;
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

// The host route service (route-service.ts): one pool of route workers for every bot process of this checkout. A
// live swarm worker (SWARM_LEASE_HOLDER) uses it unless ROUTE_SERVICE=0; ROUTE_SERVICE=1 uses it anywhere. A process
// with no usable service starts one and waits for it a short time; a service that does not answer is skipped for a
// while, and the plan goes to this process's own worker as before.
export const serviceWanted = (env: Record<string, string | undefined> = process.env): boolean =>
    env.ROUTE_SERVICE === '1' || (env.ROUTE_SERVICE !== '0' && !!env.SWARM_LEASE_HOLDER);
const SERVICE_RETRY_MS = 30_000, SERVICE_START_WAIT_MS = 5_000;
let serviceDownUntil = 0, lastLaunch = -Infinity, failedService = '';
const remote = new Map<number, number>();
type ServiceInfo = import('./route-service').ServiceInfo;
const serviceId = (i: ServiceInfo) => `${i.pid}:${i.port}:${i.started}`;
async function routeService(): Promise<ServiceInfo | null> {
    if (performance.now() < serviceDownUntil) return null;
    const [svc, { pathfindingDataKey }] = await Promise.all([import('./route-service'), import('./pathcache')]);
    // A service that failed to answer is not used again: its record may name a pid that another process has now.
    const rev = svc.checkoutRev(), key = pathfindingDataKey(), find = () => { const i = svc.usableService(svc.readServiceInfo(), rev, key); return i && serviceId(i) !== failedService ? i : null; };
    let info = find();
    if (info || !rev) return info;
    // A live service of another commit or route data belongs to processes of newer code: this process does not
    // start one of its own and plans with its own worker until it restarts.
    const other = svc.readServiceInfo();
    if (other && serviceId(other) !== failedService && (other.rev !== rev || other.dataKey !== key) && svc.pidAlive(other.pid)) return null;
    if (performance.now() - lastLaunch < SERVICE_RETRY_MS) return null;
    lastLaunch = performance.now();
    svc.launchService();
    for (const end = performance.now() + SERVICE_START_WAIT_MS; !info && performance.now() < end;) { await Bun.sleep(100); info = find(); }
    if (!info) serviceDownUntil = performance.now() + SERVICE_RETRY_MS;
    return info;
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
        serviceDownUntil = performance.now() + SERVICE_RETRY_MS;
        failedService = serviceId(info);
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
        const id = ++next;
        remote.set(id, performance.now());
        let plan: TripPlan | null | undefined;
        try {
            const info = await routeService();
            if (signal?.aborted) throw signal.reason;
            plan = info ? await planByService(info, { from, to, acct, stock, budgetMs }, signal) : undefined;
        } finally { remote.delete(id); }
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
