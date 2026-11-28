import { describe, expect, test } from 'bun:test';
import { componentId } from '../../core/src/logout';
import {
    inventoryRecipes,
    runArtisan,
    runCookFood,
    tanningRecipes,
} from '../src/bank-artisan';
import {
    runBankedTanning,
    runBlackDhideSetsCli,
} from '../src/bank-artisan/crafting-production';
import {
    DRAYNOR_FISH_BANK,
    KARAMBWAN_POINT,
    KARAMBWANJI_LAKE,
    SHILO_FISH_BANK,
    karambwanBankTile,
    karambwanTripCapacity,
    runFishingSession,
} from '../src/gather/fishing';
import {
    HEROES_RUNITE_ROCKS,
    ORE_AREAS,
    ORE_PROFILES,
    oreProductRegex,
    oreProfileItemId,
    oreProfileMinLevel,
    resolveOreArea,
    runMiningSession,
    selectRock,
} from '../src/gather/mining';
import { normalizeGatherConfig } from '../src/gather/types';
import { runLogisticsWorkerSession } from '../src/logistics/module';
import {
    ALL_ALTARS_BY_NAME,
    NATURE_ALTAR,
    nearestBankForAltar,
    ruinTarget,
    runRunecraftSession,
    unequipAndDepositEntranaContraband,
} from '../src/runecraft';

function createTickClock() {
    let tick = 0;
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
        tick++;
        for (const fn of [...listeners]) fn();
    }, 1);
    return {
        tick: () => tick,
        onTick: (fn: () => void) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        step: () => {
            tick++;
            for (const fn of [...listeners]) fn();
        },
        stop: () => clearInterval(timer),
    };
}

