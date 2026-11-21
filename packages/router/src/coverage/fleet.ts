import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalSnapshots, ownerOfIn, readSnapshotFiles } from '../../../core/src/fleet-snapshots';
import { BANDS, SKILLS, type Held, type SideAccount, type Stage, type Status } from './model';

// Items any owned account holds now: bank, pack or worn (an item used up earlier is not counted).
export function itemsHeld(statuses: Status[], items: { id: number; tradeable?: boolean }[]) {
    const held = new Set(statuses.flatMap(s => [...(s.bank ?? []), ...(s.inventory ?? []), ...(s.equipment ?? [])]).map(i => i.baseId ?? i.id).filter((n): n is number => Number.isInteger(n)));
    const tradeable = items.filter(i => i.tradeable);
    return { items: items.length, held: items.filter(i => held.has(i.id)).length, tradeable: tradeable.length, tradeableHeld: tradeable.filter(i => held.has(i.id)).length };
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
export const SNAPSHOT_MAX_AGE_MS = (Number(process.env.FLEET_SNAPSHOT_MAX_AGE_H) || 24) * 3_600_000;
export const observedAt = (at: unknown, now: number) => typeof at === 'number' && Number.isFinite(at) && at > 0 && at <= now;
export const recentObservation = (at: unknown, now: number, maxAgeMs: number) => observedAt(at, now) && now - (at as number) <= maxAgeMs;
// Unknown containers stay unknown; only positive observed units can establish collection coverage.
function containerRows(raw: unknown): Held | null {
    return Array.isArray(raw) && raw.every(i => i && Number.isSafeInteger(i.baseId ?? i.id) && (i.baseId ?? i.id) >= 0
        && Number.isSafeInteger(i.count) && i.count > 0) ? raw : null;
}
export function coverageStatus(row: any): Status {
    const quests = Array.isArray(row.questJournal) ? row.questJournal : Array.isArray(row.quests)
        ? row.quests.map((q: any) => typeof q === 'string' ? { name: q, state: 'complete' } : q) : [];
    return { name: row.name, server: row.server, at: row.at,
        skills: (Array.isArray(row.skills) ? row.skills : []).filter((k: any) => typeof k?.name === 'string' && Number.isInteger(k.level) && k.level >= 1 && k.level <= 99),
        quests: quests.filter((q: any) => typeof q?.name === 'string' && ['complete', 'started', 'not started', 'unknown'].includes(q.state)),
        bank: containerRows(row.bank), inventory: containerRows(row.inventory), equipment: containerRows(row.equipment) };
}
export function sideSnapshots(dir: string, side: string, now = Date.now(), maxAgeMs = SNAPSHOT_MAX_AGE_MS, server = 'rs-sdk-demo.fly.dev') {
    const accounts: SideAccount[] = [], stale: string[] = [];
    if (!existsSync(dir)) return { accounts, stale };
    // One canonical row per account (packages/core/src/fleet-snapshots.ts); an account this side owns now is read from
    // its status files, even when another side's last snapshot still lists it.
    const ownerOf = ownerOfIn(dirname(dir));
    const files = readSnapshotFiles(dir).map(snap => ({ ...snap, accounts: (snap.accounts ?? []).filter(a => !a?.practice && observedAt(a?.at, now)) }));
    for (const snap of canonicalSnapshots(files, ownerOf)) {
        if (snap.side === side) continue;
        for (const a of snap.accounts ?? []) {
            if (typeof a?.name !== 'string' || a.name.toLowerCase() === 'haggis' || String(a.server).toLowerCase() !== server || ownerOf(a.name) === side) continue;
            const at = a.at;
            if (now - at > maxAgeMs) { stale.push(`${snap.side}:${a.name}`); continue; }
            const projected = coverageStatus(a);
            accounts.push({ side: snap.side, name: a.name, at, skills: projected.skills ?? [],
                bank: projected.bank, inventory: projected.inventory, equipment: projected.equipment,
                ...(Array.isArray(a.quests) ? { quests: a.quests.filter((q: any) => typeof q === 'string') } : {}) });
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
const NON_RESULT_DIRS = new Set(['session-lifecycle', 'coordinator', 'deliveries', 'fleet-data', 'status', 'bots', 'saves', 'runs', 'traces', 'trace', 'profiles', 'output', 'tmp', '.git']);
// Quest folders with a passing run. .practice/results.jsonl names the script in goal; a task folder's results.jsonl names
// it in quest, with or without the quest- prefix.
export function practicePasses(practice: string, byScript: Map<string, string>): Set<string> {
    const passes = new Set<string>();
    if (!existsSync(practice)) return passes;
    const files = [join(practice, 'results.jsonl'), ...readdirSync(practice, { withFileTypes: true }).filter(e => e.isDirectory() && !NON_RESULT_DIRS.has(e.name)).map(e => join(practice, e.name, 'results.jsonl'))];
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

// The accounts whose live statuses count: the PC's verified-login registry (packages/core/src/tradeguard.ts writes it after
// a live login), without the protected main account. A machine with no registry yet (a fresh cloud container) counts none,
// and the scoreboard still reads the shared side snapshots.
export function ownedNames(file: string): Set<string> {
    let entries: Record<string, unknown> = {};
    try { entries = JSON.parse(readFileSync(file, 'utf8')); } catch { /* no verified login on this machine */ }
    const owned = new Set(Object.keys(entries).map(n => n.toLowerCase()));
    owned.delete('haggis');
    return owned;
}
