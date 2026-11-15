// Fast-fail loops: an account whose job fails again and again within seconds, with the same error. Each run logs in,
// spends no useful tick and logs out, and a standing job starts it again. Such a loop is a fault to fix, not progress.
// failLoops groups the failed results of `.practice/results.jsonl` in a window by account, goal and error (digits
// read as #) and keeps the groups with at least `minRuns` runs, each shorter than `maxRunMs`.
// Usage: bun scripts/fail-loops.ts [hours]   (prints one line for each loop of the main checkout's results)
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

export function loopLines(loops: readonly FailLoop[], limit = 5): string[] {
    return loops.slice(0, limit).map(l => `${l.name} ${l.runs}x ${l.medianSec} s: ${l.goal} | ${l.error}`);
}

if (import.meta.main) {
    const hours = Number(process.argv[2] ?? 2);
    // The main checkout runs the fleet and holds the results: the first worktree of `git worktree list`, as in now.ts.
    const here = resolve(import.meta.dir, '..');
    const list = Bun.spawnSync(['git', '-C', here, 'worktree', 'list', '--porcelain'], { stdout: 'pipe', stderr: 'ignore', windowsHide: true }).stdout.toString();
    const main = resolve(/^worktree (.+)$/m.exec(list)?.[1] ?? here);
    const file = process.env.RESULTS_FILE ?? join(main, '.practice', 'results.jsonl');
    console.log(`results ${file}`);
    const loops = failLoops(readRecentResults(file, 40_000_000), Date.now(), { windowMs: hours * 3600_000 });
    if (!loops.length) console.log(`no fast-fail loops in ${hours} h`);
    for (const line of loopLines(loops, 50)) console.log(line);
}
