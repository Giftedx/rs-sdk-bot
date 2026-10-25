import { expect, test } from 'bun:test';
import { planSoftClay, softenOne } from './soften-clay';
import type { Session } from '../packages/core/src/inprocess';
import type { NearbyLoc } from '../vendor/rs-sdk/sdk/types';
const fountain = { id: 879, x: 3190, z: 3468, level: 0 } as NearbyLoc;
function fixture(badDebit = false, missingBucket = false) {
    const inv = [{ id: 1265, count: 1, slot: 0 }, { id: 995, count: 200, slot: 1 },
        ...Array.from({ length: 20 }, (_, n) => ({ id: 434, count: 1, slot: n + 2 })),
        ...(missingBucket ? [] : [{ id: 1925, count: 1, slot: 22 }])];
    let fills = 0, uses = 0;
    const count = (id: number) => inv.filter(i => i.id === id).reduce((n,i) => n + i.count, 0);
    const s = { sdk: { getState: () => ({}), getInventory: () => inv,
        sendUseItemOnLoc: async (slot: number, x: number, z: number, id: number) => {
            expect([x,z,id]).toEqual([3190,3468,879]); const bucket = inv.find(i => i.slot === slot)!;
            expect(bucket.id).toBe(1925); bucket.id = 1929; fills++; return { success: true };
        },
        sendUseItemOnItem: async (claySlot: number, waterSlot: number) => {
            const clay = inv.find(i => i.slot === claySlot)!, water = inv.find(i => i.slot === waterSlot)!;
            expect([clay.id, water.id]).toEqual([434,1929]);
            if (!badDebit) inv.splice(inv.indexOf(clay), 1);
            water.id = 1925; inv.push({ id: 1761, count: 1, slot: 100 + uses++ }); return { success: true };
        }
    } } as unknown as Session;
    return { s, count, calls: () => [fills, uses] };
}
test('soft clay planning honors cap and leaves raw reserve', () => {
    expect(planSoftClay(50, 20, 10)).toBe(20); expect(planSoftClay(25, 20, 10)).toBe(15); expect(planSoftClay(5, 20, 10)).toBe(0);
});
test('20fresh slot conversions debit20raw and return the same bucket and kit', async () => {
    const f = fixture(); for (let n = 0; n < 20; n++) expect(await softenOne(f.s, fountain, () => false)).toBe(true);
    expect(f.count(434)).toBe(0); expect(f.count(1761)).toBe(20); expect(f.count(1925)).toBe(1); expect(f.count(1929)).toBe(0);
    expect(f.count(1265)).toBe(1); expect(f.count(995)).toBe(200); expect(f.calls()).toEqual([20,20]);
});
test('false output accounting is rejected instead of reporting20made', async () => {
    const f = fixture(true); await expect(softenOne(f.s, fountain, () => false)).rejects.toThrow('accounting mismatch');
});
test('missing owned bucket and bounded stop perform no actions', async () => {
    const f = fixture(false, true); expect(await softenOne(f.s, fountain, () => false)).toBe(false); expect(f.calls()).toEqual([0,0]);
    const ready = fixture(); expect(await softenOne(ready.s, fountain, () => true)).toBe(false); expect(ready.calls()).toEqual([0,0]);
});
