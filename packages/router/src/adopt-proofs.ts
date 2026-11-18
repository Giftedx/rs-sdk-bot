// Adopts the method proofs that a hosted runner made for this commit (.github/workflows/progression-practice.yml,
// job `qualification`), so the PC runs no practice engine for them.
// Usage: bun packages/router/src/adopt-proofs.ts [--run <run id>] [--commit <sha>] [--check]
// Without --run it takes the newest good `Progression practice` run of the commit (default: HEAD).
// The artifact is evidence, not authority. Two sets of checks stand before the index:
// 1. The origin of the run (originProblems): it is a run of the proof workflow, started by a push or a dispatch on
//    the branch this checkout is on (master in the main checkout, so a proof from a feature branch is not adopted
//    for master), for the named commit, finished with success, with a successful `qualification` job. The upload
//    step of the workflow runs for a failed job too, so the name of an artifact proves nothing.
// 2. The registrar (packages/router/src/progression-qualification.ts) checks the delivery against this checkout
//    before it writes one byte of the index:
//    - the delivery source and the worker release of the artifact equal the ones this checkout computes now
//      (packages/core/src/release-digest.ts gives one release to a Windows and a Linux checkout of one commit);
//    - each declared file has the artifact's SHA-256 here, each check passed, and each check log is the artifact's;
//    - the raw saves, the worker log and the frozen entry give the proof's own result again (verifyProof).
// A proof of another commit, of edited source or with changed files is refused and the index keeps its bytes.
// This file is controller tooling, as the registrar is: no worker imports it.
// The command never starts a worker and never touches a stop file. `--check` prints the run it would take.
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';

export const PROOF_WORKFLOW = 'Progression practice', PROOF_JOB = 'qualification', PROOF_EVENTS = ['push', 'workflow_dispatch'] as const;
export type RunRow = {databaseId: number; headSha: string; conclusion: string | null; status: string; event?: string; headBranch?: string};
export type RunView = {workflowName?: string; event?: string; headBranch?: string; headSha?: string; status?: string; conclusion?: string | null; jobs?: {name: string; conclusion: string | null}[]};

// The run id and the commit go into a folder name, an artifact name and a `gh` argument: digits and a full hash only.
// `--run ..` would otherwise name the .practice folder itself as the folder to clear.
export function adoptArgs(argv: readonly string[]): {run?: string; commit?: string; check: boolean} {
    const out: {run?: string; commit?: string; check: boolean} = {check: false};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === '--check') out.check = true;
        else if (a === '--run') { const v = argv[++i] ?? ''; if (!/^\d{1,20}$/.test(v)) throw new Error(`--run needs a run id of digits, got ${JSON.stringify(v)}`); out.run = v; }
        else if (a === '--commit') { const v = argv[++i] ?? ''; if (!/^[0-9a-f]{40}$/.test(v)) throw new Error(`--commit needs a full commit hash of 40 hex characters, got ${JSON.stringify(v)}`); out.commit = v; }
        else throw new Error(`unknown argument ${JSON.stringify(a)}`);
    }
    return out;
}
// Why this run cannot be the origin of a proof for `sha` on `branch`: an empty list when it can.
export function originProblems(view: RunView, sha: string, branch: string): string[] {
    const out: string[] = [];
    if (view.workflowName !== PROOF_WORKFLOW) out.push(`it is a run of ${JSON.stringify(view.workflowName ?? null)}, not of "${PROOF_WORKFLOW}"`);
    if (!(PROOF_EVENTS as readonly string[]).includes(view.event ?? '')) out.push(`its event is ${JSON.stringify(view.event ?? null)}, not a push or a dispatch`);
    if (view.headBranch !== branch) out.push(`it ran on branch ${JSON.stringify(view.headBranch ?? null)} and this checkout is on ${JSON.stringify(branch)}`);
    if (view.headSha !== sha) out.push(`it ran commit ${String(view.headSha).slice(0, 10)}, not ${sha.slice(0, 10)}`);
    if (view.status !== 'completed' || view.conclusion !== 'success') out.push(`it ended ${JSON.stringify(view.status ?? null)} with ${JSON.stringify(view.conclusion ?? null)}, not completed with success`);
    const job = (view.jobs ?? []).filter(j => j.name === PROOF_JOB);
    if (job.length !== 1 || job[0]!.conclusion !== 'success') out.push(`its ${PROOF_JOB} job is ${job.length === 1 ? JSON.stringify(job[0]!.conclusion) : 'missing'}, not success`);
    return out;
}
// The newest finished successful run of the commit on the branch, or null.
export function pickRun(runs: readonly RunRow[], sha: string, branch: string): RunRow | null {
    return [...runs].filter(r => r.headSha === sha && r.headBranch === branch && (PROOF_EVENTS as readonly string[]).includes(r.event ?? '') && r.status === 'completed' && r.conclusion === 'success')
        .sort((a, b) => b.databaseId - a.databaseId)[0] ?? null;
}
// Why the delivery report of an artifact cannot be registered: an empty list when it can. The registrar returns
// "nothing registered" for a delivery that is not ok, with no error, so the report is checked here first.
export function reportProblems(report: unknown): string[] {
    const r = (report && typeof report === 'object' ? report : {}) as {ok?: unknown; stage?: unknown; id?: unknown; failedCheck?: unknown};
    const out: string[] = [];
    if (r.ok !== true) out.push('its delivery is not ok');
    if (r.stage !== 'delivered') out.push(`its stage is ${JSON.stringify(r.stage ?? null)}, not "delivered"`);
    if (r.failedCheck !== undefined) out.push(`its check ${JSON.stringify(r.failedCheck)} failed`);
    if (r.id !== 'ranged-train') out.push(`it is a delivery of ${JSON.stringify(r.id ?? null)}, not of "ranged-train"`);
    return out;
}
// The delivery folder inside a downloaded artifact root: the one folder under deliveries that holds a report.
export function deliveryFolder(practiceRoot: string): string | null {
    const deliveries = join(practiceRoot, 'deliveries');
    if (!existsSync(deliveries)) return null;
    const found = readdirSync(deliveries).filter(name => existsSync(join(deliveries, name, 'report.json')) && existsSync(join(deliveries, name, 'ranged-adaptive-proof.json')));
    return found.length === 1 ? join(deliveries, found[0]!) : null;
}

