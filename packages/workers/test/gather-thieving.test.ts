// Consolidated unit tests for thieving gathering: blood chest, goldfarm knights, stable knights, pickpocketing, nature chest, and stalls.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { settle } from '../../core/src/bot';
import { setEquipmentObserved } from '../../core/src/container-observation';
import type { Session } from '../../core/src/inprocess';
import { walkPath, type PathDeps } from '../../core/src/walk';
import { isNoProgressFailure } from '../../practice/src/supervise';
import { classify } from '../../practice/src/supervise-host';
import { watchProductionLife } from '../../../scripts/microbot-c-lifetime';
import { runBankProfile } from '../../../scripts/microbot-bank-jobs';
import { monitoredPlayer } from '../src/pvp/monitor';
import { BotActions } from '../../../vendor/rs-sdk/sdk/actions';
import type { BotWorldState } from '../../../vendor/rs-sdk/sdk/types';
import {
    ARDOUGNE_RADIUS,
    BANK_SPOT,
    BLOOD_ARRIVAL,
    BLOOD_BANK,
    BLOOD_RUNE,
    BLOOD_STAGE,
    CHEST,
    CHESTS,
    COURIER_COOLDOWN,
    COURIER_WANT_BELOW,
    DOOR,
    EXIT_TICKS,
    FOOD_NAMES,
    FOOD_ORDER,
    FRAIL_FLOOR,
    FRAIL_HP,
    FRAIL_RESERVE,
    LADDER_DOWN,
    LADDER_FOOT,
    LADDER_UP,
    PICK_LIMIT,
    REFUGE_NONE,
    REFUGE_WINDOW,
    REGEN_TICKS,
    RESPAWN_TICKS,
    THIEVING_COINS_ID,
    TRAVEL_TICKS,
    WITHDRAW_FOOD,
    bloodChestEffect,
    bloodOptions,
    bloodRefusal,
    bloodZone,
    calcEatAt,
    chestOptions,
    courierCheckDue,
    courierFoodReady,
    failureResult,
    farmEatReceipt,
    farmErrorCheckpoint,
    farmFinishCheckpoint,
    farmPickCancellation,
    farmPickTarget,
    farmProgressTick,
    farmSettlePicks,
    farmStartProblem,
    foodBiteHeal,
    foodReserve,
    foodTripDue,
    foodWaitLimit,
    guardHit,
    healOf,
    incomingCookedFood,
    isFoodItem,
    natureChestEffect,
    noKnightReason,
    ownerSeesTile,
    pickFoodForLoss,
    pickpocketProfiles,
    pocketEffect,
    pocketOwnedActions,
    pocketTripStop,
    receiveFoodAtBank,
    refugeDue,
    replenishFarmFood,
    runBloodChest,
    runNatureChest,
    runPickpocketTrips,
    runPickpockets,
    selectFoodToEat,
    stallEffect,
    stallRecipes,
    stallWatched,
    stealStall,
    validatePickpocketTrip,
    validatePocketOptions,
    walkBloodDungeon,
    withStallSightBlocker,
    withStallSightBlockers,
    type BloodDeps,
    type PickpocketTrip,
    type PocketOptions,
} from '../src/gather';

// --- Blood chest (formerly blood-chest.test.ts) ---
const bloodOpts = { maxLoots: 2, cap: 2000, idleTicks: 700, bankEvery: 50 };

test('stranded dungeon step 2574,9742 reaches the chest stage despite an empty SDK plan', async () => {
    const p = { x: 2574, z: 9742, level: 0 };
    const clicks: { x: number; z: number }[] = [];
    const listeners = new Set<() => void>();
    let tick = 0;
    let target = { ...p };
    const d: PathDeps = {
        tick: () => tick,
        pos: () => p,
        onTick: cb => {
            listeners.add(cb);
            return () => {
                listeners.delete(cb);
            };
        },
        plan: () => [],
        locs: () => [],
        walk: (x, z) => {
            clicks.push({ x, z });
            target = { x, z, level: 0 };
            return { success: true };
        },
        interactLoc: () => {
            throw Error('no door on dungeon leg');
        },
    };
    const travel = walkBloodDungeon(d, BLOOD_STAGE.x, BLOOD_STAGE.z, 1, () => false);
    expect(clicks.length).toBeGreaterThan(0);
    for (let i = 0; i < 160 && listeners.size; i++) {
        p.x += Math.sign(target.x - p.x);
        p.z += Math.sign(target.z - p.z);
        tick++;
        for (const cb of [...listeners]) cb();
    }
    expect(await travel).toBe(true);
    expect(Math.max(Math.abs(p.x - BLOOD_STAGE.x), Math.abs(p.z - BLOOD_STAGE.z))).toBeLessThanOrEqual(1);
    expect(listeners.size).toBe(0);
    p.x = 2574;
    p.z = 9742;
    tick = 0;
    const stuck = walkBloodDungeon(d, BLOOD_STAGE.x, BLOOD_STAGE.z, 1, () => false);
    for (let i = 0; i < 160 && listeners.size; i++) {
        tick++;
        for (const cb of [...listeners]) cb();
    }
    expect(await stuck).toBe(false);
    expect(tick).toBeLessThanOrEqual(151);
    expect(listeners.size).toBe(0);
});

function bloodWorld(
    p: { thieving?: number; x?: number; z?: number; pickAfter?: number; hp?: number; coins?: number; cake?: number; hitAt?: number; bankCake?: number; hitPerLoot?: number; base?: number; lobster?: number; bankLobster?: number; regen?: boolean } = {},
) {
    const w = {
        x: p.x ?? BLOOD_ARRIVAL.x,
        z: p.z ?? BLOOD_ARRIVAL.z,
        level: 0,
        tick: 0,
        xp: 1000,
        hp: p.hp ?? 56,
        base: p.base ?? 56,
        runes: 0,
        coins: p.coins ?? 0,
        cake: p.cake ?? 3,
        lobster: p.lobster ?? 0,
        bankCake: p.bankCake ?? 0,
        bankLobster: p.bankLobster ?? 0,
        lifeId: 1,
        bankRunes: 0,
        bankCoins: 0,
        bankCalls: 0,
        fails: p.pickAfter ?? 0,
        chestUntil: CHESTS.map(() => 0),
        acts: [] as { id: number; option: number; x: number; z: number; tick: number }[],
        messages: [] as { type: number; text: string; sender: string; tick: number }[],
        stopped: false,
        surfaceWalks: [] as string[],
        dungeonWalks: [] as string[],
        travels: [] as string[],
    };
    const state = () =>
        ({
            player: { worldX: w.x, worldZ: w.z, level: w.level, lifeId: w.lifeId, isDead: false },
            skills: [{ name: 'Thieving', level: p.thieving ?? 99, baseLevel: p.thieving ?? 99, experience: w.xp }, { name: 'Hitpoints', level: w.hp, baseLevel: w.base, experience: 1000 }],
            inventory: [
                ...(w.lobster ? [{ id: 379, count: w.lobster, slot: 3, name: 'Lobster', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }] : []),
                ...(w.cake ? [{ id: 1895, count: w.cake, slot: 0, name: 'Slice of cake', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }] : []),
                ...(w.coins ? [{ id: THIEVING_COINS_ID, count: w.coins, slot: 1, name: 'Coins', optionsWithIndex: [] }] : []),
                ...(w.runes ? [{ id: BLOOD_RUNE, count: w.runes, slot: 2, name: 'Blood rune', optionsWithIndex: [] }] : []),
            ],
            gameMessages: w.messages,
            nearbyNpcs: [],
            nearbyLocs: [
                { id: DOOR.id, x: DOOR.x, z: DOOR.z, level: 0, optionsWithIndex: [{ text: 'Open', opIndex: 1 }, { text: 'Pick Lock', opIndex: 2 }] },
                ...CHESTS.filter((_, i) => w.chestUntil[i]! <= w.tick).map(c => ({ id: CHEST, x: c.x, z: c.z, level: 0, optionsWithIndex: [{ text: 'Open', opIndex: 1 }, { text: 'Search for traps', opIndex: 2 }] })),
            ],
        }) as unknown as BotWorldState;
    const step = async () => {
        w.tick++;
        if (w.tick === p.hitAt) w.hp = 20;
        if (p.regen && w.tick % REGEN_TICKS === 0) w.hp = Math.min(w.base, w.hp + 1);
    };
    const d: BloodDeps = {
        state,
        tick: () => w.tick,
        stopped: () => w.stopped,
        walkSurface: async (x, z) => {
            w.surfaceWalks.push(`${x},${z}`);
            w.x = x;
            w.z = z;
            w.tick += 20;
            return true;
        },
        travel: async (x, z) => {
            w.travels.push(`${x},${z}`);
            w.x = x;
            w.z = z;
            w.tick += 600;
            return true;
        },
        walkDungeon: async (x, z) => {
            w.dungeonWalks.push(`${x},${z}`);
            w.x = x;
            w.z = z;
            w.tick += 15;
            return true;
        },
        act: async (x, z, id, option) => {
            w.acts.push({ id, option, x, z, tick: w.tick });
            if (id === DOOR.id && option === 2) {
                if (w.fails-- > 0) w.messages.push({ type: 0, text: 'You fail to pick the lock.', sender: '', tick: w.tick });
                else {
                    w.x = DOOR.x - 1;
                    w.z = DOOR.z;
                    w.xp += 375;
                }
            } else if (id === DOOR.id && option === 1) {
                w.x = DOOR.x;
                w.z = DOOR.z;
            } else if (id === LADDER_DOWN.id) {
                w.x = LADDER_FOOT.x;
                w.z = LADDER_FOOT.z;
            } else if (id === LADDER_UP.id) {
                w.x = LADDER_DOWN.x + 1;
                w.z = LADDER_DOWN.z;
            } else if (id === CHEST) {
                const i = CHESTS.findIndex(c => c.x === x && c.z === z);
                if (w.chestUntil[i]! > w.tick) return { success: true };
                w.runes += 2;
                w.coins += 500;
                w.xp += 2500;
                w.hp -= p.hitPerLoot ?? 0;
                w.chestUntil[i] = w.tick + 300;
                w.x = BLOOD_ARRIVAL.x;
                w.z = BLOOD_ARRIVAL.z;
            }
            return { success: true };
        },
        wait: async (check, ticks) => {
            for (let i = 0; i < ticks; i++) {
                if (check()) return true;
                await step();
            }
            return check();
        },
        step,
        bank: async food => {
            const cake = food ? w.bankCake : 0;
            const lobster = food ? w.bankLobster : 0;
            const r = { runes: w.runes, coins: w.coins, food: cake + lobster };
            w.bankCalls++;
            w.bankRunes += w.runes;
            w.bankCoins += w.coins;
            w.runes = 0;
            w.coins = 0;
            w.cake += cake;
            w.bankCake -= cake;
            w.lobster += lobster;
            w.bankLobster -= lobster;
            return r;
        },
        eat: async item => {
            if (item.id === 379) {
                w.lobster--;
                w.hp = Math.min(w.base, w.hp + 12);
            } else {
                w.cake--;
                w.hp = Math.min(w.base, w.hp + 20);
            }
            return { success: true };
        },
        log: () => {},
    };
    return { w, d, state };
}

test('options need a tick cap, take the lower cap and keep finite limits', () => {
    expect(() => bloodOptions(undefined, {})).toThrow('tickCap');
    expect(() => bloodOptions('nope', {})).toThrow('tickCap');
    expect(() => bloodOptions('24000', { MAX_LOOTS: '0' })).toThrow('MAX_LOOTS');
    expect(() => bloodOptions(String(EXIT_TICKS - 1), {})).toThrow('tickCap');
    expect(() => bloodOptions('24000', { IDLE_TICKS: '900' })).toThrow('IDLE_TICKS');
    expect(bloodOptions('24000', { MAX_LOOTS: '100', CAP: '24000' })).toEqual({ maxLoots: 100, cap: 24000, idleTicks: 700, bankEvery: 50 });
    expect(bloodOptions('24000', { CAP: '5000' }).cap).toBe(5000);
    expect(bloodOptions('5000', { CAP: '24000' }).cap).toBe(5000);
});

test('zones follow the native tiles on both sides of the door', () => {
    const at = (x: number, z: number, level = 0) => ({ player: { worldX: x, worldZ: z, level } } as unknown as BotWorldState);
    expect(bloodZone(at(DOOR.x, DOOR.z))).toBe('surface');
    expect(bloodZone(at(DOOR.x - 1, DOOR.z))).toBe('tower');
    expect(bloodZone(at(LADDER_FOOT.x, LADDER_FOOT.z))).toBe('dungeon');
    expect(bloodZone(at(BLOOD_ARRIVAL.x, BLOOD_ARRIVAL.z))).toBe('surface');
    expect(bloodZone(at(DOOR.x - 1, DOOR.z, 1))).toBe('other');
    expect(bloodZone(at(2900, 9800))).toBe('other');
});

test('chest effect needs both rewards, XP, kept assets and the teleport', () => {
    const { state, w } = bloodWorld({ x: BLOOD_STAGE.x, z: BLOOD_STAGE.z });
    const before = state();
    expect(bloodChestEffect(before, state())).toBe(false);
    w.runes = 2;
    w.coins = 500;
    w.xp += 2500;
    expect(bloodChestEffect(before, state())).toBe(false);
    w.x = BLOOD_ARRIVAL.x;
    w.z = BLOOD_ARRIVAL.z;
    expect(bloodChestEffect(before, state())).toBe(true);
    w.coins = 499;
    expect(() => bloodChestEffect(before, state())).toThrow('reconcile');
    w.coins = 500;
    w.xp -= 2500;
    expect(() => bloodChestEffect(before, state())).toThrow('reconcile');
    w.xp += 2500;
    w.cake = 2;
    expect(() => bloodChestEffect(before, state())).toThrow('assets');
});