describe('Banked mining profiles (coal, gold, heroes-runite)', () => {
    test('resolveOreArea, product regexes, item IDs, and selectRock support coal, gold, and heroes-runite', () => {
        expect(ORE_PROFILES).toEqual(['mixed', 'clay', 'coal', 'gold', 'heroes-runite']);
        expect(oreProductRegex('coal').test('Coal')).toBe(true);
        expect(oreProductRegex('gold').test('Gold ore')).toBe(true);
        expect(oreProductRegex('heroes-runite').test('Runite ore')).toBe(true);
        expect(oreProfileMinLevel('coal')).toBe(30);
        expect(oreProfileMinLevel('gold')).toBe(40);
        expect(oreProfileMinLevel('heroes-runite')).toBe(85);
        expect([oreProfileItemId('coal'), oreProfileItemId('gold'), oreProfileItemId('heroes-runite')]).toEqual([453, 444, 451]);

        expect(resolveOreArea('coal', { miningLevel: 45 })).toEqual(ORE_AREAS.coal);
        expect(resolveOreArea('coal', { miningLevel: 60 })).toEqual(ORE_AREAS['coal-guild']);
        expect(resolveOreArea('gold', { craftingLevel: 39, hasBrownApron: true })).toEqual(ORE_AREAS.gold);
        expect(resolveOreArea('gold', { craftingLevel: 40, hasBrownApron: true })).toEqual(ORE_AREAS['gold-crafting']);
        expect(resolveOreArea('gold', { siteOverride: 'alkharid' })).toEqual(ORE_AREAS['gold-alkharid']);
        expect(resolveOreArea('heroes-runite')).toEqual(ORE_AREAS['heroes-runite']);

        const coalRock = { id: 2096, name: 'Rocks', x: 3032, z: 9737, level: 0, distance: 1, options: ['Mine'], optionsWithIndex: [{ opIndex: 1, text: 'Mine' }] };
        const goldRock = { id: 2098, name: 'Rocks', x: 2977, z: 3233, level: 0, distance: 1, options: ['Mine'], optionsWithIndex: [{ opIndex: 1, text: 'Mine' }] };
        const runiteRock = { id: 2107, name: 'Rocks', x: 2937, z: 9882, level: 0, distance: 2, options: ['Mine'], optionsWithIndex: [{ opIndex: 1, text: 'Mine' }] };
        expect(selectRock([coalRock], 29, 0, 0, 'coal')).toBeUndefined();
        expect(selectRock([coalRock], 30, 0, 0, 'coal')?.id).toBe(2096);
        expect(selectRock([goldRock], 39, 0, 0, 'gold')).toBeUndefined();
        expect(selectRock([goldRock], 40, 0, 0, 'gold')?.id).toBe(2098);
        expect(selectRock([runiteRock], 84, 0, 0, 'heroes-runite')).toBeUndefined();
        expect(selectRock([runiteRock], 85, 0, 0, 'heroes-runite')?.id).toBe(2107);
    });

    test('runMiningSession runs banked heroes-runite with immediate rock switching and Falador West banking', async () => {
        const clock = createTickClock();
        try {
            const player = { worldX: 2939, worldZ: 9883, level: 0, lifeId: 1, respawnCount: 0, isDead: false, combatLevel: 90 };
            const inv: { id: number; name: string; count: number; slot: number }[] = [];
            const bankItems: { id: number; name: string; count: number }[] = [];
            let bankOpen = false;
            let bankGen = 1;
            let miningXp = 3_500_000;
            const minedOrder: number[] = [];
            const activeRocks = new Set([2107, 2106]);
            const reindex = () => inv.forEach((it, idx) => { it.slot = idx; });

            const s: any = {
                name: 'HeroesMiner',
                lifecycle: { server: 'localhost:8888' },
                tick: clock.tick,
                onTick: clock.onTick,
                ended: new Promise(() => {}),
                bankObservation: () => ({ generation: bankGen, items: bankItems }),
                sdk: {
                    config: { host: 'localhost', port: 8888 },
                    getState: () => ({
                        player,
                        inventory: inv,
                        equipment: [{ id: 1275, name: 'Rune pickaxe', slot: 3, count: 1 }],
                        nearbyPlayers: [],
                        nearbyLocs: HEROES_RUNITE_ROCKS
                            .filter(r => activeRocks.has(r.id))
                            .map((r, idx) => ({
                                ...r,
                                name: 'Rocks',
                                distance: idx + 1,
                                reachable: true,
                                options: ['Mine'],
                                optionsWithIndex: [{ opIndex: 1, text: 'Mine' }],
                            })),
                        bank: { isOpen: bankOpen, items: bankItems },
                        dialog: { isOpen: false },
                        modalOpen: false,
                        gameMessages: [],
                    }),
                    getInventory: () => inv,
                    getEquipment: () => [{ id: 1275, name: 'Rune pickaxe', slot: 3, count: 1 }],
                    getSkill: (name: string) => {
                        const lv = name === 'Mining' ? 85 : name === 'Hitpoints' ? 99 : name === 'Attack' ? 70 : 1;
                        return { level: lv, baseLevel: lv };
                    },
                    getSkillXp: () => miningXp,
                    sendInteractLoc: async (_x: number, _z: number, locId: number) => {
                        minedOrder.push(locId);
                        activeRocks.delete(locId);
                        inv.push({ id: 451, name: 'Runite ore', count: 1, slot: inv.length });
                        miningXp += 3125;
                        clock.step();
                        return { success: true };
                    },
                },
                bot: {
                    openBank: async () => { bankOpen = true; bankGen++; return { success: true }; },
                    closeBank: async () => { bankOpen = false; return { success: true }; },
                    closeInterface: async () => { bankOpen = false; return { success: true }; },
                    depositItem: async (item: { id: number; name: string }) => {
                        let moved = 0;
                        for (let i = inv.length - 1; i >= 0; i--) {
                            if (inv[i]!.id === item.id) {
                                moved += inv[i]!.count;
                                inv.splice(i, 1);
                            }
                        }
                        reindex();
                        const row = bankItems.find(b => b.id === item.id);
                        if (row) row.count += moved;
                        else if (moved > 0) bankItems.push({ id: item.id, name: item.name, count: moved });
                        bankGen++;
                        return { success: true };
                    },
                    withdrawItem: async () => ({ success: false }),
                },
            };

            const cfg = normalizeGatherConfig({
                skill: 'mining',
                method: 'ore',
                env: { ORE_PROFILE: 'heroes-runite', MAX_ORE: '2', CAP: '120', BANK_AT: '2' },
                deps: {
                    walkTargetPersist: async (_sess, to) => {
                        player.worldX = to.x;
                        player.worldZ = to.z;
                        player.level = to.level;
                        return { ok: true };
                    },
                },
            });
            const out = await runMiningSession(s, cfg, () => false);
            expect(out.ok).toBe(true);
            expect(minedOrder).toEqual([2107, 2106]);
            expect(bankItems.find(i => i.id === 451)?.count).toBe(2);
            expect(out.delta?.items).toEqual({ 451: 2 });
        } finally {
            clock.stop();
        }
    });
});

