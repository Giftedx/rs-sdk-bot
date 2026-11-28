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
// Overflow workers (slot >= 1) open only on concurrency spikes and close after OVERFLOW_WORKER_IDLE_MS idle.
export const DEFAULT_WORKERS = 2;
export const OVERFLOW_WORKER_IDLE_MS = 60_000;
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
    try { spawn(process.execPath, [import.meta.path], { cwd: repoRoot, detached: true, windowsHide: true, stdio: ['ignore', out, out], env: routeServiceEnv(process.env) }).unref(); }
    finally { closeSync(out); }
}

type WorkerReply = { id: number; plan?: unknown; result?: unknown; error?: string };
type Slot = {
    w: Worker;
    pending: Map<number, { resolve(m: { plan?: unknown; result?: unknown; error?: string }): void }>;
    sentAreas: boolean;
    idleTimer: ReturnType<typeof setTimeout> | null;
};

// The pool: each request goes to the worker with the fewest requests in flight (preferring slot 0 so steady-state
// load keeps one worker warm). Overflow workers (slot >= 1) terminate after `overflowIdleMs` idle so momentary bursts
// do not pin a second WASM + world-graph worker forever. A failed worker fails its requests and is replaced on demand.
export function workerPool(
    size: number,
    make: () => Worker = () => new Worker(new URL('./route-worker.ts', import.meta.url).href, { preload: [new URL('./collision-lazy.ts', import.meta.url).href] } as WorkerOptions),
    opts: { overflowIdleMs?: number; sharedAreas?: () => SharedLabels | null } = {},
) {
    const overflowIdleMs = opts.overflowIdleMs ?? OVERFLOW_WORKER_IDLE_MS;
    const getSharedAreas = opts.sharedAreas;
    const slots: (Slot | null)[] = Array.from({ length: size }, () => null);
    let next = 0;
    const clearIdle = (slot: Slot) => {
        if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
    };
    const closeSlot = (i: number, slot: Slot) => {
        if (slots[i] !== slot) return;
        clearIdle(slot);
        slots[i] = null;
        void slot.w.terminate();
    };
    const scheduleOverflowIdle = (i: number, slot: Slot) => {
        if (i === 0 || overflowIdleMs <= 0 || slot.pending.size > 0) return;
        clearIdle(slot);
        slot.idleTimer = setTimeout(() => {
            if (slots[i] === slot && slot.pending.size === 0) closeSlot(i, slot);
        }, overflowIdleMs);
        (slot.idleTimer as { unref?(): void }).unref?.();
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
        };
        slot.w.onmessage = (e: MessageEvent<WorkerReply>) => {
            const p = slot.pending.get(e.data.id);
            if (!p) return;
            slot.pending.delete(e.data.id);
            if (e.data.error) p.resolve({ error: e.data.error });
            else if ('result' in e.data) p.resolve({ result: e.data.result });
            else p.resolve({ plan: e.data.plan ?? null });
            scheduleOverflowIdle(i, slot);
        };
        slot.w.onerror = (e: ErrorEvent) => fail(`route worker failed: ${e.message}`);
        slot.w.onmessageerror = () => fail('route worker message unreadable');
        return slots[i] = slot;
    };
    const dispatch = (msg: object, attachAreas: boolean): Promise<{ plan?: unknown; result?: unknown; error?: string }> => {
        let best = 0;
        for (let i = 1; i < size; i++) if ((slots[i]?.pending.size ?? 0) < (slots[best]?.pending.size ?? 0)) best = i;
        const slot = slots[best] ?? open(best), id = ++next;
        clearIdle(slot);
        const sharedAreas = attachAreas && !slot.sentAreas ? getSharedAreas?.() ?? undefined : undefined;
        return new Promise(resolve => {
            slot.pending.set(id, { resolve });
            try {
                slot.w.postMessage(sharedAreas ? { ...msg, id, sharedAreas } : { ...msg, id });
                if (sharedAreas) slot.sentAreas = true;
            } catch (error) {
                slot.pending.delete(id);
                scheduleOverflowIdle(best, slot);
                resolve({ error: String(error) });
            }
        });
    };
    return {
        plan(req: ServicePlan): Promise<{ plan?: unknown; error?: string }> {
            return dispatch(req, true);
        },
        query(req: ServiceQuery): Promise<{ result?: unknown; error?: string }> {
            return dispatch(req, false);
        },
        inFlight: () => slots.reduce((n, s) => n + (s?.pending.size ?? 0), 0),
        activeWorkers: () => slots.reduce((n, s) => n + (s ? 1 : 0), 0),
        stop: () => { for (let i = 0; i < slots.length; i++) if (slots[i]) closeSlot(i, slots[i]!); },
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

export function serveRoutes(opts: { workers?: number; idleMs?: number; overflowIdleMs?: number; file?: string; onStop?: () => void; makeWorker?: () => Worker } = {}) {
    const workers = opts.workers ?? DEFAULT_WORKERS, idleMs = opts.idleMs ?? DEFAULT_IDLE_MS, file = opts.file ?? SERVICE_FILE;
    const sharedAreas = opts.makeWorker ? undefined : () => {
        const labels = cachedMapAreas(repoRoot);
        return labels ? shareLabels(labels) : null;
    };
    const pool = workerPool(workers, opts.makeWorker, { overflowIdleMs: opts.overflowIdleMs, sharedAreas });
    let last = Date.now(), served = 0;
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        idleTimeout: 0,
        async fetch(req) {
            const url = new URL(req.url);
            if (req.method === 'GET' && url.pathname === '/health') {
                return Response.json({ ...info, inFlight: pool.inFlight(), activeWorkers: pool.activeWorkers(), served });
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
                const out = await pool.query(body);
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
        server.stop(true);
        // Only this service's own record is removed: a newer service may have written the file.
        if (readServiceInfo(file)?.pid === process.pid) try { unlinkSync(file); } catch { /* gone */ }
        opts.onStop?.();
    };
    const timer = setInterval(() => {
        if (readServiceInfo(file)?.pid !== process.pid) return stop('another service owns the record');
        if (pool.inFlight() === 0 && Date.now() - last > idleMs) return stop('idle');
        clearCheckoutRevMemo();
        if (checkoutRev() !== info.rev) return stop('checkout moved to another commit');
    }, Math.min(REV_POLL_MS, idleMs));
    return { info, stop, pool };
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
    const s = serveRoutes({ workers: arg('--workers'), idleMs: arg('--idle-ms'), overflowIdleMs: arg('--overflow-idle-ms'), onStop: () => process.exit(0) });
    const end = () => s.stop('signal');
    process.on('SIGINT', end);
    process.on('SIGTERM', end);
}
