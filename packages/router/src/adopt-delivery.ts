// Adopts the capability deliveries that hosted runners made (.github/workflows/progression-practice.yml, one job
// `capability <id>` for each capability of a round), so a qualify task of the coordinator runs no practice engine on
// the PC for a capability whose delivery of the same source is adopted.
// Usage: bun packages/router/src/adopt-delivery.ts --run <run id> [--commit <sha>] [--check]
// One line for each capability of the round: adopted, or refused with its cause. A refused capability keeps what it
// had: the coordinator runs its delivery on the PC, as before.
// A hosted delivery is evidence, not authority. Three sets of checks:
// 1. The origin of the run (roundOriginProblems): the proof workflow, a dispatch on the branch this checkout is on
//    (master in the main checkout), the named commit, and a successful job of this capability. The upload step runs
//    for a failed job too, so the name of an artifact proves nothing.
// 2. The delivery against this checkout (deliveryProblems), at the adoption and again at each use: the report is a
//    complete delivery of this capability; its source equals the delivery fingerprint and its runtime revision the
//    capability release that this checkout computes now; its task equals the task file here; each declared file has
//    the report's SHA-256 here; each check of the task passed, in order, and its two log files are in the folder.
// 3. The coordinator takes an adopted delivery only for a qualify task with no account-bound context, and only while
//    the fingerprint here still equals the adopted source (adoptedDelivery).
// A hosted delivery proves the checks on a Linux runner. It is the same evidence level as a local delivery: practice.
// This file is controller tooling: no worker imports it. The command starts no worker and touches no stop file.
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {join, resolve, sep} from 'node:path';
import {capabilityRevision} from '../../core/src/worker-release';
import {deliveryFingerprint, deliveryTask} from './delivery-cli';
import type {DeliveryTask} from './delivery';
import {adoptArgs, PROOF_WORKFLOW, type RunView} from './adopt-proofs';

const root = resolve(import.meta.dir, '../../..');
export const STORE = ['.practice', 'hosted-deliveries'] as const;
export type Adopted = {source: string; run: string; commit: string; folder: string; at: number};
type Index = {version: 1; capabilities: Record<string, Adopted>};
export type LocalFacts = {source: string; runtime: string | null; task: unknown; fileSha(path: string): string | null; hasLog(name: string): boolean};

