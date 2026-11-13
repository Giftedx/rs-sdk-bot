// Recovers this side's held live sessions through the side's running coordinator, so the swarm and the other farmers
// keep running. A held session is one whose logout the server did not confirm: a logout that timed out, a dropped
// socket, a killed worker. Its fleet claim stays held and each later login fails `fleet account claim held by swarm`.
// The side's watchdog calls this script; it never guesses: an account whose end record is gone, or a side whose
// coordinator is not running, is refused with a logged reason.
// Usage: FLEET_SIDE=<side> bun scripts/cloud-recover.ts [--dry] [--root=<checkout>]   (root defaults to this checkout)
// A cloud side waits for the recovery runs and then restarts its coordinator to release the parked jobs. That
// coordinator inherits this process's environment without SWARM_PLAN, so the caller's PATH must carry the model stub
// (README "Claude Code cloud fleet side"). The local side (packages/router/src/watchdog.ts) submits and returns: its
// coordinator holds real work in jobs.json and releases its parked jobs itself (coordinator-live.ts
// releaseFinishedOwnJobs), so this script never stops it.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { loadOwners, mySide } from '../packages/core/src/fleet';
import { BOOTSTRAP_STATUS_AGE_MS } from '../packages/core/src/session-admission';
import { readFleetAccountClaim } from '../packages/core/src/fleet-trade-claim';
import { attemptOutcome, listAttempts, readLogoutProof, type LogoutProof } from '../packages/core/src/session-lifecycle';
import { heldRecoveryOwners, RECOVERY_SCRIPT } from '../packages/core/src/session-recovery-permit';
import { jobAccounts } from '../packages/core/src/coordinator-jobs';
import { clearSwarmStop, loadEnded, swarmWroteStop, type EndRecord } from './swarm';

export const LIVE_SERVER = 'rs-sdk-demo.fly.dev';
// The end reasons the recovery permit accepts (packages/core/src/session-recovery-permit.ts), less a death: a death
// waits for a person, as the swarm's standing retry does.
const RECOVERABLE_END = /^(?:blocked|gave-up|exit|no-progress|stopped)(?:\b| )/;

export type ClaimView = { phase: 'held' | 'released'; kind?: string; pid?: number; host?: string } | null;
export type Eligibility = { eligible: true; endedAt: number } | { eligible: false; reason: string; log: boolean };

// Whether one account needs, and may get, an authenticated recovery now. `log` marks a held session that is refused,
// as opposed to an account with nothing to recover.
// `retried`: a recovery of this exact end has already failed. The supervisor wrote that end before the recovery was
// submitted, so a held attempt newer than it is the recovery child's own session, and no supervisor will write
// another end for it. Live claude-cloud: Fingerblastr's failed recovery left such an attempt, the account waited in
// silence and the retry MAX_ATTEMPTS allows was never submitted.
export function eligibility(v: { proof: LogoutProof; claim: ClaimView; end: EndRecord | undefined; stopText: string | undefined; pidAlive: (pid: number) => boolean; host: string; retried?: boolean }): Eligibility {
    if (v.proof.state !== 'held') return { eligible: false, reason: `logout proof ${v.proof.state}`, log: false };
    if (!v.claim || v.claim.phase !== 'held') {
        // No claim holds the account, and its logout is still unproved: a trade worker dropped and fleet sync released
        // its claim (scripts/fleet-sync.ts droppedTradeClaims). The swarm's orphan end names the held attempt and its
        // dead owner (scripts/swarm.ts orphanedSessionEnds), which is what a recovery needs. Live claude-cloud:
        // TrouserSnake and UnderMyKilt stood with no job after such a release until a recovery was submitted by hand.
        if (!v.end?.reason.startsWith(`exit orphaned: attempt ${v.proof.attemptId} `)) return { eligible: false, reason: 'no held fleet account claim', log: false };
    } else {
        if (v.claim.kind !== 'swarm') return { eligible: false, reason: 'claim is held by a trade order', log: true };
        if (v.claim.host === v.host && typeof v.claim.pid === 'number' && v.pidAlive(v.claim.pid)) return { eligible: false, reason: 'worker still alive', log: false };
    }
    if (v.stopText !== undefined && !swarmWroteStop(v.stopText)) return { eligible: false, reason: 'owner stop file holds the account', log: true };
    if (!v.end) return { eligible: false, reason: 'end record gone (standing retry window passed); recover by hand', log: true };
    // The supervisor retries the dropped session before it writes the end; until then the end record is an earlier
    // run's. The attempt id starts with its creation time (packages/core/src/session-lifecycle.ts).
    const started = /^\d{13}-/.test(v.proof.attemptId) ? Number(v.proof.attemptId.slice(0, 13)) : NaN;
    if (v.end.at < started && !v.retried) return { eligible: false, reason: 'waiting: the supervisor has not ended the held attempt', log: false };
    if (/^died\b/.test(v.end.reason)) return { eligible: false, reason: 'death needs a person', log: true };
    if (!RECOVERABLE_END.test(v.end.reason)) return { eligible: false, reason: `end reason not recoverable: ${v.end.reason}`, log: true };
    return { eligible: true, endedAt: v.end.at };
}

