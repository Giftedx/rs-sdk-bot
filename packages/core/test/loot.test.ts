import { test, expect } from 'bun:test';
import { claimPile, detourTicks, fileTables, lureGuard, LURE_PAUSE, lootRisk, lootRoom, pileValue, recordRun, releasePile, unitValue, worthIt, LOOT_RULES, type LootTables } from '../src/loot';
import { watchRandomEvents } from '../src/randomevents';

const RUNE = 9001, JUNK = 9002, FEATHER = 9003, QUEST = 9004, NOTED = 9005;
const tables = (wanted: number[] = [], bids: Record<number, number> = {}): LootTables => {
    const items: Record<number, { cost: number; tradeable: boolean; debugname: string }> = {
        [RUNE]: { cost: 50_000, tradeable: true, debugname: 'rune_thing' },
        [JUNK]: { cost: 10, tradeable: true, debugname: 'ore' },
        [FEATHER]: { cost: 2, tradeable: true, debugname: 'feather' },
        [QUEST]: { cost: 5_000, tradeable: false, debugname: 'quest_thing' },
        [NOTED]: { cost: 10, tradeable: true, debugname: 'cert_ore' },
    };
    return {
        info: id => items[id] ? { name: items[id].debugname, ...items[id] } : undefined,
        bid: id => bids[id] ?? 0,
        wanted: id => wanted.includes(id),
    };
};
const pile = (id: number, x: number, z: number, distance: number, count = 1) => ({ id, name: 'pile', count, x, z, distance, reachable: true });
const me = (x: number, z: number, extra: any = {}) => ({ worldX: x, worldZ: z, level: 0, animId: -1, hp: 10, maxHp: 10, combat: { inCombat: false, targetIndex: -1, targetType: 'none', lastDamageTick: -1 }, ...extra });
const state = (x: number, z: number) => ({
    tick: 100, player: me(x, z), skills: [], inventory: [] as any[], equipment: [] as any[], nearbyNpcs: [] as any[], nearbyPlayers: [] as any[],
    nearbyLocs: [] as any[], groundItems: [] as any[], gameMessages: [] as any[], dialog: { isOpen: false }, bank: { isOpen: false }, shop: { isOpen: false }, modalOpen: false,
});
const fullPack = (id = JUNK) => Array.from({ length: 28 }, (_, slot) => ({ slot, id, name: 'ore', count: 1 }));

test('value: GE bid or 60% alchemy floor; coins 1; untradeable 0', () => {
    const t = tables([], { [RUNE]: 40_000 });
    expect(unitValue(RUNE, t)).toBe(40_000);
    expect(unitValue(RUNE, tables())).toBe(30_000);
    expect(unitValue(995, t)).toBe(1);
    expect(unitValue(QUEST, t)).toBe(0);
    expect(pileValue({ id: JUNK, count: 5 }, t)).toBe(30);
});

test('worth: value per detour tick; a wanted pile needs a tenth, at its cost when untradeable', () => {
    const t = tables();
    expect(detourTicks(3)).toBe(5);
    expect(worthIt(pile(RUNE, 0, 0, 3), t)).toBe(true);
    expect(worthIt(pile(RUNE, 0, 0, 16), t)).toBe(false);
    expect(worthIt(pile(JUNK, 0, 0, 1), t)).toBe(false);
    expect(worthIt(pile(QUEST, 0, 0, 3), t)).toBe(false);
    expect(worthIt(pile(QUEST, 0, 0, 3), tables([QUEST]))).toBe(true);
    // Feathers on the bill: 50 feathers at 1 coin alchemy are still not worth 3 tiles.
    expect(worthIt(pile(FEATHER, 0, 0, 3, 50), tables([FEATHER]))).toBe(false);
});

