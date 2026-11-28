// One route and pathfinding service for every bot process of this checkout. Each bot process otherwise loads its own
// rsmod WASM collision grid (250-350 MB private) and starts its own route worker (470 MB private). This process holds
// one warm worker (plus overflow workers on demand, reaped when idle) and answers trip plans (/plan) and lightweight
// single-plane walk/SDK/harm/approach queries (/query) over HTTP on 127.0.0.1. A bot process finds it by SERVICE_FILE;
// with no live service of the same commit and route data it falls back locally.
// Usage: bun packages/core/src/route-service.ts [--workers N] [--idle-ms N]   (run in the foreground)
//        bun packages/core/src/route-service.ts --launch                       (start one detached service, then exit)
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { renameRetry } from './atomic-file';
import { cachedMapAreas, shareLabels, type SharedLabels } from './components';
import { pathfindingDataKey } from './pathcache';
import {
    SERVICE_FILE, checkoutRev, clearCheckoutRevMemo, launchService, pidAlive, readServiceInfo, routeServiceEnv,
    usableService, type ServiceInfo,
} from './route-service-client';
import type { PlanRequest, RouteQuery } from './route-worker';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
export { SERVICE_FILE, checkoutRev, launchService, pidAlive, readServiceInfo, routeServiceEnv, usableService, type ServiceInfo };
export const SERVICE_LOG = join(repoRoot, '.practice', 'route-service', 'service.log');
// Two workers: one cold search (up to about a minute) does not hold every other bot's plan or walk query.
// Overflow workers (slot >= 1) open only when work waits past DEFAULT_OVERFLOW_DELAY_MS and close after
// OVERFLOW_WORKER_IDLE_MS idle. Slot 0 also closes after PRIMARY_WORKER_IDLE_MS idle or when idle above
// DEFAULT_RECYCLE_RSS_BYTES so long-lived services drop accumulated native/WASM/danger memory without dropping requests.
export const DEFAULT_WORKERS = 2;
export const OVERFLOW_WORKER_IDLE_MS = 30_000;
export const DEFAULT_OVERFLOW_DELAY_MS = 1_500;
export const PRIMARY_WORKER_IDLE_MS = 5 * 60_000;
export const DEFAULT_RECYCLE_RSS_BYTES = 512 * 1024 * 1024;
// The service stops this long after its last request, so a host with no walking bots holds no route workers.
export const DEFAULT_IDLE_MS = 15 * 60_000;
const REV_POLL_MS = 30_000;
const QUERY_KINDS = new Set(['sdk-find-path', 'walk-plan', 'walk-danger', 'route-exposure', 'approach']);

export type ServicePlan = Omit<PlanRequest, 'id' | 'sharedAreas'>;
export type ServiceQuery = RouteQuery;
// One launch at a time for each checkout: the launcher creates the lock with the exclusive flag, and the service it
// starts removes it once its record is written. A lock older than LAUNCH_LOCK_MS (a service that died while it
// started) is removed and taken again. Bots that ask together therefore start one service, not one each.
export const LAUNCH_LOCK_MS = 60_000;
export function claimLaunch(lock = `${SERVICE_FILE}.lock`, now = Date.now()): boolean {
    mkdirSync(dirname(lock), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(lock, 'wx');
            try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now })); } finally { closeSync(fd); }
            return true;
        } catch (e) {
            if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') return false;
            let seen = '', at = now;
            try { seen = readFileSync(lock, 'utf8'); at = (JSON.parse(seen) as { at: number }).at; } catch { at = 0; }
            if (now - at < LAUNCH_LOCK_MS) return false;
            // Only the stale lock that was read is removed, never a newer launcher's.
            try { if (readFileSync(lock, 'utf8') === seen) unlinkSync(lock); } catch { /* gone */ }
        }
    }
    return false;
}
function launchDetached(): void {
    mkdirSync(dirname(SERVICE_LOG), { recursive: true });
    const out = openSync(SERVICE_LOG, 'a');
    try { spawn(process.execPath, ['--smol', import.meta.path], { cwd: repoRoot, detached: true, windowsHide: true, stdio: ['ignore', out, out], env: routeServiceEnv(process.env) }).unref(); }
    finally { closeSync(out); }
}