// The coordinator refuses a live task for an account that has any stop file (packages/router/src/coordinator-live.ts
// runLiveTask: "live account owner stopped before controller setup"). A recovery target is offline, and its stop file,
// if it has one, is the swarm's own (eligibility refuses an owner's): the swarm leaves it when the account's job leaves
// the plan, as when the planner takes an account off its job for a fleet order. Remove those before the submit, or the
// recovery fails and spends an attempt. While stop-swarm is in force they stay: no recovery runs under it.
export function clearSwarmStops(root: string, accounts: readonly string[]): string[] {
    if (existsSync(join(root, '.practice', 'stop-swarm'))) return [];
    return accounts.filter(a => clearSwarmStop(join(root, '.practice', `stop-${a}`)));
}

const stamp = (now: number) => new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase();

// One qualify task and one recovery run task per held account, all with fresh ids (finished task ids never run
// again). Accounts dropped together recover in one proposal behind one qualify, so a second account does not wait a
// whole call and reach the swarm's 15-minute end-record deletion. Each run also waits for the run before it: the
// controller has one repair slot and a run gives up after 180 s waiting for it (coordinator-live.ts
// requestAuthenticatedRecovery), which four parallel runs overran. A run behind a failed one never starts; it counts
// as a spent attempt and the next call submits its account again.
export type Target = { account: string; endedAt: number };
// The coordinator takes at most 12 tasks in one proposal (packages/router/src/coordinator-planner.ts prepareProposal)
// and one of them is the qualify, so a call recovers at most 11 accounts; the rest wait for the next call. Live
// claude-cloud: a container restart dropped 12 sessions, the 13-task proposal was rejected and nothing recovered for
// 27 minutes.
export const MAX_TARGETS = 11;
export function recoveryBatch(targets: readonly Target[]): { now: Target[]; later: Target[] } {
    return { now: targets.slice(0, MAX_TARGETS), later: targets.slice(MAX_TARGETS) };
}
// A proposal the coordinator rejects never becomes tasks: it renames the request file `.rejected`
// (packages/router/src/coordinator-cli.ts intakeRequests). The request's own name is random, so it is found by the
// qualify id it carries.
export function submitRejected(requests: string, qualifyId: string): boolean {
    if (!existsSync(requests)) return false;
    return readdirSync(requests).filter(f => f.endsWith('.rejected')).some(f => {
        try { return JSON.parse(readFileSync(join(requests, f), 'utf8'))?.tasks?.[0]?.id === qualifyId; } catch { return false; }
    });
}
export function recoveryProposal(side: string, targets: readonly Target[], now: number) {
    const s = stamp(now), qualify = `${side}-recovery-qualified-${s}`, runId = (account: string) => `${side}-recover-${account.toLowerCase()}-${s}`;
    return {
        reason: `Authenticated recovery of ${targets.map(t => t.account).join(', ')} inside the running coordinator`, capabilities: [],
        tasks: [
            { id: qualify, goal: 'wealth', kind: 'qualify', capability: 'session-recovery-only', dependsOn: [] as string[], priority: 90, estimatedMs: 600000, why: 'Qualify authenticated session recovery' },
            ...targets.map(({ account, endedAt }, i) => ({ id: runId(account), goal: 'wealth', kind: 'run', capability: 'session-recovery-only', account,
                dependsOn: i ? [qualify, runId(targets[i - 1]!.account)] : [qualify],
                repairs: [{ account, endedAt }], sessionRecovery: { account, endedAt }, accept: { counters: { sessionChecked: 1 } },
                priority: 90, estimatedMs: 120000, why: `Authenticated recovery of ${account}'s orphaned session` })),
        ],
    };
}