test('the reward first observed at 2584,3340 counts as a loot and keeps the reward and kit checks', async () => {
    const { w, d, state } = bloodWorld({ coins: 100 });
    const act = d.act;
    d.act = async (...a) => {
        const r = await act(...a);
        if (a[2] === CHEST) w.z = 3340;
        return r;
    };
    const r = await runBloodChest(d, bloodOpts);
    expect(r).toMatchObject({ ok: true, stop: 'target', conserved: true, loots: 2, bankedRunes: 4, bankedCoins: 1100, entries: 2 });
    expect(w.acts.filter(a => a.id === CHEST)).toHaveLength(2);
    w.x = BLOOD_STAGE.x;
    w.z = BLOOD_STAGE.z;
    w.runes = 0;
    w.coins = 0;
    const before = state();
    w.x = 2584;
    w.z = 3340;
    w.runes = 2;
    w.coins = 500;
    w.xp += 2500;
    expect(bloodChestEffect(before, state())).toBe(true);
    w.coins = 499;
    expect(() => bloodChestEffect(before, state())).toThrow('reconcile');
    w.coins = 500;
    w.cake = 2;
    expect(() => bloodChestEffect(before, state())).toThrow('assets');
});

test('two loots use op2 on both chests, bank the exact reward and reconcile', async () => {
    const { w, d } = bloodWorld({ coins: 100, pickAfter: 3 });
    const r = await runBloodChest(d, bloodOpts);
    expect(r).toMatchObject({ ok: true, stop: 'target', targetMet: true, conserved: true, loots: 2, runes: 4, coins: 1000, bankedRunes: 4, bankedCoins: 1100, startCoins: 100, bankTrips: 1, entries: 2, died: false });
    expect(r.picks).toBeGreaterThanOrEqual(5);
    const chests = w.acts.filter(a => a.id === CHEST);
    expect(chests.map(a => a.option)).toEqual([2, 2]);
    expect(chests.map(a => a.z).sort()).toEqual(CHESTS.map(c => c.z).sort());
    expect(w.bankRunes).toBe(4);
    expect(w.runes).toBe(0);
    expect(w.coins).toBe(0);
    expect(w.cake).toBe(3);
    expect(w.surfaceWalks.at(-1)).toBe(`${BLOOD_BANK.x},${BLOOD_BANK.z}`);
});

test('100 successful entries reset the door bound and bank 200 runes within the consumer cap', async () => {
    const { w, d } = bloodWorld({ pickAfter: 1 });
    const act = d.act;
    d.act = async (...a) => {
        const r = await act(...a);
        if (a[2] === CHEST) w.fails = 1;
        return r;
    };
    const r = await runBloodChest(d, bloodOptions('24000', { MAX_LOOTS: '100', CAP: '24000' }));
    expect(r).toMatchObject({ ok: true, stop: 'target', targetMet: true, conserved: true, loots: 100, runes: 200, coins: 50000, bankedRunes: 200, bankedCoins: 50000, bankTrips: 2, picks: 200, entries: 100, died: false });
    expect(w.acts.filter(a => a.id === DOOR.id && a.option === 2)).toHaveLength(200);
    expect(w.acts.filter(a => a.id === CHEST)).toHaveLength(100);
    expect(w.bankRunes).toBe(200);
    expect(w.bankCoins).toBe(50000);
    expect(w.runes).toBe(0);
    expect(w.coins).toBe(0);
    expect(w.cake).toBe(3);
    expect(w.surfaceWalks.at(-1)).toBe(`${BLOOD_BANK.x},${BLOOD_BANK.z}`);
    expect(r.ticks).toBeLessThan(24000);
});

test('below Thieving 59 the run refuses before any action', async () => {
    const { w, d, state } = bloodWorld({ thieving: 58 });
    await expect(runBloodChest(d, bloodOpts)).rejects.toThrow('blood chest refused: Thieving 58 is below level 59');
    expect(w.acts).toEqual([]);
    expect(w.surfaceWalks).toEqual([]);
    expect(bloodRefusal(state(), bloodOpts)).toContain('Thieving 58');
    expect(failureResult(Error('blood chest refused: Thieving 58 is below level 59')).stop).toBe('refused');
    expect(failureResult(Error('blood chest walk failed: door')).stop).toBe('failed');
    const full = bloodWorld();
    full.w.cake = 0;
    const pack = full.state();
    pack.inventory = Array.from({ length: 28 }, (_, slot) => ({ id: 1895, count: 1, slot, name: 'Slice of cake' })) as BotWorldState['inventory'];
    expect(bloodRefusal(pack, bloodOpts)).toContain('no room');
});

test('the loop waits on the surface for the respawn and banks at the set interval', async () => {
    const { w, d } = bloodWorld();
    const r = await runBloodChest(d, { ...bloodOpts, maxLoots: 4, bankEvery: 2, cap: 5000 });
    expect(r).toMatchObject({ ok: true, loots: 4, bankedRunes: 8, bankedCoins: 2000, bankTrips: 2 });
    const loots = w.acts.filter(a => a.id === CHEST);
    expect(loots.length).toBe(4);
    expect(loots[2]!.tick - loots[0]!.tick).toBeGreaterThan(RESPAWN_TICKS - 80);
    expect(w.dungeonWalks.every(t => t === `${BLOOD_STAGE.x},${BLOOD_STAGE.z}`)).toBe(true);
});

test('Hitpoints below half with no food leave by the ladder and the door, then bank the loot', async () => {
    const { w, d } = bloodWorld({ hitAt: 3, x: BLOOD_STAGE.x, z: BLOOD_STAGE.z, coins: 40, cake: 0 });
    w.chestUntil = [100000, 100000];
    const r = await runBloodChest(d, bloodOpts);
    expect(r).toMatchObject({ ok: false, stop: 'hp', targetMet: false, conserved: true, loots: 0, bankedCoins: 40, bankTrips: 1, entries: 0, hpMin: 20 });
    expect(w.acts.map(a => [a.id, a.option])).toEqual([[LADDER_UP.id, 1], [DOOR.id, 1]]);
    expect(w.dungeonWalks.at(-1)).toBe(`${LADDER_FOOT.x},${LADDER_FOOT.z}`);
});

test('Hitpoints below half eat on the surface, restock at the bank and finish the target', async () => {
    const { w, d } = bloodWorld({ cake: 1, bankCake: 20, hitPerLoot: 10 });
    const r = await runBloodChest(d, { ...bloodOpts, maxLoots: 12, cap: 20000 });
    expect(r).toMatchObject({ ok: true, stop: 'target', conserved: true, loots: 12, bankedRunes: 24, bankedCoins: 6000 });
    expect(r.meals).toBeGreaterThan(1);
    expect(r.hpMin).toBeGreaterThanOrEqual(18);
    expect(w.bankCake).toBe(0);
    expect(w.cake).toBe(21 - r.meals);
});

test('a food stock that runs out ends the run at the hp stop with the loot banked', async () => {
    const { d } = bloodWorld({ cake: 1, hitPerLoot: 10 });
    const r = await runBloodChest(d, { ...bloodOpts, maxLoots: 12, cap: 20000 });
    expect(r).toMatchObject({ ok: false, stop: 'hp', targetMet: false, conserved: true, meals: 1 });
    expect(r.loots).toBeGreaterThan(0);
    expect(r.loots).toBeLessThan(12);
    expect(r.bankedRunes).toBe(r.loots * 2);
});

test('a 47 Hitpoints account eats before the door at 25 and leaves the dungeon at 27', async () => {
    const { w, d } = bloodWorld({ hp: 25, base: 47, cake: 0, lobster: 1 });
    const order: string[] = [];
    const act = d.act;
    const eat = d.eat;
    d.act = async (...a) => {
        order.push(a[2] === DOOR.id ? 'door' : 'act');
        return act(...a);
    };
    d.eat = async item => {
        order.push(`eat ${w.hp}`);
        return eat(item);
    };
    const r = await runBloodChest(d, bloodOpts);
    expect(order[0]).toBe('eat 25');
    expect(order.indexOf('door')).toBeGreaterThan(0);
    expect(r).toMatchObject({ ok: true, stop: 'target', conserved: true, loots: 2, meals: 1 });
    expect(w.lobster).toBe(0);
    const low = bloodWorld({ hp: 27, base: 47, cake: 0, x: BLOOD_STAGE.x, z: BLOOD_STAGE.z });
    const left = await runBloodChest(low.d, bloodOpts);
    expect(left).toMatchObject({ ok: false, stop: 'hp', loots: 0, hpMin: 27 });
    expect(low.w.acts.some(a => a.id === CHEST)).toBe(false);
    expect(low.w.acts.map(a => [a.id, a.option])).toEqual([[LADDER_UP.id, 1], [DOOR.id, 1]]);
});

test('a low Hitpoints surface start with no pack food banks for Lobster, eats and loots to the target', async () => {
    const { w, d, state } = bloodWorld({ hp: 15, base: 39, cake: 0, x: 2618, z: 3332, bankLobster: 80 });
    const order: string[] = [];
    const bank = d.bank;
    const eat = d.eat;
    expect(bloodRefusal(state(), bloodOpts)).toBeNull();
    d.bank = async food => {
        order.push(`bank ${food}`);
        return bank(food);
    };
    d.eat = async item => {
        order.push(`eat ${item.name}`);
        return eat(item);
    };
    const r = await runBloodChest(d, bloodOpts);
    expect(order.slice(0, 3)).toEqual(['bank true', 'eat Lobster', 'eat Lobster']);
    expect(r).toMatchObject({ ok: true, stop: 'target', targetMet: true, conserved: true, loots: 2, bankedRunes: 4, bankedCoins: 1000, meals: 2 });
    expect(w.acts.filter(a => a.id === CHEST)).toHaveLength(2);
    expect(w.lobster).toBe(78);
    expect(w.runes).toBe(0);
    expect(w.coins).toBe(0);
    const tower = bloodWorld({ hp: 15, base: 39, cake: 0, x: DOOR.x - 1, z: DOOR.z, bankLobster: 80 });
    await expect(runBloodChest(tower.d, bloodOpts)).rejects.toThrow('Hitpoints are below half');
    expect(tower.w.acts).toEqual([]);
});

test('a low Hitpoints surface start with no food in the bank ends at the hp stop and loses no loot', async () => {
    const { w, d } = bloodWorld({ hp: 15, base: 39, cake: 0, x: 2618, z: 3332, coins: 40 });
    w.runes = 6;
    const r = await runBloodChest(d, bloodOpts);
    expect(r).toMatchObject({ ok: false, stop: 'hp', targetMet: false, conserved: true, loots: 0, meals: 0, startRunes: 6, startCoins: 40, bankedRunes: 6, bankedCoins: 40 });
    expect(w.acts).toEqual([]);
    expect(w.runes).toBe(0);
    expect(w.coins).toBe(0);
    expect(w.bankRunes).toBe(6);
    expect(w.bankCoins).toBe(40);
});

test('a surface start below the fed level with no food waits for regeneration, then loots', async () => {
    const { w, d } = bloodWorld({ hp: 34, base: 47, cake: 0, x: 2618, z: 3332, regen: true });
    const r = await runBloodChest(d, { ...bloodOpts, cap: 4000 });
    expect(r).toMatchObject({ ok: true, stop: 'target', targetMet: true, conserved: true, loots: 2, meals: 0 });
    expect(w.hp).toBeGreaterThanOrEqual(Math.ceil(47 * 0.75) - 2);
    const short = bloodWorld({ hp: 15, base: 39, cake: 0, x: 2618, z: 3332, regen: true });
    expect(await runBloodChest(short.d, bloodOpts)).toMatchObject({ ok: false, stop: 'hp', loots: 0 });
    expect(short.w.tick).toBeLessThan(REGEN_TICKS);
});

test('food with no observed effect fails the run', async () => {
    const { d } = bloodWorld({ hp: 20 });
    d.eat = async () => ({ success: true });
    await expect(runBloodChest(d, bloodOpts)).rejects.toThrow('food effect unobserved');
    const refused = bloodWorld({ hp: 20 });
    refused.d.eat = async () => ({ success: false });
    await expect(runBloodChest(refused.d, bloodOpts)).rejects.toThrow('food refused');
});

test('the soft cap leaves the dungeon and keeps the hard cap for the exit', async () => {
    const { w, d } = bloodWorld({ x: BLOOD_STAGE.x, z: BLOOD_STAGE.z, coins: 7 });
    const r = await runBloodChest(d, { ...bloodOpts, cap: EXIT_TICKS });
    expect(r).toMatchObject({ ok: false, stop: 'cap', loots: 0, bankedCoins: 7, conserved: true });
    expect(w.acts.some(a => a.id === CHEST)).toBe(false);
    const late = bloodWorld({ x: BLOOD_STAGE.x, z: BLOOD_STAGE.z, coins: 7 });
    const walk = late.d.walkDungeon;
    late.d.walkDungeon = async (x, z, t) => {
        await walk(x, z, t);
        late.w.tick += EXIT_TICKS;
        return true;
    };
    await expect(runBloodChest(late.d, { ...bloodOpts, cap: EXIT_TICKS })).rejects.toThrow('tick cap');
});

