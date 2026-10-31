import { test, expect } from 'bun:test';
import { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import { createShim,connectInProcess,clientTransportState,observeClientTransport, type ClientLike } from '../src/inprocess';
import { tradeRefusal } from '../src/tradeguard';
import { waitTicks } from '../src/ticks';
import { equipmentObserved } from '../src/container-observation';

test('a nonlocal session cannot redirect its producer receipts into a local fixture',async()=>{
    await expect(connectInProcess({name:'fixture',password:'unused-local-test',server:'rs-sdk-demo.fly.dev',lifecycleRoot:'isolated-fixture'})).rejects.toThrow('lifecycle root override is local-only');
});

test('the transport observer records each client socket write without payloads and restores send', () => {
    let clock = 500, tick = 3;
    class Socket { readyState = 1; bufferedAmount = 0; extensions = 'permessage-deflate'; protocol = 'binary'; sent: number[] = [];
        send(data: Uint8Array) { this.sent.push(data.length); this.bufferedAmount += data.length; } }
    const socket = new Socket(), out = { pos: 17 }, rows: any[] = [];
    const client = { conn: { closed: false, out, stream: { socket } }, password: 'secret' };
    expect(clientTransportState(client)).toEqual({ outPos: 17, closed: false, readyState: 1, bufferedAmount: 0, extensions: 'permessage-deflate' });
    expect(clientTransportState({})).toBeNull();
    const observer = observeClientTransport(client, r => rows.push(r), { now: () => clock, tick: () => tick, limit: 1 });
    clock = 510; socket.send(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9])); out.pos = 0;
    clock = 520; tick = 4; socket.send(new Uint8Array(3)); socket.send(new Uint8Array(1));
    expect(socket.sent).toEqual([17, 3, 1]);
    expect(rows.map(r => r.kind)).toEqual(['attached', 'write', 'record-limit']);
    expect(rows[1]).toEqual({ kind: 'write', seq: 1, at: 510, tick: 3, length: 17, readyState: 1, bufferedBefore: 0, bufferedAfter: 17, outcome: 'returned' });
    expect(clientTransportState(client)).toMatchObject({ outPos: 0, bufferedAmount: 21 });
    expect(JSON.stringify(rows)).not.toMatch(/secret|\[9,9/);
    observer.restore();
    expect(Object.prototype.hasOwnProperty.call(socket, 'send')).toBe(false);
    const missing: any[] = [];
    observeClientTransport({ conn: { out } }, r => missing.push(r), { now: () => 1 }).restore();
    expect(missing).toEqual([{ kind: 'unavailable', at: 1 }]);
});

test('equipment needs a full packet on this connection and clears on stop', async () => {
    let component:object={};
    const c:any=Object.assign(fakeClient(),{ptype0:0,packetsReceived:0,ifMutable:()=>component});
    const shim=createShim(c,newSdk()), peer={};
    const packet=async(op:number,id=1688)=>{c.ptype0=op;c.packetsReceived++;c.ifMutable(id);await Promise.resolve();};
    expect(equipmentObserved(c)).toBe(false);
    await packet(76); expect(equipmentObserved(c)).toBe(false);
    await packet(107,3214); expect(equipmentObserved(c)).toBe(false);
    await packet(107);expect(equipmentObserved(c)).toBe(false);
    component={linkObjType:[],linkObjNumber:[]};
    c.ptype0=107;c.packetsReceived++;c.ifMutable(1688);
    expect(equipmentObserved(c)).toBe(false);
    await Promise.resolve();expect(equipmentObserved(c)).toBe(true);
    expect(equipmentObserved(peer)).toBe(false);
    await packet(76);expect(equipmentObserved(c)).toBe(true);
    await packet(28);expect(equipmentObserved(c)).toBe(false);
    await packet(107);expect(equipmentObserved(c)).toBe(true);
    shim.stop('stopped');expect(equipmentObserved(c)).toBe(false);
});

test('a tick wait started during dispatch waits for the next game tick', async () => {
    const c = fakeClient(), sdk = newSdk(), shim = createShim(c, sdk);
    shim.start();
    let pending: Promise<void> | undefined, done = false;
    const off = shim.onTick(() => {
        pending ??= waitTicks({ ...shim, sdk }, 1).then(() => { done = true; });
    });
    try {
        c.fire();
        await Promise.resolve();
        expect(done).toBe(false);
        c.fire();
        await pending;
        expect(done).toBe(true);
    } finally { off(); shim.stop('stopped'); }
});

