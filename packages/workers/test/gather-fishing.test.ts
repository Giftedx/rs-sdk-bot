// Consolidated unit tests for fishing gathering: fishcook, staged microbot fishing, village fishing, and shark supply.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, spyOn, test } from 'bun:test';
import type { Session } from '../../core/src/inprocess';
import { resultCounters } from '../../core/src/status';
import * as ticks from '../../core/src/ticks';
import * as walking from '../../core/src/walk';
import type { PathDeps, PathTile } from '../../core/src/walk';
import { cookSharks, sharkCookDelta } from '../../../scripts/cook-food';
import type { BotWorldState } from '../../../vendor/rs-sdk/sdk/types';
import {
    FISH_KNIFE_RESET,
    FISH_PROFILES,
    KNIFE,
    NORMAL_LOGS,
    SHARK_IDLE_TICKS,
    SHARK_PROGRESS_TICKS,
    bestFishingMethod,
    bigNetReceipt as nativeBigNetReceipt,
    bigNetSnapshot,
    buyFishingSupplies,
    catchSharks,
    catherbyFishingSearchPoints,
    claimSharkOrder,
    cookCourierReady,
    cookStarterChickens,
    dropVillageOutput,
    ensureCatherbyFishingTool,
    finiteFoodCanCatch,
    finiteFoodEntryPosition,
    finiteFoodExitReady,
    finiteFoodKindsWork,
    finiteFoodPreferredRaw,
    finiteFoodProfile,
    finiteFoodSpotAllowed,
    finiteFoodWork,
    fishSpotIds,
    fishingByproducts,
    fishingCapacityOutputs,
    fishingMethodRequirements,
    fishingOutputs,
    fundFishingTool,
    guardSharkRoute,
    harpoonPurchase,
    karambwanAttemptEffect,
    karambwanLoadEffect,
    knifeCut,
    knifeDelay,
    pickFishSpot,
    runStagedFishing,
    runVillageFishing,
    searchNativeCatherbyFishing,
    settleSharkOrder,
    sharkAssetCheck,
    sharkAssets,
    sharkEntry,
    sharkFishingTrace,
    sharkOrderConfig,
    sharkRoutePlan,
    sharkSpot,
    sharkSummary,
    supplySharks,
    villagePackEffect,
    villagePolicy,
    type FishAction,
    type FishDriver,
    type FishMethod,
    type VillageOrder,
} from '../src/gather';

function fishcookAccount(bankCoins = 25, coins = 0, rod = false) {
    const inventory: any[] = [{ name: 'Coins', count: coins }, ...(rod ? [{ name: 'Fly fishing rod', count: 1 }] : [])];
    let withdrew = 0;
    const session = {
        sdk: {
            getInventory: () => inventory,
            getState: () => ({ inventory }),
            findBankItem: () => (bankCoins ? { name: 'Coins', count: bankCoins } : undefined),
        },
        bot: {
            withdrawItem: async (_item: any, amount: number) => {
                withdrew += amount;
                bankCoins -= amount;
                inventory[0].count += amount;
                return { success: true };
            },
        },
    } as any;
    return { session, held: () => inventory[0].count, bank: () => bankCoins, withdrew: () => withdrew };
}

test('a staged new fisher uses its banked starter coins for the missing fly rod', async () => {
    const a = fishcookAccount();
    await fundFishingTool(a.session);
    expect(a.held()).toBe(25);
    expect(a.bank()).toBe(0);
});

test('Gerrant supplies the rod before feathers spend the starter budget', async () => {
    const inventory: any[] = [{ name: 'Coins', count: 25 }];
    const calls: string[] = [];
    const s: any = {
        sdk: { getState: () => ({ inventory }) },
        bot: {
            buyFromShop: async (pattern: RegExp, n: number) => {
                const rod = pattern.test('Fly fishing rod');
                const price = rod ? 5 : 2;
                const bought = Math.min(n, Math.floor(inventory[0].count / price));
                calls.push(rod ? 'rod' : 'feathers');
                inventory[0].count -= bought * price;
                if (bought) inventory.push({ name: rod ? 'Fly fishing rod' : 'Feather', count: bought });
                return { success: bought > 0 };
            },
        },
    };
    await buyFishingSupplies(s, 1000);
    expect(calls).toEqual(['rod', 'feathers']);
    expect(inventory.find(i => i.name === 'Fly fishing rod')?.count).toBe(1);
    expect(inventory.find(i => i.name === 'Feather')?.count).toBe(10);
});

test('tool funding preserves bank coins when the rod or enough cash is already held', async () => {
    for (const a of [fishcookAccount(25, 0, true), fishcookAccount(25, 10)]) {
        await fundFishingTool(a.session);
        expect(a.withdrew()).toBe(0);
        expect(a.bank()).toBe(25);
    }
    const empty = fishcookAccount(0);
    await fundFishingTool(empty.session);
    expect(empty.held()).toBe(0);
    expect(empty.withdrew()).toBe(0);
});

test('a fisher that spent its coins can sell its own banked net catch to recover a rod', async () => {
    const inventory: any[] = [{ name: 'Coins', count: 1 }];
    let bankFish = 13;
    let noted = false;
    const s: any = {
        sdk: {
            getState: () => ({ inventory }),
            findBankItem: (re: RegExp) => (re.test('Raw shrimps') && bankFish ? { name: 'Raw shrimps', count: bankFish } : undefined),
        },
        bot: {
            withdrawItem: async (i: any, n: number, o: any) => {
                noted = o?.asNote === true;
                bankFish -= n;
                inventory.push({ name: i.name, count: n });
                return { success: true };
            },
        },
    };
    await fundFishingTool(s);
    expect(bankFish).toBe(0);
    expect(noted).toBe(true);
    expect(inventory.find(i => i.name === 'Raw shrimps')?.count).toBe(13);
});

test('only the named cook responds to a targeted live collection at Draynor', () => {
    const now = 100000;
    const s = { name: 'Courier', server: 'rs-sdk-demo.fly.dev', at: now, result: '', pos: { x: 3092, z: 3243, level: 0 }, phase: 'collecting Second' };
    expect(cookCourierReady(s, 'Courier', 'Second', now, true)).toBe(true);
    expect(cookCourierReady(s, 'Courier', 'First', now, true)).toBe(false);
    expect(cookCourierReady({ ...s, phase: 'draynor 274' }, 'Courier', 'Second', now, true)).toBe(false);
    expect(cookCourierReady({ ...s, phase: 'draynor 274' }, 'Courier', 'Second', now, false)).toBe(true);
    for (const patch of [{ name: 'Foreign' }, { at: now - 30000 }, { at: now + 1 }, { result: 'ok done' }, { server: 'localhost:8888' }, { pos: { x: 3092, z: 3243, level: 1 } }, { pos: { x: 3230, z: 3254, level: 0 } }]) {
        expect(cookCourierReady({ ...s, ...patch }, 'Courier', 'Second', now, true)).toBe(false);
    }
});

test('bootstrap food refuses missing raw input before travel or cooking', async () => {
    const s: any = { tick: () => 0, sdk: { getState: () => ({ inventory: [] }), getInventory: () => [], getSkillXp: () => 0 } };
    await expect(cookStarterChickens(s)).rejects.toThrow('train chickens and collect raw chicken2138');
});

async function starterCookingModel(mode: string, run: (s: any, model: any) => Promise<void>, stock = { raw: 2, cooked: 0, burnt: 0 }) {
    let tick = 0;
    let xp = 0;
    let due = 0;
    let started = 0;
    let actions = 0;
    let direct = 0;
    const listeners = new Set<() => void>();
    const logs: string[] = [];
    const state: any = {
        inventory: [],
        player: { worldX: 3213, worldZ: 3249, level: 0, animId: -1 },
        dialog: { isOpen: false },
        interface: { isOpen: false },
        gameMessages: [],
        nearbyLocs: [{ id: 2724, name: 'Fireplace', x: 3214, z: 3249, distance: 1 }],
    };
    const sync = () => {
        state.inventory = [
            ...Array.from({ length: stock.raw }, (_, slot) => ({ id: 2138, name: 'Raw chicken', count: 1, slot })),
            { id: 2140, name: 'Cooked chicken', count: stock.cooked, slot: 20 },
            { id: 2144, name: 'Burnt chicken', count: stock.burnt, slot: 21 },
        ];
    };
    sync();
    const dispatch = () => {
        actions++;
        started = tick + 12;
        due = started + 2;
        return { success: true, phase: 'dispatch' };
    };
    const s: any = {
        tick: () => tick,
        ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        sdk: {
            getState: () => state,
            getInventory: () => state.inventory,
            getDialog: () => state.dialog,
            getSkillXp: () => xp,
            sendUseItemOnLoc: async () => {
                if (mode === 'rejected') {
                    actions++;
                    return { success: false, reason: 'client_rejected', message: 'rejected test action' };
                }
                return dispatch();
            },
        },
        direct: async () => {
            direct++;
            return dispatch();
        },
        bot: {
            dismissBlockingUI: async () => {},
            useItemOnLoc: async (item: any, fire: any) => {
                expect(item.id).toBe(2138);
                expect(fire).toMatchObject({ id: 2724, x: 3214, z: 3249 });
                if (mode === 'pre-dispatch') {
                    await new Promise<void>(resolve => {
                        const off = s.onTick(() => {
                            off();
                            resolve();
                        });
                    });
                }
                const reply = await s.sdk.sendUseItemOnLoc(item.slot, fire.x, fire.z, fire.id);
                if (!reply.success) return { success: false, message: reply.message };
                await new Promise<void>(resolve => {
                    const off = s.onTick(() => {
                        if (tick >= started) {
                            off();
                            resolve();
                        }
                    });
                });
                return { success: true, message: 'interaction observed' };
            },
        },
    };
    const spies = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockResolvedValue({ ok: true } as any),
        spyOn(console, 'log').mockImplementation((...args: any[]) => {
            logs.push(args.join(' '));
        }),
    ];
    if (mode === 'observation-error') spies.push(spyOn(ticks, 'waitUntil').mockRejectedValue(Error('tick stream lost')) as any);
    const timer = setInterval(() => {
        tick++;
        if (tick === started) state.player.animId = 897;
        if (tick === due && !['stalled', 'cancelled'].includes(mode)) {
            stock.raw--;
            if (mode === 'lost-output') {
                // Intentionally drop item output without conversion credit
            } else if (['burnt', 'late-burnt'].includes(mode)) {
                stock.burnt++;
            } else {
                stock.cooked++;
                if (!['missing-xp', 'delayed-xp'].includes(mode)) xp += mode === 'late-cooked' ? 750 : 30;
            }
            state.gameMessages.push({
                tick,
                text: mode === 'burnt' ? 'You accidentally burn the chicken.' : 'The chicken is now nicely cooked.',
            });
            sync();
        }
        if (mode === 'delayed-xp' && tick === due + 1) xp += 30;
        for (const cb of [...listeners]) cb();
    }, 1);
    const originalSend = s.sdk.sendUseItemOnLoc;
    try {
        await run(s, { stock, logs, tick: () => tick, actions: () => actions, direct: () => direct, listeners });
    } finally {
        expect(s.sdk.sendUseItemOnLoc).toBe(originalSend);
        expect(listeners.size).toBe(0);
        clearInterval(timer);
        for (const spy of spies) spy.mockRestore();
    }
}

test('bootstrap observes interaction before its conversion deadline; delayed cooking is counted once', async () => {
    await starterCookingModel('cooked', async (s, m) => {
        const r = await cookStarterChickens(s);
        expect(r).toMatchObject({ ok: true, raw: 2, consumed: 2, cooked: 2, burnt: 0, xp: 60, remainingRaw: 0 });
        expect(m.tick()).toBeGreaterThan(8);
        expect(m.actions()).toBe(2);
        expect(m.direct()).toBe(0);
        expect(m.logs.some((l: string) => l.includes('interaction observed') && l.includes('2724'))).toBe(true);
    });
});

for (const mode of ['late-cooked', 'late-burnt']) {
    test(`accepted cooking settles after stop before the owner snapshots and logs out: ${mode}`, async () => {
        await starterCookingModel(
            mode,
            async (s, m) => {
                let failure = '';
                try {
                    await cookStarterChickens(s, () => m.tick() >= 13);
                } catch (error) {
                    failure = String(error);
                }
                expect(failure).toContain('stopped');
                const final = { ...m.stock, xp: s.sdk.getSkillXp('Cooking') };
                expect(final).toEqual({ raw: 9, cooked: mode === 'late-cooked' ? 1 : 0, burnt: mode === 'late-burnt' ? 1 : 0, xp: mode === 'late-cooked' ? 750 : 0 });
                expect(m.actions()).toBe(1);
                expect(m.tick()).toBe(14);
                if (mode === 'late-cooked') {
                    const resumed = await cookStarterChickens(s, () => false, { requiredFood: 3 });
                    expect(resumed).toMatchObject({ ok: true, raw: 9, consumed: 9, cooked: 9, burnt: 0, xp: 6750, remainingRaw: 0 });
                    expect(m.stock).toEqual({ raw: 0, cooked: 10, burnt: 0 });
                    expect(s.sdk.getSkillXp('Cooking')).toBe(7500);
                }
            },
            { raw: 10, cooked: 0, burnt: 0 },
        );
    });
}

