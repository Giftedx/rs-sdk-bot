// Consolidated unit tests for woodcutting gathering: Edgeville oaks, yews/groves/processing, and woodcut supply.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, spyOn, test } from 'bun:test';
import type { Session } from '../../core/src/inprocess';
import * as cargo from '../../core/src/cargo';
import * as walking from '../../core/src/walk';
import { at, fakeSession } from '../../core/test/fake';
import {
    chopProcessingTree,
    normalizeGatherConfig,
    normalGrove,
    oakGrove,
    processingTreeEdges,
    reconcileWoodSupplyAxe,
    reconcileWoodcuttingAxeAtBank,
    runDraynorOak,
    runEdgevilleWoodcut,
    runWoodSupply,
    runYewsGather,
    seersProcessingGrove,
    selectEdgevilleWoodcutAxe,
    selectWoodSupplyAxe,
    supplyPlan,
    takeOwnedSupplyKnife,
    treeAfterBank,
    westOakPathAllowed,
    woodStallTicks,
    woodTreeOrder,
} from '../src/gather';

// --- Edgeville woodcutting (formerly edgeville-woodcut-order.test.ts) ---
test('selectEdgevilleWoodcutAxe picks highest owned rev-289 axe and carries vs wields by Attack', () => {
    const bank = [{ id: 1351, count: 1 }, { id: 1353, count: 1 }, { id: 1359, count: 1 }];
    const low = selectEdgevilleWoodcutAxe(bank, { Woodcutting: 15, Attack: 1 });
    expect(low.current?.item.id).toBe(1359);
    expect(low.current?.canWield).toBe(false);

    const high = selectEdgevilleWoodcutAxe(bank, { Woodcutting: 15, Attack: 40 });
    expect(high.current?.item.id).toBe(1359);
    expect(high.current?.canWield).toBe(true);
});

