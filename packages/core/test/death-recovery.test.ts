import { test, expect } from 'bun:test';
import { damageLog, deathLine, deathPlan, recoverDeath, snapshot, DROP_TICKS, PICKUP_MARGIN, type DeathSnapshot } from '../src/death-recovery';
import { watchRandomEvents } from '../src/randomevents';
import type { LootTables } from '../src/loot';

const SWORD = 1277, SHIELD = 1171, HELM = 1155, ORE = 436;
const tables: LootTables = { info: id => ({ name: String(id), debugname: String(id), cost: id === SWORD ? 100 : 10, tradeable: true }), bid: () => 0, wanted: () => false };
const at = { x: 3230, z: 3220, level: 0 };
const death = (tick = 100): DeathSnapshot => ({ tick, at, lifeId: 1, pack: [{ id: ORE, count: 1 }], worn: [SWORD, SHIELD, HELM] });

test('plan: no Wilderness, nothing to take, or a tile out of reach before the despawn', () => {
    expect(deathPlan(death(), 110, { x: 3222, z: 3218, level: 0 })).toBeNull();
    expect(deathPlan({ ...death(), at: { x: 3100, z: 3540, level: 0 } }, 110, { x: 3222, z: 3218, level: 0 })).toBe('wilderness');
    expect(deathPlan({ ...death(), pack: [], worn: [] }, 110, { x: 3222, z: 3218, level: 0 })).toBe('nothing');
    expect(deathPlan(death(), 100 + DROP_TICKS - PICKUP_MARGIN, { x: 3229, z: 3220, level: 0 })).toBe('too-far');
    // 75 ticks left: 150 tiles can be run, 151 cannot.
    expect(deathPlan(death(), 210, { x: at.x + 150, z: at.z, level: 0 })).toBeNull();
    expect(deathPlan(death(), 210, { x: at.x + 151, z: at.z, level: 0 })).toBe('too-far');
});

test('snapshot: the pack and the worn items of a live player', () => {
    const d = snapshot({ tick: 9, player: { worldX: 1, worldZ: 2, level: 0, lifeId: 4, isDead: false }, inventory: [{ id: ORE, count: 3 }], equipment: [null, { id: SWORD }] });
    expect(d).toEqual({ tick: 9, at: { x: 1, z: 2, level: 0 }, lifeId: 4, pack: [{ id: ORE, count: 3 }], worn: [SWORD] });
    expect(snapshot({ player: { isDead: true } })).toBeNull();
});

// A small world: actions change the state on the next tick.
function world(o: { walks?: boolean; from?: { x: number; z: number } } = {}) {
    let t = 0;
    const listeners = new Set<() => void>();
    const lines: string[] = [];
    const wear = [{ text: 'Wield', opIndex: 2 }];
    const st: any = {
        player: { worldX: o.from?.x ?? 3222, worldZ: o.from?.z ?? 3218, level: 0, lifeId: 2, isDead: false, hp: 10, maxHp: 10, combat: { inCombat: false, lastDamageTick: -1 } },
        inventory: [{ slot: 0, id: 995, count: 5 }], equipment: [] as any[], nearbyNpcs: [], nearbyPlayers: [],
        groundItems: [SWORD, SHIELD, HELM, ORE].map(id => ({ id, count: 1, x: at.x, z: at.z, distance: 0 })),
    };
    const pending: (() => void)[] = [];
    const s: any = {
        tick: () => t, sdk: { getState: () => ({ ...st, tick: t }) },
        onTick(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb); },
        async direct(a: any) {
            if (a.type === 'walkTo' && o.walks !== false) pending.push(() => { st.player = { ...st.player, worldX: a.x, worldZ: a.z }; });
            if (a.type === 'pickupItem') pending.push(() => {
                const i = st.groundItems.findIndex((g: any) => g.id === a.itemId);
                if (i < 0) return;
                st.groundItems.splice(i, 1);
                st.inventory.push({ slot: st.inventory.length, id: a.itemId, count: 1, optionsWithIndex: a.itemId === ORE ? [] : wear });
            });
            if (a.type === 'useInventoryItem') pending.push(() => {
                const i = st.inventory.findIndex((x: any) => x.slot === a.slot);
                if (i >= 0) st.equipment.push({ id: st.inventory.splice(i, 1)[0].id });
            });
            return { success: true };
        },
    };
    const run = async (n: number) => { for (let i = 0; i < n; i++) { t++; for (const p of pending.splice(0)) p(); for (const l of [...listeners]) l(); await Promise.resolve(); await Promise.resolve(); } };
    return { s, st, lines, run };
}

