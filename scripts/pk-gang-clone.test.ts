import { expect, test } from 'bun:test';
import { CLONE_NAMES, cloneProfile, cloneProfileName, cloneProfiles, cloneSpec, MISS, pooledProfile, prayerLagOf, type CloneName, type CloneRecord } from './pk-gang-clone';

// A record with the fields that a clone reads.
const record = (name: string, more: { eat: Record<string, number>; lag: Record<string, number>; miss: number; lows?: object[]; pack?: number; prayer?: string }): CloneRecord => ({
    name, levels: { skills: { status: 'measured', value: { Attack: '99', Strength: '99', Defence: '99', Hitpoints: '99', Prayer: more.prayer ?? '99', Magic: '37', Ranged: '-' } } },
    kit: { foodCount: more.pack === undefined ? { status: 'unknown', cloneRange: { sharks: [6, 23] } } : { status: 'measured', value: { sharks: more.pack } } },
    attack: {}, prayer: { ticksFromWeaponChangeToPrayer: { status: 'measured', value: { whenTheOpponentFacesIt: more.lag, noChangeIn8Ticks: { whenTheOpponentFacesIt: more.miss } } } },
    eating: { hpAtEat: { status: 'measured', value: more.eat } }, retreat: { at40HpOrLess: more.lows ? { status: 'measured', value: more.lows } : { status: 'unknown' } },
});
const RECORDS: Record<CloneName, CloneRecord> = {
    goondelf: record('goondelf', { eat: { 53: 1, 74: 1, 'not known': 5 }, lag: { 1: 7, 2: 9, 3: 1 }, miss: 33, lows: [{ lowestHp: 26, ticksToOutOfTheWilderness: 91 }], pack: 11 }),
    ligma: record('ligma', { eat: { 44: 1, 72: 1 }, lag: { 1: 6 }, miss: 5, prayer: '90' }),
    sugma: record('sugma', { eat: { 43: 1, 74: 2 }, lag: { 1: 28, 4: 5 }, miss: 18, lows: [{ lowestHp: 0, ticksToDeath: 36 }], pack: 13, prayer: '90' }),
};
const records = (n: CloneName) => RECORDS[n];

test('the prayer wait: a measured wait of n ticks is n - 1 extra ticks, and a change with no prayer is the long wait', () => {
    expect(prayerLagOf({ 1: 7, 2: 9, 3: 1 }, 33)).toEqual([7, 9, 1, 0, 0, 0, 0, 0, 33]);
    expect(prayerLagOf({ 12: 2 }, 0)[MISS - 1]).toBe(2);
});

test('a clone takes each option from its record', () => {
    const g = cloneProfile('goondelf', 'seen', records);
    expect(g).toMatchObject({ rotation: ['melee'], eatAt: 74, prayerLag: [7, 9, 1, 0, 0, 0, 0, 0, 33], escapeAt: 26, escapeWalk: 20 });
    // Sugma's own sample is a fight to its death: no walk out.
    expect(cloneProfile('sugma', 'seen', records).escapeAt).toBeUndefined();
    // Ligma has no sample: it takes the walk out that another account showed. Its eat level is its own.
    expect(cloneProfile('ligma', 'seen', records)).toMatchObject({ eatAt: 72, escapeAt: 26 });
});

test('the modes are the two ends that the record shows with the food gone, and the ends of an unknown pack', () => {
    expect(cloneProfile('goondelf', 'stand', records).escapeAt).toBeUndefined();
    expect(cloneProfile('sugma', 'retreat', records).escapeAt).toBe(26);
    expect(cloneSpec('goondelf', 'seen', records)).toEqual({ skills: { Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Prayer: 99, Magic: 37, Ranged: 1 }, sharks: 11, skulled: true });
    // No meeting of Ligma ran out of food: the mean of the two packs that are measured.
    expect(cloneSpec('ligma', 'seen', records)).toMatchObject({ sharks: 12, skills: { Prayer: 90 } });
    expect(cloneSpec('ligma', 'lean', records).sharks).toBe(6);
    expect(cloneSpec('sugma', 'full', records).sharks).toBe(23);
});

test('the pooled options sum the prayer waits of the three', () => {
    expect(pooledProfile('seen', records)).toMatchObject({ eatAt: 74, prayerLag: [41, 9, 1, 5, 0, 0, 0, 0, 56], escapeAt: 26 });
    expect(pooledProfile('stand', records).escapeAt).toBeUndefined();
});

test('the committed record gives each clone a profile with a prayer wait and an eat level', () => {
    const all = cloneProfiles();
    for (const n of CLONE_NAMES) for (const m of ['seen', 'retreat', 'stand'] as const) {
        const p = all[cloneProfileName(n, m)]!;
        expect((p.prayerLag as number[]).length).toBe(MISS + 1);
        expect(p.eatAt as number).toBeGreaterThan(40);
        expect(cloneSpec(n).sharks).toBeGreaterThan(0);
    }
});
