// Consolidated unit tests for mining gathering: ore, essence, rotation, drop, progressive, at-site, loot, and escorted lava-maze ore.
import { expect, spyOn, test } from 'bun:test';
import type { Session } from '../../core/src/inprocess';
import * as walking from '../../core/src/walk';
import type { PathDeps } from '../../core/src/walk';
import { isNoProgressFailure } from '../../practice/src/supervise';
import { filterFixtureRoster, hasEscortLogouts } from '../../practice/src/lava-maze-escorted-ore-proof';
import { assessGodSpellReadiness, resolveMageArenaWorkflow, wildernessAgilityEscapeGuard } from '../../../scripts/aio-pvp';
import type { BotWorldState, NearbyLoc } from '../../../vendor/rs-sdk/sdk/types';
import {
    KNIFE,
    MINING_SITES,
    NORMAL_LOGS,
    RosterEvidence,
    alignAtBank,
    contentSites,
    corridorThreat,
    dist,
    eligiblePickaxe,
    entryRosterReady,
    equipUsablePickaxeInPack,
    escortInterceptDecision,
    essencePickWieldLevel,
    essenceTeleportProblem,
    firstRoll,
    groundLootEffect,
    inPerfectMine,
    isEssence,
    knifeDelay,
    lootCapacity,
    mineEssenceBatch,
    mineRock,
    miningEffect,
    miningProfiles,
    oreDamageEvidence,
    oreLag,
    oreStalled,
    pathSteps,
    progressiveMiningProfile,
    readEscortRoute,
    reconcileOrePickaxeAtBank,
    respawnTicks,
    retreatOrTeleportPlan,
    retreatOre,
    runAtSiteMining,
    runDropMining,
    runEssenceGatherer,
    runProgressiveMining,
    runVisibleGroundLoot,
    selectActiveOrePickaxe,
    selectGroundLoot,
    selectInboundRecovery,
    selectMiningRock,
    selectRock,
    siteRocks,
    siteTiles,
    stageRelease,
    standTiles,
    upgradeOwnedEssencePick,
    waitForRosterEntry,
    watchOreDamage,
    type LootDriver,
    type LootPolicy,
    type MiningAction,
    type MiningDropDriver,
    type MiningDriver,
    type MiningRotationTile,
    type RosterPlayer,
} from '../src/gather';

// --- Essence mining (formerly gather-essence.test.ts) ---
for (const mode of ['stalled', 'productive', 'stopped', 'event-stalled', 'last-tick']) {
    test(`essence output budget: ${mode}`, async () => {
        let tick = 0;
        let held = 0;
        let output = 0;
        let clicks = 0;
        const callbacks = new Set<() => void>();
        const s: any = {
            tick: () => tick,
            onTick: (cb: () => void) => {
                callbacks.add(cb);
                return () => callbacks.delete(cb);
            },
        };
        const timer = setInterval(() => {
            tick++;
            if ((mode === 'productive' && tick % 20 === 0) || (mode === 'last-tick' && tick === 10)) held += 3;
            for (const cb of [...callbacks]) cb();
        }, 1);
        try {
            const run = mineEssenceBatch(s, {
                count: () => held,
                full: () => held >= 12,
                stop: () => ['stopped', 'last-tick'].includes(mode) && tick >= 10,
                busy: () => mode === 'event-stalled',
                click: async () => {
                    clicks++;
                    return { success: true };
                },
                gain: n => {
                    output += n;
                },
            });
            if (mode.includes('stalled')) {
                await expect(run).rejects.toThrow('no observed output');
                expect(tick).toBeLessThanOrEqual(62);
                expect(output).toBe(0);
            } else {
                await run;
                expect(output).toBe(mode === 'productive' ? 12 : mode === 'last-tick' ? 3 : 0);
            }
            expect(clicks).toBeLessThan(10);
        } finally {
            clearInterval(timer);
        }
    }, 2000);
}

test('isEssence identifies rev-289 Rune essence ID only (no post-2004 Pure essence)', () => {
    expect(isEssence(1436)).toBe(true);
    expect(isEssence(7936)).toBe(false);
    expect(isEssence(995)).toBe(false);
    expect(isEssence(1265)).toBe(false);
});

test('dist calculates Chebyshev tile distance accurately', () => {
    expect(dist({ x: 3253, z: 3420 }, { worldX: 3253, worldZ: 3402 })).toBe(18);
    expect(dist({ x: 2891, z: 4847 }, { x: 2885, z: 4850 })).toBe(6);
});

test('arrival in the mine wins over stale or unrelated Rune Mysteries chat', () => {
    const refusal = { text: 'You need to have completed the Rune Mysteries Quest to use this feature.', tick: 100, observationId: 20 };
    expect(essenceTeleportProblem(true, [refusal], 10)).toBeNull();
    expect(essenceTeleportProblem(false, [refusal], 20)).toBe('Teleport to essence mine timed out');
    expect(essenceTeleportProblem(false, [{ ...refusal, text: 'You need to complete the Rune Mysteries quest to choose that option.' }], 10)).toBe('Teleport to essence mine timed out');
});

test('only a new actual Aubury refusal reports the quest prerequisite', () => {
    const refusal = { text: 'You need to have completed the Rune Mysteries Quest to use this feature.', tick: 100, observationId: 20 };
    expect(essenceTeleportProblem(false, [refusal], 19)).toBe('Rune Mysteries quest required: Aubury refused teleport');
    expect(essenceTeleportProblem(false, [{ text: 'Quest complete: Rune Mysteries', tick: 100, observationId: 20 }], 19)).toBe('Teleport to essence mine timed out');
});

test('an operator stop is not reported as a completed essence run', async () => {
    const s: any = {
        tick: () => 0,
        ended: new Promise(() => {}),
        onTick: () => () => {},
        sdk: {
            getState: () => ({ player: { worldX: 3253, worldZ: 3420, level: 0 } }),
            getInventory: () => [],
            getEquipment: () => [{ id: 1265, count: 1 }],
            getSkill: (name: string) => ({ level: name === 'Hitpoints' ? 10 : 91 }),
            getSkillXp: () => 1000,
        },
    };
    expect((await runEssenceGatherer(s, { cap: 100, bankAt: 28, stop: () => true })).ok).toBe(false);
});

function essenceBankModel(mode: 'rejected' | 'stale' | 'observed') {
    let tick = 0;
    let generation = 1;
    const state: any = { player: { worldX: 3253, worldZ: 3420, level: 0 }, bank: { isOpen: true, items: [{ id: 1436, name: 'Rune essence', count: 100 }] } };
    let inventory: any[] = Array.from({ length: 28 }, (_, slot) => ({ id: 1436, name: 'Rune essence', count: 1, slot }));
    const timers = new Set<ReturnType<typeof setInterval>>();
    const s: any = {
        tick: () => tick,
        ended: new Promise(() => {}),
        onTick: (fn: () => void) => {
            const timer = setInterval(() => {
                tick++;
                fn();
            }, 1);
            timers.add(timer);
            return () => {
                clearInterval(timer);
                timers.delete(timer);
            };
        },
        bankObservation: () => ({ generation, at: tick, items: state.bank.items }),
        sdk: {
            getState: () => state,
            getInventory: () => inventory,
            getEquipment: () => [{ id: 1265, count: 1 }],
            getSkill: (name: string) => ({ level: name === 'Hitpoints' ? 10 : 1 }),
            getSkillXp: () => 0,
        },
        bot: {
            dismissBlockingUI: async () => {},
            depositItem: async () => {
                if (mode === 'rejected') return { success: false };
                inventory = [];
                if (mode === 'observed') {
                    state.bank.items[0].count += 28;
                    generation++;
                }
                return { success: true };
            },
            closeBank: async () => {
                state.bank.isOpen = false;
                tick++;
            },
        },
    };
    return s;
}

test('a rejected deposit cannot turn the carried essence count into claimed bank output', async () => {
    const r = await runEssenceGatherer(essenceBankModel('rejected'), { cap: 1, bankAt: 28 });
    expect(r.ok).toBe(false);
    expect(r.totalBanked).toBe(0);
    expect(r.failure).toMatch(/deposit/i);
});

test('inventory disappearance without the matching bank receipt is not a banked load', async () => {
    const r = await runEssenceGatherer(essenceBankModel('stale'), { cap: 1, bankAt: 28 });
    expect(r.ok).toBe(false);
    expect(r.totalBanked).toBe(0);
    expect(r.failure).toMatch(/deposit/i);
});

test('an observed inventory debit and matching fresh bank credit count the real load', async () => {
    const r = await runEssenceGatherer(essenceBankModel('observed'), { cap: 1, bankAt: 28 });
    expect(r.ok).toBe(true);
    expect(r.totalBanked).toBe(28);
    expect(r.trips).toBe(1);
});

test('one trip includes an initial retained load and returns without another teleport', async () => {
    const s = essenceBankModel('observed');
    const walker = spyOn(walking, 'sessionWalker').mockImplementation(async () => {
        throw Error('unexpected second trip');
    });
    let r;
    try {
        r = await runEssenceGatherer(s, { cap: 100, bankAt: 28, maxTrips: 1 });
    } finally {
        walker.mockRestore();
    }
    expect(r.ok).toBe(true);
    expect(r.trips).toBe(1);
    expect(r.totalBanked).toBe(28);
    expect(r.totalMined).toBe(0);
    expect(r.held).toBe(0);
});

test('cancellation while waiting for a bank receipt does not dispatch a deposit', async () => {
    const s = essenceBankModel('observed');
    let deposits = 0;
    s.bankObservation = (() => undefined) as any;
    s.bot.depositItem = async () => {
        deposits++;
        return { success: true };
    };
    const r = await runEssenceGatherer(s, { cap: 100, bankAt: 28, maxTrips: 1, stop: () => s.tick() >= 2 });
    expect(r.ok).toBe(false);
    expect(deposits).toBe(0);
    expect(r.totalBanked).toBe(0);
    expect(s.tick()).toBeLessThan(5);
});