for (const attack of [1, 40]) {
    test(`runEdgevilleWoodcut upgrades to Rune axe (Attack ${attack}) and reconciles container totals at bank`, async () => {
        let tick = 0;
        let bankOpen = false;
        let gen = 1;
        let wcLevel = 15;
        let wcXp = 2500;
        const listeners = new Set<() => void>();
        const timer = setInterval(() => {
            tick++;
            for (const fn of [...listeners]) fn();
        }, 1);
        const inv: any[] = [];
        const eq: any[] = [];
        const bank: any[] = [
            { id: 1359, name: 'Rune axe', count: 1, slot: 0 },
            { id: 1351, name: 'Bronze axe', count: 1, slot: 1 },
            { id: 1521, name: 'Oak logs', count: 5, slot: 2 },
        ];
        const oakTree = { id: 1281, name: 'Oak', x: 3126, z: 3437, distance: 1, optionsWithIndex: [{ text: 'Chop down', opIndex: 1 }] };
        const state: any = {
            player: { worldX: 3094, worldZ: 3492, level: 0, hp: 10, isDead: false },
            bank: { isOpen: false, items: bank },
            inventory: inv,
            equipment: eq,
            nearbyLocs: [oakTree],
        };

        const s: any = {
            tick: () => tick,
            onTick: (fn: () => void) => {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
            bankObservation: () => (bankOpen ? { generation: gen, items: bank } : null),
            sdk: {
                getState: () => ({ ...state, inventory: inv, equipment: eq, bank: { isOpen: bankOpen, items: bank } }),
                getInventory: () => inv,
                getEquipment: () => eq,
                getBankItems: () => bank,
                getSkill: (n: string) => ({ level: n === 'Woodcutting' ? wcLevel : n === 'Attack' ? attack : 10, baseLevel: n === 'Woodcutting' ? wcLevel : n === 'Attack' ? attack : 10 }),
                getSkillXp: () => wcXp,
            },
            bot: {
                dismissBlockingUI: async () => undefined,
                openBank: async () => {
                    bankOpen = true;
                    state.bank.isOpen = true;
                    gen++;
                    return { success: true };
                },
                closeBank: async () => {
                    bankOpen = false;
                    state.bank.isOpen = false;
                    return { success: true };
                },
                withdrawItem: async (item: any, n: number) => {
                    const row = bank.find(r => r.id === item.id);
                    row.count -= n;
                    if (row.count <= 0) bank.splice(bank.indexOf(row), 1);
                    inv.push({ id: item.id, name: item.name, count: n });
                    gen++;
                    return { success: true };
                },
                depositItem: async (item: any) => {
                    const idx = inv.findIndex(r => r.id === item.id);
                    const [removed] = inv.splice(idx, 1);
                    const row = bank.find(r => r.id === removed.id);
                    if (row) row.count += removed.count;
                    else bank.push({ ...removed });
                    gen++;
                    return { success: true };
                },
                equipItem: async (item: any) => {
                    bankOpen = false;
                    state.bank.isOpen = false;
                    const idx = inv.findIndex(r => r.id === item.id);
                    const [removed] = inv.splice(idx, 1);
                    eq.push({ ...removed, slot: 3 });
                    return { success: true };
                },
                unequipItem: async (item: any) => {
                    bankOpen = false;
                    state.bank.isOpen = false;
                    const idx = eq.findIndex(r => r.id === item.id);
                    const [removed] = eq.splice(idx, 1);
                    inv.push({ id: removed.id, name: removed.name, count: removed.count });
                    return { success: true };
                },
                interactLoc: async () => {
                    const logRow = inv.find(i => i.id === 1521);
                    if (logRow) logRow.count++;
                    else inv.push({ id: 1521, name: 'Oak logs', count: 1 });
                    wcXp += 1000;
                    wcLevel = 36;
                    return { success: true };
                },
            },
        };

        const spies = [
            spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
            spyOn(walking, 'walkPath').mockImplementation(async (_w, points) => {
                const last = points.at(-1)!;
                state.player.worldX = last.x;
                state.player.worldZ = last.z;
                return { ok: true, ticks: 1 } as any;
            }),
        ];
        try {
            const res = await runEdgevilleWoodcut(s, () => false);
            expect(res.ok).toBe(true);
            expect(res.level).toBe(36);
            expect(res.banked).toBe(1);
            expect(inv).toHaveLength(0);
            expect(eq).toHaveLength(0);
            expect(bank.find(i => i.id === 1359)?.count).toBe(1);
            expect(bank.find(i => i.id === 1351)?.count).toBe(1);
            expect(bank.find(i => i.id === 1521)?.count).toBe(6);
        } finally {
            for (const spy of spies) spy.mockRestore();
            clearInterval(timer);
        }
    });
}

// --- Yews, groves & processing trees (formerly gather-yews.test.ts) ---
const woodTree = (x: number, distance: number) => ({ x, z: 3285, distance, reachable: true, optionsWithIndex: [{ text: 'Chop down', opIndex: 1 }] });

test('Draynor chooses an available tree over the closer tree another player is already chopping', () => {
    const close = woodTree(3086, 1);
    const clear = woodTree(3091, 5);
    expect(woodTreeOrder([close, clear], [{ x: 3086, z: 3284 }])[0]).toBe(clear);
    expect(woodTreeOrder([close, clear], [])[0]).toBe(close);
});

test('wood selection excludes unreachable or non-choppable resources before ranking', () => {
    const clear = woodTree(3091, 5);
    expect(woodTreeOrder([{ ...woodTree(3086, 1), reachable: false }, { ...woodTree(3087, 2), optionsWithIndex: [] }, clear], [])).toEqual([clear]);
});

test('northern normal grove has separate primary map trees and keeps the old grove unchanged', () => {
    const north = normalGrove('north');
    const south = normalGrove();
    expect(north.spot).toEqual({ x: 3088, z: 3303 });
    expect(north.contains(3089, 3301)).toBe(true);
    expect(north.contains(3086, 3284)).toBe(false);
    expect(south.contains(3086, 3284)).toBe(true);
    expect(south.contains(3089, 3301)).toBe(false);
    expect(() => normalGrove('unknown')).toThrow('unsupported NORMAL_GROVE');
});

test('explicit TREE survives a bank visit with fewer than 100 normal logs', () => {
    expect(treeAfterBank('oak', 13)).toBe('oak');
    expect(treeAfterBank('normal', 500)).toBe('normal');
    expect(treeAfterBank(undefined, 13)).toBe('normal');
    expect(treeAfterBank(undefined, 100)).toBe('oak');
});

function oakFixture(stalled = false, west = false) {
    let tick = 0;
    let open = false;
    let generation = 0;
    let xp = 1010625;
    const listeners = new Set<() => void>();
    const inv: any[] = [];
    const bank: any[] = [
        { id: 1349, name: 'Iron axe', count: 2, slot: 0 },
        { id: 1351, name: 'Bronze axe', count: 1, slot: 1 },
        { id: 315, name: 'Shrimps', count: 1, slot: 2 },
        { id: 2309, name: 'Bread', count: 1, slot: 3 },
        { id: 1511, name: 'Logs', count: 13, slot: 4 },
        { id: 995, name: 'Coins', count: 84, slot: 5 },
    ];
    const trees = (west ? [[3102, 3242, 1], [3081, 3291, 1], [3070, 3253, 3]] : [[3081, 3291, 2]]).map(([x, z, distance]) => ({
        id: 1281,
        name: 'Oak',
        x,
        z,
        distance,
        optionsWithIndex: [{ text: 'Chop down', opIndex: 1 }],
    }));
    const chopped: { x: number; z: number }[] = [];
    const state = () => ({ player: { worldX: 3092, worldZ: 3243, level: 0, lifeId: 1, respawnCount: 0 }, equipment: [], inventory: inv, bank: { isOpen: open, items: bank }, nearbyLocs: trees });
    const timer = setInterval(() => {
        tick++;
        for (const f of [...listeners]) f();
    }, 1);
    const s: any = {
        name: 'fixture',
        tick: () => tick,
        onTick: (f: () => void) => {
            listeners.add(f);
            return () => listeners.delete(f);
        },
        ended: new Promise(() => {}),
        bankObservation: () => (open ? { generation, at: Date.now(), items: bank } : null),
        sdk: {
            getState: state,
            getInventory: () => inv,
            getSkill: (n: string) => ({ level: n === 'Hitpoints' ? 11 : 99, baseLevel: n === 'Hitpoints' ? 11 : 99 }),
            getSkillXp: () => xp,
            sendInteractLoc: async (x: number, z: number) => {
                chopped.push({ x, z });
                if (!stalled) {
                    const row = inv.find(i => i.id === 1521);
                    if (row) row.count++;
                    else inv.push({ id: 1521, name: 'Oak logs', count: 1, slot: inv.length });
                    xp += 937;
                }
                return { success: true };
            },
        },
        bot: {
            openBank: async () => {
                open = true;
                generation++;
                return { success: true };
            },
            closeBank: async () => {
                open = false;
                return { success: true };
            },
            withdrawItem: async (item: any, n: number) => {
                item.count -= n;
                inv.push({ id: item.id, name: item.name, count: n, slot: inv.length });
                generation++;
                return { success: true };
            },
            depositItem: async (item: any) => {
                let row = bank.find(i => i.id === item.id);
                if (!row) {
                    row = { ...item, slot: bank.length, count: 0 };
                    bank.push(row);
                }
                row.count += item.count;
                inv.splice(inv.indexOf(item), 1);
                generation++;
                return { success: true };
            },
        },
        direct: async () => ({ success: true }),
    };
    return { s: s as Session, inv, bank, chopped, dispose: () => clearInterval(timer) };
}

test('prepare withdraws only owned axe and 2 foods then banks 25 NEW oak while preserving all kit assets', async () => {
    const f = oakFixture();
    try {
        const r = await runDraynorOak(f.s, { cap: 500, maximum: 25, prepare: true, walk: async () => true });
        expect(r.ok).toBe(true);
        expect(r.banked).toBe(25);
        expect(r.newLogs).toBe(25);
        expect(r.preserved).toBe(true);
        expect(f.inv.find(i => i.id === 1349).count).toBe(1);
        expect(f.bank.find(i => i.id === 1349).count).toBe(1);
        expect(f.bank.find(i => i.id === 1511).count).toBe(13);
    } finally {
        f.dispose();
    }
});

test('west opt-in uses only verified 3070,3253 Oak and northern waypoints both ways; default stays north', async () => {
    expect(oakGrove().name).toBe('north');
    expect([...oakGrove().trees]).toEqual(['3081,3291', '3082,3295']);
    expect(() => oakGrove('nearest')).toThrow('unsupported OAK_GROVE');
    const f = oakFixture(false, true);
    const walks: number[][] = [];
    try {
        const r = await runDraynorOak(f.s, {
            cap: 500,
            maximum: 25,
            prepare: true,
            grove: 'west',
            walk: async (x, z, tol) => {
                walks.push([x, z, tol]);
                return true;
            },
        });
        expect(r.ok).toBe(true);
        expect(r.grove).toBe('west');
        expect(r.banked).toBe(25);
        expect(r.preserved).toBe(true);
        expect(r.plannedPathTiles).toBeNull();
        expect(walks).toEqual([[3092, 3250, 1], [3089, 3266, 1], [3070, 3253, 3], [3089, 3266, 1], [3092, 3250, 1], [3092, 3243, 2]]);
        expect(f.chopped).toHaveLength(25);
        expect(f.chopped.every(p => p.x === 3070 && p.z === 3253)).toBe(true);
    } finally {
        f.dispose();
    }
});

test('west full expanded paths reject dark-wizard shortcut, eastern guard approach and unknown empty fallback', () => {
    const bank = { x: 3092, z: 3243 };
    expect(westOakPathAllowed(bank, [{ x: 3092, z: 3250 }, { x: 3089, z: 3266 }, { x: 3073, z: 3255 }])).toBe(true);
    expect(westOakPathAllowed(bank, [{ x: 3089, z: 3247 }, { x: 3073, z: 3255 }])).toBe(false);
    expect(westOakPathAllowed(bank, [{ x: 3098, z: 3250 }, { x: 3073, z: 3255 }])).toBe(false);
    expect(westOakPathAllowed(bank, [])).toBe(false);
});

test('west guard permits the observed F88E northern fence detour 3103,3271 only for its bank access leg', () => {
    const south = { x: 3092, z: 3250 };
    const north = { x: 3089, z: 3266 };
    const outward = [{ x: 3094, z: 3250 }, { x: 3096, z: 3251 }, { x: 3098, z: 3252 }, { x: 3100, z: 3254 }, { x: 3102, z: 3255 }, { x: 3103, z: 3265 }, { x: 3103, z: 3271 }, { x: 3095, z: 3271 }, { x: 3092, z: 3269 }, north];
    const returning = [{ x: 3092, z: 3269 }, { x: 3096, z: 3271 }, { x: 3102, z: 3271 }, { x: 3103, z: 3270 }, { x: 3103, z: 3256 }, { x: 3101, z: 3255 }, { x: 3097, z: 3252 }, { x: 3095, z: 3250 }, south];
    expect(westOakPathAllowed({ x: 3092, z: 3242 }, [south])).toBe(true);
    expect(westOakPathAllowed(south, outward, north)).toBe(true);
    expect(westOakPathAllowed(north, returning, south)).toBe(true);
    expect(westOakPathAllowed(south, [{ x: 3104, z: 3265 }, north], north)).toBe(false);
    expect(westOakPathAllowed(south, [{ x: 3103, z: 3249 }, north], north)).toBe(false);
    expect(westOakPathAllowed(south, [{ x: 3089, z: 3247 }, north], north)).toBe(false);
    expect(westOakPathAllowed(north, [{ x: 3103, z: 3271 }, { x: 3073, z: 3255 }])).toBe(false);
});

test('already held owned foods count toward preparation without withdrawing duplicate bank food', async () => {
    const f = oakFixture();
    f.inv.push(...f.bank.splice(2, 2).map((i: any, j: number) => ({ ...i, slot: j })));
    try {
        const r = await runDraynorOak(f.s, { cap: 500, maximum: 25, prepare: true, walk: async () => true });
        expect(r.ok).toBe(true);
        expect(f.inv.filter(i => i.id === 315 || i.id === 2309).reduce((n, i) => n + i.count, 0)).toBe(2);
        expect(r.preserved).toBe(true);
    } finally {
        f.dispose();
    }
});

test('missing owned preparation food fails without chopping; stalled output remains bounded', async () => {
    const missing = oakFixture();
    missing.bank.splice(2, 2);
    try {
        const r = await runDraynorOak(missing.s, { cap: 100, maximum: 25, prepare: true, walk: async () => true });
        expect(r.ok).toBe(false);
        expect(r.newLogs).toBe(0);
        expect(r.failure).toContain('food');
    } finally {
        missing.dispose();
    }
    const stalled = oakFixture(true);
    try {
        const r = await runDraynorOak(stalled.s, { cap: 100, maximum: 25, prepare: true, noProgress: 12, walk: async () => true });
        expect(r.ok).toBe(false);
        expect(r.newLogs).toBe(0);
        expect(r.failure).toContain('no wood progress');
    } finally {
        stalled.dispose();
    }
});

test('opt-in Native processing groves put willow and magic placements within observed loc radius', () => {
    for (const [tree, tiles] of [['willow', [[2704, 3506]]], ['magic', [[2690, 3427], [2691, 3424], [2696, 3423]]]] as const) {
        const point = seersProcessingGrove(tree);
        for (const [x, z] of tiles) expect(Math.max(Math.abs(point.x - x), Math.abs(point.z - z))).toBeLessThanOrEqual(15);
    }
    for (const [tree, map, id] of [['willow', 54, 1308], ['magic', 53, 1306]] as const) {
        const p = seersProcessingGrove(tree);
        const rows = readFileSync(resolve(import.meta.dir, `../../../vendor/rs-sdk/server/content/maps/m42_${map}.jm2`), 'utf8')
            .split(/\r?\n/)
            .map(l => l.match(/^0 (\d+) (\d+): (\d+) /))
            .filter(v => v && Number(v[3]) === id);
        expect(rows.some(v => Math.max(Math.abs(42 * 64 + Number(v![1]) - p.x), Math.abs(map * 64 + Number(v![2]) - p.z)) <= 15)).toBe(true);
    }
    expect(seersProcessingGrove('yew')).toEqual({ x: 2712, z: 3462 });
    expect(seersProcessingGrove('maple')).toEqual({ x: 2712, z: 3462 });
    expect(() => seersProcessingGrove('redwood')).toThrow();
});

function processingActor(refuse = false) {
    let tick = 10;
    let inputs = 0;
    const tree: any = { id: 1306, name: 'Magic tree', x: 2690, z: 3427, level: 0, distance: 2, reachable: true, optionsWithIndex: [{ text: 'Chop down', opIndex: 1 }] };
    const state: any = {
        tick: 10,
        player: { worldX: 2692, worldZ: 3426, level: 0, lifeId: 1, respawnCount: 0 },
        nearbyLocs: [tree],
        inventory: [],
        dialog: { isOpen: false, options: [] },
        interface: { isOpen: false },
        gameMessages: [],
    };
    const timers = new Set<ReturnType<typeof setInterval>>();
    const s: any = {
        name: 'woodunit',
        client: {
            executeBotAction: () => {},
            mapBuildBaseX: 0,
            mapBuildBaseZ: 0,
            minusedlevel: 0,
            localPlayer: {
                get routeX() {
                    return [state.player.worldX];
                },
                get routeZ() {
                    return [state.player.worldZ];
                },
                routeLength: 0,
            },
            locTypeOf: () => ({ width: 2, length: 2 }),
        },
        tick: () => tick,
        onTick: (f: () => void) => {
            const timer = setInterval(() => {
                tick++;
                state.tick = tick;
                f();
            }, 1);
            timers.add(timer);
            return () => {
                clearInterval(timer);
                timers.delete(timer);
            };
        },
        sdk: {
            getState: () => state,
            getSkill: () => ({ level: 99 }),
            findPath: (x: number, z: number) => ({ success: true, reachedDestination: true, waypoints: [{ x, z, level: 0 }] }),
            countInventoryItems: () => state.inventory.length,
            sendInteractLoc: async () => {
                inputs++;
                return { success: true };
            },
            waitForCondition: async (predicate: (s: any) => boolean) => {
                tick++;
                state.tick = tick;
                if (refuse) state.gameMessages.push({ type: 0, text: "I can't reach that!", tick, observationId: 1 });
                else state.inventory.push({ id: 1513, count: 1, name: 'Magic logs' });
                if (!predicate(state)) throw Error('predicate not satisfied');
                return state;
            },
        },
    };
    return { s, tree, state, inputs: () => inputs };
}

test('Native 2x2 processing tree diagonal corner requires complete cardinal path and actual arrival before chop', async () => {
    const a = processingActor();
    const walks: any[] = [];
    expect(processingTreeEdges(a.tree, 2, 2)).not.toContainEqual({ x: 2692, z: 3426 });
    const r = await chopProcessingTree(a.s, a.tree, () => false, async (x, z) => {
        walks.push([x, z]);
        a.state.player.worldX = x;
        a.state.player.worldZ = z;
        return true;
    });
    expect(r.success).toBe(true);
    expect(walks).toHaveLength(1);
    expect(processingTreeEdges(a.tree, 2, 2)).toContainEqual({ x: walks[0][0], z: walks[0][1] });
    expect(a.inputs()).toBe(1);
});

test('Native processing reach refusal ends the paid wait with no retry or false effect', async () => {
    const a = processingActor(true);
    await expect(
        chopProcessingTree(a.s, a.tree, () => false, async (x, z) => {
            a.state.player.worldX = x;
            a.state.player.worldZ = z;
            return true;
        }),
    ).rejects.toThrow("native processing tree refusal: I can't reach that!");
    expect(a.inputs()).toBe(1);
    expect(a.state.inventory).toHaveLength(0);
});

test('Native processing partial path or unobserved arrival cannot authorize a chop despite reachable true', async () => {
    for (const partial of [true, false]) {
        const a = processingActor();
        if (partial) a.s.sdk.findPath = () => ({ success: true, reachedDestination: false, waypoints: [] });
        await expect(chopProcessingTree(a.s, a.tree, () => false, async () => true)).rejects.toThrow(partial ? 'complete cardinal' : 'arrival unobserved');
        expect(a.inputs()).toBe(0);
    }
});

test('actual processing consumer cancels t36 corner route while t39 public position passes a cardinal edge before sole chop', async () => {
    const a = processingActor();
    a.state.player.worldX = 2690;
    a.state.player.worldZ = 3429;
    const local: any = { routeX: [2692], routeZ: [3426], routeLength: 3 };
    a.s.client.localPlayer = local;
    let resets = 0;
    a.s.sdk.sendWalk = async (x: number, z: number) => {
        resets++;
        expect(a.inputs()).toBe(0);
        expect(processingTreeEdges(a.tree, 2, 2)).toContainEqual({ x, z });
        expect([x, z]).not.toEqual([local.routeX[0], local.routeZ[0]]);
        a.state.player.worldX = x;
        a.state.player.worldZ = z;
        local.routeX[0] = x;
        local.routeZ[0] = z;
        local.routeLength = 9;
        return { success: true };
    };
    const r = await chopProcessingTree(a.s, a.tree, () => false);
    expect(r.success).toBe(true);
    expect(resets).toBe(1);
    expect(a.inputs()).toBe(1);
});

test('moving received head or a replacement during the single stand reset cannot authorize a chop', async () => {
    for (const kind of ['unknown', 'replacement']) {
        const a = processingActor();
        a.state.player.worldX = 2690;
        a.state.player.worldZ = 3429;
        const local: any = { routeX: [2692], routeZ: [3426] };
        a.s.client.localPlayer = local;
        let resets = 0;
        a.s.sdk.sendWalk = async () => {
            resets++;
            if (kind === 'replacement') a.s.client.executeBotAction = () => {};
            return { success: true };
        };
        await expect(chopProcessingTree(a.s, a.tree, () => false)).rejects.toThrow('cardinal arrival unobserved');
        expect(resets).toBe(1);
        expect(a.inputs()).toBe(0);
    }
});

test('delayed blocking-UI close cannot dispatch chop after the received head resumes movement', async () => {
    const a = processingActor();
    a.state.player.worldX = 2690;
    a.state.player.worldZ = 3429;
    a.state.interface = { isOpen: true, interfaceId: 123 };
    a.s.sdk.sendWalk = async (x: number, z: number) => {
        a.state.player.worldX = x;
        a.state.player.worldZ = z;
        return { success: true };
    };
    let closed = 0;
    a.s.sdk.waitForStateChange = async () => a.state;
    a.s.sdk.sendCloseModal = async () => {
        closed++;
        a.state.interface.isOpen = false;
        a.s.client.localPlayer = { routeX: [2692], routeZ: [3426], routeLength: 1 };
        return { success: true };
    };
    await expect(chopProcessingTree(a.s, a.tree, () => false)).rejects.toThrow('pre-dispatch context changed');
    expect(closed).toBe(1);
    expect(a.inputs()).toBe(0);
});

test('persistent nonzero Lite render routeLength permits chop only after two fresh exact received stand frames', async () => {
    const a = processingActor();
    a.state.player.worldX = 2690;
    a.state.player.worldZ = 3429;
    a.s.client.localPlayer.routeLength = 9;
    let walks = 0;
    a.s.sdk.sendWalk = async (x: number, z: number) => {
        walks++;
        a.state.player.worldX = x;
        a.state.player.worldZ = z;
        return { success: true };
    };
    const r = await chopProcessingTree(a.s, a.tree, () => false);
    expect(r.success).toBe(true);
    expect(a.state.tick).toBeGreaterThanOrEqual(12);
    expect(a.s.client.localPlayer.routeLength).toBe(9);
    expect(walks).toBe(1);
    expect(a.inputs()).toBe(1);
});

test('actual Lite same-tile walk no-op cannot retain an old corner destination: consumer selects a different complete edge', async () => {
    const a = processingActor();
    a.state.player.worldX = 2690;
    a.state.player.worldZ = 3429;
    let packets = 0;
    let calls = 0;
    a.s.sdk.sendWalk = async (x: number, z: number) => {
        calls++;
        if (x === a.state.player.worldX && z === a.state.player.worldZ) return { success: true };
        packets++;
        a.state.player.worldX = x;
        a.state.player.worldZ = z;
        return { success: true };
    };
    const r = await chopProcessingTree(a.s, a.tree, () => false);
    expect(r.success).toBe(true);
    expect(calls).toBe(1);
    expect(packets).toBe(1);
    expect(a.inputs()).toBe(1);
    expect(processingTreeEdges(a.tree, 2, 2)).toContainEqual({ x: a.state.player.worldX, z: a.state.player.worldZ });
});

test('cached loc type mutation after approach cannot alter the snapshotted Native footprint receipt', async () => {
    const a = processingActor();
    const type = { width: 2, length: 2 };
    const old = console.log;
    const logs: string[] = [];
    a.s.client.locTypeOf = () => type;
    console.log = (message: unknown) => {
        logs.push(String(message));
    };
    try {
        const r = await chopProcessingTree(a.s, a.tree, () => false, async (x, z) => {
            a.state.player.worldX = x;
            a.state.player.worldZ = z;
            type.width = 1;
            type.length = 1;
            return true;
        });
        expect(r.success).toBe(true);
        const receipt = JSON.parse(logs.find(l => l.startsWith('WOOD_TREE_APPROACH '))!.slice('WOOD_TREE_APPROACH '.length));
        expect(receipt.tree.width).toBe(2);
        expect(receipt.tree.length).toBe(2);
        expect(type.width).toBe(1);
        expect(a.inputs()).toBe(1);
    } finally {
        console.log = old;
    }
});

test('reconcileWoodcuttingAxeAtBank buys Bob upgrade when funded on starter Bronze and equips when Attack allows', async () => {
    let tick = 0;
    let bankOpen = true;
    let shopOpen = false;
    let gen = 1;
    let attack = 1;
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
        tick++;
        for (const fn of [...listeners]) fn();
    }, 1);
    const inv: any[] = [];
    const eq: any[] = [{ id: 1351, name: 'Bronze axe', count: 1, slot: 3 }];
    const bank: any[] = [{ id: 995, name: 'Coins', count: 400, slot: 0 }];
    const shopItems = [{ id: 1353, name: 'Steel axe', count: 3, buyPrice: 200, slot: 0 }];
    const walks: string[] = [];

    const state: any = { inventory: inv, equipment: eq, bank: { isOpen: bankOpen, items: bank }, shop: { isOpen: shopOpen, shopItems } };
    const s: any = {
        tick: () => tick,
        onTick: (fn: () => void) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        bankObservation: () => (bankOpen ? { generation: gen, items: bank } : null),
        sdk: {
            getState: () => ({ ...state, inventory: inv, equipment: eq, bank: { isOpen: bankOpen, items: bank }, shop: { isOpen: shopOpen, shopItems } }),
            getInventory: () => inv,
            getEquipment: () => eq,
            getSkill: (n: string) => ({ level: n === 'Attack' ? attack : 15, baseLevel: n === 'Attack' ? attack : 15 }),
        },
        bot: {
            openBank: async () => {
                bankOpen = true;
                gen++;
                return { success: true };
            },
            closeBank: async () => {
                bankOpen = false;
                return { success: true };
            },
            withdrawItem: async (item: any, n: number) => {
                const row = bank.find(r => r.id === item.id);
                row.count -= n;
                if (row.count <= 0) bank.splice(bank.indexOf(row), 1);
                inv.push({ id: item.id, name: item.name, count: n });
                gen++;
                return { success: true };
            },
            depositItem: async (item: any) => {
                const idx = inv.findIndex(r => r.id === item.id);
                const [removed] = inv.splice(idx, 1);
                const row = bank.find(r => r.id === removed.id);
                if (row) row.count += removed.count;
                else bank.push({ ...removed });
                gen++;
                return { success: true };
            },
            equipItem: async (item: any) => {
                bankOpen = false;
                const old = eq.splice(0, eq.length);
                for (const o of old) inv.push({ id: o.id, name: o.name, count: o.count });
                const idx = inv.findIndex(r => r.id === item.id);
                const [removed] = inv.splice(idx, 1);
                eq.push({ ...removed, slot: 3 });
                return { success: true };
            },
            openShop: async () => {
                shopOpen = true;
                return { success: true };
            },
            buyFromShop: async (row: any, n: number) => {
                row.count -= n;
                inv.find(i => i.id === 995).count -= row.buyPrice * n;
                inv.push({ id: row.id, name: row.name, count: n });
                return { success: true };
            },
            closeShop: async () => {
                shopOpen = false;
                return { success: true };
            },
        },
    };

    try {
        const r1 = await reconcileWoodcuttingAxeAtBank(s, {
            bankSpot: { x: 3092, z: 3243 },
            stop: () => false,
            allowShop: true,
            walkTo: async spot => {
                walks.push(`${spot.x},${spot.z}`);
                return true;
            },
        });
        expect(r1).toEqual({ activeId: 1353, worn: false, bought: 1353 });
        expect(walks).toEqual(['3231,3203', '3092,3243']);
        expect(inv.map(i => i.id)).toEqual([1353]);
        expect(bank.find(i => i.id === 995)?.count).toBe(200);

        attack = 5;
        const r2 = await reconcileWoodcuttingAxeAtBank(s, {
            bankSpot: { x: 3092, z: 3243 },
            stop: () => false,
            allowShop: false,
        });
        expect(r2.activeId).toBe(1353);
        expect(r2.worn).toBe(true);
        expect(eq[0]?.id).toBe(1353);
        expect(inv).toHaveLength(0);
        expect(bank.find(i => i.id === 1351)?.count).toBe(1);
    } finally {
        clearInterval(timer);
    }
});