test('loss of observation after an accepted use remains explicitly unresolved', async () => {
    await starterCookingModel('observation-error', async (s, m) => {
        await expect(cookStarterChickens(s)).rejects.toThrow('settlement unresolved: observation failed: Error: tick stream lost');
        expect(m.actions()).toBe(1);
    });
});

test('bootstrap preserves explicit rejected action and boundary observations without retry', async () => {
    await starterCookingModel('rejected', async (s, m) => {
        await expect(cookStarterChickens(s)).rejects.toThrow('client_rejected');
        expect(m.actions()).toBe(1);
        expect(m.stock.raw).toBe(2);
        expect(m.logs.join('\n')).toContain('rejected test action');
    });
});

test('bootstrap cancellation before dispatch sends nothing; accepted unresolved work uses only its cleanup bound', async () => {
    await starterCookingModel('cancelled', async (s, m) => {
        await expect(cookStarterChickens(s, () => true)).rejects.toThrow('stopped');
        expect(m.actions()).toBe(0);
        await expect(cookStarterChickens(s, () => m.tick() >= 13)).rejects.toThrow('settlement unresolved: conversion unobserved; stopped=true');
        expect(m.tick()).toBe(20);
        expect(m.actions()).toBe(1);
        expect(m.stock.raw).toBe(2);
    });
});

test('stop during helper preparation is checked again at the primitive dispatch boundary', async () => {
    await starterCookingModel('pre-dispatch', async (s, m) => {
        await expect(cookStarterChickens(s, () => m.tick() >= 1)).rejects.toThrow('stopped');
        expect(m.actions()).toBe(0);
        expect(m.stock.raw).toBe(2);
    });
});

test('bootstrap counts actual burnt output and reports the exact finite food deficit', async () => {
    await starterCookingModel('burnt', async (s, m) => {
        await expect(cookStarterChickens(s)).rejects.toThrow('cooked chicken2140 needs1');
        expect(m.stock).toEqual({ raw: 0, cooked: 0, burnt: 2 });
        expect(m.logs.join('\n')).toContain('"burnt":2');
    });
});

test('bootstrap restart uses retained raw and cooked stock; prior burnt stock is not new output', async () => {
    await starterCookingModel(
        'cooked',
        async (s, m) => {
            expect(await cookStarterChickens(s)).toMatchObject({ ok: true, raw: 1, consumed: 1, cooked: 1, burnt: 0, xp: 30 });
            expect(m.stock).toEqual({ raw: 0, cooked: 3, burnt: 1 });
        },
        { raw: 1, cooked: 2, burnt: 1 },
    );
    await starterCookingModel(
        'cooked',
        async (s, m) => {
            expect(await cookStarterChickens(s)).toMatchObject({ ok: true, consumed: 0, cooked: 0, burnt: 0, xp: 0 });
            expect(m.actions()).toBe(0);
        },
        { raw: 0, cooked: 3, burnt: 1 },
    );
});

test('bootstrap observes Cooking XP independently when its packet follows inventory output', async () => {
    await starterCookingModel('delayed-xp', async s => {
        expect(await cookStarterChickens(s)).toMatchObject({ ok: true, consumed: 2, cooked: 2, xp: 60 });
    });
});

test('bootstrap uses the caller food requirement and keeps retained cooked stock after burns', async () => {
    await starterCookingModel(
        'burnt',
        async (s, m) => {
            await expect(cookStarterChickens(s, () => false, { requiredFood: 3 })).rejects.toThrow('cooked chicken2140 needs2');
            expect(m.stock).toEqual({ raw: 0, cooked: 1, burnt: 2 });
        },
        { raw: 1, cooked: 1, burnt: 1 },
    );
});

for (const mode of ['stalled', 'lost-output', 'missing-xp']) {
    test(`bootstrap refuses unproved cooking effects: ${mode}`, async () => {
        await starterCookingModel(mode, async (s, m) => {
            await expect(cookStarterChickens(s)).rejects.toThrow(
                mode === 'stalled' ? 'conversion unobserved' : mode === 'lost-output' ? 'output mismatch' : 'Cooking XP unobserved',
            );
            expect(m.actions()).toBe(1);
            expect(m.tick()).toBeLessThanOrEqual(21);
        });
    });
}

test('finite supported food profile is explicit and bounds bootstrap, fly catches and a queued catch', () => {
    expect(finiteFoodProfile(undefined)).toBeUndefined();
    const p = finiteFoodProfile('16')!;
    expect(p).toEqual({ target: 16, netCap: 16, flyCap: 32, catchCap: 48, noProgressTicks: 240 });
    for (const v of ['', '0', '29', '1.5', 'NaN']) expect(() => finiteFoodProfile(v)).toThrow('FOOD_TARGET');
    expect(finiteFoodCanCatch(p, 14, 0, 'net')).toBe(true);
    expect(finiteFoodCanCatch(p, 15, 0, 'net')).toBe(false);
    expect(finiteFoodCanCatch(p, 13, 30, 'fly')).toBe(true);
    expect(finiteFoodCanCatch(p, 13, 31, 'fly')).toBe(false);
});

test('finite useful output stops at 16 new deposits and cooks only the remaining deficit after burns', () => {
    const p = finiteFoodProfile('16')!;
    expect(finiteFoodWork(p, 0, 0, 16)).toEqual({ needed: 16, cook: true, fish: false, done: false });
    expect(finiteFoodWork(p, 0, 14, 0)).toEqual({ needed: 2, cook: false, fish: true, done: false });
    expect(finiteFoodWork(p, 14, 0, 2)).toEqual({ needed: 2, cook: true, fish: false, done: false });
    expect(finiteFoodWork(p, 14, 2, 1)).toEqual({ needed: 0, cook: false, fish: false, done: false });
    expect(finiteFoodWork(p, 16, 0, 1)).toEqual({ needed: 0, cook: false, fish: false, done: true });
});

test('finite rod funding withdraws only 5 owned coins and never liquidates bootstrap stock', async () => {
    const a = fishcookAccount(1123);
    await fundFishingTool(a.session, 5, false);
    expect(a.held()).toBe(5);
    expect(a.bank()).toBe(1118);
    let calls = 0;
    const empty: any = {
        sdk: { getState: () => ({ inventory: [] }), findBankItem: (re: RegExp) => (re.test('Raw shrimps') ? { name: 'Raw shrimps', count: 13 } : undefined) },
        bot: {
            withdrawItem: async () => {
                calls++;
                return { success: true };
            },
        },
    };
    expect(await fundFishingTool(empty, 5, false)).toBe(0);
    expect(calls).toBe(0);
});