test('a taken chest ends at the idle limit and still exits', async () => {
    const { d } = bloodWorld({ x: BLOOD_STAGE.x, z: BLOOD_STAGE.z, coins: 1 });
    const worldInstance = bloodWorld({ x: BLOOD_STAGE.x, z: BLOOD_STAGE.z, coins: 1 });
    worldInstance.w.chestUntil = [100000, 100000];
    expect(await runBloodChest(worldInstance.d, { ...bloodOpts, idleTicks: 20 })).toMatchObject({ ok: false, stop: 'idle', loots: 0, bankedCoins: 1 });
    expect(d).toBeDefined();
});

test('a stop request, a death and a stuck door end the run', async () => {
    const stopped = bloodWorld();
    stopped.w.stopped = true;
    await expect(runBloodChest(stopped.d, bloodOpts)).rejects.toThrow('stopped');
    expect(stopped.w.acts).toEqual([]);
    const dead = bloodWorld({ x: BLOOD_STAGE.x, z: BLOOD_STAGE.z });
    const act = dead.d.act;
    dead.d.act = async (...a) => {
        const r = await act(...a);
        dead.w.lifeId = 2;
        return r;
    };
    await expect(runBloodChest(dead.d, bloodOpts)).rejects.toThrow('died');
    const door = bloodWorld({ pickAfter: PICK_LIMIT + 5 });
    await expect(runBloodChest(door.d, { ...bloodOpts, cap: 100000, idleTicks: 850 })).rejects.toThrow('door not picked');
    expect(door.w.acts.filter(a => a.id === DOOR.id).length).toBe(PICK_LIMIT);
});

test('a failed walk stops after the bound', async () => {
    const { w, d } = bloodWorld();
    d.walkSurface = async () => false;
    await expect(runBloodChest(d, bloodOpts)).rejects.toThrow('walk failed: door');
    expect(w.travels).toEqual([]);
});

test('a start at the Varrock GE 3185,3436 travels to the Ardougne bank once before the first door walk', async () => {
    const { w, d } = bloodWorld({ x: 3185, z: 3436 });
    const order: string[] = [];
    const travel = d.travel;
    const walk = d.walkSurface;
    d.travel = async (x, z, t) => {
        order.push(`travel ${x},${z}`);
        expect(t).toBeLessThanOrEqual(TRAVEL_TICKS);
        return travel(x, z, t);
    };
    d.walkSurface = async (x, z) => {
        order.push(`walk ${x},${z}`);
        return walk(x, z);
    };
    const r = await runBloodChest(d, bloodOpts);
    expect(r).toMatchObject({ ok: true, stop: 'target', conserved: true, loots: 2, bankedRunes: 4 });
    expect(w.travels).toEqual([`${BLOOD_BANK.x},${BLOOD_BANK.z}`]);
    expect(order[0]).toBe(`travel ${BLOOD_BANK.x},${BLOOD_BANK.z}`);
    expect(order[1]).toBe(`walk ${DOOR.x},${DOOR.z}`);
    const failed = bloodWorld({ x: 3185, z: 3436 });
    failed.d.travel = async () => false;
    await expect(runBloodChest(failed.d, bloodOpts)).rejects.toThrow('blood chest travel failed: start 3185,3436,0');
    expect(failed.w.surfaceWalks).toEqual([]);
    expect(failed.w.acts).toEqual([]);
    const short = bloodWorld({ x: 3185, z: 3436 });
    short.d.travel = async () => {
        short.w.x = 2900;
        return true;
    };
    await expect(runBloodChest(short.d, bloodOpts)).rejects.toThrow('start 3185,3436,0');
});

// --- Goldfarm & stable knights (formerly goldfarm.test.ts + goldfarm-stable.test.ts) ---
test('an idle pass names the first thing that keeps every knight from a pick', () => {
    const k = (inRange: boolean, reachable = true, banned = false, avoided = false) => ({ inRange, reachable, banned, avoided });
    expect(noKnightReason([])).toBe('none');
    expect(noKnightReason([k(false), k(false)])).toBe('far');
    expect(noKnightReason([k(true, false), k(false)])).toBe('unreachable');
    expect(noKnightReason([k(true, true, true), k(true, false)])).toBe('banned');
    expect(noKnightReason([k(true, true, false, true), k(true, true, true)])).toBe('avoided');
});

test('incoming sharks and shark notes count as food, raw and burnt do not', () => {
    expect(incomingCookedFood([{ id: 385, count: 5 }], [{ id: 385, count: 8 }, { id: 386, count: 20 }, { id: 383, count: 30 }, { id: 387, count: 3 }])).toBe(23);
});

test('a thief with few Hitpoints restocks while it still holds a reserve, and any other thief at the floor', () => {
    expect(foodReserve(10)).toBe(FRAIL_RESERVE);
    expect(foodReserve(FRAIL_HP - 1)).toBe(FRAIL_RESERVE);
    expect(foodReserve(FRAIL_HP)).toBe(FRAIL_FLOOR);
    expect(foodReserve(99)).toBe(FRAIL_FLOOR);
    expect(FRAIL_RESERVE).toBeGreaterThan(FRAIL_FLOOR);
});

test('a trade-only thief never goes to the shop or the stall, also while it is under a frail reserve', () => {
    const due = { low: true, bankEmpty: true, tradeOnly: false, rested: true, shopOk: false, emptyTrips: 0 };
    expect(foodTripDue(due)).toBe(true);
    expect(foodTripDue({ ...due, tradeOnly: true })).toBe(false);
    expect(foodTripDue({ ...due, tradeOnly: true, shopOk: true })).toBe(false);
    expect(foodTripDue({ ...due, low: false })).toBe(false);
    expect(foodTripDue({ ...due, bankEmpty: false })).toBe(false);
    expect(foodTripDue({ ...due, rested: false })).toBe(false);
    expect(foodTripDue({ ...due, emptyTrips: 3 })).toBe(false);
    expect(foodTripDue({ ...due, emptyTrips: 3, shopOk: true })).toBe(true);
});

test('a fall in Hitpoints with no pick of its own is a guard hit', () => {
    expect(guardHit(10, 7, false)).toBe(true);
    expect(guardHit(10, 7, true)).toBe(false);
    expect(guardHit(7, 7, false)).toBe(false);
    expect(guardHit(6, 10, false)).toBe(false);
});

test('the frail floor and food regexes match the thieving worker bounds', () => {
    expect(FRAIL_HP).toBe(20);
    expect(FRAIL_FLOOR).toBe(2);
    expect(FRAIL_RESERVE).toBe(6);
    for (const food of ['Slice of cake', '2/3 cake', 'Cake', 'Chocolate slice', 'Bread', 'Trout', 'Salmon', 'Lobster', 'Shark']) {
        expect(FOOD_ORDER.filter(re => re.test(food))).toHaveLength(1);
    }
});

const courierNow = 100000;
const courierOwners = new Set(['courier']);
const courierLive = { name: 'Courier', server: 'rs-sdk-demo.fly.dev', at: courierNow - 1000, result: '', pos: { x: 2654, z: 3283, level: 0 }, inventory: [{ id: 330, name: 'Salmon', count: 50 }] };

test('only configured authenticated same-server fresh active bank-near courier with real cooked notes wakes healthy farm', () => {
    const ready = (status: any, owned = courierOwners, tick = 120, last = 0) => courierFoodReady(status, 'Courier', 'rs-sdk-demo.fly.dev', owned, courierNow, tick, last);
    expect(ready(courierLive)).toBe(true);
    for (const change of [
        { name: 'Foreign' },
        { server: 'localhost:8888' },
        { server: undefined },
        { at: courierNow - 30000 },
        { at: courierNow + 1 },
        { result: 'ok stopped' },
        { pos: { x: 2654, z: 3300, level: 0 } },
        { pos: { x: 2654, z: 3283, level: 1 } },
        { inventory: [{ id: 329, name: 'Salmon', count: 50 }] },
        { inventory: [{ id: 333, name: 'Trout', count: 2 }] },
        { inventory: [{ id: 331, name: 'Raw salmon', count: 50 }] },
        { inventory: [{ id: 330, name: 'Salmon', count: 0 }] },
    ]) {
        expect(ready({ ...courierLive, ...change })).toBe(false);
    }
    expect(ready(courierLive, new Set())).toBe(false);
    expect(ready(courierLive, courierOwners, 119, 0)).toBe(false);
    expect(ready(courierLive, courierOwners, 120, 0)).toBe(true);
});

test('trade accounting counts only new actual incoming food, never the existing healthy pack', () => {
    const pack = [{ id: 333, count: 26 }, { id: 330, count: 5 }];
    expect(incomingCookedFood(pack, pack)).toBe(0);
    expect(incomingCookedFood(pack, [{ id: 333, count: 26 }, { id: 330, count: 15 }])).toBe(10);
    expect(incomingCookedFood(pack, [{ id: 333, count: 26 }, { id: 330, count: 5 }, { id: 331, count: 100 }])).toBe(0);
});

test('receiver banks earned coins before accepting two cooked note stacks into a 26 food pack', async () => {
    let tick = 0;
    const pack: any[] = [...Array.from({ length: 26 }, () => ({ id: 333, count: 1 })), { id: 995, count: 100 }];
    const s: any = {
        tick: () => tick,
        sdk: { getInventory: () => pack },
        bot: {
            serveTrades: async () => {
                expect(28 - pack.length).toBeGreaterThanOrEqual(2);
                pack.push({ id: 330, count: 15 }, { id: 334, count: 11 });
                tick++;
                return { reason: 'complete', message: 'received' };
            },
        },
    };
    const r = await receiveFoodAtBank(
        s,
        'Courier',
        20000,
        async () => {
            const i = pack.findIndex(i => i.id === 995);
            if (i >= 0) pack.splice(i, 1);
        },
        () => true,
    );
    expect(r.incoming).toBe(26);
});

test('short rendezvous timeout preserves existing food and returns normal-work availability; legacy timeout remains selectable', async () => {
    for (const timeout of [20000, 180000]) {
        let tick = 0;
        let seen = 0;
        let refills = 0;
        const pack: any[] = [{ id: 333, name: 'Trout', count: 26 }];
        const s: any = {
            tick: () => tick,
            sdk: { getInventory: () => pack },
            bot: {
                serveTrades: async (o: any) => {
                    seen = o.timeout;
                    expect(o.from.test('Courier')).toBe(true);
                    tick++;
                    return { reason: 'timeout', message: 'no trade' };
                },
            },
        };
        const r = await receiveFoodAtBank(
            s as Session,
            'Courier',
            timeout,
            async () => {
                refills++;
            },
            () => pack[0].count >= 2,
        );
        expect(r.incoming).toBe(0);
        expect(r.available).toBe(true);
        expect(seen).toBe(timeout);
        expect(refills).toBe(2);
        expect(pack[0].count).toBe(26);
    }
});

test('food rendezvous yields to a pending cash request from its same partner', async () => {
    let tick = 0;
    let pending = false;
    let refills = 0;
    const s: any = {
        tick: () => tick,
        sdk: { getInventory: () => [] },
        bot: {
            serveTrades: async (o: any) => {
                expect(o.until()).toBe(false);
                pending = true;
                expect(o.until()).toBe(true);
                tick++;
                return { reason: 'until', message: 'funding pending' };
            },
        },
    };
    const r = await receiveFoodAtBank(
        s,
        'Courier',
        45000,
        async () => {
            refills++;
        },
        () => false,
        () => pending,
    );
    expect(r.incoming).toBe(0);
    expect(r.reason).toBe('until');
    expect(refills).toBe(2);
});

const FOOD_IDS: Readonly<Record<string, number>> = {
    'Slice of cake': 1895,
    '2/3 cake': 1893,
    Cake: 1891,
    'Chocolate slice': 1901,
    Bread: 2309,
    Trout: 333,
    Salmon: 329,
    Lobster: 379,
    Shark: 385,
    'Cooked meat': 2142,
    'Cooked chicken': 2140,
};
const makeFood = (name: string, count = 1) => ({ id: FOOD_IDS[name]!, name, count, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] });

test('selectFoodToEat matches HP deficit to best food avoiding overheal waste', () => {
    const items = [makeFood('Lobster'), makeFood('Salmon'), makeFood('Trout'), makeFood('Bread'), makeFood('Cake'), makeFood('Chocolate slice')];
    expect(selectFoodToEat(items, 4)?.name).toBe('Cake');
    expect(selectFoodToEat([makeFood('Chocolate slice'), makeFood('Bread')], 4)?.name).toBe('Bread');
    expect(selectFoodToEat(items, 5)?.name).toBe('Chocolate slice');
    expect(selectFoodToEat(items, 6)?.name).toBe('Chocolate slice');
    expect(selectFoodToEat(items, 7)?.name).toBe('Trout');
    expect(selectFoodToEat(items, 10)?.name).toBe('Salmon');
    expect(selectFoodToEat(items, 12)?.name).toBe('Lobster');
    expect(selectFoodToEat(items, 1)?.name).toBe('Bread');
    expect(selectFoodToEat([makeFood('Chocolate slice'), makeFood('Bread')], 2)?.name).toBe('Bread');
    expect(selectFoodToEat([makeFood('Lobster')], 6)?.name).toBe('Lobster');
    expect(selectFoodToEat([{ name: 'Coins', count: 100 }], 6)).toBeUndefined();
});

test('the stall thief picks its food with the same content heals', () => {
    const pack = [makeFood('Chocolate slice'), makeFood('Bread'), makeFood('Slice of cake'), makeFood('Trout')];
    expect(pickFoodForLoss(pack, 4)?.name).toBe('Bread');
    expect(pickFoodForLoss(pack, 5)?.name).toBe('Chocolate slice');
    expect(pickFoodForLoss(pack, 2)?.name).toBe('Slice of cake');
    expect(pickFoodForLoss(pack, 9)?.name).toBe('Trout');
    expect(pickFoodForLoss([], 9)).toBeUndefined();
});