test('a listener removed during tick dispatch does not run', () => {
    const c = fakeClient(), sdk = newSdk(), shim = createShim(c, sdk);
    let calls = 0, removeLater = () => {};
    shim.onTick(() => removeLater());
    removeLater = shim.onTick(() => { calls++; });
    shim.start();
    c.fire();
    expect(calls).toBe(0);
    shim.stop('stopped');
});

test('removing and re-adding the same callback defers the new subscription', () => {
    const c = fakeClient(), sdk = newSdk(), shim = createShim(c, sdk);
    let calls = 0, changed = false, off = () => {};
    const callback = () => { calls++; };
    shim.onTick(() => {
        if (!changed) { changed = true; off(); off = shim.onTick(callback); }
    });
    off = shim.onTick(callback);
    shim.start();
    try {
        c.fire();
        expect(calls).toBe(0);
        c.fire();
        expect(calls).toBe(1);
    } finally { off(); shim.stop('stopped'); }
});

test('the action boundary blocks unowned trades through both queue and direct calls', async () => {
    const c = fakeClient();
    const sdk = newSdk();
    const state = { nearbyPlayers: [{ index: 7, name: 'Our mule' }, { index: 8, name: 'Stranger' }], trade: { partner: 'Stranger' } };
    const shim = createShim(c, sdk, a => tradeRefusal(a, state, new Set(['our mule'])));
    shim.start();
    expect((await sdk.sendTradeRequest(8)).success).toBe(false);
    expect((await shim.direct({ type: 'clickComponent', componentId: 3546 }) as any).success).toBe(false);
    expect(c.executed).toHaveLength(0);
    expect((await sdk.sendTradeRequest(7)).success).toBe(true);
    expect(c.executed).toHaveLength(1);
    shim.stop('stopped');
});

function fakeClient() {
    let cb: (() => void) | null = null;
    const executed: any[] = [];
    let pendingResolve: ((v: unknown) => void) | null = null;
    const client: ClientLike & { fire(): void; executed: any[]; holdNext: boolean; release(): void } = {
        executed,
        holdNext: false,
        collectBotState: (tick: number) => ({ tick, inGame: true, player: { worldX: 3222, worldZ: 3218, level: 0 }, skills: [], inventory: [], gameMessages: [], opFeedback: { opRejectedCount: 0 } }),
        executeBotAction(a: unknown) {
            executed.push(a);
            if (client.holdNext) return new Promise(r => { pendingResolve = r; });
            return { success: true, message: 'ok' };
        },
        setOnGameTickCallback(c) { cb = c; },
        getMaxMessageLength: () => 400,
        fire() { cb?.(); },
        release() { pendingResolve?.({ success: true }); },
    };
    return client;
}

function newSdk() {
    return new BotSDK({ botUsername: 'tester', password: 'x', autoLaunchBrowser: false, autoReconnect: false } as any);
}

test('each game tick pushes a fresh state with a rising tick', () => {
    const c = fakeClient();
    const sdk = newSdk();
    const shim = createShim(c, sdk);
    shim.start();
    c.fire();
    c.fire();
    expect(sdk.getState()?.tick).toBe(2);
    expect(shim.tick()).toBe(2);
    shim.stop('stopped');
});

test('actions reach the client one at a time, in order', async () => {
    const c = fakeClient();
    const sdk = newSdk();
    const shim = createShim(c, sdk);
    shim.start();
    c.fire();
    const a = (sdk as any).sendAction({ type: 'walkTo', x: 1, z: 2, running: true, reason: 'SDK' });
    const b = (sdk as any).sendAction({ type: 'walkTo', x: 3, z: 4, running: true, reason: 'SDK' });
    await Promise.all([a, b]);
    expect(c.executed.map((x: any) => x.x)).toEqual([1, 3]);
    shim.stop('stopped');
});

test('a wait action of 3 ticks resolves only after 3 ticks', async () => {
    const c = fakeClient();
    const sdk = newSdk();
    const shim = createShim(c, sdk);
    shim.start();
    c.fire();
    let done = false;
    const p = (sdk as any).sendAction({ type: 'wait', ticks: 3, reason: 'SDK' }).then(() => { done = true; });
    await Bun.sleep(30);
    c.fire(); c.fire();
    await Bun.sleep(30);
    expect(done).toBe(false);
    c.fire();
    await p;
    expect(done).toBe(true);
    shim.stop('stopped');
});

