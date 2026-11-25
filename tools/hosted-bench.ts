// Runs bench cases on hosted runners (the `bench-cases` job of .github/workflows/ci.yml) and prints only the result
// of each case. A hosted runner is clean and costs the PC no memory, so a bench never runs beside the live fleet.
// Usage:
//   bun tools/hosted-bench.ts '<pattern> [<pattern> ...]' [--seeds 7,8,9] [--args '--profile --set KEY=value --set-b64 KEY=base64']
//                              [--seed-jobs 1..4] [--batch 1..8] [--no-batch] [--arms 1]
//                              [--ref <branch or commit>] [--workflow-ref <branch>] [--no-wait]
//   bun tools/hosted-bench.ts --run <run id>      the results of a run that was started before
// Short patterns and multi-seed runs are automatically packed onto fewer 4-vCPU runners unless --no-batch is passed.
// `--ref` is the code that the runners check out (default: this branch, which must be pushed). `--workflow-ref` is
// the branch whose workflow file starts the run (default: master). The run's files are kept in .practice/hosted-bench/<run id>/.
// Exit code 0 when every case passed, 1 when a case failed, 2 for a run that gave no result.
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';

export const MAX_JOBS = 40;
export const INITIAL_POLL_WAIT_MS = 20_000;
export const POLL_BACKOFF_MS = [15_000, 30_000] as const;

export function pollDelayMs(pollIndex: number): number {
    return POLL_BACKOFF_MS[Math.min(Math.max(0, Math.trunc(pollIndex)), POLL_BACKOFF_MS.length - 1)]!;
}
export type PlanRow = {id: string; pattern: string; seed: string; seeds?: string; seedJobs?: string; parallel?: string};
export type PlanOptions = {batch?: number; seedJobs?: number};

/** Computes runner-packing defaults for 4-vCPU runners so multi-case and multi-arm sweeps stay inside one wave without saturating vCPUs. */
export function autoPlanOptions(
    patternCount: number,
    seedCount: number,
    opts: {batch?: number; seedJobs?: number; noBatch?: boolean; arms?: number} = {},
): PlanOptions {
    if (opts.noBatch) return {batch: 1, seedJobs: 1};
    const explicitBatch = opts.batch !== undefined ? Math.max(1, Math.min(8, Math.trunc(opts.batch))) : undefined;
    const explicitSeedJobs = opts.seedJobs !== undefined ? Math.max(1, Math.min(4, Math.trunc(opts.seedJobs))) : undefined;
    if (explicitBatch !== undefined || explicitSeedJobs !== undefined) {
        const seedJobs = explicitSeedJobs ?? (seedCount >= 2 ? Math.min(2, seedCount) : 1);
        return {batch: explicitBatch ?? 1, seedJobs};
    }
    const arms = Math.max(1, Math.trunc(opts.arms ?? 1));
    if (seedCount >= 2) {
        let seedJobs = Math.min(2, seedCount);
        let runners = arms * patternCount * Math.ceil(seedCount / seedJobs);
        if (runners > 20) {
            seedJobs = Math.min(4, seedCount);
            runners = arms * patternCount * Math.ceil(seedCount / seedJobs);
        }
        const batch = runners > 20 && patternCount > 1 ? Math.min(4, patternCount, Math.ceil(runners / 20)) : 1;
        return {batch, seedJobs};
    }
    let batch = Math.min(2, Math.max(1, patternCount));
    if (arms * Math.ceil(patternCount / batch) > 20 && patternCount > 1) {
        batch = Math.min(4, patternCount, Math.ceil((arms * patternCount) / 20));
    }
    return {batch, seedJobs: 1};
}