test('recovery: a near tile gets a plain walk; pick up every own pile, wear the gear again', async () => {
    const w = world();
    let walkedTo: any = null;
    const result = recoverDeath(w.s, death(0), {
        walk: async to => { walkedTo = to; return { ok: true }; },
        tables, danger: new Map(), friends: new Set(), log: l => w.lines.push(l),
    });
    for (let i = 0; i < 60 && !w.lines.length; i++) await w.run(1);
    expect(walkedTo).toBeNull();
    expect(await result).toMatch(/^DEATH_RECOVERY ok at=3230,3220 ticks=\d+ respawn=\d+ walk=\d+ picked=4 of=4 worn=3$/);
    expect(w.st.equipment.map((e: any) => e.id).sort()).toEqual([HELM, SHIELD, SWORD].sort());
    expect(w.st.inventory.some((i: any) => i.id === ORE)).toBe(true);
});

test('recovery: a far tile uses the planned walk', async () => {
    const w = world({ from: { x: 3200, z: 3218 } });
    let walkedTo: any = null;
    const result = recoverDeath(w.s, death(0), {
        walk: async to => { walkedTo = to; w.st.player = { ...w.st.player, worldX: to.x, worldZ: to.z }; return { ok: true }; },
        tables, danger: new Map(), friends: new Set(), log: l => w.lines.push(l),
    });
    for (let i = 0; i < 60 && !w.lines.length; i++) await w.run(1);
    expect(walkedTo).toEqual(at);
    expect(await result).toMatch(/^DEATH_RECOVERY ok .* picked=4 of=4 worn=3$/);
});

test('recovery: a stronger hunter at the tile stops it before any pickup', async () => {
    const w = world();
    w.st.player.combatLevel = 3;
    w.st.nearbyNpcs = [{ id: 77, x: at.x + 1, z: at.z, combatLevel: 30 }];
    const result = recoverDeath(w.s, death(0), {
        walk: async to => { w.st.player = { ...w.st.player, worldX: to.x, worldZ: to.z }; return { ok: true }; },
        tables, danger: new Map([[77, 3]]), friends: new Set(), log: l => w.lines.push(l),
    });
    for (let i = 0; i < 20 && !w.lines.length; i++) await w.run(1);
    expect(await result).toMatch(/^DEATH_RECOVERY abort-npc .* picked=0 of=4$/);
});

test('recovery: a walk that does not arrive ends it', async () => {
    const w = world({ walks: false });
    const result = recoverDeath(w.s, death(0), { walk: async () => ({ ok: false, reason: 'no route' }), tables, danger: new Map(), friends: new Set(), log: l => w.lines.push(l) });
    for (let i = 0; i < 60 && !w.lines.length; i++) await w.run(1);
    expect(await result).toMatch(/^DEATH_RECOVERY skip-walk .* reason=no route$/);
});

