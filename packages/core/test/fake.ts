// A fake session that steps through scripted states, one per tick.
export type FakeState = {
    tick?: number;
    player?: { worldX: number; worldZ: number; level: number; hp?: number; maxHp?: number };
    skills?: { name: string; level: number; baseLevel: number; experience: number }[];
    inventory?: { slot: number; id: number; name: string; count: number }[];
    opFeedback?: { opRejectedCount: number };
};

export function fakeSession(states: FakeState[]) {
    let i = 0;
    const listeners = new Set<() => void>();
    const s = {
        sdk: { getState: () => ({ ...states[Math.min(i, states.length - 1)], tick: i }) as any },
        tick: () => i,
        onTick(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
        // Advance one tick and notify, like the shim does after pushing a state.
        step() { i++; for (const l of [...listeners]) l(); },
        async run(n: number) { for (let k = 0; k < n; k++) { await Promise.resolve(); s.step(); await Promise.resolve(); } },
    };
    return s;
}

export const at = (x: number, z: number, level = 0, extra: Partial<FakeState> = {}): FakeState => ({
    player: { worldX: x, worldZ: z, level },
    skills: [{ name: 'Woodcutting', level: 1, baseLevel: 1, experience: 0 }],
    inventory: [],
    opFeedback: { opRejectedCount: 0 },
    ...extra,
});
