// The bot side of route-worker.ts: one worker per process, shared by every bot in it (host mode included).
// Requests queue in the worker, so two bots planning at once wait their turn without blocking either game loop.
import type { BankStock, TripPlan } from './trip';
import type { Account, Tile } from './world';

// Bun workers have ref/unref: an idle worker does not keep the process alive.
type BunWorker = Worker & { ref(): void; unref(): void };
let worker: BunWorker | null = null, next = 0;
const pending = new Map<number, { resolve(p: TripPlan | null): void; reject(e: Error): void }>();

function start(): BunWorker {
    if (worker) return worker;
    const w = new Worker(new URL('./route-worker.ts', import.meta.url).href) as BunWorker;
    w.onmessage = (e: MessageEvent<{ id: number; plan?: TripPlan | null; error?: string }>) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.error) p.reject(Error(`route worker: ${e.data.error}`)); else p.resolve(e.data.plan ?? null);
        if (!pending.size) w.unref();
    };
    w.onerror = (e: ErrorEvent) => { for (const p of pending.values()) p.reject(Error(`route worker failed: ${e.message}`)); pending.clear(); worker = null; };
    return worker = w;
}

export function planTripOffThread(from: Tile, to: Tile, acct: Account, stock?: BankStock): Promise<TripPlan | null> {
    const w = start(), id = ++next;
    w.ref();
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage({ id, from, to, acct: JSON.parse(JSON.stringify(acct)), stock });
    });
}
