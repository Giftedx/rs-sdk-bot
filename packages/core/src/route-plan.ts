// The bot side of route-worker.ts: one worker per process, shared by every bot in it (host mode included).
// Requests queue in the worker, so two bots planning at once wait their turn without blocking either game loop.
import type { BankStock, TripPlan } from './trip';
import type { Account, Tile } from './world-types';
import {
    WORKER_IDLE_MS, discoverRouteService, markRouteServiceFailed, offThreadRouteWanted, pendingLocalRouteWork,
    pendingRemoteRouteWork, postToRouteWorker, queryRouteOffThread, queryRouteService, serviceWanted,
    trackRemoteRouteWork,
} from './route-query';
import type { ServiceInfo } from './route-service-client';
import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';

export { WORKER_IDLE_MS, offThreadRouteWanted, queryRouteOffThread, queryRouteService, serviceWanted };

// The searches in flight that started under `youngerThanMs` ago. A lockstep bot holds its tick for these only: a
// search past the bound is hung and holds no tick, so one hung search costs a case one bound and not one bound for
// each later tick.
export const pendingRouteWork = (youngerThanMs = Infinity): number =>
    pendingLocalRouteWork(youngerThanMs) + pendingRemoteRouteWork(youngerThanMs);

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
    return postToRouteWorker<TripPlan | null>((id, sharedAreas) => ({
        id, from, to, acct: JSON.parse(JSON.stringify(acct)), stock, budgetMs, ...(sharedAreas ? { sharedAreas } : {}),
    }), signal, true);
}