test('a pending action rejects quickly when the session ends', async () => {
    const c = fakeClient();
    c.holdNext = true;
    const sdk = newSdk();
    const shim = createShim(c, sdk);
    shim.start();
    c.fire();
    const p = (sdk as any).sendAction({ type: 'walkTo', x: 1, z: 2, running: true, reason: 'SDK' });
    await Bun.sleep(30);
    const t0 = Date.now();
    shim.stop('disconnected');
    const r = await p.then((v: any) => v, (e: any) => ({ rejected: true, e }));
    expect(Date.now() - t0).toBeLessThan(2000); // the point: not the SDK 60 s action timeout; 100 ms was flaky under load
    expect(r.rejected ?? r.success === false).toBe(true);
});

test('direct() reaches the client even while a slow action holds the queue', async () => {
    const c = fakeClient();
    c.holdNext = true;
    const sdk = newSdk();
    const shim = createShim(c, sdk);
    shim.start();
    c.fire();
    void (sdk as any).sendAction({ type: 'walkTo', x: 1, z: 2, running: true, reason: 'SDK' });
    await Bun.sleep(20);
    c.holdNext = false;
    await shim.direct({ type: 'clickComponent', componentId: 2458, reason: 'SDK' });
    expect(c.executed.map((a: any) => a.type)).toEqual(['walkTo', 'clickComponent']);
    shim.stop('stopped');
});

test('login jitter is 0 only for a local server; any other host keeps the upstream default', async () => {
    const { loginJitterFor } = await import('../src/inprocess');
    expect(loginJitterFor('localhost:8888')).toBe(0);
    expect(loginJitterFor('127.0.0.1:8888')).toBe(0);
    expect(loginJitterFor('rs-sdk-demo.fly.dev')).toBeUndefined(); // undefined = session.ts default (5 s for remote)
    expect(loginJitterFor('localhost.example.com')).toBeUndefined();
    expect(loginJitterFor('127.evil.io')).toBeUndefined();
});

test('bank readiness follows full inventory packets, keeps real empty updates, and rejects other mutations', async () => {
    const base=fakeClient();
    const bank={linkObjType:[0],linkObjNumber:[0]};
    const c:any=Object.assign(base,{ptype0:-1,packetsReceived:0,mainModalId:5292,
        ifMutable:()=>bank,
        collectBotState:()=>({bank:{isOpen:c.mainModalId===5292,items:bank.linkObjType[0]?[{id:1779,name:'Flax',count:bank.linkObjNumber[0]}]:[]}})});
    const shim=createShim(c,newSdk());shim.start();
    const packet=async(opcode:number,id=5382,raw=1780,count=81)=>{
        c.ptype0=opcode;c.packetsReceived++;
        const inv=c.ifMutable(id);inv.linkObjType[0]=raw;inv.linkObjNumber[0]=count;
        await Promise.resolve();
    };
    expect(shim.bankObservation()).toBeNull(); // open modal, no payload
    await packet(79); // IF_SETTEXT-like mutation cannot establish inventory readiness
    expect(shim.bankObservation()).toBeNull();
    await packet(107,3214);
    expect(shim.bankObservation()).toBeNull();
    await packet(76); // partial alone is not a complete baseline
    expect(shim.bankObservation()).toBeNull();
    await packet(107);
    expect(shim.bankObservation()?.items[0]?.count).toBe(81);
    const generation=shim.bankObservation()!.generation;
    c.ifMutable(5382);await Promise.resolve(); // read with same last packet is not a new update
    expect(shim.bankObservation()!.generation).toBe(generation);
    await packet(76,5382,0,0); // withdrawing the last item is a real empty snapshot
    expect(shim.bankObservation()?.items).toEqual([]);
    expect(shim.bankObservation()!.generation).toBeGreaterThan(generation);
    await packet(28,5382,0,0); // close STOP clears components while modal may still look open
    expect(shim.bankObservation()).toBeNull();
    c.mainModalId=-1;
    await packet(107); // full inventory can precede the bank's modal-open packet
    expect(shim.bankObservation()).toBeNull();
    c.mainModalId=5292;
    expect(shim.bankObservation()?.items[0]?.count).toBe(81);
    shim.stop('stopped');
});