// Session-recovery tasks still pending or running in the coordinator's state: a release waits until they settle, so
// every finished recovery has parked its session check first. A pending task behind a failed or missing dependency
// never starts, so it is settled, not in flight.
// Pending tasks that can never start: a dependency failed, was superseded or is missing, directly or through another
// pending task. Same rule as the coordinator's deadRoots (packages/router/src/coordinator.ts), which a script may not
// import (packages/core/src/worker-release.ts); a run's failed refresh qualify is replaceable, so it does not count.
export function deadTasks(tasks: readonly any[]): Set<string> {
    const byId = new Map(tasks.map(t => [t?.spec?.id, t])), memo = new Map<string, boolean>();
    const dead = (t: any): boolean => {
        if (memo.has(t.spec.id)) return memo.get(t.spec.id)!;
        memo.set(t.spec.id, false);
        const result = (t.spec.dependsOn ?? []).some((id: string) => {
            if (t.spec.kind === 'run' && id.startsWith(`refresh-${t.spec.capability}-`)) return false;
            const d = byId.get(id);
            return !d || d.status === 'failed' || d.status === 'superseded' || d.status === 'pending' && dead(d);
        });
        memo.set(t.spec.id, result);
        return result;
    };
    return new Set(tasks.filter(t => t?.status === 'pending' && t.spec?.id).filter(dead).map(t => t.spec.id));
}
export const recoveriesInFlight = (tasks: readonly any[], dead = deadTasks(tasks)) =>
    tasks.filter(t => t?.spec?.sessionRecovery && (t.status === 'running' || t.status === 'pending' && !dead.has(t.spec.id)));

// Recovery runs already spent on one exact end: the run failed, or its qualify did. A run that never started behind a
// failed earlier run of its chain is no attempt. A failure is retried once; a second stops the retries for that end.
// A run that the controller refused while it waited for memory, a bot slot or the source owner issued no lease and
// touched no session (packages/core/src/session-recovery-dispatch.ts phase `source-owner` or `admission`;
// packages/router/src/coordinator-live.ts awaitBotSlot). It spends no attempt. MAX_WAITS keeps those retries finite.
// Live local: Sausagefest's four recovery runs were all refused on memory, and the end went to "recover by hand".
export const MAX_ATTEMPTS = 2, MAX_WAITS = 6;
// The dispatcher's cause names (session-recovery-dispatch.ts setupCauses) of a refusal that only waited.
const WAIT_CAUSES = new Set(['recovery admission waiting: memory', 'recovery admission waiting: maxBots', 'recovery waits for runtime source owner']);
// The coordinator's receipt of a run that preflight refused before it wrote the request (coordinator-live.ts preflight).
const WAIT_ERROR = /^Error: live admission waiting: (?:memory|maxBots)$/;
// The run ids that the dispatcher refused while it waited, from the lines of `.practice/swarm-repair.json.results.jsonl`.
// The coordinator receipt keeps only the dispatcher's reason, not its cause. A line that cannot be read is skipped.
export function waitRefusedRuns(results: string): Set<string> {
    const runs = new Set<string>();
    for (const line of results.split('\n')) {
        try {
            const row = JSON.parse(line), r = row?.result;
            if (r?.sessionRecovered !== false || r.reason !== 'recovery setup refused; no lease issued; no retry' || !WAIT_CAUSES.has(r.setup?.cause)) continue;
            const runId = JSON.parse(row.raw)?.runId;
            if (typeof runId === 'string') runs.add(runId);
        } catch { /* not a result line */ }
    }
    return runs;
}
const waitRefused = (t: any, waits: ReadonlySet<string>) => t.status === 'failed' && (waits.has(t.runId) || WAIT_ERROR.test(t.receipt?.error ?? ''));
function endRuns(tasks: readonly any[], target: Target) {
    const byId = new Map(tasks.map(t => [t?.spec?.id, t]));
    const qualifyFailed = (id: string) => { const d = byId.get(id); return d?.spec?.kind === 'qualify' && (d.status === 'failed' || d.status === 'superseded'); };
    return tasks.filter(t => {
        const r = t?.spec?.sessionRecovery;
        return r?.account?.toLowerCase() === target.account.toLowerCase() && r.endedAt === target.endedAt
            && (t.status === 'failed' || t.status === 'pending' && (t.spec.dependsOn ?? []).some(qualifyFailed));
    });
}
export function spentAttempts(tasks: readonly any[], target: Target, waits: ReadonlySet<string> = new Set()): number {
    return endRuns(tasks, target).filter(t => !waitRefused(t, waits)).length;
}
export function waitedAttempts(tasks: readonly any[], target: Target, waits: ReadonlySet<string> = new Set()): number {
    return endRuns(tasks, target).filter(t => waitRefused(t, waits)).length;
}

