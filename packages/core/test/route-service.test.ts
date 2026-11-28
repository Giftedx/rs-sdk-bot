import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claimLaunch, LAUNCH_LOCK_MS, readServiceInfo, serveRoutes, usableService, workerPool, type ServiceInfo } from '../src/route-service';
import { serviceWanted } from '../src/route-plan';

test('one launcher at a time holds the launch lock; a stale lock is taken again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-launch-')), lock = join(dir, 'route-service.json.lock');
    try {
        expect(claimLaunch(lock, 1_000_000)).toBe(true);
        expect(claimLaunch(lock, 1_000_000 + LAUNCH_LOCK_MS - 1)).toBe(false);
        expect(claimLaunch(lock, 1_000_000 + LAUNCH_LOCK_MS)).toBe(true);
        writeFileSync(lock, 'damaged');
        expect(claimLaunch(lock, 1_000_000_000)).toBe(true);
        expect(existsSync(lock)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

class FakeWorker {
    static made: FakeWorker[] = [];
    requests: any[] = []; terminated = false;
    onmessage: ((e: { data: unknown }) => void) | null = null; onerror: ((e: { message: string }) => void) | null = null; onmessageerror: (() => void) | null = null;
    constructor() { FakeWorker.made.push(this); }
    postMessage(r: any) { this.requests.push(r); }
    terminate() { this.terminated = true; }
    reply(id: number, data: object) { this.onmessage!({ data: { id, ...data } }); }
}
const make = () => new FakeWorker() as unknown as Worker;
const req = { from: { x: 1, z: 1, level: 0 }, to: { x: 2, z: 2, level: 0 }, acct: {} as any };

test('the service is used only with the same commit and route data and a live pid', () => {
    const info: ServiceInfo = { pid: 7, port: 1, rev: 'abc', dataKey: 'k', workers: 2, started: 0 };
    expect(usableService(info, 'abc', 'k', () => true)).toBe(info);
    expect(usableService(info, 'def', 'k', () => true)).toBeNull();
    expect(usableService(info, 'abc', 'other', () => true)).toBeNull();
    expect(usableService(info, 'abc', 'k', () => false)).toBeNull();
    expect(usableService(info, '', 'k', () => true)).toBeNull();
    expect(usableService(null, 'abc', 'k', () => true)).toBeNull();
});

test('live swarm workers use the service unless ROUTE_SERVICE=0', () => {
    expect(serviceWanted({})).toBe(false);
    expect(serviceWanted({ SWARM_LEASE_HOLDER: 'h' })).toBe(true);
    expect(serviceWanted({ SWARM_LEASE_HOLDER: 'h', ROUTE_SERVICE: '0' })).toBe(false);
    expect(serviceWanted({ ROUTE_SERVICE: '1' })).toBe(true);
});

test('the pool sends a request to the worker with fewer in flight and replaces a failed worker', async () => {
    FakeWorker.made = [];
    const pool = workerPool(2, make);
    const a = pool.plan(req), b = pool.plan(req);
    const [w0, w1] = FakeWorker.made as [FakeWorker, FakeWorker];
    expect(FakeWorker.made.length).toBe(2);
    expect(w0.requests.length).toBe(1);
    expect(w1.requests.length).toBe(1);
    w0.reply(w0.requests[0].id, { plan: { cost: 3, legs: [] } });
    expect(await a).toEqual({ plan: { cost: 3, legs: [] } });
    w1.onerror!({ message: 'boom' });
    expect(await b).toEqual({ error: 'route worker failed: boom' });
    expect(w1.terminated).toBe(true);
    const c = pool.plan(req), d = pool.plan(req);
    expect(FakeWorker.made.length).toBe(3);
    expect(pool.inFlight()).toBe(2);
    for (const w of FakeWorker.made.slice(0)) for (const r of w.requests) if (!w.terminated) w.reply(r.id, { error: 'no data' });
    expect(await c).toEqual({ error: 'no data' });
    expect(await d).toEqual({ error: 'no data' });
    pool.stop();
});

test('the service answers plans over HTTP and removes its own record when it stops', async () => {
    FakeWorker.made = [];
    const dir = mkdtempSync(join(tmpdir(), 'route-service-')), file = join(dir, 'route-service.json');
    let stopped = 0;
    const s = serveRoutes({ workers: 1, file, makeWorker: make, onStop: () => stopped++ });
    try {
        expect(readServiceInfo(file)).toEqual(s.info);
        const base = `http://127.0.0.1:${s.info.port}`;
        expect((await fetch(`${base}/plan`, { method: 'POST', body: '{' })).status).toBe(400);
        const answer = fetch(`${base}/plan`, { method: 'POST', body: JSON.stringify(req) }).then(r => r.json());
        while (!FakeWorker.made[0]?.requests.length) await Bun.sleep(5);
        const w = FakeWorker.made[0]!;
        expect(w.requests[0]).toMatchObject(req);
        w.reply(w.requests[0].id, { plan: null });
        expect(await answer).toEqual({ plan: null });
        expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ pid: process.pid, served: 1, inFlight: 0 });
    } finally {
        s.stop('test');
        s.stop('test again');
        expect(stopped).toBe(1);
        expect(readServiceInfo(file)).toBeNull();
        rmSync(dir, { recursive: true, force: true });
    }
});

// A probe process: planTripOffThread with a service that does not answer plans with the process's own worker, and
// a service that answers returns its plan without starting a worker.
test('planTripOffThread plans by the service and falls back to its own worker when the service fails', async () => {
    const probe = `
  import assert from 'node:assert/strict';
  import {mock} from 'bun:test';
  import {resolve} from 'node:path';
  const workers=[];
  globalThis.Worker=class { constructor(){workers.push(this);this.requests=[];} ref(){} unref(){} postMessage(r){this.requests.push(r);queueMicrotask(()=>this.onmessage({data:{id:r.id,plan:{cost:1,legs:[],by:'worker'}}}));} terminate(){} };
  let port=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async req=>Response.json({plan:{cost:2,legs:[],by:'service',to:(await req.json()).to}})});
  mock.module(resolve('packages/core/src/route-service.ts'),()=>({
   checkoutRev:()=>'rev',readServiceInfo:()=>({pid:process.pid,port,rev:'rev',dataKey:'k',workers:1,started:0}),
   usableService:(i)=>i,pidAlive:()=>true,launchService:()=>{throw Error('no launch in a test');},
  }));
  mock.module(resolve('packages/core/src/pathcache.ts'),()=>({pathfindingDataKey:()=>'k'}));
  process.env.ROUTE_SERVICE='1';
  const {planTripOffThread,pendingRouteWork}=await import('./packages/core/src/route-plan');
  const tile={x:1,z:1,level:0};
  port=server.port;
  const viaService=planTripOffThread(tile,{x:5,z:5,level:0},{});
  assert.equal(pendingRouteWork(),1);
  assert.equal((await viaService).by,'service');
  assert.deepEqual((await viaService).to,{x:5,z:5,level:0});
  assert.equal(workers.length,0);
  assert.equal(pendingRouteWork(),0);
  server.stop(true);
  const fallback=await planTripOffThread(tile,tile,{});
  assert.equal(fallback.by,'worker');
  assert.equal(workers.length,1);
  process.exit(0);
 `;
    const child = Bun.spawn([process.execPath, '-e', probe], { cwd: resolve(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const deadline = setTimeout(() => child.kill(), 10_000);
    try {
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(stderr).toBe('');
        expect(code).toBe(0);
    } finally { clearTimeout(deadline); }
});
