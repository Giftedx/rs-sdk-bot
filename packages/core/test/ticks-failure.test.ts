import { expect, test } from 'bun:test';
import { waitUntil, type TickSource } from '../src/ticks';
import { startReflexes } from '../src/reflex';

function source() {
    const listeners = new Set<() => void>();
    const retained: (() => void)[] = [];
    let tick = 0;
    return {
        sdk: { getState: () => ({ tick }) },
        tick: () => tick,
        onTick(cb: () => void) {
            listeners.add(cb);
            retained.push(cb);
            return () => { listeners.delete(cb); };
        },
        step() { tick++; for (const cb of listeners) cb(); },
        listeners, retained,
    } satisfies TickSource & Record<string, unknown>;
}

test('a broken wait predicate rejects its waiter without breaking other tick consumers', async () => {
    const s = source();
    const failure = new Error('malformed observation');
    const failed = waitUntil(s, st => { if (st.tick) throw failure; return false; }, { timeoutTicks: 3 });
    const settled = failed.then(value => ({ value }), error => ({ error }));
    let otherTicks = 0;
    s.onTick(() => { otherTicks++; });
    expect(() => s.step()).not.toThrow();
    expect(await settled).toEqual({ error: failure });
    expect(otherTicks).toBe(1);
    expect(s.listeners.size).toBe(1);
});

test('an invalid initial observation returns a rejected wait promise', async () => {
    const s = source();
    const failure = new Error('initial observation');
    let pending!: Promise<boolean>;
    expect(() => { pending = waitUntil(s, () => { throw failure; }, { timeoutTicks: 2 }); }).not.toThrow();
    await expect(pending).rejects.toBe(failure);
    expect(s.listeners.size).toBe(0);
});

test('a settled wait never evaluates retained callbacks again', async () => {
    const s = source();
    let calls = 0;
    const pending = waitUntil(s, st => { calls++; return st.tick > 0; }, { timeoutTicks: 2 });
    s.step();
    expect(await pending).toBe(true);
    s.retained[0]!();
    expect(calls).toBe(2);
    expect(s.listeners.size).toBe(0);
});

test('reflex failure ends an active combat wait without recording a kill', async () => {
    const s = source();
    s.sdk.getState = () => ({ tick: s.tick(), skills: [{ name: 'Hitpoints', level: 2 }], inventory: [{ name: 'Shrimps' }], nearbyNpcs: [{ index: 7 }] }) as any;
    const session = { ...s, bot: { eatFood: async () => { throw Error('food disconnected'); }, walkTo: async () => ({ success: true }) } };
    const reflex = startReflexes(session, { eatBelowHp: 5, fleeBelowHp: 3, foods: /shrimps/i, safeTile: { x: 0, z: 0, level: 0 } });
    let result: boolean | undefined;
    const pending = waitUntil(s, st => !st.nearbyNpcs.some((n: { index: number }) => n.index === 7),
        { timeoutTicks: 120, signal: reflex.aborted }).then(value => { result = value; });
    s.step();
    for (let n = 0; n < 8; n++) await Promise.resolve();
    expect(reflex.aborted.aborted).toBe(true);
    expect(result).toBe(false);
    expect(s.listeners.size).toBe(0);
    await pending;
});

test('an already aborted wait does not read its success predicate', async () => {
    const s = source();
    const ac = new AbortController();
    ac.abort('stopped');
    let calls = 0;
    expect(await waitUntil(s, () => { calls++; return true; }, { timeoutTicks: 120, signal: ac.signal })).toBe(false);
    expect(calls).toBe(0);
    expect(s.listeners.size).toBe(0);
});
