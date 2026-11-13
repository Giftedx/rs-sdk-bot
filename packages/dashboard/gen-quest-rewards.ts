// Writes client-assets/quest-rewards.json for the Quest Journal: each quest by its journal name (questJournalNames in
// packages/router/src/coverage.ts) as [quest points, [[skill, xp], ...]] from knowledge/quests.json. The XP is what the
// server gives: the base XP times the server's XP rate (XP_RATE, 25), as stat_advance applies it.
// Run: bun packages/dashboard/gen-quest-rewards.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { XP_RATE } from '../knowledge/src/method-model';
import { questJournalNames } from '../router/src/coverage';

export type Reward = [number, [string, number][]];
const cap = (s: string) => s.replace(/^./, c => c.toUpperCase());

export function questRewards(quests: { folder?: string; questPoints?: number; xp?: { skill: string; xp: number }[] }[], names: Map<string, string>, rate = XP_RATE): Record<string, Reward> {
    const out: Record<string, Reward> = {};
    for (const q of quests) {
        const name = q.folder ? names.get(q.folder) : undefined;
        if (!name) continue;
        out[name] = [Number(q.questPoints) || 0, (q.xp ?? []).map(x => [cap(x.skill), Math.round(x.xp * rate)] as [string, number])];
    }
    return out;
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const rewards = questRewards(JSON.parse(readFileSync(join(root, 'knowledge', 'quests.json'), 'utf8')), questJournalNames(root));
    writeFileSync(join(import.meta.dir, 'client-assets', 'quest-rewards.json'), JSON.stringify(rewards));
    console.log(`quest-rewards.json: ${Object.keys(rewards).length} quests, ${Object.values(rewards).reduce((n, r) => n + r[0], 0)} quest points`);
}