test('rod-only acquisition leaves the owned feather budget untouched and costs exactly 5 coins', async () => {
    const inventory: any[] = [{ name: 'Coins', count: 5 }, { name: 'Feather', count: 32 }];
    const calls: string[] = [];
    const s: any = {
        sdk: { getState: () => ({ inventory }) },
        bot: {
            buyFromShop: async (re: RegExp, n: number) => {
                calls.push(re.source);
                expect(re.test('Fly fishing rod')).toBe(true);
                expect(n).toBe(1);
                inventory[0].count -= 5;
                inventory.push({ name: 'Fly fishing rod', count: 1 });
                return { success: true };
            },
        },
    };
    expect(await buyFishingSupplies(s, 0)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(inventory[0].count).toBe(0);
    expect(inventory[1].count).toBe(32);
});

test('finite food admits actual Ghost cemetery entry and Draynor while refusing unknown surface routes', () => {
    expect(finiteFoodEntryPosition({ worldX: 3248, worldZ: 3193, level: 0 })).toBe(true);
    expect(finiteFoodEntryPosition({ worldX: 3092, worldZ: 3242, level: 0 })).toBe(true);
    for (const p of [undefined, { worldX: 3248, worldZ: 3193, level: 1 }, { worldX: 2655, worldZ: 3283, level: 0 }, { worldX: 3104, worldZ: 9576, level: 0 }]) {
        expect(finiteFoodEntryPosition(p)).toBe(false);
    }
});

test('single-kind budget is explicit, finite and leaves owned feathers reserved', () => {
    const p = finiteFoodProfile('16', '1')!;
    expect(p).toEqual({ target: 16, netCap: 16, flyCap: 48, catchCap: 64, noProgressTicks: 240, singleKind: true });
    expect(85 - p.flyCap).toBe(37);
    expect(finiteFoodProfile('1', '1')!.flyCap).toBe(3);
    for (const [target, mode] of [[undefined, '1'], ['16', '2'], ['17', '1']] as const) expect(() => finiteFoodProfile(target, mode)).toThrow();
    expect(finiteFoodProfile('16', '0')).toEqual(finiteFoodProfile('16'));
});

test('16 mixed fish never satisfy the single-kind consumer; only new bank deposits count', () => {
    const p = finiteFoodProfile('16', '1')!;
    const z = { trout: 0, salmon: 0 };
    expect(finiteFoodKindsWork(p, { trout: 8, salmon: 8 }, z, z).done).toBe(false);
    expect(finiteFoodKindsWork(p, { trout: 16, salmon: 5 }, z, z).done).toBe(true);
    expect(finiteFoodKindsWork(p, { trout: 3, salmon: 17 }, z, z).done).toBe(true);
    expect(finiteFoodKindsWork(p, z, z, z).done).toBe(false);
});

test('single-kind batching waits for enough raw of a kind rather than an aggregate deficit', () => {
    const p = finiteFoodProfile('16', '1')!;
    const bank = { trout: 13, salmon: 9 };
    const z = { trout: 0, salmon: 0 };
    expect(finiteFoodKindsWork(p, bank, z, { trout: 1, salmon: 4 }).fish).toBe(true);
    expect(finiteFoodKindsWork(p, bank, z, { trout: 3, salmon: 4 })).toEqual({ needed: 3, cook: true, fish: false, done: false });
    expect(finiteFoodKindsWork(p, bank, { trout: 3, salmon: 0 }, { trout: 0, salmon: 4 })).toEqual({ needed: 0, cook: false, fish: false, done: false });
    expect(finiteFoodPreferredRaw(p, bank, z, { trout: 3, salmon: 4 })).toBe(335);
});

test('single-kind cooking finishes the attainable kind before converting unnecessary byproduct', () => {
    const p = finiteFoodProfile('16', '1')!;
    const z = { trout: 0, salmon: 0 };
    expect(finiteFoodPreferredRaw(p, { trout: 15, salmon: 8 }, z, { trout: 1, salmon: 5 })).toBe(335);
    expect(finiteFoodPreferredRaw(p, { trout: 14, salmon: 15 }, z, { trout: 2, salmon: 1 })).toBe(331);
    expect(finiteFoodPreferredRaw(p, { trout: 15, salmon: 15 }, z, { trout: 1, salmon: 1 })).toBe(331);
    expect(finiteFoodPreferredRaw(p, { trout: 16, salmon: 10 }, z, { trout: 0, salmon: 2 })).toBeUndefined();
});

test('aggregate finite batching and stopping retain their original contract', () => {
    const p = finiteFoodProfile('16')!;
    const z = { trout: 0, salmon: 0 };
    expect(finiteFoodKindsWork(p, { trout: 8, salmon: 8 }, z, z)).toEqual(finiteFoodWork(p, 16, 0, 0));
    expect(finiteFoodKindsWork(p, { trout: 5, salmon: 6 }, { trout: 2, salmon: 1 }, { trout: 2, salmon: 0 })).toEqual(finiteFoodWork(p, 11, 3, 2));
    expect(finiteFoodPreferredRaw(p, z, z, { trout: 16, salmon: 16 })).toBeUndefined();
});

test('only the guarded finite profile admits the eight canonical moving river spots', () => {
    const npc = { id: 329, name: 'Fishing spot', reachable: true, optionsWithIndex: [{ text: 'Lure', opIndex: 1 }, { text: 'Bait', opIndex: 3 }] };
    const points = [[3239, 3241], [3239, 3242], [3239, 3243], [3239, 3244], [3238, 3251], [3238, 3252], [3238, 3254], [3238, 3255]];
    for (const [x, z] of points) {
        expect(finiteFoodSpotAllowed({ ...npc, x, z }, true)).toBe(true);
        expect(finiteFoodSpotAllowed({ ...npc, x, z })).toBe(z! >= 3248);
    }
    for (const patch of [{ id: 403, x: 3238, z: 3254 }, { id: 330, x: 3238, z: 3254 }, { x: 3239, z: 3240 }, { x: 3240, z: 3252 }, { x: 3239, z: 3250 }, { x: 3238, z: 3254, reachable: false }, { x: 3238, z: 3254, optionsWithIndex: [{ text: 'Bait', opIndex: 3 }] }]) {
        expect(finiteFoodSpotAllowed({ ...npc, ...patch }, true)).toBe(false);
    }
    expect(finiteFoodSpotAllowed({ ...npc, id: 330, x: 3240, z: 3252, reachable: false })).toBe(true);
});

test('a late safety stop overrides completed bank receipts, including the final catch-limit checkpoint', () => {
    const p = finiteFoodProfile('16', '1')!;
    const bank = { trout: 0, salmon: 0 };
    const z = { trout: 0, salmon: 0 };
    const pos = { worldX: 3092, worldZ: 3242, level: 0 };
    let blocked = false;
    const exit = () => finiteFoodExitReady(p, finiteFoodKindsWork(p, bank, z, z).done, 13, 32, blocked, pos);
    expect(exit()).toBe(false);
    bank.trout = 16;
    bank.salmon = 5;
    expect(exit()).toBe(true);
    blocked = true;
    expect(exit()).toBe(false);
    expect(finiteFoodExitReady(p, true, 13, 32, false, { worldX: 3239, worldZ: 3251, level: 0 })).toBe(false);
    expect(finiteFoodExitReady(p, true, 13, 32, false, { ...pos, level: 1 })).toBe(false);
    expect(finiteFoodExitReady(p, true, 13, 49, false, pos)).toBe(false);
});

// --- Staged fishing (formerly microbot-b-fishing.test.ts) ---
const item = (id: number, count = 1, slot = 0) => ({ id, count, slot, name: 'native fixture item', optionsWithIndex: [] });
const fishState = (method: 'fly' | 'karambwan', inventory: ReturnType<typeof item>[], xp = 0) =>
    ({
        player: { worldX: 2899, worldZ: 3118, level: 0, lifeId: 1 },
        inventory,
        skills: [{ name: 'Fishing', level: 65, experience: xp }, { name: 'Hitpoints', level: 10, baseLevel: 10, experience: 1000 }],
        nearbyNpcs: [{ index: 1, id: fishSpotIds(method)[0], x: 2900, z: 3118, distance: 1, optionsWithIndex: [{ text: method === 'fly' ? 'Lure' : 'Fish', opIndex: 1 }] }],
    }) as unknown as BotWorldState;
const fishOptions = { method: 'fly' as const, amount: 2, cap: 100, maxAttempts: 10, progressTicks: 40 };

test('native spot categories exclude lookalike shrimp and quest-only spots', () => {
    expect(fishSpotIds('karambwan')).toEqual([1176, 1177, 1178]);
    expect(fishSpotIds('karambwanji')).toEqual([1174, 1175]);
    const s = fishState('fly', [item(309), item(314, 10, 1)]);
    expect(pickFishSpot(s, 'fly')?.index).toBe(1);
    s.nearbyNpcs[0]!.id = fishSpotIds('net')[0]!;
    expect(pickFishSpot(s, 'fly')).toBeUndefined();
});

test('wrong-type-only window searches native shore then dispatches only a later compatible Cage spot', async () => {
    let tick = 0;
    let searches = 0;
    let actions = 0;
    const make = (correct = false, caught = 0) =>
        ({
            ...fishState('fly', [item(301), ...(caught ? [item(377, caught, 1)] : [])], caught * 90),
            nearbyNpcs: [{ index: correct ? 7 : 1, id: correct ? 321 : 320, x: 2860, z: 3426, distance: 2, reachable: true, optionsWithIndex: [{ text: correct ? 'Cage' : 'Net', opIndex: 1 }] }],
        }) as unknown as BotWorldState;
    let current = make();
    const d: FishDriver = {
        state: () => current,
        tick: () => tick,
        stopped: () => false,
        interact: async (index, op) => {
            expect(index).toBe(7);
            expect(op).toBe(1);
            actions++;
            return { success: true };
        },
        combine: async () => ({ success: true }),
        step: async () => {
            tick++;
        },
        wait: async testFn => {
            tick++;
            current = make(true, 1);
            return testFn();
        },
        search: async (pass, stop) => {
            expect(stop()).toBe(false);
            searches++;
            tick += 3;
            if (pass === 1) current = make(true);
            return true;
        },
    };
    const result = await runStagedFishing(d, { method: 'cage', amount: 1, cap: 100, maxAttempts: 5, progressTicks: 40 });
    expect(result.caught).toBe(1);
    expect(actions).toBe(1);
    expect(searches).toBe(2);
    expect(tick).toBeLessThan(12);
    expect(catherbyFishingSearchPoints()).toEqual([{ x: 2836, z: 3431, level: 0 }, { x: 2846, z: 3429, level: 0 }, { x: 2860, z: 3426, level: 0 }]);
});

test('absent compatible type and cancellation bound searches without dispatching wrong categories', async () => {
    for (const stoppedAt of [2, 100]) {
        let tick = 0;
        let searches = 0;
        let actions = 0;
        const current = fishState('fly', [item(301)]);
        current.nearbyNpcs[0]!.id = 320;
        const d: FishDriver = {
            state: () => current,
            tick: () => tick,
            stopped: () => tick >= stoppedAt,
            interact: async () => {
                actions++;
                return { success: true };
            },
            combine: async () => ({ success: true }),
            step: async () => {
                tick++;
            },
            wait: async () => false,
            search: async (_pass, stop) => {
                searches++;
                tick++;
                stop();
                return true;
            },
        };
        await expect(runStagedFishing(d, { method: 'cage', amount: 1, cap: 100, maxAttempts: 5, progressTicks: 40 })).rejects.toThrow();
        expect(actions).toBe(0);
        expect(searches).toBeLessThanOrEqual(3);
        expect(tick).toBeLessThanOrEqual(3);
    }
});

test('fly fishing counts native catches and exact feather debit without repeated clicks', async () => {
    let current = fishState('fly', [item(309), item(314, 10, 1)]);
    let tick = 0;
    let actions = 0;
    let caught = 0;
    const d: FishDriver = {
        state: () => current,
        tick: () => tick,
        stopped: () => false,
        interact: async () => {
            actions++;
            return { success: true };
        },
        combine: async () => ({ success: true }),
        step: async () => {
            tick++;
        },
        wait: async testFn => {
            tick++;
            caught++;
            current = fishState('fly', [item(309), item(314, 10 - caught, 1), item(335, caught, 2)], caught * 50);
            return testFn();
        },
    };
    expect(await runStagedFishing(d, fishOptions)).toEqual({ caught: 2, baitUsed: 2, attempts: 1, ticks: 3 });
    expect(actions).toBe(1);
});

test('karambwan vessel transitions distinguish a missed roll from a catch', () => {
    const before = fishState('karambwan', [item(3157), item(3150, 1, 1)]);
    const loaded = fishState('karambwan', [item(3159)]);
    expect(karambwanLoadEffect(before, loaded)).toBe(true);
    expect(karambwanAttemptEffect(loaded, fishState('karambwan', [item(3157)]))).toBe(0);
    expect(karambwanAttemptEffect(loaded, fishState('karambwan', [item(3157), item(3142, 1, 1)], 105))).toBe(1);
    expect(() => karambwanAttemptEffect(loaded, fishState('karambwan', [item(3157), item(3142, 1, 1)]))).toThrow('reconcile');
});

test('karambwan finite job reloads each consumed single bait and limits missed attempts', async () => {
    let current = fishState('karambwan', [item(3157), item(3150, 1, 1)]);
    let tick = 0;
    const d: FishDriver = {
        state: () => current,
        tick: () => tick,
        stopped: () => false,
        interact: async () => {
            current = fishState('karambwan', [item(3157), item(3142, 1, 1)], 105);
            return { success: true };
        },
        combine: async () => {
            current = fishState('karambwan', [item(3159)]);
            return { success: true };
        },
        step: async () => {
            tick++;
        },
        wait: async testFn => {
            tick++;
            return testFn();
        },
    };
    expect(await runStagedFishing(d, { ...fishOptions, method: 'karambwan', amount: 1 })).toEqual({ caught: 1, baitUsed: 1, attempts: 1, ticks: 2 });
});

test('stops, missing bait and no progress do not run forever', async () => {
    let current = fishState('fly', [item(309), item(314, 1, 1)]);
    let tick = 0;
    let actions = 0;
    const d: FishDriver = {
        state: () => current,
        tick: () => tick,
        stopped: () => true,
        interact: async () => {
            actions++;
            return { success: true };
        },
        combine: async () => ({ success: true }),
        step: async () => {
            tick++;
        },
        wait: async () => {
            tick += 10;
            return false;
        },
    };
    await expect(runStagedFishing(d, fishOptions)).rejects.toThrow('stopped');
    expect(actions).toBe(0);
    current = fishState('fly', [item(309)]);
    await expect(runStagedFishing({ ...d, stopped: () => false }, fishOptions)).rejects.toThrow('bait');
    current = fishState('fly', [item(309), item(314, 1, 1)]);
    await expect(runStagedFishing({ ...d, stopped: () => false }, fishOptions)).rejects.toThrow('no progress');
});

test('native search rejects unwalkable shore and stop without sending an NPC action', async () => {
    let paths = 0;
    const s: any = {
        sdk: {
            getState: () => ({ player: { worldX: 2839, worldZ: 3432, level: 0 }, nearbyNpcs: [] }),
            findPath: () => {
                paths++;
                return { success: false, reachedDestination: false };
            },
        },
    };
    expect(await searchNativeCatherbyFishing(s, 'cage', 0, () => false)).toBe(false);
    expect(paths).toBe(9);
    paths = 0;
    expect(await searchNativeCatherbyFishing(s, 'cage', 0, () => true)).toBe(false);
    expect(paths).toBe(0);
    expect(await searchNativeCatherbyFishing(s, 'cage', 3, () => false)).toBe(false);
});

test('original eight native profiles remain exact; BigNet and lava resolve only their actual NPC categories/names', () => {
    const old = Object.fromEntries(Object.entries(FISH_PROFILES).slice(0, 8));
    expect(createHash('sha256').update(JSON.stringify(old)).digest('hex')).toBe('a0a851241eedc584d99cf5aba276dd8f3f7f83fd62ff489385085b75b3c93aab');
    for (const m of Object.keys(old)) expect(fishingByproducts(m as keyof typeof FISH_PROFILES)).toEqual([]);
    expect(fishSpotIds('lava')).toEqual([800]);
    expect(fishSpotIds('bigNet')).toContain(322);
    expect(fishSpotIds('bigNet')).not.toContain(320);
    expect(fishingOutputs('bigNet')).toEqual([353, 341, 363, 1061, 401, 1059, 407, 405]);
    expect(Object.values(fishingCapacityOutputs('bigNet')).reduce((a, b) => a + b, 0)).toBe(9);
});

const bigNetReceipt = (b: Parameters<typeof nativeBigNetReceipt>[0], a: Parameters<typeof nativeBigNetReceipt>[1], raw = 0, xp = b.xp, rolls = 1) =>
    nativeBigNetReceipt(b, a, raw, xp, rolls, 1);
const netState = (inventory: ReturnType<typeof item>[], xp = 0) =>
    ({
        ...fishState('fly', inventory, xp),
        skills: [{ name: 'Fishing', level: 99, baseLevel: 99, experience: xp }, { name: 'Hitpoints', level: 10, baseLevel: 10, experience: 1000 }],
        nearbyNpcs: [{ index: 7, id: 322, x: 2846, z: 3429, distance: 1, reachable: true, optionsWithIndex: [{ text: 'Net', opIndex: 1 }] }],
    }) as unknown as BotWorldState;

test('BigNet fractional seaweed XP keeps a shared public-floor phase; exact known raw costs reject unknown items, debits and excess growth', () => {
    const b = bigNetSnapshot(netState([item(305)]));
    const first = bigNetSnapshot(netState([item(305), item(401, 1, 1)]));
    expect(bigNetReceipt(b, first)).toMatchObject({ kind: 'made', primary: 0, rawXp: 1, byproducts: { 401: 1 } });
    const next = bigNetSnapshot(netState([item(305), item(401, 2, 1)], 1));
    expect(bigNetReceipt(first, next, 1, 0)).toMatchObject({ kind: 'made', primary: 0, rawXp: 1 });
    expect(bigNetReceipt(first, { ...next, xp: 2 }, 1, 0).kind).toBe('pending');
    expect(bigNetReceipt(b, bigNetSnapshot(netState([item(305), item(995, 1, 1)]))).kind).toBe('invalid');
    expect(bigNetReceipt(b, bigNetSnapshot(netState([item(353, 1, 1)], 20))).kind).toBe('invalid');
    expect(bigNetReceipt(b, bigNetSnapshot(netState([item(305), item(353, 3, 1)], 60))).kind).toBe('invalid');
});

test('BigNet counts only primary fish, preserves every Native byproduct and does not reclick for junk-only rolls', async () => {
    let tick = 0;
    let actions = 0;
    let roll = 0;
    let current = netState([item(305)]);
    const batches = [
        netState([item(305), item(401, 1, 1)], 0),
        netState([item(305), item(401, 1, 1), item(407, 1, 2)], 10),
        netState([item(305), item(401, 1, 1), item(407, 1, 2), item(353, 2, 3), item(341, 1, 4), item(363, 1, 5)], 195),
    ];
    const d: FishDriver = {
        state: () => current,
        tick: () => tick,
        stopped: () => false,
        interact: async (i, op) => {
            expect(i).toBe(7);
            expect(op).toBe(1);
            actions++;
            return { success: true };
        },
        combine: async () => ({ success: true }),
        step: async () => {
            tick++;
        },
        wait: async testFn => {
            tick++;
            current = batches[roll++]!;
            return testFn();
        },
    };
    const r = await runStagedFishing(d, { method: 'bigNet', xpRate: 1, amount: 1, cap: 100, maxAttempts: 5, progressTicks: 40 });
    expect(r.caught).toBe(4);
    expect(r.byproducts).toEqual({ 401: 1, 407: 1 });
    expect(r.rawXp).toBe(1951);
    expect(r.publicXpDelta).toBe(195);
    expect(actions).toBe(1);
    expect(roll).toBe(3);
});

test('BigNet reserves nine free slots and junk-only catches cannot postpone the primary no-progress deadline', async () => {
    let actions = 0;
    let tick = 0;
    let junk = 0;
    let current = netState([item(305), ...Array.from({ length: 19 }, (_, i) => item(9000 + i, 1, i + 1))]);
    const d: FishDriver = {
        state: () => current,
        tick: () => tick,
        stopped: () => false,
        interact: async () => {
            actions++;
            return { success: true };
        },
        combine: async () => ({ success: true }),
        step: async () => {
            tick++;
        },
        wait: async testFn => {
            tick++;
            current = netState([item(305), item(401, ++junk, 1)], 0);
            return testFn();
        },
    };
    await expect(runStagedFishing(d, { method: 'bigNet', xpRate: 1, amount: 1, cap: 100, maxAttempts: 5, progressTicks: 4 })).rejects.toThrow('free space');
    expect(actions).toBe(0);
    current = netState([item(305)]);
    await expect(runStagedFishing(d, { method: 'bigNet', xpRate: 1, amount: 1, cap: 100, maxAttempts: 5, progressTicks: 4 })).rejects.toThrow('no progress');
    expect(actions).toBe(1);
});

test('BigNet unknown XP cannot authorize another input or a primary credit', async () => {
    let tick = 0;
    let actions = 0;
    let current = netState([item(305)]);
    const d: FishDriver = {
        state: () => current,
        tick: () => tick,
        stopped: () => false,
        interact: async () => {
            actions++;
            return { success: true };
        },
        combine: async () => ({ success: true }),
        step: async () => {
            tick++;
        },
        wait: async testFn => {
            tick++;
            current = netState([item(305), item(353, 1, 1)], 999);
            return testFn();
        },
    };
    await expect(runStagedFishing(d, { method: 'bigNet', xpRate: 1, amount: 1, cap: 100, maxAttempts: 5, progressTicks: 40 })).rejects.toThrow('XP receipt');
    expect(actions).toBe(1);
});

test('Lava uses exact oily rod/native 800/Bait 1 and reconciles one bait per 60 XP eel', async () => {
    for (const badXp of [false, true]) {
        let tick = 0;
        let actions = 0;
        let current = {
            ...netState([item(1585), item(313, 3, 1)]),
            nearbyNpcs: [{ index: 8, id: 800, x: 2890, z: 9766, distance: 1, optionsWithIndex: [{ text: 'Bait', opIndex: 1 }] }],
        } as unknown as BotWorldState;
        const d: FishDriver = {
            state: () => current,
            tick: () => tick,
            stopped: () => false,
            interact: async (i, op) => {
                expect(i).toBe(8);
                expect(op).toBe(1);
                actions++;
                return { success: true };
            },
            combine: async () => ({ success: true }),
            step: async () => {
                tick++;
            },
            wait: async testFn => {
                tick++;
                current = {
                    ...current,
                    inventory: [item(1585), item(313, 2, 1), item(2148, 1, 2)],
                    skills: [{ name: 'Fishing', level: 99, baseLevel: 99, experience: badXp ? 59 : 60 }, { name: 'Hitpoints', level: 10, baseLevel: 10, experience: 1000 }],
                } as unknown as BotWorldState;
                return testFn();
            },
        };
        const run = runStagedFishing(d, { method: 'lava', xpRate: 1, amount: 1, cap: 100, maxAttempts: 5, progressTicks: 40 });
        if (badXp) await expect(run).rejects.toThrow('lava eel native XP');
        else expect(await run).toMatchObject({ caught: 1, baitUsed: 1 });
        expect(actions).toBe(1);
    }
});

test('BigNet keeps scalar XP and progress baselines when the SDK mutates one live snapshot', async () => {
    let tick = 0;
    let actions = 0;
    let catches = 0;
    const current = netState([item(305)]);
    const d: FishDriver = {
        state: () => current,
        tick: () => tick,
        stopped: () => false,
        interact: async () => {
            actions++;
            return { success: true };
        },
        combine: async () => ({ success: true }),
        step: async () => {
            tick++;
        },
        wait: async testFn => {
            tick += 2;
            catches++;
            current.inventory = [item(305), item(353, catches, 1)];
            current.skills[0]!.experience = catches * 20;
            return testFn();
        },
    };
    const r = await runStagedFishing(d, { method: 'bigNet', xpRate: 1, amount: 2, cap: 20, maxAttempts: 3, progressTicks: 4 });
    expect(r.caught).toBe(2);
    expect(r.rawXp).toBe(400);
    expect(actions).toBe(1);
});

test('new fishing methods honor declared native 1/25 XP rates and park wrong-rate effects without another paid input', async () => {
    for (const method of ['bigNet', 'lava'] as const) {
        for (const rate of [1, 25]) {
            for (const wrong of [false, true]) {
                let tick = 0;
                let actions = 0;
                const tool = method === 'lava' ? 1585 : 305;
                let current = netState([item(tool), ...(method === 'lava' ? [item(313, 3, 1)] : [])]);
                if (method === 'lava') current.nearbyNpcs = [{ index: 8, id: 800, x: 2890, z: 9766, distance: 1, optionsWithIndex: [{ text: 'Bait', opIndex: 1 }] }] as any;
                const d: FishDriver = {
                    state: () => current,
                    tick: () => tick,
                    stopped: () => false,
                    interact: async () => {
                        actions++;
                        return { success: true };
                    },
                    combine: async () => ({ success: true }),
                    step: async () => {
                        tick++;
                    },
                    wait: async testFn => {
                        tick++;
                        current = {
                            ...current,
                            inventory: [item(tool), ...(method === 'lava' ? [item(313, 2, 1), item(2148, 1, 2)] : [item(353, 1, 1)])],
                            skills: [{ name: 'Fishing', level: 99, baseLevel: 99, experience: (method === 'lava' ? 60 : 20) * rate }, { name: 'Hitpoints', level: 10, baseLevel: 10, experience: 1000 }],
                        } as BotWorldState;
                        return testFn();
                    },
                };
                const p = runStagedFishing(d, { method, xpRate: wrong ? (rate === 1 ? 25 : 1) : rate, amount: 1, cap: 30, maxAttempts: 3, progressTicks: 20 });
                if (wrong) await expect(p).rejects.toThrow();
                else expect((await p).caught).toBe(1);
                expect(actions).toBe(1);
            }
        }
    }
});

test('Lava catch after a spot change during step credits the final bait before another dispatch', async () => {
    for (const mode of ['ok', 'free-fish', 'wrong-xp', 'extra-fish']) {
        let tick = 0;
        let actions = 0;
        let current = netState([item(1585), item(313, 1, 1)]);
        current.nearbyNpcs = [{ index: 8, id: 800, x: 2890, z: 9766, distance: 1, optionsWithIndex: [{ text: 'Bait', opIndex: 1 }] }] as any;
        const d: FishDriver = {
            state: () => current,
            tick: () => tick,
            stopped: () => false,
            interact: async () => {
                actions++;
                return { success: true };
            },
            combine: async () => ({ success: true }),
            wait: async testFn => {
                tick++;
                current = { ...current, nearbyNpcs: [] };
                return testFn();
            },
            step: async () => {
                tick++;
                current = {
                    ...current,
                    inventory: [item(1585), item(2148, mode === 'extra-fish' ? 2 : 1, 1), ...(mode === 'free-fish' ? [item(313, 1, 2)] : [])],
                    skills: [{ name: 'Fishing', level: 99, baseLevel: 99, experience: mode === 'wrong-xp' ? 59 : 60 }, { name: 'Hitpoints', level: 10, baseLevel: 10, experience: 1000 }],
                } as any;
            },
        };
        const run = runStagedFishing(d, { method: 'lava', xpRate: 1, amount: 1, cap: 30, maxAttempts: 3, progressTicks: 20 });
        if (mode === 'ok') expect(await run).toMatchObject({ caught: 1, baitUsed: 1 });
        else await expect(run).rejects.toThrow('step catch/bait/XP');
        expect(actions).toBe(1);
    }
});

for (const method of ['net', 'seaBait', 'fly', 'riverBait', 'cage', 'harpoon', 'karambwanji'] as const) {
    test(`${method} credits a catch received in the inter-iteration tick before the next input`, async () => {
        const p = FISH_PROFILES[method];
        let tick = 0;
        let actions = 0;
        let current = netState([item(p.tool), ...(p.bait ? [item(p.bait, 1, 1)] : [])]);
        current.nearbyNpcs = [{ index: 8, id: fishSpotIds(method)[0]!, x: 2890, z: 9766, distance: 1, optionsWithIndex: [{ text: p.label, opIndex: p.op }] }] as any;
        const d: FishDriver = {
            state: () => current,
            tick: () => tick,
            stopped: () => false,
            interact: async () => {
                actions++;
                return { success: true };
            },
            combine: async () => ({ success: true }),
            step: async () => {
                tick++;
            },
            wait: async testFn => {
                tick++;
                current = { ...current, nearbyNpcs: [] };
                return testFn();
            },
        };
        // Wrap step to credit catch right after wait clears nearbyNpcs
        d.step = async () => {
            tick++;
            current = {
                ...current,
                inventory: [item(p.tool), item(p.products[0], 1, 1)],
                skills: [{ name: 'Fishing', level: 99, baseLevel: 99, experience: 60 }, { name: 'Hitpoints', level: 10, baseLevel: 10, experience: 1000 }],
            } as any;
        };
        expect(await runStagedFishing(d, { method, xpRate: 1, amount: 1, cap: 30, maxAttempts: 3, progressTicks: 20 })).toMatchObject({
            caught: 1,
            baitUsed: p.bait ? 1 : 0,
        });
        expect(actions).toBe(1);
    });
}

test('knife reset family of each method matches its server attempt label', () => {
    const dir = resolve(import.meta.dir, '../../../vendor/rs-sdk/server/content/scripts/skill_fishing/scripts/fishing_spots');
    const labels: Record<FishMethod, [string, string]> = {
        net: ['saltfish', 'attempt_fish_shrimp'],
        seaBait: ['saltfish', 'attempt_fish_sardine'],
        fly: ['freshfish', 'attempt_fish_trout_salmon'],
        riverBait: ['freshfish', 'attempt_fish_pike'],
        cage: ['rarefish', 'attempt_fish_lobster'],
        harpoon: ['rarefish', 'attempt_fish_swordfish'],
        karambwanji: ['tbwt', 'attempt_fish_karambwanji'],
        karambwan: ['tbwt', 'attempt_fish_karambwan'],
        bigNet: ['memberfish', 'attempt_fish_mackerel'],
        lava: ['lavafish', 'attempt_fish_lava_eel'],
    };
    expect(Object.keys(labels).sort()).toEqual(Object.keys(FISH_PROFILES).sort());
    for (const [method, [file, name]] of Object.entries(labels)) {
        const text = readFileSync(resolve(dir, `${file}.rs2`), 'utf8').replace(/\r/g, '');
        const at = text.indexOf(`[label,${name}]`);
        const end = text.indexOf('\n[', at + 1);
        expect(at).toBeGreaterThanOrEqual(0);
        const body = text.slice(at, end < 0 ? undefined : end);
        const family = !/%action_delay/.test(body)
            ? null
            : /map_clock \+ 2\)/.test(body) || /\}\s*else\s*\{\s*p_opnpc/.test(body)
              ? 'same'
              : /%action_delay = map_clock\)/.test(body)
                ? 'delayed'
                : 'none';
        expect([method, family]).toEqual([method, FISH_KNIFE_RESET[method as FishMethod]]);
    }
});