test('runDraynorOak withdraws best owned axe over lower-tier bank axes', async () => {
    const f = oakFixture();
    f.bank.push({ id: 1359, name: 'Rune axe', count: 1, slot: 6 });
    try {
        const r = await runDraynorOak(f.s, { cap: 500, maximum: 25, prepare: true, walk: async () => true });
        expect(r.ok).toBe(true);
        expect(f.inv.find(i => i.id === 1359)?.count).toBe(1);
        expect(f.bank.find(i => i.id === 1349)?.count).toBe(2);
    } finally {
        f.dispose();
    }
});

test('reconcileWoodcuttingAxeAtBank recovers coins on empty Bob stock and cools down per tier for 700 ticks', async () => {
    let tick = 50;
    let bankOpen = true;
    let shopOpen = false;
    let gen = 1;
    const wc = 15;
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
        tick++;
        for (const fn of [...listeners]) fn();
    }, 2);
    const inv: any[] = [];
    const eq: any[] = [{ id: 1351, name: 'Bronze axe', count: 1, slot: 3 }];
    const bank: any[] = [{ id: 995, name: 'Coins', count: 400, slot: 0 }];
    const shopItems = [{ id: 1353, name: 'Steel axe', count: 0, buyPrice: 200, slot: 0 }];
    const walks: string[] = [];

    const state: any = { inventory: inv, equipment: eq, bank: { isOpen: bankOpen, items: bank }, shop: { isOpen: shopOpen, shopItems } };
    const s: any = {
        tick: () => tick,
        onTick: (fn: () => void) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        bankObservation: () => (bankOpen ? { generation: gen, items: bank } : null),
        sdk: {
            getState: () => ({ ...state, inventory: inv, equipment: eq, bank: { isOpen: bankOpen, items: bank }, shop: { isOpen: shopOpen, shopItems } }),
            getInventory: () => inv,
            getEquipment: () => eq,
            getSkill: (n: string) => ({ level: n === 'Woodcutting' ? wc : 1, baseLevel: n === 'Woodcutting' ? wc : 1 }),
        },
        bot: {
            openBank: async () => {
                bankOpen = true;
                gen++;
                return { success: true };
            },
            closeBank: async () => {
                bankOpen = false;
                return { success: true };
            },
            withdrawItem: async (item: any, n: number) => {
                const row = bank.find(r => r.id === item.id);
                row.count -= n;
                if (row.count <= 0) bank.splice(bank.indexOf(row), 1);
                inv.push({ id: item.id, name: item.name, count: n, slot: 0 });
                gen++;
                return { success: true };
            },
            depositItem: async (item: any, n: number) => {
                const idx = inv.findIndex(r => r.id === item.id);
                const cur = inv[idx];
                const amt = n === -1 ? cur.count : n;
                cur.count -= amt;
                if (cur.count <= 0) inv.splice(idx, 1);
                const row = bank.find(r => r.id === item.id);
                if (row) row.count += amt;
                else bank.push({ id: item.id, name: item.name, count: amt, slot: 0 });
                gen++;
                return { success: true };
            },
            openShop: async () => {
                shopOpen = true;
                return { success: true };
            },
            buyFromShop: async (row: any, n: number) => {
                row.count -= n;
                inv.find(i => i.id === 995).count -= row.buyPrice * n;
                inv.push({ id: row.id, name: row.name, count: n, slot: 1 });
                return { success: true };
            },
            closeShop: async () => {
                shopOpen = false;
                return { success: true };
            },
        },
    };
    const walkTo = async (spot: { x: number; z: number }) => {
        walks.push(`${spot.x},${spot.z}`);
        return true;
    };

    try {
        const r1 = await reconcileWoodcuttingAxeAtBank(s, { bankSpot: { x: 3092, z: 3243 }, stop: () => false, allowShop: true, walkTo });
        expect(r1).toEqual({ activeId: 1351, worn: true, bought: undefined });
        expect(walks).toEqual(['3231,3203', '3092,3243']);
        expect(bank.find(i => i.id === 995)?.count).toBe(400);
        expect(inv.filter(i => i.id === 995)).toHaveLength(0);

        shopItems[0]!.count = 1;
        tick += 40;
        await reconcileWoodcuttingAxeAtBank(s, { bankSpot: { x: 3092, z: 3243 }, stop: () => false, allowShop: true, walkTo });
        expect(walks).toHaveLength(2);

        tick += 700;
        const r2 = await reconcileWoodcuttingAxeAtBank(s, { bankSpot: { x: 3092, z: 3243 }, stop: () => false, allowShop: true, walkTo });
        expect(r2).toEqual({ activeId: 1353, worn: false, bought: 1353 });
        expect(inv.map(i => i.id)).toEqual([1353]);
    } finally {
        clearInterval(timer);
    }
});

