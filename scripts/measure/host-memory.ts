// The resident memory of 4 bots of one worker, in one host process and in 4 separate processes (linux only: /proc).
//
// Usage: bun scripts/measure/host-memory.ts <bot> <worker script> [--env KEY=value]... [--max-s N] [--stagger-ms N] -- <worker args...>
//
// A bench case provisions the accounts `<bot>`, `<bot>b` ... `<bot>h` with the same preset (companions). The condition `host`
// runs <bot>, <bot>b, <bot>c, <bot>d under packages/core/src/host.ts (one process). The condition `separate` runs
// <bot>e, <bot>f, <bot>g, <bot>h as one `bun <worker> <name> <args>` process each. The conditions run one after the other, each
// with the same environment and arguments. Each process's VmRSS is read from /proc every second; a sample counts when every
// process of the condition is alive. The result lines carry the mean and the peak of the SUM of the processes (megabytes) and
// the peak of each process (VmHWM, the kernel's high-water mark of its resident set):
//   HOSTMEM worker=<script> mode=<host|separate> bots=4 samples=<n> meanMB=<n> peakSumMB=<n> peakEachMB=<a,b,...> steadyMeanMB=<n> seconds=<n>
// `steadyMeanMB` leaves out the first 30 s (the logins and the first walk). The script ends with `RESULT ok host-memory` when
// both conditions ran and every bot process exited by itself or at the time limit.
import { readFileSync } from 'node:fs';

export type Sample = { at: number; rss: number[] };
export type Summary = { samples: number; meanMB: number; peakSumMB: number; steadyMeanMB: number };

const mb = (kb: number) => Math.round(kb / 1024);
export const readRssKb = (pid: number, field: 'VmRSS' | 'VmHWM' = 'VmRSS'): number | undefined => {
    try { const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm')); return m ? Number(m[1]) : undefined; } catch { return undefined; }
};
// The mean and the peak of the summed resident set (kilobytes in, megabytes out). `steadyFrom`: milliseconds after the start.
export function summarize(samples: readonly Sample[], steadyFrom = 30_000): Summary {
    const sums = samples.map(s => ({ at: s.at, sum: s.rss.reduce((a, b) => a + b, 0) }));
    const steady = sums.filter(s => s.at >= steadyFrom);
    const mean = (xs: readonly { sum: number }[]) => xs.length ? xs.reduce((a, x) => a + x.sum, 0) / xs.length : 0;
    return { samples: sums.length, meanMB: mb(mean(sums)), peakSumMB: mb(Math.max(0, ...sums.map(s => s.sum))), steadyMeanMB: mb(mean(steady)) };
}

type Options = { bot: string; worker: string; env: Record<string, string>; maxS: number; staggerMs: number; args: string[] };
export function parseOptions(argv: readonly string[]): Options {
    const [bot, worker, ...rest] = argv;
    if (!bot || !worker) throw Error('usage: host-memory.ts <bot> <worker script> [--env K=V]... [--max-s N] [--stagger-ms N] -- <worker args...>');
    const env: Record<string, string> = {};
    let maxS = 240, staggerMs = 2000, i = 0;
    for (; i < rest.length && rest[i] !== '--'; i++) {
        if (rest[i] === '--env') { const kv = rest[++i] ?? ''; const at = kv.indexOf('='); if (at < 1) throw Error(`--env needs KEY=value, got "${kv}"`); env[kv.slice(0, at)] = kv.slice(at + 1); }
        else if (rest[i] === '--max-s') maxS = Number(rest[++i]);
        else if (rest[i] === '--stagger-ms') staggerMs = Number(rest[++i]);
        else throw Error(`unknown option ${rest[i]}`);
    }
    if (!Number.isFinite(maxS) || maxS <= 0 || !Number.isFinite(staggerMs) || staggerMs < 0) throw Error('--max-s and --stagger-ms need numbers');
    return { bot, worker, env, maxS, staggerMs, args: rest.slice(i + 1) };
}
export const hostNames = (bot: string) => [bot, `${bot}b`, `${bot}c`, `${bot}d`];
export const separateNames = (bot: string) => ['e', 'f', 'g', 'h'].map(s => `${bot}${s}`);

async function measure(mode: 'host' | 'separate', o: Options): Promise<{ line: string; ok: boolean }> {
    const env = { ...process.env, ...o.env } as Record<string, string>;
    const start = Date.now(), procs: ReturnType<typeof Bun.spawn>[] = [];
    const spawn = (cmd: string[]) => Bun.spawn(cmd, { env, stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    if (mode === 'host') procs.push(spawn(['bun', 'packages/core/src/host.ts', o.worker, ...hostNames(o.bot), '--stagger-ms', String(o.staggerMs), ...o.args.flatMap(a => ['--arg', a])]));
    const samples: Sample[] = [], peak: number[] = [];
    const sample = () => {
        const rss = procs.map(p => readRssKb(p.pid));
        if (rss.every(r => r !== undefined)) samples.push({ at: Date.now() - start, rss: rss as number[] });
        procs.forEach((p, i) => { const h = readRssKb(p.pid, 'VmHWM'); if (h !== undefined) peak[i] = Math.max(peak[i] ?? 0, h); });
    };
    const timer = setInterval(sample, 1000);
    if (mode === 'separate') for (const name of separateNames(o.bot)) { procs.push(spawn(['bun', o.worker, name, ...o.args])); await Bun.sleep(o.staggerMs); }
    const deadline = setTimeout(() => procs.forEach(p => { try { p.kill(); } catch { /* already gone */ } }), o.maxS * 1000);
    const codes = await Promise.all(procs.map(p => p.exited));
    clearInterval(timer); clearTimeout(deadline); sample();
    const sum = summarize(samples);
    const line = `HOSTMEM worker=${o.worker} mode=${mode} bots=4 processes=${procs.length} samples=${sum.samples} meanMB=${sum.meanMB} peakSumMB=${sum.peakSumMB} peakEachMB=${peak.map(mb).join(',')} steadyMeanMB=${sum.steadyMeanMB} seconds=${Math.round((Date.now() - start) / 1000)} exits=${codes.join(',')}`;
    return { line, ok: sum.samples > 0 };
}

if (import.meta.main) {
    if (process.platform !== 'linux') { console.log('RESULT fail host-memory needs /proc (linux)'); process.exit(1); }
    const o = parseOptions(process.argv.slice(2));
    const results = [];
    for (const mode of ['host', 'separate'] as const) { const r = await measure(mode, o); console.log(r.line); results.push(r); }
    console.log(results.every(r => r.ok) ? 'RESULT ok host-memory' : 'RESULT fail host-memory no sample with every process alive');
    process.exit(results.every(r => r.ok) ? 0 : 1);
}
