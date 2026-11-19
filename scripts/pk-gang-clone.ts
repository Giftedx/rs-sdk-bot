// The bench clones of the dagger gang: the fight options and the start state of each gang account, read from its
// behaviour record (scripts/pk-gang-record/<name>.json, research/gang-clones.md). No number of a clone is written
// here: a measured value comes from the record of that account, and an unknown value takes the range that its record
// gives it, one end a mode. Nothing is read before the first call: a script that only imports this file reads no
// record.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CLONE_NAMES = ['goondelf', 'ligma', 'sugma'] as const;
export type CloneName = (typeof CLONE_NAMES)[number];
// What the record leaves open, as modes of a clone:
//   seen     each account as its own samples show it; an unknown value is the middle of its range
//   retreat  an account with no sample of its own walks out with its food gone, at the high end of its range
//   stand    an account with no sample of its own does not walk out
//   lean     an account with no measured pack has the fewest sharks of its range; `full` the most
// An account with a sample of its own keeps it in every mode: Goondelf walked out, Sugma fought to its death.
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
const numbers = (h: Hist) => Object.entries(h ?? {}).filter(([k]) => Number.isFinite(Number(k))).map(([k, c]) => [Number(k), c] as const);
const sum = (a: Hist, b: Hist) => { const out: Hist = { ...a }; for (const [k, c] of Object.entries(b)) out[k] = (out[k] ?? 0) + c; return out; };
// The median of a histogram of numbers.
export function median(h: Hist): number {
    const rows = numbers(h).sort((a, b) => a[0] - b[0]), half = rows.reduce((a, [, c]) => a + c, 0) / 2;
    let seen = 0; for (const [v, c] of rows) { seen += c; if (seen > half) return v; }
    return rows[rows.length - 1]?.[0] ?? NaN;
}

