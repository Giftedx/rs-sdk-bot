import { test, expect } from 'bun:test';
import { sail, disembark, onDeck, type BoatSession } from '../src/boat';

// The fake applies effects on later ticks. A talk or cross result alone never moves the player.
function fake({ talkOk = true, choice = /^yes please$/i, plank = true, deck = { x: 2956, z: 3143 } } = {}) {
    let tick = 0, talks = 0, clicks: number[] = [], crosses = 0, dialog: any = null, sailAt = -1, crossAt = -1;
    const player = { worldX: 3029, worldZ: 3217, level: 0 };
    const callbacks = new Set<() => void>();
    const s: BoatSession = {
        tick: () => tick,
        onTick: cb => { callbacks.add(cb); return () => { callbacks.delete(cb); }; },
        sdk: {
            getState: () => ({ tick, player, dialog }),
            getDialog: () => dialog,
            sendClickDialog: async (i: number) => {
                clicks.push(i);
                const opt = dialog?.options.find((o: any) => o.index === i);
                dialog = null;
                if (opt && choice.test(opt.text)) sailAt = tick + 2;
            },
            findNearbyLoc: () => plank && player.level === 1 ? { x: deck.x, z: deck.z, id: 2082, name: 'Gangplank' } : null,
        },
        bot: {
            talkTo: async () => { talks++; if (!talkOk) return { success: false, message: 'NPC not found' };
                dialog = { isOpen: true, isWaiting: false, options: [{ index: 1, text: 'No thanks' }, { index: 2, text: 'Yes please' }] }; return { success: true }; },
            interactLoc: async () => { crosses++; crossAt = tick + 1; },
        },
    };
    const timer = setInterval(() => {
        tick++;
        if (sailAt >= 0 && tick >= sailAt) { Object.assign(player, { worldX: deck.x, worldZ: deck.z, level: 1 }); sailAt = -1; }
        if (crossAt >= 0 && tick >= crossAt) { Object.assign(player, { worldX: deck.x + 4, worldZ: deck.z, level: 0 }); crossAt = -1; }
        for (const cb of [...callbacks]) cb();
    }, 1);
    return { s, player, stop: () => clearInterval(timer), talks: () => talks, clicks: () => clicks, crosses: () => crosses };
}
const MUSA = { x: 2956, z: 3143 };

test('deck arrival is observed after the chosen dialogue option', async () => {
    const f = fake();
    try {
        const r = await sail(f.s, { npc: /^seaman/i, choices: [/^yes please/i], deck: MUSA });
        expect(r.ok).toBe(true); expect(r.outcome).toBe('arrived');
        expect(f.clicks()).toEqual([2]); expect(onDeck(f.player, MUSA)).toBe(true);
    } finally { f.stop(); }
});
test('a refused dialogue choice never counts as arrival', async () => {
    const f = fake({ choice: /^never$/i });
    try {
        const r = await sail(f.s, { npc: /^seaman/i, choices: [/^yes please/i], deck: MUSA, attempts: 2, converseTicks: 4 });
        expect(r.ok).toBe(false); expect(r.outcome).toBe('unobserved'); expect(f.talks()).toBe(2); expect(f.player.level).toBe(0);
    } finally { f.stop(); }
});
test('a rejected talk is bounded and reported as rejected', async () => {
    const f = fake({ talkOk: false }), fails: string[] = [];
    try {
        const r = await sail(f.s, { npc: /^seaman/i, choices: [/^yes please/i], deck: MUSA, onTalkFail: m => fails.push(m) });
        expect(r.outcome).toBe('rejected'); expect(r.rejected).toBe(3); expect(fails).toEqual(['NPC not found', 'NPC not found', 'NPC not found']);
    } finally { f.stop(); }
});
test('the deadline stops a sail before another talk', async () => {
    const f = fake({ choice: /^never$/i });
    try {
        const r = await sail(f.s, { npc: /^seaman/i, choices: [/^yes please/i], deck: MUSA, deadline: f.s.tick() + 3 });
        expect(r.outcome).toBe('deadline'); expect(f.talks()).toBe(1);
    } finally { f.stop(); }
});
test('a stop request ends the sail without a talk', async () => {
    const f = fake();
    try {
        const r = await sail(f.s, { npc: /^seaman/i, choices: [/^yes please/i], deck: MUSA, stop: () => true });
        expect(r.outcome).toBe('stopped'); expect(f.talks()).toBe(0);
    } finally { f.stop(); }
});
test('the caller health hook runs before each talk', async () => {
    const f = fake(); let checks = 0;
    try { expect((await sail(f.s, { npc: /^seaman/i, choices: [/^yes please/i], deck: MUSA, before: () => { checks++; } })).ok).toBe(true); expect(checks).toBe(1); }
    finally { f.stop(); }
});
test('gangplank crossing is observed on the ground plane', async () => {
    const f = fake(); Object.assign(f.player, { ...{ worldX: MUSA.x, worldZ: MUSA.z }, level: 1 });
    try {
        const r = await disembark(f.s);
        expect(r.ok).toBe(true); expect(f.player.level).toBe(0); expect(f.crosses()).toBe(1);
    } finally { f.stop(); }
});
test('a missing gangplank is bounded and leaves the player on deck', async () => {
    const f = fake({ plank: false }); Object.assign(f.player, { worldX: MUSA.x, worldZ: MUSA.z, level: 1 });
    try {
        const r = await disembark(f.s, { attempts: 3, missTicks: 1 });
        expect(r.ok).toBe(false); expect(r.outcome).toBe('unobserved'); expect(f.crosses()).toBe(0);
    } finally { f.stop(); }
});
test('disembark honours stop and deadline', async () => {
    const f = fake({ plank: false }); Object.assign(f.player, { worldX: MUSA.x, worldZ: MUSA.z, level: 1 });
    try {
        expect((await disembark(f.s, { stop: () => true })).outcome).toBe('stopped');
        expect((await disembark(f.s, { deadline: f.s.tick() })).outcome).toBe('deadline');
    } finally { f.stop(); }
});
