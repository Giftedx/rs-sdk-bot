import { expect, test } from 'bun:test';
import { CONFIGS, isNonWildernessGatherGoal, roamTarget, runGenericCombatSession } from '../src/combat/melee-gather';
import { edgevilleRoute } from '../src/combat/survivability';
import { inWilderness } from '../src/logistics/preflight';
import { TAKER_WAIT_POLL_MS, TRADE_REQUEST_TIMEOUT_MS, performFleetTransfer, waitForGiver, type FleetTradeProgress } from '../src/logistics/trade-helpers';
import { buyFromShops, crossesWilderness } from '../src/quest/sweep-travel';

test('non-PvP druid config routes to Taverley Dungeon and Edgeville/quest/logistics guards block underground Wilderness', () => {
    expect(CONFIGS.druid!.spot).toEqual({ x: 2933, z: 9849 });
    expect(CONFIGS.druid!.bankSpot).toEqual({ x: 2946, z: 3368 });
    expect(CONFIGS.druid!.taverley).toBe(true);
    expect(isNonWildernessGatherGoal(CONFIGS.druid!.spot.x, CONFIGS.druid!.spot.z)).toBe(true);
    expect(isNonWildernessGatherGoal(3131, 9918)).toBe(false);
    expect(isNonWildernessGatherGoal(3133, 9947)).toBe(false);
    expect(isNonWildernessGatherGoal(3091, 9933)).toBe(false);

    // edgevilleRoute forbids entering Edgeville Dungeon Wilderness unless explicitly authorized,
    // while still permitting safe Hill Giants (3117,9850) and escaping south from Wilderness to surface bank.
    expect(() => edgevilleRoute({ x: 3092, z: 3496, level: 0 }, { x: 3115, z: 9928, level: 0 }, 'druid')).toThrow(/Wilderness destination forbidden/);
    const giantIn = edgevilleRoute({ x: 3092, z: 3496, level: 0 }, { x: 3117, z: 9850, level: 0 }, 'giant');
    expect(giantIn.some(s => s.kind === 'enter')).toBe(true);
    const escapeOut = edgevilleRoute({ x: 3115, z: 9928, level: 0 }, { x: 3092, z: 3496, level: 0 }, 'druid');
    expect(escapeOut.some(s => s.kind === 'exit')).toBe(true);
    expect(escapeOut.some(s => s.kind === 'walk' && s.x === 3131 && s.z === 9916)).toBe(true);

    // Underground Edgeville Dungeon Wilderness detected by logistics/preflight and quest/sweep-travel.
    expect(inWilderness({ x: 3133, z: 9947 })).toBe(true);
    expect(inWilderness({ x: 3091, z: 9933 })).toBe(true);
    expect(inWilderness({ x: 3117, z: 9850 })).toBe(false);
    expect(crossesWilderness({ x: 3131, z: 9916 }, { x: 3131, z: 9922 })).toBe(true);
    expect(crossesWilderness({ x: 3096, z: 9867 }, { x: 3117, z: 9850 })).toBe(false);
});

