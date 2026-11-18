import { expect, test } from 'bun:test';
import { driftChecks, squadDrift, squadRuns } from './pk-gang-drift';
import { benchMeetings, fidelityRows, liveMeeting, type Meeting } from './pk-gang-fidelity';

// A data file of a gang account with the fields that the drift check reads.
const file = (more: { four: number; other: number; specials: number; attacks: number; maxHit: number; eat: Record<string, number>; hit: number; miss: number; post: number; worn?: Record<string, number>; prayer?: string }) => ({
    levels: { skills: { value: { Attack: '99', Prayer: more.prayer ?? '90' } } }, kit: { worn: { value: more.worn ?? { 'hat,dagger': 100 } } },
    attack: { ticksBetweenAttacks: { value: { 4: more.four, 5: more.other } }, specials: { value: { attacks: more.attacks, specials: more.specials } }, damage: { value: { 'attack on a player without Protect from Melee': { [more.maxHit]: 1, 3: 40 }, 'special on a player without Protect from Melee': { 22: 1 } } } },
    eating: { hpAtEat: { value: more.eat, n: Object.values(more.eat).reduce((a, b) => a + b, 0) } },
    prayer: { ticksFromWeaponChangeToPrayer: { value: { whenTheOpponentFacesIt: { 1: more.hit }, noChangeIn8Ticks: { whenTheOpponentFacesIt: more.miss } } } },
    retreat: { prayedAgainst: { value: { 'ranged: bow': { attackAnimations: 50, withTheProtectPrayerForItOn: 10 } } }, at40HpOrLess: { status: 'unknown' } },
    movement: { place: { value: { post: more.post }, n: 1000 }, steps: { value: { run: 980, walk: 20 }, n: 1000 } }, targets: { frozen: { status: 'unknown' } }, death: { status: 'unknown' },
});
const RECORD = file({ four: 900, other: 100, specials: 130, attacks: 1000, maxHit: 20, eat: { 74: 3, 60: 5 }, hit: 58, miss: 18, post: 65 });

test('the same behaviour gives no drift', () => {
    expect(driftChecks(RECORD, file({ four: 180, other: 20, specials: 30, attacks: 200, maxHit: 19, eat: { 73: 4, 66: 3 }, hit: 30, miss: 10, post: 60 })).filter(c => c.drift)).toEqual([]);
});

test('a higher hit, a new worn item, a new level, a higher eat level and a prayer that changes less often each drift', () => {
    const now = file({ four: 180, other: 20, specials: 30, attacks: 200, maxHit: 25, eat: { 85: 4, 80: 3 }, hit: 5, miss: 35, post: 60, worn: { 'hat,dagger': 50, 'hat,dagger,rune_platebody': 9 }, prayer: '95' });
    const drift = driftChecks(RECORD, now).filter(c => c.drift).map(c => c.measure);
    expect(drift).toEqual(['worn sets not in the record', 'combat levels that changed', 'highest attack splat with no Protect from Melee', 'highest Hitpoints at an eat', 'weapon changes with a prayer change in 100']);
});

test('a share with few samples does not drift', () => {
    const few = driftChecks(RECORD, file({ four: 2, other: 8, specials: 0, attacks: 10, maxHit: 10, eat: {}, hit: 0, miss: 3, post: 60 }));
    expect(few.filter(c => c.drift)).toEqual([]);
    expect(few.find(c => c.measure === '4-tick attack intervals in 100')!.why).toBe('under 20 samples');
});

test('a live squad run drifts when its cost a kill is more than the tolerance away from the clone prediction', () => {
    const bench = [{ kills: 3, hpLost: 300 }, { kills: 3, hpLost: 360 }, { kills: 2, hpLost: 240 }];
    expect(squadDrift({ kills: 4, hpLost: 480 }, bench).map(c => c.drift)).toEqual([false]);
    expect(squadDrift({ kills: 4, hpLost: 1000 }, bench).map(c => c.drift)).toEqual([true]);
    // Two bench runs are too few to name a drift.
    expect(squadDrift({ kills: 4, hpLost: 1000 }, bench.slice(0, 2))[0]).toMatchObject({ drift: false, why: 'under 3 bench runs' });
});

