// Game coverage scoreboard: every skill band, quest and content domain of the pinned server, staged by our evidence.
// Quest stages: none -> named (a script file exists) -> practice (a run finished the quest) -> live (an owned account on
// any side has it complete). Action counts are a text match of content names against our source, not script coverage:
// actions without a display name rarely match, shared code handles others without naming them, and a word in a comment
// matches. Batch qualification is not tracked yet. Deterministic: no model calls. `bun packages/router/src/coverage.ts` writes .practice/coordinator/scoreboard.json.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { GameAction } from '../../knowledge/src/actions';
import { parseConfigs } from '../../knowledge/src/config';
import { QUEST_SOURCE } from '../../core/src/quest-status';
import { mySide } from '../../core/src/fleet';

export const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'] as const;
export const BANDS = [[1, 40], [40, 70], [70, 99]] as const;
export type Stage = 'none' | 'named' | 'practice' | 'live';
const RANK: Record<Stage, number> = { none: 0, named: 1, practice: 2, live: 3 };
export const better = (a: Stage, b: Stage): Stage => (RANK[a] >= RANK[b] ? a : b);

type Held = { id?: number; baseId?: number; count?: number }[];
export interface Status { name?: string; server?: string; at?: number; skills?: { name: string; level: number }[]; quests?: { name: string; state: string }[]; bank?: Held; inventory?: Held; equipment?: Held }

// Items any owned account holds now: bank, pack or worn (an item used up earlier is not counted).
export function itemsHeld(statuses: Status[], items: { id: number; tradeable?: boolean }[]) {
    const held = new Set(statuses.flatMap(s => [...(s.bank ?? []), ...(s.inventory ?? []), ...(s.equipment ?? [])]).map(i => i.baseId ?? i.id).filter((n): n is number => Number.isInteger(n)));
    const tradeable = items.filter(i => i.tradeable);
    return { items: items.length, held: items.filter(i => held.has(i.id)).length, tradeable: tradeable.length, tradeableHeld: tradeable.filter(i => held.has(i.id)).length };
}

// The source our workers are written in, lower-cased: scripts and package sources, not tests and not generated knowledge.
export function corpus(root: string): string {
    const parts: string[] = [];
    const walk = (dir: string) => {
        if (!existsSync(dir)) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) { if (!['node_modules', 'test', 'knowledge'].includes(e.name)) walk(p); }
            else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) parts.push(readFileSync(p, 'utf8'));
        }
    };
    walk(join(root, 'scripts'));
    for (const pkg of ['core', 'practice', 'router', 'planner']) walk(join(root, 'packages', pkg, 'src'));
    return parts.join('\n').toLowerCase();
}

// Text match only: the display name (5+ characters, so "Door" alone does not count) or the debug name appears in our source.
export function named(a: GameAction, text: string): boolean {
    const debug = a.subject.replace(/^_/, '').split(':')[0]!.toLowerCase();
    if (debug.length >= 4 && text.includes(debug)) return true;
    const n = a.name?.toLowerCase();
    return !!n && n.length >= 5 && text.includes(n);
}

// Our script for a quest folder: quest-<folder without quest_ and underscores>.ts unless named otherwise.
const SCRIPT_ALIAS: Record<string, string> = { quest_romeojuliet: 'quest-rj.ts', quest_scorpcatcher: 'quest-scorpion.ts', quest_blackarmgang: 'quest-arrav.ts',
    quest_arthur: 'quest-merlin.ts', quest_mcannon: 'dwarfcannon.ts', quest_itexam: 'quest-dig.ts', quest_waterfall: 'waterfall.ts', quest_elemental_workshop: 'quest-elemental.ts' };
export const questScript = (folder: string): string => SCRIPT_ALIAS[folder] ?? 'quest-' + folder.replace(/^quest_/, '').replace(/_/g, '') + '.ts';
// knowledge/quests.json has no row for these folders; points from research/quest-points-board.md (quest.constant lines).
const QP_FALLBACK: Record<string, number> = { quest_cog: 1, quest_elemental_workshop: 1, quest_mm: 3, quest_troll_love: 2 };
const VARP_FOLDER: Record<string, string> = { goblinquest: 'quest_gobdip', elenaquest: 'quest_elena', waterfall_quest: 'quest_waterfall', horrorquest: 'quest_horror' };

// Journal labels are the names emitted by questFlags, not varps or script names.
export function questJournalNames(root = resolve(import.meta.dir, '../../..')): Map<string, string> {
    return new Map(parseConfigs(readFileSync(join(root, QUEST_SOURCE), 'utf8'), QUEST_SOURCE)
        .filter(b => b.props.buttontype?.[0] === 'normal' && b.props.text?.[0])
        .map(b => [b.name === 'fortress' ? 'quest_blackknight' : `quest_${b.name}`, b.props.text![0]!]));
}

