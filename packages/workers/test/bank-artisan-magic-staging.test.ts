import { describe, expect, test } from 'bun:test';
import {
    itemMagicRecipe,
    itemSpellCosts,
    nativeTeleport,
    runItemMagic,
    runItemMagicBanked,
    spellCastsHeld,
    spellInputStackable,
    stagedSpellCasts,
    stageTeleportRunes,
} from '../src/bank-artisan/magic';

const RING = 1637;
const COSMIC = 564;
const WATER = 555;
const NAMES: Record<number, string> = { 1637: 'Sapphire ring', 2550: 'Ring of recoil', 564: 'Cosmic rune', 555: 'Water rune', 563: 'Law rune', 556: 'Air rune', 554: 'Fire rune' };
const STAFF_OF_WATER = 1383;
const stacks = (id: number) => id !== 1637 && id !== 2550 && id !== STAFF_OF_WATER;

// A session with a bank in reach: the pack starts empty and every withdrawal and deposit is observed.
function bankSession(bankStart: Record<number, number>, packStart: { id: number; count: number }[] = []) {
    const r = itemMagicRecipe('enchant:sapphire_ring');
    let tick = 0;
    let xp = 0;
    let generation = 0;
    let open = false;
    let casts = 0;
    let lastCast = -100;
    let inv: { id: number; count: number; slot: number; name: string }[] = packStart.map((p, slot) => ({ ...p, slot, name: NAMES[p.id] ?? String(p.id) }));
    let eq: { id: number; slot: number; count: number }[] = [];
    const staffWorn = () => eq.some(e => e.slot === 3 && e.id === STAFF_OF_WATER);
    const bank: Record<number, number> = { ...bankStart };
    const listeners = new Set<() => void>();
    const freeSlot = () => { for (let i = 0; i < 28; i++) if (!inv.some(x => x.slot === i)) return i; return -1; };
    const add = (id: number, n: number) => {
        if (stacks(id)) {
            const row = inv.find(x => x.id === id);
            if (row) row.count += n;
            else inv.push({ id, count: n, slot: freeSlot(), name: NAMES[id]! });
        } else {
            for (let k = 0; k < n; k++) inv.push({ id, count: 1, slot: freeSlot(), name: NAMES[id]! });
        }
    };
    const bankItems = () => Object.entries(bank).filter(([, n]) => n > 0).map(([id, count], slot) => ({ id: Number(id), count, slot, name: NAMES[Number(id)]! }));
    const s: any = {
        name: 'Earlyshooter',
        tick: () => tick,
        ended: new Promise(() => {}),
        onTick: (f: () => void) => { listeners.add(f); return () => listeners.delete(f); },
        client: { objType: (id: number) => ({ stackable: stacks(id) }) },
        sdk: {
            getState: () => ({ player: { worldX: 3185, worldZ: 3436, lifeId: 1, isDead: false }, equipment: eq, inventory: inv, bank: { isOpen: open, items: bankItems() } }),
            getInventory: () => inv,
            getEquipment: () => eq,
            getSkillXp: () => xp,
            getSkill: () => ({ level: 99 }),
            sendCloseModal: async () => ({ success: true }),
        },
        bankObservation: () => ({ generation, items: bankItems(), at: tick }),
        bot: {
            dismissBlockingUI: async () => {},
            equipItem: async (row: { id: number }) => {
                inv = inv.filter(x => x.id !== row.id);
                eq = [{ id: row.id, slot: 3, count: 1 }];
                return { success: true };
            },
            // The engine refuses a booth click while the last spell delay runs (bench trace: OpLoc delayed=true).
            openBank: async () => {
                if (tick - lastCast < 3) return { success: false, message: 'Timeout waiting for bank interface to open' };
                open = true;
                generation++;
                return { success: true };
            },
            closeBank: async () => { open = false; return { success: true }; },
            withdrawItem: async (row: { id: number }, n: number) => {
                if ((bank[row.id] ?? 0) < n) return { success: false };
                bank[row.id]! -= n;
                add(row.id, n);
                generation++;
                return { success: true };
            },
            depositItem: async (row: { id: number }) => {
                const n = inv.filter(x => x.id === row.id).reduce((a, x) => a + x.count, 0);
                inv = inv.filter(x => x.id !== row.id);
                bank[row.id] = (bank[row.id] ?? 0) + n;
                generation++;
                return { success: true };
            },
        },
        direct: async (a: { type: string; slot: number }) => {
            expect(a.type).toBe('spellOnItem');
            const target = inv.find(x => x.slot === a.slot && x.id === RING);
            if (!target) return { success: false };
            target.id = r.product;
            target.name = NAMES[r.product]!;
            for (const id of staffWorn() ? [COSMIC] : [COSMIC, WATER]) {
                const row = inv.find(x => x.id === id)!;
                row.count--;
                if (row.count === 0) inv = inv.filter(x => x !== row);
            }
            xp += 17;
            lastCast = tick;
            casts++;
            return { success: true };
        },
    };
    const timer = setInterval(() => { tick++; for (const f of listeners) f(); }, 1);
    return { s, r, bank, stop: () => clearInterval(timer), casts: () => casts, pack: () => inv };
}

