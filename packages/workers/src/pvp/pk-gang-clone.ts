// Bench clones of the dagger gang built lazily from scripts/pk-gang-record/*.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './types';

export const CLONE_NAMES = ['goondelf', 'ligma', 'sugma'] as const;
export type CloneName = (typeof CLONE_NAMES)[number];
export const CLONE_MODES = ['seen', 'retreat', 'stand', 'lean', 'full'] as const;
export type CloneMode = (typeof CLONE_MODES)[number];
type Finding = { value?: any; status: 'measured' | 'reported' | 'unknown'; n?: number; cloneRange?: any };
type Hist = Record<string, number>;
export type CloneRecord = { name: string; levels: { skills: Finding }; kit: Record<string, Finding>; attack: Record<string, Finding>; prayer: Record<string, Finding>; eating: Record<string, Finding>; retreat: Record<string, Finding> };

const recordDir = () => join(REPO_ROOT, 'scripts', 'pk-gang-record');
const cache = new Map<string, CloneRecord>();

export function cloneRecord(name: CloneName): CloneRecord {
    let r = cache.get(name);
    if (!r) { r = JSON.parse(readFileSync(join(recordDir(), `${name}.json`), 'utf8')) as CloneRecord; cache.set(name, r); }
    return r;
}
const numbers = (h: Hist) => Object.entries(h ?? {}).filter(([k]) => Number.isFinite(Number(k))).map(([k, c]) => [Number(k), c] as const);
const sum = (a: Hist, b: Hist) => { const out: Hist = { ...a }; for (const [k, c] of Object.entries(b)) out[k] = (out[k] ?? 0) + c; return out; };

export function median(h: Hist): number {
    const rows = numbers(h).sort((a, b) => a[0] - b[0]), half = rows.reduce((a, [, c]) => a + c, 0) / 2;
    let seen = 0; for (const [v, c] of rows) { seen += c; if (seen > half) return v; }
    return rows[rows.length - 1]?.[0] ?? NaN;
}

type Wait = { windowTicks: number; whenTheOpponentFacesIt: Hist; noChangeIn8Ticks: { whenTheOpponentFacesIt: number } };

export function prayerLagOf(lag: Hist, missed: number, window: number): number[] {
    const w: number[] = Array(window + 1).fill(0);
    for (const [ticks, count] of numbers(lag)) w[Math.min(window - 1, Math.max(0, ticks - 1))] += count;
    w[window] = missed;
    return w;
}

let post: number | undefined;
export const postLevel = (): number => (post ??= JSON.parse(readFileSync(join(recordDir(), 'group.json'), 'utf8')).post.value.wilderness as number);
type Low = { hpAtTheLastAttack?: number; wildernessLevel?: number; ticksToOutOfTheWilderness?: number; ticksToDeath?: number };

function walkOut(r: CloneRecord, mode: CloneMode, level: number): { escapeAt: number; escapeWalk: number } | null {
    const f = r.retreat.at40HpOrLess!;
    if (f.status === 'measured') {
        const left = (f.value as Low[]).filter(l => l.ticksToOutOfTheWilderness !== undefined && l.hpAtTheLastAttack !== undefined);
        return left.length ? { escapeAt: Math.max(...left.map(l => l.hpAtTheLastAttack!)), escapeWalk: Math.max(level, ...left.map(l => l.wildernessLevel ?? 0)) } : null;
    }
    const hp = f.cloneRange?.walkOutAtHp as [number, number] | undefined, walkLevel = f.cloneRange?.walkOutFromWildernessLevelAtMost as [number, number] | undefined;
    if (mode === 'stand' || !hp || !walkLevel) return null;
    return { escapeAt: mode === 'retreat' ? hp[1] : Math.round((hp[0] + hp[1]) / 2), escapeWalk: walkLevel[1] };
}