for (const cancel of [false, true]) {
    test(`a full retained mine load returns once, or preserves cancellation on the return route: ${cancel}`, async () => {
        const s = essenceBankModel('observed');
        const state = s.sdk.getState();
        let stopped = false;
        let teleports = 0;
        state.player = { worldX: 2891, worldZ: 4847, level: 0 };
        state.nearbyLocs = [{ id: 2492, name: 'Portal', x: 2885, z: 4850, optionsWithIndex: [{ text: 'Use', opIndex: 1 }] }];
        s.sdk.sendInteractLoc = async () => {
            teleports++;
            state.player = { worldX: 3253, worldZ: 3402, level: 0 };
            return { success: true };
        };
        const spies = [
            spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
            spyOn(walking, 'walkPath').mockImplementation(async (_w, points) => {
                if (cancel) {
                    stopped = true;
                    return { ok: false, detail: 'stopped' } as any;
                }
                const p = points.at(-1)!;
                state.player = { worldX: p.x, worldZ: p.z, level: 0 };
                return { ok: true } as any;
            }),
        ];
        try {
            const r = await runEssenceGatherer(s, { cap: 100, bankAt: 28, maxTrips: 1, stop: () => stopped });
            expect(r.ok).toBe(!cancel);
            expect(r.totalMined).toBe(0);
            expect(r.trips).toBe(cancel ? 0 : 1);
            expect(r.totalBanked).toBe(cancel ? 0 : 28);
            expect(r.held).toBe(cancel ? 28 : 0);
            expect(teleports).toBe(cancel ? 0 : 1);
        } finally {
            for (const spy of spies) spy.mockRestore();
        }
    });
}

test('cancellation after a matched bank credit preserves that receipt and does no tool action', async () => {
    const s = essenceBankModel('observed');
    let stopped = false;
    let equips = 0;
    const close = s.bot.closeBank;
    s.bot.closeBank = async () => {
        await close();
        stopped = true;
    };
    s.bot.equipItem = async () => {
        equips++;
        return { success: true };
    };
    const r = await runEssenceGatherer(s, { cap: 100, bankAt: 28, maxTrips: 1, stop: () => stopped });
    expect(r.ok).toBe(false);
    expect(r.totalBanked).toBe(28);
    expect(r.held).toBe(0);
    expect(equips).toBe(0);
});

function ownedPickBank(mode: 'observed' | 'stale-withdraw' | 'no-wield' | 'stop-after-withdraw', mining = 99, attack = 99) {
    let tick = 0;
    let generation = 1;
    let withdrawals = 0;
    let equips = 0;
    let nullOnEquip = false;
    const bank: any[] = [
        { id: 1275, name: 'Rune pickaxe', count: 1, slot: 0 },
        { id: 995, name: 'Coins', count: 77, slot: 1 },
        { id: 2357, name: 'Gold bar', count: 1, slot: 2 },
    ];
    const inventory: any[] = [];
    const equipment: any[] = [{ id: 1265, name: 'Bronze pickaxe', count: 1, slot: 3 }];
    const player = { worldX: 3253, worldZ: 3420, level: 0, lifeId: 1, respawnCount: 0, isDead: false };
    const state: any = { player, bank: { isOpen: true, items: bank }, inventory, equipment, skills: [{ name: 'Mining', level: mining }, { name: 'Hitpoints', level: 99 }] };
    const listeners = new Set<() => void>();
    const s: any = {
        tick: () => tick,
        onTick: (fn: () => void) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        bankObservation: () => (state.bank.isOpen ? { generation, items: bank } : null),
        sdk: {
            getState: () => state,
            getInventory: () => inventory,
            getEquipment: () => equipment,
            getSkill: (name: string) => ({ level: name === 'Mining' ? mining : 99, baseLevel: name === 'Attack' ? attack : 99 }),
        },
        bot: {
            closeBank: async () => {
                state.bank.isOpen = false;
                return { success: true };
            },
            withdrawItem: async (item: any, n: number) => {
                withdrawals++;
                item.count -= n;
                inventory.push({ id: item.id, name: item.name, count: n, slot: 0 });
                if (mode !== 'stale-withdraw') generation++;
                return { success: true };
            },
            equipItem: async (item: any) => {
                equips++;
                state.bank.isOpen = false;
                nullOnEquip = s.bankObservation() === null;
                if (mode === 'no-wield') return { success: false };
                const old = equipment.pop();
                inventory.splice(inventory.indexOf(item), 1);
                equipment.push({ ...item, slot: 3 });
                if (old) inventory.push({ ...old, slot: 0 });
                return { success: true };
            },
            depositItem: async (item: any) => {
                const i = inventory.indexOf(item);
                inventory.splice(i, 1);
                const row = bank.find(v => v.id === item.id);
                if (row) row.count += item.count;
                else bank.push({ ...item, slot: bank.length });
                generation++;
                return { success: true };
            },
        },
    };
    const timer = setInterval(() => {
        tick++;
        for (const fn of listeners) fn();
    }, 1);
    return {
        s,
        bank,
        inventory,
        equipment,
        withdrawals: () => withdrawals,
        equips: () => equips,
        nullOnEquip: () => nullOnEquip,
        open: async () => {
            state.bank.isOpen = true;
            generation++;
        },
        stop: () => mode === 'stop-after-withdraw' && withdrawals > 0,
        done: () => clearInterval(timer),
    };
}

test('owned bank upgrade replaces an eligible inferior pick without spending or losing either tool', async () => {
    const f = ownedPickBank('observed');
    try {
        const r = await upgradeOwnedEssencePick(f.s, { openBank: f.open, stop: f.stop });
        expect(r).toEqual({ id: 1275, worn: true, preserved: true });
        expect(f.equipment[0].id).toBe(1275);
        expect(f.bank.find(i => i.id === 1265)?.count).toBe(1);
        expect(f.bank.find(i => i.id === 995)?.count).toBe(77);
        expect(f.bank.find(i => i.id === 2357)?.count).toBe(1);
        expect(f.withdrawals()).toBe(1);
        expect(f.nullOnEquip()).toBe(true);
        await upgradeOwnedEssencePick(f.s, { openBank: f.open, stop: f.stop });
        expect(f.withdrawals()).toBe(1);
    } finally {
        f.done();
    }
});

test('native Mining eligibility skips an unusable bank upgrade and a wield refusal keeps both tools', async () => {
    for (const [mode, level, id, worn] of [['observed', 1, 1265, true], ['no-wield', 99, 1275, false]] as const) {
        const f = ownedPickBank(mode, level);
        try {
            const r = await upgradeOwnedEssencePick(f.s, { openBank: f.open, stop: f.stop });
            expect(r.id).toBe(id);
            expect(r.worn).toBe(worn);
            expect(f.equipment[0].id).toBe(1265);
            expect(f.withdrawals()).toBe(level === 1 ? 0 : 1);
            if (!worn) expect(f.inventory.some(i => i.id === 1275)).toBe(true);
            if (!worn) {
                await upgradeOwnedEssencePick(f.s, { openBank: f.open, stop: f.stop });
                expect(f.equips()).toBe(1);
                expect(f.nullOnEquip()).toBe(true);
            }
        } finally {
            f.done();
        }
    }
});

test('stale withdrawal or operator stop cannot authorize a later wield/deposit', async () => {
    for (const mode of ['stale-withdraw', 'stop-after-withdraw'] as const) {
        const f = ownedPickBank(mode);
        try {
            await expect(upgradeOwnedEssencePick(f.s, { openBank: f.open, stop: f.stop })).rejects.toThrow();
            expect(f.equipment[0].id).toBe(1265);
            expect(f.inventory.some(i => i.id === 1275)).toBe(true);
            expect(f.withdrawals()).toBe(1);
            expect(f.bank.find(i => i.id === 995)?.count).toBe(77);
        } finally {
            f.done();
        }
    }
});

test('native base Attack requirement avoids a known Rune wield refusal across repeated bank visits', async () => {
    expect(essencePickWieldLevel(1275)).toBe(40);
    expect(essencePickWieldLevel(1269)).toBe(5);
    const f = ownedPickBank('observed', 99, 1);
    try {
        for (let i = 0; i < 2; i++) {
            const r = await upgradeOwnedEssencePick(f.s, { openBank: f.open, stop: f.stop });
            expect(r.id).toBe(1275);
            expect(r.worn).toBe(false);
        }
        expect(f.equips()).toBe(0);
        expect(f.withdrawals()).toBe(1);
        expect(f.equipment[0].id).toBe(1265);
        expect(f.inventory.some(i => i.id === 1275)).toBe(true);
    } finally {
        f.done();
    }
});

// --- Gather ore & pickaxe reconciliation (formerly gather-ore.test.ts) ---
const rock = (id = 2090, distance = 1): NearbyLoc => ({ id, name: 'Rocks', x: 3285, z: 3367, level: 0, distance, options: ['Mine'], optionsWithIndex: [{ text: 'Mine', opIndex: 1 }] });

function oreFixture(change: (tick: number, f: { rocks: NearbyLoc[]; ore: number; xp: number }) => void, rejected = false) {
    let tick = 0;
    let calls = 0;
    const listeners = new Set<() => void>();
    const f = { rocks: [rock()], ore: 0, xp: 0 };
    const timer = setInterval(() => {
        tick++;
        change(tick, f);
        for (const cb of [...listeners]) cb();
    }, 1);
    const s = {
        tick: () => tick,
        ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        sdk: {
            getState: () => ({ nearbyLocs: f.rocks, gameMessages: [] }),
            getInventory: () => (f.ore ? [{ name: 'Copper ore', count: f.ore }] : []),
            getSkillXp: () => f.xp,
            sendInteractLoc: async () => {
                calls++;
                return { success: !rejected, reason: 'client_rejected' };
            },
        },
    } as unknown as Session;
    return { s, f, calls: () => calls, close: () => clearInterval(timer) };
}

test('chooses active eligible alternative when preferred species is gone; respects floor/reach/current level', () => {
    expect(selectRock([rock(2094)], 1, 0, 0)?.id).toBe(2094);
    expect(selectRock([rock(2092)], 14, 0, 0)).toBeUndefined();
    expect(selectRock([{ ...rock(), reachable: false }, { ...rock(2094), level: 1 }], 30, 0, 0)).toBeUndefined();
    expect(selectRock([rock(2090, 4), { ...rock(2091, 1), x: 3287 }], 1, 0, 0)?.id).toBe(2091);
});

test('unoccupied nodes precede crowded preferred species, while equally crowded nodes retain species rotation', () => {
    const copper = rock(2090, 1);
    const tin = { ...rock(2094, 4), x: 3289, z: 3364 };
    expect(selectRock([copper, tin], 30, 0, 0, 'mixed', [{ x: 3285, z: 3368 }])).toBe(tin);
    expect(selectRock([copper, tin], 30, 0, 0, 'mixed', [{ x: 3285, z: 3368 }, { x: 3289, z: 3365 }])).toBe(copper);
    expect(selectRock([copper, { ...rock(2091, 5), x: 3290, z: 3364 }], 30, 0, 0, 'mixed', [{ x: 3285, z: 3367 }])?.x).toBe(3290);
});