type WorkerReply = { id: number; plan?: unknown; result?: unknown; error?: string };
type QueuedRequest = { msg: object; attachAreas: boolean; resolve(m: { plan?: unknown; result?: unknown; error?: string }): void };
type Slot = {
    w: Worker;
    pending: Map<number, { resolve(m: { plan?: unknown; result?: unknown; error?: string }): void }>;
    sentAreas: boolean;
    idleTimer: ReturnType<typeof setTimeout> | null;
};

export type WorkerPoolOptions = {
    overflowIdleMs?: number;
    overflowDelayMs?: number;
    primaryIdleMs?: number;
    recycleRssBytes?: number;
    rssBytes?: () => number;
    sharedAreas?: () => SharedLabels | null;
};

// The pool: steady-state load stays on slot 0. When `overflowDelayMs` > 0 and slot 0 is busy while overflow slots
// are closed, requests wait in a FIFO queue up to `overflowDelayMs` before opening an overflow worker, so short
// concurrent bursts avoid committing a second ~250 MB WASM worker. Overflow workers terminate after `overflowIdleMs`
// idle; slot 0 terminates after `primaryIdleMs` idle or when idle above `recycleRssBytes`.
export function workerPool(
    size: number,
    make: () => Worker = () => new Worker(new URL('./route-worker.ts', import.meta.url).href, { preload: [new URL('./collision-lazy.ts', import.meta.url).href] } as WorkerOptions),
    opts: WorkerPoolOptions = {},
) {
    const overflowIdleMs = opts.overflowIdleMs ?? OVERFLOW_WORKER_IDLE_MS;
    const overflowDelayMs = Math.max(0, opts.overflowDelayMs ?? 0);
    const primaryIdleMs = Math.max(0, opts.primaryIdleMs ?? 0);
    const recycleRssBytes = Math.max(0, opts.recycleRssBytes ?? 0);
    const readRss = opts.rssBytes ?? (() => process.memoryUsage().rss);
    const getSharedAreas = opts.sharedAreas;
    const slots: (Slot | null)[] = Array.from({ length: size }, () => null);
    const queue: QueuedRequest[] = [];
    let overflowTimer: ReturnType<typeof setTimeout> | null = null;
    let next = 0;
    const clearOverflowTimer = () => {
        if (overflowTimer) { clearTimeout(overflowTimer); overflowTimer = null; }
    };
    const clearIdle = (slot: Slot) => {
        if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
    };
    const reclaimAfterTerminate = () => {
        const gc = (globalThis as { Bun?: { gc?: (sync?: boolean) => void } }).Bun?.gc;
        if (!gc) return;
        const t = setTimeout(() => { gc(true); }, 50);
        (t as { unref?(): void }).unref?.();
    };
    const closeSlot = (i: number, slot: Slot) => {
        if (slots[i] !== slot) return;
        clearIdle(slot);
        slots[i] = null;
        void slot.w.terminate();
        reclaimAfterTerminate();
    };
    const scheduleIdle = (i: number, slot: Slot) => {
        const delay = i === 0 ? primaryIdleMs : overflowIdleMs;
        if (delay <= 0 || slot.pending.size > 0) return;
        clearIdle(slot);
        slot.idleTimer = setTimeout(() => {
            if (slots[i] === slot && slot.pending.size === 0) closeSlot(i, slot);
        }, delay);
        (slot.idleTimer as { unref?(): void }).unref?.();
    };
    const sendToSlot = (i: number, slot: Slot, req: QueuedRequest) => {
        const id = ++next;
        clearIdle(slot);
        const sharedAreas = req.attachAreas && !slot.sentAreas ? getSharedAreas?.() ?? undefined : undefined;
        slot.pending.set(id, { resolve: req.resolve });
        try {
            slot.w.postMessage(sharedAreas ? { ...req.msg, id, sharedAreas } : { ...req.msg, id });
            if (sharedAreas) slot.sentAreas = true;
        } catch (error) {
            slot.pending.delete(id);
            scheduleIdle(i, slot);
            req.resolve({ error: String(error) });
        }
    };
    const armOverflowTimer = () => {
        if (overflowTimer || overflowDelayMs <= 0 || queue.length === 0) return;
        const closedIdx = slots.findIndex((s, i) => i > 0 && s === null);
        if (closedIdx < 0) return;
        overflowTimer = setTimeout(() => {
            overflowTimer = null;
            drain(true);
        }, overflowDelayMs);
        (overflowTimer as { unref?(): void }).unref?.();
    };
    const pickImmediateSlot = (allowOverflowOpen: boolean): number => {
        // Prefer an already-open idle slot (slot 0 first), then opening slot 0, then least-loaded open/allowed slot.
        if (slots[0] === null) return 0;
        if (slots[0].pending.size === 0) return 0;
        for (let i = 1; i < size; i++) if (slots[i] && slots[i]!.pending.size === 0) return i;
        if (allowOverflowOpen) {
            let best = 0;
            for (let i = 1; i < size; i++) if ((slots[i]?.pending.size ?? 0) < (slots[best]?.pending.size ?? 0)) best = i;
            return best;
        }
        return -1;
    };
    const drain = (allowOverflowOpen: boolean) => {
        while (queue.length > 0) {
            const idx = pickImmediateSlot(allowOverflowOpen);
            if (idx < 0) {
                armOverflowTimer();
                return;
            }
            const req = queue.shift()!;
            const slot = slots[idx] ?? open(idx);
            sendToSlot(idx, slot, req);
            // Open at most one overflow worker per timer firing; re-arm if more closed slots remain.
            allowOverflowOpen = overflowDelayMs === 0;
        }
        clearOverflowTimer();
    };
    const open = (i: number): Slot => {
        const slot: Slot = { w: make(), pending: new Map(), sentAreas: false, idleTimer: null };
        const fail = (reason: string) => {
            if (slots[i] !== slot) return;
            clearIdle(slot);
            slots[i] = null;
            for (const p of slot.pending.values()) p.resolve({ error: reason });
            slot.pending.clear();
            void slot.w.terminate();
            reclaimAfterTerminate();
            if (queue.length > 0) drain(overflowDelayMs === 0);
        };
        slot.w.onmessage = (e: MessageEvent<WorkerReply>) => {
            const p = slot.pending.get(e.data.id);
            if (!p) return;
            slot.pending.delete(e.data.id);
            if (e.data.error) p.resolve({ error: e.data.error });
            else if ('result' in e.data) p.resolve({ result: e.data.result });
            else p.resolve({ plan: e.data.plan ?? null });
            if (queue.length > 0) {
                const nextReq = queue.shift()!;
                if (queue.length === 0) clearOverflowTimer();
                sendToSlot(i, slot, nextReq);
                return;
            }
            if (slot.pending.size === 0 && recycleRssBytes > 0 && readRss() > recycleRssBytes) {
                closeSlot(i, slot);
                return;
            }
            scheduleIdle(i, slot);
        };
        slot.w.onerror = (e: ErrorEvent) => fail(`route worker failed: ${e.message}`);
        slot.w.onmessageerror = () => fail('route worker message unreadable');
        return slots[i] = slot;
    };
    const dispatch = (msg: object, attachAreas: boolean): Promise<{ plan?: unknown; result?: unknown; error?: string }> => {
        return new Promise(resolve => {
            const req: QueuedRequest = { msg, attachAreas, resolve };
            const idx = pickImmediateSlot(overflowDelayMs === 0);
            if (idx >= 0) {
                sendToSlot(idx, slots[idx] ?? open(idx), req);
                return;
            }
            queue.push(req);
            armOverflowTimer();
        });
    };
    return {
        plan(req: ServicePlan): Promise<{ plan?: unknown; error?: string }> {
            return dispatch(req, true);
        },
        query(req: ServiceQuery): Promise<{ result?: unknown; error?: string }> {
            return dispatch(req, false);
        },
        inFlight: () => slots.reduce((n, s) => n + (s?.pending.size ?? 0), 0) + queue.length,
        activeWorkers: () => slots.reduce((n, s) => n + (s ? 1 : 0), 0),
        stop: () => {
            clearOverflowTimer();
            while (queue.length > 0) queue.shift()!.resolve({ error: 'route service stopped' });
            for (let i = 0; i < slots.length; i++) if (slots[i]) closeSlot(i, slots[i]!);
        },
    };
}