export function skillBands(statuses: Status[]) {
    return SKILLS.map(skill => {
        const best = Math.max(1, ...statuses.flatMap(s => (s.skills ?? []).filter(k => k.name.toLowerCase() === skill.toLowerCase()).map(k => k.level)));
        return { skill, bestLive: best, bands: BANDS.map(([lo, hi]) => ({ band: `${lo}-${hi}`, stage: (best >= hi ? 'live' : best > lo ? 'live-partial' : 'none') as string })) };
    });
}

// The other sides' accounts from their fleet-data snapshots (fleet/snapshots/<side>.json, scripts/fleet-sync.ts). This
// side's snapshot is skipped (its statuses are read directly), and so is an account seen longer ago than maxAgeMs
// (FLEET_SNAPSHOT_MAX_AGE_H, default 24 h) and the protected main account Haggis.
// quests lists completed journal names; a snapshot without the field leaves that account's quests unknown.
export interface SideAccount { side: string; name: string; at: number; skills: { name: string; level: number }[]; quests?: string[] }
export const SNAPSHOT_MAX_AGE_MS = (Number(process.env.FLEET_SNAPSHOT_MAX_AGE_H) || 24) * 3_600_000;
export function sideSnapshots(dir: string, side: string, now = Date.now(), maxAgeMs = SNAPSHOT_MAX_AGE_MS, server = 'rs-sdk-demo.fly.dev') {
    const accounts: SideAccount[] = [], stale: string[] = [];
    if (!existsSync(dir)) return { accounts, stale };
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
        let snap: any; try { snap = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
        if (typeof snap?.side !== 'string' || snap.side === side) continue;
        for (const a of snap.accounts ?? []) {
            if (typeof a?.name !== 'string' || a.name.toLowerCase() === 'haggis' || String(a.server).toLowerCase() !== server) continue;
            const at = Number(a.at ?? snap.at) || 0;
            if (now - at > maxAgeMs) { stale.push(`${snap.side}:${a.name}`); continue; }
            accounts.push({ side: snap.side, name: a.name, at, skills: (a.skills ?? []).map((k: any) => ({ name: String(k.name), level: Number(k.level) || 1 })), ...(Array.isArray(a.quests) ? { quests: a.quests.map(String) } : {}) });
        }
    }
    return { accounts, stale };
}

// Fleet-best level of each skill over every side, with its account and side, and the best of each side.
export function fleetSkills(local: Status[], others: SideAccount[], side: string) {
    const rows = [...local.filter(s => (s.name ?? '').toLowerCase() !== 'haggis').map(s => ({ side, name: s.name ?? '', skills: s.skills ?? [] })), ...others];
    return SKILLS.map(skill => {
        const bySide: Record<string, { level: number; account: string }> = {};
        for (const r of rows) for (const k of r.skills) if (k.name.toLowerCase() === skill.toLowerCase() && k.level > (bySide[r.side]?.level ?? 0)) bySide[r.side] = { level: k.level, account: r.name };
        const lead = Object.entries(bySide).sort((a, b) => b[1].level - a[1].level || (a[0] === side ? -1 : b[0] === side ? 1 : 0))[0];
        return { skill, best: lead?.[1].level ?? 1, account: lead?.[1].account ?? null, side: lead?.[0] ?? null, bySide };
    });
}

// A pass finished the quest: "ok stopped at", "ok stage=" and qp=0 rows end only a part of it.
const PARTIAL_RUN = /^ok (stopped at|stage=)|\bqp=0\b/;
// Quest folders with a passing run. .practice/results.jsonl names the script in goal; a task folder's results.jsonl names
// it in quest, with or without the quest- prefix.
export function practicePasses(practice: string, byScript: Map<string, string>): Set<string> {
    const passes = new Set<string>();
    if (!existsSync(practice)) return passes;
    const files = [join(practice, 'results.jsonl'), ...readdirSync(practice, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(practice, e.name, 'results.jsonl'))];
    for (const file of files.filter(f => existsSync(f))) for (const line of readFileSync(file, 'utf8').split('\n')) {
        let r: any; try { r = JSON.parse(line); } catch { continue; }
        if (r?.ok !== true || PARTIAL_RUN.test(String(r.text ?? r.result ?? '').replace(/^RESULT /, ''))) continue;
        const script = String(r.quest ?? r.goal).replace(/\.ts$/, '') + '.ts';
        const folder = byScript.get(script) ?? (r.quest ? byScript.get('quest-' + script) : undefined);
        if (folder) passes.add(folder);
    }
    return passes;
}