for (const replacement of [[], [rock(2093)], [{ ...rock(), optionsWithIndex: [] }]]) {
    test('depleted/despawned/replaced selected rock ends wait without 60 tick timeout', async () => {
        const f = oreFixture((t, state) => {
            if (t === 2) state.rocks = replacement;
        });
        try {
            const r = await mineRock(f.s, rock(), () => false);
            expect(r.reason).toBe('rock-gone');
            expect(r.ticks).toBeLessThanOrEqual(3);
            expect(r.ore).toBe(0);
        } finally {
            f.close();
        }
    });
}

test('our ore+XP wins over simultaneous depletion; publication can settle one tick later', async () => {
    const f = oreFixture((t, state) => {
        if (t === 2) {
            state.rocks = [];
            state.ore = 1;
        }
        if (t === 3) state.xp = 437;
    });
    try {
        expect(await mineRock(f.s, rock(), () => false)).toMatchObject({ ore: 1, xp: 437, ticks: 3, reason: 'mined' });
    } finally {
        f.close();
    }
});

test('XP alone never counts ore production', async () => {
    const f = oreFixture((t, state) => {
        if (t === 2) {
            state.xp = 100;
            state.rocks = [];
        }
    });
    try {
        expect(await mineRock(f.s, rock(), () => false)).toMatchObject({ ore: 0, xp: 100, reason: 'rock-gone' });
    } finally {
        f.close();
    }
});

test('client rejection ends immediately and does not pretend ore progress', async () => {
    const f = oreFixture(() => {}, true);
    try {
        expect(await mineRock(f.s, rock(), () => false)).toMatchObject({ ore: 0, xp: 0, ticks: 0, reason: 'rejected:client_rejected' });
        expect(f.calls()).toBe(1);
    } finally {
        f.close();
    }
});

test('unchanged live rock retains a bounded roll wait and cumulative misses exhaust deadline', async () => {
    const f = oreFixture(() => {});
    try {
        let waiting = 0;
        let attempts = 0;
        while (!oreStalled(waiting, 12)) {
            const r = await mineRock(f.s, rock(), () => false, Math.min(5, 12 - waiting));
            waiting += r.ticks;
            attempts++;
        }
        expect(waiting).toBe(12);
        expect(attempts).toBe(3);
        expect(oreStalled(0, 12)).toBe(false);
    } finally {
        f.close();
    }
});

test('already stale rock is not clicked', async () => {
    const f = oreFixture(() => {});
    f.f.rocks = [];
    try {
        expect(await mineRock(f.s, rock(), () => false)).toMatchObject({ reason: 'rock-gone', ticks: 0 });
        expect(f.calls()).toBe(0);
    } finally {
        f.close();
    }
});

test('bounded ore failure is a permanent supervisor block, successful ore metrics are not', () => {
    expect(isNoProgressFailure('RESULT fail ticks=120 stop=no-progress no ore progress: bounded mining wait exhausted')).toBe(true);
    expect(isNoProgressFailure('RESULT ok mined=5 oreWaitTicks=0 stop=max-trips')).toBe(false);
});

test('explicit clay profile selects only exact clay IDs; default mixed profile stays unchanged', () => {
    const clay = rock(2108);
    expect(selectRock([clay, rock()], 1, 0, 0, 'clay')?.id).toBe(2108);
    expect(selectRock([clay, rock()], 1, 0, 0)?.id).toBe(2090);
    expect(selectRock([rock()], 99, 0, 0, 'clay')).toBeUndefined();
});

test('first positive damage cancels a live rock wait above 7 HP; a second attempt cannot click', async () => {
    const f = oreFixture(() => {});
    let hp = 10;
    let halted = false;
    const seen: any[] = [];
    (f.s.sdk as any).getSkill = () => ({ level: hp, baseLevel: 10 });
    const off = watchOreDamage(f.s, e => {
        seen.push(e);
        halted = true;
    });
    const hurt = f.s.onTick(() => {
        if (f.s.tick() >= 2) hp = 8;
    });
    try {
        const r = await mineRock(f.s, rock(), () => halted);
        expect(r.ticks).toBeLessThanOrEqual(4);
        expect(halted).toBe(true);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ hpBefore: 10, hpAfter: 8, attacker: 'unknown' });
        await mineRock(f.s, rock(), () => halted);
        expect(f.calls()).toBe(1);
    } finally {
        off();
        hurt();
        f.close();
    }
});

test('near Mugger or player-facing damage evidence never becomes a claimed live attacker', () => {
    const st = {
        player: { worldX: 3180, worldZ: 3371, level: 0, combat: { targetType: 'player', targetIndex: 44 } },
        nearbyNpcs: [{ id: 175, index: 9, name: 'Mugger', distance: 2, x: 3179, z: 3371, targetIndex: 32769, inCombat: true }],
        nearbyPlayers: [{ name: 'Nearby', index: 44, distance: 1, x: 3181, z: 3371, inCombat: true }],
        combatEvents: [{ type: 'damage_taken', tick: 8, sourceType: 'other_player', sourceIndex: 44, damage: 2 }],
    };
    const e = oreDamageEvidence(st, 10, 8, 8)!;
    expect(e.attacker).toBe('unknown');
    expect(e.npcs[0].id).toBe(175);
    expect(e.players[0].index).toBe(44);
    expect(e.eventAttribution).toContain('heuristics');
    expect(e.events).toHaveLength(1);
    expect(oreDamageEvidence(st, 0, 8, 8)).toBeUndefined();
    expect(oreDamageEvidence(st, 8, 10, 8)).toBeUndefined();
});

function recoveryFixture(refuseFood = false) {
    const inv: any[] = [
        { id: 434, name: 'Clay', count: 1, slot: 0 },
        { id: 434, name: 'Clay', count: 19, slot: 1 },
        { id: 2309, name: 'Bread', count: 1, slot: 2, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
        { id: 1265, name: 'Bronze pickaxe', count: 1, slot: 3 },
        { id: 995, name: 'Coins', count: 25, slot: 4 },
    ];
    let tick = 0;
    let hp = 8;
    const bank: any[] = [{ id: 434, name: 'Clay', count: 0 }];
    const calls: string[] = [];
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
        tick++;
        for (const cb of [...listeners]) cb();
    }, 1);
    const state: any = { player: { worldX: 3171, worldZ: 3396, level: 0 }, bank: { items: bank } };
    const s = {
        tick: () => tick,
        onTick: (cb: () => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        sdk: { getState: () => state, getInventory: () => inv, getSkill: () => ({ level: hp, baseLevel: 10 }) },
        direct: async (a: any) => {
            calls.push('eat');
            expect(a.slot).toBe(2);
            if (!refuseFood) {
                inv.splice(inv.findIndex(i => i.id === 2309), 1);
                hp = 10;
            }
            return { success: !refuseFood };
        },
        bot: {
            openBank: async () => ({ success: true }),
            closeBank: async () => ({ success: true }),
            depositItem: async (item: any) => {
                calls.push(`deposit:${item.id}`);
                bank[0].count += inv.filter(i => i.id === item.id).reduce((n, i) => n + i.count, 0);
                for (let i = inv.length - 1; i >= 0; i--) if (inv[i].id === item.id) inv.splice(i, 1);
                return { success: true };
            },
        },
    } as unknown as Session;
    const walk = async () => {
        calls.push('walk');
        state.player = { worldX: 3185, worldZ: 3436, level: 0 };
        return true;
    };
    return { s, inv, bank, calls, walk, close: () => clearInterval(timer) };
}

test('wounded owned 20 Clay recovery heals confirmed Bread before walk, banks raw only and preserves tools/coins', async () => {
    const f = recoveryFixture();
    try {
        const r = await retreatOre(f.s, { x: 3185, z: 3436 }, /^clay$/i, () => false, f.walk);
        expect(r).toMatchObject({ ok: true, banked: 20, held: 0, hp: 10 });
        expect(r.foods).toEqual([{ id: 2309, count: 1, hpBefore: 8, hpAfter: 10 }]);
        expect(f.calls).toEqual(['eat', 'walk', 'deposit:434']);
        expect(f.bank[0].count).toBe(20);
        expect(f.inv.map(i => [i.id, i.count])).toEqual([[1265, 1], [995, 25]]);
    } finally {
        f.close();
    }
});

test('unconfirmed food is bounded to 2 attempts; no alive session means no eat/walk/deposit', async () => {
    const f = recoveryFixture(true);
    try {
        const r = await retreatOre(f.s, { x: 3185, z: 3436 }, /^clay$/i, () => false, f.walk);
        expect(r.foods).toEqual([]);
        expect(f.calls.filter(c => c === 'eat')).toHaveLength(2);
        expect(f.inv.some(i => i.id === 2309)).toBe(true);
    } finally {
        f.close();
    }
    const g = recoveryFixture();
    try {
        await expect(retreatOre(g.s, { x: 3185, z: 3436 }, /^clay$/i, () => true, g.walk)).rejects.toThrow('no ore progress');
        expect(g.calls).toEqual([]);
    } finally {
        g.close();
    }
});

test('failed route or expired retreat cannot claim deposit or continue mining', async () => {
    const f = recoveryFixture();
    try {
        await expect(retreatOre(f.s, { x: 3185, z: 3436 }, /^clay$/i, () => false, async () => false)).rejects.toThrow('bounded safety retreat');
        expect(f.calls.some(c => c.startsWith('deposit'))).toBe(false);
        expect(f.inv.filter(i => i.id === 434).reduce((n, i) => n + i.count, 0)).toBe(20);
    } finally {
        f.close();
    }
    const g = recoveryFixture();
    try {
        await expect(
            retreatOre(g.s, { x: 3185, z: 3436 }, /^clay$/i, () => false, async () => {
                g.s.tick = () => 1000;
                return true;
            }),
        ).rejects.toThrow('bounded safety retreat');
        expect(g.calls.some(c => c.startsWith('deposit'))).toBe(false);
    } finally {
        g.close();
    }
    const dead = recoveryFixture();
    (dead.s.sdk as any).getSkill = () => ({ level: 0, baseLevel: 10 });
    try {
        await expect(retreatOre(dead.s, { x: 3185, z: 3436 }, /^clay$/i, () => false, dead.walk)).rejects.toThrow('died=true');
        expect(dead.calls).toEqual([]);
    } finally {
        dead.close();
    }
});