test('knife cut sets the delay two ticks ahead only when it is past, and needs a knife and a log', () => {
    expect(knifeDelay(5, 10)).toBe(12);
    expect(knifeDelay(10, 10)).toBe(10);
    expect(knifeDelay(13, 10)).toBe(13);
    expect(knifeCut([item(KNIFE, 1, 4), item(NORMAL_LOGS, 1, 7)], 99)).toEqual([
        { type: 'useItemOnItem', sourceSlot: 4, targetSlot: 7 },
        { type: 'clickComponent', componentId: 99 },
    ]);
    expect(knifeCut([item(KNIFE, 1, 4)], 99)).toBeUndefined();
});

function knifeServer(method: FishMethod, spotPos: { x: number; z: number }, player: { x: number; z: number }) {
    const p = FISH_PROFILES[method];
    const reset = FISH_KNIFE_RESET[method];
    const w = {
        tick: 0,
        delay: -10,
        rollAt: -1,
        xp: 0,
        inv: [item(p.tool, 1, 0), item(KNIFE, 1, 1), item(NORMAL_LOGS, 1, 2), ...(p.bait ? [item(p.bait, 20, 3)] : [])],
        player: { ...player },
        sent: [] as { tick: number; types: string[] }[],
        stands: 0,
    };
    const st = () =>
        ({
            player: { worldX: w.player.x, worldZ: w.player.z, level: 0, lifeId: 1 },
            inventory: w.inv.map(i => ({ ...i })),
            dialog: { isOpen: false },
            skills: [{ name: 'Fishing', level: 99, baseLevel: 99, experience: w.xp }, { name: 'Hitpoints', level: 10, baseLevel: 10, experience: 1000 }],
            nearbyNpcs: [{ index: 8, id: fishSpotIds(method)[0]!, x: spotPos.x, z: spotPos.z, distance: 1, reachable: true, optionsWithIndex: [{ text: p.label, opIndex: p.op }] }],
        }) as unknown as BotWorldState;
    const free = () => [...Array(28).keys()].find(s => !w.inv.some(i => i.slot === s))!;
    const d: FishDriver = {
        state: st,
        tick: () => w.tick,
        stopped: () => false,
        interact: async () => {
            throw Error('knife mode clicks through send');
        },
        combine: async () => ({ success: true }),
        wait: async () => false,
        step: async () => {
            w.tick++;
            if (w.rollAt === w.tick) {
                w.xp += 50;
                w.inv.push(item(p.products[0]!, 1, free()));
                if (p.bait) w.inv.find(i => i.id === p.bait)!.count--;
            }
        },
        send: async (acts: FishAction[]) => {
            w.sent.push({ tick: w.tick, types: acts.map(a => a.type) });
            for (const a of acts) {
                if (a.type === 'dropItem') w.inv = w.inv.filter(i => i.slot !== a.slot);
                if (a.type === 'clickComponent') w.delay = knifeDelay(w.delay, w.tick);
                if (a.type === 'interactNpc') {
                    if (reset === 'same' && w.delay >= w.tick) w.rollAt = w.delay;
                    if (reset === 'delayed' && w.delay === w.tick) w.rollAt = w.tick + 1;
                }
            }
        },
        stand: async () => {
            w.stands++;
            w.tick += 2;
            w.player = { x: spotPos.x + 1, z: spotPos.z };
            return true;
        },
    };
    return { w, d };
}

