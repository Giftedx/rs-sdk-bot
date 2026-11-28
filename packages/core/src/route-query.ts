// Lightweight HTTP query, discovery state, and shared off-thread route-worker transport for this checkout.
// Kept free of world/trip/danger/route-worker imports so world/pathfinding.ts and walk/* stay acyclic.
import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';
import type { ServiceInfo } from './route-service-client';

export type SdkFindPathResult = {
    success: boolean;
    waypoints: Array<{ x: number; z: number; level: number }>;
    reachedDestination?: boolean;
    error?: string;
};

export type RouteQueryBody = { kind: string; [key: string]: unknown };

// A live swarm worker (SWARM_LEASE_HOLDER) uses the host route service unless ROUTE_SERVICE=0; ROUTE_SERVICE=1 uses it anywhere.
export const serviceWanted = (env: Record<string, string | undefined> = process.env): boolean =>
    env.ROUTE_SERVICE === '1' || (env.ROUTE_SERVICE !== '0' && !!env.SWARM_LEASE_HOLDER);

// Shared host pools and route-service clients must never run synchronous in-process WASM pathfinding on the main event loop.
export const offThreadRouteWanted = (env: Record<string, string | undefined> = process.env): boolean =>
    serviceWanted(env) || Boolean(executionContext.getStore()?.log);

const SERVICE_RETRY_MS = 30_000, SERVICE_START_WAIT_MS = 5_000, QUERY_TIMEOUT_MS = 15_000;
let serviceDownUntil = 0, lastLaunch = -Infinity, failedService = '', remoteSeq = 0;
const remoteInFlight = new Map<number, number>();

// Bun workers have ref/unref: an idle worker does not keep the process alive.
type BunWorker = Worker & { ref(): void; unref(): void };
let worker: BunWorker | null = null, workerNext = 0, workerIdle: ReturnType<typeof setTimeout> | null = null, workerSentAreas = false;
// An idle worker holds a second pathfinder (about 800 MB per bot process); it closes this long after its last request.
export const WORKER_IDLE_MS = 30_000;
const workerPending = new Map<number, { started: number; resolve(v: any): void; reject(e: unknown): void }>();

export function pendingLocalRouteWork(youngerThanMs = Infinity): number {
    if (workerPending.size === 0 || youngerThanMs === Infinity) return workerPending.size;
    const now = performance.now();
    let count = 0;
    for (const p of workerPending.values()) if (now - p.started < youngerThanMs) count++;
    return count;
}

function stopWorker(w: BunWorker) {
    if (worker !== w) return;
    worker = null;
    workerSentAreas = false;
    if (workerIdle) clearTimeout(workerIdle);
    workerIdle = null;
    w.unref();
    void w.terminate();
}

function startWorker(): BunWorker {
    if (worker) return worker;
    // bunfig.toml preloads do not reach a Worker: it gets collision-lazy.ts itself (about 300 MB less heap).
    const w = new Worker(new URL('./route-worker.ts', import.meta.url).href, { preload: [new URL('./collision-lazy.ts', import.meta.url).href] } as WorkerOptions) as BunWorker;
    w.onmessage = (e: MessageEvent<{ id: number; plan?: unknown; result?: unknown; error?: string }>) => {
        if (worker !== w) return;
        const p = workerPending.get(e.data.id);
        if (!p) return;
        workerPending.delete(e.data.id);
        if (e.data.error) p.reject(Error(`route worker: ${e.data.error}`));
        else if ('result' in e.data) p.resolve(e.data.result);
        else p.resolve(e.data.plan ?? null);
        if (!workerPending.size) { w.unref(); workerIdle = setTimeout(() => { if (!workerPending.size) stopWorker(w); }, WORKER_IDLE_MS); (workerIdle as { unref?(): void }).unref?.(); }
    };
    const failAll = (reason: string) => {
        if (worker !== w) return;
        for (const p of workerPending.values()) p.reject(Error(reason));
        workerPending.clear();
        stopWorker(w);
    };
    w.onerror = (e: ErrorEvent) => failAll(`route worker failed: ${e.message}`);
    w.onmessageerror = () => failAll('route worker message unreadable');
    w.addEventListener?.('close', () => failAll('route worker closed unexpectedly'));
    return worker = w;
}

