import { test, expect, spyOn } from 'bun:test';
import { ENDED_WAIT_MS, onSessionEnd, waitTicks, waitUntil } from '../src/ticks';
import { checked } from '../src/act';
import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';
import { fakeSession, at } from './fake';

test('waitTicks resolves after n ticks', async () => {
    const s = fakeSession([at(0, 0)]);
    let done = false;
    const p = waitTicks(s as any, 3).then(() => { done = true; });
    await s.run(2);
    expect(done).toBe(false);
    await s.run(1);
    await p;
    expect(done).toBe(true);
});

test('waitUntil resolves true when the predicate turns true on tick 3', async () => {
    const s = fakeSession([at(0, 0), at(0, 0), at(0, 0), at(5, 5)]);
    const p = waitUntil(s as any, st => st.player.worldX === 5, { timeoutTicks: 10 });
    await s.run(4);
    expect(await p).toBe(true);
});

test('waitUntil resolves false after its tick budget', async () => {
    const s = fakeSession([at(0, 0)]);
    const p = waitUntil(s as any, st => st.player.worldX === 5, { timeoutTicks: 2 });
    await s.run(3);
    expect(await p).toBe(false);
});

test('waits and checked actions end at once when the session ends (no more ticks will come)', async () => {
    const { checked } = await import('../src/act');
    let end!: (v: { reason: string }) => void;
    const s: any = { ...fakeSession([at(0, 0)]), ended: new Promise<{ reason: string }>(r => { end = r; }) };
    const w = waitUntil(s, () => false, { timeoutTicks: 1000 });
    const t = waitTicks(s, 1000);
    const c = checked(s, { name: 'chop', send: async () => {}, effect: () => false, timeoutTicks: 1000 });
    end({ reason: 'disconnected' });
    expect(await w).toBe(false);
    await t;
    expect(await c).toMatchObject({ ok: false, reason: 'aborted', detail: expect.stringContaining('session ended') });
});

test('a loop that only awaits waits on an ended session still lets timers run, so its settle can finish', async () => {
    const s: any = { ...fakeSession([at(0, 0)]), ended: Promise.resolve({ reason: 'disconnected' }) };
    let fired = false;
    setTimeout(() => { fired = true; }, 10);
    let loops = 0;
    while (!fired && loops < 1_000_000) { loops++; await waitTicks(s, 1); await waitUntil(s, () => false, { timeoutTicks: 5 }); }
    expect(fired).toBe(true);
    expect(loops).toBeLessThan(5);
});

test('completed waits share one end handler and schedule no historical timers on logout', async () => {
    let end!: (value: { reason: string }) => void;
    const ended = new Promise<{ reason: string }>(resolve => { end = resolve; });
    const s = { ...fakeSession([at(0, 0)]), ended };
    const subscriptions = spyOn(ended, 'then'), timers = spyOn(globalThis, 'setTimeout');
    try {
        for (let n = 0; n < 50; n++) {
            const tick = waitTicks(s, 1);
            const until = waitUntil(s, st => st.tick > n, { timeoutTicks: 1 });
            const action = checked(s, { name: 'step', send: async () => {}, effect: () => true, timeoutTicks: 1 });
            s.step();
            await Promise.all([tick, until, action]);
        }
        expect(subscriptions).toHaveBeenCalledTimes(1);
        timers.mockClear();
        end({ reason: 'logged-out' });
        await Promise.resolve();
        await Promise.resolve();
        expect(timers.mock.calls.filter(call => call[1] === ENDED_WAIT_MS)).toHaveLength(0);
    } finally { subscriptions.mockRestore(); timers.mockRestore(); }
});

test('cancelled waits release their end subscription before logout', async () => {
    let end!: (value: { reason: string }) => void;
    const s = { ...fakeSession([at(0, 0)]), ended: new Promise<{ reason: string }>(resolve => { end = resolve; }) };
    const controller = new AbortController();
    const wait = executionContext.run({ signal: controller.signal }, () => waitTicks(s, 10));
    const until = waitUntil(s, () => false, { timeoutTicks: 10, signal: controller.signal });
    const settled = wait.catch(() => {});
    controller.abort('cancelled');
    await settled;
    expect(await until).toBe(false);
    const timers = spyOn(globalThis, 'setTimeout');
    try {
        end({ reason: 'logged-out' });
        await Promise.resolve();
        await Promise.resolve();
        expect(timers.mock.calls.filter(call => call[1] === ENDED_WAIT_MS)).toHaveLength(0);
    } finally { timers.mockRestore(); }
});

test('session-end subscribers can cancel before delivery without holding other subscribers', async () => {
    let end!: (value: { reason: string }) => void;
    const s = { ended: new Promise<{ reason: string }>(resolve => { end = resolve; }) };
    const delivered: string[] = [];
    const cancel = onSessionEnd(s, () => { delivered.push('cancelled'); });
    onSessionEnd(s, value => { delivered.push(value.reason); });
    cancel();
    end({ reason: 'logged-out' });
    await Promise.resolve();
    expect(delivered).toEqual(['logged-out']);
    const cancelLate = onSessionEnd(s, () => { delivered.push('late'); });
    cancelLate();
    await Promise.resolve();
    expect(delivered).toEqual(['logged-out']);
});