test('fly knife reset: drop, knife, Make 1, Lure and a close in one tick, a close in the next, one roll each 3 ticks', async () => {
    const { w, d } = knifeServer('fly', { x: 3238, z: 3252 }, { x: 3239, z: 3252 });
    const r = await runStagedFishing(d, { method: 'fly', amount: 4, cap: 100, maxAttempts: 5, progressTicks: 40, knife: { make1: 99, drop: true } });
    expect(r).toMatchObject({ caught: 4, baitUsed: 4, attempts: 4, knife: { reset: 'same', dropped: 3, stands: 0 } });
    expect(w.sent.map(s => s.tick)).toEqual([0, 1, 3, 4, 6, 7, 9, 10]);
    expect(w.sent[0]!.types).toEqual(['useItemOnItem', 'clickComponent', 'interactNpc', 'closeModal']);
    expect(w.sent[1]!.types).toEqual(['closeModal']);
    expect(w.sent[2]!.types).toEqual(['dropItem', 'useItemOnItem', 'clickComponent', 'interactNpc', 'closeModal']);
    expect(w.inv.filter(i => i.id === NORMAL_LOGS).length).toBe(1);
});

test('cage knife reset: knife in T, close in T+1, click in T+2; a corner start stands beside the spot first', async () => {
    const { w, d } = knifeServer('cage', { x: 2924, z: 3180 }, { x: 2925, z: 3181 });
    const r = await runStagedFishing(d, { method: 'cage', amount: 3, cap: 100, maxAttempts: 5, progressTicks: 40, knife: { make1: 99 } });
    expect(r).toMatchObject({ caught: 3, attempts: 3, knife: { reset: 'delayed', dropped: 0, stands: 1 } });
    expect(w.sent.slice(0, 3)).toEqual([{ tick: 2, types: ['useItemOnItem', 'clickComponent'] }, { tick: 3, types: ['closeModal'] }, { tick: 4, types: ['interactNpc'] }]);
    expect(w.sent[3]!.tick).toBe(5);
});

test('knife reset refuses karambwan, a missing log and a driver without send', async () => {
    const base = { amount: 1, cap: 100, maxAttempts: 5, progressTicks: 40, knife: { make1: 99 } };
    const { w, d } = knifeServer('fly', { x: 3238, z: 3252 }, { x: 3239, z: 3252 });
    await expect(runStagedFishing({ ...d, send: undefined }, { ...base, method: 'fly' })).rejects.toThrow('send and stand');
    w.inv = w.inv.filter(i => i.id !== NORMAL_LOGS);
    await expect(runStagedFishing(d, { ...base, method: 'fly' })).rejects.toThrow('knife and logs');
    const k = knifeServer('karambwan', { x: 2899, z: 3118 }, { x: 2900, z: 3118 });
    k.w.inv.push(item(3159, 1, 9));
    await expect(runStagedFishing(k.d, { ...base, method: 'karambwan' })).rejects.toThrow('no knife reset');
});

test('bestFishingMethod selects highest unlocked owned method and resolves shop sources cleanly', () => {
    const cageHarpoon = [{ id: 301, count: 1 }, { id: 311, count: 1 }, { id: 303, count: 1 }, { id: 309, count: 1 }, { id: 314, count: 50 }];
    expect(bestFishingMethod(20, cageHarpoon, { members: false })?.method).toBe('fly');
    expect(bestFishingMethod(35, cageHarpoon, { members: false })?.method).toBe('harpoon');
    expect(bestFishingMethod(40, cageHarpoon, { members: false })?.method).toBe('cage');
    expect(bestFishingMethod(40, [], { members: false, requireTool: false })).toMatchObject({ method: 'cage', toolId: 301, shop: 'fishingshop2', hasTool: false });
    expect(fishingMethodRequirements('harpoon').shop).toBe('fishingshop2');
});

// --- Village fishing (formerly microbot-village-fishing.test.ts) ---
const villageOrder: VillageOrder = { method: 'fly', mode: 'BANK_RAW', target: 1, batch: 1, reserve: 1, cap: 1000, returnTicks: 200, xpRate: 1 };

function villageActor() {
    let tick = 0;
    let sends = 0;
    const subscribers = new Set<() => void>();
    const vItem = (id: number, count = 1, slot = 0) => ({ id, count, slot, optionsWithIndex: [{ text: 'Drop', opIndex: 5 }] });
    const s: any = {
        name: 'vfunit',
        client: { executeBotAction: () => {} },
        ended: new Promise(() => {}),
        tick: () => tick,
        onTick: (fn: () => void) => {
            subscribers.add(fn);
            return () => subscribers.delete(fn);
        },
    };
    let state: any = {
        player: { lifeId: 1, respawnCount: 0, level: 0, worldX: 3107, worldZ: 3430 },
        equipment: [],
        inventory: [vItem(309), vItem(314, 3, 1)],
        nearbyNpcs: [{ index: 3, id: 328, x: 3107, z: 3431, distance: 1, optionsWithIndex: [{ text: 'Lure', opIndex: 1 }, { text: 'Bait', opIndex: 3 }] }],
        nearbyLocs: [{ id: 2728, x: 3160, z: 3427, distance: 1, reachable: true }],
        skills: [{ name: 'Fishing', level: 99, experience: 0 }, { name: 'Cooking', level: 99, experience: 0 }, { name: 'Hitpoints', level: 99, experience: 0 }],
    };
    const count = (id: number) => state.inventory.filter((i: any) => i.id === id).reduce((a: number, i: any) => a + i.count, 0);
    const change = (id: number, n: number) => {
        const existing = state.inventory.find((i: any) => i.id === id);
        if (existing) {
            existing.count += n;
            if (!existing.count) state.inventory = state.inventory.filter((i: any) => i !== existing);
        } else {
            state.inventory.push(vItem(id, n, state.inventory.length));
        }
    };
    s.sdk = {
        getState: () => state,
        getInventory: () => state.inventory,
        getSkill: (name: string) => state.skills.find((v: any) => v.name === name),
        getSkillXp: (name: string) => state.skills.find((v: any) => v.name === name)?.experience,
        sendInteractNpc: async () => {
            sends++;
            const raw = count(309) ? 335 : 349;
            const bait = count(309) ? 314 : 313;
            state = { ...state, inventory: state.inventory.map((i: any) => ({ ...i })), skills: state.skills.map((i: any) => ({ ...i })) };
            change(bait, -1);
            change(raw, 1);
            state.skills[0].experience += raw === 335 ? 50 : 60;
            return { success: true };
        },
        sendWalk: async () => ({ success: true }),
        sendCloseModal: async () => ({ success: true }),
        sendUseItemOnLoc: async (slot: number) => {
            sends++;
            const raw = state.inventory.find((i: any) => i.slot === slot).id;
            change(raw, -1);
            change(raw === 335 ? 333 : 351, 1);
            state.skills[1].experience += raw === 335 ? 70 : 80;
            return { success: true };
        },
    };
    s.direct = async (a: any) => {
        sends++;
        const row = state.inventory.find((i: any) => i.slot === a.slot);
        change(row.id, -row.count);
        return { success: true };
    };
    return {
        s,
        get state() {
            return state;
        },
        setMethod(method: string) {
            if (method === 'riverBait') state.inventory = [vItem(307), vItem(313, 3, 1)];
        },
        count,
        sends: () => sends,
        run: async (fn: () => Promise<any>) => {
            const timer = setInterval(() => {
                tick++;
                for (const f of [...subscribers]) f();
            }, 1);
            try {
                return await fn();
            } finally {
                clearInterval(timer);
            }
        },
    };
}

test('village donor four modes and native raw/cooked variants retain a real range, not modern 43475', () => {
    for (const mode of ['BANK_RAW', 'DROP_RAW', 'COOK_AND_BANK', 'COOK_AND_DROP'] as const) {
        const p = villagePolicy({ ...villageOrder, mode });
        expect(p.cook).toBe(mode.startsWith('COOK'));
        expect(p.drop).toBe(mode.includes('DROP'));
        expect(p.outputs).toContain(343);
    }
    expect(villagePolicy({ ...villageOrder, method: 'riverBait' }).recipes.map(r => r.products)).toEqual([[351]]);
    expect(readFileSync(resolve(import.meta.dir, '../../../vendor/rs-sdk/server/content/maps/m49_53.jm2'), 'utf8')).toContain('0 24 35: 2728');
    expect(() => villagePolicy({ ...villageOrder, batch: 25 })).toThrow();
    expect(() => villagePolicy({ ...villageOrder, xpRate: 0 })).toThrow();
});

test('each mode composes real staged catch/cook/drop with the bank profile and protects unrelated carried stock', async () => {
    for (const method of ['fly', 'riverBait'] as const) {
        for (const mode of ['BANK_RAW', 'DROP_RAW', 'COOK_AND_BANK', 'COOK_AND_DROP'] as const) {
            const a = villageActor();
            a.setMethod(method);
            const r: Awaited<ReturnType<typeof runVillageFishing>> = await a.run(() =>
                runVillageFishing(a.s, { ...villageOrder, method, mode }, () => false, {
                    walk: async (_s, to) => {
                        a.state.player.worldX = to.x;
                        a.state.player.worldZ = to.z;
                    },
                    bank: async (_s, j, p, stop) => {
                        expect(j.family).toBe('village-fishing');
                        await p.prepare?.(stop!);
                        const done = await p.run(1, 100, stop!);
                        return { ok: true, completed: done ?? 1, trips: 1, banked: {}, atBank: true, failure: '-', family: j.family, recipe: j.recipe, recoveryDeferred: false, ticks: 1 };
                    },
                }),
            );
            expect(r.receipts[0]!.caught[method === 'fly' ? 335 : 349]).toBe(1);
            expect(r.receipts[0]!.burnt).toBe(0);
            expect(Object.values(r.receipts[0]!.dropped as Record<string, number>).reduce((x, y) => x + y, 0)).toBe(mode.includes('DROP') ? 1 : 0);
            expect(a.count(method === 'fly' ? 314 : 313)).toBe(2);
        }
    }
});

