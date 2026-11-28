import { expect, test } from 'bun:test';
import {
    BANK_BATCH_MAX,
    depositBatchFast,
    ensureBankOpen,
    isInstantBankAmount,
    withdrawBatchFast,
} from '../src/bank-trip';
import { depositPack } from '../src/deposit';
import { startEatGuard } from '../src/eat-guard';
import {
    COOKED_KARAMBWAN_ID,
    comboEat,
    isComboFood,
    selectComboFood,
    startQuestSustain,
} from '../src/sustain';
import {
    PVP_WEAPON_IDS,
    isPvpWeapon,
    lootNameMatches,
    pickupLootBatch,
    rankGroundLoot,
} from '../src/loot-policy';
import { lootRoom, type LootTables } from '../src/loot';
import { areExclusivePrayers, PROTECT, startPrayerGuard } from '../src/prayer-guard';
import { takeItems } from '../src/trip';
import { DEFAULT_RUN_THRESHOLD, walkPath, walkRoute, type PathDeps, type PathLoc } from '../src/walk';

// ---------------- 1. Zero-Tick-Waste Banking ----------------

test('takeItems skips redundant openBank when already open and honors keepOpen', async () => {
    let tick = 0, opens = 0, closes = 0, held = 0, bankCoins = 500, generation = 3, open = true;
    const row = { id: 995, count: bankCoins };
    const s = {
        tick: () => tick,
        bankObservation: () => (open ? { generation, items: [{ id: 995, count: row.count }] } : null),
        sdk: { getState: () => ({ inventory: held ? [{ id: 995, count: held }] : [], bank: { isOpen: open, items: [row] } }) },
        bot: {
            openBank: async () => { opens++; open = true; generation++; return { success: true }; },
            withdrawItem: async (_r: unknown, n: number) => { row.count -= n; held += n; generation++; return { success: true }; },
            closeBank: async () => { closes++; open = false; },
        },
    };
    const r = await takeItems(s, 100, {}, async () => { tick++; }, { keepOpen: true });
    expect(r.ok).toBe(true);
    expect(opens).toBe(0);
    expect(closes).toBe(0);
    expect(open).toBe(true);
    expect(held).toBe(100);
    expect(tick).toBe(0);
});

test('withdrawBatchFast and depositBatchFast settle 5 instant items in 1 tick', async () => {
    let tick = 0;
    const bankItems = [
        { slot: 0, id: 385, count: 50 },
        { slot: 1, id: 3144, count: 50 },
        { slot: 2, id: 563, count: 100 },
        { slot: 3, id: 556, count: 500 },
        { slot: 4, id: 554, count: 500 },
    ];
    const inv: { slot: number; id: number; count: number }[] = [];
    const inbox: any[] = [];
    const listeners = new Set<() => void>();
    const s = {
        tick: () => tick,
        sdk: { getState: () => ({ bank: { isOpen: true, items: bankItems }, inventory: inv }) },
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (a: any) => { inbox.push(a); return { success: true }; },
        bot: { openBank: async () => ({ success: true }) },
    };
    const flushTick = () => {
        tick++;
        for (const a of inbox.splice(0, BANK_BATCH_MAX)) {
            if (a.type === 'bankWithdraw') {
                const row = bankItems.find(b => b.slot === a.slot)!;
                const amt = a.amount === -1 ? row.count : Math.min(a.amount, row.count);
                row.count -= amt;
                inv.push({ slot: inv.length, id: row.id, count: amt });
            } else if (a.type === 'bankDeposit') {
                const idx = inv.findIndex(i => i.slot === a.slot);
                if (idx >= 0) {
                    const row = inv[idx]!;
                    const amt = a.amount === -1 ? row.count : Math.min(a.amount, row.count);
                    row.count -= amt;
                    if (row.count <= 0) inv.splice(idx, 1);
                }
            }
        }
        for (const cb of [...listeners]) cb();
    };
    const waitUntilFn = (pred: () => boolean, limit: number) => new Promise<boolean>(resolve => {
        if (pred()) return resolve(true);
        let seen = 0;
        const off = s.onTick(() => {
            seen++;
            if (pred()) { off(); resolve(true); }
            else if (seen >= limit) { off(); resolve(false); }
        });
    });

    expect(isInstantBankAmount(1)).toBe(true);
    expect(isInstantBankAmount(5)).toBe(true);
    expect(isInstantBankAmount(10)).toBe(true);
    expect(isInstantBankAmount(-1)).toBe(true);
    expect(isInstantBankAmount(7)).toBe(false);
    expect(await ensureBankOpen(s)).toEqual({ ok: true, opened: false });

    const wPromise = withdrawBatchFast(s, [
        { id: 385, amount: 10 },
        { id: 3144, amount: 5 },
        { id: 563, amount: 10 },
        { id: 556, amount: 10 },
        { id: 554, amount: 10 },
    ], waitUntilFn);
    await Promise.resolve();
    flushTick();
    const wRes = await wPromise;
    expect(wRes.ok).toBe(true);
    expect(wRes.ticks).toBe(1);
    expect(wRes.withdrawn).toEqual({ 385: 10, 3144: 5, 563: 10, 556: 10, 554: 10 });

    const dPromise = depositBatchFast(s, [
        { id: 385 },
        { id: 3144 },
        { id: 563 },
        { id: 556 },
        { id: 554 },
    ], waitUntilFn);
    await Promise.resolve();
    flushTick();
    const dRes = await dPromise;
    expect(dRes.ok).toBe(true);
    expect(dRes.ticks).toBe(1);
    expect(inv.length).toBe(0);
});

