// Squad stall tick bound computed from recorded dagger gang return durations.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from './types';

export const STALL_DEFAULT_TICKS = 900;
export const STALL_MARGIN = 1.25;

/** Extracts recorded gang return ticks in descending order. */
export function recordedReturns(group: unknown): number[] {
    const value = (group as { returnToPost?: { value?: Record<string, unknown> } } | null)?.returnToPost?.value;
    if (!value || typeof value !== 'object') return [];
    return Object.values(value).flatMap(v => (Array.isArray(v) ? v : [])).filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0).sort((a, b) => b - a);
}

/** Computes bounded squad STALL_TICKS from the longest recorded gang return. */
export function squadStallTicks(group: unknown, margin = STALL_MARGIN): number {
    const longest = recordedReturns(group)[0];
    return longest === undefined ? STALL_DEFAULT_TICKS : Math.max(STALL_DEFAULT_TICKS, Math.ceil(longest * margin));
}

export function readGangRecord(dir = resolve(REPO_ROOT, 'scripts', 'pk-gang-record')): unknown {
    try { return JSON.parse(readFileSync(join(dir, 'group.json'), 'utf8')); } catch { return null; }
}

/**
 * Applies the computed squad stall bound into `env.STALL_TICKS` when unset. The escort hold (ESCORT_HOLD=1 in the
 * environment or the arguments) stands at the post with no fight by design, so its bound is 0 (no stall check): the hold
 * ends at MAX_MINUTES or at the release file.
 */
export function applySquadStallTicks(env: Record<string, string | undefined> = process.env, argv: readonly string[] = process.argv): void {
    const hold = env.ESCORT_HOLD === '1' || argv.includes('ESCORT_HOLD=1');
    env.STALL_TICKS ??= hold ? '0' : String(squadStallTicks(readGangRecord()));
}