test('woodStallTicks scales stall tolerance for slow magic trees', () => {
    expect(woodStallTicks('magic')).toBe(700);
    expect(woodStallTicks('yew')).toBe(220);
});

// --- Woodcut supply (formerly woodcut-supply.test.ts) ---
test('retained log supply admits only a finite accounting-compatible headless batch', () => {
    expect(supplyPlan(25, 165, 3000)).toEqual({ logs: 25, headless: 165, shafts: 375 });
    for (const args of [[0, 0, 3000], [26, 0, 3000], [25, 180, 3000], [25, 164, 3000], [25, 165, 0], [NaN, 0, 3000]]) {
        expect(() => supplyPlan(...(args as [number, number, number]))).toThrow();
    }
});

test('a stop at the current bank permits no bank or inventory action', async () => {
    const file = '.practice/stop-Supplystop';
    mkdirSync('.practice', { recursive: true });
    writeFileSync(file, 'unit-owned stop', { flag: 'wx' });
    let calls = 0;
    let released = false;
    const session: any = {
        name: 'Supplystop',
        tick: () => 0,
        onTick: () => () => {
            released = true;
        },
        sdk: { getSkill: () => ({ level: 54 }), getInventory: () => [], getState: () => ({ player: { worldX: 3092, worldZ: 3243, level: 0, isDead: false } }) },
        bot: {
            openBank: async () => {
                calls++;
                throw Error('unexpected bank action');
            },
        },
    };
    try {
        const r = await runWoodSupply(session, 1, 0, 3000);
        expect(r.ok).toBe(false);
        expect(r).toHaveProperty('error', 'Error: supply stopped, capped or damaged');
        expect(calls).toBe(0);
        expect(released).toBe(true);
    } finally {
        unlinkSync(file);
    }
});