test('each goldfarm food heal is the value of the content consume table', async () => {
    const content = new URL('../../../vendor/rs-sdk/server/content/', import.meta.url);
    const rows = await Bun.file(new URL('scripts/player/configs/consumption/consume_normal.dbrow', content)).text();
    const heal = new Map<string, number>();
    for (const block of rows.split(/^\[/m)) {
        const hp = block.match(/^data=stat_heal,hitpoints,(\d+),0\s*$/m);
        if (!hp) continue;
        for (const m of block.matchAll(/^data=consumable,(\S+)\s*$/gm)) heal.set(m[1]!, Number(hp[1]));
    }
    const pack = await Bun.file(new URL('pack/obj.pack', content)).text();
    const debugname = new Map([...pack.matchAll(/^(\d+)=(\S+)\s*$/gm)].map(m => [Number(m[1]), m[2]!]));
    const display = new Map(((await Bun.file(new URL('../../../knowledge/items.json', import.meta.url)).json()) as { id: number; name: string }[]).map(i => [i.id, i.name]));

    expect(heal.get('bread')).toBe(4);
    expect(heal.get('chocolate_slice')).toBe(5);
    for (const [name, id] of Object.entries(FOOD_IDS)) {
        const want = heal.get(debugname.get(id)!);
        expect(display.get(id)).toBe(name);
        expect(want).toBeGreaterThan(0);
        expect(healOf({ id, name })).toBe(want!);
        expect(foodBiteHeal({ id })).toBe(want!);
    }
    const names = Object.keys(FOOD_IDS);
    for (const re of [...FOOD_ORDER, ...FOOD_NAMES]) expect(names.some(n => re.test(n))).toBe(true);
    const source = await Bun.file(new URL('../src/gather/thieving.ts', import.meta.url)).text();
    expect(source).not.toMatch(/\bHEAL\s*=\s*\[/);
    expect(source).not.toMatch(/\bheal\s*:\s*\d/);
});

test('calcEatAt guarantees never dying from Knight fail damage (DMG=3) while maximizing food efficiency', () => {
    expect(calcEatAt(10)).toBe(4);
    expect(calcEatAt(9)).toBe(4);
    expect(calcEatAt(20)).toBe(8);
    expect(calcEatAt(50)).toBe(20);
});

test('the Baker stops a steal only from a tile within 5 tiles that he sees; a guard is not his rule', () => {
    const recipe = { name: 'stealing_bakery_stall', loc: 1, level: 5, respawn: 8, loot: [1], questGate: false, owners: [50], guards: [60] };
    const baker = { id: 50, x: 10, z: 10, inCombat: false };
    const guard = { id: 60, x: 10, z: 10, inCombat: false };
    const open = () => true;
    const shut = () => false;
    expect(ownerSeesTile(recipe, { x: 13, z: 12 }, 0, [baker], open)).toBe(true);
    expect(ownerSeesTile(recipe, { x: 15, z: 10 }, 0, [baker], open)).toBe(true);
    expect(ownerSeesTile(recipe, { x: 16, z: 10 }, 0, [baker], open)).toBe(false);
    expect(ownerSeesTile(recipe, { x: 12, z: 10 }, 0, [baker], shut)).toBe(false);
    expect(ownerSeesTile(recipe, { x: 12, z: 10 }, 0, [guard], open)).toBe(false);
    const asked: number[][] = [];
    ownerSeesTile(recipe, { x: 12, z: 11 }, 0, [baker], (x, z, toX, toZ, level) => {
        asked.push([x, z, toX, toZ, level]);
        return true;
    });
    expect(asked).toEqual([[10, 10, 12, 11, 0]]);
});

test('a thief moves to the refuge spot once, after a full window in which its own spot showed no knight too often', () => {
    const full = { ticks: REFUGE_WINDOW, none: Math.ceil(REFUGE_NONE * REFUGE_WINDOW), moved: false, atRefuge: false };
    expect(refugeDue(full)).toBe(true);
    expect(refugeDue({ ...full, none: 32 })).toBe(true);
    expect(refugeDue({ ...full, none: Math.ceil(REFUGE_NONE * REFUGE_WINDOW) - 1 })).toBe(false);
    expect(refugeDue({ ...full, ticks: REFUGE_WINDOW - 1, none: REFUGE_WINDOW - 1 })).toBe(false);
    expect(refugeDue({ ...full, moved: true })).toBe(false);
    expect(refugeDue({ ...full, atRefuge: true })).toBe(false);
});

// --- Goldfarm-stable (formerly goldfarm-stable.test.ts) ---
const atTile = (worldX: number, worldZ: number, level = 0) => ({ worldX, worldZ, level });

test('actual lite cancellation sends MOVE_GAMECLICK while same-tile success sends no packet', async () => {
    const root = resolve(import.meta.dir, '../../../vendor/rs-sdk/server/webclient/src');
    await import(resolve(root, 'lite/dom-shim.ts'));
    const { findPathToTile } = await import(resolve(root, 'lite/movement.ts'));
    const { default: CollisionMap } = await import(resolve(root, 'dash3d/CollisionMap.ts'));
    const writes: number[] = [];
    const client: any = {
        ensureCollision() {},
        collision: [new CollisionMap()],
        minusedlevel: 0,
        localPlayer: { routeX: [50], routeZ: [50] },
        mapBuildBaseX: 2604,
        mapBuildBaseZ: 3233,
        out: {
            p1Enc(n: number) {
                writes.push(n);
            },
            p1() {},
            p2() {},
        },
    };
    expect(findPathToTile(client, 50, 50, false)).toBe(true);
    expect(writes).toEqual([]);
    const p = { worldX: 2654, worldZ: 3283, level: 0 };
    let pending: any;
    const s: any = {
        sdk: { getState: () => ({ player: p }) },
        direct: async (a: any) => {
            pending = a;
            return { success: findPathToTile(client, a.x - client.mapBuildBaseX, a.z - client.mapBuildBaseZ, false) };
        },
    };
    const cancel = farmPickCancellation(s, async () => ({ plan: (_l, _f, to) => [to] }));
    expect(await cancel()).toBe(false);
    expect(writes).toEqual([234]);
    p.worldX = pending.x;
    p.worldZ = pending.z;
    expect(await cancel()).toBe(true);
    expect(writes).toEqual([234]);
});

test('pick cancellation requires an observed adjacent step, never same-tile SDK success', async () => {
    const p = { worldX: 2654, worldZ: 3283, level: 0 };
    let calls = 0;
    let pending: any;
    const s: any = {
        sdk: { getState: () => ({ player: p }) },
        direct: async (a: any) => {
            calls++;
            expect(a.x !== p.worldX || a.z !== p.worldZ).toBe(true);
            expect(a.running).toBe(false);
            pending = a;
            return { success: true };
        },
    };
    const cancel = farmPickCancellation(s, async () => ({ plan: (_l, _f, to) => [to] }));
    expect(await cancel()).toBe(false);
    expect(await cancel()).toBe(false);
    expect(calls).toBe(2);
    p.worldX = pending.x;
    p.worldZ = pending.z;
    expect(await cancel()).toBe(true);
    expect(await cancel()).toBe(true);
    expect(calls).toBe(2);
    const blocked = farmPickCancellation(s, async () => ({ plan: () => [] }));
    expect(await blocked()).toBe(false);
    expect(calls).toBe(2);
});

test('error settlement observes a late pick credit before logout instead of reading a frozen cache', async () => {
    let tick = 600;
    let coins = 10300;
    let xp = 1000;
    let cancels = 0;
    let closed = false;
    const result = await farmSettlePicks({
        read: () => ({ tick, coins, xp, busy: tick < 608, inFlight: tick < 602, available: !closed }),
        cancel: async () => {
            cancels++;
            return true;
        },
        wait: async () => {
            tick++;
            if (tick === 603) {
                coins += 50;
                xp += 2107.5;
            }
            return true;
        },
    });
    closed = true;
    expect(result.exact).toBe(true);
    expect(result.coins).toBe(10350);
    expect(result.xp).toBe(3107.5);
    expect(tick).toBeGreaterThanOrEqual(618);
    expect(cancels).toBeGreaterThan(1);
    expect(tick).toBeLessThanOrEqual(632);
});

test('error settlement is bounded and never calls a stale or rejected observation exact', async () => {
    for (const mode of ['credits', 'xp', 'busy', 'cancel', 'ended', 'frozen', 'skipped', 'throw'] as const) {
        let tick = 0;
        let waits = 0;
        const result = await farmSettlePicks({
            read: () => ({ tick, coins: mode === 'credits' ? tick * 50 : 100, xp: mode === 'xp' ? tick : 1000, busy: mode === 'busy', inFlight: false, available: mode !== 'ended' }),
            cancel: async () => mode !== 'cancel',
            wait: async () => {
                waits++;
                if (mode === 'throw') throw Error('lost tick stream');
                if (mode !== 'frozen') tick += mode === 'skipped' ? 2 : 1;
                return mode !== 'ended';
            },
        });
        expect(result.exact).toBe(false);
        expect(waits).toBeLessThanOrEqual(32);
    }
});

test('the recorded bank path opens the north door although its next tile is equally near', async () => {
    const p = { x: 2650, z: 3304, level: 0 };
    let tick = 100;
    let callback: (() => void) | undefined;
    let opens = 0;
    const targets: string[] = [];
    const corners = [
        { x: 2650, z: 3305 },
        { x: 2648, z: 3305 },
        { x: 2648, z: 3304 },
        { x: 2646, z: 3304 },
        { x: 2644, z: 3302 },
        { x: 2644, z: 3296 },
        { x: 2645, z: 3296 },
        { x: 2645, z: 3290 },
        { x: 2644, z: 3289 },
        { x: 2644, z: 3284 },
        { x: 2653, z: 3284 },
        { x: 2654, z: 3283 },
    ];
    const done = walkPath(
        {
            tick: () => tick,
            pos: () => p,
            onTick: f => {
                callback = f;
                return () => {
                    callback = undefined;
                };
            },
            plan: () => corners,
            locs: () => [{ id: 1530, x: 2650, z: 3305, name: 'Door', optionsWithIndex: [{ text: 'Open', opIndex: 1 }] }],
            interactLoc: () => {
                opens++;
            },
            walk: (x, z) => {
                targets.push(`${x},${z}`);
                return { success: false, phase: 'validation', reason: 'client_rejected', message: 'Failed to walk' };
            },
        },
        [{ ...BANK_SPOT, tol: 2 }],
        { maxTicks: 20 },
    );
    for (let i = 0; i < 20 && callback; i++) {
        tick++;
        callback();
    }
    const result = await done;
    expect(result.ok).toBe(false);
    expect(opens).toBeGreaterThan(0);
    expect(targets).toEqual([]);
    expect(result.detail).toContain('door 1530@2650,3305');
});

test('logout reports once but cannot refresh a frozen client cache, and failed logout stays false', async () => {
    for (const reason of ['logged-out', 'disconnected']) {
        let end!: (v: { reason: string }) => void;
        const coins = 10150;
        let serverCoins = 10150;
        let reports = 0;
        const lines: string[] = [];
        const s: any = {
            name: 'goldfarm-error',
            ended: new Promise(r => {
                end = r;
            }),
            direct: async () => {
                serverCoins += 50;
                end({ reason });
                return { success: true };
            },
            close: async () => {},
        };
        const done = settle(
            [s],
            reason === 'disconnected',
            ok => {
                reports++;
                expect(ok).toBe(false);
                expect(serverCoins).toBe(10200);
                expect(lines).toContain(`LOGOUT ${reason}`);
                return `original route error packCoins=${coins}`;
            },
            { log: l => lines.push(l) },
        );
        const duplicate = settle([s], true, () => {
            throw Error('second result');
        });
        expect(await done).toBe(false);
        expect(await duplicate).toBe(false);
        expect(reports).toBe(1);
        expect(lines.at(-1)).toBe('RESULT fail original route error packCoins=10150');
    }
});

test('installed farmWalk uses shared walkPath from both recorded house interiors to the bank', async () => {
    const code = `
import {mock,expect} from 'bun:test';
const module=${JSON.stringify(resolve(import.meta.dir, '../../core/src/walk.ts'))};
const real=await import(module);
let deps,adapted=0;
mock.module(module,()=>({...real,sessionWalker:async()=>{adapted++;return deps;}}));
const {farmWalk,BANK_SPOT}=await import(${JSON.stringify(resolve(import.meta.dir, '../src/gather/thieving.ts'))});
for(const startX of [2650,2651])for(const blocked of [false,true]){
 const p={x:startX,z:3304,level:0},listeners=new Set(),actions=[],plans=[];
 const door={id:1530,x:2650,z:3305,name:'Door',optionsWithIndex:[{text:'Open',opIndex:1}]};
 let tick=0,shut=true,pending=false,finished=false,result,error;
 const state=()=>({player:{worldX:p.x,worldZ:p.z,level:p.level},nearbyLocs:shut?[door]:[]});
 const s={sdk:{getState:state},bot:{interactLoc:async()=>{throw Error('worker bypassed shared walker');}}};
 deps={tick:()=>tick,pos:()=>p,onTick:f=>{listeners.add(f);return()=>listeners.delete(f);},
  locs:()=>state().nearbyLocs,
  plan:(_level,from,to)=>{
   plans.push({from:{...from},to:{...to}});
   return [...(from.x===2651?[{x:2650,z:3304}]:[]),
    {x:2650,z:3305},{x:2648,z:3305},{x:2648,z:3304},{x:2646,z:3304},
    {x:2644,z:3302},{x:2644,z:3296},{x:2645,z:3296},{x:2645,z:3290},
    {x:2644,z:3289},{x:2644,z:3284},{x:2653,z:3284},{...to}];
  },
  interactLoc:(loc,op)=>{expect(loc).toBe(door);expect(op).toBe(1);actions.push('open');pending=true;},
  walk:(x,z)=>{actions.push('walk');expect(shut).toBe(false);p.x=x;p.z=z;return {success:true};}
 };
 const before=adapted;
 const done=farmWalk(s,BANK_SPOT,2).then(r=>{result=r;},e=>{error=e;}).finally(()=>{finished=true;});
 for(let i=0;i<190&&!finished;i++){
  await Promise.resolve();tick++;
  if(pending&&!blocked){shut=false;pending=false;}
  for(const f of [...listeners])f();
  await Promise.resolve();
 }
 expect(finished).toBe(true);await done;
 expect(adapted-before).toBe(1);
 expect(plans[0]).toEqual({from:{x:startX,z:3304,level:0},to:{...BANK_SPOT,tol:2}});
 expect(plans.every(plan=>plan.to.x===BANK_SPOT.x&&plan.to.z===BANK_SPOT.z)).toBe(true);
 expect(actions[0]).toBe('open');expect(listeners.size).toBe(0);
 if(blocked){
  expect(String(error)).toContain('no farm route progress: no progress: door 1530@2650,3305');
  expect(result).toBeUndefined();expect(actions).toEqual(['open','open','open']);
  expect(p).toEqual({x:startX,z:3304,level:0});
 }else{
  expect(error).toBeUndefined();expect(result.ok).toBe(true);expect(result.doors).toBe(1);
  expect(Math.max(Math.abs(p.x-BANK_SPOT.x),Math.abs(p.z-BANK_SPOT.z))).toBeLessThanOrEqual(2);
 }
}
console.log('shared farm route checked');`;
    const child = Bun.spawn([process.execPath, '-e', code], { timeout: 8000, windowsHide: true, stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('shared farm route checked');
});

test('error cleanup preserves the original failure and attempts supported recovery only once', async () => {
    const original = Error('route rejected at 2650,3304');
    for (const supported of [true, false]) {
        for (const fail of [true, false]) {
            let calls = 0;
            let coins = 10150;
            let banked = 37;
            const outcome = await farmErrorCheckpoint(
                original,
                () => supported,
                async () => {
                    calls++;
                    if (fail) throw Error('bank refused');
                    banked += coins;
                    coins = 0;
                },
            );
            expect(outcome.reason).toBe(String(original));
            expect(calls).toBe(supported ? 1 : 0);
            expect(outcome.recovery).toBe(!supported ? 'unsupported' : fail ? 'failed: Error: bank refused' : 'banked');
            expect(banked + coins - 37).toBe(10150);
            if (!supported || fail) expect(coins).toBe(10150);
        }
    }
});

const foodItem = (name: string, id: number) => ({ id, name, count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] });

test('high HP shark eating has an exact food debit and the pinned 20 HP rule', async () => {
    const source = await Bun.file(new URL('../../../vendor/rs-sdk/server/content/scripts/player/configs/consumption/consume_normal.dbrow', import.meta.url)).text();
    expect(source).toMatch(/data=consumable,shark\r?\ndata=stat_heal,hitpoints,20,0/);
    const shark = foodItem('Shark', 385);
    let hp = 40;
    let held = 1;
    const rows: string[] = [];
    expect(selectFoodToEat([shark, foodItem('Trout', 333)], 35)).toBe(shark);
    expect(
        await farmEatReceipt({
            itemId: 385,
            count: () => held,
            hp: () => hp,
            tick: () => 1,
            eat: async () => {
                held--;
                hp += healOf(shark);
                return { success: true };
            },
            wait: async () => {},
            log: l => rows.push(l),
        }),
    ).toBe(true);
    expect(hp).toBe(60);
    expect(held).toBe(0);
    expect(rows[0]).toContain('"consumed":1');
});

test('owned sharks are edible food with the pinned 20 HP heal and are used after cheaper fish', () => {
    const shark = foodItem('Shark', 385);
    const trout = foodItem('Trout', 333);
    expect(isFoodItem(shark)).toBe(true);
    expect(isFoodItem({ ...shark, optionsWithIndex: [] })).toBe(false);
    expect(healOf(shark)).toBe(20);
    expect(selectFoodToEat([shark, trout], 6)).toBe(trout);
    expect(selectFoodToEat([shark], 6)).toBe(shark);
    expect(selectFoodToEat([shark, trout], 20)).toBe(shark);
    expect(WITHDRAW_FOOD.at(-1)!.test('Shark')).toBe(true);
    expect(WITHDRAW_FOOD.findIndex(re => re.test('Shark'))).toBe(WITHDRAW_FOOD.length - 1);
});

test('without a configured courier an exhausted supply exits at once and stays resumable', () => {
    expect(foodWaitLimit('', undefined, 100000)).toBe(0);
    expect(foodWaitLimit('', { name: '', server: 'rs-sdk-demo.fly.dev', role: 'courier', at: 100000, result: '' }, 100000)).toBe(0);
    expect(classify('RESULT fail no food supply: waited 0 ticks at bank ticks=40', false)).toBe('stopped');
});

test('eat receipts require item depletion, not an SDK success caused by HP regeneration', async () => {
    for (const scenario of ['regen', 'delayed', 'sdk-failure', 'multiple', 'cake']) {
        let count = 3;
        let hp = 4;
        const tick = 10;
        const logs: string[] = [];
        const result = await farmEatReceipt({
            itemId: 333,
            count: () => count,
            hp: () => hp,
            tick: () => tick,
            eat: async () => {
                hp++;
                if (scenario === 'sdk-failure' || scenario === 'cake') count--;
                if (scenario === 'multiple') count -= 2;
                return { success: scenario !== 'sdk-failure' };
            },
            wait: async () => {
                if (scenario === 'delayed') count--;
                else throw Error('timeout');
            },
            log: l => logs.push(l),
        });
        expect(result).toBe(['delayed', 'sdk-failure', 'cake'].includes(scenario));
        expect(logs).toHaveLength(1);
        const receipt = JSON.parse(logs[0]!.slice('EAT_RECEIPT '.length));
        expect(receipt.confirmed).toBe(result);
        expect(receipt.before - receipt.after).toBe(3 - count);
    }
});

test('nearby knights cannot lead a chain beyond the fixed market range', () => {
    const n = { index: 7, name: 'Knight of Ardougne', x: 2669, z: 3321, distance: 1, reachable: true, optionsWithIndex: [{ text: 'Pickpocket', opIndex: 3 }] };
    expect(farmPickTarget([n], atTile(2669, 3320))).toEqual({ npc: undefined, recenter: true, tol: 3 });
    expect(farmPickTarget([{ ...n, x: 2654, z: 3303 }], atTile(2653, 3302)).npc?.index).toBe(7);
});

test('normal completion banks the last pending pickpocket before the final coin snapshot', async () => {
    let held = 1200;
    let banked = 22400;
    await farmFinishCheckpoint({
        ok: true,
        died: () => false,
        coins: () => held,
        bank: async () => {
            held += 50;
            banked += held;
            held = 0;
        },
    });
    expect(banked + held - 17350).toBe(6300);
    expect(held).toBe(0);
});

test('completion refuses unbanked coins and never adds a bank walk to a failed or dead farm', async () => {
    await expect(farmFinishCheckpoint({ ok: true, died: () => false, coins: () => 50, bank: async () => {} })).rejects.toThrow('final coin deposit');
    for (const [ok, died] of [[false, false], [true, true]]) {
        let calls = 0;
        await farmFinishCheckpoint({
            ok: ok!,
            died: () => died!,
            coins: () => 50,
            bank: async () => {
                calls++;
            },
        });
        expect(calls).toBe(0);
    }
});

test('a knight behind a wall does not keep beating an available reachable pickpocket target', () => {
    const blocked = { index: 3572, name: 'Knight of Ardougne', x: 2666, z: 3291, distance: 1, reachable: false, optionsWithIndex: [{ text: 'Pickpocket', opIndex: 3 }] };
    const clear = { ...blocked, index: 3573, x: 2653, z: 3302, distance: 15, reachable: true };
    expect(farmPickTarget([blocked, clear], atTile(2665, 3291)).npc?.index).toBe(3573);
    expect(farmPickTarget([blocked], atTile(2665, 3291))).toEqual({ npc: undefined, recenter: true, tol: 3 });
    expect(farmPickTarget([blocked], atTile(2653, 3302)).recenter).toBe(false);
});

test('recorded 2651,3304 room restart walks onto the knight spot when every knight is unreachable', () => {
    const knight = { index: 3572, name: 'Knight of Ardougne', x: 2655, z: 3300, distance: 4, reachable: false, optionsWithIndex: [{ text: 'Pickpocket', opIndex: 3 }] };
    for (const [x, z] of [[2651, 3304], [2650, 3304]]) expect(farmPickTarget([knight], atTile(x!, z!))).toEqual({ npc: undefined, recenter: true, tol: 0 });
    expect(farmPickTarget([], atTile(2651, 3304)).recenter).toBe(false);
    expect(farmPickTarget([{ ...knight, reachable: true }], atTile(2651, 3304)).npc?.index).toBe(3572);
});

test('farm target selection preserves random-event exclusion and requires the real pickpocket option', () => {
    const n = { index: 1, name: 'Knight of Ardougne', x: 2653, z: 3302, distance: 1, optionsWithIndex: [{ text: 'Pickpocket', opIndex: 3 }] };
    expect(farmPickTarget([n], atTile(2653, 3302)).npc).toBe(n);
    expect(farmPickTarget([n], atTile(2653, 3302), new Set([1])).npc).toBeUndefined();
    expect(farmPickTarget([{ ...n, optionsWithIndex: [] }], atTile(2653, 3302)).npc).toBeUndefined();
});

test('the farm starts only in Ardougne market with Thieving 55 or more', () => {
    expect(farmStartProblem(atTile(BANK_SPOT.x, BANK_SPOT.z), 99)).toBeNull();
    expect(farmStartProblem(atTile(2653, 3302), 99)).toBeNull();
    expect(farmStartProblem(atTile(2655, 3310), 55)).toBeNull();
    expect(farmStartProblem(atTile(BANK_SPOT.x + ARDOUGNE_RADIUS, BANK_SPOT.z), 99)).toBeNull();
});

test('a completed farm can restart where its roaming knight left it', () => {
    expect(farmStartProblem(atTile(2656, 3325), 99)).toBeNull();
});

test('food recovery counts as work but walking, empty banks and failed attempts do not', () => {
    const before = { picks: 197, fails: 20, food: 1, banked: 20300 };
    expect(farmProgressTick(630, 921, before, { ...before, food: 9 })).toBe(921);
    expect(farmProgressTick(630, 921, before, { ...before, picks: 198 })).toBe(921);
    const bankMove = { ...before, banked: 25000 };
    expect(farmProgressTick(630, 921, before, bankMove)).toBe(630);
    expect(farmProgressTick(630, 921, before, before)).toBe(630);
    expect(farmProgressTick(630, 921, before, { ...before, food: 0 })).toBe(630);
});

test('repeated failed picks exhaust the useful-work window instead of renewing it', () => {
    let last = 10;
    let before = { picks: 0, fails: 0, food: 20 };
    for (let tick = 12; tick <= 310; tick += 2) {
        const after = { ...before, picks: before.picks + 1, fails: before.fails + 1 };
        last = farmProgressTick(last, tick, before, after);
        before = after;
    }
    expect(last).toBe(10);
    expect(310 - last).toBe(300);
    expect(farmProgressTick(last, 311, before, { ...before, picks: before.picks + 1 })).toBe(311);
    expect(farmProgressTick(last, 312, before, { ...before, food: 25 })).toBe(312);
});

test('starts that killed or idled live thieves are refused before any walk', () => {
    expect(farmStartProblem(atTile(3096, 3279), 99)).toMatch(/start in Ardougne market/);
    expect(farmStartProblem(atTile(3222, 3218), 99)).toMatch(/start in Ardougne market/);
    expect(farmStartProblem(atTile(3044, 3276), 99)).toMatch(/start in Ardougne market/);
    expect(farmStartProblem(atTile(BANK_SPOT.x, BANK_SPOT.z, 1), 99)).toMatch(/start in Ardougne market/);
    expect(farmStartProblem(undefined, 99)).toMatch(/position unknown/);
    expect(farmStartProblem(atTile(2654, 3312), 1)).toMatch(/below 55/);
});

test('a refused start blocks the account in both supervisors instead of logging it in again', () => {
    for (const why of [farmStartProblem(atTile(3096, 3279), 99)!, farmStartProblem(atTile(2654, 3312), 1)!, 'no goldfarm progress: idle 300 ticks with no pickpocket']) {
        const line = `RESULT fail ${why} ticks=1`;
        expect(isNoProgressFailure(line)).toBe(true);
        expect(classify(line, false)).toBe('blocked');
    }
});

test('an idle farm with no food stops (resumable); with food it is a stuck farm (blocked)', () => {
    expect(classify('RESULT fail no food: waited 300 ticks with no pickpocket and no food ticks=300', false)).toBe('stopped');
    expect(classify('RESULT fail no goldfarm progress: idle 300 ticks with no pickpocket ticks=300', false)).toBe('blocked');
});

test('a thief at the knights answers the courier only when it is in view, once per cooldown', () => {
    const here = [{ name: 'Knight' }, { name: 'bigpackage' }];
    expect(courierCheckDue(1000, -100_000, 'Bigpackage', here)).toBe(true);
    expect(courierCheckDue(1000, 1000 - COURIER_COOLDOWN + 1, 'Bigpackage', here)).toBe(false);
    expect(courierCheckDue(1000, 1000 - COURIER_COOLDOWN, 'Bigpackage', here)).toBe(true);
    expect(courierCheckDue(1000, -100_000, 'Bigpackage', [{ name: 'Bigpackage2' }, {}])).toBe(false);
    expect(courierCheckDue(1000, -100_000, '', here)).toBe(false);
    expect(COURIER_WANT_BELOW).toBeGreaterThan(2);
    expect(COURIER_WANT_BELOW).toBeLessThan(26);
});

test('the recorded zero-food and one-food recoveries use bank and courier only', async () => {
    for (const food of [0, 1]) {
        const actions: string[] = [];
        await replenishFarmFood(
            async () => {
                actions.push('bank');
            },
            () => food,
            async () => {
                actions.push('courier');
            },
        );
        expect(actions).toEqual(['bank', 'courier']);
    }
    let food = 1;
    const actions: string[] = [];
    await replenishFarmFood(
        async () => {
            food = 26;
            actions.push('bank');
        },
        () => food,
        async () => {
            actions.push('courier');
        },
    );
    expect(actions).toEqual(['bank']);
});

test('a real returning courier permits a bounded food wait; stale or wrong evidence does not', () => {
    const now = 100000;
    const courier = { name: 'Bigpackage', server: 'rs-sdk-demo.fly.dev', role: 'courier', at: now, result: '' };
    expect(foodWaitLimit('Bigpackage', courier, now)).toBe(1500);
    for (const s of [undefined, { ...courier, at: now - 30000 }, { ...courier, at: now + 1 }, { ...courier, name: 'Stranger' }, { ...courier, result: 'fail' }, { ...courier, role: 'bank' }, { ...courier, server: 'localhost:8888' }]) {
        expect(foodWaitLimit('Bigpackage', s, now)).toBe(300);
    }
});

test('the courier service may wait between trips for the next cooked pack without stranding a hungry thief', () => {
    const now = 100000;
    const service = { at: now, jobs: [{ account: 'Bigpackage', script: 'scripts/aio-logistics.ts', args: ['food-courier'], enabled: true, state: 'waiting offline: no fresh low-food farm or dated source food stock' }] };
    expect(foodWaitLimit('Bigpackage', undefined, now, service)).toBe(1500);
    expect(foodWaitLimit('Bigpackage', undefined, now, { ...service, at: now - 30000 })).toBe(300);
    for (const patch of [{ enabled: false }, { state: 'ended: died after 1 runs' }, { account: 'Stranger' }, { args: ['banker'] }]) {
        expect(foodWaitLimit('Bigpackage', undefined, now, { ...service, jobs: [{ ...service.jobs[0], ...patch }] })).toBe(300);
    }
});

test('a bank containing owned cake portions can replenish the same food the farm eats', () => {
    for (const name of ['2/3 cake', 'Slice of cake']) {
        const item = { id: name === '2/3 cake' ? 1893 : 1895, name, count: 3, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] };
        expect(isFoodItem(item)).toBe(true);
        const selected = WITHDRAW_FOOD.flatMap(pattern => [item].filter(row => pattern.test(row.name)));
        expect(selected).toHaveLength(1);
        expect(selected[0]!.count).toBeGreaterThanOrEqual(2);
    }
});

// --- Single pickpocket worker (formerly microbot-a-pickpocket.test.ts) ---
const pocketProfs = pickpocketProfiles();
const pocketOpts: PocketOptions = { successes: 1, attempts: 3, cap: 100, maxNoProgress: 3, hpFloor: 10, eatAt: 15, food: 0, foodReserve: 0, xpRate: 1, members: true };

test('all 12 native target rows have exact trigger-mapped NPCs and loot ranges', () => {
    expect(pocketProfs.length).toBe(12);
    expect(pocketProfs.every(p => p.npcs.length > 0 && p.loot.length > 0 && p.level > 0 && p.xp > 0 && p.damage > 0 && p.stunTicks >= 8)).toBe(true);
    expect(pocketProfs.find(p => p.name === 'hero')!.loot.length).toBe(7);
    expect(pocketProfs.find(p => p.name === 'viking')!.level).toBe(45);
});

test('native multi-row loot, item-free XP success and exact failure damage are distinct', () => {
    const p = pocketProfs.find(p => p.name === 'watchman')!;
    const b = { items: { 590: 1 }, xp: 100, hp: 30 };
    const a = { items: { 590: 1, 995: 60, 2309: 1 }, xp: 100 + p.xp, hp: 30 };
    expect(pocketEffect(p, b, a, 'success', 1)).toBe('success');
    expect(pocketEffect(p, b, { ...a, items: { 590: 1 } }, 'success', 1)).toBe('success');
    expect(pocketEffect(p, b, { ...b, hp: 27 }, 'failure', 1)).toBe('failure');
    expect(pocketEffect(p, b, { ...b, hp: 26 }, 'failure', 1)).toBe('invalid');
    expect(pocketEffect(p, b, { ...a, items: { 995: 60, 2309: 1 } }, 'success', 1)).toBe('invalid');
    expect(pocketEffect(p, b, a, 'none', 1)).toBe('invalid');
});

test('unsafe and unbounded pickpocket options fail before session actions', () => {
    expect(() => validatePocketOptions({ ...pocketOpts, members: false })).toThrow();
    expect(() => validatePocketOptions({ ...pocketOpts, attempts: 0 })).toThrow();
    expect(() => validatePocketOptions({ ...pocketOpts, food: 995 })).toThrow();
});

for (const initialHp of [30, 12]) {
    test(`native failure damage is accounted; staged HP ${initialHp} bounds the next pocket`, async () => {
        const p = pocketProfs.find(p => p.name === 'man')!;
        let tick = 0;
        let xp = 0;
        let hp = initialHp;
        let coins = 0;
        let calls = 0;
        let lastAttempt = -100;
        let revision = 0;
        const messages: any[] = [];
        const listeners = new Set<() => void>();
        const pack = () => [{ id: 590, count: 1, slot: 0 }, { id: 995, count: coins, slot: 1 }].filter(i => i.count > 0);
        const s: any = {
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (f: () => void) => {
                listeners.add(f);
                return () => listeners.delete(f);
            },
            sdk: {
                getInventory: pack,
                getSkill: (name: string) => ({ level: name === 'Hitpoints' ? hp : 99 }),
                getSkillXp: () => xp,
                getState: () => ({
                    player: { lifeId: 1, worldX: 3200, worldZ: 3200, level: 0, combat: { inCombat: false } },
                    inventory: pack(),
                    gameMessages: messages,
                    nearbyNpcs: [{ id: p.npcs[0], index: 4, distance: 1, inCombat: false, reachable: true, optionsWithIndex: [{ text: 'Pickpocket', opIndex: 3 }] }],
                }),
                sendInteractNpc: async (index: number, op: number) => {
                    expect(index).toBe(4);
                    expect(op).toBe(3);
                    calls++;
                    if (calls === 1) {
                        hp -= p.damage;
                        messages.push({ text: `You fail to pick the ${p.pocket}.`, tick, observationId: ++revision });
                        lastAttempt = tick;
                    } else {
                        expect(tick - lastAttempt).toBeGreaterThanOrEqual(p.stunTicks);
                        xp += p.xp;
                        coins += 3;
                        messages.push({ text: `You pick the ${p.pocket}.`, tick, observationId: ++revision });
                    }
                    return { success: true };
                },
            },
            bot: { dismissBlockingUI: async () => {} },
        };
        const timer = setInterval(() => {
            tick++;
            for (const f of listeners) f();
        }, 1);
        try {
            const result = await runPickpockets(s, p, pocketOpts);
            if (initialHp === 30) {
                expect(result).toMatchObject({ ok: true, successes: 1, failures: 1, attempts: 2, hp: 29, kitPreserved: true });
                expect(result.loot[995]).toBe(3);
                expect(calls).toBe(2);
            } else {
                expect(result).toMatchObject({ ok: false, stop: 'health/food', successes: 0, failures: 1, attempts: 1, hp: 11, kitPreserved: true });
                expect(calls).toBe(1);
            }
        } finally {
            clearInterval(timer);
        }
    });
}

// --- Nature chest (formerly microbot-b-nature-chest.test.ts) ---
const natureState = (n = 0, coins = n * 3, xp = n * 25) =>
    ({
        player: { worldX: 2673, worldZ: 3301, level: 1, lifeId: 1 },
        skills: [{ name: 'Thieving', level: 28, experience: xp }, { name: 'Hitpoints', level: 10, experience: 1000 }],
        inventory: [{ id: 561, count: n, slot: 0 }, { id: 995, count: coins, slot: 1 }, { id: 1735, count: 1, slot: 2 }],
        nearbyLocs: [{ id: 2567, x: 2673, z: 3301, level: 1, optionsWithIndex: [{ text: 'Open', opIndex: 1 }, { text: 'Search for traps', opIndex: 2 }] }],
    }) as unknown as BotWorldState;
const natureOpts = { x: 2673, z: 3301, level: 1, maxLoots: 2, cap: 100, idleTicks: 40 };

test('options require explicit native location and finite limits', () => {
    expect(() => chestOptions({})).toThrow('CHEST_X');
    expect(() => chestOptions({ CHEST_X: '1', CHEST_Z: '2', CHEST_LEVEL: '1', MAX_LOOTS: 'NaN' })).toThrow('MAX_LOOTS');
    expect(chestOptions({ CHEST_X: '1', CHEST_Z: '2', CHEST_LEVEL: '1' }).maxLoots).toBe(10);
});

test('reward requires both items, XP and intact assets', () => {
    expect(natureChestEffect(natureState(), natureState())).toBe(false);
    expect(natureChestEffect(natureState(), natureState(1))).toBe(true);
    expect(() => natureChestEffect(natureState(), natureState(1, 2))).toThrow('reconcile');
    expect(() => natureChestEffect(natureState(), natureState(1, 3, 0))).toThrow('reconcile');
    const lost = natureState(1);
    lost.inventory.pop();
    expect(() => natureChestEffect(natureState(), lost)).toThrow('assets');
});

test('finite consumer uses traps option and exact output; stop prevents dispatch', async () => {
    let current = natureState();
    let tick = 0;
    const actions: number[] = [];
    const d = {
        state: () => current,
        tick: () => tick,
        stopped: () => false,
        act: async (_x: number, _z: number, id: number, op: number) => {
            expect(id).toBe(2567);
            actions.push(op);
            current = natureState(actions.length);
            return { success: true };
        },
        wait: async (p: () => boolean) => p(),
        step: async () => {
            tick++;
        },
    };
    expect(await runNatureChest(d, natureOpts)).toEqual({ loots: 2, natureRunes: 2, coins: 6, ticks: 1 });
    expect(actions).toEqual([2, 2]);
    await expect(runNatureChest({ ...d, stopped: () => true }, natureOpts)).rejects.toThrow('stopped');
    expect(actions.length).toBe(2);
});

test('wrong floor, no reward and idle chest terminate', async () => {
    let current = natureState();
    let tick = 0;
    const d = {
        state: () => current,
        tick: () => tick,
        stopped: () => false,
        act: async () => ({ success: true }),
        wait: async () => false,
        step: async () => {
            tick++;
        },
    };
    await expect(runNatureChest(d, { ...natureOpts, level: 0 })).rejects.toThrow('floor');
    await expect(runNatureChest(d, natureOpts)).rejects.toThrow('unobserved');
    current = { ...natureState(), nearbyLocs: [] };
    await expect(runNatureChest(d, { ...natureOpts, idleTicks: 2 })).rejects.toThrow('no progress');
});

// --- Thieving stalls (formerly microbot-c-stalls.test.ts) ---
test('all thirteen native stall rows resolve location and loot IDs', () => {
    const rows = stallRecipes();
    expect(rows).toHaveLength(13);
    expect(new Set(rows.map(r => r.loc)).size).toBe(13);
    expect(rows.find(r => r.name === 'stealing_silk_stall')).toMatchObject({ level: 20, respawn: 16 });
    expect(rows.filter(r => r.questGate)).toHaveLength(2);
});

test('stall progress requires one declared loot item and XP', () => {
    const r = stallRecipes().find(r => r.name === 'stealing_silk_stall')!;
    const before = [{ id: r.loot[0]!, count: 2 }];
    expect(stallEffect(r, before, [{ id: r.loot[0]!, count: 3 }], 20, 44)).toBe(true);
    expect(stallEffect(r, before, [{ id: r.loot[0]!, count: 3 }], 20, 20)).toBe(false);
    expect(stallEffect(r, before, [{ id: 995, count: 3 }], 20, 44)).toBe(false);
});

test('stall approach waits for the exact native owner and guard sight rules', () => {
    const tea = stallRecipes().find(r => r.name === 'stealing_tea_stall')!;
    expect(tea.owners).toContain(595);
    const player = { worldX: 3268, worldZ: 3410, level: 0 };
    expect(stallWatched(tea, player, [{ id: 595, x: 3271, z: 3411, inCombat: false }], () => true)).toBe(true);
    expect(stallWatched(tea, player, [{ id: 595, x: 3271, z: 3411, inCombat: false }], () => false)).toBe(false);
    expect(stallWatched(tea, player, [{ id: 595, x: 3274, z: 3411, inCombat: false }], () => true)).toBe(false);
    expect(stallWatched(tea, player, [{ id: 1, x: 3269, z: 3410, inCombat: false }], () => true)).toBe(false);
});

test('native stall projectile clipping is scoped to its sight query and restores walk flags on error', () => {
    let mask = 256;
    const grid = {
        isFlagged: (_x: number, _z: number, _l: number, bits: number) => (mask & bits) !== 0,
        __set: (_x: number, _z: number, _l: number, bits: number) => {
            mask = bits;
        },
    };
    expect(withStallSightBlocker(grid, { x: 1, z: 2, level: 0, width: 1, length: 1 }, () => mask)).toBe(256 | 131072);
    expect(mask).toBe(256);
    expect(() =>
        withStallSightBlocker(grid, { x: 1, z: 2, level: 0, width: 1, length: 1 }, () => {
            throw Error('query');
        }),
    ).toThrow('query');
    expect(mask).toBe(256);
});

test('each stall of the type blocks sight inside one query, and each tile gets its flags back', () => {
    const flags = new Map<string, number>([['5,5', 256], ['9,5', 0]]);
    const key = (x: number, z: number) => `${x},${z}`;
    const grid = {
        isFlagged: (x: number, z: number, _l: number, bits: number) => ((flags.get(key(x, z)) ?? 0) & bits) !== 0,
        __set: (x: number, z: number, _l: number, bits: number) => {
            flags.set(key(x, z), bits);
        },
    };
    const stalls = [{ x: 5, z: 5, level: 0, width: 1, length: 1 }, { x: 9, z: 5, level: 0, width: 1, length: 1 }];
    expect(withStallSightBlockers(grid, stalls, () => [flags.get('5,5'), flags.get('9,5')])).toEqual([256 | 131072, 131072]);
    expect([flags.get('5,5'), flags.get('9,5')]).toEqual([256, 0]);
    expect(() =>
        withStallSightBlockers(grid, stalls, () => {
            throw Error('query');
        }),
    ).toThrow('query');
    expect([flags.get('5,5'), flags.get('9,5')]).toEqual([256, 0]);
    expect(withStallSightBlockers(grid, [], () => flags.get('5,5'))).toBe(256);
});

test('finite silk worker retains declared loot and unrelated inventory', async () => {
    const r = stallRecipes().find(r => r.name === 'stealing_silk_stall')!;
    const items = [{ id: r.loot[0]!, count: 2 }, { id: 995, count: 9 }];
    let xp = 1;
    const s: any = {
        tick: () => 0,
        sdk: {
            getInventory: () => items,
            getSkill: () => ({ level: 99 }),
            getSkillXp: () => xp,
            getState: () => ({ player: { lifeId: 1 }, nearbyLocs: [{ id: r.loc, x: 1, z: 2 }] }),
            sendInteractLoc: async (_x: number, _z: number, id: number, op: number) => {
                expect([id, op]).toEqual([r.loc, 2]);
                items[0]!.count++;
                xp += 24;
                return { success: true };
            },
        },
    };
    expect(await stealStall(s, r.name, 1, 40)).toMatchObject({ ok: true, made: 1, preserved: true });
    expect(items[1]!.count).toBe(9);
});

test('life guard snapshots mutable respawn identity and latches death', () => {
    const state: any = { player: { lifeId: 7, respawnCount: 1 } };
    const s: any = { sdk: { getState: () => state, getSkill: () => ({ level: 10 }) } };
    const life = watchProductionLife(s);
    state.player.respawnCount = 2;
    expect(life.reason()).toBe('life changed');
    state.player.respawnCount = 1;
    expect(life.stopped()).toBe(true);
});

test('production life stops on damage, requested stop and ended session', async () => {
    let hp = 10;
    let stop = false;
    let end!: () => void;
    const s: any = {
        ended: new Promise<void>(r => {
            end = r;
        }),
        sdk: { getState: () => ({ player: { lifeId: 1 } }), getSkill: () => ({ level: hp }) },
    };
    const a = watchProductionLife(s);
    hp = 9;
    expect(a.reason()).toBe('damage observed');
    hp = 10;
    const b = watchProductionLife(s, () => stop);
    stop = true;
    expect(b.reason()).toBe('stop requested');
    stop = false;
    const c = watchProductionLife(s);
    end();
    await Promise.resolve();
    expect(c.reason()).toBe('session ended');
});

test('player monitor filters baseline, radius and explicitly ignored owners', () => {
    const players = [{ name: 'Owned', index: 1, distance: 2 }, { name: 'Old', index: 2, distance: 3 }, { name: 'New', index: 3, distance: 4 }];
    const p = { radius: 5, ignore: ['owned'], onlyNew: true, action: 'stop' as const };
    expect(monitoredPlayer(players, p, new Set(['old']))?.name).toBe('New');
    expect(monitoredPlayer(players, { ...p, radius: 1 }, new Set())).toBeUndefined();
});

// --- Bank-backed pickpocket trips (formerly microbot-pickpocket-trip.test.ts) ---
const tripJob: PickpocketTrip = {
    profile: 'man',
    bank: { x: 3185, z: 3436, level: 0 },
    site: { x: 3154, z: 3428, level: 0 },
    target: 4,
    batch: 2,
    cap: 2000,
    returnTicks: 300,
    members: true,
    reserve: 1,
    food: 379,
    foodPerSuccess: 7,
    attemptsPerSuccess: 6,
    hpFloor: 70,
    eatAt: 98,
    xpRate: 1,
};

function tripFixture(mode = 'normal') {
    let quietUntil = -1;
    let tick = 0;
    let hp = 99;
    let xp = 0;
    let generation = 1;
    let open = false;
    let calls = 0;
    let foods = 0;
    let withdrawals = 0;
    let returns = 0;
    let opens = 0;
    let stop = false;
    const messages: any[] = [];
    const inv: any[] = [];
    const gear: any[] = [];
    const bank: any[] = [{ id: 379, count: 29, name: 'Lobster', slot: 0 }, { id: 995, count: 37, name: 'Coins', slot: 1 }];
    const player = { name: 'Owned', worldX: 3185, worldZ: 3436, level: 0, lifeId: 1, respawnCount: 0, isDead: false, combat: { inCombat: false, targetType: 'none', lastDamageTick: -1 } };
    const count = (a: any[], id: number) => a.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const add = (a: any[], id: number, n: number) => {
        const item = a.find(i => i.id === id);
        if (item) item.count += n;
        else a.push({ id, count: n, name: id === 379 ? 'Lobster' : 'Coins', slot: a.length, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] });
    };
    const eat = async () => {
        const row = inv.find(i => i.id === 379);
        if (!row) throw Error('no food');
        row.count--;
        if (row.count === 0) inv.splice(inv.indexOf(row), 1);
        foods++;
        hp = Math.min(99, hp + 12);
        return { success: true };
    };
    const s: any = {
        name: 'Owned',
        client: {
            localPlayer: { combatCycle: 0 },
            getClientCycle: () => tick * 25,
            membersAccount: 1,
            executeBotAction: () => ({ success: true }),
            objType: (id: number) => ({ certtemplate: -1, stackable: id === 995 }),
        },
        tick: () => tick,
        ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            let active = true;
            const next = () =>
                queueMicrotask(() => {
                    if (active) {
                        tick++;
                        if (tick >= quietUntil) player.combat.inCombat = false;
                        cb();
                        next();
                    }
                });
            next();
            return () => {
                active = false;
            };
        },
        bankObservation: () => (open ? { generation, at: tick, items: bank } : null),
        sdk: {
            getStateAge: () => 0,
            getInventory: () => inv,
            getEquipment: () => gear,
            getSkill: (n: string) => ({ level: n === 'Hitpoints' ? hp : 99, baseLevel: 99 }),
            getSkillXp: () => xp,
            getState: () => ({
                player,
                inventory: inv,
                equipment: gear,
                bank: { isOpen: open, items: bank },
                interface: { isOpen: open },
                dialog: { isOpen: false },
                autoRetaliateEnabled: false,
                prayers: { activePrayers: Array(15).fill(false) },
                combatStyle: { known: true, currentStyle: 0 },
                skills: [{ name: 'Thieving', experience: xp }, { name: 'Hitpoints', experience: 100 }],
                nearbyPlayers: [],
                nearbyNpcs: [{ id: 1, index: 4, reachable: true, distance: 1, inCombat: false, optionsWithIndex: [{ text: 'Pickpocket', opIndex: 3 }] }],
                gameMessages: messages,
            }),
            sendCloseModal: async () => {
                open = false;
                return { success: true };
            },
            sendUseItem: eat,
            sendInteractNpc: async () => {
                calls++;
                if (mode === 'unknown') return { success: true };
                if (mode === 'life') {
                    player.lifeId++;
                    return { success: true };
                }
                const failure = (mode === 'normal' || mode === 'grace') && calls % 3 === 1;
                if (failure) {
                    hp--;
                    if (mode === 'grace') {
                        player.combat.inCombat = true;
                        player.combat.lastDamageTick = tick;
                        quietUntil = tick + 16;
                        s.client.localPlayer.combatCycle = s.client.getClientCycle() + 400;
                    }
                } else {
                    xp += 8;
                    add(inv, 995, 3);
                }
                messages.push({
                    type: mode === 'chat' ? 2 : 0,
                    sender: mode === 'chat' ? 'Other' : '',
                    fromSelf: false,
                    tick,
                    observationId: messages.length + 1,
                    text: failure ? "You fail to pick the man's pocket." : "You pick the man's pocket.",
                });
                if (mode === 'stop') stop = true;
                return { success: true };
            },
        },
        bot: {
            withdrawItem: async (item: any, n: number) => {
                withdrawals++;
                item.count -= n;
                add(inv, item.id, n);
                generation++;
                return { success: true };
            },
            depositItem: async (item: any) => {
                const amount = count(inv, item.id);
                for (let i = inv.length - 1; i >= 0; i--) if (inv[i].id === item.id) inv.splice(i, 1);
                add(bank, item.id, amount);
                generation++;
                return { success: true };
            },
            openBank: async () => {
                opens++;
                open = true;
                generation++;
                return { success: true };
            },
            closeBank: async () => {
                open = false;
                return { success: true };
            },
            dismissBlockingUI: async () => {
                open = false;
            },
            eatFood: eat,
        },
    };
    const booth = { id: 2213, name: 'Bank booth', x: 3185, z: 3436, distance: 1, optionsWithIndex: [{ text: 'Bank', opIndex: 2 }] };
    s.sdk.getNearbyLocs = () => [booth];
    s.sdk.findNearbyNpc = () => null;
    s.sdk.sendInteractLoc = () => s.bot.openBank();
    s.sdk.sendBankWithdraw = (slot: number, n: number) => s.bot.withdrawItem(bank.find(i => i.slot === slot), n);
    s.sdk.sendBankDeposit = (slot: number, n: number) => s.bot.depositItem(inv.find(i => i.slot === slot), n);
    s.sdk.waitForCondition = async (predicate: any) => {
        const st = s.sdk.getState();
        if (!predicate(st)) throw Error('condition absent');
        return st;
    };
    s.sdk.findBankItem = (target: any) => bank.find(i => (typeof target === 'string' ? i.name.includes(target) : target.test(i.name)));
    const getState = s.sdk.getState;
    s.sdk.getState = () => {
        const st = getState();
        st.bank.noteMode = false;
        st.nearbyLocs = [booth];
        return st;
    };
    setEquipmentObserved(s.client, true);
    const bankRunner: any = async (_s: any, j: any, p: any, requestStop: () => boolean) => {
        let completed = 0;
        let trips = 0;
        let failure = '';
        let recoveryDeferred = false;
        try {
            while (completed < j.target) {
                if (requestStop()) throw Error('stopped');
                const n = Math.min(j.batch, j.target - completed);
                const amount = p.inputs[379] * n;
                expect(count(bank, 379) - amount).toBeGreaterThanOrEqual(j.reserve);
                bank.find(i => i.id === 379).count -= amount;
                add(inv, 379, amount);
                withdrawals++;
                open = false;
                player.worldX = p.site.x;
                player.worldZ = p.site.z;
                const made = await p.run(n, j.cap, () => hp < 99 || requestStop());
                completed += made;
                trips++;
                player.worldX = p.bank.x;
                player.worldZ = p.bank.z;
                for (const row of inv.splice(0)) add(bank, row.id, row.count);
                returns++;
            }
        } catch (e) {
            failure = String(e);
            recoveryDeferred = p.deferBankRecovery();
            if (!recoveryDeferred) {
                player.worldX = p.bank.x;
                player.worldZ = p.bank.z;
                for (const row of inv.splice(0)) add(bank, row.id, row.count);
                returns++;
            }
        }
        open = false;
        return { ok: !failure && completed >= j.target && !requestStop(), atBank: !recoveryDeferred, completed, trips, failure, recoveryDeferred };
    };
    return {
        s,
        bank,
        inv,
        player,
        bankRunner,
        regenerate: () => {
            hp = Math.min(99, hp + 1);
        },
        stop: () => stop,
        calls: () => calls,
        foods: () => foods,
        withdrawals: () => withdrawals,
        returns: () => returns,
        opens: () => opens,
        tick: () => tick,
    };
}