if (import.meta.main) {
    const root = resolve(import.meta.dir, '../../..');
    const fail = (line: string, code = 2): never => { console.error(`adopt-proofs: ${line}`); process.exit(code); };
    let args: ReturnType<typeof adoptArgs>;
    try { args = adoptArgs(process.argv.slice(2)); } catch (error) { args = fail((error as Error).message); }
    const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd, {cwd: root, stdout: 'pipe', stderr: 'pipe', windowsHide: true}); return {ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim()}; };
    const sha = args.commit ?? sh(['git', 'rev-parse', 'HEAD']).out, branch = sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD']).out;
    if (!/^[0-9a-f]{40}$/.test(sha) || !branch || branch === 'HEAD') fail('this checkout has no commit or is on no branch');
    let run = args.run;
    if (!run) {
        const list = sh(['gh', 'run', 'list', '--workflow', PROOF_WORKFLOW, '--commit', sha, '-L', '20', '--json', 'databaseId,headSha,conclusion,status,event,headBranch']);
        const picked = list.ok ? pickRun(JSON.parse(list.out || '[]'), sha, branch) : null;
        if (!picked) fail(`no successful "${PROOF_WORKFLOW}" run for commit ${sha.slice(0, 10)} on ${branch}. Start one: gh workflow run "${PROOF_WORKFLOW}" --ref ${branch}`);
        run = String(picked!.databaseId);
    }
    if (!/^\d{1,20}$/.test(run!)) fail('the run id is not digits');
    const seen = sh(['gh', 'run', 'view', run!, '--json', 'workflowName,event,headBranch,headSha,status,conclusion,jobs']);
    let view: RunView = {};
    try { view = JSON.parse(seen.out); } catch { fail(`run ${run} was not read: ${seen.err.split('\n').at(-1)}`); }
    const problems = originProblems(view, sha, branch);
    if (problems.length) fail(`run ${run} is not adopted: ${problems.join('; ')}. The index is unchanged.`, 1);
    console.log(`adopt-proofs: run ${run}, commit ${sha.slice(0, 10)}, branch ${branch}, event ${view.event}`);
    if (args.check) process.exit(0);
    // The artifact holds the runner's .practice folders, so its root is a practice root. The folder name is digits.
    const practiceRoot = join(root, '.practice', 'hosted-proofs', run!);
    rmSync(practiceRoot, {recursive: true, force: true}); mkdirSync(practiceRoot, {recursive: true});
    const got = sh(['gh', 'run', 'download', run!, '-n', `progression-qualification-${sha}`, '-D', practiceRoot]);
    if (!got.ok) fail(`the artifact progression-qualification-${sha} of run ${run} was not read: ${got.err.split('\n').at(-1)}`);
    const directory = deliveryFolder(practiceRoot);
    if (!directory) fail(`run ${run} holds no one complete Ranged delivery`);
    let report: unknown = null;
    try { report = JSON.parse(readFileSync(join(directory!, 'report.json'), 'utf8')); } catch { /* reported below */ }
    const unfit = reportProblems(report);
    if (unfit.length) fail(`refused, the index is unchanged: ${unfit.join('; ')}`, 1);
    const {registerProgressionArtifact} = await import('./progression-qualification-cli');
    try {
        const result = await registerProgressionArtifact(directory!, practiceRoot);
        // The registrar names the index file for every delivery it took. No index: it took nothing.
        if (!result.index) fail('refused, the index is unchanged: the registrar took no delivery', 1);
        console.log(`adopt-proofs: ${result.registered ? 'registered' : 'already in the index'}: ${JSON.stringify({methods: (result as any).methods, source: (result as any).source, index: result.index})}`);
    } catch (error) {
        fail(`refused, the index is unchanged: ${String((error as Error)?.message ?? error)}`, 1);
    }
}
