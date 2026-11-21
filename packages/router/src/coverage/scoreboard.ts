import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { GameAction } from '../../../knowledge/src/actions';
import { mySide } from '../../../core/src/fleet';
import { fleetStatusRows, ownerOfIn, readSnapshotFiles } from '../../../core/src/fleet-snapshots';
import { buildOwnerGoals, type OwnerGoals } from '../goal-scoreboard';
import { corpus, domainStages, firedActions } from './actions';
import { SNAPSHOT_MAX_AGE_MS, coverageStatus, fleetSkills, itemsHeld, observedAt, ownedNames, practicePasses, questStages, recentObservation, sideSnapshots, skillBands } from './fleet';
import { QP_FALLBACK, VARP_FOLDER, questJournalNames, questScript, type SideAccount } from './model';

// The numbers that must rise while work is useful, and the end condition of the whole project. Boards are tracked by
// the plan's scoreboard; this covers the game itself.
export interface Progress { skillLevels: number; skills99: number; questsLive: number; questTotal: number; itemsHeld: number; actionsNamed: number; goalVersion?: 1; goalMetrics?: Record<string,number>; done: boolean; remaining: string[] }
export function progressOf(b: { skills: { skill: string; bestLive: number }[]; quests: { liveComplete: string[]; folders: { qp: number }[] }; items: { held: number; tradeable: number; tradeableHeld: number }; totals: { actions: number; actionsNamed: number }; goals?: OwnerGoals }): Progress {
    const questTotal = b.quests.folders.filter(f => f.qp > 0).length;
    const remaining = b.goals?.remaining ?? ['Owner goal observations unavailable'];
    return { skillLevels: b.skills.reduce((n, s) => n + s.bestLive, 0), skills99: b.skills.filter(s => s.bestLive >= 99).length,
        questsLive: b.quests.liveComplete.length, questTotal, itemsHeld: b.items.held, actionsNamed: b.totals.actionsNamed,
        ...(b.goals ? {goalVersion: 1 as const, goalMetrics: b.goals.metrics} : {}), done: b.goals?.done === true, remaining };
}
// Work moved the game forward when any progress number rose.
export function improved(before: Progress, after: Progress): boolean {
    if(before.goalVersion !== 1 || after.goalVersion !== 1) return false;
    return Object.entries(after.goalMetrics ?? {}).some(([key,value]) => Number.isFinite(value)
        && Number.isFinite(before.goalMetrics?.[key]) && value > before.goalMetrics![key]!);
}

const defaultRoot = resolve(import.meta.dir, '../../../..');

