import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Session } from '../packages/core/src/inprocess';
import { intentForEntry } from '../packages/planner/src/progression-catalog';
import {
    CHEST_CLOSED, CHEST_OPEN, CRYSTAL_KEY, FALADOR_WEST_BANK, KEY_LOOP, KEY_TOOTH, MIN_FREE_SLOTS,
    TAVERLEY_CHEST_STAND, TAVERLEY_CHEST_TILE, UNCUT_DRAGONSTONE, planCrystalChest, runCrystalChest,
} from './crystal-chest';

test('planCrystalChest sizes key combination and bounded opens cleanly', () => {
    expect(planCrystalChest(0, 0, 0, 2, 3, 2, 0)).toEqual({ combinePairs: 2, keysToOpen: 4 });
    expect(planCrystalChest(0, 0, 0, 3, 2, 2, 2)).toEqual({ combinePairs: 0, keysToOpen: 2 });
    expect(planCrystalChest(0, 0, 0, 1, 2, 2, 3)).toEqual({ combinePairs: 2, keysToOpen: 3 });
    expect(planCrystalChest(0, 0, 0, 0, 5, 0, 0)).toEqual({ combinePairs: 0, keysToOpen: 0 });
    expect(planCrystalChest(0, 0, 0, -1, 1, 1, 0)).toEqual({ combinePairs: 0, keysToOpen: 0 });
});

test('crystal chest constants match pinned m45_53 map placement and loot slot bound', () => {
    const pack = readFileSync(new URL('../vendor/rs-sdk/server/content/pack/loc.pack', import.meta.url), 'utf8');
    const objPack = readFileSync(new URL('../vendor/rs-sdk/server/content/pack/obj.pack', import.meta.url), 'utf8');
    const jm2 = readFileSync(new URL('../vendor/rs-sdk/server/content/maps/m45_53.jm2', import.meta.url), 'utf8');
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
    let tick = 10, gen = 1, open = false, px = FALADOR_WEST_BANK.x, pz = FALADOR_WEST_BANK.z;
    const listeners = new Set<() => void>();
    const timer = setInterval(() => { tick++; for (const fn of [...listeners]) fn(); }, 1);
    const inv: { id: number; name: string; count: number; slot: number }[] = [];
    const bank: { id: number; name: string; count: number; slot: number }[] = [
        { id: KEY_TOOTH, name: 'Half of a key', count: 1, slot: 0 },
        { id: KEY_LOOP, name: 'Half of a key', count: 1, slot: 1 },
    ];
    const reindex = () => inv.forEach((r, idx) => { r.slot = idx; });
    const pushInv = (id: number, name: string, count: number) => {
        inv.push({ id, name, count, slot: inv.length });
    };
    const fake = {
        name: 'ChestTester',
        tick: () => tick,
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        ended: new Promise(() => {}),
        bankObservation: () => open ? { generation: gen, at: tick, items: bank.map(i => ({ ...i })) } : null,
        sdk: {
            getInventory: () => inv,
            getState: () => ({
                player: { worldX: px, worldZ: pz, level: 0, lifeId: 1, respawnCount: 0, isDead: false },
                inventory: inv,
                bank: { isOpen: open, items: bank },
                nearbyLocs: px === TAVERLEY_CHEST_STAND.x ? [{ id: CHEST_CLOSED, name: 'Crystal chest', x: 2914, z: 3452, distance: 1 }] : [],
            }),
            sendUseItemOnItem: async (a: number, b: number) => {
                const i1 = inv[a], i2 = inv[b];
                if (!i1 || !i2) return { success: false };
                inv.splice(Math.max(a, b), 1);
                inv.splice(Math.min(a, b), 1);
                pushInv(CRYSTAL_KEY, 'Crystal key', 1);
                reindex();
                return { success: true };
            },
        },
        bot: {
            openBank: async () => { open = true; gen++; return { success: true }; },
            closeBank: async () => { open = false; return { success: true }; },
            walkTo: async (x: number, z: number) => { px = x; pz = z; return { success: true }; },
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
        const res = await runCrystalChest(fake, { cap: 200, walk: async to => { px = to.x; pz = to.z; return { ok: true }; } });
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
    expect(intentForEntry('scripts/crystal-chest.ts', ['2000'], { MAX_KEYS: '4' })).toEqual({
        kind: 'service',
        objective: 'crystal-chest:skiller:foraging:crystal-chest',
        units: 1,
    });
    expect(intentForEntry('scripts/aio.ts', ['skiller', 'foraging', 'crystal-chest', '1500', 'MAX_KEYS=1'])).toEqual({
        kind: 'service',
        objective: 'crystal-chest:skiller:foraging:crystal-chest',
        units: 1,
    });
    expect(intentForEntry('scripts/crystal-chest.ts', [])).toBeNull();
    expect(intentForEntry('scripts/crystal-chest.ts', ['0'])).toBeNull();
});
