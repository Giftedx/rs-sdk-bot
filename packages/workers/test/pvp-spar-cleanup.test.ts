import { expect, test } from 'bun:test';
import { stopSparPair } from '../src/pvp/pk-spar';

function pair(options: { refuse?: boolean; endedPeer?: boolean } = {}) {
    let tick = 0;
    const callbacks = [new Set<() => void>(), new Set<() => void>()];
    const inputs: { side: number; tick: number; kind: string; x?: number; z?: number }[] = [];
    const queued: (() => void)[] = [];
    const states = [0, 1].map(side => ({
        inGame: true,
        autoRetaliateEnabled: true,
        player: { worldX: 3094 + side, worldZ: 3555, level: 0, hp: 99, maxHp: 99, lifeId: 1,
            combat: { inCombat: true, targetType: 'player', targetIndex: 1 - side } },
    }));
    const sessions = states.map((state, side) => ({
        name: `SparCleanup${side}`,
        ended: options.endedPeer && side === 1 ? Promise.resolve({ reason: 'logged-out' }) : new Promise(() => {}),
        tick: () => tick,
        onTick: (callback: () => void) => { callbacks[side]!.add(callback); return () => { callbacks[side]!.delete(callback); }; },
        sdk: {
            getState: () => state,
            sendClickComponent: async (component: number) => {
                inputs.push({ side, tick, kind: `component:${component}` });
                if (component === 151) queued.push(() => {
                    state.autoRetaliateEnabled = false;
                    if (!options.refuse) {
                        state.player.combat.targetType = 'none';
                        state.player.combat.targetIndex = -1;
                    }
                });
                return { success: true };
            },
            sendWalk: async (x: number, z: number) => {
                inputs.push({ side, tick, kind: 'walk', x, z });
                return { success: true };
            },
        },
    }));
    const timer = setInterval(() => {
        tick++;
        for (const apply of queued.splice(0)) apply();
        for (const group of callbacks) for (const callback of [...group]) if (group.has(callback)) callback();
    }, 1);
    return { sessions, states, inputs, tick: () => tick, close: () => clearInterval(timer),
        listeners: () => callbacks.reduce((total, group) => total + group.size, 0) };
}

test('spar teardown clears both native attacks and confirms fresh state while the last-hit window stays active', async () => {
    const fixture = pair();
    try {
        const cleanup = await stopSparPair(fixture.sessions as any);
        expect(cleanup.ok).toBe(true);
        expect(cleanup.ticks).toBeGreaterThan(0);
        for (let side = 0; side < 2; side++) {
            const state = fixture.states[side]!;
            expect(state.autoRetaliateEnabled).toBe(false);
            expect(state.player.combat).toEqual({ inCombat: true, targetType: 'none', targetIndex: -1 });
            expect(fixture.inputs.some(input => input.side === side && input.kind === 'component:151')).toBe(true);
            expect(fixture.inputs.some(input => input.side === side && input.kind === 'walk' && input.x === state.player.worldX && input.z === state.player.worldZ)).toBe(true);
        }
        expect(fixture.listeners()).toBe(0);
    } finally { fixture.close(); }
});

test('spar teardown reports failure within its bound when the native attack does not clear', async () => {
    const fixture = pair({ refuse: true });
    try {
        const cleanup = await stopSparPair(fixture.sessions as any);
        expect(cleanup.ok).toBe(false);
        expect(cleanup.detail).toMatch(/cancel|clear|target|teardown/i);
        expect(fixture.tick()).toBeLessThanOrEqual(20);
        expect(fixture.inputs.length).toBeLessThanOrEqual(32);
        expect(fixture.listeners()).toBe(0);
    } finally { fixture.close(); }
});

test('spar teardown sends no input to a session that has already ended', async () => {
    const fixture = pair({ endedPeer: true });
    try {
        const cleanup = await stopSparPair(fixture.sessions as any);
        expect(cleanup.ok).toBe(true);
        expect(fixture.inputs.some(input => input.side === 0)).toBe(true);
        expect(fixture.inputs.some(input => input.side === 1)).toBe(false);
        expect(fixture.listeners()).toBe(0);
    } finally { fixture.close(); }
});

test('only a fight that ends at the cap gets the pair teardown', async () => {
    const { needsSparTeardown } = await import('../src/pvp/pk-spar');
    expect(needsSparTeardown({ end: 'cap' })).toBe(true);
    // After a kill or an escape the pair has no live native fight; a teardown there made the winner's logout time out.
    expect(needsSparTeardown({ end: 'kill' })).toBe(false);
    expect(needsSparTeardown({ end: 'escape' })).toBe(false);
});