describe('Banked karambwanji/karambwan fishing & multiobj2 karambwan cooking', () => {
    test('karambwanBankTile selects Shilo when Shilo Village is complete and karambwanTripCapacity leaves a slot for loaded vessels', () => {
        expect(karambwanBankTile(new Set(['shilo village']))).toEqual(SHILO_FISH_BANK);
        expect(karambwanBankTile(new Set())).toEqual(DRAYNOR_FISH_BANK);
        expect(karambwanBankTile(new Set(['shilo village']), 'draynor')).toEqual(DRAYNOR_FISH_BANK);
        expect(karambwanTripCapacity(27, false)).toBe(27);
        expect(karambwanTripCapacity(27, true)).toBe(26);
        expect(KARAMBWANJI_LAKE).toEqual({ x: 2799, z: 3014, level: 0 });
        expect(KARAMBWAN_POINT).toEqual({ x: 2901, z: 3113, level: 0 });
    });

    test('runFishingSession supports banked karambwanji and karambwan via fishing:staged with BANKED=1', async () => {
        const clock = createTickClock();
        try {
            const player = { worldX: 2852, worldZ: 2955, level: 0, lifeId: 1, respawnCount: 0, isDead: false };
            const inv: { id: number; name: string; count: number; slot: number }[] = [];
            const bank: { id: number; name: string; count: number }[] = [
                { id: 303, name: 'Small fishing net', count: 1 },
                { id: 3157, name: 'Karambwan vessel', count: 1 },
                { id: 3150, name: 'Raw karambwanji', count: 2 },
            ];
            let bankOpen = false;
            let bankGen = 1;
            let fishingXp = 500_000;
            const visited: string[] = [];
            const reindex = () => inv.forEach((it, idx) => { it.slot = idx; });

            const s: any = {
                name: 'KarambwanFisher',
                tick: clock.tick,
                onTick: clock.onTick,
                ended: new Promise(() => {}),
                bankObservation: () => ({ generation: bankGen, items: bank }),
                sdk: {
                    config: { host: 'localhost', port: 8888 },
                    getState: () => ({
                        player,
                        inventory: inv.map(i => ({ ...i })),
                        equipment: [],
                        skills: [
                            { name: 'Fishing', level: 70, baseLevel: 70, experience: fishingXp },
                            { name: 'Hitpoints', level: 70, baseLevel: 70, experience: 750_000 },
                        ],
                        quests: [{ name: 'Shilo Village', state: 'complete' }],
                        nearbyNpcs: [
                            { id: 1174, index: 10, name: 'Fishing spot', x: 2799, z: 3013, distance: 1, reachable: true, optionsWithIndex: [{ opIndex: 1, text: 'Net' }] },
                            { id: 1176, index: 11, name: 'Fishing spot', x: 2901, z: 3114, distance: 1, reachable: true, optionsWithIndex: [{ opIndex: 1, text: 'Fish' }] },
                        ],
                        bank: { isOpen: bankOpen, items: bank },
                        dialog: { isOpen: false },
                        interface: { isOpen: false },
                    }),
                    getInventory: () => inv,
                    getSkill: (name: string) => ({ level: 70, baseLevel: 70, experience: name === 'Fishing' ? fishingXp : 750_000 }),
                    sendUseItemOnItem: async (src: number, dst: number) => {
                        const a = inv[src]!;
                        const b = inv[dst]!;
                        if (a.id === 3157 && b.id === 3150) {
                            a.id = 3159;
                            a.name = 'Karambwan vessel';
                            inv.splice(dst, 1);
                            reindex();
                        }
                        clock.step();
                        return { success: true };
                    },
                    sendInteractNpc: async (idx: number) => {
                        if (idx === 10) {
                            inv.push({ id: 3150, name: 'Raw karambwanji', count: 1, slot: inv.length });
                            fishingXp += 125;
                        } else if (idx === 11) {
                            const vessel = inv.find(i => i.id === 3159);
                            if (vessel) vessel.id = 3157;
                            inv.push({ id: 3142, name: 'Raw karambwan', count: 1, slot: inv.length });
                            fishingXp += 1250;
                        }
                        clock.step();
                        return { success: true };
                    },
                    sendCloseModal: async () => ({ success: true }),
                },
                bot: {
                    openBank: async () => { bankOpen = true; bankGen++; return { success: true }; },
                    closeBank: async () => { bankOpen = false; return { success: true }; },
                    withdrawItem: async (row: { id: number; name: string }, n: number) => {
                        const b = bank.find(x => x.id === row.id);
                        if (!b || b.count < n) return { success: false };
                        b.count -= n;
                        for (let i = 0; i < n; i++) inv.push({ id: b.id, name: b.name, count: 1, slot: inv.length });
                        reindex();
                        bankGen++;
                        return { success: true };
                    },
                    depositItem: async (item: { id: number; name: string }) => {
                        let moved = 0;
                        for (let i = inv.length - 1; i >= 0; i--) {
                            if (inv[i]!.id === item.id) {
                                moved += inv[i]!.count;
                                inv.splice(i, 1);
                            }
                        }
                        reindex();
                        const row = bank.find(b => b.id === item.id);
                        if (row) row.count += moved;
                        else if (moved > 0) bank.push({ id: item.id, name: item.name, count: moved });
                        bankGen++;
                        return { success: true };
                    },
                },
            };

            const walkDep = async (_sess: any, to: { x: number; z: number; level: number }) => {
                visited.push(`${to.x},${to.z}`);
                player.worldX = to.x;
                player.worldZ = to.z;
                player.level = to.level;
                return { ok: true };
            };

            const res1 = await runFishingSession(
                s,
                normalizeGatherConfig({ skill: 'fishing', method: 'staged', env: { METHOD: 'karambwanji', BANKED: '1', AMOUNT: '1', CAP: '120' }, deps: { walkTargetPersist: walkDep } }),
                () => false,
            );
            expect(res1.ok).toBe(true);
            expect(res1.delta?.items).toEqual({ 3150: 1 });
            expect(bank.find(i => i.id === 3150)?.count).toBe(3);
            expect(visited).toContain('2799,3014');

            // Deposit small fishing net so karambwan trip starts clean from bank.
            inv.length = 0;
            const res2 = await runFishingSession(
                s,
                normalizeGatherConfig({ skill: 'fishing', method: 'staged', env: { METHOD: 'karambwan', BANKED: '1', AMOUNT: '2', CAP: '120' }, deps: { walkTargetPersist: walkDep } }),
                () => false,
            );
            expect(res2.ok).toBe(true);
            expect(res2.delta?.items).toEqual({ 3142: 2 });
            expect(bank.find(i => i.id === 3142)?.count).toBe(2);
            expect(visited).toContain('2901,3113');
        } finally {
            clock.stop();
        }
    });

    test('runCookFood and cooking:batch honor FOOD_TYPE=karambwan with multiobj2:objtext2 click and ID-exact 3144 counting', async () => {
        const clock = createTickClock();
        try {
            const clicked: number[] = [];
            const inv: { slot: number; id: number; name: string; count: number }[] = [
                { slot: 0, id: 3142, name: 'Raw karambwan', count: 1 },
                { slot: 1, id: 3142, name: 'Raw karambwan', count: 1 },
            ];
            let dialog = { isOpen: false, options: [] as unknown[], isWaiting: false };
            let pendingSlot: number | undefined;
            const expectedComp = componentId('multiobj2:objtext2');

            const s: any = {
                name: 'KarambwanChef',
                tick: clock.tick,
                onTick: clock.onTick,
                ended: new Promise(() => {}),
                sdk: {
                    config: { host: 'localhost', port: 8888 },
                    getState: () => ({
                        player: { worldX: 2816, worldZ: 3443, level: 0, lifeId: 1 },
                        inventory: inv,
                        nearbyLocs: [{ id: 2728, name: 'Range', x: 2817, z: 3443, distance: 1, reachable: true }],
                        dialog,
                        bank: { isOpen: false, items: [] },
                        gameMessages: [],
                    }),
                    getInventory: () => inv,
                    getSkill: () => ({ level: 80, baseLevel: 80 }),
                    findNearbyLoc: () => ({ id: 2728, name: 'Range', x: 2817, z: 3443 }),
                    sendUseItemOnLoc: async (slot: number) => {
                        pendingSlot = slot;
                        dialog = { isOpen: true, options: [], isWaiting: false };
                        clock.step();
                        return { success: true };
                    },
                    sendClickComponent: async (comp: number) => {
                        clicked.push(comp);
                        dialog = { isOpen: false, options: [], isWaiting: false };
                        if (pendingSlot !== undefined) {
                            const item = inv.find(i => i.slot === pendingSlot)!;
                            item.id = comp === expectedComp ? 3144 : 3146;
                            item.name = 'Cooked karambwan';
                            pendingSlot = undefined;
                        }
                        clock.step();
                        return { success: true };
                    },
                    sendCloseModal: async () => { dialog = { isOpen: false, options: [], isWaiting: false }; return { success: true }; },
                },
                bot: {
                    openBank: async () => ({ success: true }),
                    depositItem: async () => ({ success: true }),
                    withdrawItem: async () => ({ success: false }),
                    closeInterface: async () => ({ success: true }),
                },
            };

            const r1 = await runCookFood(s, 'karambwan', 50, () => false, 1);
            expect(r1.ok).toBe(true);
            expect(r1.cookedTotal).toBe(1);
            expect(clicked).toEqual([expectedComp]);

            const r2 = await runArtisan(s, { skill: 'cooking', method: 'batch', env: { FOOD_TYPE: 'karambwan', MAX_MAKE: '1', CAP: '50' } });
            expect(r2.ok).toBe(true);
            expect(r2.produced).toBe(1);
            expect(clicked).toEqual([expectedComp, expectedComp]);
        } finally {
            clock.stop();
        }
    });
});

