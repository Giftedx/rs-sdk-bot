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

// [quest points, XP the quest always gives, XP that is one of several outcomes (Observatory Quest's random sign)].
export type Reward = [number, [string, number][], [string, number][]];
type Row = { folder?: string | null; varp?: string; questPoints?: number; xp?: { skill: string; xp: number; src?: string }[] };

// A stat_advance inside an open switch_ block (under one of its cases) is one of several outcomes. lines is the script
// file, n the 0-based line of the stat_advance; braces are counted back to the block header, so a line after the switch
// closes is not inside it.
export function insideSwitch(lines: string[], n: number): boolean {
    let depth = 0;
    for (let k = n - 1; k >= 0; k--) {
        const t = lines[k]!.trim();
        if (/^\[[a-z_]+,[^\]]+\]/.test(t)) return false;
        for (const ch of [...t].reverse()) { if (ch === '}') depth++; else if (ch === '{') { if (depth === 0) { if (/switch_\w+\(/.test(t)) return true; } else depth--; } }
    }
    return false;
}
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

// XP given in a block anywhere in the content that sets the varp to a complete value (%seaslug = ^seaslug_complete):
// for a reward defined outside the quest folder (Sea Slug: area_ardougne_east caroline.rs2). files are [path, text];
// the _test cheat scripts are left out, and so is a block with more than 3 stat_advance (a choice) or one under 100
// base XP (a skill action that happens to share the block, such as weeding). Base XP.
export function varpCompletionXp(files: [string, string][], varp: string): { skill: string; xp: number }[] {
    const sets = new RegExp(`%${varp}\\s*=\\s*\\^\\w*complete`), out: { skill: string; xp: number }[] = [];
    for (const [path, text] of files) {
        if (/(^|[\\/])_test[\\/]/.test(path)) continue;
        let block: string[] = [];
        const flush = () => {
            if (!block.some(l => sets.test(l))) return;
            const xp = block.map(l => l.match(/stat_advance\((\w+),\s*(\d+)\)/)).filter((m): m is RegExpMatchArray => !!m).map(m => ({ skill: m[1]!, xp: Number(m[2]) / 10 }));
            if (xp.length && xp.length <= 3 && xp.every(x => x.xp >= 100)) out.push(...xp);
        };
        for (const line of text.split(/\r?\n/)) { if (/^\[[a-z_]+,[^\]]+\]/.test(line)) { flush(); block = []; } else block.push(line); }
        flush();
    }
    return out;
}

export function questRewards(folders: string[], rows: Row[], names: Map<string, string>, rate = XP_RATE, varpFolder = VARP_FOLDER, qpFallback = QP_FALLBACK, scriptsOf: (folder: string) => string[] = () => [], isChoice: (src: string) => boolean = () => false, varpXp: (varp: string) => { skill: string; xp: number }[] = () => []): Record<string, Reward> {
    const byFolder = new Map<string, Row>();
    for (const r of rows) { const f = r.folder ?? (r.varp ? varpFolder[r.varp] ?? null : null); if (f) byFolder.set(f, r); }
    const out: Record<string, Reward> = {};
    for (const folder of folders) {
        const name = names.get(folder);
        if (!name) continue;
        const r = byFolder.get(folder);
        const own = r?.xp?.length ? r.xp : completionXp(scriptsOf(folder)), xp = own.length || !r?.varp ? own : varpXp(r.varp), pair = (x: { skill: string; xp: number }) => [cap(x.skill), Math.round(x.xp * rate)] as [string, number];
        out[name] = [r ? Number(r.questPoints) || 0 : qpFallback[folder] ?? 0, xp.filter(x => !(x as any).src || !isChoice((x as any).src)).map(pair), xp.filter(x => (x as any).src && isChoice((x as any).src)).map(pair)];
    }
    return out;
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const questDir = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts', 'quests');
    const folders = readdirSync(questDir).filter(f => f.startsWith('quest_'));
    const rs2 = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? rs2(p) : f.endsWith('.rs2') ? [readFileSync(p, 'utf8')] : []; });
    // Every script of the content once, as [path, text], for rewards defined outside a quest folder.
    const scriptsDir = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts');
    const withPaths = (d: string): [string, string][] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? withPaths(p) : f.endsWith('.rs2') ? [[p.slice(scriptsDir.length + 1), readFileSync(p, 'utf8')] as [string, string]] : []; });
    const allScripts = withPaths(scriptsDir);
    const rewards = questRewards(folders, JSON.parse(readFileSync(join(root, 'knowledge', 'quests.json'), 'utf8')), questJournalNames(root), XP_RATE, VARP_FOLDER, QP_FALLBACK, folder => rs2(join(questDir, folder)), src => { const i = src.lastIndexOf(':'); return insideSwitch(readFileSync(join(root, 'vendor', 'rs-sdk', 'server', 'content', src.slice(0, i)), 'utf8').split(/\r?\n/), Number(src.slice(i + 1)) - 1); }, varp => varpCompletionXp(allScripts, varp));
    writeFileSync(join(import.meta.dir, 'client-assets', 'quest-rewards.json'), JSON.stringify(rewards));
    console.log(`quest-rewards.json: ${Object.keys(rewards).length} quests, ${Object.values(rewards).reduce((n, r) => n + r[0], 0)} quest points`);
}
