import { expect, test } from 'bun:test';
import { xpForLevel } from '../packages/planner/src/curve';
import { alchCasts, alchStagePlan, castsHeld, strikeCasts, FIRE, NATURE, STRIKE } from './alch-train';

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
    const r = { ok: false, stop: 'failure', failure: 'alch: level-up dialog stayed open', level: 60, gained: 10, magicXp: 35075, casts: { 'low-alch': 18, 'high-alch': 13, strike: 0 }, ticks: 257 };
    expect(alchResultLine(r)).toBe('alch level=60 gained=10 xp=35075 strike=0 low=18 high=13 stop=failure ticks=257 failure=alch: level-up dialog stayed open');
    expect(progressed(`RESULT fail ${alchResultLine(r)}`)).toBe(true);
    expect(progressed(`RESULT fail ${alchResultLine({ ...r, gained: 0, magicXp: 0 })}`)).toBe(false);
});

test('a run that could not pay for one cast ends as no progress, which the supervisor stops instead of retrying', async () => {
    const { alchResultLine } = await import('./alch-train');
    const { isNoProgressFailure } = await import('../packages/practice/src/supervise');
    const dry = { ok: false, stop: 'supplies', failure: 'no alch progress: the bank holds no supplies for one cast', level: 75, gained: 0, magicXp: 0, casts: { 'low-alch': 0, 'high-alch': 0, strike: 0 }, ticks: 5 };
    expect(isNoProgressFailure(`RESULT fail ${alchResultLine(dry)}`)).toBe(true);
    const spent = { ...dry, ok: true, failure: '', gained: 14, magicXp: 120250, casts: { 'low-alch': 0, 'high-alch': 74, strike: 0 } };
    expect(isNoProgressFailure(`RESULT ok ${alchResultLine(spent)}`)).toBe(false);
});

test('below Magic 21 the stage adds mind and air runes for the Wind Strike start', () => {
    expect(strikeCasts(0, 99)).toBe(Math.ceil(xpForLevel(21) / 137));
    expect(strikeCasts(0, 10)).toBe(Math.ceil(xpForLevel(10) / 137));
    expect(strikeCasts(xpForLevel(21), 99)).toBe(0);
    expect(alchCasts(0, 21)).toEqual({ low: 0, high: 0 });
    const n = strikeCasts(0, 99);
    const plan = alchStagePlan({ low: 2, high: 3, strike: n }, [], [{ id: STRIKE.mind, count: 500 }, { id: STRIKE.air, count: 20 }, { id: NATURE, count: 9 }, { id: FEATHER, count: 9 }, { id: FIRE, count: 99 }], FEATHER);
    expect(plan.take).toEqual([{ id: STRIKE.mind, count: n + STRIKE.spare }, { id: STRIKE.air, count: 20 }, { id: NATURE, count: 5 }, { id: FEATHER, count: 5 }, { id: FIRE, count: 21 }]);
    expect(alchStagePlan({ low: 2, high: 3, strike: 0 }, [], [{ id: STRIKE.mind, count: 500 }, { id: NATURE, count: 9 }, { id: FEATHER, count: 9 }, { id: FIRE, count: 99 }], FEATHER).take.some(t => t.id === STRIKE.mind)).toBe(false);
});