// Why this run cannot be the origin of a delivery of `capability` for `sha` on `branch`: an empty list when it can.
// The run as a whole may end with failure, because other capabilities of the round can fail; this capability's job
// must end with success.
export function roundOriginProblems(view: RunView, sha: string, branch: string, capability: string): string[] {
    const out: string[] = [];
    if (view.workflowName !== PROOF_WORKFLOW) out.push(`it is a run of ${JSON.stringify(view.workflowName ?? null)}, not of "${PROOF_WORKFLOW}"`);
    if (view.event !== 'workflow_dispatch') out.push(`its event is ${JSON.stringify(view.event ?? null)}, not a dispatch`);
    if (view.headBranch !== branch) out.push(`it ran on branch ${JSON.stringify(view.headBranch ?? null)} and this checkout is on ${JSON.stringify(branch)}`);
    if (view.headSha !== sha) out.push(`it ran commit ${String(view.headSha).slice(0, 10)}, not ${sha.slice(0, 10)}`);
    if (view.status !== 'completed') out.push(`it is ${JSON.stringify(view.status ?? null)}, not completed`);
    const job = (view.jobs ?? []).filter(j => j.name === `capability ${capability}`);
    if (job.length !== 1 || job[0]!.conclusion !== 'success') out.push(`its job "capability ${capability}" is ${job.length === 1 ? JSON.stringify(job[0]!.conclusion) : 'missing'}, not success`);
    return out;
}
// Why this report is not a complete delivery of `task` at the source of this checkout: an empty list when it is.
export function deliveryProblems(report: any, storedTask: unknown, task: DeliveryTask, local: LocalFacts): string[] {
    const out: string[] = [], r = report && typeof report === 'object' ? report : {};
    if (r.ok !== true || r.stage !== 'delivered' || r.evidence !== 'native' || r.diagnostic || r.hostDeferred || r.failedCheck !== undefined) out.push('the delivery is not complete and accepted');
    if (r.id !== task.id) out.push(`it is a delivery of ${JSON.stringify(r.id ?? null)}, not of ${JSON.stringify(task.id)}`);
    if (typeof r.source !== 'string' || r.source !== local.source) out.push('its source differs from the delivery fingerprint of this checkout');
    if (local.runtime === null || r.runtimeRevision !== local.runtime) out.push('its worker release differs from the capability release of this checkout');
    if (!isDeepStrictEqual(storedTask, task) || !isDeepStrictEqual(local.task, task)) out.push('its task differs from the task file of this checkout');
    if (!Number.isSafeInteger(r.at) || r.at <= 0 || r.at > Date.now()) out.push('its completion time is not valid');
    const checks: any[] = Array.isArray(r.checks) ? r.checks : [];
    if (checks.length !== task.checks.length || !checks.every((c, i) => c?.id === task.checks[i]!.id && c.phase === task.checks[i]!.phase && c.exitCode === 0 && !c.timedOut)) out.push('its checks are not the checks of the task, each passed, in order');
    else if (!task.checks.every((_, i) => local.hasLog(`${i}.out.log`) && local.hasLog(`${i}.err.log`))) out.push('a check log is missing');
    const files: any[] = Array.isArray(r.files) ? r.files : [];
    if (files.length !== task.files.length || !files.every((f, i) => f?.path === task.files[i] && typeof f.sha256 === 'string' && /^[a-f0-9]{64}$/.test(f.sha256) && f.sha256 === local.fileSha(task.files[i]!))) out.push('a declared file differs from the file of this checkout');
    return out;
}
const sha256 = (file: string) => { try { return createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return null; } };
export function localFacts(task: DeliveryTask, folder: string, base = root): LocalFacts {
    let runtime: string | null = null;
    try { runtime = capabilityRevision([task.entry], base); } catch { /* an entry with no release is not adopted */ }
    let stored: unknown = null;
    try { stored = JSON.parse(readFileSync(join(base, 'packages/router/tasks', task.id + '.json'), 'utf8')); } catch { /* differs from every task */ }
    return {source: deliveryFingerprint(task, base), runtime, task: stored, fileSha: path => sha256(join(base, path)), hasLog: name => existsSync(join(folder, name))};
}
const indexFile = (base: string) => join(base, ...STORE, 'adopted.json');
function readIndex(base: string): Index {
    try { const v = JSON.parse(readFileSync(indexFile(base), 'utf8')); if (v?.version === 1 && v.capabilities && typeof v.capabilities === 'object') return v; } catch { /* no index yet */ }
    return {version: 1, capabilities: {}};
}
// The one folder of an artifact that holds the delivery of `capability`: a report that names it and a task file.
// A delivery can run another delivery inside one of its checks (session-recovery-only runs the observer
// qualification), so an artifact can hold more than one; the report names its own capability.
export function deliveryFolderOf(artifactRoot: string, capability: string): string | null {
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
        if (!existsSync(dir) || depth > 3) return;
        if (existsSync(join(dir, 'report.json')) && existsSync(join(dir, 'task.json'))) {
            try { if (JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))?.id === capability) found.push(dir); } catch { /* not a report */ }
            return;
        }
        for (const e of readdirSync(dir, {withFileTypes: true})) if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
    };
    walk(artifactRoot, 0);
    return found.length === 1 ? found[0]! : null;
}
// A folder name inside an artifact, with forward slashes: plain segments only, so it cannot leave its artifact.
export const safeFolder = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && name.split('/').every(part => /^[\w.-]+$/.test(part) && part !== '..' && part !== '.');
// The adopted delivery of this capability for the source this checkout has now, or null. Every check of
// deliveryProblems runs again here, so a file that changed after the adoption ends it.
export function adoptedDelivery(task: DeliveryTask, base = root): (Record<string, unknown> & {ok: true; id: string; source: string; directory: string; adoptedFrom: {run: string; commit: string}}) | null {
    const entry = readIndex(base).capabilities[task.id];
    if (!entry || !/^\d{1,20}$/.test(entry.run) || !safeFolder(entry.folder)) return null;
    const folder = join(base, ...STORE, entry.run, task.id, ...entry.folder.split('/'));
    try {
        const facts = localFacts(task, folder, base);
        if (entry.source !== facts.source) return null;
        const report = JSON.parse(readFileSync(join(folder, 'report.json'), 'utf8')), stored = JSON.parse(readFileSync(join(folder, 'task.json'), 'utf8'));
        if (deliveryProblems(report, stored, task, facts).length) return null;
        return {...report, ok: true, id: task.id, source: facts.source, directory: folder, adoptedFrom: {run: entry.run, commit: entry.commit}};
    } catch { return null; }
}