test('depositPack batches 5 distinct non-coin items in 1 tick via direct with paired debit/credit', async () => {
    let tick = 0, generation = 1;
    const inv = [
        { slot: 0, id: 385, name: 'Shark', count: 2 },
        { slot: 1, id: 379, name: 'Lobster', count: 3 },
        { slot: 2, id: 563, name: 'Law rune', count: 4 },
        { slot: 3, id: 556, name: 'Air rune', count: 5 },
        { slot: 4, id: 554, name: 'Fire rune', count: 6 },
    ];
    const bank = new Map<string, number>([['Shark', 10], ['Lobster', 10], ['Law rune', 10], ['Air rune', 10], ['Fire rune', 10]]);
    const inbox: any[] = [];
    const listeners = new Set<() => void>();
    const s: any = {
        name: 'fixture',
        tick: () => tick,
        sdk: { getState: () => ({ inventory: [...inv] }), getInventory: () => [...inv] },
        bankObservation: () => ({ generation, at: 1000 + tick, items: [...bank].map(([name, count], id) => ({ id, name, count })) }),
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (a: any) => { inbox.push(a); return { success: true }; },
        bot: { depositItem: async () => { throw Error('should batch via direct'); } },
    };
    const work = depositPack(s);
    await Promise.resolve();
    expect(inbox.length).toBe(5);
    // Process all 5 deposits in 1 server tick.
    tick++;
    for (const a of inbox.splice(0, 5)) {
        const idx = inv.findIndex(i => i.slot === a.slot);
        const item = inv[idx]!;
        bank.set(item.name, (bank.get(item.name) ?? 0) + item.count);
        inv.splice(idx, 1);
    }
    generation++;
    for (const cb of [...listeners]) cb();
    expect(await work).toBe(5);
    expect(tick).toBe(1);
    expect(inv).toEqual([]);
});

// ---------------- 2. Zero-Tick-Waste Walking, Doors & Run Energy ----------------

