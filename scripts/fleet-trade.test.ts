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
    const owners = new Map([['taker', { side: 'cloud' as const, server: 's' }], ['giver', { side: 'local' as const, server: 's' }]]);
    const snap = snapshot([{ name: 'Practicebot', server: 'localhost:8888' }, { name: 'Giver', server: 's', bank: [{ id: 379, name: 'Lobster', count: 9 }], password: 'x', skills: [{ name: 'Fishing', level: 99, xp: 1 }] }, { name: 'Taker', server: 's' }], 'local', owners, 7);
    expect(snap.accounts.map(a => a.name)).toEqual(['Giver']);
    expect(JSON.stringify(snap)).not.toContain('password');
    expect(snap.accounts[0]!.skills).toEqual([{ name: 'Fishing', level: 99 }]);
});

test('a snapshot lists completed quests and leaves an unread journal unknown', () => {
    const owners = new Map(['read', 'none', 'unread', 'blank'].map(n => [n, { side: 'local' as const, server: 's' }]));
    const accounts = snapshot([
        { name: 'Read', server: 's', quests: [{ name: 'Cook', state: 'complete' }, { name: 'Imp', state: 'started' }] },
        { name: 'None', server: 's', quests: [{ name: 'Imp', state: 'not started' }] },
        { name: 'Unread', server: 's', quests: null },
        { name: 'Blank', server: 's', quests: [{ name: 'Imp', state: 'unknown' }] },
    ], 'local', owners, 7).accounts;
    expect(accounts.map(a => (a as { quests?: string[] }).quests)).toEqual([['Cook'], [], undefined, undefined]);
    expect(accounts.filter(a => 'quests' in a).map(a => a.name)).toEqual(['Read', 'None']);
});

test('the agent acts only for its own side, skips busy and running accounts, and frees the rest', async () => {
    const { dueTrades, swarmBusy } = await import('./fleet-agent');
    const owners = new Map([['giver', { side: 'local' as const, server: 's' }], ['taker', { side: 'cloud' as const, server: 's' }], ['busyone', { side: 'local' as const, server: 's' }]]);
    const orders = [order({}), order({ id: 'o2', from: 'BusyOne', to: 'Taker' })];
    const busy = swarmBusy([{ account: 'BusyOne', enabled: true }, { accounts: ['Other'], enabled: true }, { account: 'Giver', enabled: false }]);
    expect([...busy].sort()).toEqual(['busyone', 'other']);
    const due = dueTrades(orders, [], 'local', owners, busy, new Set(), 2000);
    expect(due.map(d => [d.account, d.order.id, d.busy])).toEqual([['Giver', 'o1', false], ['BusyOne', 'o2', true]]);
    expect(dueTrades(orders, [], 'local', owners, busy, new Set(['giver']), 2000).map(d => d.account)).toEqual(['BusyOne']);
    expect(dueTrades(orders, [], 'cloud', owners, busy, new Set(), 2000).map(d => d.account)).toEqual(['Taker']);
});