export function questStages(statuses: Status[], practicePass: Set<string>, scriptFolders: Set<string>, quests: { varp: string; folder: string; questPoints: number; name?: string }[]) {
    const done = new Set(statuses.flatMap(s => (s.quests ?? []).filter(q => q.state === 'complete').map(q => q.name.toLowerCase())));
    const names = [...new Set(statuses.flatMap(s => (s.quests ?? []).map(q => q.name)))];
    return { liveComplete: names.filter(n => done.has(n.toLowerCase())).sort(), journalQuests: names.length,
        folders: quests.map(q => ({ folder: q.folder, qp: q.questPoints, stage: (q.name && done.has(q.name.toLowerCase()) ? 'live' : practicePass.has(q.folder) ? 'practice' : scriptFolders.has(q.folder) ? 'named' : 'none') as Stage })) };
}

export function domainStages(actions: GameAction[], text: string) {
    const by = new Map<string, { total: number; named: number }>();
    for (const a of actions) {
        const d = by.get(a.domain) ?? { total: 0, named: 0 };
        d.total++; if (named(a, text)) d.named++;
        by.set(a.domain, d);
    }
    return [...by].map(([domain, d]) => ({ domain, actions: d.total, named: d.named, share: Math.round(100 * d.named / d.total) })).sort((a, b) => a.share - b.share || b.actions - a.actions);
}

