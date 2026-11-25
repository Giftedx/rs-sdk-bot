import { expect, test } from 'bun:test';
import { waitOutStaleHeartbeat } from '../src/session-recovery-permit';

test('the login guard waits out a stale swarm heartbeat for a bounded time and passes every other refusal at once', () => {
    let t = 0, calls = 0;
    const sleep = (ms: number) => { t += ms; };
    const stale = Error('recovery fleet ownership unresolved: stale');
    // The heartbeat comes back after 3 s: the guard passes.
    waitOutStaleHeartbeat(() => { calls++; if (t < 3_000) throw stale; }, { now: () => t, sleep });
    expect({ calls, t }).toEqual({ calls: 4, t: 3_000 });
    // It never comes back: the refusal stands at the end of the wait.
    t = 0; calls = 0;
    expect(() => waitOutStaleHeartbeat(() => { calls++; throw stale; }, { waitMs: 5_000, now: () => t, sleep })).toThrow('recovery fleet ownership unresolved: stale');
    expect(t).toBe(5_000);
    // Any other refusal stands at once.
    t = 0; calls = 0;
    expect(() => waitOutStaleHeartbeat(() => { calls++; throw Error('recovery owner stopped'); }, { now: () => t, sleep })).toThrow('recovery owner stopped');
    expect({ calls, t }).toEqual({ calls: 1, t: 0 });
});