test('roamTarget selects nearest mob when alone and runGenericCombatSession eliminates idle pickup/kill waits', async () => {
    const picked = roamTarget('Bigpackage', [{ index: 10, distance: 9 }, { index: 11, distance: 2 }, { index: 12, distance: 5 }], false);
    expect(picked?.index).toBe(11);

    let tick = 0;
    const listeners = new Set<() => void>();
    const npcs: { index: number; id: number; name: string; distance: number; reachable: boolean; inCombat: boolean; targetIndex: number }[] = [
        { index: 1, id: 181, name: 'Chaos druid', distance: 1, reachable: true, inCombat: false, targetIndex: -1 },
        { index: 2, id: 181, name: 'Chaos druid', distance: 1, reachable: true, inCombat: false, targetIndex: -1 },
    ];
    const groundItems: { id: number; name: string; distance: number; x: number; z: number }[] = [];
    const timer = setInterval(() => {
        tick = npcs.length === 0 && groundItems.length === 0 ? 301 : tick + 1;
        for (const fn of [...listeners]) fn();
    }, 1);
    const inv: { id: number; name: string; count: number; slot: number }[] = Array.from({ length: 5 }, (_, slot) => ({ id: 385, name: 'Shark', count: 1, slot }));
    const bank: { id: number; name: string; count: number }[] = [];
    let bankOpen = false;
    let generation = 1;
    let pickupCalls = 0;

    const session: any = {
        name: 'FastFighter',
        tick: () => tick,
        onTick: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
        ended: new Promise(() => {}),
        client: { selfSlot: 1, executeBotAction: () => ({ success: true }) },
        direct: async () => ({ success: true }),
        bankObservation: () => ({ generation, items: bank }),
        sdk: {
            getState: () => ({
                player: { worldX: 2933, worldZ: 9849, level: 0, lifeId: 1, respawnCount: 0, isDead: false, combat: { inCombat: false } },
                nearbyNpcs: npcs,
                nearbyLocs: [],
                groundItems,
                inventory: inv,
                equipment: [],
                bank: { isOpen: bankOpen, items: bank },
                dialog: { isOpen: false },
                interface: { isOpen: false },
            }),
            getInventory: () => inv,
            getNearbyLocs: () => [],
            getSkill: (name: string) => ({ level: name === 'Hitpoints' ? 60 : 60, baseLevel: 60 }),
            getStateAge: () => 0,
            sendCloseModal: async () => { bankOpen = false; },
        },
        bot: {
            pickupItem: async (item: { id?: number; name?: string }) => {
                pickupCalls++;
                const idx = groundItems.findIndex(g => g.id === item.id);
                if (idx >= 0) {
                    const [taken] = groundItems.splice(idx, 1);
                    inv.push({ id: taken!.id, name: taken!.name, count: 1, slot: inv.length });
                    return { success: true };
                }
                return { success: false };
            },
            attack: async (m: { index: number }) => {
                const idx = npcs.findIndex(n => n.index === m.index);
                if (idx >= 0) {
                    npcs.splice(idx, 1);
                    if (m.index === 1) groundItems.push({ id: 207, name: 'Unidentified ranarr herb', distance: 1, x: 2933, z: 9849 });
                }
                return { success: true };
            },
            openBank: async () => { bankOpen = true; generation++; return { success: true }; },
            closeInterface: async () => { bankOpen = false; return { success: true }; },
            depositItem: async (row: { id: number; name: string }) => {
                let n = 0;
                for (let i = inv.length - 1; i >= 0; i--) {
                    if (inv[i]!.id === row.id) { n += inv[i]!.count; inv.splice(i, 1); }
                }
                bank.push({ id: row.id, name: row.name, count: n });
                generation++;
                return { success: true };
            },
        },
    };

    try {
        const res = await runGenericCombatSession(session, {
            target: 'druid',
            cap: 300,
            stop: () => false,
            walk: async () => true,
        });
        expect(res).toMatchObject({ ok: true, kills: 2, itemsLooted: 1 });
        // Zero wasted pickupItem scans when no matching drop exists, and zero post-kill/post-pickup dead ticks.
        expect(pickupCalls).toBe(1);
    } finally {
        clearInterval(timer);
    }
});