test('reconcileOrePickaxeAtBank selects, wields when Attack allows, and buys Nurmof upgrade when funded', async () => {
    let bankOpen = true;
    let shopOpen = false;
    let gen = 1;
    let tick = 0;
    const bank: any[] = [{ id: 1265, name: 'Bronze pickaxe', count: 1, slot: 0 }, { id: 995, name: 'Coins', count: 5000, slot: 1 }];
    const inv: any[] = [];
    const eq: any[] = [];
    const shopItems = [{ id: 1273, name: 'Mithril pickaxe', count: 2, buyPrice: 1300, slot: 0 }];
    let attack = 1;
    const walks: string[] = [];
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
        tick++;
        for (const cb of [...listeners]) cb();
    }, 1);

    const state: any = { bank: { isOpen: true, items: bank }, shop: { isOpen: false, shopItems } };
    const s: any = {
        tick: () => tick,
        onTick: (cb: () => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        bankObservation: () => (bankOpen ? { generation: gen, items: bank } : null),
        sdk: {
            getState: () => ({ ...state, inventory: inv, equipment: eq, bank: { isOpen: bankOpen, items: bank }, shop: { isOpen: shopOpen, shopItems } }),
            getInventory: () => inv,
            getEquipment: () => eq,
            getSkill: (n: string) => ({ level: n === 'Mining' ? 21 : attack, baseLevel: n === 'Attack' ? attack : 21 }),
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
                const held = inv.find(r => r.id === item.id);
                if (held && item.id === 995) held.count += n;
                else inv.push({ id: item.id, name: item.name, count: n });
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
        const rLow = await reconcileOrePickaxeAtBank(s, {
            bankSpot: { x: 3253, z: 3420 },
            stop: () => false,
            walkTo: async spot => {
                walks.push(`${spot.x},${spot.z}`);
                return true;
            },
        });
        expect(rLow).toEqual({ activeId: 1273, worn: false, bought: 1273 });
        expect(walks).toEqual(['2998,9844', '3253,3420']);
        expect(eq).toHaveLength(0);
        expect(inv.map(i => i.id)).toEqual([1273]);
        expect(bank.find(i => i.id === 995)?.count).toBe(5000 - 1300);
        expect(selectActiveOrePickaxe(s).current?.item.id).toBe(1273);

        attack = 20;
        const rHigh = await reconcileOrePickaxeAtBank(s, {
            bankSpot: { x: 3253, z: 3420 },
            stop: () => false,
            allowShop: false,
        });
        expect(rHigh.activeId).toBe(1273);
        expect(rHigh.worn).toBe(true);
        expect(eq[0]?.id).toBe(1273);
        expect(inv).toHaveLength(0);
    } finally {
        clearInterval(timer);
    }
});

test('reconcileOrePickaxeAtBank recovers coins when Nurmof shelf is empty, skips repeat trips for 700 ticks, and retries on restock or higher tier', async () => {
    let bankOpen = true;
    let shopOpen = false;
    let gen = 1;
    let tick = 100;
    let mining = 31;
    const bank: any[] = [{ id: 1265, name: 'Bronze pickaxe', count: 1, slot: 0 }, { id: 995, name: 'Coins', count: 40000, slot: 1 }];
    const inv: any[] = [];
    const eq: any[] = [];
    const shopItems = [
        { id: 1271, name: 'Adamant pickaxe', count: 0, buyPrice: 3200, slot: 0 },
        { id: 1275, name: 'Rune pickaxe', count: 0, buyPrice: 32000, slot: 1 },
    ];
    const walks: string[] = [];
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
        tick++;
        for (const cb of [...listeners]) cb();
    }, 2);

    const state: any = { bank: { isOpen: true, items: bank }, shop: { isOpen: false, shopItems } };
    const s: any = {
        tick: () => tick,
        onTick: (cb: () => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        bankObservation: () => (bankOpen ? { generation: gen, items: bank } : null),
        sdk: {
            getState: () => ({ ...state, inventory: inv, equipment: eq, bank: { isOpen: bankOpen, items: bank }, shop: { isOpen: shopOpen, shopItems } }),
            getInventory: () => inv,
            getEquipment: () => eq,
            getSkill: (n: string) => ({ level: n === 'Mining' ? mining : 1, baseLevel: n === 'Mining' ? mining : 1 }),
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
        const r1 = await reconcileOrePickaxeAtBank(s, { bankSpot: { x: 3253, z: 3420 }, stop: () => false, walkTo });
        expect(r1).toEqual({ activeId: 1265, worn: false, bought: undefined });
        expect(walks).toEqual(['2998,9844', '3253,3420']);
        expect(bank.find(i => i.id === 995)?.count).toBe(40000);
        expect(inv.filter(i => i.id === 995)).toHaveLength(0);

        tick += 50;
        const r2 = await reconcileOrePickaxeAtBank(s, { bankSpot: { x: 3253, z: 3420 }, stop: () => false, walkTo });
        expect(r2).toEqual({ activeId: 1265, worn: false, bought: undefined });
        expect(walks).toHaveLength(2);

        mining = 41;
        const r3 = await reconcileOrePickaxeAtBank(s, { bankSpot: { x: 3253, z: 3420 }, stop: () => false, walkTo });
        expect(r3).toEqual({ activeId: 1265, worn: false, bought: undefined });
        expect(walks).toEqual(['2998,9844', '3253,3420', '2998,9844', '3253,3420']);
        expect(bank.find(i => i.id === 995)?.count).toBe(40000);

        shopItems[1]!.count = 1;
        tick += 100;
        await reconcileOrePickaxeAtBank(s, { bankSpot: { x: 3253, z: 3420 }, stop: () => false, walkTo });
        expect(walks).toHaveLength(4);

        tick += 650;
        const r4 = await reconcileOrePickaxeAtBank(s, { bankSpot: { x: 3253, z: 3420 }, stop: () => false, walkTo });
        expect(r4).toEqual({ activeId: 1275, worn: false, bought: 1275 });
        expect(inv.map(i => i.id)).toEqual([1275]);
    } finally {
        clearInterval(timer);
    }
});

// --- At-site mining (formerly microbot-b-mining.test.ts) ---
const runiteProfile = () => miningProfiles().find(p => p.name === 'runite_rock_table')!;
const miningState = () =>
    ({
        player: { worldX: 3000, worldZ: 3500, level: 0, lifeId: 1 },
        skills: [{ name: 'Mining', level: 85, experience: 1000 }, { name: 'Hitpoints', level: 99 }],
        inventory: [{ id: 1275, count: 1, slot: 0 }],
        equipment: [],
        nearbyPlayers: [],
        nearbyLocs: [{ id: runiteProfile().rocks[0], x: 3001, z: 3500, level: 0, distance: 1, optionsWithIndex: [{ text: 'Mine', opIndex: 1 }] }],
    }) as unknown as BotWorldState;

test('native profiles resolve remaining metals, gems, limestone and perfect gold without gas/approval nodes', () => {
    const profiles = miningProfiles();
    for (const name of [
        'coal_rock_table',
        'gold_rock_table',
        'silver_rock_table',
        'mithril_rock_table',
        'adamantite_rock_table',
        'runite_rock_table',
        'blurite_rock',
        'gem_rock',
        'desertrescue_rock',
        'limestone_rock1',
        'limestone_rock2',
        'limestone_rock3',
        'perfect_gold_rock_table',
    ]) {
        const p = profiles.find(p => p.name === name)!;
        expect(p.rocks.length).toBeGreaterThan(0);
        expect(p.products.length).toBeGreaterThan(0);
    }
    expect(runiteProfile().level).toBe(85);
    expect(profiles.find(p => p.name === 'gem_rock')!.products.length).toBe(7);
    const s = miningState();
    expect(eligiblePickaxe(s)?.id).toBe(1275);
    s.skills[0]!.level = 40;
    expect(eligiblePickaxe(s)).toBeUndefined();
    s.inventory[0]!.id = 1265;
    expect(eligiblePickaxe(s)?.id).toBe(1265);
    s.inventory = [];
    s.equipment = [{ id: 1275, slot: 5, count: 1 } as any];
    s.skills[0]!.level = 99;
    expect(eligiblePickaxe(s)).toBeUndefined();
    s.equipment[0]!.slot = 3;
    expect(eligiblePickaxe(s)?.id).toBe(1275);
});

test('mine selection requires exact reachable floor, Mine 1 and no nearby competing player', () => {
    const s = miningState();
    expect(selectMiningRock(s, runiteProfile())?.id).toBe(runiteProfile().rocks[0]!);
    s.nearbyPlayers = [{ x: 3001, z: 3500 } as any];
    expect(selectMiningRock(s, runiteProfile())).toBeUndefined();
    s.nearbyPlayers = [];
    s.nearbyLocs[0]!.level = 1;
    expect(selectMiningRock(s, runiteProfile())).toBeUndefined();
    s.player!.worldX = 2736;
    s.player!.worldZ = 9684;
    expect(inPerfectMine(s)).toBe(true);
});

test('mining receipt distinguishes XP-producing ore, XP-free incidental gem and unexplained stock loss', () => {
    const b = miningState();
    const a = structuredClone(b);
    a.inventory.push({ id: runiteProfile().products[0]!, count: 1, slot: 1 } as any);
    expect(miningEffect(runiteProfile(), b, a)).toBeNull();
    a.skills[0]!.experience += 125;
    expect(miningEffect(runiteProfile(), b, a)).toEqual({ kind: 'ore', id: runiteProfile().products[0]! });
    const gem = structuredClone(b);
    gem.inventory.push({ id: 1623, count: 1, slot: 1 } as any);
    expect(miningEffect(runiteProfile(), b, gem)).toEqual({ kind: 'incidental', id: 1623 });
    a.inventory[0]!.count = 0;
    expect(() => miningEffect(runiteProfile(), b, a)).toThrow('inventory');
});

test('finite at-site worker retains side gems and counts only own ore+XP', async () => {
    let current = miningState();
    let tick = 0;
    let dispatch = 0;
    let rolls = 0;
    const d: MiningDriver = {
        state: () => current,
        tick: () => tick,
        stop: () => false,
        mine: async () => {
            dispatch++;
            return true;
        },
        step: async () => {
            tick++;
        },
        wait: async testFn => {
            rolls++;
            current = structuredClone(current);
            current.inventory.push({ id: rolls === 1 ? 1623 : runiteProfile().products[0]!, count: 1, slot: rolls } as any);
            if (rolls > 1) current.skills[0]!.experience += 125;
            return testFn();
        },
    };
    expect(await runAtSiteMining(d, runiteProfile(), { maximum: 1, cap: 100, idleTicks: 50 })).toMatchObject({ made: 1, sideGems: 1, attempts: 1, banked: 0, xp: 125 });
    expect(dispatch).toBe(1);
});

test('a depleted rock without own ore/XP does not count; stop prevents action', async () => {
    let current = miningState();
    let tick = 0;
    let dispatch = 0;
    const d: MiningDriver = {
        state: () => current,
        tick: () => tick,
        stop: () => false,
        mine: async () => {
            dispatch++;
            return true;
        },
        step: async () => {
            tick++;
        },
        wait: async testFn => {
            current = { ...current, nearbyLocs: [] };
            return testFn();
        },
    };
    await expect(runAtSiteMining(d, runiteProfile(), { maximum: 1, cap: 100, idleTicks: 3 })).rejects.toThrow('no useful ore');
    expect(dispatch).toBe(1);
    await expect(runAtSiteMining({ ...d, stop: () => true }, runiteProfile(), { maximum: 1, cap: 100, idleTicks: 3 })).rejects.toThrow('stopped');
    expect(dispatch).toBe(1);
});

