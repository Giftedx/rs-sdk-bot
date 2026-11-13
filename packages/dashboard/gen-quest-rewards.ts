// Writes client-assets/quest-rewards.json for the Quest Journal: each quest by its journal name (questJournalNames in
// packages/router/src/coverage.ts) as [quest points, [[skill, xp], ...]]. The quest list is the content's quest folders
// (68; knowledge/quests.json lacks some, and some of its rows have no folder), as coverage.ts takes it: a row's folder
// is its folder, else VARP_FOLDER of its varp; a folder with no row takes QP_FALLBACK. The XP is what the server gives:
// the base XP times the server's XP rate (XP_RATE, 25), as stat_advance applies it.
// Run: bun packages/dashboard/gen-quest-rewards.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { XP_RATE } from '../knowledge/src/method-model';
import { QP_FALLBACK, VARP_FOLDER, questJournalNames } from '../router/src/coverage';

export type Reward = [number, [string, number][]];
type Row = { folder?: string | null; varp?: string; questPoints?: number; xp?: { skill: string; xp: number }[] };
const cap = (s: string) => s.replace(/^./, c => c.toUpperCase());

export function questRewards(folders: string[], rows: Row[], names: Map<string, string>, rate = XP_RATE, varpFolder = VARP_FOLDER, qpFallback = QP_FALLBACK): Record<string, Reward> {
    const byFolder = new Map<string, Row>();
    for (const r of rows) { const f = r.folder ?? (r.varp ? varpFolder[r.varp] ?? null : null); if (f) byFolder.set(f, r); }
    const out: Record<string, Reward> = {};
    for (const folder of folders) {
        const name = names.get(folder);
        if (!name) continue;
        const r = byFolder.get(folder);
        out[name] = [r ? Number(r.questPoints) || 0 : qpFallback[folder] ?? 0, (r?.xp ?? []).map(x => [cap(x.skill), Math.round(x.xp * rate)] as [string, number])];
    }
    return out;
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const folders = readdirSync(join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts', 'quests')).filter(f => f.startsWith('quest_'));
    const rewards = questRewards(folders, JSON.parse(readFileSync(join(root, 'knowledge', 'quests.json'), 'utf8')), questJournalNames(root));
    writeFileSync(join(import.meta.dir, 'client-assets', 'quest-rewards.json'), JSON.stringify(rewards));
    console.log(`quest-rewards.json: ${Object.keys(rewards).length} quests, ${Object.values(rewards).reduce((n, r) => n + r[0], 0)} quest points`);
}
