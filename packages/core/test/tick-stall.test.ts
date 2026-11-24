import { expect, test } from 'bun:test';
import { attachTickStallWatch } from '../src/bot';
import { startTickStallWatch } from '../src/tick-stall';

test('a session without a game tick for the stall time is ended once and disarms its timer and tick listener', () => {
    let now = 1_000_000, cb: (() => void) | null = null, tick: (() => void) | null = null, clears = 0;
    const stalls: string[] = [];
    const s = { onTick: (f: () => void) => { tick = f; return () => { tick = null; }; } };
    const watch = startTickStallWatch(s, d => stalls.push(d), { ms: 120_000, every: 10_000, now: () => now,
        setInterval: ((f: () => void) => { cb = f; return 1 as any; }) as any, clearInterval: (() => { clears++; cb = null; }) as any });
    now += 60_000; cb!(); expect(stalls).toEqual([]);
    tick!(); now += 110_000; cb!(); expect(stalls).toEqual([]);            // a tick 110 s ago is within the stall time
    const firedCb = cb!;
    now += 20_000; firedCb(); expect(stalls).toEqual(['tick stream stalled: 130 s without a game tick']);
    expect(cb).toBeNull(); expect(tick).toBeNull(); expect(clears).toBe(1);
    now += 60_000; firedCb(); expect(stalls).toHaveLength(1);              // once
    watch.stop(); expect(clears).toBe(1);
});

test('attachTickStallWatch disarms its interval immediately when stall fires', () => {
    let cb: (() => void) | null = null, clears = 0, now = 5_000_000;
    const stalls: string[] = [];
    const session: any = {
        onTick: () => () => {},
        ended: new Promise(() => {}),
    };
    attachTickStallWatch(session, reason => stalls.push(reason), {
        ms: 1000,
        every: 100,
        now: () => now,
        setInterval: ((f: () => void) => { cb = f; return 77 as any; }) as any,
        clearInterval: ((id: any) => { if (id === 77) { clears++; cb = null; } }) as any,
    });
    now += 1500;
    cb!();
    expect(stalls).toEqual(['tick stream stalled: 2 s without a game tick']);
    expect(clears).toBe(1);
    expect(cb).toBeNull();
});
