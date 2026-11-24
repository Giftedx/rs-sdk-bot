// Writes client-assets/quest-reqs.json for the Quest Journal: what each quest needs before an account can finish it,
// by its journal name (questJournalNames in packages/core/src/quest-status.ts), as {s: [[skill, level, src]],
// qp: [points, src], q: [[quest, src]], i: [[item, count, src]]}.
//
// A skill, quest point or quest row comes only from the content (vendor/rs-sdk/server/content/scripts):
// - The level checks in the quest's folder (stat(skill) < N, stat_base(skill) >= N; the highest N of each skill;
//   Hitpoints checks are fight rules, not requirements), the quest point checks (%qp < N, in any script), and the
//   progress checks of other quests in the folder (%varp compared, with the varp of a quest from knowledge/quests.json).
// - The checks outside the quest's folder (areas, minigames, skill tables), named line by line in CONTENT_REQS. The
//   generator reads each named line and stops when the line does not hold the check.
// The wiki pages in vendor/rs-sdk/wiki/quests (## Requirements) give no row. They set src: 1 when the page also lists a
// row that the content checks, 2 when it does not. A row that only the wiki lists is left out (--report prints it).
// The item rows (i) come from the wiki list: src 1 when the quest's scripts name the item, 0 when only the wiki lists it.
// Run: bun packages/dashboard/gen-quest-reqs.ts
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VARP_FOLDER, questJournalNames } from '../core/src/quest-status';

export type Reqs = { s: [string, number, 1 | 2][]; qp?: [number, 1 | 2]; q: [string, 1 | 2][]; i?: [string, number, 0 | 1][] };

const SKILLS = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing',
    'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
const SKILL_SET = new Set(SKILLS);
const cap = (s: string) => s.replace(/^./, c => c.toUpperCase());
export const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/['’]/g, '').replace(/\bquest\b|\bthe\b/g, '').replace(/[^a-z0-9]/g, '');

// The ^constants of the content (`^name = value` in *.constant files), for checks written against a constant.
export function parseConstants(files: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const t of files) for (const m of t.matchAll(/^\^([a-z0-9_]+)\s*=\s*(-?\d+)\s*$/gm)) out.set(m[1]!, Number(m[2]));
    return out;
}
const value = (v: string, constants: Map<string, number>) => v.startsWith('^') ? constants.get(v.slice(1)) : Number(v);

// Skill requirements stated explicitly in a quest journal's requirement text (not "advantage" / "might be useful").
export function journalLevels(journals: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const t of journals) {
        if (/advantage to have at least one/i.test(t)) continue;
        for (const m of t.matchAll(/Level\s+(\d+)\s+([a-z]+)\b(?!\s+(?:or\s+higher\b|will\s+be\s+an\s+advantage\b|might\s+be\s+useful\b))/gi)) {
            const raw = m[2]!.toLowerCase();
            const skill = raw === 'ranging' ? 'Ranged' : cap(raw);
            const n = Number(m[1]);
            if (!SKILLS.includes(skill) || skill === 'Hitpoints' || !Number.isFinite(n)) continue;
            out.set(skill, Math.max(out.get(skill) ?? 0, n));
        }
    }
    return out;
}

// The highest level that the scripts of one quest folder (and optional journals) check for each skill.
export function serverLevels(scripts: string[], constants = new Map<string, number>(), journals: string[] = []): Map<string, number> {
    const out = journalLevels(journals);
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
    for (const t of journals) for (const m of t.matchAll(/%([a-z0-9_]+)\s*(?:=|>=|<|!)\s*\^[a-z0-9_]+_complete(?:_[a-z0-9_]+)?\b/g)) add(m[1]!);
    return out;
}