test('equipUsablePickaxeInPack equips higher carried pickaxe only when Attack meets wield level', async () => {
    const eq: any[] = [];
    const lowSession = {
        sdk: { getSkill: (n: string) => ({ level: n === 'Mining' ? 41 : 1, baseLevel: n === 'Attack' ? 1 : 41 }), getInventory: () => [{ id: 1275, name: 'Rune pickaxe', count: 1 }], getEquipment: () => eq },
        bot: {
            equipItem: async (i: any) => {
                eq.push({ ...i, slot: 3 });
            },
        },
    };
    expect(await equipUsablePickaxeInPack(lowSession)).toBe(false);
    expect(eq).toHaveLength(0);

    const highSession = {
        sdk: { getSkill: (n: string) => ({ level: n === 'Mining' ? 41 : 40, baseLevel: n === 'Attack' ? 40 : 41 }), getInventory: () => [{ id: 1275, name: 'Rune pickaxe', count: 1 }], getEquipment: () => eq },
        bot: {
            equipItem: async (i: any) => {
                eq.push({ ...i, slot: 3 });
            },
        },
    };
    expect(await equipUsablePickaxeInPack(highSession)).toBe(true);
    expect(eq[0]?.id).toBe(1275);
});

// --- Visible ground loot (formerly microbot-b-mining-loot.test.ts) ---
const lootPolicy: LootPolicy = { mode: 'list', ids: [561], names: [], minimumValue: 1, maximumValue: 100000, radius: 2, maximumUnits: 3, cap: 100, idleTicks: 10 };
const lootState = () =>
    ({
        player: { worldX: 3000, worldZ: 3500, level: 0, lifeId: 1 },
        skills: [{ name: 'Hitpoints', level: 10 }],
        equipment: [],
        inventory: [{ id: 995, count: 9, slot: 0 }],
        nearbyPlayers: [],
        groundItems: [{ id: 561, name: 'Nature rune', count: 3, x: 3001, z: 3500, distance: 1, reachable: true }],
    }) as unknown as BotWorldState;

test('ground selection combines exact IDs/names with explicitly static pile value', () => {
    const s = lootState();
    const definition = () => ({ cost: 180, stackable: true });
    expect(selectGroundLoot(s, lootPolicy, definition)?.value).toBe(540);
    expect(selectGroundLoot(s, { ...lootPolicy, ids: [], names: ['nature rune'] }, definition)?.item.id).toBe(561);
    expect(selectGroundLoot(s, { ...lootPolicy, ids: [], names: ['rune'] }, definition)).toBeUndefined();
    expect(selectGroundLoot(s, { ...lootPolicy, mode: 'value', minimumValue: 541 }, definition)).toBeUndefined();
    expect(selectGroundLoot(s, { ...lootPolicy, mode: 'mixed', ids: [], names: [] }, definition)?.item.id).toBe(561);
    s.nearbyPlayers = [{ x: 3001, z: 3500 } as any];
    expect(selectGroundLoot(s, lootPolicy, definition)).toBeUndefined();
});

test('capacity distinguishes full-pack existing stacks from nonstackable piles', () => {
    const s = lootState();
    const i = s.groundItems[0]!;
    s.inventory = Array.from({ length: 28 }, (_, slot) => ({ id: slot === 0 ? 561 : 1000 + slot, count: 1, slot } as any));
    expect(lootCapacity(s, i, { cost: 1, stackable: true })).toBe(true);
    expect(lootCapacity(s, i, { cost: 1, stackable: false })).toBe(false);
    s.inventory = s.inventory.slice(0, 26);
    expect(lootCapacity(s, i, { cost: 1, stackable: false })).toBe(false);
    s.inventory.pop();
    expect(lootCapacity(s, i, { cost: 1, stackable: false })).toBe(true);
});

test('own inventory receipt rejects disappearance alone and unrelated asset loss', () => {
    const b = lootState();
    const a = structuredClone(b);
    a.groundItems = [];
    expect(groundLootEffect(b, a, b.groundItems[0]!)).toBe(false);
    a.inventory.push({ id: 561, count: 3, slot: 1 } as any);
    expect(groundLootEffect(b, a, b.groundItems[0]!)).toBe(true);
    a.inventory[0]!.count--;
    expect(() => groundLootEffect(b, a, b.groundItems[0]!)).toThrow('reconcile');
});

test('finite pickup reports held output and refuses a contested disappearance', async () => {
    let current = lootState();
    let tick = 0;
    let actions = 0;
    const d: LootDriver = {
        state: () => current,
        tick: () => tick,
        stop: () => false,
        definition: () => ({ cost: 180, stackable: true }),
        pickup: async () => {
            actions++;
            current = structuredClone(current);
            current.inventory.push({ id: 561, count: 3, slot: 1 } as any);
            current.groundItems = [];
            return true;
        },
        wait: async testFn => testFn(),
        step: async () => {
            tick++;
        },
    };
    expect(await runVisibleGroundLoot(d, lootPolicy)).toMatchObject({ units: 3, pickups: 1, acquired: { 561: 3 }, staticValue: 540, banked: 0 });
    expect(actions).toBe(1);
    current = lootState();
    await expect(
        runVisibleGroundLoot(
            {
                ...d,
                pickup: async () => {
                    current = { ...current, groundItems: [] };
                    return true;
                },
            },
            lootPolicy,
        ),
    ).rejects.toThrow('without own inventory');
});

test('skips a pickup address whose same-ID piles have different counts', () => {
    const s = lootState();
    const first = s.groundItems[0]!;
    const definition = () => ({ cost: 180, stackable: true });
    s.groundItems.push({ ...first, count: 16 });
    expect(selectGroundLoot(s, lootPolicy, definition)).toBeUndefined();
    s.groundItems[1]!.count = first.count;
    expect(selectGroundLoot(s, lootPolicy, definition)?.item.count).toBe(first.count);
});

test('optional name globs select whole names and ignores beat each policy branch', () => {
    const s = lootState();
    const definition = () => ({ cost: 180, stackable: true });
    expect(selectGroundLoot(s, { ...lootPolicy, ids: [], nameGlobs: ['N?ture *'] }, definition)?.item.id).toBe(561);
    expect(selectGroundLoot(s, { ...lootPolicy, ids: [], nameGlobs: ['rune'] }, definition)).toBeUndefined();
    for (const mode of ['list', 'value', 'mixed'] as const) {
        expect(selectGroundLoot(s, { ...lootPolicy, mode, ignoredIds: [561] }, definition)).toBeUndefined();
        expect(selectGroundLoot(s, { ...lootPolicy, mode, ignoredNames: ['NATURE RUNE'] }, definition)).toBeUndefined();
        expect(selectGroundLoot(s, { ...lootPolicy, mode, ignoredNameGlobs: ['* rune'] }, definition)).toBeUndefined();
    }
});

test('capacity refuses unknown metadata and overflowing stack merges', () => {
    const s = lootState();
    const item = s.groundItems[0]!;
    expect(lootCapacity(s, item, undefined as any)).toBe(false);
    s.inventory = [{ id: 561, count: 2147483646, slot: 0 } as any];
    expect(lootCapacity(s, item, { cost: 1, stackable: true })).toBe(false);
    expect(lootCapacity(s, { ...item, count: 1 }, { cost: 1, stackable: true })).toBe(true);
});

// --- Drop mining (formerly microbot-mining-drop.test.ts) ---
const iron = () => miningProfiles().find(p => p.name === 'iron_rock_table')!;

function dropFixture(mode: 'normal' | 'lost' | 'unknown' | 'foreign' = 'normal') {
    let tick = 0;
    let drops = 0;
    let mines = 0;
    let s: any = {
        player: { worldX: 3000, worldZ: 3500, level: 0, lifeId: 1 },
        skills: [{ name: 'Mining', level: 99, experience: 0 }, { name: 'Hitpoints', level: 99 }],
        inventory: [
            { id: 1275, count: 1, slot: 0 },
            ...Array.from({ length: 26 }, (_, i) => ({ id: 440, count: 1, slot: i + 1, optionsWithIndex: [{ text: 'Drop', opIndex: 5 }] })),
        ],
        equipment: [],
        nearbyPlayers: [],
        nearbyLocs: [{ id: iron().rocks[0], x: 3001, z: 3500, level: 0, distance: 1, optionsWithIndex: [{ text: 'Mine', opIndex: 1 }] }],
    };
    const d: MiningDropDriver = {
        state: () => s,
        tick: () => tick,
        stop: () => false,
        drop: async slot => {
            drops++;
            if (mode === 'unknown') return false;
            s = structuredClone(s);
            s.inventory = s.inventory.filter((i: any) => i.slot !== slot);
            if (mode === 'foreign') s.inventory[0].count++;
            if (mode === 'lost') throw Error('lost reply');
            return true;
        },
        mine: async () => {
            mines++;
            return true;
        },
        wait: async testFn => {
            tick++;
            if (mines && drops >= 26) {
                s = structuredClone(s);
                s.inventory.push({ id: 440, count: 1, slot: s.inventory.length, optionsWithIndex: [{ text: 'Drop', opIndex: 5 }] });
                s.skills[0].experience += 35;
            }
            return testFn();
        },
        step: async () => {
            tick++;
        },
    };
    return { d, stats: () => ({ drops, mines, s }) };
}

test('drop mode preserves configured pickaxe, resumes existing miner and reconciles all discarded units', async () => {
    const f = dropFixture();
    const r = await runDropMining(f.d, iron(), { maximum: 2, cap: 100, idleTicks: 50, keep: [1275] });
    expect(r).toMatchObject({ made: 2, xp: 70, dropped: { 440: 26 }, outputs: { 440: 2 }, banked: 0 });
    expect(f.stats().drops).toBe(26);
    expect(f.stats().mines).toBe(2);
    expect(f.stats().s.inventory[0].id).toBe(1275);
});

test('lost drop reply uses one exact receipt while unknown and foreign deltas never retry', async () => {
    const lost = dropFixture('lost');
    expect((await runDropMining(lost.d, iron(), { maximum: 1, cap: 100, idleTicks: 50, keep: [1275] })).made).toBe(1);
    for (const mode of ['unknown', 'foreign'] as const) {
        const f = dropFixture(mode);
        await expect(runDropMining(f.d, iron(), { maximum: 1, cap: 100, idleTicks: 50, keep: [1275] })).rejects.toThrow('unconfirmed');
        expect(f.stats().drops).toBe(1);
        expect(f.stats().mines).toBe(0);
    }
});