test('a foreign executor during cooking travel forbids the subsequent actual paid cooking dispatch', async () => {
    const a = villageActor();
    await expect(
        a.run(() =>
            runVillageFishing(a.s, { ...villageOrder, mode: 'COOK_AND_BANK' }, () => false, {
                walk: async () => {
                    a.s.client.executeBotAction = () => {};
                },
                bank: async (_s, _j, p, stop) => {
                    await p.prepare?.(stop!);
                    await p.run(1, 100, stop!);
                    throw Error('unreachable');
                },
            }),
        ),
    ).rejects.toThrow('owner changed');
    expect(a.sends()).toBe(1);
    expect(a.count(335)).toBe(1);
    expect(a.count(333)).toBe(0);
});

test('whole-pack drop receipts refuse unrelated debits and pre-input stop makes no action', async () => {
    expect(villagePackEffect({ 335: 1, 995: 37 }, { 995: 36 }, { 335: -1 })).toBe(false);
    const a = villageActor();
    await expect(dropVillageOutput(a.s, [335], 28, () => true)).rejects.toThrow('stopped');
    expect(a.sends()).toBe(0);
});

test('actual cooked consumer enters the Native north range face instead of the reachable-false south wall', async () => {
    const a = villageActor();
    a.state.nearbyLocs[0].reachable = false;
    let moves = 0;
    let heated = 0;
    const use = a.s.sdk.sendUseItemOnLoc;
    a.s.sdk.sendUseItemOnLoc = async (slot: number) => {
        heated++;
        expect(a.state.player.worldX).toBe(3160);
        expect(a.state.player.worldZ).toBe(3428);
        return use(slot);
    };
    const r = await a.run(() =>
        runVillageFishing(a.s, { ...villageOrder, mode: 'COOK_AND_DROP' }, () => false, {
            walk: async (_s, to) => {
                moves++;
                expect(to).toEqual({ x: 3160, z: 3428 });
                a.state.player.worldX = to.x;
                a.state.player.worldZ = to.z;
                a.state.nearbyLocs[0].reachable = true;
            },
            bank: async (_s, j, p, stop) => {
                await p.prepare?.(stop!);
                const completed = await p.run(1, 100, stop!);
                return { ok: true, completed: completed ?? 0, trips: 1, banked: {}, atBank: true, failure: '-', family: j.family, recipe: j.recipe, recoveryDeferred: false, ticks: 1 };
            },
        }),
    );
    expect(r.ok).toBe(true);
    expect(moves).toBe(1);
    expect(heated).toBe(1);
    expect(a.count(333)).toBe(0);
    expect(r.receipts[0]!.dropped[333]).toBe(1);
});

test('south-wall cooking arrival cannot authorize a heat input despite being within old tolerance', async () => {
    const a = villageActor();
    await expect(
        a.run(() =>
            runVillageFishing(a.s, { ...villageOrder, mode: 'COOK_AND_BANK' }, () => false, {
                walk: async () => {
                    a.state.player.worldX = 3160;
                    a.state.player.worldZ = 3426;
                },
                bank: async (_s, _j, p, stop) => {
                    await p.prepare?.(stop!);
                    await p.run(1, 100, stop!);
                    throw Error('unreachable');
                },
            }),
        ),
    ).rejects.toThrow('cooking arrival unobserved');
    expect(a.count(335)).toBe(1);
    expect(a.count(333)).toBe(0);
    expect(a.sends()).toBe(1);
});

// --- Shark supply (formerly shark-supply.test.ts) ---
test('a finite order key is claimed once; duplicate and uncertain output refuse any unchanged retry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shark-order-'));
    try {
        const order = { target: 25, maxTicks: 9000, consumer: 'staging' };
        const result = { ok: true, banked: 25, caught: 26, cooked: 25, burnt: 1, failure: '' };
        const path = claimSharkOrder(dir, 'Mightyrod', 'pilot-25', order, 1);
        expect(() => claimSharkOrder(dir, 'mightyrod', 'pilot-25', order, 2)).toThrow('uncertain output (started)');
        settleSharkOrder(path, result, 3);
        expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ state: 'completed', result: { banked: 25 } });
        expect(() => claimSharkOrder(dir, 'Mightyrod', 'pilot-25', order, 4)).toThrow('already completed; duplicate refused');
        const failed = claimSharkOrder(dir, 'Mightyrod', 'batch-100', { ...order, target: 100 }, 5);
        settleSharkOrder(failed, { ...result, ok: false, banked: 7, failure: 'stop' }, 6);
        expect(() => claimSharkOrder(dir, 'Mightyrod', 'batch-100', order, 7)).toThrow('uncertain output (failed)');
        writeFileSync(join(dir, 'mightyrod', 'broken.json'), '{');
        expect(() => claimSharkOrder(dir, 'Mightyrod', 'broken', order)).toThrow('uncertain output (unreadable)');
        for (const [a, k] of [['../x', 'k'], ['Rod', '../k'], ['Rod', '']]) expect(() => claimSharkOrder(dir, a!, k!, order)).toThrow('identity');
        const other = claimSharkOrder(dir, 'Rod', 'pilot-25', order);
        writeFileSync(other, JSON.stringify({ state: 'started', pid: -1 }));
        expect(() => settleSharkOrder(other, result)).toThrow('ownership');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

const sharkSpotFixture = { id: 322, index: 5, name: 'Fishing spot', x: 2845, z: 3431, distance: 3, optionsWithIndex: [{ text: 'Net', opIndex: 1 }, { text: 'Harpoon', opIndex: 3 }] };

test('normal controller MAX_COOKED/CAP assignments and flat acceptance counters reach the consumer', () => {
    expect(sharkOrderConfig([], { MAX_COOKED: '100', CAP: '12000' })).toMatchObject({ target: 100, maxTicks: 12000 });
    expect(sharkOrderConfig(['25', '3000'], { MAX_COOKED: '100', CAP: '12000' })).toMatchObject({ target: 25, maxTicks: 3000 });
    expect(resultCounters(`ok ${sharkSummary({ banked: 100, caught: 102, cooked: 100, burnt: 2, coinsSpent: 5, ticks: 2500 })}`)).toMatchObject({
        newBankedSharks: 100,
        caught: 102,
        burnt: 2,
    });
});

test('sharks require the pinned memberfish identity and Net/op3, never rarefish', () => {
    expect(sharkSpot(sharkSpotFixture)).toBe(true);
    expect(sharkSpot({ ...sharkSpotFixture, id: 324 })).toBe(false);
    expect(sharkSpot({ ...sharkSpotFixture, optionsWithIndex: [{ text: 'Cage', opIndex: 1 }, { text: 'Harpoon', opIndex: 3 }] })).toBe(false);
    expect(sharkSpot({ ...sharkSpotFixture, optionsWithIndex: [{ text: 'Net', opIndex: 1 }, { text: 'Harpoon', opIndex: 2 }] })).toBe(false);
});

test('entry accepts dated ordinary west bank and Catherby only on ground floor', () => {
    expect(sharkEntry({ worldX: 2618, worldZ: 3332, level: 0 })).toBe('west-bank');
    expect(sharkEntry({ worldX: 2809, worldZ: 3441, level: 0 })).toBe('catherby');
    for (const p of [undefined, { worldX: 2618, worldZ: 3332, level: 1 }, { worldX: 3092, worldZ: 3243, level: 0 }]) expect(sharkEntry(p)).toBeNull();
});

test('tool funds retain 1000 and reject over 200, unknown cost, empty shop', () => {
    expect(harpoonPurchase(5, 2, 1200)).toBe(true);
    expect(harpoonPurchase(200, 1, 1200)).toBe(true);
    for (const [price, stock, cash] of [[201, 1, 5408], [5, 0, 1200], [5, 1, 1004], [NaN, 1, 1200], [-1, 1, 1200]]) {
        expect(harpoonPurchase(price!, stock!, cash!)).toBe(false);
    }
});

test('conservation independently accounts raw, cooked, burnt, food, paid tool and unrelated kit', () => {
    const a = sharkAssets([{ id: 995, count: 5408 }, { id: 329, count: 312 }, { id: 1275, count: 1 }, { id: 385, count: 7 }]);
    const b = sharkAssets([{ id: 995, count: 5403 }, { id: 329, count: 308 }, { id: 1275, count: 1 }, { id: 311, count: 1 }, { id: 385, count: 32 }, { id: 387, count: 3 }]);
    const r = { caught: 28, cooked: 25, burnt: 3, coinsSpent: 5, toolBought: 1, consumed: { 329: 4 } };
    expect(sharkAssetCheck(a, b, r)).toBe(true);
    expect(sharkAssetCheck(a, { ...b, 385: 7 }, r)).toBe(false);
    expect(sharkAssetCheck(a, { ...b, 1275: 0 }, r)).toBe(false);
    expect(sharkAssetCheck(a, b, { ...r, caught: 27 })).toBe(false);
});

test('cooking requires exact raw debit to cooked plus burnt, rejects unexplained loss', () => {
    expect(sharkCookDelta({ raw: 4, cooked: 3, burnt: 1 }, { raw: 0, cooked: 6, burnt: 2 })).toEqual({ raw: 4, cooked: 3, burnt: 1 });
    expect(() => sharkCookDelta({ raw: 4, cooked: 3, burnt: 1 }, { raw: 0, cooked: 5, burnt: 2 })).toThrow('reconcile');
});

function sharkFixture({ tool = true, full = false, wrong = false, moving = false, burn = false, hit = (_roll: number): boolean => true, refuse = false, animate = true } = {}) {
    let tick = 0;
    const clicks: number[] = [];
    let cookClicks = 0;
    let delay = -1;
    let fishing = -1;
    let pending = -1;
    let rolls = 0;
    let kills = 0;
    let observation = 0;
    let animAt = -99;
    const items: any[] = [
        ...(tool ? [{ id: 311, count: 1, slot: 0, name: 'Harpoon' }] : []),
        ...(full ? Array.from({ length: 27 }, (_, i) => ({ id: 436, count: 1, slot: i + 1, name: 'Copper ore' })) : []),
    ];
    const st: any = {
        inGame: true,
        player: { worldX: 2845, worldZ: 3431, level: 0 },
        equipment: [],
        gameMessages: [],
        nearbyNpcs: [{ ...sharkSpotFixture, id: wrong ? 324 : 322 }],
        nearbyLocs: [{ id: 1, name: 'Range', x: 2817, z: 3443 }],
    };
    const say = (text: string) => st.gameMessages.push({ type: 0, text, tick, observationId: ++observation, fromSelf: false, sender: '' });
    const roll = () => {
        animAt = tick;
        if (hit(rolls++)) {
            items.push({ id: 383, count: 1, slot: items.length, name: 'Raw shark' });
            say('You catch a shark!');
        }
    };
    const server = () => {
        if (pending >= 0) {
            if (delay === tick + 4) {
                say('You start Harpooning fish.');
                animAt = tick;
                fishing = pending;
            }
            pending = -1;
            return;
        }
        if (fishing < 0) return;
        if (!st.nearbyNpcs.some((n: any) => n.index === fishing && n.id === 322) || items.length >= 28) {
            fishing = -1;
            return;
        }
        if (delay < tick) delay = tick + 5;
        else if (delay === tick) roll();
    };
    const listeners = new Set<() => void>();
    const loop = setInterval(() => {
        tick++;
        server();
        if (animate) st.player.animId = tick - animAt < 3 ? 618 : -1;
        for (const f of [...listeners]) f();
    }, 1);
    const s = {
        name: 'test',
        sdk: {
            getState: () => st,
            getInventory: () => items,
            getSkill: () => ({ level: 99, baseLevel: 99 }),
            sendInteractNpc: async (index: number, op: number) => {
                clicks.push(op);
                if (moving && clicks.length === 1) {
                    st.nearbyNpcs = [{ ...sharkSpotFixture, index: 6, x: 2846 }];
                    return { success: true };
                }
                if (refuse || !st.nearbyNpcs.some((n: any) => n.index === index && n.id === 322)) return { success: true };
                const was = fishing;
                fishing = -1;
                pending = -1;
                if (delay < tick) {
                    delay = tick + 5;
                    pending = index;
                } else if (delay === tick + 4) {
                    say('You start Harpooning fish.');
                    animAt = tick;
                    fishing = index;
                } else {
                    if (delay === tick) roll();
                    if (was >= 0) kills++;
                }
                return { success: true };
            },
            sendUseItemOnLoc: async () => {
                cookClicks++;
                const raw = items.find(i => i.id === 383);
                if (raw) raw.id = burn ? 387 : 385;
                return { success: true };
            },
        },
        tick: () => tick,
        onTick: (f: () => void) => {
            listeners.add(f);
            return () => listeners.delete(f);
        },
        ended: new Promise(() => {}),
    } as unknown as Session;
    return {
        s,
        clicks,
        stop: () => clearInterval(loop),
        tick: () => tick,
        items: () => items,
        cookClicks: () => cookClicks,
        rolls: () => rolls,
        kills: () => kills,
        st,
        end: () => {
            fishing = -1;
        },
    };
}

async function captureFishing(run: (rows: any[]) => Promise<void>) {
    const rows: any[] = [];
    const original = console.log;
    const log = spyOn(console, 'log').mockImplementation((...args: any[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('SHARK_FISH_TRACE ')) rows.push(JSON.parse(args[0].slice('SHARK_FISH_TRACE '.length)));
        else original(...args);
    });
    try {
        await run(rows);
    } finally {
        log.mockRestore();
    }
}