export function cloneProfile(name: CloneName, mode: CloneMode = 'seen', records: (n: CloneName) => CloneRecord = cloneRecord, level: number = postLevel()): Record<string, unknown> {
    const r = records(name), wait = r.prayer.ticksFromWeaponChangeToPrayer!.value as Wait, holds = r.prayer.ticksAProtectPrayerStaysOn?.value as { toOff: { n: number }; toAnotherProtectPrayer: { n: number }; twoTicksOrLess: number } | undefined;
    const melee = r.kit.runes?.status === 'measured' && typeof r.kit.runes.value === 'string';
    const specTop = Math.max(0, ...Object.keys((r.attack.specialAtTargetHp?.value ?? {}) as Hist).map(k => Number(k.split('-')[1])).filter(Number.isFinite));
    const flick = !!holds && holds.twoTicksOrLess * 2 >= holds.toOff.n + holds.toAnotherProtectPrayer.n && holds.twoTicksOrLess > 0;
    const out = walkOut(r, mode, level);
    return {
        facedPrayer: true,
        ...(melee ? { rotation: ['melee'], readOverheads: false } : {}), ...(specTop ? { specBelow: Math.min(1, (specTop + 1) / 100) } : {}), prayerFlick: flick,
        eatAt: median(r.eating.hpAtEat!.value as Hist),
        prayerLag: prayerLagOf(wait.whenTheOpponentFacesIt, wait.noChangeIn8Ticks.whenTheOpponentFacesIt, wait.windowTicks),
        ...(out ?? {}),
    };
}

export function pooledProfile(mode: CloneMode = 'seen', records: (n: CloneName) => CloneRecord = cloneRecord, level: number = postLevel()): Record<string, unknown> {
    const each = CLONE_NAMES.map(n => cloneProfile(n, mode, records, level)), waits = CLONE_NAMES.map(n => records(n).prayer.ticksFromWeaponChangeToPrayer!.value as Wait);
    const walkers = each.filter(p => p.escapeAt !== undefined), none = mode === 'stand' || !walkers.length;
    return { ...each[0], eatAt: median(CLONE_NAMES.map(n => records(n).eating.hpAtEat!.value as Hist).reduce(sum, {})),
        prayerLag: prayerLagOf(waits.map(w => w.whenTheOpponentFacesIt).reduce(sum, {}), waits.reduce((a, w) => a + w.noChangeIn8Ticks.whenTheOpponentFacesIt, 0), waits[0]!.windowTicks),
        escapeAt: none ? 0 : Math.max(...walkers.map(p => p.escapeAt as number)), escapeWalk: none ? 0 : Math.max(...walkers.map(p => p.escapeWalk as number)) };
}

export function cloneSpec(name: CloneName, mode: CloneMode = 'seen', records: (n: CloneName) => CloneRecord = cloneRecord): { skills: Record<string, number>; sharks: number; skulled: boolean } {
    const r = records(name), rows = (r.levels.skills.value ?? {}) as Record<string, string>;
    const skills = Object.fromEntries(['Attack', 'Strength', 'Defence', 'Hitpoints', 'Prayer', 'Magic', 'Ranged'].map(s => [s, Number(rows[s]) || 1]));
    const own = r.kit.foodCount!, range = own.cloneRange?.sharks as [number, number] | undefined;
    if (own.status !== 'measured' && !range) throw Error(`pk-gang-clone: the record of ${name} has no pack and no range for it`);
    const sharks = own.status === 'measured' ? own.value.sharks as number : mode === 'lean' ? range![0] : mode === 'full' ? range![1] : Math.round((range![0] + range![1]) / 2);
    return { skills, sharks, skulled: true };
}

export const cloneProfileName = (name: CloneName, mode: CloneMode = 'seen') => (mode === 'seen' || mode === 'lean' || mode === 'full' ? `clone-${name}` : `clone-${name}-${mode}`);

export function cloneProfileByName(profile: string): Record<string, unknown> | undefined {
    const m = profile.match(/^clone-([a-z]+)(?:-(retreat|stand))?$/);
    return m && (CLONE_NAMES as readonly string[]).includes(m[1]!) ? cloneProfile(m[1] as CloneName, (m[2] ?? 'seen') as CloneMode) : undefined;
}

export function runPkGangCloneCli(args: readonly string[]): void {
    const mode = (args[0] ?? 'seen') as CloneMode;
    for (const n of CLONE_NAMES) console.log(`CLONE ${JSON.stringify({ name: n, mode, profile: cloneProfile(n, mode), ...cloneSpec(n, mode) })}`);
    console.log(`POOLED ${JSON.stringify(pooledProfile(mode))}`);
}
