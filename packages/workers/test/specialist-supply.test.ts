import { expect, test } from 'bun:test';
import { countById, kitBaseTotal, resolveSupplierKitPlan } from '../src/logistics/specialist-supply';

test('the crafting-cw stage leg matches an offer of unnoted and noted opals by base total', () => {
    const kit = resolveSupplierKitPlan('crafting-cw').legs[0]!.kit;
    const offer = kit.map(k => ({ id: k.id, count: k.count }));
    expect(kit.filter(k => k.id === 1625 || k.id === 1626).map(k => k.count)).toEqual([15, 3]);
    expect(kit.every(k => countById(offer, k.id) === kitBaseTotal(kit, k.id))).toBe(true);
    expect(kitBaseTotal(kit, 1626)).toBe(18);
    const short = offer.map(i => i.id === 1626 ? { ...i, count: 2 } : i);
    expect(kit.every(k => countById(short, k.id) === kitBaseTotal(kit, k.id))).toBe(false);
});
