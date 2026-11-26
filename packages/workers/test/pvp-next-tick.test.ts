import { expect, test } from 'bun:test';
import { nextTick } from '../src/pvp/fight';

function fakeSession() {
    let listeners: (() => void)[] = [];
    let endSession!: (v: { reason: string }) => void;
    const real = new Promise<{ reason: string }>(r => { endSession = r; });
    let thens = 0;
    const ended = { then: (f: (v: { reason: string }) => unknown) => { thens++; return real.then(f); } } as unknown as Promise<{ reason: string }>;
    return {
        s: {
            ended,
            onTick: (f: () => void) => { listeners.push(f); return () => { listeners = listeners.filter(x => x !== f); }; },
        },
        tick: () => { for (const f of [...listeners]) f(); },
        end: () => endSession({ reason: 'test' }),
        thens: () => thens,
        listeners: () => listeners.length,
    };
}

test('nextTick attaches one reaction to the session end for many waits', async () => {
    const f = fakeSession();
    for (let i = 0; i < 50; i++) {
        const w = nextTick(f.s);
        f.tick();
        expect(await w).toBe(true);
    }
    expect(f.thens()).toBe(1);
    expect(f.listeners()).toBe(0);
});

test('nextTick resolves false when the session ends, before and after the end', async () => {
    const f = fakeSession();
    const pending = nextTick(f.s);
    f.end();
    expect(await pending).toBe(false);
    expect(await nextTick(f.s)).toBe(false);
    expect(f.listeners()).toBe(0);
});
