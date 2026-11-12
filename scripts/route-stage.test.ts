import { expect, test } from 'bun:test';
import { heldCount, parseLine, planStage } from './route-stage';

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
    expect(plan.short).toEqual([{ item: 'magic logs', count: 107 }]);
});

test('item lines and snapshot counts', () => {
    expect(parseLine('130 oak logs')).toEqual({ count: 130, item: 'oak logs' });
    expect(() => parseLine('oak logs')).toThrow('<count> <item>');
    expect(() => parseLine('0 knife')).toThrow();
    expect(heldCount({ bank: [{ name: 'Oak logs', count: 5 }], inventory: [{ name: 'Oak logs', count: 2 }, { name: 'Logs', count: 9 }] }, 'oak logs')).toBe(7);
    expect(heldCount(undefined, 'knife')).toBe(0);
});