test('all 12 native profile contracts accept actual declared spawns and source foods', () => {
    const npcs = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../knowledge/npcs.json'), 'utf8')) as any[];
    for (const p of pickpocketProfiles()) {
        const n = npcs.find(n => p.npcs.includes(n.id) && n.spawns.length);
        const site = n.spawns[0];
        expect(validatePickpocketTrip({ ...tripJob, profile: p.name, site: { x: site.x, z: site.z, level: site.level }, hpFloor: 1, eatAt: 50 }).profile.name).toBe(p.name);
    }
    expect(() => validatePickpocketTrip({ ...tripJob, site: { x: 1, z: 1, level: 0 } })).toThrow('native profile spawn');
});

test('actual single-attempt worker plus shared-bank callback makes 2 trips with native failures, owned food and exact XP/stock', async () => {
    const f = tripFixture();
    const r = await runPickpocketTrips(f.s, tripJob, f.stop, { bank: f.bankRunner });
    expect(r).toMatchObject({ ok: true, trips: 2, verifiedSuccesses: 4, verifiedFailures: 2, eaten: 2, balanced: true, exactXp: true, paidXp: 32, recoveryDeferred: false });
    expect(f.foods()).toBe(2);
    expect(f.bank.find(i => i.id === 379).count).toBe(27);
    expect(f.bank.find(i => i.id === 995).count).toBe(49);
    expect(f.inv).toHaveLength(0);
    expect(f.s.bankObservation()).toBeNull();
    expect(f.opens()).toBe(2);
});