test('moving spot is reacquired with op3 and only raw 383 counts', async () => {
    const f = sharkFixture({ moving: true });
    try {
        expect(await catchSharks(f.s, 2, () => false, 60)).toEqual({ caught: 2 });
        expect(f.clicks).toEqual([3, 3]);
    } finally {
        f.stop();
    }
});

test('a confirmed harpoon action is not re-clicked while it rolls without a catch', async () => {
    const f = sharkFixture({ hit: r => r >= 22 });
    try {
        expect(await catchSharks(f.s, 3, () => false)).toEqual({ caught: 3 });
        expect(f.clicks).toEqual([3]);
        expect(f.kills()).toBe(0);
    } finally {
        f.stop();
    }
});

test('active fishing without a catch fails unresolved progress at the pinned-odds bound without re-clicking', async () => {
    expect(SHARK_PROGRESS_TICKS).toBe(420);
    expect((215 / 256) ** Math.floor((SHARK_PROGRESS_TICKS - 12) / 6)).toBeLessThan(1e-5);
    const f = sharkFixture({ hit: () => false });
    try {
        await expect(catchSharks(f.s, 1, () => false)).rejects.toThrow('shark fishing no progress');
        expect(f.rolls()).toBeGreaterThanOrEqual(65);
        expect(f.clicks).toEqual([3]);
        expect(f.kills()).toBe(0);
    } finally {
        f.stop();
    }
}, 30000);

test('a server action that ends without a catch is re-dispatched after the animation stops', async () => {
    let ended = false;
    const f = sharkFixture({ hit: () => ended });
    try {
        await captureFishing(async rows => {
            const run = catchSharks(f.s, 1, () => false);
            await ticks.waitTicks(f.s, 30);
            f.end();
            ended = true;
            const at = f.tick();
            expect(await run).toEqual({ caught: 1 });
            expect(f.clicks).toEqual([3, 3]);
            expect(f.kills()).toBe(0);
            const end = rows.find(r => r.event === 'action-ended');
            expect(end.detail.still).toBe(SHARK_IDLE_TICKS);
            expect(end.tick - at).toBeLessThanOrEqual(6 + SHARK_IDLE_TICKS);
            expect(rows.some(r => r.event === 'watchdog')).toBe(false);
        });
    } finally {
        f.stop();
    }
});

test('three-tick animation gaps between live rolls never end the action', async () => {
    const f = sharkFixture({ hit: r => r >= 10 });
    try {
        await captureFishing(async rows => {
            expect(await catchSharks(f.s, 1, () => false)).toEqual({ caught: 1 });
            expect(rows.some(r => r.event === 'action-ended')).toBe(false);
            expect(f.clicks).toEqual([3]);
        });
    } finally {
        f.stop();
    }
});

test('a dispatch the server never starts fails as refused, not as slow fishing', async () => {
    const f = sharkFixture({ refuse: true });
    try {
        await expect(catchSharks(f.s, 1, () => false)).rejects.toThrow('shark fishing dispatch refused');
        expect(f.clicks).toEqual([3, 3, 3]);
        expect(f.rolls()).toBe(0);
    } finally {
        f.stop();
    }
});

test('a spot that vanishes mid-action is reacquired from fresh identity', async () => {
    let moved = false;
    const f = sharkFixture({ hit: () => moved });
    try {
        const run = catchSharks(f.s, 1, () => false);
        await ticks.waitTicks(f.s, 20);
        f.st.nearbyNpcs = [{ ...sharkSpotFixture, index: 9, x: 2847, z: 3430 }];
        moved = true;
        expect(await run).toEqual({ caught: 1 });
        expect(f.clicks.length).toBeGreaterThanOrEqual(2);
        expect(f.clicks.length).toBeLessThanOrEqual(3);
        expect(f.clicks.every(op => op === 3)).toBe(true);
    } finally {
        f.stop();
    }
});

test('wrong NPC cannot make progress, missing tool/full pack refuse, budget propagates', async () => {
    for (const [settings, error] of [[{ wrong: true }, 'no progress'], [{ tool: false }, 'harpoon'], [{ full: true }, 'full pack']] as const) {
        const f = sharkFixture(settings);
        try {
            await expect(catchSharks(f.s, 1, () => false, 3)).rejects.toThrow(error);
            expect(f.clicks).toHaveLength(0);
        } finally {
            f.stop();
        }
    }
    const f = sharkFixture();
    try {
        await expect(catchSharks(f.s, 1, () => true)).rejects.toThrow('stop');
    } finally {
        f.stop();
    }
});

test('two catches then unresolved progress retains raw stock, original cause and the progress boundary', async () => {
    let lucky = false;
    const f = sharkFixture({ hit: r => r < 2 || lucky });
    try {
        await captureFishing(async rows => {
            await expect(catchSharks(f.s, 3, () => false)).rejects.toThrow('shark fishing no progress');
            const failure = rows.at(-1);
            expect(failure.event).toBe('failure');
            expect(failure.rawSharks).toBe(2);
            expect(failure.detail).toMatchObject({ caught: 2, progressTicks: SHARK_PROGRESS_TICKS, cause: 'Error: shark fishing no progress' });
            expect(failure.tick - failure.detail.progress).toBeGreaterThanOrEqual(SHARK_PROGRESS_TICKS);
            expect(failure.tick - failure.detail.progress).toBeLessThanOrEqual(SHARK_PROGRESS_TICKS + 12);
            expect(rows.some(r => r.event === 'complete')).toBe(false);
            expect(rows.filter(r => r.event === 'dispatch').every(r => r.detail.option === 3 && r.selected.id === 322)).toBe(true);
            expect(f.items().filter(i => i.id === 383)).toHaveLength(2);
            lucky = true;
            expect(await catchSharks(f.s, 3, () => false)).toEqual({ caught: 3 });
            expect(f.items().filter(i => i.id === 383)).toHaveLength(5);
        });
    } finally {
        f.stop();
    }
}, 30000);

test('active-looking animation without a catch stays unknown; dispatch replies and probable rejection are separate', async () => {
    const f = sharkFixture({ animate: false });
    const st = f.s.sdk.getState()!;
    Object.assign(st, {
        tick: 10,
        revision: 20,
        gameMessages: [],
        opFeedback: { opRejectedCount: 0, lastOpRejectedTick: -1, mapFlagUnsetCount: 0, lastMapFlagUnsetTick: -1 },
    });
    st.player!.animId = 618;
    (f.s.sdk as any).getStateAge = () => 900;
    (f.s.sdk as any).getSkill = () => ({ level: 99, baseLevel: 99, experience: 998458 });
    (f.s.sdk as any).sendInteractNpc = async () => {
        st.opFeedback!.opRejectedCount++;
        return { success: false, message: 'dispatch refused', reason: 'rejected', phase: 'dispatch' };
    };
    try {
        await captureFishing(async rows => {
            await expect(catchSharks(f.s, 1, () => false, 12)).rejects.toThrow('no progress');
            expect(rows.find(r => r.event === 'dispatch-reply').detail).toMatchObject({ success: false, reason: 'rejected', phase: 'dispatch' });
            const end = rows.at(-1);
            expect(end).toMatchObject({ stateTick: 10, revision: 20, stateAgeMs: 900, rawSharks: 0, actionSettlement: 'unknown', player: { animId: 618 }, fishing: { xp: 998458 } });
            expect(end.opFeedback.opRejectedCount).toBe(rows.filter(r => r.event === 'dispatch').length);
            expect(rows.some(r => r.event === 'started')).toBe(false);
            expect(end.detail.caught).toBe(0);
        });
    } finally {
        f.stop();
    }
});

test('trace freezes the dispatched spot, observes movement/disappearance and never consumes chat', () => {
    const f = sharkFixture();
    const rows: any[] = [];
    const st = f.s.sdk.getState()!;
    Object.assign(st, { gameMessages: [{ type: 0, text: 'old', tick: 1 }], revision: 1, tick: 1 });
    let sharedChatReads = 0;
    (f.s.sdk as any).getNewChat = () => {
        sharedChatReads++;
        return [];
    };
    const trace = sharkFishingTrace(f.s, row => rows.push(row));
    try {
        trace.select(st.nearbyNpcs[0]!);
        trace.record('dispatch');
        st.nearbyNpcs[0]!.x++;
        st.gameMessages.push(
            { type: 0, text: 'You start Harpooning fish.', tick: 2, observationId: 2, fromSelf: false, sender: '' },
            { type: 3, text: 'private text', tick: 2, observationId: 3, fromSelf: false, sender: 'other' },
        );
        trace.record('tick');
        trace.record('tick');
        expect(rows[1].selected.x).toBe(2845);
        expect(rows[1].currentSelected.x).toBe(2846);
        expect(rows[1].messages).toEqual([{ tick: 2, observationId: 2, text: 'You start Harpooning fish.' }]);
        expect(rows[2].messages).toEqual([]);
        expect(sharedChatReads).toBe(0);
        st.nearbyNpcs = [];
        trace.record('tick');
        expect(rows.at(-1)).toMatchObject({ currentSelected: null, candidates: [], actionSettlement: 'unknown' });
    } finally {
        f.stop();
    }
});

test('trace failure is reported once and cannot replace the original dispatch error', async () => {
    const f = sharkFixture();
    const problem = Error('original dispatch error');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const log = spyOn(console, 'log').mockImplementation(() => {
        throw Error('broken trace sink');
    });
    (f.s.sdk as any).sendInteractNpc = async () => {
        throw problem;
    };
    try {
        await expect(catchSharks(f.s, 1, () => false)).rejects.toBe(problem);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toContain('SHARK_FISH_TRACE_ERROR');
    } finally {
        log.mockRestore();
        warn.mockRestore();
        f.stop();
    }
});

test('cancellation and full pack stop without dispatch; post-failure ticks have no trace subscription', async () => {
    for (const full of [false, true]) {
        const f = sharkFixture({ full });
        try {
            await captureFishing(async rows => {
                await expect(catchSharks(f.s, 1, () => !full)).rejects.toThrow(full ? 'full pack' : 'budget/health stop');
                expect(f.clicks).toHaveLength(0);
                expect(rows.at(-1).event).toBe('failure');
                const length = rows.length;
                await ticks.waitTicks(f.s, 2);
                expect(rows).toHaveLength(length);
            });
        } finally {
            f.stop();
        }
    }
});

test('a vanished spot and exhausted harpoon retain observed stock and fail unresolved progress', async () => {
    const f = sharkFixture();
    let sends = 0;
    (f.s.sdk as any).sendInteractNpc = async () => {
        sends++;
        f.items().push({ id: 383, count: 1, slot: 1, name: 'Raw shark' });
        f.items().splice(0, 1);
        f.s.sdk.getState()!.nearbyNpcs = [];
        return { success: true, message: 'dispatched' };
    };
    try {
        await captureFishing(async rows => {
            await expect(catchSharks(f.s, 3, () => false, 12)).rejects.toThrow('no progress');
            expect(sends).toBe(1);
            expect(rows.at(-1)).toMatchObject({ rawSharks: 1, harpoons: 0, candidates: [], actionSettlement: 'unknown' });
            expect(rows.at(-1).detail.caught).toBe(1);
        });
    } finally {
        f.stop();
    }
});

test('session cooking counts a real burnt outcome and does not own logout', async () => {
    const f = sharkFixture({ burn: true });
    try {
        await catchSharks(f.s, 1, () => false);
        expect(await cookSharks(f.s, () => false)).toEqual({ raw: 1, cooked: 0, burnt: 1 });
    } finally {
        f.stop();
    }
});

test('unavailable bank remains failed and cannot claim production or cleanup', async () => {
    const f = sharkFixture();
    try {
        (f.s.sdk as any).getSkill = (name: string) => ({ level: name === 'Hitpoints' ? 75 : 99, baseLevel: 75 });
        (f.s.bot as any) = { openBank: async () => ({ success: false }) };
        const r = await supplySharks(f.s, { target: 25, maxTicks: 20, consumer: 'staging' });
        expect(r.ok).toBe(false);
        expect(r.caught).toBe(0);
        expect(r.failure).toContain('bank');
        expect(r.assets).toBe(false);
    } finally {
        f.stop();
    }
});

