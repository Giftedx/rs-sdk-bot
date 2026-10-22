import { test, expect } from 'bun:test';
import { waitTicks, waitUntil } from '../src/ticks';
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
