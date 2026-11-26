import { expect, test } from 'bun:test';
import { alchCasts, alchStagePlan, castsHeld, strikeCasts, FIRE, NATURE, STRIKE, xpForLevel } from '../src/bank-artisan';

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

test('the RESULT line carries progress fields', async () => {
    const { alchResultLine } = await import('../src/bank-artisan');
    const r = { ok: false, stop: 'failure', failure: 'alch: level-up dialog stayed open', level: 60, gained: 10, magicXp: 35075, casts: { 'low-alch': 18, 'high-alch': 13, strike: 0 }, ticks: 257 };
    expect(alchResultLine(r)).toBe('alch level=60 gained=10 xp=35075 strike=0 low=18 high=13 stop=failure ticks=257 failure=alch: level-up dialog stayed open');
});

test('a run that could not pay for one cast ends as no progress, which the supervisor stops instead of retrying', async () => {
    const { alchResultLine } = await import('../src/bank-artisan');
    const { isNoProgressFailure } = await import('../../practice/src/supervise');
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

test('an account past the Wind Strike phase stages at its nearest bank; a stop on the stage walk is a stop, not a failure', async () => {
    // Live: "START 3185 3436 0" (Varrock West bank), 319 move ticks to Ardougne, then ALCH_RESULT {"stop":"failure","failure":"alch stage: stop requested"}.
    const { alchStageBank, runAlch, stageAlch } = await import('../src/bank-artisan/magic');
    const varrockWest = { worldX: 3185, worldZ: 3436, level: 0 };
    expect(alchStageBank(varrockWest, xpForLevel(31), 55)).toMatchObject({ x: 3185, z: 3440 });
    expect(alchStageBank(varrockWest, xpForLevel(5), 55)).toMatchObject({ x: 2619, z: 3332 });
    const session = (stopAfterWalk: boolean) => {
        let stopped = false;
        const asked: number[][] = [];
        const s: any = {
            name: 'alch-far', tick: () => 0, onTick: () => () => {}, ended: new Promise(() => {}),
            sdk: { getState: () => ({ player: varrockWest, equipment: [], bank: { isOpen: false, items: [] } }), getInventory: () => [], getSkillXp: () => xpForLevel(31), getSkill: () => ({ level: 31, baseLevel: 31 }) },
            bot: { openBank: async () => { throw Error('bank opened before the stage walk'); } },
        };
        const walk = async (x: number, z: number) => { asked.push([x, z]); if (stopAfterWalk) stopped = true; return false; };
        return { s, asked, walk, stop: () => stopped };
    };
    const failed = session(false);
    await expect(stageAlch(failed.s, { target: 55, item: FEATHER, walk: failed.walk, stop: failed.stop })).rejects.toThrow('alch stage: walk to the 3185,3440 bank failed');
    expect(failed.asked).toEqual([[3185, 3440]]);
    const halted = session(true);
    const r = await runAlch(halted.s, { target: 55, cap: 1000, item: 'feather', walk: halted.walk, stop: halted.stop });
    expect(r.stop).toBe('stopped');
    expect(r.failure).toBe('');
});