test('retained-only pack, custom fifth action and omitted owned pickaxe stop before spending input', async () => {
    const f = dropFixture();
    await expect(runDropMining(f.d, iron(), { maximum: 1, cap: 100, idleTicks: 50, keep: [] })).rejects.toThrow('pickaxe');
    await expect(runDropMining(f.d, iron(), { maximum: 1, cap: 100, idleTicks: 50, keep: [1275, 440] })).rejects.toThrow('only retained');
    expect(f.stats().drops).toBe(0);
    f.stats().s.inventory[1].optionsWithIndex = [{ text: 'Destroy', opIndex: 5 }];
    await expect(runDropMining(f.d, iron(), { maximum: 1, cap: 100, idleTicks: 50, keep: [1275] })).rejects.toThrow('Drop');
    expect(f.stats().drops).toBe(0);
});

test('ordinary native ore omits generic Drop from object-specific menu yet uses dedicated drop receipt', async () => {
    const f = dropFixture();
    for (const i of f.stats().s.inventory) i.optionsWithIndex = [];
    expect((await runDropMining(f.d, iron(), { maximum: 1, cap: 100, idleTicks: 50, keep: [1275] })).dropped[440]).toBe(26);
    expect(f.stats().drops).toBe(26);
});

// --- Progressive mining (formerly microbot-mining-progressive.test.ts) ---
test('progressive donor tiers follow native levels instead of the modern rock enum', () => {
    for (const [level, name] of [
        [1, 'tin'],
        [14, 'tin'],
        [15, 'iron'],
        [29, 'iron'],
        [30, 'coal'],
        [40, 'gold'],
        [55, 'mithril'],
        [70, 'adamantite'],
        [85, 'runite'],
        [99, 'runite'],
    ] as const) {
        expect(progressiveMiningProfile(level).name).toBe(`${name}_rock_table`);
    }
    expect(() => progressiveMiningProfile(0)).toThrow('level');
    expect(() => progressiveMiningProfile(100)).toThrow('level');
});

test('an unlocked tier without an explicit native route stops before moving or mining', async () => {
    const s: any = { name: 'miner', sdk: { getState: () => ({ player: { lifeId: 1, respawnCount: 0 } }), getSkill: (n: string) => ({ level: n === 'Mining' ? 85 : 99 }) }, tick: () => 0 };
    await expect(
        runProgressiveMining(s, {
            maximum: 2,
            batch: 1,
            cap: 1000,
            returnTicks: 100,
            travelTicks: 100,
            members: true,
            mode: 'bank',
            routes: [{ profile: 'tin_rock_table', tool: 1265, bank: { x: 3253, z: 3420, level: 0 }, site: { x: 3286, z: 3368, level: 0 } }],
        }),
    ).rejects.toThrow('runite_rock_table');
});

// --- Mining knife rotation (formerly mining-rotation.test.ts) ---
const IRON_ORE = iron().products[0]!;
const MAKE1 = 99;

test('server numbers: respawn scaling, the knife delay and the first swing', () => {
    expect(respawnTicks(20, 1)).toBe(19);
    expect(respawnTicks(20, 1400)).toBe(13);
    expect(respawnTicks(20, 5000)).toBe(10);
    expect(knifeDelay(5, 10)).toBe(12);
    expect(knifeDelay(10, 10)).toBe(10);
    expect(knifeDelay(12, 10)).toBe(12);
    expect(firstRoll(5, 10, 2)).toEqual({ roll: 12, delay: 12 });
    expect(firstRoll(10, 10, 2)).toEqual({ roll: 10, delay: 10 });
    expect(firstRoll(11, 10, 6)).toEqual({ roll: 11, delay: 11 });
    expect(oreLag(iron())).toBe(0);
    expect(oreLag(miningProfiles().find(p => p.name === 'coal_rock_table')!)).toBe(1);
});

test('the Ardougne zoo site has its six iron rocks from the map files, and every iron site is found', () => {
    const zoo = MINING_SITES.find(s => s.key === 'ardougne-zoo-iron')!;
    expect(siteRocks(iron(), zoo.center, zoo.radius).map(r => `${r.x},${r.z}`)).toEqual(['2602,3233', '2602,3234', '2602,3236', '2605,3233', '2605,3235', '2605,3237']);
    expect(siteTiles(iron(), MINING_SITES.find(s => s.key === 'ardougne-zoo-iron-9')!).map(r => `${r.x},${r.z}`).slice(6)).toEqual(['2590,3230', '2591,3232', '2592,3234']);
    const sites = contentSites(iron());
    expect(sites.some(s => s.rocks.length === 6 && s.rocks.some(r => r.x === 2602 && r.z === 3233))).toBe(true);
    expect(sites.reduce((n, s) => n + s.rocks.length, 0)).toBe(siteRocks(iron(), { x: 0, z: 0, level: 0 }, 99999).length);
    expect(standTiles({ x: 2602, z: 3233, level: 0 }, siteRocks(iron(), zoo.center, zoo.radius)).map(t => `${t.x},${t.z}`)).toEqual(['2603,3233', '2601,3233', '2602,3232']);
});

test('the Wilderness hobgoblin mine: eight rocks, and the path to a stand tile goes round the block of rocks', () => {
    const rocks = siteTiles(iron(), MINING_SITES.find(s => s.key === 'wilderness-hobgoblin-iron')!);
    expect(rocks.map(r => `${r.x},${r.z}`)).toEqual(['3099,3765', '3099,3766', '3099,3767', '3099,3768', '3100,3765', '3100,3766', '3101,3765', '3101,3768']);
    expect(pathSteps({ x: 3100, z: 3768 }, rocks[1]!, rocks)).toBe(6);
    expect(pathSteps({ x: 3100, z: 3767 }, rocks[2]!, rocks)).toBe(0);
    expect(pathSteps({ x: 3100, z: 3767 }, rocks[7]!, rocks)).toBe(1);
});

function rotationSim(o: { rate: number; respawn: number; rocks: MiningRotationTile[]; start: { x: number; z: number }; dropLag?: number }) {
    let lagged: { at: number; slot: number }[] = [];
    const rocks = o.rocks.map(r => ({ ...r, up: true, back: 0 }));
    let tick = 0;
    let delay = -1;
    let xp = 0;
    let pending: MiningAction[] = [];
    let fletches = 0;
    let dialog = false;
    let close = false;
    let levelUp = false;
    let opensAt = -1;
    let ores = 0;
    let pos = { ...o.start };
    let target: { x: number; z: number } | undefined;
    let interaction: { rock: (typeof rocks)[number]; first: boolean } | undefined;
    let weak: number | undefined;
    const inv: ({ id: number; count: number } | undefined)[] = [{ id: 1275, count: 1 }, { id: KNIFE, count: 1 }, { id: NORMAL_LOGS, count: 1 }];
    const beside = (r: MiningRotationTile) => Math.abs(pos.x - r.x) + Math.abs(pos.z - r.z) === 1;
    const clear = () => {
        interaction = undefined;
        weak = undefined;
        dialog = false;
        levelUp = false;
    };
    const roll = (r: (typeof rocks)[number]) => {
        r.up = false;
        r.back = tick + o.respawn;
        const free = inv.findIndex(i => !i);
        if (free >= 0) inv[free] = { id: IRON_ORE, count: 1 };
        else inv.push({ id: IRON_ORE, count: 1 });
        xp += 875;
        interaction = undefined;
        if (++ores % 8 === 0) opensAt = tick + 1;
    };
    const op = () => {
        const it = interaction!;
        if (!it.rock.up) {
            interaction = undefined;
            return;
        }
        if (it.first) {
            if (delay < tick) delay = tick + o.rate;
            else if (delay === tick) roll(it.rock);
            else it.first = false;
            return;
        }
        if (delay < tick) delay = tick + o.rate;
        else if (delay === tick) roll(it.rock);
    };
    const step = () => {
        tick++;
        for (const a of pending) {
            if (a.type === 'dropItem') {
                if (o.dropLag) lagged.push({ at: tick + o.dropLag, slot: a.slot });
                else inv[a.slot] = undefined;
            } else if (a.type === 'useItemOnItem') {
                clear();
                dialog = true;
            } else if (a.type === 'clickComponent' && dialog) {
                dialog = false;
                if (delay < tick) delay = tick + 2;
                weak = tick + 2;
            } else if (a.type === 'interactLoc') {
                clear();
                const r = rocks.find(r => r.x === a.x && r.z === a.z)!;
                interaction = { rock: r, first: true };
                target = standTiles(r, rocks).sort(
                    (p, q) => Math.max(Math.abs(p.x - pos.x), Math.abs(p.z - pos.z)) - Math.max(Math.abs(q.x - pos.x), Math.abs(q.z - pos.z)),
                )[0];
            } else if (a.type === 'walkTo') {
                clear();
                target = { x: a.x, z: a.z };
            } else if (a.type === 'closeModal') close = true;
        }
        pending = [];
        for (const l of lagged.filter(l => l.at <= tick)) inv[l.slot] = undefined;
        lagged = lagged.filter(l => l.at > tick);
        if (close) {
            weak = undefined;
            close = false;
            levelUp = false;
        }
        if (opensAt === tick) levelUp = true;
        if (weak === tick) {
            weak = undefined;
            const l = inv.findIndex(i => i?.id === NORMAL_LOGS);
            if (l >= 0) {
                inv[l] = undefined;
                fletches++;
            }
        }
        if (!levelUp) {
            if (interaction && beside(interaction.rock)) op();
            else {
                for (let k = 0; k < 2 && target && (pos.x !== target.x || pos.z !== target.z); k++) {
                    pos = { x: pos.x + Math.sign(target.x - pos.x), z: pos.z + Math.sign(target.z - pos.z) };
                }
            }
        }
        for (const r of rocks) if (!r.up && r.back === tick) r.up = true;
    };
    const state = () =>
        ({
            player: { worldX: pos.x, worldZ: pos.z, level: 0, lifeId: 1 },
            skills: [{ name: 'Mining', level: 64, experience: xp }, { name: 'Hitpoints', level: 10 }],
            inventory: inv.flatMap((i, slot) => (i ? [{ ...i, slot }] : [])),
            equipment: [],
            nearbyPlayers: [],
            dialog: { isOpen: levelUp },
            interface: { isOpen: false },
            nearbyLocs: rocks.map(r => ({ id: r.up ? iron().rocks[0] : 450, x: r.x, z: r.z, level: 0, distance: 0, optionsWithIndex: r.up ? [{ text: 'Mine', opIndex: 1 }] : [] })),
        }) as unknown as BotWorldState;
    const d: MiningDriver = {
        state,
        tick: () => tick,
        stop: () => false,
        mine: async () => true,
        wait: async () => true,
        step: async () => step(),
        send: async a => {
            pending.push(...a);
        },
    };
    return { d, fletches: () => fletches };
}

