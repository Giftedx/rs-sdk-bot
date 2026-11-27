import { test, expect } from 'bun:test';
import { watchRandomEvents } from '../src/randomevents';

const wizard = (index: number, combatLevel: number | undefined) =>
    ({ index, id: 13, name: 'Wizard', combatLevel, x: 3213, z: 3462, tileX: 3213, tileZ: 3462, distance: 1, targetIndex: 32768 + 5 });

// A fake session for the flee guard: the player stands at (3212,3462) with no food, NPC 7 targets it.
// `reply` answers each action that reaches the client; `step` lets the send results settle before the next tick.
function fake(opts: { hp: number; maxHp: number; combatLevel?: number; events?: boolean; reply?: (a: any) => any }) {
    let t = 0;
    const listeners = new Set<() => void>(), sent: any[] = [], safe: string[] = [], lines: string[] = [];
    const st: any = {
        player: { worldX: 3212, worldZ: 3462, level: 0, hp: opts.hp, maxHp: opts.maxHp, animId: -1 }, inventory: [],
        nearbyNpcs: [wizard(7, opts.combatLevel)], nearbyPlayers: [], groundItems: [],
    };
    const s: any = {
        name: 'x', bot: {}, tick: () => t, sdk: { getState: () => ({ ...st, tick: t }), send: () => {}, handleMessage: () => {} },
        onTick(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (a: any) => { sent.push({ t, ...a }); return opts.reply ? opts.reply(a) : { success: true }; }, ended: new Promise(() => {}),
    };
    const w = watchRandomEvents(s, {
        pf: null, ifReader: null, danger: new Map(), events: opts.events ?? false, log: l => lines.push(l),
        flee: { hp: 0.3, onSafe: d => safe.push(d) },
    });
    const step = async (n = 1) => {
        for (let i = 0; i < n; i++) { t++; for (const l of [...listeners]) l(); await new Promise(r => setTimeout(r, 0)); }
    };
    const walks = () => sent.filter(a => a.type === 'walkTo');
    return { st, sent, safe, lines, w, step, walks };
}

test('flee guard: 4 of 11 Hitpoints against a level 9 Wizard starts the flee (two of its hits, not 30%)', async () => {
    const f = fake({ hp: 4, maxHp: 11, combatLevel: 9 });
    await f.step();
    expect(f.walks().length).toBe(1);
    expect(f.w.busy()).toBe(true);
    f.w.stop();
});

test('flee guard: 30% of a large Hitpoints pool stays the line against a weak attacker', async () => {
    const above = fake({ hp: 26, maxHp: 84, combatLevel: 33 });
    await above.step();
    expect(above.walks().length).toBe(0);
    above.w.stop();
    const below = fake({ hp: 25, maxHp: 84, combatLevel: 33 });
    await below.step();
    expect(below.walks().length).toBe(1);
    below.w.stop();
});

test('flee guard: a walkTo the client refuses is not sent again; the job picks another tile', async () => {
    let first: { x: number; z: number } | null = null;
    const f = fake({
        hp: 2, maxHp: 10, combatLevel: 9,
        reply: a => {
            if (a.type !== 'walkTo') return { success: true };
            first ??= { x: a.x, z: a.z };
            return a.x === first.x && a.z === first.z
                ? { success: false, message: 'Failed to walk', phase: 'validation', reason: 'client_rejected' }
                : { success: true };
        },
    });
    await f.step(4);
    const walks = f.walks();
    expect(walks.length).toBeGreaterThanOrEqual(2);
    expect(walks.filter(a => a.x === first!.x && a.z === first!.z).length).toBe(1);
    expect(f.lines.filter(l => /^EVENT flee_guard dest /.test(l)).length).toBeGreaterThanOrEqual(2);
    f.w.stop();
});

test('flee guard: every tile refused moves the pick to new tiles, never a refused one', async () => {
    const f = fake({ hp: 2, maxHp: 10, combatLevel: 9, reply: a => (a.type === 'walkTo' ? { success: false, message: 'Failed to walk' } : { success: true }) });
    await f.step(20);
    const tiles = f.walks().map(a => `${a.x},${a.z}`);
    expect(tiles.length).toBeGreaterThanOrEqual(10);
    expect(new Set(tiles).size).toBe(tiles.length);
    f.w.stop();
});

test('flee guard: a bot that does not move after the sends refuses the tile and picks another', async () => {
    const f = fake({ hp: 2, maxHp: 10, combatLevel: 9 });
    await f.step(12);
    const tiles = new Set(f.walks().map(a => `${a.x},${a.z}`));
    expect(tiles.size).toBeGreaterThanOrEqual(2);
    expect(f.lines.some(l => /^EVENT flee_guard flee-repick /.test(l))).toBe(true);
    f.w.stop();
});

test('flee guard: the 90-tick timeout stops the session once and keeps the script held', async () => {
    const f = fake({ hp: 2, maxHp: 10, combatLevel: 9 });
    await f.step(95);
    expect(f.safe.length).toBe(1);
    expect(f.safe[0]).toMatch(/^flee_guard timeout id=13 at=3212,3462 ticks=\d+ refused=\d+$/);
    expect(f.w.busy()).toBe(true);
    const before = f.walks().length;
    await f.step(6);
    // The NPC still targets the bot: the flee goes on after the timeout.
    expect(f.walks().length).toBeGreaterThan(before);
    expect(f.safe.length).toBe(1);
    f.w.stop();
});

test('flee guard: once the flee job ends, a new low-Hitpoints attack starts a new flee', async () => {
    const f = fake({ hp: 2, maxHp: 10, combatLevel: 9, events: true });
    await f.step();
    expect(f.lines.filter(l => /^EVENT flee_guard flee /.test(l)).length).toBe(1);
    // The attacker leaves view; after 50 ticks unseen the watcher drops it and the flee job ends.
    f.st.nearbyNpcs = [];
    await f.step(60);
    f.st.nearbyNpcs = [wizard(8, 9)];
    await f.step(2);
    expect(f.lines.filter(l => /^EVENT flee_guard flee /.test(l)).length).toBe(2);
    f.w.stop();
});

test('flee guard: cake or bread with an Eat option does not turn the flee off; a plain fish does', async () => {
    const cake = fake({ hp: 2, maxHp: 10, combatLevel: 9 });
    cake.st.inventory = [{ slot: 0, id: 1891, count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }, { slot: 1, id: 2309, count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }];
    await cake.step();
    expect(cake.walks().length).toBe(1);
    cake.w.stop();
    const fish = fake({ hp: 2, maxHp: 10, combatLevel: 9 });
    fish.st.inventory = [{ slot: 0, id: 329, count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }];
    await fish.step();
    expect(fish.walks().length).toBe(0);
    fish.w.stop();
});

test('flee guard: the flee job sends no walk after the player dies', async () => {
    const f = fake({ hp: 2, maxHp: 10, combatLevel: 9 });
    await f.step(3);
    expect(f.walks().length).toBeGreaterThanOrEqual(1);
    f.st.player = { ...f.st.player, hp: 0, isDead: true };
    await f.step();
    const after = f.walks().length;
    await f.step(10);
    expect(f.walks().length).toBe(after);
    expect(f.lines.some(l => /^EVENT flee_guard dead /.test(l))).toBe(true);
    f.w.stop();
});
