// Writes client-assets/quest-reqs.json for the Quest Journal: what each quest needs before an account can finish it,
// by its journal name (questJournalNames in packages/router/src/coverage.ts), as {s: [[skill, level, src]],
// qp: [points, src], q: [[quest, src]], i: [[item, count, src]]}. src is 1 when the server scripts check it and 0 when only the wiki says it.
//
// Two sources, joined:
// - The server: the level checks in the quest's folder (stat(skill) < N, stat_base(skill) >= N; the highest N of each
//   skill; Hitpoints checks are fight rules, not requirements), the quest point checks (%qp < N, in any script), and
//   the progress checks of other quests in the folder (%varp compared, with the varp of a quest from knowledge/quests.json).
// - The wiki pages in vendor/rs-sdk/wiki/quests (## Requirements): "N Skill", "N Quest Points" and the names of other
//   quests. A line that says recommended, optional or for shortcuts is not a requirement.
// The server wins on a level: Legends Quest checks 52 Mining where the wiki says 50.
// Run: bun packages/dashboard/gen-quest-reqs.ts
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VARP_FOLDER, questJournalNames } from '../router/src/coverage';

export type Reqs = { s: [string, number, 0 | 1 | 2][]; qp?: [number, 0 | 1 | 2]; q: [string, 0 | 1 | 2][]; i?: [string, number, 0 | 1][] };

const SKILLS = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing',
    'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
const cap = (s: string) => s.replace(/^./, c => c.toUpperCase());
export const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/['’]/g, '').replace(/\bquest\b|\bthe\b/g, '').replace(/[^a-z0-9]/g, '');

// The ^constants of the content (`^name = value` in *.constant files), for checks written against a constant.
export function parseConstants(files: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const t of files) for (const m of t.matchAll(/^\^([a-z0-9_]+)\s*=\s*(-?\d+)\s*$/gm)) out.set(m[1]!, Number(m[2]));
    return out;
}
const value = (v: string, constants: Map<string, number>) => v.startsWith('^') ? constants.get(v.slice(1)) : Number(v);

// The highest level that the scripts of one quest folder check for each skill.
export function serverLevels(scripts: string[], constants = new Map<string, number>()): Map<string, number> {
    const out = new Map<string, number>();
    for (const t of scripts) for (const m of t.matchAll(/stat(?:_base)?\(([a-z]+)\)\s*(<|>=)\s*(\^[a-z0-9_]+|\d+)/g)) {
        const skill = cap(m[1]!), n = value(m[3]!, constants);
        if (!SKILLS.includes(skill) || skill === 'Hitpoints' || n == null || !Number.isFinite(n)) continue;
        out.set(skill, Math.max(out.get(skill) ?? 0, n));
    }
    return out;
}

// The quest points that scripts check (%qp < N or %qp >= N, N a number or a ^constant).
export function serverQuestPoints(scripts: string[], constants: Map<string, number>): Set<number> {
    const out = new Set<number>();
    for (const t of scripts) for (const m of t.matchAll(/%qp\s*(?:<|>=)\s*(\^[a-z0-9_]+|\d+)/g)) { const n = value(m[1]!, constants); if (n != null && Number.isFinite(n)) out.add(n); }
    return out;
}

// The other quests whose completion a folder's scripts test as a gate: %varp < ^name_complete. A quest that only
// mentions a later quest's progress in dialogue uses other tests, so it is not counted.
// The quest's journal scripts (*_journal.rs2) state its start conditions, so any completion test there counts
// (Regicide's journal: %upass = ^upass_complete).
export function serverPrereqs(scripts: string[], varpFolder: Map<string, string>, self: string, journals: string[] = []): Set<string> {
    const out = new Set<string>(), add = (v: string) => { const f = varpFolder.get(v); if (f && f !== self) out.add(f); };
    for (const t of scripts) for (const m of t.matchAll(/%([a-z0-9_]+)\s*<\s*\^[a-z0-9_]+_complete\b/g)) add(m[1]!);
    for (const t of journals) for (const m of t.matchAll(/%([a-z0-9_]+)\s*(?:=|>=|<|!)\s*\^[a-z0-9_]+_complete\b/g)) add(m[1]!);
    return out;
}