test('buyFromShops reuses an already-open shop across items and wakes immediately on restock', async () => {
    let tick = 0;
    const listeners = new Set<() => void>();
    let shopOpen = false;
    let openCalls = 0;
    let closeCalls = 0;
    const inv: { id: number; count: number }[] = [{ id: 995, count: 500 }];
    const shopItems = [
        { id: 590, count: 1, name: 'Tinderbox' },
        { id: 946, count: 0, name: 'Knife' },
    ];
    const timer = setInterval(() => {
        tick++;
        if (tick === 2) shopItems[1]!.count = 1;
        for (const fn of [...listeners]) fn();
    }, 1);

    const s: any = {
        name: 'Shopper',
        tick: () => tick,
        onTick: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
        sdk: {
            getState: () => ({
                player: { worldX: 3212, worldZ: 3415, level: 0 },
                inventory: inv,
                nearbyNpcs: [{ id: 520, name: 'Shop keeper', distance: 1 }],
                shop: { isOpen: shopOpen, shopItems },
            }),
            getSkill: () => ({ level: 1 }),
        },
        bot: {
            openShop: async () => { openCalls++; shopOpen = true; return { success: true }; },
            closeShop: async () => { closeCalls++; shopOpen = false; return { success: true }; },
            buyFromShop: async (row: { id: number; count: number }, want: number) => {
                row.count -= want;
                inv.push({ id: row.id, count: want });
                return { success: true };
            },
            openDoor: async () => ({ success: false }),
        },
    };
    const world: any = {
        route: () => ({ ok: true, cost: 0, legs: [] }),
        navigationGraph: () => ({ transports: [], travel: [] }),
    };

    try {
        const err = await buyFromShops(s, world, [
            { id: 590, name: 'Tinderbox', count: 1, npc: 'Shop keeper', npcId: 520, tile: { x: 3212, z: 3415, level: 0 } },
            { id: 946, name: 'Knife', count: 1, npc: 'Shop keeper', npcId: 520, tile: { x: 3212, z: 3415, level: 0 } },
        ]);
        expect(err).toBeNull();
        expect(openCalls).toBe(1);
        expect(closeCalls).toBe(1);
        // Woke immediately on tick 2 restock instead of sleeping 50 ticks.
        expect(tick).toBeLessThan(20);
    } finally {
        clearInterval(timer);
    }
});

test('fleet-trade uses fast giver polling and avoids blind pacing before partner is visible', async () => {
    expect(TAKER_WAIT_POLL_MS).toBeLessThanOrEqual(250);
    expect(TRADE_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(10_000);

    let now = 0;
    const sleeps: number[] = [];
    const res = await waitForGiver(
        { id: 'o-fast', server: 'live', from: 'A', to: 'B', item: 'Coins', count: 100, start: 0, end: 60 * 60_000, takerWaits: true },
        { ready: () => now >= 500, failed: () => false, now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; } },
    );
    expect(res).toBe('ready');
    expect(now).toBe(500);
    expect(sleeps).toEqual([250, 250]);

    // performFleetTransfer waits for partner visibility before calling trade() and does not pace blindly.
    let partnerVisible = false;
    let tradeCalls = 0;
    let walkCalls = 0;
    let observedRequestTimeout = 0;
    const inv: { id: number; name: string; count: number; slot: number }[] = [];
    const progress: FleetTradeProgress = { uncertain: false, count: 0 };
    const s: any = {
        ended: new Promise(() => {}),
        sdk: {
            getInventory: () => inv,
            findNearbyPlayer: () => (partnerVisible ? { name: 'Giver', distance: 1 } : null),
            getState: () => ({ inventory: inv, bank: { isOpen: false, items: [] } }),
        },
        bankObservation: () => ({ generation: 1, at: 1000, items: [{ id: 995, count: 100 }] }),
        client: { objType: () => ({ stackable: true, certtemplate: -1, certlink: -1 }) },
        bot: {
            walkTo: async () => { walkCalls++; return { success: true }; },
            openBank: async () => ({ success: true }),
            closeBank: async () => ({ success: true }),
            trade: async (_peer: RegExp, opts: { requestTimeout: number }) => {
                tradeCalls++;
                observedRequestTimeout = opts.requestTimeout;
                inv.push({ id: 995, name: 'Coins', count: 100, slot: 0 });
                return { success: true, partner: 'Giver', gave: [], received: [{ id: 995, name: 'Coins', count: 100 }] };
            },
        },
    };
    let waitCalls = 0;
    await performFleetTransfer(
        s,
        { id: 'o-vis', server: 'live', from: 'Giver', to: 'Taker', item: 'Coins', count: 100, start: 0, end: 60_000 },
        'to',
        progress,
        {
            now: () => 0,
            wait: async (_sess, pred) => {
                waitCalls++;
                if (waitCalls === 1) partnerVisible = true;
                return pred(s.sdk.getState());
            },
            deposit: async () => 100,
        },
    );
    expect(tradeCalls).toBe(1);
    expect(walkCalls).toBe(0);
    expect(observedRequestTimeout).toBe(TRADE_REQUEST_TIMEOUT_MS);
});
