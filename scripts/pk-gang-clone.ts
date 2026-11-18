// The bench clones of the dagger gang: the fight options and the start state of each gang account, read from its
// behaviour record (scripts/pk-gang-record/<name>.json, research/gang-clones.md). No number of a clone is written
// here: a measured value comes from the record, and an unknown value takes the range that the record gives it, one
// end a mode.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CLONE_NAMES = ['goondelf', 'ligma', 'sugma'] as const;
export type CloneName = (typeof CLONE_NAMES)[number];
// What the record leaves open, as modes of a clone:
//   seen     each account as its own samples show it (an account with no sample takes the pooled value)
//   retreat  each account walks out with its food gone, as Goondelf did
//   stand    no account walks out: it fights to its death, as Sugma did
//   lean     the fewest sharks of the record's range; `full` the most
export const CLONE_MODES = ['seen', 'retreat', 'stand', 'lean', 'full'] as const;
export type CloneMode = (typeof CLONE_MODES)[number];
type Finding = { value?: any; status: 'measured' | 'reported' | 'unknown'; n?: number; cloneRange?: any };
type Hist = Record<string, number>;
export type CloneRecord = { name: string; levels: { skills: Finding }; kit: Record<string, Finding>; attack: Record<string, Finding>; prayer: Record<string, Finding>; eating: Record<string, Finding>; retreat: Record<string, Finding> };

const dir = join(import.meta.dir, 'pk-gang-record');
const cache = new Map<string, CloneRecord>();
export function cloneRecord(name: CloneName): CloneRecord {
    let r = cache.get(name);
    if (!r) { r = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as CloneRecord; cache.set(name, r); }
    return r;
}
const numbers = (h: Hist) => Object.entries(h).filter(([k]) => Number.isFinite(Number(k))).map(([k, c]) => [Number(k), c] as const);
const sum = (a: Hist, b: Hist) => { const out: Hist = { ...a }; for (const [k, c] of Object.entries(b)) out[k] = (out[k] ?? 0) + c; return out; };

