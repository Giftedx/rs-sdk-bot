// Runs bench cases on hosted runners (the `bench-cases` job of .github/workflows/ci.yml) and prints only the result
// of each case. A hosted runner is clean and costs the PC no memory, so a bench never runs beside the live fleet.
// Usage:
//   bun scripts/hosted-bench.ts '<pattern> [<pattern> ...]' [--seeds 7,8,9] [--args '--profile --set KEY=value --set-b64 KEY=base64']
//                               [--ref <branch or commit>] [--workflow-ref <branch>] [--no-wait]
//   bun scripts/hosted-bench.ts --run <run id>      the results of a run that was started before
// Each pattern and each seed gets its own runner, all at one time. `--ref` is the code that the runners check out
// (default: this branch, which must be pushed). `--workflow-ref` is the branch whose workflow file starts the run
// (default: master). `--args` are added to `bun run bench` on each runner. The run's files are kept in
// .practice/hosted-bench/<run id>/. Exit code 0 when every case passed, 1 when a case failed, 2 for a run that gave no result.
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';

export const MAX_JOBS = 40;
export const POLL_MS = 5_000;
export type PlanRow = {id: string; pattern: string; seed: string};
// The matrix of the hosted job: one row for each pattern and seed. Patterns are separated by spaces (a case key has none).
export function benchPlan(patterns: string, seeds: string): PlanRow[] {
    const list = patterns.split(/\s+/).filter(Boolean), seedList = (seeds.trim() || '7').split(',').map(s => s.trim());
    if (!list.length) throw new Error('no bench pattern');
    // The runner hands the pattern to the bench as one argument; a leading dash would make it an option there.
    for (const p of list) if (p.startsWith('-')) throw new Error(`a bench pattern cannot start with "-": ${p}`);
    for (const p of list) new RegExp(p);
    if (seedList.some(s => !/^\d{1,9}$/.test(s))) throw new Error(`seeds must be integers separated by commas, got ${seeds}`);
    const rows = list.flatMap((pattern, i) => seedList.map(seed => ({id: `p${i + 1}-s${seed}`, pattern, seed})));
    if (rows.length > MAX_JOBS) throw new Error(`${rows.length} runners asked, ${MAX_JOBS} at most: use fewer patterns or seeds`);
    return rows;
}
/** Validates and decodes a `KEY=<base64>` argument (standard or URL-safe base64). */
export function decodeSetB64(spec: string): {key: string; value: string} {
    const m = /^([A-Z][A-Z0-9_]*)=([A-Za-z0-9+/_-]+={0,2})$/.exec(spec);
    if (!m) throw new Error(`--set-b64 needs KEY=base64, got ${spec}`);
    const norm = m[2]!.replace(/-/g, '+').replace(/_/g, '/');
    const raw = norm.replace(/=+$/, '');
    if (!raw.length || raw.length % 4 === 1) throw new Error(`--set-b64 invalid base64 for ${m[1]}`);
    const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
    if ((norm.includes('=') && norm !== padded) || Buffer.from(padded, 'base64').toString('base64') !== padded) {
        throw new Error(`--set-b64 invalid base64 for ${m[1]}`);
    }
    return {key: m[1]!, value: Buffer.from(padded, 'base64').toString('utf8')};
}
// The extra bench arguments a run may carry. The start check, the budget and the engine count belong to the workflow.
export function checkArgs(args: string): string[] {
    const list = args.split(/\s+/).filter(Boolean);
    for (let i = 0; i < list.length; i++) {
        const a = list[i]!;
        if (a === '--set') { if (!/^[A-Z][A-Z0-9_]*=[\w.,:+@\/-]*$/.test(list[++i] ?? '')) throw new Error(`--set needs KEY=value, got ${list[i]}`); }
        else if (a === '--set-b64') { decodeSetB64(list[++i] ?? ''); }
        else if (!['--profile', '--no-keep', '--all', '--smoke', '--wall-clock'].includes(a)) throw new Error(`argument not allowed in a hosted bench: ${a}`);
    }
    return list;
}
export type CaseRow = {case: string; ok: boolean; elapsedMs: number; ledgerTicks: number[]; output?: number | null; result?: string | null; kept?: boolean};
// One line for each case of each job, and one line for each profile.
export function resultLines(jobs: readonly {name: string; rows: readonly CaseRow[]; log: string}[]): {lines: string[]; failed: number; cases: number} {
    const lines: string[] = [];
    let failed = 0, cases = 0;
    for (const job of [...jobs].sort((a, b) => a.name.localeCompare(b.name))) {
        const seed = /-s(\d+)$/.exec(job.name)?.[1] ?? '?';
        for (const r of job.rows) {
            cases++; if (!r.ok) failed++;
            lines.push(`${r.ok ? 'pass' : 'FAIL'}  seed ${seed}  ${r.case}  ticks ${r.ledgerTicks.at(-1) ?? '-'}  ${(r.elapsedMs / 1000).toFixed(1)} s${r.output != null ? `  output ${r.output}` : ''}${r.ok ? '' : `  ${(r.result ?? '').slice(0, 200)}`}`);
        }
        for (const m of job.log.matchAll(/^AIO_BENCH_PROFILE (\{.*\})$/gm)) {
            try {
                const p = JSON.parse(m[1]!);
                lines.push(`      profile  seed ${seed}  ${p.case}  wall ${(p.wallMs / 1000).toFixed(1)} s  engine start ${(p.engineStartMs / 1000).toFixed(1)} s  login wait ${(p.engine.startupMs / 1000).toFixed(1)} s  tick wait ${p.engine.gameMsPerTick} ms  held ${(p.client.heldMs / 1000).toFixed(1)} s  capped ${p.client.capped}`);
            } catch { /* a cut line */ }
        }
        if (!job.rows.length) { failed++; lines.push(`FAIL  seed ${seed}  ${job.name}: no result (${(/^bench: .*$/m.exec(job.log)?.[0] ?? /^AIO_BENCH_ERROR .*$/m.exec(job.log)?.[0] ?? 'see the job log').slice(0, 200)})`); }
    }
    return {lines, failed, cases};
}