export function postToRouteWorker<T>(buildMsg: (id: number, sharedAreas: unknown) => object, signal: AbortSignal | undefined, attachSharedAreas = false): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (workerIdle) { clearTimeout(workerIdle); workerIdle = null; }
    const w = startWorker(), id = ++workerNext;
    w.ref();
    return new Promise<T>((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', abort);
        const fail = (error: unknown) => {
            if (!workerPending.delete(id)) return;
            cleanup();
            reject(error);
            if (!workerPending.size) stopWorker(w);
        };
        const abort = () => fail(signal?.reason);
        workerPending.set(id, {
            started: performance.now(),
            resolve: value => { cleanup(); resolve(value as T); },
            reject: error => { cleanup(); reject(error); },
        });
        signal?.addEventListener('abort', abort, { once: true });
        const sharedAreas = attachSharedAreas && !workerSentAreas
            ? (globalThis as { __rsGetSharedLabels?: () => unknown }).__rsGetSharedLabels?.() ?? undefined
            : undefined;
        try {
            w.postMessage(buildMsg(id, sharedAreas));
            if (sharedAreas) workerSentAreas = true;
        } catch (error) { fail(error); }
    });
}

export const serviceId = (i: ServiceInfo) => `${i.pid}:${i.port}:${i.started}`;

export function markRouteServiceFailed(info: ServiceInfo): void {
    serviceDownUntil = performance.now() + SERVICE_RETRY_MS;
    failedService = serviceId(info);
}

export function trackRemoteRouteWork<T>(fn: () => Promise<T>): Promise<T> {
    const id = ++remoteSeq;
    remoteInFlight.set(id, performance.now());
    return fn().finally(() => { remoteInFlight.delete(id); });
}

export function pendingRemoteRouteWork(youngerThanMs = Infinity): number {
    if (remoteInFlight.size === 0 || youngerThanMs === Infinity) return remoteInFlight.size;
    const now = performance.now();
    let count = 0;
    for (const started of remoteInFlight.values()) if (now - started < youngerThanMs) count++;
    return count;
}

export async function discoverRouteService(): Promise<ServiceInfo | null> {
    if (performance.now() < serviceDownUntil) return null;
    if (failedService) failedService = '';
    const [svc, { pathfindingDataKey }] = await Promise.all([import('./route-service-client'), import('./pathcache')]);
    const rev = svc.checkoutRev(), key = pathfindingDataKey();
    const find = () => {
        const i = svc.usableService(svc.readServiceInfo(), rev, key);
        return i && serviceId(i) !== failedService ? i : null;
    };
    let info = find();
    if (info || !rev) return info;
    // A live service of another commit or route data belongs to processes of newer code: this process does not
    // start one of its own and plans with its own worker until it restarts.
    const other = svc.readServiceInfo();
    if (other && serviceId(other) !== failedService && (other.rev !== rev || other.dataKey !== key) && svc.pidAlive(other.pid)) return null;
    if (performance.now() - lastLaunch < SERVICE_RETRY_MS) return null;
    lastLaunch = performance.now();
    svc.launchService();
    for (const end = performance.now() + SERVICE_START_WAIT_MS; !info && performance.now() < end;) {
        await Bun.sleep(100);
        info = find();
    }
    if (!info) serviceDownUntil = performance.now() + SERVICE_RETRY_MS;
    return info;
}

// Answers a single-plane path/harm/approach query through the host route service, or returns undefined when the
// service is disabled or unavailable so the caller falls back locally.
export async function queryRouteService<T>(body: RouteQueryBody, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T | undefined> {
    if (!serviceWanted()) return undefined;
    const callerSignal = opts.signal ?? executionContext.getStore()?.signal;
    if (callerSignal?.aborted) throw callerSignal.reason;
    return trackRemoteRouteWork(async () => {
        const info = await discoverRouteService();
        if (callerSignal?.aborted) throw callerSignal.reason;
        if (!info) return undefined;
        const timeout = AbortSignal.timeout(opts.timeoutMs ?? QUERY_TIMEOUT_MS);
        const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
        let out: { result?: T; error?: string };
        try {
            const res = await fetch(`http://127.0.0.1:${info.port}/query`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal,
            });
            if (!res.ok) throw Error(`HTTP ${res.status}`);
            out = await res.json() as typeof out;
        } catch (error) {
            if (callerSignal?.aborted) throw callerSignal.reason;
            console.log(`ROUTE_SERVICE_SKIP ${JSON.stringify({ port: info.port, kind: body.kind, error: String((error as Error)?.message ?? error) })}`);
            markRouteServiceFailed(info);
            return undefined;
        }
        if (out.error) throw Error(`route worker: ${out.error}`);
        return out.result;
    });
}

// Answers a single-plane path/harm/approach query through route-service when enabled, falling back to this process's
// off-thread route-worker.ts instead of synchronous in-process WASM on the caller's event loop.
export async function queryRouteOffThread<T>(body: RouteQueryBody, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const signal = opts.signal ?? executionContext.getStore()?.signal;
    if (signal?.aborted) throw signal.reason;
    if (serviceWanted()) {
        const remote = await queryRouteService<T>(body, opts);
        if (remote !== undefined) return remote;
    }
    return postToRouteWorker<T>(id => ({ ...body, id }), signal);
}
