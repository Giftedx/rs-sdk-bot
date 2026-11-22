import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gateView, requestEvidence } from '../../evidence';
import { applyLevers, haggisActivities, haggisTravel, loadSnapshot, overallRequirementsFor, scheduleOverall, TRICKS } from '../../../planner/src/haggis';
import { append, cached, FILES, NL, practice, root, tailJsonl } from '../config';
import { ALL_BOARDS } from '../world';

// ---------- swarm controller (scripts/swarm.ts) ----------
type SwarmJob = { account: string; script: string; role: string; goal: string; enabled: boolean; repeat: boolean; note: string; state: string; since: number | null };
type Swarm = { at: number; freeGB: number; running: number; externalRunning?: number; pendingStartup?: number; pendingReserveGB?: number; minFreeGB?: number; maxBots: number; jobs: SwarmJob[] };
const swarm = () => cached<Swarm | null>(FILES.swarm, t => JSON.parse(t) as Swarm, null);

// ---------- owner request queue (research/owner-requests.md) ----------
type Req = { id: string; date: string; request: string; status: string; kind: string; evidence: string; next: string; section: string; line: number };
const KINDS: [RegExp, string][] = [[/^done/i, 'DONE'], [/^partial/i, 'PARTIAL'], [/^not started/i, 'NOT STARTED'], [/^blocked/i, 'BLOCKED'], [/^new/i, 'NEW'], [/^rule/i, 'RULE'], [/^dropped/i, 'DONE'], [/^(open|in progress)/i, 'PARTIAL']];
const kindOf = (status: string) => KINDS.find(([re]) => re.test(status))?.[1] ?? status.toUpperCase();
// Every numbered table row of owner-requests.md. A table's first row is its header only when a separator row
// follows it; a row appended under a paragraph (no header of its own) is read by position: # | request | status | ...
// One id can appear more than once (a later correction): the row furthest down the file wins.
function parseRequests(text: string): Req[] {
    const byId = new Map<string, Req>();
    let section = '', header: string[] | null = null;
    const lines = text.split(NL);
    const cellsOf = (line: string) => line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map(c => c.trim());
    const isSep = (line: string | undefined) => !!line && line.trim().startsWith('|') && cellsOf(line.trim()).every(c => /^:?-+:?$/.test(c));
    lines.forEach((raw, i) => {
        const line = raw.trim();
        if (line.startsWith('#')) { section = line.replace(/^#+\s*/, ''); header = null; return; }
        if (!line.startsWith('|')) { header = null; return; }
        if (isSep(line)) return;
        const cells = cellsOf(line);
        if (!header && isSep(lines[i + 1])) { header = cells.map(c => c.toLowerCase()); return; }
        if (!/^\d+$/.test(cells[0] ?? '')) return;
        let r: Req;
        if (header) {
            const h = header;
            const col = (re: RegExp) => { const j = h.findIndex(x => re.test(x)); return j >= 0 ? cells[j] ?? '' : ''; };
            r = { id: cells[0]!, date: col(/^date$/), request: col(/^request/), status: col(/^status$/), kind: '', evidence: col(/^evidence/), next: col(/^next/), section, line: i + 1 };
        } else {
            const si = cells.findIndex((c, j) => j > 0 && KINDS.some(([re]) => re.test(c)));
            if (si < 0) return;
            r = { id: cells[0]!, date: '', request: cells.slice(1, si).find(c => c) ?? '', status: cells[si]!, kind: '', evidence: cells[si + 1] ?? '', next: '', section, line: i + 1 };
        }
        if (!r.status) return;
        r.kind = kindOf(r.status);
        byId.delete(r.id); // re-insert so file order = position of the latest row
        byId.set(r.id, r);
    });
    return [...byId.values()];
}
// The newest changes to the request rows: added or changed numbered rows in the last commits of the file and in the
// working tree, newest first. Read with git, cached on the file's mtime.
type ReqChange = { id: string; kind: string; request: string; at: number; where: string };
let changesCache: { mtime: number; value: ReqChange[] } = { mtime: -1, value: [] };
function requestChanges(all: Req[], mtime: number): ReqChange[] {
    if (changesCache.mtime === mtime) return changesCache.value;
    const out: ReqChange[] = [], seen = new Set<string>();
    const take = (diff: string, at: number, where: string) => {
        for (const l of diff.split(NL).reverse()) {
            const m = l.match(/^\+\|\s*(\d+)\s*\|/);
            if (!m || seen.has(m[1]!)) continue;
            const r = all.find(x => x.id === m[1]);
            if (!r) continue;
            seen.add(m[1]!);
            out.push({ id: r.id, kind: r.kind, request: r.request, at, where });
        }
    };
    try {
        const rel = 'research/owner-requests.md';
        const wt = Bun.spawnSync(['git', 'diff', '-U0', '--', rel], { cwd: root, stdout: 'pipe', stderr: 'ignore', windowsHide: true }).stdout.toString();
        if (wt.trim()) take(wt, mtime, 'uncommitted');
        const log = Bun.spawnSync(['git', 'log', '-n', '8', '-p', '-U0', '--format=@@C %h %ct', '--', rel], { cwd: root, stdout: 'pipe', stderr: 'ignore', windowsHide: true }).stdout.toString();
        for (const part of log.split(/^@@C /m).filter(Boolean)) {
            const [head, ...rest] = part.split(NL);
            const [hash, ct] = head!.split(' ');
            take(rest.join(NL), Number(ct) * 1000, hash!);
            if (out.length >= 3) break;
        }
    } catch { /* no git */ }
    changesCache = { mtime, value: out.slice(0, 3) };
    return changesCache.value;
}
function requests() {
    const doc=cached(FILES.requests,text=>({all:parseRequests(text),text}),{all:[] as Req[],text:''});
    const all=doc.all;
    const counts: Record<string, number> = {};
    for (const r of all) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    // File order is priority order ("most important to the Haggis goal first", then later additions).
    const open = all.filter(r => !['DONE', 'RULE'].includes(r.kind));
    let mtime = 0; try { mtime = statSync(FILES.requests).mtimeMs; } catch { /* missing */ }
    const evidence=requestEvidence(doc.text);
    return { counts, open, total: all.length, mtime, changes: requestChanges(all, mtime), ...evidence };
}

// ---------- Haggis plan: research/haggis-run.md board table if it has one, else haggis-plan.json ----------
const PLAN_STATES = ['not started', 'method known', 'prep needed', 'rehearsed'];
function planFromRun(text: string): Record<string, { status: string; note: string }> {
    const out: Record<string, { status: string; note: string }> = {};
    let header: string[] | null = null;
    for (const raw of text.split(NL)) {
        const line = raw.trim();
        if (!line.startsWith('|')) { header = null; continue; }
        const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map(c => c.trim());
        if (cells.every(c => /^:?-+:?$/.test(c))) continue;
        if (!header) { header = cells.map(c => c.toLowerCase()); continue; }
        const board = ALL_BOARDS.find(b => cells.some(c => c.replace(/\*|`/g, '').toLowerCase() === b.toLowerCase() || (b === 'Runite' && /lava maze/i.test(c))));
        if (!board) continue;
        const si = header.findIndex(h => /status|state/.test(h));
        const statusText = (si >= 0 ? cells[si] : cells.join(' ')) ?? '';
        const status = PLAN_STATES.slice().reverse().find(s => statusText.toLowerCase().includes(s)) ?? (si >= 0 ? statusText.toLowerCase() : 'not started');
        const ni = header.findIndex(h => /method|plan|note/.test(h));
        out[board] = { status, note: (ni >= 0 ? cells[ni] : '') ?? '' };
    }
    return out;
}
function haggisPlan() {
    const run = existsSync(FILES.haggisRun) ? cached(FILES.haggisRun, planFromRun, {}) : {};
    const json = cached<{ boards: { board: string; status: string; note?: string }[] }>(FILES.haggisPlan, t => JSON.parse(t), { boards: [] });
    const fromRun = Object.keys(run).length > 0;
    return {
        source: fromRun ? 'research/haggis-run.md' : 'packages/dashboard/haggis-plan.json',
        boards: ALL_BOARDS.map(b => {
            const r = (run as Record<string, { status: string; note: string }>)[b], j = json.boards.find(x => x.board === b);
            return { board: b, status: r?.status ?? j?.status ?? 'not started', note: r?.note ?? j?.note ?? '' };
        }),
    };
}

// ---------- main account race: the planner's schedule against the live #1 deadlines ----------
// One source of truth: exactly the options of `bun packages/planner/src/haggis-cli.ts research/hiscores-live.json`,
// scenario a (all techniques eligible, travel on). The headline is the realistic plan; the
// floor plan is shown next to it.
const LIVE_HISCORES = join(root, 'research', 'hiscores-live.json');
const BOARDS_FILE = join(root, 'packages', 'planner', 'src', 'haggis-boards.json');
const TRAVEL_FILE = join(root, 'packages', 'planner', 'src', 'haggis-travel.json');
const GATE_FILE = join(practice, 'haggis-go.json');
const GAP_FILE = join(practice, 'gap-history.jsonl');
// `m: 'cli'` marks points made with the CLI's options; older points used another model (no travel) and are not shown.
type GapRec = { at: number; gap: number | null; floorGap?: number | null; wins: number; floorWins: number; m?: string };
const gapHistory: GapRec[] = tailJsonl<GapRec>(GAP_FILE, 300).filter(g => g.m === 'cli');
let raceCache: { key: string; value: any } | null = null;
const mt = (f: string) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
function race() {
    const key = [LIVE_HISCORES, BOARDS_FILE, TRAVEL_FILE].map(mt).join('|');
    if (!mt(LIVE_HISCORES)) return null;
    if (raceCache?.key === key) return raceCache.value;
    try {
        const boards = loadSnapshot(LIVE_HISCORES);
        const acts = haggisActivities(), travel = haggisTravel();
        const run = (mode: 'floor' | 'realistic') => scheduleOverall(boards, acts, { travel, mode, tricks: new Set(TRICKS) });
        const fl = run('floor'), re = run('realistic');
        // Evidence of the inputs behind each board: the activities (levers applied) that serve it. Overall: all of them.
        const live = applyLevers(acts, {});
        const ev = (id: string) => {
            const l = live.filter(a => id === 'overall' || a.serves.includes(id as any)).map(a => (a.ticks ?? a.train?.xpPerTick)?.evidence ?? a.evidence);
            return { measured: l.filter(e => e === 'MEASURED').length, codeRead: l.filter(e => e === 'CODE-READ').length, estimate: l.filter(e => e === 'ESTIMATE').length };
        };
        const rows = re.boards.map(r => {
            const f = fl.boards.find(x => x.id === r.id)!, b = boards.find(x => x.id === r.id)!;
            const label = r.label.replace(/\s*\(.*\)$/, ''), holder = (r.label.match(/\(#1 ([^,)]+)/) ?? [])[1] ?? null;
            const rule = b.rule.kind === 'clock' ? { kind: 'clock' } : b.rule.kind === 'qp' ? { kind: 'qp', points: b.rule.leaderPoints, ticks: b.rule.leaderTicks } : { kind: 'value', note: b.rule.note };
            return { id: r.id, label, holder, deadline: r.deadline, rule, evidence: ev(r.id), real: { finish: r.finish, slack: r.slack, status: r.status }, floor: { finish: f.finish, slack: f.slack, status: f.status } };
        });
        const overall = rows.find(r => r.id === 'overall');
        // The board that finishes last in the realistic plan (Overall aside) and the activity that finishes it.
        const clock = rows.filter(r => r.rule.kind === 'clock' && r.id !== 'overall' && r.real.finish != null);
        const lastB = clock.reduce((a, r) => (!a || r.real.finish! > a.real.finish! ? r : a), null as (typeof rows)[number] | null);
        const lastAct = lastB ? [...re.order].reverse().find(p => live.find(a => a.id === p.id)?.serves.includes(lastB.id as any)) : null;
        const n = (l: typeof rows, k: 'real' | 'floor') => l.filter(r => r[k].status === 'WIN').length;
        const value = {
            supplies: re.overallFinish === null ? null : overallRequirementsFor(acts, {travel, mode:'realistic', tricks:new Set(TRICKS)}, re)
                .supplies.map(({consumers,...supply}) => supply),
            rows, unmeasured: (readFileSync(BOARDS_FILE, 'utf8').match(/"evidence":\s*"(ESTIMATE|CODE-READ)"/g) ?? []).length,
            wins: n(rows, 'real'), floorWins: n(rows, 'floor'), gap: overall?.real.slack ?? null, floorGap: overall?.floor.slack ?? null,
            qpEnd: { realistic: re.qp, floor: fl.qp },
            last: lastB ? { board: lastB.label, finish: lastB.real.finish, slack: lastB.real.slack, activity: lastAct?.label ?? null } : null,
            at: Date.now(), source: 'research/hiscores-live.json', sourceAt: Date.parse(JSON.parse(readFileSync(LIVE_HISCORES,'utf8')).takenAt)||0,
            options: 'Planner CLI scenario a. Travel on. Supplies require acquisition. Relaxed scheduling deadlines: ' + (re.boards.filter(b => b.sacrificed).map(b => b.id).join(', ') || 'none'),
        };
        raceCache = { key, value };
        const last = gapHistory[gapHistory.length - 1];
        if (!last || last.gap !== value.gap || last.floorGap !== value.floorGap || last.wins !== value.wins) {
            const rec = { at: Date.now(), gap: value.gap, floorGap: value.floorGap, wins: value.wins, floorWins: value.floorWins, m: 'cli' };
            gapHistory.push(rec); if (gapHistory.length > 300) gapHistory.shift();
            append(GAP_FILE, rec);
        }
        return value;
    } catch (e) { const value = { error: String(e) }; raceCache = { key, value }; return value; }
}
// Readiness report only: no --authorize here. A dashboard refresh must never authorize login.
async function runGate() {
    if (process.env.DASH_READ_ONLY === '1') return;
    try { await Bun.spawn(['bun', join(root, 'scripts', 'haggis-gate.ts')], { stdout: 'ignore', stderr: 'ignore', cwd: root, windowsHide: true }).exited; } catch { /* next round */ }
}
// Gate details name files by absolute path; the page shows only the file name.
const gateReport = (file:string) => gateView(cached<{ go: boolean; at: number; gates: { name: string; pass: boolean; detail: string }[] } | null>(file, t => {
    const g = JSON.parse(t);
    for (const x of g?.gates ?? []) x.detail = String(x.detail ?? '').replace(/[A-Za-z]:[\\/](?:[^\s\\/]+[\\/])*/g, '');
    return g;
}, null));
const gates = () => { const authorization=gateReport(GATE_FILE); return authorization.go?authorization:gateReport(join(practice,'haggis-readiness.json')); };

export {
    gapHistory,
    gates,
    haggisPlan,
    race,
    requests,
    runGate,
    swarm,
    type SwarmJob,
};