test('exclusive: the work passes, eating passes, every other script action waits and then fails', async () => {
    let t = 0;
    const listeners = new Set<() => void>(), sent: any[] = [];
    const st: any = { player: { worldX: 1, worldZ: 1, level: 0 }, inventory: [{ slot: 3, id: 379, count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }], groundItems: [], nearbyNpcs: [] };
    const s: any = {
        name: 'x', bot: {}, tick: () => t, sdk: { getState: () => ({ ...st, tick: t }), send: () => {}, handleMessage: () => {} },
        onTick(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (a: any) => { sent.push(a.type); return { success: true }; }, ended: new Promise(() => {}),
    };
    const step = async () => { t++; for (const l of [...listeners]) l(); await Promise.resolve(); await Promise.resolve(); };
    const w = watchRandomEvents(s, { pf: null, ifReader: null, danger: null, events: false, log: () => {} });
    let release!: () => void;
    const work = w.exclusive(async () => { await s.direct({ type: 'walkTo', x: 2, z: 2 }); await new Promise<void>(r => { release = r; }); return 'done'; });
    await step();
    expect(w.busy()).toBe(true);
    const script = s.direct({ type: 'interactLoc', x: 0, z: 0, locId: 1, optionIndex: 1 });
    await s.direct({ type: 'useInventoryItem', slot: 3, optionIndex: 1 });
    await step();
    expect(sent).toEqual(['walkTo', 'useInventoryItem']);
    release();
    expect(await work).toBe('done');
    expect(await script).toMatchObject({ success: false });
    expect(w.busy()).toBe(false);
    w.stop();
});

test('death cause: the source that did the most damage in the last 20 ticks, each event once', () => {
    const log = damageLog();
    const npcs = [{ index: 7, id: 3, name: 'Guard' }, { index: 9, id: 1, name: 'Man' }];
    const ev = (tick: number, i: number, damage: number, o: number) => ({ type: 'damage_taken', tick, damage, sourceType: 'npc', sourceIndex: i, observationId: o, targetType: 'player', targetIndex: 0 });
    log.read({ tick: 1, nearbyNpcs: npcs, combatEvents: [ev(1, 9, 1, 1)] });
    log.read({ tick: 30, nearbyNpcs: npcs, combatEvents: [ev(1, 9, 1, 1), ev(28, 7, 3, 2), ev(30, 7, 4, 3), ev(29, 9, 1, 4)] });
    expect(log.cause()).toBe('by=Guard#3 taken=8 hits=3');
    const d: DeathSnapshot = { tick: 30, at: { x: 3212, z: 3462, level: 0 }, pack: [], worn: [] };
    expect(deathLine(d, '2/10', log.cause(), 'F:\\dev\\scripts\\aio-skiller.ts')).toBe('DEATH at=3212,3462,0 wild=0 hp=2/10 by=Guard#3 taken=8 hits=3 script=aio-skiller.ts');
    expect(damageLog().cause()).toBe('by=unknown taken=0 hits=0');
});

test('flee guard: low Hitpoints, no food, an attacker: run out of reach, report safe once, stay held', async () => {
    let t = 0;
    const listeners = new Set<() => void>(), sent: any[] = [], safe: string[] = [];
    const st: any = { player: { worldX: 3212, worldZ: 3462, level: 0, hp: 2, maxHp: 10, animId: -1 }, inventory: [{ slot: 0, id: 1, optionsWithIndex: [] }],
        nearbyNpcs: [{ index: 7, id: 3, name: 'Guard', x: 3213, z: 3462, tileX: 3213, tileZ: 3462, distance: 1, targetIndex: 32768 + 5 }], nearbyPlayers: [], groundItems: [] };
    const s: any = {
        name: 'x', bot: {}, tick: () => t, sdk: { getState: () => ({ ...st, tick: t }), send: () => {}, handleMessage: () => {} },
        onTick(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (a: any) => { sent.push(a); return { success: true }; }, ended: new Promise(() => {}),
    };
    const step = async (n = 1) => { for (let i = 0; i < n; i++) { t++; for (const l of [...listeners]) l(); await Promise.resolve(); await Promise.resolve(); } };
    const w = watchRandomEvents(s, { pf: null, ifReader: null, danger: new Map(), events: false, log: () => {}, flee: { hp: 0.3, onSafe: d => safe.push(d) } });
    await step();
    const walk = sent.find(a => a.type === 'walkTo');
    expect(walk).toBeTruthy();
    expect(Math.max(Math.abs(walk.x - 3213), Math.abs(walk.z - 3462))).toBe(10);
    expect(w.busy()).toBe(true);
    // Out of reach, the guard drops the target.
    st.player = { ...st.player, worldX: walk.x, worldZ: walk.z };
    st.nearbyNpcs = [{ ...st.nearbyNpcs[0], targetIndex: -1 }];
    await step(8);
    expect(safe.length).toBe(1);
    expect(safe[0]).toMatch(/^flee_guard id=3 at=\d+,\d+ ticks=\d+$/);
    expect(w.busy()).toBe(true);
    w.stop();
});

test('flee guard: food in the pack or Hitpoints above the line start nothing', async () => {
    for (const st of [
        { player: { worldX: 1, worldZ: 1, level: 0, hp: 2, maxHp: 10 }, inventory: [{ slot: 0, id: 379, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }] },
        { player: { worldX: 1, worldZ: 1, level: 0, hp: 4, maxHp: 10 }, inventory: [] },
    ] as any[]) {
        let t = 0;
        const listeners = new Set<() => void>(), sent: any[] = [];
        st.nearbyNpcs = [{ index: 7, id: 3, name: 'Guard', x: 2, z: 1, distance: 1, targetIndex: 32768 + 5 }]; st.nearbyPlayers = []; st.groundItems = [];
        const s: any = { name: 'x', bot: {}, tick: () => t, sdk: { getState: () => ({ ...st, tick: t }), send: () => {}, handleMessage: () => {} },
            onTick(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb); }, direct: async (a: any) => { sent.push(a); return { success: true }; } };
        const w = watchRandomEvents(s, { pf: null, ifReader: null, danger: new Map(), events: false, log: () => {}, flee: { hp: 0.3, onSafe: () => {} } });
        t++; for (const l of [...listeners]) l();
        expect(sent.length).toBe(0);
        expect(w.busy()).toBe(false);
        w.stop();
    }
});