test('actual shared runBankProfile consumer allows native stun damage inside producer then requires healed bank handoff', async () => {
    const f = tripFixture();
    f.player.worldX = tripJob.site!.x;
    f.player.worldZ = tripJob.site!.z;
    const r = await runPickpocketTrips(f.s, { ...tripJob, bank: tripJob.site }, f.stop, { bank: runBankProfile });
    expect(r).toMatchObject({ ok: true, trips: 2, completed: 4, verifiedFailures: 2, eaten: 2, balanced: true, exactXp: true });
    expect(f.inv).toHaveLength(0);
    expect(f.bank.find(i => i.id === 995).count).toBe(49);
    expect(f.s.sdk.getSkill('Hitpoints').level).toBe(99);
    expect(f.s.bankObservation()).toBeNull();
});

test('unknown attempted pocket and player-chat effect never repeat or invoke bank recovery', async () => {
    for (const mode of ['unknown', 'chat']) {
        const f = tripFixture(mode);
        const r = await runPickpocketTrips(f.s, tripJob, f.stop, { bank: f.bankRunner });
        expect(r.ok).toBe(false);
        expect(r.recoveryDeferred).toBe(true);
        expect(f.calls()).toBe(1);
        expect(f.returns()).toBe(0);
        expect(r.verifiedSuccesses).toBe(0);
    }
});

