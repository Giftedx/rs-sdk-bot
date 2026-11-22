import { beforeAll, expect, test } from 'bun:test';
import { AIR, BODY, CAST_RANGE, EARTH, MIND, QUIET_STOP, SPLASH_SITES, SPLASH_SPELLS, SPLASH_TILE, WATER, bankedSplashSpells, castReaches, freeRunesFromEquipment, packSpell, pickSplashTarget, prepareSplashStaffAtBank, runSplash, splashBatchDone, splashDebuffSpells, splashPlan, splashSite, splashSpell } from './splash-train';
import { xpForLevel } from '../packages/planner/src/curve';
import { loadPathfinding } from '../packages/core/src/pathcache';
import { initPathfinding, isTileWalkable } from '../vendor/rs-sdk/sdk/pathfinding';
import * as rsmod from '../vendor/rs-sdk/server/vendor/rsmod-pathfinder';
import { CollisionType } from '../vendor/rs-sdk/server/vendor/rsmod-pathfinder';

// initPathfinding() alone takes about 14 s for each process (packages/core/src/pathcache.ts), which is more than the
// time limit of a test. The snapshot loader makes the same grid first, so the call in the test returns at once.
beforeAll(async () => { await loadPathfinding(); }, 120_000);

test('a level casts the best stat spell it has, and Wind Strike under Confuse', () => {
    expect(splashSpell(1).component).toBe('magic:wind_strike');
    expect(splashSpell(3).component).toBe('magic:confuse');
    expect(splashSpell(11).component).toBe('magic:weaken');
    expect(splashSpell(18).component).toBe('magic:weaken');
    expect(splashSpell(19).component).toBe('magic:curse');
    expect(splashSpell(99).component).toBe('magic:curse');
    // The table is best first, each spell at its level of this server's spell rows.
    expect(SPLASH_SPELLS.map(s => [s.level, s.xp])).toEqual([[19, 725], [11, 525], [3, 325], [1, 137]]);
});

test('the plan counts casts spell by spell up this server\'s level curve, and their runes', () => {
    // Magic 21 to the Magic Guild's level: curses only.
    expect(splashPlan(xpForLevel(21), 66)).toEqual({ casts: 135, runes: { [BODY]: 135, [WATER]: 270, [EARTH]: 405, [MIND]: 0, [AIR]: 0 } });
    // From Magic 1: two strikes to Confuse, then Confuse, Weaken and Curse.
    const fresh = splashPlan(0, 66);
    expect(fresh.casts).toBe(144);
    expect(fresh.runes).toEqual({ [BODY]: 142, [WATER]: 290, [EARTH]: 420, [MIND]: 2, [AIR]: 2 });
    // Experience already past a level's start counts: one curse short of the target needs one cast.
    expect(splashPlan(xpForLevel(66) - 725, 66).casts).toBe(1);
    expect(splashPlan(xpForLevel(66), 66)).toEqual({ casts: 0, runes: { [BODY]: 0, [WATER]: 0, [EARTH]: 0, [MIND]: 0, [AIR]: 0 } });
});