describe('Banked dragonhide tanning, CLI TIER, and decant:antipoison', () => {
    test('runBankedTanning and crafting:tanning with TAN_BANKED=1 run multi-trip Al Kharid bank <-> Ellis Tan-All', async () => {
        const clock = createTickClock();
        try {
            const player = { worldX: 3269, worldZ: 3167, level: 0, lifeId: 1, respawnCount: 0, isDead: false };
            const inv: { id: number; name: string; count: number; slot: number }[] = [];
            const bank: { id: number; name: string; count: number }[] = [
                { id: 1747, name: 'Black dragonhide', count: 30 },
                { id: 995, name: 'Coins', count: 1000 },
            ];
            let bankOpen = false;
            let bankGen = 1;
            const clickedButtons: number[] = [];
            const reindex = () => inv.forEach((it, idx) => { it.slot = idx; });

            const s: any = {
                name: 'BankTanner',
                tick: clock.tick,
                onTick: clock.onTick,
                ended: new Promise(() => {}),
                bankObservation: () => ({ generation: bankGen, items: bank }),
                sdk: {
                    config: { host: 'localhost', port: 8888 },
                    getState: () => ({
                        player,
                        inventory: inv,
                        nearbyNpcs: player.worldZ >= 3185 ? [{ name: 'Tanner', index: 7 }] : [],
                        bank: { isOpen: bankOpen, items: bank },
                        interface: { isOpen: player.worldZ >= 3185 },
                    }),
                    getInventory: () => inv,
                    getSkill: () => ({ level: 10, baseLevel: 10 }),
                    sendInteractNpc: async () => ({ success: true }),
                    sendClickComponent: async (comp: number) => {
                        clickedButtons.push(comp);
                        const qty = comp === componentId(tanningRecipes.black.buttonAll)
                            ? inv.filter(i => i.id === 1747).reduce((n, i) => n + i.count, 0)
                            : comp === componentId(tanningRecipes.black.button5)
                              ? 5
                              : 1;
                        let left = qty;
                        for (const item of inv) {
                            if (left > 0 && item.id === 1747) {
                                item.id = 2509;
                                item.name = 'Black dragon leather';
                                left--;
                            }
                        }
                        const coins = inv.find(i => i.id === 995)!;
                        coins.count -= qty * 20;
                        if (coins.count <= 0) inv.splice(inv.indexOf(coins), 1);
                        reindex();
                        clock.step();
                        return { success: true };
                    },
                },
                bot: {
                    openBank: async () => { bankOpen = true; bankGen++; return { success: true }; },
                    closeBank: async () => { bankOpen = false; return { success: true }; },
                    withdrawItem: async (row: { id: number; name: string }, n: number) => {
                        const b = bank.find(x => x.id === row.id);
                        if (!b || b.count < n) return { success: false };
                        b.count -= n;
                        if (row.id === 995) {
                            const existing = inv.find(i => i.id === 995);
                            if (existing) existing.count += n;
                            else inv.push({ id: 995, name: 'Coins', count: n, slot: inv.length });
                        } else {
                            for (let i = 0; i < n; i++) inv.push({ id: b.id, name: b.name, count: 1, slot: inv.length });
                        }
                        reindex();
                        bankGen++;
                        return { success: true };
                    },
                    depositItem: async (item: { id: number; name: string }) => {
                        let moved = 0;
                        for (let i = inv.length - 1; i >= 0; i--) {
                            if (inv[i]!.id === item.id) {
                                moved += inv[i]!.count;
                                inv.splice(i, 1);
                            }
                        }
                        reindex();
                        const row = bank.find(b => b.id === item.id);
                        if (row) row.count += moved;
                        else if (moved > 0) bank.push({ id: item.id, name: item.name, count: moved });
                        bankGen++;
                        return { success: true };
                    },
                },
            };

            const walkDep = async (_sess: any, to: { x: number; z: number; level: number }) => {
                player.worldX = to.x;
                player.worldZ = to.z;
                player.level = to.level;
                return { ok: true };
            };

            const res = await runBankedTanning(s, 'black', 30, 500, () => false, { walkTargetPersist: walkDep });
            expect(res).toMatchObject({ ok: true, made: 30, goal: 30, coinsSpent: 600, trips: 2 });
            expect(clickedButtons[0]).toBe(componentId(tanningRecipes.black.buttonAll));
            expect(bank.find(i => i.id === 2509)?.count).toBe(30);
            expect(bank.find(i => i.id === 995)?.count).toBe(400);

            // Dispatch via crafting:tanning with TAN_BANKED=1 on blue dragonhides.
            bank.push({ id: 1751, name: 'Blue dragonhide', count: 5 });
            s.sdk.sendClickComponent = async (comp: number) => {
                expect(comp).toBe(componentId(tanningRecipes.blue.buttonAll));
                for (const item of inv) if (item.id === 1751) { item.id = 2505; item.name = 'Blue dragon leather'; }
                const coins = inv.find(i => i.id === 995)!;
                coins.count -= 100;
                if (coins.count <= 0) inv.splice(inv.indexOf(coins), 1);
                reindex();
                clock.step();
                return { success: true };
            };
            const dispatched = await runArtisan(s, {
                skill: 'crafting',
                method: 'tanning',
                args: ['blue', '5', '200'],
                env: { TAN_BANKED: '1' },
                deps: { walkTargetPersist: walkDep },
            });
            expect(dispatched).toMatchObject({ ok: true, produced: 5 });
            expect(bank.find(i => i.id === 2505)?.count).toBe(5);
        } finally {
            clock.stop();
        }
    });

    test('runBlackDhideSetsCli validates TIER and checks Crafting level for the requested tier', async () => {
        const failures: string[] = [];
        const makeQuest = (craftingLevel: number) => ({
            s: {
                tick: () => 0,
                sdk: {
                    getInventory: () => [],
                    getSkill: () => ({ level: craftingLevel }),
                },
                bankObservation: () => ({ generation: 1, items: [] }),
            },
            st: () => ({ bank: { isOpen: false, items: [] } }),
            waitUntil: async () => true,
            waitTicks: async () => {},
            milestone: () => {},
            end: async () => {},
            fail: async (msg: string) => {
                failures.push(msg);
                throw Error(msg);
            },
        });

        await expect(
            runBlackDhideSetsCli('Tester', ['TIER=bronze'], {}, { openQuest: async () => makeQuest(99) }),
        ).rejects.toThrow('unknown TIER=bronze');

        await expect(
            runBlackDhideSetsCli('Tester', ['TIER=green', 'PIECE=body'], {}, { openQuest: async () => makeQuest(62) }),
        ).rejects.toThrow('Crafting 62, body asks 63');
        expect(failures).toContain('unknown TIER=bronze');
        expect(failures).toContain('Crafting 62, body asks 63');
    });

    test('inventoryRecipes includes decant:antipoison (175->2446), decant2:antipoison, and decant31:antipoison', () => {
        const byName = new Map(inventoryRecipes().map(r => [r.name, r]));
        expect(byName.get('decant:antipoison')).toMatchObject({
            inputs: [{ id: 175, units: 2 }],
            product: 2446,
            byproducts: [{ id: 177, units: 1 }],
            level: 1,
            xp: false,
            members: true,
        });
        expect(byName.get('decant2:antipoison')).toMatchObject({
            inputs: [{ id: 177, units: 2 }],
            product: 2446,
            byproducts: [{ id: 229, units: 1 }],
        });
        expect(byName.get('decant31:antipoison')).toMatchObject({
            inputs: [{ id: 175, units: 1 }, { id: 179, units: 1 }],
            product: 2446,
            byproducts: [{ id: 229, units: 1 }],
        });
    });
});

