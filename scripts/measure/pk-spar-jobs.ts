// A list of spar batches, one at a time, with one result line each. A job is
//   <case>|<profile a>|<profile b>|<swap 0 or 1>|<seed>[|<options a as JSON>[|<options b as JSON>]]
// Each batch runs on its own engine (ports from BENCH_PORT_BASE, default 21700) in up to 8 worker processes, fewer
// where the free memory is short (procsFor). A batch of 12 full fights in 8 processes takes about 35 s; keep a list
// to 4 to 8 batches. A seed gives one fight only at one number of processes.
// The tool holds .practice/pk-climb-pause of the main checkout while its batches run, so pk-spar-matrix.ts and
// pk-spar-climb.ts of other sessions wait. Before the list and after each second batch it removes the file and gives
// a waiting matrix or climb its turn. It runs the bench itself and never waits on that file.
// The result line of a duel case also counts the kills of the first kit of each pair: a duel case places its kits by
// two pairs at a time (pairs 0, 1 the first kit on side A; pairs 2, 3 on side B).
// Usage: bun scripts/measure/pk-spar-jobs.ts "extra:spar-mirror-snare-x12|champion|champion|1|1|{\"specBelow\":0.5}" ...
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { resolve } from 'node:path';

export type SparJob = { key: string; a: string; b: string; swap: boolean; seed: string; optsA?: string; optsB?: string };
export function parseJob(job: string): SparJob {
    const [key, a, b, swap, seed, optsA, optsB] = job.split('|');
    if (!key || !a || !b || !seed) throw new Error(`job needs case|a|b|swap|seed: ${job}`);
    return { key, a, b, swap: swap === '1', seed, ...(optsA ? { optsA } : {}), ...(optsB ? { optsB } : {}) };
}
// The worker processes of one batch by the free memory: the engine and the bench take about 1.5 GB, each worker process
// about 0.55 GB (a batch in 8 processes took the free memory from 8.7 GB to 3.0 GB), and 4 GB stay free. 0: do not start.
export function procsFor(freeGB: number): number {
    return Math.max(0, Math.min(8, Math.floor((freeGB - 4 - 1.5) / 0.55)));
}
// Kills and deaths of the first kit of each pair of a duel case, from the scores of the batch.
export function firstKitTally(scores: readonly number[]): { kills: number; deaths: number } {
    const flipped = (i: number) => (i >> 1) % 2 === 1;
    return { kills: scores.filter((s, i) => (flipped(i) ? s <= -200 : s >= 200)).length, deaths: scores.filter((s, i) => (flipped(i) ? s >= 200 : s <= -200)).length };
}

if (import.meta.main) {
    const root = resolve(import.meta.dir, '..', '..');
    const main = /[\\/]\.claude[\\/]worktrees[\\/]/.test(root) ? resolve(root, '..', '..', '..') : root;
    const pause = resolve(main, '.practice/pk-climb-pause'), dir = resolve(root, '.practice/pk-spar');
    mkdirSync(dir, { recursive: true });
    const count = (pattern: string) => Number(Bun.spawnSync(['powershell', '-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | Where-Object { $_.CommandLine -match '${pattern}' -and $_.CommandLine -notmatch 'pk-spar-jobs' }).Count`], { windowsHide: true }).stdout.toString().trim() || 0);
    const benches = () => count('aio-practice-bench');
    // With the file absent, a waiting matrix or climb looks each 30 s: give it up to 75 s to start its bench, then
    // wait for that bench to end.
    const yieldTurn = async () => {
        if (count('pk-spar-matrix|pk-spar-climb') > 0) for (let i = 0; i < 25 && benches() === 0; i++) await Bun.sleep(3000);
        for (let i = 0; i < 200 && benches() > 0; i++) await Bun.sleep(3000);
    };
    const jobs = process.argv.slice(2).map(parseJob), t0 = Date.now();
    await yieldTurn();
    console.log(`JOBS_START waited ${Math.round((Date.now() - t0) / 1000)} s for other benches`);
    writeFileSync(pause, '');
    try {
        for (const [n, job] of jobs.entries()) {
            if (n > 0 && n % 2 === 0 && count('pk-spar-matrix|pk-spar-climb') > 0) { rmSync(pause, { force: true }); await yieldTurn(); writeFileSync(pause, ''); }
            const out = resolve(dir, `job-${process.argv[2 + n]!.replace(/\W+/g, '_').slice(0, 120)}.json`), t = Date.now();
            // Wait up to 5 minutes for the memory of 2 worker processes; then the batch does not run.
            let procs = procsFor(freemem() / 2 ** 30);
            for (let i = 0; i < 30 && procs < 2; i++) { await Bun.sleep(10_000); procs = procsFor(freemem() / 2 ** 30); }
            if (procs < 2) { console.log(`JOB ${process.argv[2 + n]} not run: ${(freemem() / 2 ** 30).toFixed(1)} GB free`); continue; }
            const sets = [`SPAR_A=${job.a}`, `SPAR_B=${job.b}`, `SPAR_PROCS=${procs}`, ...(job.swap ? ['SPAR_SWAP=1'] : []), ...(job.optsA ? [`SPAR_A_OPTS=${job.optsA}`] : []), ...(job.optsB ? [`SPAR_B_OPTS=${job.optsB}`] : [])];
            Bun.spawnSync(['bun', 'scripts/measure/aio-practice-bench.ts', `^${job.key}$`, '--parallel', '1', '--no-keep', '--seed', job.seed, ...sets.flatMap(s => ['--set', s])],
                { cwd: root, env: { BENCH_PORT_BASE: '21700', ...process.env, BENCH_OUT: out }, stdout: 'ignore', stderr: 'ignore', windowsHide: true });
            let line = 'no row';
            try {
                const row = JSON.parse(readFileSync(out, 'utf8')).rows[0] as { ok: boolean; result: string | null }, result = String(row.result);
                const scores = (/scores=([-\d,.]+)/.exec(result)?.[1] ?? '').split(',').filter(Boolean).map(Number), first = firstKitTally(scores);
                line = `ok ${row.ok} ${result.replace(/^RESULT ok spar-batch /, '').replace(/ nets=\S+/, '').replace(/ scores=\S+/, '')} | first kit of each pair: ${first.kills} kills, ${first.deaths} deaths`;
            } catch { /* the bench wrote no row */ }
            console.log(`JOB ${process.argv[2 + n]} ${Math.round((Date.now() - t) / 1000)} s procs=${procs} ${line}`);
        }
    } finally {
        if (existsSync(pause)) rmSync(pause);
        rmSync(resolve(root, 'vendor/rs-sdk/engine'), { recursive: true, force: true });
    }
    console.log(`JOBS_DONE ${Math.round((Date.now() - t0) / 1000)} s`);
}
