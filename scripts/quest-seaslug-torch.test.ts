import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { lightSeaSlugTorch } from './generated/quest-seaslug';
import { parseJm2 } from '../packages/knowledge/src/jm2';

function fixture(torch = false) {
    const pack = new Set([1468, ...(torch ? [596] : [])]);
    let received = true, stopped = false, attempts = 0, failures = 0, lightAt = 1;
    const calls: string[] = [];
    const q = {
        has: (id: number) => pack.has(id),
        guard: async () => { if (stopped) throw Error('stopped'); },
        fail: async (why: string) => { throw Error(why); },
        talk: async (label: string, npc: RegExp, choices: RegExp[], observed: () => boolean, home: unknown, ticks: number) => {
            calls.push(label);
            expect(npc.test('Bailey')).toBe(true); expect(choices).toEqual([]);
            expect(home).toEqual({ x: 2763, z: 3276 }); expect(ticks).toBe(60);
            if (received) pack.add(596);
            // Receipt is checked independently even if a dialogue adapter returns early.
            observed();
        },
        converse: async () => { calls.push('close dialogue'); }, dialogOpen: () => false,
        slot: () => 0, msgCount: () => failures,
        waitUntil: async (observed: () => boolean, ticks: number) => { expect(ticks).toBe(6); return observed(); },
        s: { direct: async () => {
            expect(pack.has(596)).toBe(true); calls.push('rub'); attempts++;
            if (attempts >= lightAt) { pack.delete(596); pack.add(594); } else failures++;
        } },
    } as unknown as Parameters<typeof lightSeaSlugTorch>[0];
    return { q, pack, calls, attempts: () => attempts,
        receive: (x: boolean) => { received = x; }, stop: () => { stopped = true; },
        succeedsAt: (n: number) => { lightAt = n; } };
}

test('normal entry obtains free Bailey torch before lighting and observes its conversion', async () => {
    const f = fixture(); await lightSeaSlugTorch(f.q);
    expect(f.calls).toEqual(['bailey torch', 'close dialogue', 'rub']);
    expect(f.pack.has(596)).toBe(false); expect(f.pack.has(594)).toBe(true);
});
test('prepared unlit or lit torch preserves the existing path without Bailey', async () => {
    const unlit = fixture(true); await lightSeaSlugTorch(unlit.q);
    expect(unlit.calls).toEqual(['rub']);
    const lit = fixture(); lit.pack.add(594); await lightSeaSlugTorch(lit.q);
    expect(lit.calls).toEqual([]);
});
test('unobserved Bailey receipt fails before rubbing', async () => {
    const f = fixture(); f.receive(false);
    await expect(lightSeaSlugTorch(f.q)).rejects.toThrow('Bailey torch not received');
    expect(f.attempts()).toBe(0);
});
test('stop and missing sticks prevent lighting actions', async () => {
    const f = fixture(); f.stop(); await expect(lightSeaSlugTorch(f.q)).rejects.toThrow('stopped');
    expect(f.calls).toEqual([]);
    const missing = fixture(true); missing.pack.delete(1468);
    await expect(lightSeaSlugTorch(missing.q)).rejects.toThrow('no dry sticks');
    expect(missing.attempts()).toBe(0);
});
test('lighting failure is bounded to six attempts; sixth success is accepted', async () => {
    const f = fixture(true); f.succeedsAt(7);
    await expect(lightSeaSlugTorch(f.q)).rejects.toThrow('torch not lit'); expect(f.attempts()).toBe(6);
    const sixth = fixture(true); sixth.succeedsAt(6); await lightSeaSlugTorch(sixth.q);
    expect(sixth.attempts()).toBe(6); expect(sixth.pack.has(594)).toBe(true);
});
test('Bailey approach matches the pinned NPC spawn', () => {
    const map = parseJm2('m43_51.jm2', readFileSync('vendor/rs-sdk/server/content/maps/m43_51.jm2', 'utf8'));
    expect(map.npcs.filter(n => n.id === 695).map(n => [n.x, n.z, n.level])).toEqual([[2763, 3276, 0]]);
    expect(readFileSync('vendor/rs-sdk/server/content/pack/npc.pack', 'utf8')).toContain('695=bailey');
});