// Bun.serve (1.4.5, Windows) closes a connection that receives no byte for 30 s, with idleTimeout 0 or 255, and a
// cold plan can search for longer. The client then saw ECONNRESET and planned again with its own route worker (about
// 700 MB more and the whole search again: 112 s for one prewarm walk). The answer starts at once, and a space goes out
// every HEARTBEAT_MS until the plan is there. JSON.parse skips the leading spaces.
export const HEARTBEAT_MS = 10_000;
export function planResponse(plan: Promise<unknown>, heartbeatMs = HEARTBEAT_MS): Response {
    const space = new Uint8Array([0x20]);
    return new Response(new ReadableStream<Uint8Array>({
        async start(c) {
            const beat = setInterval(() => { try { c.enqueue(space); } catch { /* the client left */ } }, heartbeatMs);
            let text: string;
            try { text = JSON.stringify(await plan); } catch (error) { text = JSON.stringify({ error: String(error) }); } finally { clearInterval(beat); }
            try { c.enqueue(new TextEncoder().encode(text)); c.close(); } catch { /* the client left */ }
        },
    }), { headers: { 'content-type': 'application/json' } });
}

export const DEFAULT_QUERY_WORKERS = 2;
export const DEFAULT_QUERY_OVERFLOW_DELAY_MS = 500;

