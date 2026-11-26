import { describe, expect, test } from 'bun:test';
import type { BankProfile, BankRouteJob } from '../../core/src/bank-trip';
import { isItemStackable, itemStackable } from '../src/bank-artisan/catalog';
import { runArtisanBankProfile } from '../src/bank-artisan/runtime';

const LAW = 563;
const AIR = 556;
const FIRE = 554;
const LOGS = 1511;
const WILLOW = 1519;
const NAMES: Record<number, string> = { 563: 'Law rune', 556: 'Air rune', 554: 'Fire rune', 1511: 'Logs', 1519: 'Willow logs' };
const stacks = (id: number) => id === LAW || id === AIR || id === FIRE;
const BANK = { x: 3185, z: 3436, level: 0 };

// A session that stands at a bank. Every withdrawal and deposit changes the pack and the bank at once.
function bankSession(bankStart: Record<number, number>, client: unknown) {
    let tick = 0;
    let generation = 0;
    let open = false;
    let inv: { id: number; count: number; slot: number; name: string }[] = [];
    const bank: Record<number, number> = { ...bankStart };
    const listeners = new Set<() => void>();
    const freeSlot = () => { for (let i = 0; i < 28; i++) if (!inv.some(x => x.slot === i)) return i; return -1; };
    const add = (id: number, n: number) => {
        if (stacks(id)) {
            const row = inv.find(x => x.id === id);
            if (row) row.count += n;
            else if (freeSlot() < 0) throw Error('pack full');
            else inv.push({ id, count: n, slot: freeSlot(), name: NAMES[id]! });
            return;
        }
        for (let k = 0; k < n; k++) {
            if (freeSlot() < 0) throw Error('pack full');
            inv.push({ id, count: 1, slot: freeSlot(), name: NAMES[id]! });
        }
    };
    const take = (id: number, n: number) => {
        for (let k = n; k > 0;) {
            const row = inv.find(x => x.id === id);
            if (!row) throw Error(`pack short ${id}`);
            const used = Math.min(row.count, k);
            row.count -= used;
            k -= used;
            if (row.count === 0) inv = inv.filter(x => x !== row);
        }
    };
    const bankItems = () => Object.entries(bank).filter(([, n]) => n > 0).map(([id, count], slot) => ({ id: Number(id), count, slot, name: NAMES[Number(id)]! }));
    const s: any = {
        name: 'BankProfileFake',
        tick: () => tick,
        ended: new Promise(() => {}),
        onTick: (f: () => void) => { listeners.add(f); return () => listeners.delete(f); },
        client,
        sdk: {
            getState: () => ({ player: { worldX: BANK.x, worldZ: BANK.z, level: 0, lifeId: 1, isDead: false }, inventory: inv, bank: { isOpen: open, items: bankItems() } }),
            getInventory: () => inv,
        },
        bankObservation: () => ({ generation, items: bankItems(), at: tick }),
        bot: {
            openBank: async () => { open = true; generation++; return { success: true }; },
            closeBank: async () => { open = false; return { success: true }; },
            withdrawItem: async (id: number, n: number) => {
                if ((bank[id] ?? 0) < n) return { success: false };
                add(id, n);
                bank[id]! -= n;
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
    };
    const timer = setInterval(() => { tick++; for (const f of listeners) f(); }, 1);
    return { s, bank, add, take, stop: () => clearInterval(timer) };
}

const job = (target: number, batch: number): BankRouteJob => ({ family: 'magic-teleport', recipe: 'varrock', target, batch, cap: 600, returnTicks: 20, members: false, bank: BANK });

// Each unit uses `inputs` from the pack and puts `made` into it.
function profile(f: ReturnType<typeof bankSession>, inputs: Record<number, number>, made: Record<number, number>, extra: Partial<BankProfile> = {}): BankProfile {
    return {
        inputs,
        tools: [],
        outputs: Object.keys(made).map(Number),
        bank: BANK,
        site: BANK,
        run: async n => {
            for (const [id, each] of Object.entries(inputs)) f.take(Number(id), each * n);
            for (const [id, each] of Object.entries(made)) f.add(Number(id), each * n);
            return n;
        },
        ...extra,
    };
}

const TELEPORT = { [LAW]: 1, [AIR]: 3, [FIRE]: 1 };
const RUNE_BANK = { [LAW]: 100, [AIR]: 300, [FIRE]: 100 };

describe('runArtisanBankProfile pack space', () => {
    test('rune stacks take one slot each: one trip carries the whole batch', async () => {
        const f = bankSession(RUNE_BANK, { objType: (id: number) => ({ stackable: stacks(id) }) });
        try {
            const r = await runArtisanBankProfile(f.s, job(20, 20), profile(f, TELEPORT, {}));
            expect(r).toMatchObject({ ok: true, completed: 20, trips: 1, failure: '-' });
            expect(f.bank[LAW]).toBe(80);
        } finally { f.stop(); }
    });

    test('without a client item type the knowledge build says runes stack', async () => {
        const f = bankSession(RUNE_BANK, {});
        try {
            const r = await runArtisanBankProfile(f.s, job(20, 20), profile(f, TELEPORT, {}));
            expect(r).toMatchObject({ ok: true, completed: 20, trips: 1, failure: '-' });
        } finally { f.stop(); }
    });

    test('a product id is not read as a per-unit count', async () => {
        // The profile names its product (id 1519) in outputs. A count of 1519 per unit fits no batch.
        const f = bankSession({ [LOGS]: 10 }, { objType: (id: number) => ({ stackable: stacks(id) }) });
        try {
            const r = await runArtisanBankProfile(f.s, job(10, 28), profile(f, { [LOGS]: 1 }, {}, { outputs: [WILLOW] }));
            expect(r).toMatchObject({ ok: true, completed: 10, trips: 1, failure: '-' });
        } finally { f.stop(); }
    });

    test('capacityOutputs bound the batch: two products a unit fill the pack at 14 units', async () => {
        const f = bankSession({ [LOGS]: 28 }, { objType: (id: number) => ({ stackable: stacks(id) }) });
        try {
            const r = await runArtisanBankProfile(f.s, job(28, 28), profile(f, { [LOGS]: 1 }, { [WILLOW]: 2 }, { capacityOutputs: { [WILLOW]: 2 } }));
            expect(r).toMatchObject({ ok: true, completed: 28, trips: 2, failure: '-' });
            expect(f.bank[WILLOW]).toBe(56);
        } finally { f.stop(); }
    });
});

describe('item stackability', () => {
    test('the knowledge build marks runes, coins and banknotes stackable', () => {
        expect(isItemStackable(AIR)).toBe(true);
        expect(isItemStackable(LAW)).toBe(true);
        expect(isItemStackable(995)).toBe(true);
        expect(isItemStackable(LOGS)).toBe(false);
        expect(isItemStackable(1512)).toBe(true); // cert_logs
        expect(isItemStackable(-5)).toBe(false);
    });

    test('the client item type wins over the knowledge build', () => {
        expect(itemStackable({ objType: () => ({ stackable: true }) }, LOGS)).toBe(true);
        expect(itemStackable({ objType: () => ({ stackable: false }) }, AIR)).toBe(false);
        expect(itemStackable({ objType: () => { throw Error('no type'); } }, AIR)).toBe(true);
        expect(itemStackable(undefined, LOGS)).toBe(false);
    });
});
