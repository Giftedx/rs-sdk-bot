// The casts and the supplies of the alchemy Magic band (scripts/alch-train.ts): Low Alchemy until Magic HIGH_LEVEL, High Alchemy from
// there to the target. One rule gives every consumable of the band from the XP left, so a kit buy and the worker's own staging agree.
import { xpForLevel } from './curve';

export const HIGH_LEVEL = 55;
// Experience a cast gives: High Alchemy 65 and Low Alchemy 31 base XP (skill_magic/configs/magic_spells.dbrow) at xpRate 25.
export const CAST_XP = { 'low-alch': 775, 'high-alch': 1625 } as const;
// Fire runes a cast takes; a fire staff takes none.
export const FIRE_PER = { 'low-alch': 3, 'high-alch': 5 } as const;
// The level at which Wind Strike (the start below Low Alchemy) ends: alchCasts counts no cast for a target at or under it.
export const STRIKE_LEVEL = 21;

// Casts of each spell from this XP to the target level: Low Alchemy below Magic 55, High Alchemy from 55.
export function alchCasts(xp: number, target: number): { low: number; high: number } {
    const goal = xpForLevel(target), gate = xpForLevel(HIGH_LEVEL);
    if (target <= STRIKE_LEVEL) return { low: 0, high: 0 };
    const low = xp < gate ? Math.ceil((Math.min(goal, gate) - xp) / CAST_XP['low-alch']) : 0;
    const high = target > HIGH_LEVEL ? Math.ceil((goal - Math.max(xp, Math.min(goal, gate))) / CAST_XP['high-alch']) : 0;
    return { low: Math.max(0, low), high: Math.max(0, high) };
}

// What the casts from a Magic level to the target use: one nature rune and one item (feather, or air rune) a cast, and fire runes for the
// casts (none with a staff). An account's partial XP in its level is not known here, so the level's own XP stands: the batch is the most
// the account can still need.
export function alchSupplies(level: number, target = 99): { nature: number; item: number; fire: number } {
    const { low, high } = alchCasts(xpForLevel(level), target), casts = low + high;
    return { nature: casts, item: casts, fire: low * FIRE_PER['low-alch'] + high * FIRE_PER['high-alch'] };
}

// The ticks of a cast, from the bench of the spell timing: 12 casts of each spell at the Draynor bank take 35 ticks for Low Alchemy
// and 57 for High Alchemy (bench cases extra:magic-alch-low and extra:magic-alch-high). The gap after a cast is the p_delay of the
// spell's script in the content (High Alchemy 3, Low Alchemy 1; scripts/microbot-magic-items.ts spellDelay), plus the casting tick
// and the wait for the effect. The rate is the measured ticks over the casts, not a number set by hand.
export const CAST_BENCH = { 'low-alch': { casts: 12, ticks: 35 }, 'high-alch': { casts: 12, ticks: 57 } } as const;
export const castTicks = (mode: keyof typeof CAST_BENCH): number => CAST_BENCH[mode].ticks / CAST_BENCH[mode].casts;
// The ticks the casts from a Magic level to the target take.
export function alchTicks(level: number, target = 99): number {
    const { low, high } = alchCasts(xpForLevel(level), target);
    return Math.ceil(low * castTicks('low-alch') + high * castTicks('high-alch'));
}
