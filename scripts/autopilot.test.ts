import { test, expect } from 'bun:test';
import { coinOrder, fundOrders, inOpenOrder } from './autopilot';

const order = (id: string, from: string, to: string, end: number) => ({ id, server: 'rs-sdk-demo.fly.dev', from, to, item: 'coins', count: 1500, start: 0, end });
const make = (from: string, to: string, coins: number) => ({ ...order(`o-${from}-${to}`, from, to, 9_999), count: coins });

test('an order is open until its window ends or both parties write a receipt', () => {
    const orders = [order('a', 'Big', 'Poor', 100), order('b', 'Rich', 'Low', 100), order('c', 'Old', 'Gone', 10)];
    const receipts = [{ id: 'b', role: 'from' }, { id: 'b', role: 'to' }] as any;
    expect([...inOpenOrder(orders, receipts, 50)].sort()).toEqual(['big', 'poor']);
});

test('a funded assignment becomes a coin order and a vacant account; an account in an open order waits', () => {
    const shop = { id: 'shop-feathers' } as any;
    const out = [
        { account: 'Poor', template: shop, value: 9, resources: ['shop:sarim'], reason: 'feather', fund: { from: 'Big', to: 'Poor', coins: 1500, template: 'shop-feathers' } },
        { account: 'Low', template: shop, value: 9, resources: ['shop:sarim'], reason: 'feather', fund: { from: 'Big', to: 'Low', coins: 1500, template: 'shop-feathers' } },
        { account: 'Farmer', template: { id: 'goldfarm@2652,3318' } as any, value: 5, resources: [], reason: 'coins' },
    ];
    const r = fundOrders(out, new Set(['low']), make);
    expect(r.orders.map(o => [o.from, o.to, o.count])).toEqual([['Big', 'Poor', 1500]]);
    expect(r.assignments.map(x => x.template?.id ?? x.reason)).toEqual([
        'vacant: awaits 1500 coins from Big for shop-feathers', 'vacant: awaits 1500 coins from Big for shop-feathers', 'goldfarm@2652,3318']);
    expect(r.log[1]).toContain('waits for an open order');
});

test('a party to an open order takes no normal job until the order closes', () => {
    const out = [
        { account: 'Big', template: { id: 'shop-runes' } as any, value: 9, resources: ['shop:aubury'], reason: 'rune' },
        { account: 'Poor', template: { id: 'goldfarm@2652,3318' } as any, value: 5, resources: [], reason: 'coins' },
        { account: 'Farmer', template: { id: 'goldfarm@2653,3300' } as any, value: 5, resources: [], reason: 'coins' },
    ];
    const r = fundOrders(out, new Set(['big', 'poor']), make);
    expect(r.orders).toEqual([]);
    expect(r.assignments.map(x => x.template?.id ?? x.reason)).toEqual(['vacant: in an open fleet order', 'vacant: in an open fleet order', 'goldfarm@2653,3300']);
});

test('a coin order opens in 15 minutes for 40 and fits the fleet order format', () => {
    const o = coinOrder('Pocketpython', 'YewFirst', 18_000, 'rs-sdk-demo.fly.dev', 1_000);
    expect(o).toEqual({ id: '901000-pocketpython-yewfirst', server: 'rs-sdk-demo.fly.dev', from: 'Pocketpython', to: 'YewFirst', item: 'coins', count: 18_000, start: 901_000, end: 3_301_000 });
    // The same checks as scripts/fleet-trade.ts validOrder.
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(o.id) && [o.from, o.to].every(n => /^[A-Za-z0-9]{1,12}$/.test(n)) && o.end > o.start).toBe(true);
});
