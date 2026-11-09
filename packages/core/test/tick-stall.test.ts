import { expect, test } from 'bun:test';
import { startTickStallWatch } from '../src/tick-stall';

test('a session without a game tick for the stall time is ended once, on the clock; a tick resets the clock', () => {
    let now = 1_000_000, cb: (() => void) | null = null, tick: (() => void) | null = null;
    const stalls: string[] = [];
    const s = { onTick: (f: () => void) => { tick = f; return () => { tick = null; }; } };
    const watch = startTickStallWatch(s, d => stalls.push(d), { ms: 120_000, every: 10_000, now: () => now,
        setInterval: ((f: () => void) => { cb = f; return 1 as any; }) as any, clearInterval: (() => { cb = null; }) as any });
    now += 60_000; cb!(); expect(stalls).toEqual([]);
    tick!(); now += 110_000; cb!(); expect(stalls).toEqual([]);            // a tick 110 s ago is within the stall time
    now += 20_000; cb!(); expect(stalls).toEqual(['tick stream stalled: 130 s without a game tick']);
    now += 60_000; cb!(); expect(stalls).toHaveLength(1);                   // once
    watch.stop(); expect(cb).toBeNull(); expect(tick).toBeNull();
});