test('the bench runs of the squad check come from the RESULT lines that scripts/pk-squad.ts prints', () => {
    // Three case logs as a hosted run keeps them: a pass, a fail with its kills, and a log with no squad RESULT.
    const logs = ['START 3093 3501 0\n[a] SQUAD march to 3067,3640 in 13 steps\nRESULT ok squad accounts=5 kills=3 gangDied=3 died=0 taken=48 trips=5 picked={"884":26,"1231":3}\n',
        'RESULT fail squad accounts=6 kills=3 gangDied=3 died=0 taken=55 trips=6 picked={"884":26,"1231":3}\n', 'RESULT ok gang groups=1 cleared=0 died=0 kills=1 ticks=1991 taken=178\n'];
    expect(squadRuns(logs)).toEqual([{ kills: 3, hpLost: 48 }, { kills: 3, hpLost: 55 }]);
    const three = squadRuns([logs[0]!, logs[1]!, logs[0]!]);
    // 151 Hitpoints for 9 kills is 17 a kill: a live run at 60 a kill drifts, one at 20 does not.
    expect(squadDrift({ kills: 5, hpLost: 300 }, three)[0]).toMatchObject({ record: 17, now: 60, drift: true });
    expect(squadDrift({ kills: 5, hpLost: 100 }, three)[0]!.drift).toBe(false);
});

test('the fidelity rows give the error of the bench in percent of the live value', () => {
    const live = { ticks: 1000, kills: 1, ourDeaths: 0, hpLost: 500, byAttack: 340, bySpecial: 10, byPoison: 150, ourEats: 20, ourAttacks: 100, ourAttacksOnTheRightPrayer: 25, gangAttacks: 200, gangSpecials: 30, gangEats: 30, gangEatsEach: {}, damageOnGang: 1000 } satisfies Meeting;
    const bench = benchMeetings(['GANG {"end":"cleared","kills":2,"ticks":1200,"taken":400,"eaten":18,"fights":[{"attacks":{"melee":50,"ranged":70,"magic":0},"dealt":1100}],"gang":[{"attacks":{"melee":150,"ranged":0,"magic":0},"specs":20,"eaten":12},{"attacks":{"melee":50,"ranged":0,"magic":0},"specs":10,"eaten":10}]}']);
    expect(bench.n).toBe(1);
    const rows = Object.fromEntries(fidelityRows(live, bench.mean).map(r => [r.measure, r]));
    expect(rows['meeting ticks']).toMatchObject({ live: 1000, bench: 1200, errorPercent: 20 });
    expect(rows['Hitpoints lost a kill']).toMatchObject({ live: 500, bench: 200, errorPercent: -60 });
    expect(rows['poison in 100 Hitpoints lost']).toMatchObject({ live: 30, bench: null, errorPercent: null });
});

test('the live meeting counts the gang attacks on our account, its eats and the damage by source', () => {
    const tick = (k: number, ...p: object[]) => JSON.stringify({ t: 'tick', r: 0, k, p });
    const m = liveMeeting([
        JSON.stringify({ t: 'roster', k: 1, p: [[1, 'Sugma', 10, 10, 0, 125], [2, 'Ours', 11, 10, 0, 126]] }),
        tick(10, { i: 1, fe: 32768 + 2, an: [376, 0] }, { i: 2, fe: 32768 + 1, hm: [[9, 1]], hp: [90, 99] }),
        tick(12, { i: 2, an: [426, 0] }, { i: 1, hm: [[12, 1]], hp: [87, 99] }),
        tick(14, { i: 1, an: [1062, 0] }, { i: 2, hm: [[10, 1], [4, 1], [4, 2]], hp: [72, 99] }),
        tick(15, { i: 2, an: [829, 0] }, { i: 1, an: [829, 0] }),
        tick(18, { i: 1, an: [376, 0] }, { i: 2, hm: [[0, 1]], hp: [92, 99] }),
        tick(30, { i: 2, an: [829, 0] }),
    ], 'ours', () => '', id => (id === 426 ? 'human_bow' : String(id)));
    expect(m).toMatchObject({ ticks: 8, gangAttacks: 3, gangSpecials: 1, hpLost: 27, byAttack: 9, bySpecial: 14, byPoison: 4, ourEats: 1, gangEats: 1, ourAttacks: 1, damageOnGang: 12 });
});