test('risk: no deeper Wilderness, no stranger there, no new hunter, hp and fight', () => {
    const none = new Map<number, number>(), friends = new Set(['ourbot']);
    const st: any = state(3222, 3218);
    expect(lootRisk(st, pile(RUNE, 3224, 3218, 2), none, friends)).toBeNull();
    expect(lootRisk({ ...st, player: me(3222, 3218, { hp: 4 }) }, pile(RUNE, 3224, 3218, 2), none, friends)).toBe('hp');
    expect(lootRisk({ ...st, player: me(3222, 3218, { combat: { inCombat: false, lastDamageTick: 95 } }) }, pile(RUNE, 3224, 3218, 2), none, friends)).toBe('combat');
    expect(lootRisk({ ...st, player: me(3100, 3525) }, pile(RUNE, 3100, 3540, 15), none, friends)).toBe('deeper');
    const wild: any = { ...state(3100, 3540), nearbyPlayers: [{ name: 'Stranger', distance: 9 }] };
    expect(lootRisk(wild, pile(RUNE, 3100, 3538, 2), none, friends)).toBe('player');
    expect(lootRisk({ ...wild, nearbyPlayers: [{ name: 'OurBot', distance: 9 }] }, pile(RUNE, 3100, 3538, 2), none, friends)).toBeNull();
    // A hunter in range of the pile but not of the player is new risk; one that already has the player in range is not.
    const hunters = new Map([[50, 4]]);
    expect(lootRisk({ ...st, nearbyNpcs: [{ id: 50, x: 3230, z: 3218 }] }, pile(RUNE, 3227, 3218, 5), hunters, friends)).toBe('npc');
    expect(lootRisk({ ...st, nearbyNpcs: [{ id: 50, x: 3224, z: 3218 }] }, pile(RUNE, 3227, 3218, 5), hunters, friends)).toBeNull();
    expect(lootRisk(st, { ...pile(RUNE, 3227, 3218, 5), reachable: false }, none, friends)).toBe('unreachable');
});

test('bait guards: no pile near the Wilderness edge, none beside a stronger hunter', () => {
    const none = new Map<number, number>(), friends = new Set<string>();
    const south: any = state(3100, 3505);
    expect(lootRisk(south, pile(RUNE, 3100, 3517, 12), none, friends)).toBe('near-wild');
    expect(lootRisk(south, pile(RUNE, 3100, 3510, 5), none, friends)).toBeNull();
    // The hunter already has the player in range, but it is stronger: no pickup.
    const st: any = { ...state(3222, 3218), player: me(3222, 3218, { combatLevel: 20 }) };
    const hunters = new Map([[50, 4]]);
    expect(lootRisk({ ...st, nearbyNpcs: [{ id: 50, x: 3224, z: 3218, combatLevel: 21 }] }, pile(RUNE, 3227, 3218, 5), hunters, friends)).toBe('npc');
    expect(lootRisk({ ...st, nearbyNpcs: [{ id: 50, x: 3224, z: 3218, combatLevel: 20 }] }, pile(RUNE, 3227, 3218, 5), hunters, friends)).toBeNull();
});

test('bait guards: the anchor holds through a trail; 3 pickups in 100 ticks pause looting', () => {
    const g = lureGuard();
    const at = (x: number) => ({ x, z: 3218, level: 0 });
    expect(g.allow(0, at(3222), { x: 3230, z: 3218 })).toBeNull();
    expect(g.picked(5)).toBe(false);
    // The bot stands 8 tiles east after a walk back that timed out: the anchor stays at 3222.
    expect(g.allow(20, at(3230), { x: 3236, z: 3218 })).toBeNull();
    expect(g.allow(20, at(3230), { x: 3238, z: 3218 })).toBe('far-anchor');
    expect(g.picked(25)).toBe(false);
    expect(g.picked(40)).toBe(true);
    expect(g.allow(41, at(3222), { x: 3223, z: 3218 })).toBe('lure-pause');
    expect(g.allow(40 + LURE_PAUSE, at(3222), { x: 3223, z: 3218 })).toBeNull();
    // 100 ticks with no pickup move the anchor to the player.
    expect(g.allow(40 + LURE_PAUSE + 101, at(3300), { x: 3310, z: 3218 })).toBeNull();
});

