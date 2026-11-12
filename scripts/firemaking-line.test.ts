import { expect, test } from 'bun:test';
import { AHEAD_TICKS, BATCH, LOG_XP, assignBatches, batches, mayDrop, pace, planLine } from './firemaking-line';
import { LOGS, xpForLevel } from './firemaking-order';

const total = (plan: number[]) => plan.reduce((n, id) => n + LOG_XP[id]!, 0);

test('the mock-run stock plans logs to 15, oak to 75, then magic, and ends at 99', () => {
    const plan = planLine(0, 99, { [LOGS.normal.id]: 2, [LOGS.oak.id]: 130, [LOGS.magic.id]: 107 });
    expect(plan.slice(0, 2)).toEqual([LOGS.normal.id, LOGS.normal.id]);
    expect(plan[2]).toBe(LOGS.oak.id);
    const firstMagic = plan.indexOf(LOGS.magic.id);
    expect(total(plan.slice(0, firstMagic))).toBeGreaterThanOrEqual(xpForLevel(75));
    expect(total(plan.slice(0, firstMagic - 1))).toBeLessThan(xpForLevel(75));
    expect(total(plan)).toBeGreaterThanOrEqual(xpForLevel(99));
    expect(total(plan.slice(0, -1))).toBeLessThan(xpForLevel(99));
});

test('the planner line (27 logs, 4 oak, 7 willow, 13 maple, 25 yew, 107 magic) uses each tier at its level', () => {
    const stock = { [LOGS.normal.id]: 27, [LOGS.oak.id]: 4, [LOGS.willow.id]: 7, [LOGS.maple.id]: 13, [LOGS.yew.id]: 25, [LOGS.magic.id]: 107 };
    const plan = planLine(0, 99, stock);
    // A tier never comes before its level.
    let xp = 0;
    for (const id of plan) { const tier = Object.values(LOGS).find(t => t.id === id)!; expect(xp).toBeGreaterThanOrEqual(xpForLevel(tier.level)); xp += LOG_XP[id]!; }
    expect(xp).toBeGreaterThanOrEqual(xpForLevel(99));
});

test('a stock with no log the level burns gives an empty plan; a short stock ends early', () => {
    expect(planLine(0, 99, { [LOGS.oak.id]: 50 })).toEqual([]);
    const short = planLine(0, 99, { [LOGS.normal.id]: 3 });
    expect(short).toEqual([LOGS.normal.id, LOGS.normal.id, LOGS.normal.id]);
    expect(planLine(xpForLevel(99), 99, { [LOGS.magic.id]: 5 })).toEqual([]);
});

test('batches are consecutive runs of 28 with their counts; each log drops just in time', () => {
    const plan = [...Array(30).fill(LOGS.oak.id), ...Array(3).fill(LOGS.magic.id)];
    const b = batches(plan);
    expect(b.map(x => [x.from, x.ids.length])).toEqual([[0, BATCH], [BATCH, 5]]);
    expect(b[1]!.counts).toEqual({ [LOGS.oak.id]: 2, [LOGS.magic.id]: 3 });
    // A log is dropped when the runner reaches it within AHEAD_TICKS at its pace, and never before the batch ahead is down.
    expect(AHEAD_TICKS).toBe(220);
    expect(mayDrop(55, 0, 4, true)).toBe(true);
    expect(mayDrop(56, 0, 4, true)).toBe(false);
    expect(mayDrop(27, 0, 8, true)).toBe(true);
    expect(mayDrop(28, 0, 8, true)).toBe(false);
    expect(mayDrop(10, 0, 4, false)).toBe(false);
    expect(pace([])).toBe(8);
    expect(pace([100, 104, 108, 120])).toBe(20 / 3);
});

test('each batch goes to a helper whose bank holds it, in turn where both do', () => {
    const work = batches([...Array(28).fill(1521), ...Array(28).fill(1521), ...Array(10).fill(1513)]);
    expect(assignBatches(work, [{ 1521: 56 }, { 1521: 28, 1513: 10 }])).toEqual([0, 1, 1]);
    expect(assignBatches(work, [{ 1521: 60, 1513: 10 }])).toEqual([0, 0, 0]);
    expect(assignBatches(work, [{ 1521: 30 }, { 1521: 20 }])).toBeUndefined();
});