// One unresolved recovery lineage: a failed recovery child stays held, the swarm writes a new orphan end for it with a
// new time (scripts/swarm.ts orphanedSessionEnds), and the next recovery names that new time. The budget of each end
// is then the budget of its whole lineage, or the retries never stop: a per-end count restarts at zero on each new
// orphan end of the same held child.
// An end is child-generated when the attempt that it names (an orphan end) or, for an earlier end, the latest attempt
// at its time is a recovery child: its producer receipt names RECOVERY_SCRIPT, role `recovery` and the coordinator run
// id of a retained recovery request of the same account. The link goes back to the end that this request named. A
// confirmed logout or an ordinary session between that end and the child proves a new lineage, and so does an end
// whose attempt is an ordinary session. A link that cannot be read is unknown, and an unknown link gets no budget.
export type LineageAttempt = { attemptId: string; runId: string | null; script: string; role: string | null; confirmed: boolean } | { attemptId: string; unreadable: true };
export type RecoveryRecord = { runId: string; endedAt: number };
export type Lineage = { ends: number[] } | { unknown: string };
export const MAX_LINEAGE = 64;
const attemptTime = (id: string) => /^\d{13}-/.test(id) ? Number(id.slice(0, 13)) : NaN;
const recoveryChild = (a: Exclude<LineageAttempt, { unreadable: true }>) => a.script === RECOVERY_SCRIPT && a.role === 'recovery';
export function recoveryLineage(end: Pick<EndRecord, 'at' | 'reason'>, attempts: readonly LineageAttempt[], records: readonly RecoveryRecord[]): Lineage {
    const sorted = [...attempts].sort((a, b) => a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0), ends = [end.at];
    let at = end.at, named = /^exit orphaned: attempt (\S+) /.exec(end.reason)?.[1];
    for (let step = 0; step < MAX_LINEAGE; step++) {
        const attempt = named ? sorted.find(a => a.attemptId === named) : sorted.filter(a => attemptTime(a.attemptId) <= at).at(-1);
        if (!attempt) return named ? { unknown: `attempt ${named} of end ${at} has no lifecycle receipt` } : { ends };
        if ('unreadable' in attempt) return { unknown: `lifecycle receipt ${attempt.attemptId} of end ${at} is unreadable` };
        if (!recoveryChild(attempt)) return { ends };
        const parents = new Set(records.filter(r => r.runId === attempt.runId).map(r => r.endedAt));
        if (parents.size !== 1) return { unknown: `recovery child ${attempt.attemptId} names run ${attempt.runId}, which ${parents.size ? 'retained requests give different ends' : 'no retained recovery request names'}` };
        const parent = [...parents][0]!, created = attemptTime(attempt.attemptId);
        if (!(parent < created) || !(parent < at)) return { unknown: `recovery child ${attempt.attemptId} does not follow its end ${parent}` };
        for (const a of sorted.filter(x => attemptTime(x.attemptId) > parent && attemptTime(x.attemptId) < created)) {
            if ('unreadable' in a) return { unknown: `lifecycle receipt ${a.attemptId} after end ${parent} is unreadable` };
            if (a.confirmed || !recoveryChild(a)) return { ends };
        }
        ends.push(parent); at = parent; named = undefined;
    }
    return { unknown: `lineage of end ${end.at} is longer than ${MAX_LINEAGE} ends` };
}

// The retained recovery requests of one account: the coordinator's run tasks, and every permit and output request
// under the account's recovery folder, also those of a lease moved aside (archiveStaleLease).
export function recoveryRecords(root: string, account: string, tasks: readonly any[]): RecoveryRecord[] {
    const key = account.toLowerCase(), out: RecoveryRecord[] = [];
    const add = (r: any) => { if (typeof r?.runId === 'string' && Number.isFinite(r.endedAt) && typeof r.account === 'string' && r.account.toLowerCase() === key) out.push({ runId: r.runId, endedAt: r.endedAt }); };
    for (const t of tasks) if (t?.spec?.sessionRecovery) add({ runId: t.runId, ...t.spec.sessionRecovery });
    const dir = join(root, '.practice', 'coordinator', 'session-recovery', 'accounts', key);
    let entries: string[] = []; try { entries = readdirSync(dir); } catch { /* no recovery yet */ }
    for (const e of entries) {
        if (/^lease(?:-stale-.*)?\.json$/.test(e)) { add(readJson(join(dir, e), null)?.request); continue; }
        add(readJson(join(dir, e, 'permit.json'), null)?.request);
        add(readJson(join(dir, e, 'output', 'request.json'), null));
        add(readJson(join(dir, e, 'output', 'receipt.json'), null)?.request);
    }
    return out;
}

export function lineageAttempts(root: string, account: string): LineageAttempt[] {
    return listAttempts(account, LIVE_SERVER, { root: lifecycleRoot(root) }).map(({ attemptId, receipt }) => receipt
        ? { attemptId, runId: receipt.owner.coordinatorRunId ?? null, script: receipt.owner.script, role: receipt.owner.role ?? null, confirmed: attemptOutcome(receipt).confirmed }
        : { attemptId, unreadable: true as const });
}