test('no cow can stand beside the fence tile, and a cast from it reaches the field', () => {
    initPathfinding();
    // Every tile a cow (2 tiles wide) reaches from a spawn inside the field by the engine's step rule.
    const key = (x: number, z: number) => `${x},${z}`, seen = new Set([key(2660, 3344)]), queue: [number, number][] = [[2660, 3344]];
    while (queue.length) {
        const [x, z] = queue.shift()!;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
            const nx = x + dx, nz = z + dz;
            if (nx < 2640 || nx > 2690 || nz < 3325 || nz > 3370 || seen.has(key(nx, nz)) || !rsmod.canTravel(0, x, z, dx, dz, 2, 0, CollisionType.NORMAL)) continue;
            seen.add(key(nx, nz)); queue.push([nx, nz]);
        }
    }
    const cows = [...seen].map(k => k.split(',').map(Number) as [number, number]);
    expect(cows.length).toBeGreaterThan(300);
    // The nearest a cow's footprint comes to the tile is two tiles: the fence row lies between.
    const gap = (sw: [number, number]) => Math.max(sw[0] - SPLASH_TILE.x, SPLASH_TILE.x - (sw[0] + 1), sw[1] - SPLASH_TILE.z, SPLASH_TILE.z - (sw[1] + 1), 0);
    expect(Math.min(...cows.map(gap))).toBe(2);
    // Six of the ten cow spawns of the field are in reach and in sight from the tile.
    const spawns: [number, number][] = [[2657, 3341], [2658, 3351], [2660, 3344], [2664, 3341], [2664, 3348], [2664, 3352], [2666, 3344], [2670, 3348], [2671, 3342], [2672, 3354]];
    expect(spawns.filter(([x, z]) => castReaches(SPLASH_TILE, { x, z })).length).toBeGreaterThanOrEqual(6);
    expect(castReaches(SPLASH_TILE, { x: 2664, z: 3341 })).toBe(true);
    // Out of range.
    expect(castReaches(SPLASH_TILE, { x: 2664, z: SPLASH_TILE.z + CAST_RANGE + 1 })).toBe(false);
});

test('a run that gained a level and then ran out of runes, ticks or cows is a finished batch, not a failed band', () => {
    // Live: two runs gained 37 and 15 levels and ended `RESULT fail ... stop=no cast in 300 ticks`.
    for (const stop of ['supplies', 'cap', QUIET_STOP]) {
        expect(splashBatchDone(stop, 1)).toBe(true);
        expect(splashBatchDone(stop, 0)).toBe(false);
    }
    expect(QUIET_STOP).toBe('no cast in 300 ticks');
    // A lost hitpoint, a stop file or a dropped session is never a finished batch.
    for (const stop of ['lost hitpoints at the fence (98 of 99)', 'stopped', 'session ended', '']) expect(splashBatchDone(stop, 5)).toBe(false);
});


test('the coop site casts from the starter pack: the best spell the pack pays for, then Wind Strike', () => {
    const starter = [{ id: AIR, count: 25 }, { id: MIND, count: 15 }, { id: WATER, count: 6 }, { id: EARTH, count: 4 }, { id: BODY, count: 2 }];
    expect(packSpell(1, starter).component).toBe('magic:wind_strike');
    expect(packSpell(3, starter).component).toBe('magic:confuse');
    expect(packSpell(3, starter.filter(i => i.id !== BODY)).component).toBe('magic:wind_strike');
    expect(packSpell(3, []).component).toBe('magic:confuse');
    expect(splashSite().bank).toBe(true);
    expect(splashSite('coop')).toMatchObject({ bank: false, size: 1, hpFloor: 5 });
    expect(splashSite('coop').target({ id: 41, name: 'Chicken' })).toBe(true);
    expect(splashSite('coop').target({ id: 81, name: 'Cow' })).toBe(false);
    expect(() => splashSite('varrock')).toThrow('SPLASH_SITE');
});

test('pickSplashTarget falls back to Weaken and Confuse when Curse is on cooldown for all cows in reach', () => {
    const runes = [{ id: BODY, count: 10 }, { id: WATER, count: 30 }, { id: EARTH, count: 30 }];
    const spells = splashDebuffSpells(65, runes);
    expect(spells.map(s => s.component)).toEqual(['magic:curse', 'magic:weaken', 'magic:confuse']);
    const cows = [{ index: 1, distance: 3 }, { index: 2, distance: 5 }];
    const rest = new Map<string, number>();
    expect(pickSplashTarget(cows, spells, rest, 100)).toEqual({ target: cows[0]!, spell: spells[0]! });
    rest.set('1:magic:curse', 120);
    expect(pickSplashTarget(cows, spells, rest, 100)).toEqual({ target: cows[1]!, spell: spells[0]! });
    rest.set('2:magic:curse', 120);
    expect(pickSplashTarget(cows, spells, rest, 100)).toEqual({ target: cows[0]!, spell: spells[1]! });
    rest.set('1:magic:weaken', 120);
    rest.set('2:magic:weaken', 120);
    expect(pickSplashTarget(cows, spells, rest, 100)).toEqual({ target: cows[0]!, spell: spells[2]! });
});