function knifeBank(stock = 1, mode = 'observed') {
    let generation = 3;
    const ticks = fakeSession([at(3092, 3243)]);
    const pack: { id: number; name: string; count: number }[] = [{ id: 1351, name: 'Bronze axe', count: 1 }];
    const bank: { id: number; name: string; count: number }[] = stock ? [{ id: 946, name: 'Knife', count: stock }] : [];
    const calls: { id: number; amount: number; notes: boolean }[] = [];
    const s: any = {
        ...ticks,
        name: 'Supplyknife',
        bankObservation: () => ({ generation, items: bank }),
        sdk: {
            getInventory: () => pack,
            getState: () => ({ player: { worldX: 3092, worldZ: 3243, level: 0, isDead: false }, bank: { isOpen: true, items: bank } }),
        },
        bot: {
            withdrawItem: async (item: any, amount: number, o: any) => {
                calls.push({ id: item.id, amount, notes: o.asNote });
                if (mode === 'refused') return { success: false };
                if (mode !== 'no-debit') bank[0]!.count -= amount;
                if (mode !== 'no-credit') pack.push({ id: 946, name: 'Knife', count: amount });
                if (mode !== 'no-generation') generation++;
                return { success: true };
            },
        },
    };
    return { s, pack, bank, calls, advance: (n: number) => ticks.run(n) };
}