// Why the end may not get another automatic recovery, or undefined. The proposal still names the exact current end;
// only the count runs over the lineage. Waits keep their own budget.
export function budgetRefusal(root: string, account: string, end: Pick<EndRecord, 'at' | 'reason'>, tasks: readonly any[], waits: ReadonlySet<string> = new Set()): string | undefined {
    let lineage: Lineage;
    try { lineage = recoveryLineage(end, lineageAttempts(root, account), recoveryRecords(root, account, tasks)); }
    catch (e) { lineage = { unknown: `lifecycle unreadable: ${String(e).slice(0, 120)}` }; }
    if ('unknown' in lineage) return `recovery lineage of end ${end.at} unknown (${lineage.unknown}); recover by hand`;
    const sum = (f: typeof spentAttempts) => lineage.ends.reduce((n, endedAt) => n + f(tasks, { account, endedAt }, waits), 0);
    const of = lineage.ends.length > 1 ? `end ${end.at} and the ${lineage.ends.length - 1} earlier ends of its lineage (first ${lineage.ends.at(-1)})` : `end ${end.at}`;
    if (sum(spentAttempts) >= MAX_ATTEMPTS) return `${MAX_ATTEMPTS} recoveries of ${of} failed; recover by hand`;
    if (sum(waitedAttempts) >= MAX_WAITS) return `${MAX_WAITS} recoveries of ${of} waited on memory, a bot slot or the source owner; recover by hand`;
    return undefined;
}

// The folder that receives the coordinator's parked jobs and stop file after a release.
// The session-lifecycle root that readLogoutProof reads (packages/core/src/session-lifecycle.ts DEFAULT_LIFECYCLE_ROOT).
export const lifecycleRoot = (root: string) => join(root, '.practice', 'session-lifecycle');

export function archiveDir(root: string, account: string, now: number): string {
    return join(root, '.practice', 'coordinator', 'release-archive', `${stamp(now)}-${account.toLowerCase()}`);
}

// The jobs in the coordinator's file that a release may archive. A finished recovery parks a session check. A recovery
// that parked the account's owner job (a disabled copy without coordinatorOwner, coordinator-live.ts
// prepareLiveRecovery) and then failed leaves that copy. The copy goes only when, for every account in it, the owner job
// in swarm.json still names the account, its logout proof is confirmed (none or invalid still block) and no recovery
// of it is pending or running; the copy then only keeps the account from its owner job (the coordinator's settledOwnerJob).
export type ReleaseView = { ownerJob: (account: string) => boolean; confirmed: (account: string) => boolean; recovering: (account: string) => boolean };
const releasable = (j: any, v: ReleaseView) => j?.enabled === false && (
    j.coordinatorOwner === 'coordinator' ? typeof j.account === 'string' && j.script === 'scripts/session-check.ts'
        : jobAccounts(j).length > 0 && jobAccounts(j).every(a => v.ownerJob(a) && v.confirmed(a) && !v.recovering(a)));
// Jobs that may not be archived yet.
export const releaseBlockers = (jobs: readonly any[], v: ReleaseView) => jobs.filter(j => !releasable(j, v));
// A blocker that only waits for its own account: a parked owner-job copy whose owner job is in swarm.json and that has
// no recovery open, but whose logout is not confirmed yet. It stays in the file and no longer holds the others: live
// claude-cloud, one such copy (Fingersmith) kept seven recovered accounts parked for 30 minutes.
const waits = (j: any, v: ReleaseView) => j?.enabled === false && j.coordinatorOwner !== 'coordinator'
    && jobAccounts(j).length > 0 && jobAccounts(j).every(a => v.ownerJob(a) && !v.recovering(a));
// What a release does with the coordinator's file: the jobs it archives and the jobs it leaves in place. Any other
// blocker (an enabled job, a coordinator job that is not a parked session check, a copy with no owner job) is work
// this script does not understand, and nothing is released around it.
export function releasePlan(jobs: readonly any[], v: ReleaseView): { free: any[]; keep: any[] } {
    const keep = releaseBlockers(jobs, v);
    return keep.every(j => waits(j, v)) ? { free: jobs.filter(j => !keep.includes(j)), keep } : { free: [], keep: [...jobs] };
}
// The accounts a release frees.
export function releasableAccounts(jobs: readonly any[], v: ReleaseView): string[] {
    return releasePlan(jobs, v).free.flatMap(jobAccounts);
}

