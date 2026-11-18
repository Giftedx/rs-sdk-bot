// The stall bound of the gang squad, from the clone record. Imported FIRST by scripts/pk-squad.ts: packages/core/src/bot.ts
// reads STALL_TICKS once, when it loads, and a squad that holds its post while the gang is away has no xp, item, dialog or
// journey for as long as the gang takes to come back (a dead account is back on the post after `returnToPost` ticks in
// scripts/pk-gang-record/group.json). The default of 900 ticks ended a hold of that kind as "no progress". The bound is the
// longest return of the record times one margin, never under the default; STALL_TICKS in the environment wins.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const STALL_DEFAULT_TICKS = 900;
export const STALL_MARGIN = 1.25;

// The returns of a gang account to its post in the record (ticks after a death, ticks after a walk out), longest first.
export function recordedReturns(group: unknown): number[] {
    const value = (group as { returnToPost?: { value?: Record<string, unknown> } } | null)?.returnToPost?.value;
    if (!value || typeof value !== 'object') return [];
    return Object.values(value).flatMap(v => (Array.isArray(v) ? v : [])).filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0).sort((a, b) => b - a);
}

export function squadStallTicks(group: unknown, margin = STALL_MARGIN): number {
    const longest = recordedReturns(group)[0];
    return longest === undefined ? STALL_DEFAULT_TICKS : Math.max(STALL_DEFAULT_TICKS, Math.ceil(longest * margin));
}

export function readGangRecord(dir = resolve(import.meta.dir, 'pk-gang-record')): unknown {
    try { return JSON.parse(readFileSync(join(dir, 'group.json'), 'utf8')); } catch { return null; }
}

// Only the process that runs the squad sets it: a test or a tool that imports pk-squad.ts keeps the default.
if (/pk-squad\.ts$/.test(process.argv[1] ?? '')) process.env.STALL_TICKS ??= String(squadStallTicks(readGangRecord()));
