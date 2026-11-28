// Lightweight HTTP query and discovery state for the checkout's shared route-service.ts process.
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
