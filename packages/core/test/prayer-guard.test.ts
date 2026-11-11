import { expect, test } from 'bun:test';
import { protectByStyle, startPrayerGuard, PROTECT, type AttackStyle, type Hunter } from '../src/prayer-guard';

// A model of the server rules the guard depends on (skill_prayer/scripts/prayer.rs2 and prayers/*.rs2): a prayer
// button closes the open window and clears the interaction; the drain timer starts at 5 when the first prayer goes
// on, is cleared when none is on, and counts down in the tick that set it.
function world(init: { prayers?: number[]; level?: number; points?: number } = {}) {
    const active = Array(15).fill(false);
    for (const i of init.prayers ?? []) active[i] = true;
    let tick = 0, timer: number | null = active.some(Boolean) ? 5 : null;
    const w = {
        active, drains: 0, toggles: 0, windowsClosed: 0, cleared: 0, window: false, anim: -1,
        interaction: null as string | null, z: 3200, combat: 50, npcs: [] as any[], events: [] as any[], offSeen: 0,
    };
    const inbox: any[] = [];
    const listeners = new Set<() => void>();
    const client = { selfSlot: 7, executeBotAction(a: any) { inbox.push(a); return { success: true }; } };
    const state = () => ({
        player: { worldX: 3200, worldZ: w.z, level: 0, animId: w.anim, isDead: false, combatLevel: w.combat },
        prayers: { activePrayers: [...active], prayerPoints: init.points ?? 50, prayerLevel: init.level ?? 50 },
        nearbyNpcs: w.npcs, nearbyPlayers: [], combatEvents: w.events, modalOpen: w.window,
        dialog: { isOpen: false }, interface: { isOpen: false }, bank: { isOpen: false }, shop: { isOpen: false },
    });
    let published = state();
    const s = {
        sdk: { getState: () => published }, tick: () => tick, client,
        onTick(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (a: any) => client.executeBotAction(a),
    };
    const advance = (n = 1) => {
        for (let k = 0; k < n; k++) {
            for (const a of inbox.splice(0)) {
                if (a.type === 'togglePrayer') {
                    w.toggles++;
                    if (w.window) { w.window = false; w.windowsClosed++; }
                    if (w.interaction) { w.interaction = null; w.cleared++; }
                    active[a.prayerIndex] = !active[a.prayerIndex];
                    // One protection prayer turns the other two off (prayer.rs2:52, prayer_deactivate_conflicting).
                    if (active[a.prayerIndex] && a.prayerIndex >= 12) for (const i of [12, 13, 14]) if (i !== a.prayerIndex) active[i] = false;
                    if (active[a.prayerIndex]) { if (timer === null) timer = 5; } else if (!active.some(Boolean)) timer = null;
                } else if (a.type === 'interactNpc' || a.type === 'interactLoc') w.interaction = `${a.type}:${a.npcIndex ?? a.locId}`;
            }
            if (timer !== null && --timer === 0) { w.drains++; timer = 5; }
            tick++;
            published = state();
            for (const cb of [...listeners]) cb();
        }
    };
    return { w, s, client, advance };
}
const cow = (target: number) => ({ index: 3, id: 81, hp: 8, targetIndex: target, optionsWithIndex: [{ text: 'Attack', opIndex: 2 }] });

test('an active prayer costs no points over 200 ticks', () => {
    const { w, s, advance } = world({ prayers: [PROTECT.melee] });
    const guard = startPrayerGuard(s, { protect: false });
    for (let i = 0; i < 200; i++) { advance(); expect(w.active[PROTECT.melee]).toBe(true); }
    expect(w.drains).toBe(0);
    expect(guard.stats().flicks).toBeGreaterThan(40);
});

test('without the guard the same prayer drains', () => {
    const { w, advance } = world({ prayers: [PROTECT.melee] });
    advance(200);
    expect(w.drains).toBe(40);
});

test('two prayers flick together; three are held', () => {
    const two = world({ prayers: [10, PROTECT.melee] });
    startPrayerGuard(two.s, { protect: false });
    two.advance(100);
    expect(two.w.drains).toBe(0);
    const three = world({ prayers: [9, 10, 11] });
    const guard = startPrayerGuard(three.s, { protect: false });
    three.advance(100);
    expect(three.w.toggles).toBe(0);
    expect(guard.stats().holds).toBeGreaterThan(0);
});

test('an open window is never closed: the prayer is held', () => {
    const { w, s, advance } = world({ prayers: [PROTECT.melee] });
    startPrayerGuard(s, { protect: false });
    w.window = true;
    advance(50);
    expect(w.windowsClosed).toBe(0);
    expect(w.toggles).toBe(0);
    expect(w.drains).toBe(10);
    w.window = false;
    const before = w.drains;
    advance(50);
    expect(w.drains - before).toBeLessThanOrEqual(1);
});

test('an attack is sent again in the tick of each flick', () => {
    const { w, s, client, advance } = world({ prayers: [PROTECT.melee] });
    w.npcs = [cow(-1)];
    const guard = startPrayerGuard(s, { protect: false });
    advance();
    const before = guard.stats().flicks;
    client.executeBotAction({ type: 'interactNpc', npcIndex: 3, optionIndex: 2 });
    for (let i = 0; i < 60; i++) { advance(); expect(w.interaction).toBe('interactNpc:3'); }
    expect(w.drains).toBe(0);
    expect(guard.stats().resends).toBe(guard.stats().flicks - before);
    expect(guard.stats().resends).toBeGreaterThan(10);
});

test('an interaction that is not an attack is never cleared', () => {
    const { w, s, client, advance } = world({ prayers: [PROTECT.melee] });
    startPrayerGuard(s, { protect: false });
    w.anim = 625;
    client.executeBotAction({ type: 'interactLoc', x: 1, z: 1, locId: 2090, optionIndex: 1 });
    advance(40);
    expect(w.cleared).toBe(0);
    expect(w.interaction).toBe('interactLoc:2090');
    // The player stands idle: the interaction is over and the flick starts again.
    w.anim = -1; w.interaction = null;
    const before = w.drains;
    advance(40);
    expect(w.drains - before).toBeLessThanOrEqual(1);
});

test('an attacking NPC turns protection on once; calm turns it off', () => {
    const { w, s, advance } = world();
    const guard = startPrayerGuard(s, { calmTicks: 10 });
    advance(5);
    expect(w.toggles).toBe(0);
    w.npcs = [cow(32768 + 7)];
    advance(3);
    expect(w.active[PROTECT.melee]).toBe(true);
    advance(60);
    expect(w.active[PROTECT.melee]).toBe(true);
    expect(w.drains).toBe(0);
    expect(guard.stats().protects).toBe(1);
    w.npcs = [];
    advance(20);
    expect(w.active.some(Boolean)).toBe(false);
});

test('a prayer the script turned on stays on after the threat ends', () => {
    const { w, s, advance } = world({ prayers: [PROTECT.melee] });
    startPrayerGuard(s, { calmTicks: 5 });
    advance(40);
    expect(w.active[PROTECT.melee]).toBe(true);
});

test('a Prayer level below the protection prayer sends nothing', () => {
    const { w, s, advance } = world({ level: 42 });
    startPrayerGuard(s);
    w.npcs = [cow(32768 + 7)];
    advance(20);
    expect(w.toggles).toBe(0);
});

test('a prayer input from the script stops the guard for 8 ticks', () => {
    const { w, s, client, advance } = world();
    startPrayerGuard(s, { protect: false });
    advance(2);
    client.executeBotAction({ type: 'togglePrayer', prayerIndex: 10 });
    advance(1);
    const after = w.toggles;
    advance(7);
    expect(w.toggles).toBe(after);
    advance(10);
    expect(w.toggles).toBeGreaterThan(after);
    expect(w.active[10]).toBe(true);
});

test('stop puts the client input function back', () => {
    const { s, client } = world();
    const original = client.executeBotAction;
    const guard = startPrayerGuard(s);
    expect(client.executeBotAction).not.toBe(original);
    guard.stop();
    expect(client.executeBotAction).toBe(original);
});

const styles = new Map<number, readonly AttackStyle[]>([[66, ['ranged']], [13, ['magic']], [54, ['melee', 'magic']]]);
const npc = (id: number, distance: number, size = 1) => ({ ...cow(32768 + 7), id, distance, size });

test('a ranged NPC turns Protect from Missiles on; a magic NPC turns Protect from Magic on', () => {
    for (const [id, prayer] of [[66, PROTECT.missiles], [13, PROTECT.magic], [81, PROTECT.melee]] as const) {
        const { w, s, advance } = world();
        startPrayerGuard(s, { protect: protectByStyle(styles) });
        w.npcs = [npc(id, 6)];
        advance(40);
        expect(w.active.flatMap((on, i) => (on ? [i] : []))).toEqual([prayer]);
        expect(w.drains).toBe(0);
    }
});

test('an NPC with melee and magic: magic from a distance, melee next to the player', () => {
    const { w, s, advance } = world();
    const guard = startPrayerGuard(s, { protect: protectByStyle(styles) });
    w.npcs = [npc(54, 7, 4)];
    advance(20);
    expect(w.active[PROTECT.magic]).toBe(true);
    w.npcs = [npc(54, 3, 4)];
    advance(20);
    expect(w.active.flatMap((on, i) => (on ? [i] : []))).toEqual([PROTECT.melee]);
    expect(w.drains).toBe(0);
    expect(guard.stats().protects).toBe(2);
});

test('Prayer 40 protects from a ranged NPC and not from a melee NPC', () => {
    const { w, s, advance } = world({ level: 40 });
    startPrayerGuard(s, { protect: protectByStyle(styles) });
    w.npcs = [npc(81, 1)];
    advance(10);
    expect(w.toggles).toBe(0);
    w.npcs = [npc(66, 6)];
    advance(10);
    expect(w.active[PROTECT.missiles]).toBe(true);
});

// 82: hunt range 2, wander 5, level 20, too-strong rule. 934: no too-strong rule.
const hunters = new Map<number, Hunter>([[82, { range: 2, wander: 5, level: 20, tooStrong: true }], [934, { range: 5, wander: 2, level: 20, tooStrong: false }]]);
const idle = (id: number, distance: number) => ({ ...cow(-1), id, distance, size: 1 });

test('an NPC that attacks first turns protection on before it attacks', () => {
    const { w, s, advance } = world();
    w.combat = 40;
    startPrayerGuard(s, { hunters });
    w.npcs = [idle(82, 9)];
    advance(10);
    expect(w.toggles).toBe(0);
    w.npcs = [idle(82, 7)];
    advance(60);
    expect(w.active[PROTECT.melee]).toBe(true);
    expect(w.drains).toBe(0);
});

test('the too-strong rule: no protection above two times the NPC level, except in the Wilderness', () => {
    const { w, s, advance } = world();
    w.combat = 41;
    startPrayerGuard(s, { hunters });
    w.npcs = [idle(82, 2)];
    advance(10);
    expect(w.toggles).toBe(0);
    w.z = 3600;
    advance(10);
    expect(w.active[PROTECT.melee]).toBe(true);
});

test('an NPC without the too-strong rule is a threat at each combat level', () => {
    const { w, s, advance } = world();
    w.combat = 126;
    startPrayerGuard(s, { hunters });
    w.npcs = [idle(934, 7)];
    advance(10);
    expect(w.active[PROTECT.melee]).toBe(true);
});

test('an NPC that does not attack first is no threat', () => {
    const { w, s, advance } = world();
    startPrayerGuard(s, { hunters });
    w.npcs = [idle(81, 1)];
    advance(20);
    expect(w.toggles).toBe(0);
});

test('near an NPC that attacks first, a window and a skill action still get no prayer input', () => {
    const { w, s, client, advance } = world();
    w.combat = 30;
    startPrayerGuard(s, { hunters });
    w.npcs = [idle(82, 2)];
    w.window = true;
    advance(20);
    expect(w.toggles).toBe(0);
    expect(w.windowsClosed).toBe(0);
    w.anim = 625;
    client.executeBotAction({ type: 'interactLoc', x: 1, z: 1, locId: 2090, optionIndex: 1 });
    advance(1);
    w.window = false;
    advance(20);
    expect(w.toggles).toBe(0);
    expect(w.interaction).toBe('interactLoc:2090');
});