const ZOO: MiningRotationTile[] = [{ x: 0, z: 0 }, { x: 0, z: 1 }, { x: 0, z: 3 }, { x: 3, z: 0 }, { x: 3, z: 2 }, { x: 3, z: 4 }].map(t => ({ ...t, level: 0 }));
const runRot = async (knife: boolean, rate: number, respawn: number, rocks = ZOO, maximum = 60, dropLag = 0) => {
    const s = rotationSim({ rate, respawn, rocks, start: { x: 1, z: 1 }, dropLag });
    const r = (await runAtSiteMining(s.d, iron(), { maximum, cap: 5000, idleTicks: 500, rotation: { knife, drop: true, make1: MAKE1, players: 1, rocks } })) as any;
    return { per: (r.rolls.at(-1) - r.rolls[0]) / (r.rolls.length - 1), r, fletches: s.fletches() };
};

test('rune pickaxe, plenty of rocks: 3 ticks an ore with the knife, over 4 without; the pack stays open', async () => {
    const plain = await runRot(false, 2, 4);
    const knife = await runRot(true, 2, 4);
    expect(knife.per).toBeCloseTo(3, 2);
    expect(plain.per).toBeGreaterThan(4);
    for (const x of [plain, knife]) {
        expect(x.r.made).toBe(60);
        expect(x.r.dropped).toBeGreaterThan(30);
        expect(x.fletches).toBe(0);
    }
});

test('adamant pickaxe (mining_rate 3): the knife holds 3 ticks an ore, plain mining takes over 5', async () => {
    expect((await runRot(false, 3, 4)).per).toBeGreaterThan(5);
    expect((await runRot(true, 3, 4)).per).toBeCloseTo(3, 2);
});

test('respawn 19 on six rocks: the knife cut 2 ticks before the respawn makes the click roll at once', async () => {
    const plain = await runRot(false, 2, 19, ZOO, 90);
    const knife = await runRot(true, 2, 19, ZOO, 90);
    expect(knife.per).toBeLessThan(plain.per);
    expect(knife.per).toBeLessThanOrEqual(20 / 6);
    expect(knife.r.preArms).toBeGreaterThan(5);
    expect(knife.fletches).toBe(0);
    expect(knife.r.respawn).toBe(19);
});

test('nine rocks with a 6-tick walk between the groups are no slower than six', async () => {
    const NINE = [...ZOO, ...[{ x: -12, z: -3 }, { x: -11, z: -1 }, { x: -10, z: 1 }].map(t => ({ ...t, level: 0 }))];
    const six = await runRot(true, 2, 18, ZOO, 90);
    const nine = await runRot(true, 2, 18, NINE, 90);
    expect(nine.per).toBeLessThanOrEqual(six.per + 0.01);
    expect(nine.fletches).toBe(0);
});

test('a drop that shows two ticks late is a drop, not a lost item; each slot drops once while it is pending', async () => {
    const x = await runRot(true, 2, 4, ZOO, 60, 2);
    expect(x.r.made).toBe(60);
    expect(x.r.dropped).toBeGreaterThan(30);
    expect(x.per).toBeLessThan(3.2);
});

// --- Lava maze escorted ore (formerly lava-maze-escorted-ore.test.ts) ---
const escortNames = ['Escort', 'Miner'];
const escortRoster = (x = 3060, z = 3883): RosterPlayer[] => [[1, escortNames[0]!, x, z, 0, 75], [2, escortNames[1]!, 3094, 3492, 0, 29]];

test('native title-cased fixture rows survive identity filtering without changing native fields', () => {
    const rows: RosterPlayer[] = [[1, 'Lvax1ft00', 3094, 3492, 0, 75], [2, 'Lvax1ft11', 3094, 3491, 0, 29], [3, 'Foreign', 3060, 3883, 0, 100]];
    const filtered = filterFixtureRoster(rows, ['lvax1ft00', 'lvax1ft11']);
    expect(filtered).toEqual(rows.slice(0, 2));
    expect(filtered[0]).toBe(rows[0]);
    expect(filtered[1]).toBe(rows[1]);
});

const entryParticipants = () => escortNames.map((name, i) => ({ name: name.toLowerCase(), player: { worldX: 3094, worldZ: 3492, level: 0, combatLevel: i === 0 ? 75 : 29 } }));
function entryClock() {
    let tick = 0;
    const listeners = new Set<() => void>();
    return {
        sdk: { getState: () => ({}) },
        tick: () => tick,
        onTick: (cb: () => void) => {
            listeners.add(cb);
            return () => {
                listeners.delete(cb);
            };
        },
        advance: () => {
            tick++;
            for (const cb of listeners) cb();
        },
        listening: () => listeners.size,
    };
}

test('saved adjacent-only Native frames cannot admit; exact local state needs a matching frame', () => {
    const frames = [60, 70, 80].map(k => ({ k, p: [[1, 'Lvax91r00', 3094, 3491, 0, 75], [2, 'Lvax91r11', 3094, 3491, 0, 29]] as RosterPlayer[] }));
    const feed = new RosterEvidence();
    for (const f of frames) {
        feed.accept({ t: 'roster', ...f }, f.k);
        const participants = f.p.map(row => ({ name: row[1].toLowerCase(), player: { worldX: row[2], worldZ: row[3], level: row[4], combatLevel: row[5] } }));
        expect(entryRosterReady(feed.fresh(f.k), participants)).toBe(false);
        participants.forEach(p => {
            p.player.worldZ = 3492;
        });
        expect(entryRosterReady(feed.fresh(f.k), participants)).toBe(false);
        const exact = { tick: 90, at: 90, roster: f.p.map(row => [row[0], row[1], 3094, 3492, 0, row[5]] as RosterPlayer) };
        expect(entryRosterReady(exact, participants)).toBe(true);
    }
});

function bankWalker(move = true) {
    const clock = entryClock();
    const position = { x: 3094, z: 3491, level: 0 };
    const clicks: number[][] = [];
    const walker: PathDeps = {
        ...clock,
        pos: () => position,
        locs: () => [],
        plan: (_level, _from, to) => [to],
        interactLoc: () => {},
        walk: (x, z) => {
            clicks.push([x, z]);
            if (move) {
                position.x = x;
                position.z = z;
            }
        },
    };
    return { clock, position, clicks, walker };
}

test('safe bank alignment confirms exact observed arrival, not dispatch alone', async () => {
    const f = bankWalker();
    const result = alignAtBank(f.walker, () => false);
    f.clock.advance();
    expect(await result).toBe(true);
    expect(f.position).toEqual({ x: 3094, z: 3492, level: 0 });
    const stuck = bankWalker(false);
    const pending = alignAtBank(stuck.walker, () => false);
    for (let i = 0; i < 13; i++) stuck.clock.advance();
    expect(await pending).toBe(false);
    expect(stuck.position.z).toBe(3491);
});

test('safe positioning refuses owner, life and budget gates without leaving Edgeville', async () => {
    for (const gate of ['owner', 'life', 'budget', 'local-area']) {
        const f = bankWalker(false);
        if (gate === 'local-area') f.position.level = 1;
        expect(await alignAtBank(f.walker, () => gate !== 'local-area')).toBe(false);
        expect(f.clicks).toEqual([]);
        expect(f.position.x).toBe(3094);
        expect(f.position.z).toBe(3491);
    }
    const f = bankWalker(false);
    let refused = false;
    const result = alignAtBank(f.walker, () => refused);
    const count = f.clicks.length;
    refused = true;
    f.clock.advance();
    expect(await result).toBe(false);
    f.clock.advance();
    expect(f.clicks.length).toBe(count);
    expect(f.position.z).toBe(3491);
});

test('entry wait stays pending through startup frames, then accepts the first matching frame', async () => {
    const clock = entryClock();
    const feed = new RosterEvidence();
    let moved = false;
    const result = waitForRosterEntry(clock, () => feed.fresh(clock.tick() * 100), entryParticipants, () => !!feed.failure).then(ok => {
        moved = ok;
        return ok;
    });
    for (const [i, rows] of [[], escortRoster()].entries()) {
        feed.accept({ t: 'roster', k: (i + 1) * 10, p: rows }, clock.tick() * 100);
        clock.advance();
        await Promise.resolve();
        expect(moved).toBe(false);
        expect(clock.listening()).toBe(1);
    }
    feed.accept({ t: 'roster', k: 30, p: escortRoster(3094, 3492) }, clock.tick() * 100);
    clock.advance();
    expect(await result).toBe(true);
    expect(moved).toBe(true);
    expect(clock.tick()).toBe(3);
    expect(clock.listening()).toBe(0);
});

test('entry consumes one 40-tick budget when participants never appear', async () => {
    const clock = entryClock();
    const feed = new RosterEvidence();
    feed.accept({ t: 'roster', k: 10, p: [] }, 0);
    const result = waitForRosterEntry(clock, () => feed.fresh(clock.tick() * 100), entryParticipants, () => !!feed.failure);
    for (let i = 0; i < 39; i++) clock.advance();
    expect(clock.listening()).toBe(1);
    clock.advance();
    expect(await result).toBe(false);
    expect(clock.tick()).toBe(40);
    expect(clock.listening()).toBe(0);
});

test('entry refuses malformed feed, a threat, or an owner or account gate without waiting for participants', async () => {
    for (const kind of ['malformed', 'threat', 'hold', 'death', 'budget']) {
        const clock = entryClock();
        const feed = new RosterEvidence();
        let gate = false;
        const refused = () => gate || !!feed.failure || !!corridorThreat(feed.fresh(clock.tick() * 100)?.roster ?? [], new Set(escortNames.map(n => n.toLowerCase())), [[3060, 3883]], 75);
        const result = waitForRosterEntry(clock, () => feed.fresh(clock.tick() * 100), entryParticipants, refused);
        feed.accept({ t: 'roster', k: 10, p: kind === 'malformed' ? [[1, 'Bad', 1]] : kind === 'threat' ? [[3, 'Enemy', 3060, 3883, 0, 100]] : [] }, 0);
        gate = ['hold', 'death', 'budget'].includes(kind);
        clock.advance();
        expect(await result).toBe(false);
        expect(clock.tick()).toBe(1);
        expect(clock.listening()).toBe(0);
    }
});