export function serveRoutes(opts: { workers?: number; queryWorkers?: number; idleMs?: number; overflowIdleMs?: number; overflowDelayMs?: number; primaryIdleMs?: number; recycleRssBytes?: number; file?: string; onStop?: () => void; makeWorker?: () => Worker } = {}) {
    const workers = opts.workers ?? DEFAULT_WORKERS, idleMs = opts.idleMs ?? DEFAULT_IDLE_MS, file = opts.file ?? SERVICE_FILE;
    const queryWorkers = opts.queryWorkers ?? Math.min(DEFAULT_QUERY_WORKERS, Math.max(1, workers));
    const sharedAreas = opts.makeWorker ? undefined : () => {
        const labels = cachedMapAreas(repoRoot);
        return labels ? shareLabels(labels) : null;
    };
    const pool = workerPool(workers, opts.makeWorker, {
        overflowIdleMs: opts.overflowIdleMs,
        overflowDelayMs: opts.overflowDelayMs ?? (opts.makeWorker ? 0 : DEFAULT_OVERFLOW_DELAY_MS),
        primaryIdleMs: opts.primaryIdleMs ?? (opts.makeWorker ? 0 : PRIMARY_WORKER_IDLE_MS),
        recycleRssBytes: opts.recycleRssBytes ?? (opts.makeWorker ? 0 : DEFAULT_RECYCLE_RSS_BYTES),
        sharedAreas,
    });
    // Dedicated lightweight pool for single-plane /query requests (walk-plan, walk-danger, sdk-find-path, approach,
    // route-exposure) so fast queries never head-of-line block behind slow multi-plane /plan searches.
    const queryPool = workerPool(queryWorkers, opts.makeWorker, {
        overflowIdleMs: opts.overflowIdleMs,
        overflowDelayMs: opts.makeWorker ? 0 : DEFAULT_QUERY_OVERFLOW_DELAY_MS,
        primaryIdleMs: opts.primaryIdleMs ?? (opts.makeWorker ? 0 : PRIMARY_WORKER_IDLE_MS),
        recycleRssBytes: opts.recycleRssBytes ?? (opts.makeWorker ? 0 : DEFAULT_RECYCLE_RSS_BYTES),
    });
    let last = Date.now(), served = 0;
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        idleTimeout: 0,
        async fetch(req) {
            const url = new URL(req.url);
            if (req.method === 'GET' && url.pathname === '/health') {
                return Response.json({
                    ...info,
                    inFlight: pool.inFlight() + queryPool.inFlight(),
                    planInFlight: pool.inFlight(),
                    queryInFlight: queryPool.inFlight(),
                    activeWorkers: pool.activeWorkers() + queryPool.activeWorkers(),
                    served,
                });
            }
            if (req.method === 'POST' && url.pathname === '/plan') {
                let body: ServicePlan;
                try { body = await req.json() as ServicePlan; } catch { return new Response('bad request', { status: 400 }); }
                if (!body?.from || !body?.to || !body?.acct) return new Response('bad request', { status: 400 });
                last = Date.now();
                return planResponse(pool.plan(body).then(out => { last = Date.now(); served++; return out; }));
            }
            if (req.method === 'POST' && url.pathname === '/query') {
                let body: ServiceQuery;
                try { body = await req.json() as ServiceQuery; } catch { return new Response('bad request', { status: 400 }); }
                if (!body?.kind || !QUERY_KINDS.has(body.kind)) return new Response('bad request', { status: 400 });
                last = Date.now();
                const out = await queryPool.query(body);
                last = Date.now();
                served++;
                return Response.json(out);
            }
            return new Response('not found', { status: 404 });
        },
    });
    const info: ServiceInfo = { pid: process.pid, port: server.port!, rev: checkoutRev(), dataKey: pathfindingDataKey(), workers, started: Date.now() };
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(info));
    renameRetry(tmp, file);
    // The record is there: the next launcher finds this service, so the launch lock is released.
    try { unlinkSync(`${file}.lock`); } catch { /* none */ }
    console.log(`ROUTE_SERVICE_START ${JSON.stringify(info)}`);
    let stopped = false;
    const stop = (why: string) => {
        if (stopped) return;
        stopped = true;
        console.log(`ROUTE_SERVICE_STOP ${JSON.stringify({ pid: process.pid, why, served })}`);
        clearInterval(timer);
        pool.stop();
        queryPool.stop();
        server.stop(true);
        // Only this service's own record is removed: a newer service may have written the file.
        if (readServiceInfo(file)?.pid === process.pid) try { unlinkSync(file); } catch { /* gone */ }
        opts.onStop?.();
    };
    const timer = setInterval(() => {
        if (readServiceInfo(file)?.pid !== process.pid) return stop('another service owns the record');
        if (pool.inFlight() === 0 && queryPool.inFlight() === 0 && Date.now() - last > idleMs) return stop('idle');
        clearCheckoutRevMemo();
        if (checkoutRev() !== info.rev) return stop('checkout moved to another commit');
    }, Math.min(REV_POLL_MS, idleMs));
    return { info, stop, pool, queryPool };
}

if (import.meta.main) {
    const args = process.argv.slice(2), arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : undefined; };
    if (args.includes('--launch')) {
        // One service for each checkout: a live one of this commit and route data that answers is kept. A record of a
        // killed service whose pid another process has now does not answer.
        const found = usableService(readServiceInfo(), checkoutRev(), pathfindingDataKey());
        const answers = found ? await fetch(`http://127.0.0.1:${found.port}/health`, { signal: AbortSignal.timeout(2_000) }).then(r => r.ok, () => false) : false;
        if (!answers && claimLaunch()) launchDetached();
        process.exit(0);
    }
    const recycleMb = arg('--recycle-rss-mb');
    const s = serveRoutes({
        workers: arg('--workers'),
        idleMs: arg('--idle-ms'),
        overflowIdleMs: arg('--overflow-idle-ms'),
        overflowDelayMs: arg('--overflow-delay-ms'),
        primaryIdleMs: arg('--primary-idle-ms'),
        recycleRssBytes: recycleMb !== undefined ? recycleMb * 1024 * 1024 : undefined,
        onStop: () => process.exit(0),
    });
    const end = () => s.stop('signal');
    process.on('SIGINT', end);
    process.on('SIGTERM', end);
}