// The requirement lines of a wiki quest page: skills, quest points and quest names (matched against the journal names).
// Subheadings from ### Recommended onwards are advisory, never hard gates.
export function wikiReqs(page: string, journal: string[]): { s: Map<string, number>; qp: number | null; q: string[] } {
    const sec = (page.split(/^## Requirements\s*$/m)[1]?.split(/^## /m)[0] ?? '').split(/^###\s*Recommended\b/mi)[0] ?? '';
    const s = new Map<string, number>(), q: string[] = [], seenQ = new Set<string>();
    const journalNorm: [string, string][] = [];
    for (let i = 0; i < journal.length; i++) {
        const name = journal[i]!, normalized = norm(name);
        if (normalized.length >= 4) journalNorm.push([name, normalized]);
    }
    let qp: number | null = null;
    for (const raw of sec.split(/\r?\n/)) {
        if (!/^\s*-\s/.test(raw)) continue;
        const line = raw.replace(/\*\*/g, '').replace(/^\s*-\s*/, '');
        if (/recommended|optional|for shortcuts|^no\b|^none\b|^ability\b/i.test(line)) continue;
        const qpm = line.match(/^(\d+)\s+quest points?/i);
        if (qpm) { qp = Number(qpm[1]); continue; }
        // A level with a reason or an alternative ("33 Magic (for Telegrab spell)": the map piece can be bought) is
        // one way through the quest, not a gate; the server checks give the gates.
        if (/^\d+\s+[A-Za-z]+\s*\(\s*(for|or)\b|\bor\b/i.test(line)) continue;
        const sk = line.match(/^(\d+)\s+([A-Za-z]+)/);
        if (sk) {
            const skillName = cap(sk[2]!.toLowerCase());
            if (SKILL_SET.has(skillName)) { s.set(skillName, Number(sk[1])); continue; }
        }
        const n = norm(line);
        for (let i = 0; i < journalNorm.length; i++) {
            const [name, normalized] = journalNorm[i]!;
            if (!seenQ.has(name) && n.includes(normalized)) { seenQ.add(name); q.push(name); }
        }
    }
    return { s, qp, q };
}

// Each row is a content check. src: 1 the wiki page lists the row too (the content level wins), 2 the wiki does not.
// A row that only the wiki lists gives no output: wikiOnly names it.
export function joinReqs(server: Map<string, number>, serverQp: Set<number>, serverQuests: Set<string>, wiki: ReturnType<typeof wikiReqs> | null, folderQp: Set<number> = new Set()): Reqs {
    const s: [string, number, 1 | 2][] = [...server].map(([skill, level]) => [skill, level, wiki?.s.has(skill) ? 1 : 2]);
    s.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const out: Reqs = { s, q: [] };
    if (wiki?.qp != null && serverQp.has(wiki.qp)) out.qp = [wiki.qp, 1];
    else if (folderQp.size) out.qp = [Math.max(...folderQp), 2];
    for (const name of [...(wiki?.q ?? []).filter(n => serverQuests.has(n)), ...[...serverQuests].filter(n => !wiki?.q.includes(n))]) out.q.push([name, wiki?.q.includes(name) ? 1 : 2]);
    return out;
}

// The rows of a wiki page that no content check confirms, as text. They are not in the output.
export function wikiOnly(server: Map<string, number>, serverQp: Set<number>, serverQuests: Set<string>, wiki: ReturnType<typeof wikiReqs> | null): string[] {
    if (!wiki) return [];
    return [...[...wiki.s].filter(([skill]) => !server.has(skill)).map(([skill, level]) => `${level} ${skill}`),
        ...(wiki.qp != null && !serverQp.has(wiki.qp) ? [`${wiki.qp} QP`] : []), ...wiki.q.filter(n => !serverQuests.has(n))];
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

// A content line that holds a check: the file under vendor/rs-sdk/server/content/scripts, the 1-based line, and text
// that the line must hold.
export type Cite = readonly [file: string, line: number, text: string];

// Quest prerequisites and skill checks of the content outside the quest's own folder. Each row names its line.
// A skill row: the cited text holds the level. Where the check is on an item or a place and not on the quest's
// progress, the comment gives the line that ties it to the quest.
export const CONTENT_REQS: Record<string, { q?: [folder: string, cite: Cite][]; s?: [skill: string, level: number, cite: Cite][] }> = {
    quest_grail: {
        q: [['quest_arthur', ['areas/area_camelot/scripts/king_arthur.rs2', 43, 'case ^arthur_complete : @king_arthur_grailstart;']]],
        // The Black Knight Titan dies only to Excalibur (quests/quest_grail/scripts/black_knight_titan.rs2:30).
        s: [['Attack', 20, ['levelrequire/scripts/tier20.rs2', 16, '[opheld2,excalibur] @levelrequire_attack(20, last_slot);']]],
    },
    // Elena starts Biohazard in her house (areas/area_ardougne_east/scripts/elena.rs2:118). Its door opens after Plague City.
    quest_biohazard: { q: [['quest_elena', ['areas/area_ardougne_east/scripts/doors.rs2', 3, 'case ^elena_complete, ^elena_complete_read_scroll : ~open_and_close_door2(']]] },
    quest_junglepotion: { q: [['quest_druid', ['areas/area_karamja/scripts/trufitus.rs2', 280, 'if (%druidquest = ^druid_complete) {']]] },
    quest_troll: { q: [['quest_death', ['quests/quest_death/scripts/death_ig_commander.rs2', 7, 'case ^death_complete :']]] },
    quest_eadgar: {
        // Sanfew gives more work (sanfew_postquest) from the last stage of Druidic Ritual.
        q: [['quest_druid', ['areas/area_taverly/scripts/sanfew.rs2', 27,'} else if(%druidquest >= ^druid_given_ingredients) {']],
            ['quest_death', ['areas/area_taverly/scripts/sanfew.rs2', 102, '%death_equiproom = ^death_complete']],
            ['quest_troll', ['areas/area_taverly/scripts/sanfew.rs2', 102, '%troll_quest = ^troll_complete']]],
        s: [['Herblore', 31, ['areas/area_taverly/scripts/sanfew.rs2', 103, 'if(stat_base(herblore) >= 31) {']]],
    },
    quest_tbwt: { q: [['quest_junglepotion', ['areas/area_karamja/scripts/tbwt_timfraku.rs2', 51, 'if (%junglepotion >= ^junglepotion_complete) {']]] },
    quest_mm: {
        q: [['quest_grandtree', ['quests/quest_grandtree/scripts/king_narnode.rs2', 7, 'case ^grandtree_complete :']],
            ['quest_tree', ['quests/quest_grandtree/scripts/king_narnode.rs2', 8, 'if(%treequest = ^tree_complete) {']]],
    },
    quest_mortton: {
        // Drezel opens the way to Morytania after Priest in Peril.
        q: [['quest_priestperil', ['areas/area_mausoleum/scripts/drezel.rs2', 120, 'if (%priestperil < ^priestperil_complete) {']]],
        s: [
            // Serum 207 ([mort_serum3_tarrominvial]); the quest goes on when it is made (skill_herblore/scripts/herblore.rs2:17).
            ['Herblore', 15, ['skill_herblore/configs/brewing/brew_potion.struct', 289, 'param=brew_potion_level,15']],
            // The temple repair moves the quest on (flamtaer_temple.rs2:77). The brick check of the quest folder is 12.
            ['Crafting', 20, ['minigames/game_mortton/scripts/flamtaer_temple.rs2', 11, 'if (stat(crafting) < 20) {']],
            // The lowest pyre; the pyre moves the quest on (mortton_pyre.rs2:75,91).
            ['Firemaking', 5, ['minigames/game_mortton/configs/flamtaer_pyre.struct', 2, 'param=pyre_level,5']],
        ],
    },
    // Achietties takes a fire feather, a lava eel and a thieves' armband (areas/areas_heroes_guild/scripts/achietties.rs2:12).
    // The lava eel, the blamish oil for its rod and the ice gloves for the feather cannot be traded (knowledge/items.json).
    quest_hero: {
        s: [
            ['Fishing', 53, ['skill_fishing/scripts/fishing_spots/lavafish.rs2', 84, 'if (stat(fishing) < 53) {']],
            ['Cooking', 53, ['skill_cooking/configs/cooking_source/cooking_generic.dbrow', 110, 'data=levelrequired,53']],
            // The rockslide on the way to the Ice Queen, who drops the ice gloves.
            ['Mining', 50, ['areas/area_white_wolf_mountain/scripts/white_wolf_mountain.rs2', 20, 'if(stat(mining) < 50) {']],
            // Blamish oil ([blamish_oil]) for the oily fishing rod.
            ['Herblore', 25, ['skill_herblore/configs/brewing/brew_potion.struct', 210, 'param=brew_potion_level,25']],
        ],
    },
    // King Lathas starts Underground Pass.
    quest_upass: { s: [['Ranged', 25, ['areas/area_ardougne_east/scripts/king_lathas.rs2', 95, 'if(stat_base(ranged) < 25) {']]] },
};

// The citations of CONTENT_REQS that the content does not hold: a missing file or line, a line without the text, or a
// skill row whose text does not hold its level. `read` returns the text of a content file, or null.
export function citeFaults(read: (file: string) => string | null, reqs = CONTENT_REQS): string[] {
    const out: string[] = [];
    const check = (owner: string, [file, line, text]: Cite, level?: number) => {
        const got = read(file)?.split(/\r?\n/)[line - 1];
        if (got == null) out.push(`${owner}: ${file}:${line} is not in the content`);
        else if (!got.includes(text)) out.push(`${owner}: ${file}:${line} does not hold "${text}" (line: "${got.trim()}")`);
        if (level != null && !new RegExp(`(^|\\D)${level}(\\D|$)`).test(text)) out.push(`${owner}: the text "${text}" does not hold the level ${level}`);
    };
    for (const [folder, r] of Object.entries(reqs)) {
        for (const [q, cite] of r.q ?? []) check(`${folder} needs ${q}`, cite);
        for (const [skill, level, cite] of r.s ?? []) check(`${folder} needs ${level} ${skill}`, cite, level);
    }
    return out;
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const scriptsDir = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts'), questDir = join(scriptsDir, 'quests');
    const namedFiles = (d: string, ext: string): { path: string; text: string }[] => readdirSync(d).sort().flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? namedFiles(p, ext) : f.endsWith(ext) ? [{ path: p, text: readFileSync(p, 'utf8') }] : []; });
    const files = (d: string, ext: string): string[] => namedFiles(d, ext).map(x => x.text);
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
    const wiki = new Map(readdirSync(wikiDir).sort().filter(f => f.endsWith('.md')).map(f => { const t = readFileSync(join(wikiDir, f), 'utf8'); return [norm(t.match(/^# (.+)$/m)?.[1] ?? f), t] as [string, string]; }));
    const faults = citeFaults(file => { try { return readFileSync(join(scriptsDir, file), 'utf8'); } catch { return null; } });
    if (faults.length) throw new Error(`CONTENT_REQS does not match the content:\n${faults.join('\n')}`);
    const out: Record<string, Reqs> = {}, report: string[] = [], dropped: string[] = [], mark = (s: number) => s === 0 ? '?' : s === 2 ? '*' : '';
    for (const [folder, name] of names) {
        let scriptEntries: { path: string; text: string }[] = [];
        let journals: string[] = [];
        try { scriptEntries = namedFiles(join(questDir, folder), '.rs2'); journals = files(join(questDir, folder), '_journal.rs2'); } catch { /* no folder */ }
        const scripts = scriptEntries.map(e => e.text);
        // Post-quest godbook preaching (horror_godbook.rs2:272, 50 Prayer) is not a Horror from the Deep gate.
        const reqScripts = scriptEntries.filter(e => !/_godbook\.rs2$/.test(e.path)).map(e => e.text);
        const cross = CONTENT_REQS[folder];
        const quests = new Set([...serverPrereqs(reqScripts, varpFolder, folder, journals), ...(cross?.q ?? []).map(([f]) => f)].filter(f => names.has(f)).map(f => names.get(f)!));
        const page = wiki.get(norm(name)) ?? null, w = page ? wikiReqs(page, journal.filter(n => n !== name)) : null;
        const levels = serverLevels(reqScripts, constants, journals);
        for (const [sk, lv] of cross?.s ?? []) levels.set(sk, Math.max(levels.get(sk) ?? 0, lv));
        const r = joinReqs(levels, serverQp, quests, w, serverQuestPoints(reqScripts, constants));
        const left = wikiOnly(levels, serverQp, quests, w);
        if (left.length) dropped.push(`${name}: ${left.join(', ')}`);
        // Items: src 1 when the quest's scripts name the item (its debugname as a word), 0 when only the wiki lists it.
        const text = scripts.join('\n'), its = page ? wikiItems(page, items) : [];
        if (its.length) r.i = its.map(([n, c, d]) => [n, c, new RegExp(`\\b${d}\\b`).test(text) ? 1 : 0]);
        if (r.s.length || r.q.length || r.qp || r.i) out[name] = r;
        const diff = [...(w?.s ?? [])].filter(([k, v]) => levels.has(k) && levels.get(k) !== v).map(([k, v]) => `${k} wiki ${v} server ${levels.get(k)}`);
        report.push(`${name}${page ? '' : ' (no wiki page)'}: ${r.s.map(x => x[1] + ' ' + x[0] + mark(x[2])).join(', ')}${r.qp ? ' · ' + r.qp[0] + ' QP' + mark(r.qp[1]) : ''}${r.q.length ? ' · ' + r.q.map(x => x[0] + mark(x[1])).join(', ') : ''}${r.i ? ' · items ' + r.i.map(x => x[1] + ' ' + x[0] + mark(x[2])).join(', ') : ''}${diff.length ? ' · DIFF ' + diff.join('; ') : ''}`);
    }
    dropCycles(out);
    writeFileSync(join(import.meta.dir, 'client-assets', 'quest-reqs.json'), JSON.stringify(out));
    // --report: one line a quest; * the wiki does not list the row, ? an item that only the wiki lists. Then the wiki
    // rows that no content check confirms: they are not in the file.
    if (process.argv.includes('--report')) console.log(`${report.join('\n')}\n\nWiki rows with no content check (left out):\n${dropped.join('\n') || 'none'}`);
    console.log(`quest-reqs.json: ${Object.keys(out).length} quests with requirements`);
}
