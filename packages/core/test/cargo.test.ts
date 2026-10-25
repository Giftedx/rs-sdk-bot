import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bankCargo, validCargoRequest, exactItem, courierWaiting } from '../src/cargo';
import type { Session } from '../src/inprocess';

const owned = new Set(['courier']);
test('requests reject wrong worker, stranger, future, missing and expired timestamps', () => {
    const req = { worker: 'worker', courier: 'Courier', at: 1000, ready: true };
    expect(validCargoRequest(req, 'Worker', owned, 1100)).toBe(true);
    for (const changed of [{ worker: 'other' }, { courier: 'stranger' }, { at: 1200 }, { at: null }, { at: 1000 - 180000 }]) {
        expect(validCargoRequest({ ...req, ...changed }, 'worker', owned, 1100)).toBe(false);
    }
    expect(exactItem('Tool (noted)+').test('Tool (noted)+')).toBe(true);
    expect(exactItem('Tool (noted)+').test('Tool noted')).toBe(false);
});

for (const outcome of ['success', 'declined', 'throw', 'partial'] as const) {
    test(`bank-to-courier fake integration: ${outcome} preserves stock, coins and held tool`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cargo-test-'));
        const bank = [{ id: 1, name: 'Flax', count: 50 }, { id: 2, name: 'Iron axe', count: 2 }];
        const inventory = [{ id: 3, name: 'Coins', count: 1234 }, { id: 2, name: 'Iron axe', count: 1 }];
        let bankOpen = true, trades = 0;
        const state = () => ({ bank: { isOpen: bankOpen, items: bank }, player: { worldX: 2654, worldZ: 3283, level: 0 }, nearbyPlayers: [{ name: 'Courier', distance: 2 }] });
        const s = {
            name: 'worker', sdk: { getState: state, getInventory: () => inventory },
            bot: {
                withdrawItem: async (re: RegExp, amount: number) => {
                    const item = bank.find(i => re.test(i.name))!;
                    const n = outcome === 'partial' ? 7 : amount;
                    item.count -= n;
                    inventory.push({ id: 100 + item.id, name: item.name, count: n });
                    return { success: n === amount, amountWithdrawn: n };
                },
                closeBank: async () => { bankOpen = false; },
                openBank: async () => { bankOpen = true; return { success: true }; },
                serveTrades: async ({ give }: any) => {
                    trades++;
                    expect(give).toHaveLength(1);
                    const flax = inventory.find(i => i.name === 'Flax')!;
                    expect(give[0].amount).toBe(flax.count);
                    if (outcome === 'throw') throw new Error('simulated trade failure');
                    if (outcome === 'declined') return { trades: [] };
                    const gave = [{ ...flax }];
                    inventory.splice(inventory.indexOf(flax), 1);
                    return { trades: [{ success: true, gave }] };
                },
                depositItem: async (re: RegExp, amount: number) => {
                    const i = inventory.findIndex(i => re.test(i.name));
                    bank.find(i => re.test(i.name))!.count += amount;
                    inventory[i]!.count -= amount;
                    if (!inventory[i]!.count) inventory.splice(i, 1);
                    return { success: true };
                },
            },
        } as unknown as Session;
        try {
            writeFileSync(join(dir, 'request-worker.json'), JSON.stringify({ worker: 'worker', courier: 'Courier', at: Date.now(), ready: true }));
            expect(courierWaiting('worker', { dir, owned })).toBe(true);
            const run = bankCargo(s, [/flax|axe|coins/i], 0, { dir, owned });
            if (outcome === 'throw') await expect(run).rejects.toThrow('simulated trade failure');
            else await run;
            expect(trades).toBe(1);
            expect(courierWaiting('worker', { dir, owned })).toBe(false);
            await bankCargo(s, [/flax|axe|coins/i], 0, { dir, owned });
            expect(trades).toBe(1); // No repeat attempt for the same ready request.
            expect(inventory).toEqual([{ id: 3, name: 'Coins', count: 1234 }, { id: 2, name: 'Iron axe', count: 1 }]);
            const manifest = JSON.parse(readFileSync(join(dir, 'worker.json'), 'utf8'));
            expect(manifest.items.find((i: any) => i.name === 'Flax')?.count ?? 0).toBe(outcome === 'partial' ? 43 : outcome === 'success' ? 0 : 50);
            expect(manifest.items.find((i: any) => i.name === 'Coins')).toBeUndefined();
            expect(bankOpen).toBe(true);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
}
