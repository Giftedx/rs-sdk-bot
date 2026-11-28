// One route planner for every bot process of this checkout. Each bot process otherwise starts its own route worker
// (route-plan.ts) for each walk plan: about 470 MB of private memory while it lives, and about 1 s to restore the grid
// each time it starts again after 30 s idle (scripts/measure/solo-route-memory.ts). This process holds a small pool of
// the same route workers (route-worker.ts) and answers the same plan requests over HTTP on 127.0.0.1. A bot process
// finds it by SERVICE_FILE; with no live service of the same commit and route data it plans with its own worker.
// Usage: bun packages/core/src/route-service.ts [--workers N] [--idle-ms N]   (run in the foreground)
//        bun packages/core/src/route-service.ts --launch                       (start one detached service, then exit)
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { renameRetry } from './atomic-file';
import { pathfindingDataKey } from './pathcache';
import type { PlanRequest } from './route-worker';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
export const SERVICE_FILE = join(repoRoot, '.practice', 'cache', 'route-service.json');
export const SERVICE_LOG = join(repoRoot, '.practice', 'route-service', 'service.log');
// Two workers: one cold search (up to about a minute) does not hold every other bot's plan.
export const DEFAULT_WORKERS = 2;
// The service stops this long after its last request, so a host with no walking bots holds no route workers.
export const DEFAULT_IDLE_MS = 15 * 60_000;
const REV_POLL_MS = 30_000;

export type ServiceInfo = { pid: number; port: number; rev: string; dataKey: string; workers: number; started: number };
export type ServicePlan = Omit<PlanRequest, 'id' | 'sharedAreas'>;

// The commit of this checkout. A service of another commit plans with other code, so a bot does not use it.
let revMemo: string | null = null;
export function checkoutRev(root = repoRoot): string {
    if (root === repoRoot && revMemo !== null) return revMemo;
    const r = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const rev = r.status === 0 ? r.stdout.trim() : '';
    if (root === repoRoot) revMemo = rev;
    return rev;
}

export const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code === 'EPERM'; } };

export function readServiceInfo(file = SERVICE_FILE): ServiceInfo | null {
    try {
        const v = JSON.parse(readFileSync(file, 'utf8')) as ServiceInfo;
        return Number.isInteger(v?.pid) && Number.isInteger(v?.port) && typeof v.rev === 'string' && typeof v.dataKey === 'string' ? v : null;
    } catch { return null; }
}

// The info of a live service that plans with this process's code and route data, or null.
export function usableService(info: ServiceInfo | null, rev: string, dataKey: string, alive = pidAlive): ServiceInfo | null {
    return info && rev && info.rev === rev && info.dataKey === dataKey && alive(info.pid) ? info : null;
}

// Starts one detached service through a launcher that exits at once. The service's parent is then a dead process, so
// a tree kill of the bot that asked for it (taskkill /T) does not stop the service that other bots use.
export function launchService(root = repoRoot): void {
    spawn(process.execPath, [join(root, 'packages', 'core', 'src', 'route-service.ts'), '--launch'], { cwd: root, detached: true, windowsHide: true, stdio: 'ignore', env: process.env }).unref();
}
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
    try { spawn(process.execPath, [import.meta.path], { cwd: repoRoot, detached: true, windowsHide: true, stdio: ['ignore', out, out], env: process.env }).unref(); }
    finally { closeSync(out); }
}

type Slot = { w: Worker; pending: Map<number, { resolve(m: { plan?: unknown; error?: string }): void }> };

// The pool: each request goes to the worker with the fewest requests in flight. A failed worker fails its requests
// and is replaced at the next request.
export function workerPool(size: number, make: () => Worker = () => new Worker(new URL('./route-worker.ts', import.meta.url).href, { preload: [new URL('./collision-lazy.ts', import.meta.url).href] } as WorkerOptions)) {
    const slots: (Slot | null)[] = Array.from({ length: size }, () => null);
    let next = 0;
    const open = (i: number): Slot => {
        const slot: Slot = { w: make(), pending: new Map() };
        const fail = (reason: string) => {
            if (slots[i] !== slot) return;
            slots[i] = null;
            for (const p of slot.pending.values()) p.resolve({ error: reason });
            slot.pending.clear();
            void slot.w.terminate();
        };
        slot.w.onmessage = (e: MessageEvent<{ id: number; plan?: unknown; error?: string }>) => {
            const p = slot.pending.get(e.data.id);
            if (!p) return;
            slot.pending.delete(e.data.id);
            p.resolve(e.data.error ? { error: e.data.error } : { plan: e.data.plan ?? null });
        };
        slot.w.onerror = (e: ErrorEvent) => fail(`route worker failed: ${e.message}`);
        slot.w.onmessageerror = () => fail('route worker message unreadable');
        return slots[i] = slot;
    };
    return {
        plan(req: ServicePlan): Promise<{ plan?: unknown; error?: string }> {
            let best = 0;
            for (let i = 1; i < size; i++) if ((slots[i]?.pending.size ?? 0) < (slots[best]?.pending.size ?? 0)) best = i;
            const slot = slots[best] ?? open(best), id = ++next;
            return new Promise(resolve => {
                slot.pending.set(id, { resolve });
                try { slot.w.postMessage({ ...req, id }); }
                catch (error) { slot.pending.delete(id); resolve({ error: String(error) }); }
            });
        },
        inFlight: () => slots.reduce((n, s) => n + (s?.pending.size ?? 0), 0),
        stop: () => { for (const s of slots) void s?.w.terminate(); },
    };
}

export function serveRoutes(opts: { workers?: number; idleMs?: number; file?: string; onStop?: () => void; makeWorker?: () => Worker } = {}) {
    const workers = opts.workers ?? DEFAULT_WORKERS, idleMs = opts.idleMs ?? DEFAULT_IDLE_MS, file = opts.file ?? SERVICE_FILE;
    const pool = workerPool(workers, opts.makeWorker);
    let last = Date.now(), served = 0;
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        idleTimeout: 0,
        async fetch(req) {
            const url = new URL(req.url);
            if (req.method === 'GET' && url.pathname === '/health') return Response.json({ ...info, inFlight: pool.inFlight(), served });
            if (req.method !== 'POST' || url.pathname !== '/plan') return new Response('not found', { status: 404 });
            let body: ServicePlan;
            try { body = await req.json() as ServicePlan; } catch { return new Response('bad request', { status: 400 }); }
            if (!body?.from || !body?.to || !body?.acct) return new Response('bad request', { status: 400 });
            last = Date.now();
            const out = await pool.plan(body);
            last = Date.now();
            served++;
            return Response.json(out);
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
        revMemo = null;
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
    const s = serveRoutes({ workers: arg('--workers'), idleMs: arg('--idle-ms'), onStop: () => process.exit(0) });
    const end = () => s.stop('signal');
    process.on('SIGINT', end);
    process.on('SIGTERM', end);
}