// The requirement lines of a wiki quest page: skills, quest points and quest names (matched against the journal names).
export function wikiReqs(page: string, journal: string[]): { s: Map<string, number>; qp: number | null; q: string[] } {
    const sec = page.split(/^## Requirements\s*$/m)[1]?.split(/^## /m)[0] ?? '';
    const s = new Map<string, number>(), q: string[] = [];
    let qp: number | null = null;
    for (const raw of sec.split(/\r?\n/).filter(l => /^\s*-\s/.test(l))) {
        const line = raw.replace(/\*\*/g, '').replace(/^\s*-\s*/, '');
        if (/recommended|optional|for shortcuts|^no\b|^none\b|^ability\b/i.test(line)) continue;
        const qpm = line.match(/^(\d+)\s+quest points?/i);
        if (qpm) { qp = Number(qpm[1]); continue; }
        // A level with a reason or an alternative ("33 Magic (for Telegrab spell)": the map piece can be bought) is
        // one way through the quest, not a gate; the server checks give the gates.
        if (/^\d+\s+[A-Za-z]+\s*\(\s*(for|or)\b|\bor\b/i.test(line)) continue;
        const sk = line.match(/^(\d+)\s+([A-Za-z]+)/);
        if (sk && SKILLS.includes(cap(sk[2]!.toLowerCase()))) { s.set(cap(sk[2]!.toLowerCase()), Number(sk[1])); continue; }
        const n = norm(line);
        for (const name of journal) if (norm(name).length >= 4 && n.includes(norm(name)) && !q.includes(name)) q.push(name);
    }
    return { s, qp, q };
}

// src: 1 the server checks it and the wiki lists it (the server level wins), 0 only the wiki lists it, 2 only the
// server checks it (a check inside the quest that the wiki does not list).
export function joinReqs(server: Map<string, number>, serverQp: Set<number>, serverQuests: Set<string>, wiki: ReturnType<typeof wikiReqs> | null, folderQp: Set<number> = new Set()): Reqs {
    const s: [string, number, 0 | 1 | 2][] = [];
    for (const skill of new Set([...server.keys(), ...(wiki?.s.keys() ?? [])])) {
        const sv = server.get(skill), wv = wiki?.s.get(skill);
        s.push(sv != null ? [skill, sv, wv != null ? 1 : 2] : [skill, wv!, 0]);
    }
    s.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const out: Reqs = { s, q: [] };
    if (wiki?.qp != null) out.qp = [wiki.qp, serverQp.has(wiki.qp) ? 1 : 0];
    else if (folderQp.size) out.qp = [Math.max(...folderQp), 2];
    for (const name of new Set([...(wiki?.q ?? []), ...serverQuests])) out.q.push([name, serverQuests.has(name) ? (wiki?.q.includes(name) ? 1 : 2) : 0]);
    return out;
}

// The items of a wiki page's "Items Needed" list that name a real item: [name, count, debugname]. The count is the
// leading number (1 when there is none); a parenthesis and an "or" alternative are dropped; a plural name falls back to
// the singular. A line about food, gear, coins or an item obtained in the quest is not a need.
export function wikiItems(page: string, items: Map<string, { name: string; debugname: string }>): [string, number, string][] {
    const sec = page.split(/^## Items Needed\s*$/m)[1]?.split(/^## /m)[0] ?? '';
    const out: [string, number, string][] = [];
    for (const raw of sec.split(/\r?\n/).filter(l => /^\s*-\s/.test(l))) {
        const line = raw.replace(/\*\*/g, '').replace(/^\s*-\s*/, '');
        if (/obtained|during the quest|given|recommended|optional|food|equipment|armou?r|\bgp\b|coins/i.test(line)) continue;
        const m = line.match(/^(?:(\d[\d,]*)\s*x?\s+)?([^(]+)/i);
        if (!m) continue;
        const count = m[1] ? Number(m[1].replace(/,/g, '')) : 1, name = m[2]!.split(/\s+or\s+|,|\//i)[0]!.trim().toLowerCase();
        const hit = items.get(name) ?? items.get(name.replace(/ies$/, 'y')) ?? items.get(name.replace(/es$/, '')) ?? items.get(name.replace(/s$/, ''));
        if (hit && count > 0 && !out.some(([n]) => n === hit.name)) out.push([hit.name, count, hit.debugname]);
    }
    return out;
}

// A quest cannot need a quest that needs it: a server-only prerequisite B of A is dropped when B needs A (Death
// Plateau tests Troll Stronghold's completion in dialogue; Troll Stronghold needs Death Plateau).
export function dropCycles(out: Record<string, Reqs>) {
    const needs = (a: string, b: string) => out[a]?.q.some(([n]) => n === b) ?? false;
    const drop = Object.entries(out).flatMap(([a, r]) => r.q.filter(([b, src]) => src === 2 && needs(b, a)).map(([b]) => [a, b] as const));
    for (const [a, b] of drop) out[a]!.q = out[a]!.q.filter(([n]) => n !== b);
    for (const [a, r] of Object.entries(out)) if (!r.s.length && !r.q.length && !r.qp && !r.i) delete out[a];
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const scriptsDir = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts'), questDir = join(scriptsDir, 'quests');
    const files = (d: string, ext: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? files(p, ext) : f.endsWith(ext) ? [readFileSync(p, 'utf8')] : []; });
    const constants = parseConstants(files(scriptsDir, '.constant'));
    const names = questJournalNames(root), journal = [...names.values()];
    const itemRows = JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')) as { name: string; debugname: string }[];
    const items = new Map<string, { name: string; debugname: string }>();
    for (const it of itemRows) if (it.name && it.debugname && !items.has(it.name.toLowerCase())) items.set(it.name.toLowerCase(), it);
    const rows = JSON.parse(readFileSync(join(root, 'knowledge', 'quests.json'), 'utf8')) as { varp: string; folder?: string | null }[];
    const varpFolder = new Map<string, string>(Object.entries(VARP_FOLDER));
    for (const r of rows) if (r.folder && r.varp) varpFolder.set(r.varp, r.folder);
    const serverQp = serverQuestPoints(files(scriptsDir, '.rs2'), constants);
    const wikiDir = join(root, 'vendor', 'rs-sdk', 'wiki', 'quests');
    const wiki = new Map(readdirSync(wikiDir).filter(f => f.endsWith('.md')).map(f => { const t = readFileSync(join(wikiDir, f), 'utf8'); return [norm(t.match(/^# (.+)$/m)?.[1] ?? f), t] as [string, string]; }));
    const out: Record<string, Reqs> = {}, report: string[] = [], mark = (s: number) => s === 0 ? '?' : s === 2 ? '*' : '';
    for (const [folder, name] of names) {
        let scripts: string[] = [];
        let journals: string[] = [];
        try { scripts = files(join(questDir, folder), '.rs2'); journals = files(join(questDir, folder), '_journal.rs2'); } catch { /* no folder */ }
        const quests = new Set([...serverPrereqs(scripts, varpFolder, folder, journals)].filter(f => names.has(f)).map(f => names.get(f)!));
        const page = wiki.get(norm(name)) ?? null, w = page ? wikiReqs(page, journal.filter(n => n !== name)) : null;
        const levels = serverLevels(scripts, constants), r = joinReqs(levels, serverQp, quests, w, serverQuestPoints(scripts, constants));
        // Items: src 1 when the quest's scripts name the item (its debugname as a word), 0 when only the wiki lists it.
        const text = scripts.join('\n'), its = page ? wikiItems(page, items) : [];
        if (its.length) r.i = its.map(([n, c, d]) => [n, c, new RegExp(`\\b${d}\\b`).test(text) ? 1 : 0]);
        if (r.s.length || r.q.length || r.qp || r.i) out[name] = r;
        const diff = [...(w?.s ?? [])].filter(([k, v]) => levels.has(k) && levels.get(k) !== v).map(([k, v]) => `${k} wiki ${v} server ${levels.get(k)}`);
        report.push(`${name}${page ? '' : ' (no wiki page)'}: ${r.s.map(x => x[1] + ' ' + x[0] + mark(x[2])).join(', ')}${r.qp ? ' · ' + r.qp[0] + ' QP' + mark(r.qp[1]) : ''}${r.q.length ? ' · ' + r.q.map(x => x[0] + mark(x[1])).join(', ') : ''}${r.i ? ' · items ' + r.i.map(x => x[1] + ' ' + x[0] + mark(x[2])).join(', ') : ''}${diff.length ? ' · DIFF ' + diff.join('; ') : ''}`);
    }
    dropCycles(out);
    writeFileSync(join(import.meta.dir, 'client-assets', 'quest-reqs.json'), JSON.stringify(out));
    // --report: one line a quest; ? only the wiki lists it, * only the server checks it.
    if (process.argv.includes('--report')) console.log(report.join('\n'));
    console.log(`quest-reqs.json: ${Object.keys(out).length} quests with requirements`);
}