test('full bank rejects an unobserved deposit; missing owned food stops before travel', async () => {
    for (const fullBank of [true, false]) {
        const f = sharkFixture();
        let generation = 0;
        const bank: any[] = [];
        try {
            const st = f.s.sdk.getState()!;
            st.player!.worldX = 2618;
            st.player!.worldZ = 3332;
            st.inventory = f.items();
            (f.s.sdk as any).getSkill = (name: string) => ({ level: name === 'Hitpoints' ? 43 : 99, baseLevel: name === 'Hitpoints' ? 75 : 99 });
            (f.s.sdk as any).getEquipment = () => [];
            (f.s as any).bankObservation = () => ({ generation, at: Date.now(), items: bank.map(i => ({ ...i })) });
            (f.s as any).bot = {
                openBank: async () => {
                    generation++;
                    return { success: true };
                },
                depositItem: async (itemRow: any) => {
                    if (fullBank) return { success: false };
                    const n = f.items().filter(i => i.id === itemRow.id).reduce((v, i) => v + i.count, 0);
                    for (let i = f.items().length - 1; i >= 0; i--) if (f.items()[i].id === itemRow.id) f.items().splice(i, 1);
                    bank.push({ id: itemRow.id, name: itemRow.name, count: n });
                    generation++;
                    return { success: true };
                },
            };
            const r = await supplySharks(f.s, { target: 25, maxTicks: 500, consumer: 'staging' });
            expect(r.ok).toBe(false);
            expect(r.caught).toBe(0);
            expect(r.banked).toBe(0);
            expect(r.failure).toContain(fullBank ? 'pack debit/bank credit unobserved' : 'missing owned travel food');
            expect(f.items().reduce((n, i) => n + i.count, 0) + bank.reduce((n, i) => n + i.count, 0)).toBe(1);
        } finally {
            f.stop();
        }
    }
});

const ardougneLeg: PathTile[] = [
    [2645, 3389], [2647, 3391], [2658, 3391], [2660, 3393], [2660, 3394], [2661, 3394], [2662, 3395], [2667, 3395], [2668, 3396],
    [2669, 3396], [2671, 3398], [2671, 3399], [2674, 3399], [2674, 3401], [2676, 3403], [2677, 3403], [2679, 3405],
].map(([x, z]) => ({ x: x!, z: z! }));

test('route accepts an empty plan at the target and a plan that ends beside the target', () => {
    expect(sharkRoutePlan(0, { x: 2809, z: 3441 }, { x: 2809, z: 3441, tol: 2 }, [])).toEqual([]);
    expect(sharkRoutePlan(0, { x: 2645, z: 3385 }, { x: 2680, z: 3405, tol: 2 }, ardougneLeg)).toBe(ardougneLeg);
});

test('route refuses a short plan, an empty plan away from the target, a corridor exit and another level', () => {
    expect(() => sharkRoutePlan(0, { x: 2645, z: 3385 }, { x: 2680, z: 3405, tol: 2 }, ardougneLeg.slice(0, -1))).toThrow('unsafe/incomplete shark route');
    expect(() => sharkRoutePlan(0, { x: 2618, z: 3332 }, { x: 2618, z: 3355, tol: 2 }, [])).toThrow('unsafe/incomplete shark route');
    expect(() => sharkRoutePlan(0, { x: 2850, z: 3440 }, { x: 2860, z: 3440, tol: 2 }, [{ x: 2870, z: 3440 }, { x: 2860, z: 3440 }])).toThrow('unsafe/incomplete shark route');
    expect(() => sharkRoutePlan(1, { x: 2809, z: 3441 }, { x: 2809, z: 3441, tol: 2 }, [])).toThrow('unsafe/incomplete shark route');
});

function fakeSharkWalker(at: PathTile, plan: PathDeps['plan']) {
    let tick = 0;
    const pos = { ...at, level: 0 };
    const listeners = new Set<() => void>();
    const loop = setInterval(() => {
        tick++;
        for (const f of [...listeners]) f();
    }, 1);
    const deps: PathDeps = {
        tick: () => tick,
        pos: () => ({ ...pos }),
        onTick: f => {
            listeners.add(f);
            return () => listeners.delete(f);
        },
        walk: (x, z) => {
            pos.x = x;
            pos.z = z;
        },
        interactLoc: () => {},
        locs: () => [],
        plan,
    };
    return { deps, pos, stop: () => clearInterval(loop) };
}

test('guarded walkPath finishes on an empty plan at the bank and on the pinned leg that ends beside its point', async () => {
    const bank = fakeSharkWalker({ x: 2809, z: 3441 }, () => []);
    try {
        expect((await walking.walkPath(guardSharkRoute(bank.deps, () => false), [{ x: 2809, z: 3441, tol: 2 }])).ok).toBe(true);
    } finally {
        bank.stop();
    }
    const leg = fakeSharkWalker({ x: 2645, z: 3385 }, () => ardougneLeg);
    try {
        expect((await walking.walkPath(guardSharkRoute(leg.deps, () => false), [{ x: 2680, z: 3405, tol: 2 }], { maxTicks: 60 })).ok).toBe(true);
        expect(Math.max(Math.abs(leg.pos.x - 2680), Math.abs(leg.pos.z - 3405))).toBeLessThanOrEqual(2);
    } finally {
        leg.stop();
    }
});

async function routeThrow(recoveryPlan: PathTile[]) {
    const f = sharkFixture({ tool: false });
    let generation = 0;
    const bank: any[] = [{ id: 311, name: 'Harpoon', count: 1 }, { id: 329, name: 'Salmon', count: 10 }, { id: 995, name: 'Coins', count: 5000 }];
    try {
        const st = f.s.sdk.getState()!;
        st.player!.worldX = 2618;
        st.player!.worldZ = 3332;
        st.inventory = f.items();
        (f.s.sdk as any).getSkill = (name: string) => ({ level: name === 'Hitpoints' ? 75 : 99, baseLevel: name === 'Hitpoints' ? 75 : 99 });
        (f.s.sdk as any).getEquipment = () => [];
        (f.s as any).bankObservation = () => ({ generation, at: Date.now(), items: bank.map(i => ({ ...i })) });
        (f.s as any).bot = {
            openBank: async () => {
                generation++;
                return { success: true };
            },
            closeInterface: async () => {},
            withdrawItem: async (name: RegExp, n: number) => {
                const b = bank.find(i => name.test(i.name))!;
                b.count -= n;
                f.items().push({ id: b.id, count: n, slot: f.items().length, name: b.name });
                generation++;
                return { success: true };
            },
            depositItem: async (itemRow: any) => {
                const n = f.items().filter(i => i.id === itemRow.id).reduce((v, i) => v + i.count, 0);
                for (let i = f.items().length - 1; i >= 0; i--) if (f.items()[i].id === itemRow.id) f.items().splice(i, 1);
                bank.push({ id: itemRow.id, name: itemRow.name, count: n });
                generation++;
                return { success: true };
            },
        };
        const plans: PathTile[] = [];
        const r = await supplySharks(f.s, {
            target: 25,
            maxTicks: 500,
            consumer: 'staging',
            walker: async () =>
                fakeSharkWalker({ x: 2618, z: 3332 }, (_l, _from, to) => {
                    plans.push(to);
                    return plans.length === 1 ? [{ x: 2618, z: 3345 }] : recoveryPlan;
                }).deps,
        });
        return { r, plans, pack: f.items().map(i => i.id) };
    } finally {
        f.stop();
    }
}

test('a route throw keeps its error, banks the carried kit at the west bank and reconciles assets', async () => {
    const { r, plans, pack } = await routeThrow([]);
    expect(r.ok).toBe(false);
    expect(r.failure).toContain('unsafe/incomplete shark route');
    expect(plans.at(-1)).toMatchObject({ x: 2619, z: 3332, tol: 8 });
    expect(r).toMatchObject({ recovery: 'banked', atBank: true, assets: true, unbanked: {}, caught: 0, banked: 0 });
    expect(pack).toEqual([]);
});

test('a failed recovery stays failed, never claims the bank and lists the unbanked kit', async () => {
    const { r, pack } = await routeThrow([{ x: 2590, z: 3332 }]);
    expect(r.ok).toBe(false);
    expect(r.failure).toContain('unsafe/incomplete shark route');
    expect(r.recovery).toContain('unsafe/incomplete shark route');
    expect(r.atBank).toBe(false);
    expect(r.unbanked).toEqual({ 311: 1, 329: 2 });
    expect(pack.sort()).toEqual([311, 329]);
});

test('the order owns a two-catch stall: raw stock banks, cooked credit stays zero, cause is retained', async () => {
    const f = sharkFixture({ tool: false, hit: r => r < 2 });
    let generation = 0;
    const bank: any[] = [{ id: 311, name: 'Harpoon', count: 1 }, { id: 329, name: 'Salmon', count: 10 }, { id: 995, name: 'Coins', count: 5408 }, { id: 385, name: 'Shark', count: 5 }];
    const st = f.s.sdk.getState()!;
    st.player!.worldX = 2809;
    st.player!.worldZ = 3441;
    st.inventory = f.items();
    (f.s.sdk as any).getSkill = (name: string) => ({ level: name === 'Hitpoints' ? 75 : 99, baseLevel: name === 'Hitpoints' ? 75 : 99 });
    (f.s.sdk as any).getEquipment = () => [];
    (f.s as any).bankObservation = () => ({ generation, at: Date.now(), items: bank.map(i => ({ ...i })) });
    (f.s as any).bot = {
        openBank: async () => {
            generation++;
            return { success: true };
        },
        closeInterface: async () => {},
        withdrawItem: async (name: RegExp, n: number) => {
            const b = bank.find(i => name.test(i.name))!;
            b.count -= n;
            f.items().push({ id: b.id, count: n, slot: f.items().length, name: b.name });
            generation++;
            return { success: true };
        },
        depositItem: async (itemRow: any) => {
            const n = f.items().filter(i => i.id === itemRow.id).reduce((v, i) => v + i.count, 0);
            for (let i = f.items().length - 1; i >= 0; i--) if (f.items()[i].id === itemRow.id) f.items().splice(i, 1);
            bank.push({ id: itemRow.id, name: itemRow.name, count: n });
            generation++;
            return { success: true };
        },
    };
    const walker = async (): Promise<PathDeps> => ({
        tick: f.s.tick,
        onTick: f.s.onTick,
        pos: () => ({ x: st.player!.worldX, z: st.player!.worldZ, level: 0 }),
        walk: (x, z) => {
            st.player!.worldX = x;
            st.player!.worldZ = z;
        },
        interactLoc: () => {},
        locs: () => [],
        plan: (_level, _from, to) => [{ x: to.x, z: to.z }],
    });
    try {
        await captureFishing(async () => {
            const r = await supplySharks(f.s, { target: 3, maxTicks: 1000, consumer: 'staging', walker });
            expect(r).toMatchObject({
                ok: false,
                target: 3,
                caught: 2,
                cooked: 0,
                burnt: 0,
                banked: 0,
                assets: true,
                recovery: 'banked',
                atBank: true,
                unbanked: {},
                failure: 'Error: shark fishing no progress',
            });
            expect(bank.filter(i => i.id === 383).reduce((n, i) => n + i.count, 0)).toBe(2);
            expect(bank.filter(i => i.id === 385).reduce((n, i) => n + i.count, 0)).toBe(5);
            expect(f.items()).toEqual([]);
            expect(sharkSummary(r)).toContain('newBankedSharks=0 caught=2 cooked=0');
        });
    } finally {
        f.stop();
    }
}, 30000);

test('ensureCatherbyFishingTool buys missing Lobster pot from Harry when funded and banks change', async () => {
    let bankOpen = true;
    let shopOpen = false;
    let gen = 1;
    let tick = 0;
    const inv: any[] = [];
    const bank: any[] = [{ id: 995, name: 'Coins', count: 200, slot: 0 }];
    const shopItems = [{ id: 301, name: 'Lobster pot', count: 2, buyPrice: 20, slot: 0 }];
    const walks: string[] = [];
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
        tick++;
        for (const fn of [...listeners]) fn();
    }, 1);
    const s: any = {
        tick: () => tick,
        onTick: (fn: () => void) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        bankObservation: () => (bankOpen ? { generation: gen, items: bank } : null),
        sdk: {
            getState: () => ({ inventory: inv, equipment: [], bank: { isOpen: bankOpen, items: bank }, shop: { isOpen: shopOpen, shopItems } }),
            getInventory: () => inv,
            getEquipment: () => [],
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
            withdrawItem: async (itemRow: any, n: number) => {
                const row = bank.find(r => r.id === itemRow.id);
                row.count -= n;
                if (row.count <= 0) bank.splice(bank.indexOf(row), 1);
                inv.push({ id: itemRow.id, name: itemRow.name, count: n });
                gen++;
                return { success: true };
            },
            depositItem: async (itemRow: any) => {
                const idx = inv.findIndex(r => r.id === itemRow.id);
                const [removed] = inv.splice(idx, 1);
                const row = bank.find(r => r.id === removed.id);
                if (row) row.count += removed.count;
                else bank.push({ ...removed });
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
        const r = await ensureCatherbyFishingTool(s, {
            toolId: 301,
            maxCost: 50,
            walkTo: async spot => {
                walks.push(`${spot.x},${spot.z}`);
                return true;
            },
            openBank: () => s.bot.openBank(),
            stop: () => false,
        });
        expect(r).toEqual({ ok: true, bought: true, coinsSpent: 20 });
        expect(walks).toEqual(['2834,3445', '2809,3441']);
        expect(inv.map(i => i.id)).toEqual([301]);
        expect(bank.find(i => i.id === 995)?.count).toBe(180);
    } finally {
        clearInterval(timer);
    }
});
