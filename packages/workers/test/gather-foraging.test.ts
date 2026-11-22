// Consolidated unit tests for foraging gathering: crystal chest, feathers, flax, and ground spawns.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { bankCargo } from '../../core/src/cargo';
import type { Session } from '../../core/src/inprocess';
import { wildernessLevel } from '../../core/src/prayer-guard';
import { intentForEntry } from '../../planner/src/progression-catalog';
import { BotActions } from '../../../vendor/rs-sdk/sdk/actions';
import { FALADOR_WEST_BANK } from '../src/logistics';
import {
    CHEST_CLOSED,
    CHEST_OPEN,
    CRYSTAL_KEY,
    KEY_LOOP,
    KEY_TOOTH,
    MIN_FREE_SLOTS,
    TAVERLEY_CHEST_STAND,
    TAVERLEY_CHEST_TILE,
    UNCUT_DRAGONSTONE,
    enterPen,
    featherRunOk,
    finishPenEntry,
    nonWildernessBanks,
    parsePen,
    penTiles,
    planCrystalChest,
    runCrystalChest,
    runFlax,
    safeSpawnWalk,
    tripSize,
} from '../src/gather';

// --- Crystal chest (formerly crystal-chest.test.ts) ---
test('planCrystalChest sizes key combination and bounded opens cleanly', () => {
    expect(planCrystalChest(0, 0, 0, 2, 3, 2, 0)).toEqual({ combinePairs: 2, keysToOpen: 4 });
    expect(planCrystalChest(0, 0, 0, 3, 2, 2, 2)).toEqual({ combinePairs: 0, keysToOpen: 2 });
    expect(planCrystalChest(0, 0, 0, 1, 2, 2, 3)).toEqual({ combinePairs: 2, keysToOpen: 3 });
    expect(planCrystalChest(0, 0, 0, 0, 5, 0, 0)).toEqual({ combinePairs: 0, keysToOpen: 0 });
    expect(planCrystalChest(0, 0, 0, -1, 1, 1, 0)).toEqual({ combinePairs: 0, keysToOpen: 0 });
});

test('crystal chest constants match pinned m45_53 map placement and loot slot bound', () => {
    const pack = readFileSync(new URL('../../../vendor/rs-sdk/server/content/pack/loc.pack', import.meta.url), 'utf8');
    const objPack = readFileSync(new URL('../../../vendor/rs-sdk/server/content/pack/obj.pack', import.meta.url), 'utf8');
    const jm2 = readFileSync(new URL('../../../vendor/rs-sdk/server/content/maps/m45_53.jm2', import.meta.url), 'utf8');
    expect(pack).toContain(`${CHEST_CLOSED}=crystal_chestclosed`);
    expect(pack).toContain(`${CHEST_OPEN}=crystal_chestopen`);
    expect(objPack).toContain(`${KEY_TOOTH}=keyhalf1`);
    expect(objPack).toContain(`${KEY_LOOP}=keyhalf2`);
    expect(objPack).toContain(`${CRYSTAL_KEY}=crystal_key`);
    expect(objPack).toContain(`${UNCUT_DRAGONSTONE}=uncut_dragonstone`);
    expect(jm2).toContain(`0 ${TAVERLEY_CHEST_TILE.x - 45 * 64} ${TAVERLEY_CHEST_TILE.z - 53 * 64}: ${CHEST_CLOSED} `);
    expect(TAVERLEY_CHEST_STAND).toEqual({ x: 2914, z: 3451, level: 0 });
    expect(MIN_FREE_SLOTS).toBe(12);
});