// The account's recovery lease (packages/core/src/session-recovery-permit.ts recoveryPermitPaths). A recovery whose
// child is held keeps it (session-recovery-dispatch.ts "recovery child held"), and while the file is there the swarm
// refuses every later recovery of the account ("existing recovery lease held") and the account's own logins
// (assertNoRecoveryLease). Live claude-cloud: one such lease (Fingersmith) made the retry of its end fail unseen.
// A lease is stale when heldRecoveryOwners no longer counts it: its child's process is gone, or it recorded no child
// and its permit has expired. A lease it cannot read, and one whose child still runs, are held.
export type LeaseState = 'none' | 'held' | 'stale';
const leaseFile = (root: string, account: string) => join(root, '.practice', 'coordinator', 'session-recovery', 'accounts', account.toLowerCase(), 'lease.json');
export function recoveryLeaseState(root: string, account: string, alive?: (pid: number) => boolean, now = Date.now()): LeaseState {
    if (!existsSync(leaseFile(root, account))) return 'none';
    return heldRecoveryOwners(root, [], alive, now).some(h => h.account.toLowerCase() === account.toLowerCase()) ? 'held' : 'stale';
}
// Moves a stale lease aside in its own folder, so the retry that MAX_ATTEMPTS allows is a real recovery. The attempt
// folder beside it keeps the held child's permit and output.
export function archiveStaleLease(root: string, account: string, now: number): string {
    const file = leaseFile(root, account), to = join(resolve(file, '..'), `lease-stale-${stamp(now)}.json`);
    renameSync(file, to);
    return to;
}

// The local side's coordinator owns real work in its jobs.json; only a cloud side waits for the runs and restarts its
// coordinator to release the parked jobs.
export const cloudSide = (side: string) => side !== 'local';

// The accounts that stay offline (scripts/swarm.ts PROTECTED_ACCOUNTS; the coordinator refuses a recovery of the
// first three, packages/router/src/coordinator.ts). The swarm records no end for them, so eligibility refuses them
// already; this list keeps them out of a proposal even with an end record written by hand.
export const NEVER_RECOVERED = ['haggis', 'shaftshooter', 'polevaulter', 'afknight'];

// A recovery run names the exact time of its end record, and its qualify takes about 9 minutes. The local swarm's
// standing retry deletes a blocked, gave-up or stopped end once the account's status is BOOTSTRAP_STATUS_AGE_MS old
// (scripts/swarm.ts standingRetryDue); the retry fails on the held claim and a later end gets a new time, so a run
// that names the deleted end fails `exact failure changed`. The retry never takes an orphan end, so that time holds.
// Any other end is taken once the retry window is over.
export const END_SETTLE_MS = BOOTSTRAP_STATUS_AGE_MS + 5 * 60_000;
export function endSettled(end: Pick<EndRecord, 'at' | 'reason'>, now: number): boolean {
    return end.reason.startsWith('exit orphaned: attempt ') || now - end.at >= END_SETTLE_MS;
}

// A submitted proposal is a `.request.json` file until the coordinator takes it into its state (coordinator-cli.ts
// intakeRequests). Until then state.json shows no recovery in flight, and a second call would submit the same
// accounts again. A file that cannot be read counts as waiting.
export function recoveryRequestWaiting(requests: string): boolean {
    let files: string[]; try { files = readdirSync(requests); } catch { return false; }
    return files.filter(f => f.endsWith('.request.json')).some(f => {
        try { return (JSON.parse(readFileSync(join(requests, f), 'utf8'))?.tasks ?? []).some((t: any) => t?.sessionRecovery); } catch { return true; }
    });
}

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const readJson = (file: string, fallback: any) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const log = (line: string) => console.log(`CLOUD_RECOVER ${line}`);