test('an owned bank knife is reused once with unnoted debit and pack credit', async () => {
    const f = knifeBank(2);
    expect(await takeOwnedSupplyKnife(f.s, () => {})).toBe('withdrawn');
    expect(f.calls).toEqual([{ id: 946, amount: 1, notes: false }]);
    expect(f.bank[0]!.count).toBe(1);
    expect(f.pack.filter(i => i.id === 946).reduce((n, i) => n + i.count, 0)).toBe(1);
    expect(f.pack.filter(i => i.id === 946).reduce((n, i) => n + i.count, 0) + f.bank[0]!.count).toBe(2);
});

test('only observed absence selects the spawn fallback; a held knife needs no bank action', async () => {
    const f = knifeBank(0);
    expect(await takeOwnedSupplyKnife(f.s, () => {})).toBe('missing');
    expect(f.calls).toEqual([]);
    f.pack.push({ id: 946, name: 'Knife', count: 1 });
    f.s.bankObservation = () => null;
    expect(await takeOwnedSupplyKnife(f.s, () => {})).toBe('held');
    expect(f.calls).toEqual([]);
    const unknown = knifeBank(0);
    unknown.s.bankObservation = () => null;
    await expect(takeOwnedSupplyKnife(unknown.s, () => {})).rejects.toThrow('bank unobserved');
    expect(unknown.calls).toEqual([]);
});