export function buildScoreboard(root = defaultRoot, now = Date.now(), fleetDir = resolve(process.env.FLEET_DIR ?? join(root, '.practice', 'fleet-data', 'fleet'))) {
    const actions: GameAction[] = JSON.parse(readFileSync(join(root, 'knowledge', 'actions.json'), 'utf8'));
    const text = corpus(root);
    const owned = ownedNames(join(root, '.practice', 'owned-accounts.json'));
    const statusDir = join(root, '.practice', 'status');
    const local = (existsSync(statusDir) ? readdirSync(statusDir) : []).filter(f => f.endsWith('.json')).flatMap(f => { try { return [JSON.parse(readFileSync(join(statusDir, f), 'utf8'))]; } catch { return []; } })
        .filter(s => typeof s?.name === 'string' && owned.has(s.name.toLowerCase()) && !s.practice
            && typeof s.server === 'string' && s.server.toLowerCase() === 'rs-sdk-demo.fly.dev' && (s.at === undefined || observedAt(s.at, now)));
    const side = mySide(), files = readSnapshotFiles(join(fleetDir, 'snapshots'));
    const ownerOf = ownerOfIn(fleetDir);
    const shared = sideSnapshots(join(fleetDir, 'snapshots'), side, now);
    const validFiles = files.map(s => ({ ...s, accounts: (s.accounts ?? []).filter(a => observedAt(a?.at, now)) }));
    // Ownership chooses the observation before age is considered. An expired owner row must not promote a
    // former side's copy. Local durable achievements remain usable; equal-time rows prefer the local input.
    const selectedLocally = (row: any) => row.side === side && local.some(s => s.name.toLowerCase() === row.name.toLowerCase() && s.at === row.at);
    const canonical = fleetStatusRows(local, validFiles, ownerOf, side);
    const rows = canonical.filter(r => r.name.toLowerCase() !== 'haggis'
        && (selectedLocally(r) || recentObservation(r.at, now, SNAPSHOT_MAX_AGE_MS)));
    const statuses = rows.map(coverageStatus);
    const localStatuses = rows.filter(r => r.side === side).map(coverageStatus);
    const otherStatuses: SideAccount[] = rows.filter(r => r.side !== side).map(r => ({ side: r.side, name: r.name, at: r.at, skills: coverageStatus(r).skills ?? [] }));
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
    const domains = domainStages(actions, text, firedActions(join(root, '.practice', 'action-trace.log')));
    const board = { at: new Date(now).toISOString(), scope: 'Pinned rev 289 content across the fleet; actionsFired counts actions a practice engine ran, actionsNamed is a text match; batch is not tracked yet.',
        totals: { actions: actions.length, actionsFired: domains.reduce((n, d) => n + d.fired, 0), actionsNamed: domains.reduce((n, d) => n + d.named, 0), domains: domains.length, domainsUntouched: domains.filter(d => d.named === 0).length },
        items: itemsHeld(statuses, JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8'))),
        skills: skillBands(statuses), quests: questStages(statuses, practicePass, scriptFolders, quests), domains, statuses: statuses.length,
        fleetSkills: fleetSkills(localStatuses, otherStatuses, side),
        fleet: { side, sides: [...new Set([side, ...rows.map(a => a.side)])].sort(), sharedAccounts: otherStatuses.length, stale: shared.stale, questsUnknown: [...new Set(rows.filter(a => !Array.isArray(a.quests) && !Array.isArray(a.questJournal)).map(a => a.side))].sort() } };
    const goals = buildOwnerGoals({ root, now, statuses: canonical, questNames: quests.filter(q => q.questPoints > 0 && q.name).map(q => q.name!), fleetDir });
    const full = { ...board, goals, progress: progressOf({ ...board, goals }) };
    mkdirSync(join(root, '.practice', 'coordinator'), { recursive: true });
    writeFileSync(join(root, '.practice', 'coordinator', 'scoreboard.json'), JSON.stringify(full, null, 1) + '\n');
    return full;
}

// Rebuilt when older than maxAgeMs; the planner reads it every round.
export function freshScoreboard(root: string, maxAgeMs = 600_000) {
    const file = join(root, '.practice', 'coordinator', 'scoreboard.json');
    try { if (Date.now() - statSync(file).mtimeMs < maxAgeMs) { const saved=JSON.parse(readFileSync(file, 'utf8')); if(saved.goals?.version===1) return saved; } } catch { /* rebuild */ }
    return buildScoreboard(root);
}

export function runCoverageCli() {
    const board = buildScoreboard(), statuses = { length: board.statuses };
    const s = board.skills, q = board.quests;
    console.log(`actions ${board.totals.actions}, fired in practice ${board.totals.actionsFired} (${Math.round(100 * board.totals.actionsFired / board.totals.actions)}%), text match ${board.totals.actionsNamed} (${Math.round(100 * board.totals.actionsNamed / board.totals.actions)}%); domains ${board.totals.domains}, untouched ${board.totals.domainsUntouched}; owned live statuses ${statuses.length}`);
    console.log(`skills at 99 live: ${s.filter(k => k.bestLive >= 99).length}/19; under 40: ${s.filter(k => k.bestLive < 40).map(k => `${k.skill} ${k.bestLive}`).join(', ')}`);
    console.log(`fleet sides ${board.fleet.sides.join(', ')}: ${board.fleet.sharedAccounts} shared accounts, ${board.fleet.stale.length} stale skipped; other side leads: ${board.fleetSkills.filter(k => k.side !== board.fleet.side).map(k => `${k.skill} ${k.best} (${k.side} ${k.account})`).join(', ') || 'none'}`);
    console.log(`items held now: ${board.items.held}/${board.items.items} (tradeable ${board.items.tradeableHeld}/${board.items.tradeable})`);
    console.log(`quests complete live: ${q.liveComplete.length}/${q.journalQuests} journal quests; folders live ${q.folders.filter(f => f.stage === 'live').length}, practice ${q.folders.filter(f => f.stage === 'practice').length}, named ${q.folders.filter(f => f.stage === 'named').length}, none ${q.folders.filter(f => f.stage === 'none').length} of ${q.folders.length}${board.fleet.questsUnknown.length ? `; quests unknown on ${board.fleet.questsUnknown.join(', ')}` : ''}`);
}