test('room: a stack joins its stack; a full pack drops one of several cheap slots, never a kept or single item', () => {
    const t = tables();
    expect(lootRoom([], pile(RUNE, 0, 0, 1), t, () => false)).toBe('ok');
    expect(lootRoom([...fullPack().slice(0, 27), { slot: 27, id: NOTED, name: 'n', count: 4 }], pile(NOTED, 0, 0, 1), t, () => false)).toBe('ok');
    expect(lootRoom(fullPack(), pile(RUNE, 0, 0, 1), t, () => false)).toBe(27);
    expect(lootRoom(fullPack(), pile(RUNE, 0, 0, 1), t, id => id === JUNK)).toBeNull();
    const singles = fullPack().map((i, k) => ({ ...i, id: 10_000 + k }));
    expect(lootRoom(singles, pile(RUNE, 0, 0, 1), t, () => false)).toBeNull();
    // An ore is not worth a tenth of a junk pile: no drop.
    expect(lootRoom(fullPack(), pile(JUNK, 0, 0, 1), t, () => false)).toBeNull();
});

test('record runs never loot; one claim per pile across sessions', () => {
    expect(recordRun('Haggis', {})).toBe(true);
    expect(recordRun('ShaftShooter', {})).toBe(true);
    expect(recordRun('Woodpecker', {})).toBe(false);
    expect(recordRun('Woodpecker', { HAGGIS_RUN: '1' })).toBe(true);
    expect(claimPile('0:1:1:1', 'a', 0)).toBe(true);
    expect(claimPile('0:1:1:1', 'b', 1)).toBe(false);
    expect(claimPile('0:1:1:1', 'b', 30_000)).toBe(true);
    releasePile('0:1:1:1', 'b');
    expect(claimPile('0:1:1:1', 'a', 30_001)).toBe(true);
});

test('file tables read knowledge/items.json', () => {
    const t = fileTables();
    expect(t.info(1149)?.cost).toBe(100_000);
    expect(unitValue(1149, t)).toBeGreaterThanOrEqual(60_000);
});