test('an owner stop before withdrawal prevents inventory actions', async () => {
    for (const when of [1, 2]) {
        const f = knifeBank();
        let checks = 0;
        await expect(
            takeOwnedSupplyKnife(f.s, () => {
                if (++checks === when) throw Error('owner stopped');
            }),
        ).rejects.toThrow('owner stopped');
        expect(f.calls).toEqual([]);
        expect(f.bank[0]!.count).toBe(1);
        expect(f.pack.some(i => i.id === 946)).toBe(false);
    }
});

test('refused and unobserved withdrawals stop instead of acquiring a duplicate knife', async () => {
    const refused = knifeBank(1, 'refused');
    await expect(takeOwnedSupplyKnife(refused.s, () => {})).rejects.toThrow('withdrawal refused');
    expect(refused.calls).toHaveLength(1);
    expect(refused.bank[0]!.count).toBe(1);
    expect(refused.pack.some(i => i.id === 946)).toBe(false);
    for (const mode of ['no-credit', 'no-debit', 'no-generation']) {
        const f = knifeBank(1, mode);
        const pending = takeOwnedSupplyKnife(f.s, () => {});
        const failure = pending.catch(error => error);
        await f.advance(6);
        const error = await failure;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('withdrawal unobserved');
        expect(f.calls).toHaveLength(1);
    }
});

test('a stop received while the initial bank opens prevents knife withdrawal and spawn acquisition', async () => {
    const file = '.practice/stop-Supplymid';
    mkdirSync('.practice', { recursive: true });
    if (existsSync(file)) throw Error('test stop already exists');
    const f = knifeBank();
    f.s.name = 'Supplymid';
    f.s.sdk.getSkill = () => ({ level: 54 });
    let opens = 0;
    f.s.bot.openBank = async () => {
        opens++;
        writeFileSync(file, 'unit-owned bank-open stop', { flag: 'wx' });
        return { success: true };
    };
    try {
        const r = await runWoodSupply(f.s, 1, 0, 3000);
        expect(r.ok).toBe(false);
        expect(r).toHaveProperty('error', 'Error: supply stopped, capped or damaged');
        expect(opens).toBe(1);
        expect(f.calls).toEqual([]);
        expect(f.bank[0]!.count).toBe(1);
        expect(f.pack.some(i => i.id === 946)).toBe(false);
    } finally {
        if (existsSync(file)) unlinkSync(file);
    }
});

test('a stop that lands while the bank opens permits no deposit', async () => {
    const file = '.practice/stop-Supplybank';
    mkdirSync('.practice', { recursive: true });
    if (existsSync(file)) unlinkSync(file);
    let deposits = 0;
    const inventory = [{ id: 1351, name: 'Bronze axe', count: 1, slot: 0 }, { id: 946, name: 'Knife', count: 1, slot: 1 }];
    const session: any = {
        name: 'Supplybank',
        tick: () => 0,
        onTick: () => () => {},
        sdk: { getSkill: () => ({ level: 54 }), getInventory: () => inventory, getState: () => ({ player: { worldX: 3092, worldZ: 3243, level: 0, isDead: false }, bank: { isOpen: true, items: [] } }) },
        bot: {
            openBank: async () => {
                writeFileSync(file, 'unit-owned stop', { flag: 'wx' });
                return { success: true };
            },
            depositItem: async () => {
                deposits++;
                return { success: true };
            },
            closeBank: async () => ({ success: true }),
        },
    };
    try {
        const r = await runWoodSupply(session, 1, 0, 3000);
        expect(r.ok).toBe(false);
        expect(r).toHaveProperty('error', 'Error: supply stopped, capped or damaged');
        expect(deposits).toBe(0);
    } finally {
        if (existsSync(file)) unlinkSync(file);
    }
});