import { takeSeaSlugPaste } from './generated/quest-seaslug';
import { PROFILES, planShopPurchases, maximumUnitCost } from './shop-buyer';
function pasteFixture() {
    let pack = 0, bank = 1, generation = 0, open = false, near = true, stop = false, receipt = true, fresh = true, accepts = true;
    const calls: string[] = [];
    const observation = () => ({ generation, items: [{ id: 1941, name: 'Swamp paste', count: bank }] });
    const q = {
        has: () => pack > 0, cnt: () => pack, near: () => near, lvl: () => 0,
        guard: async () => { if (stop) throw Error('stopped'); }, fail: async (message: string) => { throw Error(message); },
        st: () => ({ bank: { isOpen: open, items: bank > 0 ? [{ id: 1941, name: 'Swamp paste', count: bank }] : [] } }),
        waitUntil: async (observed: () => boolean) => observed(),
        s: { bankObservation: observation, bot: {
            openBank: async () => { calls.push('open'); open = true; if (fresh) generation++; return { success: true }; },
            withdrawItem: async (_item: unknown, amount: number, options: unknown) => {
                calls.push('withdraw'); expect(amount).toBe(1); expect(options).toEqual({ asNote: false });
                if (accepts) { pack++; if (receipt) { bank--; generation++; } }
                return { success: accepts };
            },
            closeBank: async () => { calls.push('close'); open = false; return { success: true }; },
        } },
    } as unknown as Parameters<typeof takeSeaSlugPaste>[0];
    return { q, calls, counts: () => [pack, bank], held: () => { pack = 1; },
        missing: () => { bank = 0; }, away: () => { near = false; }, stop: () => { stop = true; },
        stale: () => { fresh = false; }, noReceipt: () => { receipt = false; }, refuse: () => { accepts = false; } };
}
test('banked paste withdraws exactly one unnoted with fresh debit and credit receipt', async () => {
    const f = pasteFixture(); await takeSeaSlugPaste(f.q);
    expect(f.calls).toEqual(['open', 'withdraw', 'close']); expect(f.counts()).toEqual([1, 0]);
    const held = pasteFixture(); held.held(); await takeSeaSlugPaste(held.q); expect(held.calls).toEqual([]);
});
test('missing paste entry refuses unknown location, absent stock, stale bank and stop', async () => {
    for (const [mode, error] of [['away', 'start at Ardougne'], ['missing', 'owned bank paste missing'], ['stale', 'bank unobserved'], ['stop', 'stopped']] as const) {
        const f = pasteFixture(); f[mode](); await expect(takeSeaSlugPaste(f.q)).rejects.toThrow(error);
        expect(f.calls).not.toContain('withdraw');
    }
});
test('paste credit alone or refused withdrawal cannot claim a bank receipt', async () => {
    const f = pasteFixture(); f.noReceipt(); await expect(takeSeaSlugPaste(f.q)).rejects.toThrow('withdrawal unobserved');
    const refused = pasteFixture(); refused.refuse(); await expect(takeSeaSlugPaste(refused.q)).rejects.toThrow('withdrawal refused');
});
test('Khazard paste profile targets exact pinned shopkeeper and only one paste under finite budget', () => {
    const profile = PROFILES.khazard_paste!;
    expect(profile.npc.test('Shop keeper')).toBe(true); expect(profile.npc.test('Shopkeeper')).toBe(false);
    expect(profile.npcSpot).toEqual({ x: 2641, z: 3171 }); expect(profile.bankSpot).toEqual({ x: 2654, z: 3283 });
    expect(profile.items).toHaveLength(1); expect(profile.items[0]!.re.test('Swamp paste')).toBe(true);
    expect(planShopPurchases(profile.items, [{ name: 'Swamp paste', count: 500, buyPrice: 42 }], [], new Map(), 252, 1, 1)).toEqual([{ name: 'Swamp paste', amount: 1 }]);
    expect(maximumUnitCost({ baseCost: 30 }, { sellMultiplier: 1400 })).toBe(192);
    const map = parseJm2('m41_49.jm2', readFileSync('vendor/rs-sdk/server/content/maps/m41_49.jm2', 'utf8'));
    expect(map.npcs.some(n => n.id === 555 && n.x === 2641 && n.z === 3171 && n.level === 0)).toBe(true);
    const inv = readFileSync('vendor/rs-sdk/server/content/scripts/areas/area_ardougne_east/configs/port_khazard/port_khazard.inv', 'utf8');
    expect(inv).toContain('stock12=swamppaste,500,20');
    expect(readFileSync('vendor/rs-sdk/server/content/scripts/areas/area_ardougne_east/configs/port_khazard/port_khazard.npc', 'utf8')).toContain('param=shop_sell_multiplier,1400');
    expect(readFileSync('vendor/rs-sdk/server/content/scripts/skill_cooking/configs/cooking_generic/cooking.obj', 'utf8')).toContain('[swamppaste]\nname=Swamp paste\ndesc=A tar like substance mixed with flour and warmed.\ncost=30');
});