// A fake session, as in randomevents.test.ts.
function fake(st: any) {
    let t = 0;
    const listeners = new Set<() => void>();
    const sent: any[] = [], lines: string[] = [];
    const s: any = {
        name: 'fake', bot: {}, tick: () => t,
        sdk: { getState: () => ({ ...st, tick: t }), send: (_: any) => {}, handleMessage: (_: string) => {} },
        onTick(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
        direct: async (a: any) => { sent.push({ t, ...a }); return { success: true }; },
        close: async () => {}, ended: new Promise(() => {}),
    };
    return {
        s, st, sent, lines,
        async step(n = 1) { for (let i = 0; i < n; i++) { t++; for (const l of [...listeners]) l(); await Promise.resolve(); await Promise.resolve(); } },
        watch: (name = `bot${Math.random()}`) => watchRandomEvents(s, { pf: null, ifReader: null, danger: null, events: false, log: l => lines.push(l),
            loot: { tables: tables(), name } }),
    };
}

test('pickup: hold the script, take the pile, keep it, walk back, release', async () => {
    const f = fake(state(3222, 3218));
    const w = f.watch();
    f.st.groundItems = [pile(RUNE, 3225, 3218, 3)];
    await f.step();
    expect(f.lines.some(l => /^EVENT loot seen t=\d+ id=9001 n=1 value=30000 d=3/.test(l))).toBe(true);
    expect(f.sent.at(-1)).toMatchObject({ type: 'pickupItem', x: 3225, z: 3218, itemId: RUNE });
    expect(w.busy()).toBe(true);
    let chopped = false;
    void f.s.direct({ type: 'interactLoc', x: 1, z: 1, locId: 1, optionIndex: 1 }).then(() => { chopped = true; });
    await f.step();
    expect(chopped).toBe(false);
    f.st.player = me(3225, 3218);
    f.st.groundItems = [];
    f.st.inventory = [{ slot: 0, id: RUNE, name: 'rune', count: 1 }];
    await f.step();
    expect(f.lines.some(l => /^EVENT loot pickup .*id=9001 n=1 value=30000/.test(l))).toBe(true);
    expect(w.kept().get(RUNE)).toBe(1);
    await f.step();
    expect(f.sent.at(-1)).toMatchObject({ type: 'walkTo', x: 3222, z: 3218 });
    f.st.player = me(3222, 3218);
    await f.step(2);
    expect(f.lines.some(l => /^EVENT loot returned/.test(l))).toBe(true);
    expect(w.busy()).toBe(false);
    expect(chopped).toBe(true);
    w.stop();
});

test('the gate refuses a drop of a kept item, then lets the script win after 3 refusals', async () => {
    const f = fake(state(3222, 3218));
    const w = f.watch();
    f.st.groundItems = [pile(RUNE, 3222, 3218, 0)];
    await f.step();
    f.st.groundItems = [];
    f.st.inventory = [{ slot: 4, id: RUNE, name: 'rune', count: 1 }];
    await f.step(2);
    expect(w.kept().get(RUNE)).toBe(1);
    const results: any[] = [];
    for (let i = 0; i < 4; i++) {
        const before = f.sent.length;
        const r = f.s.direct({ type: 'dropItem', slot: 4 });
        await f.step();
        results.push(await r);
        if (i < 3) expect(f.sent.length).toBe(before);
    }
    expect(results.slice(0, 3).every(r => r.reason === 'loot_kept')).toBe(true);
    expect(results[3]).toEqual({ success: true });
    expect(f.lines.some(l => /^EVENT loot released .*id=9001/.test(l))).toBe(true);
    expect(w.kept().has(RUNE)).toBe(false);
    w.stop();
});

test('an open bank takes the kept item first; a script that loots for itself is left alone', async () => {
    const f = fake(state(3222, 3218));
    const w = f.watch();
    f.st.groundItems = [pile(RUNE, 3222, 3218, 0)];
    await f.step();
    f.st.groundItems = [];
    f.st.inventory = [{ slot: 2, id: RUNE, name: 'rune', count: 1 }, { slot: 3, id: JUNK, name: 'ore', count: 1 }];
    await f.step(2);
    f.st.bank = { isOpen: true };
    await f.step();
    expect(f.sent.at(-1)).toMatchObject({ type: 'bankDeposit', slot: 2, amount: 1 });
    f.st.inventory = [{ slot: 3, id: JUNK, name: 'ore', count: 1 }];
    await f.step();
    expect(f.lines.some(l => /^EVENT loot banked .*id=9001/.test(l))).toBe(true);
    expect(w.kept().size).toBe(0);
    f.st.bank = { isOpen: false };
    await f.step();
    // The script picks something up: for the next 20 ticks a new pile is its own.
    await f.s.direct({ type: 'pickupItem', x: 3223, z: 3218, itemId: JUNK });
    f.st.groundItems = [pile(RUNE, 3224, 3218, 2)];
    await f.step(5);
    expect(f.lines.filter(l => /^EVENT loot seen/.test(l)).length).toBe(1);
    await f.step(20);
    expect(f.lines.filter(l => /^EVENT loot seen/.test(l)).length).toBe(2);
    w.stop();
});

test('a bait trail: after 3 pickups the next pile is left with lure-pause', async () => {
    // Tiles on row 3230: the piles of earlier tests in this file are still claimed by their sessions.
    const f = fake(state(3222, 3230));
    const w = f.watch();
    let slot = 0;
    for (const x of [3223, 3224, 3225]) {
        f.st.groundItems = [pile(RUNE, x, 3230, x - 3222)];
        await f.step();
        f.st.groundItems = [];
        f.st.inventory = [...f.st.inventory, { slot: slot++, id: RUNE, name: 'rune', count: 1 }];
        f.st.player = me(x, 3230);
        await f.step();
        f.st.player = me(3222, 3230);
        await f.step(3);
    }
    expect(f.lines.filter(l => /^EVENT loot pickup/.test(l)).length).toBe(3);
    expect(f.lines.some(l => /^EVENT loot lure-pause/.test(l))).toBe(true);
    f.st.groundItems = [pile(RUNE, 3226, 3230, 4)];
    const sent = f.sent.length;
    await f.step(5);
    expect(f.lines.some(l => /^EVENT loot skip-lure-pause .*id=9001/.test(l))).toBe(true);
    expect(f.sent.slice(sent).some(a => a.type === 'pickupItem')).toBe(false);
    w.stop();
});

test('a pile deeper in the Wilderness is skipped once with its reason', async () => {
    const f = fake(state(3100, 3525));
    const w = f.watch();
    f.st.groundItems = [pile(RUNE, 3100, 3540, 15)];
    await f.step(15);
    expect(f.lines.filter(l => /^EVENT loot skip-deeper .*id=9001/.test(l)).length).toBe(1);
    expect(f.sent.some(a => a.type === 'pickupItem')).toBe(false);
    expect(LOOT_RULES.maxDistance).toBe(15);
    w.stop();
});
