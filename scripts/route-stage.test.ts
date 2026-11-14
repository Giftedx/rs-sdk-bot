import { expect, test } from 'bun:test';
import { groupOrders, heldBack, heldCount, orderInWay, parseLine, planStage } from './route-stage';

test('free holders give first, then the largest busy stock; the held count is not ordered', () => {
    const holders = (item: string) => item === 'magic logs'
        ? [{ name: 'OreElse', count: 107, busy: true }, { name: 'Bigchopper', count: 20, busy: false }] : [];
    const plan = planStage([{ item: 'magic logs', count: 110 }], () => 3, holders, true);
    expect(plan.held).toEqual([{ item: 'magic logs', count: 3 }]);
    expect(plan.orders).toEqual([
        { from: 'Bigchopper', item: 'magic logs', count: 20, busy: false },
        { from: 'OreElse', item: 'magic logs', count: 87, busy: true },
    ]);
    expect(plan.short).toEqual([]);
});

test('without --allow-busy a busy holder gives nothing and the rest is short', () => {
    const plan = planStage([{ item: 'magic logs', count: 107 }], () => 0, () => [{ name: 'OreElse', count: 107, busy: true }], false);
    expect(plan.orders).toEqual([]);
    expect(plan.short).toEqual([{ item: 'magic logs', count: 107, blocked: [] }]);
});

test('a holder in a job that the autopilot does not own never gives, and the short line names it', () => {
    const holders = () => [{ name: 'Woodpecker', count: 50, busy: true, blocked: true }, { name: 'OreElse', count: 20, busy: true }];
    const plan = planStage([{ item: 'logs', count: 30 }], () => 0, holders, true);
    expect(plan.orders).toEqual([{ from: 'OreElse', item: 'logs', count: 20, busy: true }]);
    expect(plan.short).toEqual([{ item: 'logs', count: 10, blocked: ['Woodpecker'] }]);
});

test('item lines and snapshot counts', () => {
    expect(parseLine('130 oak logs')).toEqual({ count: 130, item: 'oak logs' });
    expect(() => parseLine('oak logs')).toThrow('<count> <item>');
    expect(() => parseLine('0 knife')).toThrow();
    expect(heldCount({ bank: [{ name: 'Oak logs', count: 5 }], inventory: [{ name: 'Oak logs', count: 2 }, { name: 'Logs', count: 9 }] }, 'oak logs')).toBe(7);
    expect(heldCount(undefined, 'knife')).toBe(0);
});

test('an account in a trade or with an order its agent would pick is held; a reconcile order days old is not', () => {
    const order = (id: string, from: string, to: string, start: number, end: number) => ({ id, server: 'rs-sdk-demo.fly.dev', from, to, item: 'logs', count: 1, start, end });
    const now = 10_000_000;
    const orders = [order('old', 'Bigchopper', 'UnderMyKilt', 1, 2), order('open', 'OreElse', 'Balls', now - 1000, now + 600_000), order('soon', 'Shaftmaker', 'Balls', now + 60_000, now + 900_000)];
    expect(orderInWay(orders, [], 'Bigchopper', now)).toBeUndefined();
    expect(orderInWay(orders, [], 'Balls', now)).toBe('open');
    // Balls is in the open trade: pickOrder skips the order that has its receipt, so the prepared receipt holds it.
    const trading = [{ id: 'open', role: 'to', account: 'Balls', state: 'prepared' }];
    expect(orderInWay(orders, trading, 'Balls', now)).toBe('open');
    // Inside the agent's 10-minute lead an order that starts later still holds its giver.
    expect(orderInWay(orders, [], 'Shaftmaker', now)).toBe('soon');
    const settled = [{ id: 'open', role: 'to', account: 'Balls', state: 'settled' }, { id: 'soon', role: 'to', account: 'Balls', state: 'settled' }];
    expect(orderInWay(orders, settled, 'Balls', now)).toBeUndefined();
});

test('a held trade claim of another order holds the account', () => {
    const claims = [{ account: 'mmsmk1232', orderId: '1794503734080-nabtheknob-mmsmk1232-bones' }];
    expect(orderInWay([], [], 'mmsmk1232', 1, claims)).toBe('1794503734080-nabtheknob-mmsmk1232-bones');
    expect(orderInWay([], [], 'MMSMK1232', 1, claims)).toBe('1794503734080-nabtheknob-mmsmk1232-bones');
    expect(orderInWay([], [], 'Shaftmaker', 1, claims)).toBeUndefined();
});

test('an owner stop file, a reservation or a hand job holds an account back from giving', () => {
    const jobs = [
        { account: 'Mightyrod', script: '', enabled: false },
        { account: 'WeeQuickie', script: 'scripts/firemaking-order.ts', enabled: false },
        { account: 'OreElse', script: 'scripts/goldfarm.ts', enabled: true, autopilot: 'local' },
        { account: 'Shaftmaker', script: 'scripts/shop-buyer.ts', enabled: false, autopilot: 'local' },
    ];
    expect(heldBack('Mightyrod', jobs, undefined)).toBe('reserved (a job with no script)');
    expect(heldBack('WeeQuickie', jobs, undefined)).toBe('hand job (disabled, not an autopilot job)');
    expect(heldBack('OreElse', jobs, undefined)).toBeUndefined();
    expect(heldBack('Shaftmaker', jobs, undefined)).toBeUndefined();
    expect(heldBack('Bigchopper', jobs, 'session: owner pause for a dagger gang pilot\n')).toBe('owner stop file');
    expect(heldBack('Bigchopper', jobs, 'swarm')).toBeUndefined();
    expect(heldBack('Bigchopper', jobs, undefined)).toBeUndefined();
});

test('each giver gets one order with all its lines, split at one trade window', () => {
    const groups = groupOrders([
        { from: 'Abracadickra', item: 'Sapphire ring', count: 40, busy: false },
        { from: 'Balls', item: 'Fire rune', count: 80, busy: true },
        { from: 'abracadickra', item: 'Cosmic rune', count: 74, busy: false },
    ]);
    expect(groups).toEqual([
        { from: 'Abracadickra', lines: [{ item: 'Sapphire ring', count: 40 }, { item: 'Cosmic rune', count: 74 }], busy: false },
        { from: 'Balls', lines: [{ item: 'Fire rune', count: 80 }], busy: true },
    ]);
    const many = groupOrders(Array.from({ length: 30 }, (_, i) => ({ from: 'Balls', item: `Item ${i}`, count: 1, busy: false })));
    expect(many.map(g => g.lines.length)).toEqual([28, 2]);
});