test('walkPath skips redundant runOn when already enabled and re-enables run after energy recovers', async () => {
    let x = 3000, clickX = 3000, tick = 0, runEnabled = true, energy = 4;
    let runClicks = 0;
    const listeners = new Set<() => void>();
    const deps: PathDeps = {
        pos: () => ({ x, z: 3200, level: 0 }),
        onTick: cb => { listeners.add(cb); return () => listeners.delete(cb); },
        walk: tx => { clickX = tx; },
        interactLoc: () => {},
        runOn: () => { runClicks++; if (energy >= 1) runEnabled = true; },
        runState: () => ({ enabled: runEnabled, energy }),
        locs: () => [],
        plan: (_l, _f, to) => [to],
    };
    const p = walkPath(deps, [{ x: 3080, z: 3200, tol: 0 }], { maxTicks: 100, runThreshold: DEFAULT_RUN_THRESHOLD });
    let result: Awaited<typeof p> | undefined;
    p.then(r => { result = r; });
    for (let i = 0; i < 100 && !result; i++) {
        tick++;
        const steps = runEnabled ? 2 : 1;
        for (let k = 0; k < steps && x !== clickX; k++) x += Math.sign(clickX - x);
        if (runEnabled) {
            energy = Math.max(0, energy - 2);
            if (energy === 0) runEnabled = false;
        } else {
            energy = Math.min(100, energy + 2);
        }
        for (const cb of [...listeners]) cb();
        await Promise.resolve();
    }
    const r = await p;
    expect(r.ok).toBe(true);
    // Started with runEnabled=true (0 clicks at start), re-enabled on each recovery to 20% across the 80-tile walk.
    expect(runClicks).toBe(3);
    // 80 tiles with run re-enabled takes ~54 ticks (vs 78 ticks walking at 1 tile/tick after depletion).
    expect(r.ticks).toBeLessThan(60);

    // Full energy with run already enabled sends 0 redundant runOn clicks across the entire walk.
    let x2 = 3000, clickX2 = 3000, runClicks2 = 0;
    const l2 = new Set<() => void>();
    const p2 = walkPath({
        pos: () => ({ x: x2, z: 3200, level: 0 }),
        onTick: cb => { l2.add(cb); return () => l2.delete(cb); },
        walk: tx => { clickX2 = tx; },
        interactLoc: () => {},
        runOn: () => { runClicks2++; },
        runState: () => ({ enabled: true, energy: 100 }),
        locs: () => [],
        plan: (_l, _f, to) => [to],
    }, [{ x: 3040, z: 3200, tol: 0 }], { maxTicks: 40 });
    let r2Res: Awaited<typeof p2> | undefined;
    p2.then(v => { r2Res = v; });
    for (let i = 0; i < 40 && !r2Res; i++) {
        for (let k = 0; k < 2 && x2 !== clickX2; k++) x2 += Math.sign(clickX2 - x2);
        for (const cb of [...l2]) cb();
        await Promise.resolve();
    }
    expect((await p2).ok).toBe(true);
    expect(runClicks2).toBe(0);
});

test('walkPath eliminates redundant same-tile walk re-clicks when moving near a hunter square', async () => {
    let x = 3000, clickX = 3000, tick = 0;
    const walkLog: { tick: number; x: number }[] = [];
    const listeners = new Set<() => void>();
    const deps: PathDeps = {
        pos: () => ({ x, z: 3200, level: 0 }),
        onTick: cb => { listeners.add(cb); return () => listeners.delete(cb); },
        walk: tx => { clickX = tx; walkLog.push({ tick, x: tx }); },
        interactLoc: () => {},
        locs: () => [],
        // Reach probe clamps every click to at most 4 tiles ahead (<= reclickAt=6), creating the exact duplicate-click scenario.
        reach: to => to.x <= x + 4,
        plan: (_l, _f, to) => [to],
    };
    const p = walkPath(deps, [{ x: 3020, z: 3200, tol: 0 }], { maxTicks: 40 });
    let result: Awaited<typeof p> | undefined;
    p.then(r => { result = r; });
    for (let i = 0; i < 40 && !result; i++) {
        tick++;
        // Move 1 tile/tick so target stays at the same reachable tile across consecutive ticks.
        if (x !== clickX) x += Math.sign(clickX - x);
        for (const cb of [...listeners]) cb();
        await Promise.resolve();
    }
    const r = await p;
    expect(r.ok).toBe(true);
    // Never emits consecutive identical walk targets while moving.
    for (let i = 1; i < walkLog.length; i++) {
        expect(walkLog[i]!.x).not.toBe(walkLog[i - 1]!.x);
    }
});