test('runCrystalChest combines key halves, opens chest, and deposits uncut dragonstones', async () => {
    let tick = 10;
    let gen = 1;
    let open = false;
    let px = FALADOR_WEST_BANK.x;
    let pz = FALADOR_WEST_BANK.z;
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
        tick++;
        for (const fn of [...listeners]) fn();
    }, 1);
    const inv: { id: number; name: string; count: number; slot: number }[] = [];
    const bank: { id: number; name: string; count: number; slot: number }[] = [
        { id: KEY_TOOTH, name: 'Half of a key', count: 1, slot: 0 },
        { id: KEY_LOOP, name: 'Half of a key', count: 1, slot: 1 },
    ];
    const reindex = () =>
        inv.forEach((r, idx) => {
            r.slot = idx;
        });
    const pushInv = (id: number, name: string, count: number) => {
        inv.push({ id, name, count, slot: inv.length });
    };
    const fake = {
        name: 'ChestTester',
        tick: () => tick,
        onTick: (cb: () => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        ended: new Promise(() => {}),
        bankObservation: () => (open ? { generation: gen, at: tick, items: bank.map(i => ({ ...i })) } : null),
        sdk: {
            getInventory: () => inv,
            getState: () => ({
                player: { worldX: px, worldZ: pz, level: 0, lifeId: 1, respawnCount: 0, isDead: false },
                inventory: inv,
                bank: { isOpen: open, items: bank },
                nearbyLocs: px === TAVERLEY_CHEST_STAND.x ? [{ id: CHEST_CLOSED, name: 'Crystal chest', x: 2914, z: 3452, distance: 1 }] : [],
            }),
            sendUseItemOnItem: async (a: number, b: number) => {
                const i1 = inv[a];
                const i2 = inv[b];
                if (!i1 || !i2) return { success: false };
                inv.splice(Math.max(a, b), 1);
                inv.splice(Math.min(a, b), 1);
                pushInv(CRYSTAL_KEY, 'Crystal key', 1);
                reindex();
                return { success: true };
            },
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
            walkTo: async (x: number, z: number) => {
                px = x;
                pz = z;
                return { success: true };
            },
            withdrawItem: async (item: { id: number; name: string }, n: number) => {
                const row = bank.find(r => r.id === item.id)!;
                row.count -= n;
                if (row.count <= 0) bank.splice(bank.indexOf(row), 1);
                for (let k = 0; k < n; k++) pushInv(item.id, item.name, 1);
                gen++;
                return { success: true };
            },
            depositItem: async (item: { id: number; name: string }) => {
                const matching = inv.filter(r => r.id === item.id);
                const total = matching.reduce((n, r) => n + r.count, 0);
                for (const m of matching) inv.splice(inv.indexOf(m), 1);
                reindex();
                const row = bank.find(r => r.id === item.id);
                if (row) row.count += total;
                else bank.push({ id: item.id, name: item.name, count: total, slot: bank.length });
                gen++;
                return { success: true };
            },
            useItemOnLoc: async () => {
                const key = inv.find(r => r.id === CRYSTAL_KEY)!;
                inv.splice(inv.indexOf(key), 1);
                pushInv(UNCUT_DRAGONSTONE, 'Uncut dragonstone', 1);
                pushInv(995, 'Coins', 2000);
                reindex();
                return { success: true };
            },
        },
    } as unknown as Session;
    try {
        const res = await runCrystalChest(fake, {
            cap: 200,
            walk: async to => {
                px = to.x;
                pz = to.z;
                return { ok: true };
            },
        });
        expect(res.ok).toBe(true);
        expect(res.combined).toBe(1);
        expect(res.opened).toBe(1);
        expect(res.dragonstones).toBe(1);
        expect(res.bankDragonstones).toBe(1);
    } finally {
        clearInterval(timer);
    }
});

test('progression catalog admits bounded crystal-chest routes and rejects unbounded calls', () => {
    expect(intentForEntry('scripts/aio-skiller.ts', ['gather', 'foraging', 'crystal-chest', '2000'], { MAX_KEYS: '4' })).toEqual({
        kind: 'service',
        objective: 'crystal-chest:skiller:foraging:crystal-chest',
        units: 1,
    });
    expect(intentForEntry('scripts/aio.ts', ['skiller', 'foraging', 'crystal-chest', '1500', 'MAX_KEYS=1'])).toEqual({
        kind: 'service',
        objective: 'crystal-chest:skiller:foraging:crystal-chest',
        units: 1,
    });
    expect(intentForEntry('scripts/aio-skiller.ts', ['gather', 'foraging', 'crystal-chest'])).toBeNull();
    expect(intentForEntry('scripts/aio-skiller.ts', ['gather', 'foraging', 'crystal-chest', '0'])).toBeNull();
});

// --- Chicken pen feathers (formerly gather-feathers.test.ts) ---
test('a run is good when it gained feathers or the pack holds the target', () => {
    expect(featherRunOk(220, 2005, 2000)).toBe(true);
    expect(featherRunOk(0, 2005, 2000)).toBe(true);
    expect(featherRunOk(0, 2000, 2000)).toBe(true);
    expect(featherRunOk(0, 1845, 2000)).toBe(false);
});

test('the chicken pen comes from PEN, Lumbridge by default', () => {
    expect(parsePen('3017,3288')).toEqual({ x: 3017, z: 3288 });
    expect(parsePen(undefined)).toEqual({ x: 3229, z: 3298 });
    expect(parsePen('bad')).toEqual({ x: 3229, z: 3298 });
});

test('pen tiles are the ground-floor chicken spawns within 15 tiles, nearest first', () => {
    expect(penTiles({ x: 2851, z: 3370 }, [{ x: 2855, z: 3372, level: 0 }, { x: 2852, z: 3369, level: 0 }, { x: 2852, z: 3369, level: 1 }, { x: 2900, z: 3370, level: 0 }]))
        .toEqual([{ x: 2852, z: 3369 }, { x: 2855, z: 3372 }]);
});