// The matrix of the hosted job: packs patterns by `batch` and seeds by `seedJobs` (defaults to 1x1 when unpassed).
export function benchPlan(patterns: string, seeds: string, opts: PlanOptions = {}): PlanRow[] {
    const list = patterns.split(/\s+/).filter(Boolean), seedList = (seeds.trim() || '7').split(',').map(s => s.trim());
    if (!list.length) throw new Error('no bench pattern');
    // The runner hands the pattern to the bench as one argument; a leading dash would make it an option there.
    for (const p of list) if (p.startsWith('-')) throw new Error(`a bench pattern cannot start with "-": ${p}`);
    for (const p of list) new RegExp(p);
    if (seedList.some(s => !/^\d{1,9}$/.test(s))) throw new Error(`seeds must be integers separated by commas, got ${seeds}`);
    const batch = Math.max(1, Math.min(8, Math.trunc(opts.batch ?? 1)));
    const seedJobs = Math.max(1, Math.min(4, Math.trunc(opts.seedJobs ?? 1)));
    const patternGroups: string[][] = [];
    for (let i = 0; i < list.length; i += batch) patternGroups.push(list.slice(i, i + batch));
    const seedGroups: string[][] = [];
    for (let i = 0; i < seedList.length; i += seedJobs) seedGroups.push(seedList.slice(i, i + seedJobs));
    const rows: PlanRow[] = [];
    let multiIdx = 0;
    for (let pi = 0; pi < patternGroups.length; pi++) {
        const group = patternGroups[pi]!;
        const pattern = group.length === 1 ? group[0]! : group.map(p => `(?:${p})`).join('|');
        for (const seedSlice of seedGroups) {
            if (seedSlice.length === 1 && group.length === 1) {
                rows.push({id: `p${pi + 1}-s${seedSlice[0]!}`, pattern, seed: seedSlice[0]!});
            } else if (seedSlice.length === 1) {
                rows.push({id: `p${pi + 1}-s${seedSlice[0]!}`, pattern, seed: seedSlice[0]!, parallel: String(Math.min(4, group.length))});
            } else {
                multiIdx++;
                rows.push({
                    id: `m${multiIdx}`,
                    pattern,
                    seed: seedSlice[0]!,
                    seeds: seedSlice.join(','),
                    seedJobs: String(Math.min(4, seedSlice.length)),
                });
            }
        }
    }
    if (rows.length > MAX_JOBS) throw new Error(`${rows.length} runners asked, ${MAX_JOBS} at most: use fewer patterns or seeds, or increase --batch / --seed-jobs`);
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
        else if (a === '--seed-jobs') { if (!/^[1-4]$/.test(list[++i] ?? '')) throw new Error(`--seed-jobs needs 1..4, got ${list[i]}`); }
        else if (a === '--batch') { if (!/^[1-8]$/.test(list[++i] ?? '')) throw new Error(`--batch needs 1..8, got ${list[i]}`); }
        else if (!['--profile', '--no-keep', '--all', '--smoke', '--wall-clock'].includes(a)) throw new Error(`argument not allowed in a hosted bench: ${a}`);
    }
    return list;
}
/** Extracts workflow runner-packing flags embedded in BENCH_ARGS. */
export function extractPlanOpts(args: string): PlanOptions {
    const list = checkArgs(args);
    const out: PlanOptions = {};
    for (let i = 0; i < list.length; i++) {
        if (list[i] === '--batch') out.batch = Number(list[++i]);
        else if (list[i] === '--seed-jobs') out.seedJobs = Number(list[++i]);
    }
    return out;
}
/** Materializes per-seed bench-p<idx>-s<seed> folders from downloaded bench-m* multi-seed artifacts so downstream parsers read one layout. */
export function expandMultiSeedArtifacts(dir: string): Set<string> {
    const expandedSources = new Set<string>();
    if (!existsSync(dir)) return expandedSources;
    for (const entry of readdirSync(dir)) {
        const m = /^bench-m(\d+)((?:-[0-9a-f]{40})?)$/.exec(entry);
        if (!m) continue;
        const mIdx = m[1]!, shaSuffix = m[2]!;
        const src = join(dir, entry);
        const srcCases = existsSync(join(src, 'bench-cases')) ? join(src, 'bench-cases') : src;
        if (!existsSync(srcCases)) continue;
        const seedFiles = readdirSync(srcCases).filter(f => /^seed-\d+\.json$/.test(f)).sort();
        if (!seedFiles.length) continue;
        // Retain the wrapper entry unless the runner finished writing aggregated cases.json (otherwise surface the crash).
        if (existsSync(join(srcCases, 'cases.json'))) expandedSources.add(entry);
        for (const f of seedFiles) {
            const seed = /^seed-(\d+)\.json$/.exec(f)![1]!;
            const target = join(dir, `bench-p${mIdx}-s${seed}${shaSuffix}`);
            const targetCases = join(target, 'bench-cases');
            const targetOut = join(target, 'aio-bench', 'output');
            mkdirSync(targetCases, {recursive: true});
            mkdirSync(targetOut, {recursive: true});
            copyFileSync(join(srcCases, f), join(targetCases, 'cases.json'));
            const seedLog = join(srcCases, `seed-${seed}.log`);
            if (existsSync(seedLog)) copyFileSync(seedLog, join(targetCases, 'bench.log'));
            const simOut = join(src, 'sim', 'aio-bench', `output-seed-${seed}`);
            const srcOut = existsSync(simOut) ? simOut : join(src, 'aio-bench', `output-seed-${seed}`);
            if (existsSync(srcOut)) {
                for (const lf of readdirSync(srcOut).filter(x => x.endsWith('.log'))) copyFileSync(join(srcOut, lf), join(targetOut, lf));
            }
        }
    }
    return expandedSources;
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

export function parseRunId(raw: string): string {
    const trimmed = raw.trim();
    if (!/^\d{1,20}$/.test(trimmed)) throw new Error(`invalid --run id: ${raw}`);
    return trimmed;
}

export function parseBoundedIntFlag(flag: string, raw: string, min: number, max: number): number {
    if (!/^\d+$/.test(raw.trim())) throw new Error(`${flag} must be an integer ${min}..${max}, got ${raw}`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${flag} must be ${min}..${max}, got ${raw}`);
    return n;
}

export type PollState =
    | { done: false }
    | { done: true; planFailed: boolean; conclusion?: string | null };

export function evaluatePollState(view: { status?: string; jobs?: { name: string; status: string; conclusion?: string | null }[] }): PollState {
    const jobs = view.jobs ?? [];
    const planJob = jobs.find(j => j.name === 'bench-plan');
    if (planJob?.status === 'completed' && planJob.conclusion && planJob.conclusion !== 'success') {
        return { done: true, planFailed: true, conclusion: planJob.conclusion };
    }
    const bench = jobs.filter(j => j.name.startsWith('bench-cases'));
    if (view.status === 'completed' || (bench.length > 0 && bench.every(j => j.status === 'completed') && planJob?.status === 'completed')) {
        return { done: true, planFailed: false };
    }
    return { done: false };
}

if (import.meta.main) {
    const root = resolve(import.meta.dir, '..'), argv = process.argv.slice(2);
    const value = (flag: string) => {
        const i = argv.indexOf(flag);
        if (i < 0) return undefined;
        if (i + 1 >= argv.length) { console.error(`hosted-bench: ${flag} requires a value`); process.exit(2); }
        return argv.splice(i, 2)[1];
    };
    const has = (flag: string) => { const i = argv.indexOf(flag); if (i < 0) return false; argv.splice(i, 1); return true; };
    // The workflow's first job: the matrix as a step output.
    if (has('--plan')) {
        const argsEnv = process.env.BENCH_ARGS ?? '';
        console.log(`matrix=${JSON.stringify({include: benchPlan(process.env.BENCH_PATTERN ?? '', process.env.BENCH_SEEDS ?? '', extractPlanOpts(argsEnv))})}`);
        process.exit(0);
    }
    const gh = (args: string[]) => { const r = Bun.spawnSync(['gh', ...args], {cwd: root, stdout: 'pipe', stderr: 'pipe', windowsHide: true}); return {ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString()}; };
    const runArg = value('--run');
    const startedFreshRun = runArg === undefined;
    let run = runArg !== undefined ? parseRunId(runArg) : undefined;
    const seeds = value('--seeds') ?? '', args = value('--args') ?? '', wait = !has('--no-wait');
    const noBatch = has('--no-batch'), cliBatch = value('--batch'), cliSeedJobs = value('--seed-jobs'), cliArms = value('--arms');
    const branch = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {stdout: 'pipe', windowsHide: true}).stdout.toString().trim();
    const ref = value('--ref') ?? branch, workflowRef = value('--workflow-ref') ?? 'master';
    if (!run) {
        if (argv.length !== 1 || argv[0]!.startsWith('--')) { console.error("usage: bun tools/hosted-bench.ts '<pattern> [<pattern> ...]' [--seeds 7,8,9] [--args '--profile'] [--seed-jobs 1..4] [--batch 1..8] [--no-batch] [--ref <branch>] [--workflow-ref <branch>] [--no-wait] | --run <id>"); process.exit(2); }
        const patternCount = argv[0]!.split(/\s+/).filter(Boolean).length;
        const seedCount = (seeds.trim() || '7').split(',').filter(Boolean).length;
        const parsedArgs = checkArgs(args);
        const hasFlag = (f: string) => parsedArgs.includes(f);
        const planOpts = autoPlanOptions(patternCount, seedCount, {
            noBatch,
            ...(cliBatch !== undefined ? {batch: parseBoundedIntFlag('--batch', cliBatch, 1, 8)} : {}),
            ...(cliSeedJobs !== undefined ? {seedJobs: parseBoundedIntFlag('--seed-jobs', cliSeedJobs, 1, 4)} : {}),
            ...(cliArms !== undefined ? {arms: parseBoundedIntFlag('--arms', cliArms, 1, 100)} : {}),
        });
        const extraPlanTokens = [
            ...(planOpts.seedJobs && planOpts.seedJobs > 1 && !hasFlag('--seed-jobs') ? ['--seed-jobs', String(planOpts.seedJobs)] : []),
            ...(planOpts.batch && planOpts.batch > 1 && !hasFlag('--batch') ? ['--batch', String(planOpts.batch)] : []),
        ];
        const dispatchArgs = [...parsedArgs, ...extraPlanTokens].join(' ');
        const plan = benchPlan(argv[0]!, seeds, extractPlanOpts(dispatchArgs));
        const started = gh(['workflow', 'run', 'CI', '--ref', workflowRef, '-f', `bench_pattern=${argv[0]}`, '-f', `bench_seeds=${seeds}`, '-f', `bench_args=${dispatchArgs}`, '-f', `bench_ref=${ref}`]);
        if (!started.ok) { console.error(`hosted-bench: the run did not start: ${started.err.trim().split('\n').at(-1)}`); process.exit(2); }
        run = /actions\/runs\/(\d+)/.exec(started.out + started.err)?.[1];
        for (let i = 0; !run && i < 10; i++) { await Bun.sleep(1000); run = JSON.parse(gh(['run', 'list', '--workflow', 'CI', '--event', 'workflow_dispatch', '--branch', workflowRef, '-L', '1', '--json', 'databaseId']).out || '[]')[0]?.databaseId?.toString(); }
        if (!run) { console.error('hosted-bench: the run started and its id was not found: see gh run list --workflow CI'); process.exit(2); }
        console.log(`hosted-bench: run ${run}, ${plan.length} ${plan.length === 1 ? 'runner' : 'runners'} (${patternCount * seedCount} pairs), code ${ref}`);
        if (!wait) process.exit(0);
    } else if (argv.length) {
        console.error(`hosted-bench: unexpected arguments with --run: ${argv.join(' ')}`);
        process.exit(2);
    }
    // Wait for the bench jobs only: the other jobs of the workflow take longer and hold no bench result.
    const deadline = Date.now() + 40 * 60_000;
    if (startedFreshRun) await Bun.sleep(INITIAL_POLL_WAIT_MS);
    let pollFailures = 0;
    let pollIndex = 0;
    for (;;) {
        const res = gh(['run', 'view', run, '--json', 'status,jobs']);
        if (!res.ok) {
            if (++pollFailures >= 3) {
                console.error(`hosted-bench: could not inspect run ${run}: ${res.err.trim() || 'gh run view failed'}`);
                process.exit(2);
            }
        } else {
            pollFailures = 0;
            const view = JSON.parse(res.out || '{}') as {status?: string; jobs?: {name: string; status: string; conclusion?: string | null}[]};
            const poll = evaluatePollState(view);
            if (poll.done) {
                if (poll.planFailed) {
                    console.error(`hosted-bench: run ${run} bench-plan ended with conclusion=${poll.conclusion}`);
                    process.exit(2);
                }
                break;
            }
        }
        if (Date.now() > deadline) { console.error(`hosted-bench: run ${run} did not end in 40 minutes`); process.exit(2); }
        await Bun.sleep(pollDelayMs(pollIndex++));
    }
    const dir = join(root, '.practice', 'hosted-bench', run);
    rmSync(dir, {recursive: true, force: true}); mkdirSync(dir, {recursive: true});
    const download = gh(['run', 'download', run, '-p', 'bench-*', '-D', dir]);
    if (!download.ok) {
        console.error(`hosted-bench: artifact download failed for run ${run}: ${download.err.trim() || 'gh run download failed'}`);
    }
    const expanded = expandMultiSeedArtifacts(dir);
    const jobs = (existsSync(dir) ? readdirSync(dir) : []).filter(n => n.startsWith('bench-') && !expanded.has(n)).map(name => {
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