test('walkPath opens a second shut door on the exact tick the first door opens (zero dead airlock tick)', async () => {
    let x = 3000, clickX = 3000, tick = 0;
    const shut = new Set([3004, 3008]);
    let opening: number | null = null;
    const inputs: { tick: number; what: string }[] = [];
    const listeners = new Set<() => void>();
    const doorAt = (dx: number): PathLoc => ({ x: dx, z: 3200, id: 1530, name: 'Door', optionsWithIndex: [{ text: 'Open', opIndex: 1 }] });
    const deps: PathDeps = {
        pos: () => ({ x, z: 3200, level: 0 }),
        onTick: cb => { listeners.add(cb); return () => listeners.delete(cb); },
        walk: tx => { clickX = tx; inputs.push({ tick, what: `walk ${tx}` }); },
        interactLoc: l => { clickX = l.x - 1; opening = l.x; inputs.push({ tick, what: `open ${l.x}` }); },
        locs: () => [...shut].map(doorAt),
        plan: (_l, _f, to) => [to],
    };
    const p = walkPath(deps, [{ x: 3014, z: 3200, tol: 0 }], { maxTicks: 40 });
    let result: Awaited<typeof p> | undefined;
    p.then(r => { result = r; });
    for (let i = 0; i < 40 && !result; i++) {
        tick++;
        const firstShut = [...shut].sort((a, b) => a - b)[0] ?? Infinity;
        for (let k = 0; k < 2 && x !== clickX; k++) {
            const nx = x + Math.sign(clickX - x);
            if (nx >= firstShut) break;
            x = nx;
        }
        if (opening !== null && x === opening - 1) { shut.delete(opening); opening = null; }
        for (const cb of [...listeners]) cb();
        await Promise.resolve();
    }
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.doors).toBe(2);
    // Immediately opens door 3008 after door 3004 opens, with zero intermediate walk click between them.
    const idx1 = inputs.findIndex(e => e.what === 'open 3004');
    const idx2 = inputs.findIndex(e => e.what === 'open 3008');
    expect(idx2).toBe(idx1 + 1);
});

test('travelGateLeg exits immediately on arrival without sleeping 4 blind ticks', async () => {
    let tick = 0;
    const pos = { worldX: 2461, worldZ: 3382, level: 0 };
    const listeners = new Set<() => void>();
    const s: any = {
        tick: () => tick,
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        sdk: {
            getState: () => ({
                player: pos,
                nearbyLocs: [{ id: 190, name: 'Gate', x: 2459, z: 3383, level: 0, optionsWithIndex: [{ text: 'Open', opIndex: 1 }] }],
            }),
            getDialog: () => ({ isOpen: false, options: [] }),
        },
        direct: async (a: any) => {
            if (a.type === 'interactLoc') { pos.worldX = 2461; pos.worldZ = 3385; }
            if (a.type === 'walkTo') { pos.worldX = a.x; pos.worldZ = a.z; }
            return { success: true };
        },
        bot: { walkTo: async () => ({ success: true }), interactLoc: async () => ({ success: true }) },
    };
    const gateLeg: any = {
        kind: 'travel',
        at: { x: 2461, z: 3382, level: 0 },
        to: { x: 2459, z: 3385, level: 0 },
        travel: {
            id: 'gate:test', kind: 'gate', name: 'Test Gate',
            from: { x: 2461, z: 3382, level: 0 }, to: { x: 2459, z: 3385, level: 0 },
            coins: 0, needs: [], runes: [], cost: 5,
            run: { how: 'gate', loc: 'Gate', action: 'Open', at: { x: 2459, z: 3383, level: 0 }, choices: [] },
        },
    };
    const work = walkRoute(s, [gateLeg], { maxRetriesPerLeg: 1 });
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        tick++;
        for (const cb of [...listeners]) cb();
    }
    const r = await work;
    expect(r.ok).toBe(true);
    // Previously waited 4 blind ticks after walkTo; now settles in 1 tick.
    expect(r.ticks).toBeLessThanOrEqual(2);
});

