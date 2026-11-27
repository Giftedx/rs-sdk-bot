// No-op runs: a job that ends ok but changes nothing on the account (no XP, no item, no position, no quest stage).
// Each such run is a login for nothing, and a standing job or a brain pass that plans the same job starts it again.
// The swarm notes each run end here (packages/fleet/src/swarm.ts). After NOOP_RUN_LIMIT no-op runs in a row of one
// job, the account holds that job until its status shows a changed state. The records live in
// .practice/live/noop-runs.json; tools/now.ts and tools/fail-loops.ts list them.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson } from './plan-lock';

export const NOOP_RUN_LIMIT = 2;
export const NOOP_RUNS_FILE = 'noop-runs.json';

// The account state that a useful run changes, read from its status file.
export interface RunFingerprint {
    readonly xp: string;
    readonly items: string;
    readonly pos: string;
    readonly quests: string;
}

export interface NoOpRecord {
    readonly account: string;
    // The job's mission signature (swarm.ts missionSignature): one script, argument list and environment.
    readonly signature: string;
    // A short name of the job for the log and the report lines.
    readonly job: string;
    readonly runs: number;
    readonly fingerprint: RunFingerprint;
    readonly at: number;
}

const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

function containerText(raw: unknown): string {
    if (!Array.isArray(raw)) return '';
    const counts = new Map<number, number>();
    for (const it of raw) {
        if (!isRecord(it)) continue;
        const id = Number(it.baseId ?? it.id), n = Number(it.count ?? 1);
        if (!Number.isFinite(id) || !Number.isFinite(n) || n <= 0) continue;
        counts.set(id, (counts.get(id) ?? 0) + n);
    }
    return [...counts].sort(([a], [b]) => a - b).map(([id, n]) => `${id}:${n}`).join(',');
}

function sortedEntries(raw: unknown): string {
    return isRecord(raw) ? Object.entries(raw).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',') : '';
}

// The fingerprint of a status file, or undefined when the file holds no position or no skills (no proof of a state).
export function statusFingerprint(status: unknown): RunFingerprint | undefined {
    if (!isRecord(status) || !isRecord(status.pos) || !Array.isArray(status.skills)) return undefined;
    const p = status.pos;
    if (![p.x, p.z, p.level].every(Number.isFinite)) return undefined;
    const xp = status.skills
        .filter((s: unknown) => isRecord(s) && typeof s.name === 'string')
        .map((s: Record<string, any>) => `${s.name}:${Number(s.xp ?? s.experience ?? 0)}`)
        .sort()
        .join(',');
    const items = [containerText(status.inventory), containerText(status.equipment ?? status.worn), containerText(status.bank)].join('|');
    const facts = isRecord(status.guildFacts) ? status.guildFacts : {};
    const quests = [sortedEntries(facts.questStages), sortedEntries(facts.varps), sortedEntries(status.quests)].join('|');
    return { xp, items, pos: `${p.x},${p.z},${p.level}`, quests };
}

export function sameFingerprint(a: RunFingerprint, b: RunFingerprint): boolean {
    return a.xp === b.xp && a.items === b.items && a.pos === b.pos && a.quests === b.quests;
}

export function noOpRunsFile(liveDir: string): string {
    return join(liveDir, NOOP_RUNS_FILE);
}

export function readNoOpRuns(file: string): NoOpRecord[] {
    if (!existsSync(file)) return [];
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        return Array.isArray(raw)
            ? raw.filter((r): r is NoOpRecord => isRecord(r) && typeof r.account === 'string' && typeof r.signature === 'string'
                && Number.isSafeInteger(r.runs) && isRecord(r.fingerprint) && Number.isFinite(r.at))
            : [];
    } catch {
        return [];
    }
}

// One record per account: the last job that ended and its run of no-op ends.
export class NoOpRunGuard {
    private readonly records = new Map<string, NoOpRecord>();

    constructor(private readonly file?: string, private readonly limit = NOOP_RUN_LIMIT) {
        if (file) for (const r of readNoOpRuns(file)) this.records.set(r.account.toLowerCase(), r);
    }

    // Notes the end of one run. `before` and `after` are the status fingerprints at its start and end. Returns the
    // record when this end makes the job held (the limit-th no-op end in a row), otherwise undefined.
    note(run: {
        readonly account: string;
        readonly signature: string;
        readonly job: string;
        readonly ok: boolean;
        readonly before?: RunFingerprint;
        readonly after?: RunFingerprint;
        readonly now: number;
    }): NoOpRecord | undefined {
        const key = run.account.toLowerCase();
        const noOp = run.ok && !!run.before && !!run.after && sameFingerprint(run.before, run.after);
        if (!noOp) {
            if (this.records.delete(key)) this.save();
            return undefined;
        }
        const prev = this.records.get(key);
        const runs = prev && prev.signature === run.signature && sameFingerprint(prev.fingerprint, run.after!) ? prev.runs + 1 : 1;
        const rec: NoOpRecord = { account: run.account, signature: run.signature, job: run.job, runs, fingerprint: run.after!, at: run.now };
        this.records.set(key, rec);
        this.save();
        return runs === this.limit ? rec : undefined;
    }

    // The hold reason of the job for the account, or undefined when it may start. A changed state ends the hold.
    hold(account: string, signature: string, current: RunFingerprint | undefined): string | undefined {
        const key = account.toLowerCase();
        const rec = this.records.get(key);
        if (!rec || rec.runs < this.limit || rec.signature !== signature) return undefined;
        if (current && !sameFingerprint(rec.fingerprint, current)) {
            this.records.delete(key);
            this.save();
            return undefined;
        }
        return noOpHoldReason(rec);
    }

    list(): NoOpRecord[] {
        return [...this.records.values()];
    }

    private save(): void {
        if (!this.file) return;
        try { atomicJson(this.file, this.list()); } catch { /* the guard holds in memory; the report line misses it */ }
    }
}

export function noOpHoldReason(rec: NoOpRecord): string {
    return `ended: no-op ${rec.runs} runs in a row (no XP, item, position or quest change) of ${rec.job}; held until the account state changes`;
}

// The report lines of the accounts with repeated no-op runs, most runs first.
export function noOpLines(records: readonly NoOpRecord[], limit = 5, min = NOOP_RUN_LIMIT): string[] {
    return records.filter(r => r.runs >= min).sort((a, b) => b.runs - a.runs || b.at - a.at).slice(0, limit)
        .map(r => `${r.account} ${r.runs}x ok with no change at ${r.fingerprint.pos}: ${r.job}`);
}