describe('Runecraft nature & law seams and glory recharge MAX_GLORIES', () => {
    test('ALL_ALTARS includes nature altar (2460/2473) with Shilo bank and mode=nature without jobPath falls back cleanly', async () => {
        expect(ALL_ALTARS_BY_NAME.get('nature')).toEqual(NATURE_ALTAR);
        expect(ruinTarget(NATURE_ALTAR).q.id).toBe(2460);
        expect(NATURE_ALTAR.portal).toBe(2473);
        expect(nearestBankForAltar('nature')).toEqual({ x: 2852, z: 2955, level: 0 });

        const clock = createTickClock();
        try {
            // Confirm mode='nature' without natureJob delegates into runRuneBankCraft(altar:'nature') instead of refusing for missing jobPath.
            const s: any = {
                name: 'NatureRc',
                tick: clock.tick,
                onTick: clock.onTick,
                ended: new Promise(() => {}),
                bankObservation: () => ({ generation: 1, items: [] }),
                sdk: {
                    config: { host: 'localhost', port: 8888 },
                    getState: () => ({ player: { worldX: 2852, worldZ: 2955, level: 0, lifeId: 1 }, inventory: [], bank: { isOpen: false, items: [] } }),
                    getInventory: () => [],
                    getSkill: () => ({ level: 44, baseLevel: 44 }),
                    getSkillXp: () => 60_000,
                },
                bot: {
                    openBank: async () => ({ success: false }),
                    closeBank: async () => ({ success: true }),
                },
            };
            const out = await runRunecraftSession(s, { mode: 'nature', cap: 20, deps: { getWorld: async () => ({} as any), accountOf: () => ({} as any) } }, () => true);
            expect(out.detail).not.toContain('requires natureJob');
        } finally {
            clock.stop();
        }
    });

    test('unequipAndDepositEntranaContraband auto-unequips worn gear and re-opens Draynor bank to deposit it', async () => {
        const clock = createTickClock();
        try {
            const equipment: { id: number; name: string; slot: number; count: number }[] = [
                { id: 1333, name: 'Rune scimitar', slot: 3, count: 1 },
                { id: 2503, name: "Black d'hide body", slot: 4, count: 1 },
            ];
            const inv: { id: number; name: string; slot: number; count: number }[] = [];
            let bankOpen = true;
            let opens = 0;
            let closes = 0;
            let secures = 0;
            const s: any = {
                tick: clock.tick,
                onTick: clock.onTick,
                sdk: {
                    config: { host: 'localhost', port: 8888 },
                    getState: () => ({ equipment, inventory: inv, bank: { isOpen: bankOpen } }),
                    getInventory: () => inv,
                },
                bot: {
                    unequipItem: async (item: { id: number; name: string; slot: number }) => {
                        const idx = equipment.findIndex(e => e.id === item.id && e.slot === item.slot);
                        if (idx < 0) return { success: false };
                        const [removed] = equipment.splice(idx, 1);
                        inv.push({ ...removed!, slot: inv.length });
                        clock.step();
                        return { success: true };
                    },
                },
            };

            const count = await unequipAndDepositEntranaContraband(s, {
                stop: () => false,
                open: async () => { opens++; bankOpen = true; },
                close: async () => { closes++; bankOpen = false; },
                secure: async () => { secures++; inv.length = 0; },
            });
            expect(count).toBe(2);
            expect(equipment).toEqual([]);
            expect(inv).toEqual([]);
            expect([closes, opens, secures]).toEqual([1, 1, 1]);
        } finally {
            clock.stop();
        }
    });

    test('runLogisticsWorkerSession charge-glory honors env.MAX_GLORIES and falls back to cfg.count', async () => {
        const clock = createTickClock();
        try {
            const runWith = async (cfg: { count?: number; env?: Record<string, string> }) => {
                const player = { worldX: 2946, worldZ: 3368, level: 0, lifeId: 1, respawnCount: 0, isDead: false };
                const inv: { id: number; name: string; count: number; slot: number }[] = [];
                const bank: { id: number; name: string; count: number }[] = [
                    { id: 1704, name: 'Amulet of glory', count: 5 },
                ];
                let bankOpen = false;
                let bankGen = 1;
                const reindex = () => inv.forEach((it, idx) => { it.slot = idx; });
                const s: any = {
                    name: 'GloryRunner',
                    tick: clock.tick,
                    onTick: clock.onTick,
                    ended: new Promise(() => {}),
                    bankObservation: () => ({ generation: bankGen, items: bank }),
                    sdk: {
                        getState: () => ({
                            player,
                            inventory: inv,
                            quests: [{ name: "Heroes' Quest", state: 'complete' }],
                            nearbyLocs: [{ id: 2638, name: 'Fountain of Heroes', x: 2917, z: 9893, distance: 1 }],
                            bank: { isOpen: bankOpen, items: bank },
                            gameMessages: [],
                        }),
                        getInventory: () => inv,
                        getSkill: (name: string) => ({ level: name === 'Hitpoints' ? 99 : 70, baseLevel: name === 'Hitpoints' ? 99 : 70 }),
                    },
                    bot: {
                        openBank: async () => { bankOpen = true; bankGen++; return { success: true }; },
                        closeBank: async () => { bankOpen = false; return { success: true }; },
                        dismissBlockingUI: async () => {},
                        walkTo: async (x: number, z: number) => { player.worldX = x; player.worldZ = z; return { success: true }; },
                        withdrawItem: async (row: { id: number; name: string }, n: number) => {
                            const b = bank.find(x => x.id === row.id);
                            if (!b || b.count < n) return { success: false };
                            b.count -= n;
                            for (let i = 0; i < n; i++) inv.push({ id: b.id, name: b.name, count: 1, slot: inv.length });
                            reindex();
                            bankGen++;
                            return { success: true };
                        },
                        depositItem: async (item: { id: number; name: string }) => {
                            let moved = 0;
                            for (let i = inv.length - 1; i >= 0; i--) {
                                if (inv[i]!.id === item.id) {
                                    moved += inv[i]!.count;
                                    inv.splice(i, 1);
                                }
                            }
                            reindex();
                            const row = bank.find(b => b.id === item.id);
                            if (row) row.count += moved;
                            else if (moved > 0) bank.push({ id: item.id, name: item.name, count: moved });
                            bankGen++;
                            return { success: true };
                        },
                        useItemOnLoc: async (item: { slot: number }) => {
                            inv[item.slot] = { id: 1712, name: 'Amulet of glory(4)', count: 1, slot: item.slot };
                            clock.step();
                            return { success: true };
                        },
                    },
                };
                // Keep player within walkTo proximity of Falador bank & Fountain so runChargeGlory stays in-memory without map loading.
                s.client = { quests: [{ name: "Heroes' Quest", state: 'complete' }] };
                return { s, cfg };
            };

            // Verify invalid env.MAX_GLORIES is read (not ignored) and rejected by runChargeGlory validation before walking.
            const { s: sBad } = await runWith({ count: 3, env: { MAX_GLORIES: '-1' } });
            const badRes = await runLogisticsWorkerSession(sBad, { operation: 'recover', role: 'charge-glory', count: 3, env: { MAX_GLORIES: '-1' } });
            expect(badRes.kind).toBe('session_unsettled');
            expect('reason' in badRes ? badRes.reason : '').toContain('invalid MAX_GLORIES');

            // Verify fallback to cfg.count when env.MAX_GLORIES is absent (invalid cfg.count=-2 hits runChargeGlory validation).
            const { s: sFallback } = await runWith({ count: -2 });
            const fallbackRes = await runLogisticsWorkerSession(sFallback, { operation: 'recover', role: 'charge-glory', count: -2 });
            expect(fallbackRes.kind).toBe('session_unsettled');
            expect('reason' in fallbackRes ? fallbackRes.reason : '').toContain('invalid MAX_GLORIES');
        } finally {
            clock.stop();
        }
    });
});