type Wait = { windowTicks: number; whenTheOpponentFacesIt: Hist; noChangeIn8Ticks: { whenTheOpponentFacesIt: number } };
// The wait of a protect prayer change as weights of 0, 1, 2 ... extra ticks (scripts/pk.ts prayerLag). The fight loop
// turns its prayer 1 tick after the weapon change, so a measured wait of n ticks is n - 1 extra ticks. A weapon change
// that got no prayer change in the window of the measure is a wait of that window: the loop rolls the wait again at
// each weapon change, so the prayer of such a change never comes on against an opponent that changes its weapon each
// turn.
export function prayerLagOf(lag: Hist, missed: number, window: number): number[] {
    const w: number[] = Array(window + 1).fill(0);
    for (const [ticks, count] of numbers(lag)) w[Math.min(window - 1, Math.max(0, ticks - 1))] += count;
    w[window] = missed;
    return w;
}
// The Wilderness level of the gang's post (group.json): an account walks out from its post, whatever tile of the
// post its sample began on.
let post: number | undefined;
export const postLevel = (): number => (post ??= JSON.parse(readFileSync(join(dir, 'group.json'), 'utf8')).post.value.wilderness as number);
type Low = { hpAtTheLastAttack?: number; wildernessLevel?: number; ticksToOutOfTheWilderness?: number; ticksToDeath?: number };
// The walk out of an account with its food gone: from its own samples, else from the range of its record by the mode.
function walkOut(r: CloneRecord, mode: CloneMode, level: number): { escapeAt: number; escapeWalk: number } | null {
    const f = r.retreat.at40HpOrLess!;
    if (f.status === 'measured') {
        const left = (f.value as Low[]).filter(l => l.ticksToOutOfTheWilderness !== undefined && l.hpAtTheLastAttack !== undefined);
        // The Hitpoints at its last attack before it left, and the Wilderness level that it left from.
        return left.length ? { escapeAt: Math.max(...left.map(l => l.hpAtTheLastAttack!)), escapeWalk: Math.max(level, ...left.map(l => l.wildernessLevel ?? 0)) } : null;
    }
    const hp = f.cloneRange?.walkOutAtHp as [number, number] | undefined, walkLevel = f.cloneRange?.walkOutFromWildernessLevelAtMost as [number, number] | undefined;
    if (mode === 'stand' || !hp || !walkLevel) return null;
    return { escapeAt: mode === 'retreat' ? hp[1] : Math.round((hp[0] + hp[1]) / 2), escapeWalk: walkLevel[1] };
}
// The fight options of a clone (a Profile of scripts/pk-spar.ts).
export function cloneProfile(name: CloneName, mode: CloneMode = 'seen', records: (n: CloneName) => CloneRecord = cloneRecord, level: number = postLevel()): Record<string, unknown> {
    const r = records(name), wait = r.prayer.ticksFromWeaponChangeToPrayer!.value as Wait, holds = r.prayer.ticksAProtectPrayerStaysOn?.value as { toOff: { n: number }; toAnotherProtectPrayer: { n: number }; twoTicksOrLess: number } | undefined;
    // Melee only when no animation of the account is a cast or a shot; with one style there is no overhead to read.
    const melee = r.kit.runes?.status === 'measured' && typeof r.kit.runes.value === 'string';
    // A special at any Hitpoints of the target: the highest band of the target's Hitpoints at a special.
    const specTop = Math.max(0, ...Object.keys((r.attack.specialAtTargetHp?.value ?? {}) as Hist).map(k => Number(k.split('-')[1])).filter(Number.isFinite));
    // A flick shows as holds of 1 or 2 ticks: it is on when half of the holds or more are that short.
    const flick = !!holds && holds.twoTicksOrLess * 2 >= holds.toOff.n + holds.toAnotherProtectPrayer.n && holds.twoTicksOrLess > 0;
    const out = walkOut(r, mode, level);
    return {
        // A gang account prays against the weapon of the one account it faces (research/gang-clones.md, "The prayer of the gang": 98 of 107 swaps).
        facedPrayer: true,
        ...(melee ? { rotation: ['melee'], readOverheads: false } : {}), ...(specTop ? { specBelow: Math.min(1, (specTop + 1) / 100) } : {}), prayerFlick: flick,
        // The eat level: the median Hitpoints at an eat for Hitpoints.
        eatAt: median(r.eating.hpAtEat!.value as Hist),
        prayerLag: prayerLagOf(wait.whenTheOpponentFacesIt, wait.noChangeIn8Ticks.whenTheOpponentFacesIt, wait.windowTicks),
        ...(out ?? {}),
    };
}
// The options of the three clones as one: for a harness that gives every gang account the same options. The eat level
// is the median of the three histograms as one. The walk out is the highest Hitpoints at which one of the three walks
// out in this mode, so each clone of such a harness walks out, also one that stood live: the harness is then harder
// to clear than three clones of their own would be. No walk out is the value 0 for both options: the harness lays
// these options over a profile that has a walk out, and a key with no value would leave that one in place.
export function pooledProfile(mode: CloneMode = 'seen', records: (n: CloneName) => CloneRecord = cloneRecord, level: number = postLevel()): Record<string, unknown> {
    const each = CLONE_NAMES.map(n => cloneProfile(n, mode, records, level)), waits = CLONE_NAMES.map(n => records(n).prayer.ticksFromWeaponChangeToPrayer!.value as Wait);
    const walkers = each.filter(p => p.escapeAt !== undefined), none = mode === 'stand' || !walkers.length;
    return { ...each[0], eatAt: median(CLONE_NAMES.map(n => records(n).eating.hpAtEat!.value as Hist).reduce(sum, {})),
        prayerLag: prayerLagOf(waits.map(w => w.whenTheOpponentFacesIt).reduce(sum, {}), waits.reduce((a, w) => a + w.noChangeIn8Ticks.whenTheOpponentFacesIt, 0), waits[0]!.windowTicks),
        escapeAt: none ? 0 : Math.max(...walkers.map(p => p.escapeAt as number)), escapeWalk: none ? 0 : Math.max(...walkers.map(p => p.escapeWalk as number)) };
}
// The start state of a clone: its levels, its sharks and its skull. A level with no hiscore row is 1.
export function cloneSpec(name: CloneName, mode: CloneMode = 'seen', records: (n: CloneName) => CloneRecord = cloneRecord): { skills: Record<string, number>; sharks: number; skulled: boolean } {
    const r = records(name), rows = (r.levels.skills.value ?? {}) as Record<string, string>;
    const skills = Object.fromEntries(['Attack', 'Strength', 'Defence', 'Hitpoints', 'Prayer', 'Magic', 'Ranged'].map(s => [s, Number(rows[s]) || 1]));
    // The pack: the eats of a meeting in which the food ran out. An account with no such meeting has a range: its
    // middle, or one end in the modes `lean` and `full`.
    const own = r.kit.foodCount!, range = own.cloneRange?.sharks as [number, number] | undefined;
    if (own.status !== 'measured' && !range) throw Error(`pk-gang-clone: the record of ${name} has no pack and no range for it`);
    const sharks = own.status === 'measured' ? own.value.sharks as number : mode === 'lean' ? range![0] : mode === 'full' ? range![1] : Math.round((range![0] + range![1]) / 2);
    return { skills, sharks, skulled: true };
}
// The name of the profile of a clone in a mode (scripts/pk-spar.ts sparOptions builds it on first use).
export const cloneProfileName = (name: CloneName, mode: CloneMode = 'seen') => (mode === 'seen' || mode === 'lean' || mode === 'full' ? `clone-${name}` : `clone-${name}-${mode}`);
// The profile of a name such as `clone-sugma` or `clone-ligma-stand`, or undefined for another name.
export function cloneProfileByName(profile: string): Record<string, unknown> | undefined {
    const m = profile.match(/^clone-([a-z]+)(?:-(retreat|stand))?$/);
    return m && (CLONE_NAMES as readonly string[]).includes(m[1]!) ? cloneProfile(m[1] as CloneName, (m[2] ?? 'seen') as CloneMode) : undefined;
}

if (import.meta.main) {
    // bun scripts/pk-gang-clone.ts [mode]: the options and the start state of each clone, and the pooled options.
    const mode = (process.argv[2] ?? 'seen') as CloneMode;
    for (const n of CLONE_NAMES) console.log(`CLONE ${JSON.stringify({ name: n, mode, profile: cloneProfile(n, mode), ...cloneSpec(n, mode) })}`);
    console.log(`POOLED ${JSON.stringify(pooledProfile(mode))}`);
}
