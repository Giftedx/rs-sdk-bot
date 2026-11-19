import { test, expect, mock } from 'bun:test';
import { resolve } from 'node:path';

// The route finder is loaded by the first handler that needs it, not when the watcher starts.
test('a watcher that starts and ticks with no event does not load the route finder', async () => {
    let loads = 0;
    mock.module(resolve(import.meta.dir, '../src/pathcache.ts'), () => ({ loadPathfinding: async () => { loads++; return {}; } }));
    const { watchRandomEvents } = await import('../src/randomevents');
    let t = 0;
    const listeners = new Set<() => void>();
    const state: any = {
        player: { worldX: 3200, worldZ: 3200, level: 0, animId: -1, combat: { targetIndex: -1, targetType: 'none' } },
        skills: [{ name: 'Woodcutting', level: 49, baseLevel: 49, experience: 250000 }],
        inventory: [], equipment: [], nearbyNpcs: [], nearbyPlayers: [], nearbyLocs: [], groundItems: [], gameMessages: [],
        dialog: { isOpen: false }, modalInterface: -1, bank: { isOpen: false },
    };
    const s: any = {
        name: 'fake', bot: {}, tick: () => t,
        sdk: { getState: () => ({ ...state, tick: t }), send: () => {}, handleMessage: () => {} },
        onTick(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
        direct: async () => ({ success: true }), close: async () => {}, ended: new Promise(() => {}),
    };
    const w = watchRandomEvents(s, { ifReader: null, danger: null, log: () => {} });
    for (let i = 0; i < 20; i++) { t++; for (const l of [...listeners]) l(); await Promise.resolve(); }
    await new Promise(r => setTimeout(r, 50));
    expect(loads).toBe(0);
    (w as any).stop?.();
});
