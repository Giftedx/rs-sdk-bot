import { attackTarget } from './threats';
import type { AttackStyle, Pending, PrayerGuardOptions, PrayerIntent, ThreatAssessment } from './types';

export const PROTECT = { magic: 12, missiles: 13, melee: 14 } as const;
const PROTECT_ITEM = 8;
// vendor/rs-sdk/sdk/types.ts PRAYER_LEVELS.
const LEVEL: Record<number, number> = { 1: 4, 2: 7, 4: 13, 5: 16, 8: 25, 10: 31, 11: 34, 12: 37, 13: 40, 14: 43 };
// Strength and Attack prayers, the strongest first (5%, 10%, 15%).
const STRENGTH = [10, 4, 1], ATTACK = [11, 5, 2];
const best = (prayers: readonly number[], level: number): number | null => prayers.find(i => level >= LEVEL[i]!) ?? null;

const PROTECT_FROM: Record<AttackStyle, number> = { melee: PROTECT.melee, ranged: PROTECT.missiles, magic: PROTECT.magic };

// The protection prayer for one NPC, from a table of the styles its attack script can use
// (packages/knowledge/src/npc-attack-styles.ts). An NPC that is not in the table uses melee. An NPC with melee and
// another style uses melee while it stands next to the player. `magic` first in the list: a spell of the NPC binds or
// drains, and magic protection comes first at each distance.
export const protectByStyle = (table: ReadonlyMap<number, readonly AttackStyle[]>) => (npc: any | null): number => {
    const styles = npc ? table.get(npc.id) : undefined;
    if (!styles) return PROTECT.melee;
    if (styles[0] === 'magic') return PROTECT.magic;
    if (styles.includes('melee') && npc.distance <= 1 + Math.floor((npc.size ?? 1) / 2)) return PROTECT.melee;
    return styles.includes('magic') ? PROTECT.magic : styles.includes('ranged') ? PROTECT.missiles : PROTECT.melee;
};

// Ticks the Strength and Attack prayers stay on after the last tick with an attack pending.
const OFFENCE_GRACE = 6;
// Prayers that turn each other off (skill_prayer/configs, prayer_deactivate): Defence, Strength, Attack, protection.
const EXCLUSIVE = [[0, 3, 9], [1, 4, 10], [2, 5, 11], [12, 13, 14]];
// The active prayers after one button, from the prayers that were active before it.
export const afterToggle = (active: readonly number[], prayer: number): number[] => active.includes(prayer) ? active.filter(i => i !== prayer)
    : [...active.filter(i => !EXCLUSIVE.find(group => group.includes(prayer))?.includes(i)), prayer];

// The server reads 5 inputs of a player in one tick and keeps the rest for the next tick (engine NetworkPlayer.ts:70,
// ClientGameProtCategory USER_EVENT). A flick never sends more than 5 in a tick. Two prayers go off and on in one tick
// with one attack. Three or four prayers all go off in the first tick; the protection prayer comes back on in that
// tick, and the others in the next tick. Five prayers or more would leave no input for the protection prayer.
export const TICK_INPUTS = 5;
export const MAX_FLICKED = 4;

// Rapid Restore and Rapid Heal. Each button of these two sets the regen timer again: off sets it to 100 ticks and on
// to 50 (skill_prayer/scripts/prayers/rapidrestore.rs2:18-19,35-36, rapidheal.rs2:17-18,34-35). A flick each 3 ticks
// would keep that timer from its end: no Hitpoints and no stat would come back. With one of them on, the guard sends
// no flick and the prayers drain.
const REGEN_PRAYERS: readonly number[] = [6, 7];
export const regenOn = (active: readonly number[]): boolean => active.some(i => REGEN_PRAYERS.includes(i));
// The order prayers come back on: protection, then Defence, then the others.
export const backFirst = (prayer: number) => prayer >= 12 ? 0 : [0, 3, 9].includes(prayer) ? 1 : 2;
// The state shows a prayer input at most this many ticks after the guard saw it.
export const STATE_LAG = 2;

// The active prayers: the state, with each prayer input of the last STATE_LAG ticks applied.
export function believedPrayers(st: any, intents: Map<number, PrayerIntent>, now: number): number[] {
    const set = new Set<number>((st?.prayers?.activePrayers ?? []).flatMap((on: boolean, i: number) => (on ? [i] : [])));
    for (const [i, v] of intents) {
        if (now - v.at > STATE_LAG) intents.delete(i);
        else if (v.on) set.add(i); else set.delete(i);
    }
    return [...set].sort((a, b) => a - b);
}

export function intendToggle(intents: Map<number, PrayerIntent>, before: readonly number[], prayer: number, now: number): number[] {
    const after = afterToggle(before, prayer);
    for (const i of [...before, prayer]) if (before.includes(i) !== after.includes(i)) intents.set(i, { on: after.includes(i), at: now });
    return after;
}

export const activeProtectionIndex = (activePrayers: readonly boolean[]): number =>
    activePrayers.findIndex((on, i) => on && i >= PROTECT.magic && i <= PROTECT.melee);

export const prayerKeepExpiry = (prayer: number, now: number, calmTicks: number): number =>
    now + (prayer >= 12 || prayer === PROTECT_ITEM ? calmTicks : OFFENCE_GRACE);

export const shouldDropOwned = (prayer: number, actionType: string, threatNow: boolean): boolean =>
    prayer < 12 && prayer !== PROTECT_ITEM ? true : actionType !== 'walkTo' && !threatNow;

export function chooseWantedPrayers(st: any, prayers: any, o: PrayerGuardOptions, threat: ThreatAssessment, pending: Pending): number[] {
    const wanted: number[] = [];
    if (threat.threatNow) {
        const choice = !threat.npc && threat.rival
            ? PROTECT_FROM[o.players?.style?.(threat.rival.player) ?? (threat.rival.player.distance <= 1 ? 'melee' : 'magic')]
            : o.protect ? o.protect(threat.npc) : PROTECT.melee;
        if (choice !== null && prayers.prayerLevel >= (LEVEL[choice] ?? Infinity)) wanted.push(choice);
    }
    if (o.protect !== false && threat.rival && prayers.prayerLevel >= LEVEL[PROTECT_ITEM]!) wanted.push(PROTECT_ITEM);
    if (o.offence && pending.kind === 'attack' && pending.action.type === 'interactNpc' && attackTarget(pending.action, st) && (o.melee?.(st) ?? true)) {
        for (const i of [best(STRENGTH, prayers.prayerLevel), best(ATTACK, prayers.prayerLevel)]) if (i !== null) wanted.push(i);
    }
    return wanted;
}

export interface PrayerTransition {
    missing: number[];
    stale: number[];
    order: number[];
    asFlick: boolean;
}

export function planPrayerTransition(
    active: readonly number[],
    wanted: readonly number[],
    owned: ReadonlyMap<number, number>,
    keep: ReadonlyMap<number, number>,
    now: number,
    fighting: boolean,
): PrayerTransition | null {
    const missing = wanted.filter(i => !active.includes(i));
    const stale = active.filter(i => owned.has(i) && !wanted.includes(i) && now > (keep.get(i) ?? -Infinity));
    if (!missing.length && !stale.length) return null;
    let target = active.filter(i => !stale.includes(i));
    for (const i of missing) target = afterToggle(target, i);
    const order = [...target].sort((x, y) => backFirst(x) - backFirst(y));
    const asFlick = active.length > 0 && active.length + order.length + (fighting ? 1 : 0) <= TICK_INPUTS && !regenOn(active);
    return { missing, stale, order, asFlick };
}
