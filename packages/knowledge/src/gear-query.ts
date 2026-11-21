// Pure queries over knowledge/gear.json (wearable requirements, weighted scoring, slot ranking, bonus sums).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Bonus, Gear, Skill } from './gear';
import { BONUSES } from './gear';

const root = resolve(import.meta.dir, '..', '..', '..');
export const loadGear = (): Gear[] => JSON.parse(readFileSync(join(root, 'knowledge', 'gear.json'), 'utf8'));
export const MAXED: Record<Skill, number> = { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 };

export function canWear(g: Gear, levels: Partial<Record<Skill, number>>, quests: ReadonlySet<string> | null): boolean {
    for (const [s, n] of Object.entries(g.requires.skills)) if ((levels[s as Skill] ?? 1) < n!) return false;
    return !g.requires.quest || !quests || quests.has(g.requires.quest);
}

export const score = (g: Gear, weights: Partial<Record<Bonus, number>>) => Object.entries(weights).reduce((n, [k, w]) => n + (g.bonuses[k as Bonus] ?? 0) * w!, 0);

export function best(gear: readonly Gear[], slot: string, weights: Partial<Record<Bonus, number>>, levels: Partial<Record<Skill, number>> = MAXED, quests: ReadonlySet<string> | null = null, all = false): Gear[] {
    return gear.filter(g => g.slot === slot && (all || (!g.staffOnly && canWear(g, levels, quests)))).sort((a, b) => score(b, weights) - score(a, weights) || a.id - b.id);
}

export function sumBonuses(items: readonly Gear[]): Record<Bonus, number> {
    const sum = Object.fromEntries(BONUSES.map(b => [b, 0])) as Record<Bonus, number>;
    for (const g of items) for (const b of BONUSES) sum[b] += g.bonuses[b];
    return sum;
}