async function main(root: string, dry: boolean): Promise<number> {
    const side = mySide(), cloud = cloudSide(side), coord = join(root, '.practice', 'coordinator'), stopCoordinator = join(root, '.practice', 'stop-coordinator');
    const coordinatorRunning = () => { const o = readJson(join(coord, 'owner.json'), null); return !!o && Number.isSafeInteger(o.pid) && pidAlive(o.pid) && !existsSync(stopCoordinator); };
    if (!coordinatorRunning()) { log('refused: coordinator is not running'); return 1; }
    const tasksNow = () => readJson(join(coord, 'state.json'), { tasks: [] }).tasks ?? [];
    const before = tasksNow(), dead = deadTasks(before), inFlight = recoveriesInFlight(before, dead);
    if (inFlight.length) { log(`recovery in flight for ${inFlight.map((t: any) => t.spec.sessionRecovery.account).join(', ')}; waiting`); return 0; }
    if (recoveryRequestWaiting(join(coord, 'requests'))) { log('a submitted recovery waits for the coordinator to take it; waiting'); return 0; }
    const ended = loadEnded(join(root, '.practice', 'swarm-deaths.json'));
    let results = ''; try { results = readFileSync(join(root, '.practice', 'swarm-repair.json.results.jsonl'), 'utf8'); } catch { /* no recovery result yet */ }
    const waits = waitRefusedRuns(results);
    const accounts = [...loadOwners()].filter(([n, o]) => o.side === side && o.server === LIVE_SERVER && !NEVER_RECOVERED.includes(n.toLowerCase())).map(([n]) => n);
    const targets: Target[] = [];
    for (const lower of accounts) {
        const name = [...ended.keys()].find(n => n.toLowerCase() === lower) ?? lower;
        const proof = readLogoutProof(name, LIVE_SERVER, { root: lifecycleRoot(root) });
        if (proof.state !== 'held') continue;
        // A live worker refreshes its status every few seconds; skip it before reading the claim ref from origin.
        const status = readJson(join(root, '.practice', 'status', `${name}.json`), null);
        if (status && !status.result && Date.now() - status.at < 60_000) continue;
        let claim: ClaimView = null;
        try { claim = readFleetAccountClaim(root, { account: name, server: LIVE_SERVER }) as ClaimView; } catch (e) { log(`${name}: refused: claim unreadable: ${String(e).slice(0, 120)}`); continue; }
        const stopFile = join(root, '.practice', `stop-${name}`), stopText = existsSync(stopFile) ? readFileSync(stopFile, 'utf8') : undefined;
        const end = ended.get(name);
        const e = eligibility({ proof, claim, end, stopText, pidAlive, host: hostname(), retried: !!end && spentAttempts(before, { account: name, endedAt: end.at }, waits) > 0 });
        if (!e.eligible) { if (e.log) log(`${name}: refused: ${e.reason}`); continue; }
        if (!cloud && !endSettled(end!, Date.now())) continue;
        const target = { account: name, endedAt: e.endedAt };
        const refusal = budgetRefusal(root, name, end!, before, waits);
        if (refusal) { log(`${name}: refused: ${refusal}`); continue; }
        if (recoveryLeaseState(root, name) === 'held') { log(`${name}: refused: a recovery child still holds the account's lease, or the lease is unreadable`); continue; }
        targets.push(target);
    }
    let failed = false;
    if (targets.length) {
        const { now: batch, later } = recoveryBatch(targets);
        if (later.length) log(`${later.length} more held accounts wait for the next call: ${later.map(t => t.account).join(', ')}`);
        const proposal = recoveryProposal(side, batch, Date.now()), runs = proposal.tasks.slice(1) as { id: string; account: string }[];
        log(`submitting ${proposal.tasks.map(t => t.id).join(', ')} (${batch.map(t => `${t.account} endedAt ${t.endedAt}`).join('; ')})`);
        const stale = batch.map(t => t.account).filter(a => recoveryLeaseState(root, a) === 'stale');
        if (dry) { if (stale.length) log(`would move aside the stale recovery lease of ${stale.join(', ')}`); return 0; }
        for (const a of stale) log(`${a}: moved its stale recovery lease to ${archiveStaleLease(root, a, Date.now())}`);
        const cleared = clearSwarmStops(root, batch.map(t => t.account));
        if (cleared.length) log(`removed the swarm's own stop file for ${cleared.join(', ')}`);
        const file = join(root, '.practice', 'cloud-recover', `${proposal.tasks[0]!.id}.json`);
        mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(proposal, null, 1) + '\n');
        if (!(await run(root, ['--submit', file]))) { log('submit failed'); return 1; }
        // The local coordinator runs the tasks and releases the parked jobs itself; the next call sees them in flight.
        if (!cloud) return 0;
        // One qualify, then about a minute per recovery run.
        const deadline = Date.now() + (15 + 2 * runs.length) * 60_000;
        for (;;) {
            const tasks = tasksNow(), status = (id: string) => tasks.find((t: any) => t.spec?.id === id)?.status, open = new Set(recoveriesInFlight(tasks).map((t: any) => t.spec.id));
            if (runs.every(r => status(r.id) && !open.has(r.id))) break;
            if (submitRejected(join(coord, 'requests'), proposal.tasks[0]!.id)) { log(`submit rejected by the coordinator (queue-submit-failed in its events): ${proposal.tasks[0]!.id}`); return 1; }
            if (Date.now() > deadline) { log(`recovery timed out (${runs.map(r => `${r.id} ${status(r.id) ?? 'unseen'}`).join(', ')}); no retry`); return 1; }
            await Bun.sleep(5000);
        }
        const tasks = tasksNow();
        for (const r of runs) {
            const status = tasks.find((t: any) => t.spec?.id === r.id)?.status, ok = status === 'succeeded', proof = readLogoutProof(r.account, LIVE_SERVER, { root: lifecycleRoot(root) });
            log(`${r.account}: recovery ${ok ? 'succeeded' : status === 'pending' ? 'not started: a dependency failed' : 'failed'} (${r.id}); logout proof ${proof.state}`);
            if (!ok || proof.state !== 'confirmed') failed = true;
        }
    }
    if (!cloud) return 0;
    // A finished recovery leaves a parked coordinator job that keeps the account from its owner job; release them all
    // once no recovery is still in flight, so each has parked its session check first.
    const flying = recoveriesInFlight(tasksNow());
    if (flying.length) return failed ? 1 : 0;
    const jobs = readJson(join(coord, 'jobs.json'), { jobs: [] }).jobs ?? [];
    const owned = new Set((readJson(join(root, 'swarm.json'), { jobs: [] }).jobs ?? []).flatMap(jobAccounts).map((n: string) => n.toLowerCase()));
    const view: ReleaseView = { ownerJob: a => owned.has(a.toLowerCase()), confirmed: a => readLogoutProof(a, LIVE_SERVER, { root: lifecycleRoot(root) }).state === 'confirmed',
        recovering: a => flying.some((t: any) => t.spec.sessionRecovery.account.toLowerCase() === a.toLowerCase()) };
    const { free, keep } = releasePlan(jobs, view), parked = free.flatMap(jobAccounts), blockers = releaseBlockers(jobs, view);
    const named = (js: readonly any[]) => js.map((j: any) => `${jobAccounts(j).join('+')} ${j.script}${j.enabled === false ? '' : ' (enabled)'}`).join(', ');
    if (!parked.length && blockers.length && blockers.length < jobs.length) log(`release skipped: jobs.json also holds ${named(blockers)}`);
    if (!parked.length) return failed ? 1 : 0;
    if (dry) { log(`would release parked jobs for ${parked.join(', ')}${keep.length ? `; would leave ${named(keep)}` : ''}`); return 0; }
    return (await release(root, parked, keep)) && !failed ? 0 : 1;
}