test('a successful route or walk reply outside a fence cannot admit the chicken worker', async () => {
    let player = { worldX: 3196, worldZ: 3351, level: 0 };
    const clicks: number[][] = [];
    const s = {
        sdk: { getState: () => ({ player }) },
        bot: {
            walkTo: async (x: number, z: number, tolerance?: number) => {
                clicks.push([x, z, tolerance!]);
                return { success: true };
            },
        },
    };
    expect(await finishPenEntry(s, { x: 3197, z: 3353 })).toBe(false);
    expect(clicks).toEqual([[3197, 3353, 0]]);
    s.bot.walkTo = async () => {
        player = { worldX: 3197, worldZ: 3353, level: 0 };
        return { success: true };
    };
    expect(await finishPenEntry(s, { x: 3197, z: 3353 })).toBe(true);
});

test('the pen walk ends at the first exact arrival, and a failed walk that ends no closer ends the travel with its cause', async () => {
    const pen = { x: 3017, z: 3288 };
    const tiles = [{ x: 3015, z: 3290 }, { x: 3018, z: 3287 }, pen];
    let player = { worldX: 2575, worldZ: 3269, level: 1 };
    const walks: string[] = [];
    const s = { sdk: { getState: () => ({ player }) }, bot: { walkTo: async () => ({ success: true }) } };
    expect(
        await enterPen(s, pen, tiles, async (to: { x: number; z: number; level: number }) => {
            walks.push(`${to.x},${to.z},${to.level}`);
            return { ok: false, reason: 'precondition', detail: 'no route to 3015,3290,0' };
        }),
    ).toBe('precondition no route to 3015,3290,0');
    expect(walks).toEqual(['3015,3290,0']);
    walks.length = 0;
    expect(
        await enterPen(s, pen, tiles, async (to: { x: number; z: number; level: number }) => {
            walks.push(`${to.x},${to.z},${to.level}`);
            if (walks.length === 1) {
                player = { worldX: 2772, worldZ: 3225, level: 0 };
                return { ok: false, reason: 'timeout', detail: 'walk stopped' };
            }
            player = { worldX: to.x, worldZ: to.z, level: 0 };
            return { ok: true };
        }),
    ).toBeNull();
    expect(walks).toEqual(['3015,3290,0', '3018,3287,0']);
    player = { worldX: 3016, worldZ: 3291, level: 0 };
    expect(await enterPen(s, pen, tiles, async () => ({ ok: true }))).toBe('exact pen entry unobserved');
});

