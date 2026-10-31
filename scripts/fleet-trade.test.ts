import { expect, test } from 'bun:test';
import { pickOrder, validOrder, type Order, type Receipt } from './fleet-trade';
import { makeOrder } from './fleet-order';
import { snapshot } from './fleet-sync';

const order = (o: Partial<Order>): Order => ({ id: 'o1', server: 's', from: 'Giver', to: 'Taker', item: 'Lobster', count: 500, start: 1000, end: 5000, ...o });

test('an order needs two different accounts, an item, a positive count and a window', () => {
    expect(validOrder(order({}))).toBe(true);
    expect(validOrder(order({ to: 'giver' }))).toBe(false);
    expect(validOrder(order({ count: 0 }))).toBe(false);
    expect(validOrder(order({ end: 1000 }))).toBe(false);
});

test('each side picks its own open order once, in or near its window', () => {
    const o = order({}), r: Receipt = { id: 'o1', account: 'Giver', role: 'from', side: 'local', ok: true, count: 500, at: 2000, detail: '' };
    expect(pickOrder([o], [], 'giver', 2000)).toEqual({ order: o, role: 'from' });
    expect(pickOrder([o], [], 'Taker', 2000)?.role).toBe('to');
    expect(pickOrder([o], [r], 'Giver', 2000)).toBeNull();
    expect(pickOrder([o], [r], 'Taker', 2000)?.role).toBe('to');
    expect(pickOrder([o], [], 'Giver', 6000)).toBeNull();
    expect(pickOrder([order({ start: 10 * 60_000 + 3000, end: 10 * 60_000 + 9000 })], [], 'Giver', 2000)).toBeNull();
    expect(pickOrder([o], [], 'Stranger', 2000)).toBeNull();
});

test('an order is only made between listed accounts on one server', () => {
    const owners = new Map([['giver', { side: 'local' as const, server: 's' }], ['taker', { side: 'cloud' as const, server: 's' }], ['far', { side: 'cloud' as const, server: 't' }]]);
    const o = makeOrder('Giver', 'Taker', 500, 'Lobster', 0, 15, 40, owners);
    expect(o).toMatchObject({ from: 'Giver', to: 'Taker', count: 500, item: 'Lobster', start: 900_000, end: 3_300_000, server: 's' });
    expect(() => makeOrder('Giver', 'Nobody', 1, 'Lobster', 0, 15, 40, owners)).toThrow();
    expect(() => makeOrder('Giver', 'Far', 1, 'Lobster', 0, 15, 40, owners)).toThrow();
});

test('a snapshot holds only this side’s accounts and no credentials', () => {
    const owners = new Map([['taker', { side: 'cloud' as const, server: 's' }]]);
    const snap = snapshot([{ name: 'Giver', server: 's', bank: [{ id: 379, name: 'Lobster', count: 9 }], password: 'x', skills: [{ name: 'Fishing', level: 99, xp: 1 }] }, { name: 'Taker', server: 's' }], 'local', owners, 7);
    expect(snap.accounts.map(a => a.name)).toEqual(['Giver']);
    expect(JSON.stringify(snap)).not.toContain('password');
    expect(snap.accounts[0]!.skills).toEqual([{ name: 'Fishing', level: 99 }]);
});