async function run(root: string, args: string[]): Promise<boolean> {
    // This process's own runtime: the PATH of a scheduled caller (the local watchdog task) can hold no `bun`.
    const p = Bun.spawn([process.execPath, 'packages/router/src/coordinator-cli.ts', ...args], { cwd: root, stdout: 'inherit', stderr: 'inherit', windowsHide: true });
    return (await p.exited) === 0;
}

// Stop the coordinator (its swarm and workers are detached and keep running), move its parked jobs and stop file into
// an archive folder, then start it again; it adopts the running swarm. Jobs in `keep` go back into a new jobs.json.
async function release(root: string, parked: string[], keep: readonly any[] = []): Promise<boolean> {
    const coord = join(root, '.practice', 'coordinator'), owner = readJson(join(coord, 'owner.json'), null);
    if (!(await run(root, ['--stop']))) { log('release: coordinator stop failed'); return false; }
    const deadline = Date.now() + 120_000;
    while (owner && pidAlive(owner.pid)) { if (Date.now() > deadline) { log('release: coordinator did not exit; jobs.json left in place'); return false; } await Bun.sleep(2000); }
    const dir = archiveDir(root, parked[0]!, Date.now()); mkdirSync(dir, { recursive: true });
    const file = join(coord, 'jobs.json'), whole = readJson(file, { jobs: [] });
    for (const f of [file, join(root, '.practice', 'stop-coordinator')]) if (existsSync(f)) renameSync(f, join(dir, f.split('/').pop()!));
    if (keep.length) { writeFileSync(file, JSON.stringify({ ...whole, jobs: keep }, null, 1) + '\n'); log(`release left in jobs.json: ${keep.map((j: any) => `${jobAccounts(j).join('+')} ${j.script}`).join(', ')}`); }
    const env = { ...process.env }; delete env.SWARM_PLAN;
    mkdirSync(join(root, '.practice', 'swarm-logs'), { recursive: true });
    const out = openSync(join(root, '.practice', 'swarm-logs', 'coordinator.log'), 'a');
    spawn('bun', ['packages/router/src/coordinator-cli.ts', '--run'], { cwd: root, env, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
    log(`released ${parked.join(', ')}; parked jobs archived in ${dir}; coordinator restarted`);
    return true;
}

if (import.meta.main) {
    const rootArg = process.argv.find(a => a.startsWith('--root='))?.slice(7);
    process.exit(await main(resolve(rootArg ?? join(import.meta.dir, '..')), process.argv.includes('--dry')));
}
