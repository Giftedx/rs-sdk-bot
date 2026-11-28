import { describe, expect, test } from 'bun:test';
import type { BotWorldState, NearbyNpc } from '../../../vendor/rs-sdk/sdk/types';
import { runShopBuy } from '../src/market/shop-buy';
import { runStagedFishing, type FishDriver } from '../src/gather/fishing';
import { runYewsGather } from '../src/gather/woodcutting';
import { mineEssenceBatch } from '../src/gather/mining';
import { runGoldfarmKnights, stallRecipes, stealStall } from '../src/gather/thieving';
import { inventoryRecipes, runInventoryBank } from '../src/bank-artisan/crafting-production';

function makeTickClock() {
    let tick = 0;
    const listeners = new Set<() => void>();
    const onTick = (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
    };
    const step = (n = 1) => {
        for (let i = 0; i < n; i++) {
            tick++;
            for (const cb of [...listeners]) cb();
        }
    };
    return {
        tick: () => tick,
        onTick,
        step,
        start: (hook?: (t: number) => void) =>
            setInterval(() => {
                tick++;
                hook?.(tick);
                for (const cb of [...listeners]) cb();
            }, 1),
    };
}

describe('tick-workers zero-wasted-tick regressions', () => {
    test('runShopBuy wakes on the exact restock tick and adds zero post-buy idle ticks', async () => {
        const clock = makeTickClock();
        let px = 3253;
        let pz = 3420;
        let shopOpen = false;
        let bankOpen = false;
        let shopOpenTick = -1;
        let shopStock = 0;
        let heldCount = 0;
        let coins = 10_000;
        const buyTicks: number[] = [];

        const s: any = {
            name: 'shoptest',
            lifecycle: { server: 'localhost:8888' },
            tick: clock.tick,
            onTick: clock.onTick,
            ended: new Promise(() => {}),
            direct: async (act: any) => {
                if (act?.type === 'walkTo') {
                    px = act.x;
                    pz = act.z;
                }
                return { success: true };
            },
            sdk: {
                config: { host: 'localhost', port: 8888, gatewayUrl: 'ws://localhost:8888' },
                findPath: (x: number, z: number) => ({ success: true, reachedDestination: true, waypoints: [{ x, z }] }),
                getState: () => ({
                    player: { worldX: px, worldZ: pz, level: 0, isDead: false, lifeId: 1, respawnCount: 0 },
                    inventory: [
                        { id: 995, slot: 0, name: 'Coins', count: coins },
                        ...(heldCount > 0 ? [{ id: 556, slot: 1, name: 'Air rune', count: heldCount }] : []),
                    ],
                    equipment: [],
                    bank: { isOpen: bankOpen, items: [] },
                    shop: {
                        isOpen: shopOpen,
                        shopItems: [{ id: 556, slot: 0, name: 'Air rune', count: shopStock, baseCost: 4, buyPrice: 4 }],
                    },
                    dialog: { isOpen: false, options: [] },
                    interface: { isOpen: false },
                    modalOpen: false,
                    nearbyNpcs: [{ index: 7, id: 553, name: 'Aubury', x: 3253, z: 3401, distance: 1, reachable: true }],
                    nearbyLocs: [],
                    skills: [{ name: 'Hitpoints', level: 10, baseLevel: 10, experience: 1154 }],
                }),
                getInventory: () => s.sdk.getState().inventory,
                getDialog: () => s.sdk.getState().dialog,
                getSkill: () => ({ level: 10, baseLevel: 10, experience: 1154 }),
                sendWalk: async (x: number, z: number) => {
                    px = x;
                    pz = z;
                    return { success: true };
                },
            },
            bot: {
                openShop: async () => {
                    shopOpen = true;
                    if (shopOpenTick < 0) shopOpenTick = clock.tick();
                    return { success: true };
                },
                closeShop: async () => {
                    shopOpen = false;
                    return { success: true };
                },
                buyFromShop: async (_item: unknown, amount: number) => {
                    buyTicks.push(clock.tick());
                    const take = Math.min(amount, 10, shopStock);
                    shopStock -= take;
                    heldCount += take;
                    coins -= take * 4;
                    clock.step(1);
                    return { success: take > 0 };
                },
                walkTo: async (x: number, z: number) => {
                    px = x;
                    pz = z;
                    return { success: true };
                },
                openBank: async () => {
                    bankOpen = true;
                    return { success: true };
                },
                closeBank: async () => {
                    bankOpen = false;
                    return { success: true };
                },
                closeInterface: async () => {
                    bankOpen = false;
                    shopOpen = false;
                    return { success: true };
                },
                depositItem: async () => {
                    heldCount = 0;
                    return { success: true };
                },
                withdrawItem: async () => ({ success: true }),
            },
        };

        // Restock 20 air runes 3 ticks after shop opens (well inside the 15-tick stock-wait interval).
        const timer = clock.start(t => {
            if (shopOpenTick >= 0 && t === shopOpenTick + 3) shopStock = 20;
        });
        try {
            const result = await runShopBuy(s, {
                mode: 'shop-buy',
                profile: 'aubury',
                items: 'air rune',
                cap: 40,
                maxItems: 20,
                coinReserve: 100,
                maxSpend: 1000,
                noBuyTicks: 25,
                stockPollTicks: 15,
                blindBuy: false,
            });
            expect(result.boughtTotal).toBe(20);
            // Wakes on the exact restock tick (shopOpenTick + 3) rather than sleeping 15 ticks,
            // and dispatches round 2 on the very next tick (zero post-buy idle ticks).
            expect(buyTicks).toEqual([shopOpenTick + 3, shopOpenTick + 4]);
        } finally {
            clearInterval(timer);
        }
    });

    test('runStagedFishing breaks immediately on a level-up dialog and dismisses it instead of stalling 40 ticks', async () => {
        let tick = 0;
        let caught = 0;
        let dialogOpen = false;
        let closeCalls = 0;
        let interactCalls = 0;
        const spot = {
            index: 11,
            id: 328,
            name: 'Fishing spot',
            x: 3238,
            z: 3252,
            distance: 1,
            combatLevel: 0,
            hp: 0,
            maxHp: 0,
            options: ['Lure', 'Bait'],
            optionsWithIndex: [
                { text: 'Lure', opIndex: 1 },
                { text: 'Bait', opIndex: 2 },
            ],
        } as unknown as NearbyNpc;
        const makeState = (): BotWorldState =>
            ({
                player: { worldX: 3238, worldZ: 3253, level: 0, lifeId: 1, respawnCount: 0, isDead: false },
                inventory: [
                    { id: 309, slot: 0, name: 'Fly fishing rod', count: 1, optionsWithIndex: [] },
                    { id: 314, slot: 1, name: 'Feather', count: 10 - caught, optionsWithIndex: [] },
                    ...(caught > 0
                        ? Array.from({ length: caught }, (_, idx) => ({
                              id: 335,
                              slot: 2 + idx,
                              name: 'Raw trout',
                              count: 1,
                              optionsWithIndex: [],
                          }))
                        : []),
                ],
                skills: [
                    { name: 'Hitpoints', level: 10, baseLevel: 10, experience: 1154 },
                    { name: 'Fishing', level: 20, baseLevel: 20, experience: 5000 + caught * 50 },
                ],
                nearbyNpcs: [spot],
                dialog: { isOpen: dialogOpen, options: [] },
                modalOpen: dialogOpen,
            }) as unknown as BotWorldState;

        const d: FishDriver = {
            state: makeState,
            tick: () => tick,
            stopped: () => false,
            interact: async () => {
                interactCalls++;
                return { success: true };
            },
            combine: async () => ({ success: true }),
            closeDialog: async () => {
                closeCalls++;
                dialogOpen = false;
            },
            step: async () => {
                tick++;
            },
            wait: async (testFn, maxTicks) => {
                for (let i = 0; i < maxTicks; i++) {
                    tick++;
                    if (tick === 2) {
                        // Catch 1 triggers a level-up dialog.
                        caught++;
                        dialogOpen = true;
                    } else if (tick === 5) {
                        // Catch 2 lands after the bot re-clicks once the dialog is dismissed.
                        caught++;
                    }
                    if (testFn()) return true;
                }
                return false;
            },
        };

        const res = await runStagedFishing(d, {
            method: 'fly',
            amount: 2,
            cap: 60,
            maxAttempts: 5,
            progressTicks: 50,
            xpRate: 1,
        });
        expect(res.caught).toBe(2);
        expect(closeCalls).toBe(1);
        expect(interactCalls).toBe(2);
        // Without dialog break/dismissal, wait stalls 40 ticks; with it, finishes on tick 5.
        expect(res.ticks).toBeLessThanOrEqual(6);
    });

    test('runYewsGather stays on an active tree across logs, breaks on level-up dialog, and switches with zero fell wait', async () => {
        const clock = makeTickClock();
        let px = 2712;
        let pz = 3462;
        let logs = 0;
        let dialogOpen = false;
        let tree1Alive = true;
        let interactLocCalls = 0;
        let chopTreeCalls = 0;
        let closeModalCalls = 0;
        const interactTicks: number[] = [];

        const makeLocs = () => [
            ...(tree1Alive
                ? [{ id: 1309, x: 2712, z: 3461, name: 'Yew', distance: 1, optionsWithIndex: [{ text: 'Chop down', opIndex: 1 }] }]
                : []),
            { id: 1309, x: 2710, z: 3464, name: 'Yew', distance: 2, optionsWithIndex: [{ text: 'Chop down', opIndex: 1 }] },
        ];

        const s: any = {
            name: 'wctest',
            tick: clock.tick,
            onTick: clock.onTick,
            ended: new Promise(() => {}),
            direct: async (act: any) => {
                if (act.type === 'closeModal') {
                    closeModalCalls++;
                    dialogOpen = false;
                }
                return { success: true };
            },
            sdk: {
                config: { host: 'localhost', port: 8888, gatewayUrl: 'ws://localhost:8888' },
                getState: () => ({
                    player: { worldX: px, worldZ: pz, level: 0, animId: 867, isDead: false, lifeId: 1, respawnCount: 0 },
                    inventory: [
                        { id: 1359, slot: 0, name: 'Rune axe', count: 1 },
                        ...Array.from({ length: logs }, (_, i) => ({ id: 1515, slot: 1 + i, name: 'Yew logs', count: 1 })),
                    ],
                    equipment: [],
                    bank: { isOpen: false, items: [] },
                    dialog: { isOpen: dialogOpen, options: [] },
                    interface: { isOpen: false },
                    modalOpen: dialogOpen,
                    nearbyLocs: makeLocs(),
                    nearbyNpcs: [],
                    skills: [
                        { name: 'Hitpoints', level: 50, baseLevel: 50, experience: 101333 },
                        { name: 'Woodcutting', level: 70, baseLevel: 70, experience: 737627 + logs * 175 },
                    ],
                }),
                getInventory: () => s.sdk.getState().inventory,
                getEquipment: () => [],
                getDialog: () => s.sdk.getState().dialog,
                getSkill: (name: string) => s.sdk.getState().skills.find((k: any) => k.name === name),
                getSkillXp: (name: string) => s.sdk.getState().skills.find((k: any) => k.name === name)?.experience ?? 0,
                sendInteractLoc: async () => {
                    interactLocCalls++;
                    interactTicks.push(clock.tick());
                    return { success: true };
                },
            },
            bot: {
                chopTree: async () => {
                    chopTreeCalls++;
                    return { success: true };
                },
                walkTo: async (x: number, z: number) => {
                    px = x;
                    pz = z;
                    return { success: true };
                },
                openBank: async () => ({ success: true }),
                closeBank: async () => ({ success: true }),
                closeInterface: async () => ({ success: true }),
                depositItem: async () => {
                    logs = 0;
                    return { success: true };
                },
            },
        };

        const timer = clock.start(t => {
            if (t === 2) logs = 1;
            if (t === 4) {
                logs = 2;
                dialogOpen = true; // Level-up dialog during active chop.
            }
            if (t === 6) tree1Alive = false; // First tree depletes.
            if (t === 8) logs = 3;
        });
        try {
            const res = await runYewsGather(
                s,
                {
                    kind: 'gather',
                    family: 'woodcutting',
                    mode: 'yews',
                    botName: 'wc-zero-waste',
                    site: 'edgeville',
                    target: { capTicks: 10 },
                    args: [],
                    env: { SITE: 'edgeville' },
                } as any,
                () => clock.tick() >= 10,
            );
            expect(res.ok).toBe(true);
            // Uses direct sendInteractLoc with activeTree tracking rather than re-clicking s.bot.chopTree per log.
            expect(chopTreeCalls).toBe(0);
            expect(closeModalCalls).toBe(1);
            // Click 1 at start, click 2 after dialog dismissed, click 3 on the exact tick tree1 fell (tick 6).
            expect(interactLocCalls).toBe(3);
            expect(interactTicks[2]).toBe(6);
        } finally {
            clearInterval(timer);
        }
    });

    test('mineEssenceBatch wakes on odd pack-full tick and dismisses level-up dialog immediately', async () => {
        const clock = makeTickClock();
        let held = 0;
        let dialogOpen = false;
        let clicks = 0;
        let closeCalls = 0;
        const clickTicks: number[] = [];

        const s: any = {
            tick: clock.tick,
            onTick: clock.onTick,
            direct: async (act: any) => {
                if (act.type === 'closeModal') {
                    closeCalls++;
                    dialogOpen = false;
                }
                return { success: true };
            },
            sdk: {
                config: { host: 'localhost', port: 8888, gatewayUrl: 'ws://localhost:8888' },
                getState: () => ({ dialog: { isOpen: dialogOpen }, modalOpen: dialogOpen }),
            },
        };

        const timer = clock.start(t => {
            if (t === 2) dialogOpen = true;
            if (t === 5) held = 12; // Odd tick pack fill.
        });
        try {
            await mineEssenceBatch(s, {
                count: () => held,
                full: () => held >= 12,
                stop: () => false,
                busy: () => false,
                click: async () => {
                    clicks++;
                    clickTicks.push(clock.tick());
                    return { success: true };
                },
                gain: () => {},
            });
            expect(closeCalls).toBe(1);
            // Must re-click on tick 2 right after dismissing dialog (not wait 10 ticks) and exit on tick 5 (not 6).
            expect(clicks).toBe(2);
            expect(clickTicks[1]).toBe(2);
            expect(clock.tick()).toBe(5);
        } finally {
            clearInterval(timer);
        }
    });

    test('stealStall steals consecutive units with zero post-steal idle wait when stall is up', async () => {
        const clock = makeTickClock();
        const r = stallRecipes().find(x => !x.questGate)!;
        const lootId = r.loot[0]!;
        let lootCount = 0;
        let xp = 1000;
        let interactCount = 0;
        const interactTicks: number[] = [];

        const s: any = {
            name: 'stall-zero-waste',
            tick: clock.tick,
            onTick: clock.onTick,
            ended: new Promise(() => {}),
            sdk: {
                config: { host: 'localhost', port: 8888, gatewayUrl: 'ws://localhost:8888' },
                getState: () => ({
                    player: { worldX: 2669, worldZ: 3310, level: 0, lifeId: 1, respawnCount: 0, isDead: false },
                    inventory: Array.from({ length: lootCount }, (_, i) => ({ id: lootId, slot: i, name: 'Loot', count: 1 })),
                    nearbyLocs: [{ id: r.loc, x: 2668, z: 3311, name: r.name, optionsWithIndex: [{ text: 'Steal-from', opIndex: 2 }] }],
                    nearbyNpcs: [],
                    skills: [
                        { name: 'Hitpoints', level: 10, baseLevel: 10, experience: 1154 },
                        { name: 'Thieving', level: Math.max(55, r.level), baseLevel: Math.max(55, r.level), experience: xp },
                    ],
                }),
                getInventory: () => s.sdk.getState().inventory,
                getSkill: (name: string) => s.sdk.getState().skills.find((k: any) => k.name === name),
                getSkillXp: (name: string) => s.sdk.getState().skills.find((k: any) => k.name === name)?.experience ?? 0,
                sendInteractLoc: async () => {
                    interactCount++;
                    interactTicks.push(clock.tick());
                    clock.step(1);
                    lootCount++;
                    xp += 16;
                    return { success: true };
                },
            },
        };

        const res = await stealStall(s, r.name, 2, 20);
        expect(res.ok).toBe(true);
        expect(res.made).toBe(2);
        expect(interactCount).toBe(2);
        // Second steal fires immediately on tick 1 without a 2-tick post-steal sleep.
        expect(interactTicks).toEqual([0, 1]);
        expect(res.ticks).toBe(2);
    });

    test('runGoldfarmKnights dismisses dialogs, avoids noop clicks during stun, and finishes approach without banning', async () => {
        const clock = makeTickClock();
        let px = 2655;
        let pz = 3300;
        let hp = 40;
        let coins = 0;
        let dialogOpen = true;
        let knightDist = 3;
        let closeCalls = 0;
        const clickTicks: number[] = [];
        const scheduled = new Map<number, () => void>();

        const s: any = {
            name: 'goldfarm-zero-waste',
            tick: clock.tick,
            onTick: clock.onTick,
            ended: new Promise(() => {}),
            direct: async (act: any) => {
                if (act.type === 'closeModal') {
                    closeCalls++;
                    dialogOpen = false;
                    return { success: true };
                }
                if (act.type === 'interactNpc') {
                    const now = clock.tick();
                    clickTicks.push(now);
                    const n = clickTicks.length;
                    if (n === 1) {
                        // First pickpocket approaches from distance 3, then lands coins on tick +4.
                        scheduled.set(now + 4, () => {
                            knightDist = 1;
                            coins += 50;
                        });
                    } else if (n === 2) {
                        // Second pickpocket fails and stuns (damage lands after 2 ticks).
                        scheduled.set(now + 2, () => {
                            hp -= 3;
                        });
                    } else {
                        // Third pickpocket after stun expires succeeds.
                        scheduled.set(now + 1, () => {
                            coins += 50;
                        });
                    }
                }
                return { success: true };
            },
            sdk: {
                config: { host: 'localhost', port: 8888, gatewayUrl: 'ws://localhost:8888' },
                getState: () => ({
                    player: { worldX: px, worldZ: pz, level: 0, animId: -1, spotanimId: -1, isDead: false, lifeId: 1, respawnCount: 0 },
                    inventory: [
                        ...(coins > 0 ? [{ id: 995, slot: 0, name: 'Coins', count: coins, optionsWithIndex: [] }] : []),
                        { id: 385, slot: 1, name: 'Shark', count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
                        { id: 385, slot: 2, name: 'Shark', count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
                        { id: 385, slot: 3, name: 'Shark', count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
                        { id: 385, slot: 4, name: 'Shark', count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
                        { id: 385, slot: 5, name: 'Shark', count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
                    ],
                    dialog: { isOpen: dialogOpen, options: [] },
                    modalOpen: dialogOpen,
                    nearbyNpcs: [
                        {
                            index: 42,
                            name: 'Knight of Ardougne',
                            x: 2655 + knightDist,
                            z: 3300,
                            distance: knightDist,
                            reachable: true,
                            optionsWithIndex: [{ text: 'Pickpocket', opIndex: 3 }],
                        },
                    ],
                    nearbyLocs: [],
                    skills: [
                        { name: 'Hitpoints', level: hp, baseLevel: 40, experience: 37224 },
                        { name: 'Thieving', level: 55, baseLevel: 55, experience: 166636 },
                    ],
                }),
                getInventory: () => s.sdk.getState().inventory,
                getSkill: (name: string) => s.sdk.getState().skills.find((k: any) => k.name === name),
            },
            bot: {
                eatFood: async () => ({ success: true }),
                walkTo: async (x: number, z: number) => {
                    px = x;
                    pz = z;
                    return { success: true };
                },
            },
        };

        const timer = clock.start(t => {
            const fn = scheduled.get(t);
            if (fn) {
                scheduled.delete(t);
                fn();
            }
        });
        try {
            const res = await runGoldfarmKnights(
                s,
                {
                    kind: 'gather',
                    family: 'thieving',
                    mode: 'goldfarm',
                    botName: 'goldfarm-zero-waste',
                    target: { capTicks: 22 },
                    args: [],
                    env: { TICKS: '22', BANK_AT: '50000' },
                } as any,
                () => false,
            );
            expect(res.ok).toBe(true);
            expect(closeCalls).toBe(1);
            expect(res.detail).toContain('bans=0');
            // Click 3 must wait until the 8-tick stun from click 2 expires instead of spamming noop clicks during stun.
            expect(clickTicks.length).toBeGreaterThanOrEqual(3);
            expect(clickTicks[2]! - clickTicks[1]!).toBeGreaterThanOrEqual(8);
        } finally {
            clearInterval(timer);
        }
    });

    test('runInventoryBank triggers closeModal fallback after 2 ticks instead of 8 when closeBank misses', async () => {
        const clock = makeTickClock();
        const r = inventoryRecipes().find(x => x.name === 'pie-shell')!;
        let bankOpen = false;
        let generation = 1;
        let closeModalAt = -1;
        let pack: { id: number; slot: number; name: string; count: number }[] = [];
        const stock = new Map<number, number>([
            ...r.inputs.map(i => [i.id, i.units * 2] as [number, number]),
            ...r.tools.map(id => [id, 1] as [number, number]),
        ]);
        const bankItems = () =>
            [...stock].filter(([, count]) => count > 0).map(([id, count], slot) => ({ id, count, slot, name: `item-${id}` }));
        const add = (id: number, n: number) => {
            const p = pack.find(i => i.id === id);
            if (p) p.count += n;
            else pack.push({ id, count: n, slot: pack.length, name: `item-${id}` });
        };

        const s: any = {
            name: 'bank-close-fast',
            tick: clock.tick,
            onTick: clock.onTick,
            ended: new Promise(() => {}),
            direct: async (act: any) => {
                if (act.type === 'closeModal') {
                    closeModalAt = clock.tick();
                    bankOpen = false;
                }
                return { success: true };
            },
            bankObservation: () => ({ generation, items: bankItems().map(({ slot: _slot, ...i }) => i) }),
            sdk: {
                getInventory: () => pack.filter(i => i.count > 0),
                getSkill: () => ({ level: 99 }),
                getSkillXp: () => 100,
                getDialog: () => ({ isOpen: false }),
                getState: () => ({
                    player: { lifeId: 1, worldX: 3185, worldZ: 3436, level: 0 },
                    inventory: pack.filter(i => i.count > 0),
                    bank: { isOpen: bankOpen, noteMode: false, items: bankItems() },
                    interface: { isOpen: false },
                }),
                sendUseItemOnItem: async () => {
                    clock.step(1);
                    for (const i of r.inputs) add(i.id, -i.units);
                    add(r.product, r.productUnits ?? 1);
                    return { success: true };
                },
            },
            bot: {
                openBank: async () => {
                    bankOpen = true;
                    generation++;
                    return { success: true };
                },
                closeBank: async () => ({ success: true }), // Leaves bankOpen = true to exercise closeModal fallback.
                withdrawItem: async (item: { id: number }, n: number) => {
                    stock.set(item.id, (stock.get(item.id) ?? 0) - n);
                    add(item.id, n);
                    generation++;
                    return { success: true };
                },
                depositItem: async (item: { id: number }) => {
                    const row = pack.find(i => i.id === item.id);
                    const n = row?.count ?? 0;
                    if (row) row.count = 0;
                    stock.set(item.id, (stock.get(item.id) ?? 0) + n);
                    generation++;
                    return { success: true };
                },
            },
        };

        const timer = clock.start();
        try {
            const res = await runInventoryBank(s, r, { maximum: 1, cap: 20, maxAttempts: 2 });
            expect(res.ok).toBe(true);
            expect(closeModalAt).toBeGreaterThanOrEqual(2);
            expect(closeModalAt).toBeLessThanOrEqual(3);
        } finally {
            clearInterval(timer);
        }
    });
});