test('empty and previous entry frames cannot release movement; the first matching frame can', () => {
    const feed = new RosterEvidence();
    const participants = entryParticipants();
    expect(entryRosterReady(feed.fresh(0), participants)).toBe(false);
    for (const [i, rows] of [
        [],
        escortRoster(),
        escortRoster(3094, 3492).slice(0, 1),
        escortRoster(3094, 3492).map(p => [...p.slice(0, 4), 1, p[5]] as RosterPlayer),
        escortRoster(3094, 3492).map(p => [...p.slice(0, 5), 100] as RosterPlayer),
    ].entries()) {
        feed.accept({ t: 'roster', k: (i + 1) * 10, p: rows }, i * 100);
        expect(entryRosterReady(feed.fresh(i * 100), participants)).toBe(false);
        expect(feed.failure).toBeUndefined();
    }
    feed.accept({ t: 'roster', k: 60, p: escortRoster(3094, 3492) }, 500);
    expect(entryRosterReady(feed.fresh(500), participants)).toBe(true);
    expect(entryRosterReady(feed.fresh(10500), participants)).toBe(false);
});

test('malformed entry evidence cannot recover and missing local state cannot release', () => {
    const feed = new RosterEvidence();
    feed.accept({ t: 'roster', k: 10, p: [[1, 'Bad', 1]] }, 0);
    feed.accept({ t: 'roster', k: 20, p: escortRoster(3094, 3492) }, 100);
    expect(entryRosterReady(feed.fresh(100), entryParticipants())).toBe(false);
    const valid = new RosterEvidence();
    valid.accept({ t: 'roster', k: 10, p: escortRoster(3094, 3492) }, 0);
    expect(entryRosterReady(valid.fresh(0), [{ name: 'Escort', player: undefined }, entryParticipants()[1]!])).toBe(false);
});

test('proof requires both logout results in the shared settle format', () => {
    expect(hasEscortLogouts('LOGOUT logged-out logged-out\r\n')).toBe(true);
    for (const log of ['LOGOUT logged-out\n', 'LOGOUT logged-out timeout\n', 'LOGOUT logged-out logged-out logged-out\n']) {
        expect(hasEscortLogouts(log)).toBe(false);
    }
});

test('route retains the measured endpoints and all 40 multi transit tiles', () => {
    const r = readEscortRoute();
    expect(r.out.p[0]).toEqual([3094, 3492]);
    expect(r.out.p.at(-1)).toEqual([3060, 3883]);
    expect(r.back.p[0]).toEqual([3060, 3883]);
    expect(r.back.p.at(-1)).toEqual([3094, 3492]);
    expect(r.multiTiles).toBe(40);
});

test('full corridor checks the two combat brackets separately', () => {
    const own = new Set(escortNames.map(n => n.toLowerCase()));
    expect(corridorThreat([[3, 'Enemy', 3060, 3883, 0, 100]], own, [[3060, 3883]], 75)).toBeDefined();
    expect(corridorThreat([[3, 'Enemy', 3060, 3883, 0, 100]], own, [[3060, 3883]], 29)).toBeUndefined();
    expect(corridorThreat([[3, 'Enemy', 3060, 3883, 0, 3]], own, [[3060, 3883]], 29)).toBeDefined();
    expect(corridorThreat([[3, 'Enemy', 3060, 3883, 1, 75]], own, [[3060, 3883]], 75)).toBeUndefined();
    expect(corridorThreat([[3, 'Enemy', 3094, 3492, 0, 75]], own, [[3060, 3883]], 75)).toBeUndefined();
});

test('three distinct consecutive frames are required and polling cannot add frames', () => {
    const feed = new RosterEvidence();
    const release = stageRelease(escortNames[0]!, escortNames[1]!);
    feed.accept({ t: 'roster', k: 10, p: escortRoster() }, 100);
    expect(release(feed.fresh(100), true)).toBe(false);
    expect(release(feed.fresh(101), true)).toBe(false);
    feed.accept({ t: 'roster', k: 20, p: escortRoster() }, 200);
    expect(release(feed.fresh(200), true)).toBe(false);
    feed.accept({ t: 'roster', k: 30, p: escortRoster() }, 300);
    expect(release(feed.fresh(300), true)).toBe(true);
    expect(feed.fresh(10300)).toBeUndefined();
});

test('adjacent miner roster rows cannot release even with a ready local observation', () => {
    const release = stageRelease(escortNames[0]!, escortNames[1]!);
    for (const tick of [10, 20, 30]) {
        const rows = escortRoster();
        rows[1]![3] = 3491;
        expect(release({ tick, at: tick, roster: rows }, true)).toBe(false);
    }
    for (const tick of [40, 50]) expect(release({ tick, at: tick, roster: escortRoster() }, true)).toBe(false);
    expect(release({ tick: 60, at: 60, roster: escortRoster() }, true)).toBe(true);
});

test('gaps and malformed frames latch refusal for the whole trip', () => {
    for (const next of [{ t: 'roster', k: 30, p: escortRoster() }, { t: 'roster', k: 20, p: [[1, 'Bad', 1]] }]) {
        const feed = new RosterEvidence();
        feed.accept({ t: 'roster', k: 10, p: escortRoster() }, 100);
        feed.accept(next, 200);
        feed.accept({ t: 'roster', k: 40, p: escortRoster() }, 300);
        expect(feed.fresh(300)).toBeUndefined();
        expect(feed.failure).toBeDefined();
    }
});

test('release resets if the escort moves, miner leaves Edgeville, or roster is stale', () => {
    for (const interrupt of ['escort', 'miner', 'stale']) {
        const feed = new RosterEvidence();
        const release = stageRelease(escortNames[0]!, escortNames[1]!);
        for (const k of [10, 20]) {
            feed.accept({ t: 'roster', k, p: escortRoster() }, k);
            expect(release(feed.fresh(k), true)).toBe(false);
        }
        feed.accept({ t: 'roster', k: 30, p: interrupt === 'escort' ? escortRoster(3061) : escortRoster() }, 30);
        expect(release(interrupt === 'stale' ? undefined : feed.fresh(30), interrupt !== 'miner')).toBe(false);
    }
});

test('escort intercept decision, south inbound recovery, and retreat teleport fallback', () => {
    expect(retreatOrTeleportPlan({ tile: [3060, 3885], magic: 99, inventory: [{ name: 'Amulet of glory(4)' }], equipment: [] })).toBe('run');
    expect(retreatOrTeleportPlan({ tile: [3060, 3715], magic: 99, inventory: [{ name: 'Amulet of glory(4)' }], equipment: [] })).toBe('glory');
    expect(retreatOrTeleportPlan({ tile: [3060, 3632], magic: 70, inventory: [{ name: 'Law rune', count: 1 }, { name: 'Air rune', count: 3 }, { name: 'Fire rune', count: 1 }], equipment: [] })).toBe('teleport');
    expect(selectInboundRecovery([3060, 3800], [[3060, 3883], [3060, 3810], [3060, 3780], [3094, 3492]])).toBe(2);

    expect(
        escortInterceptDecision({
            escortTile: [3060, 3883],
            escortCombat: 75,
            threat: { name: 'Pker', x: 3060, z: 3880, combatLevel: 78 },
            hasWeapon: true,
            hasFood: true,
            prayerPoints: 35,
        }).action,
    ).toBe('intercept');
    expect(
        escortInterceptDecision({
            escortTile: [3060, 3883],
            escortCombat: 75,
            threat: { name: 'MainPker', x: 3060, z: 3880, combatLevel: 115 },
            hasWeapon: true,
            hasFood: true,
            prayerPoints: 35,
        }).action,
    ).toBe('screen-retreat');
});

test('assessGodSpellReadiness, resolveMageArenaWorkflow, and wildernessAgilityEscapeGuard', () => {
    const ready = assessGodSpellReadiness({
        god: 'guthix',
        magicLevel: 85,
        prayerLevel: 43,
        mageArenaVarp: 8,
        godCastVarp: 99,
        chargeVarp: 0,
        wornIds: [2413, 2416],
        inventory: [{ id: 554, count: 10 }, { id: 565, count: 10 }, { id: 556, count: 10 }],
    });
    expect(ready).toMatchObject({ ready: true, maxHit: 30, drainEffect: 'defence', chargeReady: true, conflict: null });
    expect(
        assessGodSpellReadiness({
            god: 'saradomin',
            magicLevel: 85,
            prayerLevel: 43,
            wornIds: [2414, 2415],
            inventory: [{ id: 554, count: 5 }, { id: 565, count: 5 }, { id: 556, count: 5 }],
        }).conflict,
    ).toEqual({ capeGod: 'zamorak', staffGod: 'saradomin' });
    expect(resolveMageArenaWorkflow('saradomin', { charge: true })).toEqual({
        script: 'scripts/generated/quest-magearena.ts',
        args: [],
        env: { MA_GOD: 'saradomin', MA_MODE: 'pray', MA_CHARGE: '1' },
    });

    const hostile = { name: 'AgilityPker', x: 3004, z: 3948, combatLevel: 95, distance: 8, wornWeapon: 861 };
    expect(
        wildernessAgilityEscapeGuard({
            me: { x: 3004, z: 3945, level: 0, hp: 50, maxHp: 99, combatLevel: 90 },
            nearby: [hostile],
            inObstacleDelay: true,
            hasGlory: true,
            hasVarrockTele: false,
            foodCount: 8,
        }),
    ).toMatchObject({ onCourse: true, inPit: false, action: 'wait-obstacle-settle', protectPrayer: 13 });
    expect(
        wildernessAgilityEscapeGuard({
            me: { x: 3005, z: 10363, level: 0, hp: 40, maxHp: 99, combatLevel: 90 },
            nearby: [hostile],
            inObstacleDelay: false,
            hasGlory: true,
            hasVarrockTele: false,
            foodCount: 4,
        }),
    ).toMatchObject({ onCourse: true, inPit: true, action: 'climb-pit-then-escape', protectPrayer: 13 });
    expect(
        wildernessAgilityEscapeGuard({
            me: { x: 3004, z: 3955, level: 0, hp: 50, maxHp: 99, combatLevel: 90 },
            nearby: [{ name: 'Skiller', x: 3004, z: 3955, combatLevel: 3, distance: 2 }],
            inObstacleDelay: false,
            hasGlory: true,
            hasVarrockTele: false,
            foodCount: 8,
        }),
    ).toMatchObject({ action: 'eat', threat: null });
    expect(
        wildernessAgilityEscapeGuard({
            me: { x: 3004, z: 3955, level: 0, hp: 85, maxHp: 99, combatLevel: 90 },
            nearby: [{ name: 'Skiller', x: 3004, z: 3955, combatLevel: 3, distance: 2 }],
            inObstacleDelay: false,
            hasGlory: true,
            hasVarrockTele: false,
            foodCount: 8,
        }),
    ).toMatchObject({ action: 'continue', threat: null });
});