test('stop immediately after a fresh paid success reconciles once then returns owned stock without another attempt', async () => {
    const f = tripFixture('stop');
    const r = await runPickpocketTrips(f.s, tripJob, f.stop, { bank: f.bankRunner });
    expect(r).toMatchObject({ ok: false, verifiedSuccesses: 1, balanced: true, recoveryDeferred: false, exactXp: true });
    expect(f.calls()).toBe(1);
    expect(f.returns()).toBe(1);
    expect(f.inv).toHaveLength(0);
});

test('missing total owned food or initial stop sends zero withdrawals and pockets', async () => {
    for (const mode of ['stock', 'stop']) {
        const f = tripFixture();
        if (mode === 'stock') f.bank[0].count = 1;
        const r = await runPickpocketTrips(f.s, tripJob, () => mode === 'stop', { bank: f.bankRunner });
        expect(r.ok).toBe(false);
        expect(f.calls()).toBe(0);
        expect(f.withdrawals()).toBe(0);
    }
});

test('original life and insufficient source-derived food budget reject without a repeated action', async () => {
    const f = tripFixture('life');
    const r = await runPickpocketTrips(f.s, tripJob, f.stop, { bank: f.bankRunner });
    expect(r.ok).toBe(false);
    expect(f.calls()).toBe(1);
    expect(f.returns()).toBe(0);
    const g = tripFixture();
    await expect(runPickpocketTrips(g.s, { ...tripJob, foodPerSuccess: 1 }, g.stop, { bank: f.bankRunner })).rejects.toThrow('native failure damage');
    expect(g.withdrawals()).toBe(0);
});