describe('bank staging for pack spells', () => {
    test('staged casts fit the free slots and the bank stock', () => {
        const perCast = { [RING]: 1, [COSMIC]: 1, [WATER]: 1 };
        // 26 rings and one slot for each rune stack fill an empty pack.
        expect(stagedSpellCasts(perCast, 50, [], [{ id: RING, count: 30 }, { id: COSMIC, count: 100 }, { id: WATER, count: 100 }], 28, stacks)).toBe(26);
        // The bank stock of rings bounds the casts.
        expect(stagedSpellCasts(perCast, 50, [], [{ id: RING, count: 10 }, { id: COSMIC, count: 100 }, { id: WATER, count: 100 }], 28, stacks)).toBe(10);
        // No cosmic runes anywhere: no casts, as for Earlyshooter.
        expect(stagedSpellCasts(perCast, 50, [], [{ id: RING, count: 10 }, { id: WATER, count: 100 }], 28, stacks)).toBe(0);
        // A held rune stack takes no new slot.
        expect(stagedSpellCasts(perCast, 50, [{ id: COSMIC, count: 5 }], [{ id: RING, count: 30 }, { id: COSMIC, count: 100 }, { id: WATER, count: 100 }], 27, stacks)).toBe(26);
        expect(spellCastsHeld(perCast, [{ id: RING, count: 1 }, { id: RING, count: 1 }, { id: COSMIC, count: 9 }, { id: WATER, count: 1 }])).toBe(1);
    });

    test('runes and coins stack without a client item type, rings do not', () => {
        expect(spellInputStackable(undefined, COSMIC)).toBe(true);
        expect(spellInputStackable(undefined, 995)).toBe(true);
        expect(spellInputStackable(undefined, RING)).toBe(false);
        expect(spellInputStackable({ objType: () => ({ stackable: true }) }, RING)).toBe(true);
    });

    test('enchanting takes rings and runes from the bank when the pack holds none', async () => {
        const f = bankSession({ [RING]: 2, [COSMIC]: 5, [WATER]: 5 });
        try {
            // The pack-only runner stops at once: the Earlyshooter and Woodpecker result.
            const before = await runItemMagic(f.s, f.r, { count: 2, cap: 200 });
            expect(before).toMatchObject({ ok: false, stop: 'supplies', casts: 0 });
            const out = await runItemMagicBanked(f.s, f.r, { count: 2, cap: 400 });
            expect(out.casts).toBe(2);
            expect(out.ok).toBe(true);
            expect(f.casts()).toBe(2);
            expect(f.bank[RING]).toBe(0);
        } finally {
            f.stop();
        }
    });

    test('a bank that runs out after some casts ends ok on supplies, and an empty bank fails', async () => {
        const f = bankSession({ [RING]: 3, [COSMIC]: 9, [WATER]: 9 });
        try {
            const out = await runItemMagicBanked(f.s, f.r, { count: 50, cap: 2000 });
            expect(out).toMatchObject({ ok: true, stop: 'supplies', casts: 3, produced: 3 });
            // The second stage banked the three products before it found no rings.
            expect(f.bank[f.r.product]).toBe(3);
            const empty = await runItemMagicBanked(f.s, f.r, { count: 1, cap: 200 });
            expect(empty).toMatchObject({ ok: false, stop: 'supplies', casts: 0 });
        } finally {
            f.stop();
        }
    });

    test('teleport runes stage only when the pack holds too few casts', async () => {
        const t = nativeTeleport('varrock');
        const f = bankSession({ 563: 10, 556: 30, 554: 10 });
        try {
            const staged = await stageTeleportRunes(f.s, t, 5);
            expect(staged).toEqual({ casts: 5, banked: true });
            for (const [id, n] of Object.entries(t.runes)) {
                expect(f.pack().find(x => x.id === Number(id))?.count).toBe(n * 5);
            }
            expect(await stageTeleportRunes(f.s, t, 5)).toEqual({ casts: 5, banked: false });
        } finally {
            f.stop();
        }
    });

    test('the enchant recipe costs one ring, one cosmic and one water rune per cast', () => {
        expect(itemSpellCosts(itemMagicRecipe('enchant:sapphire_ring'), [])).toEqual({ [RING]: 1, [COSMIC]: 1, [WATER]: 1 });
    });
});

test('a run that hits its tick cap reports cap, not supplies', async () => {
    const f = bankSession({ [RING]: 5, [COSMIC]: 5, [WATER]: 5 });
    try {
        const out = await runItemMagicBanked(f.s, f.r, { count: 5, cap: 1 });
        expect(out.ok).toBe(false);
        expect(out.stop).toBe('cap');
    } finally {
        f.stop();
    }
});

test('a pack Staff of water pays the water runes, so a pack without water runes still enchants', async () => {
    // The old pack runner equipped the staff before its costs; the banked runner must too.
    const f = bankSession({}, [{ id: RING, count: 1 }, { id: RING, count: 1 }, { id: COSMIC, count: 2 }, { id: STAFF_OF_WATER, count: 1 }]);
    try {
        const out = await runItemMagicBanked(f.s, f.r, { count: 2, cap: 400 });
        expect(out).toMatchObject({ ok: true, casts: 2, stages: 0 });
        expect(f.s.sdk.getEquipment()).toEqual([{ id: STAFF_OF_WATER, slot: 3, count: 1 }]);
    } finally {
        f.stop();
    }
});
