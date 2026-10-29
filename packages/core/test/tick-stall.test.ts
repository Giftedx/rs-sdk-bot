import { expect, test } from 'bun:test';
import { waitTicks, waitUntil } from '../src/ticks';

function stream() {
    let tick = 0;
    const listeners = new Set<() => void>();
    return { sdk: { getState: () => ({ tick }) }, tick: () => tick,
        onTick(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
        emit(advance = true) { if (advance) tick++; for (const cb of [...listeners]) cb(); }, listeners };
}
const bounded = (p: Promise<unknown>) => Promise.race([p.then(() => 'completed', e => e), Bun.sleep(100).then(() => 'still pending')]);

test('a connected source with no ticks ends a tick wait with a transport stall', async () => {
    const s = stream();
    const result = await bounded(waitTicks(s, 100, { idleMs: 20 }));
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain('tick stream stalled');
    expect(s.listeners.size).toBe(0);
});

test('duplicate notifications cannot conceal a frozen authoritative tick', async () => {
    const s = stream();
    const timer = setInterval(() => s.emit(false), 5);
    try {
        const result = await bounded(waitUntil(s, () => false, { timeoutTicks: 10000, idleMs: 20 }));
        expect(result).toBeInstanceOf(Error);
        expect(String(result)).toContain('tick stream stalled');
        expect(s.listeners.size).toBe(0);
    } finally { clearInterval(timer); }
});

test('advancing ticks keep a long wait alive and release the monitor after success', async () => {
    const s = stream(), timer = setInterval(() => s.emit(), 5);
    try {
        expect(await waitUntil(s, state => state.tick >= 8, { timeoutTicks: 20, idleMs: 20 })).toBe(true);
        expect(s.listeners.size).toBe(0);
    } finally { clearInterval(timer); }
});
