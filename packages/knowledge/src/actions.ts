// Every player action the pinned server content defines: each script trigger a player starts by clicking a loc, NPC,
// held or ground item, interface button or another player, or by entering a zone. Generated into knowledge/actions.json
// by `bun packages/knowledge/src/actions.ts`; the coverage scoreboard (packages/router/src/coverage.ts) stages them.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const PLAYER_TRIGGERS = /^(oploc[1-5u]|aploc[1-5u]|opnpc[1-5u]|apnpc[1-5u]|opheld[1-5u]|opobj[1-5u]|apobj[1-5u]|opplayer[1-5u]|applayer[1-5u]|if_button|inv_button[1-5]|mapzone|zone)$/;
export interface GameAction { domain: string; trigger: string; subject: string; name?: string; src: string }

const SKILL_FOLDERS: Record<string, string> = {
    skill_agility: 'agility', skill_cooking: 'cooking', skill_crafting: 'crafting', skill_firemaking: 'firemaking',
    skill_fishing: 'fishing', skill_fletching: 'fletching', skill_herblore: 'herblore', skill_magic: 'magic', skill_mining: 'mining',
    skill_prayer: 'prayer', skill_runecraft: 'runecraft', skill_smithing: 'smithing', skill_thieving: 'thieving',
    skill_woodcutting: 'woodcutting', skill_combat: 'combat',
};

// The domain is the content area a player meets: one skill, one quest, one area, one minigame, or a shared system.
export function domainOf(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    const top = parts[0] ?? '';
    if (SKILL_FOLDERS[top]) return 'skill/' + SKILL_FOLDERS[top];
    if (top === 'quests' || top === 'areas' || top === 'minigames') return `${top.replace(/s$/, '')}/${(parts[1] ?? '').replace(/^(quest|area|areas|game)_/, '')}`;
    return 'system/' + top.replace(/\s+/g, '_');
}

function files(dir: string, ext: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '_test' && e.name !== '_unpack') files(p, ext, out); }
        else if (e.name.endsWith(ext)) out.push(p);
    }
    return out;
}

// debugname -> display name for locs (the .loc configs), NPCs and objs (knowledge/*.json).
export function nameIndex(content: string, knowledge: string): Map<string, string> {
    const names = new Map<string, string>();
    for (const f of files(join(content, 'scripts'), '.loc')) {
        let current = '';
        for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
            const head = line.match(/^\[([^\]]+)\]/);
            if (head) { current = head[1]!; continue; }
            const n = line.match(/^name=(.+)$/);
            if (n && current && !names.has(current)) names.set(current, n[1]!.trim());
        }
    }
    for (const file of ['npcs.json', 'items.json']) {
        for (const r of JSON.parse(readFileSync(join(knowledge, file), 'utf8')) as { debugname?: string; name?: string }[])
            if (r.debugname && r.name && !names.has(r.debugname)) names.set(r.debugname, r.name);
    }
    return names;
}

export function extractActions(content: string, knowledge: string): GameAction[] {
    const names = nameIndex(content, knowledge), out: GameAction[] = [], seen = new Set<string>();
    const scripts = join(content, 'scripts');
    for (const f of files(scripts, '.rs2')) {
        const rel = relative(scripts, f).replace(/\\/g, '/');
        readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
            const m = line.match(/^\[([a-z_0-9]+),([^\]]+)\]/);
            if (!m || !PLAYER_TRIGGERS.test(m[1]!)) return;
            const key = `${m[1]},${m[2]}`;
            if (seen.has(key)) return;
            seen.add(key);
            const subject = m[2]!.trim(), base = subject.replace(/^_/, '').split(':')[0]!;
            out.push({ domain: domainOf(rel), trigger: m[1]!, subject, ...(names.has(base) ? { name: names.get(base) } : {}), src: `scripts/${rel}:${i + 1}` });
        });
    }
    return out.sort((a, b) => a.domain.localeCompare(b.domain) || a.src.localeCompare(b.src));
}

if (import.meta.main) {
    const root = resolve(import.meta.dir, '..', '..', '..');
    const actions = extractActions(join(root, 'vendor', 'rs-sdk', 'server', 'content'), join(root, 'knowledge'));
    writeFileSync(join(root, 'knowledge', 'actions.json'), JSON.stringify(actions, null, 1) + '\n');
    const domains = new Map<string, number>();
    for (const a of actions) domains.set(a.domain.split('/')[0]!, (domains.get(a.domain.split('/')[0]!) ?? 0) + 1);
    console.log(`actions ${actions.length} domains ${new Set(actions.map(a => a.domain)).size} named ${actions.filter(a => a.name).length}`);
    console.log([...domains].map(([k, v]) => `${k} ${v}`).join(', '));
}
