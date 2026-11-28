import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claimLaunch, LAUNCH_LOCK_MS, planResponse, readServiceInfo, routeServiceEnv, serveRoutes, usableService, workerPool, type ServiceInfo } from '../src/route-service';
import { serviceWanted } from '../src/route-plan';

test('a slow plan answer sends spaces until the plan, and still reads as JSON', async () => {
    const res = planResponse(Bun.sleep(70).then(() => ({ plan: { cost: 3 } })), 20);
    const text = await res.text();
    expect(text).toMatch(/^ {2,}\{/);
    expect(JSON.parse(text)).toEqual({ plan: { cost: 3 } });
    expect(await planResponse(Promise.reject(Error('boom')), 20).json()).toEqual({ error: 'Error: boom' });
});

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
  mock.module(resolve('packages/core/src/route-service-client.ts'),()=>({
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

test('overflow workers terminate after overflowIdleMs while slot 0 stays warm, and sharedAreas transfer once per worker', async () => {
    FakeWorker.made = [];
    const fakeShared = { areas: 1, tiles: 64, bits: 4, isUint16: true } as any;
    const pool = workerPool(2, make, { overflowIdleMs: 30, sharedAreas: () => fakeShared });
    try {
        const a = pool.plan(req), b = pool.plan(req);
        expect(pool.activeWorkers()).toBe(2);
        const [w0, w1] = FakeWorker.made as [FakeWorker, FakeWorker];
        expect(w0.requests[0].sharedAreas).toBe(fakeShared);
        expect(w1.requests[0].sharedAreas).toBe(fakeShared);
        w0.reply(w0.requests[0].id, { plan: { cost: 1, legs: [] } });
        w1.reply(w1.requests[0].id, { plan: { cost: 2, legs: [] } });
        await Promise.all([a, b]);
        await Bun.sleep(60);
        expect(w0.terminated).toBe(false);
        expect(w1.terminated).toBe(true);
        expect(pool.activeWorkers()).toBe(1);
        const c = pool.plan(req);
        expect(w0.requests[1].sharedAreas).toBeUndefined();
        w0.reply(w0.requests[1].id, { plan: null });
        await c;
    } finally { pool.stop(); }
});

test('routeServiceEnv keeps DFG JIT enabled and clears low bot RAM cap inherited from caller env', () => {
    const env = routeServiceEnv({ BUN_JSC_useDFGJIT: '0', BUN_JSC_forceRAMSize: '268435456', PATH: 'x' });
    expect(env.BUN_JSC_useDFGJIT).toBe('1');
    expect(env.BUN_JSC_forceRAMSize).toBeUndefined();
    expect(env.BUN_JSC_numberOfWasmCompilerThreads).toBe('1');
    expect(env.BUN_JSC_numberOfGCMarkers).toBe('1');
});

test('serveRoutes answers POST /query for single-plane path queries and rejects unknown kinds', async () => {
    FakeWorker.made = [];
    const dir = mkdtempSync(join(tmpdir(), 'route-service-q-')), file = join(dir, 'route-service.json');
    const s = serveRoutes({ workers: 1, file, makeWorker: make });
    try {
        const base = `http://127.0.0.1:${s.info.port}`;
        expect((await fetch(`${base}/query`, { method: 'POST', body: JSON.stringify({ kind: 'bogus' }) })).status).toBe(400);
        const q = { kind: 'sdk-find-path' as const, from: { x: 3222, z: 3218, level: 0 }, to: { x: 3240, z: 3225 } };
        const pending = fetch(`${base}/query`, { method: 'POST', body: JSON.stringify(q) }).then(r => r.json());
        while (!FakeWorker.made[0]?.requests.length) await Bun.sleep(5);
        const w = FakeWorker.made[0]!;
        expect(w.requests[0]).toMatchObject(q);
        w.reply(w.requests[0].id, { result: { success: true, waypoints: [{ x: 3240, z: 3225, level: 0 }], reachedDestination: true } });
        expect(await pending).toEqual({ result: { success: true, waypoints: [{ x: 3240, z: 3225, level: 0 }], reachedDestination: true } });
    } finally {
        s.stop('test');
        rmSync(dir, { recursive: true, force: true });
    }
});

test('remote sendFindPath, sessionWalker, interactionApproach and routeHarm use route-service without initializing local WASM', async () => {
    const probe = `
        import assert from 'node:assert/strict';
        import { mock } from 'bun:test';
        import { resolve } from 'node:path';
        const seen = [];
        const server = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: async req => {
                const body = await req.json();
                seen.push(body.kind);
                if (body.kind === 'sdk-find-path') return Response.json({ result: { success: true, waypoints: [{ x: body.to.x, z: body.to.z, level: 0 }], reachedDestination: true } });
                if (body.kind === 'walk-plan') return Response.json({ result: [{ x: body.to.x, z: body.to.z }] });
                if (body.kind === 'walk-danger') return Response.json({ result: { verdict: 'clear', start: false, summary: { zone: '-', damage: 0, need: 0, needHeal: 0, eatFirst: 0, floorLine: 0, tiles: 0, zones: [] } } });
                if (body.kind === 'approach') return Response.json({ result: { x: 3062, z: 3376, level: 0 } });
                if (body.kind === 'route-exposure') return Response.json({ result: { tiles: 0, damage: 0, maxHit: 0, burst: 0, zones: [] } });
                return new Response('bad', { status: 400 });
            },
        });
        mock.module(resolve('packages/core/src/route-service-client.ts'), () => ({
            checkoutRev: () => 'rev',
            readServiceInfo: () => ({ pid: process.pid, port: server.port, rev: 'rev', dataKey: 'k', workers: 1, started: 0 }),
            usableService: i => i,
            pidAlive: () => true,
            launchService: () => { throw Error('no launch in test'); },
        }));
        mock.module(resolve('packages/core/src/pathcache.ts'), () => ({
            pathfindingDataKey: () => 'k',
            openDiagonalDoors: () => 0,
        }));
        process.env.ROUTE_SERVICE = '1';
        const rsmod = await import('./vendor/rs-sdk/server/vendor/rsmod-pathfinder');
        const { installRemoteSendFindPath, interactionApproach } = await import('./packages/core/src/world/pathfinding');
        const { sessionWalker, routeHarm } = await import('./packages/core/src/walk');
        const state = {
            player: { worldX: 3222, worldZ: 3218, level: 0, runEnergy: 100, runWeight: 0, hp: 10, maxHp: 10 },
            skills: [{ name: 'Hitpoints', level: 10 }],
            inventory: [],
            equipment: [],
            nearbyLocs: [{ id: 1733, x: 3059, z: 3376, level: 0 }],
            nearbyNpcs: [],
        };
        let localCalls = 0;
        const sdk = {
            getState: () => state,
            findPath: () => { localCalls++; return { success: true, waypoints: [{ x: 3224, z: 3218, level: 0 }], reachedDestination: true }; },
            async sendFindPath(x, z, m) { return this.findPath(x, z, m); },
            temporaryDoorBlocks: { active: () => [] },
        };
        installRemoteSendFindPath(sdk);
        const path = await sdk.sendFindPath(3240, 3225, 500);
        assert.equal(path.success, true);
        assert.equal(path.waypoints[0].x, 3240);
        assert.equal(localCalls, 0);

        const deps = await sessionWalker({ sdk, onTick: () => () => {}, direct: async () => ({}) }, { noFareFloat: true });
        const corners = await deps.planAsync(0, { x: 3222, z: 3218 }, { x: 3235, z: 3220 });
        assert.deepEqual(corners, [{ x: 3235, z: 3220 }]);
        const danger = await deps.dangerAsync(0, [{ x: 2840, z: 3497 }]);
        assert.equal(danger.verdict, 'clear');

        const approach = await interactionApproach(sdk, { x: 3059, z: 3376, level: 0 }, { id: 1733, shape: 10, angle: 1, width: 2, height: 3, blockAccessFlags: 14 });
        assert.deepEqual(approach, { x: 3062, z: 3376, level: 0 });

        const harm = await routeHarm({ sdk, tick: () => 0, onTick: () => () => {}, bot: { walkTo: async () => ({}), interactLoc: async () => ({}) } },
            { x: 2809, z: 3436, level: 0 }, { x: 2895, z: 3445, level: 0 },
            { skills: { hitpoints: 10 }, varps: {}, items: [] },
            { cost: 50, legs: [{ kind: 'walk', to: { x: 2895, z: 3445, level: 0 } }] },
            async () => null);
        assert.equal(harm.action, 'clear');
        assert.deepEqual(seen, ['sdk-find-path', 'walk-plan', 'walk-danger', 'approach', 'route-exposure']);
        assert.equal(rsmod.__wasm, undefined, 'remote queries must never initialize local rsmod WASM');

        // Fallback when service goes down:
        server.stop(true);
        const fallback = await sdk.sendFindPath(3224, 3218, 500);
        assert.equal(localCalls, 1);
        assert.equal(fallback.waypoints[0].x, 3224);
        process.exit(0);
    `;
    const child = Bun.spawn([process.execPath, '-e', probe], {
        cwd: resolve(import.meta.dir, '../../..'),
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
    });
    const deadline = setTimeout(() => child.kill(), 30_000);
    try {
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(stderr).toBe('');
        expect(code).toBe(0);
    } finally { clearTimeout(deadline); }
}, 35_000);

test('workerPool delays overflow worker creation for short bursts, spawns on slow searches, sleeps primary when idle, and recycles idle worker above RSS threshold', async () => {
    FakeWorker.made = [];
    let fakeRss = 100 * 1024 * 1024;
    const pool = workerPool(2, make, {
        overflowDelayMs: 60,
        overflowIdleMs: 30,
        primaryIdleMs: 50,
        recycleRssBytes: 300 * 1024 * 1024,
        rssBytes: () => fakeRss,
    });
    try {
        // Short burst: second request queues and runs on slot 0 once first replies, never opening slot 1.
        const a = pool.plan(req), b = pool.plan(req);
        expect(pool.activeWorkers()).toBe(1);
        expect(pool.inFlight()).toBe(2);
        const w0 = FakeWorker.made[0]!;
        expect(w0.requests.length).toBe(1);
        w0.reply(w0.requests[0].id, { plan: { cost: 1, legs: [] } });
        expect(await a).toEqual({ plan: { cost: 1, legs: [] } });
        expect(pool.activeWorkers()).toBe(1);
        expect(w0.requests.length).toBe(2);
        w0.reply(w0.requests[1].id, { plan: { cost: 2, legs: [] } });
        expect(await b).toEqual({ plan: { cost: 2, legs: [] } });
        expect(FakeWorker.made.length).toBe(1);

        // Slow request exceeding overflowDelayMs opens slot 1 so the second request proceeds.
        const c = pool.plan(req), d = pool.plan(req);
        expect(pool.activeWorkers()).toBe(1);
        await Bun.sleep(90);
        expect(pool.activeWorkers()).toBe(2);
        const w1 = FakeWorker.made[1]!;
        expect(w1.requests.length).toBe(1);
        // Set RSS high while both are in flight: neither worker terminates until it finishes its in-flight request.
        fakeRss = 600 * 1024 * 1024;
        w0.reply(w0.requests[2].id, { plan: { cost: 3, legs: [] } });
        expect(await c).toEqual({ plan: { cost: 3, legs: [] } });
        expect(w0.terminated).toBe(true);
        expect(w1.terminated).toBe(false);
        w1.reply(w1.requests[0].id, { plan: { cost: 4, legs: [] } });
        expect(await d).toEqual({ plan: { cost: 4, legs: [] } });
        expect(w1.terminated).toBe(true);
        expect(pool.activeWorkers()).toBe(0);

        // Primary idle sleep: after RSS drops below threshold, slot 0 opens for a new request then sleeps when idle.
        fakeRss = 100 * 1024 * 1024;
        const e = pool.plan(req);
        expect(pool.activeWorkers()).toBe(1);
        const w2 = FakeWorker.made[2]!;
        w2.reply(w2.requests[0].id, { plan: { cost: 5, legs: [] } });
        expect(await e).toEqual({ plan: { cost: 5, legs: [] } });
        expect(w2.terminated).toBe(false);
        await Bun.sleep(80);
        expect(w2.terminated).toBe(true);
        expect(pool.activeWorkers()).toBe(0);
    } finally { pool.stop(); }
});
