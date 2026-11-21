import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Session } from '../packages/core/src/inprocess';
import { intentForEntry } from '../packages/planner/src/progression-catalog';
import {
    FALADOR_WEST_BANK, FOUNTAIN_ID, GLORY_4, GLORY_UNCHARGED, HEROES_FOUNTAIN_STAND, HEROES_FOUNTAIN_TILE,
    canEnterHeroesBasement, runChargeGlory,
} from './charge-glory';

test('canEnterHeroesBasement enforces Hero quest completion and basement Blue dragon danger clearance', () => {
    expect(canEnterHeroesBasement({ quests: new Set(), skills: { Hitpoints: 99 } }).ok).toBe(false);
    expect(canEnterHeroesBasement({ quests: new Set(["hero's quest"]), skills: { Hitpoints: 50, Defence: 50 } }).ok).toBe(false);
    expect(canEnterHeroesBasement({ quests: new Set(["hero's quest"]), skills: { Hitpoints: 75 } }).ok).toBe(true);
    expect(canEnterHeroesBasement({ varps: { heroquest: 15 }, skills: { Attack: 99, Strength: 99, Defence: 85, Hitpoints: 70, Prayer: 70 } }).ok).toBe(true);
    expect(canEnterHeroesBasement({ questStages: { heroquest: 15 }, skills: { Hitpoints: 80 } }).ok).toBe(true);
    expect(canEnterHeroesBasement({ unlocks: ['complete:heroquest'], skills: { Hitpoints: 80 } }).ok).toBe(true);
});

test('fountain constants match pinned m45_154 map and Heroes Guild script ids', () => {
    const objPack = readFileSync(new URL('../vendor/rs-sdk/server/content/pack/obj.pack', import.meta.url), 'utf8');
    const locPack = readFileSync(new URL('../vendor/rs-sdk/server/content/pack/loc.pack', import.meta.url), 'utf8');
    const jm2 = readFileSync(new URL('../vendor/rs-sdk/server/content/maps/m45_154.jm2', import.meta.url), 'utf8');
    expect(locPack).toContain(`${FOUNTAIN_ID}=fountain_of_heroes`);
    expect(objPack).toContain(`${GLORY_UNCHARGED[0]}=amulet_of_glory`);
    expect(objPack).toContain(`${GLORY_UNCHARGED[1]}=amulet_of_glory_1`);
    expect(objPack).toContain(`${GLORY_UNCHARGED[2]}=amulet_of_glory_2`);
    expect(objPack).toContain(`${GLORY_UNCHARGED[3]}=amulet_of_glory_3`);
    expect(objPack).toContain(`${GLORY_4}=amulet_of_glory_4`);
    expect(jm2).toContain(`0 ${HEROES_FOUNTAIN_TILE.x - 45 * 64} ${HEROES_FOUNTAIN_TILE.z - 154 * 64}: ${FOUNTAIN_ID} `);
    expect(HEROES_FOUNTAIN_STAND).toEqual({ x: 2916, z: 9893, level: 0 });
});

test('runChargeGlory withdraws uncharged/partial glories, dips at fountain, clears objbox, and deposits glory(4)', async () => {
    let tick = 10, gen = 1, open = false, modal = false, px = FALADOR_WEST_BANK.x, pz = FALADOR_WEST_BANK.z;
    const listeners = new Set<() => void>();
    const timer = setInterval(() => { tick++; for (const fn of [...listeners]) fn(); }, 1);
    const inv: { id: number; name: string; count: number; slot: number }[] = [];
    const bank: { id: number; name: string; count: number; slot: number }[] = [
        { id: 1704, name: 'Amulet of glory', count: 1, slot: 0 },
        { id: 1708, name: 'Amulet of glory(2)', count: 2, slot: 1 },
    ];
    const reindex = () => inv.forEach((r, idx) => { r.slot = idx; });
    const fake = {
        name: 'GloryTester',
        tick: () => tick,
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        ended: new Promise(() => {}),
        bankObservation: () => open ? { generation: gen, at: tick, items: bank.map(i => ({ ...i })) } : null,
        sdk: {
            getInventory: () => inv,
            getSkill: (n: string) => ({ level: n === 'Hitpoints' ? 99 : 1, baseLevel: n === 'Hitpoints' ? 99 : 1 }),
            getState: () => ({
                player: { worldX: px, worldZ: pz, level: 0, lifeId: 1, respawnCount: 0, isDead: false },
                skills: [{ name: 'Hitpoints', baseLevel: 99, level: 99 }],
                quests: [{ name: "Hero's Quest", state: 'complete' }],
                inventory: inv,
                equipment: [],
                bank: { isOpen: open, items: bank },
                dialog: { isOpen: modal, options: modal ? [{ index: 0, text: 'Click here to continue' }] : [] },
                interface: { isOpen: false, interfaceId: -1 },
                nearbyLocs: px === HEROES_FOUNTAIN_STAND.x ? [{ id: FOUNTAIN_ID, name: 'Fountain of Heroes', x: 2917, z: 9893, distance: 1 }] : [],
            }),
        },
        client: { quests: [{ name: "Hero's Quest", complete: true }] },
        bot: {
            openBank: async () => { open = true; gen++; return { success: true }; },
            closeBank: async () => { open = false; return { success: true }; },
            dismissBlockingUI: async () => { modal = false; },
            walkTo: async (x: number, z: number) => { px = x; pz = z; return { success: true }; },
            useItemOnLoc: async (item: { slot: number }) => {
                const row = inv[item.slot]!;
                row.id = GLORY_4;
                row.name = 'Amulet of glory(4)';
                modal = true;
                return { success: true, message: 'Used Amulet of glory on Fountain of Heroes' };
            },
            withdrawItem: async (item: { id: number; name: string }, n: number) => {
                const row = bank.find(r => r.id === item.id)!;
                row.count -= n;
                if (row.count <= 0) bank.splice(bank.indexOf(row), 1);
                for (let k = 0; k < n; k++) inv.push({ id: item.id, name: item.name, count: 1, slot: inv.length });
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
        },
    } as unknown as Session;
    try {
        const res = await runChargeGlory(fake, { cap: 200, walk: async to => { px = to.x; pz = to.z; return { ok: true }; } });
        expect(res.ok).toBe(true);
        expect(res.charged).toBe(3);
        expect(res.bankGlory4).toBe(3);
        expect(modal).toBe(false);
    } finally {
        clearInterval(timer);
    }
});

test('progression catalog admits bounded charge-glory routes and rejects unbounded calls', () => {
    expect(intentForEntry('scripts/charge-glory.ts', ['2000'], { MAX_GLORIES: '28' })).toEqual({
        kind: 'service',
        objective: 'charge-glory:logistics:charge-glory',
        units: 1,
    });
    expect(intentForEntry('scripts/aio.ts', ['logistics', 'charge-glory', '1500', 'MAX_GLORIES=2'])).toEqual({
        kind: 'service',
        objective: 'charge-glory:logistics:charge-glory',
        units: 1,
    });
    expect(intentForEntry('scripts/charge-glory.ts', [])).toBeNull();
    expect(intentForEntry('scripts/charge-glory.ts', ['0'])).toBeNull();
});