// The wait of a protect prayer change as weights of 0, 1, 2 ... extra ticks (scripts/pk.ts prayerLag). The fight loop
// turns its prayer 1 tick after the weapon change, so a measured wait of n ticks is n - 1 extra ticks. A weapon change
// that got no prayer change in 8 ticks is a wait of `MISS` extra ticks: the loop rolls the wait again at each weapon
// change, so the prayer of such a change never comes on against an opponent that changes its weapon each turn.
export const MISS = 8;
export function prayerLagOf(lag: Hist, missed: number): number[] {
    const w: number[] = Array(MISS + 1).fill(0);
    for (const [ticks, count] of numbers(lag)) w[Math.min(MISS - 1, Math.max(0, ticks - 1))] += count;
    w[MISS] = missed;
    return w;
}
// The fight options of a clone (a Profile of scripts/pk-spar.ts).
export function cloneProfile(name: CloneName, mode: CloneMode = 'seen', records: (n: CloneName) => CloneRecord = cloneRecord): Record<string, unknown> {
    const r = records(name), all = CLONE_NAMES.map(records);
    // The eat level: the highest Hitpoints at an eat for Hitpoints.
    const eatAt = Math.max(...numbers(r.eating.hpAtEat!.value as Hist).map(([hp]) => hp));
    const wait = r.prayer.ticksFromWeaponChangeToPrayer!.value as { whenTheOpponentFacesIt: Hist; noChangeIn8Ticks: { whenTheOpponentFacesIt: number } };
    // The walk out: the lowest Hitpoints of a sample that left the Wilderness. A sample that died did not walk out.
    const left = (x: CloneRecord) => ((x.retreat.at40HpOrLess?.value ?? []) as { lowestHp: number; ticksToOutOfTheWilderness?: number; ticksToDeath?: number }[]);
    const walked = all.flatMap(left).filter(l => l.ticksToOutOfTheWilderness !== undefined).map(l => l.lowestHp), own = left(r);
    const walksOut = mode === 'stand' ? false : mode === 'retreat' ? true : own.length ? own.some(l => l.ticksToOutOfTheWilderness !== undefined) : walked.length > 0;
    return {
        rotation: ['melee'], specBelow: 1, eatAt, prayerFlick: false, readOverheads: false,
        prayerLag: prayerLagOf(wait.whenTheOpponentFacesIt, wait.noChangeIn8Ticks.whenTheOpponentFacesIt),
        ...(walksOut && walked.length ? { escapeAt: Math.max(...walked), escapeWalk: 20 } : {}),
    };
}
// The options of the three clones as one: for a harness that gives every gang account the same options.
export function pooledProfile(mode: CloneMode = 'seen', records: (n: CloneName) => CloneRecord = cloneRecord): Record<string, unknown> {
    const each = CLONE_NAMES.map(n => cloneProfile(n, mode, records)), waits = CLONE_NAMES.map(n => records(n).prayer.ticksFromWeaponChangeToPrayer!.value as { whenTheOpponentFacesIt: Hist; noChangeIn8Ticks: { whenTheOpponentFacesIt: number } });
    const escape = each.find(p => p.escapeAt !== undefined);
    return { ...each[0], eatAt: Math.max(...each.map(p => p.eatAt as number)), prayerLag: prayerLagOf(waits.map(w => w.whenTheOpponentFacesIt).reduce(sum, {}), waits.reduce((a, w) => a + w.noChangeIn8Ticks.whenTheOpponentFacesIt, 0)),
        ...(mode !== 'stand' && escape ? { escapeAt: escape.escapeAt, escapeWalk: escape.escapeWalk } : { escapeAt: undefined, escapeWalk: undefined }) };
}
// The start state of a clone: its levels, its sharks and its skull. A level with no hiscore row is 1.
export function cloneSpec(name: CloneName, mode: CloneMode = 'seen', records: (n: CloneName) => CloneRecord = cloneRecord): { skills: Record<string, number>; sharks: number; skulled: boolean } {
    const r = records(name), rows = (r.levels.skills.value ?? {}) as Record<string, string>;
    const skills = Object.fromEntries(['Attack', 'Strength', 'Defence', 'Hitpoints', 'Prayer', 'Magic', 'Ranged'].map(s => [s, Number(rows[s]) || 1]));
    // The pack: the eats of a meeting in which the food ran out. An account with no such meeting takes the mean of the
    // accounts that have one. The modes `lean` and `full` are the ends of the range of an unknown pack.
    const packs = CLONE_NAMES.map(records).map(x => x.kit.foodCount!).filter(f => f.status === 'measured').map(f => f.value.sharks as number);
    const range = CLONE_NAMES.map(records).map(x => x.kit.foodCount!.cloneRange?.sharks as [number, number] | undefined).find(Boolean);
    const own = r.kit.foodCount!, mean = packs.length ? Math.round(packs.reduce((a, b) => a + b, 0) / packs.length) : range ? Math.round((range[0] + range[1]) / 2) : 12;
    const sharks = mode === 'lean' && range ? range[0] : mode === 'full' && range ? range[1] : own.status === 'measured' ? own.value.sharks : mean;
    return { skills, sharks, skulled: true };
}
// The name of the profile of a clone in a mode (scripts/pk-spar.ts PROFILES).
export const cloneProfileName = (name: CloneName, mode: CloneMode = 'seen') => (mode === 'seen' || mode === 'lean' || mode === 'full' ? `clone-${name}` : `clone-${name}-${mode}`);
export function cloneProfiles(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const n of CLONE_NAMES) for (const m of ['seen', 'retreat', 'stand'] as const) out[cloneProfileName(n, m)] = cloneProfile(n, m);
    return out;
}

if (import.meta.main) {
    // bun scripts/pk-gang-clone.ts [mode]: the options and the start state of each clone, and the pooled options.
    const mode = (process.argv[2] ?? 'seen') as CloneMode;
    for (const n of CLONE_NAMES) console.log(`CLONE ${JSON.stringify({ name: n, mode, profile: cloneProfile(n, mode), ...cloneSpec(n, mode) })}`);
    console.log(`POOLED ${JSON.stringify(pooledProfile(mode))}`);
}
