import { expect, test } from 'bun:test';
import { startEatGuard } from '../src/eat-guard';
import { questFoodDefinitions, startQuestSustain } from '../src/sustain';

const SHARK = 385, LOBSTER = 379;
const food = (id: number, slot: number, count = 1) => ({ id, slot, count, name: `food ${id}`, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] });
const giant = { index: 3, id: 117, hp: 35, optionsWithIndex: [{ text: 'Attack', opIndex: 2 }] };
const attack = { type: 'interactNpc', npcIndex: 3, optionIndex: 2 };

// A model of the server rules the guard depends on (engine OpHeldHandler.ts, consume.rs2 player_consume_item): an
// item click is dropped while the player is delayed; an accepted click closes the open window and clears the
// interaction; food is then refused for 2 more ticks.
function world(init: { hp?: number; max?: number; inventory?: any[] } = {}) {
    let tick = 0;
    const w = {
        hp: init.hp ?? 99, max: init.max ?? 99, inventory: init.inventory ?? [food(SHARK, 0), food(SHARK, 1), food(SHARK, 2)],
        window: false, windowsClosed: 0, interaction: null as string | null, cleared: 0, delayed: false, anim: -1,
        eatUntil: -1, eaten: 0, tooSoon: 0, dropped: 0, npcs: [giant] as any[], perTick: [] as string[][],
    };
    const inbox: any[] = [];
    const listeners = new Set<() => void>();
    const client = { selfSlot: 7, executeBotAction(a: any) { inbox.push(a); return { success: true }; } };
    const state = () => ({
        player: { worldX: 3200, worldZ: 3200, level: 0, animId: w.anim, isDead: false },
        skills: [{ name: 'Hitpoints', level: w.hp, baseLevel: w.max }],
        inventory: w.inventory.map(i => ({ ...i })), nearbyNpcs: w.npcs, nearbyPlayers: [], modalOpen: w.window,
        dialog: { isOpen: false }, interface: { isOpen: false }, bank: { isOpen: false }, shop: { isOpen: false },
    });
    let published = state();
    const s = {
        sdk: { getState: () => published }, tick: () => tick, client,
        onTick(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (a: any) => client.executeBotAction(a) as { success: boolean },
    };
    const advance = (n = 1) => {
        for (let k = 0; k < n; k++) {
            const got = inbox.splice(0);
            w.perTick.push(got.map(a => a.type));
            for (const a of got) {
                if (a.type === 'useInventoryItem') {
                    const item = w.inventory.find(i => i.slot === a.slot);
                    if (!item) continue;
                    if (w.delayed) { w.dropped++; continue; }
                    if (w.window) { w.window = false; w.windowsClosed++; }
                    if (w.interaction) { w.interaction = null; w.cleared++; }
                    const heal = questFoodDefinitions().get(item.id)?.heal;
                    if (heal === undefined) continue;
                    if (w.eatUntil >= tick) { w.tooSoon++; continue; }
                    w.eatUntil = tick + 2;
                    if (--item.count <= 0) w.inventory.splice(w.inventory.indexOf(item), 1);
                    w.hp = Math.min(w.max, w.hp + heal);
                    w.eaten++;
                } else if (a.type === 'interactNpc' || a.type === 'interactLoc') w.interaction = `${a.type}:${a.npcIndex ?? a.locId}`;
            }
            tick++;
            published = state();
            for (const cb of [...listeners]) cb();
        }
    };
    const hit = (n: number) => { w.hp = Math.max(1, w.hp - n); };
    // For an eater that reads the reply of its input: each tick ends before the next one starts.
    const run = async (n: number) => { for (let k = 0; k < n; k++) { advance(); await Bun.sleep(0); } };
    return { w, s, client, advance, run, hit };
}

test('eats when a hit takes Hitpoints to the eat level', () => {
    const { w, s, advance, hit } = world();
    const guard = startEatGuard(s);
    advance(3);
    hit(50);
    advance(3);
    expect(w.eaten).toBe(0);
    hit(10);
    advance(2);
    expect(w.eaten).toBe(1);
    expect(w.hp).toBe(59);
    expect(guard.stats()).toMatchObject({ eats: 1, healed: 20, refused: 0, yielded: false });
});

test('an account with low Hitpoints and no damage keeps its food until the urgent level', () => {
    const calm = world({ hp: 30 });
    startEatGuard(calm.s);
    calm.advance(300);
    expect(calm.w.eaten).toBe(0);
    const low = world({ hp: 20 });
    const guard = startEatGuard(low.s);
    low.advance(3);
    expect(low.w.eaten).toBe(1);
    expect(guard.stats().urgent).toBe(1);
    low.advance(300);
    expect(low.w.eaten).toBe(1);
});

test('damage older than calmTicks no longer counts', () => {
    const { w, s, advance, hit } = world({ hp: 80, inventory: [] });
    startEatGuard(s, { calmTicks: 10 });
    advance(2);
    hit(45);
    advance(20);
    w.inventory.push(food(SHARK, 0));
    advance(20);
    expect(w.eaten).toBe(0);
    hit(1);
    advance(2);
    expect(w.eaten).toBe(1);
});

test('an open window is closed only at the urgent level', () => {
    const { w, s, advance, hit } = world({ hp: 60 });
    const guard = startEatGuard(s);
    w.window = true;
    advance(2);
    hit(25);
    advance(10);
    expect(w.eaten).toBe(0);
    expect(w.windowsClosed).toBe(0);
    expect(guard.stats().holds).toBeGreaterThan(0);
    hit(16);
    advance(2);
    expect(w.eaten).toBe(1);
    expect(w.windowsClosed).toBe(1);
});

test('an interaction that is not an attack is held until the player stands idle', () => {
    const { w, s, client, advance, hit } = world({ hp: 60 });
    startEatGuard(s);
    client.executeBotAction({ type: 'interactLoc', locId: 2090, optionIndex: 1 });
    w.anim = 625;
    advance(2);
    hit(25);
    advance(10);
    expect(w.eaten).toBe(0);
    expect(w.cleared).toBe(0);
    w.anim = -1;
    advance(8);
    expect(w.eaten).toBe(1);
});

test('the attack is sent again in the tick of the eat', () => {
    const { w, s, client, advance, hit } = world({ hp: 60 });
    const guard = startEatGuard(s);
    client.executeBotAction({ ...attack });
    advance(2);
    hit(25);
    advance(2);
    expect(w.eaten).toBe(1);
    expect(w.cleared).toBe(1);
    expect(w.interaction).toBe('interactNpc:3');
    expect(w.perTick.some(t => t.join() === 'useInventoryItem,interactNpc')).toBe(true);
    expect(guard.stats().resends).toBe(1);
});

test('an attack on a dead target is not sent again', () => {
    const { w, s, client, advance, hit } = world({ hp: 60 });
    const guard = startEatGuard(s);
    client.executeBotAction({ ...attack });
    advance(2);
    w.npcs = [];
    hit(25);
    advance(2);
    expect(w.eaten).toBe(1);
    expect(guard.stats().resends).toBe(0);
});

test('under constant damage the server refuses no eat', () => {
    const { w, s, advance, hit } = world({ hp: 30, inventory: Array.from({ length: 20 }, (_, i) => food(LOBSTER, i)) });
    const guard = startEatGuard(s);
    for (let i = 0; i < 40; i++) { hit(5); advance(); }
    expect(w.tooSoon).toBe(0);
    expect(w.eaten).toBeGreaterThan(10);
    expect(guard.stats().eats).toBe(w.eaten);
    expect(guard.stats().refused).toBe(0);
});

test('an eat that the server dropped is counted and sent again', () => {
    const { w, s, advance, hit } = world({ hp: 60 });
    const guard = startEatGuard(s);
    advance(2);
    w.delayed = true;
    hit(25);
    advance(4);
    expect(w.eaten).toBe(0);
    expect(w.dropped).toBe(1);
    w.delayed = false;
    advance(4);
    expect(w.eaten).toBe(1);
    expect(guard.stats().refused).toBeGreaterThan(0);
});

test('a script that eats on its own turns the guard off', () => {
    const { w, s, client, advance, hit } = world({ hp: 99 });
    const guard = startEatGuard(s);
    hit(10);
    advance(2);
    client.executeBotAction({ type: 'useInventoryItem', slot: 0, optionIndex: 1 });
    advance(2);
    expect(w.eaten).toBe(1);
    expect(guard.stats().yielded).toBe(true);
    hit(70);
    advance(20);
    expect(w.eaten).toBe(1);
});

test('a script eat in the food delay of a guard eat is sent when the delay ends', () => {
    const { w, s, client, advance, hit } = world({ hp: 60 });
    const guard = startEatGuard(s);
    advance(2);
    hit(50);
    advance(2);
    expect(w.eaten).toBe(1);
    expect(w.hp).toBe(30);
    expect(client.executeBotAction({ type: 'useInventoryItem', slot: 1, optionIndex: 1 })).toMatchObject({ success: true });
    advance(1);
    expect(w.eaten).toBe(1);
    advance(3);
    expect(w.eaten).toBe(2);
    expect(w.tooSoon).toBe(0);
    expect(guard.stats()).toMatchObject({ eats: 1, late: 1, yielded: true });
    advance(20);
    expect(w.eaten).toBe(2);
});

test('a script input on an item that is not food does not turn the guard off', () => {
    const { w, s, client, advance, hit } = world({ hp: 60, inventory: [{ id: 995, slot: 0, count: 5, name: 'Coins', optionsWithIndex: [{ text: 'Use', opIndex: 1 }] }, food(SHARK, 1)] });
    const guard = startEatGuard(s);
    client.executeBotAction({ type: 'useInventoryItem', slot: 0, optionIndex: 1 });
    advance(2);
    hit(25);
    advance(2);
    expect(guard.stats().yielded).toBe(false);
    expect(w.eaten).toBe(1);
});

test('a quest sustain holds the guard, and the guard eats again after the sustain stops', async () => {
    const { w, s, advance, run, hit } = world({ hp: 60, inventory: Array.from({ length: 10 }, (_, i) => food(SHARK, i)) });
    const guard = startEatGuard(s);
    const sustain = startQuestSustain(s, { food: [SHARK], eatAt: 40 });
    await run(2);
    hit(25);
    await run(12);
    expect(w.eaten).toBe(1);
    expect(guard.stats()).toMatchObject({ eats: 0, yielded: false });
    expect(sustain.failure()).toBeNull();
    sustain.stop();
    hit(30);
    advance(3);
    expect(w.eaten).toBe(2);
    expect(guard.stats().eats).toBe(1);
});

test('a quest sustain that starts after an eat of the guard waits for the food delay', async () => {
    const { w, s, advance, run, hit } = world({ hp: 60, inventory: Array.from({ length: 10 }, (_, i) => food(LOBSTER, i)) });
    startEatGuard(s);
    advance(2);
    hit(50);
    advance(1);
    const sustain = startQuestSustain(s, { food: [LOBSTER], eatAt: 40 });
    await run(12);
    expect(w.eaten).toBeGreaterThan(1);
    expect(w.tooSoon).toBe(0);
    expect(sustain.failure()).toBeNull();
});

test('reserved food is not eaten', () => {
    const { w, s, advance, hit } = world({ hp: 60, inventory: [food(SHARK, 0, 1), food(LOBSTER, 1, 1)] });
    startEatGuard(s, { reserved: () => ({ [SHARK]: 1 }) });
    advance(2);
    hit(55);
    advance(10);
    expect(w.eaten).toBe(1);
    expect(w.inventory.map(i => i.id)).toEqual([SHARK]);
});

test('the eat waits one tick when the tick already holds 4 inputs', () => {
    const { w, s, client, advance, hit } = world({ hp: 60 });
    // The prayer guard starts first, so its flick is sent before the eat guard runs: 4 inputs in one tick.
    let flick = false;
    s.onTick(() => { if (flick) { flick = false; for (let i = 0; i < 4; i++) client.executeBotAction({ type: 'togglePrayer', prayerIndex: 14 }); } });
    const guard = startEatGuard(s);
    client.executeBotAction({ ...attack });
    advance(2);
    hit(25);
    flick = true;
    advance(1);
    expect(guard.stats().waits).toBe(1);
    advance(2);
    expect(w.eaten).toBe(1);
    expect(Math.max(...w.perTick.map(t => t.length))).toBeLessThanOrEqual(5);
});

test('stop prints one EAT_GUARD line and restores the client input function', () => {
    const { s, client, advance, hit } = world({ hp: 60 });
    const original = client.executeBotAction;
    const lines: string[] = [];
    const guard = startEatGuard(s, { log: l => lines.push(l) });
    expect(client.executeBotAction).not.toBe(original);
    advance(2);
    hit(25);
    advance(3);
    guard.stop();
    guard.stop();
    expect(client.executeBotAction).toBe(original);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith('EAT_GUARD {"eats":1,');
    expect(JSON.parse(lines[0]!.slice('EAT_GUARD '.length)).hp).toEqual([60, 35, 55]);
});