// --- Seers flax picking (formerly gather-flax.test.ts) ---
function flaxFixture(
    o: {
        visible?: boolean;
        walkFails?: boolean;
        firstWalkFails?: boolean;
        capOnFirstReturn?: boolean;
        depositFails?: boolean;
        stale?: boolean;
        stopOnReturn?: boolean;
        dieOnReturn?: boolean;
        endOnReturn?: boolean;
        exhaust?: boolean;
        cargoLeftover?: boolean;
        cargoTransfer?: boolean;
        stopOnCargoSend?: 'note-toggle' | 'withdraw';
    } = {},
) {
    let tick = 0;
    let x = o.visible ? 2735 : 2744;
    let z = o.visible ? 3483 : 3445;
    let open = false;
    let generation = 0;
    let banked = 10;
    let stopped = false;
    let dead = false;
    let noteMode = false;
    let openCalls = 0;
    let autoWalks = 0;
    let cargoCalls = 0;
    let withdrawals = 0;
    let trades = 0;
    let closeCalls = 0;
    const walks: { remaining: number; stopped: boolean }[] = [];
    const inv: any[] = [{ id: 995, name: 'Coins', count: 80, slot: 0 }, { id: 333, name: 'Trout', count: 2, slot: 1 }];
    const listeners = new Set<() => void>();
    let end!: () => void;
    const ended = new Promise<any>(r => {
        end = () => r({ reason: 'test ended' });
    });
    const state = () => ({
        inventory: inv,
        player: { worldX: x, worldZ: z, level: 0, lifeId: 1, respawnCount: 0, isDead: dead },
        interface: { isOpen: open },
        trade: { isOpen: false },
        bank: { isOpen: open, noteMode, items: [{ id: 1779, name: 'Flax', count: banked, slot: 0 }] },
        nearbyPlayers: [{ name: 'Courier', distance: 2, index: 1 }],
    });
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
        ended,
        bankObservation: () => (open && !o.stale ? { generation, at: Date.now(), items: state().bank.items } : null),
        client: { selfSlot: 1, executeBotAction: () => ({ success: true }) },
        sdk: {
            config: { host: 'fixture', port: 1 },
            getState: state,
            getStateAge: () => 0,
            getTradeState: () => state().trade,
            getSkill: () => ({ level: 10 }),
            getInventory: () => inv,
            findNearbyLoc: () => ({ id: 2646, name: 'Flax' }),
            findBankItem: (target: RegExp) => state().bank.items.find(i => target.test(i.name)),
            waitForCondition: async (predicate: (st: ReturnType<typeof state>) => boolean) => {
                if (!predicate(state())) throw Error('fixture condition not observed');
                return state();
            },
            send: async (message: { type: string; action: { type: string; amount?: number; slot?: number; componentId?: number } }) => {
                const action = message.action;
                const phase = action.type === 'clickComponent' ? 'note-toggle' : 'withdraw';
                if (phase === 'note-toggle') noteMode = true;
                if (phase === 'withdraw') {
                    const amount = action.amount! < 0 ? banked : action.amount!;
                    withdrawals++;
                    banked -= amount;
                    inv.push({ id: 1780, name: 'Flax', count: amount, slot: 2 });
                    generation++;
                }
                await Promise.resolve();
                if (phase === o.stopOnCargoSend) stopped = true;
                return { success: true };
            },
            sendClickComponent: function (componentId: number) {
                return this.send({ type: 'sdk_action', action: { type: 'clickComponent', componentId } });
            },
            sendBankWithdraw: function (slot: number, amount: number) {
                return this.send({ type: 'sdk_action', action: { type: 'bankWithdraw', slot, amount } });
            },
        },
        bot: {
            dismissBlockingUI: async () => {},
            interactLoc: async () => {
                await new Promise<void>(r => {
                    const once = () => {
                        listeners.delete(once);
                        r();
                    };
                    listeners.add(once);
                });
                inv.push({ id: 1779, name: 'Flax', count: 1, slot: 2 });
                return { success: true };
            },
            openBank: async () => {
                openCalls++;
                const distance = Math.max(Math.abs(x - 2727), Math.abs(z - 3492));
                if (distance > 15) return { success: false, message: 'No banker NPC or bank booth found nearby' };
                if (distance > 2) {
                    autoWalks++;
                    x = 2727;
                    z = 3492;
                }
                open = true;
                generation++;
                return { success: true };
            },
            depositItem: async (target: RegExp, amount = -1) => {
                if (o.depositFails) return { success: true };
                const i = inv.findIndex(i => target.test(i.name));
                if (i >= 0) {
                    const n = amount < 0 ? inv[i].count : Math.min(amount, inv[i].count);
                    banked += n;
                    inv[i].count -= n;
                    if (!inv[i].count) inv.splice(i, 1);
                }
                generation++;
                return { success: true };
            },
            closeBank: async () => {
                open = false;
                return { success: true };
            },
            serveTrades: async () => {
                trades++;
                throw Error('cargo trade reached after caller stop');
            },
            closeInterface: async () => {
                closeCalls++;
                open = false;
                return { success: true };
            },
        },
    };
    if (o.stopOnCargoSend) {
        const actions = new BotActions(s.sdk);
        s.bot.withdrawItem = actions.withdrawItem.bind(actions);
    }
    const walk = async (a: number, b: number, _tol: number, stop: () => boolean, remaining: number) => {
        if (a === 2744 && b === 3445) {
            x = 2744;
            z = 3445;
            return true;
        }
        walks.push({ remaining, stopped: stop() });
        if (o.capOnFirstReturn && walks.length === 1) {
            tick = 2;
            return false;
        }
        if (o.stopOnReturn) stopped = true;
        if (o.dieOnReturn) {
            dead = true;
            for (const f of [...listeners]) f();
        }
        if (o.endOnReturn) {
            end();
            await Promise.resolve();
        }
        if (o.exhaust) {
            tick += remaining;
            return false;
        }
        if (stop() || o.walkFails || (o.firstWalkFails && walks.length === 1)) return false;
        x = a;
        z = b;
        return true;
    };
    x = 2744;
    z = 3445;
    return {
        s: s as Session,
        inv,
        walk,
        stop: () => stopped,
        walks,
        cargo: async () => {
            cargoCalls++;
            if (o.cargoLeftover) inv.push({ id: 1780, name: 'Flax', count: 1, slot: 2 });
            if (o.cargoTransfer) {
                banked = 0;
                generation++;
            }
        },
        directSdkBankAtVisible: async () => {
            x = 2735;
            z = 3483;
            return s.bot.openBank();
        },
        stats: () => ({ banked, openCalls, autoWalks, cargoCalls, withdrawals, trades, closeCalls }),
        dispose: () => clearInterval(timer),
    };
}

test('CAP at field with no bank visible still returns within separate budget and proves deposit/held 0', async () => {
    const f = flaxFixture();
    try {
        const r = await runFlax(f.s, { cap: 1, bankAt: 28, walk: f.walk, cargo: f.cargo, waiting: () => false });
        expect(r).toMatchObject({ ok: true, picks: 1, banked: 1, held: 0, finalBankConfirmed: true });
        expect(r.ticks).toBeGreaterThanOrEqual(1);
        expect(f.walks).toEqual([{ remaining: 240, stopped: false }]);
        expect(f.stats()).toMatchObject({ banked: 11, openCalls: 1, autoWalks: 0, cargoCalls: 1 });
        expect(f.inv.map(i => [i.id, i.count])).toEqual([[995, 80], [333, 2]]);
    } finally {
        f.dispose();
    }
});

