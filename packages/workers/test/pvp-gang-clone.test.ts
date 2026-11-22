import { expect, test } from 'bun:test';
import { sparOptions } from '../src/pvp/pk-spar';
import { CLONE_NAMES, cloneProfile, cloneProfileByName, cloneProfileName, cloneSpec, median, pooledProfile, prayerLagOf, type CloneName, type CloneRecord } from '../src/pvp/pk-gang-clone';

// A record with the fields that a clone reads.
const record = (name: string, more: { eat: Record<string, number>; lag: Record<string, number>; miss: number; lows?: object[]; pack?: number; prayer?: string; short?: number }): CloneRecord => ({
    name, levels: { skills: { status: 'measured', value: { Attack: '99', Strength: '99', Defence: '99', Hitpoints: '99', Prayer: more.prayer ?? '99', Magic: '37', Ranged: '-' } } },
    kit: { foodCount: more.pack === undefined ? { status: 'unknown', cloneRange: { sharks: [6, 23] } } : { status: 'measured', value: { sharks: more.pack } }, runes: { status: 'measured', value: 'no cast and no shot' } },
    attack: { specialAtTargetHp: { status: 'measured', value: { '90-99': 30, '40-49': 5, 'not known': 1 } } },
    prayer: { ticksFromWeaponChangeToPrayer: { status: 'measured', value: { windowTicks: 8, whenTheOpponentFacesIt: more.lag, noChangeIn8Ticks: { whenTheOpponentFacesIt: more.miss } } },
        ticksAProtectPrayerStaysOn: { status: 'measured', value: { toOff: { n: 10 }, toAnotherProtectPrayer: { n: 20 }, twoTicksOrLess: more.short ?? 3 } } },
    eating: { hpAtEat: { status: 'measured', value: more.eat } },
    retreat: { at40HpOrLess: more.lows ? { status: 'measured', value: more.lows } : { status: 'unknown', cloneRange: { walkOutAtHp: [20, 40], walkOutFromWildernessLevelAtMost: [16, 20] } } },
});
const RECORDS: Record<CloneName, CloneRecord> = {
    goondelf: record('goondelf', { eat: { 53: 1, 66: 2, 74: 1, 'not known': 5 }, lag: { 1: 7, 2: 9, 3: 1 }, miss: 33, lows: [{ hp: 39, lowestHp: 26, hpAtTheLastAttack: 28, wildernessLevel: 15, ticksToOutOfTheWilderness: 91 }], pack: 11 }),
    ligma: record('ligma', { eat: { 44: 1, 64: 1, 72: 1 }, lag: { 1: 6 }, miss: 5, prayer: '90' }),
    sugma: record('sugma', { eat: { 43: 1, 71: 3, 74: 2 }, lag: { 1: 28, 4: 5 }, miss: 18, lows: [{ hp: 36, lowestHp: 0, hpAtTheLastAttack: 12, wildernessLevel: 15, ticksToDeath: 36 }], pack: 13, prayer: '90' }),
};
const records = (n: CloneName) => RECORDS[n];

test('the prayer wait: a measured wait of n ticks is n - 1 extra ticks, and a change with no prayer is the window of the measure', () => {
    expect(prayerLagOf({ 1: 7, 2: 9, 3: 1 }, 33, 8)).toEqual([7, 9, 1, 0, 0, 0, 0, 0, 33]);
    expect(prayerLagOf({ 12: 2 }, 0, 8)[7]).toBe(2);
});

test('the eat level is the median of the Hitpoints at an eat, not the highest', () => {
    expect(median({ 53: 1, 66: 2, 74: 1, 'not known': 5 })).toBe(66);
    expect(cloneProfile('goondelf', 'seen', records, 16).eatAt).toBe(66);
    expect(cloneProfile('sugma', 'seen', records, 16).eatAt).toBe(71);
});