test('the coop tile is open floor that sees most of the coop within reach', () => {
    initPathfinding();
    const { tile } = SPLASH_SITES.coop!;
    expect(isTileWalkable(0, tile.x, tile.z)).toBe(true);
    let seen = 0, open = 0;
    for (let x = 3223; x <= 3236; x++) for (let z = 3293; z <= 3303; z++) {
        if (!isTileWalkable(0, x, z)) continue;
        open++; if (castReaches(tile, { x, z }, CAST_RANGE, 1)) seen++;
    }
    expect(seen).toBeGreaterThanOrEqual(100);
    expect(seen).toBeLessThanOrEqual(open);
});

test('elemental staff in slot 3 eliminates its rune from splashPlan and splashDebuffSpells', () => {
    const free = freeRunesFromEquipment([{ id: 1385, slot: 3 }]); // Staff of earth
    expect([...free]).toEqual([EARTH]);
    expect(splashPlan(xpForLevel(21), 66, free)).toEqual({
        casts: 135,
        runes: { [BODY]: 135, [WATER]: 270, [EARTH]: 0, [MIND]: 0, [AIR]: 0 },
    });
    expect(splashDebuffSpells(21, [{ id: BODY, count: 1 }, { id: WATER, count: 2 }], free).map(s => s.component)).toEqual(['magic:curse']);
});

test('prepareSplashStaffAtBank equips best covering bank staff or buys Staff of earth from Zaff', async () => {
    let bankOpen = true, shopOpen = false, gen = 1, tick = 0;
    const inv: any[] = [];
    const eq: any[] = [];
    const bank: any[] = [{ id: 995, name: 'Coins', count: 2500, slot: 0 }, { id: 1381, name: 'Staff of air', count: 1, slot: 1 }];
    const shopItems = [{ id: 1385, name: 'Staff of earth', count: 2, buyPrice: 1500, slot: 0 }];
    const walks: string[] = [];
    const listeners = new Set<() => void>();
    const timer = setInterval(() => { tick++; for (const fn of [...listeners]) fn(); }, 1);
    const s: any = {
        tick: () => tick,
        onTick: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
        bankObservation: () => bankOpen ? { generation: gen, items: bank } : null,
        sdk: {
            getState: () => ({ inventory: inv, equipment: eq, bank: { isOpen: bankOpen, items: bank }, shop: { isOpen: shopOpen, shopItems } }),
            getInventory: () => inv,
            getEquipment: () => eq,
            getSkill: (n: string) => ({ level: n === 'Magic' ? 21 : 1, baseLevel: n === 'Magic' ? 21 : 1 }),
        },
        bot: {
            openBank: async () => { bankOpen = true; gen++; return { success: true }; },
            closeBank: async () => { bankOpen = false; return { success: true }; },
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
            openShop: async () => { shopOpen = true; return { success: true }; },
            buyFromShop: async (row: any, n: number) => {
                row.count -= n;
                inv.find(i => i.id === 995).count -= row.buyPrice * n;
                inv.push({ id: row.id, name: itemName(row.id), count: n });
                return { success: true };
            },
            closeShop: async () => { shopOpen = false; return { success: true }; },
        },
    };
    function itemName(id: number) { return id === 1385 ? 'Staff of earth' : 'Item'; }
    try {
        const res = await prepareSplashStaffAtBank(s, {
            xp: xpForLevel(21),
            target: 66,
            bankSpot: { x: 3185, z: 3436 },
            allowZaffShop: true,
            stop: () => false,
            walkTo: async spot => { walks.push(`${spot.x},${spot.z}`); return true; },
        });
        expect(res.activeId).toBe(1385);
        expect(res.bought).toBe(1385);
        expect([...res.freeRunes]).toEqual([EARTH]);
        expect(walks).toEqual(['3203,3433', '3185,3436']);
        expect(eq[0]?.id).toBe(1385);
        expect(bank.find(i => i.id === 995)?.count).toBe(1000);
        expect(inv).toHaveLength(0);
    } finally {
        clearInterval(timer);
    }
});