test('visible-bank SDK auto-walk remains available; bounded final return also proves nearby-bank case', async () => {
    const f = flaxFixture();
    try {
        expect((await f.directSdkBankAtVisible()).success).toBe(true);
        expect(f.stats().autoWalks).toBe(1);
        const r = await runFlax(f.s, { cap: 1, bankAt: 28, walk: f.walk, cargo: f.cargo, waiting: () => false });
        expect(r.ok).toBe(true);
        expect(r.held).toBe(0);
    } finally {
        f.dispose();
    }
});

test('failed return never opens distant SDK bank or reports held flax as successful', async () => {
    const f = flaxFixture({ walkFails: true });
    try {
        const r = await runFlax(f.s, { cap: 1, bankAt: 28, walk: f.walk, cargo: f.cargo, waiting: () => false });
        expect(r.ok).toBe(false);
        expect(r.held).toBe(1);
        expect(r.finalBankConfirmed).toBe(false);
        expect(f.stats().openCalls).toBe(0);
    } finally {
        f.dispose();
    }
});

test('first unconfirmed production bank stops gathering and allows only one final salvage attempt', async () => {
    const f = flaxFixture({ walkFails: true });
    try {
        const r = await runFlax(f.s, { cap: 15000, bankAt: 1, walk: f.walk, cargo: f.cargo, waiting: () => false });
        expect(r.ok).toBe(false);
        expect(r.failure).toBe('no flax progress: production bank unconfirmed');
        expect(r.picks).toBe(1);
        expect(r.held).toBe(1);
        expect(f.walks.length).toBe(2);
        expect(r.ticks).toBeLessThan(10);
    } finally {
        f.dispose();
    }
});

test('successful final salvage cannot turn an earlier production bank failure into success', async () => {
    const f = flaxFixture({ firstWalkFails: true });
    try {
        const r = await runFlax(f.s, { cap: 15000, bankAt: 1, walk: f.walk, cargo: f.cargo, waiting: () => false });
        expect(r.ok).toBe(false);
        expect(r.finalBankConfirmed).toBe(true);
        expect(r.held).toBe(0);
        expect(r.banked).toBe(1);
        expect(r.failure).toBe('no flax progress: production bank unconfirmed');
        expect(f.walks.length).toBe(2);
    } finally {
        f.dispose();
    }
});

test('production CAP reached during a bank return proceeds to final cleanup without inventing a bank error', async () => {
    const f = flaxFixture({ capOnFirstReturn: true });
    try {
        const r = await runFlax(f.s, { cap: 2, bankAt: 1, walk: f.walk, cargo: f.cargo, waiting: () => false });
        expect(r.ok).toBe(true);
        expect(r.failure).toBe('');
        expect(r.held).toBe(0);
        expect(r.finalBankConfirmed).toBe(true);
        expect(f.walks.length).toBe(2);
    } finally {
        f.dispose();
    }
});

test('confirmed owned courier transfer may lower final bank stock without invalidating deposited output', async () => {
    const f = flaxFixture({ cargoTransfer: true });
    try {
        const r = await runFlax(f.s, { cap: 1, bankAt: 28, walk: f.walk, cargo: f.cargo, waiting: () => false });
        expect(r.ok).toBe(true);
        expect(r.banked).toBe(1);
        expect(r.held).toBe(0);
        expect(r.finalBankConfirmed).toBe(true);
        expect(f.stats().banked).toBe(0);
    } finally {
        f.dispose();
    }
});

test('dispatch success without real deposit, unknown bank data or leftover courier notes cannot claim completion', async () => {
    for (const option of [{ depositFails: true }, { stale: true }, { cargoLeftover: true }]) {
        const f = flaxFixture(option);
        try {
            const r = await runFlax(f.s, { cap: 1, bankAt: 28, walk: f.walk, cargo: f.cargo, waiting: () => false });
            expect(r.ok).toBe(false);
            expect(r.finalBankConfirmed).toBe(false);
        } finally {
            f.dispose();
        }
    }
});

test('cleanup honors user stop, death, ended session and own deadline without opening bank', async () => {
    for (const option of [{ stopOnReturn: true }, { dieOnReturn: true }, { endOnReturn: true }, { exhaust: true }]) {
        const f = flaxFixture(option);
        try {
            const r = await runFlax(f.s, { cap: 1, bankAt: 28, walk: f.walk, cargo: f.cargo, waiting: () => false, stop: f.stop });
            expect(r.ok).toBe(false);
            expect(r.held).toBe(1);
            expect(f.stats().openCalls).toBe(0);
            expect(r.ticks).toBeLessThanOrEqual(241);
        } finally {
            f.dispose();
        }
    }
});

