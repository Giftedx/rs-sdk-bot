import { expect, test } from 'bun:test';
import { runLegacyCraftJewelryCli } from '../src/bank-artisan';

type Item = { id: number; name: string; count: number; slot: number };

async function smeltFixture(options: { effect?: boolean; staged?: boolean } = {}) {
    let tick = 0, reads = 0, crafts = 0;
    const player = { worldX: options.staged ? 3274 : 3269, worldZ: options.staged ? 3186 : 3167 };
    const names: Record<number, string> = { 1592: 'Ring mould', 2357: 'Gold bar', 1607: 'Sapphire', 1637: 'Sapphire ring' };
    const bank = new Map<number, number>(options.staged ? [] : [[1592, 1], [2357, 26], [1607, 26]]);
    const pack: Item[] = options.staged ? [1592, 2357, 1607].map((id, slot) => ({ id, name: names[id]!, count: 1, slot })) : [];
    const reindex = () => pack.forEach((item, slot) => { item.slot = slot; });
    const count = (pattern: RegExp) => pack.filter(item => pattern.test(item.name)).reduce((sum, item) => sum + item.count, 0);
    let result: { ok: boolean; detail: string } | undefined;
    const session = {
        tick: () => tick,
        sdk: {
            getInventory: () => pack,
            getState: () => {
                if (++reads > 10_000) throw Error('worker did not advance its tick budget');
                return { player };
            },
        },
        bot: {
            openBank: async () => ({ success: true }),
            closeInterface: async () => ({ success: true }),
            depositItem: async (pattern: RegExp) => {
                for (let i = pack.length - 1; i >= 0; i--) if (pattern.test(pack[i]!.name)) {
                    const item = pack.splice(i, 1)[0]!;
                    bank.set(item.id, (bank.get(item.id) ?? 0) + item.count);
                }
                reindex();
                return { success: true };
            },
            withdrawItem: async (pattern: RegExp, amount: number) => {
                const id = [...bank.keys()].find(id => pattern.test(names[id]!));
                if (id === undefined) return { success: false };
                const quantity = Math.min(amount, bank.get(id) ?? 0);
                bank.set(id, (bank.get(id) ?? 0) - quantity);
                for (let i = 0; i < quantity; i++) pack.push({ id, name: names[id]!, count: 1, slot: pack.length });
                return { success: quantity > 0 };
            },
            craftJewelry: async () => {
                crafts++;
                tick++;
                if (options.effect !== false) {
                    const quantity = Math.min(2, count(/^gold bar$/i), count(/^sapphire$/i));
                    for (const id of [2357, 1607]) for (let i = 0; i < quantity; i++) pack.splice(pack.findIndex(item => item.id === id), 1);
                    for (let i = 0; i < quantity; i++) pack.push({ id: 1637, name: names[1637]!, count: 1, slot: pack.length });
                    reindex();
                }
                return { success: true };
            },
        },
    };
    // Run the actual CLI body with a finite session fixture. No login or game server is used.
    await runLegacyCraftJewelryCli(
        'JewelFixture',
        ['400', 'smelt', 'sapphire'],
        {},
        {
            openBot: async () => session as any,
            finish: (async (_sessions: unknown[], ok: boolean, detail: string) => { result = { ok, detail }; }) as any,
            countItems: (_session: unknown, pattern: RegExp) => count(pattern),
            waitTicks: (async (_session: unknown, ticks = 1) => { tick += ticks; }) as any,
            waitUntil: (async (_session: unknown, condition: () => boolean) => condition()) as any,
            sessionWalker: (async () => ({})) as any,
            walkPath: (async (_walker: unknown, points: { x: number; z: number }[]) => {
                const point = points.at(-1)!;
                player.worldX = point.x; player.worldZ = point.z; tick++;
                return { ok: true, ticks: 1 };
            }) as any,
        },
    );
    return { result, bank, pack, crafts, tick };
}

test('legacy furnace smelting advances through crafting and banks the observed ring output', async () => {
    const f = await smeltFixture();
    expect(f.result?.ok).toBe(true);
    expect(f.result?.detail).toMatch(/\bcrafted=26\b/);
    expect(f.bank.get(1637)).toBe(26);
    expect(f.bank.get(2357)).toBe(0);
    expect(f.bank.get(1607)).toBe(0);
    expect(f.pack).toEqual([{ id: 1592, name: 'Ring mould', count: 1, slot: 0 }]);
    expect(f.crafts).toBe(14);
    expect(f.tick).toBeGreaterThanOrEqual(400);
});

test('a successful craft acknowledgement with no product cannot count as crafted output', async () => {
    const f = await smeltFixture({ effect: false, staged: true });
    expect(f.crafts).toBeGreaterThan(0);
    expect(f.result?.ok).toBe(false);
    expect(f.result?.detail).toMatch(/\bcrafted=0\b/);
    expect(f.pack.map(item => item.id)).toEqual([1592, 2357, 1607]);
    expect(f.tick).toBeGreaterThanOrEqual(400);
});

test('legacy furnace smelting terminates cleanly when furnace walk fails repeatedly', async () => {
    let tick = 0;
    let walkCalls = 0;
    let result: { ok: boolean; detail: string } | undefined;
    const pack: Item[] = [
        { id: 1592, name: 'Ring mould', count: 1, slot: 0 },
        { id: 2357, name: 'Gold bar', count: 1, slot: 1 },
        { id: 1607, name: 'Sapphire', count: 1, slot: 2 },
    ];
    const session = {
        tick: () => tick,
        sdk: {
            getInventory: () => pack,
            getState: () => ({ player: { worldX: 3269, worldZ: 3167 } }),
        },
        bot: {
            openBank: async () => ({ success: true }),
            closeInterface: async () => ({ success: true }),
            depositItem: async () => ({ success: true }),
            withdrawItem: async () => ({ success: true }),
            craftJewelry: async () => ({ success: true }),
        },
    };
    await runLegacyCraftJewelryCli(
        'JewelWalkFail',
        ['400', 'smelt', 'sapphire'],
        {},
        {
            openBot: async () => session as any,
            finish: (async (_sessions: unknown[], ok: boolean, detail: string) => { result = { ok, detail }; }) as any,
            countItems: () => 0,
            waitTicks: (async (_session: unknown, ticks = 1) => { tick += ticks; }) as any,
            waitUntil: (async (_session: unknown, condition: () => boolean) => condition()) as any,
            sessionWalker: (async () => ({})) as any,
            walkPath: (async () => {
                walkCalls++;
                return { ok: false, ticks: 0, detail: 'blocked' };
            }) as any,
        },
    );
    expect(walkCalls).toBe(15);
    expect(result?.ok).toBe(false);
    expect(tick).toBeLessThan(400);
});