// A fake session at a bank: it records the walks and the withdrawals, and it notes the pack and the bank when the
// run closes the Ardougne bank. `closed()` then stops the run before its first cast.
function bankedSplashFixture(magic: number, bank: any[], start = { worldX: 3185, worldZ: 3436 }) {
    let tick = 0, bankOpen = false, shopOpen = false, gen = 1, closedAtBankCount = 0;
    const listeners = new Set<() => void>();
    const timer = setInterval(() => { tick++; for (const fn of [...listeners]) fn(); }, 2);
    const player = { ...start, level: 0 };
    const inv: any[] = [];
    const eq: any[] = [];
    const shopItems = [{ id: 1385, name: 'Staff of earth', count: 2, buyPrice: 1500, slot: 0 }];
    const walks: string[] = [];
    const withdraws: { id: number; n: number; worldX: number }[] = [];
    let invAtCombatStart: { id: number; count: number }[] = [];
    let bankAtCombatStart: { id: number; count: number }[] = [];

    const s: any = {
        tick: () => tick,
        ended: new Promise<void>(() => {}),
        onTick: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
        direct: async () => ({ success: true }),
        bankObservation: () => bankOpen ? { generation: gen, items: bank } : null,
        sdk: {
            getState: () => ({
                tick,
                player,
                inventory: inv,
                equipment: eq,
                bank: { isOpen: bankOpen, items: bank },
                shop: { isOpen: shopOpen, shopItems },
                nearbyNpcs: [],
                nearbyLocs: [],
                nearbyPlayers: [],
                gameMessages: [],
            }),
            getInventory: () => inv,
            getEquipment: () => eq,
            getSkill: (n: string) => {
                if (n === 'Magic') return { level: magic, baseLevel: magic };
                if (n === 'Hitpoints') return { level: 10, baseLevel: 10 };
                return { level: 1, baseLevel: 1 };
            },
            getSkillXp: (n: string) => (n === 'Magic' ? xpForLevel(magic) : 0),
        },
        bot: {
            openBank: async () => { bankOpen = true; gen++; return { success: true }; },
            closeBank: async () => {
                bankOpen = false;
                if (player.worldX === 2619 && closedAtBankCount === 0) {
                    closedAtBankCount++;
                    invAtCombatStart = inv.map(i => ({ id: i.id, count: i.count }));
                    bankAtCombatStart = bank.map(i => ({ id: i.id, count: i.count }));
                }
                return { success: true };
            },
            withdrawItem: async (item: any, n: number) => {
                withdraws.push({ id: item.id, n, worldX: player.worldX });
                const row = bank.find(r => r.id === item.id);
                row.count -= n;
                if (row.count <= 0) bank.splice(bank.indexOf(row), 1);
                inv.push({ id: item.id, name: item.name, count: n, slot: inv.length });
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
                else bank.push({ id: item.id, name: item.name, count: amt, slot: bank.length });
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
            openShop: async () => { shopOpen = true; return { success: true }; },
            buyFromShop: async (row: any, n: number) => {
                row.count -= n;
                inv.find(i => i.id === 995).count -= row.buyPrice * n;
                inv.push({ id: row.id, name: row.name, count: n, slot: inv.length });
                return { success: true };
            },
            closeShop: async () => { shopOpen = false; return { success: true }; },
        },
    };

    const walkTo = async (spot: { x: number; z: number }) => { walks.push(`${spot.x},${spot.z}`); player.worldX = spot.x; player.worldZ = spot.z; return true; };
    return { s, eq, bank, walks, withdraws, walkTo, closed: () => closedAtBankCount > 0, atStart: () => ({ inv: invAtCombatStart, bank: bankAtCombatStart }), end: () => clearInterval(timer) };
}

test('runSplash captures east-side start before walking to Ardougne, buys Zaff Staff of earth, equips it, and withdraws 0 Earth runes', async () => {
    const f = bankedSplashFixture(21, [
        { id: 995, name: 'Coins', count: 2500, slot: 0 },
        { id: BODY, name: 'Body rune', count: 135, slot: 1 },
        { id: WATER, name: 'Water rune', count: 270, slot: 2 },
        { id: EARTH, name: 'Earth rune', count: 405, slot: 3 },
    ]);
    try {
        const res = await runSplash(f.s, { target: 66, cap: 500, stop: f.closed, walkTo: f.walkTo });
        expect(res.stop).toBe('stopped');
        expect(f.walks).toEqual(['3203,3433', '3185,3436', '2619,3332']);
        expect(f.eq[0]?.id).toBe(1385);
        expect(f.atStart().inv.find(i => i.id === BODY)?.count).toBe(135);
        expect(f.atStart().inv.find(i => i.id === WATER)?.count).toBe(270);
        expect(f.atStart().inv.find(i => i.id === EARTH)).toBeUndefined();
        expect(f.atStart().bank.find(i => i.id === EARTH)?.count).toBe(405);
        expect(f.withdraws.some(w => w.id === EARTH)).toBe(false);
        expect(f.bank.find(i => i.id === 995)?.count).toBe(1000);
    } finally { f.end(); }
});

test('a banked run under Magic 3 casts Wind Strike with its mind and air runes; with none it stops for supplies', async () => {
    // The planner's kit for a new account (autopilot.ts army-splash-magic-66): two strikes, then the stat spells.
    const kit = () => [{ id: MIND, name: 'Mind rune', count: 2, slot: 0 }, { id: AIR, name: 'Air rune', count: 2, slot: 1 },
        { id: BODY, name: 'Body rune', count: 10, slot: 2 }, { id: WATER, name: 'Water rune', count: 30, slot: 3 }, { id: EARTH, name: 'Earth rune', count: 30, slot: 4 }];
    const f = bankedSplashFixture(1, kit(), { worldX: 2619, worldZ: 3332 });
    try {
        const res = await runSplash(f.s, { target: 66, cap: 500, stop: f.closed, walkTo: f.walkTo });
        expect(f.atStart().inv.find(i => i.id === MIND)?.count).toBe(2);
        expect(f.atStart().inv.find(i => i.id === AIR)?.count).toBe(2);
        expect(res.stop).toBe('stopped');
    } finally { f.end(); }
    const none = bankedSplashFixture(1, kit().filter(i => i.id !== MIND), { worldX: 2619, worldZ: 3332 });
    try { expect((await runSplash(none.s, { target: 66, cap: 500, stop: none.closed, walkTo: none.walkTo })).stop).toBe('supplies'); } finally { none.end(); }
    expect(bankedSplashSpells(1, [{ id: MIND, count: 2 }, { id: AIR, count: 2 }]).map(s => s.component)).toEqual(['magic:wind_strike']);
    expect(bankedSplashSpells(2, [{ id: MIND, count: 1 }])).toEqual([]);
    // From Magic 3 the banked run casts only the stat spells: leftover strike runes do not keep it at the fence.
    expect(bankedSplashSpells(3, [{ id: MIND, count: 2 }, { id: AIR, count: 2 }])).toEqual([]);
    expect(bankedSplashSpells(11, [{ id: BODY, count: 1 }, { id: WATER, count: 3 }, { id: EARTH, count: 3 }, { id: MIND, count: 2 }, { id: AIR, count: 2 }]).map(s => s.component))
        .toEqual(['magic:weaken', 'magic:confuse']);
});