test('flax passes its live stop into real cargo across SDK note and withdrawal awaits', async () => {
    for (const phase of ['note-toggle', 'withdraw'] as const) {
        const f = flaxFixture({ stopOnCargoSend: phase });
        const dir = mkdtempSync(join(tmpdir(), 'flax-cargo-stop-'));
        try {
            writeFileSync(join(dir, 'request-fixture.json'), JSON.stringify({ worker: 'fixture', courier: 'Courier', at: Date.now(), ready: true }));
            const r = await runFlax(f.s, {
                cap: 15000,
                bankAt: 1,
                walk: f.walk,
                waiting: () => false,
                stop: f.stop,
                cargo: (session, stopped) => bankCargo(session, [/^flax$/i], 0, { dir, owned: new Set(['courier']), stopped }),
            });
            expect(r).toMatchObject({ ok: false, picks: 1, stopped: true, finalBankConfirmed: false, held: 0 });
            expect(f.stats()).toMatchObject({ banked: 11, withdrawals: phase === 'withdraw' ? 1 : 0, trades: 0, closeCalls: 0 });
            expect(f.inv.map(i => [i.id, i.count])).toEqual([[995, 80], [333, 2]]);
            expect(JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')).items).toEqual([]);
        } finally {
            f.dispose();
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('a start on another floor goes to the field with the shared walker first, and a failed approach ends with its cause', async () => {
    const upstairs = (f: ReturnType<typeof flaxFixture>, until: () => boolean) => {
        const real = f.s.sdk.getState.bind(f.s.sdk);
        (f.s.sdk as any).getState = () => {
            const st = real()!;
            return until() ? st : { ...st, player: { ...st.player, worldX: 2575, worldZ: 3269, level: 1 } };
        };
    };
    const f = flaxFixture();
    try {
        let arrived = false;
        let calls = 0;
        upstairs(f, () => arrived);
        const r = await runFlax(f.s, {
            cap: 1,
            bankAt: 28,
            walk: f.walk,
            cargo: f.cargo,
            waiting: () => false,
            approach: async () => {
                calls++;
                arrived = true;
                return true;
            },
        });
        expect(calls).toBe(1);
        expect(r.ok).toBe(true);
        expect(r.picks).toBe(1);
        expect(r.held).toBe(0);
    } finally {
        f.dispose();
    }
    const g = flaxFixture();
    try {
        upstairs(g, () => false);
        const r = await runFlax(g.s, { cap: 50, bankAt: 28, walk: f.walk, cargo: f.cargo, waiting: () => false, approach: async () => false });
        expect(r.ok).toBe(false);
        expect(r.picks).toBe(0);
        expect(r.failure).toBe('no flax progress: no route to the flax field');
    } finally {
        g.dispose();
    }
});

// --- Ground spawn gathering via unified aio-skiller CLI (formerly gather-spawn.test.ts) ---
test('a stack trip takes all that is left; other items fill the free slots', () => {
    expect(tripSize(176, false, 20)).toBe(20);
    expect(tripSize(5, false, 20)).toBe(5);
    expect(tripSize(2000, true, 2)).toBe(2000);
    expect(tripSize(-3, true, 9)).toBe(0);
});

async function runSpawnCli(mode: 'complete' | 'partial' | 'error' | 'missing-credit' | 'world-error' | 'close-error') {
    const root = resolve(import.meta.dir, '../../..');
    const directory = resolve(root, '.practice/catalog-useful-gaps/unit-fixtures');
    mkdirSync(directory, { recursive: true });
    const preload = resolve(directory, `gather-${process.pid}-${mode}.ts`);
    writeFileSync(
        preload,
        `import {mock} from 'bun:test';
const mode=${JSON.stringify(mode)};let tick=0,pack=[],bank=0,generation=0,opened=false,calls=0;
const state=()=>({player:{worldX:3185,worldZ:3436,level:0},inventory:pack,bank:{isOpen:opened,items:[]}});
const session={name:'fixture',tick:()=>tick,onTick:()=>()=>{},ended:new Promise(()=>{}),client:{objType:()=>({stackable:false})},
 sdk:{getState:state,getInventory:()=>pack},bankObservation:()=>generation?{generation,items:bank?[{id:1573,name:'Doogle leaves',count:bank}]:[]}:null,
 bot:{openBank:async()=>{opened=true;generation++;return{success:true};},closeBank:async()=>{opened=false;if(mode==='close-error')throw Error('bank close after credit failed');if(mode==='partial')tick=1000;},
 depositItem:async()=>{const n=pack.reduce((total,item)=>total+item.count,0);pack=[];if(mode!=='missing-credit')bank+=n;generation++;return{success:true};}}};
const botMod=${JSON.stringify(resolve(root, 'packages/core/src/bot.ts'))},gatherMod=${JSON.stringify(resolve(root, 'packages/core/src/gather.ts'))},walkMod=${JSON.stringify(resolve(root, 'packages/core/src/walk.ts'))},ticksMod=${JSON.stringify(resolve(root, 'packages/core/src/ticks.ts'))},qsMod=${JSON.stringify(resolve(root, 'scripts/quest-sweep.ts'))};
const [realBot,realGather,realWalk,realTicks,realQs]=await Promise.all([import(botMod),import(gatherMod),import(walkMod),import(ticksMod),import(qsMod)]);
mock.module(botMod,()=>({...realBot,openBot:async()=>session,getWorld:async()=>{if(mode==='world-error')throw Error('world unavailable');return{};},accountOf:()=>({}),countItems:()=>0,
 finish:async(_sessions,ok,detail)=>{console.log('TEST_FINAL '+JSON.stringify({ok,detail,bank,calls}));process.exitCode=ok?0:1;}}));
mock.module(gatherMod,()=>({...realGather,gatherItems:async()=>{calls++;tick++;if(calls>1&&mode==='error')throw Error('collector fault after bank');pack=[{id:1573,name:'Doogle leaves',count:mode==='complete'||mode==='close-error'?2:1,slot:0}];return null;}}));
mock.module(walkMod,()=>({...realWalk,goTo:async()=>({ok:true})}));
mock.module(ticksMod,()=>({...realTicks,waitUntil:async(_s,test,options)=>{for(let i=0;i<(options?.timeoutTicks??20);i++){if(test(state()))return true;tick++;}return test(state());}}));
mock.module(qsMod,()=>({...realQs,nearestBanks:()=>[{x:3185,z:3436,level:0}]}));
`,
    );
    const child = Bun.spawn([process.execPath, '--preload', preload, resolve(root, 'scripts/aio-skiller.ts'), 'fixture', 'gather', 'foraging', 'spawn', '1573', '2'], {
        cwd: root,
        env: { ...process.env, TICKS: '100' },
        windowsHide: true,
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill(), 10000);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        const line = stdout.split(/\r?\n/).find(line => line.startsWith('TEST_FINAL '));
        if (!line) throw Error(`CLI result missing: code=${code} ${stdout} ${stderr}`);
        return { code, ...JSON.parse(line.slice('TEST_FINAL '.length)) };
    } finally {
        clearTimeout(timer);
    }
}

test('ground gather CLI succeeds only after the complete target has paired bank credits', async () => {
    const result = await runSpawnCli('complete');
    expect(result.code).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.bank).toBe(2);
    expect(result.detail).toContain('banked=2');
});

test('ground gather CLI retains partial banked progress but fails an unmet target', async () => {
    const result = await runSpawnCli('partial');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.bank).toBe(1);
    expect(result.detail).toContain('targetMet=false');
    expect(result.detail).toContain('remaining=1');
});

test('ground gather CLI preserves a collector error after an earlier useful bank trip', async () => {
    const result = await runSpawnCli('error');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.bank).toBe(1);
    expect(result.detail).toContain('collector fault after bank');
    expect(result.detail).toContain('remaining=1');
});

test('ground gather CLI cannot count a pack debit without its bank credit', async () => {
    const result = await runSpawnCli('missing-credit');
    expect(result.ok).toBe(false);
    expect(result.bank).toBe(0);
    expect(result.detail).toContain('pack debit/bank credit unobserved');
});

test('ground gather CLI settles its owned session when world loading fails', async () => {
    const result = await runSpawnCli('world-error');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.calls).toBe(0);
    expect(result.detail).toContain('world unavailable');
    expect(result.detail).toContain('remaining=2');
});

test('ground gather CLI retains a confirmed credit when bank closing fails', async () => {
    const result = await runSpawnCli('close-error');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.bank).toBe(2);
    expect(result.detail).toContain('banked=2');
    expect(result.detail).toContain('remaining=0');
    expect(result.detail).toContain('bank close after credit failed');
});