test('trip global/account/role stop detection uses injected files only', () => {
    expect(pocketTripStop('Owned', () => false, p => p === '.practice/stop-all')).toBe(true);
    expect(pocketTripStop('Owned', () => false, p => p === '.practice/stop-Owned')).toBe(true);
    expect(pocketTripStop('Owned', () => false, p => p === '.practice/stop-microbot-pickpocket-trip')).toBe(true);
});

test('modal close owner or original client handoff blocks subsequent bank input', async () => {
    for (const changed of ['owner', 'client']) {
        const f = tripFixture();
        f.s.sdk.sendCloseModal = async () => {
            await Promise.resolve();
            if (changed === 'owner') f.s.client.executeBotAction = () => ({ success: true });
            else f.s.client = { ...f.s.client };
            return { success: true };
        };
        await expect(runPickpocketTrips(f.s, tripJob, f.stop, { bank: f.bankRunner })).rejects.toThrow('owner lost');
        expect(f.opens()).toBe(0);
        expect(f.withdrawals()).toBe(0);
        expect(f.calls()).toBe(0);
    }
});

test('actual openBank door retry helper cannot walk or open a door after awaited owner handoff', async () => {
    for (const route of ['walk', 'door']) {
        const f = tripFixture();
        const client = f.s.client;
        const owner = client.executeBotAction;
        let walks = 0;
        let doors = 0;
        f.s.sdk.sendWalk = async () => {
            walks++;
            return { success: true };
        };
        f.s.sdk.sendInteractLoc = async () => {
            doors++;
            return { success: true };
        };
        if (route === 'door') f.s.sdk.getNearbyLocs = () => [{ id: 1, name: 'Door', x: 3186, z: 3436, distance: 1, optionsWithIndex: [{ text: 'Open', opIndex: 1 }] }];
        const view = pocketOwnedActions(f.s, () => f.s.client === client && client.executeBotAction === owner);
        (view.bot as any)._openBankOnce = async () => {
            await Promise.resolve();
            client.executeBotAction = () => ({ success: true });
            return { success: false, reason: 'cant_reach' };
        };
        await expect(view.bot.openBank()).rejects.toThrow('input owner absent');
        expect(walks).toBe(0);
        expect(doors).toBe(0);
    }
});

test('real BotActions food dismissal continuation refuses paid dispatch and Session.direct after ownership handoff', async () => {
    for (const changed of ['owner', 'client']) {
        const f = tripFixture();
        const client = f.s.client;
        const owner = client.executeBotAction;
        let paid = 0;
        let direct = 0;
        f.inv.push({ id: 379, count: 1, name: 'Lobster', slot: 0, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] });
        f.s.sdk.sendUseItem = async () => {
            paid++;
            return { success: true };
        };
        f.s.direct = () => {
            direct++;
        };
        f.s.bot = new BotActions(f.s.sdk);
        f.s.bot.dismissBlockingUI = async () => {
            await Promise.resolve();
            if (changed === 'owner') client.executeBotAction = () => ({ success: true });
            else f.s.client = { ...client };
        };
        const view = pocketOwnedActions(f.s, () => f.s.client === client && client.executeBotAction === owner);
        view.bot.dismissBlockingUI = f.s.bot.dismissBlockingUI;
        await expect(view.bot.eatFood(f.inv[0])).rejects.toThrow('input owner absent');
        expect(() => view.direct({} as any)).toThrow('input owner absent');
        expect(paid).toBe(0);
        expect(direct).toBe(0);
        expect(f.inv[0].count).toBe(1);
    }
});

test('real lower worker known failed pocket waits native combat grace then heals before next paid attempt', async () => {
    const f = tripFixture('grace');
    const r = await runPickpocketTrips(f.s, tripJob, f.stop, { bank: f.bankRunner });
    expect(r).toMatchObject({ ok: true, trips: 2, verifiedSuccesses: 4, verifiedFailures: 2, eaten: 2, balanced: true, recoveryDeferred: false });
    expect(f.calls()).toBe(6);
    expect(f.foods()).toBe(2);
    expect(f.s.sdk.getSkill('Hitpoints').level).toBe(99);
});

test('known-failure quiet settlement rejects new target, peer or stock change after exactly one early food', async () => {
    for (const change of ['target', 'peer', 'stock']) {
        const f = tripFixture('grace');
        const get = f.s.sdk.getState;
        f.s.sdk.getState = () => {
            const st = get();
            if (f.tick() >= 12 && st.player.combat.inCombat) {
                if (change === 'target') st.player.combat.targetType = 'npc';
                if (change === 'peer') st.nearbyPlayers = [{ name: 'Visitor' }];
                if (change === 'stock' && !f.inv.some(i => i.id === 554)) f.inv.push({ id: 554, count: 1, slot: 27 });
            }
            return st;
        };
        const r = await runPickpocketTrips(f.s, tripJob, f.stop, { bank: f.bankRunner });
        expect(r.ok).toBe(false);
        expect(f.calls()).toBe(1);
        expect(f.foods()).toBe(1);
    }
});

test('known damage grace uses native 400 client cycles, not vanilla 16 game observations', async () => {
    const f = tripFixture('grace');
    let cycle = 0;
    const on = f.s.onTick;
    f.s.client.getClientCycle = () => cycle;
    f.s.onTick = (cb: () => void) =>
        on(() => {
            cycle += 2;
            if (f.s.client.localPlayer.combatCycle > cycle) f.player.combat.inCombat = true;
            cb();
        });
    const r = await runPickpocketTrips(f.s, tripJob, f.stop, { bank: f.bankRunner });
    expect(r).toMatchObject({ ok: true, verifiedFailures: 2, eaten: 2, trips: 2, recoveryDeferred: false });
    expect(f.tick()).toBeGreaterThan(200);
    expect(f.foods()).toBe(2);
});

test('exact early owned food precedes passive regeneration during accelerated native combat grace', async () => {
    const f = tripFixture('grace');
    const on = f.s.onTick;
    let cycle = 0;
    f.s.client.getClientCycle = () => cycle;
    f.s.onTick = (cb: () => void) =>
        on(() => {
            cycle += 2;
            if (f.s.client.localPlayer.combatCycle > cycle) f.player.combat.inCombat = true;
            if (f.tick() === 30) {
                f.regenerate();
                expect(f.foods()).toBe(1);
                expect(f.s.sdk.getSkill('Hitpoints').level).toBe(99);
            }
            cb();
        });
    const r = await runPickpocketTrips(f.s, tripJob, f.stop, { bank: f.bankRunner });
    expect(r).toMatchObject({ ok: true, verifiedFailures: 2, eaten: 2, trips: 2, balanced: true, recoveryDeferred: false });
    expect(f.foods()).toBe(2);
    expect(f.bank.find(i => i.id === 379).count).toBe(27);
});

test('new incoming hit during early food cannot be rebased even when food restores exact HP 99', async () => {
    for (const during of ['dispatch', 'settlement']) {
        const f = tripFixture('grace');
        const use = f.s.sdk.sendUseItem;
        const on = f.s.onTick;
        let changed = false;
        const incoming = () => {
            changed = true;
            f.player.combat.lastDamageTick = f.tick();
            f.s.client.localPlayer.combatCycle += 25;
        };
        if (during === 'dispatch') {
            f.s.sdk.sendUseItem = async (...a: any[]) => {
                const r = await use(...a);
                incoming();
                return r;
            };
        } else {
            f.s.onTick = (cb: () => void) =>
                on(() => {
                    if (!changed && f.foods() === 1) incoming();
                    cb();
                });
        }
        const r = await runPickpocketTrips(f.s, tripJob, f.stop, { bank: f.bankRunner });
        expect(r.ok).toBe(false);
        expect(r.recoveryDeferred).toBe(true);
        expect(f.calls()).toBe(1);
        expect(f.foods()).toBe(1);
        expect(f.returns()).toBe(0);
        expect(f.s.sdk.getSkill('Hitpoints').level).toBe(99);
    }
});

test('a stable knights farm started outside the market walks the world route to the market bank; a stop on it is a stop', async () => {
    // Live: "no goldfarm progress: start in Ardougne market, not ..." at ticks=0.
    const { goldfarmEntryTravel } = await import('../src/gather/thieving');
    const at = (worldX: number, worldZ: number, thieving = 60) => ({
        onTick: () => () => {},
        sdk: { getState: () => ({ player: atTile(worldX, worldZ) }), getSkill: () => ({ level: thieving, baseLevel: thieving }) },
    }) as any;
    const asked: unknown[] = [];
    const cfg = { deps: { walkTargetPersist: async (_s: unknown, to: unknown) => { asked.push(to); return { ok: false, reason: 'precondition', detail: 'test route end' }; } } } as any;
    const far = await goldfarmEntryTravel(at(3185, 3436), cfg, () => false);
    expect(asked).toEqual([{ x: BANK_SPOT.x, z: BANK_SPOT.z, level: 0 }]);
    expect(far).toEqual({ ok: false, stopped: false, detail: 'precondition test route end' });
    expect(await goldfarmEntryTravel(at(BANK_SPOT.x, BANK_SPOT.z), cfg, () => false)).toMatchObject({ ok: true });
    expect(await goldfarmEntryTravel(at(3185, 3436, 40), cfg, () => false)).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
    expect(await goldfarmEntryTravel(at(3185, 3436), cfg, () => true)).toMatchObject({ ok: false, stopped: true });
});
