import { test, expect } from 'bun:test';
import { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import { createShim, type ClientLike } from '../src/inprocess';

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
    expect(Date.now() - t0).toBeLessThan(100);
    expect(r.rejected ?? r.success === false).toBe(true);
});