test('safeSpawnWalk and nonWildernessBanks block Wilderness coordinates by default', async () => {
    const visited: { x: number; z: number; level: number }[] = [];
    const fakeSession = {
        sdk: { getState: () => ({ player: { worldX: 2552, worldZ: 3574, level: 0 }, skills: [], inventory: [], equipment: [] }), getInventory: () => [] },
        bankObservation: () => null,
    } as unknown as Parameters<typeof safeSpawnWalk>[0];
    const fakeWorld = {} as Parameters<typeof safeSpawnWalk>[1];
    const fakeMove = async (_s: unknown, _w: unknown, to: { x: number; z: number; level: number }) => {
        visited.push(to);
        return { ok: true };
    };
    const guarded = safeSpawnWalk(fakeSession, fakeWorld, false, fakeMove);
    expect(await guarded({ x: 3214, z: 3809, level: 0 })).toEqual({ ok: false, reason: 'wilderness', detail: 'refused Wilderness spawn 3214,3809,0' });
    expect(await guarded({ x: 3148, z: 3671, level: 0 })).toEqual({ ok: false, reason: 'wilderness', detail: 'refused Wilderness spawn 3148,3671,0' });
    expect(await guarded({ x: 3090, z: 9930, level: 0 })).toEqual({ ok: false, reason: 'wilderness', detail: 'refused Wilderness spawn 3090,9930,0' });
    expect(visited).toEqual([]);
    expect(await guarded({ x: 2262, z: 3168, level: 0 })).toEqual({ ok: true });
    expect(await guarded({ x: 2552, z: 3574, level: 0 })).toEqual({ ok: true });
    expect(visited).toEqual([{ x: 2262, z: 3168, level: 0 }, { x: 2552, z: 3574, level: 0 }]);
    const allowed = safeSpawnWalk(fakeSession, fakeWorld, true, fakeMove);
    expect(await allowed({ x: 3214, z: 3809, level: 0 })).toEqual({ ok: true });
    expect(nonWildernessBanks([{ x: 2618, z: 3332 }, { x: 3092, z: 3957 }, { x: 2727, z: 3493 }], false)).toEqual([{ x: 2618, z: 3332 }, { x: 2727, z: 3493 }]);
});

