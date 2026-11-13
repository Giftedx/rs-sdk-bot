// Writes client-assets/quest-rewards.json for the Quest Journal: each quest by its journal name (questJournalNames in
// packages/router/src/coverage.ts) as [quest points, [[skill, xp], ...]]. The quest list is the content's quest folders
// (68; knowledge/quests.json lacks some, and some of its rows have no folder), as coverage.ts takes it: a row's folder
// is its folder, else VARP_FOLDER of its varp; a folder with no row takes QP_FALLBACK. The XP is what the server gives:
// the base XP times the server's XP rate (XP_RATE, 25), as stat_advance applies it.
// Run: bun packages/dashboard/gen-quest-rewards.ts
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { XP_RATE } from '../knowledge/src/method-model';
import { QP_FALLBACK, VARP_FOLDER, questJournalNames } from '../router/src/coverage';

export type Reward = [number, [string, number][]];
type Row = { folder?: string | null; varp?: string; questPoints?: number; xp?: { skill: string; xp: number }[] };
const cap = (s: string) => s.replace(/^./, c => c.toUpperCase());

// The XP a quest's own scripts give on completion, for a quest whose knowledge/quests.json row has none (an extraction
// gap: Fight Arena, Waterfall Quest): each stat_advance(skill, tenths) with a number inside a script block whose name
// holds "complete". A block with more than 3 is a choice of skills (The Tourist Trap) and is left out. Base XP.
export function completionXp(texts: string[]): { skill: string; xp: number }[] {
    const blocks = new Map<string, { skill: string; xp: number }[]>();
    let head = '';
    for (const text of texts) for (const line of text.split(/\r?\n/)) {
        const h = line.match(/^\[[a-z_]+,([^\]]+)\]/);
        if (h) { head = h[1]!; continue; }
        const m = line.match(/stat_advance\((\w+),\s*(\d+)\)/);
        if (m && /complete/.test(head)) blocks.set(head, [...(blocks.get(head) ?? []), { skill: m[1]!, xp: Number(m[2]) / 10 }]);
    }
    return [...blocks.values()].filter(b => b.length <= 3).flat();
}

export function questRewards(folders: string[], rows: Row[], names: Map<string, string>, rate = XP_RATE, varpFolder = VARP_FOLDER, qpFallback = QP_FALLBACK, scriptsOf: (folder: string) => string[] = () => []): Record<string, Reward> {
    const byFolder = new Map<string, Row>();
    for (const r of rows) { const f = r.folder ?? (r.varp ? varpFolder[r.varp] ?? null : null); if (f) byFolder.set(f, r); }
    const out: Record<string, Reward> = {};
    for (const folder of folders) {
        const name = names.get(folder);
        if (!name) continue;
        const r = byFolder.get(folder);
        const xp = r?.xp?.length ? r.xp : completionXp(scriptsOf(folder));
        out[name] = [r ? Number(r.questPoints) || 0 : qpFallback[folder] ?? 0, xp.map(x => [cap(x.skill), Math.round(x.xp * rate)] as [string, number])];
    }
    return out;
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const questDir = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts', 'quests');
    const folders = readdirSync(questDir).filter(f => f.startsWith('quest_'));
    const rs2 = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? rs2(p) : f.endsWith('.rs2') ? [readFileSync(p, 'utf8')] : []; });
    const rewards = questRewards(folders, JSON.parse(readFileSync(join(root, 'knowledge', 'quests.json'), 'utf8')), questJournalNames(root), XP_RATE, VARP_FOLDER, QP_FALLBACK, folder => rs2(join(questDir, folder)));
    writeFileSync(join(import.meta.dir, 'client-assets', 'quest-rewards.json'), JSON.stringify(rewards));
    console.log(`quest-rewards.json: ${Object.keys(rewards).length} quests, ${Object.values(rewards).reduce((n, r) => n + r[0], 0)} quest points`);
}