test('reconcileWoodSupplyAxe swaps starter Bronze for higher owned/Bob axe and equips when Attack permits', async () => {
    let open = true;
    let shopOpen = false;
    let gen = 1;
    const ticks = fakeSession([at(3092, 3243)]);
    const pack: any[] = [{ id: 1351, name: 'Bronze axe', count: 1 }];
    const eq: any[] = [];
    const bank: any[] = [{ id: 1359, name: 'Rune axe', count: 1 }, { id: 995, name: 'Coins', count: 500 }];
    const shopItems = [{ id: 1353, name: 'Steel axe', count: 3, buyPrice: 200 }];
    let attack = 1;
    const s: any = {
        ...ticks,
        name: 'Supplyaxe',
        bankObservation: () => (open ? { generation: gen, items: bank } : null),
        sdk: {
            getInventory: () => pack,
            getEquipment: () => eq,
            getSkill: (n: string) => ({ level: n === 'Attack' ? attack : 15, baseLevel: n === 'Attack' ? attack : 15 }),
            getState: () => ({ player: { worldX: 3092, worldZ: 3243, level: 0, isDead: false }, bank: { isOpen: open, items: bank }, shop: { isOpen: shopOpen, shopItems } }),
        },
        bot: {
            openBank: async () => {
                open = true;
                gen++;
                return { success: true };
            },
            closeBank: async () => {
                open = false;
                return { success: true };
            },
            withdrawItem: async (item: any, n: number) => {
                const r = bank.find(v => v.id === item.id);
                r.count -= n;
                if (r.count <= 0) bank.splice(bank.indexOf(r), 1);
                pack.push({ id: item.id, name: item.name, count: n });
                gen++;
                return { success: true };
            },
            depositItem: async (item: any) => {
                const idx = pack.findIndex(v => v.id === item.id);
                const [rm] = pack.splice(idx, 1);
                const r = bank.find(v => v.id === rm.id);
                if (r) r.count += rm.count;
                else bank.push({ ...rm });
                gen++;
                return { success: true };
            },
            equipItem: async (item: any) => {
                open = false;
                const idx = pack.findIndex(v => v.id === item.id);
                const [rm] = pack.splice(idx, 1);
                eq.push({ ...rm, slot: 3 });
                return { success: true };
            },
            openShop: async () => {
                shopOpen = true;
                return { success: true };
            },
            buyFromShop: async () => ({ success: true }),
            closeShop: async () => {
                shopOpen = false;
                return { success: true };
            },
        },
    };

    expect(selectWoodSupplyAxe(bank, { Woodcutting: 1, Attack: 1 }).current?.item.id).toBe(1359);
    const lowId = await reconcileWoodSupplyAxe(s, { check: () => {}, allowShop: false });
    expect(lowId).toBe(1359);
    expect(pack.map(i => i.id)).toEqual([1359]);
    expect(eq).toHaveLength(0);
    expect(bank.find(i => i.id === 1351)?.count).toBe(1);

    attack = 40;
    const highId = await reconcileWoodSupplyAxe(s, { check: () => {}, allowShop: false });
    expect(highId).toBe(1359);
    expect(eq[0]?.id).toBe(1359);
    expect(pack).toHaveLength(0);
});

test('runYewsGather preserves MAX_TRIPS=1 after initial Draynor forceToolCheck bank visit', async () => {
    let tick = 0;
    let gen = 1;
    let bankOpen = false;
    let wcXp = 0;
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
        tick++;
        for (const fn of [...listeners]) fn();
    }, 1);
    const grove = normalGrove();
    const pos = { worldX: 3092, worldZ: 3243, level: 0, isDead: false, lifeId: 1, respawnCount: 0, combatLevel: 20 };
    const pack: any[] = [{ id: 1351, name: 'Bronze axe', count: 1 }];
    const bank: any[] = [{ id: 946, name: 'Knife', count: 1 }];
    const tree = { id: 1276, name: 'Tree', x: grove.spot.x, z: grove.spot.z, distance: 1, optionsWithIndex: [{ text: 'Chop down', opIndex: 1 }] };
    const s: any = {
        name: 'WoodYewsTrip',
        tick: () => tick,
        ended: new Promise(() => {}),
        onTick: (fn: () => void) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        bankObservation: () => (bankOpen ? { generation: gen, items: bank } : null),
        direct: async () => ({ success: true }),
        sdk: {
            getState: () => ({
                player: pos,
                inventory: pack,
                equipment: [],
                bank: { isOpen: bankOpen, items: bank },
                nearbyLocs: [tree],
                nearbyPlayers: [],
                dialog: { isOpen: false },
                interface: { isOpen: false },
                modalOpen: false,
            }),
            getInventory: () => pack,
            getEquipment: () => [],
            getSkill: (name: string) =>
                name === 'Hitpoints' ? { level: 30, baseLevel: 30 } : name === 'Attack' ? { level: 20, baseLevel: 20 } : { level: 1, baseLevel: 1 },
            getSkillXp: (name: string) => (name === 'Woodcutting' || name === 'woodcutting' ? wcXp : 0),
            sendInteractLoc: async () => {
                pack.push({ id: 1511, name: 'Logs', count: 1 });
                wcXp += 25;
                return { success: true };
            },
        },
        bot: {
            openBank: async () => {
                bankOpen = true;
                gen++;
                return { success: true };
            },
            closeInterface: async () => {
                bankOpen = false;
                return { success: true };
            },
            depositItem: async (re: RegExp | string) => {
                for (let i = pack.length - 1; i >= 0; i--) {
                    const item = pack[i]!;
                    const match = typeof re === 'string' ? item.name === re : re.test(item.name);
                    if (!match) continue;
                    pack.splice(i, 1);
                    const row = bank.find(r => r.id === item.id);
                    if (row) row.count += item.count;
                    else bank.push({ ...item });
                    gen++;
                }
                return { success: true };
            },
        },
    };
    const cargoSpy = spyOn(cargo, 'bankCargo').mockResolvedValue();
    const walkSpy = spyOn(walking, 'walkPath').mockImplementation(async (_w: any, targets: readonly { x: number; z: number }[]) => {
        const t = targets[0];
        if (t) {
            pos.worldX = t.x;
            pos.worldZ = t.z;
        }
        return { ok: true } as any;
    });
    try {
        const cfg = normalizeGatherConfig({
            skill: 'woodcutting',
            method: 'yews',
            args: ['200', '1'],
            env: { REGION: 'draynor', TREE: 'normal', MAX_TRIPS: '1', BANK_AT: '1', CAP: '200' },
        });
        const r = await runYewsGather(s as Session, cfg, () => false);
        expect(r.ok).toBe(true);
        expect(r.summary).toMatchObject({ chops: 1, banked: 1, tree: 'normal' });
    } finally {
        clearInterval(timer);
        cargoSpy.mockRestore();
        walkSpy.mockRestore();
    }
});