async function runRealGatherCli(id: number, start: { x: number; z: number; level: number }) {
    const root = resolve(import.meta.dir, '../../..');
    const directory = resolve(root, '.practice/catalog-useful-gaps/unit-fixtures');
    mkdirSync(directory, { recursive: true });
    const preload = resolve(directory, `gather-nowild-${process.pid}-${id}-${start.x}.ts`);
    writeFileSync(
        preload,
        `import {mock} from 'bun:test';
const walked=[];
const state=()=>({player:{worldX:${start.x},worldZ:${start.z},level:${start.level}},inventory:[],groundItems:[],nearbyLocs:[]});
const session={name:'fixture',tick:()=>0,onTick:()=>()=>{},ended:new Promise(()=>{}),client:{objType:()=>({stackable:false})},
 sdk:{getState:state,getInventory:()=>[]},bankObservation:()=>null,
 bot:{openBank:async()=>({success:true}),closeBank:async()=>({success:true})}};
const botMod=${JSON.stringify(resolve(root, 'packages/core/src/bot.ts'))},walkMod=${JSON.stringify(resolve(root, 'packages/core/src/walk.ts'))},ticksMod=${JSON.stringify(resolve(root, 'packages/core/src/ticks.ts'))},qsMod=${JSON.stringify(resolve(root, 'scripts/quest-sweep.ts'))};
const [realBot,realWalk,realTicks,realQs]=await Promise.all([import(botMod),import(walkMod),import(ticksMod),import(qsMod)]);
mock.module(botMod,()=>({...realBot,openBot:async()=>session,getWorld:async()=>({}),accountOf:()=>({skills:{},varps:{},items:[]}),countItems:()=>0,
 finish:async(_sessions,ok,detail)=>{console.log('TEST_WILD_GUARD '+JSON.stringify({ok,detail,walked}));process.exitCode=ok?0:1;}}));
mock.module(walkMod,()=>({...realWalk,goTo:async(_s,_w,to)=>{walked.push(to);return{ok:true};}}));
mock.module(ticksMod,()=>({...realTicks,waitUntil:async()=>false,waitTicks:async()=>{}}));
mock.module(qsMod,()=>({...realQs,nearestBanks:()=>[{x:2618,z:3332,level:0},{x:2727,z:3493,level:0}]}));
`,
    );
    const child = Bun.spawn([process.execPath, '--preload', preload, resolve(root, 'scripts/aio-skiller.ts'), 'fixture', 'gather', 'foraging', 'spawn', String(id), '27'], {
        cwd: root,
        env: { ...process.env, TICKS: '100' },
        windowsHide: true,
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill(), 15000);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        const line = stdout.split(/\r?\n/).find(l => l.startsWith('TEST_WILD_GUARD '));
        if (!line) throw Error(`CLI guard result missing: code=${code} ${stdout} ${stderr}`);
        return { code, ...(JSON.parse(line.slice('TEST_WILD_GUARD '.length)) as { ok: boolean; detail: string; walked: { x: number; z: number; level: number }[] }) };
    } finally {
        clearTimeout(timer);
    }
}

test(
    'ground gather CLI never walks to Wilderness white-berry (239) or plank (960) spawns when mainland spawns stall',
    async () => {
        const [berries, planks, badStart] = await Promise.all([
            runRealGatherCli(239, { x: 2262, z: 3168, level: 0 }),
            runRealGatherCli(960, { x: 2552, z: 3574, level: 0 }),
            runRealGatherCli(239, { x: 3214, z: 3809, level: 0 }),
        ]);
        expect(berries.ok).toBe(false);
        expect(berries.walked.length).toBeGreaterThan(0);
        expect(berries.walked.every(t => wildernessLevel(t.x, t.z) === 0)).toBe(true);
        expect(berries.walked.some(t => t.x === 3214 || t.x === 3218)).toBe(false);

        expect(planks.ok).toBe(false);
        expect(planks.walked.length).toBeGreaterThan(0);
        expect(planks.walked.every(t => wildernessLevel(t.x, t.z) === 0)).toBe(true);
        expect(planks.walked.some(t => t.x === 3148 || t.x === 3154)).toBe(false);

        expect(badStart.ok).toBe(false);
        expect(badStart.walked).toEqual([]);
        expect(badStart.detail).toContain('refused Wilderness position');
    },
    15000,
);
