import { expect, spyOn, test } from 'bun:test';
import * as walking from '../packages/core/src/walk';
import { runEdgevilleWoodcut, selectEdgevilleWoodcutAxe } from './edgeville-woodcut-order';

test('selectEdgevilleWoodcutAxe picks highest owned rev-289 axe and carries vs wields by Attack', () => {
    const bank = [{ id: 1351, count: 1 }, { id: 1353, count: 1 }, { id: 1359, count: 1 }];
    const low = selectEdgevilleWoodcutAxe(bank, { Woodcutting: 15, Attack: 1 });
    expect(low.current?.item.id).toBe(1359);
    expect(low.current?.canWield).toBe(false);

    const high = selectEdgevilleWoodcutAxe(bank, { Woodcutting: 15, Attack: 40 });
    expect(high.current?.item.id).toBe(1359);
    expect(high.current?.canWield).toBe(true);
});

for (const attack of [1, 40]) {
    test(`runEdgevilleWoodcut upgrades to Rune axe (Attack ${attack}) and reconciles container totals at bank`, async () => {
        let tick = 0, bankOpen = false, gen = 1, wcLevel = 15, wcXp = 2500;
        const listeners = new Set<() => void>();
        const timer = setInterval(() => { tick++; for (const fn of [...listeners]) fn(); }, 1);
        const inv: any[] = [];
        const eq: any[] = [];
        const bank: any[] = [
            { id: 1359, name: 'Rune axe', count: 1, slot: 0 },
            { id: 1351, name: 'Bronze axe', count: 1, slot: 1 },
            { id: 1521, name: 'Oak logs', count: 5, slot: 2 },
        ];
        const oakTree = { id: 1281, name: 'Oak', x: 3126, z: 3437, distance: 1, optionsWithIndex: [{ text: 'Chop down', opIndex: 1 }] };
        const state: any = {
            player: { worldX: 3094, worldZ: 3492, level: 0, hp: 10, isDead: false },
            bank: { isOpen: false, items: bank },
            inventory: inv,
            equipment: eq,
            nearbyLocs: [oakTree],
        };

        const s: any = {
            tick: () => tick,
            onTick: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
            bankObservation: () => bankOpen ? { generation: gen, items: bank } : null,
            sdk: {
                getState: () => ({ ...state, inventory: inv, equipment: eq, bank: { isOpen: bankOpen, items: bank } }),
                getInventory: () => inv,
                getEquipment: () => eq,
                getBankItems: () => bank,
                getSkill: (n: string) => ({ level: n === 'Woodcutting' ? wcLevel : n === 'Attack' ? attack : 10, baseLevel: n === 'Woodcutting' ? wcLevel : n === 'Attack' ? attack : 10 }),
                getSkillXp: () => wcXp,
            },
            bot: {
                dismissBlockingUI: async () => undefined,
                openBank: async () => { bankOpen = true; state.bank.isOpen = true; gen++; return { success: true }; },
                closeBank: async () => { bankOpen = false; state.bank.isOpen = false; return { success: true }; },
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
                    state.bank.isOpen = false;
                    const idx = inv.findIndex(r => r.id === item.id);
                    const [removed] = inv.splice(idx, 1);
                    eq.push({ ...removed, slot: 3 });
                    return { success: true };
                },
                unequipItem: async (item: any) => {
                    bankOpen = false;
                    state.bank.isOpen = false;
                    const idx = eq.findIndex(r => r.id === item.id);
                    const [removed] = eq.splice(idx, 1);
                    inv.push({ id: removed.id, name: removed.name, count: removed.count });
                    return { success: true };
                },
                interactLoc: async () => {
                    const logRow = inv.find(i => i.id === 1521);
                    if (logRow) logRow.count++;
                    else inv.push({ id: 1521, name: 'Oak logs', count: 1 });
                    wcXp += 1000;
                    wcLevel = 36;
                    return { success: true };
                },
            },
        };

        const spies = [
            spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
            spyOn(walking, 'walkPath').mockImplementation(async (_w, points) => {
                const last = points.at(-1)!;
                state.player.worldX = last.x;
                state.player.worldZ = last.z;
                return { ok: true, ticks: 1 } as any;
            }),
        ];
        try {
            const res = await runEdgevilleWoodcut(s, () => false);
            expect(res.ok).toBe(true);
            expect(res.level).toBe(36);
            expect(res.banked).toBe(1);
            expect(inv).toHaveLength(0);
            expect(eq).toHaveLength(0);
            expect(bank.find(i => i.id === 1359)?.count).toBe(1);
            expect(bank.find(i => i.id === 1351)?.count).toBe(1);
            expect(bank.find(i => i.id === 1521)?.count).toBe(6);
        } finally {
            for (const spy of spies) spy.mockRestore();
            clearInterval(timer);
        }
    });
}
