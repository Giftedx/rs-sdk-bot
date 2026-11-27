// Fast-fail loops: an account whose job fails again and again within seconds, with the same error. Each run logs in,
// spends no useful tick and logs out, and a standing job starts it again. Such a loop is a fault to fix, not progress.
// failLoops groups the failed results of `.practice/results.jsonl` in a window by account, goal and error (digits
// read as #) and keeps the groups with at least `minRuns` runs, each shorter than `maxRunMs`.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

export type ResultRow = { started?: number; at?: number; name?: string; goal?: string; ok?: boolean; text?: string };
export type FailLoop = { name: string; goal: string; error: string; runs: number; medianSec: number; lastAt: number };
export const LOOP_WINDOW_MS = 2 * 3600_000, LOOP_MIN_RUNS = 3, LOOP_MAX_RUN_MS = 60_000;

// The failure text with its numbers as #, from the first word after "fail", cut to 90 characters.
export function errorKey(text: string): string {
    return text.replace(/^(?:RESULT )?fail\s+/, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 90);
}

export function failLoops(rows: readonly ResultRow[], now: number, o: { windowMs?: number; minRuns?: number; maxRunMs?: number } = {}): FailLoop[] {
    const windowMs = o.windowMs ?? LOOP_WINDOW_MS, minRuns = o.minRuns ?? LOOP_MIN_RUNS, maxRunMs = o.maxRunMs ?? LOOP_MAX_RUN_MS;
    const groups = new Map<string, { name: string; goal: string; error: string; secs: number[]; lastAt: number }>();
    for (const r of rows) {
        if (r.ok !== false || typeof r.name !== 'string' || !Number.isFinite(r.at) || !Number.isFinite(r.started)) continue;
        if (now - r.at! > windowMs || r.at! - r.started! > maxRunMs || r.at! < r.started!) continue;
        const error = errorKey(String(r.text ?? '')), goal = String(r.goal ?? '').replace(/\d+/g, '#').slice(0, 50);
        const key = `${r.name.toLowerCase()}|${goal}|${error}`;
        const g = groups.get(key) ?? { name: r.name, goal, error, secs: [], lastAt: 0 };
        g.secs.push((r.at! - r.started!) / 1000); g.lastAt = Math.max(g.lastAt, r.at!); groups.set(key, g);
    }
    return [...groups.values()].filter(g => g.secs.length >= minRuns)
        .map(g => { const s = [...g.secs].sort((a, b) => a - b); return { name: g.name, goal: g.goal, error: g.error, runs: s.length, medianSec: Math.round(s[Math.floor(s.length / 2)]!), lastAt: g.lastAt }; })
        .sort((a, b) => b.runs - a.runs || b.lastAt - a.lastAt);
}

// The rows of the last `bytes` of the file: the window holds a few hours, and the file grows for good.
export function readRecentResults(file: string, bytes = 4_000_000): ResultRow[] {
    if (!existsSync(file)) return [];
    const size = statSync(file).size, start = Math.max(0, size - bytes), buf = Buffer.alloc(size - start), fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.flatMap(l => { try { return l.trim() ? [JSON.parse(l) as ResultRow] : []; } catch { return []; } });
}

// Cross-account faults: one error (numbers as #) that ends short failed runs of many accounts in a window, whatever the
// goal. A fault of shared code repeats on each account that the planner sends, so a per-account loop can miss it: live,
// "quest-sweep tree missing #:# (unsold; others in shops)" ended 17 runs of 10 accounts in 24 h, none 3 times on one.
export type CrossAccountFault = { error: string; runs: number; accounts: number; goals: number; lostSec: number; lastAt: number };
export const CROSS_WINDOW_MS = 24 * 3600_000, CROSS_MIN_ACCOUNTS = 3, CROSS_MAX_RUN_MS = 120_000;

export function crossAccountFaults(rows: readonly ResultRow[], now: number, o: { windowMs?: number; minAccounts?: number; maxRunMs?: number } = {}): CrossAccountFault[] {
    const windowMs = o.windowMs ?? CROSS_WINDOW_MS, minAccounts = o.minAccounts ?? CROSS_MIN_ACCOUNTS, maxRunMs = o.maxRunMs ?? CROSS_MAX_RUN_MS;
    const groups = new Map<string, { runs: number; accounts: Set<string>; goals: Set<string>; lostMs: number; lastAt: number }>();
    for (const r of rows) {
        if (r.ok !== false || typeof r.name !== 'string' || !Number.isFinite(r.at) || !Number.isFinite(r.started)) continue;
        if (now - r.at! > windowMs || r.at! - r.started! > maxRunMs || r.at! < r.started!) continue;
        const error = errorKey(String(r.text ?? ''));
        const g = groups.get(error) ?? { runs: 0, accounts: new Set<string>(), goals: new Set<string>(), lostMs: 0, lastAt: 0 };
        g.runs++; g.accounts.add(r.name.toLowerCase()); g.goals.add(String(r.goal ?? '').replace(/\d+/g, '#'));
        g.lostMs += r.at! - r.started!; g.lastAt = Math.max(g.lastAt, r.at!); groups.set(error, g);
    }
    return [...groups].filter(([, g]) => g.accounts.size >= minAccounts)
        .map(([error, g]) => ({ error, runs: g.runs, accounts: g.accounts.size, goals: g.goals.size, lostSec: Math.round(g.lostMs / 1000), lastAt: g.lastAt }))
        .sort((a, b) => b.runs - a.runs || b.lastAt - a.lastAt);
}

export function crossAccountLines(faults: readonly CrossAccountFault[], limit = 5): string[] {
    return faults.slice(0, limit).map(f => `${f.runs}x on ${f.accounts} accounts, ${f.goals} goals, ${f.lostSec} s in runs: ${f.error}`);
}

export function loopLines(loops: readonly FailLoop[], limit = 5): string[] {
    return loops.slice(0, limit).map(l => `${l.name} ${l.runs}x ${l.medianSec} s: ${l.goal} | ${l.error}`);
}