if (import.meta.main) {
    const fail = (line: string, code = 2): never => { console.error(`adopt-delivery: ${line}`); process.exit(code); };
    let args: ReturnType<typeof adoptArgs>;
    try { args = adoptArgs(process.argv.slice(2)); } catch (error) { args = fail((error as Error).message); }
    if (!args.run) fail('--run <run id> is needed: the run of a round started with gh workflow run "' + PROOF_WORKFLOW + '" --ref <branch> -f capabilities=all');
    const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd, {cwd: root, stdout: 'pipe', stderr: 'pipe', windowsHide: true}); return {ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim()}; };
    const sha = args.commit ?? sh(['git', 'rev-parse', 'HEAD']).out, branch = sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD']).out, run = args.run!;
    if (!/^[0-9a-f]{40}$/.test(sha) || !branch || branch === 'HEAD') fail('this checkout has no commit or is on no branch');
    let view: RunView = {};
    const seen = sh(['gh', 'run', 'view', run, '--json', 'workflowName,event,headBranch,headSha,status,conclusion,jobs']);
    try { view = JSON.parse(seen.out); } catch { fail(`run ${run} was not read: ${seen.err.split('\n').at(-1)}`); }
    const capabilities = (view.jobs ?? []).map(j => /^capability ([-a-z0-9]+)$/.exec(j.name)?.[1]).filter((id): id is string => !!id).sort();
    if (!capabilities.length) fail(`run ${run} has no capability job`);
    const index = readIndex(root);
    let adopted = 0;
    for (const id of capabilities) {
        const refuse = (why: string) => console.log(`refused  ${id}: ${why}`);
        const origin = roundOriginProblems(view, sha, branch, id);
        if (origin.length) { refuse(origin.join('; ')); continue; }
        let task: DeliveryTask;
        try { task = deliveryTask(id); } catch { refuse('this checkout has no such task'); continue; }
        if (args.check) { console.log(`origin ok  ${id}`); continue; }
        // The folder name is digits and a capability id, both checked above.
        const target = join(root, ...STORE, run, id);
        rmSync(target, {recursive: true, force: true}); mkdirSync(target, {recursive: true});
        if (!sh(['gh', 'run', 'download', run, '-n', `capability-${id}-${sha}`, '-D', target]).ok) { refuse('its artifact was not read'); continue; }
        const folder = deliveryFolderOf(target, id);
        if (!folder) { refuse('its artifact holds no one delivery'); continue; }
        const name = folder.slice(target.length + 1).split(sep).join('/');
        if (!safeFolder(name)) { refuse('its delivery folder has an unexpected name'); continue; }
        let report: unknown = null, stored: unknown = null;
        try { report = JSON.parse(readFileSync(join(folder, 'report.json'), 'utf8')); stored = JSON.parse(readFileSync(join(folder, 'task.json'), 'utf8')); } catch { /* reported by the checks */ }
        const facts = localFacts(task, folder), problems = deliveryProblems(report, stored, task, facts);
        if (problems.length) { refuse(problems.join('; ')); continue; }
        index.capabilities[id] = {source: facts.source, run, commit: sha, folder: name, at: Date.now()};
        adopted++;
        console.log(`adopted  ${id}: source ${facts.source.slice(0, 16)}`);
    }
    if (!args.check && adopted) { const file = indexFile(root), tmp = `${file}.${process.pid}.tmp`; mkdirSync(join(root, ...STORE), {recursive: true}); writeFileSync(tmp, JSON.stringify(index, null, 1)); renameSync(tmp, file); }
    console.log(`adopt-delivery: run ${run}: ${adopted} of ${capabilities.length} capabilities adopted`);
    process.exit(0);
}
