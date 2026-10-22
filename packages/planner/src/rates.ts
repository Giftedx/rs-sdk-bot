import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Method } from './plan';

// Measured rates only. Each entry says what was measured and where the evidence is. Model estimates do not belong
// here (they live in research/xp-per-tick.md); the planner can tell the two apart by `source`.
export interface MeasuredRate {
    method: string;
    skill: string;
    level: number; // level the method needs (and the level it was measured at, unless `note` says otherwise)
    xpPerTick: number; // XP per tick of the acting account's playtime, at 25x
    runs: number;
    tickMs: number;
    source: 'measured';
    evidence: string;
    note?: string;
}

const file = join(resolve(import.meta.dir, '..', '..', '..'), 'knowledge', 'rates.json');

export function loadRates(path = file): MeasuredRate[] {
    return JSON.parse(readFileSync(path, 'utf8'));
}

export function toMethods(rates: MeasuredRate[]): Method[] {
    return rates.map(r => ({ id: r.method, skill: r.skill, level: r.level, xpPerHour: r.xpPerTick * (3_600_000 / r.tickMs), source: 'measured' as const }));
}
