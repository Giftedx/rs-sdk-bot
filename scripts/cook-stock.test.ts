import { expect, test } from 'bun:test';
import { selectRawStock, depositPlan } from './cook-stock';
const bank = [{ id: 335, name: 'Raw trout', count: 517 }, { id: 331, name: 'Raw salmon', count: 355 }];
test('raw selection retains50 each, enforces level, real slots and job cap', () => {
    expect(selectRawStock(bank, 99, 24)).toEqual([{ id: 331, name: 'Raw salmon', amount: 24 }]);
    expect(selectRawStock(bank, 15, 24)).toEqual([{ id: 335, name: 'Raw trout', amount: 24 }]);
    expect(selectRawStock(bank, 14, 24)).toEqual([]);
    expect(selectRawStock([{ id: 335, name: 'Raw trout', count: 55 }], 99, 28, 0)).toEqual([{ id: 335, name: 'Raw trout', amount: 5 }]);
    expect(selectRawStock(bank, 99, 24, 50, 3)[0]?.amount).toBe(3);
});
test('deposit dedup uses id, protects held food/tools/coins and banks actual new products', () => {
    const inventory = [{ id: 333, name: 'Trout', count: 1 }, { id: 333, name: 'Trout', count: 1 }, { id: 343, name: 'Burnt fish', count: 1 },
        { id: 343, name: 'Burnt fish', count: 1 }, { id: 946, name: 'Knife', count: 1 }, { id: 995, name: 'Coins', count: 500 }];
    const plan = depositPlan(inventory, new Map([[333, 1], [946, 1], [995, 500]]));
    expect(plan.map(i => [i.item.id, i.amount])).toEqual([[333, 1], [343, 2]]);
});
