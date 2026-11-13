// The whole PvP bench (or any pattern) in batches that each end well inside 10 minutes. Each case's last wall time
// is kept in .practice/pvp-sweep/elapsed.json (from the AIO_BENCH_RESULT lines of earlier sweeps); a case with no
// time counts as 90 s. Cases are packed longest first onto PARALLEL engines until a batch's estimate (the busiest
// engine) reaches the budget; each batch runs with a hard limit of the budget plus 90 s, and a case it did not reach
// goes into the next batch. Prints one line for each batch and one PVP_SWEEP total.
// Usage: bun scripts/measure/pvp-sweep.ts [pattern] [--parallel 6] [--budget 3.5] [--seed n] [--quick] [--batch k]
// A batch's hard limit is the budget plus 90 s: with the default 3.5 minutes no batch runs past 5 minutes. --batch k
// runs only the k-th batch of the packing (1-based), one bench of 5 minutes or less.
// Default pattern: every pvp: case and every extra: spar, gang, kite, army, team and hunt-trip case (233 cases, about
// 32 minutes in four batches on 4 cores; 10 engines at once are no faster than 6). --quick: every pvp: route case and
// one case of each climb (QUICK_CASES), a few minutes, for the turns of a change; the full sweep before a merge.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { benchCases } from './aio-bench-cases';

const root = resolve(import.meta.dir, '..', '..');
const dir = join(root, '.practice', 'pvp-sweep'), timesFile = join(dir, 'elapsed.json');
const DEFAULT_MS = 90_000;
// One case of each climb of research/pvp-fight-loop.md: the champion against the rival builds and the runner, the
// spear army, the roam's and the hunt's pick, two against two, and the dagger gang.
export const QUICK_CASES = ['extra:spar-rivals-tribrid-snare-sara-x12', 'extra:spar-escape-tribrid-snare-sara-x8', 'extra:army-route-spear-x5',
    'extra:roam-pick', 'extra:hunt-pick', 'extra:team-2v2-multi-x4', 'extra:gang-ganker-x4'] as const;
export const quickPattern = () => new RegExp(`^(pvp:.*|${QUICK_CASES.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

// Longest first onto the least loaded engine; a batch closes when its busiest engine would pass the budget.
export function packBatches(cases: readonly { key: string; ms: number }[], engines: number, budgetMs: number): string[][] {
    const batches: string[][] = [];
    let load = Array.from({ length: engines }, () => 0), batch: string[] = [];
    for (const c of [...cases].sort((a, b) => b.ms - a.ms)) {
        const i = load.indexOf(Math.min(...load));
        if (batch.length && load[i]! + c.ms > budgetMs) { batches.push(batch); batch = []; load = load.map(() => 0); }
        load[load.indexOf(Math.min(...load))]! += c.ms;
        batch.push(c.key);
    }
    if (batch.length) batches.push(batch);
    return batches;
}

if (import.meta.main) {
    const argv = process.argv.slice(2), value = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
    const pattern = argv.includes('--quick') ? quickPattern() : new RegExp(argv.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) ?? '^(pvp:|extra:(spar|gang|kite|army|team|hunt-trip))');
    const engines = Number(value('--parallel') ?? 6), budgetMs = Number(value('--budget') ?? 3.5) * 60_000, seed = value('--seed');
    mkdirSync(dir, { recursive: true });
    const times: Record<string, number> = existsSync(timesFile) ? JSON.parse(readFileSync(timesFile, 'utf8')) : {};
    const keys = benchCases().filter(c => pattern.test(c.key) && !c.known).map(c => c.key);
    // A case's own time leaves out its engine start and the load of the other engines: `_scale` (actual batch time over
    // its estimate, from the last batch; 1.4 at first) turns the case times into batch time.
    let scale = times._scale ?? 1.4;
    let todo = keys.map(key => ({ key, ms: times[key] ?? DEFAULT_MS }));
    const results = new Map<string, boolean>();
    let n = 0;
    const only = value('--batch') ? Number(value('--batch')) : undefined;
    if (only !== undefined) {
        const all = packBatches(todo.map(c => ({ ...c, ms: c.ms * scale })), engines, budgetMs);
        if (!(only >= 1 && only <= all.length)) { console.log(`PVP_SWEEP --batch needs 1..${all.length}`); process.exit(2); }
        todo = todo.filter(c => all[only - 1]!.includes(c.key));
        console.log(`PVP_SWEEP batch ${only} of ${all.length}: ${todo.length} cases`);
    }
    while (todo.length) {
        const [batch] = packBatches(todo.map(c => ({ ...c, ms: c.ms * scale })), engines, budgetMs);
        const estimate = (() => { const load = Array.from({ length: engines }, () => 0); for (const c of todo.filter(c => batch!.includes(c.key)).sort((a, b) => b.ms - a.ms)) load[load.indexOf(Math.min(...load))]! += c.ms; return Math.max(...load); })();
        const re = `^(${batch!.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
        const t0 = Date.now();
        const p = Bun.spawnSync(['timeout', String(Math.round((budgetMs + 90_000) / 1000)), 'bun', 'scripts/measure/aio-practice-bench.ts', re, '--parallel', String(engines), '--no-keep', ...(seed ? ['--seed', seed] : [])],
            // Bench accounts (aiob*) are the local side's (fleet/owners.json names no other), whatever this machine's side.
            { cwd: root, env: { ...process.env, FLEET_SIDE: 'local' }, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
        for (const l of p.stdout.toString().split('\n')) {
            if (!l.startsWith('AIO_BENCH_RESULT ')) continue;
            const r = JSON.parse(l.slice(17)) as { case: string; ok: boolean; elapsedMs: number; result?: string };
            results.set(r.case, r.ok); times[r.case] = r.elapsedMs;
            if (!r.ok) console.log(`FAIL ${r.case} ${String(r.result ?? '').slice(0, 160)}`);
        }
        const missedNow = batch!.filter(k => !results.has(k)).length;
        if (!missedNow && estimate > 0) times._scale = scale = Math.max(1, (Date.now() - t0) / estimate);
        writeFileSync(timesFile, JSON.stringify(times, null, 1));
        const missed = batch!.filter(k => !results.has(k));
        // A case that a batch did not reach goes again; one that two batches missed is counted as failed.
        for (const k of missed) { if ((todo.find(c => c.key === k) as { tries?: number } | undefined)?.tries) results.set(k, false); }
        todo = todo.filter(c => !results.has(c.key)).map(c => missed.includes(c.key) ? { ...c, tries: 1, ms: Math.max(c.ms, budgetMs / 2) } : c);
        console.log(`PVP_SWEEP_BATCH ${++n}: ${batch!.length} cases, ${Math.round((Date.now() - t0) / 1000)} s, ${batch!.length - missed.length} reported`);
    }
    const failed = [...results].filter(([, ok]) => !ok).map(([k]) => k);
    console.log(`PVP_SWEEP ${JSON.stringify({ cases: keys.length, passed: keys.length - failed.length, failed, batches: n })}`);
    process.exitCode = failed.length ? 1 : 0;
}