export function buildScoreboard(root = resolve(import.meta.dir, '..', '..', '..')) {
    const actions: GameAction[] = JSON.parse(readFileSync(join(root, 'knowledge', 'actions.json'), 'utf8'));
    const text = corpus(root);
    const owned = new Set(Object.keys(JSON.parse(readFileSync(join(root, '.practice', 'owned-accounts.json'), 'utf8'))).map(n => n.toLowerCase()));
    owned.delete('haggis'); // the protected main account is not a coverage account
    const statusDir = join(root, '.practice', 'status');
    const statuses: Status[] = readdirSync(statusDir).filter(f => f.endsWith('.json')).flatMap(f => { try { return [JSON.parse(readFileSync(join(statusDir, f), 'utf8'))]; } catch { return []; } })
        .filter((s: Status) => s.server === 'rs-sdk-demo.fly.dev' && owned.has((s.name ?? '').toLowerCase()));
    // The 68 quest folders of the content are the quest list (knowledge/quests.json lacks 4 folders).
    const known = new Map<string, number>((JSON.parse(readFileSync(join(root, 'knowledge', 'quests.json'), 'utf8')) as { folder: string | null; varp: string; questPoints: number }[])
        .map(q => [q.folder ?? VARP_FOLDER[q.varp] ?? q.varp, q.questPoints]));
    const journalNames = questJournalNames(root);
    const quests = readdirSync(join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts', 'quests')).filter(f => f.startsWith('quest_'))
        .map(folder => ({ varp: folder, folder, name: journalNames.get(folder), questPoints: known.get(folder) ?? QP_FALLBACK[folder] ?? 0 }));
    const gen = join(root, 'scripts', 'generated');
    const scriptFolders = new Set(quests.map(q => q.folder).filter(f => existsSync(join(gen, questScript(f)))));
    const byScript = new Map(quests.map(q => [questScript(q.folder), q.folder]));
    const practicePass = practicePasses(join(root, '.practice'), byScript);
    const domains = domainStages(actions, text);
    const side = mySide(), shared = sideSnapshots(join(root, '.practice', 'fleet-data', 'fleet', 'snapshots'), side);
    const sideQuests: Status[] = shared.accounts.map(a => ({ quests: (a.quests ?? []).map(name => ({ name, state: 'complete' })) }));
    const board = { at: new Date().toISOString(), scope: 'Pinned rev 289 content; action counts are a text match, not script coverage; batch is not tracked yet.',
        totals: { actions: actions.length, actionsNamed: domains.reduce((n, d) => n + d.named, 0), domains: domains.length, domainsUntouched: domains.filter(d => d.named === 0).length },
        items: itemsHeld(statuses, JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8'))),
        skills: skillBands(statuses), quests: questStages([...statuses, ...sideQuests], practicePass, scriptFolders, quests), domains, statuses: statuses.length,
        // skills count this side only and fleetSkills adds the other sides' fresh snapshots; quests count every side.
        fleetSkills: fleetSkills(statuses, shared.accounts, side),
        fleet: { side, sides: [...new Set([side, ...shared.accounts.map(a => a.side)])].sort(), sharedAccounts: shared.accounts.length, stale: shared.stale, questsUnknown: [...new Set(shared.accounts.filter(a => !a.quests).map(a => a.side))].sort() } };
    const full = { ...board, progress: progressOf(board) };
    writeFileSync(join(root, '.practice', 'coordinator', 'scoreboard.json'), JSON.stringify(full, null, 1) + '\n');
    return full;
}

// The numbers that must rise while work is useful, and the end condition of the whole project. Boards are tracked by
// the plan's scoreboard; this covers the game itself.
export interface Progress { skillLevels: number; skills99: number; questsLive: number; questTotal: number; itemsHeld: number; actionsNamed: number; done: boolean; remaining: string[] }
export function progressOf(b: { skills: { skill: string; bestLive: number }[]; quests: { liveComplete: string[]; folders: { qp: number }[] }; items: { held: number; tradeable: number; tradeableHeld: number }; totals: { actions: number; actionsNamed: number } }): Progress {
    const questTotal = b.quests.folders.filter(f => f.qp > 0).length;
    const remaining = [
        ...b.skills.filter(s => s.bestLive < 99).map(s => `${s.skill} ${s.bestLive}/99`),
        ...(b.quests.liveComplete.length < questTotal ? [`quests ${b.quests.liveComplete.length}/${questTotal} live`] : []),
        ...(b.items.tradeableHeld < b.items.tradeable ? [`tradeable items ${b.items.tradeableHeld}/${b.items.tradeable} held`] : []),
        ...(b.totals.actionsNamed < b.totals.actions ? [`actions ${b.totals.actionsNamed}/${b.totals.actions} named`] : []),
    ];
    return { skillLevels: b.skills.reduce((n, s) => n + s.bestLive, 0), skills99: b.skills.filter(s => s.bestLive >= 99).length,
        questsLive: b.quests.liveComplete.length, questTotal, itemsHeld: b.items.held, actionsNamed: b.totals.actionsNamed, done: remaining.length === 0, remaining };
}
// Work moved the game forward when any progress number rose.
export function improved(before: Progress, after: Progress): boolean {
    return after.skillLevels > before.skillLevels || after.skills99 > before.skills99 || after.questsLive > before.questsLive
        || after.itemsHeld > before.itemsHeld || after.actionsNamed > before.actionsNamed;
}

// Rebuilt when older than maxAgeMs; the planner reads it every round.
export function freshScoreboard(root: string, maxAgeMs = 600_000) {
    const file = join(root, '.practice', 'coordinator', 'scoreboard.json');
    try { if (Date.now() - statSync(file).mtimeMs < maxAgeMs) return JSON.parse(readFileSync(file, 'utf8')); } catch { /* rebuild */ }
    return buildScoreboard(root);
}

if (import.meta.main) {
    const board = buildScoreboard(), statuses = { length: board.statuses };
    const s = board.skills, q = board.quests;
    console.log(`actions ${board.totals.actions}, text match ${board.totals.actionsNamed} (${Math.round(100 * board.totals.actionsNamed / board.totals.actions)}%); domains ${board.totals.domains}, untouched ${board.totals.domainsUntouched}; owned live statuses ${statuses.length}`);
    console.log(`skills at 99 live: ${s.filter(k => k.bestLive >= 99).length}/19; under 40: ${s.filter(k => k.bestLive < 40).map(k => `${k.skill} ${k.bestLive}`).join(', ')}`);
    console.log(`fleet sides ${board.fleet.sides.join(', ')}: ${board.fleet.sharedAccounts} shared accounts, ${board.fleet.stale.length} stale skipped; other side leads: ${board.fleetSkills.filter(k => k.side !== board.fleet.side).map(k => `${k.skill} ${k.best} (${k.side} ${k.account})`).join(', ') || 'none'}`);
    console.log(`items held now: ${board.items.held}/${board.items.items} (tradeable ${board.items.tradeableHeld}/${board.items.tradeable})`);
    console.log(`quests complete live: ${q.liveComplete.length}/${q.journalQuests} journal quests; folders live ${q.folders.filter(f => f.stage === 'live').length}, practice ${q.folders.filter(f => f.stage === 'practice').length}, named ${q.folders.filter(f => f.stage === 'named').length}, none ${q.folders.filter(f => f.stage === 'none').length} of ${q.folders.length}${board.fleet.questsUnknown.length ? `; quests unknown on ${board.fleet.questsUnknown.join(', ')}` : ''}`);
}