// ---------------- 3. Instant 1-Tick Combo Eating & Sustain ----------------

test('sustain comboEat dispatches shark + karambwan + attack resend in 1 single tick (+38 HP)', async () => {
    expect(isComboFood(COOKED_KARAMBWAN_ID)).toBe(true);
    expect(isComboFood(385)).toBe(false);
    const state = {
        skills: [{ name: 'Hitpoints', level: 40, baseLevel: 99 }],
        inventory: [
            { id: 385, slot: 0, count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
            { id: COOKED_KARAMBWAN_ID, slot: 1, count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
        ],
    };
    const policy = { food: [385], comboFood: [COOKED_KARAMBWAN_ID], eatAt: 60, comboAt: 50 };
    const picked = selectComboFood(state, policy);
    expect(picked).not.toBeNull();
    expect(picked!.primary.item.id).toBe(385);
    expect(picked!.combo.item.id).toBe(COOKED_KARAMBWAN_ID);
    expect(picked!.totalHeal).toBe(38);

    const sent: any[] = [];
    const attack = { type: 'interactPlayer', playerIndex: 5, optionIndex: 2 };
    const res = await comboEat({ direct: async a => { sent.push(a); return { success: true }; } }, state, policy, attack);
    expect(res).toEqual({ dispatched: true, combo: true, items: [385, COOKED_KARAMBWAN_ID], totalHeal: 38 });
    expect(sent).toEqual([
        { type: 'useInventoryItem', slot: 0, optionIndex: 1, reason: 'SDK' },
        { type: 'useInventoryItem', slot: 1, optionIndex: 1, reason: 'SDK' },
        attack,
    ]);
});

test('startQuestSustain with comboFood dispatches shark + karambwan in the same tick and verifies both debits', async () => {
    let tick = 0;
    let state: any = {
        skills: [{ name: 'Hitpoints', level: 30, baseLevel: 99 }],
        inventory: [
            { id: 385, slot: 0, count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
            { id: COOKED_KARAMBWAN_ID, slot: 1, count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
        ],
    };
    const listeners = new Set<() => void>();
    const sent: { tick: number; action: any }[] = [];
    const consumed: number[] = [];
    const s: any = {
        tick: () => tick,
        sdk: { getState: () => state },
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (action: any) => { sent.push({ tick, action }); return { success: true }; },
    };
    const eater = startQuestSustain(s, {
        food: [385], comboFood: [COOKED_KARAMBWAN_ID], eatAt: 60, comboAt: 40,
        onConsumed: e => consumed.push(e.id),
    });
    tick++; for (const cb of [...listeners]) cb();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(sent.length).toBe(2);
    expect(sent[0]!.tick).toBe(sent[1]!.tick);
    expect(sent.map(x => x.action.slot)).toEqual([0, 1]);
    state = { skills: [{ name: 'Hitpoints', level: 68, baseLevel: 99 }], inventory: [] };
    tick++; for (const cb of [...listeners]) cb();
    expect(consumed).toEqual([385, COOKED_KARAMBWAN_ID]);
    expect(eater.failure()).toBeNull();
    eater.stop();
});

test('eat-guard with comboFood stacks shark + karambwan + attack resend in 1 tick', () => {
    let tick = 0;
    let hp = 60;
    const inv = [
        { id: 385, slot: 0, count: 1, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
        { id: COOKED_KARAMBWAN_ID, slot: 1, count: 1, name: 'Cooked karambwan', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
    ];
    const perTick: string[][] = [];
    const inbox: any[] = [];
    const listeners = new Set<() => void>();
    const client = { executeBotAction(a: any) { inbox.push(a); return { success: true }; } };
    const state = () => ({
        player: { worldX: 3200, worldZ: 3200, level: 0, animId: -1, isDead: false },
        skills: [{ name: 'Hitpoints', level: hp, baseLevel: 99 }],
        inventory: inv.map(i => ({ ...i })),
        nearbyNpcs: [{ index: 3, id: 117, hp: 35, optionsWithIndex: [{ text: 'Attack', opIndex: 2 }] }],
        nearbyPlayers: [], modalOpen: false,
        dialog: { isOpen: false }, interface: { isOpen: false }, bank: { isOpen: false }, shop: { isOpen: false },
    });
    let pub = state();
    const s: any = {
        tick: () => tick, sdk: { getState: () => pub }, client,
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (a: any) => client.executeBotAction(a),
    };
    const step = () => {
        const got = inbox.splice(0);
        perTick.push(got.map(a => a.type));
        for (const a of got) {
            if (a.type === 'useInventoryItem') {
                const idx = inv.findIndex(i => i.slot === a.slot);
                if (idx >= 0) {
                    const id = inv[idx]!.id;
                    inv.splice(idx, 1);
                    hp = Math.min(99, hp + (id === 385 ? 20 : 18));
                }
            }
        }
        tick++; pub = state();
        for (const cb of [...listeners]) cb();
    };
    const guard = startEatGuard(s, { fightOnly: false, comboFood: [COOKED_KARAMBWAN_ID], eatAt: 40, comboAt: 25 });
    client.executeBotAction({ type: 'interactNpc', npcIndex: 3, optionIndex: 2 });
    step();
    hp = 20;
    step();
    step();
    expect(perTick.some(t => t.join(',') === 'useInventoryItem,useInventoryItem,interactNpc')).toBe(true);
    expect(hp).toBe(58);
    expect(guard.stats().eats).toBe(2);
    expect(guard.stats().healed).toBe(38);
    guard.stop();
});

// ---------------- 4. Zero-Tick-Waste Prayer Guard ----------------

test('prayer-guard eliminates redundant stale toggles on exclusive switches and prevents stale repair oscillation', () => {
    expect(areExclusivePrayers(PROTECT.melee, PROTECT.magic)).toBe(true);
    expect(areExclusivePrayers(PROTECT.melee, 10)).toBe(false);

    // Non-flick switch: 3 active prayers + fighting -> switching melee to magic sends only toggle(magic) + attack (2 inputs, <= 5).
    let tick = 0;
    const active = Array(15).fill(false);
    active[10] = true; active[11] = true; active[PROTECT.melee] = true;
    const listeners = new Set<() => void>();
    const perTick: any[][] = [];
    const inbox: any[] = [];
    const client = { selfSlot: 7, executeBotAction(a: any) { inbox.push(a); return { success: true }; } };
    let attackerId = 81;
    const makeState = () => ({
        tick,
        player: { worldX: 3200, worldZ: 3200, level: 0, animId: -1, isDead: false, combatLevel: 90, combat: { inCombat: true, targetType: 'npc', targetIndex: 3 } },
        prayers: { activePrayers: [...active], prayerPoints: 50, prayerLevel: 50 },
        nearbyNpcs: [{ index: 3, id: attackerId, hp: 50, distance: 5, size: 1, targetIndex: 32768 + 7, optionsWithIndex: [{ text: 'Attack', opIndex: 2 }] }],
        nearbyPlayers: [], gameMessages: [], nearbyLocs: [], inventory: [], combatEvents: [],
        modalOpen: false, dialog: { isOpen: false }, recentDialogs: [],
        interface: { isOpen: false }, bank: { isOpen: false }, shop: { isOpen: false }, skills: [],
    });
    let pub = makeState();
    const s: any = {
        tick: () => tick, sdk: { getState: () => pub }, client,
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (a: any) => client.executeBotAction(a),
    };
    const step = (lagState = false) => {
        const batch = inbox.splice(0, 5);
        perTick.push(batch);
        for (const a of batch) {
            if (a.type === 'togglePrayer') {
                active[a.prayerIndex] = !active[a.prayerIndex];
                if (active[a.prayerIndex]) {
                    for (const g of [[0, 3, 9], [1, 4, 10], [2, 5, 11], [12, 13, 14]])
                        if (g.includes(a.prayerIndex)) for (const i of g) if (i !== a.prayerIndex) active[i] = false;
                }
            }
        }
        tick++;
        if (!lagState) pub = makeState();
        for (const cb of [...listeners]) cb();
    };
    const guard = startPrayerGuard(s, {
        offence: true, calmTicks: 1,
        protect: npc => (npc?.id === 13 ? PROTECT.magic : PROTECT.melee),
    });
    client.executeBotAction({ type: 'interactNpc', npcIndex: 3, optionIndex: 2 });
    step();
    // Switch attacker to mage -> Protect Magic activates without redundantly toggling Protect Melee off first.
    attackerId = 13;
    step();
    step();
    expect(active[PROTECT.magic]).toBe(true);
    expect(active[PROTECT.melee]).toBe(false);
    expect(Math.max(...perTick.map(b => b.length))).toBeLessThanOrEqual(5);
    guard.stop();
});

test('prayer-guard skips redundant early flicks on walkTo ticks while keeping zero prayer drain', () => {
    let tick = 0, timer: number | null = 5, drains = 0;
    const active = Array(15).fill(false);
    active[PROTECT.melee] = true;
    const inbox: any[] = [];
    const listeners = new Set<() => void>();
    const client = { selfSlot: 7, executeBotAction(a: any) { inbox.push(a); return { success: true }; } };
    const makeState = () => ({
        tick,
        player: { worldX: 3200 + tick, worldZ: 3200, level: 0, animId: -1, isDead: false, combatLevel: 50, combat: { inCombat: false, targetType: 'none', targetIndex: -1 } },
        prayers: { activePrayers: [...active], prayerPoints: 50, prayerLevel: 50 },
        nearbyNpcs: [], nearbyPlayers: [], gameMessages: [], nearbyLocs: [], inventory: [], combatEvents: [],
        modalOpen: false, dialog: { isOpen: false }, recentDialogs: [],
        interface: { isOpen: false }, bank: { isOpen: false }, shop: { isOpen: false }, skills: [],
    });
    let pub = makeState();
    const s: any = {
        tick: () => tick, sdk: { getState: () => pub }, client,
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (a: any) => client.executeBotAction(a),
    };
    const guard = startPrayerGuard(s, { protect: false, every: 3 });
    for (let i = 0; i < 30; i++) {
        client.executeBotAction({ type: 'walkTo', x: 3210 + i, z: 3200 });
        for (const a of inbox.splice(0, 5)) {
            if (a.type === 'togglePrayer') {
                active[a.prayerIndex] = !active[a.prayerIndex];
                if (active[a.prayerIndex]) { if (timer === null) timer = 5; } else if (!active.some(Boolean)) timer = null;
            }
        }
        if (timer !== null && --timer === 0) { drains++; timer = 5; }
        tick++;
        pub = makeState();
        for (const cb of [...listeners]) cb();
    }
    expect(drains).toBe(0);
    // Walking every tick for 30 ticks with every=3 should flick ~10 times, never 30 times.
    expect(guard.stats().flicks).toBeLessThanOrEqual(12);
    guard.stop();
});

// ---------------- 5. Zero-Tick-Waste Looting & Enemy PvP Weapon Priority ----------------

test('loot-policy prioritizes enemy PvP weapons first, then value, then closest tile, with cached glob matching', () => {
    expect(PVP_WEAPON_IDS.has(1231)).toBe(true); // dragon_dagger_p
    expect(PVP_WEAPON_IDS.has(1333)).toBe(true); // rune_scimitar
    expect(PVP_WEAPON_IDS.has(861)).toBe(true);  // magic_shortbow
    expect(isPvpWeapon({ id: 1231 })).toBe(true);
    expect(isPvpWeapon({ id: 385, name: 'Shark' })).toBe(false);
    expect(lootNameMatches('Dragon dagger(p)', 'dragon dagger*')).toBe(true);
    expect(lootNameMatches('Rune scimitar', 'rune *')).toBe(true);

    const piles = [
        { id: 385, name: 'Shark', count: 1, x: 3080, z: 3640, distance: 0 },
        { id: 995, name: 'Coins', count: 150_000, x: 3080, z: 3640, distance: 0 },
        { id: 1333, name: 'Rune scimitar', count: 1, x: 3080, z: 3640, distance: 2 },
        { id: 1231, name: 'Dragon dagger(p)', count: 1, x: 3080, z: 3640, distance: 1 },
        { id: 560, name: 'Death rune', count: 200, x: 3081, z: 3640, distance: 1 },
        { id: 1305, name: 'Dragon longsword', count: 1, x: 3080, z: 3640, distance: 1, reachable: false },
    ];
    const values: Record<number, number> = { 385: 900, 995: 1, 1333: 18_000, 1231: 32_000, 560: 250, 1305: 60_000 };
    const ranked = rankGroundLoot(piles, (id, count) => (values[id] ?? 0) * count, { minValue: 5_000 });
    // Unreachable dragon longsword excluded; shark (900 < 5000) excluded; PvP weapons first (DDP > rune scimitar), then Coins 150k, then Death runes 50k.
    expect(ranked.map(p => p.id)).toEqual([1231, 1333, 995, 560]);
});

test('pickupLootBatch loots 4 PvP kill drops in exact priority order in 4 ticks (zero inter-item delay)', async () => {
    let tick = 0;
    const ground = [
        { id: 385, name: 'Shark', count: 1, x: 3080, z: 3640, distance: 0 },
        { id: 1333, name: 'Rune scimitar', count: 1, x: 3080, z: 3640, distance: 0 },
        { id: 1231, name: 'Dragon dagger(p)', count: 1, x: 3080, z: 3640, distance: 0 },
        { id: 995, name: 'Coins', count: 80_000, x: 3080, z: 3640, distance: 0 },
    ];
    const inv: { id: number; count: number; slot: number }[] = [];
    const listeners = new Set<() => void>();
    const inbox: any[] = [];
    const s: any = {
        tick: () => tick,
        sdk: { getState: () => ({ player: { worldX: 3080, worldZ: 3640, level: 0, isDead: false }, groundItems: [...ground], inventory: [...inv] }) },
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (a: any) => { inbox.push(a); return { success: true }; },
    };
    const values: Record<number, number> = { 385: 900, 1333: 18_000, 1231: 32_000, 995: 1 };
    const work = pickupLootBatch(s, {
        valueOf: (id, count) => (values[id] ?? 0) * count,
        stackableOf: id => ({ stackable: id === 995 }),
        minValue: 500,
    });
    for (let i = 0; i < 6; i++) {
        for (const a of inbox.splice(0, 1)) {
            if (a.type === 'pickupItem') {
                const idx = ground.findIndex(g => g.id === a.itemId && g.x === a.x && g.z === a.z);
                if (idx >= 0) {
                    const g = ground.splice(idx, 1)[0]!;
                    inv.push({ id: g.id, count: g.count, slot: inv.length });
                }
            }
        }
        tick++;
        for (const cb of [...listeners]) cb();
        await Promise.resolve();
    }
    const res = await work;
    expect(res.picked.map(p => p.id)).toEqual([1231, 1333, 995, 385]);
    expect(res.ticks).toBe(4);
});

test('lootRoom O(N) preserves exact cheap-slot drop selection on full pack', () => {
    const t: LootTables = {
        info: id => ({ name: `item${id}`, debugname: `item${id}`, cost: id === 1231 ? 30_000 : 10, tradeable: true }),
        bid: () => 0,
        wanted: () => false,
    };
    const pack = Array.from({ length: 28 }, (_, slot) => ({ slot, id: 100, count: 1 }));
    expect(lootRoom(pack, { id: 1231, count: 1, x: 0, z: 0, distance: 0 }, t, () => false, id => ({ stackable: id === 995 }))).toBe(27);
});
