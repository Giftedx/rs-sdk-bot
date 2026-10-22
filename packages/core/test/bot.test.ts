import { test, expect } from 'bun:test';
import { closeWithin } from '../src/bot';

test('closeWithin returns after its limit even if a session close never finishes', async () => {
    const stuck = { close: () => new Promise<void>(() => {}) };
    const fine = { close: async () => {} };
    const t0 = Date.now();
    const r = await closeWithin([stuck as any, fine as any], 200);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r).toEqual({ closed: 1, timedOut: 1 });
});
