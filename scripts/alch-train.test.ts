import { expect, test } from 'bun:test';
import { xpForLevel } from '../packages/planner/src/curve';
import { alchCasts, alchStagePlan, castsHeld, FIRE, NATURE } from './alch-train';

const FEATHER = 314, STAFF = 1387;

test('Low Alchemy to 55, then High Alchemy to the target', () => {
    const at50 = xpForLevel(50), gate = xpForLevel(55), top = xpForLevel(99);
    expect(alchCasts(at50, 99)).toEqual({ low: Math.ceil((gate - at50) / 775), high: Math.ceil((top - gate) / 1625) });
    expect(alchCasts(xpForLevel(62), 99)).toEqual({ low: 0, high: Math.ceil((top - xpForLevel(62)) / 1625) });
    expect(alchCasts(at50, 53)).toEqual({ low: Math.ceil((xpForLevel(53) - at50) / 775), high: 0 });
    expect(alchCasts(top, 99)).toEqual({ low: 0, high: 0 });
});

test('the stage takes runes and the item for every cast, capped by the bank', () => {
    const plan = alchStagePlan({ low: 10, high: 100 }, [{ id: NATURE, count: 20 }], [{ id: NATURE, count: 50 }, { id: FIRE, count: 10000 }, { id: FEATHER, count: 15000 }], FEATHER);
    expect(plan.staff).toBeUndefined();
    expect(plan.take).toEqual([{ id: NATURE, count: 50 }, { id: FEATHER, count: 110 }, { id: FIRE, count: 530 }]);
});

test('a fire staff in the bank replaces the fire runes and is taken once', () => {
    const plan = alchStagePlan({ low: 0, high: 5 }, [], [{ id: STAFF, count: 1 }, { id: NATURE, count: 9 }, { id: FIRE, count: 99 }, { id: FEATHER, count: 9 }], FEATHER);
    expect(plan.staff).toBe(STAFF);
    expect(plan.take).toEqual([{ id: STAFF, count: 1 }, { id: NATURE, count: 5 }, { id: FEATHER, count: 5 }]);
    expect(alchStagePlan({ low: 0, high: 5 }, [{ id: STAFF, count: 1 }], [{ id: NATURE, count: 9 }, { id: FEATHER, count: 9 }], FEATHER).take)
        .toEqual([{ id: NATURE, count: 5 }, { id: FEATHER, count: 5 }]);
});

test('held casts are the scarcest of natures, items and fire runes', () => {
    const held = [{ id: NATURE, count: 40 }, { id: FEATHER, count: 100 }, { id: FIRE, count: 100 }];
    expect(castsHeld('high-alch', held, FEATHER, false)).toBe(20);
    expect(castsHeld('low-alch', held, FEATHER, false)).toBe(33);
    expect(castsHeld('high-alch', held, FEATHER, true)).toBe(40);
});

test('the RESULT line carries progress fields the planner reads', async () => {
    const { alchResultLine } = await import('./alch-train');
    const { progressed } = await import('../packages/planner/src/autopilot');
    const r = { ok: false, stop: 'failure', failure: 'alch: level-up dialog stayed open', level: 60, gained: 10, magicXp: 35075, casts: { 'low-alch': 18, 'high-alch': 13 }, ticks: 257 };
    expect(alchResultLine(r)).toBe('alch level=60 gained=10 xp=35075 low=18 high=13 stop=failure ticks=257 failure=alch: level-up dialog stayed open');
    expect(progressed(`RESULT fail ${alchResultLine(r)}`)).toBe(true);
    expect(progressed(`RESULT fail ${alchResultLine({ ...r, gained: 0, magicXp: 0 })}`)).toBe(false);
});