test('a clone takes each option from its own record', () => {
    const g = cloneProfile('goondelf', 'seen', records, 16);
    // The walk out: the Hitpoints at its last attack, from the Wilderness level of the post.
    expect(g).toEqual({ rotation: ['melee'], readOverheads: false, facedPrayer: true, specBelow: 1, prayerFlick: false, eatAt: 66, prayerLag: [7, 9, 1, 0, 0, 0, 0, 0, 33], escapeAt: 28, escapeWalk: 16 });
    // Sugma's own sample is a fight to its death: no walk out, in every mode.
    for (const mode of ['seen', 'retreat', 'stand'] as const) expect(cloneProfile('sugma', mode, records, 16).escapeAt).toBeUndefined();
    // Goondelf keeps its sample in every mode.
    expect(cloneProfile('goondelf', 'stand', records, 16).escapeAt).toBe(28);
});

test('an account with no sample takes the range of its own record, never the sample of another account', () => {
    expect(cloneProfile('ligma', 'seen', records, 16)).toMatchObject({ escapeAt: 30, escapeWalk: 20 });
    expect(cloneProfile('ligma', 'retreat', records, 16).escapeAt).toBe(40);
    expect(cloneProfile('ligma', 'stand', records, 16).escapeAt).toBeUndefined();
    expect(cloneSpec('ligma', 'seen', records).sharks).toBe(15);
    expect(cloneSpec('ligma', 'lean', records).sharks).toBe(6);
    expect(cloneSpec('ligma', 'full', records).sharks).toBe(23);
    // A measured pack does not change with the mode.
    expect(cloneSpec('sugma', 'full', records)).toEqual({ skills: { Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Prayer: 90, Magic: 37, Ranged: 1 }, sharks: 13, skulled: true });
});

test('a flick is on only when half of the holds of a protect prayer are 2 ticks or less', () => {
    const flicker = record('goondelf', { eat: { 60: 1 }, lag: { 1: 1 }, miss: 0, short: 20 });
    expect(cloneProfile('goondelf', 'seen', () => flicker, 16).prayerFlick).toBe(true);
});

test('the pooled options sum the prayer waits and the eat histograms of the three', () => {
    // The walk out of the pool is the highest of the three: Goondelf 28 from its sample, Ligma 30 and 40 from its range.
    expect(pooledProfile('seen', records, 16)).toMatchObject({ eatAt: 71, prayerLag: [41, 9, 1, 5, 0, 0, 0, 0, 56], escapeAt: 30, escapeWalk: 20 });
    expect(pooledProfile('retreat', records, 16)).toMatchObject({ escapeAt: 40, escapeWalk: 20 });
    expect(pooledProfile('stand', records, 16)).toMatchObject({ escapeAt: 0, escapeWalk: 0 });
});

test('the pooled options of each mode reach the fight options of a gang account through the JSON of SPAR_B_OPTS', () => {
    // The squad script lays SPAR_B_OPTS over the profile ganker-live, which walks out at 30 Hitpoints.
    const through = (mode: 'seen' | 'retreat' | 'stand') => sparOptions('ganker-live', JSON.stringify(pooledProfile(mode, records, 16)), {} as never, 900);
    expect(sparOptions('ganker-live', undefined, {} as never, 900)).toMatchObject({ escapeAt: 30, escapeWalk: 20 });
    expect(through('stand')).toMatchObject({ escapeAt: 0, escapeWalk: 0 });
    expect(through('retreat')).toMatchObject({ escapeAt: 40, escapeWalk: 20 });
    expect(through('seen')).toMatchObject({ escapeAt: 30, eatAt: 71 });
    // The committed record: the three modes give three different walk outs.
    expect(new Set((['seen', 'retreat', 'stand'] as const).map(m => sparOptions('ganker-live', JSON.stringify(pooledProfile(m)), {} as never, 900).escapeAt)).size).toBe(3);
});

test('the committed record gives each clone a profile, and a name that is no clone gives none', () => {
    expect(cloneProfileByName('ganker-live')).toBeUndefined();
    expect(cloneProfileByName('clone-nobody')).toBeUndefined();
    for (const n of CLONE_NAMES) for (const m of ['seen', 'retreat', 'stand'] as const) {
        const p = cloneProfileByName(cloneProfileName(n, m))!;
        expect((p.prayerLag as number[]).length).toBe(9);
        expect(p.eatAt as number).toBeGreaterThan(40);
        expect(p.eatAt as number).toBeLessThan(75);
        expect(cloneSpec(n).sharks).toBeGreaterThan(0);
    }
});