if (import.meta.main) {
    const root = resolve(import.meta.dir, '..'), argv = process.argv.slice(2);
    const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
    const has = (flag: string) => { const i = argv.indexOf(flag); if (i < 0) return false; argv.splice(i, 1); return true; };
    // The workflow's first job: the matrix as a step output.
    if (has('--plan')) { console.log(`matrix=${JSON.stringify({include: benchPlan(process.env.BENCH_PATTERN ?? '', process.env.BENCH_SEEDS ?? '')})}`); checkArgs(process.env.BENCH_ARGS ?? ''); process.exit(0); }
    const gh = (args: string[]) => { const r = Bun.spawnSync(['gh', ...args], {cwd: root, stdout: 'pipe', stderr: 'pipe', windowsHide: true}); return {ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString()}; };
    let run = value('--run');
    const seeds = value('--seeds') ?? '', args = value('--args') ?? '', wait = !has('--no-wait');
    const branch = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {stdout: 'pipe', windowsHide: true}).stdout.toString().trim();
    const ref = value('--ref') ?? branch, workflowRef = value('--workflow-ref') ?? 'master';
    if (!run) {
        if (argv.length !== 1 || argv[0]!.startsWith('--')) { console.error("usage: bun scripts/hosted-bench.ts '<pattern> [<pattern> ...]' [--seeds 7,8,9] [--args '--profile'] [--ref <branch>] [--workflow-ref <branch>] [--no-wait] | --run <id>"); process.exit(2); }
        const plan = benchPlan(argv[0]!, seeds); checkArgs(args);
        const started = gh(['workflow', 'run', 'CI', '--ref', workflowRef, '-f', `bench_pattern=${argv[0]}`, '-f', `bench_seeds=${seeds}`, '-f', `bench_args=${args}`, '-f', `bench_ref=${ref}`]);
        if (!started.ok) { console.error(`hosted-bench: the run did not start: ${started.err.trim().split('\n').at(-1)}`); process.exit(2); }
        run = /actions\/runs\/(\d+)/.exec(started.out + started.err)?.[1];
        for (let i = 0; !run && i < 10; i++) { await Bun.sleep(3000); run = JSON.parse(gh(['run', 'list', '--workflow', 'CI', '--event', 'workflow_dispatch', '--branch', workflowRef, '-L', '1', '--json', 'databaseId']).out || '[]')[0]?.databaseId?.toString(); }
        if (!run) { console.error('hosted-bench: the run started and its id was not found: see gh run list --workflow CI'); process.exit(2); }
        console.log(`hosted-bench: run ${run}, ${plan.length} ${plan.length === 1 ? 'runner' : 'runners'}, code ${ref}`);
        if (!wait) process.exit(0);
    }
    // Wait for the bench jobs only: the other jobs of the workflow take longer and hold no bench result.
    const deadline = Date.now() + 40 * 60_000;
    for (;;) {
        const view = JSON.parse(gh(['run', 'view', run, '--json', 'status,jobs']).out || '{}') as {status?: string; jobs?: {name: string; status: string}[]};
        const bench = (view.jobs ?? []).filter(j => j.name.startsWith('bench-cases'));
        if (view.status === 'completed' || (bench.length > 0 && bench.every(j => j.status === 'completed') && (view.jobs ?? []).some(j => j.name === 'bench-plan' && j.status === 'completed'))) break;
        if (Date.now() > deadline) { console.error(`hosted-bench: run ${run} did not end in 40 minutes`); process.exit(2); }
        await Bun.sleep(POLL_MS);
    }
    const dir = join(root, '.practice', 'hosted-bench', run);
    rmSync(dir, {recursive: true, force: true}); mkdirSync(dir, {recursive: true});
    gh(['run', 'download', run, '-p', 'bench-*', '-D', dir]);
    const jobs = (existsSync(dir) ? readdirSync(dir) : []).filter(n => n.startsWith('bench-')).map(name => {
        // The artifact holds .practice/bench-cases, alone or beside the case logs.
        const base = existsSync(join(dir, name, 'bench-cases')) ? join(dir, name, 'bench-cases') : join(dir, name);
        const file = join(base, 'cases.json'), log = join(base, 'bench.log');
        let rows: CaseRow[] = [];
        try { rows = JSON.parse(readFileSync(file, 'utf8')).rows; } catch { /* the job gave no rows */ }
        return {name: name.replace(/-[0-9a-f]{40}$/, ''), rows, log: existsSync(log) ? readFileSync(log, 'utf8') : ''};
    });
    const {lines, failed, cases} = resultLines(jobs);
    console.log(lines.join('\n'));
    console.log(`hosted-bench: run ${run}: ${cases - Math.min(failed, cases)} of ${cases} cases passed on ${jobs.length} ${jobs.length === 1 ? 'runner' : 'runners'}; files in .practice/hosted-bench/${run}`);
    process.exit(!jobs.length ? 2 : failed ? 1 : 0);
}
